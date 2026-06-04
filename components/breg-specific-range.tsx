'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   BREG · Breguet Specific-Range & Cruise-Efficiency Optimizer
   ------------------------------------------------------------
   Per-airframe cruise-efficiency scorer evaluating observed
   Mach / FL / IAS against a parametric drag-polar + TSFC model
   to produce: Specific Range SR [NM / kg-fuel], current burn
   FF [kg/hr], optimum cruise Mach M_opt that maximises M·(L/D),
   Long-Range Cruise (LRC, 99% best-SR per Boeing FCOM PI),
   Maximum-Range Cruise (MRC, 100% best-SR), optimum altitude
   FL_opt for current weight, Cost-Index optimum Mach with a
   user-adjustable CI 0-500 slider, and a deviation metric vs
   the recommended profile expressed in fuel-burn penalty %.

   Drag polar implemented as quadratic in CL with compressibility
   wave-drag rise above critical Mach M_crit per type-class:
     CD = CD0 + k·CL²  + ΔCD_wave(M, M_crit)
     ΔCD_wave(M,Mc) = 0.0024·((M-Mc)/0.06)² for M > Mc else 0
     (Lock-style wave-drag rise per Mason "Configuration Aero",
      Boeing PEM §3 Drag Rise, Airbus GTGFE §1.3.2)

   TSFC (Brake Specific Fuel Consumption) per-class baseline at
   FL350/M0.78 with Mach-correction TSFC = SFC0·(1 + 0.16·M)
   per Roskam Pt VI / Mattingly Aircraft Engine Design §8.

   Lift coefficient required:
     CL = 2·W / (ρ·V²·S)
   Drag:
     D = CD·q·S  ;  q = ½·ρ·V²
   Thrust required = D (steady cruise).
   Fuel flow FF = TSFC · T_req  [kg/hr]
   Specific Range:
     SR = V_TAS [NM/hr] / FF [kg/hr]  [NM/kg]
   Maximised by Mach that maximises M·(L/D), which solves to:
     CL_opt = sqrt(CD0 / (3·k))   (no wave-drag)
   With wave-drag, evaluated numerically over Mach 0.55-0.92.

   Optimum altitude: weight ↑ → optimum CL pushes altitude up.
   FL_opt ≈ FL where current weight gives CL = CL_opt at chosen
   Mach. Recomputed in feet.

   References:
     · Anderson, Aircraft Performance and Design §5
     · Hale, Aircraft Performance Selection & Design §5
     · Roskam, Airplane Design Pt VI Ch 3-4
     · Mason, Configuration Aerodynamics Ch 8 wave drag
     · Mattingly, Aircraft Engine Design AIAA §8 TSFC
     · Boeing 737/777/787 Performance Engineer's Manual §3 §4
     · Airbus Getting to Grips with Fuel Economy §1.3 §2.1
     · Airbus Getting to Grips with the Cost Index ed.2
     · Boeing FCOM PI-22 LRC tables / Mach-Cost-Index
     · EUROCONTROL Base of Aircraft Data BADA 3.15 / 4.2
     · ICAO Doc 9889 Manual on Air Quality §A.3 fuel-burn
     · Breguet (1923) "Calcul du Poids de Combustible"
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'WASTE' | 'POOR' | 'OK' | 'GOOD' | 'OPTIMAL' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  WASTE: '#ef4444', POOR: '#f59e0b', OK: '#0ea5e9', GOOD: '#10b981', OPTIMAL: '#a855f7', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['WASTE','POOR','OK','GOOD','OPTIMAL']
const TIER_RANK: Record<Tier, number> = { WASTE:0, POOR:1, OK:2, GOOD:3, OPTIMAL:4, IDLE:5 }

type Klass = 'WB-LH' | 'WB-M' | 'NB' | 'RGN-J' | 'RGN-T' | 'BIZ'
const KLASS_COLOR: Record<Klass, string> = {
  'WB-LH':'#a855f7','WB-M':'#0ea5e9','NB':'#10b981','RGN-J':'#f59e0b','RGN-T':'#facc15','BIZ':'#f43f5e',
}
const KLASS_LIST: Klass[] = ['WB-LH','WB-M','NB','RGN-J','RGN-T','BIZ']

interface Perf {
  klass: Klass
  family: string
  S: number          // wing reference area m²
  CD0: number        // zero-lift drag coefficient at cruise
  k: number          // induced drag factor 1/(π·AR·e)
  Mcrit: number      // critical drag-rise Mach
  Mmo: number        // never-exceed Mach
  W_oew: number      // operating empty weight kg
  W_mzfw: number     // max zero-fuel weight kg
  W_mtow: number     // max takeoff weight kg
  W_typ: number      // typical mid-cruise weight kg
  SFC0: number       // baseline TSFC kg/(N·hr) at FL350/M0.78
  M_lrc: number      // published LRC Mach
  FL_opt_typ: number // typical optimum FL at typ weight
  ref: string        // doc reference
}

/* Per-ICAO-type cruise-performance catalogue. Values derived from
   manufacturer Performance Engineer Manuals, FCOM PI/PEM sections,
   EUROCONTROL BADA 3/4, Jane's All The World's Aircraft. */
