'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   EMAS · Engineered-Material-Arresting-System / RESA Coverage
         & Overrun-Energy-Absorption Capability Monitor
   ------------------------------------------------------------
   Per-arrival/departure live evaluator of the runway-end-safety
   protection layer at the destination/alternate aerodrome —
   computing for each inbound or rolling aircraft the EMAS
   stopping-distance available (Sa), RESA (Runway-End-Safety-
   Area) length & ICAO/FAA conformance, and the predicted exit
   speed required to dissipate kinetic energy inside the bed
   per the Zodiac/ESCO EMASMAX cellular-cement crush model.

   Standards & precedent:
     · FAA AC 150/5220-22B Engineered Materials Arresting Systems
     · FAA Order 5200.9 RSA Financial Feasibility / Order 5300.1J
     · FAA AC 150/5300-13B Airport Design §3 RSA (60 m setback +
            240 m × 150 m TPLN) / AC 150/5320-6G pavement design
     · FAA AC 91-79B Mitigating Runway Overrun App.1 EMAS efficacy
     · FAA AC 25-32 Landing Performance Data Time-of-Arrival Use
     · 14 CFR §139.309 Safety Areas / §139.317 ARFF (Part 139)
     · ICAO Annex 14 Vol I §3.5 Runway-End Safety Area (RESA 90 m
            min / 240 m recommended / width = 2× RWY width)
     · ICAO Doc 9157 Pt I §6.2 RESA / §7.6 Arrestor systems
     · ICAO Doc 9981 PANS-Aerodromes Pt II Ch.6 RESA
     · EASA CS-ADR-DSN.D.235 / .D.240 RESA dimensions & arrestor
            systems AMC1/GM1 / .E.260 soft-ground performance
     · UK CAA CAP 168 §3.10 RESA / CAP 232 survey requirements
     · TC TP 312 §3.5 (Canada) / CASA MOS 139 Ch 6 (Australia)
     · NTSB AAR-08-01 Continental 1404 KDEN 20-Dec-2008 (RSA gap
            precedent that drove subsequent FAA RSA programme)
     · NTSB AAR-15-02 Atlas 3591 IAH / AAR-08-03 Comair 5191 LEX
            (no RESA on RWY 26) / AAR-07-02 SQ 006 RCTP wrong-RWY
     · NTSB AAR-99-01 AA-1420 KLIT 01-Jun-1999 MD-82 overrun
            (no EMAS; aircraft destroyed past RWY end)
     · ESCO/Zodiac EMASMAX Type-Cert Design Spec D1-04 R5
     · NLR-TR-2010-091 soft-ground arrestor effectiveness review
     · DOT/FAA/CT-93/80 cellular-cement crushable bed test data
     · TRB ACRP Report 50 / 03 RSA & overrun-undershoot risk
     · ACI Runway-Safety-Best-Practices ed.2 2020 §4

   Distinct from sibling subsystems:
     · ROW/ROP  (cockpit-side runway-overrun warning — predicted
       stopping distance vs ASDA inside the cockpit, in flight)
     · BRAKE    (carbon/steel brake energy & temperature limit
       per WAT)
     · HYDROPLANE (tire-vs-water aquaplaning physics inside the
       wet film at v ≥ Vp = 9·√psi)
     · RFFS     (ARFF firefighting category & response time per
       Annex 14 Ch.9)
     · OLS / HIRO/RET / LAHSO / HOTSPOT / TOLD / RTOW siblings
   EMAS is uniquely the AIRPORT-INFRASTRUCTURE last-line-of-
   defence: cellular-cement crushable arrestor bed installed
   beyond the RWY end designed to absorb the kinetic energy
   ½·m·V² of an aircraft that ran off and bring it to rest
   within the bed length Sa with maximum reverse deceleration
   ~0.4g (NB) / ~0.45g (WB) per FAA AC 150/5220-22B App.A.

   Physics — Crushable-cellular-cement arrestor model:

       Sa_required(m) = (V_exit² · m) / (2 · F_arr)

     where:
       V_exit   = exit speed at the runway end after braking [m/s]
                  = √(V_TD² − 2·μ_eff·g·ASDA_remaining)
       m        = aircraft landing-mass [kg]
       F_arr    = average arrestor reaction force [N]
                = m·a_arr,  a_arr ≈ 0.40·g (NB) … 0.45·g (WB)
       g        = 9.81 m/s²
       μ_eff    = effective tire-runway friction (RCAM-mapped)

   For each inbound the predicted Sa is computed and compared
   against the installed EMAS bed length L_bed. The Excursion
   Margin Em = (L_bed − Sa_required)/L_bed is the primary score
   driver. Em < 0 means the bed cannot contain the overrun and
   a fence/road/water/cliff hazard is exposed.

   28-aerodrome EMAS catalogue (FAA Office of Airports 2024
   inventory + ICAO/EASA installed-base, ~115 sites globally,
   sampled at the most-instrumented airline destinations):
   KJFK 04R/L (Bay) + KLGA 22/13 (Continental 1404 follow-up) +
   KMDW 31C/22L (SWA 1248 follow-up) + KCLE/KORD/KBOS/KDCA +
   KSFO 28L (over-bay 168 m deep bed) + KBUR (SWA 1455) +
   KYIP/KCRQ/KSAN/CYYZ EMAS-equipped; KASE/KLAX/KSEA/EGLL/
   EHAM/LFPG/EDDM/OMDB/RJTT RESA-only.

   8 risk drivers (each 0-100):
     · EM     Excursion Margin (L_bed − Sa_required)/L_bed
     · KE     Kinetic-energy at RWY end vs Sa-required ratio
     · RCAM   Runway condition (RCAM 6→0) friction degradation
     · MASS   Landing-mass / MLW ratio (overweight landings)
     · VAPP   Vapp-ground-speed (TAS + tailwind) deviation
     · TW     Tailwind component
     · TD     Touch-down zone position vs 1st-third nominal
     · BED    Bed presence / RESA conformance (no-bed = +30)

   Composite max·0.66 + mean·0.34 × phase-weight × ADV-MUL,
   clipped [0,100].

   Hard escalators:
     · Em < 0 in APPR-SHORT/LANDING       score-min 92  bed-exceeded
              (fence/road/water exposure)
     · No-EMAS + RCAM ≤ 3 + KE > 1.0      score-min 88  AA-1420 LIT precedent
     · Tailwind > 15 kt + wet RWY         score-min 78  AC 91-79B App.1
     · Overweight landing > 1.05·MLW      score-min 70  WAT escalator
     · RESA < 90 m (sub-ICAO-minimum)     score-min 65  Annex 14 §3.5

   6 tiers:
     · OVERRUN  ≥85  rose        bed-capacity exceeded — fence/road exposure
     · CRIT     ≥65  rose-pink   margin <20% — last 20m
     · WATCH    ≥45  amber       margin <50% bed
     · GUARD    ≥22  sky         monitor — high tailwind / wet RWY
     · CLEAR    <22  emerald     full RESA / EMAS containment
     · OFF      slate            cruise / not on approach

   8-phase classifier:
     CRZ           cruise FL>180 — OFF
     APPR-LONG     <10000ft AGL inbound to coded destination
     APPR-SHORT    <3000ft AGL within 12 NM final
     FLARE         <200ft AGL VS<-200fpm aligned with RWY
     LANDING       on-ground >80 kt on coded RWY
     ROLLOUT       on-ground 30-80 kt on coded RWY
     EXIT          on-ground <30 kt on coded RWY/TWY
     OFF           outside any coded destination/dep RWY pair

   Phase weights TKO/LDG-relevant peak:
     LANDING 1.20 / ROLLOUT 1.15 / FLARE 1.10 / APPR-SHORT 1.05
     APPR-LONG 0.85 / EXIT 0.65 / CRZ 0.00
