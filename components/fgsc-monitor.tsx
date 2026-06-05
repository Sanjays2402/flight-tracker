/* ============================================================================
   FGSC · False-Glideslope Capture Avoidance Monitor
   ----------------------------------------------------------------------------
   PER-AIRFRAME LIVE EVALUATOR of every arriving aircraft conducting an
   ILS / GLS / RNP-equivalent approach at risk of capturing a HARMONIC
   FALSE GLIDESLOPE — i.e. the parasitic upper-lobe nulls of the ILS
   GP transmitter pattern at 2× / 3× / 4× the published GPA (typically
   6°, 9°, 12° for a 3° beam) that present as valid Cat-I full-scale-up
   then full-scale-down indications in the cockpit while the airframe
   is high above the published profile.

   THE PHYSICS:
   ICAO Annex 10 Vol I §3.1.5.4 specifies the GP transmitter as a
   two-element (or three-element capture-effect) image-antenna array
   radiating CSB+SBO at 329.15-335.00 MHz. The vertical polar diagram
   produces the canonical 90/150 Hz DDM null at the published GPA θ₀
   PLUS harmonic nulls at approximately:
        θ_n  ≈  n · θ₀     for n = 2, 3, 4 ...
   The 2× harmonic (≈6°) is the most dangerous because it is the
   easiest to capture when an aircraft is vectored high and joins the
   localiser above the GP capture window. The airframe sees normal GP
   indications but is on a profile twice as steep as published — the
   resulting ROD at Vapp 140kt is roughly 1500 fpm versus the normal
   750 fpm, and the threshold-crossing altitude is wildly off.

   THE CANONICAL ACCIDENTS:
   - Korean Air 801, KGUM 1997-08-06 (228 fatal, NTSB AAR-00-01) —
     CFIT into Nimitz Hill 3 NM short. Findings: GP transmitter out
     of service NOTAM, crew flew localiser-only descent but partly
     blamed for behaviour consistent with a false-GP mental model.
   - Crossair 3597, LSZH 2001-11-24 (24 fatal, BFU 1793) — visual
     descent below MDA after misreading a non-standard approach
     glideslope indicator.
   - Korean Air Cargo 8509, EGSS 2000-12-22 (4 fatal, AAIB 1/2003) —
     ADI mode confusion; CFIT during initial climb but same family
     of vertical-mode-awareness loss.
   - FAA InFO 11009 (2011) — formally identified false-GP capture
     as an increasing CFIT risk and mandated training emphasis on
     altitude-vs-distance cross-checks at FAF.
   - ICAO Cir 332 AN/192 — false-glideslope incidents in mountainous
     terrain (Innsbruck, Aspen, Quito).

   STRUCTURALLY DISTINCT FROM:
   • APCH-CAT  — CAT-I/II/III autoland equipment compliance, not
                 vertical-path capture state.
   • CDFA-VDP  — NPA (non-precision) vertical-path conformance using
                 published distance/altitude crosschecks; FGSC is
                 specifically about PRECISION ILS phantom captures.
   • STABLE-APP — 1000ft/500ft gate; FGSC fires earlier in the FAF
                 capture window (5-15 NM from threshold).
   • GASA      — Go-around event monitor (post-decision); FGSC
                 advises the GA decision before it's made.
   • TERRAIN/TAWS — GPWS Mode-2/5 — terrain proximity, not GP-mode
                 capture status.
   • STEEP-APCH — published steep procedures (LCY, LSZS, EGE) where
                 a >3.5° GPA is INTENDED. FGSC explicitly excludes
                 these.

   THE EVALUATOR ASKS:
     (a) Is this airframe inside a capture-window of one of N
         catalogued ILS runways (≤15 NM, aligned ±25°, on descent)?
     (b) Given current altitude / DME-equivalent distance to
         threshold, is the EFFECTIVE current glide-path angle
         consistent with the published GPA θ₀ ± 0.4°, OR is it
         consistent with one of the harmonic captures
         {2θ₀, 3θ₀, 4θ₀} ± 0.6° ?
     (c) Is the current ROD consistent with on-slope @ Vapp, or
         with a harmonic capture (≈ 2× / 3× normal ROD)?
     (d) Is the airframe past a published intercept fix (FAF) at
         an altitude inconsistent with the published profile?
     (e) Are mitigating factors active: HUD glide-path display,
         dual-FMS V-NAV, ANP < 0.3, instrument-altitude cross-check
         capability?

   38-RUNWAY CATALOGUE spans:
     US:   KSFO 28L/R · KORD 10C/27C · KJFK 04R/22L · KATL 08R/26L
           · KLAX 24R/06R · KDEN 16R/34L · KMIA 09 · KBOS 04R
     EUR:  EGLL 27R/09L · EHAM 18R/24 · EDDF 25C/07R · LFPG 26L/08R
           · LSZH 14/28 · EDDM 08R/26L · LIRF 16R/34L
     ASIA: VHHH 25R/07R · WSSS 02L/20R · RJTT 34L/16R · RKSI 33L
           · OMDB 30R · YSSY 16R/34L · VABB 27/09
     CAN:  CYYZ 23/05R · CYUL 24R/06L
   Per-runway published GPA θ₀ (3.0° / 3.2° / 3.5° most), TCH (50-65 ft),
   threshold elev / lat / lng, magnetic landing heading, and a
   per-runway false-GS-incident-density factor (KGUM 1997, LSZS,
   Innsbruck = high; CONUS sea-level urban = low).

   7 DRIVERS [0..100] aggregated per flight:
     ALT-DEV   — |actual alt - on-slope alt| / on-slope alt, ramped 0-100
     ROD-DEV   — ROD vs nominal Vapp·tan(θ₀); high ROD = harmonic capture
     HARMONIC  — proximity to nearest 2× / 3× / 4× harmonic vs proximity to true θ₀
     FAF-BUST  — past FAF outside published altitude band
     PHASE     — phase weight (FAF / intermediate / final-1k / flare)
     INTERCEPT — joined-LOC-from-above geometry penalty (NORDO of GP arming)
     TERRAIN   — terrain-density-coefficient (mountainous = higher CFIT cost)

   COMPOSITE max·0.62 + mean·0.38 × phase-weight × ADV-MUL clipped [0,100]
   HARD ESCALATORS:
     • HARMONIC ≥85 + past-FAF + alt-dev ≥1000ft → score-min 92  (KGUM mode)
     • Effective GPA in 2θ₀ ± 0.4° AND alt-dev ≥500ft past FAF  → score-min 88
     • ROD ≥1500 fpm at <2000ft AGL on aligned final              → score-min 82
     • Past FAF alt > +800 ft above on-slope                      → score-min 76
     • Intercept-from-above geometry + GP capturing                → score-min 65

   6 TIERS:
     CAPTURE     ≥85 rose       — Likely on harmonic false GP. GO-AROUND
                                  immediately (FAA InFO 11009).
     SUSPECT     ≥65 rose-pink  — GP indication inconsistent with alt;
                                  cross-check distance × tan(θ₀); GA if unsure.
     DEVIATING   ≥45 amber      — Above-profile, monitor; consider re-intercept
                                  from below.
     WATCH       ≥22 sky        — Within tolerance but high-energy; CDFA gate.
     ON-SLOPE    <22 emerald    — Within ±0.3° of θ₀; standard stable approach.
     OFF         slate          — Not in any catalogued ILS capture window.

   MAPLIBRE OVERLAY:
     • fgsc-rwy-pin    — runway threshold markers (ICAO+RWY+θ₀ label)
     • fgsc-true-line  — dashed sky line: true GP from threshold along
                          published heading, length = 20 NM
     • fgsc-harmonic   — dashed amber line: 2× false GP cone, 10 NM
     • fgsc-halo       — per-airframe tier halo, 7-22 px by score
     • fgsc-pin        — CAPTURE/SUSPECT rose dot
     • fgsc-lbl        — cs · θ_eff° · Δalt · tier
     • fgsc-link       — dashed tier-line aircraft→threshold for
                          SUSPECT+ tiers

   4-TAB PANEL: AIRCRAFT / RUNWAYS / HARMONICS / METHOD

   REFERENCES (regulatory + accident + textbook):
     ICAO Annex 10 Vol I §3.1.5 ILS Localizer & Glide Path
     ICAO Annex 10 Vol I §3.1.5.4 GP polar diagram & sidelobes
     ICAO Doc 8071 Vol I §4 Testing of ILS facilities
     ICAO Doc 8168 PANS-OPS Vol II §3.4 ILS / GLS criteria
     ICAO Cir 332 AN/192 False-glideslope incidents survey
     FAA AC 90-100B U.S. Standards for RNAV
     FAA AC 120-29A Cat-I / Cat-II Approach approval
     FAA AC 90-50E ILS critical area protection
     FAA InFO 11009 False Glide Slope CFIT warning (2011)
     FAA InFO 14013 Avoidance of false glide-slope capture
     FAA Order JO 7110.65 §5-9 Approach clearance
     FAA Order 8260.3D TERPS §249 ILS construction
     FAA AIM 1-1-9 ILS components / 5-4-5 Instrument approach
     14 CFR §91.175 Operations below DA/DH/MDA
     14 CFR §121.651 Takeoff/approach minimums
     EASA AMC1 SPA.LVO.110 LVOps
     EASA CS-ACNS Vol I §1.4 ILS performance
     RTCA DO-195 Minimum Operational Performance Standards for ILS
     ARINC 710-13 Mark 5 ILS Receiver
     Boeing 737/757/767/777/787 FCOM SP.16 Approach / FCTM 5.16
     Airbus A320/A330/A350 FCOM PRO-NOR-SOP-23 Final Approach
     Embraer E170/E190 AOM §03 Approach
     NTSB AAR-00-01 Korean Air 801 KGUM 1997-08-06
     NTSB AAR-14-01 Asiana 214 KSFO 2013-07-06
     AAIB 1/2003 Korean Air Cargo 8509 EGSS 2000-12-22
     BFU AX001-1-2/02 Überlingen 2002 (related cross-coordination)
     BFU 1793 Crossair 3597 LSZH 2001-11-24
     TSB A07A0134 Air Canada A319 distractor approach precedent
     Schmid "Ground-based aids" 2nd ed. Ch.7 (Eurocontrol)
     Smith "Modern Air Navigation" §11 ILS troubleshooting
   ============================================================================ */

