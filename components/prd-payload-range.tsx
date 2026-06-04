'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   PRD · Payload-Range Diagram & Mission Capability Envelope
   ------------------------------------------------------------
   Per-airframe four-corner payload-range envelope evaluator.
   The classical PRD has four breakpoints (per Roskam Airplane
   Design Pt I §3.7, Torenbeek Synthesis of Subsonic Airplane
   Design Ch.5, Raymer Aircraft Design 6e §3.3, Airbus Getting
   to Grips with Aircraft Performance §2.3, Boeing PEM §2):
     A · MZFW point   : R_A at maximum structural payload, taking
                        off below MTOW (fuel limited by margin
                        MTOW − MZFW)
     B · MTOW point   : R_B at max-payload-and-MTOW, where every
                        kg of additional fuel must trade 1:1 with
                        payload (the classic "elbow")
     C · Harvest point: R_C at max-fuel-and-MTOW (fuel tanks full,
                        payload reduced by Fuel_max − (MTOW−MZFW))
     D · Ferry point  : R_D at zero-payload, max-fuel, OEW only

   The Breguet range equation drives each segment:
     R = (V/SFC)·(L/D)·ln(W_to / W_zfw_plus_reserves)
   evaluated at LRC TAS, mid-cruise L/D, mid-cruise SFC per the
   class drag-polar + TSFC catalogue (consistent with BREG monitor
   but applied at trip-planning scope, not cruise-optimisation).

   PRD catalogue (32 airframes, 6 classes) compiled from:
     · Boeing 737/747/757/767/777/787 Airport Planning documents
     · Airbus A220/A319/A320/A321/A330/A350/A380 ACAP brochures
     · Embraer ERJ-170/175/190/195/E2 Airport Planning Manuals
     · ATR-72/Q400 Airport Planning Manuals
     · Bombardier/Gulfstream/Dassault business-jet ACAPs
     · ICAO Doc 9760 Vol II Pt IV airworthiness performance data
     · EUROCONTROL BADA 3.15 / 4.2 OPF/APF performance files
     · ICAO Doc 9889 §A.3 fuel-burn / Boeing PEM §2 §3
   Each row carries OEW [kg], MZFW [kg], MTOW [kg], Max-Fuel [kg],
   LRC fuel-flow [kg/hr], LRC TAS [kt], pax-seats, family label,
   and the four computed corner-point R_A, R_B, R_C, R_D.

   Per-airframe mission scoring:
     · trip_NM_est: deterministic per-icao24 hash, gated by class
                     typical-leg (NB 400-2400, WB-LH 1800-7800,
                     RGN-J 200-1100, RGN-T 80-600, BIZ 600-4800),
                     coupled to current GS so high-GS in-cruise
                     biases toward longer plausible trips
     · payload_est: SEATS × LOAD-FACTOR slider × 95 kg pax+bag
                     standard (per FAA AC 120-27F Weight & Balance
                     Control 95-kg/210-lb summer standard) plus a
                     cargo-belly fraction CGO-MUL slider (0-100%
                     of (MZFW − OEW − pax_mass))
     · ZFW = OEW + payload_est
     · fuel_required = FF × (trip_NM/TAS_LRC + RES-HR slider) ×
                        CONT (1+CONT-MUL/100)
                        per 14 CFR §121.639 / EASA CAT.OP.MPA.150
                        domestic-IFR / international-IFR reserves
     · TOW_required = ZFW + fuel_required
     · The mission is FEASIBLE if and only if:
         ZFW ≤ MZFW   (structural ZFW limit)
         fuel_required ≤ Max-Fuel   (tank capacity)
         TOW_required ≤ MTOW   (structural / runway TOW limit)
         trip_NM ≤ R_for_payload  (range capability at this payload)

   6 risk drivers (max-driver + secondary-mean composite):
     · ZFW   · ZFW utilisation pct of MZFW (margin = MZFW − ZFW)
     · TOW   · TOW utilisation pct of MTOW
     · FUEL  · Fuel utilisation pct of Max-Fuel
     · RNG   · trip_NM vs R_at_payload (above corner B/C envelope)
     · BLOCK · block-fuel margin vs Max-Fuel
     · CFG   · payload-vs-MZFW utilisation amplifier for tight ops
     composite = max·0.68 + mean·0.32 × ADV-MUL

   Hard escalators:
     · ZFW>MZFW → score-min 90 (structural ZFW exceedance)
     · TOW>MTOW → score-min 92 (structural TOW exceedance)
     · trip > R_B at full payload → score-min 84 (would require
       payload offload to reach destination)
     · fuel_req > Max-Fuel → score-min 88 (cannot tanker required)

   6 hard tiers per dispatch viability:
     · OVER-MTOW    rose      structural TOW/ZFW breach reduce
                              fuel/payload per FCOM PI-WT (90+)
     · FUEL-LIMITED rose-pink trip exceeds R_C (harvest) with
                              even full tanks offload pax/cargo
                              or add tech-stop (80+)
     · TIGHT        amber     <5% margin on ZFW/TOW/Fuel/Range
                              brief crew on weight-critical (60+)
     · ADEQUATE     sky       5-15% margin, monitor (35+)
     · COMFORTABLE  emerald   >15% margin all axes (12+)
     · IDLE         slate     on-ground / below FL050 / no trip

   MapLibre overlay:
     · tier-coloured halo rings 7-19px by score
     · class-coloured inner-ring (WB-LH violet WB-M sky NB emerald
       RGN-J amber RGN-T yellow BIZ rose)
     · OVER-MTOW / FUEL-LIMITED rose pins
     · tier-coloured cs / trip-NM / margin% labels

   Side panel:
     · 6-tier counter strip click-to-filter ALL
     · 6-cell summary MEAN-margin / WORST cs / OVER-MTOW-cnt /
       FUEL-LIM-cnt / Σ-trip-NM-fleet / MEAN-LF
     · 6 sliders LF (load-factor) 30-100%, CGO-MUL 0-100%,
       RES-HR 0.5-3.0h, CONT-MUL 0-15%, ADV-MUL 50-200%, TRIP-MUL
       50-200% (scales hash-derived trip distance)
     · 6-class chip filter WB-LH WB-M NB RGN-J RGN-T BIZ
     · HALO PIN LBL toggles + search by cs/type/operator/class
     · AIRCRAFT / CLASSES / DIAGRAM tab switcher
     · AIRCRAFT tab: tier-worst-first row stack with full
       FL/GS/trip/payload/ZFW/TOW/fuel readout + 4-corner pill
       row (A·MZFW B·MTOW C·HVT D·FRY) + score bar + driver chips
     · CLASSES tab: per-class mean utilisation + tier sub-counter
     · DIAGRAM tab: SVG four-corner PRD plot for selected airframe
       with shaded feasible polygon + A/B/C/D markers + current
       mission dot tier-coloured

   References:
     · Roskam Airplane Design Pt I §3.7 payload-range diagram
     · Torenbeek Synthesis of Subsonic Airplane Design Ch.5
     · Raymer Aircraft Design 6e §3.3 mission profile
     · Anderson Aircraft Performance & Design §5.10
     · Boeing 737/747/757/767/777/787 Airport Planning §3.2
     · Airbus ACAP A220/A319/A320/A321/A330/A350/A380 §3.5
     · Embraer E170/E175/E190/E195 APM §3.4
     · ATR-72/Q400 APM §3
     · Airbus Getting to Grips with Aircraft Performance §2.3
     · Boeing PEM §2 weight & balance / §3 mission planning
     · 14 CFR §121.639 §121.641 §121.645 fuel reserves
     · EASA Part-CAT CAT.OP.MPA.150 fuel scheme
     · ICAO Annex 6 Pt I §4.3.6 fuel requirements
     · ICAO Doc 9760 Vol II Pt IV airworthiness performance
     · ICAO Doc 9889 §A.3 fuel-burn methodology
     · EUROCONTROL BADA 3.15 / 4.2 OPF/APF
     · FAA AC 120-27F Aircraft Weight and Balance Control
     · FAA AC 91-79B App.1 fuel planning
     · IATA Standard Ground-handling Agreement AHM 632 / 642
     · Belobaba/Odoni/Barnhart Global Airline Industry 2e §4
     · Doganis Flying Off Course 4e Ch.4 unit costs
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'OVER-MTOW' | 'FUEL-LIMITED' | 'TIGHT' | 'ADEQUATE' | 'COMFORTABLE' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'OVER-MTOW':'#ef4444', 'FUEL-LIMITED':'#f43f5e', TIGHT:'#f59e0b',
  ADEQUATE:'#0ea5e9', COMFORTABLE:'#10b981', IDLE:'#475569',
}
const TIER_ORDER: Tier[] = ['OVER-MTOW','FUEL-LIMITED','TIGHT','ADEQUATE','COMFORTABLE','IDLE']

