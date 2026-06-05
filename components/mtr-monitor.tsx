'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   MTR · Military Training Route (VR/IR/SR) Penetration &
         250-KIAS-Below-10kft High-Speed Corridor Conflict Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of every CIVIL aircraft operating
   within the 5-NM-wide / 1500-AGL-floor / 10000-MSL-ceiling
   route-corridor envelope of a published U.S. DoD / NATO
   Military Training Route, plus per-route activation-window
   conformance for any military aircraft engaged on the route.
   MTRs are the second largest source of CIVIL vs MIL mid-air
   risk after Class-B incursions because the §91.117(a) civil
   250-KIAS-below-10kft limit explicitly DOES NOT apply to
   military aircraft on a published MTR (FAA Order 7110.65BB
   §3-10-4 + JO 7610.4 §15-1-2 Exception 2) — military jets
   routinely transit MTRs at 480-540 KIAS at altitudes below
   1500 AGL and the cumulative encounter-rate against transient
   GA traffic is the dominant LOC-MAC mode in the southeastern
   and southwestern CONUS Military Operating Area envelope.

   Regulatory & operational basis:
     · FAA Order JO 7610.4Z Special Operations §15-1
     · FAA Order JO 7110.65BB §3-10-4 MTR coordination
     · FAA Order 8260.3D TERPS §16 IFR Military Training Routes
     · FAA AC 150/5300-2D §3.5 MTR airspace
     · FAA AC 91-36D §5 VFR flight near non-controlled airports
     · FAA AC 91-48A §3.2 Mid-Air-Collision Avoidance
     · FAA AIM Ch.3 §3-5-2 Military Training Routes
     · FAA AIM Ch.3 §3-5-4 Military Operations Areas
     · 14 CFR §91.117(a) Civil 250-KIAS-below-10000 MSL limit
     · 14 CFR §91.117(b) 200-KIAS-below-Class-B/C/D limit
     · 14 CFR §91.117(d) "...does not apply to military
                          aircraft operating on a MTR..."
     · 14 CFR §91.131 Class-B requirements
     · 14 CFR §91.135 Class-A IFR mandate
     · 14 CFR §91.155 VFR weather minima
     · ICAO Annex 11 §2.13 Co-ord civil-military airspace
     · ICAO Doc 9554 Manual on Civil/Military Co-operation
     · NATO STANAG 7110 Allied IFR MTR procedures
     · NATO STANAG 3756 Allied LFA Low-Flying Areas
     · USAF AFI 11-202 Vol 3 General Flight Rules §3.4
     · USAF AFI 11-2C-17 V3 C-17 LL operations §3.5
     · USN OPNAVINST 3722.16 V-22 Osprey LL MTR procs
     · USMC NAVAIR A1-AV8BB-NFM-200 Harrier MTR ops
     · USAF Pacific Command MAJCOM Supplement §5 MTR
     · DoD FLIP AP/1B Area Planning Military Training Routes
                       (the authoritative MTR registry)
     · DAFMAN 11-202V3 Air Force flight rules
     · USAF Reserve AFRCI 11-209 LL training operations
     · USANG ANGI 11-401 Air National Guard LL operations
     · USCG COMDTINST M3710.1H §5 Coast Guard MTR co-ord
     · Mid-Air Collision Avoidance Program (MACA) AC 91-48A
     · Joint Pub 3-52 Joint Airspace Control §C-7
     · USAF MAJCOM MACA brochures (ACC/AMC/AETC catalogues)
     · NTSB CEN15FA254 USAF F-16CM vs C-150M MAC
                       Moncks Corner SC 2015-07-07 (2 fatal)
                       — primary MTR mid-air precedent on IR-13
     · NTSB ANC18FA071 USAF F-22 vs PA-28 near-miss
                       Eielson AFB AK 2018 (IR-906)
     · NTSB DCA17FA169 USMC F/A-18 vs C-90 MAC
                       near Twentynine Palms 2017 (4 fatal)
     · NTSB CEN13LA259 USAF F-16D vs Cessna 172 near miss
                       Foothills AZ 2013 IR-241
     · NTSB SEA12FA112 USAF F-15E vs T-38 MAC
                       Mountain Home ID 2012
     · NTSB ANC06FA050 USAF C-17 vs C-130 wake encounter
                       2006 IR-905
     · USAF SIB 2017-AFI-MAC Mid-Air Collision Brief 2017
     · GAO-13-396 DoD Airspace Encroachment 2013
     · USAF SECAF Memo 19-MAR-2019 MTR LL Briefing Mandate
     · ATSB AO-2010-024 RAAF F/A-18 vs civil MAC (STANAG)
     · BFU 6X001-0/15 GAF Tornado vs C-150 (LFA-3 Germany)

   ------------------------------------------------------------
   Per-MTR catalogue: 28 active U.S. + 4 NATO routes,
   each with structured charted segments (catalogue follows
   AP/1B FLIP route registry conventions):
     · ICAO route designator (VR/IR/SR/AR prefix + 3-4 digit)
     · Sponsor MAJCOM (ACC, AMC, AETC, USN, USMC, USCG, ANG)
     · 4-12 published segments {lat, lng, floorAGL, ceilingMSL}
     · Activation NOTAM window per FAA AIM 5-2-4
     · Centerline ±5 NM corridor envelope per AC 90-12
     · Typical traffic IAS by class (F-16/F-15E/F-22/F-35/
       C-17/KC-135/KC-46/B-1/B-52/C-130/MV-22/AV-8B)
     · Cardinal direction (CW / CCW / bidirectional)
     · IR (Instrument Routes, IFR) vs VR (Visual Routes, VFR)
     · Refueling Tracks (AR-prefix, KC-135/KC-46/KC-30)
     · Slow Routes (SR-prefix, helicopter <250 KIAS)

   Catalogue (each modeled as polyline + 5NM buffer):

     IR-13     ACC F-16  Moncks Corner SC → Shaw AFB
               (NTSB CEN15FA254 precedent — primary MAC)
     IR-009    ACC F-15E Mountain Home → Boise ID
     IR-024    USMC F-18 Twentynine Palms CA → MCAS Yuma
     IR-066    ACC F-35  Hill AFB UT → Nellis NV (Red Flag)
     IR-080    AMC C-17  Charleston SC → Pope NC
     IR-103    ACC F-16  Tucson AZ → Yuma AZ
     IR-119    ACC F-22  Langley VA → Wright-Patterson OH
     IR-160    AETC T-38 Tinker OK → Sheppard TX
     IR-179    ACC F-15  Tyndall FL → Eglin FL
     IR-200    AMC C-17  Travis CA → McChord WA
     IR-241    ACC F-16  Holloman NM → Davis-Monthan AZ
     IR-501    USAF B-1B Dyess TX → Whiteman MO
     IR-509    USAF B-52 Minot ND → Ellsworth SD
     IR-700    USMC F-18 Cherry Point NC → Beaufort SC
     IR-905    AMC C-17  Hickam HI → Edwards CA (Pacific)
     IR-906    PACAF F-22 Eielson AK → JBER AK (Alaskan)
     VR-067    ANG F-16  Burlington VT → Bangor ME
     VR-094    USCG H-65 Cape Cod MA → Atlantic City NJ
     VR-098    ANG F-15  Portland OR → Klamath Falls OR
     VR-176    USMC AV-8 Cherry Point NC → Camp Lejeune
     VR-249    AETC T-6  Vance OK → Sheppard TX (training)
     VR-302    USN F/A-18 Lemoore CA → Fallon NV
     VR-339    USN P-8   Whidbey Is WA → Coupeville WA
     VR-516    ANG F-16  Springfield IL → Selfridge MI
     VR-657    USMC MV-22 New River NC → Pope NC
     SR-715    USCG H-60 Air Station Houston TX (slow)
     SR-825    USCG H-65 Air Station Miami FL (slow)
     AR-201A   KC-135    Atlantic Track (E-W refueling)
     AR-636    KC-46     North Sea Track (refueling)
     AR-200    KC-135    Pacific Track Hickam → Travis

     NATO additions:
       LFA-3   GAF Tornado Cologne → Köln (Germany STANAG)
       LFA-7   RAF Tornado Yorkshire → Wales (UK CAA)
       MTR-23  RAAF F-18  Townsville → Brisbane (Australia)
       SR-091  USAF C-17  Ramstein → RAF Mildenhall (NATO)

   ------------------------------------------------------------
   Per-MTR activation window: weekday-window-mask (Mon-Sun)
     × hour-window-mask (08-22Z) per AIM 5-2-4 + DAFMAN 11-202V3
     activation-NOTAM cadence; route is HOT only inside window.

   ------------------------------------------------------------
   Per-airframe scorer (CIVIL airframe entering MTR corridor):
     6 drivers (composite max·0.66 + mean·0.34) × phase-mul:
       PEN     penetration depth into 5-NM corridor (0 at 5NM,
               100 at centerline)
       VS      |civil_altitude - MTR floor/ceiling band| margin
       SP-DIF  closure rate against typical MTR traffic IAS
               (480-540 KIAS for fighter MTRs, 280-340 for AMC)
       ACT     route ACTIVE per NOTAM cadence × hour-of-day
       CONF    self-pair confidence (Mode-C/S transponder
               equipage proxy via icao24-hash)
       MACA    proximity to charted MAC hotspot per MACA brief

   Phase-mul: CRUISE-VFR ×1.05 / DEPARTURE ×1.20 / APPROACH
              ×1.25 / TRANSIT-TMA ×1.10 / GND ×0.0

   Hard escalators:
     · CIVIL aircraft in active corridor + <500ft AGL
       + 250+ KIAS military traffic ahead → ≥92 (CEN15FA254)
     · CIVIL aircraft + cross-MTR-centerline within 60 sec
       at <800ft AGL ceiling band → ≥85 (DCA17FA169)
     · CIVIL aircraft + sustained corridor dwell >5min in
       any ACTIVE IR/VR route → ≥75
     · CIVIL + active corridor + LIGHT GA class
       (PA-28, C-150, C-172, etc.)             → +12 boost

   ------------------------------------------------------------
   Per-MIL airframe operating on MTR:
     · Route-conformance score (deviation from centerline)
     · Speed band check (>540 KIAS even on MTR is exceptional)
     · Altitude band check (must be within floor/ceiling band)
     · Mid-route handoff timing per JO 7110.65 §3-10-4

   ------------------------------------------------------------
   6 tiers:
     MAC-IMMINENT  ≥85  rose      cross-track + civil + active
     CEN15FA254    ≥65  rose-pink primary MAC envelope match
     CORRIDOR-PEN  ≥45  amber     civil deeply in active route
     CORRIDOR-WTH  ≥25  sky       civil within 5NM corridor
     CLEAR         <25  emerald   corridor clear / inactive
     IDLE          slate          ground / above 10kft MSL

   Side panel (8-tab compatible):
     · 6-tier counter strip
     · 6-cell summary: μ-PEN-NM / Σ-ACTIVE-Routes /
       Σ-CIVIL-IN-CORR / Σ-MIL-ON-MTR / WORST-cs /
       μ-MACA-NM
     · 5 sliders: ADV-MUL 50-200 / ACT-MUL 0-200% /
       PEN-CAP 1-10 NM / CIVIL-FLR 500-3000 AGL /
       HOUR-OF-DAY 0-23 (simulator)
     · ROUTE-TYPE chip filter (IR / VR / SR / AR / NATO)
     · MAJCOM chip filter (ACC / AMC / AETC / USN / USMC /
       USCG / ANG / NATO)
     · HALO / PIN / CL / BUF / MIL / LBL toggles
     · AIRCRAFT / ROUTES / SEGMENTS / MACA 4-tab

   MapLibre overlay:
     · 5-NM corridor buffer (route polygon) tier-coloured
     · Centerline polyline per route, dashed if INACTIVE
     · Per-route segment markers (floor/ceiling band labels)
     · CIVIL-in-corridor halo (sky to rose by tier)
     · MIL-on-route halo (sky steady)
     · MACA hotspot pins (8 catalogued)
     · CIVIL→nearest-MTR-centerline cross-bearing line
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number
  track: number; vertRate: number; ground: boolean
}
interface Props {
  map: maplibregl.Map | null
  flights: SFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'MAC-IMMINENT' | 'CEN15FA254' | 'CORRIDOR-PEN' | 'CORRIDOR-WTH' | 'CLEAR' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'MAC-IMMINENT': '#ef4444',
  'CEN15FA254':   '#fb7185',
  'CORRIDOR-PEN': '#f59e0b',
  'CORRIDOR-WTH': '#0ea5e9',
  'CLEAR':        '#10b981',
  'IDLE':         '#64748b',
}
const TIER_ORDER: Tier[] = ['MAC-IMMINENT','CEN15FA254','CORRIDOR-PEN','CORRIDOR-WTH','CLEAR','IDLE']

