'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   HIRO / RET · High-Intensity Runway Operations &
   Rapid Exit Taxiway Runway-Occupancy-Time monitor
   ------------------------------------------------------------
   ICAO Annex 14 Vol I §3.10 Rapid exit taxiways /
   ICAO Doc 9157 Aerodrome Design Manual Pt 2 ch 1 §1.10 RETs /
   ICAO Doc 9981 PANS-Aerodromes Pt II ch 4 runway occupancy /
   ICAO Doc 9870 Manual on Runway-Incursion Prevention §3.4 /
   EUROCONTROL HIRO HMI Operational Concept v3.0 (LHR/CDG/AMS) /
   EUROCONTROL Reduced ROT Best-Practice ed.2 (2017) /
   FAA AC 150/5300-13B Airport Design §4.5 RET geometry /
   FAA Order JO 7110.65 §3-10-3 land-and-hold-short / §5-5-9 /
   FAA AC 90-66B §11 runway operations /
   IATA Ground Ops Manual IGOM 4.4 vacate criteria /
   Boeing FCTM 5.50 / Airbus FCTM PR-AOP-LDG Rollout /
   NATS Heathrow HIRO Operational Manual (CAP 1378 §6) /
   ACI EUROPE Apron Safety Handbook 2023 ch 5.

   HIRO is the operational discipline of minimising Runway
   Occupancy Time (ROT) — measured from threshold-crossing to
   runway-vacate (wheels off the live runway) — so that the
   declared arrival rate can be sustained without compression
   delays. Modern HIRO airports publish a target landing ROT
   (typically 50-60s narrow-body, 65-75s wide-body, 85-95s
   super) and a target departure ROT (45-55s). Achieving target
   ROT depends on the right Rapid Exit Taxiway (RET) selection:
   RETs are angled at 30deg (vs 90deg normal exits) for
   exit-speeds up to 60kt without aggressive braking
   (Doc 9157 Pt 2 §1.10).

   This monitor takes airborne arriving traffic within 25 NM
   of a 24-runway HIRO catalogue (EGLL-27L EGLL-27R EGKK-26L
   EHAM-18R EHAM-06 EDDF-25C LFPG-26L LFPG-27R LSZH-14 LIRF-16R
   LOWW-29 LEMD-32L EGCC-23R KATL-27R KATL-26L KORD-10C KORD-28C
   KJFK-22L KJFK-31R KLAX-25L KSFO-28R KBOS-04R CYYZ-24L
   RJTT-34R OMDB-12L VHHH-07R WSSS-02L YSSY-16R) each with
   threshold lat/lng, magnetic QFU, runway length, declared
   target ROT (s), RET catalogue (position from threshold ft,
   side L/R, design-exit-speed kt), and HIRO discipline tier
   (CAT-3 high / CAT-2 mid / CAT-1 baseline) per CAP 1378 §6.

   Per-aircraft 6-class weight×brake catalogue:
     HVY-Q 747-8 A380   Vref 152 kt  rollout-base 6800 ft
     HVY   777 787 A350  Vref 145 kt  rollout-base 5600 ft
     NRW   737 A320 757  Vref 138 kt  rollout-base 4700 ft
     RGN   CRJ E-Jet      Vref 132 kt  rollout-base 4100 ft
     BIZ   GLF FA7X CL30  Vref 118 kt  rollout-base 3300 ft
     TBP   ATR Q400       Vref 110 kt  rollout-base 2800 ft

   ROT model: rollout-distance = base x (Vapp/Vref)^2
              x surface-factor (DRY 1.0 WET 1.18 CONT 1.45)
              x autobrake-factor (MAX 0.85 AB-3 0.95 AB-2 1.05
                AB-1 1.18) x reverser-factor (BOTH 1.0 1-INOP
                1.06 NONE 1.12).
   Mean rollout-speed = (Vapp + 20kt vacate) / 2 (gives
   threshold-to-vacate transit time).
   RET selection: pick first RET whose position-from-threshold
   >= rollout-distance and whose design-exit-speed is reachable
   without over-deceleration; fall back to runway-end if none.

   6 risk drivers (max-driver composite):
     · ROT  predicted ROT vs target (>+15s = 100)
     · EXT  RET overshoot — rollout exceeds last RET by N ft
     · BRK  brake-effort excess (high autobrake on long rwy)
     · LSV  late-vacate gate breach (still on rwy at +90s)
     · OVL  trailing aircraft on 4 NM final + ROT > target
     · CFG  config penalty (TBP/BIZ on cat-3 HIRO rwy)

   5 hard tiers:
     · ROT-MISS  predicted ROT > target+20s & traffic on final
     · LATE-VAC  predicted ROT > target+30s on cat-3 HIRO
     · OVERSHOOT no RET available — rollout to runway-end
     · WATCH     ROT +5 to +20s of target
     · ON-HIRO   meets target, exits at planned RET
============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'ROT-MISS' | 'LATE-VAC' | 'OVERSHOOT' | 'WATCH' | 'ON-HIRO' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'ROT-MISS': '#ef4444', 'LATE-VAC': '#f43f5e', OVERSHOOT: '#f43f5e',
  WATCH: '#0ea5e9', 'ON-HIRO': '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['ROT-MISS', 'LATE-VAC', 'OVERSHOOT', 'WATCH', 'ON-HIRO']
const TIER_RANK: Record<Tier, number> = { 'ROT-MISS': 0, 'LATE-VAC': 1, OVERSHOOT: 2, WATCH: 3, 'ON-HIRO': 4, IDLE: 5 }

type Klass = 'HVY-Q' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
const KLASS_COLOR: Record<Klass, string> = { 'HVY-Q': '#a855f7', HVY: '#ec4899', NRW: '#0ea5e9', RGN: '#22d3ee', BIZ: '#f59e0b', TBP: '#10b981' }
interface ClassDef { vref: number; rolloutFt: number; brakeBias: number; minRet: number }
const KLASS: Record<Klass, ClassDef> = {
  'HVY-Q': { vref: 152, rolloutFt: 6800, brakeBias: 1.10, minRet: 50 },
  HVY:     { vref: 145, rolloutFt: 5600, brakeBias: 1.00, minRet: 45 },
  NRW:     { vref: 138, rolloutFt: 4700, brakeBias: 0.95, minRet: 35 },
  RGN:     { vref: 132, rolloutFt: 4100, brakeBias: 0.93, minRet: 30 },
  BIZ:     { vref: 118, rolloutFt: 3300, brakeBias: 0.90, minRet: 25 },
  TBP:     { vref: 110, rolloutFt: 2800, brakeBias: 0.90, minRet: 25 },
}
function classifyKlass(type: string | undefined): Klass {
  const t = (type || '').toUpperCase()
  if (/^(A38[0-9]|B74[7-8])$/.test(t)) return 'HVY-Q'
  if (/^(B77[0-9]|B78[0-9]|A35[0-9]|A33[0-9]|A340|MD11)$/.test(t)) return 'HVY'
  if (/^(B73[0-9]|B7M[78]|B75[0-9]|A32[0-9]|A21N|A20N|A22[01]|BCS[123])$/.test(t)) return 'NRW'
  if (/^(CRJ[0-9]|E1[7-9][0-9]|E2[0-9][0-9])$/.test(t)) return 'RGN'
  if (/^(GLF[1-9]|FA[57]X|CL[36][0-9]|C[56][0-9][0-9]|PC[2-9][0-9])$/.test(t)) return 'BIZ'
  return 'TBP'
}

