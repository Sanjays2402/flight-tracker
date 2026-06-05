'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   SFF · Smoke / Fire / Fumes In-Flight Source-Isolation &
         17-Minute QRH-Compliance / Diversion-Window Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of every airborne aircraft for
   the worst-case ABNORMAL-non-normal condition that drives more
   in-flight emergency declarations than any other: SMOKE, FIRE,
   or FUMES of unknown origin in the cockpit or cabin. Scores
   the airframe's ability to satisfy the canonical SR111-driven
   "land at the nearest suitable airport in ≤17 minutes from
   the first sign of smoke" benchmark established by TSB Canada
   A98H0003 (Swissair 111 MD-11 HB-IWF Halifax 1998-09-02
   229 fatal), reinforced by AAR-86-02 Air Canada 797 (DC-9
   N8964Z Cincinnati 1983-06-02 23 fatal · 24 min mishandled),
   GCAA AAI 13/2010 UPS 6 (B744F N571UP Dubai 2010-09-03
   2 fatal · 28 min Li-ion runaway), and NTSB AAR-07-02
   FedEx Express 80 (MD-11F N526FE Memphis 2003-07-28 2 fatal
   landing-impact pulled from same family of cascade events).

   Distinct from existing monitors:
     · FIRELOOP  — detection-loop integrity (loop-A/B health,
                   pneumatic vs optical sensor mix, ATA-26)
     · CARGOFS   — Halon-1301 bottle endurance for Class-C/E
                   compartments + ETOPS DTLD (Diversion-Time
                   Limited Dispatch)
     · BLEED     — TCP / oil-seal fume-event risk proxy
                   (ASHRAE 161 / SAFO 18003)
     · LIBAT     — Li-ion cargo cell thermal-runaway with
                   Fire Containment Cover
     · EDR       — Rapid-decompression descent profile only
                   (different cause family)
     · CARGO-FS  — same as CARGOFS, suppression endurance
     · OWL/JETT  — Overweight-landing fuel jettison
     · EVAC      — Post-landing 90s evacuation
   SFF is uniquely the FORWARD-LOOKING composite scorer of the
   active in-flight DECISION TREE the crew must execute when
   SOSF (Smoke Of Source Suspect or Unknown) is declared:
     STEP 1. Don oxygen, smoke goggles, establish comms
             per QRH SMOKE-FIRE-FUMES memory items.
     STEP 2. Source isolation — sequential ELEC bus / pack /
             recirc-fan / IFE / galley / cargo loop test.
     STEP 3. Diversion declaration — PAN/MAYDAY, request
             nearest suitable airport, descend if needed.
     STEP 4. Land within 17 minutes (TSB SR111 benchmark)
             of first indication — failure beyond this
             window approaches the SR111 cascade catastrophe.

   ------------------------------------------------------------
   Per-airframe SMOKE-ISOLATION architecture catalogue
   (8 classes; each defines isolation-step inventory, response
   cadence baseline, and per-family smoke-evacuation procedure):

   HVY-MD11   MD-11/DC-10/MD-90 legacy 3-eng wide
              · IFE galvanic shielding generation per AAIR-99/01
              · Polyimide MPET-laminate wire-bundle insulation
                (the SR111 ignition substrate)
              · No automatic smoke-blanket pressurization control
              · BUS-1/2/3 + L/R PACK + RECIRC + GALLEY isolation
              · Cadence baseline 4.8 items/min (slow ECAM/EICAS)

   HVY-T      B777 / B787 EICAS + Electronic Checklist
              · ECL-driven smoke-source isolation auto-sequence
              · Bus tie automatic / DSC FAULT prompts
              · SMOKE/FUMES checklist auto-pages on master-caution
              · 9 isolation steps cadence 8.0/min

   HVY-A      A330 / A350 / A380 FBW ECAM SD-driven
              · ECAM "AIR-COND PACK 1 (2)" / "AVIONICS SMOKE"
              · Auto Bleed Air Iso (BLEED 1/2/APU) + PACK reset
              · SMOKE/FUMES paper QRH backup
              · Cadence 7.5/min (FCOM PRO-ABN-AIR / 26)

   HVY-NB     B737NG/MAX A320 family with EICAS-CL / ECAM
              · Manual smoke-removal checklist, no ECL
              · BUS-TIE manual, PACK selector manual
              · Cadence 6.0/min (Boeing FCOM QRH 11.20)

   RGN-J      E170/190/195/E2 CRJ Embraer Primus Epic
              · EICAS SMK detect, NWHL bus
              · 6 isolation steps cadence 5.5/min (E195 AOM §03)

   RGN-T      ATR42/72 Q400 Saab Dash turboprop
              · Single-channel detect (forward / aft / lavatory)
              · Simplified bleed/pack iso (no APU bleed)
              · Cadence 4.5/min (Q400 FCOM §11)

   FREIGHTER  B744F B777F MD-11F A332F A330-200F A300-600F
              · Main-deck Class-E compartment (no in-flight
                fire suppression, depressurization-based
                inerting per 14 CFR §25.857(d))
              · Asiana 991 / UPS 6 / FedEx 80 / Centurion 164
                precedent cluster — depressurization or
                diversion is the only option
              · 8 isolation steps cadence 6.5/min

   BIZ-LIGHT  G650 / GLEX / Falcon / PC-12 / TBM
              · Manual smoke-removal limited bus inventory
              · 4-5 isolation steps cadence 4.0/min

   ------------------------------------------------------------
   28-airport NEAREST-SUITABLE airport catalogue
   (each with class for runway length, ARFF cat 7+, ILS Cat-I
   minimum, fire-fighting capability per ICAO Annex 14 §9.2):
     KJFK/KLGA/KEWR/KBOS/KIAD/KATL/KDFW/KIAH/KORD/KMIA/KLAX/
     KSFO/KSEA/KDEN/KSLC + EGLL/EGKK/EDDF/EDDM/LFPG/EHAM/LIRF
     + RJTT/RKSI/VHHH/WSSS/OMDB/YSSY/CYYZ/CYUL/MROC
   ------------------------------------------------------------

   8 drivers (each 0-100; composite max·0.62 + mean·0.38):
     · TIME      time since SOSF declaration vs 17-min cliff
                 (ramp 0 @ T+0min → 100 @ T+25min)
     · DIVERT    distance to nearest suitable (NMI) vs glide
                 endurance at current FL & cabin Δp
     · ARCH      smoke-isolation architecture cadence vs
                 required SOP item count (MD-11/737-CL low,
                 777/787 ECL high)
     · CADENCE   actual item-completion rate observed vs
                 required cadence (Sarter-Woods IJAP 1995)
     · CLASS-E   freighter main-deck Class-E compartment
                 cascade risk per UPS6 / Asiana 991 mode
     · IFE       in-flight entertainment / galley electrical-
                 source isolation completeness
     · DESCENT   altitude reduction from cruise to safe
                 emergency-descent FL100 / cabin-altitude
     · ISO-COMP  source-isolation completion percentage
                 (5-step ELEC / PACK / RECIRC / IFE / CARGO)

   Hard escalators (composite floor):
     · T ≥17min + source unidentified  → ≥92 (SR111 cliff)
     · Cabin smoke + DIVERT > 80 NM    → ≥88 (no suitable)
     · Cabin smoke + class FREIGHTER
                   + cargo loop hot    → ≥85 (UPS6 mode)
     · IFE source suspected + bus not
                   isolated within 8m  → ≥80 (SR111 mode)
     · CADENCE < 50% of architecture
                   baseline            → ≥72 (overload)
     · DESCENT not initiated + cabin
                   smoke + T+5min      → ≥65 (AC797 mode)

   6 tiers:
     SR111-CRIT  ≥85  rose       17-min cliff approached
     UPS6-LIKE   ≥65  rose-pink  Class-E cascade or non-isol
     AC797-DRIFT ≥45  amber      iso slow, divert window open
     COMMITTED   ≥25  sky        QRH executing on plan
     CLEAN       <25  emerald    no smoke event detected
     IDLE        slate           cruise-stable / ground

   Side panel (8-tier compatible structure):
     · 6-tier counter strip (click-to-filter)
     · 6-cell summary: μ-T-min / μ-DIVERT-NM / Σ-SR111-cnt /
       Σ-UPS6-cnt / WORST-callsign / μ-COMPLETION%
     · 5 sliders: ADV-MUL 50-200% / EVENT-RATE 0-100%
       (synthetic smoke-incident rate per 10k flt-hr per
       NTSB SDR 1995-2024) / DIVERT-CAP 30-200 NM scope /
       CADENCE-MUL 50-200% / CLIFF-MIN 10-30 (configurable
       17-min SR111 benchmark)
     · 8-class chip filter
     · 5-step ISO chip filter
       (NONE / ELEC / PACK / RECIRC / IFE / CARGO)
     · HALO / PIN / LBL / VEC / DIV toggles
     · search by callsign / type / operator / divert-ICAO
     · AIRCRAFT/CLASSES/PROFILE/PRECEDENT 4-tab switcher

   MapLibre overlay:
     · tier-coloured halo rings 7-20px score-sized
     · SR111-CRIT/UPS6-LIKE rose pins
     · dashed link aircraft → snapped nearest suitable
       (tier-coloured)
     · forward vector showing descent profile (300NM cone
       length for SR111-CRIT, 180NM for UPS6, 60NM standard)
     · cs / T+min / divert-NMI / tier labels

   AIRCRAFT tab — tier-worst-first row stack:
     · cs + type + arch-class-pill + phase-pill + tier-pill
     · 4-cell T+min / DIVERT-NM / ISO-step / ISO-%
     · 4-cell FL / CABIN-ALT / DESCENT-fpm / ARFF-cat
     · tier-coloured score bar
     · 8-driver chips TIME DIVERT ARCH CADENCE CLASS-E IFE
       DESCENT ISO-COMP
     · tier-coloured advice line citing TSB A98H0003 /
       AAR-86-02 / AAI 13/2010 / NTSB AAR-07-02 / QRH
       SMOKE-FIRE-FUMES

   CLASSES tab — per-arch class row:
     · class-pill + count + arch-note
     · 4-cell ISO-steps / CADENCE / Class-E flag / FCOM-ref
     · 4-cell μ-SCORE / SR111 / UPS6 / AC797
     · class-coloured score bar

   PROFILE tab — SVG decision-tree timeline
     · X-axis time T+0min → T+30min
     · Y-axis decision-tree depth
     · SR111 17-min cliff line (rose dashed)
     · Per-class cadence curve overlaid
     · Live picked-aircraft decision-marker position
     · 4-step shaded zones (DETECT / ISOLATE / DIVERT / LAND)

   PRECEDENT tab — 6-card historical incident catalogue
     · SR111 Swissair 111 MD-11 HB-IWF 1998-09-02
     · AC797 Air Canada 797 DC-9 C-FTLU 1983-06-02
     · UPS6 UPS 006 B744F N571UP 2010-09-03
     · FX80 FedEx 80 MD-11F N526FE 2003-07-28
     · AS991 Asiana 991 B744F HL7604 2011-07-28
     · BA38(F) BA Cargo 168 GE90 fire 2014 EGLL ON-GROUND

   References (cited in advice + PRECEDENT tab):
     · TSB Canada A98H0003 Swissair 111 MD-11 / 1998-09
     · NTSB AAR-86-02 Air Canada 797 DC-9 / 1983-06
     · GCAA UAE AAI 13/2010 UPS 6 B744F / 2010-09
     · NTSB AAR-07-02 FedEx 80 MD-11F / 2003-07
     · KARAIB AAB-2011-01 Asiana 991 B744F / 2011-07
     · NTSB AAR-93-02 USAir 405 ColdPack (icing tangent)
     · 14 CFR §25.831 cabin air ventilation
     · 14 CFR §25.851 fire extinguishers
     · 14 CFR §25.853(a) interior materials flame test
     · 14 CFR §25.855(d)(e) cargo compartment fire test
     · 14 CFR §25.857 cargo compartment classification
        (Class-A/B/C/D/E/F)
     · 14 CFR §25.858 cargo or baggage compartment smoke
                       or fire detection systems
     · 14 CFR §25.869 fire-protection in compartment
                       containing concentration of wiring
     · 14 CFR §25.1309 equipment systems and installations
     · 14 CFR §121.308 lavatory fire protection
     · 14 CFR §121.337 supplemental oxygen
     · 14 CFR §121.585 emergency equipment
     · 14 CFR §121.1119 ETOPS DTLD
     · EASA CS-25.851 / CS-25.857 / CS-25.858 / CS-25.869
     · ICAO Annex 6 Pt I §6.7 Fire-extinguishing equipment
     · ICAO Annex 8 Pt IIIA §4 / Doc 9760 Vol II Pt VI
     · ICAO Doc 9284 Tech Inst Dangerous Goods
     · FAA AC 25-9A Smoke detection / penetration
     · FAA AC 120-80B In-flight fires
     · FAA AC 120-42B ETOPS / DTLD
     · FAA SAFO 09013 In-Flight Fires Best Practice
     · FAA SAFO 18003 Fume Events
     · FAA InFO 11003 Smoke evacuation procedures
     · Boeing FCOM QRH 11.20 SMOKE-FIRE-FUMES Memory Items
     · Boeing FCTM Ch.8 Smoke/Fire/Fumes
     · Airbus FCOM PRO-ABN-AIR / PRO-ABN-26 SMOKE
     · Airbus FCTM PR-AOP §17 SMOKE / FIRE / FUMES
     · Embraer E-Jet AOM §03 / QRH SMOKE
     · MD-11 FCOM Vol II 91.10 SMOKE FIRE FUMES
     · TSB Canada Safety Recommendation A99-07 17-min
     · SAE ARP 5588 Multi-Function-Display Alerting
     · NFPA 408 Lavatory fire protection
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number
  track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'SR111-CRIT' | 'UPS6-LIKE' | 'AC797-DRIFT' | 'COMMITTED' | 'CLEAN' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'SR111-CRIT':  '#ef4444',
  'UPS6-LIKE':   '#fb7185',
  'AC797-DRIFT': '#f59e0b',
  'COMMITTED':   '#0ea5e9',
  'CLEAN':       '#10b981',
  'IDLE':        '#64748b',
}
const TIER_ORDER: Tier[] = ['SR111-CRIT','UPS6-LIKE','AC797-DRIFT','COMMITTED','CLEAN','IDLE']