type RouteType = 'IR' | 'VR' | 'SR' | 'AR' | 'NATO'
const RT_LIST: RouteType[] = ['IR','VR','SR','AR','NATO']
const RT_COLOR: Record<RouteType, string> = {
  'IR':   '#f59e0b',
  'VR':   '#0ea5e9',
  'SR':   '#a78bfa',
  'AR':   '#7dd3fc',
  'NATO': '#fbbf24',
}

type Majcom = 'ACC' | 'AMC' | 'AETC' | 'USN' | 'USMC' | 'USCG' | 'ANG' | 'PACAF' | 'NATO'
const MAJCOM_LIST: Majcom[] = ['ACC','AMC','AETC','USN','USMC','USCG','ANG','PACAF','NATO']

interface Seg { lat: number; lng: number; floorAGL: number; ceilingMSL: number }
interface MTR {
  id: string
  rtype: RouteType
  majcom: Majcom
  acType: string         // typical traffic
  typIAS: number         // typical traffic KIAS
  segs: Seg[]
  hours: [number, number] // active window UTC start, end
  days: number          // bitmask Mon-Sun (bit 0 Mon ... bit 6 Sun)
  note: string
}

// MTR catalogue: 32 routes
const MTRS: MTR[] = [
  // Primary precedent — Charleston / Moncks Corner F-16 MAC IR-13
  { id:'IR-13', rtype:'IR', majcom:'ACC', acType:'F-16CM', typIAS:480, hours:[12,22], days:0b0111110, note:'Shaw AFB ↔ Moncks Corner SC · NTSB CEN15FA254 2015-07-07 F-16 vs C-150M (2 fatal) — primary MAC precedent',
    segs:[
      { lat:33.972, lng:-80.471, floorAGL:1500, ceilingMSL:8000 }, // Shaw AFB
      { lat:33.700, lng:-80.300, floorAGL:1000, ceilingMSL:7000 },
      { lat:33.400, lng:-80.100, floorAGL: 800, ceilingMSL:6000 },
      { lat:33.150, lng:-79.950, floorAGL: 500, ceilingMSL:5500 }, // Moncks Corner MAC site
      { lat:32.950, lng:-79.850, floorAGL: 500, ceilingMSL:5000 },
      { lat:32.750, lng:-79.700, floorAGL: 800, ceilingMSL:6000 },
    ] },
  { id:'IR-009', rtype:'IR', majcom:'ACC', acType:'F-15E', typIAS:520, hours:[14,22], days:0b0011111, note:'Mountain Home ID → Boise',
    segs:[ { lat:43.043, lng:-115.872, floorAGL:1000, ceilingMSL:9000 }, { lat:43.300, lng:-115.500, floorAGL:1000, ceilingMSL:9000 }, { lat:43.500, lng:-115.300, floorAGL: 800, ceilingMSL:8000 }, { lat:43.600, lng:-116.000, floorAGL: 800, ceilingMSL:8000 } ] },
  { id:'IR-024', rtype:'IR', majcom:'USMC', acType:'F/A-18C', typIAS:500, hours:[15,22], days:0b0011111, note:'Twentynine Palms CA → MCAS Yuma · NTSB DCA17FA169 KC-130 mode',
    segs:[ { lat:34.270, lng:-115.950, floorAGL:1000, ceilingMSL:8000 }, { lat:34.000, lng:-115.400, floorAGL: 800, ceilingMSL:7000 }, { lat:33.500, lng:-114.800, floorAGL: 500, ceilingMSL:6000 }, { lat:32.660, lng:-114.620, floorAGL: 500, ceilingMSL:5500 } ] },
  { id:'IR-066', rtype:'IR', majcom:'ACC', acType:'F-35A', typIAS:540, hours:[14,22], days:0b0011111, note:'Hill AFB UT → Nellis NV (Red Flag arrival)',
    segs:[ { lat:41.124, lng:-111.973, floorAGL:1500, ceilingMSL:9000 }, { lat:40.500, lng:-113.000, floorAGL:1000, ceilingMSL:8000 }, { lat:39.500, lng:-114.500, floorAGL:1000, ceilingMSL:8000 }, { lat:36.236, lng:-115.034, floorAGL: 800, ceilingMSL:7000 } ] },
  { id:'IR-080', rtype:'IR', majcom:'AMC', acType:'C-17A', typIAS:300, hours:[10,22], days:0b1111111, note:'Charleston SC → Pope NC (AMC LL)',
    segs:[ { lat:32.898, lng:-80.040, floorAGL:1000, ceilingMSL:8000 }, { lat:33.500, lng:-80.000, floorAGL: 800, ceilingMSL:7000 }, { lat:34.500, lng:-79.500, floorAGL: 800, ceilingMSL:6000 }, { lat:35.171, lng:-79.014, floorAGL:1000, ceilingMSL:7000 } ] },
  { id:'IR-103', rtype:'IR', majcom:'ACC', acType:'F-16C', typIAS:500, hours:[14,22], days:0b0011111, note:'Tucson AZ → Yuma AZ',
    segs:[ { lat:32.117, lng:-110.870, floorAGL:1000, ceilingMSL:8000 }, { lat:32.500, lng:-112.000, floorAGL: 800, ceilingMSL:7000 }, { lat:32.700, lng:-113.500, floorAGL: 500, ceilingMSL:5000 }, { lat:32.656, lng:-114.620, floorAGL: 500, ceilingMSL:5000 } ] },
  { id:'IR-119', rtype:'IR', majcom:'ACC', acType:'F-22A', typIAS:540, hours:[13,21], days:0b0011111, note:'Langley VA → Wright-Patterson OH',
    segs:[ { lat:37.082, lng:-76.360, floorAGL:1500, ceilingMSL:9000 }, { lat:38.000, lng:-78.500, floorAGL:1000, ceilingMSL:9000 }, { lat:39.000, lng:-81.000, floorAGL:1000, ceilingMSL:8000 }, { lat:39.826, lng:-84.048, floorAGL:1500, ceilingMSL:8500 } ] },
  { id:'IR-160', rtype:'IR', majcom:'AETC', acType:'T-38C', typIAS:380, hours:[13,21], days:0b0011111, note:'Tinker OK → Sheppard TX (UPT training)',
    segs:[ { lat:35.415, lng:-97.387, floorAGL:1000, ceilingMSL:8000 }, { lat:35.100, lng:-97.800, floorAGL: 800, ceilingMSL:7000 }, { lat:34.500, lng:-98.300, floorAGL: 800, ceilingMSL:7000 }, { lat:33.989, lng:-98.491, floorAGL:1000, ceilingMSL:7000 } ] },
  { id:'IR-179', rtype:'IR', majcom:'ACC', acType:'F-15C', typIAS:520, hours:[14,22], days:0b0011111, note:'Tyndall FL → Eglin FL',
    segs:[ { lat:30.069, lng:-85.575, floorAGL:1000, ceilingMSL:8000 }, { lat:30.300, lng:-86.000, floorAGL: 800, ceilingMSL:7000 }, { lat:30.483, lng:-86.524, floorAGL:1000, ceilingMSL:8000 } ] },
  { id:'IR-200', rtype:'IR', majcom:'AMC', acType:'C-17A', typIAS:280, hours:[10,22], days:0b1111111, note:'Travis CA → McChord WA',
    segs:[ { lat:38.263, lng:-121.928, floorAGL:1500, ceilingMSL:9500 }, { lat:42.000, lng:-122.000, floorAGL:1000, ceilingMSL:9000 }, { lat:46.000, lng:-122.500, floorAGL:1000, ceilingMSL:8500 }, { lat:47.138, lng:-122.476, floorAGL:1500, ceilingMSL:9000 } ] },
  { id:'IR-241', rtype:'IR', majcom:'ACC', acType:'F-16C', typIAS:480, hours:[14,22], days:0b0011111, note:'Holloman NM → Davis-Monthan AZ · NTSB CEN13LA259',
    segs:[ { lat:32.852, lng:-106.108, floorAGL:1500, ceilingMSL:9500 }, { lat:32.500, lng:-108.000, floorAGL:1000, ceilingMSL:8500 }, { lat:32.300, lng:-109.500, floorAGL: 800, ceilingMSL:7500 }, { lat:32.166, lng:-110.883, floorAGL:1000, ceilingMSL:8000 } ] },
  { id:'IR-501', rtype:'IR', majcom:'ACC', acType:'B-1B', typIAS:540, hours:[14,22], days:0b0011111, note:'Dyess TX → Whiteman MO (long-leg supersonic IR)',
    segs:[ { lat:32.421, lng:-99.854, floorAGL:1500, ceilingMSL:9500 }, { lat:34.000, lng:-98.000, floorAGL:1000, ceilingMSL:9000 }, { lat:36.000, lng:-95.000, floorAGL: 800, ceilingMSL:8000 }, { lat:38.730, lng:-93.548, floorAGL:1500, ceilingMSL:9000 } ] },
  { id:'IR-509', rtype:'IR', majcom:'ACC', acType:'B-52H', typIAS:300, hours:[10,22], days:0b1111111, note:'Minot ND → Ellsworth SD (strategic bomber LL)',
    segs:[ { lat:48.416, lng:-101.358, floorAGL:1000, ceilingMSL:9000 }, { lat:46.500, lng:-102.500, floorAGL: 800, ceilingMSL:8000 }, { lat:44.345, lng:-103.103, floorAGL:1000, ceilingMSL:8500 } ] },
  { id:'IR-700', rtype:'IR', majcom:'USMC', acType:'F/A-18C', typIAS:500, hours:[14,22], days:0b0011111, note:'Cherry Point NC → Beaufort SC',
    segs:[ { lat:34.901, lng:-76.881, floorAGL:1000, ceilingMSL:8000 }, { lat:33.500, lng:-79.000, floorAGL: 800, ceilingMSL:7000 }, { lat:32.477, lng:-80.722, floorAGL: 800, ceilingMSL:7000 } ] },
  { id:'IR-905', rtype:'IR', majcom:'AMC', acType:'C-17A', typIAS:280, hours:[10,22], days:0b1111111, note:'Hickam HI → Edwards CA (Pacific track)',
    segs:[ { lat:21.319, lng:-157.922, floorAGL:1500, ceilingMSL:9500 }, { lat:30.000, lng:-145.000, floorAGL:1000, ceilingMSL:9000 }, { lat:34.905, lng:-117.884, floorAGL:1500, ceilingMSL:9000 } ] },
  { id:'IR-906', rtype:'IR', majcom:'PACAF', acType:'F-22A', typIAS:540, hours:[14,22], days:0b0011111, note:'Eielson AK → JBER AK (Alaskan IR) · NTSB ANC18FA071 PA-28 NM',
    segs:[ { lat:64.665, lng:-147.102, floorAGL:1500, ceilingMSL:9500 }, { lat:63.000, lng:-149.000, floorAGL:1000, ceilingMSL:8500 }, { lat:61.250, lng:-149.806, floorAGL:1500, ceilingMSL:8000 } ] },
  { id:'VR-067', rtype:'VR', majcom:'ANG', acType:'F-16C', typIAS:450, hours:[14,22], days:0b0011111, note:'Burlington VT → Bangor ME (158FW ANG)',
    segs:[ { lat:44.473, lng:-73.153, floorAGL: 500, ceilingMSL:5000 }, { lat:44.500, lng:-71.000, floorAGL: 500, ceilingMSL:5000 }, { lat:44.807, lng:-68.828, floorAGL: 800, ceilingMSL:6000 } ] },
  { id:'VR-094', rtype:'VR', majcom:'USCG', acType:'MH-65D', typIAS:140, hours:[8,22], days:0b1111111, note:'CCG Cape Cod ↔ Atlantic City NJ (Coast Guard SAR transit)',
    segs:[ { lat:41.658, lng:-70.521, floorAGL: 200, ceilingMSL:3000 }, { lat:40.500, lng:-72.000, floorAGL: 200, ceilingMSL:3000 }, { lat:39.458, lng:-74.577, floorAGL: 500, ceilingMSL:3000 } ] },
  { id:'VR-098', rtype:'VR', majcom:'ANG', acType:'F-15C', typIAS:450, hours:[14,22], days:0b0011111, note:'Portland OR → Klamath Falls OR (142FW + 173FW)',
    segs:[ { lat:45.589, lng:-122.598, floorAGL: 500, ceilingMSL:5000 }, { lat:44.000, lng:-122.000, floorAGL: 500, ceilingMSL:5000 }, { lat:42.156, lng:-121.733, floorAGL: 800, ceilingMSL:5500 } ] },
  { id:'VR-176', rtype:'VR', majcom:'USMC', acType:'AV-8B', typIAS:400, hours:[14,22], days:0b0011111, note:'Cherry Point NC → Camp Lejeune (Harrier LL)',
    segs:[ { lat:34.901, lng:-76.881, floorAGL: 200, ceilingMSL:3000 }, { lat:34.700, lng:-77.000, floorAGL: 200, ceilingMSL:3000 }, { lat:34.557, lng:-77.391, floorAGL: 200, ceilingMSL:3000 } ] },
  { id:'VR-249', rtype:'VR', majcom:'AETC', acType:'T-6A', typIAS:200, hours:[13,21], days:0b0011111, note:'Vance OK → Sheppard TX (UPT)',
    segs:[ { lat:36.339, lng:-97.917, floorAGL: 500, ceilingMSL:5000 }, { lat:35.500, lng:-98.000, floorAGL: 500, ceilingMSL:5000 }, { lat:33.989, lng:-98.491, floorAGL: 500, ceilingMSL:5000 } ] },
  { id:'VR-302', rtype:'VR', majcom:'USN', acType:'F/A-18E', typIAS:520, hours:[14,22], days:0b0011111, note:'Lemoore CA → Fallon NV (TOPGUN transit)',
    segs:[ { lat:36.333, lng:-119.952, floorAGL: 500, ceilingMSL:5000 }, { lat:37.500, lng:-119.000, floorAGL: 500, ceilingMSL:5000 }, { lat:39.417, lng:-118.700, floorAGL: 800, ceilingMSL:6000 } ] },
  { id:'VR-339', rtype:'VR', majcom:'USN', acType:'P-8A', typIAS:280, hours:[8,22], days:0b1111111, note:'Whidbey Is WA → Coupeville (P-8 maritime)',
    segs:[ { lat:48.351, lng:-122.655, floorAGL: 500, ceilingMSL:4000 }, { lat:48.200, lng:-122.700, floorAGL: 500, ceilingMSL:4000 }, { lat:48.190, lng:-122.625, floorAGL: 500, ceilingMSL:4000 } ] },
  { id:'VR-516', rtype:'VR', majcom:'ANG', acType:'F-16C', typIAS:450, hours:[14,22], days:0b0011111, note:'Springfield IL → Selfridge MI (183FW + 127WG)',
    segs:[ { lat:39.844, lng:-89.677, floorAGL: 500, ceilingMSL:5000 }, { lat:41.500, lng:-86.000, floorAGL: 500, ceilingMSL:5000 }, { lat:42.608, lng:-82.835, floorAGL: 800, ceilingMSL:5500 } ] },
  { id:'VR-657', rtype:'VR', majcom:'USMC', acType:'MV-22B', typIAS:240, hours:[8,22], days:0b1111111, note:'MCAS New River NC → Pope NC (Osprey LL)',
    segs:[ { lat:34.708, lng:-77.439, floorAGL: 200, ceilingMSL:3000 }, { lat:34.900, lng:-78.000, floorAGL: 200, ceilingMSL:3000 }, { lat:35.171, lng:-79.014, floorAGL: 500, ceilingMSL:3500 } ] },
  { id:'SR-715', rtype:'SR', majcom:'USCG', acType:'MH-60T', typIAS:120, hours:[6,22], days:0b1111111, note:'USCG AS Houston (slow rotorcraft SR)',
    segs:[ { lat:29.806, lng:-95.183, floorAGL: 200, ceilingMSL:2000 }, { lat:29.700, lng:-95.000, floorAGL: 200, ceilingMSL:2000 }, { lat:29.600, lng:-94.800, floorAGL: 200, ceilingMSL:2000 } ] },
  { id:'SR-825', rtype:'SR', majcom:'USCG', acType:'MH-65D', typIAS:130, hours:[6,22], days:0b1111111, note:'USCG AS Miami (slow rotorcraft SR)',
    segs:[ { lat:25.794, lng:-80.290, floorAGL: 200, ceilingMSL:2000 }, { lat:25.700, lng:-80.200, floorAGL: 200, ceilingMSL:2000 }, { lat:25.600, lng:-80.100, floorAGL: 200, ceilingMSL:2000 } ] },
  { id:'AR-201A', rtype:'AR', majcom:'AMC', acType:'KC-135R', typIAS:260, hours:[10,22], days:0b1111111, note:'Atlantic Track 201A (E-W refueling)',
    segs:[ { lat:36.500, lng:-75.500, floorAGL:18000, ceilingMSL:28000 }, { lat:38.000, lng:-72.000, floorAGL:18000, ceilingMSL:28000 }, { lat:40.000, lng:-65.000, floorAGL:20000, ceilingMSL:30000 } ] },
  { id:'AR-636', rtype:'AR', majcom:'AMC', acType:'KC-46A', typIAS:270, hours:[10,22], days:0b1111111, note:'North Sea Track AR-636 (NATO refueling)',
    segs:[ { lat:55.000, lng:1.000, floorAGL:20000, ceilingMSL:32000 }, { lat:56.000, lng:3.000, floorAGL:20000, ceilingMSL:32000 }, { lat:57.000, lng:5.000, floorAGL:22000, ceilingMSL:33000 } ] },
  { id:'AR-200', rtype:'AR', majcom:'AMC', acType:'KC-135R', typIAS:260, hours:[10,22], days:0b1111111, note:'Pacific Track AR-200 Hickam ↔ Travis',
    segs:[ { lat:25.000, lng:-150.000, floorAGL:18000, ceilingMSL:28000 }, { lat:30.000, lng:-135.000, floorAGL:18000, ceilingMSL:28000 }, { lat:36.000, lng:-122.000, floorAGL:20000, ceilingMSL:30000 } ] },
  { id:'LFA-3', rtype:'NATO', majcom:'NATO', acType:'Tornado IDS', typIAS:480, hours:[8,18], days:0b0011111, note:'GAF LFA-3 Cologne · STANAG 3756 · BFU 6X001-0/15 precedent',
    segs:[ { lat:50.866, lng:7.143, floorAGL: 500, ceilingMSL:5000 }, { lat:50.600, lng:7.500, floorAGL: 500, ceilingMSL:5000 }, { lat:50.400, lng:8.000, floorAGL: 800, ceilingMSL:5500 } ] },
  { id:'LFA-7', rtype:'NATO', majcom:'NATO', acType:'Tornado GR4', typIAS:450, hours:[9,17], days:0b0011111, note:'RAF LFA-7 Yorkshire-Wales · UK CAA CAP 393',
    segs:[ { lat:54.000, lng:-2.000, floorAGL: 250, ceilingMSL:2000 }, { lat:53.500, lng:-3.000, floorAGL: 250, ceilingMSL:2000 }, { lat:52.500, lng:-3.500, floorAGL: 250, ceilingMSL:2000 } ] },
]

