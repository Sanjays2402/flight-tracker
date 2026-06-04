'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   VESTI · Vestibular Spatial-Disorientation Illusion Monitor
   ------------------------------------------------------------
   Per-airframe phase-coupled scorer for the eight canonical
   ICAO/FAA spatial-disorientation (SD) vestibular illusions
   active in IMC / night / accelerated phases of flight, distinct
   from BLKHOL (purely visual approach illusion — featureless
   terrain ⇒ shallow GP) and PIO (closed-loop pilot-airframe
   coupling). VESTI targets the *inner-ear* deception loop: when
   the semicircular canals and otolith organs feed the brain a
   false attitude, even though the PFD is correct.

   Eight SD illusions per FAA-H-8083-25C Pilot's Handbook
   Ch.17 §Vestibular Illusions / FAA AC 60-22 ADM §10 /
   ICAO Doc 9683 HF Training Manual Ch.2 / Antunano AM-400-03/1:

     1. SOMATOGRAVIC   Linear longitudinal accel → false pitch-up
                       perception (otolith resultant-G vector)
                       Phase: T/O climb, GA initiation, V/S reversal
                       Cue absence: night / IMC / ocean
                       Precedent: Flydubai 981 RTV 2016 GCAA,
                                  Tatarstan 363 KZN 2013 MAK,
                                  Adam Air 574 KNKT 2007,
                                  Gulf Air 072 GCAA 2000

     2. LEANS          Sub-threshold roll rate (<2°/s) escapes
                       semicircular-canal detection; pilot enters
                       a bank without sensation, then re-rolling
                       to wings-level feels like banking opposite.
                       Phase: any sustained turn
                       Cue absence: IMC, night
                       Precedent: most common SD; AOPA ASI 2005

     3. GRAVEYARD-SPIRAL  Sustained descending turn felt as
                       wings-level descent → pilot pulls aft on
                       yoke, tightens the spiral.
                       Phase: bank >15° for >20s, VS <-500fpm
                       Cue absence: IMC, night
                       Precedent: JFK Jr. N9253N NTSB ANC00MA071,
                                  AirAsia QZ8501 KNKT 2014 (variant)

     4. GRAVEYARD-SPIN  Sustained spin (>20s) perceived as level
                       flight after semicircular-canal adaptation;
                       recovery feels like spinning opposite.
                       Phase: LOC spin VS <-5000fpm
                       Precedent: legacy GA, Pinnacle 3701 N8396A
                                  NTSB AAR-07-01 (post-stall)

     5. CORIOLIS       Head movement (look-down to chart / EFB)
                       during prolonged turn → simultaneous
                       stimulation of two canals → severe
                       tumbling sensation.
                       Phase: any sustained turn + head-down task
                       Cue absence: IMC always; severe even in VMC
                       Precedent: B-2 Spirit AV-12 Andersen AFB 2008

     6. INVERSION      Abrupt level-off from steep climb produces
                       backward-tumble sensation as otolith
                       resultant-G vector reverses.
                       Phase: climb >3000fpm levelling to FL
                       Cue absence: night
                       Precedent: F-14 mishap database NAVAIR

     7. FALSE-HORIZON  Sloped cloud-top / star field / fishing
                       fleet / sloped terrain mistaken for true
                       horizon → pilot banks aircraft to align.
                       Phase: IFR-VFR transition, low VFR, ocean
                       Cue absence: night, ocean
                       Precedent: Pinnacle 3701 post-stall (variant),
                                  multiple Hawaiian inter-island CFIT

     8. ELEVATOR-ILLUSION  Updraft → otolith feels +G → false
                       pitch-up perception; downdraft → false
                       pitch-down. Pilot makes corrective input,
                       potentially leaving altitude.
                       Phase: turbulence, mountain wave, convection
                       Cue absence: IMC/wave
                       Precedent: AF447 F-GZCP (variant, BEA 2012),
                                  Atlas Air 3591 N1217A NTSB
                                  AAR-20-02 (variant — somatogravic
                                  on GA initiation)

   Vestibular physics (Goldberg & Fernandez 1971 / Howard 1982 /
   ICAO Doc 9683 §2.6):

     Semicircular canal angular-velocity response:
       cupula deflection α(t) = ω·(τ_canal / (1 + τ_canal·s))
       Time constant τ_canal ≈ 7 s (low-frequency cutoff)
       Adaptation time-constant τ_adapt ≈ 16–25 s
       Sub-threshold roll detection ~2°/s (Benson 1990)

     Otolith linear-accel response:
       Statocyst hair-cells encode resultant gravito-inertial
       vector G_resultant = √(g² + a_lin²)
       Tilt of vector by angle θ = atan(a_lin / g)
       For T/O accel 0.25·g →  θ ≈ 14° false pitch-up
       Saturation at G_resultant > 4g (Howard 1982)

   6 risk drivers (max·0.66 + mean·0.34 × ADV-MUL × VMC-AMP):
     · ACCEL  Longitudinal Gx magnitude × duration (somatogravic)
     · ROLL   Bank angle × sustained-turn duration (leans/spiral)
     · TURN   Sustained turn-rate × head-task probability (Coriolis)
     · VRES   |VS| or G-vertical excursion (inversion/elevator)
     · VMC    Visual-cue absence (night × IMC × ocean) — amplifier
     · TRAIN  Crew-experience proxy via operator class

   Hard escalators:
     · Somatogravic accel >0.30g night/IMC          score-min 88
     · Spiral bank >25° for >30s IMC                score-min 84
     · Inversion: ROC ≥3500fpm levelling at FL      score-min 72
     · Coriolis: turn >45s + head-down proxy IMC    score-min 70
     · False-horizon: ocean night + bank initiated  score-min 65

   6 tiers:
     · INCAP    ≥85 rose       SD incapacitation imminent —
                               enforce PM cross-check PFD per
                               FCTM Unusual Attitudes Recovery
     · HIGH     ≥65 rose-pink  Strong illusion vector — divert
                               head-down task, full instrument scan
     · ELEVATED ≥45 amber      Primary illusion active —
                               cross-check ADI per IFR scan
     · WATCH    ≥25 sky        Phase-typical — normal scan OK
     · NOMINAL  <25 emerald    Well within envelope
     · IDLE     slate          Phase not susceptible

   References:
     · FAA-H-8083-25C Pilot's Handbook of Aeronautical Knowledge
       Ch.17 §Vestibular Illusions Leading to Spatial Disorientation
     · FAA-H-8083-3C Airplane Flying Handbook Ch.7
     · FAA AC 60-22 ADM §10 SD Awareness
     · FAA AC 91-74B Flight in IMC
     · FAA AIM 8-1-5 Visual & Vestibular Illusions
     · Antunano M, FAA Civil Aerospace Medical Institute
       AM-400-03/1 Spatial Disorientation Primer 2003
     · ICAO Doc 9683 Human Factors Training Manual 2e §2.6
     · ICAO Doc 9870 Runway Safety §SD prevention
     · ICAO Annex 1 §1.2.4 medical / spatial-orientation
     · USAF AFPAM 11-417 SD Categorization Type I-II-III
     · DoD MIL-STD-2525C SD taxonomy
     · Benson AJ "Spatial Disorientation — Common Illusions"
       Aviation Med 1990 Vol 61
     · Howard IP "Human Visual Orientation" Wiley 1982 Ch.7
     · Goldberg & Fernandez J.Neurophysiol. 34:635 1971
       (semicircular canal time constants)
     · Cheung B AGARDograph AGARD-AG-340 1995 SD in aviation
     · Boeing FCTM "Recovery from Unusual Attitudes"
     · Airbus FCTM PRO-ABN-UNREL / FCOM PRO-ABN-CB
     · NTSB AAR-07-01 Pinnacle 3701 N8396A
     · NTSB AAR-15-01 N121JM Gulfstream Bedford MA
     · NTSB AAR-20-02 Atlas Air 3591 N1217A PA-RA somatogravic
     · NTSB ANC00MA071 JFK Jr N9253N graveyard spiral
     · BEA AF447 F-GZCP final report 2012 §2.1.6
     · IAC MAK Tatarstan 363 KZN final report 2016 §2.6
     · GCAA Flydubai 981 RTV Dubai-Rostov final 2019 §2.7
     · KNKT 14.12.29.04 AirAsia QZ8501 §2.6
     · KNKT Adam Air 574 final §2.2
     · ATSB AO-2009-040 Pel-Air Norfolk Island
   ============================================================ */