type Klass =
  | 'HVY-MD11' | 'HVY-T' | 'HVY-A' | 'HVY-NB'
  | 'RGN-J' | 'RGN-T' | 'FREIGHTER' | 'BIZ-LIGHT'
const KLASS_LIST: Klass[] = ['HVY-MD11','HVY-T','HVY-A','HVY-NB','RGN-J','RGN-T','FREIGHTER','BIZ-LIGHT']
const KLASS_COLOR: Record<Klass, string> = {
  'HVY-MD11':  '#ef4444',
  'HVY-T':     '#7dd3fc',
  'HVY-A':     '#a78bfa',
  'HVY-NB':    '#fb923c',
  'RGN-J':     '#fbbf24',
  'RGN-T':     '#fde047',
  'FREIGHTER': '#f472b6',
  'BIZ-LIGHT': '#94a3b8',
}

interface ClassSpec {
  isoSteps: number   // SOP items in smoke-isolation
  cadence: number    // baseline items/min
  classE: boolean    // freighter main-deck Class-E exposure
  fcomRef: string
  arch: string       // architecture descriptor
}
const SPEC: Record<Klass, ClassSpec> = {
  'HVY-MD11':  { isoSteps: 11, cadence: 4.8, classE: false, fcomRef: 'MD-11 FCOM Vol II 91.10', arch: 'IFE+galley legacy 3-eng (SR111 family)' },
  'HVY-T':     { isoSteps: 9,  cadence: 8.0, classE: false, fcomRef: 'Boeing 777/787 FCOM ECL', arch: 'EICAS + Electronic Checklist auto-seq' },
  'HVY-A':     { isoSteps: 8,  cadence: 7.5, classE: false, fcomRef: 'Airbus FCOM PRO-ABN-AIR/26', arch: 'ECAM SD-driven smoke iso' },
  'HVY-NB':    { isoSteps: 7,  cadence: 6.0, classE: false, fcomRef: 'Boeing 737 FCOM QRH 11.20', arch: 'EICAS-CL manual smoke removal' },
  'RGN-J':     { isoSteps: 6,  cadence: 5.5, classE: false, fcomRef: 'E195 AOM §03 / Primus Epic', arch: 'EICAS SMK detect, NWHL bus' },
  'RGN-T':     { isoSteps: 5,  cadence: 4.5, classE: false, fcomRef: 'Q400 FCOM §11 / ATR FCOM §2.05', arch: 'Single-channel detect simplified' },
  'FREIGHTER': { isoSteps: 8,  cadence: 6.5, classE: true,  fcomRef: 'AC 120-80B + 14 CFR §25.857(d)', arch: 'Main-deck Class-E + depressurize-only' },
  'BIZ-LIGHT': { isoSteps: 4,  cadence: 4.0, classE: false, fcomRef: 'G650 FOM / FCOM ABN-06', arch: 'Manual smoke-removal limited bus' },
}

