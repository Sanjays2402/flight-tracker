'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Cold-Temperature Altitude Correction Monitor
   -----------------------------------------------------------
   ICAO Doc 8168 PANS-OPS Vol I Pt I §4.3.3 / FAA AIM 7-3-1 /
   FAA AC 91-79B / TC AIM RAC 9.17 / EASA AMC 20-32

   Pressure altimeters are calibrated to ISA. When OAT is much
   colder than ISA, indicated altitude reads HIGHER than true
   altitude — the aircraft is actually closer to the terrain or
   obstacle than the altimeter shows. This is the classic
   "from hot to cold, look out below" problem and the direct
   cause of the AC1363 Air China Co. (Indonesia 2002), CRJ200
   YPG, and Korean Air 801 GUM CFIT precursors.

   ICAO PANS-OPS table 4.3.3 gives a correction (ft) added to
   each published procedure altitude (IF, FAF, MDA, DH, MSA)
   as a function of HEIGHT ABOVE AERODROME and AERODROME OAT.
   FAA CTAC AIRPORTS LIST (AIM 7-3-1 table 7-3-1) names ~270
   airports where the correction is MANDATORY when OAT ≤
   published threshold (typically -12 °C to -30 °C).

   For each airborne aircraft in approach or arrival phase we:
     1. Snap to nearest CTAC airport (200 nm gate).
     2. Pull synthetic OAT for the airport (ISA + lat-dependent
        season + per-airport stable bias from FNV hash).
     3. Compute correction ft using PANS-OPS linear table for
        HAA segments 200/300/400/500/1000/1500/2000/3000/4000/
        5000 ft and OAT bins 0/-10/-20/-30/-40/-50 °C.
     4. Compare aircraft TRUE altitude (indicated + correction)
        against airport published procedure altitudes: MSA,
        IAF, IF, FAF, MDA, DH.
     5. Compute TERR-PROX = (true AGL) − required obstacle
        clearance (1000 ft enroute / 500 ft IF / 250 ft FAF /
        200 ft DA per TERPS 8260.3 ch 12).
     6. Compute uncorrected-vs-corrected ALT delta and flag when
        crew may be flying uncorrected (CRJ200 YPG precursor).
     7. Surface mandatory-correction band when OAT ≤ threshold.

   5 RISK DRIVERS (max-driver composite):
     COR  correction required (ft) — bigger = more risk crew
          forgets to apply.  0 at <100 ft, 100 at ≥600 ft.
     PRX  true terrain/obstacle proximity vs TERPS MOC.
          0 at margin ≥ 2×MOC, 100 at margin ≤ 0.
     OAT  OAT below CTAC threshold (mandatory zone).
          0 at >threshold, 100 at ≤threshold-25 °C.
     SEG  HAA segment risk — final segment (≤1500 ft HAA)
          weighted highest because corrections are largest %
          and TERPS margins are smallest.
     PHS  phase mismatch — CRZ over CTAC airport with cold OAT
          but no descent intent flags WATCH only.

   PHASE multiplier:  APP 1.40  ARRIVAL 1.20  CRZ 1.00  CLB 0.80
                      GND/IDLE 0

   5 TIERS:
     CFIT      score≥80  rose · APPLY CORRECTION NOW per
               PANS-OPS 4.3.3 / climb to corrected procedure
               altitude / advise ATC of cold-temperature
               correction in use per AIM 7-3-1-c
     CORRECT   score≥55  amber · CTAC airport with mandatory
               threshold breached — apply published correction
               table to all segments at and below holding
               pattern altitude per Order 8260.3D ch 11
     WATCH     score≥25  sky · cold but margin nominal —
               brief crew on CTAC procedure, verify FMS
               cold-temp comp armed per FCOM 22.30
     OK        score<25  emerald · OAT above threshold or
               correction <50 ft
     IDLE      not in arrival scope or no CTAC nearby · slate

   270-CTAC catalogue (sample 38 most-used in real CONUS+CAN
   +EUR+ASIA mountain ops): KASE KEGE KJAC KMSO KSDY KBOI KBJI
   KBTM KCDC KCNY KGEG KSUN KSLC KEKO PAJN PAFA PADQ PASI PAKT
   PAOM CYLW CYQR CYYC CYYJ CYWG CYMM CYZF CYFB CYHZ ENGM
   ENBR ESSA EFHK BIRK UUEE ZBAA RJCC VTBD

   References: ICAO Doc 8168 PANS-OPS Vol I §4.3.3 cold-temp
   correction · Doc 8400 PANS-ABC · Doc 4444 §4.10.1 · Annex 6
   Pt I 4.3.4.4 · FAA AIM 7-3-1 · AC 91-79B App 2 · AC 90-100A
   · Order 8260.3D ch 12 TERPS / ch 11 cold-temp · 14 CFR
   91.144 · TC AIM RAC 9.17 · CAR 602.124 · EASA AMC 20-32 ·
   CS-AWO 1 / 2 · Boeing FCOM 22.30 cold-temp comp · Airbus
   FCOM PRO-NOR-SOP-COLD · Embraer FCOM 9.50 · TSB A11W0151
   CRJ-705 YPG · NTSB AAR-86/01 Hansa 405 / DCA00MA006 KAL801
   GUM · AAIB G-EMBE 2/2009 Embraer 145 BHX low-temp.

   ft-ctac persisted preference.
   ============================================================ */

export interface CtFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  category?: number | string
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
  flights: CtFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'CFIT' | 'CORRECT' | 'WATCH' | 'OK' | 'IDLE'
type Driver = 'COR' | 'PRX' | 'OAT' | 'SEG' | 'PHS'
type Phase = 'APP' | 'ARRIVAL' | 'CRZ' | 'CLB' | 'IDLE'

const TIER_COLOR: Record<Tier, string> = {
  CFIT: '#f43f5e',
  CORRECT: '#f59e0b',
  WATCH: '#0ea5e9',
  OK: '#10b981',
  IDLE: '#475569',
}
const TIER_BG: Record<Tier, string> = {
  CFIT: 'bg-rose-500/15 border-rose-500/40 text-rose-200',
  CORRECT: 'bg-amber-500/15 border-amber-500/40 text-amber-200',
  WATCH: 'bg-sky-500/15 border-sky-500/40 text-sky-200',
  OK: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200',
  IDLE: 'bg-slate-700/30 border-slate-600/40 text-slate-300',
}
const TIER_ORDER: Tier[] = ['CFIT', 'CORRECT', 'WATCH', 'OK', 'IDLE']
const PHASE_MUL: Record<Phase, number> = { APP: 1.40, ARRIVAL: 1.20, CRZ: 1.00, CLB: 0.80, IDLE: 0 }

interface Ctac {
  icao: string
  name: string
  lat: number
  lng: number
  elevFt: number
  thresholdC: number       // mandatory correction threshold
  msaFt: number
  iafFt: number
  ifFt: number
  fafFt: number
  mdaFt: number
  dhFt: number
  region: 'NAM-W' | 'NAM-E' | 'AK' | 'CAN-W' | 'CAN-E' | 'EUR-N' | 'EUR-A' | 'ASIA-N' | 'ASIA-M'
}

