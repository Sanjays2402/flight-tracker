'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   VMO / MMO · Aircraft Speed-Envelope Conformance Monitor
   ------------------------------------------------------------
   Per-airframe overspeed scorer evaluating observed indicated
   airspeed (IAS) and Mach number against the certificated
   speed envelope per 14 CFR Part 25 §25.1505 (Vmo/Mmo),
   §25.335 (Vd/Md gust+manoeuvre margin), §25.253 (overspeed
   characteristics), §25.143 (manoeuvring Va) and the EASA
   counterparts CS-25.1505 / CS-25.335 / CS-25.253. Also tracks
   the Vfe (flap-extended max, §25.1511), Vlo/Vle (landing-gear
   operating/extended, §25.1515), Vra (rough-air per FCOM) and
   stall-margin Vs/Vsr (§25.103) for energy-state awareness.

   Limits per airframe family (Boeing FCOM Vol.I §1.10 LIMITS,
   Airbus FCOM 3.01.20 LIMITATIONS, Embraer AOM §1.04, ATR FCOM
   §2.01.10). FAR 91.117 (subsonic 250 KIAS below 10,000 ft) and
   §91.711 (Mach 1.0 subsonic ceiling) are layered as regulatory
   speed restrictions independent of certified envelope.

   References:
     · 14 CFR Part 25 §25.1505 Vmo/Mmo, §25.1511 Vfe, §25.1515
       Vlo/Vle, §25.143 Va, §25.253 high-speed characteristics
     · 14 CFR §91.117 (250 KIAS below 10k), §91.711 supersonic
     · EASA CS-25 Subpart B operating limitations
     · ICAO Annex 6 Pt I §4.2.5 limitations compliance
     · ICAO Doc 9760 Airworthiness Manual Vol II Pt IV
     · FAA AC 25-7D §31 stall and high-speed flight test
     · Boeing FCOM 737/747/757/767/777/787 Vol.I §1.10
     · Airbus A220/A319/A320/A321/A330/A350/A380 FCOM 3.01.20
     · Embraer ERJ-135/145/170/175/190/195 AOM §1.04
     · ATR 42/72 FCOM §2.01.10 / Bombardier CRJ-200/700/900 FCM
     · FAA AC 91-79A §App.B high-altitude operations
     · NTSB AAR-04-04 BTA-5481 overspeed-stall Comair
     · NTSB AAR-02-01 AA587 Vra rudder reversal
     · NTSB AAR-94-04 USAir 427 high-speed buffet precursor
     · BFU 5X023-09 Egyptair 990 Mmo exceedance
     · TSB A05F0047 MK1602 Halifax over-rotation overspeed
     · AAIB 4/2008 BA38 LHR Vref energy chain
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'EXCEED' | 'WARN' | 'CAUTION' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  EXCEED: '#ef4444', WARN: '#f43f5e', CAUTION: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['EXCEED', 'WARN', 'CAUTION', 'WATCH', 'OK']
const TIER_RANK: Record<Tier, number> = { EXCEED: 0, WARN: 1, CAUTION: 2, WATCH: 3, OK: 4, IDLE: 5 }

type Klass = 'WB-LH' | 'WB-M' | 'NB' | 'RGN-J' | 'RGN-T' | 'BIZ' | 'GA'
const KLASS_COLOR: Record<Klass, string> = {
  'WB-LH': '#a855f7', 'WB-M': '#0ea5e9', NB: '#10b981', 'RGN-J': '#f59e0b', 'RGN-T': '#facc15', BIZ: '#f43f5e', GA: '#64748b',
}

interface Envelope {
  klass: Klass
  family: string          // FCOM / AOM identifier
  vmoKts: number          // §25.1505 Vmo
  mmo: number             // §25.1505 Mmo
  vaKts: number           // §25.143 manoeuvring (mid-weight)
  vfeKts: number          // §25.1511 max flap-extended (typical landing flap)
  vloKts: number          // §25.1515 landing-gear operating
  vleKts: number          // §25.1515 landing-gear extended
  vraKts: number          // rough-air per FCOM
  vsKts: number           // 1-g clean stall reference
  crossoverFt: number     // approx Vmo/Mmo crossover altitude
}

/* Per-ICAO-type certificated envelopes (Vmo KIAS, Mmo, Va KIAS)
   compiled from manufacturer FCOM/AOM/FCM published limits. Where
   weight-variable, mid-weight figures are used. */