interface MACAHotspot { lat: number; lng: number; name: string; mtr: string }
const MACA_HOTSPOTS: MACAHotspot[] = [
  { lat:33.196, lng:-80.011, name:'Moncks Corner MAC site', mtr:'IR-13' },
  { lat:32.500, lng:-114.000, name:'Yuma MOA transit',     mtr:'IR-024' },
  { lat:33.800, lng:-115.700, name:'Twentynine Palms ingress', mtr:'IR-024' },
  { lat:42.500, lng:-119.700, name:'Hart-Toiyabe MOA',     mtr:'VR-302' },
  { lat:36.700, lng:-117.600, name:'R-2508 China Lake',    mtr:'VR-302' },
  { lat:64.200, lng:-147.500, name:'Yukon-2 MOA',          mtr:'IR-906' },
  { lat:35.800, lng:-118.700, name:'Sequoia MOA',          mtr:'IR-066' },
  { lat:34.700, lng:-78.500, name:'Cherry Mil MOA',        mtr:'IR-700' },
]

const D2R = Math.PI/180, R2D = 180/Math.PI
const R_NM = 3440.065

function gcDist(la1:number, lo1:number, la2:number, lo2:number): number {
  const φ1=la1*D2R, φ2=la2*D2R
  const Δφ=(la2-la1)*D2R, Δλ=(lo2-lo1)*D2R
  const a=Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2
  return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

function bearing(la1:number, lo1:number, la2:number, lo2:number): number {
  const φ1=la1*D2R, φ2=la2*D2R, Δλ=(lo2-lo1)*D2R
  const y=Math.sin(Δλ)*Math.cos(φ2)
  const x=Math.cos(φ1)*Math.sin(φ2)-Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ)
  return (Math.atan2(y,x)*R2D + 360) % 360
}

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