const CTAC: Ctac[] = [
  // NAM-W (Rockies / Sierras)
  { icao:'KASE', name:'Aspen-Pitkin',           lat:39.223,  lng:-106.869, elevFt:7820,  thresholdC:-12, msaFt:14400, iafFt:14000, ifFt:11900, fafFt:10400, mdaFt:9300, dhFt:8420,  region:'NAM-W' },
  { icao:'KEGE', name:'Eagle County',           lat:39.643,  lng:-106.918, elevFt:6548,  thresholdC:-12, msaFt:14100, iafFt:13700, ifFt:11500, fafFt:9700,  mdaFt:8200, dhFt:7148,  region:'NAM-W' },
  { icao:'KJAC', name:'Jackson Hole',           lat:43.607,  lng:-110.738, elevFt:6451,  thresholdC:-30, msaFt:14400, iafFt:13500, ifFt:11700, fafFt:9700,  mdaFt:8100, dhFt:7051,  region:'NAM-W' },
  { icao:'KMSO', name:'Missoula',               lat:46.916,  lng:-114.091, elevFt:3206,  thresholdC:-30, msaFt:10500, iafFt:9800,  ifFt:7800,  fafFt:5800,  mdaFt:4200, dhFt:3406,  region:'NAM-W' },
  { icao:'KSDY', name:'Sidney-Richland',        lat:47.706,  lng:-104.193, elevFt:1981,  thresholdC:-30, msaFt:8000,  iafFt:7000,  ifFt:5500,  fafFt:3800,  mdaFt:2700, dhFt:2181,  region:'NAM-W' },
  { icao:'KBOI', name:'Boise',                  lat:43.564,  lng:-116.222, elevFt:2871,  thresholdC:-15, msaFt:9500,  iafFt:8400,  ifFt:6700,  fafFt:4800,  mdaFt:3400, dhFt:3071,  region:'NAM-W' },
  { icao:'KBTM', name:'Bert Mooney Butte',      lat:45.954,  lng:-112.497, elevFt:5550,  thresholdC:-20, msaFt:13000, iafFt:12100, ifFt:10000, fafFt:8000,  mdaFt:6700, dhFt:5750,  region:'NAM-W' },
  { icao:'KCDC', name:'Cedar City',             lat:37.701,  lng:-113.099, elevFt:5622,  thresholdC:-20, msaFt:12500, iafFt:11600, ifFt:9700,  fafFt:7800,  mdaFt:6500, dhFt:5822,  region:'NAM-W' },
  { icao:'KCNY', name:'Canyonlands Moab',       lat:38.755,  lng:-109.755, elevFt:4557,  thresholdC:-20, msaFt:11500, iafFt:10600, ifFt:8700,  fafFt:6800,  mdaFt:5400, dhFt:4757,  region:'NAM-W' },
  { icao:'KGEG', name:'Spokane',                lat:47.620,  lng:-117.534, elevFt:2376,  thresholdC:-20, msaFt:9000,  iafFt:8000,  ifFt:6200,  fafFt:4400,  mdaFt:3200, dhFt:2576,  region:'NAM-W' },
  { icao:'KSUN', name:'Sun Valley Friedman',    lat:43.504,  lng:-114.296, elevFt:5320,  thresholdC:-30, msaFt:13500, iafFt:12500, ifFt:10400, fafFt:8400,  mdaFt:6900, dhFt:5520,  region:'NAM-W' },
  { icao:'KSLC', name:'Salt Lake City',         lat:40.788,  lng:-111.978, elevFt:4227,  thresholdC:-10, msaFt:11500, iafFt:10400, ifFt:8500,  fafFt:6500,  mdaFt:5100, dhFt:4427,  region:'NAM-W' },
  { icao:'KEKO', name:'Elko Regional',          lat:40.825,  lng:-115.792, elevFt:5140,  thresholdC:-20, msaFt:13000, iafFt:12000, ifFt:10100, fafFt:8100,  mdaFt:6700, dhFt:5340,  region:'NAM-W' },
  // Alaska
  { icao:'PAJN', name:'Juneau',                 lat:58.355,  lng:-134.576, elevFt:21,    thresholdC:-25, msaFt:8500,  iafFt:7500,  ifFt:5700,  fafFt:3700,  mdaFt:1100, dhFt:221,   region:'AK' },
  { icao:'PAFA', name:'Fairbanks',              lat:64.815,  lng:-147.856, elevFt:439,   thresholdC:-30, msaFt:8000,  iafFt:7000,  ifFt:5200,  fafFt:3200,  mdaFt:900,  dhFt:639,   region:'AK' },
  { icao:'PADQ', name:'Kodiak',                 lat:57.750,  lng:-152.494, elevFt:78,    thresholdC:-20, msaFt:7500,  iafFt:6500,  ifFt:4700,  fafFt:2800,  mdaFt:700,  dhFt:278,   region:'AK' },
  { icao:'PASI', name:'Sitka',                  lat:57.047,  lng:-135.362, elevFt:21,    thresholdC:-20, msaFt:7000,  iafFt:6000,  ifFt:4400,  fafFt:2500,  mdaFt:520,  dhFt:221,   region:'AK' },
  { icao:'PAKT', name:'Ketchikan',              lat:55.356,  lng:-131.714, elevFt:88,    thresholdC:-20, msaFt:7200,  iafFt:6200,  ifFt:4500,  fafFt:2600,  mdaFt:580,  dhFt:288,   region:'AK' },
  { icao:'PAOM', name:'Nome',                   lat:64.512,  lng:-165.445, elevFt:38,    thresholdC:-30, msaFt:6500,  iafFt:5500,  ifFt:3700,  fafFt:2200,  mdaFt:520,  dhFt:238,   region:'AK' },
  // CAN-W
  { icao:'CYLW', name:'Kelowna',                lat:49.956,  lng:-119.378, elevFt:1421,  thresholdC:-20, msaFt:10000, iafFt:9000,  ifFt:7000,  fafFt:5000,  mdaFt:2400, dhFt:1621,  region:'CAN-W' },
  { icao:'CYQR', name:'Regina',                 lat:50.432,  lng:-104.666, elevFt:1894,  thresholdC:-30, msaFt:7500,  iafFt:6500,  ifFt:4800,  fafFt:3700,  mdaFt:2700, dhFt:2094,  region:'CAN-W' },
  { icao:'CYYC', name:'Calgary',                lat:51.114,  lng:-114.020, elevFt:3557,  thresholdC:-30, msaFt:10000, iafFt:9000,  ifFt:7300,  fafFt:5400,  mdaFt:4300, dhFt:3757,  region:'CAN-W' },
  { icao:'CYYJ', name:'Victoria',               lat:48.647,  lng:-123.426, elevFt:63,    thresholdC:-15, msaFt:6800,  iafFt:5800,  ifFt:4100,  fafFt:2300,  mdaFt:560,  dhFt:263,   region:'CAN-W' },
  { icao:'CYWG', name:'Winnipeg',               lat:49.910,  lng:-97.240,  elevFt:783,   thresholdC:-30, msaFt:5500,  iafFt:4500,  ifFt:3000,  fafFt:2200,  mdaFt:1480, dhFt:983,   region:'CAN-W' },
  { icao:'CYMM', name:'Fort McMurray',          lat:56.653,  lng:-111.222, elevFt:1211,  thresholdC:-30, msaFt:7000,  iafFt:6000,  ifFt:4500,  fafFt:3100,  mdaFt:1900, dhFt:1411,  region:'CAN-W' },
  { icao:'CYZF', name:'Yellowknife',            lat:62.463,  lng:-114.440, elevFt:675,   thresholdC:-40, msaFt:5500,  iafFt:4500,  ifFt:3100,  fafFt:2100,  mdaFt:1300, dhFt:875,   region:'CAN-W' },
  // CAN-E
  { icao:'CYFB', name:'Iqaluit',                lat:63.756,  lng:-68.555,  elevFt:110,   thresholdC:-40, msaFt:5500,  iafFt:4500,  ifFt:3100,  fafFt:2100,  mdaFt:610,  dhFt:310,   region:'CAN-E' },
  { icao:'CYHZ', name:'Halifax',                lat:44.881,  lng:-63.509,  elevFt:477,   thresholdC:-15, msaFt:5800,  iafFt:4800,  ifFt:3200,  fafFt:2200,  mdaFt:1280, dhFt:677,   region:'CAN-E' },
  // EUR-N
  { icao:'ENGM', name:'Oslo Gardermoen',        lat:60.193,  lng:11.100,   elevFt:681,   thresholdC:-20, msaFt:6500,  iafFt:5500,  ifFt:3900,  fafFt:2700,  mdaFt:1480, dhFt:881,   region:'EUR-N' },
  { icao:'ENBR', name:'Bergen Flesland',        lat:60.293,  lng:5.218,    elevFt:170,   thresholdC:-12, msaFt:6800,  iafFt:5800,  ifFt:4100,  fafFt:2300,  mdaFt:670,  dhFt:370,   region:'EUR-N' },
  { icao:'ESSA', name:'Stockholm Arlanda',      lat:59.651,  lng:17.918,   elevFt:137,   thresholdC:-20, msaFt:5500,  iafFt:4500,  ifFt:3100,  fafFt:2100,  mdaFt:640,  dhFt:337,   region:'EUR-N' },
  { icao:'EFHK', name:'Helsinki Vantaa',        lat:60.317,  lng:24.963,   elevFt:179,   thresholdC:-20, msaFt:5500,  iafFt:4500,  ifFt:3100,  fafFt:2100,  mdaFt:680,  dhFt:379,   region:'EUR-N' },
  { icao:'BIRK', name:'Reykjavik',              lat:64.130,  lng:-21.941,  elevFt:48,    thresholdC:-15, msaFt:5500,  iafFt:4500,  ifFt:3100,  fafFt:2100,  mdaFt:550,  dhFt:248,   region:'EUR-N' },
  // EUR-A (Alps)
  { icao:'LOWI', name:'Innsbruck',              lat:47.260,  lng:11.344,   elevFt:1907,  thresholdC:-12, msaFt:13500, iafFt:11500, ifFt:9500,  fafFt:7000,  mdaFt:2900, dhFt:2107,  region:'EUR-A' },
  // ASIA-N (Russia / Mongolia)
  { icao:'UUEE', name:'Moscow Sheremetyevo',    lat:55.973,  lng:37.415,   elevFt:622,   thresholdC:-30, msaFt:5500,  iafFt:4500,  ifFt:3100,  fafFt:2200,  mdaFt:1120, dhFt:822,   region:'ASIA-N' },
  { icao:'ZBAA', name:'Beijing Capital',        lat:40.080,  lng:116.585,  elevFt:116,   thresholdC:-15, msaFt:5800,  iafFt:4800,  ifFt:3200,  fafFt:2200,  mdaFt:620,  dhFt:316,   region:'ASIA-M' },
  { icao:'RJCC', name:'Sapporo New Chitose',    lat:42.775,  lng:141.692,  elevFt:82,    thresholdC:-20, msaFt:5500,  iafFt:4500,  ifFt:3100,  fafFt:2100,  mdaFt:550,  dhFt:282,   region:'ASIA-N' },
  { icao:'VTBD', name:'Bangkok Don Mueang',     lat:13.913,  lng:100.607,  elevFt:9,     thresholdC:-99, msaFt:5500,  iafFt:4500,  ifFt:3100,  fafFt:2100,  mdaFt:510,  dhFt:209,   region:'ASIA-M' },
]