const PERF_TABLE: Record<string, Perf> = {
  // Boeing widebody long-haul
  B748: { klass:'WB-LH', family:'B747-8I', S:554, CD0:0.0184, k:0.0420, Mcrit:0.870, Mmo:0.92, W_oew:220130, W_mzfw:295740, W_mtow:447700, W_typ:340000, SFC0:0.572, M_lrc:0.855, FL_opt_typ:330, ref:'B747-8 PEM §3' },
  B744: { klass:'WB-LH', family:'B747-400',  S:541, CD0:0.0195, k:0.0440, Mcrit:0.860, Mmo:0.92, W_oew:181000, W_mzfw:246070, W_mtow:396890, W_typ:300000, SFC0:0.594, M_lrc:0.850, FL_opt_typ:330, ref:'B747-400 PEM §3' },
  B77W: { klass:'WB-LH', family:'B777-300ER',S:436, CD0:0.0175, k:0.0395, Mcrit:0.870, Mmo:0.89, W_oew:167830, W_mzfw:237680, W_mtow:351530, W_typ:265000, SFC0:0.554, M_lrc:0.840, FL_opt_typ:350, ref:'B777-300ER PEM §3' },
  B772: { klass:'WB-LH', family:'B777-200',  S:427, CD0:0.0180, k:0.0395, Mcrit:0.870, Mmo:0.89, W_oew:138100, W_mzfw:195040, W_mtow:247200, W_typ:200000, SFC0:0.560, M_lrc:0.840, FL_opt_typ:370, ref:'B777-200 PEM §3' },
  B788: { klass:'WB-LH', family:'B787-8',    S:325, CD0:0.0168, k:0.0380, Mcrit:0.875, Mmo:0.90, W_oew:119950, W_mzfw:161000, W_mtow:227930, W_typ:175000, SFC0:0.510, M_lrc:0.850, FL_opt_typ:390, ref:'B787-8 PEM §3' },
  B789: { klass:'WB-LH', family:'B787-9',    S:325, CD0:0.0168, k:0.0380, Mcrit:0.875, Mmo:0.90, W_oew:128850, W_mzfw:181000, W_mtow:254000, W_typ:195000, SFC0:0.510, M_lrc:0.850, FL_opt_typ:380, ref:'B787-9 PEM §3' },
  B78X: { klass:'WB-LH', family:'B787-10',   S:325, CD0:0.0170, k:0.0382, Mcrit:0.875, Mmo:0.90, W_oew:135500, W_mzfw:193000, W_mtow:254000, W_typ:210000, SFC0:0.512, M_lrc:0.850, FL_opt_typ:370, ref:'B787-10 PEM §3' },
  // Boeing widebody medium
  B763: { klass:'WB-M',  family:'B767-300ER',S:283, CD0:0.0186, k:0.0438, Mcrit:0.855, Mmo:0.86, W_oew:90010,  W_mzfw:126550, W_mtow:186880, W_typ:140000, SFC0:0.584, M_lrc:0.800, FL_opt_typ:370, ref:'B767-300 PEM §3' },
  // Boeing narrowbody
  B737: { klass:'NB', family:'B737-700',  S:124, CD0:0.0220, k:0.0490, Mcrit:0.785, Mmo:0.82, W_oew:38150, W_mzfw:54650, W_mtow:70080, W_typ:55000, SFC0:0.610, M_lrc:0.785, FL_opt_typ:370, ref:'B737-NG PEM §3' },
  B738: { klass:'NB', family:'B737-800',  S:125, CD0:0.0218, k:0.0488, Mcrit:0.785, Mmo:0.82, W_oew:41410, W_mzfw:62730, W_mtow:79010, W_typ:62000, SFC0:0.610, M_lrc:0.785, FL_opt_typ:360, ref:'B737-800 PEM §3' },
  B739: { klass:'NB', family:'B737-900ER',S:125, CD0:0.0218, k:0.0488, Mcrit:0.785, Mmo:0.82, W_oew:44680, W_mzfw:67720, W_mtow:85130, W_typ:67000, SFC0:0.612, M_lrc:0.785, FL_opt_typ:350, ref:'B737-900 PEM §3' },
  B38M: { klass:'NB', family:'B737-8 MAX', S:127, CD0:0.0205, k:0.0470, Mcrit:0.790, Mmo:0.82, W_oew:45070, W_mzfw:65950, W_mtow:82190, W_typ:64000, SFC0:0.570, M_lrc:0.790, FL_opt_typ:380, ref:'B737-MAX PEM §3' },
  B39M: { klass:'NB', family:'B737-9 MAX', S:127, CD0:0.0205, k:0.0470, Mcrit:0.790, Mmo:0.82, W_oew:47620, W_mzfw:69310, W_mtow:88300, W_typ:69000, SFC0:0.572, M_lrc:0.790, FL_opt_typ:370, ref:'B737-MAX PEM §3' },
  B752: { klass:'NB', family:'B757-200',   S:185, CD0:0.0208, k:0.0470, Mcrit:0.805, Mmo:0.86, W_oew:58040, W_mzfw:83460, W_mtow:115680, W_typ:90000, SFC0:0.595, M_lrc:0.800, FL_opt_typ:370, ref:'B757-200 PEM §3' },
  // Airbus widebody
  A388: { klass:'WB-LH', family:'A380-800', S:845, CD0:0.0182, k:0.0410, Mcrit:0.870, Mmo:0.89, W_oew:276800, W_mzfw:361000, W_mtow:575000, W_typ:445000, SFC0:0.560, M_lrc:0.850, FL_opt_typ:330, ref:'A380 FCOM PER-CRZ' },
  A359: { klass:'WB-LH', family:'A350-900', S:443, CD0:0.0166, k:0.0378, Mcrit:0.880, Mmo:0.89, W_oew:135630, W_mzfw:195700, W_mtow:283000, W_typ:215000, SFC0:0.505, M_lrc:0.850, FL_opt_typ:390, ref:'A350-900 FCOM PER-CRZ' },
  A35K: { klass:'WB-LH', family:'A350-1000',S:443, CD0:0.0168, k:0.0380, Mcrit:0.880, Mmo:0.89, W_oew:155350, W_mzfw:223000, W_mtow:319000, W_typ:240000, SFC0:0.506, M_lrc:0.850, FL_opt_typ:370, ref:'A350-1000 FCOM PER-CRZ' },
  A332: { klass:'WB-M',  family:'A330-200', S:362, CD0:0.0180, k:0.0418, Mcrit:0.860, Mmo:0.86, W_oew:120150, W_mzfw:170000, W_mtow:242000, W_typ:188000, SFC0:0.572, M_lrc:0.820, FL_opt_typ:370, ref:'A330-200 FCOM PER-CRZ' },
  A333: { klass:'WB-M',  family:'A330-300', S:362, CD0:0.0182, k:0.0420, Mcrit:0.860, Mmo:0.86, W_oew:124500, W_mzfw:175000, W_mtow:242000, W_typ:195000, SFC0:0.574, M_lrc:0.820, FL_opt_typ:360, ref:'A330-300 FCOM PER-CRZ' },
  A339: { klass:'WB-M',  family:'A330-900neo',S:362,CD0:0.0172,k:0.0408,Mcrit:0.865,Mmo:0.86, W_oew:137000, W_mzfw:181000, W_mtow:251000, W_typ:200000, SFC0:0.534, M_lrc:0.820, FL_opt_typ:390, ref:'A330neo FCOM PER-CRZ' },
  // Airbus narrowbody
  A319: { klass:'NB', family:'A319',     S:122, CD0:0.0225, k:0.0500, Mcrit:0.780, Mmo:0.82, W_oew:40800, W_mzfw:58500, W_mtow:75500, W_typ:58000, SFC0:0.612, M_lrc:0.780, FL_opt_typ:380, ref:'A319 FCOM PER-CRZ' },
  A320: { klass:'NB', family:'A320',     S:122, CD0:0.0224, k:0.0500, Mcrit:0.780, Mmo:0.82, W_oew:42600, W_mzfw:62500, W_mtow:78000, W_typ:62000, SFC0:0.612, M_lrc:0.780, FL_opt_typ:370, ref:'A320 FCOM PER-CRZ' },
  A321: { klass:'NB', family:'A321',     S:122, CD0:0.0226, k:0.0502, Mcrit:0.780, Mmo:0.82, W_oew:48400, W_mzfw:75500, W_mtow:93500, W_typ:75000, SFC0:0.614, M_lrc:0.780, FL_opt_typ:360, ref:'A321 FCOM PER-CRZ' },
  A20N: { klass:'NB', family:'A320neo',  S:122, CD0:0.0210, k:0.0480, Mcrit:0.785, Mmo:0.82, W_oew:42600, W_mzfw:64300, W_mtow:79000, W_typ:63000, SFC0:0.572, M_lrc:0.785, FL_opt_typ:380, ref:'A320neo FCOM PER-CRZ' },
  A21N: { klass:'NB', family:'A321neo',  S:122, CD0:0.0212, k:0.0482, Mcrit:0.785, Mmo:0.82, W_oew:50100, W_mzfw:77300, W_mtow:97000, W_typ:78000, SFC0:0.574, M_lrc:0.785, FL_opt_typ:370, ref:'A321neo FCOM PER-CRZ' },
  BCS3: { klass:'NB', family:'A220-300', S:112, CD0:0.0205, k:0.0470, Mcrit:0.790, Mmo:0.82, W_oew:37080, W_mzfw:55340, W_mtow:67585, W_typ:52000, SFC0:0.555, M_lrc:0.790, FL_opt_typ:390, ref:'A220-300 FCOM' },
  // Embraer regional jets
  E190: { klass:'RGN-J', family:'E190',  S:92,  CD0:0.0230, k:0.0510, Mcrit:0.770, Mmo:0.82, W_oew:27840, W_mzfw:40800, W_mtow:51800, W_typ:42000, SFC0:0.624, M_lrc:0.770, FL_opt_typ:370, ref:'E190 AOM PER' },
  E195: { klass:'RGN-J', family:'E195',  S:92,  CD0:0.0232, k:0.0512, Mcrit:0.770, Mmo:0.82, W_oew:28970, W_mzfw:42500, W_mtow:52290, W_typ:43000, SFC0:0.626, M_lrc:0.770, FL_opt_typ:360, ref:'E195 AOM PER' },
  E290: { klass:'RGN-J', family:'E190-E2',S:103, CD0:0.0210, k:0.0480, Mcrit:0.780, Mmo:0.82, W_oew:33000, W_mzfw:45800, W_mtow:56400, W_typ:46000, SFC0:0.554, M_lrc:0.780, FL_opt_typ:380, ref:'E190-E2 AOM' },
  E295: { klass:'RGN-J', family:'E195-E2',S:103, CD0:0.0212, k:0.0480, Mcrit:0.780, Mmo:0.82, W_oew:35990, W_mzfw:50790, W_mtow:61500, W_typ:50000, SFC0:0.556, M_lrc:0.780, FL_opt_typ:370, ref:'E195-E2 AOM' },
  CRJ9: { klass:'RGN-J', family:'CRJ-900', S:71, CD0:0.0245, k:0.0535, Mcrit:0.760, Mmo:0.85, W_oew:21433, W_mzfw:32545, W_mtow:38329, W_typ:33000, SFC0:0.640, M_lrc:0.760, FL_opt_typ:370, ref:'CRJ-900 FCM' },
  CRJ7: { klass:'RGN-J', family:'CRJ-700', S:70, CD0:0.0244, k:0.0535, Mcrit:0.760, Mmo:0.85, W_oew:19731, W_mzfw:28259, W_mtow:34019, W_typ:30000, SFC0:0.638, M_lrc:0.760, FL_opt_typ:370, ref:'CRJ-700 FCM' },
  // Regional turboprops (Mach ~0.4, model still useful for OPT-FL/burn-vs-prof)
  AT72: { klass:'RGN-T', family:'ATR-72',  S:61, CD0:0.0290, k:0.0580, Mcrit:0.650, Mmo:0.55, W_oew:13311, W_mzfw:21000, W_mtow:23000, W_typ:20000, SFC0:0.450, M_lrc:0.420, FL_opt_typ:200, ref:'ATR-72-600 AFM' },
  DH8D: { klass:'RGN-T', family:'Q400',    S:63, CD0:0.0270, k:0.0560, Mcrit:0.700, Mmo:0.55, W_oew:17819, W_mzfw:26308, W_mtow:29574, W_typ:25000, SFC0:0.430, M_lrc:0.500, FL_opt_typ:250, ref:'Q400 FCOM' },
  // Business jets
  GLEX: { klass:'BIZ', family:'Global Express', S:94, CD0:0.0200, k:0.0455, Mcrit:0.870, Mmo:0.89, W_oew:25855, W_mzfw:33203, W_mtow:45132, W_typ:34000, SFC0:0.560, M_lrc:0.850, FL_opt_typ:430, ref:'BD-700 FCOM' },
  G650: { klass:'BIZ', family:'Gulfstream G650', S:120, CD0:0.0185, k:0.0418, Mcrit:0.890, Mmo:0.925, W_oew:25800, W_mzfw:32885, W_mtow:45178, W_typ:35000, SFC0:0.520, M_lrc:0.880, FL_opt_typ:450, ref:'G650 PEM' },
  GLF6: { klass:'BIZ', family:'Gulfstream G650', S:120, CD0:0.0185, k:0.0418, Mcrit:0.890, Mmo:0.925, W_oew:25800, W_mzfw:32885, W_mtow:45178, W_typ:35000, SFC0:0.520, M_lrc:0.880, FL_opt_typ:450, ref:'G650 PEM' },
  FA8X: { klass:'BIZ', family:'Falcon-8X',     S:70,  CD0:0.0210, k:0.0470, Mcrit:0.850, Mmo:0.90, W_oew:16210, W_mzfw:22045, W_mtow:33113, W_typ:24000, SFC0:0.555, M_lrc:0.830, FL_opt_typ:430, ref:'Falcon-8X FCOM' },
  CL60: { klass:'BIZ', family:'CL-604/605',    S:48,  CD0:0.0225, k:0.0500, Mcrit:0.810, Mmo:0.85, W_oew:12064, W_mzfw:14515, W_mtow:21863, W_typ:17000, SFC0:0.590, M_lrc:0.800, FL_opt_typ:410, ref:'CL-604 FCOM' },
}
const DEFAULT_PERF: Perf = { klass:'NB', family:'generic NB', S:122, CD0:0.0220, k:0.0500, Mcrit:0.780, Mmo:0.82, W_oew:42000, W_mzfw:62000, W_mtow:78000, W_typ:62000, SFC0:0.612, M_lrc:0.780, FL_opt_typ:370, ref:'BADA 3.15 generic' }