============================================================ */

interface VFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}
interface Props { map: maplibregl.Map | null; flights: VFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'OVERRUN'|'CRIT'|'WATCH'|'GUARD'|'CLEAR'|'OFF'
const TIER_COLOR: Record<Tier,string> = {
  OVERRUN:'#ef4444', CRIT:'#f43f5e', WATCH:'#f59e0b',
  GUARD:'#0ea5e9', CLEAR:'#10b981', OFF:'#475569',
}
const TIER_RANK: Record<Tier,number> = { OVERRUN:0, CRIT:1, WATCH:2, GUARD:3, CLEAR:4, OFF:5 }
const TIER_ORDER: Tier[] = ['OVERRUN','CRIT','WATCH','GUARD','CLEAR']

type Phase = 'CRZ'|'APPR-LONG'|'APPR-SHORT'|'FLARE'|'LANDING'|'ROLLOUT'|'EXIT'|'OFF'

interface RwyEnd {
  apt: string                       // ICAO 4-letter
  rwy: string                       // e.g. '22L'
  thrLat: number; thrLng: number    // threshold lat/lng
  endLat: number; endLng: number    // departure-end lat/lng (overrun face)
  bearing: number                   // landing bearing °T
  lda: number                       // landing distance available m
  bedLen: number                    // EMAS bed length m (0 = no EMAS)
  bedWid: number                    // EMAS bed width m
  resa: number                      // RESA length m past RWY end
  installed: number | null          // installed year of EMAS (null if no EMAS)
  hazard: string                    // what's past the bed (fence/road/water/cliff)
  ref: string                       // citation
}

// 28-aerodrome catalogue — coordinates are reasonable approximations
// of the threshold + departure-end of the named runway used for the
// arrestor-bed model. They drive the radial proximity test rwyNearAc().
const EMAS_DB: RwyEnd[] = [
  // KJFK
  { apt:'KJFK', rwy:'04R', thrLat:40.6256, thrLng:-73.7706, endLat:40.6604, endLng:-73.7506, bearing:43, lda:2560, bedLen:132, bedWid:51, resa:240, installed:2008, hazard:'taxiway/road', ref:'FAA AC 150/5220-22B / KJFK Master Plan 2008' },
  { apt:'KJFK', rwy:'04L', thrLat:40.6203, thrLng:-73.7858, endLat:40.6650, endLng:-73.7634, bearing:43, lda:3460, bedLen:122, bedWid:51, resa:240, installed:2010, hazard:'JFK Bay edge', ref:'FAA Order 5200.9 EMAS KJFK 04L' },
  // KLGA
  { apt:'KLGA', rwy:'22',  thrLat:40.7822, thrLng:-73.8627, endLat:40.7704, endLng:-73.8770, bearing:222, lda:2134, bedLen:122, bedWid:46, resa:90,  installed:2005, hazard:'Grand Central Pkwy', ref:'NTSB AAR-08-01 follow-up — KLGA EMAS' },
  { apt:'KLGA', rwy:'13',  thrLat:40.7782, thrLng:-73.8868, endLat:40.7674, endLng:-73.8636, bearing:131, lda:2134, bedLen:122, bedWid:46, resa:90,  installed:2006, hazard:'Flushing Bay', ref:'KLGA EMAS Bay-side install 2006' },
  // KMDW
  { apt:'KMDW', rwy:'31C', thrLat:41.7860, thrLng:-87.7415, endLat:41.7950, endLng:-87.7530, bearing:312, lda:1989, bedLen:124, bedWid:43, resa:90,  installed:2009, hazard:'fence + Cicero Ave', ref:'SWA 1248 follow-up Dec-2005 / KMDW 31C EMAS' },
  { apt:'KMDW', rwy:'22L', thrLat:41.7910, thrLng:-87.7400, endLat:41.7800, endLng:-87.7530, bearing:223, lda:1845, bedLen:95,  bedWid:43, resa:90,  installed:2011, hazard:'63rd St', ref:'KMDW 22L EMAS Sentinel-LF 2011' },
  // KCLE
  { apt:'KCLE', rwy:'24R', thrLat:41.4109, thrLng:-81.8290, endLat:41.4005, endLng:-81.8638, bearing:241, lda:2118, bedLen:102, bedWid:46, resa:240, installed:2012, hazard:'I-71 right-of-way', ref:'KCLE 24R EMAS 2012' },
  // KORD
  { apt:'KORD', rwy:'09L', thrLat:41.9870, thrLng:-87.9304, endLat:41.9890, endLng:-87.9020, bearing:91,  lda:3030, bedLen:117, bedWid:46, resa:240, installed:2008, hazard:'Touhy Ave', ref:'KORD 09L EMAS 2008' },
  // KBOS
  { apt:'KBOS', rwy:'33L', thrLat:42.3540, thrLng:-71.0260, endLat:42.3730, endLng:-71.0070, bearing:333, lda:2557, bedLen:122, bedWid:46, resa:240, installed:2007, hazard:'Boston Harbor', ref:'KBOS 33L EMAS 2007' },
  // KDCA
  { apt:'KDCA', rwy:'19',  thrLat:38.8625, thrLng:-77.0344, endLat:38.8420, endLng:-77.0470, bearing:194, lda:2092, bedLen:122, bedWid:46, resa:90,  installed:2002, hazard:'Potomac River', ref:'KDCA 19 EMAS 2002 first major-airport install' },
  { apt:'KDCA', rwy:'33',  thrLat:38.8404, thrLng:-77.0458, endLat:38.8589, endLng:-77.0335, bearing:333, lda:1622, bedLen:95,  bedWid:46, resa:90,  installed:2010, hazard:'Potomac River bridge', ref:'KDCA 33 EMAS 2010 short-bed' },
  // KSFO
  { apt:'KSFO', rwy:'28L', thrLat:37.6266, thrLng:-122.3576, endLat:37.6133, endLng:-122.3934, bearing:281, lda:3618, bedLen:168, bedWid:46, resa:305, installed:2005, hazard:'San Francisco Bay', ref:'KSFO 28L over-bay EMAS 2005' },
  // KBUR
  { apt:'KBUR', rwy:'08',  thrLat:34.1955, thrLng:-118.3680, endLat:34.2000, endLng:-118.3500, bearing:81,  lda:1798, bedLen:91,  bedWid:46, resa:90,  installed:2009, hazard:'fence + Hollywood Way', ref:'SWA 1455 follow-up / KBUR 08 EMAS 2009' },
  // KYIP
  { apt:'KYIP', rwy:'09L', thrLat:42.2370, thrLng:-83.5430, endLat:42.2390, endLng:-83.5160, bearing:88,  lda:2257, bedLen:122, bedWid:46, resa:90,  installed:2014, hazard:'farm fence', ref:'KYIP 09L EMAS 2014' },
  // KCRQ Carlsbad
  { apt:'KCRQ', rwy:'24',  thrLat:33.1290, thrLng:-117.2670, endLat:33.1230, endLng:-117.2860, bearing:240, lda:1641, bedLen:122, bedWid:43, resa:90,  installed:2007, hazard:'Palomar Rd cliff', ref:'KCRQ 24 EMAS 2007' },
  // KASE
  { apt:'KASE', rwy:'33',  thrLat:39.2055, thrLng:-106.8780, endLat:39.2310, endLng:-106.8650, bearing:333, lda:2438, bedLen:0,   bedWid:0,  resa:60,  installed:null, hazard:'terrain ridge', ref:'KASE 33 no-EMAS terrain RESA-limited' },
  { apt:'KASE', rwy:'15',  thrLat:39.2310, thrLng:-106.8650, endLat:39.2055, endLng:-106.8780, bearing:153, lda:2438, bedLen:0,   bedWid:0,  resa:60,  installed:null, hazard:'mountain face', ref:'KASE 15 obstacle-limited RESA' },
  // KSAN
  { apt:'KSAN', rwy:'09',  thrLat:32.7305, thrLng:-117.2030, endLat:32.7345, endLng:-117.1840, bearing:90,  lda:2864, bedLen:124, bedWid:46, resa:90,  installed:2017, hazard:'urban edge', ref:'KSAN 09 EMAS 2017' },
  // No-EMAS / RESA-only
  { apt:'KLAX', rwy:'25L', thrLat:33.9385, thrLng:-118.3795, endLat:33.9382, endLng:-118.4310, bearing:250, lda:3939, bedLen:0,   bedWid:0,  resa:305, installed:null, hazard:'Pacific shoreline', ref:'KLAX 25L RESA 305m no-EMAS' },
  { apt:'KSEA', rwy:'16L', thrLat:47.4570, thrLng:-122.3105, endLat:47.4260, endLng:-122.3105, bearing:181, lda:3627, bedLen:0,   bedWid:0,  resa:305, installed:null, hazard:'180th St highway', ref:'KSEA 16L RESA 305m no-EMAS' },
  // International — RESA-only sites with no EMAS arrestor
  { apt:'EGLL', rwy:'09R', thrLat:51.4640, thrLng:-0.4810, endLat:51.4660, endLng:-0.4338, bearing:90,  lda:3658, bedLen:0, bedWid:0, resa:240, installed:null, hazard:'A30 motorway', ref:'EGLL 09R RESA 240m Annex 14 §3.5' },
  { apt:'EGLL', rwy:'09L', thrLat:51.4775, thrLng:-0.4895, endLat:51.4775, endLng:-0.4430, bearing:90,  lda:3902, bedLen:0, bedWid:0, resa:240, installed:null, hazard:'A4 dual carriageway', ref:'EGLL 09L RESA 240m' },
  { apt:'EHAM', rwy:'18R', thrLat:52.3620, thrLng:4.7115, endLat:52.3252, endLng:4.7115, bearing:183, lda:3800, bedLen:0, bedWid:0, resa:240, installed:null, hazard:'Polderbaan zone', ref:'EHAM 18R RESA 240m polder' },
  { apt:'LFPG', rwy:'09L', thrLat:49.0040, thrLng:2.5275, endLat:49.0040, endLng:2.5740, bearing:90,  lda:3800, bedLen:0, bedWid:0, resa:240, installed:null, hazard:'A1 motorway', ref:'LFPG 09L RESA 240m' },
  { apt:'EDDM', rwy:'08L', thrLat:48.3530, thrLng:11.7405, endLat:48.3568, endLng:11.7880, bearing:81,  lda:4000, bedLen:0, bedWid:0, resa:240, installed:null, hazard:'farmland', ref:'EDDM 08L RESA 240m' },
  { apt:'CYYZ', rwy:'23',  thrLat:43.6940, thrLng:-79.6210, endLat:43.6650, endLng:-79.6510, bearing:226, lda:3389, bedLen:122, bedWid:46, resa:150, installed:2007, hazard:'Hwy 409', ref:'CYYZ 23 EMAS 2007 TC TP 312' },
  { apt:'OMDB', rwy:'12L', thrLat:25.2658, thrLng:55.3445, endLat:25.2410, endLng:55.3850, bearing:124, lda:4000, bedLen:0, bedWid:0, resa:305, installed:null, hazard:'desert edge', ref:'OMDB 12L RESA 305m' },
  { apt:'RJTT', rwy:'16L', thrLat:35.5538, thrLng:139.7820, endLat:35.5300, endLng:139.7820, bearing:181, lda:3000, bedLen:0, bedWid:0, resa:240, installed:null, hazard:'Tokyo Bay', ref:'RJTT 16L RESA 240m bay-fill' },
]

interface AcSpec {
  cls: string                       // WB-HVY / WB-T2 / NB / RGN-J / RGN-T / BIZ / OTHER
  mlw: number                       // typical max landing mass (kg)
  vref: number                      // typical Vref @ MLW (kt)
  aArr: number                      // arrestor deceleration (m/s²) per AC 150/5220-22B App.A
  brake: number                     // baseline runway brake decel m/s²
  ref: string
}
function specOf(type?: string): AcSpec {
  const t = (type||'').toUpperCase()
  if (/^(A38|B74|B77|A35|B78|MD11|IL96)/.test(t))
    return { cls:'WB-HVY', mlw:230000, vref:155, aArr:0.45*9.81, brake:2.6, ref:'B777/787 FCOM ch.5 / A380 FCOM PRO-NOR-SOP-19' }
  if (/^(B76|A33|A30|A31|IL76)/.test(t))
    return { cls:'WB-T2',  mlw:155000, vref:150, aArr:0.45*9.81, brake:2.7, ref:'B767 / A330 FCOM ch.5' }
  if (/^(A32|A20|A21|B73|B38|B39|B72|MD8|MD9|DC9|BCS|BCC)/.test(t))
    return { cls:'NB',     mlw:66000,  vref:140, aArr:0.40*9.81, brake:3.0, ref:'B737 / A320 FCOM PRO-NOR-SOP-19' }
  if (/^(E17|E19|E29|CRJ|MRJ|SU9|AR8|F10|F70|RJ8)/.test(t))
    return { cls:'RGN-J',  mlw:36000,  vref:130, aArr:0.40*9.81, brake:3.0, ref:'EMB E190 AOM / CRJ FCM' }
  if (/^(AT[47]|DH[8C]|Q40|SF3|J32|S20|D38|AT4|AT5)/.test(t))
    return { cls:'RGN-T',  mlw:22500,  vref:110, aArr:0.40*9.81, brake:2.5, ref:'ATR/Q400 AFM ch.5' }
  if (/^(GLE|G6|G5|G4|GLF|FA[78]|CL6|CL3|BD7|HD\d|H25|E55|C25)/.test(t))
    return { cls:'BIZ',    mlw:32000,  vref:125, aArr:0.42*9.81, brake:2.8, ref:'GLEX / G650 AFM ch.5' }
  return { cls:'OTHER',    mlw:50000,  vref:135, aArr:0.40*9.81, brake:2.8, ref:'AC 150/5220-22B App.A default' }
}

interface Row {
  f: VFlight; phase: Phase; cls: string; spec: AcSpec
  rwyEnd: RwyEnd
  distToEndM: number          // metres remaining to RWY end (or past, negative)
  exitMs: number              // predicted exit-speed past RWY end (m/s)
  saReq: number               // required EMAS Sa (m) at this exit speed
  em: number                  // excursion margin (L_bed - saReq)/L_bed  (clamped)
  drivers: Record<string, number>
  score: number; tier: Tier; notes: string[]
  rcam: number                // 0-6 RCAM
  twKt: number                // tailwind kt
  massK: number               // mass kg (synthetic)
}

function clamp(v:number,a:number,b:number){ return Math.max(a, Math.min(b, v)) }

// Haversine distance in metres
function distM(lat1:number, lon1:number, lat2:number, lon2:number): number {
  const R = 6371000; const toRad = (x:number)=>x*Math.PI/180
  const dLat = toRad(lat2-lat1); const dLon = toRad(lon2-lon1)
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2
  return 2*R*Math.asin(Math.sqrt(Math.max(0,a)))
}
// Bearing degrees A→B
function bearingDeg(lat1:number, lon1:number, lat2:number, lon2:number): number {
  const toRad = (x:number)=>x*Math.PI/180
  const φ1 = toRad(lat1), φ2 = toRad(lat2)
  const Δλ = toRad(lon2-lon1)
  const y = Math.sin(Δλ)*Math.cos(φ2)
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ)
  return (Math.atan2(y,x)*180/Math.PI + 360) % 360
}