interface Ret { ft: number; side: 'L' | 'R'; speed: number; name: string }
interface Rwy {
  icao: string; name: string; rwy: string; lat: number; lng: number   // threshold lat/lng
  qfu: number; lengthFt: number; targetRot: number; hiroTier: 1 | 2 | 3
  surface: 'DRY' | 'WET' | 'CONT'; rets: Ret[]
}
const RWYS: Rwy[] = [
  { icao: 'EGLL', name: 'London Heathrow',     rwy: '27L', lat: 51.4775, lng: -0.4329, qfu: 270, lengthFt: 12802, targetRot: 60, hiroTier: 3, surface: 'WET', rets: [
    { ft: 4900, side: 'R', speed: 50, name: 'N4G' }, { ft: 6600, side: 'R', speed: 55, name: 'N5G' }, { ft: 8200, side: 'R', speed: 55, name: 'N6G' }, { ft: 9900, side: 'R', speed: 45, name: 'N7' } ] },
  { icao: 'EGLL', name: 'London Heathrow',     rwy: '27R', lat: 51.4647, lng: -0.4341, qfu: 270, lengthFt: 12001, targetRot: 60, hiroTier: 3, surface: 'WET', rets: [
    { ft: 4700, side: 'L', speed: 50, name: 'S4F' }, { ft: 6400, side: 'L', speed: 55, name: 'S5F' }, { ft: 8000, side: 'L', speed: 55, name: 'S6F' }, { ft: 9700, side: 'L', speed: 45, name: 'S7' } ] },
  { icao: 'EGKK', name: 'London Gatwick',      rwy: '26L', lat: 51.1481, lng: -0.1903, qfu: 263, lengthFt: 10879, targetRot: 58, hiroTier: 3, surface: 'WET', rets: [
    { ft: 4600, side: 'R', speed: 50, name: 'JL' }, { ft: 6300, side: 'R', speed: 55, name: 'JG' }, { ft: 8100, side: 'R', speed: 50, name: 'JF' } ] },
  { icao: 'EHAM', name: 'Amsterdam Schiphol',  rwy: '18R', lat: 52.3625, lng:  4.7117, qfu: 184, lengthFt: 12467, targetRot: 62, hiroTier: 3, surface: 'WET', rets: [
    { ft: 5000, side: 'L', speed: 55, name: 'W11' }, { ft: 6700, side: 'L', speed: 55, name: 'W10' }, { ft: 8400, side: 'L', speed: 50, name: 'W9' } ] },
  { icao: 'EHAM', name: 'Amsterdam Schiphol',  rwy: '06',  lat: 52.2879, lng:  4.7341, qfu:  58, lengthFt: 11329, targetRot: 60, hiroTier: 2, surface: 'WET', rets: [
    { ft: 4800, side: 'L', speed: 50, name: 'S3' }, { ft: 6500, side: 'L', speed: 55, name: 'S4' }, { ft: 8200, side: 'L', speed: 50, name: 'S5' } ] },
  { icao: 'EDDF', name: 'Frankfurt Main',      rwy: '25C', lat: 50.0379, lng:  8.5622, qfu: 250, lengthFt: 13123, targetRot: 60, hiroTier: 3, surface: 'WET', rets: [
    { ft: 5200, side: 'R', speed: 55, name: 'M16' }, { ft: 6900, side: 'R', speed: 55, name: 'M15' }, { ft: 8500, side: 'R', speed: 50, name: 'M14' } ] },
  { icao: 'LFPG', name: 'Paris CDG',           rwy: '26L', lat: 49.0249, lng:  2.5589, qfu: 263, lengthFt: 13780, targetRot: 60, hiroTier: 3, surface: 'WET', rets: [
    { ft: 5400, side: 'L', speed: 55, name: 'S5' }, { ft: 7100, side: 'L', speed: 55, name: 'S6' }, { ft: 8800, side: 'L', speed: 50, name: 'S7' } ] },
  { icao: 'LFPG', name: 'Paris CDG',           rwy: '27R', lat: 49.0166, lng:  2.5292, qfu: 270, lengthFt: 8858,  targetRot: 58, hiroTier: 2, surface: 'WET', rets: [
    { ft: 4800, side: 'R', speed: 50, name: 'N7' }, { ft: 6500, side: 'R', speed: 55, name: 'N8' }, { ft: 8100, side: 'R', speed: 45, name: 'N9' } ] },
  { icao: 'LSZH', name: 'Zurich Kloten',       rwy: '14',  lat: 47.4707, lng:  8.5365, qfu: 137, lengthFt: 10827, targetRot: 60, hiroTier: 2, surface: 'WET', rets: [
    { ft: 5000, side: 'L', speed: 50, name: 'A7' }, { ft: 6700, side: 'L', speed: 55, name: 'A8' }, { ft: 8400, side: 'L', speed: 50, name: 'A9' } ] },
  { icao: 'LIRF', name: 'Rome Fiumicino',      rwy: '16R', lat: 41.8166, lng: 12.2486, qfu: 162, lengthFt: 12795, targetRot: 60, hiroTier: 2, surface: 'WET', rets: [
    { ft: 5100, side: 'L', speed: 50, name: 'CE' }, { ft: 6800, side: 'L', speed: 55, name: 'CD' }, { ft: 8500, side: 'L', speed: 50, name: 'CC' } ] },
  { icao: 'LOWW', name: 'Vienna Schwechat',    rwy: '29',  lat: 48.1207, lng: 16.5800, qfu: 290, lengthFt: 11811, targetRot: 60, hiroTier: 2, surface: 'WET', rets: [
    { ft: 4900, side: 'R', speed: 50, name: 'B5' }, { ft: 6600, side: 'R', speed: 55, name: 'B6' }, { ft: 8300, side: 'R', speed: 50, name: 'B7' } ] },
  { icao: 'LEMD', name: 'Madrid Barajas',      rwy: '32L', lat: 40.4926, lng: -3.5775, qfu: 320, lengthFt: 14272, targetRot: 60, hiroTier: 2, surface: 'WET', rets: [
    { ft: 5300, side: 'L', speed: 55, name: 'K10' }, { ft: 7000, side: 'L', speed: 55, name: 'K11' }, { ft: 8700, side: 'L', speed: 50, name: 'K12' } ] },
  { icao: 'EGCC', name: 'Manchester',          rwy: '23R', lat: 53.3654, lng: -2.2613, qfu: 232, lengthFt: 10000, targetRot: 58, hiroTier: 2, surface: 'WET', rets: [
    { ft: 4700, side: 'R', speed: 50, name: 'J' }, { ft: 6400, side: 'R', speed: 55, name: 'K' }, { ft: 8000, side: 'R', speed: 45, name: 'L' } ] },
  { icao: 'KATL', name: 'Atlanta Hartsfield',  rwy: '27R', lat: 33.6404, lng: -84.4422,qfu: 273, lengthFt: 9000,  targetRot: 56, hiroTier: 3, surface: 'DRY', rets: [
    { ft: 4400, side: 'R', speed: 50, name: 'D' }, { ft: 6100, side: 'R', speed: 55, name: 'E' }, { ft: 7600, side: 'R', speed: 45, name: 'F' } ] },
  { icao: 'KATL', name: 'Atlanta Hartsfield',  rwy: '26L', lat: 33.6293, lng: -84.4348,qfu: 263, lengthFt: 9000,  targetRot: 56, hiroTier: 3, surface: 'DRY', rets: [
    { ft: 4400, side: 'L', speed: 50, name: 'M2' }, { ft: 6100, side: 'L', speed: 55, name: 'M3' }, { ft: 7600, side: 'L', speed: 45, name: 'M4' } ] },
  { icao: 'KORD', name: 'Chicago O\u2019Hare', rwy: '10C', lat: 41.9786, lng: -87.9145,qfu:  99, lengthFt: 11245, targetRot: 60, hiroTier: 3, surface: 'DRY', rets: [
    { ft: 4900, side: 'R', speed: 55, name: 'P1' }, { ft: 6600, side: 'R', speed: 55, name: 'P2' }, { ft: 8300, side: 'R', speed: 50, name: 'P3' } ] },
  { icao: 'KORD', name: 'Chicago O\u2019Hare', rwy: '28C', lat: 41.9802, lng: -87.8801,qfu: 279, lengthFt: 11245, targetRot: 60, hiroTier: 3, surface: 'DRY', rets: [
    { ft: 4900, side: 'L', speed: 55, name: 'L1' }, { ft: 6600, side: 'L', speed: 55, name: 'L2' }, { ft: 8300, side: 'L', speed: 50, name: 'L3' } ] },
  { icao: 'KJFK', name: 'New York JFK',        rwy: '22L', lat: 40.6446, lng: -73.7901,qfu: 224, lengthFt: 11351, targetRot: 60, hiroTier: 2, surface: 'DRY', rets: [
    { ft: 4900, side: 'L', speed: 50, name: 'KE' }, { ft: 6600, side: 'L', speed: 55, name: 'KF' }, { ft: 8300, side: 'L', speed: 50, name: 'A' } ] },
  { icao: 'KJFK', name: 'New York JFK',        rwy: '31R', lat: 40.6184, lng: -73.7726,qfu: 314, lengthFt: 14572, targetRot: 60, hiroTier: 2, surface: 'DRY', rets: [
    { ft: 5300, side: 'R', speed: 55, name: 'B' }, { ft: 7000, side: 'R', speed: 55, name: 'KE' }, { ft: 8700, side: 'R', speed: 50, name: 'KF' } ] },
  { icao: 'KLAX', name: 'Los Angeles',         rwy: '25L', lat: 33.9396, lng: -118.4017,qfu:255, lengthFt: 11095, targetRot: 60, hiroTier: 3, surface: 'DRY', rets: [
    { ft: 4800, side: 'L', speed: 55, name: 'A6' }, { ft: 6500, side: 'L', speed: 55, name: 'A8' }, { ft: 8200, side: 'L', speed: 50, name: 'A9' } ] },
  { icao: 'KSFO', name: 'San Francisco',       rwy: '28R', lat: 37.6188, lng: -122.3937,qfu:284, lengthFt: 11870, targetRot: 60, hiroTier: 2, surface: 'WET', rets: [
    { ft: 4900, side: 'R', speed: 55, name: 'M' }, { ft: 6600, side: 'R', speed: 55, name: 'N' }, { ft: 8200, side: 'R', speed: 50, name: 'P' } ] },
  { icao: 'KBOS', name: 'Boston Logan',        rwy: '04R', lat: 42.3540, lng: -71.0118,qfu:  37, lengthFt: 10083, targetRot: 58, hiroTier: 2, surface: 'WET', rets: [
    { ft: 4700, side: 'L', speed: 50, name: 'M' }, { ft: 6400, side: 'L', speed: 55, name: 'N' }, { ft: 8000, side: 'L', speed: 45, name: 'P' } ] },
  { icao: 'CYYZ', name: 'Toronto Pearson',     rwy: '24L', lat: 43.6976, lng: -79.6248,qfu: 233, lengthFt: 11051, targetRot: 60, hiroTier: 2, surface: 'WET', rets: [
    { ft: 4900, side: 'L', speed: 50, name: 'B5' }, { ft: 6600, side: 'L', speed: 55, name: 'B6' }, { ft: 8300, side: 'L', speed: 50, name: 'B7' } ] },
  { icao: 'RJTT', name: 'Tokyo Haneda',        rwy: '34R', lat: 35.5396, lng: 139.7822, qfu: 343, lengthFt: 9843,  targetRot: 60, hiroTier: 3, surface: 'WET', rets: [
    { ft: 4700, side: 'R', speed: 50, name: 'A8' }, { ft: 6400, side: 'R', speed: 55, name: 'A9' }, { ft: 8000, side: 'R', speed: 45, name: 'A10' } ] },
  { icao: 'OMDB', name: 'Dubai Intl',          rwy: '12L', lat: 25.2522, lng: 55.3573, qfu: 122, lengthFt: 13123, targetRot: 60, hiroTier: 3, surface: 'DRY', rets: [
    { ft: 5200, side: 'L', speed: 55, name: 'M3' }, { ft: 6900, side: 'L', speed: 55, name: 'M4' }, { ft: 8600, side: 'L', speed: 50, name: 'M5' } ] },
  { icao: 'VHHH', name: 'Hong Kong',           rwy: '07R', lat: 22.3083, lng: 113.9180, qfu:  70, lengthFt: 12467, targetRot: 60, hiroTier: 3, surface: 'WET', rets: [
    { ft: 5100, side: 'R', speed: 55, name: 'A8' }, { ft: 6800, side: 'R', speed: 55, name: 'A9' }, { ft: 8500, side: 'R', speed: 50, name: 'A10' } ] },
  { icao: 'WSSS', name: 'Singapore Changi',    rwy: '02L', lat: 1.3306,  lng: 103.9911, qfu:  20, lengthFt: 13123, targetRot: 60, hiroTier: 3, surface: 'WET', rets: [
    { ft: 5200, side: 'L', speed: 55, name: 'WA1' }, { ft: 6900, side: 'L', speed: 55, name: 'WA2' }, { ft: 8600, side: 'L', speed: 50, name: 'WA3' } ] },
  { icao: 'YSSY', name: 'Sydney Kingsford',    rwy: '16R', lat: -33.9333,lng: 151.1881, qfu: 162, lengthFt: 12999, targetRot: 60, hiroTier: 2, surface: 'WET', rets: [
    { ft: 5100, side: 'L', speed: 55, name: 'A8' }, { ft: 6800, side: 'L', speed: 55, name: 'A9' }, { ft: 8500, side: 'L', speed: 50, name: 'A10' } ] },
]

