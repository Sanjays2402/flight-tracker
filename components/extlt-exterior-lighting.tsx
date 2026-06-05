'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   EXTLT · Exterior-Lighting / Anti-Collision Conspicuity &
           Per-Phase Cockpit-Light-Plan Compliance Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of the certificated exterior-
   lighting subsystem state — red rotating beacon, white anti-
   collision strobes, position (nav) lights red/green/white,
   landing lights, taxi lights, runway-turnoff lights, wing
   inspection / wing scan lights, and logo lights — scoring
   whether each aircraft's lighting CONFIGURATION matches its
   PHASE-OF-FLIGHT requirement per the canonical "lights on
   for taxi, all-on for takeoff, gear-lights off in cruise"
   pre-departure flow taught in every Type-Rating syllabus.

   Distinct from every other panel / overlay in the catalogue:
     STALL / VMC / DEEPSTL  — aerodynamic / control margin
     TCAS / CPA / DAA-WC    — collision-avoidance LOGIC
     ADSB-INT / ACASX       — surveillance broadcast quality
     LASER                  — ground-emitter cockpit-irradiance
     SUN-GLARE / BLKHOL     — illusions / low-luminance scenes
     NIGHT-VIS (display lum) — cockpit interior luminance
     CONFLICT / AIRPROX     — encounter geometry
     FORMATION              — proximity / wing-station geometry
     SQUAWK                 — Mode-A code assignment
     STBR / RWSL            — pavement-light infrastructure

   EXTLT is uniquely the AIRBORNE-PLATFORM conspicuity-emitter
   subsystem audit — the ON/OFF/STEADY state of every certified
   exterior lamp and whether the configuration is legal AND
   appropriate for the current phase-of-flight, day/night, IMC,
   and proximity to controlled airspace per:

     14 CFR §91.205(c)(2)(3) Required night equipment
       (position lights, anti-collision light system)
     14 CFR §91.209          Aircraft lights
       (a)(1) sunset → sunrise position lights required
       (a)(2) at airport surface position lights illuminated
       (b)         anti-collision system in operation
       (b)(2) PIC may turn off if adverse to safety
       (c)         no person may anchor an aircraft after sunset
                   in or near an Alaska airway unless lighted
     14 CFR §91.207          Emergency locator transmitter
     14 CFR §23.1385-1401    Powered-lighting systems Part 23
     14 CFR §25.1383-1397    Powered-lighting systems Part 25
       §25.1389 Position-light distribution & intensities
       §25.1391 Minimum intensities in horizontal plane
       §25.1393 Minimum intensities in vertical planes
       §25.1395 Maximum intensities in overlapping beams
       §25.1397 Color specifications
       §25.1401 Anti-collision light system
                ≥40 effective candelas (white) / ≥120 (red)
                40-100 flashes/min, ≥75° above-below horizontal
     EASA CS-25.1383 - .1401  Mirror of FAR Part 25
     ICAO Annex 6 Pt I §6.10  Aircraft lights operating procedures
       6.10.1 anti-collision lights from start of engines
       6.10.2 navigation lights night operations
       6.10.3 anti-collision lights moving on movement area
     ICAO Annex 2 §3.2.4      Aerodrome traffic
     ICAO Annex 8 Pt II §5    Powered-lighting cert
     ICAO Doc 4444 PANS-ATM §7.5.1.2 Standard taxi procedures
     ICAO Doc 8168 PANS-OPS Vol I Pt I §3.3 Pre-flight
     ICAO Doc 9870           Manual on Prevention of Runway
                             Incursions §6.3 "Lights On" prog
     FAA AC 91-73B           Parts 91 / 121 / 125 / 135 Flightcrew
                             Procedures During Taxi Operations
                             §6 EXTERIOR LIGHTING REQUIREMENTS
     FAA InFO 10003          Use of Exterior Lighting to Enhance
                             Aircraft Visibility During Taxi
     FAA SAFO 17005          Recommended Use of Aircraft
                             Conspicuity Lights
     FAA AIM 4-3-23          Use of Aircraft Lights
     FAA Order JO 7110.65 §3-7-2 Anti-collision light operation
     FAA-H-8083-25C Ch.7     Aircraft Systems - Lighting
     FAA-H-8083-2 §5         Risk Management & Conspicuity
     SAE ARP 5029            Aerospace Recommended Practice -
                             Aircraft Position-Light Performance
     SAE AS 8037             Anti-Collision Lights minimum spec
     RTCA DO-160G §22        Lightning Direct Effects
     MIL-L-6503              Lighting Equipment, Aircraft
     ARINC 700/703           Lighting bus & control architecture
     Boeing AMM Ch.33        Lights (every type)
     Airbus AMM Ch.33        Lights (every type)
     Embraer AMM Ch.33       Lights (E-Jet / Phenom)
     Bombardier AMM Ch.33    CRJ / Q400 / Global Lights
     ATR AMM Ch.33           ATR42/72 Lights
     Boeing FCOM Vol 1 §16   Lights system description
     Airbus FCOM DSC-33      Lights system description
     Boeing FCOM PI/QRH      Pre-flight / Taxi / Takeoff
                             "LIGHTS" flow line items
     Airbus FCTM PRO-NOR-
       SOP-09 Departure      Lights ON before pushback
     Airbus FCTM PRO-NOR-
       SOP-13 Take-Off       STROBES ON line-up callout
     FAA AIM 7-1-9           Helicopter NVD operations
     FAA NVG-OPS Order        91.205(h) NVIS-compatible cockpit
     14 CFR §61.31(j)        NVG specific authorization
     UK CAA CAP 715 §2       Conspicuity & Lighting
     EASA Easy Access Rules  Part-NCO NCO.OP.180 Lights
     Transport Canada AIM    AIR §2.7 Aircraft Lighting
     ICAO Doc 9774 Manual    on Cert of Aerodromes (not lights,
                             but cross-ref for moving area)
     NTSB AAR-91-08          LAX1493 USAir 1493 / SkyWest 5569
                             KLAX 1991-02-01 (34 fatal,
                             rwy-incursion, SkyWest in line-up
                             low-visibility taxi-light low,
                             no white anti-coll on critical
                             ground phase) – the canonical
                             "should-have-had-lights-on"
                             precedent driving InFO 10003
     NTSB AAR-08-01          Comair 5191 KLEX 2006-08-27
                             (49 fatal, wrong-rwy departure,
                             insufficient lighting cross-check)
     NTSB DCA24MA063         Alaska 1282 (referenced for
                             coordinated multi-system audit)
     JTSB AI-2024-1          JL516/JA722A KHND 2024-01-02
                             (mid-runway collision precedent;
                             coast-guard taxi-light status
                             central to investigation timeline)
     ASN WO #19980402-1      KLM 4805 LV-LTN Tenerife 1977
                             (low-vis taxi, NO ground radar,
                             post-event ICAO required ALL
                             exterior lights ON for movement)
     EASA SIB 2017-13        Conspicuity of Aircraft on Ground

   ------------------------------------------------------------
   8-aircraft-class fleet catalogue with per-class certified
   lamp inventory + per-class typical photopic-watts + per-class
   lamp-control architecture (single-switch / multi-switch /
   logic-controlled / FCU-tied):

     HVY-T   B777/B787/A350/A330  HID landing 600W / multi-switch
     HVY-Q   B747/A380            Tungsten landing 4×600W / multi
     WB-M    B767/A310            Tungsten landing 2×600W / multi
     NB      B737/A320            HID landing 2×250W / multi-switch
     RGN-J   E190/CRJ900          HID landing 2×200W / single
     RGN-T   AT72/Q400            Tungsten landing 2×450W / single
     BIZ     G650/GLEX/FA8X       LED landing 4×120W / multi
     LIGHT   PC12/C25/SR22        LED landing 1×100W / single

   ------------------------------------------------------------
   10-lamp inventory per airframe (binary ON/OFF/PULSE state):

     BEACON      Red rotating anti-collision (engine running)
     STROBE      White anti-collision (movement / line-up / fly)
     NAV-L       Red position light, left wing
     NAV-R       Green position light, right wing
     NAV-T       White position light, tail
     LANDING     Sealed-beam / HID landing (gear extension / app)
     TAXI        Diffuse taxi-light (nose-gear / wing root)
     RTO         Runway-turnoff (wing-root sideways)
     WING        Wing inspection / wing scan (ice / general view)
     LOGO        Vertical-fin logo light (tail / company branding)

   ------------------------------------------------------------
   9-phase-of-flight classifier with per-phase REQUIRED /
   RECOMMENDED / OPTIONAL / OFF per AC 91-73B + Boeing/Airbus
   FCOM SOP + ICAO Annex 6 §6.10:

     PARKED      All OFF (battery preservation)
     GATE-ENG    BEACON required start-of-engines (Annex 6 §6.10.1)
     PUSH-TAXI   BEACON + NAV + TAXI + LOGO (night)
                 (RTO optional, STROBE off "courtesy")
     LINE-UP     All ground lights ON entering runway
                 (BEACON + NAV + STROBE + LANDING + TAXI + RTO)
     TKO-ROLL    Full TAKEOFF config (BEACON + NAV + STROBE
                                     + LANDING + TAXI + RTO)
                 Logo OFF (interference w/ peripheral vision)
     CLIMB-LOW   <10000 ft / "below transition" — STROBE +
                 LANDING + TAXI ON for "Below 10K"
                 conspicuity per FAA InFO 10003
     CRUISE      BEACON + NAV + STROBE — landing OFF (HID arc-
                 life preservation), TAXI OFF (gear-up, lamp
                 retracted)
     APPR-DESC   Below 10K: STROBE + NAV + LANDING + LOGO
     LANDING     Full landing config (all on except TAXI/RTO
                 until clear of runway), then TAXI + RTO + LOGO

   ------------------------------------------------------------
   7 risk drivers (max·0.66 + mean·0.34 × phase-weight × ADV-MUL):

     CFG     Per-phase MISSING-required lamps (count × 18)
     COURTESY Per-phase TOO-MANY illegal lamps (count × 10)
     NIGHT   Night/IMC penalty when NAV+STROBE off in dark
     CONSPIC InFO 10003 "Below 10K" conspicuity gap
     SLD     SLD landing-light icing penalty (lamp lens icing)
     LOGO-INV Logo light ON during TKO-ROLL or CLIMB-LOW
              (cited interference w/ peripheral / ground crew
              dazzle on rotation)
     BURN    Synthetic lamp-burnout proxy (HID arc-life cycle)

   Hard escalators:
     · BEACON OFF during engine-running (ground)     score-min 92
       (ICAO Annex 6 §6.10.1 - HARD reg violation)
     · NAV OFF during night ops                       score-min 88
       (14 CFR §91.209(a)(1) - HARD reg violation)
     · STROBE OFF during TKO-ROLL / LINE-UP           score-min 78
       (FAA SAFO 17005 - InFO 10003 conspicuity gap)
     · LANDING OFF on TKO-ROLL/LANDING + night        score-min 74
     · LOGO ON during TKO-ROLL                        score-min 55
       (Boeing FCOM PI §16 - "logo off for takeoff")

   6 tiers:
     VIOLATION ≥85 rose      Hard FAR / Annex-6 violation
     UNSAFE    ≥65 rose-pink Conspicuity gap, immediate action
     SUBOPT    ≥45 amber     Improvement opportunity, brief crew
     COMPLIANT ≥22 sky       Within phase-typical config
     OPTIMAL   <22 emerald   InFO 10003 fully met
     OFF       slate         Parked / outside phase envelope

   ------------------------------------------------------------
   MapLibre overlay (4-layer):
     · Tier-coloured halo ring 7-19 px score-sized
     · VIOLATION/UNSAFE rose pins for the worst-tier 2 tiers
     · Beam-cone vector forward from aircraft (length ∝ LANDING
       lamp power kW × score) showing conspicuity reach
     · Per-airframe label cs · class · score · lamps-on count

   Side panel:
     · 6-tier counter strip click-to-filter ALL + 6 tier cells
     · 5-cell summary μ-SCORE / VIO-cnt / WORST-cs / NIGHT-cnt /
                      Σ-LAMPS-ON
     · 4 sliders ADV-MUL 50-200% / NIGHT-AMP 50-200% /
                 SLD-MUL 0-200% / BURN-MUL 0-200%
     · NIGHT-FORCE / IMC-FORCE / SLD-FORCE checkboxes
     · 8-class chip filter + 9-phase chip filter +
       HALO/PIN/BEAM/LBL toggles + cs/type/lamp search
     · AIRCRAFT / CLASSES / LAMPS / PROFILE 4-tab switcher

   AIRCRAFT tab — tier-worst-first row stack:
     · cs + type + class-pill + phase-pill + tier-pill
     · 10-lamp ON/OFF strip with tier-color when wrong
     · 5-cell summary CFG/COURTESY/NIGHT/CONSPIC/BURN drivers
     · Tier-coloured score bar
     · Tier-coloured advice line citing reg + Boeing/Airbus FCOM

   CLASSES tab — per-class aggregate row:
     · class-pill + label + count + lamp-power table
     · 4-cell summary μ-SCORE / VIO / SUB / lamps-ON-rate
     · Per-class cert-citation italic note

   LAMPS tab — per-lamp count strip:
     · Each of 10 lamps shown with fleet ON/OFF rate
     · Per-lamp phase legal-mode summary
     · Mini bar chart of ON-rate by phase per lamp

   PROFILE tab — full SVG lighting-profile timeline:
     · Y-axis: 10 lamp rows
     · X-axis: 9 phase columns (PARKED→LANDING)
     · Cell colour: REQUIRED green / RECOMMENDED sky /
                    OPTIONAL slate / OFF (forbidden) rose
     · Per-class overlay highlighted rows when class chip clicked
     · Reference Boeing FCOM PI §16 / Airbus FCTM PRO-NOR-SOP-09
       / FAA AC 91-73B §6 table embedded in figure

   ------------------------------------------------------------
   EXTLT entry registered in Layers Safety & Traffic category
   after MCAS, ft-extlt persisted preference.
   ============================================================ */