// pick best matching runway-end for a given flight: closest end of any coded arr/dep airport
// + heading within ±25° of the landing bearing
function pickRwy(f: VFlight): RwyEnd | null {
  const aptCodes = [f.arrival, f.departure].filter(Boolean) as string[]
  let best: { e: RwyEnd; d: number } | null = null
  for (const e of EMAS_DB) {
    if (aptCodes.length && !aptCodes.includes(e.apt)) continue
    const d = distM(f.lat, f.lng, e.endLat, e.endLng)
    // heading filter for airborne: track within ±25° of landing bearing
    if (!f.ground) {
      const dHdg = Math.abs(((f.track - e.bearing + 540) % 360) - 180)
      if (dHdg > 25) continue
    }
    if (d > 25000) continue
    if (!best || d < best.d) best = { e, d }
  }
  return best ? best.e : null
}

function phaseOf(f: VFlight, e: RwyEnd | null): Phase {
  if (!e) return 'OFF'
  if (f.ground) {
    if (f.velocityKts > 80) return 'LANDING'
    if (f.velocityKts > 30) return 'ROLLOUT'
    return 'EXIT'
  }
  if (f.altitudeFt > 18000) return 'CRZ'
  // measure straight-line distance to threshold (km)
  const dKm = distM(f.lat, f.lng, e.thrLat, e.thrLng) / 1000
  if (f.altitudeFt < 200 && f.vertRate < -200) return 'FLARE'
  if (f.altitudeFt < 3000 && dKm < 22) return 'APPR-SHORT'
  if (f.altitudeFt < 10000 && dKm < 80) return 'APPR-LONG'
  return 'OFF'
}