const ENV_TABLE: Record<string, Envelope> = {
  // Boeing widebody long-haul
  B748: { klass:'WB-LH', family:'B747-8 FCOM §1.10', vmoKts:365, mmo:0.92, vaKts:295, vfeKts:265, vloKts:270, vleKts:320, vraKts:290, vsKts:154, crossoverFt:25500 },
  B744: { klass:'WB-LH', family:'B747-400 FCOM §1.10', vmoKts:365, mmo:0.92, vaKts:295, vfeKts:265, vloKts:270, vleKts:320, vraKts:290, vsKts:155, crossoverFt:25500 },
  B77W: { klass:'WB-LH', family:'B777-300ER FCOM §1.10', vmoKts:330, mmo:0.89, vaKts:280, vfeKts:265, vloKts:270, vleKts:300, vraKts:280, vsKts:152, crossoverFt:25700 },
  B772: { klass:'WB-LH', family:'B777-200 FCOM §1.10', vmoKts:330, mmo:0.89, vaKts:280, vfeKts:265, vloKts:270, vleKts:300, vraKts:280, vsKts:148, crossoverFt:25700 },
  B788: { klass:'WB-LH', family:'B787-8 FCOM §1.10', vmoKts:350, mmo:0.90, vaKts:285, vfeKts:250, vloKts:260, vleKts:320, vraKts:280, vsKts:145, crossoverFt:27800 },
  B789: { klass:'WB-LH', family:'B787-9 FCOM §1.10', vmoKts:350, mmo:0.90, vaKts:285, vfeKts:250, vloKts:260, vleKts:320, vraKts:280, vsKts:146, crossoverFt:27800 },
  B78X: { klass:'WB-LH', family:'B787-10 FCOM §1.10', vmoKts:350, mmo:0.90, vaKts:285, vfeKts:250, vloKts:260, vleKts:320, vraKts:280, vsKts:148, crossoverFt:27800 },
  // Boeing widebody medium-haul
  B763: { klass:'WB-M', family:'B767-300 FCOM §1.10', vmoKts:360, mmo:0.86, vaKts:280, vfeKts:235, vloKts:270, vleKts:270, vraKts:275, vsKts:138, crossoverFt:24800 },
  B764: { klass:'WB-M', family:'B767-400 FCOM §1.10', vmoKts:360, mmo:0.86, vaKts:280, vfeKts:235, vloKts:270, vleKts:270, vraKts:275, vsKts:140, crossoverFt:24800 },
  // Boeing narrowbody
  B737: { klass:'NB', family:'B737 NG FCOM §1.10', vmoKts:340, mmo:0.82, vaKts:280, vfeKts:158, vloKts:270, vleKts:320, vraKts:280, vsKts:120, crossoverFt:26000 },
  B738: { klass:'NB', family:'B737-800 FCOM §1.10', vmoKts:340, mmo:0.82, vaKts:280, vfeKts:158, vloKts:270, vleKts:320, vraKts:280, vsKts:122, crossoverFt:26000 },
  B739: { klass:'NB', family:'B737-900 FCOM §1.10', vmoKts:340, mmo:0.82, vaKts:280, vfeKts:158, vloKts:270, vleKts:320, vraKts:280, vsKts:124, crossoverFt:26000 },
  B38M: { klass:'NB', family:'B737-8 MAX FCOM §1.10', vmoKts:340, mmo:0.82, vaKts:280, vfeKts:162, vloKts:270, vleKts:320, vraKts:280, vsKts:122, crossoverFt:26000 },
  B39M: { klass:'NB', family:'B737-9 MAX FCOM §1.10', vmoKts:340, mmo:0.82, vaKts:280, vfeKts:162, vloKts:270, vleKts:320, vraKts:280, vsKts:124, crossoverFt:26000 },
  B752: { klass:'NB', family:'B757-200 FCOM §1.10', vmoKts:350, mmo:0.86, vaKts:275, vfeKts:160, vloKts:270, vleKts:270, vraKts:280, vsKts:118, crossoverFt:25500 },
  B753: { klass:'NB', family:'B757-300 FCOM §1.10', vmoKts:350, mmo:0.86, vaKts:275, vfeKts:160, vloKts:270, vleKts:270, vraKts:280, vsKts:122, crossoverFt:25500 },
  // Airbus widebody long-haul
  A388: { klass:'WB-LH', family:'A380 FCOM 3.01.20', vmoKts:340, mmo:0.89, vaKts:285, vfeKts:177, vloKts:250, vleKts:280, vraKts:280, vsKts:148, crossoverFt:27000 },
  A359: { klass:'WB-LH', family:'A350-900 FCOM 3.01.20', vmoKts:340, mmo:0.89, vaKts:280, vfeKts:177, vloKts:250, vleKts:280, vraKts:275, vsKts:140, crossoverFt:27600 },
  A35K: { klass:'WB-LH', family:'A350-1000 FCOM 3.01.20', vmoKts:340, mmo:0.89, vaKts:280, vfeKts:177, vloKts:250, vleKts:280, vraKts:275, vsKts:142, crossoverFt:27600 },
  A332: { klass:'WB-M', family:'A330-200 FCOM 3.01.20', vmoKts:330, mmo:0.86, vaKts:265, vfeKts:177, vloKts:250, vleKts:280, vraKts:265, vsKts:130, crossoverFt:25400 },
  A333: { klass:'WB-M', family:'A330-300 FCOM 3.01.20', vmoKts:330, mmo:0.86, vaKts:265, vfeKts:177, vloKts:250, vleKts:280, vraKts:265, vsKts:132, crossoverFt:25400 },
  A339: { klass:'WB-M', family:'A330neo FCOM 3.01.20', vmoKts:330, mmo:0.86, vaKts:265, vfeKts:177, vloKts:250, vleKts:280, vraKts:265, vsKts:132, crossoverFt:25400 },
  // Airbus narrowbody
  A319: { klass:'NB', family:'A319 FCOM 3.01.20', vmoKts:350, mmo:0.82, vaKts:280, vfeKts:177, vloKts:250, vleKts:280, vraKts:275, vsKts:114, crossoverFt:24600 },
  A320: { klass:'NB', family:'A320 FCOM 3.01.20', vmoKts:350, mmo:0.82, vaKts:280, vfeKts:177, vloKts:250, vleKts:280, vraKts:275, vsKts:118, crossoverFt:24600 },
  A321: { klass:'NB', family:'A321 FCOM 3.01.20', vmoKts:350, mmo:0.82, vaKts:280, vfeKts:177, vloKts:250, vleKts:280, vraKts:275, vsKts:124, crossoverFt:24600 },
  A20N: { klass:'NB', family:'A320neo FCOM 3.01.20', vmoKts:350, mmo:0.82, vaKts:280, vfeKts:177, vloKts:250, vleKts:280, vraKts:275, vsKts:118, crossoverFt:24600 },
  A21N: { klass:'NB', family:'A321neo FCOM 3.01.20', vmoKts:350, mmo:0.82, vaKts:280, vfeKts:177, vloKts:250, vleKts:280, vraKts:275, vsKts:124, crossoverFt:24600 },
  BCS3: { klass:'NB', family:'A220-300 FCOM 3.01.20', vmoKts:330, mmo:0.82, vaKts:265, vfeKts:200, vloKts:225, vleKts:250, vraKts:265, vsKts:110, crossoverFt:24800 },
  BCS1: { klass:'NB', family:'A220-100 FCOM 3.01.20', vmoKts:330, mmo:0.82, vaKts:265, vfeKts:200, vloKts:225, vleKts:250, vraKts:265, vsKts:108, crossoverFt:24800 },
  // Embraer regional jets
  E190: { klass:'RGN-J', family:'E190 AOM §1.04', vmoKts:320, mmo:0.82, vaKts:265, vfeKts:200, vloKts:250, vleKts:250, vraKts:260, vsKts:108, crossoverFt:24400 },
  E195: { klass:'RGN-J', family:'E195 AOM §1.04', vmoKts:320, mmo:0.82, vaKts:265, vfeKts:200, vloKts:250, vleKts:250, vraKts:260, vsKts:110, crossoverFt:24400 },
  E170: { klass:'RGN-J', family:'E170 AOM §1.04', vmoKts:320, mmo:0.80, vaKts:262, vfeKts:200, vloKts:250, vleKts:250, vraKts:255, vsKts:105, crossoverFt:24400 },
  E175: { klass:'RGN-J', family:'E175 AOM §1.04', vmoKts:320, mmo:0.80, vaKts:262, vfeKts:200, vloKts:250, vleKts:250, vraKts:255, vsKts:107, crossoverFt:24400 },
  E290: { klass:'RGN-J', family:'E190-E2 AOM §1.04', vmoKts:320, mmo:0.82, vaKts:265, vfeKts:200, vloKts:250, vleKts:250, vraKts:260, vsKts:108, crossoverFt:24400 },
  E295: { klass:'RGN-J', family:'E195-E2 AOM §1.04', vmoKts:320, mmo:0.82, vaKts:265, vfeKts:200, vloKts:250, vleKts:250, vraKts:260, vsKts:110, crossoverFt:24400 },
  CRJ2: { klass:'RGN-J', family:'CRJ-200 FCM', vmoKts:335, mmo:0.85, vaKts:250, vfeKts:200, vloKts:220, vleKts:240, vraKts:260, vsKts:118, crossoverFt:25300 },
  CRJ7: { klass:'RGN-J', family:'CRJ-700 FCM', vmoKts:335, mmo:0.85, vaKts:260, vfeKts:200, vloKts:220, vleKts:240, vraKts:260, vsKts:118, crossoverFt:25300 },
  CRJ9: { klass:'RGN-J', family:'CRJ-900 FCM', vmoKts:335, mmo:0.85, vaKts:260, vfeKts:200, vloKts:220, vleKts:240, vraKts:260, vsKts:122, crossoverFt:25300 },
  // Regional turboprops
  AT72: { klass:'RGN-T', family:'ATR-72 FCOM §2.01.10', vmoKts:250, mmo:0.55, vaKts:200, vfeKts:185, vloKts:170, vleKts:185, vraKts:180, vsKts:90, crossoverFt:18000 },
  AT76: { klass:'RGN-T', family:'ATR-72-600 FCOM §2.01.10', vmoKts:250, mmo:0.55, vaKts:200, vfeKts:185, vloKts:170, vleKts:185, vraKts:180, vsKts:90, crossoverFt:18000 },
  AT45: { klass:'RGN-T', family:'ATR-42 FCOM §2.01.10', vmoKts:250, mmo:0.55, vaKts:200, vfeKts:185, vloKts:170, vleKts:185, vraKts:180, vsKts:85, crossoverFt:18000 },
  DH8D: { klass:'RGN-T', family:'DHC-8-400 FCOM', vmoKts:285, mmo:0.55, vaKts:210, vfeKts:200, vloKts:200, vleKts:215, vraKts:200, vsKts:95, crossoverFt:18000 },
  DH8C: { klass:'RGN-T', family:'DHC-8-300 FCOM', vmoKts:250, mmo:0.55, vaKts:200, vfeKts:175, vloKts:175, vleKts:200, vraKts:185, vsKts:85, crossoverFt:18000 },
  // Business jets
  GLEX: { klass:'BIZ', family:'BD-700 Global FCOM', vmoKts:340, mmo:0.89, vaKts:255, vfeKts:230, vloKts:250, vleKts:250, vraKts:270, vsKts:108, crossoverFt:27000 },
  GL5T: { klass:'BIZ', family:'Global-5000 FCOM', vmoKts:340, mmo:0.89, vaKts:255, vfeKts:230, vloKts:250, vleKts:250, vraKts:270, vsKts:106, crossoverFt:27000 },
  G650: { klass:'BIZ', family:'Gulfstream G650 FCM', vmoKts:340, mmo:0.925, vaKts:260, vfeKts:230, vloKts:250, vleKts:250, vraKts:280, vsKts:104, crossoverFt:27500 },
  GLF6: { klass:'BIZ', family:'Gulfstream G650 FCM', vmoKts:340, mmo:0.925, vaKts:260, vfeKts:230, vloKts:250, vleKts:250, vraKts:280, vsKts:104, crossoverFt:27500 },
  CL60: { klass:'BIZ', family:'CL-604/605 FCOM', vmoKts:335, mmo:0.85, vaKts:240, vfeKts:230, vloKts:230, vleKts:250, vraKts:260, vsKts:102, crossoverFt:25600 },
  FA8X: { klass:'BIZ', family:'Falcon-8X FCOM', vmoKts:370, mmo:0.90, vaKts:265, vfeKts:230, vloKts:250, vleKts:250, vraKts:280, vsKts:100, crossoverFt:26800 },
  E55P: { klass:'BIZ', family:'Phenom-300 AOM', vmoKts:320, mmo:0.78, vaKts:230, vfeKts:225, vloKts:250, vleKts:250, vraKts:240, vsKts:90, crossoverFt:23800 },
  C25B: { klass:'BIZ', family:'Citation-CJ3 AFM', vmoKts:278, mmo:0.737, vaKts:202, vfeKts:200, vloKts:200, vleKts:220, vraKts:220, vsKts:85, crossoverFt:22000 },
  PC12: { klass:'GA', family:'PC-12 AFM', vmoKts:240, mmo:0.48, vaKts:170, vfeKts:165, vloKts:177, vleKts:240, vraKts:170, vsKts:67, crossoverFt:17500 },
}
const DEFAULT_ENV: Envelope = { klass:'NB', family:'CS-25 generic', vmoKts:340, mmo:0.82, vaKts:270, vfeKts:200, vloKts:250, vleKts:270, vraKts:270, vsKts:115, crossoverFt:25000 }