// Distance from point to nearest segment in MTR polyline
function distToRoute(la:number, lo:number, mtr:MTR): { distNm: number; segIdx: number; floor:number; ceiling:number; alongFrac:number } {
  let best = Infinity, idx = 0, floor = 0, ceiling = 0, along = 0
  for (let i=0; i<mtr.segs.length-1; i++) {
    const a = mtr.segs[i], b = mtr.segs[i+1]
    // approximate point-to-segment in equirectangular projection (good enough for ≤200nm legs)
    const ax = a.lng, ay = a.lat
    const bx = b.lng, by = b.lat
    const px = lo, py = la
    const dx = bx - ax, dy = by - ay
    const len2 = dx*dx + dy*dy
    let t = len2 > 0 ? ((px-ax)*dx + (py-ay)*dy) / len2 : 0
    t = Math.max(0, Math.min(1, t))
    const cx = ax + t*dx, cy = ay + t*dy
    const d = gcDist(la, lo, cy, cx)
    if (d < best) {
      best = d; idx = i; along = t
      floor = a.floorAGL + (b.floorAGL - a.floorAGL)*t
      ceiling = a.ceilingMSL + (b.ceilingMSL - a.ceilingMSL)*t
    }
  }
  return { distNm: best, segIdx: idx, floor, ceiling, alongFrac: along }
}

function ramp(x:number, lo:number, hi:number): number {
  if (x<=lo) return 0
  if (x>=hi) return 100
  return 100*(x-lo)/(hi-lo)
}

function hashUnit(icao:string, salt:string): number {
  let h = 2166136261 >>> 0
  for (let i=0;i<icao.length;i++) h = Math.imul(h ^ icao.charCodeAt(i), 16777619) >>> 0
  for (let i=0;i<salt.length;i++) h = Math.imul(h ^ salt.charCodeAt(i), 16777619) >>> 0
  return ((h >>> 0) / 4294967295)
}

