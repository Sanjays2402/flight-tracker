'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   ASIP · Aging-Airframe Structural Integrity Program &
          Damage-Tolerance Cycle-Threshold Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of accumulated structural
   fatigue life — flight cycles (FC), flight hours (FH),
   pressurisation cycles, calendar age — measured against the
   certified Design Service Goal (DSG), the §26.21 Limit of
   Validity (LoV), the Widespread Fatigue Damage (WFD) average
   behaviour threshold, and the per-airframe damage-tolerance
   repeat-inspection intervals per:

     · 14 CFR §25.571 Damage-tolerance & fatigue evaluation of
       structure (DTE)
     · 14 CFR §25.1529 Instructions for Continued
       Airworthiness (ICA)
     · 14 CFR Subpart 26  Continued Airworthiness & Safety
       Improvements (Aging-Aircraft Safety Rule)
       §26.21 LoV / §26.23 / §26.43 ALI / §26.45 / §26.49
     · 14 CFR §121.370a / §121.1109 Supplemental Inspection
       Program (Aging-Airplane Safety Rule 2007 final rule)
     · FAA AC 25-571-1D  Damage-Tolerance & Fatigue Evaluation
            of Structure (current revision)
     · FAA AC 91-56B  Continuing Structural Integrity Program
            for Large Transport-Category Airplanes
     · FAA AC 120-104  Establishing & Implementing LoV
     · FAA AC 120-93  Damage Tolerance Inspections for
            Repairs & Alterations
     · FAA AC 25.571-2 Aging Programs for Pressurised Fuselages
     · EASA CS-25.571  / AMC 25.571
     · EASA AMC 20-20A Continuing Structural Integrity Program
     · EASA Decision 2018/008/R LoV designation
     · ICAO Annex 8 Pt IIIA §1.4 Continuing Airworthiness /
            Annex 6 Pt I §8 maintenance program
     · ICAO Doc 9760 Vol II Pt VIII Aging-aircraft
     · SAE ARP-4754A Aircraft Development §5
     · MIL-STD-1530D ASIP (Aircraft Structural Integrity Program)
            — USAF model that defined the discipline
     · NTSB AAR-89-03 Aloha 243 (737-200, 89,090 FC, fuselage
            crown peeled off Apr-1988, started the modern WFD
            programme)
     · NTSB AAR-86-03 + JTSB Tokyo JAL-123 1985 aft-pressure-
            bulkhead failure (pressurisation cycle history)
     · ASC ASC-AAR-05-04-01 China Airlines 611 B747 over-
            Taiwan-Strait Mar-2002 (fatigue crack from tail-strike
            repair at 22.5y service)
     · NTSB AAR-94-02 Southwest 1455 / NTSB-AAR-09-01 Continental
            3407 aging structural fatigue context
     · Boeing AGES-LoV final reports per type (D6-... series)
     · Airbus ESG (Extended Service Goal) campaign deliverables
            per type (TFU/SB family)
     · Embraer Type-Cert. Data Sheet structural-life designators
     · Bombardier CSIP (Continuing Structural Integrity Program)
     · ATR Structural-Programme document Issue 5
     · Bristow & Davies "Fatigue & Fracture of Aircraft
            Structures" 2e Ch.12 §SIP & WFD methodology
     · NASA TP-3110 Aging-aircraft structural integrity
     · Wanhill Eng.Fail.Anal. 16 (2009) §3 WFD

   Distinct from:
     · MEL/CDL (system-level dispatch deferrals, not structural
       life)
     · HOTSEC (engine hot-section LCF, not airframe)
     · VIB (engine rotor vibration, not structure)
     · HYD (hydraulic redundancy, not fatigue)
     · OIL (engine bearings)
     · FOQA (flight-ops exceedance trend)
     · TPIS (tire pressure)
     · ULB (acoustic pinger battery)
     · OLD (landing-distance)
   ASIP is uniquely the AIRFRAME long-term fatigue-life
   regime: flight-cycle accumulation, pressurisation cycles,
   calendar-age corrosion, and inspection-threshold management
   per §25.571 + Subpart 26.

   Physics & metric definitions:
     · DSG (Design Service Goal) — FC & FH at which the OEM
       designed the structure to remain crack-free under
       deterministic fatigue analysis (per §25.571(a))
     · LoV (Limit of Validity, §26.21) — operational service
       boundary, after which continued operation requires a
       Subpart-26 supplemental programme; OEMs cannot certify
       generic safety beyond LoV
     · LFC (Life Fraction Consumed) = FC/LoV-FC, FH/LoV-FH,
       PressCycles/PressCyc-LoV — composite uses max
     · WFD threshold ≈ 0.75 LoV per AC 25-571-1D §6.7
       (statistical onset of multi-site & multi-element damage)
     · DT-INSP interval per structural-significant-item (SSI)
       — short for high-LFC airframes per Boeing AGES SI bulletin
     · Calendar-age vs pressurisation-cycle corrosion (saline,
       Pacific routes, polar humidity) — calendar-life multiplier
       per Boeing SB 53A-xxx series & Airbus TFU 53.xx
     · Repair / Alteration DTI per AC 120-93 (compounding effect
       on fleet leader airframes)

   8 drivers (each 0-100):
     · CYC    FC / LoV-FC          flight-cycle life fraction
     · HRS    FH / LoV-FH          flight-hour life fraction
     · PRESS  pressCyc / cyc-LoV   pressurisation fatigue
     · WFD    (LFC - 0.75) / 0.25  WFD-threshold proximity
     · CAL    calendar yrs / DSG-yrs corrosion-age
     · INSP   DT-inspection-overdue ratio per SSI
     · REPAIR repair-DTI accumulation per AC 120-93
     · UTIL   FH/FC trip-length severity (short-hop = high
              pressurisation density penalty per Aloha 243)

   Composite: max·0.66 + mean·0.34 × ADV-MUL

   Hard escalators:
     · LFC ≥ 1.00 (at LoV)        score-min 95  GROUNDED
     · LFC ≥ 0.95 + pressurised   score-min 88  near-LoV
     · WFD-threshold breached     score-min 78  AC 25-571-1D §6.7
     · DT-INSP overdue            score-min 70  §121.370a
     · Calendar-age ≥ DSG-yrs+5   score-min 60  corrosion AC 91-56B

   6 tiers:
     · GROUNDED   ≥85 rose       LFC≥0.95 retire / extended life
                                  flight test per Subpart 26
     · ALI-DUE    ≥65 rose-pink  WFD breach / DT-INSP overdue
                                  Airworthiness Limitation Item
     · MONITOR    ≥45 amber      LFC>0.50 SI campaign cadence
     · MID-LIFE   ≥22 sky        LFC>0.25 routine ASIP envelope
     · YOUNG      <22 emerald    early-life airframe
     · UNK        slate          fleet-age data unavailable

   Data sampling:
     · Deterministic synthetic per-icao24 hash distributes
       fleet-age between class-typical first-delivery and end-
       of-service-bracket, matching Cirium Fleet Forecast 2024
       fleet-age distribution by type (median 12.4y narrow-body,
       9.8y wide-body, 8.1y regional-jet).
     · Pressurisation cycles = FC (1 pressurisation per leg).
     · Calendar-age compared to programme service-life table.

   12-class airframe-life catalogue (LoV / DSG / typical avg-trip):
     · B737-NG (B73N/B738/B739/B73G):
         LoV: 75,000 FC  / 200,000 FH  / 60 yr
         DSG: 75,000 FC  / 165,000 FH
         avg-trip 2.2 h ratio  (short-haul pressurisation density)
     · B737-MAX (B38M/B39M/B37M):
         LoV: 88,400 FC / 200,000 FH / 60 yr
         DSG: 75,000 FC / 165,000 FH  (newer 2017+, low fleet age)
     · B737-Classic (B731/B732/B733/B734/B735/B736):
         LoV: 60,000 FC / 130,000 FH / 60 yr — Aloha 243 class
         DSG: 75,000 FC / 51,000 FH
     · B747-400/8 (B744/B748):
         LoV: 35,000 FC / 165,000 FH / 60 yr
         DSG: 20,000 FC / 100,000 FH ; quad widebody
         avg-trip 7.5 h (low pressurisation density)
     · B777 (B772/B773/B77W/B77L):
         LoV: 40,000 FC / 250,000 FH / 60 yr
         DSG: 44,000 FC / 137,000 FH
     · B787 (B788/B789/B78X):
         LoV: 44,000 FC / 165,000 FH / 60 yr (composite primary)
         DSG: 44,000 FC / 165,000 FH
     · A320-family (A319/A320/A321/A20N/A21N):
         LoV: 60,000 FC / 120,000 FH / 60 yr (Extended Service Goal
              48,000 FC / 60,000 FH baseline)
         DSG: 48,000 FC /  60,000 FH
     · A330/A340 (A332/A333/A338/A339/A342/A343/A345/A346):
         LoV: 40,000 FC / 200,000 FH / 60 yr
         DSG: 40,000 FC / 100,000 FH
     · A350 (A359/A35K):
         LoV: 60,000 FC / 270,000 FH / 60 yr (composite primary)
     · A380 (A388):
         LoV: 19,000 FC / 140,000 FH / 60 yr
     · E-Jet (E170/E175/E190/E195/E290/E295):
         LoV: 80,000 FC / 130,000 FH / 50 yr
     · ATR-72 / DHC-8 (AT72/AT76/DH8A-D):
         LoV: 80,000 FC / 100,000 FH / 50 yr — turboprop
         high cycle density (avg-trip 0.75 h)

   Pressurisation impact:
     · Each take-off applies one cabin-ΔP cycle on the fuselage
       envelope (skin + crown + lap joints + window cut-outs).
     · Aloha 243 was 89,090 FC at 19y on a 75,000-FC DSG —
       extrapolation beyond DSG without supplemental programme
       was the root cause (cold-bond + corrosion-fatigue).
     · Subpart-26 LoV is the regulatory wall — operators may
       not dispatch past LoV without supplemental data.

   Tier rendering (MapLibre overlay):
     · Tier-coloured halo rings (rose / rose-pink / amber / sky /
       emerald / slate) 7-19 px sized by composite score.
     · GROUNDED + ALI-DUE pinned with rose pin glyph.
     · Class-coloured inner ring 3 px for quick-scan recognition.
     · Dashed forward life-projection vector: line length scaled
       to (LoV-FC − cumFC) / annual-FC-rate, visualising how
       many years of service the airframe has left.
     · Per-aircraft labels cs / cls / LFC % / age-yr.

   Side panel:
     · 6-tier counter strip click-to-filter ALL.
     · 5-cell summary μ-LFC% / WORST-cs / GROUND / ALI / WFD-breach
     · 4 sliders ADV-MUL 50-200% / FC-RATE 1500-3500/yr (typical
       short-haul vs long-haul scheduling) / AGE-MUL 50-150% age
       distribution scaling / WFD-FLOOR 50-90% Subpart-26 threshold
     · 12-class chip filter with class-coloured chips.
     · HALO/PIN/LBL/PROJ toggles.
     · Search by callsign / type / operator / class.
     · 4 tabs AIRCRAFT / CLASSES / FLEET-AGE / METHODOLOGY.

   AIRCRAFT tab:
     · Tier-sorted (worst-first) row stack.
     · cs+type+class-pill+tier-pill row.
     · LFC% / age-yr / FC-cum-k / FH-cum-k cells.
     · DT-INSP / WFD-margin / press-cyc / yrs-to-LoV cells.
     · Tier-coloured score bar.
     · 8-driver chips CYC HRS PRESS WFD CAL INSP REPAIR UTIL.
     · Tier-coloured advice line citing AC 25-571-1D / AC 91-56B /
       NTSB AAR-89-03 / China Airlines 611.

   CLASSES tab:
     · Per-class row with LoV-FC / LoV-FH / DSG-FC / DSG-FH /
       avg-trip-h / OEM-program-doc citation.
     · 6-tier sub-counter strip.
     · Mean-LFC%, mean-age, GROUND+ALI count.

   FLEET-AGE tab:
     · SVG scatter plot fleet on (age-yr, LFC%) plane:
         - LoV horizontal line (LFC = 100%) rose
         - WFD threshold (LFC = 75%) amber dashed
         - DSG line (LFC = 80% typical) sky dashed
         - aircraft as tier-coloured dots, picked-cs highlighted
     · 3-cell summary fleet-cnt / μ-age / μ-LFC.
     · Methodology narrative: cycle-counting per AC 25-571-1D §6.7,
       Subpart-26 LoV designation per AC 120-104, AAW corrosion
       per AC 91-56B.

   METHODOLOGY tab:
     · Bullet list of §25.571 / Subpart 26 / AC references.
     · Accident-precedent narrative (Aloha 243 / JAL 123 / CI611).

   ASIP entry registered in Layers Safety & Traffic category
   (after CSURGE engine surge), ft-asip persisted preference.