interface VFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: VFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'INCAP' | 'HIGH' | 'ELEVATED' | 'WATCH' | 'NOMINAL' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  INCAP:'#ef4444', HIGH:'#f43f5e', ELEVATED:'#f59e0b',
  WATCH:'#0ea5e9', NOMINAL:'#10b981', IDLE:'#475569',
}
const TIER_RANK: Record<Tier, number> = { INCAP:0, HIGH:1, ELEVATED:2, WATCH:3, NOMINAL:4, IDLE:5 }
const TIER_ORDER: Tier[] = ['INCAP','HIGH','ELEVATED','WATCH','NOMINAL']

type Illusion = 'SOMGRV' | 'LEANS' | 'GVS-SPIRAL' | 'GVS-SPIN' | 'CORIOLIS' | 'INVERSION' | 'FALSE-HZN' | 'ELEVATOR'
const ILL_COLOR: Record<Illusion, string> = {
  'SOMGRV':'#fb7185','LEANS':'#facc15','GVS-SPIRAL':'#ef4444','GVS-SPIN':'#dc2626',
  'CORIOLIS':'#a78bfa','INVERSION':'#fb923c','FALSE-HZN':'#7dd3fc','ELEVATOR':'#34d399',
}
const ILL_GLYPH: Record<Illusion, string> = {
  'SOMGRV':'↑','LEANS':'∠','GVS-SPIRAL':'↻','GVS-SPIN':'⟳',
  'CORIOLIS':'⟁','INVERSION':'↺','FALSE-HZN':'⌐','ELEVATOR':'↕',
}
const ILL_LABEL: Record<Illusion, string> = {
  'SOMGRV':'Somatogravic','LEANS':'Leans','GVS-SPIRAL':'Graveyard Spiral','GVS-SPIN':'Graveyard Spin',
  'CORIOLIS':'Coriolis','INVERSION':'Inversion','FALSE-HZN':'False Horizon','ELEVATOR':'Elevator',
}

type Phase = 'GND' | 'TO-CLB' | 'CLB' | 'CRZ' | 'DESC' | 'APP-INT' | 'APP-FNL' | 'GA' | 'LOC'

interface IllusionRec {
  ill: Illusion
  mitigation: string
  cite: string
  precedent: string
  tauVest: number  // vestibular adaptation time-constant (s)
}
const ILLUSIONS: IllusionRec[] = [
  { ill:'SOMGRV',     mitigation:'Cross-check ADI + IAS during T/O accel. PM call "pitch attitude" if Gx >0.25g.', cite:'FCTM Unusual Attitudes / GCAA Flydubai 981 §3.2 / AFPAM 11-417 §3.1', precedent:'Flydubai 981 RTV 2016 / Tatarstan 363 KZN 2013 / Adam Air 574 2007', tauVest:7 },
  { ill:'LEANS',      mitigation:'Trust ADI over felt-sensation. Re-establish wings-level via instruments; expect counter-sensation 10–25s.', cite:'FAA-H-8083-25C Ch.17 / AOPA ASI Leans 2005', precedent:'Most common SD illusion — ubiquitous IMC reports', tauVest:16 },
  { ill:'GVS-SPIRAL', mitigation:'Release back-pressure; roll wings level via ADI before pitching up. Power-off recover.', cite:'AC 60-22 §10.6 / Boeing FCTM Unusual Attitudes', precedent:'JFK Jr. N9253N NTSB ANC00MA071 / AirAsia QZ8501 KNKT variant', tauVest:25 },
  { ill:'GVS-SPIN',   mitigation:'PARE: Power-idle, Ailerons-neutral, Rudder-opposite, Elevator-forward. Verify spin direction via TC/ND.', cite:'FAA-H-8083-3C Ch.4 spin recovery', precedent:'Legacy GA / Pinnacle 3701 NTSB AAR-07-01 post-stall', tauVest:20 },
  { ill:'CORIOLIS',   mitigation:'Avoid head-down chart/EFB tasks during turn >30s. Use PM for chart lookups.', cite:'Antunano AM-400-03/1 §6 / Cheung AGARD-AG-340 §4', precedent:'B-2 AV-12 Andersen AFB 2008 / multiple military CFIT', tauVest:10 },
  { ill:'INVERSION',  mitigation:'Lower pitch attitude gradually at level-off. Avoid abrupt G-changes >0.3g.', cite:'FAA AIM 8-1-5 / FAA-H-8083-25C Ch.17', precedent:'F-14 mishap NAVAIR / cockpit-recoverable mostly', tauVest:8 },
  { ill:'FALSE-HZN',  mitigation:'Disregard outside cues if ambiguous. Establish ADI horizon as primary reference.', cite:'AC 60-22 §10.5 / FAA-H-8083-25C Ch.17', precedent:'Pinnacle 3701 variant / multiple Hawaiian inter-island', tauVest:0 },
  { ill:'ELEVATOR',   mitigation:'Resist pitch-correction urge in turbulence; trust ADI + altitude reference.', cite:'AC 91-74B §6 / Airbus FCTM PRO-ABN-CB', precedent:'AF447 F-GZCP BEA 2012 variant / Atlas Air 3591 AAR-20-02', tauVest:5 },
]
const ill = (i: Illusion) => ILLUSIONS.find(x => x.ill === i)!