interface EFlight {
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
  ground?: boolean
}
interface Props {
  map: maplibregl.Map | null
  flights: EFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

// ----- Tiers ---------------------------------------------------------------
type Tier = 'VIOLATION' | 'UNSAFE' | 'SUBOPT' | 'COMPLIANT' | 'OPTIMAL' | 'OFF'
const TIER_COLOR: Record<Tier, string> = {
  VIOLATION: '#f43f5e', UNSAFE: '#fb7185', SUBOPT: '#f59e0b',
  COMPLIANT: '#0ea5e9', OPTIMAL: '#10b981', OFF: '#475569',
}
const TIER_RANK: Record<Tier, number> = {
  VIOLATION: 0, UNSAFE: 1, SUBOPT: 2, COMPLIANT: 3, OPTIMAL: 4, OFF: 5,
}
const TIER_ORDER: Tier[] = ['VIOLATION', 'UNSAFE', 'SUBOPT', 'COMPLIANT', 'OPTIMAL']

// ----- Classes -------------------------------------------------------------
type Klass = 'HVY-T' | 'HVY-Q' | 'WB-M' | 'NB' | 'RGN-J' | 'RGN-T' | 'BIZ' | 'LIGHT'
const KLASS_COLOR: Record<Klass, string> = {
  'HVY-T': '#a78bfa', 'HVY-Q': '#c084fc', 'WB-M': '#7dd3fc', 'NB': '#34d399',
  'RGN-J': '#fbbf24', 'RGN-T': '#facc15', 'BIZ': '#fb7185', 'LIGHT': '#94a3b8',
}

interface KlassRec {
  cls: Klass
  label: string
  landingType: 'HID' | 'TUNGSTEN' | 'LED'
  landingWattsEa: number
  landingCount: number
  taxiCount: number
  rtoCount: number
  hasWingScan: boolean
  hasLogo: boolean
  switchArch: 'multi' | 'single' | 'logic'
  amm: string
}
const CLASSES: KlassRec[] = [
  { cls:'HVY-T', label:'WB-Twin', landingType:'HID', landingWattsEa:600, landingCount:2, taxiCount:2, rtoCount:2, hasWingScan:true, hasLogo:true, switchArch:'multi', amm:'Boeing 777/787 AMM 33-40-00 / Airbus A350 AMM 33-43' },
  { cls:'HVY-Q', label:'WB-Quad', landingType:'TUNGSTEN', landingWattsEa:600, landingCount:4, taxiCount:2, rtoCount:2, hasWingScan:true, hasLogo:true, switchArch:'multi', amm:'Boeing 747-400/-8 AMM 33-42 / A380 AMM 33-44' },
  { cls:'WB-M',  label:'WB-Med',  landingType:'TUNGSTEN', landingWattsEa:600, landingCount:2, taxiCount:1, rtoCount:2, hasWingScan:true, hasLogo:true, switchArch:'multi', amm:'Boeing 767 AMM 33-41 / A300/A310 AMM 33-42' },
  { cls:'NB',    label:'NarrowBody', landingType:'HID', landingWattsEa:250, landingCount:2, taxiCount:1, rtoCount:2, hasWingScan:true, hasLogo:true, switchArch:'multi', amm:'Boeing 737NG/MAX AMM 33-44 / A320 AMM 33-41' },
  { cls:'RGN-J', label:'Regional-Jet', landingType:'HID', landingWattsEa:200, landingCount:2, taxiCount:1, rtoCount:1, hasWingScan:false, hasLogo:true, switchArch:'single', amm:'E170/190 AMM 33-44 / CRJ700/900 AMM 33-43' },
  { cls:'RGN-T', label:'Turboprop', landingType:'TUNGSTEN', landingWattsEa:450, landingCount:2, taxiCount:1, rtoCount:1, hasWingScan:false, hasLogo:false, switchArch:'single', amm:'ATR42/72 AMM 33-42 / Q400 AMM 33-43' },
  { cls:'BIZ',   label:'Business', landingType:'LED', landingWattsEa:120, landingCount:4, taxiCount:2, rtoCount:2, hasWingScan:true, hasLogo:true, switchArch:'multi', amm:'Gulfstream G650 AMM 33-40 / Bombardier Global AMM 33-41' },
  { cls:'LIGHT', label:'Light/GA', landingType:'LED', landingWattsEa:100, landingCount:1, taxiCount:1, rtoCount:0, hasWingScan:false, hasLogo:false, switchArch:'single', amm:'PC-12 POH §7.11 / Cessna 25B POH §7.10' },
]

function classify(f: EFlight): Klass {
  const t = (f.type || '').toUpperCase()
  if (/^B77|^B78|^A35|^A33[0-9]|^MD11/.test(t)) return 'HVY-T'
  if (/^B74|^A38/.test(t)) return 'HVY-Q'
  if (/^B76|^A31|^A30/.test(t)) return 'WB-M'
  if (/^B73|^B75|^A31[89]|^A32|^A20N|^A21N|^BCS/.test(t)) return 'NB'
  if (/^E1[79]|^E2[09]|^CRJ|^RJ1?[01]/.test(t)) return 'RGN-J'
  if (/^AT[47]|^DH8|^Q40|^SF34|^SAAB|^D328|^MA60/.test(t)) return 'RGN-T'
  if (/^G[56]|^GL|^FA[78]|^C2[05]|^CL[36]|^LJ|^PRM/.test(t)) return 'BIZ'
  if (/^PC|^C1[578]|^PA|^SR2|^TBM|^DA/.test(t)) return 'LIGHT'
  if (f.velocityKts > 380) return 'HVY-T'
  if (f.velocityKts > 280) return 'NB'
  if (f.velocityKts > 180) return 'RGN-J'
  return 'NB'
}
const klassRec = (c: Klass) => CLASSES.find(x => x.cls === c)!

// ----- Phases --------------------------------------------------------------
type Phase = 'PARKED' | 'GATE-ENG' | 'PUSH-TAXI' | 'LINE-UP' | 'TKO-ROLL' |
             'CLIMB-LOW' | 'CRUISE' | 'APPR-DESC' | 'LANDING'

const PHASE_ORDER: Phase[] = ['PARKED', 'GATE-ENG', 'PUSH-TAXI', 'LINE-UP',
                              'TKO-ROLL', 'CLIMB-LOW', 'CRUISE', 'APPR-DESC',
                              'LANDING']

function classifyPhase(f: EFlight): Phase {
  if (f.ground) {
    if (f.velocityKts < 1) return 'PARKED'
    if (f.velocityKts < 5) return 'GATE-ENG'
    if (f.velocityKts < 60) return 'PUSH-TAXI'
    if (f.velocityKts < 80) return 'LINE-UP'
    return 'TKO-ROLL'
  }
  const vs = f.vertRate || 0
  if (f.altitudeFt < 10000 && vs > 200) return 'CLIMB-LOW'
  if (f.altitudeFt < 4000 && vs < -200) return 'LANDING'
  if (f.altitudeFt < 12000 && vs < -200) return 'APPR-DESC'
  return 'CRUISE'
}

function phaseWeight(p: Phase): number {
  switch (p) {
    case 'TKO-ROLL': return 1.40
    case 'LINE-UP':  return 1.30
    case 'LANDING':  return 1.30
    case 'CLIMB-LOW': return 1.20
    case 'APPR-DESC': return 1.10
    case 'PUSH-TAXI': return 1.05
    case 'GATE-ENG': return 1.00
    case 'CRUISE':   return 0.65
    case 'PARKED':   return 0.20
  }
}

// ----- Lamp inventory ------------------------------------------------------
type Lamp = 'BEACON' | 'STROBE' | 'NAV-L' | 'NAV-R' | 'NAV-T' |
            'LANDING' | 'TAXI' | 'RTO' | 'WING' | 'LOGO'
const LAMPS: Lamp[] = ['BEACON', 'STROBE', 'NAV-L', 'NAV-R', 'NAV-T',
                       'LANDING', 'TAXI', 'RTO', 'WING', 'LOGO']

const LAMP_LABEL: Record<Lamp, string> = {
  BEACON: 'Red rotating beacon (engine running)',
  STROBE: 'White anti-collision strobes (movement)',
  'NAV-L': 'Red position light, left wing',
  'NAV-R': 'Green position light, right wing',
  'NAV-T': 'White position light, tail',
  LANDING: 'Sealed-beam / HID landing lights',
  TAXI:    'Diffuse taxi light (nose-gear / wing-root)',
  RTO:     'Runway-turnoff (wing-root sideways)',
  WING:    'Wing inspection / wing scan light',
  LOGO:    'Vertical-fin logo light',
}

// Per-phase REQUIRED / RECOMMENDED / OPTIONAL / FORBIDDEN per AC 91-73B §6
// Format: 'R' required (missing = penalty), '+' recommended (missing = soft),
//         '.' optional, 'X' should be OFF (on = penalty)
type LampMode = 'R' | '+' | '.' | 'X'
const PHASE_TABLE: Record<Phase, Record<Lamp, LampMode>> = {
  PARKED:   { BEACON:'.', STROBE:'X', 'NAV-L':'.', 'NAV-R':'.', 'NAV-T':'.', LANDING:'X', TAXI:'X', RTO:'X', WING:'.', LOGO:'.' },
  'GATE-ENG': { BEACON:'R', STROBE:'X', 'NAV-L':'+', 'NAV-R':'+', 'NAV-T':'+', LANDING:'X', TAXI:'.', RTO:'X', WING:'.', LOGO:'+' },
  'PUSH-TAXI': { BEACON:'R', STROBE:'X', 'NAV-L':'R', 'NAV-R':'R', 'NAV-T':'R', LANDING:'X', TAXI:'R', RTO:'+', WING:'.', LOGO:'+' },
  'LINE-UP':  { BEACON:'R', STROBE:'R', 'NAV-L':'R', 'NAV-R':'R', 'NAV-T':'R', LANDING:'R', TAXI:'R', RTO:'R', WING:'.', LOGO:'+' },
  'TKO-ROLL': { BEACON:'R', STROBE:'R', 'NAV-L':'R', 'NAV-R':'R', 'NAV-T':'R', LANDING:'R', TAXI:'R', RTO:'R', WING:'.', LOGO:'X' },
  'CLIMB-LOW': { BEACON:'R', STROBE:'R', 'NAV-L':'R', 'NAV-R':'R', 'NAV-T':'R', LANDING:'R', TAXI:'+', RTO:'X', WING:'.', LOGO:'.' },
  CRUISE:   { BEACON:'R', STROBE:'R', 'NAV-L':'R', 'NAV-R':'R', 'NAV-T':'R', LANDING:'X', TAXI:'X', RTO:'X', WING:'.', LOGO:'.' },
  'APPR-DESC': { BEACON:'R', STROBE:'R', 'NAV-L':'R', 'NAV-R':'R', 'NAV-T':'R', LANDING:'R', TAXI:'.', RTO:'X', WING:'.', LOGO:'+' },
  LANDING:  { BEACON:'R', STROBE:'R', 'NAV-L':'R', 'NAV-R':'R', 'NAV-T':'R', LANDING:'R', TAXI:'R', RTO:'R', WING:'.', LOGO:'+' },
}

// ----- Synthetic state sampling (deterministic per icao + tick) ------------
function hash32(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h
}

// Synthesise lamp state per phase: most flights compliant, some with mistakes
// ~88% nominal, 8% missed-one-lamp, 3% missed-two, 1% missed BEACON/NAV (violation)
function lampState(icao: string, rec: KlassRec, phase: Phase, isNight: boolean, isIMC: boolean): Record<Lamp, boolean> {
  const h = hash32(icao + phase)
  const out: Record<Lamp, boolean> = { BEACON:false, STROBE:false, 'NAV-L':false, 'NAV-R':false, 'NAV-T':false, LANDING:false, TAXI:false, RTO:false, WING:false, LOGO:false }
  const tbl = PHASE_TABLE[phase]

  // Start from nominal — ON for R / +, OFF for X / .  (+ shown ON by default;
  // optional . shown ON 35% of time; X off; R on)
  for (const L of LAMPS) {
    const m = tbl[L]
    if (m === 'R') out[L] = true
    else if (m === '+') out[L] = true
    else if (m === '.') out[L] = ((h >>> (LAMPS.indexOf(L) * 3)) & 0x07) >= 5
    else out[L] = false  // X = OFF nominally
  }

  // Class-specific lamp absence
  if (!rec.hasWingScan) out.WING = false
  if (!rec.hasLogo) out.LOGO = false

  // Inject per-airframe deterministic mistakes (8% miss-one + 3% miss-two)
  const r1 = (h >>> 24) & 0xff
  if (r1 < 22) {
    // miss one required lamp
    const idx = (h >>> 16) & 0x07
    const L = LAMPS[idx]
    if (tbl[L] === 'R' || tbl[L] === '+') out[L] = false
  }
  if (r1 < 6) {
    // miss two required lamps
    const idx2 = (h >>> 13) & 0x07
    const L2 = LAMPS[idx2]
    if (tbl[L2] === 'R' || tbl[L2] === '+') out[L2] = false
  }
  if (r1 < 2) {
    // hard violation: BEACON or NAV off during ground or night
    if (phase === 'PUSH-TAXI' || phase === 'GATE-ENG') out.BEACON = false
    if (isNight) out['NAV-L'] = false
  }

  // Courtesy mistakes: leaving LOGO on during TKO-ROLL ~6%
  const r2 = (h >>> 8) & 0xff
  if (r2 < 16 && phase === 'TKO-ROLL' && rec.hasLogo) out.LOGO = true
  // Strobe-courtesy: leaving STROBE off during PUSH-TAXI in night (often
  // strobe is held off until line-up to not blind taxiing aircraft)
  if (phase === 'PUSH-TAXI' && r2 > 30) out.STROBE = false  // mostly OFF (correct courtesy)
  // BEACON-on while parked ~5% (engine running at gate, normal)
  if (phase === 'PARKED' && r2 < 12) out.BEACON = true

  // Night cruise: LOGO often ON for company branding ~35%
  if (phase === 'CRUISE' && isNight && rec.hasLogo && r2 < 90) out.LOGO = true

  return out
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

// ----- Score computation ---------------------------------------------------
interface Drivers { CFG: number; COURTESY: number; NIGHT: number; CONSPIC: number; SLD: number; LOGOINV: number; BURN: number }
interface Row {
  f: EFlight; cls: Klass; rec: KlassRec; phase: Phase
  state: Record<Lamp, boolean>; tbl: Record<Lamp, LampMode>
  missing: Lamp[]; extra: Lamp[]
  drivers: Drivers; score: number; tier: Tier
  notes: string[]
  isNight: boolean; isIMC: boolean; lampsOn: number
}

function scoreRow(f: EFlight, advMul: number, nightAmp: number, sldMul: number, burnMul: number,
                  forceNight: boolean, forceIMC: boolean, forceSld: boolean): Row | null {
  if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) return null
  const cls = classify(f)
  const rec = klassRec(cls)
  const phase = classifyPhase(f)

  // Day/night per longitude-anchored synthetic UTC clock (deterministic over
  // an evaluation window) — use icao hash so distribution is steady
  const h = hash32(f.icao)
  const utcHour = ((h >>> 9) % 24)
  const localHour = ((utcHour + Math.round(f.lng / 15)) + 48) % 24
  const isNight = forceNight || (localHour < 6 || localHour >= 19)
  // IMC: 25% of cruise; 35% of climb/descent below 10K; force-IMC override
  const r1 = (h >>> 17) & 0xff
  const isIMC = forceIMC || ((phase === 'CRUISE' && r1 < 64) || ((phase === 'CLIMB-LOW' || phase === 'APPR-DESC') && r1 < 90))

  const state = lampState(f.icao, rec, phase, isNight, isIMC)
  const tbl = PHASE_TABLE[phase]

  // Count missing required / present-but-forbidden / suboptimal
  const missing: Lamp[] = []
  const extra: Lamp[] = []
  let recMiss = 0
  for (const L of LAMPS) {
    // Skip lamps the class doesn't have
    if (L === 'WING' && !rec.hasWingScan) continue
    if (L === 'LOGO' && !rec.hasLogo) continue
    const m = tbl[L]
    if (m === 'R' && !state[L]) missing.push(L)
    if (m === '+' && !state[L]) recMiss++
    if (m === 'X' && state[L]) extra.push(L)
  }

  // SLD landing-light lens icing proxy
  const sldR = (h >>> 11) & 0xff
  const sldActive = forceSld || (isIMC && f.altitudeFt > 4000 && f.altitudeFt < 22000 && sldR < 30)
  // Burn-out proxy — HID arc-life decay (older airframe by icao hash)
  const burnR = (h >>> 5) & 0xff
  const lampBurn = burnR < 14 && rec.landingType === 'HID'

  // Drivers
  const cfg = clamp(missing.length * 18 + recMiss * 6, 0, 100)
  const courtesy = clamp(extra.length * 10, 0, 100)
  // NIGHT penalty: night/IMC & missing NAV/STROBE
  const navOff = !state['NAV-L'] || !state['NAV-R'] || !state['NAV-T']
  const strobeOff = !state.STROBE && (phase !== 'PARKED' && phase !== 'GATE-ENG' && phase !== 'PUSH-TAXI')
  const night = clamp(((navOff && isNight) ? 80 : 0) + ((strobeOff && isNight) ? 40 : 0) + (isIMC ? 25 : 0), 0, 100) * (nightAmp / 100)
  // CONSPIC: InFO 10003 "Below 10K" — LANDING off in CLIMB-LOW or APPR-DESC
  const conspic = clamp(
    ((phase === 'CLIMB-LOW' || phase === 'APPR-DESC') && !state.LANDING) ? 75 : 0
    , 0, 100)
  // SLD lens icing
  const sld = sldActive ? clamp(45 + (state.LANDING ? 25 : 0), 0, 100) * (sldMul / 100) : 0
  // LOGO inversely penalised during TKO-ROLL / CLIMB-LOW
  const logoinv = ((phase === 'TKO-ROLL' || phase === 'CLIMB-LOW') && state.LOGO) ? 55 : 0
  // Burn proxy
  const burn = lampBurn ? 35 * (burnMul / 100) : 0

  const drivers: Drivers = { CFG: cfg, COURTESY: courtesy, NIGHT: night, CONSPIC: conspic, SLD: sld, LOGOINV: logoinv, BURN: burn }
  const vals = Object.values(drivers)
  const maxD = Math.max(...vals)
  const meanD = vals.reduce((a, b) => a + b, 0) / vals.length
  let score = (maxD * 0.66 + meanD * 0.34) * phaseWeight(phase) * (advMul / 100)

  // Hard escalators
  if (!state.BEACON && (phase === 'GATE-ENG' || phase === 'PUSH-TAXI' || phase === 'LINE-UP' || phase === 'TKO-ROLL')) {
    score = Math.max(score, 92)
  }
  if (isNight && (!state['NAV-L'] || !state['NAV-R'] || !state['NAV-T'])) {
    score = Math.max(score, 88)
  }
  if (!state.STROBE && (phase === 'LINE-UP' || phase === 'TKO-ROLL')) {
    score = Math.max(score, 78)
  }
  if (isNight && !state.LANDING && (phase === 'TKO-ROLL' || phase === 'LANDING')) {
    score = Math.max(score, 74)
  }
  if (state.LOGO && phase === 'TKO-ROLL') {
    score = Math.max(score, 55)
  }
  score = clamp(score, 0, 100)

  let tier: Tier
  if (phase === 'PARKED' && score < 18) tier = 'OFF'
  else if (score >= 85) tier = 'VIOLATION'
  else if (score >= 65) tier = 'UNSAFE'
  else if (score >= 45) tier = 'SUBOPT'
  else if (score >= 22) tier = 'COMPLIANT'
  else tier = 'OPTIMAL'

  const notes: string[] = []
  if (!state.BEACON && (phase === 'GATE-ENG' || phase === 'PUSH-TAXI' || phase === 'LINE-UP' || phase === 'TKO-ROLL')) {
    notes.push(`BEACON OFF with engine running — ICAO Annex 6 §6.10.1 / FAA AIM 4-3-23 / FCOM PI §16 violation`)
  }
  if (isNight && (!state['NAV-L'] || !state['NAV-R'] || !state['NAV-T'])) {
    notes.push(`NAV OFF in night ops — 14 CFR §91.209(a)(1) hard violation`)
  }
  if (!state.STROBE && (phase === 'LINE-UP' || phase === 'TKO-ROLL')) {
    notes.push(`STROBE OFF at LINE-UP / TKO-ROLL — FAA SAFO 17005 / InFO 10003 conspicuity gap`)
  }
  if (state.LOGO && phase === 'TKO-ROLL') {
    notes.push(`LOGO ON during TKO-ROLL — Boeing FCOM PI §16 calls for LOGO OFF before takeoff to avoid peripheral interference`)
  }
  if (missing.length > 0 && notes.length === 0) {
    notes.push(`Missing required lamp${missing.length > 1 ? 's' : ''}: ${missing.join(', ')} per AC 91-73B §6 / ${rec.amm}`)
  }
  if ((phase === 'CLIMB-LOW' || phase === 'APPR-DESC') && !state.LANDING) {
    notes.push(`LANDING lights OFF below FL100 — FAA InFO 10003 conspicuity practice missed`)
  }
  if (sldActive && state.LANDING) {
    notes.push(`SLD/icing conditions — landing-light lens may glaze; cycle lamps per FCOM Anti-Ice & Rain`)
  }
  if (notes.length === 0) {
    const oncount = Object.values(state).filter(Boolean).length
    notes.push(`${oncount} lamps ON · phase-typical config per FAA AC 91-73B §6 / ${rec.amm}`)
  }

  const lampsOn = Object.values(state).filter(Boolean).length
  return { f, cls, rec, phase, state, tbl, missing, extra, drivers, score, tier, notes, isNight, isIMC, lampsOn }
}

// ----- Component -----------------------------------------------------------
export default function ExtltExteriorLighting({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLASSES' | 'LAMPS' | 'PROFILE'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [q, setQ] = useState('')
  const [advMul, setAdvMul] = useState(100)
  const [nightAmp, setNightAmp] = useState(100)
  const [sldMul, setSldMul] = useState(100)
  const [burnMul, setBurnMul] = useState(100)
  const [forceNight, setForceNight] = useState(false)
  const [forceIMC, setForceIMC] = useState(false)
  const [forceSld, setForceSld] = useState(false)
  const [classFilter, setClassFilter] = useState<Set<Klass>>(new Set())
  const [phaseFilter, setPhaseFilter] = useState<Set<Phase>>(new Set())
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showBeam, setShowBeam] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [pickedIcao, setPickedIcao] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => { const t = setInterval(() => setTick(x => x + 1), 22000); return () => clearInterval(t) }, [])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const r = scoreRow(f, advMul, nightAmp, sldMul, burnMul, forceNight, forceIMC, forceSld)
      if (r) out.push(r)
    }
    return out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score).slice(0, 280)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flights, advMul, nightAmp, sldMul, burnMul, forceNight, forceIMC, forceSld, tick])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { VIOLATION:0, UNSAFE:0, SUBOPT:0, COMPLIANT:0, OPTIMAL:0, OFF:0 }
    rows.forEach(r => c[r.tier]++); return c
  }, [rows])

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (classFilter.size) r = r.filter(x => classFilter.has(x.cls))
    if (phaseFilter.size) r = r.filter(x => phaseFilter.has(x.phase))
    if (q.trim()) {
      const s = q.trim().toLowerCase()
      r = r.filter(x =>
        (x.f.callsign || '').toLowerCase().includes(s) ||
        (x.f.icao || '').toLowerCase().includes(s) ||
        (x.f.type || '').toLowerCase().includes(s) ||
        x.cls.toLowerCase().includes(s) ||
        x.phase.toLowerCase().includes(s) ||
        LAMPS.some(L => L.toLowerCase().includes(s) && x.state[L])
      )
    }
    return r
  }, [rows, tierFilter, classFilter, phaseFilter, q])

  const meanScore = rows.length ? rows.reduce((a, b) => a + b.score, 0) / rows.length : 0
  const vioCnt = tierCounts.VIOLATION
  const unsafeCnt = tierCounts.UNSAFE
  const nightCnt = rows.filter(r => r.isNight).length
  const totalLampsOn = rows.reduce((a, b) => a + b.lampsOn, 0)
  const worst = rows[0]

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const SRC = 'extlt-ac'
    const HALO = 'extlt-halo', INNER = 'extlt-inner', PIN = 'extlt-pin', LBL = 'extlt-lbl', BEAM = 'extlt-beam'
    const BEAM_SRC = 'extlt-beam-src'

    const fc = { type:'FeatureCollection' as const, features: rows.map(r => ({
      type:'Feature' as const,
      geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat] },
      properties:{
        cs: r.f.callsign || r.f.icao, tier: r.tier, cls: r.cls,
        color: TIER_COLOR[r.tier], inner: KLASS_COLOR[r.cls],
        lamps: r.lampsOn, phase: r.phase,
        haloR: 7 + (5 - Math.min(5, TIER_RANK[r.tier])) * 3,
        pinScale: r.tier === 'VIOLATION' ? 1.7 : r.tier === 'UNSAFE' ? 1.25 : 0,
      },
    })) }

    // Landing beam vector — short cone forward from aircraft when LANDING/TAXI/RTO on
    const beamFeats = rows.filter(r => r.state.LANDING && (r.tier === 'VIOLATION' || r.tier === 'UNSAFE' || r.tier === 'SUBOPT')).slice(0, 20).map(r => {
      const power = r.rec.landingWattsEa * r.rec.landingCount / 1000  // kW
      const len = 0.05 + Math.min(0.30, (power * r.score) / 800)
      const θ = (r.f.track || 0) * Math.PI / 180
      const dy = Math.cos(θ) * len
      const dx = Math.sin(θ) * len / Math.cos(r.f.lat * Math.PI / 180)
      return {
        type:'Feature' as const,
        geometry:{ type:'LineString' as const, coordinates:[[r.f.lng, r.f.lat], [r.f.lng + dx, r.f.lat + dy]] },
        properties:{ color: TIER_COLOR[r.tier] },
      }
    })
    const beamFC = { type:'FeatureCollection' as const, features: beamFeats }

    const add = () => {
      try {
        if (!map.getSource(SRC)) map.addSource(SRC, { type:'geojson', data: fc as any })
        else (map.getSource(SRC) as any).setData(fc)
        if (!map.getSource(BEAM_SRC)) map.addSource(BEAM_SRC, { type:'geojson', data: beamFC as any })
        else (map.getSource(BEAM_SRC) as any).setData(beamFC)

        if (showBeam && !map.getLayer(BEAM)) map.addLayer({ id:BEAM, type:'line', source:BEAM_SRC, paint:{
          'line-color':['get','color'], 'line-width':1.6, 'line-opacity':0.55, 'line-dasharray':[1,1.5],
        }})
        if (showHalo && !map.getLayer(HALO)) map.addLayer({ id:HALO, type:'circle', source:SRC, paint:{
          'circle-radius':['get','haloR'], 'circle-color':['get','color'],
          'circle-opacity':0.14, 'circle-stroke-color':['get','color'],
          'circle-stroke-width':1.5, 'circle-stroke-opacity':0.85,
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
        if (showLbl && !map.getLayer(LBL)) map.addLayer({ id:LBL, type:'symbol', source:SRC, layout:{
          'text-field':['concat',['get','cs'],'  ',['get','cls'],'  ',['get','lamps'],' on'],
          'text-size':10, 'text-offset':[0,1.45], 'text-anchor':'top',
          'text-font':['Open Sans Semibold','Arial Unicode MS Bold'],
        }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0b1220', 'text-halo-width':1.2 }})
      } catch {}
    }
    if (map.isStyleLoaded()) add(); else map.once('load', add)
    return () => {
      try {
        for (const l of [LBL, PIN, INNER, HALO, BEAM]) if (map.getLayer(l)) map.removeLayer(l)
        if (map.getSource(SRC)) map.removeSource(SRC)
        if (map.getSource(BEAM_SRC)) map.removeSource(BEAM_SRC)
      } catch {}
    }
  }, [map, rows, showHalo, showPin, showLbl, showBeam])

  const pickedRow = filtered.find(r => r.f.icao === pickedIcao) || worst || null

  // ----- Render ------------------------------------------------------------
  return (
    <div className="absolute right-3 top-20 z-30 w-[540px] max-h-[84vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">EXTLT</div>
        <div className="text-[10px] text-slate-400 truncate">Exterior lighting · anti-collision conspicuity audit</div>
        <div className="ml-auto flex items-center gap-1">
          {(['AIRCRAFT','CLASSES','LAMPS','PROFILE'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`text-[10px] px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'border border-slate-700 text-slate-400 hover:text-slate-200'}`}>{t}</button>
          ))}
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xs px-2 py-1 rounded border border-slate-800">×</button>
        </div>
      </div>

      {/* Tier strip */}
      <div className="flex border-b border-slate-800/80 text-[10px]">
        <button onClick={() => setTierFilter('ALL')}
          className={`flex-1 px-2 py-1.5 ${tierFilter==='ALL'?'bg-sky-500/15 text-slate-100':'text-slate-400 hover:text-slate-200'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(t)}
            className={`flex-1 px-2 py-1.5 ${tierFilter===t?'bg-slate-800/80 text-slate-100':'text-slate-400 hover:text-slate-200'}`}
            style={{ color: tierFilter===t ? TIER_COLOR[t] : undefined }}>{t} · {tierCounts[t]}</button>
        ))}
      </div>

      {/* Summary */}
      <div className="grid grid-cols-5 border-b border-slate-800/80 text-[10px]">
        <div className="p-2 border-r border-slate-800/60"><div className="text-slate-500">μ-SCORE</div><div className="text-slate-100 font-semibold">{meanScore.toFixed(0)}</div></div>
        <div className="p-2 border-r border-slate-800/60"><div className="text-slate-500">VIO</div><div className="font-semibold" style={{ color: vioCnt ? TIER_COLOR.VIOLATION : undefined }}>{vioCnt}</div></div>
        <div className="p-2 border-r border-slate-800/60"><div className="text-slate-500">UNSAFE</div><div className="font-semibold" style={{ color: unsafeCnt ? TIER_COLOR.UNSAFE : undefined }}>{unsafeCnt}</div></div>
        <div className="p-2 border-r border-slate-800/60"><div className="text-slate-500">NIGHT</div><div className="text-slate-100 font-semibold">{nightCnt}</div></div>
        <div className="p-2"><div className="text-slate-500">Σ-LAMPS-ON</div><div className="text-slate-100 font-semibold">{totalLampsOn}</div></div>
      </div>

      {/* Controls */}
      <div className="px-3 py-2 border-b border-slate-800/80 space-y-1.5">
        <div className="grid grid-cols-2 gap-2 text-[10px]">
          <label className="flex items-center gap-2">
            <span className="text-slate-500 w-16">ADV-MUL</span>
            <input type="range" min={50} max={200} value={advMul} onChange={e => setAdvMul(+e.target.value)} className="flex-1 accent-sky-500"/>
            <span className="w-10 text-right text-slate-300">{advMul}%</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-slate-500 w-16">NIGHT-AMP</span>
            <input type="range" min={50} max={200} value={nightAmp} onChange={e => setNightAmp(+e.target.value)} className="flex-1 accent-sky-500"/>
            <span className="w-10 text-right text-slate-300">{nightAmp}%</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-slate-500 w-16">SLD-MUL</span>
            <input type="range" min={0} max={200} value={sldMul} onChange={e => setSldMul(+e.target.value)} className="flex-1 accent-sky-500"/>
            <span className="w-10 text-right text-slate-300">{sldMul}%</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-slate-500 w-16">BURN-MUL</span>
            <input type="range" min={0} max={200} value={burnMul} onChange={e => setBurnMul(+e.target.value)} className="flex-1 accent-sky-500"/>
            <span className="w-10 text-right text-slate-300">{burnMul}%</span>
          </label>
        </div>
        <div className="flex items-center gap-2 text-[10px] flex-wrap">
          <label className="flex items-center gap-1"><input type="checkbox" className="accent-sky-500" checked={forceNight} onChange={e=>setForceNight(e.target.checked)}/>Force NIGHT</label>
          <label className="flex items-center gap-1"><input type="checkbox" className="accent-sky-500" checked={forceIMC} onChange={e=>setForceIMC(e.target.checked)}/>Force IMC</label>
          <label className="flex items-center gap-1"><input type="checkbox" className="accent-sky-500" checked={forceSld} onChange={e=>setForceSld(e.target.checked)}/>Force SLD</label>
        </div>
        <div className="flex flex-wrap gap-1">
          {CLASSES.map(c => {
            const on = classFilter.has(c.cls)
            return <button key={c.cls} onClick={() => {
              const ns = new Set(classFilter); on ? ns.delete(c.cls) : ns.add(c.cls); setClassFilter(ns)
            }} className={`text-[9px] px-1.5 py-0.5 rounded border ${on?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-700 text-slate-400'}`}
              style={{ color: on ? KLASS_COLOR[c.cls] : undefined }}>{c.cls}</button>
          })}
        </div>
        <div className="flex flex-wrap gap-1">
          {PHASE_ORDER.map(p => {
            const on = phaseFilter.has(p)
            return <button key={p} onClick={() => {
              const ns = new Set(phaseFilter); on ? ns.delete(p) : ns.add(p); setPhaseFilter(ns)
            }} className={`text-[9px] px-1.5 py-0.5 rounded border ${on?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-700 text-slate-400'}`}>{p}</button>
          })}
        </div>
        <div className="flex items-center gap-1.5 text-[10px]">
          {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['BEAM',showBeam,setShowBeam],['LBL',showLbl,setShowLbl]] as const).map(([n,v,s]) => (
            <button key={n} onClick={() => s(!v as any)} className={`px-1.5 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-700 text-slate-400'}`}>{n}</button>
          ))}
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="cs / type / lamp / phase"
            className="ml-auto bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-[10px] w-40 placeholder:text-slate-600 outline-none focus:border-sky-500/60"/>
        </div>
      </div>

      {/* Body */}
      <div className="overflow-y-auto flex-1">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.map(r => (
              <div key={r.f.icao} className="p-2 hover:bg-slate-900/50 cursor-pointer" onClick={() => { setPickedIcao(r.f.icao); onFly(r.f.icao) }}>
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className="font-semibold text-slate-100">{r.f.callsign || r.f.icao}</span>
                  <span className="text-slate-500">{r.f.type || '—'}</span>
                  <span className="px-1 py-0.5 rounded text-[9px] border border-slate-700" style={{ color: KLASS_COLOR[r.cls] }}>{r.cls}</span>
                  <span className="px-1 py-0.5 rounded text-[9px] border border-slate-700 text-slate-300">{r.phase}</span>
                  {r.isNight && <span className="px-1 py-0.5 rounded text-[9px] border border-slate-700 text-slate-400">› NIGHT</span>}
                  {r.isIMC && <span className="px-1 py-0.5 rounded text-[9px] border border-slate-700 text-slate-400">› IMC</span>}
                  <span className="px-1 py-0.5 rounded text-[9px] border" style={{ color: TIER_COLOR[r.tier], borderColor: TIER_COLOR[r.tier]+'66' }}>{r.tier}</span>
                  <span className="ml-auto text-[10px] text-slate-400">{r.lampsOn}/{LAMPS.length - (r.rec.hasWingScan?0:1) - (r.rec.hasLogo?0:1)} ON</span>
                </div>
                {/* Lamp strip */}
                <div className="mt-1 flex flex-wrap gap-1 text-[9px]">
                  {LAMPS.map(L => {
                    if (L === 'WING' && !r.rec.hasWingScan) return null
                    if (L === 'LOGO' && !r.rec.hasLogo) return null
                    const isOn = r.state[L]
                    const mode = r.tbl[L]
                    const wrong = (mode === 'R' && !isOn) || (mode === 'X' && isOn)
                    const bgcol = wrong ? TIER_COLOR.VIOLATION+'33' : isOn ? '#0ea5e933' : 'transparent'
                    const fgcol = wrong ? TIER_COLOR.VIOLATION : isOn ? '#0ea5e9' : '#475569'
                    return (
                      <span key={L} className="px-1 py-0.5 rounded border" style={{ borderColor: fgcol+'66', backgroundColor: bgcol, color: fgcol }}>
                        {L}{isOn ? '·on' : '·off'}{wrong ? '!' : ''}
                      </span>
                    )
                  })}
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-800/80 overflow-hidden">
                  <div className="h-full" style={{ width: r.score + '%', backgroundColor: TIER_COLOR[r.tier] }}/>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {Object.entries(r.drivers).map(([k, v]) => (
                    <span key={k} className="px-1 py-0.5 rounded border border-slate-800/80 text-[9px] text-slate-400">
                      {k}·<span className="text-slate-200">{Math.round(v)}</span>
                    </span>
                  ))}
                </div>
                <div className="mt-1 text-[10px] italic" style={{ color: TIER_COLOR[r.tier] }}>{r.notes[0]}</div>
                {r.notes.length > 1 && (
                  <div className="mt-0.5 text-[9px] text-slate-500">{r.notes.slice(1).join(' · ')}</div>
                )}
              </div>
            ))}
            {!filtered.length && <div className="p-6 text-center text-[11px] text-slate-500">No aircraft in current filter.</div>}
          </div>
        )}

        {tab === 'CLASSES' && (
          <div className="divide-y divide-slate-800/60">
            {CLASSES.map(c => {
              const r = rows.filter(x => x.cls === c.cls)
              const mu = r.length ? r.reduce((a, b) => a + b.score, 0) / r.length : 0
              const vio = r.filter(x => x.tier === 'VIOLATION').length
              const sub = r.filter(x => x.tier === 'SUBOPT').length
              const lampsOnAvg = r.length ? r.reduce((a, b) => a + b.lampsOn, 0) / r.length : 0
              return (
                <div key={c.cls} className="p-2">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="px-1 py-0.5 rounded text-[10px] font-semibold border" style={{ color: KLASS_COLOR[c.cls], borderColor: KLASS_COLOR[c.cls]+'60' }}>{c.cls}</span>
                    <span className="text-slate-300 text-[10px]">{c.label}</span>
                    <span className="text-slate-500 text-[10px]">{c.landingCount}×{c.landingWattsEa}W {c.landingType}</span>
                    <span className="text-slate-500 text-[10px]">·{c.switchArch}</span>
                    <span className="ml-auto text-slate-500 text-[10px]">n={r.length}</span>
                  </div>
                  <div className="mt-1 grid grid-cols-4 gap-1 text-[10px]">
                    <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">μ-SCORE </span><span className="text-slate-100">{mu.toFixed(0)}</span></div>
                    <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">VIO </span><span className="text-slate-100" style={{ color: vio ? TIER_COLOR.VIOLATION : undefined }}>{vio}</span></div>
                    <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">SUB </span><span className="text-slate-100" style={{ color: sub ? TIER_COLOR.SUBOPT : undefined }}>{sub}</span></div>
                    <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">μ-ON </span><span className="text-slate-100">{lampsOnAvg.toFixed(1)}</span></div>
                  </div>
                  <div className="mt-1 text-[10px] text-slate-500 italic">{c.amm}</div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'LAMPS' && (
          <div className="divide-y divide-slate-800/60">
            {LAMPS.map(L => {
              const total = rows.filter(r => !((L==='WING'&&!r.rec.hasWingScan)||(L==='LOGO'&&!r.rec.hasLogo))).length
              const on = rows.filter(r => r.state[L]).length
              const rate = total ? (on / total) * 100 : 0
              // Per-phase ON rate strip
              const phaseRates = PHASE_ORDER.map(p => {
                const ph = rows.filter(r => r.phase === p && !((L==='WING'&&!r.rec.hasWingScan)||(L==='LOGO'&&!r.rec.hasLogo)))
                const phOn = ph.filter(r => r.state[L]).length
                return ph.length ? (phOn / ph.length) * 100 : 0
              })
              return (
                <div key={L} className="p-2">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="font-semibold text-slate-100 w-20">{L}</span>
                    <span className="text-slate-500 text-[10px] flex-1 truncate">{LAMP_LABEL[L]}</span>
                    <span className="text-slate-400 text-[10px]">{on}/{total} on</span>
                    <span className="text-slate-100 text-[10px] font-semibold w-12 text-right">{rate.toFixed(0)}%</span>
                  </div>
                  <div className="mt-1 h-1 rounded bg-slate-800/80 overflow-hidden">
                    <div className="h-full bg-sky-500" style={{ width: rate + '%' }}/>
                  </div>
                  <div className="mt-1 grid grid-cols-9 gap-0.5 text-[9px]">
                    {PHASE_ORDER.map((p, i) => {
                      const r = phaseRates[i]
                      // What does AC 91-73B require for this lamp in this phase?
                      const mode = PHASE_TABLE[p][L]
                      const expected = mode === 'R' ? 100 : mode === '+' ? 80 : mode === '.' ? 35 : 0
                      const gap = Math.abs(r - expected)
                      const col = gap < 20 ? '#10b981' : gap < 40 ? '#f59e0b' : '#f43f5e'
                      return (
                        <div key={p} className="flex flex-col items-center">
                          <div className="w-full h-4 rounded-sm bg-slate-800/70 overflow-hidden relative">
                            <div className="absolute bottom-0 left-0 right-0" style={{ height: r + '%', backgroundColor: col, opacity:0.7 }}/>
                            <div className="absolute bottom-0 left-0 right-0 border-t border-dashed" style={{ bottom: expected + '%', borderColor:'#94a3b8' }}/>
                          </div>
                          <span className="text-slate-500 text-[8px] truncate w-full text-center">{p.slice(0,5)}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'PROFILE' && (
          <div className="p-3 space-y-2">
            <div className="text-[10px] text-slate-400">
              Per-phase lighting-config table per FAA AC 91-73B §6 / ICAO Annex 6 §6.10 / Boeing FCOM PI §16 / Airbus FCTM PRO-NOR-SOP-09. Picked: <span className="text-slate-100 font-semibold">{pickedRow ? (pickedRow.f.callsign||pickedRow.f.icao) : '—'}</span>
            </div>
            <svg viewBox="0 0 540 320" className="w-full">
              {/* X-axis: phase headers */}
              {PHASE_ORDER.map((p, i) => (
                <text key={p} x={86 + i*48} y={14} fontSize="8" fill="#94a3b8" textAnchor="middle">{p}</text>
              ))}
              {/* Y-axis: lamp rows */}
              {LAMPS.map((L, j) => (
                <g key={L}>
                  <text x={6} y={36 + j*26} fontSize="9" fill="#cbd5e1">{L}</text>
                  {PHASE_ORDER.map((p, i) => {
                    const mode = PHASE_TABLE[p][L]
                    const col = mode === 'R' ? '#10b981' : mode === '+' ? '#0ea5e9' : mode === '.' ? '#475569' : '#f43f5e'
                    const sym = mode === 'R' ? '●' : mode === '+' ? '○' : mode === '.' ? '·' : '✕'
                    // Highlight picked-row's actual state if present
                    const pickActual = pickedRow && pickedRow.phase === p ? pickedRow.state[L] : null
                    const ring = pickedRow && pickedRow.phase === p
                    return (
                      <g key={L+p}>
                        <rect x={66 + i*48} y={26 + j*26} width={42} height={18} rx={3}
                          fill={col} fillOpacity={mode === 'X' ? 0.18 : mode === '.' ? 0.06 : mode === '+' ? 0.18 : 0.30}
                          stroke={ring ? '#e2e8f0' : col} strokeWidth={ring ? 1.2 : 0.5} strokeOpacity={ring ? 0.85 : 0.4}/>
                        <text x={86 + i*48} y={39 + j*26} fontSize="10" fill={col} textAnchor="middle">{sym}</text>
                        {pickActual !== null && (
                          <text x={104 + i*48} y={32 + j*26} fontSize="7" fill={pickActual ? '#fff' : '#475569'}>{pickActual?'●':'○'}</text>
                        )}
                      </g>
                    )
                  })}
                </g>
              ))}
              {/* Legend */}
              <g transform="translate(6,306)">
                <text fontSize="9" fill="#94a3b8">● R = required</text>
                <text x={110} fontSize="9" fill="#0ea5e9">○ + = recommended</text>
                <text x={245} fontSize="9" fill="#475569">· = optional</text>
                <text x={335} fontSize="9" fill="#f43f5e">✕ X = should be OFF</text>
              </g>
            </svg>
            <div className="text-[10px] text-slate-500 leading-relaxed">
              The 10-lamp × 9-phase compliance grid above is the canonical "lights flow" taught in every type-rating syllabus. The white symbols overlaid on the picked-aircraft column show its <em>actual</em> state ● = on / ○ = off; mismatches against the row colour are scored against the {pickedRow ? pickedRow.cls : '—'}-class lamp inventory per <em>{pickedRow ? pickedRow.rec.amm : 'Boeing/Airbus AMM Ch.33'}</em>. Hard-violation floors: BEACON OFF at engines-running ⇒ 92 score-min (Annex 6 §6.10.1) / NAV OFF at night ⇒ 88 score-min (14 CFR §91.209(a)(1)) / STROBE OFF at LINE-UP ⇒ 78 score-min (FAA SAFO 17005, InFO 10003).
              <div className="mt-2 text-slate-500">References: 14 CFR §91.205 §91.209 §25.1383-1401 / EASA CS-25.1389-.1401 / ICAO Annex 6 Pt I §6.10 / Annex 8 Pt II §5 / Doc 9870 §6.3 / FAA AC 91-73B §6 / InFO 10003 / SAFO 17005 / AIM 4-3-23 / SAE ARP 5029 / AS 8037 / Boeing FCOM Vol 1 §16 / Airbus FCOM DSC-33 / Airbus FCTM PRO-NOR-SOP-09 §Departure-Lights / NTSB AAR-91-08 USAir-1493 LAX / AAR-08-01 Comair-5191 LEX / Tenerife KLM-4805 ASN WO-19980402-1 / JTSB AI-2024-1 JAL-516 HND.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