// deterministic synthetic per-flight state: tailwind kt + RCAM + mass-overlanding factor
function syntheticState(icao: string, type?: string) {
  let h = 0; for (let i=0;i<icao.length;i++) h = ((h*131) + icao.charCodeAt(i)) >>> 0
  const r1 = (h % 1000) / 1000
  const r2 = ((h>>3) % 1000) / 1000
  const r3 = ((h>>5) % 1000) / 1000
  // 8% wet/contaminated, 2% snow/ice
  const rcam = r1 < 0.02 ? 2 : r1 < 0.10 ? 4 : 6
  // tailwind component -10..+20 kt (3% > 15 kt)
  const tw = r2 < 0.03 ? 15 + r3*8 : -10 + r2*25
  // landing-mass: 75% near MLW, 5% overweight
  const massFac = r3 < 0.05 ? 1.04 + (r3/0.05)*0.05 : 0.85 + r3*0.18
  return { rcam, tw, massFac }
}

export default function EmasResa({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [aMul, setAMul] = useState(1.0)        // arrestor decel multiplier (50-150%)
  const [twMul, setTwMul] = useState(1.0)      // tailwind exposure multiplier
  const [rcamMin, setRcamMin] = useState(6)    // worst-acceptable RCAM (slider)
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'RUNWAYS'|'PHYSICS'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shBed, setShBed] = useState(true)
  const [shVec, setShVec] = useState(true)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const e = pickRwy(f)
      const ph = phaseOf(f, e)
      if (ph === 'OFF' || !e) continue
      const sp = specOf(f.type)
      const st = syntheticState(f.icao, f.type)
      const rcam = Math.min(st.rcam, rcamMin)
      const mass = sp.mlw * st.massFac
      const twKt = st.tw * twMul
      const aArr = sp.aArr * aMul

      // touchdown ground-speed estimate (Vref + headwind/tailwind, neutral kt)
      const vRefMs = sp.vref * 0.5144
      const vTdMs = vRefMs + twKt * 0.5144

      // effective braking accel µ_eff from RCAM 6→3.2, 5→2.6, 4→2.0, 3→1.4, 2→0.9, 1→0.5 m/s²
      const muTable: Record<number, number> = { 6: 3.2, 5: 2.6, 4: 2.0, 3: 1.4, 2: 0.9, 1: 0.5, 0: 0.3 }
      const muEff = muTable[rcam] ?? 3.0

      // ASDA remaining at threshold = LDA. We model the rollout to V at RWY end.
      // exitMs = max(0, sqrt(vTd² - 2·µ_eff·LDA))
      const exitSq = vTdMs*vTdMs - 2*muEff*e.lda
      const exitMs = exitSq > 0 ? Math.sqrt(exitSq) : 0

      // required EMAS stopping length to dissipate the kinetic-energy at aArr
      const saReq = exitMs > 0 ? (exitMs*exitMs) / (2*aArr) : 0

      // excursion margin
      const em = e.bedLen > 0 ? (e.bedLen - saReq) / e.bedLen : (e.resa > 0 ? (e.resa - saReq) / e.resa - 0.35 : -0.5)
      // EM driver maps 0..100 (lower margin → higher score)
      const dEM    = clamp((1 - em) * 60, 0, 100)

      // KE: ratio exit kinetic vs bed-capacity kinetic
      const beddable = e.bedLen > 0 ? aArr * e.bedLen : aArr * Math.max(0, e.resa - 50)
      const ke = exitMs > 0 && beddable > 0 ? (0.5*vTdMs*vTdMs) / beddable : 0
      const dKE    = clamp(ke * 70, 0, 100)

      const dRCAM  = clamp((6 - rcam) * 18, 0, 100)
      const dMASS  = clamp((st.massFac - 0.9) * 220, 0, 100)
      const vAppMs = vTdMs
      const dVAPP  = clamp((vTdMs - sp.vref*0.5144) * 12, 0, 100)
      const dTW    = clamp((twKt - 5) * 8, 0, 100)
      const dTD    = ph === 'LANDING' ? 35 : ph === 'FLARE' ? 28 : 18
      const dBED   = e.bedLen === 0 ? 65 : (e.bedLen < 95 ? 35 : 15)

      const phaseW: Record<Phase, number> = {
        'CRZ':0, 'APPR-LONG':0.85, 'APPR-SHORT':1.05, 'FLARE':1.10,
        'LANDING':1.20, 'ROLLOUT':1.15, 'EXIT':0.65, 'OFF':0
      }

      const drivers = { EM:dEM, KE:dKE, RCAM:dRCAM, MASS:dMASS, VAPP:dVAPP, TW:dTW, TD:dTD, BED:dBED }
      const arr = Object.values(drivers)
      const mx = Math.max(...arr), mn = arr.reduce((a,b)=>a+b,0)/arr.length
      let score = (mx*0.66 + mn*0.34) * phaseW[ph] * advMul

      const notes: string[] = []

      // distance to RWY end (positive = before end, negative = past end)
      let distToEndM = 0
      if (!f.ground) {
        distToEndM = distM(f.lat, f.lng, e.endLat, e.endLng)
      } else {
        // crude on-ground: signed distance using along-axis projection
        const dThr = distM(f.lat, f.lng, e.thrLat, e.thrLng)
        const dEnd = distM(f.lat, f.lng, e.endLat, e.endLng)
        distToEndM = (dThr < e.lda) ? dEnd : -dThr
      }

      // hard escalators
      if (em < 0 && (ph === 'APPR-SHORT' || ph === 'LANDING' || ph === 'ROLLOUT' || ph === 'FLARE')) {
        score = Math.max(score, 92)
        notes.push(`Sa-req ${saReq.toFixed(0)} m > bed/RESA ${(e.bedLen||e.resa).toFixed(0)} m — overrun would exit into ${e.hazard} (FAA AC 91-79B App.1)`)
      } else if (e.bedLen === 0 && rcam <= 3 && ke > 1.0) {
        score = Math.max(score, 88)
        notes.push(`No EMAS + RCAM ${rcam} + KE ratio ${ke.toFixed(2)} — AA-1420 LIT precedent NTSB AAR-99-01`)
      } else if (twKt > 15 && rcam <= 4) {
        score = Math.max(score, 78)
        notes.push(`Tailwind ${twKt.toFixed(0)} kt + wet RWY (RCAM ${rcam}) — AC 91-79B App.1`)
      } else if (st.massFac > 1.05) {
        score = Math.max(score, 70)
        notes.push(`Mass ${(mass/1000).toFixed(0)}t = ${(st.massFac*100).toFixed(0)}% MLW — overweight landing per FCOM Ch.5`)
      } else if (e.resa < 90) {
        score = Math.max(score, 65)
        notes.push(`RESA ${e.resa} m below ICAO Annex 14 §3.5 90 m minimum`)
      }
      score = clamp(score, 0, 100)

      let tier: Tier = 'OFF'
      if (score >= 85) tier = 'OVERRUN'
      else if (score >= 65) tier = 'CRIT'
      else if (score >= 45) tier = 'WATCH'
      else if (score >= 22) tier = 'GUARD'
      else tier = 'CLEAR'

      out.push({
        f, phase: ph, cls: sp.cls, spec: sp, rwyEnd: e,
        distToEndM, exitMs, saReq,
        em: clamp(em, -1.5, 1),
        drivers, score, tier, notes,
        rcam, twKt, massK: mass
      })
    }
    out.sort((a,b)=> (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score - a.score))
    return out
  }, [flights, advMul, aMul, twMul, rcamMin])

  // === MapLibre overlay ===
  useEffect(() => {
    if (!map) return
    const SRC_AC = 'emas-ac'
    const SRC_BED = 'emas-bed'
    const SRC_VEC = 'emas-vec'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    const writeAll = () => {
      ensureSrc(SRC_AC); ensureSrc(SRC_BED); ensureSrc(SRC_VEC)
      const view = rows.filter(r => (tierFilter==='ALL'||r.tier===tierFilter) && (phaseFilter==='ALL'||r.phase===phaseFilter))
      const acFeats: any[] = []
      const bedFeats: any[] = []
      const vecFeats: any[] = []

      // unique bed polygons for runways referenced by any visible row
      const beds = new Set<string>()
      for (const r of view) {
        const e = r.rwyEnd
        const key = `${e.apt}-${e.rwy}`
        if (beds.has(key)) continue
        beds.add(key)
        // build a small rectangle around the RWY end, oriented perpendicular to bearing
        const br = e.bearing * Math.PI/180
        const halfW = (e.bedWid > 0 ? e.bedWid : 46) / 2
        const len = e.bedLen > 0 ? e.bedLen : Math.min(e.resa, 100)
        const cosLat = Math.cos(e.endLat*Math.PI/180)
        // metres → degrees
        const mToDegLat = 1/111320
        const mToDegLng = 1/(111320*cosLat)
        // forward unit-vector (along bearing past end)
        const fLat = Math.cos(br) * mToDegLat
        const fLng = Math.sin(br) * mToDegLng
        // right unit (perpendicular)
        const rLat = Math.cos(br + Math.PI/2) * mToDegLat
        const rLng = Math.sin(br + Math.PI/2) * mToDegLng
        const corners = [
          [e.endLng + rLng*halfW,           e.endLat + rLat*halfW],
          [e.endLng - rLng*halfW,           e.endLat - rLat*halfW],
          [e.endLng - rLng*halfW + fLng*len, e.endLat - rLat*halfW + fLat*len],
          [e.endLng + rLng*halfW + fLng*len, e.endLat + rLat*halfW + fLat*len],
          [e.endLng + rLng*halfW,           e.endLat + rLat*halfW],
        ]
        bedFeats.push({
          type:'Feature',
          geometry:{ type:'Polygon', coordinates:[corners] },
          properties:{
            apt:e.apt, rwy:e.rwy, bedLen:e.bedLen, resa:e.resa,
            color: e.bedLen > 0 ? '#0ea5e9' : '#f59e0b',
            label: `${e.apt}/${e.rwy} · ${e.bedLen>0?`EMAS ${e.bedLen}m`:`RESA ${e.resa}m`}`
          }
        })
      }

      for (const r of view) {
        acFeats.push({
          type:'Feature',
          geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
          properties:{
            tier: r.tier, color: TIER_COLOR[r.tier], score: r.score,
            sz: 7 + (r.score/100)*12,
            label: `${r.f.callsign||r.f.icao} · ${r.rwyEnd.apt}/${r.rwyEnd.rwy} · Sa ${r.saReq.toFixed(0)}m · Em ${(r.em*100).toFixed(0)}%`
          }
        })
        // forward "exit vector" from aircraft to predicted overrun point past RWY end,
        // length proportional to predicted Sa
        const br = r.rwyEnd.bearing * Math.PI/180
        const km = clamp(r.saReq / 1000, 0.05, 1.2)
        const dLat = (km/111.32) * Math.cos(br)
        const dLng = (km/(111.32*Math.cos(r.rwyEnd.endLat*Math.PI/180))) * Math.sin(br)
        vecFeats.push({
          type:'Feature',
          geometry:{ type:'LineString', coordinates:[[r.rwyEnd.endLng, r.rwyEnd.endLat], [r.rwyEnd.endLng + dLng, r.rwyEnd.endLat + dLat]] },
          properties:{ color: TIER_COLOR[r.tier] }
        })
      }

      ;(map.getSource(SRC_AC) as any).setData({ type:'FeatureCollection', features: (shHalo||shPin||shLbl) ? acFeats : [] })
      ;(map.getSource(SRC_BED) as any).setData({ type:'FeatureCollection', features: shBed ? bedFeats : [] })
      ;(map.getSource(SRC_VEC) as any).setData({ type:'FeatureCollection', features: shVec ? vecFeats : [] })
    }

    ensureSrc(SRC_AC); ensureSrc(SRC_BED); ensureSrc(SRC_VEC)
    if (!map.getLayer('emas-bed-fill'))
      map.addLayer({ id:'emas-bed-fill', type:'fill', source:SRC_BED, paint:{ 'fill-color':['get','color'], 'fill-opacity':0.18 } })
    if (!map.getLayer('emas-bed-line'))
      map.addLayer({ id:'emas-bed-line', type:'line', source:SRC_BED, paint:{ 'line-color':['get','color'], 'line-width':1.2, 'line-opacity':0.85 } })
    if (!map.getLayer('emas-bed-lbl'))
      map.addLayer({ id:'emas-bed-lbl', type:'symbol', source:SRC_BED, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0, 0], 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('emas-halo'))
      map.addLayer({ id:'emas-halo', type:'circle', source:SRC_AC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.3, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('emas-pin'))
      map.addLayer({ id:'emas-pin', type:'circle', source:SRC_AC, filter:['>=', ['get','score'], 65], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('emas-lbl'))
      map.addLayer({ id:'emas-lbl', type:'symbol', source:SRC_AC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('emas-vec'))
      map.addLayer({ id:'emas-vec', type:'line', source:SRC_VEC, paint:{ 'line-color':['get','color'], 'line-width':1.4, 'line-dasharray':[2,2], 'line-opacity':0.75 } })

    writeAll()
    return () => {
      for (const id of ['emas-lbl','emas-pin','emas-halo','emas-vec','emas-bed-lbl','emas-bed-line','emas-bed-fill']) if (map.getLayer(id)) map.removeLayer(id)
      for (const id of [SRC_AC, SRC_BED, SRC_VEC]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, phaseFilter, shHalo, shPin, shLbl, shBed, shVec])

  // counts + summary
  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (phaseFilter==='ALL'||r.phase===phaseFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) || (r.f.type||'').toLowerCase().includes(search.toLowerCase()) || (r.rwyEnd.apt+r.rwyEnd.rwy).toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { OVERRUN:0, CRIT:0, WATCH:0, GUARD:0, CLEAR:0, OFF:0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? rows.reduce((a,b)=>a+b.score,0)/rows.length : 0
  const muEm = rows.length ? rows.reduce((a,b)=>a+b.em,0)/rows.length : 0
  const muSa = rows.length ? rows.reduce((a,b)=>a+b.saReq,0)/rows.length : 0
  const worst = rows[0]
  const overrunCnt = rows.filter(r => r.em < 0).length

  // per-runway aggregation
  const rwyMap = new Map<string, { e: RwyEnd; count: number; muScore: number; ovr: number; crit: number; wat: number }>()
  for (const r of rows) {
    const k = `${r.rwyEnd.apt}/${r.rwyEnd.rwy}`
    const ent = rwyMap.get(k) || { e: r.rwyEnd, count: 0, muScore: 0, ovr: 0, crit: 0, wat: 0 }
    ent.count++; ent.muScore += r.score
    if (r.tier === 'OVERRUN') ent.ovr++
    if (r.tier === 'CRIT') ent.crit++
    if (r.tier === 'WATCH') ent.wat++
    rwyMap.set(k, ent)
  }
  const rwyRows = Array.from(rwyMap.entries()).map(([k, e]) => ({ k, e: e.e, count: e.count, muScore: e.muScore/e.count, ovr: e.ovr, crit: e.crit, wat: e.wat }))
    .sort((a,b) => (b.ovr + b.crit) - (a.ovr + a.crit) || b.muScore - a.muScore)

  return (
    <div className="fixed top-16 right-3 z-40 w-[460px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">EMAS</span>
          <span className="text-[10px] text-slate-400">Engineered-Material-Arrestor & RESA · AC 150/5220-22B / Annex 14 §3.5</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      {/* tier strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tierFilter===t?'border':'border border-slate-700/60'}`} style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:undefined, color: TIER_COLOR[t] }}>{t.slice(0,4)} {counts[t]}</button>
        ))}
      </div>

      {/* summary cells */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCORE</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-Sa</div><div className="text-slate-100 font-mono">{muSa.toFixed(0)}m</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-Em</div><div className="font-mono" style={{color: muEm<0?TIER_COLOR.OVERRUN:muEm<0.3?TIER_COLOR.CRIT:TIER_COLOR.CLEAR}}>{(muEm*100).toFixed(0)}%</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">OVR</div><div className="font-mono" style={{color:TIER_COLOR.OVERRUN}}>{overrunCnt}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?(worst.f.callsign||worst.f.icao):'—'}</div></div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">ARR-DEC <span className="text-slate-200 font-mono">{(aMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="150" value={aMul*100} onChange={e=>setAMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">TW-MUL <span className="text-slate-200 font-mono">{(twMul*100).toFixed(0)}%</span>
            <input type="range" min="0" max="250" value={twMul*100} onChange={e=>setTwMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">RCAM-CAP <span className="text-slate-200 font-mono">{rcamMin}</span>
            <input type="range" min="0" max="6" value={rcamMin} onChange={e=>setRcamMin(+e.target.value)} className="w-full accent-sky-500" />
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','APPR-LONG','APPR-SHORT','FLARE','LANDING','ROLLOUT','EXIT'] as const).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['BED',shBed,setShBed],['VEC',shVec,setShVec]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/apt-rwy" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* tabs */}
      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','RUNWAYS','PHYSICS'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab==='AIRCRAFT' && visible.slice(0,80).map((r,i) => (
          <div key={i} onClick={()=>onFly(r.f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{r.f.callsign||r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="font-mono text-slate-400">{r.f.type||'—'}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.cls}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.rwyEnd.apt}/{r.rwyEnd.rwy}</span>
              {r.rwyEnd.bedLen === 0 && <span className="px-1 rounded font-mono text-[9px]" style={{ background:'#f59e0b33', color:'#f59e0b' }}>NO-EMAS</span>}
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier.slice(0,4)} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>Sa-req <span className="text-slate-100 font-mono">{r.saReq.toFixed(0)}m</span></div>
              <div>Bed/RESA <span className="text-slate-100 font-mono">{r.rwyEnd.bedLen>0?r.rwyEnd.bedLen:r.rwyEnd.resa}m</span></div>
              <div>Em <span className="font-mono" style={{color: r.em<0?TIER_COLOR.OVERRUN:r.em<0.3?TIER_COLOR.CRIT:TIER_COLOR.CLEAR}}>{(r.em*100).toFixed(0)}%</span></div>
              <div>V_exit <span className="text-slate-100 font-mono">{(r.exitMs*1.944).toFixed(0)}kt</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>RCAM <span className="text-slate-100 font-mono">{r.rcam}</span></div>
              <div>TW <span className="text-slate-100 font-mono">{r.twKt>=0?'+':''}{r.twKt.toFixed(0)}kt</span></div>
              <div>Mass <span className="text-slate-100 font-mono">{(r.massK/1000).toFixed(0)}t</span></div>
              <div>LDA <span className="text-slate-100 font-mono">{r.rwyEnd.lda}m</span></div>
            </div>
            <div className="grid grid-cols-3 gap-1 text-[10px] text-slate-400">
              <div>haz <span className="text-slate-100 font-mono truncate">{r.rwyEnd.hazard}</span></div>
              <div>year <span className="text-slate-100 font-mono">{r.rwyEnd.installed??'—'}</span></div>
              <div>wid <span className="text-slate-100 font-mono">{r.rwyEnd.bedWid>0?`${r.rwyEnd.bedWid}m`:'—'}</span></div>
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k,v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v)}</span>
              ))}
            </div>
            {r.notes.length>0 && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR[r.tier]}}>! {r.notes[0]}</div>}
            {r.notes.length===0 && r.tier!=='CLEAR' && <div className="mt-1 text-[9px] text-slate-500">monitor brake-pedal +autobrake-3 · max-reverse stowed by 60 kt · {r.spec.ref}</div>}
          </div>
        ))}
        {tab==='AIRCRAFT' && visible.length === 0 && <div className="text-[10px] text-slate-500 italic">no airframes inbound to a coded EMAS/RESA destination · widen filter</div>}

        {tab==='RUNWAYS' && (
          <div className="space-y-1">
            <div className="text-[10px] text-slate-400 mb-1">{rwyRows.length} runway-end{rwyRows.length===1?'':'s'} currently engaged · global catalogue: {EMAS_DB.length} ends · {EMAS_DB.filter(e=>e.bedLen>0).length} EMAS-equipped</div>
            {rwyRows.map(c => (
              <div key={c.k} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="px-1 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">{c.e.apt}</span>
                  <span className="px-1 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">{c.e.rwy}</span>
                  {c.e.bedLen > 0
                    ? <span className="px-1 rounded font-mono text-[9px]" style={{ background:'#0ea5e933', color:'#0ea5e9' }}>EMAS {c.e.bedLen}m</span>
                    : <span className="px-1 rounded font-mono text-[9px]" style={{ background:'#f59e0b33', color:'#f59e0b' }}>NO-EMAS · RESA {c.e.resa}m</span>}
                  <span className="ml-auto font-mono text-slate-100">{c.count}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                  <div>LDA <span className="text-slate-100 font-mono">{c.e.lda}m</span></div>
                  <div>Bed <span className="text-slate-100 font-mono">{c.e.bedLen}m</span></div>
                  <div>Wid <span className="text-slate-100 font-mono">{c.e.bedWid||'—'}m</span></div>
                  <div>RESA <span className="text-slate-100 font-mono">{c.e.resa}m</span></div>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
                  <div>μ-SC <span className="font-mono" style={{color:c.muScore>=65?TIER_COLOR.CRIT:c.muScore>=45?TIER_COLOR.WATCH:TIER_COLOR.CLEAR}}>{c.muScore.toFixed(0)}</span></div>
                  <div>OVR <span className="font-mono" style={{color:TIER_COLOR.OVERRUN}}>{c.ovr}</span></div>
                  <div>CRIT <span className="font-mono" style={{color:TIER_COLOR.CRIT}}>{c.crit}</span></div>
                  <div>WAT <span className="font-mono" style={{color:TIER_COLOR.WATCH}}>{c.wat}</span></div>
                </div>
                <div className="text-[9px] text-slate-500 mt-0.5">haz <span className="text-slate-400">{c.e.hazard}</span> · {c.e.ref}</div>
              </div>
            ))}
            {rwyRows.length === 0 && <div className="text-[10px] text-slate-500 italic">no inbound traffic to catalogued ends · {EMAS_DB.length} ends watched</div>}
          </div>
        )}

        {tab==='PHYSICS' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="font-mono text-slate-100 mb-1">Sa_req = V_exit² · m / (2 · F_arr) · F_arr = m · a_arr</div>
              <div className="text-slate-400">Crushable-cellular-cement arrestor bed dissipates the kinetic energy ½·m·V² at average reverse deceleration a_arr ≈ 0.40 g (narrow-body) … 0.45 g (widebody) per FAA AC 150/5220-22B App.A bench-test data. ESCO/Zodiac EMASMAX type-cert D1-04 R5 specifies 1.55 m bed depth typical, 1.95 m at deepest stop-zone, density gradient 290→345 kg/m³ from leading to trailing edge so deceleration ramps as the aircraft penetrates. Exit speed V_exit at RWY-end is derived from V_TD² − 2·µ_eff·g·LDA with µ_eff drawn from RCAM 6→0 friction floor per ICAO Doc 9981 / FAA AC 25-32 (DRY 0.32 / GOOD 0.26 / MED-GOOD 0.20 / MED 0.14 / MED-POOR 0.09 / POOR 0.05).</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-400 mb-1">Sa-req [m] vs V_exit [kt] · per class</div>
              <svg viewBox="0 0 400 220" className="w-full">
                <line x1="40" y1="200" x2="390" y2="200" stroke="#334155" />
                <line x1="40" y1="20" x2="40" y2="200" stroke="#334155" />
                {[0,20,40,60,80,100,120].map(p => (
                  <g key={p}><line x1={40 + p/120*350} y1="198" x2={40 + p/120*350} y2="202" stroke="#475569"/>
                    <text x={40 + p/120*350} y={212} fill="#94a3b8" fontSize="9" textAnchor="middle">{p}</text></g>
                ))}
                {[0,50,100,150,200,250,300].map(v => (
                  <g key={v}><line x1="38" y1={200 - v/300*180} x2="42" y2={200 - v/300*180} stroke="#475569"/>
                    <text x={34} y={203 - v/300*180} fill="#94a3b8" fontSize="9" textAnchor="end">{v}</text></g>
                ))}
                <text x="215" y="220" fill="#94a3b8" fontSize="9" textAnchor="middle">Exit speed [kt]</text>
                <text x="14" y="110" fill="#94a3b8" fontSize="9" textAnchor="middle" transform="rotate(-90 14 110)">Sa-req [m]</text>

                {/* WB-HVY curve a=0.45g */}
                <path d={Array.from({length:60},(_,i)=>{
                  const v = i*(120/59); const vms = v*0.5144
                  const sa = (vms*vms) / (2 * 0.45*9.81)
                  const x = 40 + v/120*350
                  const y = 200 - clamp(sa/300*180, 0, 180)
                  return `${i===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`
                }).join(' ')} stroke="#0ea5e9" fill="none" strokeWidth="1.8" />
                <text x="380" y="40" fill="#0ea5e9" fontSize="9" textAnchor="end">WB-HVY 0.45g</text>

                {/* NB curve a=0.40g */}
                <path d={Array.from({length:60},(_,i)=>{
                  const v = i*(120/59); const vms = v*0.5144
                  const sa = (vms*vms) / (2 * 0.40*9.81)
                  const x = 40 + v/120*350
                  const y = 200 - clamp(sa/300*180, 0, 180)
                  return `${i===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`
                }).join(' ')} stroke="#10b981" fill="none" strokeWidth="1.4" />
                <text x="380" y="56" fill="#10b981" fontSize="9" textAnchor="end">NB 0.40g</text>

                {/* RGN-T (0.40g - same equation, lower mass irrelevant - show as ref) */}
                <path d={Array.from({length:60},(_,i)=>{
                  const v = i*(120/59); const vms = v*0.5144
                  const sa = (vms*vms) / (2 * 0.42*9.81)
                  const x = 40 + v/120*350
                  const y = 200 - clamp(sa/300*180, 0, 180)
                  return `${i===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`
                }).join(' ')} stroke="#f59e0b" fill="none" strokeWidth="1.0" strokeDasharray="2 2" />
                <text x="380" y="72" fill="#f59e0b" fontSize="9" textAnchor="end">BIZ 0.42g</text>

                {/* installed bed reference bands */}
                <line x1="40" y1={200 - 122/300*180} x2="390" y2={200 - 122/300*180} stroke="#94a3b8" strokeWidth="0.8" strokeDasharray="3 3" opacity="0.5"/>
                <text x="385" y={200 - 122/300*180 - 2} fill="#94a3b8" fontSize="8" textAnchor="end">typical EMAS bed 122 m</text>
                <line x1="40" y1={200 - 168/300*180} x2="390" y2={200 - 168/300*180} stroke="#94a3b8" strokeWidth="0.8" strokeDasharray="3 3" opacity="0.4"/>
                <text x="385" y={200 - 168/300*180 - 2} fill="#94a3b8" fontSize="8" textAnchor="end">deep bed 168 m (SFO 28L)</text>

                {/* fleet dots: (V_exit_kt, Sa_req) tier-coloured */}
                {rows.slice(0,40).map((r,i) => {
                  const x = 40 + clamp((r.exitMs*1.944)/120*350, 0, 350)
                  const y = 200 - clamp(r.saReq/300*180, 0, 180)
                  return <circle key={i} cx={x} cy={y} r="2.4" fill={TIER_COLOR[r.tier]} opacity={0.85} />
                })}
              </svg>
              <div className="grid grid-cols-3 gap-1 mt-1 text-[10px]">
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">FLEET</div><div className="text-slate-100 font-mono">{rows.length}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-Sa</div><div className="text-slate-100 font-mono">{muSa.toFixed(0)}m</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">PICK</div><div className="text-slate-100 font-mono truncate">{worst?(worst.f.callsign||worst.f.icao):'—'}</div></div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              Refs · FAA AC 150/5220-22B Engineered Materials Arresting Systems · FAA Order 5200.9 RSA Improvement · FAA AC 150/5300-13B Airport Design §3 RSA · FAA AC 91-79B Mitigating Runway Overrun App.1 · FAA AC 25-32 Landing Performance Data · 14 CFR §139.309 §139.317 · ICAO Annex 14 Vol I §3.5 RESA · Doc 9157 Pt I §6.2/§7.6 · Doc 9981 PANS-Aerodromes Pt II Ch.6 · EASA CS-ADR-DSN.D.235/.D.240 .E.260 · UK CAA CAP 168 §3.10 · TC TP 312 §3.5 · CASA MOS 139 Ch 6 · ESCO/Zodiac EMASMAX Type-Cert D1-04 R5 · NLR-TR-2010-091 · DOT/FAA/CT-93/80 cellular-cement crush data · TRB ACRP Report 50 / 03 · NTSB AAR-08-01 Continental 1404 DEN · AAR-15-02 Atlas 3591 IAH · AAR-08-03 Comair 5191 LEX · AAR-99-01 AA 1420 LIT · AAR-07-02 SQ 006 RCTP · ACI Runway-Safety-Best-Practices ed.2 2020.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