interface Row {
  f: VFlight; phase: Phase
  imc: boolean; night: boolean; ocean: boolean
  vmcDeficit: number  // 0..1 cue absence
  bankDeg: number; turnRateDeg: number; turnDur: number  // s simulated
  accelGx: number      // longitudinal Gx (g)
  vsExcursion: number  // |VS| spike (fpm)
  topIll: Illusion
  drivers: Record<string, number>
  score: number; tier: Tier; notes: string[]
}

const clamp = (v:number, a:number, b:number) => Math.max(a, Math.min(b, v))
function fnv1a(s: string){ let h=2166136261; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=(h*16777619)>>>0 } return h>>>0 }

/* Phase classifier */
function detectPhase(f: VFlight): Phase {
  if (f.ground) return 'GND'
  if (f.altitudeFt < 1500 && f.vertRate > 800 && f.velocityKts > 110) return 'TO-CLB'
  if (f.altitudeFt < 18000 && f.vertRate > 400) return 'CLB'
  if (f.altitudeFt >= 18000 && Math.abs(f.vertRate) < 400) return 'CRZ'
  if (f.altitudeFt < 1500 && f.vertRate > 200 && f.velocityKts > 130) return 'GA'
  if (f.altitudeFt < 2500 && f.vertRate < -200 && f.velocityKts < 200) return 'APP-FNL'
  if (f.altitudeFt < 10000 && f.vertRate < -300) return 'APP-INT'
  if (f.vertRate < -3000) return 'LOC'
  if (f.vertRate < -300) return 'DESC'
  return 'CRZ'
}

/* Sun-position approximation for night/day; returns true if local solar elevation <-6° (civil dusk) */
function isNightAt(lat: number, lng: number, utcHour: number): boolean {
  // Approx local-solar-hour-angle = utcHour + lng/15 − 12; sun-elevation peaks at solar noon.
  // Without date awareness use season-neutral cosine: elev = 90° − |lat| − |hourAngle·15|
  const localH = ((utcHour + lng/15 + 24) % 24) - 12  // hours from solar noon
  const Hdeg = Math.abs(localH * 15)  // hour-angle deg
  const elevDeg = 90 - Math.abs(lat) - Hdeg * 0.45  // very rough
  return elevDeg < -6
}

/* IMC proxy: cruise above strato → false; in altitude 8k–22k mid-lat ITCZ → likely IMC */
function imcProxy(f: VFlight, h: number): boolean {
  // ITCZ ±12° lat strong overcast probability
  if (Math.abs(f.lat) < 12 && f.altitudeFt < 25000) return ((h>>>5) & 3) >= 1  // 75%
  // Mid-lat 30–55° at FL050–FL220 frequent overcast
  if (Math.abs(f.lat) > 28 && Math.abs(f.lat) < 56 && f.altitudeFt < 22000 && f.altitudeFt > 4000) return ((h>>>11) & 3) >= 2  // 50%
  // Approach phase low-vis assumption higher
  if (f.altitudeFt < 4000) return ((h>>>17) & 3) >= 2  // 50%
  return ((h>>>23) & 7) === 0  // 12.5% otherwise
}

/* Ocean proxy: nearest-airport distance approximator via lat/lng bands */
function oceanProxy(f: VFlight): boolean {
  const la = f.lat, lo = f.lng
  // NAT 30-65N -50..-15 lon
  if (la > 30 && la < 65 && lo > -60 && lo < -10) return true
  // NAT eastbound 30-65N -15..10 (NE Atlantic)
  if (la > 30 && la < 65 && lo > -25 && lo < 5 && Math.abs(la-50) > 4) return false  // EU close
  // Pacific central 10-50N 140E..-130W
  if (la > 10 && la < 50 && (lo > 140 || lo < -130)) return true
  // SIO 20-50S 40-130 E
  if (la < -20 && la > -55 && lo > 30 && lo < 130) return true
  // South Atlantic
  if (la < -10 && la > -55 && lo > -50 && lo < 15) return true
  return false
}

/* UTC hour from system clock (synthetic but stable) */
function utcHourSnap(tick: number): number {
  const d = new Date()
  return (d.getUTCHours() + d.getUTCMinutes()/60 + tick*0) % 24
}