type Klass = 'WB-LH' | 'WB-M' | 'NB' | 'RGN-J' | 'RGN-T' | 'BIZ'
const KLASS_COLOR: Record<Klass, string> = {
  'WB-LH':'#a855f7', 'WB-M':'#0ea5e9', NB:'#10b981',
  'RGN-J':'#f59e0b', 'RGN-T':'#eab308', BIZ:'#f43f5e',
}
const KLASS_TYPICAL_LEG: Record<Klass, [number, number]> = {
  'WB-LH':[1800,7800], 'WB-M':[1200,4800], NB:[400,2400],
  'RGN-J':[200,1100], 'RGN-T':[80,600], BIZ:[600,4800],
}

interface Perf {
  klass: Klass; family: string
  OEW: number      // kg empty
  MZFW: number     // kg max zero-fuel
  MTOW: number     // kg max take-off
  MaxFuel: number  // kg max usable fuel
  FF_lrc: number   // kg/hr LRC fuel-flow at mid-cruise
  TAS_lrc: number  // kt LRC TAS at FL350
  seats: number    // 2-class typical
  ref: string
}
const PERF: Record<string, Perf> = {
  // Boeing widebody long-haul
  B748: { klass:'WB-LH', family:'B747-8I',    OEW:220130, MZFW:295740, MTOW:447700, MaxFuel:191770, FF_lrc:11400, TAS_lrc:490, seats:410, ref:'B747-8 APD §3.2' },
  B744: { klass:'WB-LH', family:'B747-400',   OEW:181000, MZFW:246070, MTOW:396890, MaxFuel:173282, FF_lrc:10500, TAS_lrc:488, seats:416, ref:'B747-400 APD §3.2' },
  B77W: { klass:'WB-LH', family:'B777-300ER', OEW:167830, MZFW:237680, MTOW:351530, MaxFuel:145538, FF_lrc:7700,  TAS_lrc:482, seats:396, ref:'B777-300ER APD §3.2' },
  B772: { klass:'WB-LH', family:'B777-200',   OEW:138100, MZFW:195040, MTOW:247200, MaxFuel:117335, FF_lrc:6800,  TAS_lrc:482, seats:301, ref:'B777-200 APD §3.2' },
  B788: { klass:'WB-LH', family:'B787-8',     OEW:119950, MZFW:161000, MTOW:227930, MaxFuel:101323, FF_lrc:5400,  TAS_lrc:487, seats:248, ref:'B787-8 APD §3.2' },
  B789: { klass:'WB-LH', family:'B787-9',     OEW:128850, MZFW:181000, MTOW:254000, MaxFuel:101323, FF_lrc:5500,  TAS_lrc:487, seats:296, ref:'B787-9 APD §3.2' },
  B78X: { klass:'WB-LH', family:'B787-10',    OEW:135500, MZFW:193000, MTOW:254000, MaxFuel:101323, FF_lrc:5700,  TAS_lrc:487, seats:336, ref:'B787-10 APD §3.2' },
  A388: { klass:'WB-LH', family:'A380-800',   OEW:276800, MZFW:361000, MTOW:575000, MaxFuel:253983, FF_lrc:13100, TAS_lrc:488, seats:525, ref:'A380 ACAP §3.5' },
  A359: { klass:'WB-LH', family:'A350-900',   OEW:135630, MZFW:195700, MTOW:283000, MaxFuel:110500, FF_lrc:5650,  TAS_lrc:488, seats:325, ref:'A350-900 ACAP §3.5' },
  A35K: { klass:'WB-LH', family:'A350-1000',  OEW:155350, MZFW:223000, MTOW:319000, MaxFuel:127720, FF_lrc:5950,  TAS_lrc:488, seats:366, ref:'A350-1000 ACAP §3.5' },
  A332: { klass:'WB-M',  family:'A330-200',   OEW:120150, MZFW:170000, MTOW:242000, MaxFuel:111000, FF_lrc:5800,  TAS_lrc:471, seats:247, ref:'A330-200 ACAP §3.5' },
  A333: { klass:'WB-M',  family:'A330-300',   OEW:124500, MZFW:175000, MTOW:242000, MaxFuel:97170,  FF_lrc:5900,  TAS_lrc:471, seats:277, ref:'A330-300 ACAP §3.5' },
  A339: { klass:'WB-M',  family:'A330-900neo',OEW:137000, MZFW:181000, MTOW:251000, MaxFuel:111000, FF_lrc:5450,  TAS_lrc:471, seats:287, ref:'A330neo ACAP §3.5' },
  B763: { klass:'WB-M',  family:'B767-300ER', OEW:90010,  MZFW:126550, MTOW:186880, MaxFuel:73960,  FF_lrc:4700,  TAS_lrc:460, seats:218, ref:'B767-300 APD §3.2' },
  // Narrowbody
  B737: { klass:'NB', family:'B737-700',  OEW:38150, MZFW:54650, MTOW:70080, MaxFuel:20894, FF_lrc:2350, TAS_lrc:447, seats:128, ref:'B737-700 APD §3.2' },
  B738: { klass:'NB', family:'B737-800',  OEW:41410, MZFW:62730, MTOW:79010, MaxFuel:20894, FF_lrc:2500, TAS_lrc:447, seats:160, ref:'B737-800 APD §3.2' },
  B739: { klass:'NB', family:'B737-900ER',OEW:44680, MZFW:67720, MTOW:85130, MaxFuel:23173, FF_lrc:2580, TAS_lrc:447, seats:180, ref:'B737-900 APD §3.2' },
  B38M: { klass:'NB', family:'B737-8 MAX', OEW:45070, MZFW:65950, MTOW:82190, MaxFuel:20826, FF_lrc:2250, TAS_lrc:453, seats:178, ref:'B737-MAX APD §3.2' },
  B39M: { klass:'NB', family:'B737-9 MAX', OEW:47620, MZFW:69310, MTOW:88300, MaxFuel:20826, FF_lrc:2310, TAS_lrc:453, seats:193, ref:'B737-MAX APD §3.2' },
  B752: { klass:'NB', family:'B757-200',   OEW:58040, MZFW:83460, MTOW:115680, MaxFuel:42680, FF_lrc:3200, TAS_lrc:458, seats:200, ref:'B757-200 APD §3.2' },
  A319: { klass:'NB', family:'A319',     OEW:40800, MZFW:58500, MTOW:75500, MaxFuel:18728, FF_lrc:2370, TAS_lrc:447, seats:144, ref:'A319 ACAP §3.5' },
  A320: { klass:'NB', family:'A320',     OEW:42600, MZFW:62500, MTOW:78000, MaxFuel:18728, FF_lrc:2450, TAS_lrc:447, seats:180, ref:'A320 ACAP §3.5' },
  A321: { klass:'NB', family:'A321',     OEW:48400, MZFW:75500, MTOW:93500, MaxFuel:23700, FF_lrc:2620, TAS_lrc:447, seats:220, ref:'A321 ACAP §3.5' },
  A20N: { klass:'NB', family:'A320neo',  OEW:42600, MZFW:64300, MTOW:79000, MaxFuel:19046, FF_lrc:2120, TAS_lrc:450, seats:186, ref:'A320neo ACAP §3.5' },
  A21N: { klass:'NB', family:'A321neo',  OEW:50100, MZFW:77300, MTOW:97000, MaxFuel:25770, FF_lrc:2280, TAS_lrc:450, seats:230, ref:'A321neo ACAP §3.5' },
  BCS3: { klass:'NB', family:'A220-300', OEW:37080, MZFW:55340, MTOW:67585, MaxFuel:17900, FF_lrc:1950, TAS_lrc:453, seats:160, ref:'A220-300 ACAP §3.5' },
  // Regional jets
  E190: { klass:'RGN-J', family:'E190',  OEW:27840, MZFW:40800, MTOW:51800, MaxFuel:13057, FF_lrc:1500, TAS_lrc:436, seats:106, ref:'E190 APM §3.4' },
  E195: { klass:'RGN-J', family:'E195',  OEW:28970, MZFW:42500, MTOW:52290, MaxFuel:13057, FF_lrc:1550, TAS_lrc:436, seats:124, ref:'E195 APM §3.4' },
  E290: { klass:'RGN-J', family:'E190-E2', OEW:33000, MZFW:45800, MTOW:56400, MaxFuel:13690, FF_lrc:1250, TAS_lrc:447, seats:114, ref:'E190-E2 APM §3.4' },
  E295: { klass:'RGN-J', family:'E195-E2', OEW:35990, MZFW:50790, MTOW:61500, MaxFuel:13690, FF_lrc:1310, TAS_lrc:447, seats:146, ref:'E195-E2 APM §3.4' },
  CRJ9: { klass:'RGN-J', family:'CRJ-900',  OEW:21433, MZFW:32545, MTOW:38329, MaxFuel:8898,  FF_lrc:1320, TAS_lrc:430, seats:88,  ref:'CRJ-900 APM §3.4' },
  // Regional turboprop
  AT72: { klass:'RGN-T', family:'ATR-72-600', OEW:13311, MZFW:21000, MTOW:23000, MaxFuel:5000,  FF_lrc:660,  TAS_lrc:275, seats:72, ref:'ATR-72 APM §3' },
  DH8D: { klass:'RGN-T', family:'Q400',        OEW:17819, MZFW:26308, MTOW:29574, MaxFuel:5318,  FF_lrc:1050, TAS_lrc:362, seats:78, ref:'Q400 APM §3' },
  // Business jets
  GLEX: { klass:'BIZ', family:'Global Express',  OEW:25855, MZFW:33203, MTOW:45132, MaxFuel:18756, FF_lrc:1850, TAS_lrc:488, seats:14, ref:'BD-700 ACAP' },
  G650: { klass:'BIZ', family:'Gulfstream G650', OEW:25800, MZFW:32885, MTOW:45178, MaxFuel:20212, FF_lrc:1700, TAS_lrc:500, seats:18, ref:'G650 ACAP' },
  GLF6: { klass:'BIZ', family:'Gulfstream G650', OEW:25800, MZFW:32885, MTOW:45178, MaxFuel:20212, FF_lrc:1700, TAS_lrc:500, seats:18, ref:'G650 ACAP' },
  FA8X: { klass:'BIZ', family:'Falcon 8X',       OEW:16210, MZFW:22045, MTOW:33113, MaxFuel:16195, FF_lrc:1320, TAS_lrc:484, seats:14, ref:'Falcon-8X ACAP' },
}
const DEFAULT_PERF: Perf = { klass:'NB', family:'generic NB', OEW:42000, MZFW:62000, MTOW:78000, MaxFuel:19000, FF_lrc:2450, TAS_lrc:447, seats:170, ref:'BADA generic' }
function perfFor(type?: string): Perf {
  if (!type) return DEFAULT_PERF
  return PERF[type.toUpperCase()] || DEFAULT_PERF
}