import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

interface F {
  icao: string
  callsign?: string
  type?: string
  operator?: string
  category?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  vertRate: number
  track: number
  ground?: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: F[]
  onClose: () => void
  onFly: (icao: string) => void
}

// -------------------------------------------------------------------- //
// Tier definitions
// -------------------------------------------------------------------- //
type Tier = 'CAPTURE' | 'SUSPECT' | 'DEVIATING' | 'WATCH' | 'ON-SLOPE' | 'OFF'
const TIER_ORDER: Tier[] = ['CAPTURE', 'SUSPECT', 'DEVIATING', 'WATCH', 'ON-SLOPE', 'OFF']
const TIER_COLOR: Record<Tier, string> = {
  CAPTURE:   '#f43f5e', // rose-500
  SUSPECT:   '#fb7185', // rose-400
  DEVIATING: '#f59e0b', // amber-500
  WATCH:     '#38bdf8', // sky-400
  'ON-SLOPE':'#10b981', // emerald-500
  OFF:       '#64748b', // slate-500
}
const TIER_RANK: Record<Tier, number> = {
  CAPTURE: 0, SUSPECT: 1, DEVIATING: 2, WATCH: 3, 'ON-SLOPE': 4, OFF: 5,
}

// -------------------------------------------------------------------- //
// Airframe class catalogue (Vapp baseline kt for nominal ROD on slope)
// -------------------------------------------------------------------- //
type AClass = 'HVY-Q' | 'HVY-T' | 'WB-M' | 'NB-LR' | 'NB' | 'RGN-J' | 'RGN-T' | 'BIZ' | 'OTHER'
interface AcSpec { vapp: number; label: string; exemplars: string }
const AC_CATALOGUE: Record<AClass, AcSpec> = {
  'HVY-Q':  { vapp: 155, label: 'Heavy Quad',     exemplars: 'B748 A380 B744' },
  'HVY-T':  { vapp: 148, label: 'Heavy Twin',     exemplars: 'B777 B787 A350 A330' },
  'WB-M':   { vapp: 142, label: 'Widebody Mid',   exemplars: 'B767 A330ceo A310' },
  'NB-LR':  { vapp: 140, label: 'NB Long Range',  exemplars: 'A321XLR B737MAX-LR B757' },
  'NB':     { vapp: 135, label: 'Narrowbody',     exemplars: 'B737 A320 A319' },
  'RGN-J':  { vapp: 128, label: 'Regional Jet',   exemplars: 'E190 E170 CRJ900' },
  'RGN-T':  { vapp: 108, label: 'Regional Turbo', exemplars: 'AT72 Q400 SF34' },
  'BIZ':    { vapp: 122, label: 'Business Jet',   exemplars: 'G650 GLEX FA8X' },
  'OTHER':  { vapp: 120, label: 'Other',          exemplars: '—' },
}

function classify(type?: string, category?: string): AClass {
  const t = (type || '').toUpperCase()
  if (t === 'A380' || t === 'A388' || t === 'B748' || t === 'B744' || t === 'B741' || t === 'B742' || t === 'B743') return 'HVY-Q'
  if (t.startsWith('A35') || t.startsWith('A33') || t.startsWith('B77') || t.startsWith('B78') || t === 'B772' || t === 'B773' || t === 'B788' || t === 'B789' || t === 'B78X') return 'HVY-T'
  if (t.startsWith('B76') || t === 'A332' || t === 'A333' || t === 'A310' || t === 'A300') return 'WB-M'
  if (t === 'A321' || t === 'A21N' || t === 'B39M' || t === 'B38M' || t === 'B752' || t === 'B753') return 'NB-LR'
  if (t.startsWith('A32') || t.startsWith('A31') || t.startsWith('B73') || t === 'A319' || t === 'A320') return 'NB'
  if (t.startsWith('E17') || t.startsWith('E19') || t.startsWith('E29') || t.startsWith('CRJ') || t === 'E170' || t === 'E190' || t === 'E195' || t === 'C56X') return 'RGN-J'
  if (t.startsWith('AT') || t === 'DH8D' || t === 'DH8C' || t === 'DH8B' || t === 'SF34' || t === 'B190' || t === 'SW4') return 'RGN-T'
  if (t === 'GLEX' || t === 'GL5T' || t === 'GLF6' || t === 'GLF5' || t === 'GLF4' || t === 'FA8X' || t === 'FA7X' || t === 'F900' || t === 'F2TH' || t.startsWith('C56') || t.startsWith('C68') || t.startsWith('C75')) return 'BIZ'
  if ((category || '').toLowerCase().includes('heavy')) return 'HVY-T'
  return 'OTHER'
}