function perfFor(type?: string): Perf { if (!type) return DEFAULT_PERF; return PERF_TABLE[type.toUpperCase()] || DEFAULT_PERF }

/* ISA atmosphere */
function isa(altFt: number) {
  const altM = altFt * 0.3048
  const t0 = 288.15, p0 = 101325, rho0 = 1.225, L = 0.0065, R = 287.05, g = 9.80665, gamma = 1.4
  let t: number, p: number, rho: number
  if (altM <= 11000) {
    t = t0 - L * altM
    p = p0 * Math.pow(t / t0, g / (R * L))
    rho = rho0 * Math.pow(t / t0, g / (R * L) - 1)
  } else {
    const t11 = t0 - L * 11000
    const p11 = p0 * Math.pow(t11 / t0, g / (R * L))
    t = t11
    p = p11 * Math.exp(-g * (altM - 11000) / (R * t11))
    rho = p / (R * t)
  }
  const a = Math.sqrt(gamma * R * t)
  return { t, p, rho, a }
}
function tasFromIas(iasKts: number, altFt: number): number {
  const { rho } = isa(altFt); return iasKts * Math.sqrt(1.225 / rho)
}
function machFromTas(tasKts: number, altFt: number): number {
  const { a } = isa(altFt); return (tasKts * 0.514444) / a
}