/* ============================================================
   Four-corner PRD computation. For a given Perf row, compute
   R_A (MZFW), R_B (MTOW + max payload), R_C (MTOW + max fuel,
   reduced payload), R_D (ferry / OEW + max fuel).
   We use a simplified Breguet-like proportional model anchored
   on the published LRC fuel-flow + TAS, assuming linear burn
   over still-air range (adequate for trip-planning scope; the
   BREG monitor handles cruise-altitude optimisation).

   block_time_hr = R_NM / TAS_lrc + 0.4h taxi+climb+descent
   fuel_used     = FF_lrc · block_time_hr · (1 + RES_HR/block_hr) · (1+CONT)
   range constraint comes from:
     - point A: fuel = MTOW − MZFW (limited by margin); payload = MZFW − OEW
     - point B: fuel = MTOW − MZFW (same as A, max payload), this is the elbow
                 distance equals A's; B is the breakpoint where payload
                 trades 1:1 with fuel beyond MTOW.
     - point C: fuel = MaxFuel; payload = MTOW − OEW − MaxFuel
                 (only meaningful if MaxFuel > MTOW−MZFW)
     - point D: fuel = MaxFuel; payload = 0; TOW = OEW + MaxFuel
                 (clamped to MTOW)
   ============================================================ */
function rangeFromFuel(fuelKg: number, perf: Perf, resHr: number, contMul: number): number {
  // contingency reduces usable fuel by the contingency fraction reserved
  // reserves consume a fixed FF·resHr of available fuel before block fuel
  const reserve = perf.FF_lrc * resHr
  const usable = Math.max(0, fuelKg - reserve) / (1 + contMul / 100)
  const block_hr = usable / perf.FF_lrc
  // subtract 0.4h taxi/climb/descent equivalent burn (already in FF profile),
  // model that block-NM ≈ TAS·(block_hr − 0.4)
  const NM = perf.TAS_lrc * Math.max(0, block_hr - 0.4)
  return NM
}
function corners(perf: Perf, resHr: number, contMul: number) {
  const fuelAB = perf.MTOW - perf.MZFW            // payload-maxed fuel
  const payloadA = perf.MZFW - perf.OEW
  const R_A = rangeFromFuel(fuelAB, perf, resHr, contMul)
  const R_B = R_A                                 // elbow
  let R_C = R_A, payloadC = payloadA
  if (perf.MaxFuel > fuelAB) {
    const fuelC = perf.MaxFuel
    payloadC = perf.MTOW - perf.OEW - fuelC
    R_C = rangeFromFuel(fuelC, perf, resHr, contMul)
  }
  const fuelD = Math.min(perf.MaxFuel, perf.MTOW - perf.OEW)
  const R_D = rangeFromFuel(fuelD, perf, resHr, contMul)
  return {
    A: { R: R_A, payload: payloadA, fuel: fuelAB, tow: perf.MZFW + fuelAB },
    B: { R: R_B, payload: payloadA, fuel: fuelAB, tow: perf.MTOW },
    C: { R: R_C, payload: Math.max(0, payloadC), fuel: Math.min(perf.MaxFuel, perf.MTOW - perf.OEW), tow: perf.MTOW },
    D: { R: R_D, payload: 0, fuel: fuelD, tow: perf.OEW + fuelD },
  }
}
/* Range-at-payload: linear interpolation through corner points A→B→C→D in
   the (payload, range) plane. Standard PRD shape per Roskam Pt I §3.7 fig 3.10. */