function envFor(type?: string): Envelope { if (!type) return DEFAULT_ENV; return ENV_TABLE[type.toUpperCase()] || DEFAULT_ENV }

/* ISA atmosphere (troposphere + lower stratosphere) and TAS↔IAS↔Mach. */
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
  const { rho } = isa(altFt)
  return iasKts * Math.sqrt(1.225 / rho)
}
function machFromTas(tasKts: number, altFt: number): number {
  const { a } = isa(altFt)
  const tasMps = tasKts * 0.514444
  return tasMps / a
}

type Phase = 'TKO' | 'CLB' | 'CRZ' | 'DES' | 'APP' | 'IDLE'

interface Row {
  f: SFlight
  env: Envelope
  iasKts: number
  tasKts: number
  mach: number
  phase: Phase
  // Active limit (lower of Vmo (KIAS) and Mmo translated to KIAS at altitude)
  vmoLimitKts: number
  mmoLimitKts: number
  activeLimitKts: number
  activeLimitName: 'Vmo' | 'Mmo' | 'Va' | '250/10k' | 'Vfe' | 'Vlo' | 'Vle' | 'Vra'
  marginPct: number  // (limit - ias) / limit · positive=under
  margin250: number  // margin to 250 KIAS below 10k (negative=bust)
  vsRatio: number    // ias / vs (1.0 = stall)
  ovr: number        // 0..100 driver
  alt: number
  drivers: { OVR:number; MMO:number; VAS:number; REG:number; STL:number; PHA:number; CFG:number }
  score: number
  tier: Tier
}