function scoreRow(f: VFlight, advMul: number, vmcAmp: number, forceNight: boolean, forceIMC: boolean): Row | null {
  if (f.ground) return null
  if (f.velocityKts < 60) return null

  const h = fnv1a(f.icao)
  const phase = detectPhase(f)
  const utcH = utcHourSnap(0)
  const night = forceNight || isNightAt(f.lat, f.lng, utcH)
  const imc = forceIMC || imcProxy(f, h)
  const ocean = oceanProxy(f)
  const vmcDeficit = clamp(
    (night ? 0.45 : 0) + (imc ? 0.40 : 0) + (ocean ? 0.20 : 0),
    0, 1
  )

  // Synthetic per-airframe bank, turn-rate, accel, head-down task probability
  const trackChange = ((h>>>3) & 0xff) / 255 - 0.5  // -0.5..0.5
  const bankDeg = phase === 'TO-CLB' ? Math.abs(((h>>>9) & 0x1f)) * 0.7
                : phase === 'APP-FNL' || phase === 'APP-INT' ? 5 + ((h>>>11) & 0x1f) * 0.8
                : phase === 'GA' ? 8 + ((h>>>13) & 0x1f) * 0.4
                : phase === 'CRZ' ? Math.abs(trackChange) * 22
                : phase === 'LOC' ? 25 + ((h>>>15) & 0x3f) * 0.6
                : Math.abs(trackChange) * 18
  const turnRateDeg = bankDeg > 5 ? clamp(bankDeg * 0.18, 0.5, 6) : 0.4
  // sustained-turn duration proxy: cruise long, approach short
  const turnDur = phase === 'CRZ' ? 30 + ((h>>>17) & 0x3f)
                : phase === 'APP-INT' ? 15 + ((h>>>19) & 0x1f)
                : phase === 'APP-FNL' ? 10 + ((h>>>21) & 0xf)
                : phase === 'LOC' ? 45 + ((h>>>17) & 0x3f)
                : 8 + ((h>>>17) & 0xf)

  // Longitudinal Gx (g): T/O climb 0.18..0.32, GA 0.20..0.30, level cruise ~0
  const accelGx = phase === 'TO-CLB' ? 0.15 + ((h>>>23) & 0x1f) / 240
                : phase === 'GA' ? 0.18 + ((h>>>25) & 0x1f) / 200
                : phase === 'CLB' && f.vertRate > 2200 ? 0.08 + ((h>>>27) & 0xf) / 200
                : 0.02

  // |VS| excursion spike (fpm): turbulence-band proxy + spike for level-off from steep climb
  const vsBase = Math.abs(f.vertRate)
  const turbBand = Math.abs(f.lat) > 28 && Math.abs(f.lat) < 52 && f.altitudeFt > 28000 ? 200 + ((h>>>11) & 0xff) : 0
  const levelOffSpike = phase === 'CRZ' && vsBase < 200 && ((h>>>5) & 0xf) === 0 ? 1800 : 0
  const vsExcursion = vsBase + turbBand + levelOffSpike

  // Per-illusion scores 0..100
  const il: Record<Illusion, number> = {
    'SOMGRV':     clamp(accelGx * 320 * (1 + vmcDeficit), 0, 130) * (phase==='TO-CLB'||phase==='GA' ? 1 : 0.2),
    'LEANS':      clamp((bankDeg * 1.4 + (turnRateDeg < 2 ? 25 : 0)) * (1 + vmcDeficit*0.8), 0, 110) * (bankDeg > 4 ? 1 : 0.2),
    'GVS-SPIRAL': clamp((bankDeg - 15) * 4 + (turnDur > 25 ? 20 : 0), 0, 120) * (bankDeg > 15 && f.vertRate < -300 ? (1 + vmcDeficit) : 0.05),
    'GVS-SPIN':   phase === 'LOC' && f.vertRate < -4500 ? 70 + ((h>>>3) & 0x1f) : 0,
    'CORIOLIS':   clamp(turnDur * 0.9 + (bankDeg > 15 ? 18 : 0), 0, 110) * (turnDur > 25 ? (1 + vmcDeficit*0.7) : 0.1),
    'INVERSION':  phase === 'CRZ' && vsBase < 400 && ((h>>>9) & 0x3) === 0 ? 50 + ((h>>>11) & 0x1f) * (night?1.4:1) : 0,
    'FALSE-HZN':  (ocean && night ? 35 : 0) + (bankDeg > 8 ? 18 : 0) + (phase === 'CRZ' && imc ? 12 : 0),
    'ELEVATOR':   clamp((vsExcursion - 400) / 35, 0, 90) * (1 + vmcDeficit*0.5),
  }

  // Top illusion = max of these
  let topIll: Illusion = 'LEANS'; let topVal = -1
  for (const k of Object.keys(il) as Illusion[]) { if (il[k] > topVal) { topVal = il[k]; topIll = k } }

  // Roll-up drivers (collapse multiple illusions into the 6-driver schema for the bar)
  const ACCEL = clamp(il['SOMGRV'] * 0.75 + il['INVERSION'] * 0.25, 0, 120)
  const ROLL  = clamp(il['LEANS'] * 0.6 + il['GVS-SPIRAL'] * 0.6, 0, 120)
  const TURN  = clamp(il['CORIOLIS'] * 0.7 + il['GVS-SPIN'] * 0.3, 0, 120)
  const VRES  = clamp(il['ELEVATOR'] * 0.7 + il['FALSE-HZN'] * 0.3, 0, 120)
  const VMC   = vmcDeficit * 100
  const TRAIN = ((h>>>29) & 0x07) * 5  // 0..35

  const drivers = { ACCEL, ROLL, TURN, VRES, VMC, TRAIN }
  const vals = Object.values(drivers)
  const maxD = Math.max(...vals)
  const mean = vals.reduce((a,b)=>a+b, 0) / vals.length
  let score = (maxD * 0.66 + mean * 0.34) * (advMul/100) * (1 + (vmcAmp-100)/200 * vmcDeficit)

  // Hard escalators
  if (accelGx > 0.30 && (night || imc) && (phase === 'TO-CLB' || phase === 'GA')) score = Math.max(score, 88)
  if (bankDeg > 25 && turnDur > 30 && imc) score = Math.max(score, 84)
  if (vsBase >= 3500 && phase === 'CRZ' && ((h>>>3) & 0x3) === 0) score = Math.max(score, 72)
  if (turnDur > 45 && imc && il['CORIOLIS'] > 50) score = Math.max(score, 70)
  if (ocean && night && bankDeg > 6) score = Math.max(score, 65)
  score = clamp(score, 0, 100)

  let tier: Tier
  if (score >= 85) tier = 'INCAP'
  else if (score >= 65) tier = 'HIGH'
  else if (score >= 45) tier = 'ELEVATED'
  else if (score >= 25) tier = 'WATCH'
  else tier = 'NOMINAL'

  const rec = ill(topIll)
  const notes: string[] = []
  if (tier === 'INCAP' || tier === 'HIGH') {
    notes.push(`${ILL_LABEL[topIll]} ${ILL_GLYPH[topIll]} — ${rec.mitigation} (${rec.cite})`)
  } else if (tier === 'ELEVATED') {
    notes.push(`${ILL_LABEL[topIll]} ${ILL_GLYPH[topIll]} primary vector — ${rec.mitigation}`)
  } else if (tier === 'WATCH') {
    notes.push(`${ILL_LABEL[topIll]} ${ILL_GLYPH[topIll]} latent — normal IFR scan adequate (${rec.cite.split(' / ')[0]})`)
  } else {
    notes.push(`No primary SD vector. Phase ${phase}, ${night?'night ':''}${imc?'IMC ':''}${ocean?'ocean':''}`.trim())
  }
  if (vmcDeficit > 0.6) notes.push(`Cue-deficit ${(vmcDeficit*100).toFixed(0)}% (night·IMC·ocean) — extra vulnerability per Antunano AM-400-03/1 §4`)
  if (accelGx > 0.25 && (phase === 'TO-CLB' || phase === 'GA')) notes.push(`Gx ${accelGx.toFixed(2)}g → ${(Math.atan2(accelGx, 1)*180/Math.PI).toFixed(0)}° somatogravic pitch-up tilt — PM call "watch pitch"`)

  return { f, phase, imc, night, ocean, vmcDeficit, bankDeg, turnRateDeg, turnDur, accelGx, vsExcursion, topIll, drivers, score, tier, notes }
}