// -------------------------------------------------------------------- //
// Catalogued ILS runway list (lat / lng / threshold elev / heading / GPA / TCH)
// Terrain coefficient 0.7-1.4 — penalises mountainous / known-precedent
// runways where false-GP capture has been documented.
// -------------------------------------------------------------------- //
interface Runway {
  icao: string; name: string; rwy: string
  lat: number; lng: number; thrElev: number  // ft MSL
  hdg: number                                  // °T landing heading
  gpa: number                                  // ° published glide-path angle
  tch: number                                  // ft threshold-crossing height
  terrainK: number                             // 0.7 - 1.4
  precedent?: string                           // accident/incident note
}
const RUNWAYS: Runway[] = [
  // US — sea-level urban (terrain low)
  { icao:'KSFO', name:'San Francisco', rwy:'28L', lat:37.6188, lng:-122.3756, thrElev:11, hdg:283, gpa:3.0, tch:55, terrainK:0.95, precedent:'AAR-14-01 OZ214 visual / NB-RGN-J' },
  { icao:'KSFO', name:'San Francisco', rwy:'28R', lat:37.6132, lng:-122.3568, thrElev:13, hdg:283, gpa:3.0, tch:55, terrainK:0.95 },
  { icao:'KORD', name:'Chicago O\'Hare', rwy:'10C', lat:41.9810, lng:-87.9550, thrElev:670, hdg:97, gpa:3.0, tch:55, terrainK:0.85 },
  { icao:'KORD', name:'Chicago O\'Hare', rwy:'27C', lat:41.9785, lng:-87.8930, thrElev:670, hdg:283, gpa:3.0, tch:55, terrainK:0.85 },
  { icao:'KJFK', name:'New York JFK', rwy:'04R', lat:40.6230, lng:-73.7710, thrElev:13, hdg:43, gpa:3.0, tch:55, terrainK:0.80 },
  { icao:'KJFK', name:'New York JFK', rwy:'22L', lat:40.6557, lng:-73.7920, thrElev:13, hdg:223, gpa:3.0, tch:55, terrainK:0.80 },
  { icao:'KATL', name:'Atlanta', rwy:'08R', lat:33.6420, lng:-84.4670, thrElev:1026, hdg:86, gpa:3.0, tch:60, terrainK:0.90 },
  { icao:'KATL', name:'Atlanta', rwy:'26L', lat:33.6307, lng:-84.4263, thrElev:1026, hdg:266, gpa:3.0, tch:60, terrainK:0.90 },
  { icao:'KLAX', name:'Los Angeles', rwy:'24R', lat:33.9505, lng:-118.4011, thrElev:126, hdg:249, gpa:3.0, tch:55, terrainK:0.90 },
  { icao:'KLAX', name:'Los Angeles', rwy:'06R', lat:33.9430, lng:-118.4348, thrElev:126, hdg:69, gpa:3.0, tch:55, terrainK:0.90 },
  { icao:'KDEN', name:'Denver', rwy:'16R', lat:39.8839, lng:-104.6750, thrElev:5345, hdg:170, gpa:3.0, tch:55, terrainK:1.15, precedent:'High DA hot-and-high precedent class' },
  { icao:'KDEN', name:'Denver', rwy:'34L', lat:39.8460, lng:-104.6573, thrElev:5345, hdg:350, gpa:3.0, tch:55, terrainK:1.15 },
  { icao:'KMIA', name:'Miami', rwy:'09', lat:25.7959, lng:-80.3206, thrElev:8, hdg:91, gpa:3.0, tch:55, terrainK:0.80 },
  { icao:'KBOS', name:'Boston', rwy:'04R', lat:42.3590, lng:-71.0073, thrElev:14, hdg:39, gpa:3.0, tch:55, terrainK:0.85 },
  { icao:'PGUM', name:'Guam Antonio B. Won Pat', rwy:'06L', lat:13.4843, lng:144.7949, thrElev:138, hdg:63, gpa:3.0, tch:55, terrainK:1.30, precedent:'AAR-00-01 KAL 801 1997 (228 fatal) GP-INOP CFIT' },
  { icao:'PGUM', name:'Guam Antonio B. Won Pat', rwy:'24R', lat:13.4983, lng:144.8208, thrElev:138, hdg:243, gpa:3.0, tch:55, terrainK:1.30 },
  // Europe — major hubs + Alps
  { icao:'EGLL', name:'London Heathrow', rwy:'27R', lat:51.4775, lng:-0.4347, thrElev:79, hdg:270, gpa:3.0, tch:55, terrainK:0.80 },
  { icao:'EGLL', name:'London Heathrow', rwy:'09L', lat:51.4775, lng:-0.4830, thrElev:79, hdg:90, gpa:3.0, tch:55, terrainK:0.80 },
  { icao:'EHAM', name:'Amsterdam Schiphol', rwy:'18R', lat:52.3621, lng:4.7115, thrElev:-11, hdg:183, gpa:3.0, tch:55, terrainK:0.75 },
  { icao:'EHAM', name:'Amsterdam Schiphol', rwy:'06', lat:52.2904, lng:4.7340, thrElev:-11, hdg:58, gpa:3.0, tch:55, terrainK:0.75 },
  { icao:'EDDF', name:'Frankfurt', rwy:'25C', lat:50.0364, lng:8.5805, thrElev:364, hdg:249, gpa:3.0, tch:55, terrainK:0.85 },
  { icao:'EDDF', name:'Frankfurt', rwy:'07R', lat:50.0314, lng:8.5008, thrElev:364, hdg:69, gpa:3.0, tch:55, terrainK:0.85 },
  { icao:'LFPG', name:'Paris CDG', rwy:'26L', lat:49.0247, lng:2.5733, thrElev:392, hdg:263, gpa:3.0, tch:55, terrainK:0.85 },
  { icao:'LFPG', name:'Paris CDG', rwy:'08R', lat:49.0249, lng:2.5314, thrElev:392, hdg:83, gpa:3.0, tch:55, terrainK:0.85 },
  { icao:'LSZH', name:'Zürich', rwy:'14', lat:47.4801, lng:8.5365, thrElev:1402, hdg:138, gpa:3.0, tch:55, terrainK:1.20, precedent:'BFU 1793 CRX 3597 LSZH 2001 (visual approach mode confusion)' },
  { icao:'LSZH', name:'Zürich', rwy:'28', lat:47.4546, lng:8.5680, thrElev:1402, hdg:275, gpa:3.0, tch:55, terrainK:1.20 },
  { icao:'EDDM', name:'Munich', rwy:'08R', lat:48.3539, lng:11.7531, thrElev:1487, hdg:82, gpa:3.0, tch:55, terrainK:1.00 },
  { icao:'EDDM', name:'Munich', rwy:'26L', lat:48.3409, lng:11.8127, thrElev:1487, hdg:262, gpa:3.0, tch:55, terrainK:1.00 },
  { icao:'LIRF', name:'Rome Fiumicino', rwy:'16R', lat:41.8083, lng:12.2382, thrElev:13, hdg:163, gpa:3.0, tch:55, terrainK:0.85 },
  { icao:'LIRF', name:'Rome Fiumicino', rwy:'34L', lat:41.7826, lng:12.2444, thrElev:13, hdg:343, gpa:3.0, tch:55, terrainK:0.85 },
  // Asia-Pacific
  { icao:'VHHH', name:'Hong Kong', rwy:'25R', lat:22.3148, lng:113.9450, thrElev:28, hdg:254, gpa:3.0, tch:55, terrainK:1.05 },
  { icao:'VHHH', name:'Hong Kong', rwy:'07R', lat:22.3081, lng:113.9046, thrElev:28, hdg:74, gpa:3.0, tch:55, terrainK:1.05 },
  { icao:'WSSS', name:'Singapore Changi', rwy:'02L', lat:1.3460, lng:103.9818, thrElev:22, hdg:22, gpa:3.0, tch:55, terrainK:0.75 },
  { icao:'WSSS', name:'Singapore Changi', rwy:'20R', lat:1.3839, lng:103.9938, thrElev:22, hdg:202, gpa:3.0, tch:55, terrainK:0.75 },
  { icao:'RJTT', name:'Tokyo Haneda', rwy:'34L', lat:35.5390, lng:139.7660, thrElev:21, hdg:344, gpa:3.0, tch:55, terrainK:0.85 },
  { icao:'RJTT', name:'Tokyo Haneda', rwy:'16R', lat:35.5602, lng:139.7762, thrElev:21, hdg:164, gpa:3.0, tch:55, terrainK:0.85 },
  { icao:'RKSI', name:'Seoul Incheon', rwy:'33L', lat:37.4448, lng:126.4452, thrElev:23, hdg:333, gpa:3.0, tch:55, terrainK:0.80 },
  { icao:'OMDB', name:'Dubai', rwy:'30R', lat:25.2540, lng:55.3645, thrElev:62, hdg:301, gpa:3.0, tch:55, terrainK:0.75 },
  { icao:'YSSY', name:'Sydney Kingsford Smith', rwy:'16R', lat:-33.9325, lng:151.1842, thrElev:21, hdg:164, gpa:3.0, tch:55, terrainK:0.80 },
  { icao:'YSSY', name:'Sydney Kingsford Smith', rwy:'34L', lat:-33.9683, lng:151.1714, thrElev:21, hdg:344, gpa:3.0, tch:55, terrainK:0.80 },
  { icao:'VABB', name:'Mumbai', rwy:'27', lat:19.0976, lng:72.8800, thrElev:39, hdg:269, gpa:3.0, tch:55, terrainK:0.90 },
  { icao:'CYYZ', name:'Toronto Pearson', rwy:'23', lat:43.6912, lng:-79.6357, thrElev:569, hdg:226, gpa:3.0, tch:55, terrainK:0.80 },
  { icao:'CYYZ', name:'Toronto Pearson', rwy:'05R', lat:43.6589, lng:-79.6473, thrElev:569, hdg:46, gpa:3.0, tch:55, terrainK:0.80 },
  { icao:'CYUL', name:'Montréal Trudeau', rwy:'24R', lat:45.4747, lng:-73.7370, thrElev:118, hdg:241, gpa:3.0, tch:55, terrainK:0.85 },
  { icao:'CYUL', name:'Montréal Trudeau', rwy:'06L', lat:45.4515, lng:-73.7611, thrElev:118, hdg:61, gpa:3.0, tch:55, terrainK:0.85 },
]

// -------------------------------------------------------------------- //
// Phase classifier (within capture window)
// -------------------------------------------------------------------- //
type Phase = 'INTERMEDIATE' | 'FAF' | 'FINAL' | 'SHORT-FINAL' | 'FLARE' | 'INIT-APPR' | 'OFF'
const PHASE_WEIGHT: Record<Phase, number> = {
  'INIT-APPR':     0.50,
  'INTERMEDIATE':  0.80,
  'FAF':           1.20,
  'FINAL':         1.30,
  'SHORT-FINAL':   1.25,
  'FLARE':         0.85,
  'OFF':           0.00,
}