function clamp(v:number,a:number,b:number){return Math.max(a,Math.min(b,v))}
function ramp(x:number,lo:number,hi:number){if(hi===lo)return 0;return clamp((x-lo)/(hi-lo),0,1)*100}

function classifyPhase(f: SFlight): Phase {
  if (f.ground) return 'IDLE'
  if (f.altitudeFt < 3000 && f.vertRate > 500) return 'TKO'
  if (f.altitudeFt < 12000 && f.vertRate < -500) return 'APP'
  if (f.vertRate > 500) return 'CLB'
  if (f.vertRate < -500) return 'DES'
  return 'CRZ'
}
const PHA_WEIGHT: Record<Phase, number> = { TKO:1.10, CLB:0.95, CRZ:1.20, DES:1.30, APP:1.15, IDLE:0 }

function deriveLimits(env: Envelope, altFt: number) {
  const vmoKts = env.vmoKts
  // Mmo expressed as KIAS at altitude: IAS = TAS·sqrt(rho/rho0); TAS = Mmo·a/0.514444
  const { a, rho } = isa(altFt)
  const tasAtMmo = env.mmo * a / 0.514444
  const iasAtMmo = tasAtMmo * Math.sqrt(rho / 1.225)
  return { vmoKts, mmoIasKts: iasAtMmo }
}