function clamp(v:number,a:number,b:number){return Math.max(a,Math.min(b,v))}

/* Drag polar with compressibility wave-drag rise. */
function dragCoef(CL: number, M: number, p: Perf): number {
  const wave = M > p.Mcrit ? 0.0024 * Math.pow((M - p.Mcrit) / 0.06, 2) : 0
  return p.CD0 + p.k * CL * CL + wave
}

/* Compute SR [NM/kg] at a given (alt,Mach,W) for perf p. */
function computeSR(altFt: number, mach: number, weightKg: number, p: Perf): { sr: number, ff: number, tasKts: number, CL: number, CD: number, LD: number } {
  const { rho, a } = isa(altFt)
  const tasMps = mach * a
  const tasKts = tasMps / 0.514444
  const W = weightKg * 9.80665                                // N
  const q = 0.5 * rho * tasMps * tasMps                       // Pa
  const CL = W / (q * p.S)
  const CD = dragCoef(CL, mach, p)
  const D = CD * q * p.S                                      // N (thrust required)
  const tsfc = p.SFC0 * (1 + 0.16 * mach)                     // kg/(N·hr) Mach-corrected
  const FF = tsfc * D                                          // kg/hr
  const sr = tasKts / Math.max(1, FF)                          // NM/kg
  return { sr, ff: FF, tasKts, CL, CD, LD: CL / CD }
}

/* Brute-force search Mach 0.55..min(Mmo,0.92) at given alt+weight,
   return Mach maximising SR (MRC). LRC = highest Mach ≥ MRC with
   SR ≥ 0.99·max. */
function optimalProfile(altFt: number, weightKg: number, p: Perf): { mMRC: number, srMRC: number, mLRC: number, srLRC: number, mFastMmo: number } {
  let best = { mMRC: 0.55, srMRC: -1, sr: 0 }
  const mMax = Math.min(p.Mmo - 0.005, 0.93)
  for (let m = 0.55; m <= mMax; m += 0.005) {
    const r = computeSR(altFt, m, weightKg, p)
    if (r.sr > best.srMRC) { best = { mMRC: m, srMRC: r.sr, sr: r.sr } }
  }
  let mLRC = best.mMRC, srLRC = best.srMRC
  for (let m = best.mMRC; m <= mMax; m += 0.005) {
    const r = computeSR(altFt, m, weightKg, p)
    if (r.sr >= 0.99 * best.srMRC) { mLRC = m; srLRC = r.sr }
  }
  return { mMRC: best.mMRC, srMRC: best.srMRC, mLRC, srLRC, mFastMmo: mMax }
}

/* Cost-Index optimum Mach: minimise total cost
   CT = CI·time + fuel  where time per NM = 1/V, fuel per NM = FF/V
   = (CI + FF) / V   →  maximise V / (CI + FF). CI in kg/min units. */
function costIndexOpt(altFt: number, weightKg: number, ci: number, p: Perf): { mCI: number, ffCI: number, tasCI: number } {
  let best = { m: p.M_lrc, score: -1, ff: 0, tas: 0 }
  const mMax = Math.min(p.Mmo - 0.005, 0.93)
  const ciPerHr = ci * 60  // kg/hr equivalent cost (CI is kg/min by Boeing/Airbus convention)
  for (let m = 0.55; m <= mMax; m += 0.005) {
    const r = computeSR(altFt, m, weightKg, p)
    const sc = r.tasKts / (ciPerHr + r.ff)
    if (sc > best.score) best = { m, score: sc, ff: r.ff, tas: r.tasKts }
  }
  return { mCI: best.m, ffCI: best.ff, tasCI: best.tas }
}

/* Optimum FL at given Mach + weight: search 200..430 picking max SR. */
function optimalAlt(mach: number, weightKg: number, p: Perf): number {
  let best = { fl: 350, sr: -1 }
  for (let fl = 200; fl <= 430; fl += 10) {
    const r = computeSR(fl * 100, mach, weightKg, p)
    if (r.sr > best.sr) best = { fl, sr: r.sr }
  }
  return best.fl
}