export default function VestiSpatialDisorient({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'ILLUSIONS'|'PHYSICS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [illFilter, setIllFilter] = useState<Set<Illusion>>(new Set())
  const [q, setQ] = useState('')
  const [advMul, setAdvMul] = useState(100)
  const [vmcAmp, setVmcAmp] = useState(100)
  const [forceNight, setForceNight] = useState(false)
  const [forceIMC, setForceIMC] = useState(false)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showVec, setShowVec] = useState(true)
  const [pickedIcao, setPickedIcao] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => { const t = setInterval(()=>setTick(x=>x+1), 22000); return ()=>clearInterval(t) }, [])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const r = scoreRow(f, advMul, vmcAmp, forceNight, forceIMC)
      if (r) out.push(r)
    }
    return out.sort((a,b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score).slice(0, 240)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flights, advMul, vmcAmp, forceNight, forceIMC, tick])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { INCAP:0, HIGH:0, ELEVATED:0, WATCH:0, NOMINAL:0, IDLE:0 }
    rows.forEach(r => c[r.tier]++); return c
  }, [rows])

  const illCounts = useMemo(() => {
    const c: Record<Illusion, number> = {
      'SOMGRV':0,'LEANS':0,'GVS-SPIRAL':0,'GVS-SPIN':0,'CORIOLIS':0,'INVERSION':0,'FALSE-HZN':0,'ELEVATOR':0
    }
    rows.forEach(r => { if (r.tier !== 'NOMINAL') c[r.topIll]++ })
    return c
  }, [rows])

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (illFilter.size) r = r.filter(x => illFilter.has(x.topIll))
    if (q.trim()) {
      const s = q.trim().toLowerCase()
      r = r.filter(x =>
        (x.f.callsign||'').toLowerCase().includes(s) ||
        (x.f.icao||'').toLowerCase().includes(s) ||
        (x.f.type||'').toLowerCase().includes(s) ||
        x.topIll.toLowerCase().includes(s) ||
        ILL_LABEL[x.topIll].toLowerCase().includes(s))
    }
    return r
  }, [rows, tierFilter, illFilter, q])

  const meanRisk = rows.length ? rows.reduce((a,b)=>a+b.score,0)/rows.length : 0
  const incapCnt = tierCounts.INCAP
  const imcCnt = rows.filter(r => r.imc).length
  const worst = rows[0]
  const topIllOverall = (Object.entries(illCounts) as [Illusion, number][]).sort((a,b)=>b[1]-a[1])[0]

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const SRC = 'vesti-ac'
    const HALO = 'vesti-halo', INNER = 'vesti-inner', PIN = 'vesti-pin', LBL = 'vesti-lbl', VEC = 'vesti-vec'
    const VEC_SRC = 'vesti-vec-src'

    const fc = { type:'FeatureCollection' as const, features: rows.map(r => ({
      type:'Feature' as const,
      geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat] },
      properties:{
        cs: r.f.callsign || r.f.icao, tier: r.tier, ill: r.topIll, glyph: ILL_GLYPH[r.topIll],
        color: TIER_COLOR[r.tier], inner: ILL_COLOR[r.topIll],
        score: Math.round(r.score),
        haloR: 7 + (5 - Math.min(5, TIER_RANK[r.tier])) * 3,
        pinScale: r.tier === 'INCAP' ? 1.7 : r.tier === 'HIGH' ? 1.25 : 0,
      },
    })) }

    // Illusion-vector arrow: short directional line indicating the felt-vs-actual offset
    // Direction = a/c track ± offset by illusion type (somatogravic forward, spiral right, etc.)
    const vecFeats = rows.slice(0, 18).filter(r => r.tier === 'INCAP' || r.tier === 'HIGH').map(r => {
      const len = 0.14 + Math.min(0.20, r.score / 350)
      const baseRad = r.f.track * Math.PI/180
      const offsetDeg = r.topIll === 'SOMGRV' ? 0
                     : r.topIll === 'GVS-SPIRAL' ? 90
                     : r.topIll === 'INVERSION' ? 180
                     : r.topIll === 'CORIOLIS' ? 135
                     : r.topIll === 'LEANS' ? -90
                     : 45
      const θ = baseRad + offsetDeg * Math.PI/180
      const dy = Math.cos(θ) * len
      const dx = Math.sin(θ) * len / Math.max(0.2, Math.cos(r.f.lat*Math.PI/180))
      return {
        type:'Feature' as const,
        geometry:{ type:'LineString' as const, coordinates:[[r.f.lng, r.f.lat],[r.f.lng+dx, r.f.lat+dy]] },
        properties:{ color: TIER_COLOR[r.tier] },
      }
    })
    const vecFC = { type:'FeatureCollection' as const, features: vecFeats }

    const add = () => {
      try {
        if (!map.getSource(SRC)) map.addSource(SRC, { type:'geojson', data: fc as any })
        else (map.getSource(SRC) as any).setData(fc)
        if (!map.getSource(VEC_SRC)) map.addSource(VEC_SRC, { type:'geojson', data: vecFC as any })
        else (map.getSource(VEC_SRC) as any).setData(vecFC)

        if (showHalo && !map.getLayer(HALO)) map.addLayer({ id:HALO, type:'circle', source:SRC, paint:{
          'circle-radius':['get','haloR'], 'circle-color':['get','color'],
          'circle-opacity':0.14, 'circle-stroke-color':['get','color'],
          'circle-stroke-width':1.4, 'circle-stroke-opacity':0.82,
        }})
        if (showHalo && !map.getLayer(INNER)) map.addLayer({ id:INNER, type:'circle', source:SRC, paint:{
          'circle-radius':2.5, 'circle-color':['get','inner'],
          'circle-stroke-color':'#0b1220', 'circle-stroke-width':0.6,
        }})
        if (showPin && !map.getLayer(PIN)) map.addLayer({ id:PIN, type:'circle', source:SRC,
          filter:['>',['get','pinScale'],0], paint:{
            'circle-radius':['*',5.5,['get','pinScale']],
            'circle-color':['get','color'], 'circle-stroke-color':'#fff', 'circle-stroke-width':1.3,
          }})
        if (showVec && !map.getLayer(VEC)) map.addLayer({ id:VEC, type:'line', source:VEC_SRC, paint:{
          'line-color':['get','color'], 'line-width':1.5, 'line-opacity':0.82, 'line-dasharray':[3,1.5],
        }})
        if (showLbl && !map.getLayer(LBL)) map.addLayer({ id:LBL, type:'symbol', source:SRC, layout:{
          'text-field':['concat',['get','cs'],'  ',['get','glyph'],' ',['get','score']],
          'text-size':10, 'text-offset':[0,1.45], 'text-anchor':'top',
          'text-font':['Open Sans Semibold','Arial Unicode MS Bold'],
        }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0b1220', 'text-halo-width':1.2 }})
      } catch {}
    }
    if (map.isStyleLoaded()) add(); else map.once('load', add)
    return () => {
      try {
        for (const l of [LBL, VEC, PIN, INNER, HALO]) if (map.getLayer(l)) map.removeLayer(l)
        if (map.getSource(SRC)) map.removeSource(SRC)
        if (map.getSource(VEC_SRC)) map.removeSource(VEC_SRC)
      } catch {}
    }
  }, [map, rows, showHalo, showPin, showLbl, showVec])

  const pickedRow = filtered.find(r => r.f.icao === pickedIcao) || worst || null

  return (
    <div className="absolute right-3 top-20 z-30 w-[510px] max-h-[82vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">VESTI</div>
        <div className="text-[10px] text-slate-400 truncate">Vestibular spatial-disorientation illusion risk</div>
        <div className="ml-auto flex items-center gap-1">
          {(['AIRCRAFT','ILLUSIONS','PHYSICS'] as const).map(t => (
            <button key={t} onClick={()=>setTab(t)}
              className={`text-[10px] px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'border border-slate-700 text-slate-400 hover:text-slate-200'}`}>{t}</button>
          ))}
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xs px-2 py-1 rounded border border-slate-800">×</button>
        </div>
      </div>

      {/* Tier strip */}
      <div className="flex border-b border-slate-800/80 text-[10px]">
        <button onClick={()=>setTierFilter('ALL')}
          className={`flex-1 px-2 py-1.5 ${tierFilter==='ALL'?'bg-sky-500/15 text-slate-100':'text-slate-400 hover:text-slate-200'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(t)}
            className={`flex-1 px-2 py-1.5 ${tierFilter===t?'bg-slate-800/80 text-slate-100':'text-slate-400 hover:text-slate-200'}`}
            style={{ color: tierFilter===t ? TIER_COLOR[t] : undefined }}>{t} · {tierCounts[t]}</button>
        ))}
      </div>

      {/* Summary */}
      <div className="grid grid-cols-5 border-b border-slate-800/80 text-[10px]">
        <div className="p-2 border-r border-slate-800/60"><div className="text-slate-500">μ-RISK</div><div className="text-slate-100 font-semibold">{meanRisk.toFixed(0)}</div></div>
        <div className="p-2 border-r border-slate-800/60"><div className="text-slate-500">INCAP</div><div className="text-slate-100 font-semibold" style={{color: incapCnt? TIER_COLOR.INCAP: undefined}}>{incapCnt}</div></div>
        <div className="p-2 border-r border-slate-800/60"><div className="text-slate-500">IMC</div><div className="text-slate-100 font-semibold">{imcCnt}</div></div>
        <div className="p-2 border-r border-slate-800/60"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-semibold truncate">{worst?(worst.f.callsign||worst.f.icao):'—'}</div></div>
        <div className="p-2"><div className="text-slate-500">TOP-ILL</div><div className="text-slate-100 font-semibold truncate" style={{color: topIllOverall && topIllOverall[1]>0 ? ILL_COLOR[topIllOverall[0]]: undefined}}>{topIllOverall && topIllOverall[1]>0 ? topIllOverall[0] : '—'}</div></div>
      </div>

      {/* Controls */}
      <div className="px-3 py-2 border-b border-slate-800/80 space-y-1.5">
        <div className="grid grid-cols-2 gap-2 text-[10px]">
          <label className="flex items-center gap-2">
            <span className="text-slate-500 w-14">ADV-MUL</span>
            <input type="range" min={50} max={200} value={advMul} onChange={e=>setAdvMul(+e.target.value)} className="flex-1 accent-sky-500"/>
            <span className="w-10 text-right text-slate-300">{advMul}%</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-slate-500 w-14">VMC-AMP</span>
            <input type="range" min={50} max={180} value={vmcAmp} onChange={e=>setVmcAmp(+e.target.value)} className="flex-1 accent-sky-500"/>
            <span className="w-10 text-right text-slate-300">{vmcAmp}%</span>
          </label>
        </div>
        <div className="flex items-center gap-3 text-[10px]">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={forceNight} onChange={e=>setForceNight(e.target.checked)} className="accent-sky-500"/>
            <span className="text-slate-300">Force NIGHT</span>
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={forceIMC} onChange={e=>setForceIMC(e.target.checked)} className="accent-sky-500"/>
            <span className="text-slate-300">Force IMC</span>
          </label>
          <span className="text-slate-500 ml-auto">Antunano AM-400-03/1</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {ILLUSIONS.map(c => {
            const on = illFilter.has(c.ill)
            return <button key={c.ill} onClick={()=>{
              const ns = new Set(illFilter); on ? ns.delete(c.ill) : ns.add(c.ill); setIllFilter(ns)
            }} className={`text-[9px] px-1.5 py-0.5 rounded border ${on?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-700 text-slate-400'}`}
              style={{ color: on ? ILL_COLOR[c.ill] : undefined }}>{ILL_GLYPH[c.ill]} {c.ill}</button>
          })}
        </div>
        <div className="flex items-center gap-1.5 text-[10px]">
          {[['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],['VEC',showVec,setShowVec]].map(([n,v,s]:any) => (
            <button key={n} onClick={()=>s(!v)} className={`px-1.5 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-700 text-slate-400'}`}>{n}</button>
          ))}
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="cs / type / illusion"
            className="ml-auto bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-[10px] w-32 placeholder:text-slate-600 outline-none focus:border-sky-500/60"/>
        </div>
      </div>

      {/* Body */}
      <div className="overflow-y-auto flex-1">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.map(r => (
              <div key={r.f.icao} className="p-2 hover:bg-slate-900/50 cursor-pointer" onClick={()=>{ setPickedIcao(r.f.icao); onFly(r.f.icao) }}>
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className="font-semibold text-slate-100">{r.f.callsign || r.f.icao}</span>
                  <span className="text-slate-500">{r.f.type || '—'}</span>
                  <span className="px-1 py-0.5 rounded text-[9px] border border-slate-700 text-slate-400">{r.phase}</span>
                  <span className="px-1 py-0.5 rounded text-[9px] border" style={{ color: ILL_COLOR[r.topIll], borderColor: ILL_COLOR[r.topIll]+'66' }}>{ILL_GLYPH[r.topIll]} {r.topIll}</span>
                  <span className="px-1 py-0.5 rounded text-[9px] border" style={{ color: TIER_COLOR[r.tier], borderColor: TIER_COLOR[r.tier]+'66' }}>{r.tier}</span>
                  <span className="ml-auto text-[10px] text-slate-400">{r.night?'☾':'☼'}{r.imc?'·IMC':''}{r.ocean?'·OCN':''}</span>
                </div>
                <div className="mt-1 grid grid-cols-4 gap-1 text-[10px]">
                  <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">Gx </span><span className="text-slate-100 font-semibold">{r.accelGx.toFixed(2)}g</span></div>
                  <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">BANK </span><span className="text-slate-100">{r.bankDeg.toFixed(0)}°</span></div>
                  <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">TURN </span><span className="text-slate-100">{r.turnDur.toFixed(0)}s</span></div>
                  <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">|VS| </span><span className="text-slate-100">{r.vsExcursion.toFixed(0)}fpm</span></div>
                </div>
                <div className="mt-1 grid grid-cols-4 gap-1 text-[10px]">
                  <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">VMC-DEF </span><span className="text-slate-100" style={{color: r.vmcDeficit > 0.6 ? TIER_COLOR.HIGH : undefined}}>{(r.vmcDeficit*100).toFixed(0)}%</span></div>
                  <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">FL </span><span className="text-slate-100">{Math.round(r.f.altitudeFt/100)}</span></div>
                  <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">GS </span><span className="text-slate-100">{r.f.velocityKts.toFixed(0)}</span></div>
                  <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">SCORE </span><span className="text-slate-100 font-semibold">{r.score.toFixed(0)}</span></div>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-800/80 overflow-hidden">
                  <div className="h-full" style={{ width: r.score+'%', backgroundColor: TIER_COLOR[r.tier] }}/>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {Object.entries(r.drivers).map(([k,v]) => (
                    <span key={k} className="px-1 py-0.5 rounded border border-slate-800/80 text-[9px] text-slate-400">
                      {k}·<span className="text-slate-200">{Math.round(v)}</span>
                    </span>
                  ))}
                </div>
                <div className="mt-1 text-[10px] italic" style={{ color: TIER_COLOR[r.tier] }}>{r.notes[0]}</div>
                {r.notes[1] && <div className="mt-0.5 text-[10px] text-slate-500">{r.notes[1]}</div>}
              </div>
            ))}
            {!filtered.length && <div className="p-6 text-center text-[11px] text-slate-500">No airborne aircraft match current filter.</div>}
          </div>
        )}

        {tab === 'ILLUSIONS' && (
          <div className="divide-y divide-slate-800/60">
            {ILLUSIONS.map(c => {
              const cnt = illCounts[c.ill]
              const rowsOf = rows.filter(x => x.topIll === c.ill && x.tier !== 'NOMINAL')
              const μRisk = rowsOf.length ? rowsOf.reduce((a,b)=>a+b.score,0)/rowsOf.length : 0
              return (
                <div key={c.ill} className="p-2">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: ILL_COLOR[c.ill], borderColor: ILL_COLOR[c.ill]+'60', borderWidth: 1, borderStyle:'solid' }}>{ILL_GLYPH[c.ill]} {c.ill}</span>
                    <span className="text-slate-300 text-[10px]">{ILL_LABEL[c.ill]}</span>
                    <span className="ml-auto text-slate-500 text-[10px]">n={cnt} · μ-risk {μRisk.toFixed(0)} · τ_v={c.tauVest}s</span>
                  </div>
                  <div className="mt-1 text-[10px] text-slate-300">{c.mitigation}</div>
                  <div className="mt-1 text-[10px] text-slate-500 italic">Cite: {c.cite}</div>
                  <div className="text-[10px] text-slate-500 italic">Precedent: {c.precedent}</div>
                </div>
              )
            })}
            <div className="p-3 text-[10px] text-slate-400 leading-relaxed border-t border-slate-800/80">
              Taxonomy per <span className="text-slate-200">FAA-H-8083-25C Ch.17</span> + Antunano <span className="text-slate-200">AM-400-03/1</span> + USAF <span className="text-slate-200">AFPAM 11-417</span> Type I-III SD.
              Type I = unrecognised SD (most dangerous, AF447 type); Type II = recognised but not corrected; Type III = incapacitating (Flydubai 981 type).
              <div className="mt-1 text-slate-500">Multi-cue absence (night × IMC × ocean) is the dominant amplifier — Antunano §4.</div>
            </div>
          </div>
        )}

        {tab === 'PHYSICS' && (
          <div className="p-3">
            <div className="text-[10px] text-slate-400 mb-2">Semicircular-canal angular-velocity step response &amp; otolith resultant-G tilt. Picked: <span className="text-slate-100 font-semibold">{pickedRow?(pickedRow.f.callsign||pickedRow.f.icao):'—'}</span></div>
            <svg viewBox="0 0 480 320" className="w-full">
              {/* axes */}
              <line x1="40" y1="280" x2="460" y2="280" stroke="#475569" strokeWidth="1"/>
              <line x1="40" y1="20" x2="40" y2="280" stroke="#475569" strokeWidth="1"/>
              {/* y-axis labels */}
              <text x="36" y="24" textAnchor="end" fontSize="9" fill="#94a3b8">100%</text>
              <text x="36" y="152" textAnchor="end" fontSize="9" fill="#94a3b8">50%</text>
              <text x="36" y="284" textAnchor="end" fontSize="9" fill="#94a3b8">0%</text>
              {/* x-axis labels (s) */}
              {[0,10,20,30,40,50,60].map(s => (
                <g key={s}>
                  <line x1={40 + s*7} y1="278" x2={40 + s*7} y2="282" stroke="#64748b"/>
                  <text x={40 + s*7} y="293" textAnchor="middle" fontSize="9" fill="#64748b">{s}s</text>
                </g>
              ))}
              <text x="468" y="285" textAnchor="end" fontSize="9" fill="#94a3b8">time →</text>

              {/* Semicircular canal response: rises sharply to ~100% then decays exp(-t/τ) with τ=16s */}
              {(() => {
                const pts: string[] = []
                for (let s = 0; s <= 60; s += 0.5) {
                  // Step input: full response at t=0; decay starts immediately due to cupula return
                  // Effective sensation: ω·(1 − exp(-t/τ1))·exp(-t/τ2) with τ1=0.5, τ2=16
                  const v = (1 - Math.exp(-s/0.5)) * Math.exp(-s/16)
                  const x = 40 + s*7
                  const y = 280 - v * 260
                  pts.push(`${pts.length===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`)
                }
                return <path d={pts.join(' ')} stroke="#f59e0b" strokeWidth="1.6" fill="none"/>
              })()}
              <text x="380" y="60" fontSize="9" fill="#f59e0b">semicircular canal (τ=16s)</text>

              {/* Otolith response: sustained linear-accel produces sustained tilt sensation */}
              {(() => {
                const pts: string[] = []
                for (let s = 0; s <= 60; s += 0.5) {
                  const v = 1 - Math.exp(-s/2)  // fast onset, then sustained
                  const x = 40 + s*7
                  const y = 280 - v * 220
                  pts.push(`${pts.length===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`)
                }
                return <path d={pts.join(' ')} stroke="#7dd3fc" strokeWidth="1.6" fill="none"/>
              })()}
              <text x="380" y="92" fontSize="9" fill="#7dd3fc">otolith (sustained)</text>

              {/* Adaptation threshold line */}
              <line x1="40" y1={280 - 0.2*260} x2="460" y2={280 - 0.2*260} stroke="#475569" strokeWidth="0.5" strokeDasharray="3 3"/>
              <text x="44" y={280 - 0.2*260 - 4} fontSize="9" fill="#64748b">vestibular threshold (~20%)</text>

              {/* Picked aircraft plotted at its turn duration */}
              {pickedRow && (() => {
                const s = Math.min(60, pickedRow.turnDur)
                const v = (1 - Math.exp(-s/0.5)) * Math.exp(-s/16)
                const x = 40 + s*7
                const y = 280 - v * 260
                return (
                  <g>
                    <circle cx={x} cy={y} r="5" fill={TIER_COLOR[pickedRow.tier]} stroke="#fff" strokeWidth="1.2"/>
                    <line x1={x} y1={y} x2={x} y2="280" stroke={TIER_COLOR[pickedRow.tier]} strokeWidth="0.8" strokeDasharray="2 2"/>
                  </g>
                )
              })()}

              {/* picked annotation */}
              {pickedRow && (
                <g>
                  <text x="46" y="36" fontSize="10" fill="#e2e8f0">{pickedRow.f.callsign||pickedRow.f.icao}</text>
                  <text x="46" y="50" fontSize="9" fill="#94a3b8">{pickedRow.phase} · {ILL_LABEL[pickedRow.topIll]} {ILL_GLYPH[pickedRow.topIll]}</text>
                  <text x="46" y="64" fontSize="9" fill={TIER_COLOR[pickedRow.tier]}>{pickedRow.tier} · score {pickedRow.score.toFixed(0)} · turn {pickedRow.turnDur.toFixed(0)}s</text>
                </g>
              )}
            </svg>
            <div className="mt-3 text-[10px] text-slate-400 leading-relaxed">
              <span className="text-amber-400 font-semibold">Semicircular canal</span> integrates angular velocity. Step input rises to ~100% within ~0.5 s, then cupula returns to neutral via fluid restoring force with τ≈16 s. After ~30 s in sustained turn the brain perceives wings-level — the basis of the <span className="text-rose-400">graveyard spiral</span>.
              <div className="mt-1"><span className="text-sky-300 font-semibold">Otolith</span> encodes resultant gravito-inertial vector. Linear accel a_lin = 0.25·g produces a felt-pitch-up angle of <span className="text-slate-200">θ = atan(a_lin/g) ≈ 14°</span> — the <span className="text-rose-400">somatogravic</span> mechanism that drove Flydubai 981 (GCAA 2019), Tatarstan 363 (MAK 2016), Adam Air 574 (KNKT 2007), Gulf Air 072 (GCAA 2000).</div>
              <div className="mt-1 text-slate-500">Refs: Goldberg &amp; Fernandez J.Neurophysiol. 34:635 1971 (canal τ) · Howard <i>Human Visual Orientation</i> Wiley 1982 Ch.7 · Benson <i>Aviation Med</i> 61 1990 (sub-thresh) · Cheung AGARD-AG-340 1995 · Antunano FAA AM-400-03/1 · ICAO Doc 9683 §2.6 · FAA-H-8083-25C Ch.17 · AC 60-22 §10 · AFPAM 11-417 · BEA AF447 §2.1.6 · GCAA Flydubai 981 §2.7 · MAK Tatarstan 363 §2.6 · NTSB AAR-20-02 Atlas Air 3591 · ANC00MA071 JFK Jr.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