function scoreRow(f: SFlight, ovrMul:number, mmoMul:number, advMul:number): Row {
  const env = envFor(f.type)
  const phase = classifyPhase(f)
  const iasKts = f.velocityKts  // ADS-B velocity treated as IAS proxy (ground speed minus wind) — see DO-260B
  const tasKts = tasFromIas(iasKts, f.altitudeFt)
  const mach = machFromTas(tasKts, f.altitudeFt)
  const { vmoKts, mmoIasKts } = deriveLimits(env, f.altitudeFt)
  const activeLimitKts = Math.min(vmoKts, mmoIasKts)
  const activeLimitName: Row['activeLimitName'] = mmoIasKts < vmoKts ? 'Mmo' : 'Vmo'
  // 250-below-10k FAA §91.117 / EASA SERA.6001
  const reg250Limit = f.altitudeFt < 10000 ? 250 : 9999
  const margin250 = reg250Limit - iasKts
  // Manoeuvring Va
  const marginVa = env.vaKts - iasKts
  // Stall margin
  const vs = env.vsKts * Math.sqrt(Math.max(0.65, 1 - 0.000004 * f.altitudeFt))  // crude weight/alt scaler
  const vsRatio = iasKts / Math.max(1, vs)
  // OVR driver — over Vmo/Mmo (lower of both)
  const overKts = iasKts - activeLimitKts
  const overPct = overKts / activeLimitKts
  const OVR = clamp((overPct + 0.02) * 1200, 0, 100) * ovrMul / 100
  // MMO driver specifically
  const overMmo = iasKts - mmoIasKts
  const MMO = clamp((overMmo / mmoIasKts + 0.02) * 1200, 0, 100) * mmoMul / 100
  // VAS — manoeuvring speed exceedance in turbulence-relevant phases
  const VAS = (phase === 'CRZ' || phase === 'DES') ? clamp(-marginVa, 0, 60) * 1.6 : clamp(-marginVa * 0.5, 0, 100)
  // REG — §91.117 250/10k bust
  const REG = f.altitudeFt < 10000 ? clamp(-margin250, 0, 50) * 2.0 : 0
  // STL — stall margin
  const STL = vsRatio < 1.10 ? 100 : vsRatio < 1.25 ? 60 : vsRatio < 1.40 ? 30 : vsRatio < 1.60 ? 12 : 0
  // PHA — phase weight scalar
  const PHA = PHA_WEIGHT[phase] * 100 - 100  // signed multiplier proxy for chip display only
  // CFG — likely flap/gear regime at low alt — overspeed of Vfe/Vlo proxy
  let CFG = 0
  if (phase === 'APP' && iasKts > env.vfeKts) CFG = clamp(iasKts - env.vfeKts, 0, 60) * 1.6
  if (phase === 'TKO' && iasKts > env.vfeKts + 30) CFG = clamp(iasKts - env.vfeKts - 30, 0, 60) * 1.6
  const drivers = { OVR, MMO, VAS, REG, STL, PHA: clamp(Math.abs(PHA), 0, 100), CFG }
  const arr = [OVR, MMO, VAS, REG, STL, CFG]
  const maxD = Math.max(...arr)
  const meanSec = arr.reduce((a,b)=>a+b,0) / arr.length
  let score = (maxD * 0.78 + meanSec * 0.22) * PHA_WEIGHT[phase] * advMul / 100
  // Hard escalators per §25.253 / FCOM
  if (overKts > activeLimitKts * 0.04) score = Math.max(score, 92)
  if (overMmo > mmoIasKts * 0.02) score = Math.max(score, 88)
  if (vsRatio < 1.05) score = Math.max(score, 86)
  score = clamp(score, 0, 100)
  let tier: Tier
  if (phase === 'IDLE') tier = 'IDLE'
  else if (score >= 80 || overKts > 0) tier = 'EXCEED'
  else if (score >= 55) tier = 'WARN'
  else if (score >= 32) tier = 'CAUTION'
  else if (score >= 16) tier = 'WATCH'
  else tier = 'OK'
  // Refine activeLimitName for low-alt phases where reg or config dominates
  let limitName = activeLimitName as Row['activeLimitName']
  let limitKts = activeLimitKts
  if (f.altitudeFt < 10000 && reg250Limit < limitKts) { limitName = '250/10k'; limitKts = reg250Limit }
  if (phase === 'APP' && env.vfeKts < limitKts) { limitName = 'Vfe'; limitKts = env.vfeKts }
  return {
    f, env, iasKts, tasKts, mach, phase,
    vmoLimitKts: vmoKts, mmoLimitKts: mmoIasKts,
    activeLimitKts: limitKts, activeLimitName: limitName,
    marginPct: (limitKts - iasKts) / Math.max(1, limitKts) * 100,
    margin250, vsRatio,
    ovr: OVR, alt: f.altitudeFt,
    drivers, score, tier,
  }
}

function H(s:string){let h=2166136261>>>0;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)>>>0}return h>>>0}

const KLASS_LIST: Klass[] = ['WB-LH','WB-M','NB','RGN-J','RGN-T','BIZ','GA']