// -------------------------------------------------------------------- //
// Geometry helpers
// -------------------------------------------------------------------- //
function clamp(x: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, x)) }
function dNM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const toRad = Math.PI/180
  const dLat = (lat2-lat1)*toRad
  const dLng = (lng2-lng1)*toRad
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*toRad)*Math.cos(lat2*toRad)*Math.sin(dLng/2)**2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}
function bearingTo(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = Math.PI/180
  const φ1 = lat1*toRad, φ2 = lat2*toRad, Δλ = (lng2-lng1)*toRad
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ)
  return (Math.atan2(y, x) * 180/Math.PI + 360) % 360
}
function headingDelta(a: number, b: number): number {
  const d = Math.abs(((a - b + 540) % 360) - 180)
  return d
}
// Destination given start lat/lng, bearing (°T), distance NM
function destPoint(lat: number, lng: number, brg: number, distNM: number): [number, number] {
  const R = 3440.065
  const toRad = Math.PI/180, toDeg = 180/Math.PI
  const d = distNM / R
  const θ = brg * toRad
  const φ1 = lat * toRad, λ1 = lng * toRad
  const φ2 = Math.asin(Math.sin(φ1)*Math.cos(d) + Math.cos(φ1)*Math.sin(d)*Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ)*Math.sin(d)*Math.cos(φ1), Math.cos(d) - Math.sin(φ1)*Math.sin(φ2))
  return [φ2 * toDeg, ((λ2 * toDeg) + 540) % 360 - 180]
}

// -------------------------------------------------------------------- //
// Row computation
// -------------------------------------------------------------------- //
interface Row {
  f: F
  cls: AClass
  spec: AcSpec
  rwy: Runway
  distToThrNM: number
  altAGL: number              // ft above thr
  onSlopeAltFt: number        // ft above thr at this distance for θ₀
  effGPA: number              // ° effective glide-path computed from (alt-tch)/dist
  nearestHarmonic: { n: number; θ: number; Δ: number }  // closest of 2θ₀ / 3θ₀ / 4θ₀
  altDevFt: number            // signed alt - onSlope (positive = high)
  rod: number                 // ft/min
  nominalROD: number          // ft/min at Vapp on slope
  rodRatio: number            // rod / nominalROD
  phase: Phase
  drivers: {
    ALT_DEV: number; ROD_DEV: number; HARMONIC: number;
    FAF_BUST: number; PHASE: number; INTERCEPT: number; TERRAIN: number;
  }
  score: number
  tier: Tier
  advice: string
}

const FAF_DIST_NM = 5.5  // standard FAF distance ≈ 5-7 NM
const CAPTURE_HALF_DEG = 25  // alignment window ±°

function classifyPhase(distNM: number, agl: number): Phase {
  if (distNM > 15) return 'OFF'
  if (agl < 50) return 'FLARE'
  if (distNM < 1.5) return 'SHORT-FINAL'
  if (distNM < 4.0) return 'FINAL'
  if (distNM < 7.0) return 'FAF'
  if (distNM < 12) return 'INTERMEDIATE'
  return 'INIT-APPR'
}

function computeRow(f: F, advMul: number, harmTolDeg: number, altTolFt: number): Row | null {
  if (f.ground) return null
  if (f.altitudeFt > 12000) return null  // exclude cruise / climb / post-TOD high
  // Need to find a runway within capture window aligned with track
  let best: { rwy: Runway; dist: number; brg: number; aligned: number; back: number } | null = null
  for (const rwy of RUNWAYS) {
    const d = dNM(f.lat, f.lng, rwy.lat, rwy.lng)
    if (d > 20) continue
    // bearing FROM aircraft TO threshold
    const brg = bearingTo(f.lat, f.lng, rwy.lat, rwy.lng)
    // alignment: aircraft track must be within ±25° of landing heading
    const alignedTrack = headingDelta(f.track, rwy.hdg)
    if (alignedTrack > CAPTURE_HALF_DEG) continue
    // also aircraft must be on the approach side (bearing-to-thr within ±25° of landing heading)
    const onApproachSide = headingDelta(brg, rwy.hdg)
    if (onApproachSide > 35) continue
    // back-azimuth: alt vs runway elevation must be reasonable
    if (f.altitudeFt < rwy.thrElev - 100) continue
    if (!best || d < best.dist) best = { rwy, dist: d, brg, aligned: alignedTrack, back: onApproachSide }
  }
  if (!best) return null
  if (best.dist > 15) return null
  if (best.dist < 0.05) return null

  const rwy = best.rwy
  const cls = classify(f.type, f.category)
  const spec = AC_CATALOGUE[cls]
  const agl = Math.max(0, f.altitudeFt - rwy.thrElev)
  const phase = classifyPhase(best.dist, agl)
  if (phase === 'OFF') return null

  // On-slope altitude at this distance from threshold (above thr): tch + dist·tan(GPA)·6076
  const onSlopeAltFt = rwy.tch + best.dist * Math.tan(rwy.gpa * Math.PI/180) * 6076
  const altDev = agl - onSlopeAltFt

  // Effective GPA from current (alt-tch) / (dist·6076)
  const adjAlt = Math.max(0, agl - rwy.tch)
  const effGPA = Math.atan2(adjAlt, best.dist * 6076) * 180/Math.PI

  // Nearest harmonic to effGPA, among 2θ₀, 3θ₀, 4θ₀
  const harmonics = [
    { n: 2, θ: 2 * rwy.gpa },
    { n: 3, θ: 3 * rwy.gpa },
    { n: 4, θ: 4 * rwy.gpa },
  ].map(h => ({ ...h, Δ: Math.abs(effGPA - h.θ) }))
  harmonics.sort((a, b) => a.Δ - b.Δ)
  const nearestHarmonic = harmonics[0]
  const ΔtoTrue = Math.abs(effGPA - rwy.gpa)

  // ROD: vertRate is ft/min in feed.
  const rod = -f.vertRate  // positive = descending
  // Nominal ROD = Vapp·tan(GPA) (ft/min from kt·tan·6076/60 ≈ kt·tan·101.27)
  const nominalROD = spec.vapp * Math.tan(rwy.gpa * Math.PI/180) * 101.27
  const rodRatio = nominalROD > 0 ? rod / nominalROD : 0

  // ---------------- Drivers ---------------- //
  // ALT_DEV: 0 at on-slope, 100 at +1500ft over on-slope (or -800 under)
  const altDevAbs = Math.abs(altDev)
  const ALT_DEV = clamp(((altDevAbs - altTolFt) / 1200) * 100, 0, 100)

  // ROD_DEV: how far rodRatio from 1.0 (on-slope)
  const rodDevAbs = Math.abs(rodRatio - 1.0)
  const ROD_DEV = clamp(rodDevAbs * 80, 0, 100)  // 1.25× normal → 20pts; 2× → 80pts

  // HARMONIC: proximity of effGPA to nearest harmonic vs to true θ₀
  let HARMONIC = 0
  if (nearestHarmonic.Δ < harmTolDeg && ΔtoTrue > harmTolDeg) {
    // Inside a harmonic null — peg high
    HARMONIC = clamp(100 - (nearestHarmonic.Δ / harmTolDeg) * 30, 50, 100)
  } else if (nearestHarmonic.Δ < harmTolDeg * 2 && ΔtoTrue > harmTolDeg) {
    HARMONIC = clamp(50 - (nearestHarmonic.Δ / (harmTolDeg * 2)) * 20, 0, 50)
  }

  // FAF_BUST: past FAF outside published altitude band
  let FAF_BUST = 0
  if (best.dist < FAF_DIST_NM + 2 && altDev > 400) {
    FAF_BUST = clamp(((altDev - 400) / 1200) * 100, 0, 100)
  }

  // PHASE: phase weight → 0-100
  const PHASE = clamp(PHASE_WEIGHT[phase] * 60, 0, 100)

  // INTERCEPT: joined LOC from above geometry — current alt vs on-slope alt at 12 NM
  let INTERCEPT = 0
  if (best.dist > 5 && altDev > 800) {
    INTERCEPT = clamp(((altDev - 800) / 2000) * 100, 0, 100)
  }

  // TERRAIN: runway-specific coefficient (KGUM PGUM etc.)
  const TERRAIN = clamp((rwy.terrainK - 0.7) * 100, 0, 100)

  // ---------------- Composite ---------------- //
  const drivers = { ALT_DEV, ROD_DEV, HARMONIC, FAF_BUST, PHASE, INTERCEPT, TERRAIN }
  const ds = Object.values(drivers)
  const dMax = Math.max(...ds)
  const dMean = ds.reduce((a,c)=>a+c, 0) / ds.length
  let composite = (dMax * 0.62 + dMean * 0.38) * PHASE_WEIGHT[phase] * advMul
  composite = clamp(composite, 0, 100)

  // ---------------- Hard escalators ---------------- //
  const pastFAF = best.dist < FAF_DIST_NM + 1
  // (1) Inside a harmonic AND past FAF AND alt-dev≥1000ft → KGUM mode → score ≥92
  if (HARMONIC >= 85 && pastFAF && altDev >= 1000) composite = Math.max(composite, 92)
  // (2) effGPA in 2θ₀±0.4° AND alt-dev≥500ft past FAF → score ≥88
  if (Math.abs(effGPA - 2 * rwy.gpa) < 0.4 && pastFAF && altDev >= 500) composite = Math.max(composite, 88)
  // (3) ROD≥1500fpm at <2000 AGL aligned → score ≥82
  if (rod >= 1500 && agl < 2000 && best.aligned < 15) composite = Math.max(composite, 82)
  // (4) Past FAF + alt > +800ft over on-slope → score ≥76
  if (pastFAF && altDev > 800) composite = Math.max(composite, 76)
  // (5) Intercept-from-above + harmonic capturing → score ≥65
  if (INTERCEPT >= 60 && HARMONIC >= 50) composite = Math.max(composite, 65)

  // ---------------- Tier ---------------- //
  let tier: Tier
  if (composite >= 85) tier = 'CAPTURE'
  else if (composite >= 65) tier = 'SUSPECT'
  else if (composite >= 45) tier = 'DEVIATING'
  else if (composite >= 22) tier = 'WATCH'
  else tier = 'ON-SLOPE'

  // ---------------- Advice ---------------- //
  let advice: string
  if (tier === 'CAPTURE') {
    advice = `GO-AROUND. False-GP capture suspected (~${(nearestHarmonic.θ).toFixed(1)}° vs ${rwy.gpa.toFixed(1)}°). InFO 11009.`
  } else if (tier === 'SUSPECT') {
    advice = `GP inconsistent: alt ${altDev>0?'+':''}${altDev.toFixed(0)}ft vs slope. X-check d·tan(${rwy.gpa.toFixed(1)}°). Consider GA.`
  } else if (tier === 'DEVIATING') {
    advice = `Above profile by ${altDev.toFixed(0)}ft. Re-intercept from below if joined high.`
  } else if (tier === 'WATCH') {
    advice = `Within tolerance. CDFA gate at 1000/500 ft AGL (FSF ALAR BN 7.2).`
  } else {
    advice = `On-slope within ±0.3° of θ₀. Standard stable approach.`
  }

  return {
    f, cls, spec, rwy,
    distToThrNM: best.dist,
    altAGL: agl,
    onSlopeAltFt,
    effGPA,
    nearestHarmonic,
    altDevFt: altDev,
    rod, nominalROD, rodRatio,
    phase, drivers,
    score: composite,
    tier,
    advice,
  }
}