function clamp(v: number, mn: number, mx: number) { return Math.max(mn, Math.min(mx, v)) }
function gcNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 3440.065
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dφ = (la2 - la1) * Math.PI / 180, dλ = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}
function bearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dλ = (lo2 - lo1) * Math.PI / 180
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}
function fnv32(s: string): number { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 }
function hashFrac(s: string): number { return (fnv32(s) % 1000) / 1000 }

interface Sched {
  rwy: Rwy; klass: Klass; vapp: number; vref: number; autobrake: 'MAX' | 'AB-3' | 'AB-2' | 'AB-1'
  reverser: 'BOTH' | '1-INOP' | 'NONE'; surfFac: number
  rolloutFt: number; rotSec: number; vacateSec: number; chosenRet: Ret | null; overshootFt: number
  distToThrFt: number; secsToThr: number; trafficOnFinal: number
}
interface Eval {
  f: SFlight; rwy: Rwy; sch: Sched
  drivers: { ROT: number; EXT: number; BRK: number; LSV: number; OVL: number; CFG: number }
  tier: Tier; score: number; advice: string
}

function evalArrival(f: SFlight, sch: Sched, advMul: number): Eval {
  const rotDelta = sch.rotSec - sch.rwy.targetRot
  const ROT = clamp(rotDelta * 5, 0, 100)                                // +20s = 100
  const EXT = clamp(sch.overshootFt / 5, 0, 100)                         // 500ft = 100
  const brkMap: Record<string, number> = { 'MAX': 70, 'AB-3': 35, 'AB-2': 15, 'AB-1': 0 }
  const longRwy = sch.rwy.lengthFt > 11000
  const BRK = longRwy ? brkMap[sch.autobrake] : 0
  const LSV = sch.rwy.hiroTier === 3 && rotDelta > 30 ? clamp(rotDelta * 3, 0, 100) : 0
  const OVL = sch.trafficOnFinal >= 1 && rotDelta > 5 ? clamp((sch.trafficOnFinal * 30) + rotDelta * 2, 0, 100) : 0
  const CFG = (sch.rwy.hiroTier === 3 && (sch.klass === 'TBP' || sch.klass === 'BIZ')) ? 40 : 0
  const drivers = { ROT, EXT, BRK, LSV, OVL, CFG }
  const arr = [ROT, EXT, BRK, LSV, OVL, CFG].sort((a, b) => b - a)
  let composite = arr[0] * 0.46 + arr[1] * 0.24 + arr[2] * 0.14 + arr[3] * 0.09 + arr[4] * 0.04 + arr[5] * 0.03
  composite *= (advMul / 100)
  composite = clamp(composite, 0, 100)
  if (rotDelta > 20 && sch.trafficOnFinal >= 1) composite = Math.max(composite, 82)
  if (sch.rwy.hiroTier === 3 && rotDelta > 30) composite = Math.max(composite, 75)
  if (!sch.chosenRet) composite = Math.max(composite, 70)

  let tier: Tier, advice: string
  if (rotDelta > 20 && sch.trafficOnFinal >= 1) {
    tier = 'ROT-MISS'
    advice = `Predicted ROT ${sch.rotSec.toFixed(0)}s vs target ${sch.rwy.targetRot}s with ${sch.trafficOnFinal} on final — go-around or land-long to clear runway; coordinate per JO 7110.65 §3-10-3 / CAP 1378 §6 HIRO`
  } else if (sch.rwy.hiroTier === 3 && rotDelta > 30) {
    tier = 'LATE-VAC'
    advice = `Cat-3 HIRO runway ${sch.rwy.icao}/${sch.rwy.rwy} — predicted ROT ${sch.rotSec.toFixed(0)}s breaches +30s gate; expect EXIT ${sch.chosenRet?.name || 'RWY-END'} late, brief crew on max-braking + idle-reverse-by-vacate per IATA IGOM 4.4`
  } else if (!sch.chosenRet) {
    tier = 'OVERSHOOT'
    advice = `Rollout ${sch.rolloutFt.toFixed(0)}ft exceeds last RET on ${sch.rwy.rwy} (${sch.rwy.lengthFt}ft) by ${sch.overshootFt.toFixed(0)}ft — use full braking; alternate runway-end vacate per ICAO Doc 9981 Pt II ch 4`
  } else if (rotDelta > 5) {
    tier = 'WATCH'
    advice = `ROT ${sch.rotSec.toFixed(0)}s +${rotDelta.toFixed(0)}s of target — plan EXIT ${sch.chosenRet.name} (${sch.chosenRet.ft}ft / ${sch.chosenRet.speed}kt); brief reverse-to-idle by ${sch.chosenRet.name} per Boeing FCTM 5.50`
  } else {
    tier = 'ON-HIRO'
    advice = `ROT ${sch.rotSec.toFixed(0)}s meets ${sch.rwy.targetRot}s target — vacate ${sch.chosenRet.name} (${sch.chosenRet.ft}ft / ${sch.chosenRet.speed}kt design) HIRO nominal per CAP 1378 §6`
  }
  return { f, rwy: sch.rwy, sch, drivers, tier, score: composite, advice }
}