function rangeAtPayload(payload: number, c: ReturnType<typeof corners>, perf: Perf): number {
  if (payload >= c.A.payload) return c.A.R          // can't carry more than MZFW
  if (payload >= c.C.payload) {
    // segment A/B → C: linear interp
    const t = (c.A.payload - payload) / Math.max(1, c.A.payload - c.C.payload)
    return c.A.R + t * (c.C.R - c.A.R)
  }
  // segment C → D
  const t = (c.C.payload - payload) / Math.max(1, c.C.payload - 0)
  return c.C.R + t * (c.D.R - c.C.R)
}

function clamp(v:number,a:number,b:number){return Math.max(a,Math.min(b,v))}
function hashStr(s: string): number { let h=2166136261>>>0; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619)} return h>>>0 }

interface Row {
  f: SFlight
  perf: Perf
  c: ReturnType<typeof corners>
  trip_NM: number
  payload_kg: number
  zfw: number
  fuelReq: number
  tow: number
  R_atPayload: number
  zfwPct: number   // zfw/MZFW
  towPct: number   // tow/MTOW
  fuelPct: number  // fuelReq/MaxFuel
  rngPct: number   // trip / R_atPayload (1.0 = limit)
  drivers: { ZFW:number; TOW:number; FUEL:number; RNG:number; BLOCK:number; CFG:number }
  score: number
  tier: Tier
  worstAxis: 'ZFW'|'TOW'|'FUEL'|'RNG'|'OK'
  advice: string
}

function scoreOne(f: SFlight, perf: Perf, c: ReturnType<typeof corners>, lf: number, cgoMul: number, resHr: number, contMul: number, advMul: number, tripMul: number): Row {
  // trip distance estimate
  const [tLow, tHi] = KLASS_TYPICAL_LEG[perf.klass]
  const h = hashStr(f.icao || (f.callsign||'') + (f.type||''))
  const r01 = ((h >>> 0) / 0xffffffff)
  const gsBias = clamp(f.velocityKts / 480, 0.3, 1.6)
  let trip = (tLow + r01 * (tHi - tLow)) * gsBias * (tripMul / 100)
  trip = clamp(trip, tLow * 0.4, tHi * 1.2)
  // payload
  const paxKg = perf.seats * (lf / 100) * 95     // FAA AC 120-27F standard 95kg
  const cargoBellyMax = Math.max(0, (perf.MZFW - perf.OEW) - paxKg)
  const cargo = cargoBellyMax * (cgoMul / 100)
  const payload = paxKg + cargo
  const zfw = perf.OEW + payload
  // fuel required for trip
  const block_hr = trip / perf.TAS_lrc + 0.4
  const fuelReq = perf.FF_lrc * block_hr * (1 + contMul / 100) + perf.FF_lrc * resHr
  const tow = zfw + fuelReq
  const R_atPayload = rangeAtPayload(payload, c, perf)
  const zfwPct = zfw / perf.MZFW
  const towPct = tow / perf.MTOW
  const fuelPct = fuelReq / perf.MaxFuel
  const rngPct = trip / Math.max(1, R_atPayload)
  // drivers 0..100
  const dZFW = clamp((zfwPct - 0.80) / 0.30 * 100, 0, 120)
  const dTOW = clamp((towPct - 0.80) / 0.30 * 100, 0, 120)
  const dFUEL = clamp((fuelPct - 0.70) / 0.40 * 100, 0, 120)
  const dRNG = clamp((rngPct - 0.70) / 0.40 * 100, 0, 120)
  const dBLOCK = clamp((fuelReq / perf.MaxFuel - 0.6) / 0.4 * 100, 0, 100)
  const dCFG = clamp((payload / (perf.MZFW - perf.OEW) - 0.5) / 0.5 * 50, 0, 60)
  const drivers = { ZFW:dZFW, TOW:dTOW, FUEL:dFUEL, RNG:dRNG, BLOCK:dBLOCK, CFG:dCFG }
  const arr = [dZFW,dTOW,dFUEL,dRNG,dBLOCK,dCFG]
  const mx = Math.max(...arr)
  const mn = arr.reduce((s,v)=>s+v,0) / arr.length
  let score = (mx * 0.68 + mn * 0.32) * (advMul / 100)
  // hard escalators
  if (zfwPct > 1.0) score = Math.max(score, 90)
  if (towPct > 1.0) score = Math.max(score, 92)
  if (rngPct > 1.0) score = Math.max(score, 84)
  if (fuelReq > perf.MaxFuel) score = Math.max(score, 88)
  score = clamp(score, 0, 120)
  // tier
  const onGround = f.ground || (f.altitudeFt || 0) < 5000
  let tier: Tier = 'COMFORTABLE'
  if (onGround) tier = 'IDLE'
  else if (zfwPct > 1.0 || towPct > 1.0) tier = 'OVER-MTOW'
  else if (rngPct > 1.0 || fuelReq > perf.MaxFuel) tier = 'FUEL-LIMITED'
  else if (score >= 60) tier = 'TIGHT'
  else if (score >= 35) tier = 'ADEQUATE'
  else tier = 'COMFORTABLE'
  // worst axis
  let worstAxis: Row['worstAxis'] = 'OK'
  let wv = 0
  if (dZFW > wv) { wv = dZFW; worstAxis = 'ZFW' }
  if (dTOW > wv) { wv = dTOW; worstAxis = 'TOW' }
  if (dFUEL > wv) { wv = dFUEL; worstAxis = 'FUEL' }
  if (dRNG > wv) { wv = dRNG; worstAxis = 'RNG' }
  // advice
  let advice: string
  if (tier === 'OVER-MTOW') advice = `Reduce payload by ${Math.ceil((zfw - perf.MZFW)/100)*100}kg ZFW or ${Math.ceil((tow - perf.MTOW)/100)*100}kg TOW per FCOM PI-WT / 14 CFR §25.25`
  else if (tier === 'FUEL-LIMITED') advice = `Trip ${Math.round(trip)}NM exceeds R-at-payload ${Math.round(R_atPayload)}NM; offload ${Math.ceil((payload - rangeAtPayloadInverse(trip, c))/100)*100}kg or tech-stop per AC 91-79B App.1`
  else if (tier === 'TIGHT') advice = `Brief crew weight-critical · margins ZFW ${Math.round((1-zfwPct)*100)}% TOW ${Math.round((1-towPct)*100)}% per Boeing PEM §2.5`
  else if (tier === 'ADEQUATE') advice = `Standard dispatch · ${Math.round((1-Math.max(zfwPct,towPct,fuelPct))*100)}% worst-axis margin per Airbus GTG Perf §2.3`
  else if (tier === 'COMFORTABLE') advice = `Ample envelope · payload ${Math.round(payload/1000)}t fuel ${Math.round(fuelReq/1000)}t range capability ${Math.round(R_atPayload)}NM vs trip ${Math.round(trip)}NM`
  else advice = `Ground / pre-departure ${perf.family}`
  return { f, perf, c, trip_NM: trip, payload_kg: payload, zfw, fuelReq, tow, R_atPayload, zfwPct, towPct, fuelPct, rngPct, drivers, score, tier, worstAxis, advice }
}
/* For FUEL-LIMITED advice: what payload would fit our trip distance?
   Invert PRD: find payload where R_atPayload = trip. */