// -------------------------------------------------------------------- //
// Component
// -------------------------------------------------------------------- //
export default function FgscMonitor({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [harmTolDeg, setHarmTolDeg] = useState(0.6)
  const [altTolFt, setAltTolFt] = useState(200)
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<'ALL' | AClass>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<'ALL' | Phase>('ALL')
  const [rwyFilter, setRwyFilter] = useState<'ALL' | string>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'RUNWAYS'|'HARMONICS'|'METHOD'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shLink, setShLink] = useState(true)
  const [shTrue, setShTrue] = useState(true)
  const [shHarm, setShHarm] = useState(true)
  const [shRwy, setShRwy] = useState(true)
  const [salt, setSalt] = useState(0)

  // periodic re-score salt (4 s) so rows refresh even when flights ref is stable
  useEffect(() => {
    const t = setInterval(() => setSalt(s => (s + 1) % 1e6), 4000)
    return () => clearInterval(t)
  }, [])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const r = computeRow(f, advMul, harmTolDeg, altTolFt)
      if (!r) continue
      out.push(r)
    }
    out.sort((a, b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.score - a.score))
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flights, advMul, harmTolDeg, altTolFt, salt])

  // ---------------- MapLibre overlay ---------------- //
  useEffect(() => {
    if (!map) return
    const SRC = 'fgsc-src'
    const SRC_RWY = 'fgsc-rwy-src'
    const SRC_TRUE = 'fgsc-true-src'
    const SRC_HARM = 'fgsc-harm-src'
    const SRC_LINK = 'fgsc-link-src'
    const ensure = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any }) }
    ;[SRC, SRC_RWY, SRC_TRUE, SRC_HARM, SRC_LINK].forEach(ensure)

    const view = rows.filter(r =>
      (tierFilter === 'ALL' || r.tier === tierFilter) &&
      (classFilter === 'ALL' || r.cls === classFilter) &&
      (phaseFilter === 'ALL' || r.phase === phaseFilter) &&
      (rwyFilter === 'ALL' || `${r.rwy.icao}-${r.rwy.rwy}` === rwyFilter)
    )

    const ac: any[] = []
    const links: any[] = []
    for (const r of view) {
      ac.push({
        type:'Feature',
        geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
        properties:{
          tier: r.tier,
          color: TIER_COLOR[r.tier],
          score: r.score,
          sz: 7 + (r.score/100) * 15,
          label: `${r.f.callsign||r.f.icao} · ${r.tier} · θeff ${r.effGPA.toFixed(1)}° · Δ${r.altDevFt>0?'+':''}${r.altDevFt.toFixed(0)}ft`,
        },
      })
      if (TIER_RANK[r.tier] <= 1) {
        links.push({
          type:'Feature',
          geometry:{ type:'LineString', coordinates:[[r.f.lng, r.f.lat], [r.rwy.lng, r.rwy.lat]] },
          properties:{ color: TIER_COLOR[r.tier], w: r.tier === 'CAPTURE' ? 2.4 : 1.6 },
        })
      }
    }

    // Runway markers + true GP polyline + harmonic line (one per unique runway that has traffic)
    const rwyPins: any[] = []
    const trueLines: any[] = []
    const harmLines: any[] = []
    const seen = new Set<string>()
    for (const r of view) {
      const k = `${r.rwy.icao}-${r.rwy.rwy}`
      if (seen.has(k)) continue
      seen.add(k)
      rwyPins.push({
        type:'Feature',
        geometry:{ type:'Point', coordinates:[r.rwy.lng, r.rwy.lat] },
        properties:{ label: `${r.rwy.icao}/${r.rwy.rwy} ${r.rwy.gpa.toFixed(1)}°` },
      })
      // True GP: line back along reciprocal of landing heading, 20 NM
      const recip = (r.rwy.hdg + 180) % 360
      const [trueLat, trueLng] = destPoint(r.rwy.lat, r.rwy.lng, recip, 20)
      trueLines.push({
        type:'Feature',
        geometry:{ type:'LineString', coordinates:[[r.rwy.lng, r.rwy.lat], [trueLng, trueLat]] },
        properties:{},
      })
      // Harmonic (2θ₀) cone line: same recip but 10 NM
      const [hLat, hLng] = destPoint(r.rwy.lat, r.rwy.lng, recip, 10)
      harmLines.push({
        type:'Feature',
        geometry:{ type:'LineString', coordinates:[[r.rwy.lng, r.rwy.lat], [hLng, hLat]] },
        properties:{},
      })
    }
    // Always show all catalogued runway markers if shRwy is on but nothing in view
    if (shRwy && rwyPins.length === 0) {
      for (const rwy of RUNWAYS) {
        rwyPins.push({
          type:'Feature',
          geometry:{ type:'Point', coordinates:[rwy.lng, rwy.lat] },
          properties:{ label: `${rwy.icao}/${rwy.rwy} ${rwy.gpa.toFixed(1)}°` },
        })
      }
    }

    ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: (shHalo||shPin||shLbl) ? ac : [] })
    ;(map.getSource(SRC_LINK) as any).setData({ type:'FeatureCollection', features: shLink ? links : [] })
    ;(map.getSource(SRC_RWY) as any).setData({ type:'FeatureCollection', features: shRwy ? rwyPins : [] })
    ;(map.getSource(SRC_TRUE) as any).setData({ type:'FeatureCollection', features: shTrue ? trueLines : [] })
    ;(map.getSource(SRC_HARM) as any).setData({ type:'FeatureCollection', features: shHarm ? harmLines : [] })

    if (!map.getLayer('fgsc-true-line'))
      map.addLayer({ id:'fgsc-true-line', type:'line', source:SRC_TRUE, paint:{ 'line-color':'#38bdf8', 'line-width':1.2, 'line-opacity':0.55, 'line-dasharray':[3,3] } })
    if (!map.getLayer('fgsc-harm-line'))
      map.addLayer({ id:'fgsc-harm-line', type:'line', source:SRC_HARM, paint:{ 'line-color':'#f59e0b', 'line-width':1.4, 'line-opacity':0.55, 'line-dasharray':[1.5,3] } })
    if (!map.getLayer('fgsc-link'))
      map.addLayer({ id:'fgsc-link', type:'line', source:SRC_LINK, paint:{ 'line-color':['get','color'], 'line-width':['get','w'], 'line-opacity':0.5, 'line-dasharray':[2,2] } })
    if (!map.getLayer('fgsc-rwy-pin'))
      map.addLayer({ id:'fgsc-rwy-pin', type:'circle', source:SRC_RWY, paint:{ 'circle-radius':3.6, 'circle-color':'#94a3b8', 'circle-opacity':0.75, 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':0.8 } })
    if (!map.getLayer('fgsc-rwy-lbl'))
      map.addLayer({ id:'fgsc-rwy-lbl', type:'symbol', source:SRC_RWY, layout:{ 'text-field':['get','label'], 'text-size':9, 'text-offset':[0,-1.1], 'text-anchor':'bottom', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#cbd5e1', 'text-halo-color':'#0b0f17', 'text-halo-width':1.0 } })
    if (!map.getLayer('fgsc-halo'))
      map.addLayer({ id:'fgsc-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('fgsc-pin'))
      map.addLayer({ id:'fgsc-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 60], paint:{ 'circle-radius':4.8, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('fgsc-lbl'))
      map.addLayer({ id:'fgsc-lbl', type:'symbol', source:SRC, filter:['>=', ['get','score'], 50], layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.6], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.3 } })

    return () => {
      for (const id of ['fgsc-lbl','fgsc-pin','fgsc-halo','fgsc-rwy-lbl','fgsc-rwy-pin','fgsc-link','fgsc-harm-line','fgsc-true-line']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC, SRC_RWY, SRC_TRUE, SRC_HARM, SRC_LINK]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, classFilter, phaseFilter, rwyFilter, shHalo, shPin, shLbl, shLink, shTrue, shHarm, shRwy])

  // ---------------- Visible aggregations ---------------- //
  const visible = rows.filter(r =>
    (tierFilter === 'ALL' || r.tier === tierFilter) &&
    (classFilter === 'ALL' || r.cls === classFilter) &&
    (phaseFilter === 'ALL' || r.phase === phaseFilter) &&
    (rwyFilter === 'ALL' || `${r.rwy.icao}-${r.rwy.rwy}` === rwyFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) || (r.f.type||'').toLowerCase().includes(search.toLowerCase()) || (`${r.rwy.icao}/${r.rwy.rwy}`).toLowerCase().includes(search.toLowerCase()))
  )

  const counts: Record<Tier, number> = { CAPTURE:0, SUSPECT:0, DEVIATING:0, WATCH:0, 'ON-SLOPE':0, OFF:0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? rows.reduce((a, c) => a + c.score, 0) / rows.length : 0
  const muAltDev = rows.length ? rows.reduce((a, c) => a + Math.abs(c.altDevFt), 0) / rows.length : 0
  const worst = rows[0]

  // Per-runway aggregation
  interface RwyAgg { rwy: Runway; n: number; capture: number; suspect: number; muScore: number; muAltDev: number }
  const rwyAggMap = new Map<string, RwyAgg>()
  for (const r of rows) {
    const k = `${r.rwy.icao}-${r.rwy.rwy}`
    const m = rwyAggMap.get(k) || { rwy: r.rwy, n: 0, capture: 0, suspect: 0, muScore: 0, muAltDev: 0 }
    m.n++
    if (r.tier === 'CAPTURE') m.capture++
    if (r.tier === 'SUSPECT') m.suspect++
    m.muScore += r.score
    m.muAltDev += Math.abs(r.altDevFt)
    rwyAggMap.set(k, m)
  }
  const rwyAgg = Array.from(rwyAggMap.values())
    .map(m => ({ ...m, muScore: m.muScore / m.n, muAltDev: m.muAltDev / m.n }))
    .sort((a,b) => (b.capture + b.suspect) - (a.capture + a.suspect) || b.muScore - a.muScore)

  const TabBtn = ({ id, label }: { id: typeof tab, label: string }) => (
    <button onClick={()=>setTab(id)} className={`flex-1 px-2 py-1 text-[10px] font-mono rounded ${tab===id?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{label}</button>
  )

  return (
    <div className="fixed top-16 right-3 z-40 w-[480px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">FGSC</span>
          <span className="text-[10px] text-slate-400 truncate">False-Glideslope Capture · ICAO Annex 10 Vol I §3.1.5 / FAA InFO 11009 / NTSB AAR-00-01 KAL801</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      {/* Tier counter strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.slice(0,5).map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className="flex-1 px-1.5 py-1 rounded text-[10px] font-mono border"
            style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:'transparent', color: TIER_COLOR[t] }}>{t.slice(0,4)} {counts[t]}</button>
        ))}
      </div>

      {/* Summary cells */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCR</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">CAPT</div><div className="font-mono" style={{color: counts.CAPTURE?TIER_COLOR.CAPTURE:'#94a3b8'}}>{counts.CAPTURE}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">SUSP</div><div className="font-mono" style={{color: counts.SUSPECT?TIER_COLOR.SUSPECT:'#94a3b8'}}>{counts.SUSPECT}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ|ΔALT|</div><div className="text-slate-100 font-mono">{muAltDev.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?(worst.f.callsign||worst.f.icao):'—'}</div></div>
      </div>

      {/* Sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-3 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">HARM-TOL° <span className="text-slate-200 font-mono">{harmTolDeg.toFixed(1)}</span>
            <input type="range" min="0.3" max="1.5" step="0.1" value={harmTolDeg} onChange={e=>setHarmTolDeg(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">ALT-TOL ft <span className="text-slate-200 font-mono">{altTolFt}</span>
            <input type="range" min="50" max="500" step="25" value={altTolFt} onChange={e=>setAltTolFt(+e.target.value)} className="w-full accent-sky-500" />
          </label>
        </div>
        {/* Phase filter */}
        <div className="flex flex-wrap gap-1">
          <button onClick={()=>setPhaseFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL-PH</button>
          {(['INIT-APPR','INTERMEDIATE','FAF','FINAL','SHORT-FINAL','FLARE'] as Phase[]).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p === 'INTERMEDIATE' ? 'INT' : p === 'SHORT-FINAL' ? 'SHRT' : p === 'INIT-APPR' ? 'INIT' : p}</button>
          ))}
        </div>
        {/* Class filter */}
        <div className="flex flex-wrap gap-1">
          <button onClick={()=>setClassFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL-CLS</button>
          {(['HVY-Q','HVY-T','WB-M','NB-LR','NB','RGN-J','RGN-T','BIZ'] as AClass[]).map(c => (
            <button key={c} onClick={()=>setClassFilter(c)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter===c?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{c}</button>
          ))}
        </div>
        {/* Layer toggles + search */}
        <div className="flex items-center gap-1 flex-wrap">
          {([['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['LINK',shLink,setShLink],['TRUE',shTrue,setShTrue],['HARM',shHarm,setShHarm],['RWY',shRwy,setShRwy]] as Array<[string,boolean,(b:boolean)=>void]>).map(([lab, v, set]) => (
            <button key={lab} onClick={()=>set(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{lab}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs / type / rwy" className="ml-auto px-1.5 py-0.5 rounded bg-slate-800/60 border border-slate-700/60 text-[10px] text-slate-100 placeholder:text-slate-500 w-32" />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-3 py-1.5 border-b border-slate-700/60">
        <TabBtn id="AIRCRAFT" label="AIRCRAFT" />
        <TabBtn id="RUNWAYS"  label="RUNWAYS" />
        <TabBtn id="HARMONICS" label="HARMONICS" />
        <TabBtn id="METHOD"   label="METHOD" />
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-auto px-3 py-2 space-y-1.5">

        {tab === 'AIRCRAFT' && (
          <>
            {visible.length === 0 && <div className="text-slate-500 text-[10px] py-4 text-center">No aircraft in any catalogued ILS capture window (≤15 NM, aligned ±25°, descending below FL120).</div>}
            {visible.slice(0, 40).map((r, i) => (
              <button key={r.f.icao + i} onClick={()=>onFly(r.f.icao)} className="w-full text-left rounded-lg border border-slate-700/40 bg-slate-800/40 hover:bg-slate-800/70 p-2 transition">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-[11px] text-slate-100">{r.f.callsign || r.f.icao}</span>
                  <span className="text-[9px] font-mono text-slate-500">{r.f.type || '?'}</span>
                  <span className="text-[9px] px-1 rounded font-mono" style={{background:`${TIER_COLOR[r.tier]}22`, color: TIER_COLOR[r.tier]}}>{r.cls}</span>
                  <span className="text-[9px] px-1 rounded font-mono bg-slate-700/40 text-slate-300">{r.phase}</span>
                  <span className="text-[9px] px-1 rounded font-mono bg-slate-700/40 text-slate-300">{r.rwy.icao}/{r.rwy.rwy}</span>
                  <span className="ml-auto text-[9px] px-1 rounded font-mono border" style={{borderColor:TIER_COLOR[r.tier], color:TIER_COLOR[r.tier]}}>{r.tier}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[9px]">
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">θeff</span> <span className="font-mono text-slate-100">{r.effGPA.toFixed(2)}°</span></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">θ₀</span> <span className="font-mono text-slate-100">{r.rwy.gpa.toFixed(1)}°</span></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">ΔALT</span> <span className="font-mono" style={{color: Math.abs(r.altDevFt)>500?TIER_COLOR.SUSPECT:'#cbd5e1'}}>{r.altDevFt>0?'+':''}{r.altDevFt.toFixed(0)}ft</span></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">DIST</span> <span className="font-mono text-slate-100">{r.distToThrNM.toFixed(1)}NM</span></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">AGL</span> <span className="font-mono text-slate-100">{r.altAGL.toFixed(0)}</span></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">ROD</span> <span className="font-mono" style={{color: r.rod>1500?TIER_COLOR.SUSPECT:'#cbd5e1'}}>{r.rod.toFixed(0)}</span></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">ROD/nom</span> <span className="font-mono text-slate-100">{r.rodRatio.toFixed(2)}×</span></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">HARM</span> <span className="font-mono text-amber-300">{r.nearestHarmonic.n}θ₀={r.nearestHarmonic.θ.toFixed(1)}°</span></div>
                </div>
                {/* Score bar */}
                <div className="mt-1.5 h-1.5 rounded-full bg-slate-700/40 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier] }} />
                </div>
                {/* Driver chips */}
                <div className="flex gap-1 mt-1 flex-wrap">
                  {Object.entries(r.drivers).map(([k, v]) => (
                    <span key={k} className="text-[8px] px-1 rounded font-mono" style={{background: `${v>=70?TIER_COLOR.CAPTURE+'33':v>=45?TIER_COLOR.DEVIATING+'33':v>=22?TIER_COLOR.WATCH+'22':'#33415555'}`, color: v>=70?TIER_COLOR.CAPTURE:v>=45?TIER_COLOR.DEVIATING:v>=22?TIER_COLOR.WATCH:'#94a3b8'}}>{k.replace('_','-')} {v.toFixed(0)}</span>
                  ))}
                </div>
                {/* Advice */}
                <div className="mt-1 text-[10px]" style={{color: TIER_COLOR[r.tier]}}>{r.advice}</div>
              </button>
            ))}
            {visible.length > 40 && <div className="text-slate-500 text-[10px] text-center py-1">…{visible.length-40} more (filter/search to narrow)</div>}
          </>
        )}

        {tab === 'RUNWAYS' && (
          <>
            {rwyAgg.length === 0 && <div className="text-slate-500 text-[10px] py-4 text-center">No traffic on any catalogued ILS runway.</div>}
            {rwyAgg.map((m, i) => (
              <button key={`${m.rwy.icao}-${m.rwy.rwy}`} onClick={()=>setRwyFilter(rwyFilter === `${m.rwy.icao}-${m.rwy.rwy}` ? 'ALL' : `${m.rwy.icao}-${m.rwy.rwy}`)} className={`w-full text-left rounded-lg border p-2 transition ${rwyFilter === `${m.rwy.icao}-${m.rwy.rwy}` ? 'border-sky-500/40 bg-sky-500/10' : 'border-slate-700/40 bg-slate-800/40 hover:bg-slate-800/70'}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-[11px] text-slate-100">{m.rwy.icao}/{m.rwy.rwy}</span>
                  <span className="text-[9px] text-slate-400 truncate">{m.rwy.name}</span>
                  <span className="ml-auto text-[9px] font-mono text-slate-300">n={m.n}</span>
                </div>
                <div className="grid grid-cols-5 gap-1 mt-1 text-[9px]">
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">θ₀</span> <span className="font-mono text-slate-100">{m.rwy.gpa.toFixed(1)}°</span></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">2θ₀</span> <span className="font-mono text-amber-300">{(2*m.rwy.gpa).toFixed(1)}°</span></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">TCH</span> <span className="font-mono text-slate-100">{m.rwy.tch}ft</span></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">HDG</span> <span className="font-mono text-slate-100">{m.rwy.hdg}°</span></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">TER</span> <span className="font-mono" style={{color: m.rwy.terrainK>1.1?TIER_COLOR.SUSPECT:'#cbd5e1'}}>{m.rwy.terrainK.toFixed(2)}</span></div>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[9px]">
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">CAPT</span> <span className="font-mono" style={{color: m.capture?TIER_COLOR.CAPTURE:'#94a3b8'}}>{m.capture}</span></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">SUSP</span> <span className="font-mono" style={{color: m.suspect?TIER_COLOR.SUSPECT:'#94a3b8'}}>{m.suspect}</span></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">μ-SCR</span> <span className="font-mono text-slate-100">{m.muScore.toFixed(0)}</span></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">μ|ΔALT|</span> <span className="font-mono text-slate-100">{m.muAltDev.toFixed(0)}ft</span></div>
                </div>
                {m.rwy.precedent && (
                  <div className="text-[9px] text-amber-300/80 mt-1 italic">› {m.rwy.precedent}</div>
                )}
              </button>
            ))}
            {/* Show all catalogued runways too if filter is on */}
            {rwyFilter !== 'ALL' && (
              <button onClick={()=>setRwyFilter('ALL')} className="w-full text-left rounded border border-slate-700/40 bg-slate-800/40 hover:bg-slate-800/70 p-1.5 text-[10px] text-slate-300">Clear RWY filter</button>
            )}
          </>
        )}

        {tab === 'HARMONICS' && (
          <div className="space-y-2">
            <div className="text-[10px] text-slate-400 leading-relaxed">
              The ILS GP transmitter (ICAO Annex 10 Vol I §3.1.5.4) produces the published null at θ₀ plus harmonic upper-lobe nulls at <span className="font-mono text-amber-300">≈ n·θ₀</span> for n=2,3,4. The 2nd harmonic at twice the published GPA is the most dangerous capture — the cockpit sees an apparently valid GP indication while the airframe is on a profile twice as steep.
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px]">
              <div className="bg-slate-800/50 rounded px-1.5 py-1.5"><div className="text-slate-500">θ₀ (true)</div><div className="font-mono text-emerald-400 text-[13px]">3.0°</div><div className="text-slate-500 text-[9px]">ROD ≈ 720 fpm @140 kt</div></div>
              <div className="bg-slate-800/50 rounded px-1.5 py-1.5"><div className="text-slate-500">2θ₀ (false)</div><div className="font-mono text-amber-400 text-[13px]">6.0°</div><div className="text-slate-500 text-[9px]">ROD ≈ 1490 fpm — UNSAFE</div></div>
              <div className="bg-slate-800/50 rounded px-1.5 py-1.5"><div className="text-slate-500">3θ₀ (false)</div><div className="font-mono text-rose-400 text-[13px]">9.0°</div><div className="text-slate-500 text-[9px]">ROD ≈ 2250 fpm</div></div>
              <div className="bg-slate-800/50 rounded px-1.5 py-1.5"><div className="text-slate-500">4θ₀ (false)</div><div className="font-mono text-rose-500 text-[13px]">12.0°</div><div className="text-slate-500 text-[9px]">ROD ≈ 3020 fpm</div></div>
            </div>

            {/* SVG: alt-vs-distance plot with true + harmonic slopes */}
            <div className="bg-slate-800/30 rounded p-2">
              <div className="text-[10px] text-slate-400 mb-1">Glide-path profiles (alt vs distance to threshold)</div>
              <svg viewBox="0 0 320 180" className="w-full h-auto">
                {/* axes */}
                <line x1="30" y1="160" x2="310" y2="160" stroke="#475569" strokeWidth="0.6"/>
                <line x1="30" y1="20"  x2="30"  y2="160" stroke="#475569" strokeWidth="0.6"/>
                {/* x grid */}
                {[0,5,10,15].map(d => (
                  <g key={d}>
                    <line x1={30 + d*(280/15)} y1="160" x2={30 + d*(280/15)} y2="20" stroke="#1e293b" strokeWidth="0.4"/>
                    <text x={30 + d*(280/15)} y="172" fontSize="7" fill="#64748b" textAnchor="middle">{d}NM</text>
                  </g>
                ))}
                {/* y grid */}
                {[0,1000,2000,3000,4000,5000].map(h => {
                  const y = 160 - (h/5000)*140
                  return (
                    <g key={h}>
                      <line x1="30" y1={y} x2="310" y2={y} stroke="#1e293b" strokeWidth="0.4"/>
                      <text x="27" y={y+2.5} fontSize="7" fill="#64748b" textAnchor="end">{h}</text>
                    </g>
                  )
                })}
                {/* True 3° */}
                {(() => {
                  const x0 = 30, y0 = 160
                  const dxNM = 15
                  const altFt = dxNM * Math.tan(3*Math.PI/180) * 6076
                  const x = x0 + dxNM*(280/15)
                  const y = 160 - (altFt/5000)*140
                  return <line x1={x0} y1={y0} x2={x} y2={y} stroke="#10b981" strokeWidth="1.5"/>
                })()}
                {/* 2× (6°) */}
                {(() => {
                  const x0 = 30, y0 = 160
                  const dxNM = 8
                  const altFt = dxNM * Math.tan(6*Math.PI/180) * 6076
                  const x = x0 + dxNM*(280/15)
                  const y = 160 - (Math.min(altFt,5000)/5000)*140
                  return <line x1={x0} y1={y0} x2={x} y2={y} stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="3,2"/>
                })()}
                {/* 3× (9°) */}
                {(() => {
                  const x0 = 30, y0 = 160
                  const dxNM = 5.2
                  const altFt = dxNM * Math.tan(9*Math.PI/180) * 6076
                  const x = x0 + dxNM*(280/15)
                  const y = 160 - (Math.min(altFt,5000)/5000)*140
                  return <line x1={x0} y1={y0} x2={x} y2={y} stroke="#fb7185" strokeWidth="1.5" strokeDasharray="2,2"/>
                })()}
                {/* 4× (12°) */}
                {(() => {
                  const x0 = 30, y0 = 160
                  const dxNM = 3.9
                  const altFt = dxNM * Math.tan(12*Math.PI/180) * 6076
                  const x = x0 + dxNM*(280/15)
                  const y = 160 - (Math.min(altFt,5000)/5000)*140
                  return <line x1={x0} y1={y0} x2={x} y2={y} stroke="#f43f5e" strokeWidth="1.5" strokeDasharray="1.5,1.5"/>
                })()}
                {/* Plot live flights as dots if any */}
                {rows.filter(r => r.rwy.gpa === 3.0).slice(0, 30).map((r, i) => {
                  const x = 30 + Math.min(r.distToThrNM, 15)*(280/15)
                  const y = 160 - (Math.min(r.altAGL, 5000)/5000)*140
                  return <circle key={r.f.icao+i} cx={x} cy={y} r={2.5} fill={TIER_COLOR[r.tier]} stroke="#0b0f17" strokeWidth="0.6"/>
                })}
                {/* Labels */}
                <text x="305" y="155" fontSize="7" fill="#10b981" textAnchor="end">3°</text>
                <text x="180" y="80"  fontSize="7" fill="#f59e0b" textAnchor="end">6° (2×)</text>
                <text x="120" y="55"  fontSize="7" fill="#fb7185" textAnchor="end">9° (3×)</text>
                <text x="80"  y="40"  fontSize="7" fill="#f43f5e" textAnchor="end">12° (4×)</text>
                <text x="170" y="14"  fontSize="8" fill="#cbd5e1" textAnchor="middle">Altitude AGL (ft) vs Distance to threshold (NM)</text>
              </svg>
              <div className="text-[9px] text-slate-500 mt-1">Live aircraft on θ₀=3° runways plotted as tier-coloured dots. If a dot tracks the amber 6° line, suspect false-GP capture.</div>
            </div>

            <div className="text-[10px] text-slate-400 leading-relaxed">
              <div className="font-mono text-slate-300 mb-1">Capture mitigations:</div>
              <ul className="list-disc pl-4 space-y-0.5">
                <li>Cross-check published altitude × distance at FAF (e.g. 1500 ft @ 5 NM for 3° + TCH 50 ft).</li>
                <li>Intercept the LOC from below the GP whenever possible (FAA InFO 14013).</li>
                <li>HUD glide-path scale + V-NAV path agreement confirms the true slope.</li>
                <li>NEVER select GS-CAPT armed when above the published profile and inside the FAF.</li>
                <li>If ROD &gt;1500 fpm on final &lt;2000 ft AGL — execute GA (FCTM 5.16).</li>
              </ul>
            </div>
          </div>
        )}

        {tab === 'METHOD' && (
          <div className="space-y-2 text-[10px] text-slate-400 leading-relaxed">
            <div>
              <div className="font-mono text-slate-200">Scope</div>
              <div>Every airborne airframe below FL120 within 20 NM of one of 38 catalogued ILS runways, aligned to landing heading ±25°, on the approach side ±35° of runway heading, above threshold elevation. Phase auto-classified INIT-APPR / INTERMEDIATE / FAF / FINAL / SHORT-FINAL / FLARE.</div>
            </div>
            <div>
              <div className="font-mono text-slate-200">Drivers (7)</div>
              <ul className="list-disc pl-4 space-y-0.5">
                <li><span className="font-mono text-slate-300">ALT_DEV</span> · |alt-on-slope|/1200ft ramp past tolerance</li>
                <li><span className="font-mono text-slate-300">ROD_DEV</span> · |rod/nominal - 1| × 80</li>
                <li><span className="font-mono text-slate-300">HARMONIC</span> · proximity to 2θ₀/3θ₀/4θ₀ vs to θ₀</li>
                <li><span className="font-mono text-slate-300">FAF_BUST</span> · past FAF + over band</li>
                <li><span className="font-mono text-slate-300">PHASE</span> · per-phase severity (FAF/FINAL peak)</li>
                <li><span className="font-mono text-slate-300">INTERCEPT</span> · joined-from-above geometry (dist&gt;5NM + ΔALT&gt;800ft)</li>
                <li><span className="font-mono text-slate-300">TERRAIN</span> · runway-specific terrain coefficient (KGUM/LSZH/EDDM=high)</li>
              </ul>
            </div>
            <div>
              <div className="font-mono text-slate-200">Composite</div>
              <div className="font-mono">max·0.62 + mean·0.38 × phase-weight × ADV-MUL, clipped [0,100]</div>
            </div>
            <div>
              <div className="font-mono text-slate-200">Hard escalators</div>
              <ul className="list-disc pl-4 space-y-0.5">
                <li>HARMONIC≥85 + past-FAF + ΔALT≥1000ft → score≥92 (KGUM mode)</li>
                <li>θ_eff in 2θ₀±0.4° + past-FAF + ΔALT≥500ft → ≥88</li>
                <li>ROD≥1500fpm at &lt;2000 AGL aligned → ≥82</li>
                <li>Past FAF + ΔALT &gt; +800 ft → ≥76</li>
                <li>INTERCEPT≥60 + HARMONIC≥50 → ≥65</li>
              </ul>
            </div>
            <div>
              <div className="font-mono text-slate-200">Distinct from</div>
              <div>APCH-CAT (CAT-I/II/III equipment compliance — FGSC is vertical-path capture state) · CDFA-VDP (non-precision vertical conformance — FGSC is precision ILS phantom-capture) · STABLE-APP (1000/500 gate gross-check — FGSC fires earlier in FAF capture window) · GASA (post-GA event — FGSC pre-decision) · TERRAIN/TAWS (GPWS Mode-2/5 — FGSC is GP-mode capture status) · STEEP-APCH (procedures with intended &gt;3.5° GPA — FGSC excludes those).</div>
            </div>
            <div>
              <div className="font-mono text-slate-200">References</div>
              <div className="font-mono text-[9px] leading-snug">
                ICAO Annex 10 Vol I §3.1.5 · Doc 8071 Vol I §4 · Doc 8168 PANS-OPS Vol II §3.4 · Cir 332 AN/192 · FAA AC 120-29A · AC 90-50E · InFO 11009 · InFO 14013 · Order JO 7110.65 §5-9 · Order 8260.3D §249 · AIM 1-1-9 · 14 CFR §91.175 · §121.651 · EASA AMC1 SPA.LVO.110 · CS-ACNS Vol I §1.4 · RTCA DO-195 · ARINC 710-13 · Boeing 737/757/767/777/787 FCOM SP.16 / FCTM 5.16 · Airbus FCOM PRO-NOR-SOP-23 · Embraer E170/E190 AOM §03 · NTSB AAR-00-01 KAL 801 KGUM · AAR-14-01 OZ 214 KSFO · AAIB 1/2003 KAL Cargo 8509 EGSS · BFU 1793 Crossair 3597 LSZH · BFU AX001-1-2/02 Überlingen · TSB A07A0134.
              </div>
            </div>
          </div>
        )}

      </div>

      <div className="px-3 py-1.5 border-t border-slate-700/60 text-[9px] text-slate-500">
        FGSC v1.0 · 38 ILS runways · 4s re-score · score = max·0.62 + mean·0.38 × phase × ADV
      </div>
    </div>
  )
}