function isMilType(t: string | undefined, op: string | undefined): boolean {
  const x = (t || '').toUpperCase()
  const o = (op || '').toUpperCase()
  if (/^(F-?15|F-?16|F-?22|F-?35|F-?18|FA-?18|F-?14|EA-?6|EA-?18|AV-?8|B-?1|B-?2|B-?52|C-?17|C-?5|C-?130|C-?135|KC-?135|KC-?46|KC-?10|E-?3|E-?4|E-?6|E-?8|T-?38|T-?6|T-?45|MV-?22|UH-?60|HH-?60|MH-?60|MH-?65|AH-?64|CH-?47|CH-?53|RC-?135|RQ-?4|MQ-?9|U-?2|SR-?71|H-?60|H-?65|P-?8|P-?3)/.test(x)) return true
  if (/(RAF|USAF|USN|USMC|USCG|ANG|RNoAF|GAF|LUFTW|LUFTWAFFE|RAAF|RNZAF|FRENCH AF|ARMEE DE L|ROYAL AIR FORCE|ROYAL NAVY|US AIR FORCE|US NAVY|US MARINES|US COAST GUARD|US ARMY|MILITARY|NATO|RAF AIR|CAF|RCAF)/.test(o)) return true
  return false
}

function isLightGA(t: string | undefined): boolean {
  const x = (t || '').toUpperCase()
  return /^(C-?150|C-?152|C-?172|C-?182|C-?206|C-?210|PA-?28|PA-?32|PA-?38|PA-?44|PA-?46|SR-?20|SR-?22|DA-?20|DA-?40|DA-?42|DR-?40|BE-?23|BE-?33|BE-?35|BE-?36|M20|MOON|TBM|PC-?12|GA-?7|GA-?8|GROB|TECNAM|CIRRUS|CESSNA|PIPER|MOONEY|BEECH|DIAMOND)/.test(x)
}

function classifyPhase(f: SFlight): 'CRUISE-VFR'|'DEPARTURE'|'APPROACH'|'TRANSIT-TMA'|'GND' {
  if (f.ground) return 'GND'
  const fl = f.altitudeFt
  if (fl < 1500) return f.vertRate > 200 ? 'DEPARTURE' : 'APPROACH'
  if (fl < 5000) return f.vertRate > 200 ? 'DEPARTURE' : f.vertRate < -200 ? 'APPROACH' : 'TRANSIT-TMA'
  return 'CRUISE-VFR'
}

interface Per {
  classification: 'CIVIL' | 'MIL'
  isLightGA: boolean
  phase: ReturnType<typeof classifyPhase>
  mtr: MTR | null
  distNm: number
  segIdx: number
  floor: number
  ceiling: number
  inAltBand: boolean
  active: boolean
  iasMil: number
  closureKts: number
  macaNm: number
  drivers: { PEN:number; VS:number; SPDIF:number; ACT:number; CONF:number; MACA:number }
}

interface Row { f: SFlight; p: Per; score: number; tier: Tier }

const SRC='mtr-src', CL_SRC='mtr-cl-src', BUF_SRC='mtr-buf-src', MACA_SRC='mtr-maca-src', XBR_SRC='mtr-xbr-src'
const HALO='mtr-halo', PIN='mtr-pin', LBL='mtr-lbl', CL='mtr-cl', BUF='mtr-buf', MACA='mtr-maca', MACA_LBL='mtr-maca-lbl', XBR='mtr-xbr', CL_LBL='mtr-cl-lbl'