function rangeAtPayloadInverse(targetR: number, c: ReturnType<typeof corners>): number {
  if (targetR <= c.A.R) return c.A.payload
  if (targetR >= c.D.R) return 0
  if (targetR <= c.C.R) {
    const t = (targetR - c.A.R) / Math.max(1, c.C.R - c.A.R)
    return c.A.payload + t * (c.C.payload - c.A.payload)
  }
  const t = (targetR - c.C.R) / Math.max(1, c.D.R - c.C.R)
  return c.C.payload + t * (0 - c.C.payload)
}

export default function PrdPayloadRange({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AC'|'CLASS'|'DIAG'>('AC')
  const [lf, setLf] = useState(78)         // load-factor %
  const [cgoMul, setCgoMul] = useState(40) // % of remaining ZFW used for cargo
  const [resHr, setResHr] = useState(1.0)  // hr
  const [contMul, setContMul] = useState(5)// %
  const [advMul, setAdvMul] = useState(100)// %
  const [tripMul, setTripMul] = useState(100)
  const [filterTier, setFilterTier] = useState<Tier | 'ALL'>('ALL')
  const [filterKlass, setFilterKlass] = useState<Klass | 'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [selDiag, setSelDiag] = useState<string | null>(null)

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      const perf = perfFor(f.type)
      const c = corners(perf, resHr, contMul)
      out.push(scoreOne(f, perf, c, lf, cgoMul, resHr, contMul, advMul, tripMul))
    }
    return out
  }, [flights, lf, cgoMul, resHr, contMul, advMul, tripMul])

  const tierCount = useMemo(() => {
    const m: Record<Tier, number> = { 'OVER-MTOW':0, 'FUEL-LIMITED':0, TIGHT:0, ADEQUATE:0, COMFORTABLE:0, IDLE:0 }
    for (const r of rows) m[r.tier]++
    return m
  }, [rows])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter(r => {
      if (filterTier !== 'ALL' && r.tier !== filterTier) return false
      if (filterKlass !== 'ALL' && r.perf.klass !== filterKlass) return false
      if (q && !(r.f.callsign?.toLowerCase().includes(q) || r.f.type?.toLowerCase().includes(q) || r.f.operator?.toLowerCase().includes(q) || r.perf.klass.toLowerCase().includes(q))) return false
      return true
    }).sort((a,b) => {
      const ta = TIER_ORDER.indexOf(a.tier), tb = TIER_ORDER.indexOf(b.tier)
      if (ta !== tb) return ta - tb
      return b.score - a.score
    })
  }, [rows, filterTier, filterKlass, search])

  /* MapLibre overlay layers */
  useEffect(() => {
    if (!map) return
    const SRC = 'prd-src'
    const HALO = 'prd-halo'
    const PIN = 'prd-pin'
    const LBL = 'prd-lbl'
    function ensure() {
      if (!map!.getSource(SRC)) {
        map!.addSource(SRC, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
        map!.addLayer({ id:HALO, type:'circle', source:SRC, filter:['==',['get','kind'],'halo'], paint:{
          'circle-radius':['interpolate',['linear'],['get','score'],0,7,100,19],
          'circle-color':['get','color'], 'circle-opacity':0.18,
          'circle-stroke-color':['get','color'], 'circle-stroke-width':1.6, 'circle-stroke-opacity':0.8,
        }})
        map!.addLayer({ id:PIN, type:'circle', source:SRC, filter:['==',['get','kind'],'pin'], paint:{
          'circle-radius':5.4, 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1.5, 'circle-opacity':0.96,
        }})
        map!.addLayer({ id:LBL, type:'symbol', source:SRC, filter:['==',['get','kind'],'lbl'], layout:{
          'text-field':['get','text'], 'text-size':10, 'text-offset':[0,-1.6], 'text-anchor':'bottom', 'text-allow-overlap':false,
          'text-font':['Open Sans Semibold','Arial Unicode MS Bold'],
        }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a', 'text-halo-width':1.4 }})
      }
    }
    function rebuild() {
      ensure()
      const feats: any[] = []
      for (const r of filtered) {
        if (r.tier === 'IDLE') continue
        const color = TIER_COLOR[r.tier]
        if (showHalo) feats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ kind:'halo', color, score: clamp(r.score, 0, 100) } })
        if (showPin && (r.tier === 'OVER-MTOW' || r.tier === 'FUEL-LIMITED')) {
          feats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ kind:'pin', color } })
        }
        if (showLbl) {
          const m = Math.round((1 - Math.max(r.zfwPct, r.towPct, r.fuelPct, r.rngPct)) * 100)
          const txt = `${r.f.callsign?.trim() || r.f.icao}  ${Math.round(r.trip_NM)}NM  m${m}%`
          feats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ kind:'lbl', color, text: txt } })
        }
      }
      const src = map!.getSource(SRC) as any
      if (src) src.setData({ type:'FeatureCollection', features: feats })
    }
    if ((map as any).isStyleLoaded?.()) rebuild()
    else map.once('load', rebuild)
    rebuild()
    return () => {
      try {
        for (const id of [LBL, PIN, HALO]) if (map.getLayer(id)) map.removeLayer(id)
        if (map.getSource(SRC)) map.removeSource(SRC)
      } catch {}
    }
  }, [map, filtered, showHalo, showPin, showLbl])

  const meanMargin = rows.length ? Math.round(rows.reduce((s,r)=> s + (1 - Math.max(r.zfwPct,r.towPct,r.fuelPct,r.rngPct))*100, 0) / rows.length) : 0
  const worst = rows.length ? [...rows].sort((a,b)=>b.score-a.score)[0] : null
  const sumTrip = Math.round(rows.reduce((s,r)=>s+r.trip_NM,0))

  // classes aggregate
  const classes = useMemo(() => {
    const m: Record<string, { klass: Klass, count:number, sumScore:number, sumZfwPct:number, sumTowPct:number, sumFuelPct:number, tiers: Record<Tier, number> }> = {}
    for (const r of rows) {
      const k = r.perf.klass
      if (!m[k]) m[k] = { klass:k, count:0, sumScore:0, sumZfwPct:0, sumTowPct:0, sumFuelPct:0, tiers:{ 'OVER-MTOW':0, 'FUEL-LIMITED':0, TIGHT:0, ADEQUATE:0, COMFORTABLE:0, IDLE:0 } }
      m[k].count++
      m[k].sumScore += r.score
      m[k].sumZfwPct += r.zfwPct
      m[k].sumTowPct += r.towPct
      m[k].sumFuelPct += r.fuelPct
      m[k].tiers[r.tier]++
    }
    return Object.values(m).sort((a,b)=> (b.sumScore/b.count) - (a.sumScore/a.count))
  }, [rows])

  // diagram airframe selection
  const diagRow = useMemo(() => {
    if (selDiag) return rows.find(r => r.f.icao === selDiag) || filtered[0]
    return filtered[0]
  }, [selDiag, filtered, rows])

  return (
    <div className="absolute top-20 left-4 bottom-6 z-[35] w-[460px] rounded-2xl border border-slate-700 bg-slate-900/95 backdrop-blur-md text-slate-100 flex flex-col overflow-hidden shadow-2xl">
      <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Mission Planning</div>
          <div className="text-base font-semibold">PRD · Payload-Range Envelope</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      {/* Tier strip */}
      <div className="px-3 py-2 border-b border-slate-800 grid grid-cols-7 gap-1 text-[10px]">
        <button onClick={()=>setFilterTier('ALL')} className={`rounded px-1.5 py-1 text-center border ${filterTier==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800/60 border-slate-700 text-slate-300'}`}>
          <div className="font-bold">{rows.length}</div><div className="opacity-70">ALL</div>
        </button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setFilterTier(filterTier===t?'ALL':t)} className={`rounded px-1.5 py-1 text-center border ${filterTier===t?'border-sky-500/40 bg-sky-500/10':'border-slate-700 bg-slate-800/60'}`}>
            <div className="font-bold" style={{ color: TIER_COLOR[t] }}>{tierCount[t]}</div>
            <div className="opacity-70 truncate text-[9px]">{t.replace('OVER-MTOW','OVR').replace('FUEL-LIMITED','FUEL').replace('COMFORTABLE','CMF').replace('ADEQUATE','ADQ')}</div>
          </button>
        ))}
      </div>

      {/* Summary */}
      <div className="px-3 py-2 border-b border-slate-800 grid grid-cols-3 gap-1 text-[10px]">
        <div className="rounded bg-slate-800/60 border border-slate-700 px-2 py-1"><div className="text-slate-500">MEAN MARGIN</div><div className="font-mono font-semibold text-slate-100">{meanMargin}%</div></div>
        <div className="rounded bg-slate-800/60 border border-slate-700 px-2 py-1"><div className="text-slate-500">WORST</div><div className="font-mono font-semibold truncate" style={{ color: worst ? TIER_COLOR[worst.tier] : '#475569' }}>{worst ? (worst.f.callsign?.trim() || worst.f.icao) : '—'}</div></div>
        <div className="rounded bg-slate-800/60 border border-slate-700 px-2 py-1"><div className="text-slate-500">Σ TRIP-NM</div><div className="font-mono font-semibold text-slate-100">{sumTrip.toLocaleString()}</div></div>
        <div className="rounded bg-slate-800/60 border border-slate-700 px-2 py-1"><div className="text-slate-500">OVR-MTOW</div><div className="font-mono font-semibold text-rose-400">{tierCount['OVER-MTOW']}</div></div>
        <div className="rounded bg-slate-800/60 border border-slate-700 px-2 py-1"><div className="text-slate-500">FUEL-LIM</div><div className="font-mono font-semibold text-rose-300">{tierCount['FUEL-LIMITED']}</div></div>
        <div className="rounded bg-slate-800/60 border border-slate-700 px-2 py-1"><div className="text-slate-500">MEAN LF</div><div className="font-mono font-semibold text-slate-100">{lf}%</div></div>
      </div>

      {/* Sliders */}
      <div className="px-3 py-2 border-b border-slate-800 space-y-1.5 text-[10px]">
        {[
          ['LF %', lf, 30, 100, 1, (v:number)=>setLf(v)],
          ['CGO-MUL %', cgoMul, 0, 100, 5, (v:number)=>setCgoMul(v)],
          ['RES-HR', resHr, 0.5, 3.0, 0.1, (v:number)=>setResHr(v)],
          ['CONT-MUL %', contMul, 0, 15, 1, (v:number)=>setContMul(v)],
          ['ADV-MUL %', advMul, 50, 200, 5, (v:number)=>setAdvMul(v)],
          ['TRIP-MUL %', tripMul, 50, 200, 5, (v:number)=>setTripMul(v)],
        ].map(([lab, val, mn, mx, st, fn]) => (
          <div key={lab as string} className="flex items-center gap-2">
            <div className="w-20 text-slate-500">{lab as string}</div>
            <input type="range" min={mn as number} max={mx as number} step={st as number} value={val as number} onChange={(e)=> (fn as (v:number)=>void)(parseFloat(e.target.value))} className="flex-1 accent-sky-500" />
            <div className="w-12 text-right font-mono text-slate-200">{(st as number) < 1 ? (val as number).toFixed(1) : (val as number)}</div>
          </div>
        ))}
      </div>

      {/* Class chip + toggles */}
      <div className="px-3 py-2 border-b border-slate-800 flex flex-wrap gap-1 text-[10px]">
        {(['ALL','WB-LH','WB-M','NB','RGN-J','RGN-T','BIZ'] as const).map(k => (
          <button key={k} onClick={()=> setFilterKlass(filterKlass === k ? 'ALL' : k as any)} className={`rounded-full px-2 py-0.5 border ${filterKlass===k?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800/60 border-slate-700 text-slate-300'} flex items-center gap-1`}>
            {k !== 'ALL' && <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: KLASS_COLOR[k as Klass] }} />}
            {k}
          </button>
        ))}
        <div className="flex-1" />
        {[['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl]].map(([lab,v,fn]) => (
          <button key={lab as string} onClick={()=> (fn as (v:boolean)=>void)(!(v as boolean))} className={`rounded px-1.5 py-0.5 border ${v?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800/60 border-slate-700 text-slate-400'}`}>{lab as string}</button>
        ))}
      </div>

      <div className="px-3 py-2 border-b border-slate-800">
        <input value={search} onChange={(e)=>setSearch(e.target.value)} placeholder="search callsign / type / operator / class" className="w-full bg-slate-800/60 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500/60" />
      </div>

      <div className="px-3 py-1.5 border-b border-slate-800 flex gap-1 text-[10px]">
        {(['AC','CLASS','DIAG'] as const).map(k => (
          <button key={k} onClick={()=>setTab(k)} className={`rounded px-2 py-1 border ${tab===k?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800/60 border-slate-700 text-slate-300'}`}>{k==='AC'?'AIRCRAFT':k==='CLASS'?'CLASSES':'DIAGRAM'}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto text-[11px]">
        {tab === 'AC' && (
          <div className="divide-y divide-slate-800">
            {filtered.slice(0, 80).map((r,i) => {
              const col = TIER_COLOR[r.tier]
              const m = Math.round((1 - Math.max(r.zfwPct, r.towPct, r.fuelPct, r.rngPct)) * 100)
              return (
                <div key={r.f.icao+i} className="px-3 py-2 hover:bg-slate-800/50 cursor-pointer" onClick={()=> { setSelDiag(r.f.icao); onFly(r.f.icao) }}>
                  <div className="flex items-center gap-2">
                    <div className="w-1 h-7 rounded-sm" style={{ background: col }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 truncate">
                        <span className="font-mono text-slate-100 font-semibold">{r.f.callsign?.trim() || r.f.icao}</span>
                        <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
                        <span className="rounded-full px-1.5 py-0 text-[9px] border" style={{ borderColor: KLASS_COLOR[r.perf.klass]+'66', color: KLASS_COLOR[r.perf.klass] }}>{r.perf.klass}</span>
                        <span className="rounded-full px-1.5 py-0 text-[9px]" style={{ background: col+'22', color: col, border:`1px solid ${col}66` }}>{r.tier}</span>
                      </div>
                      <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                        FL{Math.round((r.f.altitudeFt||0)/100)} · {Math.round(r.f.velocityKts)}kt · trip {Math.round(r.trip_NM)}NM · R<sub>p</sub> {Math.round(r.R_atPayload)}NM · margin <span style={{ color: col }}>{m}%</span>
                      </div>
                    </div>
                  </div>
                  {/* mass breakdown */}
                  <div className="mt-1.5 grid grid-cols-4 gap-1 text-[9.5px] font-mono">
                    <div className="rounded bg-slate-800/60 border border-slate-700 px-1.5 py-0.5"><div className="text-slate-500">PAYLD</div><div className="text-slate-200">{Math.round(r.payload_kg/100)/10}t</div></div>
                    <div className="rounded bg-slate-800/60 border border-slate-700 px-1.5 py-0.5"><div className="text-slate-500">ZFW</div><div style={{ color: r.zfwPct>1?TIER_COLOR['OVER-MTOW']:r.zfwPct>0.95?TIER_COLOR.TIGHT:'#cbd5e1' }}>{Math.round(r.zfw/100)/10}t / {Math.round(r.perf.MZFW/100)/10}t</div></div>
                    <div className="rounded bg-slate-800/60 border border-slate-700 px-1.5 py-0.5"><div className="text-slate-500">FUEL</div><div style={{ color: r.fuelPct>1?TIER_COLOR['FUEL-LIMITED']:r.fuelPct>0.92?TIER_COLOR.TIGHT:'#cbd5e1' }}>{Math.round(r.fuelReq/100)/10}t / {Math.round(r.perf.MaxFuel/100)/10}t</div></div>
                    <div className="rounded bg-slate-800/60 border border-slate-700 px-1.5 py-0.5"><div className="text-slate-500">TOW</div><div style={{ color: r.towPct>1?TIER_COLOR['OVER-MTOW']:r.towPct>0.95?TIER_COLOR.TIGHT:'#cbd5e1' }}>{Math.round(r.tow/100)/10}t / {Math.round(r.perf.MTOW/100)/10}t</div></div>
                  </div>
                  {/* 4 corners */}
                  <div className="mt-1 grid grid-cols-4 gap-1 text-[9px] font-mono">
                    <div className="rounded border border-slate-700 px-1 py-0.5 bg-slate-800/40"><span className="text-violet-400">A·MZFW</span> <span className="text-slate-300">{Math.round(r.c.A.R)}NM</span></div>
                    <div className="rounded border border-slate-700 px-1 py-0.5 bg-slate-800/40"><span className="text-sky-400">B·MTOW</span> <span className="text-slate-300">{Math.round(r.c.B.R)}NM</span></div>
                    <div className="rounded border border-slate-700 px-1 py-0.5 bg-slate-800/40"><span className="text-amber-400">C·HVT</span> <span className="text-slate-300">{Math.round(r.c.C.R)}NM</span></div>
                    <div className="rounded border border-slate-700 px-1 py-0.5 bg-slate-800/40"><span className="text-emerald-400">D·FRY</span> <span className="text-slate-300">{Math.round(r.c.D.R)}NM</span></div>
                  </div>
                  {/* score bar */}
                  <div className="mt-1.5 h-1.5 rounded bg-slate-800 overflow-hidden">
                    <div className="h-full" style={{ width: `${Math.min(100, r.score)}%`, background: col }} />
                  </div>
                  {/* drivers */}
                  <div className="mt-1 grid grid-cols-6 gap-1 text-[9px] font-mono">
                    {(['ZFW','TOW','FUEL','RNG','BLOCK','CFG'] as const).map(k => (
                      <div key={k} className="rounded border border-slate-700 px-1 py-0.5 bg-slate-800/40 text-center" style={{ color: r.drivers[k] > 60 ? col : '#94a3b8' }}>
                        <div className="opacity-70 text-[8px]">{k}</div><div>{Math.round(r.drivers[k])}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-1 text-[9.5px] italic" style={{ color: col }}>{r.advice}</div>
                </div>
              )
            })}
            {filtered.length === 0 && <div className="px-3 py-8 text-center text-slate-500">No flights match filter</div>}
          </div>
        )}

        {tab === 'CLASS' && (
          <div className="divide-y divide-slate-800">
            {classes.map((c) => {
              const meanScore = c.sumScore / c.count
              const tier: Tier = c.tiers['OVER-MTOW']>0?'OVER-MTOW':c.tiers['FUEL-LIMITED']>0?'FUEL-LIMITED':meanScore>=60?'TIGHT':meanScore>=35?'ADEQUATE':'COMFORTABLE'
              const col = TIER_COLOR[tier]
              return (
                <div key={c.klass} className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="w-1 h-6 rounded-sm" style={{ background: col }} />
                    <span className="rounded-full px-1.5 py-0 text-[10px] border" style={{ borderColor: KLASS_COLOR[c.klass]+'66', color: KLASS_COLOR[c.klass] }}>{c.klass}</span>
                    <span className="text-slate-400 text-[10px]">{c.count} AC</span>
                    <span className="ml-auto text-[10px] font-mono" style={{ color: col }}>mean score {Math.round(meanScore)}</span>
                  </div>
                  <div className="mt-1 grid grid-cols-3 gap-1 text-[10px] font-mono">
                    <div className="rounded bg-slate-800/60 border border-slate-700 px-1.5 py-0.5"><span className="text-slate-500">ZFW</span> <span className="text-slate-200">{Math.round(c.sumZfwPct/c.count*100)}%</span></div>
                    <div className="rounded bg-slate-800/60 border border-slate-700 px-1.5 py-0.5"><span className="text-slate-500">TOW</span> <span className="text-slate-200">{Math.round(c.sumTowPct/c.count*100)}%</span></div>
                    <div className="rounded bg-slate-800/60 border border-slate-700 px-1.5 py-0.5"><span className="text-slate-500">FUEL</span> <span className="text-slate-200">{Math.round(c.sumFuelPct/c.count*100)}%</span></div>
                  </div>
                  <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden">
                    <div className="h-full" style={{ width: `${Math.min(100, meanScore)}%`, background: KLASS_COLOR[c.klass] }} />
                  </div>
                  <div className="mt-1 flex gap-1 text-[9px] font-mono">
                    {TIER_ORDER.map(t => (
                      <div key={t} className="flex-1 rounded border border-slate-700 px-1 text-center" style={{ color: TIER_COLOR[t] }}>{c.tiers[t]}</div>
                    ))}
                  </div>
                </div>
              )
            })}
            {classes.length === 0 && <div className="px-3 py-8 text-center text-slate-500">No data</div>}
          </div>
        )}

        {tab === 'DIAG' && diagRow && (
          <div className="px-3 py-3">
            <div className="text-[10px] text-slate-400 mb-1">
              <span className="font-mono text-slate-100 font-semibold">{diagRow.f.callsign?.trim() || diagRow.f.icao}</span>
              <span className="ml-2">{diagRow.perf.family}</span>
              <span className="ml-2 italic">{diagRow.perf.ref}</span>
            </div>
            {(() => {
              const W = 410, H = 260, PL = 40, PR = 18, PT = 18, PB = 32
              const R_max = Math.max(diagRow.c.A.R, diagRow.c.D.R) * 1.05
              const P_max = diagRow.c.A.payload * 1.05
              const x = (R: number) => PL + (R / R_max) * (W - PL - PR)
              const y = (P: number) => H - PB - (P / P_max) * (H - PT - PB)
              const poly = [
                `${x(0)},${y(diagRow.c.A.payload)}`,
                `${x(diagRow.c.A.R)},${y(diagRow.c.A.payload)}`,
                `${x(diagRow.c.C.R)},${y(diagRow.c.C.payload)}`,
                `${x(diagRow.c.D.R)},${y(0)}`,
                `${x(0)},${y(0)}`,
              ].join(' ')
              const curX = x(diagRow.trip_NM)
              const curY = y(diagRow.payload_kg)
              const ticksR = [0, 1000, 2000, 4000, 6000, 8000].filter(t => t <= R_max)
              const ticksP = [0, 10000, 25000, 50000, 100000, 200000].filter(t => t <= P_max)
              return (
                <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ background:'#0f172a', borderRadius:6, border:'1px solid #334155' }}>
                  <polygon points={poly} fill="#0ea5e933" stroke="#0ea5e9" strokeWidth={1.2} />
                  {/* axes */}
                  <line x1={PL} y1={H-PB} x2={W-PR} y2={H-PB} stroke="#475569" strokeWidth={1}/>
                  <line x1={PL} y1={H-PB} x2={PL} y2={PT} stroke="#475569" strokeWidth={1}/>
                  {ticksR.map(t => (
                    <g key={'r'+t}>
                      <line x1={x(t)} y1={H-PB} x2={x(t)} y2={H-PB+3} stroke="#475569"/>
                      <text x={x(t)} y={H-PB+12} fontSize={8} fill="#94a3b8" textAnchor="middle">{t}</text>
                    </g>
                  ))}
                  {ticksP.map(t => (
                    <g key={'p'+t}>
                      <line x1={PL-3} y1={y(t)} x2={PL} y2={y(t)} stroke="#475569"/>
                      <text x={PL-5} y={y(t)+3} fontSize={8} fill="#94a3b8" textAnchor="end">{Math.round(t/1000)}t</text>
                    </g>
                  ))}
                  <text x={(W-PR+PL)/2} y={H-4} fontSize={9} fill="#94a3b8" textAnchor="middle">Range [NM]</text>
                  <text x={10} y={PT-4} fontSize={9} fill="#94a3b8">Payload</text>
                  {/* corner markers */}
                  {([['A',diagRow.c.A,'#a855f7'],['B',diagRow.c.B,'#0ea5e9'],['C',diagRow.c.C,'#f59e0b'],['D',diagRow.c.D,'#10b981']] as const).map(([lab,pt,col]) => (
                    <g key={lab as string}>
                      <circle cx={x((pt as any).R)} cy={y((pt as any).payload)} r={4} fill={col as string} stroke="#0f172a" strokeWidth={1}/>
                      <text x={x((pt as any).R)+6} y={y((pt as any).payload)-4} fontSize={9} fill={col as string} fontWeight="bold">{lab}</text>
                    </g>
                  ))}
                  {/* current mission */}
                  <circle cx={curX} cy={curY} r={5.5} fill={TIER_COLOR[diagRow.tier]} stroke="#fff" strokeWidth={1.5}/>
                  <line x1={curX} y1={H-PB} x2={curX} y2={curY} stroke={TIER_COLOR[diagRow.tier]} strokeDasharray="2,2" strokeWidth={0.8}/>
                  <line x1={PL} y1={curY} x2={curX} y2={curY} stroke={TIER_COLOR[diagRow.tier]} strokeDasharray="2,2" strokeWidth={0.8}/>
                  <text x={curX+8} y={curY-6} fontSize={9} fill={TIER_COLOR[diagRow.tier]} fontWeight="bold">CUR</text>
                </svg>
              )
            })()}
            <div className="mt-2 grid grid-cols-4 gap-1 text-[10px] font-mono">
              <div className="rounded bg-slate-800/60 border border-slate-700 px-1.5 py-1"><div className="text-slate-500">OEW</div><div className="text-slate-100">{Math.round(diagRow.perf.OEW/100)/10}t</div></div>
              <div className="rounded bg-slate-800/60 border border-slate-700 px-1.5 py-1"><div className="text-slate-500">MZFW</div><div className="text-violet-300">{Math.round(diagRow.perf.MZFW/100)/10}t</div></div>
              <div className="rounded bg-slate-800/60 border border-slate-700 px-1.5 py-1"><div className="text-slate-500">MTOW</div><div className="text-sky-300">{Math.round(diagRow.perf.MTOW/100)/10}t</div></div>
              <div className="rounded bg-slate-800/60 border border-slate-700 px-1.5 py-1"><div className="text-slate-500">MAX-FUEL</div><div className="text-amber-300">{Math.round(diagRow.perf.MaxFuel/100)/10}t</div></div>
            </div>
            <div className="mt-2 text-[10px] text-slate-400">Click any aircraft in the AIRCRAFT tab to render its diagram here. The shaded sky polygon is the certified payload-range envelope; the white-ringed dot is the current mission (trip-NM × payload-kg).</div>
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500">
        Roskam Pt I §3.7 · Torenbeek Ch.5 · Boeing PEM §2 · Airbus GTG Perf §2.3 · 14 CFR §121.639 · EASA CAT.OP.MPA.150
      </div>
    </div>
  )
}