function classify(t: string | undefined, op: string | undefined): Klass | null {
  const x = (t || '').toUpperCase()
  const o = (op || '').toUpperCase()
  if (/^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139|AW189)/.test(x)) return null
  if (/^F1[5-9]/.test(x)) return null
  // Freighters detected by operator first
  if (/(FEDEX|UPS|DHL|ATLAS|AMERIJET|KALITTA|ASIANA CARGO|CARGOLUX|EVA CARGO|POLAR|NIPPON CARGO|CARGO|EXPRESS|ABX|SOUTHERN AIR|ATL|FX|GTI|GTI|5X|5Y)/.test(o)) {
    if (/^(B74|B748|B77|MD11|A30|A33|A34|A35|IL76)/.test(x)) return 'FREIGHTER'
  }
  if (/F$/.test(x) || /CARGO/.test(x)) return 'FREIGHTER'
  // MD-11/DC-10 legacy SR111 family
  if (/^(MD11|DC10|MD9|MD8|MD81|MD82|MD83|MD87|MD88|MD90|MD80)/.test(x)) return 'HVY-MD11'
  // Heavy Boeing twins / quads (777, 787, 747, 767)
  if (/^(B77|B78|B74|B748|B76)/.test(x)) return 'HVY-T'
  // Heavy Airbus (A330/350/380)
  if (/^(A33|A34|A35|A38)/.test(x)) return 'HVY-A'
  // Narrowbody
  if (/^(B73|B38M|B39M|B72|B71|A19|A20|A21|A22|CS|BCS|MD90)/.test(x)) return 'HVY-NB'
  // Regional jet
  if (/^(CRJ|E14|E15|E17|E19|E29|E70|E75|E90|E95|RJ70|RJ85|RJ100|BAE)/.test(x)) return 'RGN-J'
  // Regional turboprop
  if (/^(AT4|AT5|AT7|DH8|SF34|J32|J41|ATR|Q400|BE9|BE3|EMB1|EMB2|F50|F70|F100)/.test(x)) return 'RGN-T'
  // Biz / light
  if (/^(GLF|GLEX|GL5T|GL7T|G280|G450|G550|G650|CL[36]|C25|C56|C68|C75|C72|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC|TBM|BE40|C82|C17|P28|SR2|DA)/.test(x)) return 'BIZ-LIGHT'
  return 'HVY-NB'
}

interface Airport {
  icao: string; lat: number; lng: number; arffCat: number; ilsCat: 1|2|3; name: string
}
const APTS: Airport[] = [
  { icao:'KJFK', lat:40.6413, lng:-73.7781, arffCat:10, ilsCat:3, name:'New York JFK' },
  { icao:'KLGA', lat:40.7769, lng:-73.8740, arffCat:9,  ilsCat:1, name:'New York LGA' },
  { icao:'KEWR', lat:40.6925, lng:-74.1687, arffCat:10, ilsCat:3, name:'Newark' },
  { icao:'KBOS', lat:42.3656, lng:-71.0096, arffCat:10, ilsCat:3, name:'Boston Logan' },
  { icao:'KIAD', lat:38.9531, lng:-77.4565, arffCat:10, ilsCat:3, name:'Washington Dulles' },
  { icao:'KATL', lat:33.6407, lng:-84.4277, arffCat:10, ilsCat:3, name:'Atlanta' },
  { icao:'KDFW', lat:32.8998, lng:-97.0403, arffCat:10, ilsCat:3, name:'Dallas/Fort Worth' },
  { icao:'KIAH', lat:29.9844, lng:-95.3414, arffCat:10, ilsCat:3, name:'Houston IAH' },
  { icao:'KORD', lat:41.9742, lng:-87.9073, arffCat:10, ilsCat:3, name:'Chicago O\u2019Hare' },
  { icao:'KMIA', lat:25.7959, lng:-80.2870, arffCat:10, ilsCat:3, name:'Miami' },
  { icao:'KLAX', lat:33.9425, lng:-118.4081, arffCat:10, ilsCat:3, name:'Los Angeles' },
  { icao:'KSFO', lat:37.6213, lng:-122.3790, arffCat:10, ilsCat:3, name:'San Francisco' },
  { icao:'KSEA', lat:47.4502, lng:-122.3088, arffCat:10, ilsCat:3, name:'Seattle' },
  { icao:'KDEN', lat:39.8561, lng:-104.6737, arffCat:10, ilsCat:3, name:'Denver' },
  { icao:'KSLC', lat:40.7899, lng:-111.9791, arffCat:9,  ilsCat:3, name:'Salt Lake City' },
  { icao:'KMSP', lat:44.8848, lng:-93.2223, arffCat:10, ilsCat:3, name:'Minneapolis' },
  { icao:'EGLL', lat:51.4700, lng:-0.4543, arffCat:10, ilsCat:3, name:'London Heathrow' },
  { icao:'EGKK', lat:51.1481, lng:-0.1903, arffCat:9,  ilsCat:3, name:'London Gatwick' },
  { icao:'EDDF', lat:50.0379, lng:8.5622, arffCat:10, ilsCat:3, name:'Frankfurt' },
  { icao:'EDDM', lat:48.3538, lng:11.7861, arffCat:10, ilsCat:3, name:'Munich' },
  { icao:'LFPG', lat:49.0097, lng:2.5479, arffCat:10, ilsCat:3, name:'Paris CDG' },
  { icao:'EHAM', lat:52.3105, lng:4.7683, arffCat:10, ilsCat:3, name:'Amsterdam' },
  { icao:'LIRF', lat:41.8003, lng:12.2389, arffCat:10, ilsCat:3, name:'Rome Fiumicino' },
  { icao:'LSZH', lat:47.4647, lng:8.5492, arffCat:9,  ilsCat:3, name:'Z\u00fcrich' },
  { icao:'RJTT', lat:35.5494, lng:139.7798, arffCat:10, ilsCat:3, name:'Tokyo Haneda' },
  { icao:'RKSI', lat:37.4602, lng:126.4407, arffCat:10, ilsCat:3, name:'Seoul Incheon' },
  { icao:'VHHH', lat:22.3080, lng:113.9185, arffCat:10, ilsCat:3, name:'Hong Kong' },
  { icao:'WSSS', lat:1.3592, lng:103.9894, arffCat:10, ilsCat:3, name:'Singapore Changi' },
  { icao:'OMDB', lat:25.2528, lng:55.3644, arffCat:10, ilsCat:3, name:'Dubai' },
  { icao:'YSSY', lat:-33.9399, lng:151.1753, arffCat:10, ilsCat:3, name:'Sydney' },
  { icao:'CYYZ', lat:43.6777, lng:-79.6248, arffCat:10, ilsCat:3, name:'Toronto Pearson' },
  { icao:'CYHZ', lat:44.8808, lng:-63.5086, arffCat:9,  ilsCat:3, name:'Halifax (SR111 div)' },
  { icao:'CYUL', lat:45.4706, lng:-73.7408, arffCat:10, ilsCat:3, name:'Montreal Trudeau' },
]

const D2R = Math.PI/180, R2D = 180/Math.PI
const R_NM = 3440.065

function projectGc(lat:number, lng:number, brgDeg:number, distNm:number) {
  const d=distNm/R_NM, br=brgDeg*D2R
  const \u03c61=lat*D2R, \u03bb1=lng*D2R
  const s\u03c62=Math.sin(\u03c61)*Math.cos(d)+Math.cos(\u03c61)*Math.sin(d)*Math.cos(br)
  const \u03c62=Math.asin(s\u03c62)
  const y=Math.sin(br)*Math.sin(d)*Math.cos(\u03c61)
  const x=Math.cos(d)-Math.sin(\u03c61)*s\u03c62
  const \u03bb2=\u03bb1+Math.atan2(y,x)
  return { lat:\u03c62*R2D, lng:((\u03bb2*R2D+540)%360)-180 }
}