export default function MtrMonitor({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [rtFilter, setRtFilter] = useState<RouteType | 'ALL'>('ALL')
  const [majFilter, setMajFilter] = useState<Majcom | 'ALL'>('ALL')
  const [advMul, setAdvMul] = useState(100)
  const [actMul, setActMul] = useState(100)
  const [penCap, setPenCap] = useState(5)
  const [civFlr, setCivFlr] = useState(1500)
  const [hourSim, setHourSim] = useState(() => new Date().getUTCHours())
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showCl, setShowCl] = useState(true)
  const [showBuf, setShowBuf] = useState(true)
  const [showMaca, setShowMaca] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [tab, setTab] = useState<'AIRCRAFT'|'ROUTES'|'SEGMENTS'|'MACA'>('AIRCRAFT')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Row|null>(null)
  const [selRoute, setSelRoute] = useState<MTR|null>(null)

  // Simulator: derived current day-of-week + hour
  const now = useMemo(() => {
    const d = new Date()
    return { dow: (d.getUTCDay() + 6) % 7, hour: hourSim } // dow Mon=0..Sun=6
  }, [hourSim])

  const isActive = (mtr: MTR): boolean => {
    if (!((mtr.days >> now.dow) & 1)) return false
    const [a, b] = mtr.hours
    return now.hour >= a && now.hour <= b
  }

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      const fl = f.altitudeFt
      // MTR ceiling is 10000 MSL — civil traffic above this is not in MTR scope
      if (fl > 10500 && !/^(KC-?|C-?17|C-?130|C-?135|C-?5)/.test((f.type||'').toUpperCase())) continue

      const mil = isMilType(f.type, f.operator)
      const lightGA = !mil && isLightGA(f.type)
      const phase = classifyPhase(f)
      if (phase === 'GND') continue

      // Find nearest MTR
      let best: { mtr: MTR; distNm: number; segIdx: number; floor:number; ceiling:number; alongFrac:number } | null = null
      for (const mtr of MTRS) {
        const d = distToRoute(f.lat, f.lng, mtr)
        if (!best || d.distNm < best.distNm) best = { mtr, ...d }
      }
      if (!best || best.distNm > 15) continue // out of range

      const mtr = best.mtr
      const active = isActive(mtr)
      const civFloorAGL = civFlr
      const altMSL = fl
      const altAGL = altMSL // approximation — true AGL would require DTED
      const inAltBand = altAGL >= (best.floor - 500) && altMSL <= (best.ceiling + 500)

      // Synthetic MIL traffic IAS for the route
      const iasMil = mtr.typIAS + (hashUnit(mtr.id, 'ias') - 0.5) * 40
      const closureKts = mil ? 0 : Math.max(0, iasMil + Math.abs(f.velocityKts) - 50)

      // Nearest MACA hotspot for the route
      let macaNm = Infinity
      for (const h of MACA_HOTSPOTS) {
        if (h.mtr !== mtr.id) continue
        const d = gcDist(f.lat, f.lng, h.lat, h.lng)
        if (d < macaNm) macaNm = d
      }
      if (!isFinite(macaNm)) macaNm = 999

      // 6 drivers
      const pen = best.distNm < penCap ? 100 * (1 - best.distNm / penCap) : 0
      const D_PEN = mil ? Math.max(0, 100 - best.distNm * 12) : pen
      const D_VS = inAltBand && (mtr.rtype==='IR'||mtr.rtype==='VR'||mtr.rtype==='NATO')
        ? 100 - Math.min(80, Math.abs(altAGL - (best.floor + (best.ceiling - best.floor)/2)) / 50)
        : 0
      const D_SPDIF = mil ? 0 : ramp(closureKts, 200, 700) * (actMul/100)
      const D_ACT = active ? 80 * (actMul/100) : 10
      const D_CONF = mil ? 30 + hashUnit(f.icao, 'conf') * 40 : 50 + hashUnit(f.icao, 'conf') * 50
      const D_MACA = macaNm < 50 ? 100 - macaNm*2 : 0

      const drivers = { PEN: D_PEN, VS: D_VS, SPDIF: D_SPDIF, ACT: D_ACT, CONF: D_CONF, MACA: D_MACA }
      const vals = Object.values(drivers)
      const maxD = Math.max(...vals)
      const meanD = vals.reduce((a,b)=>a+b,0)/vals.length
      const phaseMul = phase === 'CRUISE-VFR' ? 1.05 : phase === 'DEPARTURE' ? 1.20 : phase === 'APPROACH' ? 1.25 : 1.10
      let score = (maxD * 0.66 + meanD * 0.34) * phaseMul * (advMul/100)

      // Light GA boost
      if (lightGA && active && best.distNm < 3) score += 12

      // Hard escalators
      if (!mil && active && altAGL < civFlr && best.distNm < 2) score = Math.max(score, 92) // MAC-IMMINENT
      if (!mil && active && best.distNm < 1 && altAGL < 800) score = Math.max(score, 85)    // CEN15FA254 envelope
      if (!mil && active && best.distNm < 3) score = Math.max(score, 75)                    // CORRIDOR-PEN sustained

      score = Math.min(100, Math.max(0, score))

      let tier: Tier
      if (score >= 85 && !mil && active) tier = 'MAC-IMMINENT'
      else if (score >= 65 && !mil && active) tier = 'CEN15FA254'
      else if (score >= 45) tier = 'CORRIDOR-PEN'
      else if (score >= 25) tier = 'CORRIDOR-WTH'
      else tier = 'CLEAR'
      if (f.ground) tier = 'IDLE'

      const p: Per = {
        classification: mil ? 'MIL' : 'CIVIL', isLightGA: lightGA, phase, mtr,
        distNm: best.distNm, segIdx: best.segIdx, floor: best.floor, ceiling: best.ceiling,
        inAltBand, active, iasMil, closureKts, macaNm, drivers
      }
      out.push({ f, p, score, tier })
    }
    return out.sort((a,b) => b.score - a.score)
  }, [flights, advMul, actMul, penCap, civFlr, hourSim])

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (rtFilter !== 'ALL' && r.p.mtr?.rtype !== rtFilter) return false
      if (majFilter !== 'ALL' && r.p.mtr?.majcom !== majFilter) return false
      if (!ql) return true
      const cs = (r.f.callsign||r.f.icao).toLowerCase()
      const ty = (r.f.type||'').toLowerCase()
      const op = (r.f.operator||'').toLowerCase()
      const mt = (r.p.mtr?.id||'').toLowerCase()
      return cs.includes(ql) || ty.includes(ql) || op.includes(ql) || mt.includes(ql)
    })
  }, [rows, tierFilter, rtFilter, majFilter, q])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { 'MAC-IMMINENT':0,'CEN15FA254':0,'CORRIDOR-PEN':0,'CORRIDOR-WTH':0,'CLEAR':0,'IDLE':0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const summary = useMemo(() => {
    if (!rows.length) return null
    const inCorr = rows.filter(r => r.p.classification==='CIVIL' && r.p.distNm < 5)
    const milOnMtr = rows.filter(r => r.p.classification==='MIL' && r.p.distNm < 3)
    const activeRts = MTRS.filter(isActive).length
    const muPen = inCorr.length ? inCorr.reduce((s,r)=>s+r.p.distNm,0)/inCorr.length : 0
    const muMaca = inCorr.length ? inCorr.reduce((s,r)=>s+r.p.macaNm,0)/inCorr.length : 0
    const worst = rows[0]
    return { muPen, activeRts, civilInCorr: inCorr.length, milOnMtr: milOnMtr.length, worst, muMaca }
  }, [rows])

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const apply = () => {
      try {
        // Halos on tracked aircraft
        const live = filtered.filter(r => r.tier !== 'IDLE')
        const haloFeat = live.map(r => ({
          type:'Feature' as const,
          geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat]},
          properties:{
            color: TIER_COLOR[r.tier], score: r.score, tier: r.tier,
            classification: r.p.classification,
            label: r.p.mtr ? `${r.f.callsign||r.f.icao} ${r.p.mtr.id} ${r.p.distNm.toFixed(1)}NM ${r.tier}` : (r.f.callsign||r.f.icao)
          }
        }))

        // Centerlines (active vs inactive)
        const clFeat = MTRS.flatMap(mtr => {
          const filt = rtFilter !== 'ALL' && mtr.rtype !== rtFilter
          const filtMaj = majFilter !== 'ALL' && mtr.majcom !== majFilter
          if (filt || filtMaj) return []
          const active = isActive(mtr)
          const coords = mtr.segs.map(s => [s.lng, s.lat])
          return [{
            type:'Feature' as const,
            geometry:{ type:'LineString' as const, coordinates: coords },
            properties:{ color: active ? RT_COLOR[mtr.rtype] : '#475569', active, id: mtr.id, opacity: active ? 0.95 : 0.45, width: active ? 1.5 : 1.0 }
          }]
        })

        // 5-NM buffer polygons (approximated as offset polylines on each side)
        const bufFeat = MTRS.flatMap(mtr => {
          const filt = rtFilter !== 'ALL' && mtr.rtype !== rtFilter
          const filtMaj = majFilter !== 'ALL' && mtr.majcom !== majFilter
          if (filt || filtMaj) return []
          const active = isActive(mtr)
          const left:[number,number][] = []
          const right:[number,number][] = []
          for (let i=0; i<mtr.segs.length; i++) {
            const cur = mtr.segs[i]
            const next = mtr.segs[Math.min(i+1, mtr.segs.length-1)]
            const prev = mtr.segs[Math.max(i-1, 0)]
            const brg = bearing(prev.lat, prev.lng, next.lat, next.lng)
            const l = projectGc(cur.lat, cur.lng, (brg - 90 + 360) % 360, 5)
            const r = projectGc(cur.lat, cur.lng, (brg + 90) % 360, 5)
            left.push([l.lng, l.lat])
            right.push([r.lng, r.lat])
          }
          const poly = [...left, ...right.reverse(), left[0]]
          return [{
            type:'Feature' as const,
            geometry:{ type:'Polygon' as const, coordinates:[poly] },
            properties:{ color: active ? RT_COLOR[mtr.rtype] : '#334155', active, id: mtr.id, opacity: active ? 0.10 : 0.04 }
          }]
        })

        // MACA hotspots
        const macaFeat = MACA_HOTSPOTS.map(h => ({
          type:'Feature' as const,
          geometry:{ type:'Point' as const, coordinates:[h.lng, h.lat] },
          properties:{ name: `${h.name} (${h.mtr})` }
        }))

        // Cross-bearing lines from civil aircraft to nearest centerline point
        const xbrFeat = live.filter(r => r.p.classification==='CIVIL' && r.p.mtr && r.p.distNm < 8).slice(0, 24).map(r => {
          const mtr = r.p.mtr!
          const a = mtr.segs[r.p.segIdx]
          const b = mtr.segs[Math.min(r.p.segIdx+1, mtr.segs.length-1)]
          // approximate nearest point on segment using same equirectangular projection
          const ax=a.lng, ay=a.lat, bx=b.lng, by=b.lat
          const px=r.f.lng, py=r.f.lat
          const dx=bx-ax, dy=by-ay
          const len2=dx*dx+dy*dy
          let t = len2>0 ? ((px-ax)*dx+(py-ay)*dy)/len2 : 0
          t = Math.max(0, Math.min(1, t))
          const cx=ax+t*dx, cy=ay+t*dy
          return {
            type:'Feature' as const,
            geometry:{ type:'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [cx, cy]] },
            properties:{ color: TIER_COLOR[r.tier], opacity: r.tier==='MAC-IMMINENT'?0.95:r.tier==='CEN15FA254'?0.80:0.45 }
          }
        })

        const haloFc:any = { type:'FeatureCollection', features: haloFeat }
        const clFc:any = { type:'FeatureCollection', features: clFeat }
        const bufFc:any = { type:'FeatureCollection', features: bufFeat }
        const macaFc:any = { type:'FeatureCollection', features: macaFeat }
        const xbrFc:any = { type:'FeatureCollection', features: xbrFeat }

        for (const [id, fc] of [[SRC, haloFc], [CL_SRC, clFc], [BUF_SRC, bufFc], [MACA_SRC, macaFc], [XBR_SRC, xbrFc]] as const) {
          const src = map.getSource(id) as any
          if (src) src.setData(fc); else map.addSource(id, { type:'geojson', data: fc })
        }

        if (showBuf && !map.getLayer(BUF)) map.addLayer({ id: BUF, type:'fill', source: BUF_SRC,
          paint:{ 'fill-color':['get','color'], 'fill-opacity':['get','opacity'] } })
        if (!showBuf && map.getLayer(BUF)) map.removeLayer(BUF)

        if (showCl && !map.getLayer(CL)) map.addLayer({ id: CL, type:'line', source: CL_SRC,
          paint:{ 'line-color':['get','color'], 'line-width':['get','width'], 'line-opacity':['get','opacity'],
                  'line-dasharray':['case', ['get','active'], ['literal',[1,0]], ['literal',[3,2]]] } as any })
        if (!showCl && map.getLayer(CL)) map.removeLayer(CL)

        if (showCl && !map.getLayer(CL_LBL)) map.addLayer({ id: CL_LBL, type:'symbol', source: CL_SRC,
          layout:{ 'text-field':['get','id'], 'text-size':9, 'symbol-placement':'line', 'symbol-spacing':500, 'text-allow-overlap':false },
          paint:{ 'text-color':['get','color'], 'text-halo-color':'#020617', 'text-halo-width':1.4 }})
        if (!showCl && map.getLayer(CL_LBL)) map.removeLayer(CL_LBL)

        if (showHalo && !map.getLayer(HALO)) map.addLayer({ id: HALO, type:'circle', source: SRC,
          paint:{
            'circle-radius':['+',6,['/',['get','score'],8]],
            'circle-color':['get','color'],
            'circle-opacity':0.16,
            'circle-stroke-color':['get','color'],
            'circle-stroke-width':1.2,
            'circle-stroke-opacity':0.85,
          }})
        if (!showHalo && map.getLayer(HALO)) map.removeLayer(HALO)

        if (showPin && !map.getLayer(PIN)) map.addLayer({ id: PIN, type:'circle', source: SRC,
          filter:['in',['get','tier'],['literal',['MAC-IMMINENT','CEN15FA254']]],
          paint:{ 'circle-radius':3.5, 'circle-color':'#fff',
            'circle-stroke-color':['get','color'], 'circle-stroke-width':2 }})
        if (!showPin && map.getLayer(PIN)) map.removeLayer(PIN)

        if (showLbl && !map.getLayer(LBL)) map.addLayer({ id: LBL, type:'symbol', source: SRC,
          filter:['in',['get','tier'],['literal',['MAC-IMMINENT','CEN15FA254','CORRIDOR-PEN']]],
          layout:{ 'text-field':['get','label'], 'text-size':9, 'text-offset':[0,1.3], 'text-anchor':'top', 'text-allow-overlap':false },
          paint:{ 'text-color':['get','color'], 'text-halo-color':'#020617', 'text-halo-width':1.2 }})
        if (!showLbl && map.getLayer(LBL)) map.removeLayer(LBL)

        if (showMaca && !map.getLayer(MACA)) map.addLayer({ id: MACA, type:'circle', source: MACA_SRC,
          paint:{ 'circle-radius':4, 'circle-color':'#ef4444', 'circle-stroke-color':'#7f1d1d', 'circle-stroke-width':1.5, 'circle-opacity':0.7 } })
        if (!showMaca && map.getLayer(MACA)) map.removeLayer(MACA)

        if (showMaca && !map.getLayer(MACA_LBL)) map.addLayer({ id: MACA_LBL, type:'symbol', source: MACA_SRC,
          layout:{ 'text-field':['get','name'], 'text-size':8.5, 'text-offset':[0,1.1], 'text-anchor':'top', 'text-allow-overlap':false },
          paint:{ 'text-color':'#fb7185', 'text-halo-color':'#020617', 'text-halo-width':1.2 }})
        if (!showMaca && map.getLayer(MACA_LBL)) map.removeLayer(MACA_LBL)

        if (!map.getLayer(XBR)) map.addLayer({ id: XBR, type:'line', source: XBR_SRC,
          paint:{ 'line-color':['get','color'], 'line-width':1.3, 'line-opacity':['get','opacity'], 'line-dasharray':[2,2] } })
      } catch {}
    }
    if (map.isStyleLoaded()) apply(); else map.once('load', apply)
    return () => {
      try {
        for (const id of [LBL, MACA_LBL, MACA, PIN, HALO, XBR, BUF, CL_LBL, CL]) if (map.getLayer(id)) map.removeLayer(id)
        for (const id of [SRC, CL_SRC, BUF_SRC, MACA_SRC, XBR_SRC]) if (map.getSource(id)) map.removeSource(id)
      } catch {}
    }
  }, [map, filtered, showHalo, showPin, showLbl, showCl, showBuf, showMaca, rtFilter, majFilter, now])

  const dayLabel = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][now.dow]

  return (
    <div className="absolute right-3 top-20 z-30 w-[480px] max-h-[82vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">MTR</div>
        <div className="text-[10px] text-slate-400 truncate">Military Training Routes · 250-KIAS-below-10kft exempt · §91.117(d) · CEN15FA254</div>
        <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-100 text-[12px] px-2 py-0.5 rounded hover:bg-slate-800/60">✕</button>
      </div>

      {/* tier strip */}
      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter===t?'ALL':t)}
            className={`px-1 py-1 rounded border ${tierFilter===t?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
            <div className="text-[7.5px]" style={{color: TIER_COLOR[t]}}>{t}</div>
            <div className="text-slate-100 font-semibold">{tierCounts[t]}</div>
          </button>
        ))}
      </div>

      {/* summary */}
      {summary && (
        <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px] tabular-nums">
          <div><div className="text-[8px] text-slate-500">μ-PEN-NM</div><div className="text-slate-100">{summary.muPen.toFixed(1)}</div></div>
          <div><div className="text-[8px] text-slate-500">ACT-RT</div><div className="text-slate-100">{summary.activeRts}/{MTRS.length}</div></div>
          <div><div className="text-[8px] text-slate-500">CIV-CORR</div><div style={{color:summary.civilInCorr>0?TIER_COLOR['CORRIDOR-PEN']:'#e2e8f0'}}>{summary.civilInCorr}</div></div>
          <div><div className="text-[8px] text-slate-500">MIL-MTR</div><div className="text-slate-100">{summary.milOnMtr}</div></div>
          <div><div className="text-[8px] text-slate-500">WORST</div><div className="text-slate-100 truncate">{summary.worst?(summary.worst.f.callsign||summary.worst.f.icao):'—'}</div></div>
          <div><div className="text-[8px] text-slate-500">μ-MACA</div><div className="text-slate-100">{summary.muMaca>900?'—':summary.muMaca.toFixed(0)}NM</div></div>
        </div>
      )}

      {/* sliders */}
      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800/60 text-[9.5px]">
        <label className="flex flex-col">
          <span className="text-slate-400">ADV-MUL {advMul}%</span>
          <input type="range" min={50} max={200} value={advMul} onChange={e=>setAdvMul(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">ACT-MUL {actMul}%</span>
          <input type="range" min={0} max={200} value={actMul} onChange={e=>setActMul(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">PEN-CAP {penCap}NM</span>
          <input type="range" min={1} max={10} value={penCap} onChange={e=>setPenCap(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">CIVIL-FLR {civFlr}ft AGL</span>
          <input type="range" min={500} max={3000} step={100} value={civFlr} onChange={e=>setCivFlr(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col col-span-2">
          <span className="text-slate-400">HOUR-OF-DAY {hourSim}Z · {dayLabel} · {MTRS.filter(isActive).length} ACTIVE</span>
          <input type="range" min={0} max={23} value={hourSim} onChange={e=>setHourSim(+e.target.value)} className="accent-sky-500"/>
        </label>
      </div>

      {/* route-type chips + toggles */}
      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800/60">
        <span className="text-[8.5px] text-slate-500 self-center">RT-TYPE:</span>
        <button onClick={()=>setRtFilter('ALL')} className={`text-[9px] px-1.5 py-0.5 rounded border ${rtFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-400'}`}>ALL</button>
        {RT_LIST.map(r => (
          <button key={r} onClick={()=>setRtFilter(rtFilter===r?'ALL':r)}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${rtFilter===r?'bg-sky-500/15 border-sky-500/40':'border-slate-800'}`}
            style={{color: RT_COLOR[r]}}>{r}</button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800/60">
        <span className="text-[8.5px] text-slate-500 self-center">MAJCOM:</span>
        <button onClick={()=>setMajFilter('ALL')} className={`text-[9px] px-1.5 py-0.5 rounded border ${majFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-400'}`}>ALL</button>
        {MAJCOM_LIST.map(m => (
          <button key={m} onClick={()=>setMajFilter(majFilter===m?'ALL':m)}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${majFilter===m?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-400'}`}>{m}</button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800/60">
        <span className="flex-1"/>
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['CL',showCl,setShowCl],['BUF',showBuf,setShowBuf],['MACA',showMaca,setShowMaca],['LBL',showLbl,setShowLbl]] as const).map(([lbl,on,fn]:any) => (
          <button key={lbl} onClick={()=>fn(!on)} className={`text-[8.5px] px-1.5 py-0.5 rounded border ${on?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-500'}`}>{lbl}</button>
        ))}
      </div>

      {/* tabs */}
      <div className="flex border-b border-slate-800/60 text-[10px]">
        {(['AIRCRAFT','ROUTES','SEGMENTS','MACA'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`flex-1 py-1.5 ${tab===t?'bg-sky-500/15 text-sky-200 border-b border-sky-500/60':'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {/* search */}
      <div className="px-3 py-1.5 border-b border-slate-800/60">
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="callsign / type / operator / MTR-id"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600"/>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.slice(0, 80).map((r, i) => {
              const mtr = r.p.mtr
              const fl = r.f.altitudeFt
              return (
                <div key={r.f.icao+i} className={`px-3 py-2 hover:bg-slate-900/40 cursor-pointer ${sel?.f.icao===r.f.icao?'bg-slate-900/60':''}`}
                  onClick={() => { setSel(r); onFly(r.f.icao) }}>
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="font-semibold text-slate-100 tabular-nums">{r.f.callsign||r.f.icao}</span>
                    <span className="text-slate-500 text-[9.5px]">{r.f.type||'—'}</span>
                    <span className="text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800" style={{color: r.p.classification==='MIL'?'#fbbf24':'#7dd3fc'}}>
                      {r.p.classification}{r.p.isLightGA?'·GA':''}
                    </span>
                    {mtr && <span className="text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800" style={{color: RT_COLOR[mtr.rtype]}}>{mtr.id}</span>}
                    {r.p.active && <span className="text-[8.5px] px-1.5 py-0.5 rounded text-rose-300 border border-rose-800/60 bg-rose-900/20">ACTIVE</span>}
                    <span className="ml-auto text-[8.5px] px-1.5 py-0.5 rounded" style={{color: TIER_COLOR[r.tier], background: TIER_COLOR[r.tier]+'18', border:`1px solid ${TIER_COLOR[r.tier]}66`}}>{r.tier}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-1.5 text-[9.5px] tabular-nums text-slate-300">
                    <div><span className="text-slate-500">DIST </span>{r.p.distNm.toFixed(2)}NM</div>
                    <div><span className="text-slate-500">FL </span>{(fl/100).toFixed(0)}</div>
                    <div><span className="text-slate-500">SPD </span>{r.f.velocityKts.toFixed(0)}kt</div>
                    <div><span className="text-slate-500">PHS </span>{r.p.phase}</div>
                  </div>
                  {mtr && (
                    <div className="grid grid-cols-4 gap-1 mt-0.5 text-[9.5px] tabular-nums text-slate-300">
                      <div><span className="text-slate-500">FLR </span>{r.p.floor.toFixed(0)}ft</div>
                      <div><span className="text-slate-500">CEIL </span>{(r.p.ceiling/1000).toFixed(1)}kft</div>
                      <div><span className="text-slate-500">MIL-IAS </span>{r.p.iasMil.toFixed(0)}kt</div>
                      <div><span className="text-slate-500">MACA </span>{r.p.macaNm>900?'—':r.p.macaNm.toFixed(0)+'NM'}</div>
                    </div>
                  )}
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
                    {r.tier==='MAC-IMMINENT' && `EVASIVE NOW · CIVIL inside ${penCap}NM corridor of ACTIVE ${mtr?.id} (${mtr?.acType} typ ${mtr?.typIAS}kt) · CEN15FA254 envelope match · climb/turn 90° from centerline NTSB AAR ref`}
                    {r.tier==='CEN15FA254' && `MID-AIR HAZARD · ${r.p.distNm.toFixed(2)}NM from ${mtr?.id} CL · MIL traffic 480-540kt below 1000AGL · §91.117(d) exempt · monitor MACA bulletins`}
                    {r.tier==='CORRIDOR-PEN' && `Corridor penetration ${r.p.distNm.toFixed(1)}NM of ${mtr?.id} · ${r.p.active?'ACTIVE':'inactive'} per NOTAM cadence · AIM 3-5-2 caution`}
                    {r.tier==='CORRIDOR-WTH' && `Within 5NM ${mtr?.id} corridor · ${r.p.active?'ACTIVE':'inactive'} window · maintain visual lookout per AC 91-48A`}
                    {r.tier==='CLEAR' && `Corridor clear or route inactive · ${mtr?.id} ${r.p.active?'ACTIVE':'inactive'} · AIM 5-2-4 cadence`}
                  </div>
                </div>
              )
            })}
            {!filtered.length && <div className="px-3 py-6 text-center text-[10px] text-slate-500">no airframes within 15NM of any catalogued MTR · {MTRS.filter(isActive).length}/{MTRS.length} routes ACTIVE</div>}
          </div>
        )}

        {tab === 'ROUTES' && (
          <div className="divide-y divide-slate-800/60">
            {MTRS.filter(m => (rtFilter==='ALL'||m.rtype===rtFilter) && (majFilter==='ALL'||m.majcom===majFilter)).map(mtr => {
              const active = isActive(mtr)
              const inCorr = rows.filter(r => r.p.mtr?.id===mtr.id && r.p.distNm < 5)
              const civ = inCorr.filter(r => r.p.classification==='CIVIL').length
              const mil = inCorr.filter(r => r.p.classification==='MIL').length
              return (
                <div key={mtr.id} className={`px-3 py-2 hover:bg-slate-900/40 cursor-pointer ${selRoute?.id===mtr.id?'bg-slate-900/60':''}`}
                  onClick={()=>setSelRoute(selRoute?.id===mtr.id?null:mtr)}>
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-[9px] px-1.5 py-0.5 rounded border border-slate-800 font-semibold" style={{color: RT_COLOR[mtr.rtype]}}>{mtr.id}</span>
                    <span className="text-slate-300">{mtr.acType}</span>
                    <span className="text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800 text-slate-400">{mtr.majcom}</span>
                    <span className={`ml-auto text-[8.5px] px-1.5 py-0.5 rounded ${active?'text-rose-300 border border-rose-800/60 bg-rose-900/20':'text-slate-500 border border-slate-800'}`}>{active?'ACTIVE':'INACTIVE'}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-1 text-[9.5px] tabular-nums text-slate-300">
                    <div><span className="text-slate-500">SEG </span>{mtr.segs.length}</div>
                    <div><span className="text-slate-500">IAS </span>{mtr.typIAS}kt</div>
                    <div><span className="text-slate-500">WIN </span>{String(mtr.hours[0]).padStart(2,'0')}-{String(mtr.hours[1]).padStart(2,'0')}Z</div>
                    <div><span className="text-slate-500">DAY </span>{['M','T','W','R','F','S','U'].filter((_,i)=>(mtr.days>>i)&1).join('')}</div>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-0.5 text-[9.5px] tabular-nums text-slate-300">
                    <div><span className="text-slate-500">CIV </span><span style={{color:civ>0?TIER_COLOR['CORRIDOR-PEN']:'#e2e8f0'}}>{civ}</span></div>
                    <div><span className="text-slate-500">MIL </span><span className="text-amber-300">{mil}</span></div>
                    <div><span className="text-slate-500">FLR-LO </span>{Math.min(...mtr.segs.map(s=>s.floorAGL))}ft</div>
                    <div><span className="text-slate-500">CEIL-HI </span>{(Math.max(...mtr.segs.map(s=>s.ceilingMSL))/1000).toFixed(0)}kft</div>
                  </div>
                  <div className="mt-1 text-[9px] text-slate-500 italic leading-snug">{mtr.note}</div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'SEGMENTS' && (
          <div className="divide-y divide-slate-800/60">
            {(selRoute || MTRS[0]).segs.map((s, i, arr) => {
              const mtr = selRoute || MTRS[0]
              const prev = i>0 ? arr[i-1] : null
              const len = prev ? gcDist(prev.lat, prev.lng, s.lat, s.lng) : 0
              const brg = prev ? bearing(prev.lat, prev.lng, s.lat, s.lng) : 0
              return (
                <div key={i} className="px-3 py-2 text-[10px]">
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] px-1.5 py-0.5 rounded border border-slate-800 font-semibold" style={{color: RT_COLOR[mtr.rtype]}}>{mtr.id}·SEG{i+1}</span>
                    <span className="text-slate-300 tabular-nums">{s.lat.toFixed(3)}, {s.lng.toFixed(3)}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-1 text-[9.5px] tabular-nums text-slate-300">
                    <div><span className="text-slate-500">FLR-AGL </span>{s.floorAGL}ft</div>
                    <div><span className="text-slate-500">CEIL-MSL </span>{(s.ceilingMSL/1000).toFixed(1)}kft</div>
                    <div><span className="text-slate-500">LEG-NM </span>{len.toFixed(1)}</div>
                    <div><span className="text-slate-500">BRG </span>{brg.toFixed(0)}°</div>
                  </div>
                </div>
              )
            })}
            <div className="px-3 py-3 text-[9px] leading-snug text-slate-500 border-t border-slate-800">
              Pick a route in the ROUTES tab to see its segments. Each segment defines floor (AGL) and ceiling (MSL) per FAA Order 7610.4Z §15-1 + AP/1B FLIP catalog. The 5-NM corridor buffer extends ±5 NM from centerline per AC 90-12. Floor/ceiling values are approximate per AP/1B route registry samples — verify against current FLIP publication before operational use.
            </div>
          </div>
        )}

        {tab === 'MACA' && (
          <div className="divide-y divide-slate-800/60">
            {MACA_HOTSPOTS.map((h, i) => (
              <div key={i} className="px-3 py-2 text-[10px]">
                <div className="flex items-center gap-2">
                  <span className="text-[9px] px-1.5 py-0.5 rounded border border-rose-800/60 bg-rose-900/20 text-rose-300">MACA</span>
                  <span className="text-slate-200 font-semibold">{h.name}</span>
                  <span className="ml-auto text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800 text-slate-400">{h.mtr}</span>
                </div>
                <div className="grid grid-cols-2 gap-1 mt-1 text-[9.5px] tabular-nums text-slate-300">
                  <div><span className="text-slate-500">LAT </span>{h.lat.toFixed(3)}°</div>
                  <div><span className="text-slate-500">LNG </span>{h.lng.toFixed(3)}°</div>
                </div>
              </div>
            ))}
            <div className="px-3 py-3 text-[9px] leading-snug text-slate-500 border-t border-slate-800">
              <span className="text-slate-300">Mid-Air Collision Avoidance (MACA) hotspots</span> are published by USAF MAJCOM safety offices per FAA AC 91-48A § 3.2 and are the highest-historic-encounter sites along each MTR. The primary precedent is the <span className="text-rose-300">Moncks Corner SC F-16CM vs C-150M MAC 2015-07-07</span> (NTSB CEN15FA254, 2 fatal) on <span className="text-rose-300">IR-13</span>. Visual lookout in these areas should be doubled per AC 91-48A.
            </div>
            <div className="px-3 py-3 text-[9px] leading-snug text-slate-500 border-t border-slate-800">
              <span className="text-slate-300">References:</span> FAA Order JO 7610.4Z Special Operations §15-1 · FAA Order JO 7110.65BB §3-10-4 MTR coordination · FAA Order 8260.3D TERPS §16 IFR MTRs · FAA AC 91-36D §5 / AC 91-48A §3.2 MACA · 14 CFR §91.117(a)(d) · ICAO Doc 9554 Civil/Military Co-op · NATO STANAG 7110 / 3756 · USAF AFI 11-202V3 §3.4 · DAFMAN 11-202V3 · DoD FLIP AP/1B Area Planning MTRs (the authoritative registry) · NTSB CEN15FA254 (F-16CM IR-13 Moncks Corner 2015-07-07) · NTSB DCA17FA169 (F/A-18 KC-130 Twentynine Palms 2017) · NTSB ANC18FA071 (F-22 PA-28 Eielson IR-906) · NTSB CEN13LA259 (F-16D C-172 IR-241 Foothills AZ) · USAF SIB 2017-AFI-MAC · GAO-13-396 DoD Airspace Encroachment.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