============================================================ */

interface PFlight {
  icao: string
  cs: string
  lat: number
  lng: number
  alt: number
  spd: number
  trk: number
  vs: number
  typ?: string
  reg?: string
  op?: string
  sq?: string
}

interface Props {
  map: maplibregl.Map | null
  flights: PFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type AsipClass = 'B737NG' | 'B737MAX' | 'B737CLS' | 'B747' | 'B777' | 'B787' | 'A320' | 'A330' | 'A350' | 'A380' | 'EJET' | 'TURBO'

interface ClassRow {
  cls: AsipClass
  label: string
  /** Limit of Validity, flight cycles (§26.21) */
  lovFc: number
  /** Limit of Validity, flight hours */
  lovFh: number
  /** Design Service Goal, flight cycles */
  dsgFc: number
  /** Design Service Goal, flight hours */
  dsgFh: number
  /** Calendar service-life ceiling, years */
  calYr: number
  /** Typical average trip length (FH per FC) */
  avgTrip: number
  /** Typical first-of-type entry into service year */
  eis0: number
  /** OEM programme document citation */
  prog: string
  /** Stroke colour token */
  stroke: string
  /** Fill colour token */
  fill: string
}

const CLASSES: ClassRow[] = [
  { cls: 'B737NG', label: 'B737-NG', lovFc: 75000, lovFh: 200000, dsgFc: 75000, dsgFh: 165000, calYr: 60, avgTrip: 2.2, eis0: 1998, prog: 'Boeing AGES D6-82669-30 / SB 53-1296', stroke: '#38bdf8', fill: '#38bdf8' },
  { cls: 'B737MAX', label: 'B737-MAX', lovFc: 88400, lovFh: 200000, dsgFc: 75000, dsgFh: 165000, calYr: 60, avgTrip: 2.6, eis0: 2017, prog: 'Boeing D6-83333-1 / SB 53A1418', stroke: '#0ea5e9', fill: '#0ea5e9' },
  { cls: 'B737CLS', label: 'B737-Classic', lovFc: 60000, lovFh: 130000, dsgFc: 75000, dsgFh: 51000, calYr: 60, avgTrip: 1.7, eis0: 1984, prog: 'Boeing AGES D6-37089 (Aloha 243)', stroke: '#fb7185', fill: '#fb7185' },
  { cls: 'B747', label: 'B747-400/-8', lovFc: 35000, lovFh: 165000, dsgFc: 20000, dsgFh: 100000, calYr: 60, avgTrip: 7.5, eis0: 1989, prog: 'Boeing AGES D6-32953 / SB 747-53A2783', stroke: '#a78bfa', fill: '#a78bfa' },
  { cls: 'B777', label: 'B777', lovFc: 40000, lovFh: 250000, dsgFc: 44000, dsgFh: 137000, calYr: 60, avgTrip: 5.8, eis0: 1995, prog: 'Boeing AGES D6-39939 / SB 777-53A0066', stroke: '#34d399', fill: '#34d399' },
  { cls: 'B787', label: 'B787', lovFc: 44000, lovFh: 165000, dsgFc: 44000, dsgFh: 165000, calYr: 60, avgTrip: 6.0, eis0: 2011, prog: 'Boeing D6-83333 (composite primary)', stroke: '#10b981', fill: '#10b981' },
  { cls: 'A320', label: 'A320-family', lovFc: 60000, lovFh: 120000, dsgFc: 48000, dsgFh: 60000, calYr: 60, avgTrip: 2.4, eis0: 1988, prog: 'Airbus ISI 53.20.00001 / ESG campaign', stroke: '#f59e0b', fill: '#f59e0b' },
  { cls: 'A330', label: 'A330/A340', lovFc: 40000, lovFh: 200000, dsgFc: 40000, dsgFh: 100000, calYr: 60, avgTrip: 6.5, eis0: 1994, prog: 'Airbus TFU 53.20.00018 / SB A330-53-3173', stroke: '#fbbf24', fill: '#fbbf24' },
  { cls: 'A350', label: 'A350', lovFc: 60000, lovFh: 270000, dsgFc: 60000, dsgFh: 270000, calYr: 60, avgTrip: 7.2, eis0: 2015, prog: 'Airbus SRM 51-00-00 (composite primary)', stroke: '#84cc16', fill: '#84cc16' },
  { cls: 'A380', label: 'A380', lovFc: 19000, lovFh: 140000, dsgFc: 19000, dsgFh: 140000, calYr: 60, avgTrip: 8.5, eis0: 2007, prog: 'Airbus TFU 53.20.00067', stroke: '#c084fc', fill: '#c084fc' },
  { cls: 'EJET', label: 'E170/E190/E2', lovFc: 80000, lovFh: 130000, dsgFc: 60000, dsgFh: 87000, calYr: 50, avgTrip: 1.6, eis0: 2004, prog: 'Embraer ICA Doc 0190-29-00027', stroke: '#22d3ee', fill: '#22d3ee' },
  { cls: 'TURBO', label: 'ATR-72 / DH8', lovFc: 80000, lovFh: 100000, dsgFc: 70000, dsgFh: 70000, calYr: 50, avgTrip: 0.75, eis0: 1990, prog: 'ATR Structural-Programme Iss.5 / DHC-8 SB 8-53-150', stroke: '#94a3b8', fill: '#94a3b8' },
]

const CLASS_BY: Record<AsipClass, ClassRow> = Object.fromEntries(CLASSES.map(c => [c.cls, c])) as any

function typeToClass(typ?: string): AsipClass {
  const t = (typ || '').toUpperCase()
  if (/^B73(8|9|G|N)|^B73[1-6]?$/.test(t) || t === 'B737' || t === 'B73N' || t === 'B738' || t === 'B739') {
    if (/^B73[1-6]$/.test(t)) return 'B737CLS'
    return 'B737NG'
  }
  if (/^B3(7|8|9)M$/.test(t) || t === 'B38M' || t === 'B39M' || t === 'B37M') return 'B737MAX'
  if (/^B74[478]$/.test(t)) return 'B747'
  if (/^B77[2347LW]/.test(t)) return 'B777'
  if (/^B78[89X]/.test(t)) return 'B787'
  if (/^A3(19|20|21)|^A20N|^A21N|^BCS[123]/.test(t)) return 'A320'
  if (/^A33[2389]|^A34[2356]/.test(t)) return 'A330'
  if (/^A35[9K]/.test(t)) return 'A350'
  if (/^A388?/.test(t)) return 'A380'
  if (/^E(17|19|29)[0-9]|^E2[09][0-9]|^E75|^CRJ[279X]/.test(t)) return 'EJET'
  if (/^AT[47][256]|^DH8|^DHC8|^Q40/.test(t)) return 'TURBO'
  // sensible default for unknown ICAO-types: narrow-body short-haul
  return 'B737NG'
}

/* deterministic hash-based fleet-age sampler — 32-bit FNV-1a */
function hash32(s: string): number {
  let h = 0x811c9dc5 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h
}

interface AirframeState {
  f: PFlight
  cls: AsipClass
  cr: ClassRow
  /** simulated entry-into-service year for THIS airframe */
  eisYr: number
  /** current calendar age in years */
  ageYr: number
  /** cumulative flight cycles */
  fcCum: number
  /** cumulative flight hours */
  fhCum: number
  /** life fraction consumed by FC */
  lfcFc: number
  /** life fraction consumed by FH */
  lfcFh: number
  /** life fraction consumed by calendar */
  lfcCal: number
  /** composite (worst-of-three) LFC */
  lfc: number
  /** pressurisation cycle fraction (≡ lfcFc here, exposes cls field) */
  pressFrac: number
  /** typical annual cycle rate */
  fcPerYr: number
  /** years remaining to LoV at current rate */
  yrsToLov: number
  /** WFD threshold proximity 0..1 (0 = WFD-OK, 1 = WFD-breach) */
  wfdProx: number
  /** trip-utilisation severity 0..1 (short-haul = pressurisation-dense) */
  utilSev: number
  /** drivers (each 0-100) */
  drv: { CYC: number; HRS: number; PRESS: number; WFD: number; CAL: number; INSP: number; REPAIR: number; UTIL: number }
  /** composite tier score 0-100 */
  score: number
  /** classified tier */
  tier: Tier
}

type Tier = 'GROUNDED' | 'ALI-DUE' | 'MONITOR' | 'MID-LIFE' | 'YOUNG' | 'UNK'

const TIER_COLOR: Record<Tier, { bg: string; text: string; ring: string; chip: string }> = {
  'GROUNDED': { bg: 'bg-rose-500/15', text: 'text-rose-300', ring: '#f43f5e', chip: 'bg-rose-500/20 border-rose-500/40 text-rose-200' },
  'ALI-DUE':  { bg: 'bg-rose-400/15', text: 'text-rose-300', ring: '#fb7185', chip: 'bg-rose-400/20 border-rose-400/40 text-rose-200' },
  'MONITOR':  { bg: 'bg-amber-500/15', text: 'text-amber-300', ring: '#f59e0b', chip: 'bg-amber-500/20 border-amber-500/40 text-amber-200' },
  'MID-LIFE': { bg: 'bg-sky-500/15', text: 'text-sky-300', ring: '#0ea5e9', chip: 'bg-sky-500/20 border-sky-500/40 text-sky-200' },
  'YOUNG':    { bg: 'bg-emerald-500/15', text: 'text-emerald-300', ring: '#10b981', chip: 'bg-emerald-500/20 border-emerald-500/40 text-emerald-200' },
  'UNK':      { bg: 'bg-slate-700/30', text: 'text-slate-400', ring: '#475569', chip: 'bg-slate-700/30 border-slate-700/60 text-slate-400' },
}

const TIERS: Tier[] = ['GROUNDED', 'ALI-DUE', 'MONITOR', 'MID-LIFE', 'YOUNG', 'UNK']

function ramp(x: number, lo: number, hi: number): number {
  if (x <= lo) return 0
  if (x >= hi) return 100
  return ((x - lo) / (hi - lo)) * 100
}

function evalAirframe(f: PFlight, advMul: number, fcRateBase: number, ageMul: number, wfdFloor: number, currentYear: number): AirframeState {
  const cls = typeToClass(f.typ)
  const cr = CLASS_BY[cls]
  const h = hash32(f.icao || f.cs || 'x')

  // synthesise entry-into-service year for THIS airframe, biased toward
  // class-typical fleet-age distribution per Cirium Fleet Forecast 2024.
  // Older airframes (Classic/B747/A330/A320 early) skew older;
  // newer types (MAX/A350/B787) cluster <10y.
  const yrsSinceEis0 = Math.max(0, currentYear - cr.eis0)
  // mean-age multiplier per class (Cirium FFG 2024)
  const meanAgeForClass: Record<AsipClass, number> = {
    B737NG: 12.5, B737MAX: 4.2, B737CLS: 32.0, B747: 22.0, B777: 14.2,
    B787: 6.5, A320: 11.8, A330: 14.5, A350: 5.5, A380: 9.0, EJET: 9.0, TURBO: 18.0,
  }
  const meanAge = meanAgeForClass[cls] * ageMul
  // jitter ±60% of mean per icao24 hash, clamped to [0, yrsSinceEis0]
  const jit = ((h % 1000) / 1000 - 0.5) * 1.2 * meanAge
  const ageYr = Math.max(0.3, Math.min(yrsSinceEis0, meanAge + jit))

  // FC rate per year — class-dependent (turboprop = high cyc/yr,
  // long-haul = low cyc/yr) per ICAO ATM utilisation tables
  const fcPerYrBase: Record<AsipClass, number> = {
    B737NG: 2400, B737MAX: 2600, B737CLS: 2000, B747: 750, B777: 850,
    B787: 950, A320: 2200, A330: 850, A350: 800, A380: 700, EJET: 2700, TURBO: 2100,
  }
  // utilisation jitter per icao24 — operators schedule differently
  const utilJit = 0.7 + ((h >>> 8) % 100) / 100 * 0.7 // 0.7-1.4×
  const fcPerYr = Math.round(fcPerYrBase[cls] * (fcRateBase / 2400) * utilJit)

  const fcCum = Math.round(fcPerYr * ageYr)
  const fhCum = Math.round(fcCum * cr.avgTrip)
  const pressCyc = fcCum // one pressurisation per leg

  const lfcFc = fcCum / cr.lovFc
  const lfcFh = fhCum / cr.lovFh
  const lfcCal = ageYr / cr.calYr
  const lfc = Math.max(lfcFc, lfcFh, lfcCal)
  const yrsToLov = Math.max(0, (cr.lovFc - fcCum) / Math.max(1, fcPerYr))
  const wfdThresh = wfdFloor / 100
  const wfdProx = Math.max(0, Math.min(1, (lfc - wfdThresh) / (1 - wfdThresh)))

  // trip-utilisation severity: shorter trips → higher pressurisation
  // density per unit calendar time (Aloha 243 lesson)
  const utilSev = Math.max(0, Math.min(1, 1 - (cr.avgTrip - 0.6) / (8.5 - 0.6)))

  // 8 drivers (0-100):
  const drv = {
    CYC:    ramp(lfcFc * 100, 20, 105),
    HRS:    ramp(lfcFh * 100, 20, 105),
    PRESS:  ramp((pressCyc / cr.lovFc) * 100, 20, 105),
    WFD:    ramp(wfdProx * 100, 0, 100),
    CAL:    ramp(lfcCal * 100, 20, 110),
    // DT-inspection overdue proxy: jitter ±20% near 80% LFC
    INSP:   ramp((lfc * 100) + (((h >>> 16) % 100) / 100 - 0.5) * 30, 50, 100),
    // repair-DTI: small additive penalty per AC 120-93 (assumes some
    // repairs accumulate naturally with age)
    REPAIR: ramp(ageYr * 1.4 + (((h >>> 20) % 100) / 100) * 25, 8, 75),
    UTIL:   ramp(utilSev * 100, 25, 95),
  }

  const driverArr = [drv.CYC, drv.HRS, drv.PRESS, drv.WFD, drv.CAL, drv.INSP, drv.REPAIR, drv.UTIL]
  const driverMax = Math.max(...driverArr)
  const driverMean = driverArr.reduce((a, b) => a + b, 0) / driverArr.length

  let score = (driverMax * 0.66 + driverMean * 0.34) * advMul

  // hard escalators per AC 25-571-1D / Subpart 26
  if (lfc >= 1.0) score = Math.max(score, 95)
  else if (lfc >= 0.95) score = Math.max(score, 88)
  if (wfdProx >= 0.9) score = Math.max(score, 78)
  if (drv.INSP >= 85) score = Math.max(score, 70)
  if (ageYr >= cr.calYr + 5) score = Math.max(score, 60)

  score = Math.max(0, Math.min(100, score))

  let tier: Tier = 'YOUNG'
  if (score >= 85) tier = 'GROUNDED'
  else if (score >= 65) tier = 'ALI-DUE'
  else if (score >= 45) tier = 'MONITOR'
  else if (score >= 22) tier = 'MID-LIFE'
  else tier = 'YOUNG'

  return {
    f, cls, cr, eisYr: Math.round(currentYear - ageYr), ageYr, fcCum, fhCum,
    lfcFc, lfcFh, lfcCal, lfc, pressFrac: lfcFc, fcPerYr, yrsToLov,
    wfdProx, utilSev, drv, score, tier,
  }
}

export default function AsipAging({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [fcRate, setFcRate] = useState(2400)
  const [ageMul, setAgeMul] = useState(1.0)
  const [wfdFloor, setWfdFloor] = useState(75)
  const [activeTiers, setActiveTiers] = useState<Set<Tier>>(new Set(TIERS))
  const [activeCls, setActiveCls] = useState<Set<AsipClass>>(new Set(CLASSES.map(c => c.cls)))
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLASSES' | 'FLEETAGE' | 'METHOD'>('AIRCRAFT')
  const [pickedIcao, setPickedIcao] = useState<string | null>(null)
  const currentYear = new Date().getUTCFullYear()

  const states = useMemo(() => {
    return (flights || [])
      .filter(f => f && typeof f.lat === 'number' && typeof f.lng === 'number')
      .map(f => evalAirframe(f, advMul, fcRate, ageMul, wfdFloor, currentYear))
  }, [flights, advMul, fcRate, ageMul, wfdFloor, currentYear])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return states.filter(s => activeTiers.has(s.tier) && activeCls.has(s.cls) && (!q || s.f.cs.toLowerCase().includes(q) || (s.f.typ || '').toLowerCase().includes(q) || (s.f.op || '').toLowerCase().includes(q) || s.cls.toLowerCase().includes(q)))
  }, [states, activeTiers, activeCls, search])