interface Row {
  f: SFlight
  perf: Perf
  weightKg: number
  iasKts: number
  tasKts: number
  mach: number
  ff: number
  sr: number
  LD: number
  mMRC: number
  mLRC: number
  mCI: number
  flOpt: number
  burnPenaltyPct: number     // (FF_current - FF_optimal) / FF_optimal at same alt
  tier: Tier
  delta: number              // current SR / MRC SR (1.00 = optimal)
  reason: string
}

function H(s:string){let h=2166136261>>>0;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)>>>0}return h>>>0}

function scoreRow(f: SFlight, ci: number, weightMul: number): Row {
  const perf = perfFor(f.type)
  // Weight estimate: deterministic per-airframe between OEW+typical-payload and MTOW
  const jitter = (H(f.icao) % 100) / 100
  const baseWeight = perf.W_oew + (perf.W_typ - perf.W_oew) * (0.6 + jitter * 0.6)
  const weightKg = clamp(baseWeight * (weightMul / 100), perf.W_oew, perf.W_mtow)
  const iasKts = f.velocityKts
  const tasKts = tasFromIas(iasKts, f.altitudeFt)
  const mach = machFromTas(tasKts, f.altitudeFt)
  const cur = computeSR(f.altitudeFt, mach, weightKg, perf)
  const opt = optimalProfile(f.altitudeFt, weightKg, perf)
  const ciOpt = costIndexOpt(f.altitudeFt, weightKg, ci, perf)
  const flOpt = optimalAlt(opt.mLRC, weightKg, perf)
  const delta = cur.sr / Math.max(0.0001, opt.srMRC)
  const optAtAlt = computeSR(f.altitudeFt, opt.mLRC, weightKg, perf)
  const burnPenaltyPct = (cur.ff - optAtAlt.ff) / Math.max(1, optAtAlt.ff) * 100

  let tier: Tier
  if (f.ground || f.altitudeFt < 15000) tier = 'IDLE'
  else if (delta >= 0.995) tier = 'OPTIMAL'
  else if (delta >= 0.97) tier = 'GOOD'
  else if (delta >= 0.92) tier = 'OK'
  else if (delta >= 0.85) tier = 'POOR'
  else tier = 'WASTE'

  let reason = ''
  if (tier === 'WASTE' || tier === 'POOR') {
    if (mach > opt.mLRC + 0.015) reason = `Mach ${mach.toFixed(3)} > LRC ${opt.mLRC.toFixed(3)}: reduce ${(mach-opt.mLRC).toFixed(3)}M to save ${burnPenaltyPct.toFixed(1)}% fuel`
    else if (mach < opt.mMRC - 0.02) reason = `Mach ${mach.toFixed(3)} < MRC ${opt.mMRC.toFixed(3)}: drag-divergent or off-optimum CL`
    else if (Math.abs(f.altitudeFt - flOpt * 100) > 2000) reason = `FL${(f.altitudeFt/100).toFixed(0)} ≠ OPT FL${flOpt}: step climb or descend for −${burnPenaltyPct.toFixed(1)}% burn`
    else reason = `Off-optimum cruise — verify CI/LRC selection per FCOM PI-22`
  } else if (tier === 'GOOD') {
    reason = `Near optimum · ${(delta*100).toFixed(1)}% of MRC SR`
  } else if (tier === 'OPTIMAL') {
    reason = `On MRC · max specific range per Breguet`
  }

  return {
    f, perf, weightKg, iasKts, tasKts, mach,
    ff: cur.ff, sr: cur.sr, LD: cur.LD,
    mMRC: opt.mMRC, mLRC: opt.mLRC, mCI: ciOpt.mCI,
    flOpt, burnPenaltyPct, tier, delta, reason,
  }
}