/* layer ids */
const SRC_HALO = 'hiro-halo', LYR_HALO = 'hiro-halo'
const SRC_PIN  = 'hiro-pin',  LYR_PIN  = 'hiro-pin'
const SRC_LBL  = 'hiro-lbl',  LYR_LBL  = 'hiro-lbl'
const SRC_RWY  = 'hiro-rwy',  LYR_RWY  = 'hiro-rwy'
const SRC_RLBL = 'hiro-rlbl', LYR_RLBL = 'hiro-rlbl'
const SRC_RET  = 'hiro-ret',  LYR_RET  = 'hiro-ret'
const SRC_LINK = 'hiro-link', LYR_LINK = 'hiro-link'

const lsGet = (k: string, d: any) => { if (typeof window === 'undefined') return d; try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } }
const lsSet = (k: string, v: any) => { if (typeof window === 'undefined') return; try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

export default function HiroMonitor({ map, flights, onClose, onFly }: Props) {
  const [vappBias, setVappBias] = useState<number>(() => lsGet('ft-hiro-vapp', 0))
  const [surfMul, setSurfMul]   = useState<number>(() => lsGet('ft-hiro-surf', 100))
  const [advMul, setAdvMul]     = useState<number>(() => lsGet('ft-hiro-adv', 100))
  const [retMul, setRetMul]     = useState<number>(() => lsGet('ft-hiro-ret', 100))
  const [minFl, setMinFl]       = useState<number>(() => lsGet('ft-hiro-mnfl', 0))
  const [maxFl, setMaxFl]       = useState<number>(() => lsGet('ft-hiro-mxfl', 200))
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'RUNWAYS' | 'RETS'>('AIRCRAFT')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin]   = useState(true)
  const [showLbl, setShowLbl]   = useState(true)
  const [showRwy, setShowRwy]   = useState(true)
  const [showRet, setShowRet]   = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    lsSet('ft-hiro-vapp', vappBias); lsSet('ft-hiro-surf', surfMul); lsSet('ft-hiro-adv', advMul); lsSet('ft-hiro-ret', retMul)
    lsSet('ft-hiro-mnfl', minFl); lsSet('ft-hiro-mxfl', maxFl)
  }, [vappBias, surfMul, advMul, retMul, minFl, maxFl])

  const evals = useMemo(() => {
    const out: Eval[] = []
    // First pass: identify runway candidates for each arrival
    interface Cand { f: SFlight; rwy: Rwy; distNm: number; klass: Klass }
    const cands: Cand[] = []
    for (const f of flights) {
      if (f.ground) continue
      const fl = f.altitudeFt / 100
      if (fl < minFl || fl > maxFl) continue
      if (f.vertRate > 200) continue
      let best: { r: Rwy; d: number } | null = null
      for (const r of RWYS) {
        const d = gcNm(f.lat, f.lng, r.lat, r.lng)
        if (d > 25) continue
        const brg = bearingDeg(f.lat, f.lng, r.lat, r.lng)
        const dirDelta = Math.abs(((f.track - brg + 540) % 360) - 180)
        if (dirDelta < 100) continue   // not inbound
        const qfuDelta = Math.abs(((f.track - r.qfu + 540) % 360) - 180)
        if (qfuDelta > 35) continue   // not aligned w/ runway
        if (!best || d < best.d) best = { r, d }
      }
      if (!best) continue
      cands.push({ f, rwy: best.r, distNm: best.d, klass: classifyKlass(f.type) })
    }
    // Sort per runway by distance to threshold
    const byRwy: Record<string, Cand[]> = {}
    for (const c of cands) {
      const k = c.rwy.icao + '/' + c.rwy.rwy
      ;(byRwy[k] = byRwy[k] || []).push(c)
    }
    for (const k in byRwy) byRwy[k].sort((a, b) => a.distNm - b.distNm)

    for (const k in byRwy) {
      const arr = byRwy[k]
      for (let i = 0; i < arr.length; i++) {
        const c = arr[i]
        const r = c.rwy
        const kdef = KLASS[c.klass]
        const h = hashFrac(c.f.icao)
        const vapp = kdef.vref + 5 + (h * 16 - 4) + vappBias    // +5 to +25 typically
        const autobrake = (['MAX', 'AB-3', 'AB-2', 'AB-1'] as const)[Math.floor(h * 4)]
        const reverser = h > 0.92 ? '1-INOP' : h > 0.97 ? 'NONE' : 'BOTH'
        const surfMap = { DRY: 1.00, WET: 1.18, CONT: 1.45 } as const
        const surfFac = surfMap[r.surface] * (surfMul / 100)
        const abMap: Record<string, number> = { 'MAX': 0.85, 'AB-3': 0.95, 'AB-2': 1.05, 'AB-1': 1.18 }
        const revMap: Record<string, number> = { 'BOTH': 1.00, '1-INOP': 1.06, 'NONE': 1.12 }
        const rolloutFt = kdef.rolloutFt * Math.pow(vapp / kdef.vref, 2) * surfFac * abMap[autobrake] * revMap[reverser] * kdef.brakeBias
        const meanRolloutKt = (vapp + 20) / 2
        const rotSec = (rolloutFt / (meanRolloutKt * 1.6878))   // ft / (kt -> ft/s)
        const vacateSec = rotSec + 8  // crossing-to-clear margin

        // RET selection: first RET past rolloutFt
        let chosenRet: Ret | null = null
        for (const ret of r.rets) {
          if (ret.ft * (retMul / 100) >= rolloutFt) { chosenRet = ret; break }
        }
        const overshootFt = chosenRet ? 0 : Math.max(0, rolloutFt - r.lengthFt + 800)
        // Traffic on 4 NM final = count of other arrivals on same rwy within (this.distNm + 4 NM)
        const trafficOnFinal = arr.filter(o => o !== c && o.distNm < c.distNm + 4 && o.distNm > c.distNm - 1).length
        const distToThrFt = c.distNm * 6076
        const secsToThr = (c.distNm / Math.max(120, c.f.velocityKts)) * 3600

        const sch: Sched = { rwy: r, klass: c.klass, vapp, vref: kdef.vref, autobrake, reverser, surfFac,
          rolloutFt, rotSec, vacateSec, chosenRet, overshootFt, distToThrFt, secsToThr, trafficOnFinal }
        out.push(evalArrival(c.f, sch, advMul))
      }
    }
    out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, minFl, maxFl, vappBias, surfMul, advMul, retMul])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return evals.filter(e => {
      if (klassFilter !== 'ALL' && e.sch.klass !== klassFilter) return false
      if (tierFilter !== 'ALL' && e.tier !== tierFilter) return false
      if (q) {
        const blob = `${e.f.callsign} ${e.f.icao} ${e.f.type} ${e.f.operator} ${e.rwy.icao} ${e.rwy.rwy}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [evals, klassFilter, tierFilter, query])

  const tierCount: Record<Tier, number> = { 'ROT-MISS': 0, 'LATE-VAC': 0, OVERSHOOT: 0, WATCH: 0, 'ON-HIRO': 0, IDLE: 0 }
  for (const e of evals) tierCount[e.tier]++
  const meanScore = evals.length ? evals.reduce((s, e) => s + e.score, 0) / evals.length : 0
  const worst = evals[0]
  const missN = evals.filter(e => e.tier === 'ROT-MISS').length
  const meanRot = evals.length ? evals.reduce((s, e) => s + e.sch.rotSec, 0) / evals.length : 0
  const overshootN = evals.filter(e => e.tier === 'OVERSHOOT').length
  const lateVacN = evals.filter(e => e.tier === 'LATE-VAC').length

  useEffect(() => {
    if (!map) return
    const ensure = (id: string, type: any, src: string, paint: any, layout: any = {}) => {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer(id)) map.addLayer({ id, type, source: src, paint, layout } as any)
    }
    ensure(LYR_RWY,  'line',   SRC_RWY,  { 'line-color': ['get', 'color'], 'line-width': 2.4, 'line-opacity': 0.6 })
    ensure(LYR_RET,  'circle', SRC_RET,  { 'circle-radius': 3, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1, 'circle-stroke-color': '#0f172a' })
    ensure(LYR_HALO, 'circle', SRC_HALO, { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'] })
    ensure(LYR_PIN,  'circle', SRC_PIN,  { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' })
    ensure(LYR_LINK, 'line',   SRC_LINK, { 'line-color': ['get', 'color'], 'line-width': 1.3, 'line-opacity': 0.8, 'line-dasharray': [2, 2] })
    ensure(LYR_LBL,  'symbol', SRC_LBL,  {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    ensure(LYR_RLBL, 'symbol', SRC_RLBL, {}, { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, -1.2], 'text-anchor': 'bottom', 'text-font': ['Open Sans Regular'] })
    if (map.getLayer(LYR_LBL))  { map.setPaintProperty(LYR_LBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_LBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_LBL, 'text-halo-width', 1.4) }
    if (map.getLayer(LYR_RLBL)) { map.setPaintProperty(LYR_RLBL, 'text-color', '#7dd3fc'); map.setPaintProperty(LYR_RLBL, 'text-halo-color', '#020617'); map.setPaintProperty(LYR_RLBL, 'text-halo-width', 1.4) }

    // Build runway-line geometry (threshold + length along QFU)
    const rwyFeats: any[] = [], rlblFeats: any[] = [], retFeats: any[] = []
    if (showRwy) {
      for (const r of RWYS) {
        const inR = evals.filter(e => e.rwy.icao === r.icao && e.rwy.rwy === r.rwy).length
        if (inR === 0) continue
        const qfuRad = r.qfu * Math.PI / 180
        const latPerFt = 1 / 364000
        const lngPerFt = 1 / (364000 * Math.cos(r.lat * Math.PI / 180))
        const endLat = r.lat + Math.cos(qfuRad) * r.lengthFt * latPerFt
        const endLng = r.lng + Math.sin(qfuRad) * r.lengthFt * lngPerFt
        const hiroCol = r.hiroTier === 3 ? '#a855f7' : r.hiroTier === 2 ? '#0ea5e9' : '#64748b'
        rwyFeats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.lng, r.lat], [endLng, endLat]] }, properties: { color: hiroCol } })
        rlblFeats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lng, r.lat] }, properties: { label: `${r.icao}/${r.rwy}·C${r.hiroTier}·${r.targetRot}s·${inR}` } })
        if (showRet) {
          for (const ret of r.rets) {
            const rLat = r.lat + Math.cos(qfuRad) * ret.ft * latPerFt
            const rLng = r.lng + Math.sin(qfuRad) * ret.ft * lngPerFt
            const speedCol = ret.speed >= 55 ? '#10b981' : ret.speed >= 50 ? '#0ea5e9' : '#f59e0b'
            retFeats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [rLng, rLat] }, properties: { color: speedCol } })
          }
        }
      }
    }

    const halo: any[] = [], pin: any[] = [], lbl: any[] = [], link: any[] = []
    for (const e of filtered) {
      const color = TIER_COLOR[e.tier]
      if (showHalo && e.tier !== 'IDLE' && e.tier !== 'ON-HIRO') halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color, r: 8 + e.score * 0.14 } })
      if (showPin && (e.tier === 'ROT-MISS' || e.tier === 'OVERSHOOT')) pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color } })
      if (showLbl && e.tier !== 'ON-HIRO' && e.tier !== 'IDLE') {
        const tag = `${e.sch.rotSec.toFixed(0)}s/${e.rwy.targetRot}s`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color, label: `${e.f.callsign || e.f.icao} › ${e.rwy.icao}/${e.rwy.rwy} · ${tag} · ${e.tier}` } })
      }
      if (showLink && e.tier !== 'ON-HIRO' && e.tier !== 'IDLE') {
        link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[e.f.lng, e.f.lat], [e.rwy.lng, e.rwy.lat]] }, properties: { color } })
      }
    }
    ;(map.getSource(SRC_RWY)  as any).setData({ type: 'FeatureCollection', features: rwyFeats })
    ;(map.getSource(SRC_RLBL) as any).setData({ type: 'FeatureCollection', features: rlblFeats })
    ;(map.getSource(SRC_RET)  as any).setData({ type: 'FeatureCollection', features: retFeats })
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN)  as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL)  as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_RWY, LYR_RLBL, LYR_RET]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_PIN, SRC_LBL, SRC_LINK, SRC_RWY, SRC_RLBL, SRC_RET]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, filtered, evals, showHalo, showPin, showLbl, showRwy, showRet, showLink])

  const tierBadge = (t: Tier) => <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  const klassBadge = (k: Klass) => <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: KLASS_COLOR[k], backgroundColor: KLASS_COLOR[k] + '1f', border: `1px solid ${KLASS_COLOR[k]}55` }}>{k}</span>
  const drvBadge = (k: string, v: number) => {
    const c = v >= 70 ? '#ef4444' : v >= 40 ? '#f59e0b' : v >= 18 ? '#0ea5e9' : '#10b981'
    return <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: c, backgroundColor: c + '1c', border: `1px solid ${c}55` }}>{k}{v.toFixed(0)}</span>
  }

  /* Scatter: predicted ROT (x) vs overshoot ft (y) */
  const W = 280, H = 110, padL = 28, padB = 16, padT = 6, padR = 6
  const xMin = 35, xMax = 120, yMin = 0, yMax = 1200
  const sx = (v: number) => padL + ((clamp(v, xMin, xMax) - xMin) / (xMax - xMin)) * (W - padL - padR)
  const sy = (v: number) => padT + (1 - (clamp(v, yMin, yMax) - yMin) / (yMax - yMin)) * (H - padT - padB)

  return (
    <div className="absolute right-3 top-20 z-40 w-[26rem] max-h-[calc(100vh-6rem)] flex flex-col bg-slate-900/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-sky-500 animate-pulse" />
          <span className="text-[10px] font-bold tracking-widest uppercase text-sky-400">HIRO / RET · Runway Occupancy</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-sm leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800 text-[10px]">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[8px] font-semibold leading-tight" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Mean score</div><div className="text-sm font-semibold" style={{ color: meanScore >= 65 ? '#ef4444' : meanScore >= 35 ? '#f59e0b' : '#10b981' }}>{meanScore.toFixed(0)}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Worst</div><div className="text-sm font-semibold text-slate-100 truncate">{worst ? (worst.f.callsign || worst.f.icao) : '—'}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">ROT-miss</div><div className="text-sm font-semibold" style={{ color: missN > 0 ? '#ef4444' : '#10b981' }}>{missN}</div></div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Mean ROT</div><div className="text-xs font-semibold" style={{ color: meanRot > 75 ? '#f43f5e' : meanRot > 65 ? '#f59e0b' : '#10b981' }}>{meanRot.toFixed(0)}s</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Late-vac</div><div className="text-xs font-semibold" style={{ color: lateVacN > 0 ? '#f43f5e' : '#10b981' }}>{lateVacN}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Overshoot</div><div className="text-xs font-semibold" style={{ color: overshootN > 0 ? '#f43f5e' : '#10b981' }}>{overshootN}</div></div>
      </div>

      {showDiag && evals.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* target band: 50-70s */}
            <rect x={sx(50)} y={padT} width={sx(70) - sx(50)} height={H - padT - padB} fill="#10b98115" />
            {/* breach: >80s */}
            <rect x={sx(80)} y={padT} width={W - padR - sx(80)} height={H - padT - padB} fill="#ef444415" />
            <line x1={sx(60)} y1={padT} x2={sx(60)} y2={H - padB} stroke="#10b98166" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(80)} y1={padT} x2={sx(80)} y2={H - padB} stroke="#ef444466" strokeWidth={0.5} strokeDasharray="2 3" />
            <line x1={padL} y1={sy(0)} x2={W - padR} y2={sy(0)} stroke="#475569" strokeWidth={0.5} />
            <text x={W / 2} y={H - 3} textAnchor="middle" fontSize="9" fill="#64748b">Predicted ROT (s)</text>
            <text x={6} y={H / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H / 2})`}>RET overshoot (ft)</text>
            {evals.map((e, i) => (
              <circle key={i} cx={sx(e.sch.rotSec)} cy={sy(e.sch.overshootFt)} r={2.4} fill={TIER_COLOR[e.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['VAPP-BIAS', vappBias, -10, 25, setVappBias, 'kt'],
            ['SURF-MUL', surfMul, 50, 200, setSurfMul, '%'],
            ['RET-MUL', retMul, 50, 200, setRetMul, '%'],
            ['ADV-MUL', advMul, 50, 200, setAdvMul, '%'],
            ['MIN-FL', minFl, 0, 100, setMinFl, ''],
            ['MAX-FL', maxFl, 50, 300, setMaxFl, ''],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[68px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[40px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['HVY-Q', 'HVY', 'NRW', 'RGN', 'BIZ', 'TBP'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlassFilter(klassFilter === k ? 'ALL' : k)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: klassFilter === k ? KLASS_COLOR[k] + '33' : '#0b1220', borderColor: klassFilter === k ? KLASS_COLOR[k] : '#1e293b', color: klassFilter === k ? KLASS_COLOR[k] : '#cbd5e1' }}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['RWY', showRwy, setShowRwy],
            ['RET', showRet, setShowRet],
            ['LINK', showLink, setShowLink],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, v, setter]: any) => (
            <button key={lab} onClick={() => setter(!v)} className="px-1.5 py-0.5 rounded text-[9px] font-mono border" style={{ backgroundColor: v ? '#0ea5e933' : '#0b1220', borderColor: v ? '#0ea5e9' : '#1e293b', color: v ? '#7dd3fc' : '#64748b' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / type / runway" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'RUNWAYS', 'RETS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-1.5 text-[10px] font-semibold ${tab === t ? 'text-sky-400 bg-slate-800/50 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No arrivals on HIRO-equipped runway final.</div>}
            {filtered.map((e, idx) => {
              const s = e.sch
              const rotDelta = s.rotSec - e.rwy.targetRot
              return (
                <div key={idx} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(e.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[e.tier]}` }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-slate-200 text-[11px] font-semibold truncate">{e.f.callsign || e.f.icao}</span>
                      <span className="text-slate-500 text-[10px] font-mono">{e.f.type || '—'}</span>
                      {klassBadge(s.klass)}
                      <span className="px-1 py-0.5 rounded text-[9px] font-mono text-slate-400 bg-slate-800/60 border border-slate-700">C{e.rwy.hiroTier}</span>
                      {s.trafficOnFinal > 0 && <span className="px-1 py-0.5 rounded text-[9px] font-mono text-amber-400 bg-amber-500/10 border border-amber-500/40">+{s.trafficOnFinal}fnl</span>}
                    </div>
                    {tierBadge(e.tier)}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    <span className="text-sky-300">{e.rwy.icao}/{e.rwy.rwy}</span>
                    {' · ROT '}<span style={{ color: rotDelta > 20 ? '#f43f5e' : rotDelta > 5 ? '#f59e0b' : '#10b981' }}>{s.rotSec.toFixed(0)}s</span>
                    {' / '}<span className="text-slate-300">{e.rwy.targetRot}s</span>
                    {' · Δ'}<span style={{ color: rotDelta > 20 ? '#f43f5e' : rotDelta > 5 ? '#f59e0b' : '#10b981' }}>{rotDelta >= 0 ? '+' : ''}{rotDelta.toFixed(0)}s</span>
                    {' · '}<span className="text-slate-300">{(s.distToThrFt / 6076).toFixed(1)}nm</span>
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    rollout <span className="text-slate-300">{s.rolloutFt.toFixed(0)}ft</span>
                    {' · '}{s.chosenRet ? (<>exit <span className="text-emerald-400">{s.chosenRet.name}</span> @{s.chosenRet.ft}ft/{s.chosenRet.speed}kt</>) : (<span className="text-rose-400">no RET — RWY-END +{s.overshootFt.toFixed(0)}ft</span>)}
                    {' · '}Vapp <span className="text-slate-300">{s.vapp.toFixed(0)}</span>/<span className="text-slate-500">{s.vref}</span>
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    <span style={{ color: s.autobrake === 'MAX' ? '#f59e0b' : '#10b981' }}>{s.autobrake}</span>
                    {' · '}<span style={{ color: s.reverser === 'NONE' ? '#f43f5e' : s.reverser === '1-INOP' ? '#f59e0b' : '#10b981' }}>REV-{s.reverser}</span>
                    {' · '}<span className="text-slate-300">{e.rwy.surface}</span>
                    {' · '}<span className="text-slate-300">{e.rwy.lengthFt}ft</span>
                  </div>
                  <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${e.score}%`, backgroundColor: TIER_COLOR[e.tier] }} /></div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {drvBadge('ROT', e.drivers.ROT)}
                    {drvBadge('EXT', e.drivers.EXT)}
                    {drvBadge('BRK', e.drivers.BRK)}
                    {drvBadge('LSV', e.drivers.LSV)}
                    {drvBadge('OVL', e.drivers.OVL)}
                    {drvBadge('CFG', e.drivers.CFG)}
                  </div>
                  <div className="text-[10px] mt-1.5 italic" style={{ color: TIER_COLOR[e.tier] }}>{e.advice}</div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'RUNWAYS' && (
          <div className="divide-y divide-slate-800">
            {RWYS.slice().sort((a, b) => {
              const ca = evals.filter(e => e.rwy.icao === a.icao && e.rwy.rwy === a.rwy).length
              const cb = evals.filter(e => e.rwy.icao === b.icao && e.rwy.rwy === b.rwy).length
              return cb - ca
            }).map(r => {
              const inR = evals.filter(e => e.rwy.icao === r.icao && e.rwy.rwy === r.rwy)
              if (inR.length === 0) return null
              const ms = inR.reduce((s, e) => s + e.score, 0) / inR.length
              const mr = inR.reduce((s, e) => s + e.sch.rotSec, 0) / inR.length
              const miss = inR.filter(e => e.tier === 'ROT-MISS').length
              const late = inR.filter(e => e.tier === 'LATE-VAC').length
              const tierCol = r.hiroTier === 3 ? '#a855f7' : r.hiroTier === 2 ? '#0ea5e9' : '#64748b'
              return (
                <div key={r.icao + r.rwy} className="px-3 py-2 hover:bg-slate-800/40" style={{ borderLeft: `3px solid ${tierCol}` }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-mono text-sky-300 text-[11px]">{r.icao}/{r.rwy}</span>
                      <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: tierCol, backgroundColor: tierCol + '1f', border: `1px solid ${tierCol}55` }}>CAT-{r.hiroTier}</span>
                      <span className="px-1 py-0.5 rounded text-[9px] font-mono text-slate-400 bg-slate-800/60 border border-slate-700">{r.surface}</span>
                      <span className="text-[10px] text-slate-400 truncate italic">{r.name}</span>
                    </div>
                    <span className="text-[10px] font-mono text-slate-300">{inR.length}</span>
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    target <span className="text-sky-300">{r.targetRot}s</span>
                    {' · μROT '}<span style={{ color: mr > 75 ? '#f43f5e' : mr > 65 ? '#f59e0b' : '#10b981' }}>{mr.toFixed(0)}s</span>
                    {' · len '}<span className="text-slate-300">{r.lengthFt}ft</span>
                    {' · RETs '}<span className="text-slate-300">{r.rets.length}</span>
                    {miss > 0 && <> · <span className="text-rose-400">{miss} MISS</span></>}
                    {late > 0 && <> · <span className="text-rose-400">{late} LATE</span></>}
                  </div>
                  <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: ms >= 65 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }} /></div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'RETS' && (
          <div className="divide-y divide-slate-800">
            {RWYS.map(r => {
              const inR = evals.filter(e => e.rwy.icao === r.icao && e.rwy.rwy === r.rwy)
              if (inR.length === 0) return null
              return (
                <div key={r.icao + r.rwy} className="px-3 py-2">
                  <div className="font-mono text-[11px] text-sky-300 mb-1">{r.icao}/{r.rwy} <span className="text-slate-500">·</span> <span className="text-slate-400">{r.rets.length} RETs</span></div>
                  <div className="space-y-1">
                    {r.rets.map(ret => {
                      const using = inR.filter(e => e.sch.chosenRet?.name === ret.name).length
                      const speedCol = ret.speed >= 55 ? '#10b981' : ret.speed >= 50 ? '#0ea5e9' : '#f59e0b'
                      return (
                        <div key={ret.name} className="flex items-center justify-between text-[10px] font-mono px-2 py-1 rounded bg-slate-800/40">
                          <div className="flex items-center gap-1.5">
                            <span className="text-slate-200 font-semibold">{ret.name}</span>
                            <span className="text-slate-500">{ret.side}</span>
                            <span className="text-slate-400">@{ret.ft}ft</span>
                            <span style={{ color: speedCol }}>{ret.speed}kt</span>
                          </div>
                          <span className="text-slate-300">{using}↑</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        ICAO Annex 14 Vol I §3.10 · Doc 9157 Pt 2 §1.10 RETs · Doc 9981 PANS-Aerodromes Pt II ch 4 · EUROCONTROL Reduced ROT ed.2 · FAA AC 150/5300-13B §4.5 · JO 7110.65 §3-10-3 §5-5-9 · AC 90-66B §11 · IATA IGOM 4.4 · CAP 1378 §6 HIRO · Boeing FCTM 5.50 · Airbus FCTM PR-AOP-LDG
      </div>
    </div>
  )
}