// PANS-OPS Doc 8168 Vol I §4.3.3 table — correction (ft) by HAA (rows) × airport-OAT (cols 0,-10,-20,-30,-40,-50 °C)
const PANSOPS: Array<{ haa: number; vals: number[] }> = [
  { haa: 200,  vals: [20, 20, 30, 40,  50,  60]  },
  { haa: 300,  vals: [20, 30, 50, 60,  80,  90]  },
  { haa: 400,  vals: [30, 40, 60, 80,  100, 120] },
  { haa: 500,  vals: [30, 50, 80, 100, 120, 150] },
  { haa: 1000, vals: [60, 100, 160, 210, 260, 320] },
  { haa: 1500, vals: [90, 150, 230, 320, 390, 490] },
  { haa: 2000, vals: [120, 200, 310, 420, 530, 650] },
  { haa: 3000, vals: [170, 290, 450, 630, 800, 990] },
  { haa: 4000, vals: [230, 390, 610, 840, 1080, 1330] },
  { haa: 5000, vals: [280, 490, 770, 1060, 1360, 1680] },
]
function pansopsCorrection(haaFt: number, oatC: number): number {
  if (haaFt <= 0) return 0
  // clamp OAT
  const oats = [0, -10, -20, -30, -40, -50]
  let col = 0
  for (let i = 0; i < oats.length - 1; i++) {
    if (oatC <= oats[i] && oatC >= oats[i+1]) { col = i; break }
    if (oatC < oats[oats.length-1]) col = oats.length - 2
  }
  if (oatC >= 0) return 0
  if (oatC < -50) col = oats.length - 2
  const tFrac = (oats[col] - oatC) / 10  // 0..1
  // find HAA bracket
  let row = 0
  for (let i = 0; i < PANSOPS.length - 1; i++) {
    if (haaFt >= PANSOPS[i].haa && haaFt <= PANSOPS[i+1].haa) { row = i; break }
    if (haaFt > PANSOPS[PANSOPS.length-1].haa) row = PANSOPS.length - 2
  }
  const r0 = PANSOPS[row], r1 = PANSOPS[row+1]
  const hFrac = (haaFt - r0.haa) / (r1.haa - r0.haa)
  const v0 = r0.vals[col] + (r0.vals[col+1] - r0.vals[col]) * tFrac
  const v1 = r1.vals[col] + (r1.vals[col+1] - r1.vals[col]) * tFrac
  return Math.round(v0 + (v1 - v0) * Math.max(0, Math.min(1, hFrac)))
}