export default function BregSpecificRange({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'POLAR'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Record<Klass, boolean>>(()=>Object.fromEntries(KLASS_LIST.map(k=>[k,true])) as Record<Klass, boolean>)
  const [q, setQ] = useState('')
  const [ci, setCi] = useState(30)         // typical CI kg/min
  const [weightMul, setWeightMul] = useState(100)
  const [minFL, setMinFL] = useState(180)
  const [maxFL, setMaxFL] = useState(450)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)

  const rows = useMemo<Row[]>(() => {
    return flights
      .filter(f => !f.ground && f.altitudeFt >= minFL * 100 && f.altitudeFt <= maxFL * 100 && f.velocityKts > 200)
      .map(f => scoreRow(f, ci, weightMul))
      .filter(r => klassFilter[r.perf.klass])
      .sort((a,b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.delta - b.delta)
  }, [flights, ci, weightMul, minFL, maxFL, klassFilter])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { WASTE:0, POOR:0, OK:0, GOOD:0, OPTIMAL:0, IDLE:0 }
    rows.forEach(r => c[r.tier]++); return c
  }, [rows])

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (q.trim()) {
      const s = q.trim().toLowerCase()
      r = r.filter(x => (x.f.callsign||'').toLowerCase().includes(s) || (x.f.icao||'').toLowerCase().includes(s) || (x.f.type||'').toLowerCase().includes(s) || (x.perf.family||'').toLowerCase().includes(s))
    }
    return r
  }, [rows, tierFilter, q])

  const meanDelta = rows.length ? rows.reduce((a,b)=>a+b.delta,0)/rows.length : 1
  const totBurnExcess = rows.reduce((a,b)=>a+Math.max(0,b.burnPenaltyPct),0)
  const worst = rows[0]

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const SRC = 'breg-src'
    const HALO = 'breg-halo'
    const PIN = 'breg-pin'
    const LBL = 'breg-lbl'
    const features = rows.filter(r => r.tier !== 'IDLE').map(r => ({
      type:'Feature' as const,
      geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat] },
      properties:{
        tier: r.tier, color: TIER_COLOR[r.tier], kcolor: KLASS_COLOR[r.perf.klass],
        cs: r.f.callsign || r.f.icao,
        haloR: 7 + (4 - Math.min(4, TIER_RANK[r.tier])) * 3.2,
        pinScale: r.tier === 'WASTE' ? 1.5 : r.tier === 'POOR' ? 1.1 : 0,
        delta: (r.delta*100).toFixed(1),
        pen: r.burnPenaltyPct >= 0 ? `+${r.burnPenaltyPct.toFixed(1)}%` : `${r.burnPenaltyPct.toFixed(1)}%`,
      },
    }))
    const fc = { type:'FeatureCollection' as const, features }
    const add = () => {
      try {
        if (!map.getSource(SRC)) map.addSource(SRC, { type:'geojson', data: fc as any })
        else (map.getSource(SRC) as any).setData(fc)
        if (showHalo && !map.getLayer(HALO)) {
          map.addLayer({ id: HALO, type:'circle', source: SRC, paint:{
            'circle-radius': ['get','haloR'],
            'circle-color': ['get','kcolor'],
            'circle-opacity': 0.14,
            'circle-stroke-color': ['get','color'],
            'circle-stroke-width': 1.4,
            'circle-stroke-opacity': 0.85,
          }})
        }
        if (showPin && !map.getLayer(PIN)) {
          map.addLayer({ id: PIN, type:'circle', source: SRC, filter:['>',['get','pinScale'],0], paint:{
            'circle-radius': ['*', 5.2, ['get','pinScale']],
            'circle-color': ['get','color'],
            'circle-stroke-color':'#fff','circle-stroke-width':1.3,
          }})
        }
        if (showLbl && !map.getLayer(LBL)) {
          map.addLayer({ id: LBL, type:'symbol', source: SRC, layout:{
            'text-field': ['concat', ['get','cs'], '  ', ['get','delta'], '%  ', ['get','pen']],
            'text-size': 10, 'text-offset':[0,1.3],'text-anchor':'top',
            'text-font':['Open Sans Semibold','Arial Unicode MS Bold'],
          }, paint:{ 'text-color':['get','color'],'text-halo-color':'#0b1220','text-halo-width':1.2 }})
        }
      } catch {}
    }
    if (map.isStyleLoaded()) add(); else map.once('load', add)
    return () => {
      try {
        for (const l of [LBL, PIN, HALO]) if (map.getLayer(l)) map.removeLayer(l)
        if (map.getSource(SRC)) map.removeSource(SRC)
      } catch {}
    }
  }, [map, rows, showHalo, showPin, showLbl])

  /* Polar SVG: SR vs Mach for selected row's altitude+weight */
  const polarSel: Row | undefined = filtered[0] || rows[0]
  const polarCurve = useMemo(() => {
    if (!polarSel) return null
    const p = polarSel.perf
    const pts: Array<{ m:number, sr:number }> = []
    const mMax = Math.min(p.Mmo - 0.005, 0.92)
    for (let m = 0.55; m <= mMax; m += 0.01) {
      const r = computeSR(polarSel.f.altitudeFt, m, polarSel.weightKg, p)
      pts.push({ m, sr: r.sr })
    }
    const srMax = Math.max(...pts.map(p=>p.sr))
    return { pts, srMax, mMax }
  }, [polarSel])

  return (
    <div className="absolute right-3 top-20 z-30 w-[480px] max-h-[80vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">BREG</div>
        <div className="text-[10px] text-slate-400 truncate">Breguet specific-range · LRC/MRC · CI optimum · OPT-FL</div>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-[12px] px-2 py-0.5 rounded hover:bg-slate-800/60">✕</button>
        </div>
      </div>

      {/* tier strip */}
      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        {(['WASTE','POOR','OK','GOOD','OPTIMAL'] as Tier[]).map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter===t?'ALL':t)}
            className={`px-1 py-1 rounded border ${tierFilter===t?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
            <div className="text-[8px]" style={{color: TIER_COLOR[t]}}>{t.slice(0,5)}</div>
            <div className="text-slate-100 font-semibold">{tierCounts[t]}</div>
          </button>
        ))}
        <button onClick={() => setTierFilter('ALL')} className={`px-1 py-1 rounded border ${tierFilter==='ALL'?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
          <div className="text-[8px] text-slate-400">ALL</div>
          <div className="text-slate-100 font-semibold">{rows.length}</div>
        </button>
      </div>

      {/* summary */}
      <div className="grid grid-cols-4 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">MEAN δ</div>
          <div className="text-slate-100 font-semibold tabular-nums">{(meanDelta*100).toFixed(1)}%</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">WORST</div>
          <div className="text-slate-100 font-semibold truncate">{worst ? worst.f.callsign || worst.f.icao : '—'}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">Σ EXCESS</div>
          <div className="font-semibold tabular-nums" style={{color: totBurnExcess > 100 ? TIER_COLOR.WASTE : '#cbd5e1'}}>{totBurnExcess.toFixed(0)}%</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">CI</div>
          <div className="font-semibold tabular-nums text-sky-300">{ci}</div>
        </div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-800/60 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
        {([
          ['CI', ci, setCi, 0, 500, 'kg/min'],
          ['WT-MUL', weightMul, setWeightMul, 70, 130, 'pct'],
          ['MIN-FL', minFL, setMinFL, 100, 400, ''],
          ['MAX-FL', maxFL, setMaxFL, 250, 500, ''],
        ] as Array<[string, number, (n:number)=>void, number, number, string]>).map(([lbl,val,set,lo,hi,suf]) => (
          <label key={lbl} className="flex items-center gap-1.5">
            <span className="text-slate-500 w-14">{lbl}</span>
            <input type="range" min={lo} max={hi} value={val}
              onChange={e => set(parseInt(e.target.value))}
              className="flex-1 h-1 accent-sky-500" />
            <span className="text-slate-300 tabular-nums w-16 text-right">{val}{suf}</span>
          </label>
        ))}
      </div>

      {/* class chips */}
      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800/60">
        {KLASS_LIST.map(k => (
          <button key={k} onClick={() => setKlassFilter(p => ({...p, [k]: !p[k]}))}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${klassFilter[k]?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700 opacity-50'}`}
            style={{color: KLASS_COLOR[k]}}>{k}</button>
        ))}
      </div>

      {/* layer toggles */}
      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800/60 text-[9px]">
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl]] as const).map(([n,v,s])=>(
          <button key={n} onClick={()=>(s as any)(!v)} className={`px-1.5 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-500 hover:border-slate-700'}`}>{n}</button>
        ))}
      </div>

      {/* search + tabs */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-800/60">
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="callsign / icao / type / family"
          className="flex-1 bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/40" />
      </div>
      <div className="flex gap-0.5 px-3 py-1.5 border-b border-slate-800/60 text-[10px]">
        {(['AIRCRAFT','CLASSES','POLAR'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 text-slate-100 border border-sky-500/40':'text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      {/* tab body */}
      <div className="overflow-y-auto flex-1 text-[11px]">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500">no cruise traffic in scope · adjust MIN-FL / MAX-FL / class chips</div>}
            {filtered.slice(0, 80).map(r => (
              <button key={r.f.icao} onClick={()=>onFly(r.f.icao)} className="w-full text-left px-3 py-2 hover:bg-slate-900/60 transition">
                <div className="flex items-center gap-2 mb-1" style={{borderLeft:`3px solid ${TIER_COLOR[r.tier]}`, paddingLeft:8}}>
                  <span className="font-semibold text-slate-100">{r.f.callsign || r.f.icao}</span>
                  <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
                  <span className="text-[9px] px-1 py-px rounded bg-slate-800/70" style={{color: KLASS_COLOR[r.perf.klass]}}>{r.perf.klass}</span>
                  <span className="ml-auto text-[9px] px-1.5 py-px rounded font-bold tabular-nums" style={{background: TIER_COLOR[r.tier]+'22', color: TIER_COLOR[r.tier]}}>{(r.delta*100).toFixed(1)}%</span>
                  <span className="text-[9px] px-1.5 py-px rounded font-bold" style={{background: TIER_COLOR[r.tier]+'22', color: TIER_COLOR[r.tier]}}>{r.tier}</span>
                </div>
                <div className="grid grid-cols-4 gap-x-2 gap-y-1 text-[10px] pl-2">
                  <div><span className="text-slate-500">M </span><span className="text-slate-100 tabular-nums">{r.mach.toFixed(3)}</span></div>
                  <div><span className="text-slate-500">FL </span><span className="text-slate-100 tabular-nums">{(r.f.altitudeFt/100).toFixed(0)}</span></div>
                  <div><span className="text-slate-500">TAS </span><span className="text-slate-100 tabular-nums">{r.tasKts.toFixed(0)}kt</span></div>
                  <div><span className="text-slate-500">L/D </span><span className="text-slate-100 tabular-nums">{r.LD.toFixed(1)}</span></div>
                  <div><span className="text-slate-500">SR </span><span className="text-slate-100 tabular-nums">{(r.sr*1000).toFixed(1)} <span className="text-[8px] text-slate-500">NM/t</span></span></div>
                  <div><span className="text-slate-500">FF </span><span className="text-slate-100 tabular-nums">{r.ff.toFixed(0)}kg/h</span></div>
                  <div><span className="text-slate-500">W </span><span className="text-slate-100 tabular-nums">{(r.weightKg/1000).toFixed(0)}t</span></div>
                  <div><span className="text-slate-500">PEN </span><span className="tabular-nums" style={{color: r.burnPenaltyPct > 3 ? TIER_COLOR.WASTE : r.burnPenaltyPct > 1 ? TIER_COLOR.POOR : '#cbd5e1'}}>{r.burnPenaltyPct >= 0 ? '+' : ''}{r.burnPenaltyPct.toFixed(1)}%</span></div>
                </div>
                <div className="grid grid-cols-4 gap-x-2 gap-y-1 text-[10px] pl-2 mt-1">
                  <div><span className="text-slate-500">MRC </span><span className="text-violet-300 tabular-nums">M{r.mMRC.toFixed(3)}</span></div>
                  <div><span className="text-slate-500">LRC </span><span className="text-emerald-300 tabular-nums">M{r.mLRC.toFixed(3)}</span></div>
                  <div><span className="text-slate-500">CI{ci} </span><span className="text-sky-300 tabular-nums">M{r.mCI.toFixed(3)}</span></div>
                  <div><span className="text-slate-500">OPT-FL </span><span className="text-amber-300 tabular-nums">{r.flOpt}</span></div>
                </div>
                <div className="mt-1.5 pl-2">
                  <div className="w-full bg-slate-900/60 rounded h-1 overflow-hidden">
                    <div className="h-full" style={{width:`${Math.round(r.delta*100)}%`, background: TIER_COLOR[r.tier]}}></div>
                  </div>
                  <div className="text-[10px] mt-1.5 italic" style={{color: TIER_COLOR[r.tier]}}>› {r.reason}</div>
                  <div className="text-[9px] text-slate-500 italic mt-0.5">{r.perf.ref}</div>
                </div>
              </button>
            ))}
          </div>
        )}

        {tab === 'CLASSES' && (
          <div className="divide-y divide-slate-800/60">
            {(() => {
              const groups = new Map<Klass, Row[]>()
              rows.forEach(r => { if (!groups.has(r.perf.klass)) groups.set(r.perf.klass, []); groups.get(r.perf.klass)!.push(r) })
              const arr = Array.from(groups.entries()).map(([k, rs]) => ({
                k, rs,
                meanDelta: rs.reduce((a,b)=>a+b.delta,0)/rs.length,
                meanPen: rs.reduce((a,b)=>a+b.burnPenaltyPct,0)/rs.length,
                worst: rs.reduce((a,b)=>Math.min(a, TIER_RANK[b.tier]), 5),
                waste: rs.filter(r=>r.tier==='WASTE').length,
              })).sort((a,b) => a.worst - b.worst || a.meanDelta - b.meanDelta)
              if (arr.length === 0) return <div className="px-3 py-6 text-center text-slate-500">no traffic in scope</div>
              return arr.map(g => {
                const worstTier = TIER_ORDER[g.worst] || 'OK'
                return (
                  <div key={g.k} className="px-3 py-2" style={{borderLeft:`3px solid ${TIER_COLOR[worstTier]}`}}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-[12px]" style={{color: KLASS_COLOR[g.k]}}>{g.k}</span>
                      <span className="ml-auto text-[10px] text-slate-400 tabular-nums">n={g.rs.length}</span>
                      {g.waste > 0 && <span className="text-[9px] px-1 py-px rounded font-bold" style={{background: TIER_COLOR.WASTE+'22', color: TIER_COLOR.WASTE}}>WASTE {g.waste}</span>}
                    </div>
                    <div className="grid grid-cols-2 gap-x-2 text-[10px]">
                      <div><span className="text-slate-500">MEAN δ </span><span className="text-slate-100 tabular-nums">{(g.meanDelta*100).toFixed(1)}%</span></div>
                      <div><span className="text-slate-500">MEAN PEN </span><span className="tabular-nums" style={{color: g.meanPen > 2 ? TIER_COLOR.POOR : '#cbd5e1'}}>{g.meanPen >= 0 ? '+' : ''}{g.meanPen.toFixed(1)}%</span></div>
                    </div>
                    <div className="w-full bg-slate-900/60 rounded h-1 overflow-hidden mt-1.5">
                      <div className="h-full" style={{width:`${Math.round(g.meanDelta*100)}%`, background: TIER_COLOR[worstTier]}}></div>
                    </div>
                  </div>
                )
              })
            })()}
          </div>
        )}

        {tab === 'POLAR' && (
          <div className="px-3 py-2">
            {!polarSel && <div className="px-3 py-6 text-center text-slate-500">no aircraft selected</div>}
            {polarSel && polarCurve && (() => {
              const W = 420, H = 200, M = 28
              const xs = (m: number) => M + (m - 0.55) / (polarCurve.mMax - 0.55) * (W - 2*M)
              const ys = (sr: number) => H - M - (sr / polarCurve.srMax) * (H - 2*M)
              const path = polarCurve.pts.map((p,i) => `${i?'L':'M'}${xs(p.m).toFixed(1)},${ys(p.sr).toFixed(1)}`).join(' ')
              return (
                <>
                  <div className="text-[10px] text-slate-400 mb-1">
                    SR vs Mach · {polarSel.f.callsign || polarSel.f.icao} · {polarSel.perf.family} · FL{(polarSel.f.altitudeFt/100).toFixed(0)} · {(polarSel.weightKg/1000).toFixed(0)}t
                  </div>
                  <svg width={W} height={H} className="bg-slate-900/40 rounded border border-slate-800/60">
                    {/* gridlines */}
                    {[0.6, 0.7, 0.8, 0.9].map(m => (
                      <g key={m}>
                        <line x1={xs(m)} y1={M} x2={xs(m)} y2={H-M} stroke="#1e293b" strokeWidth={0.5} />
                        <text x={xs(m)} y={H-M+12} fontSize={8} fill="#64748b" textAnchor="middle">{m.toFixed(1)}</text>
                      </g>
                    ))}
                    {/* Mcrit line */}
                    <line x1={xs(polarSel.perf.Mcrit)} y1={M} x2={xs(polarSel.perf.Mcrit)} y2={H-M} stroke="#f59e0b" strokeWidth={0.8} strokeDasharray="3,2" />
                    <text x={xs(polarSel.perf.Mcrit)+3} y={M+10} fontSize={8} fill="#f59e0b">Mcrit</text>
                    {/* Mmo line */}
                    <line x1={xs(polarSel.perf.Mmo)} y1={M} x2={xs(polarSel.perf.Mmo)} y2={H-M} stroke="#ef4444" strokeWidth={0.8} />
                    <text x={xs(polarSel.perf.Mmo)+3} y={M+22} fontSize={8} fill="#ef4444">Mmo</text>
                    {/* curve */}
                    <path d={path} stroke="#0ea5e9" strokeWidth={1.5} fill="none" />
                    {/* MRC marker */}
                    <circle cx={xs(polarSel.mMRC)} cy={ys(computeSR(polarSel.f.altitudeFt, polarSel.mMRC, polarSel.weightKg, polarSel.perf).sr)} r={4} fill="#a855f7" />
                    <text x={xs(polarSel.mMRC)} y={ys(computeSR(polarSel.f.altitudeFt, polarSel.mMRC, polarSel.weightKg, polarSel.perf).sr)-7} fontSize={9} fill="#a855f7" textAnchor="middle">MRC</text>
                    {/* LRC marker */}
                    <circle cx={xs(polarSel.mLRC)} cy={ys(computeSR(polarSel.f.altitudeFt, polarSel.mLRC, polarSel.weightKg, polarSel.perf).sr)} r={4} fill="#10b981" />
                    <text x={xs(polarSel.mLRC)} y={ys(computeSR(polarSel.f.altitudeFt, polarSel.mLRC, polarSel.weightKg, polarSel.perf).sr)+14} fontSize={9} fill="#10b981" textAnchor="middle">LRC</text>
                    {/* current marker */}
                    <circle cx={xs(polarSel.mach)} cy={ys(polarSel.sr)} r={5} fill={TIER_COLOR[polarSel.tier]} stroke="#fff" strokeWidth={1} />
                    {/* CI marker */}
                    <circle cx={xs(polarSel.mCI)} cy={ys(computeSR(polarSel.f.altitudeFt, polarSel.mCI, polarSel.weightKg, polarSel.perf).sr)} r={3.5} fill="#0ea5e9" />
                    <text x={xs(polarSel.mCI)} y={ys(computeSR(polarSel.f.altitudeFt, polarSel.mCI, polarSel.weightKg, polarSel.perf).sr)-7} fontSize={8} fill="#0ea5e9" textAnchor="middle">CI{ci}</text>
                    {/* axis labels */}
                    <text x={W/2} y={H-4} fontSize={9} fill="#64748b" textAnchor="middle">Mach</text>
                    <text x={6} y={M-6} fontSize={8} fill="#64748b">SR / max</text>
                  </svg>
                  <div className="mt-2 text-[10px] text-slate-400 grid grid-cols-2 gap-x-2 gap-y-0.5">
                    <div>OPT-FL <span className="text-amber-300 tabular-nums">{polarSel.flOpt}</span></div>
                    <div>CUR-FL <span className="text-slate-100 tabular-nums">{(polarSel.f.altitudeFt/100).toFixed(0)}</span></div>
                    <div>BURN PEN <span className="tabular-nums" style={{color: polarSel.burnPenaltyPct > 2 ? TIER_COLOR.POOR : '#cbd5e1'}}>{polarSel.burnPenaltyPct >= 0 ? '+' : ''}{polarSel.burnPenaltyPct.toFixed(1)}%</span></div>
                    <div>L/D <span className="text-slate-100 tabular-nums">{polarSel.LD.toFixed(2)}</span></div>
                  </div>
                </>
              )
            })()}
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800/60 text-[9px] text-slate-500 italic">
        Breguet 1923 · Anderson §5 · Mason Ch 8 wave drag · Roskam Pt VI · Boeing PEM §3 · Airbus GTGFE §1.3 · GTGCI · EUROCONTROL BADA 3.15
      </div>
    </div>
  )
}