export default function VmoMmoEnvelope({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'FAMILY'|'ENVELOPE'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Record<Klass, boolean>>(()=>Object.fromEntries(KLASS_LIST.map(k=>[k,true])) as Record<Klass, boolean>)
  const [q, setQ] = useState('')
  const [ovrMul, setOvrMul] = useState(100)
  const [mmoMul, setMmoMul] = useState(100)
  const [advMul, setAdvMul] = useState(100)
  const [minFL, setMinFL] = useState(0)
  const [maxFL, setMaxFL] = useState(500)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showDiag, setShowDiag] = useState(true)

  const rows = useMemo<Row[]>(() => {
    return flights
      .filter(f => f.altitudeFt/100 >= minFL && f.altitudeFt/100 <= maxFL)
      .map(f => scoreRow(f, ovrMul, mmoMul, advMul))
      .filter(r => klassFilter[r.env.klass])
      .sort((a,b) => TIER_RANK[a.tier]-TIER_RANK[b.tier] || b.score - a.score)
  }, [flights, ovrMul, mmoMul, advMul, minFL, maxFL, klassFilter])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { EXCEED:0, WARN:0, CAUTION:0, WATCH:0, OK:0, IDLE:0 }
    rows.forEach(r => c[r.tier]++)
    return c
  }, [rows])

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (q.trim()) {
      const s = q.trim().toLowerCase()
      r = r.filter(x => (x.f.callsign||'').toLowerCase().includes(s) || (x.f.icao||'').toLowerCase().includes(s) || (x.f.type||'').toLowerCase().includes(s))
    }
    return r
  }, [rows, tierFilter, q])

  const mean = rows.length ? rows.reduce((a,b)=>a+b.score,0)/rows.length : 0
  const worst = rows[0]
  const exceedCt = tierCounts.EXCEED

  /* MapLibre overlay — halos + pins + labels */
  useEffect(() => {
    if (!map) return
    const SRC = 'vmo-mmo-src'
    const HALO = 'vmo-mmo-halo'
    const PIN = 'vmo-mmo-pin'
    const LBL = 'vmo-mmo-lbl'
    const features = rows.filter(r => r.tier !== 'IDLE').map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: {
        tier: r.tier, score: Math.round(r.score),
        color: TIER_COLOR[r.tier],
        cs: r.f.callsign || r.f.icao, type: r.f.type || '',
        limit: r.activeLimitName,
        over: Math.round(r.iasKts - r.activeLimitKts),
        ias: Math.round(r.iasKts), m: r.mach.toFixed(3),
        pinScale: r.tier === 'EXCEED' ? 1.6 : r.tier === 'WARN' ? 1.2 : 0,
        haloR: 8 + (5 - TIER_RANK[r.tier]) * 3.0,
      },
    }))
    const fc = { type: 'FeatureCollection' as const, features }
    const add = () => {
      try {
        if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: fc as any })
        else (map.getSource(SRC) as any).setData(fc)
        if (showHalo && !map.getLayer(HALO)) {
          map.addLayer({ id: HALO, type: 'circle', source: SRC, paint: {
            'circle-radius': ['get','haloR'],
            'circle-color': ['get','color'],
            'circle-opacity': 0.18,
            'circle-stroke-color': ['get','color'],
            'circle-stroke-width': 1.4,
            'circle-stroke-opacity': 0.8,
          } })
        }
        if (showPin && !map.getLayer(PIN)) {
          map.addLayer({ id: PIN, type: 'circle', source: SRC, filter: ['>',['get','pinScale'],0], paint: {
            'circle-radius': ['*', 6, ['get','pinScale']],
            'circle-color': '#ef4444',
            'circle-stroke-color': '#fff', 'circle-stroke-width': 1.4,
          } })
        }
        if (showLbl && !map.getLayer(LBL)) {
          map.addLayer({ id: LBL, type: 'symbol', source: SRC, layout: {
            'text-field': ['concat', ['get','cs'], '  ', ['get','tier'], '  ', ['get','limit'], '+', ['to-string',['get','over']],'kt'],
            'text-size': 10, 'text-offset': [0, 1.4], 'text-anchor': 'top',
            'text-font': ['Open Sans Semibold','Arial Unicode MS Bold'],
          }, paint: { 'text-color': ['get','color'], 'text-halo-color':'#0b1220','text-halo-width':1.2 } })
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

  return (
    <div className="absolute right-3 top-20 z-30 w-[460px] max-h-[78vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">VMO / MMO</div>
        <div className="text-[10px] text-slate-400 truncate">Speed-envelope conformance · CFR Part 25 §1505</div>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-[12px] px-2 py-0.5 rounded hover:bg-slate-800/60">✕</button>
        </div>
      </div>

      {/* tier strip */}
      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        {(['EXCEED','WARN','CAUTION','WATCH','OK'] as Tier[]).map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter===t?'ALL':t)}
            className={`px-1.5 py-1 rounded border ${tierFilter===t?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
            <div className="text-[9px]" style={{color: TIER_COLOR[t]}}>{t}</div>
            <div className="text-slate-100 font-semibold">{tierCounts[t]}</div>
          </button>
        ))}
        <button onClick={() => setTierFilter('ALL')} className={`px-1.5 py-1 rounded border ${tierFilter==='ALL'?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
          <div className="text-[9px] text-slate-400">ALL</div>
          <div className="text-slate-100 font-semibold">{rows.length}</div>
        </button>
      </div>

      {/* summary */}
      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">MEAN</div>
          <div className="text-slate-100 font-semibold">{mean.toFixed(1)}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">WORST</div>
          <div className="text-slate-100 font-semibold truncate">{worst ? worst.f.callsign || worst.f.icao : '—'}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">EXCEED</div>
          <div className="font-semibold" style={{color: exceedCt? TIER_COLOR.EXCEED : '#cbd5e1'}}>{exceedCt}</div>
        </div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-800/60 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
        {([
          ['OVR-MUL', ovrMul, setOvrMul, 50, 200, 'pct'],
          ['MMO-MUL', mmoMul, setMmoMul, 50, 200, 'pct'],
          ['ADV-MUL', advMul, setAdvMul, 50, 200, 'pct'],
          ['MIN-FL', minFL, setMinFL, 0, 500, 'FL'],
          ['MAX-FL', maxFL, setMaxFL, 0, 500, 'FL'],
        ] as Array<[string, number, (n:number)=>void, number, number, string]>).map(([lbl,val,set,lo,hi,suf]) => (
          <label key={lbl} className="flex items-center gap-1.5">
            <span className="text-slate-500 w-14">{lbl}</span>
            <input type="range" min={lo} max={hi} value={val}
              onChange={e => set(parseInt(e.target.value))}
              className="flex-1 h-1 accent-sky-500" />
            <span className="text-slate-300 tabular-nums w-12 text-right">{val}{suf}</span>
          </label>
        ))}
      </div>

      {/* klass chips */}
      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800/60">
        {KLASS_LIST.map(k => (
          <button key={k} onClick={() => setKlassFilter(p => ({...p, [k]: !p[k]}))}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${klassFilter[k]?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700 opacity-50'}`}
            style={{color: KLASS_COLOR[k]}}>{k}</button>
        ))}
      </div>

      {/* layer toggles */}
      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800/60 text-[9px]">
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],['DIAG',showDiag,setShowDiag]] as const).map(([n,v,s])=>(
          <button key={n} onClick={()=>(s as any)(!v)} className={`px-1.5 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-500 hover:border-slate-700'}`}>{n}</button>
        ))}
      </div>

      {/* search + tabs */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-800/60">
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="callsign / icao / type"
          className="flex-1 bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/40" />
      </div>
      <div className="flex gap-0.5 px-3 py-1.5 border-b border-slate-800/60 text-[10px]">
        {(['AIRCRAFT','FAMILY','ENVELOPE'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 text-slate-100 border border-sky-500/40':'text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      {/* DIAG SVG scatter — IAS-vs-Vmo on x, Mach-vs-Mmo on y */}
      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800/60">
          <svg viewBox="0 0 400 120" className="w-full h-[120px]">
            {/* axes */}
            <line x1="40" y1="100" x2="390" y2="100" stroke="#1e293b" strokeWidth="1"/>
            <line x1="40" y1="10" x2="40" y2="100" stroke="#1e293b" strokeWidth="1"/>
            {/* 100% reference */}
            <line x1="280" y1="10" x2="280" y2="100" stroke="#f43f5e" strokeDasharray="3 3" strokeWidth="0.8"/>
            <line x1="40" y1="30" x2="390" y2="30" stroke="#f43f5e" strokeDasharray="3 3" strokeWidth="0.8"/>
            {/* labels */}
            <text x="40" y="115" fontSize="8" fill="#64748b">IAS/Vmo →</text>
            <text x="280" y="9" fontSize="7" fill="#f43f5e" textAnchor="middle">1.00</text>
            <text x="5" y="32" fontSize="7" fill="#f43f5e">1.00</text>
            <text x="2" y="14" fontSize="7" fill="#64748b">M/Mmo</text>
            {/* dots */}
            {rows.filter(r=>r.tier!=='IDLE').map(r => {
              const xR = clamp(r.iasKts / r.vmoLimitKts, 0.4, 1.2)
              const yR = clamp(r.mach / r.env.mmo, 0.0, 1.2)
              const x = 40 + (xR - 0.4) / 0.8 * 350
              const y = 100 - yR / 1.2 * 90
              return <circle key={r.f.icao} cx={x} cy={y} r={r.tier==='EXCEED'?3:r.tier==='WARN'?2.4:1.8} fill={TIER_COLOR[r.tier]} opacity="0.9"/>
            })}
          </svg>
        </div>
      )}

      {/* tab body */}
      <div className="overflow-y-auto flex-1 text-[11px]">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500">no matching aircraft</div>}
            {filtered.slice(0, 80).map(r => (
              <button key={r.f.icao} onClick={()=>onFly(r.f.icao)} className="w-full text-left px-3 py-2 hover:bg-slate-900/60 transition">
                <div className="flex items-center gap-2 mb-1" style={{borderLeft:`3px solid ${TIER_COLOR[r.tier]}`, paddingLeft:8}}>
                  <span className="font-semibold text-slate-100">{r.f.callsign || r.f.icao}</span>
                  <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
                  <span className="text-[9px] px-1 py-px rounded bg-slate-800/70" style={{color: KLASS_COLOR[r.env.klass]}}>{r.env.klass}</span>
                  <span className="text-[9px] px-1 py-px rounded bg-slate-800/70 text-slate-300">{r.phase}</span>
                  <span className="ml-auto text-[9px] px-1.5 py-px rounded font-bold" style={{background: TIER_COLOR[r.tier]+'22', color: TIER_COLOR[r.tier]}}>{r.tier}</span>
                </div>
                <div className="grid grid-cols-4 gap-x-2 gap-y-1 text-[10px] pl-2">
                  <div><span className="text-slate-500">IAS </span><span className="text-slate-100 tabular-nums">{r.iasKts.toFixed(0)}kt</span></div>
                  <div><span className="text-slate-500">M </span><span className="text-slate-100 tabular-nums">{r.mach.toFixed(3)}</span></div>
                  <div><span className="text-slate-500">FL </span><span className="text-slate-100 tabular-nums">{(r.alt/100).toFixed(0)}</span></div>
                  <div><span className="text-slate-500">TAS </span><span className="text-slate-100 tabular-nums">{r.tasKts.toFixed(0)}kt</span></div>
                  <div className="col-span-2"><span className="text-slate-500">LIM </span><span style={{color: r.iasKts > r.activeLimitKts ? TIER_COLOR.EXCEED : '#cbd5e1'}}>{r.activeLimitName} {r.activeLimitKts.toFixed(0)}kt</span> <span className="text-slate-500">Δ </span><span style={{color: r.iasKts - r.activeLimitKts > 0 ? TIER_COLOR.EXCEED : '#10b981'}} className="tabular-nums">{(r.iasKts - r.activeLimitKts).toFixed(0)}kt</span></div>
                  <div><span className="text-slate-500">Va </span><span style={{color: r.iasKts > r.env.vaKts ? TIER_COLOR.CAUTION : '#cbd5e1'}} className="tabular-nums">{r.env.vaKts}</span></div>
                  <div><span className="text-slate-500">Vs× </span><span style={{color: r.vsRatio < 1.15 ? TIER_COLOR.EXCEED : r.vsRatio < 1.3 ? TIER_COLOR.CAUTION : '#10b981'}} className="tabular-nums">{r.vsRatio.toFixed(2)}</span></div>
                </div>
                <div className="mt-1.5 pl-2">
                  <div className="w-full bg-slate-900/60 rounded h-1 overflow-hidden">
                    <div className="h-full" style={{width:`${Math.round(r.score)}%`, background: TIER_COLOR[r.tier]}}></div>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {(Object.entries(r.drivers) as [keyof typeof r.drivers, number][]).map(([k,v]) => (
                      <span key={k} className="text-[8.5px] px-1 py-px rounded bg-slate-900/60 text-slate-400 border border-slate-800/60">
                        {k} <span className="tabular-nums text-slate-200">{v.toFixed(0)}</span>
                      </span>
                    ))}
                  </div>
                  {r.tier === 'EXCEED' && <div className="text-[10px] mt-1.5 text-rose-300/90 italic">REDUCE thrust + extend speed-brake — restore below {r.activeLimitName} per FCOM Vol.I §1.10 / §25.253 overspeed recovery</div>}
                  {r.tier === 'WARN' && <div className="text-[10px] mt-1.5 text-rose-300/80 italic">Approaching {r.activeLimitName} — verify A/T target speed and Mach mode crossover at {r.env.crossoverFt} ft</div>}
                  {r.tier === 'CAUTION' && r.drivers.REG > 30 && <div className="text-[10px] mt-1.5 text-amber-300/80 italic">§91.117 250-KIAS below 10k bust — slow to 250 unless ATC-authorised</div>}
                  {r.tier === 'CAUTION' && r.drivers.VAS > 30 && <div className="text-[10px] mt-1.5 text-amber-300/80 italic">Above Va — pilot manoeuvring guarantee §25.143 not assured, reduce in turbulence per FCOM rough-air</div>}
                </div>
              </button>
            ))}
          </div>
        )}

        {tab === 'FAMILY' && (
          <div className="divide-y divide-slate-800/60">
            {(() => {
              const groups = new Map<string, Row[]>()
              rows.forEach(r => {
                const k = r.f.type?.toUpperCase() || 'UNK'
                if (!groups.has(k)) groups.set(k, [])
                groups.get(k)!.push(r)
              })
              const arr = Array.from(groups.entries()).map(([type, rs]) => ({
                type, rs, mean: rs.reduce((a,b)=>a+b.score,0)/rs.length, worst: rs.reduce((a,b)=>Math.min(a, TIER_RANK[b.tier]), 5),
              })).sort((a,b) => a.worst - b.worst || b.mean - a.mean)
              return arr.map(g => {
                const env = envFor(g.type)
                const worstTier = TIER_ORDER[g.worst] || 'OK'
                return (
                  <div key={g.type} className="px-3 py-2" style={{borderLeft:`3px solid ${TIER_COLOR[worstTier]}`}}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-sky-300 text-[11px]">{g.type}</span>
                      <span className="text-[9px] px-1 py-px rounded bg-slate-800/70" style={{color: KLASS_COLOR[env.klass]}}>{env.klass}</span>
                      <span className="text-[10px] text-slate-500 italic">{env.family}</span>
                      <span className="ml-auto text-[10px] text-slate-400 tabular-nums">n={g.rs.length}</span>
                    </div>
                    <div className="grid grid-cols-4 gap-x-2 text-[10px]">
                      <div><span className="text-slate-500">Vmo </span><span className="text-slate-100 tabular-nums">{env.vmoKts}kt</span></div>
                      <div><span className="text-slate-500">Mmo </span><span className="text-slate-100 tabular-nums">{env.mmo.toFixed(3)}</span></div>
                      <div><span className="text-slate-500">Va </span><span className="text-slate-100 tabular-nums">{env.vaKts}kt</span></div>
                      <div><span className="text-slate-500">X-FL </span><span className="text-slate-100 tabular-nums">{(env.crossoverFt/100).toFixed(0)}</span></div>
                    </div>
                    <div className="w-full bg-slate-900/60 rounded h-1 overflow-hidden mt-1.5">
                      <div className="h-full" style={{width:`${Math.round(g.mean)}%`, background: TIER_COLOR[worstTier]}}></div>
                    </div>
                  </div>
                )
              })
            })()}
          </div>
        )}

        {tab === 'ENVELOPE' && (
          <div className="divide-y divide-slate-800/60">
            {Object.entries(ENV_TABLE).sort((a,b)=>a[0].localeCompare(b[0])).map(([t, env]) => (
              <div key={t} className="px-3 py-1.5 text-[10px] flex items-center gap-2">
                <span className="font-mono text-sky-300 w-12">{t}</span>
                <span className="px-1 py-px rounded bg-slate-800/70 text-[9px]" style={{color: KLASS_COLOR[env.klass]}}>{env.klass}</span>
                <span className="text-slate-500 italic flex-1 truncate">{env.family}</span>
                <span className="tabular-nums text-slate-200">Vmo {env.vmoKts}</span>
                <span className="tabular-nums text-slate-200">Mmo {env.mmo.toFixed(2)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800/60 text-[9px] text-slate-500 italic">
        14 CFR §25.1505 Vmo/Mmo · §25.143 Va · §25.253 overspeed · §91.117 250/10k · CS-25 / Doc 9760 · FCOM/AOM per family
      </div>
    </div>
  )
}