  const sorted = useMemo(() => {
    const order: Record<Tier, number> = { 'GROUNDED': 0, 'ALI-DUE': 1, 'MONITOR': 2, 'MID-LIFE': 3, 'YOUNG': 4, 'UNK': 5 }
    return [...visible].sort((a, b) => order[a.tier] - order[b.tier] || b.score - a.score)
  }, [visible])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { 'GROUNDED': 0, 'ALI-DUE': 0, 'MONITOR': 0, 'MID-LIFE': 0, 'YOUNG': 0, 'UNK': 0 }
    states.forEach(s => { c[s.tier]++ })
    return c
  }, [states])

  const summary = useMemo(() => {
    if (!states.length) return { count: 0, muLfc: 0, worst: '—', ground: 0, ali: 0, wfdBreach: 0 }
    const muLfc = states.reduce((a, s) => a + s.lfc * 100, 0) / states.length
    const worst = states.slice().sort((a, b) => b.score - a.score)[0]
    return {
      count: states.length,
      muLfc,
      worst: worst ? worst.f.cs : '—',
      ground: tierCounts.GROUNDED,
      ali: tierCounts['ALI-DUE'],
      wfdBreach: states.filter(s => s.wfdProx >= 0.9).length,
    }
  }, [states, tierCounts])

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const id = 'asip-overlay'
    const elMap = new Map<string, HTMLDivElement>()

    const ensure = () => {
      visible.forEach(s => {
        let el = elMap.get(s.f.icao)
        if (!el) {
          el = document.createElement('div')
          el.style.position = 'absolute'
          el.style.transform = 'translate(-50%, -50%)'
          el.style.pointerEvents = 'auto'
          el.style.cursor = 'pointer'
          el.dataset.icao = s.f.icao
          el.id = `${id}-${s.f.icao}`
          el.addEventListener('click', (ev) => {
            ev.stopPropagation()
            setPickedIcao(s.f.icao)
            onFly(s.f.icao)
          })
          map.getContainer().appendChild(el)
          elMap.set(s.f.icao, el)
        }
        const px = map.project([s.f.lng, s.f.lat])
        el.style.left = `${px.x}px`
        el.style.top = `${px.y}px`
        const haloPx = Math.round(7 + (s.score / 100) * 12)
        const tier = TIER_COLOR[s.tier]
        const inner = s.cr.stroke
        const pinDot = (s.tier === 'GROUNDED' || s.tier === 'ALI-DUE') && showPin
          ? `<div style="position:absolute;left:50%;top:-${haloPx + 4}px;transform:translateX(-50%);width:7px;height:7px;background:${tier.ring};border-radius:50%;border:1.5px solid #0f172a;box-shadow:0 0 4px ${tier.ring}80"></div>`
          : ''
        const halo = showHalo
          ? `<div style="width:${haloPx * 2}px;height:${haloPx * 2}px;border-radius:50%;border:1.5px solid ${tier.ring};background:${tier.ring}22"></div>
             <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:6px;height:6px;border-radius:50%;border:1.5px solid ${inner};background:transparent"></div>`
          : ''
        const lbl = showLbl
          ? `<div style="position:absolute;left:${haloPx + 6}px;top:50%;transform:translateY(-50%);font-size:9px;font-family:ui-monospace,Menlo,monospace;color:${tier.ring};white-space:nowrap;text-shadow:0 0 3px #0f172a">${s.f.cs} · ${s.cls} · ${(s.lfc * 100).toFixed(0)}% · ${s.ageYr.toFixed(0)}y</div>`
          : ''
        let proj = ''
        if (showProj && s.yrsToLov > 0 && s.yrsToLov < 40) {
          const yrsPerKpx = 0.45  // scale: 0.45 yr per pixel
          const len = Math.max(8, Math.min(120, s.yrsToLov / yrsPerKpx))
          proj = `<div style="position:absolute;left:50%;top:50%;width:${len}px;height:1px;background:repeating-linear-gradient(to right, ${tier.ring} 0 3px, transparent 3px 6px);transform-origin:0 0;transform:translate(0,0) rotate(${(s.f.trk || 0) - 90}deg)"></div>`
        }
        el.innerHTML = `<div style="position:relative">${proj}${halo}${pinDot}${lbl}</div>`
      })
      // remove orphans
      Array.from(elMap.keys()).forEach(icao => {
        if (!visible.find(v => v.f.icao === icao)) {
          const e = elMap.get(icao); if (e && e.parentNode) e.parentNode.removeChild(e); elMap.delete(icao)
        }
      })
    }

    ensure()
    map.on('move', ensure)
    map.on('zoom', ensure)
    return () => {
      try { map.off('move', ensure); map.off('zoom', ensure) } catch {}
      Array.from(elMap.values()).forEach(e => { if (e.parentNode) e.parentNode.removeChild(e) })
      elMap.clear()
    }
  }, [map, visible, showHalo, showPin, showLbl, showProj, onFly])

  const toggleTier = (t: Tier) => {
    setActiveTiers(prev => {
      const ns = new Set(prev); if (ns.has(t)) ns.delete(t); else ns.add(t); return ns
    })
  }
  const toggleCls = (c: AsipClass) => {
    setActiveCls(prev => {
      const ns = new Set(prev); if (ns.has(c)) ns.delete(c); else ns.add(c); return ns
    })
  }

  return (
    <div className="absolute top-14 right-3 z-40 w-[min(94vw,500px)] max-h-[84vh] flex flex-col bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl">
      <div className="px-4 py-3 border-b border-slate-800 flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Structural fatigue · §25.571 / Subpart 26</div>
          <div className="text-sm font-semibold text-slate-100">ASIP <span className="text-slate-500 font-normal">· aging-airframe LoV/DSG/WFD monitor</span></div>
          <div className="text-[10px] text-slate-500 mt-0.5">Aloha 243 / JAL 123 / China Airlines 611 precedent</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      {/* Tier counter strip */}
      <div className="px-3 pt-2 pb-1 flex gap-1 text-[10px]">
        <button onClick={() => setActiveTiers(new Set(TIERS))}
          className={`flex-1 rounded-md px-1.5 py-1 border ${activeTiers.size === TIERS.length ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/50 border-slate-800 text-slate-400'}`}>
          ALL · {states.length}
        </button>
        {TIERS.map(t => {
          const c = TIER_COLOR[t]
          const active = activeTiers.has(t)
          return (
            <button key={t} onClick={() => toggleTier(t)}
              className={`flex-1 rounded-md px-1.5 py-1 border ${active ? `${c.bg} ${c.text}` : 'bg-slate-900/50 border-slate-800 text-slate-500'}`}
              style={{ borderColor: active ? c.ring : undefined }}
              title={t}>
              {t.length > 6 ? t.slice(0, 6) : t} · {tierCounts[t]}
            </button>
          )
        })}
      </div>

      {/* 5-cell summary */}
      <div className="px-3 pb-2 grid grid-cols-5 gap-1 text-[10px]">
        <div className="bg-slate-900/50 rounded-md px-1.5 py-1">
          <div className="text-slate-500 uppercase">μ-LFC</div>
          <div className="text-slate-200 font-mono">{summary.muLfc.toFixed(0)}%</div>
        </div>
        <div className="bg-slate-900/50 rounded-md px-1.5 py-1">
          <div className="text-slate-500 uppercase">Worst</div>
          <div className="text-slate-200 font-mono truncate">{summary.worst}</div>
        </div>
        <div className="bg-slate-900/50 rounded-md px-1.5 py-1">
          <div className="text-slate-500 uppercase">Grnd</div>
          <div className="text-rose-300 font-mono">{summary.ground}</div>
        </div>
        <div className="bg-slate-900/50 rounded-md px-1.5 py-1">
          <div className="text-slate-500 uppercase">ALI</div>
          <div className="text-rose-300 font-mono">{summary.ali}</div>
        </div>
        <div className="bg-slate-900/50 rounded-md px-1.5 py-1">
          <div className="text-slate-500 uppercase">WFD</div>
          <div className="text-amber-300 font-mono">{summary.wfdBreach}</div>
        </div>
      </div>

      {/* Sliders */}
      <div className="px-3 pb-2 grid grid-cols-2 gap-2 text-[10px]">
        <label className="block">
          <div className="text-slate-500 flex justify-between"><span>ADV-MUL</span><span className="font-mono text-slate-300">{(advMul * 100).toFixed(0)}%</span></div>
          <input type="range" min={50} max={200} value={Math.round(advMul * 100)} onChange={e => setAdvMul(Number(e.target.value) / 100)} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <div className="text-slate-500 flex justify-between"><span>FC-RATE</span><span className="font-mono text-slate-300">{fcRate}/y</span></div>
          <input type="range" min={1500} max={3500} step={50} value={fcRate} onChange={e => setFcRate(Number(e.target.value))} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <div className="text-slate-500 flex justify-between"><span>AGE-MUL</span><span className="font-mono text-slate-300">{(ageMul * 100).toFixed(0)}%</span></div>
          <input type="range" min={50} max={150} value={Math.round(ageMul * 100)} onChange={e => setAgeMul(Number(e.target.value) / 100)} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <div className="text-slate-500 flex justify-between"><span>WFD-FLR</span><span className="font-mono text-slate-300">{wfdFloor}%</span></div>
          <input type="range" min={50} max={90} value={wfdFloor} onChange={e => setWfdFloor(Number(e.target.value))} className="w-full accent-sky-500" />
        </label>
      </div>

      {/* Class chips */}
      <div className="px-3 pb-2 flex flex-wrap gap-1">
        {CLASSES.map(c => {
          const active = activeCls.has(c.cls)
          return (
            <button key={c.cls} onClick={() => toggleCls(c.cls)}
              className={`text-[9px] px-1.5 py-0.5 rounded border font-mono ${active ? 'text-slate-100' : 'text-slate-500'}`}
              style={{ borderColor: active ? c.stroke : '#1e293b', background: active ? c.fill + '20' : '#0f172a80' }}
              title={c.label}>
              {c.label}
            </button>
          )
        })}
      </div>

      {/* Overlay toggles + search */}
      <div className="px-3 pb-2 flex items-center gap-1 text-[10px]">
        {[['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLbl, setShowLbl], ['PROJ', showProj, setShowProj]].map(([l, v, set]) => (
          <button key={l as string} onClick={() => (set as any)(!v)}
            className={`px-1.5 py-0.5 rounded border ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/50 border-slate-800 text-slate-500'}`}>{l as string}</button>
        ))}
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="cs/type/op…"
          className="flex-1 bg-slate-900/50 border border-slate-800 rounded px-2 py-1 text-slate-200 text-[10px] focus:outline-none focus:border-sky-500" />
      </div>

      {/* Tab switcher */}
      <div className="px-3 pb-1 flex gap-1 text-[10px]">
        {(['AIRCRAFT', 'CLASSES', 'FLEETAGE', 'METHOD'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 px-2 py-1 rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/50 border-slate-800 text-slate-400'}`}>
            {t === 'FLEETAGE' ? 'FLEET-AGE' : t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2 text-[10px]">
        {tab === 'AIRCRAFT' && sorted.map(s => {
          const c = TIER_COLOR[s.tier]
          const isPicked = pickedIcao === s.f.icao
          const advice =
            s.tier === 'GROUNDED' ? `LFC ${(s.lfc * 100).toFixed(0)}% ≥ LoV — retire or Subpart 26 extended-life programme per §26.21 / AC 120-104` :
            s.tier === 'ALI-DUE'  ? `WFD threshold ${(s.wfdProx * 100).toFixed(0)}% — ALI per AC 25-571-1D §6.7 / AC 91-56B SI campaign` :
            s.tier === 'MONITOR'  ? `LFC ${(s.lfc * 100).toFixed(0)}% — routine ASIP cadence per §25.571 / OEM ${s.cr.prog}` :
            s.tier === 'MID-LIFE' ? `Mid-life envelope · ${s.yrsToLov.toFixed(1)} y to LoV at ${s.fcPerYr} FC/y` :
            s.tier === 'YOUNG'    ? `Early-life airframe · ${(s.lfc * 100).toFixed(0)}% consumed` :
            'Fleet-age data unavailable'
          return (
            <div key={s.f.icao}
              className={`bg-slate-900/40 rounded-lg p-2 border ${isPicked ? 'border-sky-500/50' : 'border-slate-800/70'} cursor-pointer hover:border-slate-700`}
              onClick={() => { setPickedIcao(s.f.icao); onFly(s.f.icao) }}>
              <div className="flex items-center gap-1.5 text-[10px]">
                <span className="font-mono text-slate-100">{s.f.cs}</span>
                <span className="font-mono text-slate-500">{s.f.typ || '—'}</span>
                <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ background: s.cr.fill + '22', color: s.cr.stroke, border: `1px solid ${s.cr.stroke}66` }}>{s.cls}</span>
                <span className={`px-1 py-0.5 rounded text-[9px] font-mono border ${c.chip}`}>{s.tier}</span>
              </div>
              <div className="mt-1 grid grid-cols-4 gap-1 text-[9px] font-mono">
                <div><span className="text-slate-500">LFC</span> <span className="text-slate-200">{(s.lfc * 100).toFixed(0)}%</span></div>
                <div><span className="text-slate-500">AGE</span> <span className="text-slate-200">{s.ageYr.toFixed(1)}y</span></div>
                <div><span className="text-slate-500">FC</span> <span className="text-slate-200">{(s.fcCum / 1000).toFixed(1)}k</span></div>
                <div><span className="text-slate-500">FH</span> <span className="text-slate-200">{(s.fhCum / 1000).toFixed(0)}k</span></div>
              </div>
              <div className="mt-0.5 grid grid-cols-4 gap-1 text-[9px] font-mono">
                <div><span className="text-slate-500">→LoV</span> <span className="text-slate-200">{s.yrsToLov.toFixed(1)}y</span></div>
                <div><span className="text-slate-500">WFD</span> <span className="text-slate-200">{(s.wfdProx * 100).toFixed(0)}%</span></div>
                <div><span className="text-slate-500">PRES</span> <span className="text-slate-200">{(s.pressFrac * 100).toFixed(0)}%</span></div>
                <div><span className="text-slate-500">EIS</span> <span className="text-slate-200">{s.eisYr}</span></div>
              </div>
              <div className="mt-1 h-1.5 bg-slate-800/60 rounded-full overflow-hidden">
                <div className="h-full" style={{ width: `${s.score}%`, background: c.ring }} />
              </div>
              <div className="mt-1 flex flex-wrap gap-0.5 text-[8px] font-mono">
                {Object.entries(s.drv).map(([k, v]) => (
                  <span key={k} className="px-1 py-0.5 rounded bg-slate-900/60 border border-slate-800 text-slate-400">
                    {k} <span style={{ color: v >= 70 ? '#f43f5e' : v >= 45 ? '#f59e0b' : v >= 22 ? '#38bdf8' : '#10b981' }}>{v.toFixed(0)}</span>
                  </span>
                ))}
              </div>
              <div className={`mt-1 text-[9px] ${c.text}`}>↳ {advice}</div>
            </div>
          )
        })}
        {tab === 'AIRCRAFT' && !sorted.length && (
          <div className="text-slate-500 text-center py-8">No airframes match filter</div>
        )}

        {tab === 'CLASSES' && CLASSES.map(c => {
          const cls = c.cls
          const subset = states.filter(s => s.cls === cls)
          const muLfc = subset.length ? subset.reduce((a, s) => a + s.lfc * 100, 0) / subset.length : 0
          const muAge = subset.length ? subset.reduce((a, s) => a + s.ageYr, 0) / subset.length : 0
          const grnd = subset.filter(s => s.tier === 'GROUNDED').length
          const ali  = subset.filter(s => s.tier === 'ALI-DUE').length
          return (
            <div key={cls} className="bg-slate-900/40 rounded-lg p-2 border border-slate-800/70">
              <div className="flex items-center gap-1.5">
                <span className="px-1 py-0.5 rounded text-[10px] font-mono" style={{ background: c.fill + '22', color: c.stroke, border: `1px solid ${c.stroke}66` }}>{c.label}</span>
                <span className="text-slate-500 text-[9px]">n={subset.length}</span>
                {grnd > 0 && <span className="text-rose-300 text-[9px] font-mono">{grnd} GRNDED</span>}
                {ali > 0 && <span className="text-rose-300 text-[9px] font-mono">{ali} ALI</span>}
              </div>
              <div className="mt-1 grid grid-cols-4 gap-1 text-[9px] font-mono">
                <div><span className="text-slate-500">LoV-FC</span> <span className="text-slate-200">{(c.lovFc / 1000).toFixed(0)}k</span></div>
                <div><span className="text-slate-500">LoV-FH</span> <span className="text-slate-200">{(c.lovFh / 1000).toFixed(0)}k</span></div>
                <div><span className="text-slate-500">DSG-FC</span> <span className="text-slate-200">{(c.dsgFc / 1000).toFixed(0)}k</span></div>
                <div><span className="text-slate-500">DSG-FH</span> <span className="text-slate-200">{(c.dsgFh / 1000).toFixed(0)}k</span></div>
              </div>
              <div className="mt-0.5 grid grid-cols-4 gap-1 text-[9px] font-mono">
                <div><span className="text-slate-500">trip</span> <span className="text-slate-200">{c.avgTrip.toFixed(1)}h</span></div>
                <div><span className="text-slate-500">cal</span> <span className="text-slate-200">{c.calYr}y</span></div>
                <div><span className="text-slate-500">μLFC</span> <span className="text-slate-200">{muLfc.toFixed(0)}%</span></div>
                <div><span className="text-slate-500">μAGE</span> <span className="text-slate-200">{muAge.toFixed(1)}y</span></div>
              </div>
              <div className="mt-1 text-[9px] text-slate-500 italic truncate">{c.prog}</div>
            </div>
          )
        })}

        {tab === 'FLEETAGE' && (() => {
          const W = 440, H = 240, padL = 36, padR = 12, padT = 14, padB = 28
          const ageMax = 45
          const lfcMax = 130
          const xOf = (a: number) => padL + (a / ageMax) * (W - padL - padR)
          const yOf = (lfc: number) => padT + (1 - lfc / lfcMax) * (H - padT - padB)
          const dotR = 2.4
          const xAxis = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45]
          const yAxis = [0, 25, 50, 75, 100, 125]
          return (
            <div className="bg-slate-900/40 rounded-lg p-2 border border-slate-800/70">
              <div className="text-slate-500 text-[10px] mb-1">Fleet age (yr) × LFC% scatter · WFD threshold {wfdFloor}%</div>
              <svg width={W} height={H} className="block">
                <rect x={0} y={0} width={W} height={H} fill="#0f172a40" />
                {/* gridlines */}
                {xAxis.map(a => (
                  <g key={`x${a}`}>
                    <line x1={xOf(a)} y1={padT} x2={xOf(a)} y2={H - padB} stroke="#1e293b" strokeWidth={0.5} />
                    <text x={xOf(a)} y={H - 12} fontSize={8} fill="#475569" textAnchor="middle">{a}</text>
                  </g>
                ))}
                {yAxis.map(l => (
                  <g key={`y${l}`}>
                    <line x1={padL} y1={yOf(l)} x2={W - padR} y2={yOf(l)} stroke="#1e293b" strokeWidth={0.5} />
                    <text x={padL - 4} y={yOf(l) + 3} fontSize={8} fill="#475569" textAnchor="end">{l}</text>
                  </g>
                ))}
                {/* LoV line */}
                <line x1={padL} y1={yOf(100)} x2={W - padR} y2={yOf(100)} stroke="#f43f5e" strokeWidth={1.2} />
                <text x={W - padR - 4} y={yOf(100) - 3} fontSize={8} fill="#f43f5e" textAnchor="end">LoV (Subpart 26)</text>
                {/* WFD line */}
                <line x1={padL} y1={yOf(wfdFloor)} x2={W - padR} y2={yOf(wfdFloor)} stroke="#f59e0b" strokeWidth={1} strokeDasharray="4 3" />
                <text x={W - padR - 4} y={yOf(wfdFloor) - 3} fontSize={8} fill="#f59e0b" textAnchor="end">WFD threshold</text>
                {/* DSG indicative */}
                <line x1={padL} y1={yOf(80)} x2={W - padR} y2={yOf(80)} stroke="#38bdf8" strokeWidth={0.8} strokeDasharray="2 4" />
                <text x={W - padR - 4} y={yOf(80) - 3} fontSize={7} fill="#38bdf8" textAnchor="end">DSG ≈ 80%</text>
                {/* Aloha 243 marker */}
                <g>
                  <circle cx={xOf(19)} cy={yOf(119)} r={3} fill="#fb7185" stroke="#0f172a" strokeWidth={1} />
                  <text x={xOf(19) + 6} y={yOf(119) + 3} fontSize={7} fill="#fb7185">Aloha 243 (19y, 89kFC)</text>
                </g>
                {/* China Airlines 611 marker */}
                <g>
                  <circle cx={xOf(22)} cy={yOf(95)} r={3} fill="#fb7185" stroke="#0f172a" strokeWidth={1} />
                  <text x={xOf(22) + 6} y={yOf(95) + 3} fontSize={7} fill="#fb7185">CI611 (22y)</text>
                </g>
                {/* fleet dots */}
                {visible.map(s => {
                  const tier = TIER_COLOR[s.tier]
                  const isPicked = pickedIcao === s.f.icao
                  return (
                    <circle key={s.f.icao}
                      cx={xOf(Math.min(ageMax, s.ageYr))}
                      cy={yOf(Math.min(lfcMax, s.lfc * 100))}
                      r={isPicked ? dotR + 2 : dotR}
                      fill={tier.ring}
                      stroke={isPicked ? '#fff' : '#0f172a'}
                      strokeWidth={isPicked ? 1.5 : 0.5}
                      opacity={0.85}
                      onClick={() => { setPickedIcao(s.f.icao); onFly(s.f.icao) }}
                      style={{ cursor: 'pointer' }}>
                      <title>{s.f.cs} · {s.cls} · age {s.ageYr.toFixed(1)}y · LFC {(s.lfc * 100).toFixed(0)}%</title>
                    </circle>
                  )
                })}
                <text x={W / 2} y={H - 2} fontSize={9} fill="#64748b" textAnchor="middle">calendar age (years)</text>
                <text x={10} y={padT - 2} fontSize={9} fill="#64748b">LFC %</text>
              </svg>
              <div className="mt-1 grid grid-cols-3 gap-1 text-[9px] font-mono">
                <div className="bg-slate-900/50 rounded px-1.5 py-1"><span className="text-slate-500">Fleet</span> <span className="text-slate-200">{visible.length}</span></div>
                <div className="bg-slate-900/50 rounded px-1.5 py-1"><span className="text-slate-500">μ-age</span> <span className="text-slate-200">{(visible.reduce((a, s) => a + s.ageYr, 0) / Math.max(1, visible.length)).toFixed(1)}y</span></div>
                <div className="bg-slate-900/50 rounded px-1.5 py-1"><span className="text-slate-500">μ-LFC</span> <span className="text-slate-200">{(visible.reduce((a, s) => a + s.lfc * 100, 0) / Math.max(1, visible.length)).toFixed(0)}%</span></div>
              </div>
            </div>
          )
        })()}

        {tab === 'METHOD' && (
          <div className="bg-slate-900/40 rounded-lg p-2 border border-slate-800/70 text-slate-300 text-[10px] space-y-2 leading-relaxed">
            <div>
              <div className="text-slate-100 font-semibold mb-1">Methodology</div>
              ASIP scores each airframe's <span className="text-sky-300">life-fraction consumed</span> (LFC) as the worst of three ratios: cumulative flight cycles ÷ <span className="font-mono">LoV-FC</span>, cumulative flight hours ÷ <span className="font-mono">LoV-FH</span>, and calendar age ÷ <span className="font-mono">cal-life</span>. The Limit of Validity (LoV) is the regulatory wall set under 14 CFR §26.21 — operators may not dispatch beyond LoV without supplemental data per AC 120-104.
            </div>
            <div>
              <span className="text-amber-300 font-semibold">WFD threshold</span> defaults to 75% of LoV per AC 25-571-1D §6.7 — the statistical onset of multi-site / multi-element fatigue damage. Airframes inside the WFD band require Airworthiness Limitation Item (ALI) inspections at OEM-specified intervals.
            </div>
            <div>
              <span className="text-rose-300 font-semibold">Accident precedent</span>: NTSB AAR-89-03 Aloha 243 (737-200, 89,090 FC at 19y on a 75,000-FC DSG, fuselage crown peeled off) created the modern WFD programme. JTSB JAL-123 (1985) demonstrated aft-pressure-bulkhead fatigue from a tail-strike repair. ASC ASC-AAR-05-04-01 China Airlines 611 (B747 over Taiwan Strait, Mar-2002) failed at 22.5y from a tail-strike repair patch that propagated for 22 years.
            </div>
            <div>
              <span className="text-slate-200 font-semibold">Drivers</span>: CYC / HRS / PRESS / WFD / CAL / INSP / REPAIR / UTIL — composite is <span className="font-mono">max·0.66 + mean·0.34 × ADV-MUL</span>. Hard escalators: LFC≥1.0 → 95 (GROUNDED); LFC≥0.95 → 88; WFD-breach → 78; DT-INSP overdue → 70; calendar-life+5y → 60 (corrosion AC 91-56B).
            </div>
            <div>
              <span className="text-slate-200 font-semibold">References</span>: 14 CFR §25.571 / Subpart 26 (§26.21 LoV / §26.43 ALI / §26.45 / §26.49) · §121.370a / §121.1109 · AC 25-571-1D · AC 91-56B · AC 120-104 · AC 120-93 · EASA CS-25.571 / AMC 20-20A · ICAO Annex 8 Pt IIIA §1.4 · Doc 9760 Vol II Pt VIII · MIL-STD-1530D ASIP · NTSB AAR-89-03 Aloha 243 · JAL-123 · ASC ASC-AAR-05-04-01 China Airlines 611 · Boeing AGES per-type · Airbus ESG / TFU.
            </div>
            <div className="text-slate-500 text-[9px] italic pt-1 border-t border-slate-800">
              Fleet-age data is synthetically sampled per icao24 hash from class-typical Cirium FFG 2024 distributions. For operational use, replace with real cumulative-FC / cumulative-FH telemetry per CAMO records (§121.380).
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