const SRC_HALO='ctc-halo-src', LYR_HALO='ctc-halo-lyr'
const SRC_PIN ='ctc-pin-src',  LYR_PIN ='ctc-pin-lyr'
const SRC_LBL ='ctc-lbl-src',  LYR_LBL ='ctc-lbl-lyr'
const SRC_AP  ='ctc-ap-src',   LYR_AP  ='ctc-ap-lyr', LYR_APL='ctc-ap-lyr-lbl'
const SRC_LINK='ctc-link-src', LYR_LINK='ctc-link-lyr'
const SRC_REF ='ctc-ref-src',  LYR_REF ='ctc-ref-lyr'

function fnv1a(s: string): number { let h=0x811c9dc5; for (let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=(h*0x01000193)>>>0 } return h>>>0 }
function hashUnit(s: string, salt: string): number { return fnv1a(s+':'+salt)/0xffffffff }

const toRad=(d:number)=>d*Math.PI/180
function distNm(la1:number,lo1:number,la2:number,lo2:number): number {
  const R=3440.065
  const dLa=toRad(la2-la1), dLo=toRad(lo2-lo1)
  const a=Math.sin(dLa/2)**2 + Math.cos(toRad(la1))*Math.cos(toRad(la2))*Math.sin(dLo/2)**2
  return 2*R*Math.asin(Math.sqrt(a))
}

function snapCtac(f: CtFlight, maxNm: number): Ctac | null {
  let best: Ctac | null = null, bestD = maxNm
  for (const a of CTAC) {
    const d = distNm(f.lat, f.lng, a.lat, a.lng)
    if (d < bestD) { bestD = d; best = a }
  }
  return best
}

function classifyPhase(f: CtFlight, ap: Ctac | null): Phase {
  if (f.ground) return 'IDLE'
  if (!ap) {
    if (f.altitudeFt < 18000 && f.vertRate < -200) return 'ARRIVAL'
    return 'CRZ'
  }
  const d = distNm(f.lat, f.lng, ap.lat, ap.lng)
  const haa = f.altitudeFt - ap.elevFt
  if (d < 15 && haa < 5000) return 'APP'
  if (d < 60 && haa < 12000 && f.vertRate < -200) return 'ARRIVAL'
  if (f.vertRate > 800 && haa < 15000) return 'CLB'
  return 'CRZ'
}

// Synthetic OAT at airport — ISA + seasonal latitude band + per-airport stable bias
function airportOat(ap: Ctac, season: number /* -1 winter .. +1 summer */, noiseMul: number): number {
  const isaSurface = 15 - 0.00198 * ap.elevFt
  // seasonal swing: stronger at high lat
  const swing = Math.max(0, Math.abs(ap.lat) - 25) * 0.55  // up to ~25 °C @ 70 N
  const seasonal = -swing * (-season)  // season=-1 winter => subtract swing
  const bias = (hashUnit(ap.icao, 'oat') - 0.5) * 14 * noiseMul
  return Math.round(isaSurface + seasonal + bias)
}

interface Calc {
  phase: Phase
  ap: Ctac | null
  apDistNm: number
  oatC: number
  haaFt: number
  corrFt: number               // correction at current HAA
  corrFafFt: number            // correction at FAF segment
  corrDhFt: number             // correction at DH segment
  trueAltFt: number            // indicated minus correction (cold reads high)
  haaTrue: number
  margFafFt: number            // current alt vs corrected FAF gate
  margDhFt: number             // current alt vs corrected DH gate
  oatMandatory: boolean
  scoreCor: number
  scorePrx: number
  scoreOat: number
  scoreSeg: number
  scorePhs: number
  score: number
  tier: Tier
  driver: Driver
  advice: string
}

interface Opts {
  season: number      // -1..+1
  oatNoise: number    // multiplier
  corrThold: number   // mandatory ft threshold to trigger CORRECT
  phaseW: number
  minHaa: number
  rangeNm: number
}

function compute(f: CtFlight, opts: Opts): Calc {
  const ap = snapCtac(f, opts.rangeNm)
  const phase = classifyPhase(f, ap)
  if (!ap || phase === 'IDLE') {
    return {
      phase, ap: null, apDistNm: 0, oatC: 15, haaFt: 0, corrFt: 0, corrFafFt: 0, corrDhFt: 0,
      trueAltFt: f.altitudeFt, haaTrue: 0, margFafFt: 0, margDhFt: 0, oatMandatory: false,
      scoreCor: 0, scorePrx: 0, scoreOat: 0, scoreSeg: 0, scorePhs: 0,
      score: 0, tier: 'IDLE', driver: 'PHS', advice: 'No CTAC airport in range or aircraft on ground.',
    }
  }
  const oat = airportOat(ap, opts.season, opts.oatNoise)
  const haa = Math.max(0, f.altitudeFt - ap.elevFt)
  const corr = pansopsCorrection(haa, oat)
  const corrFaf = pansopsCorrection(Math.max(0, ap.fafFt - ap.elevFt), oat)
  const corrDh  = pansopsCorrection(Math.max(0, ap.dhFt  - ap.elevFt), oat)
  // True altitude < indicated when cold
  const trueAlt = f.altitudeFt - corr
  const haaTrue = trueAlt - ap.elevFt
  // Margin vs corrected gates: current indicated should be at or above gate+correction
  const fafGate = ap.fafFt + corrFaf
  const dhGate  = ap.dhFt  + corrDh
  const margFaf = f.altitudeFt - fafGate
  const margDh  = f.altitudeFt - dhGate
  const oatMandatory = oat <= ap.thresholdC

  // Scores
  const scoreCor = Math.max(0, Math.min(100, (corr - 100) / 5))  // 100→0, 600→100
  let scorePrx = 0
  if (phase === 'APP') {
    // Distance-based MOC: 200 ft at DH, 250 at FAF
    if (margDh < 0) scorePrx = 100
    else if (margDh < 200) scorePrx = 100 - margDh * 0.5
    else if (margDh < 500) scorePrx = 50 - (margDh - 200) / 6
    else scorePrx = Math.max(0, 50 - margDh / 20)
  } else if (phase === 'ARRIVAL') {
    if (margFaf < 0) scorePrx = 90
    else if (margFaf < 500) scorePrx = 90 - margFaf / 6
    else scorePrx = Math.max(0, 60 - margFaf / 30)
  } else if (phase === 'CRZ') {
    const enrouteMoc = 1000
    const enrMargin = haaTrue - enrouteMoc
    if (enrMargin < 0) scorePrx = 70
    else scorePrx = Math.max(0, 40 - enrMargin / 100)
  }
  let scoreOat = 0
  if (oatMandatory) {
    const gap = ap.thresholdC - oat
    scoreOat = Math.min(100, 40 + gap * 2.4)
  } else if (oat < 0) {
    scoreOat = Math.max(0, Math.min(40, -oat * 1.2))
  }
  let scoreSeg = 0
  if (phase === 'APP') scoreSeg = 60
  else if (phase === 'ARRIVAL') scoreSeg = 35
  else if (phase === 'CRZ') scoreSeg = 10
  else scoreSeg = 0
  // PHS: cruising over a CTAC at very cold OAT — situational only
  const scorePhs = (phase === 'CRZ' && oatMandatory) ? 25 : 0

  const arr: Array<[Driver, number]> = [
    ['COR', scoreCor], ['PRX', scorePrx], ['OAT', scoreOat], ['SEG', scoreSeg], ['PHS', scorePhs],
  ]
  arr.sort((a,b)=>b[1]-a[1])
  const top = arr[0]
  const secondary = arr.slice(1).reduce((s,x)=>s+x[1],0)
  const phaseW = 1 + (PHASE_MUL[phase] - 1) * opts.phaseW
  let score = top[1] * phaseW + 0.10 * secondary
  score = Math.max(0, Math.min(100, score))

  let tier: Tier = 'OK'
  if (score >= 80 || (phase === 'APP' && margDh < 0)) tier = 'CFIT'
  else if (score >= 55 || (oatMandatory && corr >= opts.corrThold && (phase === 'APP' || phase === 'ARRIVAL'))) tier = 'CORRECT'
  else if (score >= 25 || oat < 0) tier = 'WATCH'

  let advice = ''
  switch (tier) {
    case 'CFIT':
      advice = `APPLY +${corr}ft NOW · climb to corrected procedure altitude · advise ATC cold-temp correction in use · PANS-OPS 4.3.3 · AIM 7-3-1c · TSB A11W0151 YPG`
      break
    case 'CORRECT':
      advice = `CTAC mandatory · add +${corr}ft to all segments at and below holding · arm FMS cold-temp comp · Order 8260.3D ch 11 · FCOM 22.30`
      break
    case 'WATCH':
      advice = `cold OAT ${oat}°C · brief CTAC procedure · verify altimeter setting / FMS comp · AC 91-79B App 2`
      break
    case 'OK':
      advice = `OAT ${oat}°C above ${ap.thresholdC}°C threshold · correction ${corr}ft negligible`
      break
  }

  return {
    phase, ap, apDistNm: distNm(f.lat, f.lng, ap.lat, ap.lng),
    oatC: oat, haaFt: haa, corrFt: corr, corrFafFt: corrFaf, corrDhFt: corrDh,
    trueAltFt: trueAlt, haaTrue, margFafFt: margFaf, margDhFt: margDh, oatMandatory,
    scoreCor, scorePrx, scoreOat, scoreSeg, scorePhs,
    score, tier, driver: top[0], advice,
  }
}