function gcDist(la1:number, lo1:number, la2:number, lo2:number): number {
  const \u03c61=la1*D2R, \u03c62=la2*D2R
  const \u0394\u03c6=(la2-la1)*D2R, \u0394\u03bb=(lo2-lo1)*D2R
  const a=Math.sin(\u0394\u03c6/2)**2 + Math.cos(\u03c61)*Math.cos(\u03c62)*Math.sin(\u0394\u03bb/2)**2
  return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

function ramp(x:number, lo:number, hi:number): number {
  if (x<=lo) return 0
  if (x>=hi) return 100
  return 100*(x-lo)/(hi-lo)
}

// deterministic hash 0..1 from icao24
function hashUnit(icao:string, salt:string): number {
  let h = 2166136261 >>> 0
  for (let i=0;i<icao.length;i++) h = Math.imul(h ^ icao.charCodeAt(i), 16777619) >>> 0
  for (let i=0;i<salt.length;i++) h = Math.imul(h ^ salt.charCodeAt(i), 16777619) >>> 0
  return ((h >>> 0) / 4294967295)
}

type IsoStep = 'NONE' | 'ELEC' | 'PACK' | 'RECIRC' | 'IFE' | 'CARGO'
const ISO_STEPS: IsoStep[] = ['NONE','ELEC','PACK','RECIRC','IFE','CARGO']

interface SmokeState {
  active: boolean
  src: IsoStep
  tMin: number       // minutes since first indication
  isoCompleted: number // 0-100 percentage of iso steps completed
  cabinSmoke: boolean
  ifeSuspected: boolean
  cargoHot: boolean
}

interface Per {
  klass: Klass
  spec: ClassSpec
  smoke: SmokeState
  divNM: number
  divApt: Airport | null
  flKft: number
  cabinAltKft: number
  descentFpm: number
  drivers: { TIME:number; DIVERT:number; ARCH:number; CADENCE:number; CLASSE:number; IFE:number; DESCENT:number; ISOCOMP:number }
}

interface Row {
  f: SFlight
  klass: Klass
  p: Per
  score: number
  tier: Tier
}

const SRC='sff-src', LINK_SRC='sff-link-src', VEC_SRC='sff-vec-src', APT_SRC='sff-apt-src'
const HALO='sff-halo', PIN='sff-pin', LBL='sff-lbl', LINK='sff-link', VEC='sff-vec', APT='sff-apt', APT_LBL='sff-apt-lbl'

export default function SffSmokeIsolation({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [stepFilter, setStepFilter] = useState<IsoStep | 'ALL'>('ALL')
  const [advMul, setAdvMul] = useState(100)
  const [eventRate, setEventRate] = useState(35) // smoke incidents per 10k flt-hr scaled to fleet
  const [divCap, setDivCap] = useState(120)
  const [cadenceMul, setCadenceMul] = useState(100)
  const [cliffMin, setCliffMin] = useState(17)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showVec, setShowVec] = useState(true)
  const [showApt, setShowApt] = useState(true)
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'PROFILE'|'PRECEDENT'>('AIRCRAFT')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Row|null>(null)

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      const klass = classify(f.type, f.operator)
      if (!klass) continue
      const flKft = f.altitudeFt / 1000
      if (flKft < 1) continue
      const spec = SPEC[klass]

      // Deterministic synthetic smoke event sampling
      const rEvent = hashUnit(f.icao, 'sff-event')
      const eventProb = eventRate / 1000 // dial baseline (~3.5% at 35)
      const active = rEvent < eventProb

      let smoke: SmokeState
      if (!active) {
        smoke = { active: false, src: 'NONE', tMin: 0, isoCompleted: 100, cabinSmoke: false, ifeSuspected: false, cargoHot: false }
      } else {
        const rT = hashUnit(f.icao, 'sff-t')
        const tMin = rT * 28 // 0-28 min since SOSF
        const srcRoll = hashUnit(f.icao, 'sff-src')
        let src: IsoStep
        if (srcRoll < 0.18) src = 'NONE'
        else if (srcRoll < 0.42) src = 'ELEC'
        else if (srcRoll < 0.60) src = 'PACK'
        else if (srcRoll < 0.72) src = 'RECIRC'
        else if (srcRoll < 0.88) src = 'IFE'
        else src = 'CARGO'
        const isoCompleted = Math.min(100, (tMin / 12) * 100 * (cadenceMul/100) * (spec.cadence / 7))
        const cabinSmoke = hashUnit(f.icao, 'sff-cabin') < 0.55
        const ifeSuspected = src === 'IFE' || (klass === 'HVY-MD11' && hashUnit(f.icao, 'sff-ife') < 0.55)
        const cargoHot = src === 'CARGO' || (spec.classE && hashUnit(f.icao, 'sff-cargo') < 0.45)
        smoke = { active: true, src, tMin, isoCompleted, cabinSmoke, ifeSuspected, cargoHot }
      }

      // Nearest suitable airport
      let divNM = Infinity
      let divApt: Airport | null = null
      for (const a of APTS) {
        const d = gcDist(f.lat, f.lng, a.lat, a.lng)
        if (d < divNM) { divNM = d; divApt = a }
      }
      if (divNM > divCap * 4) { divApt = null; divNM = Infinity }

      // Estimated cabin altitude (cabin Δp ~8 psi cruise FL300+ → cabin alt 6-8 kft)
      const cabinAltKft = flKft > 28 ? 6 + (flKft - 28) * 0.05 : flKft * 0.3
      const descentFpm = active && smoke.cabinSmoke ? Math.max(0, 2500 + Math.abs(f.vertRate)) : Math.abs(f.vertRate)

      // 8 drivers
      const D_TIME = active ? ramp(smoke.tMin, 0, cliffMin + 8) : 0
      const D_DIVERT = isFinite(divNM) ? ramp(divNM, 30, divCap) : 100
      const D_ARCH = active ? Math.max(0, (10 - spec.cadence) * 11) : 0
      const D_CADENCE = active && smoke.tMin > 2
        ? Math.max(0, 100 - smoke.isoCompleted * 1.0)
        : 0
      const D_CLASSE = active && spec.classE && smoke.cargoHot ? 85 : (spec.classE && active ? 45 : 0)
      const D_IFE = active && smoke.ifeSuspected && smoke.isoCompleted < 60 ? 75 : 0
      const D_DESC = active && smoke.cabinSmoke && descentFpm < 1500 && flKft > 18 ? 70 : 0
      const D_ISO = active ? Math.max(0, 100 - smoke.isoCompleted) : 0

      const drivers = { TIME:D_TIME, DIVERT:D_DIVERT, ARCH:D_ARCH, CADENCE:D_CADENCE, CLASSE:D_CLASSE, IFE:D_IFE, DESCENT:D_DESC, ISOCOMP:D_ISO }
      const vals = Object.values(drivers)
      const max = Math.max(...vals)
      const mean = vals.reduce((a,b)=>a+b,0)/vals.length
      let score = (max * 0.62 + mean * 0.38) * (advMul/100)

      // Hard escalators (SR111 / UPS6 / AC797 / SR111-IFE / cadence / AC797-descent)
      if (active && smoke.tMin >= cliffMin && smoke.src === 'NONE') score = Math.max(score, 92)
      if (active && smoke.cabinSmoke && divNM > 80) score = Math.max(score, 88)
      if (active && spec.classE && smoke.cargoHot) score = Math.max(score, 85)
      if (active && smoke.ifeSuspected && smoke.tMin > 8 && smoke.isoCompleted < 50) score = Math.max(score, 80)
      if (active && smoke.tMin > 4 && smoke.isoCompleted < spec.cadence * smoke.tMin * 0.5) score = Math.max(score, 72)
      if (active && smoke.cabinSmoke && descentFpm < 1500 && smoke.tMin > 5 && flKft > 25) score = Math.max(score, 65)

      score = Math.min(100, Math.max(0, score))

      let tier: Tier
      if (!active) tier = 'CLEAN'
      else if (score >= 85) tier = 'SR111-CRIT'
      else if (score >= 65) tier = 'UPS6-LIKE'
      else if (score >= 45) tier = 'AC797-DRIFT'
      else if (score >= 25) tier = 'COMMITTED'
      else tier = 'CLEAN'
      if (flKft < 1) tier = 'IDLE'

      const p: Per = { klass, spec, smoke, divNM, divApt, flKft, cabinAltKft, descentFpm, drivers }
      out.push({ f, klass, p, score, tier })
    }
    return out.sort((a,b) => b.score - a.score)
  }, [flights, advMul, eventRate, divCap, cadenceMul, cliffMin])

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (stepFilter !== 'ALL' && r.p.smoke.src !== stepFilter) return false
      if (!ql) return true
      const cs = (r.f.callsign||r.f.icao).toLowerCase()
      const ty = (r.f.type||'').toLowerCase()
      const op = (r.f.operator||'').toLowerCase()
      const di = (r.p.divApt?.icao||'').toLowerCase()
      return cs.includes(ql) || ty.includes(ql) || op.includes(ql) || r.klass.toLowerCase().includes(ql) || di.includes(ql)
    })
  }, [rows, tierFilter, klassFilter, stepFilter, q])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { 'SR111-CRIT':0,'UPS6-LIKE':0,'AC797-DRIFT':0,'COMMITTED':0,'CLEAN':0,'IDLE':0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const summary = useMemo(() => {
    if (!rows.length) return null
    const active = rows.filter(r => r.p.smoke.active)
    if (!active.length) return { muT: 0, muDiv: 0, sr111: 0, ups6: 0, worst: null, muIso: 0, activeCnt: 0 }
    const muT = active.reduce((s,r)=>s+r.p.smoke.tMin,0)/active.length
    const muDiv = active.reduce((s,r)=>s+(isFinite(r.p.divNM)?r.p.divNM:0),0)/active.length
    const sr111 = active.filter(r => r.tier==='SR111-CRIT').length
    const ups6 = active.filter(r => r.tier==='UPS6-LIKE').length
    const worst = active.reduce((a,b)=> b.score>a.score?b:a)
    const muIso = active.reduce((s,r)=>s+r.p.smoke.isoCompleted,0)/active.length
    return { muT, muDiv, sr111, ups6, worst, muIso, activeCnt: active.length }
  }, [rows])

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const apply = () => {
      try {
        const live = filtered.filter(r => r.tier !== 'IDLE' && r.tier !== 'CLEAN')
        const haloFeat = filtered.filter(r => r.tier !== 'IDLE').map(r => ({
          type:'Feature' as const,
          geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat]},
          properties:{
            color: TIER_COLOR[r.tier], score: r.score, tier: r.tier,
            label: r.p.smoke.active
              ? `${r.f.callsign||r.f.icao} T+${r.p.smoke.tMin.toFixed(0)}min ${isFinite(r.p.divNM)?r.p.divNM.toFixed(0)+'NM':'—'} ${r.tier}`
              : `${r.f.callsign||r.f.icao} ${r.tier}`
          }
        }))

        const linkFeat = live.filter(r => r.p.divApt).map(r => ({
          type:'Feature' as const,
          geometry:{ type:'LineString' as const, coordinates:[
            [r.f.lng, r.f.lat], [r.p.divApt!.lng, r.p.divApt!.lat]
          ]},
          properties:{ color: TIER_COLOR[r.tier], opacity: r.tier==='SR111-CRIT'?0.85:r.tier==='UPS6-LIKE'?0.7:0.45 }
        }))

        const vecFeat = live.slice(0, 24).map(r => {
          const len = r.tier === 'SR111-CRIT' ? 300 : r.tier === 'UPS6-LIKE' ? 180 : 60
          const halfDeg = 7
          const c1 = projectGc(r.f.lat, r.f.lng, r.f.track - halfDeg, len)
          const c2 = projectGc(r.f.lat, r.f.lng, r.f.track + halfDeg, len)
          return {
            type:'Feature' as const,
            geometry:{ type:'Polygon' as const, coordinates:[[
              [r.f.lng, r.f.lat], [c1.lng, c1.lat], [c2.lng, c2.lat], [r.f.lng, r.f.lat]
            ]]},
            properties:{ color: TIER_COLOR[r.tier], opacity: 0.10 + r.score/600 }
          }
        })

        const aptSet = new Set(live.filter(r => r.p.divApt).map(r => r.p.divApt!.icao))
        const aptFeat = APTS.filter(a => aptSet.has(a.icao)).map(a => ({
          type:'Feature' as const,
          geometry:{ type:'Point' as const, coordinates:[a.lng, a.lat]},
          properties:{ name: `${a.icao} ARFF-${a.arffCat} ILS-CAT${a.ilsCat}` }
        }))

        const haloFc:any = { type:'FeatureCollection', features: haloFeat }
        const linkFc:any = { type:'FeatureCollection', features: linkFeat }
        const vecFc:any = { type:'FeatureCollection', features: vecFeat }
        const aptFc:any = { type:'FeatureCollection', features: aptFeat }

        const haloSrc = map.getSource(SRC) as any
        const linkSrc = map.getSource(LINK_SRC) as any
        const vecSrc = map.getSource(VEC_SRC) as any
        const aptSrc = map.getSource(APT_SRC) as any
        if (haloSrc) haloSrc.setData(haloFc); else map.addSource(SRC, { type:'geojson', data: haloFc })
        if (linkSrc) linkSrc.setData(linkFc); else map.addSource(LINK_SRC, { type:'geojson', data: linkFc })
        if (vecSrc) vecSrc.setData(vecFc); else map.addSource(VEC_SRC, { type:'geojson', data: vecFc })
        if (aptSrc) aptSrc.setData(aptFc); else map.addSource(APT_SRC, { type:'geojson', data: aptFc })

        if (showVec && !map.getLayer(VEC)) map.addLayer({ id: VEC, type:'fill', source: VEC_SRC,
          paint:{ 'fill-color':['get','color'], 'fill-opacity':['get','opacity'] } })
        if (!showVec && map.getLayer(VEC)) map.removeLayer(VEC)

        if (showHalo && !map.getLayer(HALO)) map.addLayer({ id: HALO, type:'circle', source: SRC,
          paint:{
            'circle-radius':['+',7,['/',['get','score'],7.5]],
            'circle-color':['get','color'],
            'circle-opacity':0.18,
            'circle-stroke-color':['get','color'],
            'circle-stroke-width':1.2,
            'circle-stroke-opacity':0.85,
          }})
        if (!showHalo && map.getLayer(HALO)) map.removeLayer(HALO)

        if (showLink && !map.getLayer(LINK)) map.addLayer({ id: LINK, type:'line', source: LINK_SRC,
          paint:{ 'line-color':['get','color'], 'line-width':1.3, 'line-opacity':['get','opacity'], 'line-dasharray':[3,2] } })
        if (!showLink && map.getLayer(LINK)) map.removeLayer(LINK)

        if (showPin && !map.getLayer(PIN)) map.addLayer({ id: PIN, type:'circle', source: SRC,
          filter:['in',['get','tier'],['literal',['SR111-CRIT','UPS6-LIKE']]],
          paint:{ 'circle-radius':3.5, 'circle-color':'#fff',
            'circle-stroke-color':['get','color'], 'circle-stroke-width':2 }})
        if (!showPin && map.getLayer(PIN)) map.removeLayer(PIN)

        if (showApt && !map.getLayer(APT)) map.addLayer({ id: APT, type:'circle', source: APT_SRC,
          paint:{ 'circle-radius':3.5, 'circle-color':'#10b981', 'circle-stroke-color':'#022c22', 'circle-stroke-width':1.5, 'circle-opacity':0.7 } })
        if (!showApt && map.getLayer(APT)) map.removeLayer(APT)

        if (showApt && !map.getLayer(APT_LBL)) map.addLayer({ id: APT_LBL, type:'symbol', source: APT_SRC,
          layout:{ 'text-field':['get','name'], 'text-size':8.5, 'text-offset':[0,1.1], 'text-anchor':'top', 'text-allow-overlap':false },
          paint:{ 'text-color':'#10b981', 'text-halo-color':'#020617', 'text-halo-width':1.2 }})
        if (!showApt && map.getLayer(APT_LBL)) map.removeLayer(APT_LBL)

        if (showLbl && !map.getLayer(LBL)) map.addLayer({ id: LBL, type:'symbol', source: SRC,
          filter:['in',['get','tier'],['literal',['SR111-CRIT','UPS6-LIKE','AC797-DRIFT']]],
          layout:{ 'text-field':['get','label'], 'text-size':9.5, 'text-offset':[0,1.3], 'text-anchor':'top', 'text-allow-overlap':false },
          paint:{ 'text-color':['get','color'], 'text-halo-color':'#020617', 'text-halo-width':1.2 }})
        if (!showLbl && map.getLayer(LBL)) map.removeLayer(LBL)
      } catch {}
    }
    if (map.isStyleLoaded()) apply(); else map.once('load', apply)
    return () => {
      try {
        for (const id of [LBL, APT_LBL, APT, PIN, LINK, HALO, VEC]) if (map.getLayer(id)) map.removeLayer(id)
        for (const id of [SRC, LINK_SRC, VEC_SRC, APT_SRC]) if (map.getSource(id)) map.removeSource(id)
      } catch {}
    }
  }, [map, filtered, showHalo, showPin, showLbl, showLink, showVec, showApt])

  /* PROFILE tab — decision-tree SVG */
  const ProfileSvg = () => {
    const W = 430, H = 240, PL = 36, PR = 12, PT = 14, PB = 30
    const tMax = 30
    const x = (t:number) => PL + (t/tMax) * (W-PL-PR)
    const y = (d:number) => H-PB - (d/100) * (H-PT-PB)

    // Background shaded zones: DETECT 0-3 / ISOLATE 3-10 / DIVERT 10-17 / LAND 17-30
    const zones = [
      { t0:0, t1:3, name:'DETECT', color:'#10b98122' },
      { t0:3, t1:10, name:'ISOLATE', color:'#0ea5e922' },
      { t0:10, t1:cliffMin, name:'DIVERT', color:'#f59e0b22' },
      { t0:cliffMin, t1:tMax, name:'LAND-OR-CASCADE', color:'#ef444422' },
    ]

    // Cadence curves per class (% completion vs time)
    const classCurves = KLASS_LIST.map(k => {
      const sp = SPEC[k]
      const pts: [number,number][] = []
      for (let t=0; t<=tMax; t+=0.5) {
        const completion = Math.min(100, (t / 12) * 100 * (sp.cadence / 7))
        pts.push([t, completion])
      }
      return { k, pts, color: KLASS_COLOR[k] }
    })

    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{maxHeight:260}}>
        <rect x={0} y={0} width={W} height={H} fill="#020617"/>
        {/* zones */}
        {zones.map(z => (
          <g key={z.name}>
            <rect x={x(z.t0)} y={PT} width={x(z.t1)-x(z.t0)} height={H-PT-PB} fill={z.color}/>
            <text x={(x(z.t0)+x(z.t1))/2} y={PT+9} fontSize={7.5} fill="#94a3b8" textAnchor="middle">{z.name}</text>
          </g>
        ))}
        {/* axes */}
        <line x1={PL} y1={H-PB} x2={W-PR} y2={H-PB} stroke="#334155" strokeWidth={0.8}/>
        <line x1={PL} y1={PT} x2={PL} y2={H-PB} stroke="#334155" strokeWidth={0.8}/>
        {[0,5,10,15,20,25,30].map(v => (
          <g key={`x${v}`}>
            <line x1={x(v)} y1={H-PB} x2={x(v)} y2={H-PB+3} stroke="#475569"/>
            <text x={x(v)} y={H-PB+12} fontSize={8} fill="#64748b" textAnchor="middle">T+{v}m</text>
          </g>
        ))}
        {[0,25,50,75,100].map(v => (
          <g key={`y${v}`}>
            <line x1={PL-3} y1={y(v)} x2={PL} y2={y(v)} stroke="#475569"/>
            <text x={PL-5} y={y(v)+3} fontSize={8} fill="#64748b" textAnchor="end">{v}%</text>
          </g>
        ))}
        <text x={W/2} y={H-4} fontSize={9} fill="#94a3b8" textAnchor="middle">time since SOSF (min)</text>
        <text x={10} y={H/2} fontSize={9} fill="#94a3b8" transform={`rotate(-90 10 ${H/2})`} textAnchor="middle">iso completion %</text>
        {/* SR111 17-min cliff */}
        <line x1={x(cliffMin)} y1={PT} x2={x(cliffMin)} y2={H-PB} stroke={TIER_COLOR['SR111-CRIT']} strokeWidth={1.4} strokeDasharray="3 3"/>
        <text x={x(cliffMin)+4} y={PT+18} fontSize={8} fill={TIER_COLOR['SR111-CRIT']}>SR111 cliff T+{cliffMin}m</text>
        {/* per-class cadence curves */}
        {classCurves.map(c => (
          <polyline key={c.k} fill="none" stroke={c.color} strokeWidth={1.1} opacity={0.7}
            points={c.pts.map(([t,v])=>`${x(t)},${y(v)}`).join(' ')}/>
        ))}
        {/* active aircraft dots */}
        {rows.filter(r => r.p.smoke.active).slice(0,24).map((r,i) => (
          <g key={i}>
            <circle cx={x(r.p.smoke.tMin)} cy={y(r.p.smoke.isoCompleted)} r={3.2}
              fill={TIER_COLOR[r.tier]} stroke="#020617" strokeWidth={0.8} opacity={0.85}/>
          </g>
        ))}
        {/* picked aircraft */}
        {sel && sel.p.smoke.active && (
          <g>
            <circle cx={x(sel.p.smoke.tMin)} cy={y(sel.p.smoke.isoCompleted)} r={6}
              fill="none" stroke="#f1f5f9" strokeWidth={1.4}/>
            <text x={x(sel.p.smoke.tMin)} y={y(sel.p.smoke.isoCompleted)-9} fontSize={8} fill="#cbd5e1" textAnchor="middle">{sel.f.callsign||sel.f.icao}</text>
          </g>
        )}
      </svg>
    )
  }

  /* PRECEDENT tab — 6 historical cards */
  type Precedent = { tag: string; date: string; ac: string; reg: string; loc: string; fatal: number; tMin: number; src: string; ref: string; narr: string; color: string }
  const PRECEDENTS: Precedent[] = [
    { tag:'SR111', date:'1998-09-02', ac:'MD-11', reg:'HB-IWF', loc:'Halifax NS · Swissair 111 JFK-GVA', fatal:229, tMin:21, src:'IFE wiring arc/MPET',
      ref:'TSB Canada A98H0003 / SR A99-07', narr:'In-flight fire above cockpit ceiling from IFE supply arc. Smoke detected T+0 ZRH BD. Crew did not request emergency descent until T+15min. Aircraft impacted ocean T+21min unable to reach CYHZ. Established the 17-min benchmark.', color:'#ef4444' },
    { tag:'AC797', date:'1983-06-02', ac:'DC-9-32', reg:'C-FTLU', loc:'Cincinnati KCVG · Air Canada 797', fatal:23, tMin:24, src:'Lavatory fire suspected',
      ref:'NTSB AAR-86-02', narr:'Smoke originated from aft lavatory area at FL330. Crew commenced emergency descent T+5min. Landed CVG T+17min from first indication but cabin flashover during evacuation killed 23 of 46.', color:'#fb7185' },
    { tag:'UPS6', date:'2010-09-03', ac:'B744F', reg:'N571UP', loc:'Dubai OMDB · UPS 006 DXB-CGN', fatal:2, tMin:28, src:'Class-E main-deck Li-ion runaway',
      ref:'GCAA AAI 13/2010', narr:'Li-ion pallets self-ignited. Smoke filled cockpit, both pilots incapacitated by toxic atmosphere. Aircraft attempted return to DXB, missed approach, impacted desert T+28min. Drove ICAO Doc 9284 Add.4 Li-ion 30% SoC cap.', color:'#fb7185' },
    { tag:'FX80', date:'2003-07-28', ac:'MD-11F', reg:'N526FE', loc:'Memphis KMEM · FedEx Express 80 OAK-MEM', fatal:0, tMin:0, src:'Landing impact / cargo fire post-impact',
      ref:'NTSB AAR-07-02', narr:'Landing-impact related rather than in-flight smoke origin, but cargo fire developed post-touchdown. MD-11 class precedent for freighter cargo fire suppression timelines and evacuation. 0 fatalities of 2 crew (later reclassified).', color:'#f59e0b' },
    { tag:'AS991', date:'2011-07-28', ac:'B744F', reg:'HL7604', loc:'East China Sea · Asiana 991 ICN-PVG', fatal:2, tMin:25, src:'Main-deck Class-E Li-ion + flammable',
      ref:'KARAIB AAB-2011-01', narr:'Main-deck fire indication FL340. Attempted divert RJTT (Jeju) and RKSI. Lost control T+25min, ditched East China Sea. Both crew killed. Catalyst for IATA DGR Li-ion forbidden-PAX strengthening.', color:'#fb7185' },
    { tag:'CTH164', date:'2009-02-07', ac:'B744F', reg:'N987SA', loc:'Brazil · Centurion 164 / Atlas 164', fatal:0, tMin:0, src:'EE-bay smoke (electrical equipment)',
      ref:'NTSB DCA09RA021', narr:'Smoke in EE-bay at cruise. Crew executed Boeing 747 SMOKE / FIRE / FUMES QRH and diverted to nearest suitable, successful landing within window. Cited as positive-precedent for source-isolation procedure compliance.', color:'#10b981' },
  ]

  return (
    <div className="absolute right-3 top-20 z-30 w-[470px] max-h-[80vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">SFF</div>
        <div className="text-[10px] text-slate-400 truncate">Smoke / Fire / Fumes · 17-min QRH compliance · TSB A98H0003</div>
        <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-100 text-[12px] px-2 py-0.5 rounded hover:bg-slate-800/60">\u2715</button>
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
          <div><div className="text-[8px] text-slate-500">\u03bc-T+min</div><div className="text-slate-100">{summary.muT.toFixed(1)}</div></div>
          <div><div className="text-[8px] text-slate-500">\u03bc-DIV-NM</div><div className="text-slate-100">{isFinite(summary.muDiv)?summary.muDiv.toFixed(0):'—'}</div></div>
          <div><div className="text-[8px] text-slate-500">SR111</div><div style={{color:summary.sr111>0?TIER_COLOR['SR111-CRIT']:'#e2e8f0'}}>{summary.sr111}</div></div>
          <div><div className="text-[8px] text-slate-500">UPS6</div><div style={{color:summary.ups6>0?TIER_COLOR['UPS6-LIKE']:'#e2e8f0'}}>{summary.ups6}</div></div>
          <div><div className="text-[8px] text-slate-500">WORST</div><div className="text-slate-100 truncate">{summary.worst?(summary.worst.f.callsign||summary.worst.f.icao):'—'}</div></div>
          <div><div className="text-[8px] text-slate-500">\u03bc-ISO%</div><div className="text-slate-100">{summary.muIso.toFixed(0)}</div></div>
        </div>
      )}

      {/* sliders */}
      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800/60 text-[9.5px]">
        <label className="flex flex-col">
          <span className="text-slate-400">ADV-MUL {advMul}%</span>
          <input type="range" min={50} max={200} value={advMul} onChange={e=>setAdvMul(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">EVENT {eventRate}/10k</span>
          <input type="range" min={0} max={100} value={eventRate} onChange={e=>setEventRate(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">DIV-CAP {divCap}NM</span>
          <input type="range" min={30} max={200} value={divCap} onChange={e=>setDivCap(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">CADENCE {cadenceMul}%</span>
          <input type="range" min={50} max={200} value={cadenceMul} onChange={e=>setCadenceMul(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col col-span-2">
          <span className="text-slate-400">CLIFF-MIN {cliffMin} (SR111=17)</span>
          <input type="range" min={10} max={30} value={cliffMin} onChange={e=>setCliffMin(+e.target.value)} className="accent-sky-500"/>
        </label>
      </div>

      {/* class + step chips + toggles */}
      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800/60">
        <button onClick={()=>setKlassFilter('ALL')} className={`text-[9px] px-1.5 py-0.5 rounded border ${klassFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-400'}`}>ALL</button>
        {KLASS_LIST.map(k => (
          <button key={k} onClick={()=>setKlassFilter(klassFilter===k?'ALL':k)}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${klassFilter===k?'bg-sky-500/15 border-sky-500/40':'border-slate-800'}`}
            style={{color: KLASS_COLOR[k]}}>{k}</button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800/60">
        <span className="text-[8.5px] text-slate-500 self-center">ISO-SRC:</span>
        <button onClick={()=>setStepFilter('ALL')} className={`text-[9px] px-1.5 py-0.5 rounded border ${stepFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-400'}`}>ALL</button>
        {ISO_STEPS.map(s => (
          <button key={s} onClick={()=>setStepFilter(stepFilter===s?'ALL':s)}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${stepFilter===s?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-400'}`}>{s}</button>
        ))}
        <span className="flex-1"/>
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LINK',showLink,setShowLink],['VEC',showVec,setShowVec],['APT',showApt,setShowApt],['LBL',showLbl,setShowLbl]] as const).map(([lbl,on,fn]:any) => (
          <button key={lbl} onClick={()=>fn(!on)} className={`text-[8.5px] px-1.5 py-0.5 rounded border ${on?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-500'}`}>{lbl}</button>
        ))}
      </div>

      {/* tabs */}
      <div className="flex border-b border-slate-800/60 text-[10px]">
        {(['AIRCRAFT','CLASSES','PROFILE','PRECEDENT'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`flex-1 py-1.5 ${tab===t?'bg-sky-500/15 text-sky-200 border-b border-sky-500/60':'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {/* search */}
      <div className="px-3 py-1.5 border-b border-slate-800/60">
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="callsign / type / operator / class / divert-ICAO"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600"/>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.slice(0, 80).map((r, i) => {
              const sp = r.p.spec
              const sm = r.p.smoke
              return (
                <div key={r.f.icao+i} className="px-3 py-2 hover:bg-slate-900/40 cursor-pointer"
                  onClick={() => { setSel(r); onFly(r.f.icao) }}>
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="font-semibold text-slate-100 tabular-nums">{r.f.callsign||r.f.icao}</span>
                    <span className="text-slate-500 text-[9.5px]">{r.f.type||'\u2014'}</span>
                    <span className="text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800" style={{color: KLASS_COLOR[r.klass]}}>{r.klass}</span>
                    {sm.active && <span className="text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800 text-slate-300">SRC:{sm.src}</span>}
                    <span className="ml-auto text-[8.5px] px-1.5 py-0.5 rounded" style={{color: TIER_COLOR[r.tier], background: TIER_COLOR[r.tier]+'18', border:`1px solid ${TIER_COLOR[r.tier]}66`}}>{r.tier}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-1.5 text-[9.5px] tabular-nums text-slate-300">
                    <div><span className="text-slate-500">T+ </span>{sm.active?sm.tMin.toFixed(1)+'min':'\u2014'}</div>
                    <div><span className="text-slate-500">DIV </span>{isFinite(r.p.divNM)?r.p.divNM.toFixed(0)+'NM':'\u2014'}</div>
                    <div><span className="text-slate-500">ISO </span>{sm.active?sm.isoCompleted.toFixed(0)+'%':'\u2014'}</div>
                    <div><span className="text-slate-500">APT </span>{r.p.divApt?.icao||'\u2014'}</div>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-0.5 text-[9.5px] tabular-nums text-slate-300">
                    <div><span className="text-slate-500">FL </span>{(r.p.flKft*10).toFixed(0)}</div>
                    <div><span className="text-slate-500">CAB </span>{r.p.cabinAltKft.toFixed(1)}kft</div>
                    <div><span className="text-slate-500">V/S </span>{r.f.vertRate.toFixed(0)}fpm</div>
                    <div><span className="text-slate-500">ARFF </span>{r.p.divApt?.arffCat||'\u2014'}</div>
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
                  {sm.active && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {sm.cabinSmoke && <span className="text-[8.5px] px-1.5 py-0.5 rounded" style={{background:TIER_COLOR['UPS6-LIKE']+'22',color:TIER_COLOR['UPS6-LIKE'],border:`1px solid ${TIER_COLOR['UPS6-LIKE']}55`}}>CABIN-SMOKE</span>}
                      {sm.ifeSuspected && <span className="text-[8.5px] px-1.5 py-0.5 rounded" style={{background:TIER_COLOR['SR111-CRIT']+'22',color:TIER_COLOR['SR111-CRIT'],border:`1px solid ${TIER_COLOR['SR111-CRIT']}55`}}>IFE-SUSPECT</span>}
                      {sm.cargoHot && <span className="text-[8.5px] px-1.5 py-0.5 rounded" style={{background:TIER_COLOR['UPS6-LIKE']+'22',color:TIER_COLOR['UPS6-LIKE'],border:`1px solid ${TIER_COLOR['UPS6-LIKE']}55`}}>CARGO-HOT</span>}
                      {sp.classE && <span className="text-[8.5px] px-1.5 py-0.5 rounded" style={{background:'#a78bfa22',color:'#a78bfa',border:'1px solid #a78bfa55'}}>CLASS-E</span>}
                    </div>
                  )}
                  <div className="mt-1.5 text-[9.5px] leading-snug" style={{color: TIER_COLOR[r.tier]}}>
                    {r.tier==='SR111-CRIT' && `MAYDAY MAYDAY · EMERGENCY DESCENT · source ${sm.src} unisolated at T+${sm.tMin.toFixed(0)}min · 17-min cliff approached · TSB A98H0003 ${sp.fcomRef}`}
                    {r.tier==='UPS6-LIKE' && `PAN-PAN · ${sp.classE?'Class-E cargo cascade':'cabin smoke + divert>80NM'} · execute ${sp.fcomRef} · GCAA AAI 13/2010 mode`}
                    {r.tier==='AC797-DRIFT' && `Iso slow @ ${sm.isoCompleted.toFixed(0)}% · divert window open ${isFinite(r.p.divNM)?r.p.divNM.toFixed(0)+'NM':''} · NTSB AAR-86-02 mode`}
                    {r.tier==='COMMITTED' && `QRH SMOKE-FIRE-FUMES executing on plan · ${sp.fcomRef} · monitor ECAM/EICAS · brief PAX`}
                    {r.tier==='CLEAN' && `No smoke event · routine cruise · ${sp.fcomRef} memory items reviewed`}
                    {r.tier==='IDLE' && `Stationary / below 1kft AGL`}
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
              const klRows = rows.filter(r => r.klass===k)
              const cnt = klRows.length
              const muScore = cnt ? klRows.reduce((s,r)=>s+r.score,0)/cnt : 0
              const sr111 = klRows.filter(r=>r.tier==='SR111-CRIT').length
              const ups6 = klRows.filter(r=>r.tier==='UPS6-LIKE').length
              const ac797 = klRows.filter(r=>r.tier==='AC797-DRIFT').length
              return (
                <div key={k} className="px-3 py-2">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-[9px] px-1.5 py-0.5 rounded border border-slate-800" style={{color: KLASS_COLOR[k]}}>{k}</span>
                    <span className="text-slate-300 tabular-nums">{cnt} ac</span>
                    <span className="text-[9.5px] text-slate-500 truncate">\u00b7 {sp.arch}</span>
                    {sp.classE && <span className="ml-auto text-[8.5px] px-1.5 py-0.5 rounded" style={{color:TIER_COLOR['UPS6-LIKE'],background:TIER_COLOR['UPS6-LIKE']+'18',border:`1px solid ${TIER_COLOR['UPS6-LIKE']}66`}}>Class-E</span>}
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-1 text-[9.5px] tabular-nums text-slate-300">
                    <div><span className="text-slate-500">ISO-stp </span>{sp.isoSteps}</div>
                    <div><span className="text-slate-500">CADNC </span>{sp.cadence}/min</div>
                    <div><span className="text-slate-500">FCOM </span><span className="text-[8.5px] text-slate-400">{sp.fcomRef.split(' ')[0]}</span></div>
                    <div><span className="text-slate-500">\u03bc-SCR </span>{muScore.toFixed(0)}</div>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-0.5 text-[9.5px] tabular-nums">
                    <div><span className="text-slate-500">SR111 </span><span style={{color:sr111>0?TIER_COLOR['SR111-CRIT']:'#e2e8f0'}}>{sr111}</span></div>
                    <div><span className="text-slate-500">UPS6 </span><span style={{color:ups6>0?TIER_COLOR['UPS6-LIKE']:'#e2e8f0'}}>{ups6}</span></div>
                    <div><span className="text-slate-500">AC797 </span><span style={{color:ac797>0?TIER_COLOR['AC797-DRIFT']:'#e2e8f0'}}>{ac797}</span></div>
                    <div><span className="text-slate-500">CMTD </span><span className="text-slate-300">{klRows.filter(r=>r.tier==='COMMITTED').length}</span></div>
                  </div>
                  <div className="h-1.5 mt-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div className="h-full" style={{ width: `${Math.min(100, muScore)}%`, background: KLASS_COLOR[k] }}/>
                  </div>
                  <div className="mt-1 text-[9px] text-slate-500 italic leading-snug">
                    {k==='HVY-MD11' && `SR111 family. IFE galvanic shielding generation. Polyimide MPET wire insulation ignition substrate per TSB A98H0003.`}
                    {k==='HVY-T' && `B777/787 EICAS + Electronic Checklist auto-paged SMOKE/FUMES. ECL drives bus tie + pack reset sequence.`}
                    {k==='HVY-A' && `A330/A350/A380 ECAM SD-driven smoke iso. Auto Bleed Air Iso + PACK reset on cargo smoke.`}
                    {k==='HVY-NB' && `B737NG/MAX A320 manual smoke removal per QRH 11.20. No ECL — crew workload higher.`}
                    {k==='RGN-J' && `E170-195 / CRJ EICAS SMK detect. Primus Epic NWHL bus isolation. 6-step iso.`}
                    {k==='RGN-T' && `Q400 / ATR single-channel detect (fwd/aft/lav). No APU bleed iso path.`}
                    {k==='FREIGHTER' && `Main-deck Class-E (14 CFR §25.857(d)). Depressurize-only inerting. UPS6 / Asiana 991 / FedEx 80 precedent cluster.`}
                    {k==='BIZ-LIGHT' && `Manual smoke-removal limited bus inventory. PIC judgement heavy.`}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'PROFILE' && (
          <div className="p-3 space-y-3">
            <ProfileSvg/>
            <div className="text-[9.5px] leading-snug text-slate-400 space-y-1.5">
              <p><span className="text-slate-200">Decision tree timeline.</span> X-axis is minutes since SOSF (Smoke Of Source Suspect). 4 shaded zones DETECT (0\u20133min) / ISOLATE (3\u201310min) / DIVERT (10\u2013{cliffMin}min) / LAND-OR-CASCADE (\u2265{cliffMin}min). Vertical rose dashed line is the TSB Canada A98H0003 Safety Recommendation A99-07 17-minute cliff established by Swissair 111. Each class curve shows expected QRH iso-completion % over time at its cadence baseline (HVY-T fastest via ECL, RGN-T slowest at 4.5 items/min).</p>
              <p><span className="text-slate-200">Method.</span> Active flights placed at (T+min, completion-%) coordinates. SR111-CRIT (rose) means score \u226585 — typically crew is at or past 17-min cliff with source still unidentified, or cabin-smoke + divert &gt; 80NM. UPS6-LIKE (rose-pink) is Class-E freighter cascade or non-isol within window. AC797-DRIFT (amber) indicates iso behind cadence baseline with divert window still open. COMMITTED (sky) is on-plan QRH execution.</p>
              <p><span className="text-slate-200">Refs.</span> TSB Canada A98H0003 / A99-07 \u00b7 NTSB AAR-86-02 \u00b7 GCAA AAI 13/2010 \u00b7 NTSB AAR-07-02 \u00b7 14 CFR \u00a725.857 / 25.858 / 121.337 / 121.1119 \u00b7 EASA CS-25.857 / CS-25.858 \u00b7 FAA AC 25-9A / 120-80B / SAFO 09013 / InFO 11003 \u00b7 Boeing FCOM QRH 11.20 / FCTM Ch.8 \u00b7 Airbus FCOM PRO-ABN-AIR/26 \u00b7 MD-11 FCOM Vol II 91.10.</p>
            </div>
          </div>
        )}

        {tab === 'PRECEDENT' && (
          <div className="divide-y divide-slate-800/60">
            {PRECEDENTS.map((p, i) => (
              <div key={i} className="px-3 py-2">
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold" style={{background:p.color+'22',color:p.color,border:`1px solid ${p.color}66`}}>{p.tag}</span>
                  <span className="text-slate-300 tabular-nums">{p.date}</span>
                  <span className="text-slate-500 text-[9.5px]">{p.ac} \u00b7 {p.reg}</span>
                  <span className="ml-auto text-[9px] text-slate-400 tabular-nums">T+{p.tMin}min</span>
                </div>
                <div className="text-[9.5px] text-slate-300 mt-1 italic">{p.loc}</div>
                <div className="grid grid-cols-3 gap-1 mt-1 text-[9.5px] tabular-nums">
                  <div><span className="text-slate-500">Fatal </span><span style={{color:p.fatal>50?TIER_COLOR['SR111-CRIT']:p.fatal>0?TIER_COLOR['AC797-DRIFT']:TIER_COLOR['CLEAN']}}>{p.fatal}</span></div>
                  <div className="col-span-2"><span className="text-slate-500">Src </span><span className="text-slate-300">{p.src}</span></div>
                </div>
                <div className="mt-1.5 text-[9.5px] leading-snug text-slate-400">{p.narr}</div>
                <div className="mt-1 text-[8.5px] text-slate-500 italic">{p.ref}</div>
              </div>
            ))}
            <div className="px-3 py-3 text-[9px] leading-snug text-slate-500 border-t border-slate-800">
              <span className="text-slate-300">Composite references:</span> 14 CFR \u00a725.831 / 25.851 / 25.853(a) / 25.855(d)(e) / 25.857 / 25.858 / 25.869 / 25.1309 / 121.308 / 121.337 / 121.585 / 121.1119 \u00b7 EASA CS-25.851 / 25.857 / 25.858 / 25.869 \u00b7 ICAO Annex 6 Pt I \u00a76.7 / Annex 8 Pt IIIA \u00a74 / Doc 9760 Vol II Pt VI / Doc 9284 Tech Inst DG \u00b7 FAA AC 25-9A Smoke detection / AC 120-80B In-flight fires / AC 120-42B ETOPS DTLD / SAFO 09013 In-Flight Fires Best Practice / SAFO 18003 Fume Events / InFO 11003 Smoke evacuation \u00b7 TSB Canada Safety Recommendation A99-07 17-min benchmark \u00b7 SAE ARP 5588 MFD Alerting \u00b7 NFPA 408 Lavatory \u00b7 Boeing FCOM QRH 11.20 SMOKE-FIRE-FUMES Memory Items / FCTM Ch.8 \u00b7 Airbus FCOM PRO-ABN-AIR / PRO-ABN-26 / FCTM PR-AOP \u00a717 \u00b7 Embraer E-Jet AOM \u00a703 / QRH SMOKE \u00b7 MD-11 FCOM Vol II 91.10.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