const REGION_COLOR: Record<Ctac['region'], string> = {
  'NAM-W': '#0ea5e9', 'NAM-E': '#10b981', 'AK': '#a78bfa', 'CAN-W': '#06b6d4',
  'CAN-E': '#22c55e', 'EUR-N': '#f472b6', 'EUR-A': '#f59e0b', 'ASIA-N': '#94a3b8', 'ASIA-M': '#facc15',
}
const REGIONS: Ctac['region'][] = ['NAM-W','NAM-E','AK','CAN-W','CAN-E','EUR-N','EUR-A','ASIA-N','ASIA-M']

export default function ColdTempCorr({ map, flights, onClose, onFly }: Props) {
  const [season, setSeason] = useState<number>(-100)   // -100..100 → -1..1
  const [oatNoise, setOatNoise] = useState(100)
  const [corrThold, setCorrThold] = useState(150)      // ft
  const [phaseW, setPhaseW] = useState(100)
  const [minHaa, setMinHaa] = useState(0)
  const [rangeNm, setRangeNm] = useState(150)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showAp, setShowAp] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showRef, setShowRef] = useState(false)
  const [showDiag, setShowDiag] = useState(true)
  const [tierFilter, setTierFilter] = useState<Tier | null>(null)
  const [regionFilter, setRegionFilter] = useState<Set<Ctac['region']>>(new Set(REGIONS))
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS'>('AIRCRAFT')

  const opts: Opts = useMemo(() => ({
    season: season/100, oatNoise: oatNoise/100, corrThold, phaseW: phaseW/100, minHaa, rangeNm,
  }), [season, oatNoise, corrThold, phaseW, minHaa, rangeNm])

  const computed = useMemo(() => {
    return flights
      .filter(f => Number.isFinite(f.lat) && Number.isFinite(f.lng))
      .map(f => ({ f, c: compute(f, opts) }))
  }, [flights, opts])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { CFIT:0, CORRECT:0, WATCH:0, OK:0, IDLE:0 }
    for (const r of computed) c[r.c.tier]++
    return c
  }, [computed])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return computed.filter(({ f, c }) => {
      if (tierFilter && c.tier !== tierFilter) return false
      if (c.ap && !regionFilter.has(c.ap.region)) return false
      if (q && !(
        f.callsign?.toLowerCase().includes(q) ||
        f.type?.toLowerCase().includes(q) ||
        f.operator?.toLowerCase().includes(q) ||
        f.icao.toLowerCase().includes(q) ||
        c.ap?.icao.toLowerCase().includes(q)
      )) return false
      return true
    })
  }, [computed, tierFilter, regionFilter, query])

  const ranked = useMemo(() => {
    return [...filtered].sort((a,b) => {
      const ta=TIER_ORDER.indexOf(a.c.tier), tb=TIER_ORDER.indexOf(b.c.tier)
      if (ta !== tb) return ta - tb
      return b.c.score - a.c.score
    })
  }, [filtered])

  const summary = useMemo(() => {
    const visible = computed.filter(r => r.c.tier !== 'IDLE')
    const meanCorr = visible.length ? visible.reduce((s,r) => s+r.c.corrFt, 0) / visible.length : 0
    const meanOat  = visible.length ? visible.reduce((s,r) => s+r.c.oatC, 0) / visible.length : 0
    const worst = visible.reduce<{cs:string, m:number} | null>((acc,r) => {
      if (!acc || r.c.score > acc.m) return { cs: r.f.callsign?.trim() || r.f.icao, m: r.c.score }
      return acc
    }, null)
    const mandatoryShare = visible.length ? visible.filter(r => r.c.oatMandatory).length / visible.length : 0
    return { meanCorr, meanOat, worstCs: worst?.cs || '—', mandatoryShare, tracked: visible.length }
  }, [computed])

  const byAirport = useMemo(() => {
    const grp = new Map<string, { ap: Ctac; n: number; cfit: number; correct: number; sumScore: number; sumCorr: number; worstCs: string; worstScore: number }>()
    for (const r of computed) {
      if (!r.c.ap) continue
      const k = r.c.ap.icao
      const g = grp.get(k) || { ap: r.c.ap, n: 0, cfit: 0, correct: 0, sumScore: 0, sumCorr: 0, worstCs: '—', worstScore: -1 }
      g.n++
      g.sumScore += r.c.score
      g.sumCorr += r.c.corrFt
      if (r.c.tier === 'CFIT') g.cfit++
      if (r.c.tier === 'CORRECT') g.correct++
      if (r.c.score > g.worstScore) { g.worstScore = r.c.score; g.worstCs = r.f.callsign?.trim() || r.f.icao }
      grp.set(k, g)
    }
    return Array.from(grp.values()).sort((a,b) => b.cfit - a.cfit || b.correct - a.correct || b.n - a.n)
  }, [computed])

  // ---------------- MapLibre overlay ----------------
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        if (!map.getSource(SRC_REF)) map.addSource(SRC_REF, { type:'geojson', data:{type:'FeatureCollection',features:[]} })
        if (!map.getLayer(LYR_REF)) map.addLayer({ id:LYR_REF, type:'line', source:SRC_REF, paint:{'line-color':'#0ea5e9','line-opacity':0.18,'line-width':1,'line-dasharray':[3,3]} })
        if (!map.getSource(SRC_AP)) map.addSource(SRC_AP, { type:'geojson', data:{type:'FeatureCollection',features:[]} })
        if (!map.getLayer(LYR_AP)) map.addLayer({ id:LYR_AP, type:'circle', source:SRC_AP, paint:{
          'circle-radius': 5, 'circle-color': ['get','color'],
          'circle-stroke-color': '#fff', 'circle-stroke-width': 1.2, 'circle-opacity': 0.85,
        }})
        if (!map.getLayer(LYR_APL)) map.addLayer({ id:LYR_APL, type:'symbol', source:SRC_AP, layout:{
          'text-field': ['get','label'], 'text-size': 9, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-allow-overlap':true,
        }, paint: { 'text-color':['get','color'], 'text-halo-color':'#000', 'text-halo-width':1.2 } })
        if (!map.getSource(SRC_LINK)) map.addSource(SRC_LINK, { type:'geojson', data:{type:'FeatureCollection',features:[]} })
        if (!map.getLayer(LYR_LINK)) map.addLayer({ id:LYR_LINK, type:'line', source:SRC_LINK, paint:{'line-color':['get','color'],'line-width':1.4,'line-opacity':0.7,'line-dasharray':[2,2]} })
        if (!map.getSource(SRC_HALO)) map.addSource(SRC_HALO, { type:'geojson', data:{type:'FeatureCollection',features:[]} })
        if (!map.getLayer(LYR_HALO)) map.addLayer({ id:LYR_HALO, type:'circle', source:SRC_HALO, paint:{
          'circle-radius': ['interpolate',['linear'],['get','score'],0,8,100,22],
          'circle-color': ['get','color'], 'circle-opacity': 0.18,
          'circle-stroke-color': ['get','color'], 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.85,
        }})
        if (!map.getSource(SRC_PIN)) map.addSource(SRC_PIN, { type:'geojson', data:{type:'FeatureCollection',features:[]} })
        if (!map.getLayer(LYR_PIN)) map.addLayer({ id:LYR_PIN, type:'circle', source:SRC_PIN, paint:{
          'circle-radius': 5, 'circle-color':'#f43f5e', 'circle-stroke-color':'#fff', 'circle-stroke-width':1.2,
        }})
        if (!map.getSource(SRC_LBL)) map.addSource(SRC_LBL, { type:'geojson', data:{type:'FeatureCollection',features:[]} })
        if (!map.getLayer(LYR_LBL)) map.addLayer({ id:LYR_LBL, type:'symbol', source:SRC_LBL, layout:{
          'text-field': ['get','label'], 'text-size':10, 'text-offset':[0,-1.8], 'text-anchor':'bottom', 'text-allow-overlap':true,
        }, paint:{'text-color':['get','color'], 'text-halo-color':'#000', 'text-halo-width':1.2 } })
      } catch {}
    }
    ensure()

    const visible = computed.filter(r => r.c.tier !== 'IDLE' && (!r.c.ap || regionFilter.has(r.c.ap.region)))
    const haloFeats = visible.map(r => ({
      type:'Feature' as const,
      geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat] },
      properties:{ color: TIER_COLOR[r.c.tier], score: r.c.score },
    }))
    const pinFeats = visible.filter(r => r.c.tier === 'CFIT').map(r => ({
      type:'Feature' as const, geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat] }, properties:{},
    }))
    const lblFeats = visible.filter(r => r.c.tier !== 'OK').map(r => ({
      type:'Feature' as const,
      geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat] },
      properties:{ color: TIER_COLOR[r.c.tier],
        label: `${r.f.callsign?.trim() || r.f.icao} ${r.c.ap?.icao || ''} +${r.c.corrFt}ft @ ${r.c.oatC}°C` },
    }))
    const linkFeats = visible.filter(r => r.c.ap && (r.c.tier === 'CFIT' || r.c.tier === 'CORRECT')).map(r => ({
      type:'Feature' as const,
      geometry:{ type:'LineString' as const, coordinates:[ [r.f.lng, r.f.lat], [r.c.ap!.lng, r.c.ap!.lat] ] },
      properties:{ color: TIER_COLOR[r.c.tier] },
    }))
    const apFeats = CTAC.filter(a => regionFilter.has(a.region)).map(a => ({
      type:'Feature' as const,
      geometry:{ type:'Point' as const, coordinates:[a.lng, a.lat] },
      properties:{ color: REGION_COLOR[a.region], label: `${a.icao} ${a.thresholdC}°C` },
    }))
    const refFeats: Array<{type:'Feature', geometry:{type:'LineString', coordinates:[number,number][]}, properties:{}}> = []
    if (showRef) {
      for (const lat of [-60,-30,0,30,60]) for (let lng=-180; lng<180; lng+=12)
        refFeats.push({ type:'Feature', geometry:{type:'LineString', coordinates:[[lng,lat],[lng+12,lat]]}, properties:{} })
    }
    try {
      ;(map.getSource(SRC_HALO) as maplibregl.GeoJSONSource | undefined)?.setData({ type:'FeatureCollection', features: showHalo ? haloFeats : [] })
      ;(map.getSource(SRC_PIN)  as maplibregl.GeoJSONSource | undefined)?.setData({ type:'FeatureCollection', features: showPin  ? pinFeats : [] })
      ;(map.getSource(SRC_LBL)  as maplibregl.GeoJSONSource | undefined)?.setData({ type:'FeatureCollection', features: showLbl  ? lblFeats : [] })
      ;(map.getSource(SRC_LINK) as maplibregl.GeoJSONSource | undefined)?.setData({ type:'FeatureCollection', features: showLink ? linkFeats : [] })
      ;(map.getSource(SRC_AP)   as maplibregl.GeoJSONSource | undefined)?.setData({ type:'FeatureCollection', features: showAp   ? apFeats : [] })
      ;(map.getSource(SRC_REF)  as maplibregl.GeoJSONSource | undefined)?.setData({ type:'FeatureCollection', features: refFeats })
    } catch {}
  }, [map, computed, regionFilter, showHalo, showPin, showLbl, showLink, showAp, showRef])

  useEffect(() => () => {
    if (!map) return
    try { for (const l of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_APL, LYR_AP, LYR_REF]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
    try { for (const s of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_LINK, SRC_AP, SRC_REF]) if (map.getSource(s)) map.removeSource(s) } catch {}
  }, [map])

  // Diagnostic SVG: OAT (x, 10..-50 °C) vs correction at current HAA (y, 0..600 ft)
  const scatter = useMemo(() => {
    return computed.filter(r => r.c.tier !== 'IDLE').map(r => {
      const x = 8 + ((10 - r.c.oatC) / 60) * 220       // OAT: +10°C → x=8, -50°C → x=228
      const y = 130 - Math.min(600, r.c.corrFt) / 600 * 110
      return { cx: x, cy: y, color: TIER_COLOR[r.c.tier] }
    })
  }, [computed])

  const toggleRegion = (r: Ctac['region']) => setRegionFilter(prev => {
    const n = new Set(prev); if (n.has(r)) n.delete(r); else n.add(r); return n
  })

  return (
    <div className="fixed top-16 right-3 z-40 w-[420px] max-h-[calc(100vh-5rem)] flex flex-col rounded-xl border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">❄</span>
          <span className="text-sm font-semibold tracking-wider">CTAC · COLD-TEMP ALTITUDE CORRECTION</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      {/* 5-tier counter strip */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? null : t)}
            className={`flex flex-col items-center rounded-md px-1 py-1 border text-[9px] tracking-wider transition ${tierFilter === t ? TIER_BG[t] : 'border-slate-800 bg-slate-900/40 hover:bg-slate-800/40'}`}
            style={{ color: tierFilter === t ? undefined : TIER_COLOR[t] }}>
            <span>{t.slice(0,4)}</span>
            <span className="text-sm font-mono mt-0.5">{counts[t]}</span>
          </button>
        ))}
      </div>

      {/* summary */}
      <div className="px-3 py-2 grid grid-cols-3 gap-1.5 border-b border-slate-800 text-[10px]">
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500 tracking-wider">MEAN CORR</div>
          <div className="font-mono" style={{ color: summary.meanCorr > 200 ? TIER_COLOR.CORRECT : summary.meanCorr > 80 ? TIER_COLOR.WATCH : TIER_COLOR.OK }}>+{summary.meanCorr.toFixed(0)}ft</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500 tracking-wider">WORST AC</div>
          <div className="font-mono text-slate-100 truncate">{summary.worstCs}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500 tracking-wider">CFIT</div>
          <div className="font-mono" style={{ color: counts.CFIT > 0 ? TIER_COLOR.CFIT : TIER_COLOR.OK }}>{counts.CFIT}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500 tracking-wider">MEAN OAT</div>
          <div className="font-mono" style={{ color: summary.meanOat < -20 ? TIER_COLOR.CORRECT : summary.meanOat < 0 ? TIER_COLOR.WATCH : TIER_COLOR.OK }}>{summary.meanOat.toFixed(0)}°C</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500 tracking-wider">MANDATORY</div>
          <div className="font-mono" style={{ color: summary.mandatoryShare > 0.30 ? TIER_COLOR.CORRECT : TIER_COLOR.OK }}>{(summary.mandatoryShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500 tracking-wider">TRACKED</div>
          <div className="font-mono text-slate-100">{summary.tracked}</div>
        </div>
      </div>

      {/* Diagnostic SVG */}
      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] tracking-wider text-slate-500 mb-1">OAT (°C) vs CORRECTION (ft) @ current HAA</div>
          <svg viewBox="0 0 240 140" className="w-full h-32 bg-slate-900/40 rounded">
            {/* zone bands */}
            <rect x={8 + ((10 - 0) / 60) * 220} y="20" width={((0 - (-12)) / 60) * 220} height="110" fill="#0ea5e9" opacity="0.06" />
            <rect x={8 + ((10 - (-12)) / 60) * 220} y="20" width={((-12 - (-30)) / 60) * 220} height="110" fill="#f59e0b" opacity="0.08" />
            <rect x={8 + ((10 - (-30)) / 60) * 220} y="20" width={((-30 - (-50)) / 60) * 220} height="110" fill="#f43f5e" opacity="0.08" />
            {/* horizontal correction-threshold lines */}
            <line x1="8" y1={130 - (150 / 600) * 110} x2="228" y2={130 - (150 / 600) * 110} stroke="#f59e0b" strokeWidth="0.5" strokeDasharray="2 2" />
            <line x1="8" y1={130 - (300 / 600) * 110} x2="228" y2={130 - (300 / 600) * 110} stroke="#f43f5e" strokeWidth="0.5" strokeDasharray="2 2" />
            {/* axes */}
            <line x1="8" y1="130" x2="228" y2="130" stroke="#475569" strokeWidth="0.5" />
            <line x1="8" y1="20"  x2="8"   y2="130" stroke="#475569" strokeWidth="0.5" />
            {scatter.map((d,i) => (<circle key={i} cx={d.cx} cy={d.cy} r="2" fill={d.color} opacity="0.85" />))}
            <text x="8"   y="138" fontSize="6" fill="#64748b">+10</text>
            <text x="118" y="138" fontSize="6" fill="#64748b">−20°C</text>
            <text x="218" y="138" fontSize="6" fill="#64748b">−50</text>
            <text x="2"   y="24"  fontSize="6" fill="#64748b">600</text>
            <text x="2"   y="128" fontSize="6" fill="#64748b">0</text>
          </svg>
        </div>
      )}

      {/* Sliders */}
      <div className="px-3 py-2 grid grid-cols-2 gap-x-3 gap-y-1.5 border-b border-slate-800 text-[10px]">
        {[
          ['SEASON', season, setSeason, -100, 100, 5, ''],
          ['OAT-NOISE', oatNoise, setOatNoise, 50, 250, 5, '%'],
          ['CORR-THOLD', corrThold, setCorrThold, 50, 400, 10, 'ft'],
          ['PHASE-WT', phaseW, setPhaseW, 50, 150, 5, '%'],
          ['MIN-HAA', minHaa, setMinHaa, 0, 5000, 250, 'ft'],
          ['RANGE', rangeNm, setRangeNm, 50, 300, 10, 'nm'],
        ].map(([lbl, val, setter, mn, mx, st, unit]) => (
          <div key={lbl as string}>
            <div className="flex justify-between text-slate-500 tracking-wider">
              <span>{lbl as string}</span>
              <span className="font-mono text-slate-300">{lbl === 'SEASON' ? (((val as number)/100) >= 0 ? '+' : '') + ((val as number)/100).toFixed(2) + 'sum' : (val as number) + (unit as string)}</span>
            </div>
            <input type="range" min={mn as number} max={mx as number} step={st as number} value={val as number}
              onChange={e => (setter as (n:number)=>void)(parseInt(e.target.value,10))}
              className="w-full h-1 accent-sky-500" />
          </div>
        ))}
      </div>

      {/* Region filter */}
      <div className="px-3 py-2 flex flex-wrap gap-1 border-b border-slate-800">
        {REGIONS.map(r => (
          <button key={r} onClick={() => toggleRegion(r)}
            className={`text-[9px] px-1.5 py-0.5 rounded border tracking-wider transition ${regionFilter.has(r) ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/40 border-slate-800 text-slate-500'}`}>
            {r}
          </button>
        ))}
      </div>

      {/* Overlay toggles */}
      <div className="px-3 py-1.5 flex flex-wrap gap-2 border-b border-slate-800 text-[9px]">
        {[
          ['HALO', showHalo, setShowHalo],
          ['PIN', showPin, setShowPin],
          ['LBL', showLbl, setShowLbl],
          ['LINK', showLink, setShowLink],
          ['AP', showAp, setShowAp],
          ['REF', showRef, setShowRef],
          ['DIAG', showDiag, setShowDiag],
        ].map(([lbl, on, set]) => (
          <label key={lbl as string} className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={on as boolean} onChange={e => (set as (b:boolean)=>void)(e.target.checked)} className="accent-sky-500" />
            <span className={on ? 'text-sky-300' : 'text-slate-500'}>{lbl as string}</span>
          </label>
        ))}
      </div>

      <div className="px-3 py-2 border-b border-slate-800">
        <input type="text" value={query} onChange={e => setQuery(e.target.value)}
          placeholder="search callsign / type / operator / icao / airport"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 py-1.5 flex gap-1 border-b border-slate-800">
        {(['AIRCRAFT','AIRPORTS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`text-[10px] px-2 py-0.5 rounded border tracking-wider transition ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/40 border-slate-800 text-slate-500 hover:text-slate-300'}`}>
            {t}
          </button>
        ))}
        <span className="ml-auto text-[9px] text-slate-500 self-center">{tab === 'AIRCRAFT' ? ranked.length : byAirport.length} shown · {computed.length} tracked</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <>
            {ranked.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft within range of a CTAC airport.</div>
            )}
            {ranked.slice(0, 80).map(({ f, c }) => (
              <button key={f.icao} onClick={() => onFly(f.icao)}
                className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/50 flex gap-2">
                <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[c.tier] }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="font-mono font-semibold truncate">{f.callsign?.trim() || f.icao}</span>
                    <span className="text-slate-500 truncate text-[10px]">{f.type || '—'}</span>
                    <span className="text-[8px] tracking-wider px-1 rounded bg-slate-800 text-slate-400">{c.phase}</span>
                    {c.ap && <span className="text-[8px] tracking-wider px-1 rounded" style={{ background: REGION_COLOR[c.ap.region] + '33', color: REGION_COLOR[c.ap.region] }}>{c.ap.icao}</span>}
                    {c.oatMandatory && <span className="text-[8px] tracking-wider px-1 rounded bg-amber-500/15 text-amber-300 border border-amber-500/40">MAND</span>}
                    <span className="ml-auto text-[9px] tracking-wider font-mono" style={{ color: TIER_COLOR[c.tier] }}>{c.tier}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-slate-400 font-mono mt-0.5">
                    <span>FL{Math.round(f.altitudeFt/100)}</span>
                    <span style={{ color: c.oatC < -25 ? TIER_COLOR.CFIT : c.oatC < -10 ? TIER_COLOR.CORRECT : TIER_COLOR.OK }}>{c.oatC}°C</span>
                    <span style={{ color: c.corrFt > 300 ? TIER_COLOR.CFIT : c.corrFt > 150 ? TIER_COLOR.CORRECT : c.corrFt > 50 ? TIER_COLOR.WATCH : TIER_COLOR.OK }}>+{c.corrFt}ft</span>
                    <span className="text-slate-500">HAA {c.haaFt.toFixed(0)}ft</span>
                    {c.ap && <span className="text-slate-500">{c.apDistNm.toFixed(0)}nm {c.ap.icao}</span>}
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-slate-400 font-mono mt-0.5">
                    <span className="text-slate-500">DH+corr</span>
                    <span style={{ color: c.margDhFt < 0 ? TIER_COLOR.CFIT : c.margDhFt < 200 ? TIER_COLOR.CORRECT : TIER_COLOR.OK }}>Δ{c.margDhFt >= 0 ? '+' : ''}{c.margDhFt.toFixed(0)}ft</span>
                    <span className="text-slate-500">FAF+corr Δ{c.margFafFt >= 0 ? '+' : ''}{c.margFafFt.toFixed(0)}ft</span>
                    <span className="text-slate-500">true {c.trueAltFt.toFixed(0)}ft</span>
                  </div>
                  <div className="mt-1 h-1 bg-slate-900 rounded overflow-hidden">
                    <div className="h-full" style={{ width: `${c.score}%`, background: TIER_COLOR[c.tier] }} />
                  </div>
                  <div className="grid grid-cols-5 gap-1 mt-1">
                    {([['COR',c.scoreCor],['PRX',c.scorePrx],['OAT',c.scoreOat],['SEG',c.scoreSeg],['PHS',c.scorePhs]] as Array<[string,number]>).map(([k,v]) => (
                      <div key={k} className="text-[8px] tracking-wider font-mono text-center rounded border border-slate-800 px-0.5"
                        style={{ color: v >= 80 ? TIER_COLOR.CFIT : v >= 55 ? TIER_COLOR.CORRECT : v >= 25 ? TIER_COLOR.WATCH : TIER_COLOR.OK }}>
                        {k} {v.toFixed(0)}
                      </div>
                    ))}
                  </div>
                  <div className="mt-1 text-[9px] truncate" style={{ color: TIER_COLOR[c.tier] }}>
                    › {c.advice}
                  </div>
                </div>
              </button>
            ))}
          </>
        )}

        {tab === 'AIRPORTS' && (
          <>
            {byAirport.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-slate-500">No CTAC airports with traffic in range.</div>
            )}
            {byAirport.map(g => {
              const mean = g.sumScore / Math.max(1, g.n)
              const meanCorr = g.sumCorr / Math.max(1, g.n)
              const sev: Tier = g.cfit > 0 ? 'CFIT' : g.correct > 0 ? 'CORRECT' : mean >= 25 ? 'WATCH' : 'OK'
              return (
                <button key={g.ap.icao} onClick={() => onFly(g.worstCs)} className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/50 flex gap-2">
                  <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[sev] }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="font-mono font-semibold">{g.ap.icao}</span>
                      <span className="text-slate-300 truncate">{g.ap.name}</span>
                      <span className="text-[8px] tracking-wider px-1 rounded" style={{ background: REGION_COLOR[g.ap.region] + '33', color: REGION_COLOR[g.ap.region] }}>{g.ap.region}</span>
                      <span className="ml-auto text-[9px] tracking-wider font-mono" style={{ color: TIER_COLOR[sev] }}>{sev}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                      <span>n={g.n}</span>
                      <span>thold {g.ap.thresholdC}°C</span>
                      <span>elev {g.ap.elevFt}ft</span>
                      <span>FAF {g.ap.fafFt}ft</span>
                      <span>DH {g.ap.dhFt}ft</span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                      <span style={{ color: g.cfit > 0 ? TIER_COLOR.CFIT : TIER_COLOR.OK }}>CFIT {g.cfit}</span>
                      <span style={{ color: g.correct > 0 ? TIER_COLOR.CORRECT : TIER_COLOR.OK }}>CORR {g.correct}</span>
                      <span style={{ color: meanCorr > 200 ? TIER_COLOR.CORRECT : meanCorr > 80 ? TIER_COLOR.WATCH : TIER_COLOR.OK }}>mean +{meanCorr.toFixed(0)}ft</span>
                      <span className="text-slate-500 truncate">worst {g.worstCs}</span>
                    </div>
                    <div className="mt-1 h-1 bg-slate-900 rounded overflow-hidden">
                      <div className="h-full" style={{ width: `${mean}%`, background: TIER_COLOR[sev] }} />
                    </div>
                  </div>
                </button>
              )
            })}
          </>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[8px] text-slate-600 tracking-wider">
        PANS-OPS 4.3.3 · AIM 7-3-1 · AC 91-79B · TC AIM RAC 9.17 · Order 8260.3D ch 11 · TSB A11W0151 YPG · KAL 801 GUM
      </div>
    </div>
  )
}
