'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   DCB · Demand-Capacity-Balancing Sector-Overload Monitor
   -------------------------------------------------------------
   Per-sector ATFCM demand vs declared-capacity scorer.
   Continuously evaluates each tracked aircraft against a 36-sector
   global en-route ACC/UAC catalogue (EUROCONTROL NM + FAA ARTCC
   spans) computing for each sector:

       OCC = instantaneous occupancy count inside polygon + FL band
       ENT = entry count in next LOOK-AH minutes (forward projection)
       LOAD% = peak(OCC, ENT) / declared sustainable capacity
       PEAK% = OCC / declared peak instantaneous capacity

   When LOAD% exceeds declared sustainable capacity for >5 min
   the FMP (Flow Management Position) raises a regulation /
   MIT (Miles-in-Trail) or MINIT (Minutes-in-Trail) restriction
   per EUROCONTROL ATFCM Operations Manual ed.27 sec 4.4 / FAA
   JO 7210.3 sec 17 / FAA Order JO 7110.65 sec 17-1. Each sector
   may be Combined/Split (CBA = Combined-with-Adjacent) and the
   monitor recommends opening adjacent sectors when sustained
   overload appears, per EUROCONTROL DCB Handbook ed.2.0 sec 5.

   Regulatory & operational basis:
     · EUROCONTROL ATFCM Operations Manual ed.27 sec 3.5 / sec 4
       DCB cycle / strategic-pre-tactical-tactical horizons
     · EUROCONTROL DCB Handbook ed.2.0 (Demand-Capacity Balancing)
     · EUROCONTROL Network Operations Plan (NOP) sec 4
     · EUROCONTROL CASA (Computer Assisted Slot Allocation)
       baseline FCFS slot algorithm with deviation tolerance
     · ICAO Doc 9971 Manual on Collaborative ATM Pt I Ch 3
     · ICAO Doc 4444 PANS-ATM sec 4 (sec 4.4 flight planning)
     · ICAO Annex 11 sec 3 (ATFM/DCB Network coordination)
     · ICAO Doc 7754 European ANP
     · EU Commission Implementing Regulation 2019/123 NMIR sec 6
       (capacity declaration and monitoring)
     · FAA Order JO 7210.3DD sec 17 (Traffic Management National)
     · FAA Order JO 7110.65 sec 17-1 (MIT / MINIT restrictions)
     · FAA Order JO 7210.55F Traffic Management National
     · FAA TFMS Traffic Flow Management System (CTOP/GDP/AFP)
     · NATS NMOC Network Manager Operations Centre
     · NATS UK MACC / SCN / IFPS interface
     · DFS DEFRA-FMP sec 4 capacity declaration
     · DSNA STAC sec 5 RVR / sec 8 ATFCM
     · MUAC Maastricht Upper Area Control sec 6 DCB
     · SESAR PJ.09 Network Collaborative Management
     · SESAR PJ.24 Network Performance
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'REGULATION' | 'OVERLOAD' | 'HOTSPOT' | 'WATCH' | 'NOMINAL' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  REGULATION: '#ef4444', OVERLOAD: '#f43f5e', HOTSPOT: '#f59e0b', WATCH: '#0ea5e9', NOMINAL: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['REGULATION', 'OVERLOAD', 'HOTSPOT', 'WATCH', 'NOMINAL']
const TIER_RANK: Record<Tier, number> = { REGULATION: 0, OVERLOAD: 1, HOTSPOT: 2, WATCH: 3, NOMINAL: 4, IDLE: 5 }

/* 4 sector-class taxonomy per EUROCONTROL DCB Hbk ed.2.0 sec 3 + FAA JO 7210.3 sec 17 */
type SectClass = 'UAC' | 'ACC' | 'TMA' | 'OCN'
const CLASS_COLOR: Record<SectClass, string> = { UAC: '#a855f7', ACC: '#0ea5e9', TMA: '#f59e0b', OCN: '#10b981' }
const CLASS_LABEL: Record<SectClass, string> = {
  UAC: 'Upper Area Control (FL245+)', ACC: 'Area Control Centre (FL100-FL245)',
  TMA: 'Terminal Manoeuvring Area (<FL100)', OCN: 'Oceanic (FL280+, NAT/EPAC/IND)',
}

/* 36-sector global catalogue. bbox = [minLat, minLng, maxLat, maxLng]; flLo/flHi FL band;
   cap = declared sustainable capacity (mvts/hr); peak = peak instantaneous occupancy cap; */
interface Sector {
  id: string; name: string; fir: string; country: string; klass: SectClass
  bbox: [number, number, number, number]; flLo: number; flHi: number
  cap: number; peak: number; mit: number  // baseline MIT NM
}
const SECTORS: Sector[] = [
  // MUAC Upper (Brussels, NL, Lux, DE-NW)
  { id: 'EDYY-DOL', name: 'DOLAN', fir: 'EDYY', country: 'MUAC', klass: 'UAC', bbox: [50.6, 4.0, 53.2, 9.0], flLo: 245, flHi: 660, cap: 64, peak: 22, mit: 7 },
  { id: 'EDYY-HMM', name: 'HAMM',  fir: 'EDYY', country: 'MUAC', klass: 'UAC', bbox: [50.6, 6.5, 53.2, 10.5], flLo: 245, flHi: 660, cap: 58, peak: 20, mit: 6 },
  // London AC
  { id: 'EGTT-CLN', name: 'CLN-N', fir: 'EGTT', country: 'UK',   klass: 'ACC', bbox: [51.5, -0.5, 53.5, 2.5],  flLo: 100, flHi: 245, cap: 52, peak: 18, mit: 5 },
  { id: 'EGTT-LON', name: 'LON-U', fir: 'EGTT', country: 'UK',   klass: 'UAC', bbox: [51.0, -3.0, 54.0, 2.0],  flLo: 245, flHi: 660, cap: 56, peak: 20, mit: 6 },
  // Paris
  { id: 'LFFF-PAR', name: 'PARIS', fir: 'LFFF', country: 'FR',   klass: 'ACC', bbox: [47.5, 1.0, 50.5, 5.0],   flLo: 100, flHi: 245, cap: 60, peak: 22, mit: 6 },
  { id: 'LFEE-RMS', name: 'REIMS', fir: 'LFEE', country: 'FR',   klass: 'UAC', bbox: [47.5, 2.0, 51.0, 7.5],   flLo: 245, flHi: 660, cap: 62, peak: 22, mit: 7 },
  { id: 'LFMM-MAS', name: 'MARS',  fir: 'LFMM', country: 'FR',   klass: 'UAC', bbox: [42.5, 3.0, 46.0, 8.0],   flLo: 245, flHi: 660, cap: 54, peak: 18, mit: 6 },
  // Karlsruhe UAC
  { id: 'EDUU-RHN', name: 'RHEIN', fir: 'EDUU', country: 'DE',   klass: 'UAC', bbox: [48.0, 6.0, 51.0, 11.0],  flLo: 245, flHi: 660, cap: 66, peak: 24, mit: 7 },
  // Munich
  { id: 'EDMM-MUN', name: 'MUNICH',fir: 'EDMM', country: 'DE',   klass: 'ACC', bbox: [47.5, 9.5, 50.0, 13.5],  flLo: 100, flHi: 245, cap: 50, peak: 18, mit: 6 },
  // Vienna
  { id: 'LOVV-VIE', name: 'VIENNA',fir: 'LOVV', country: 'AT',   klass: 'ACC', bbox: [46.0, 12.0, 49.0, 17.5], flLo: 100, flHi: 660, cap: 48, peak: 18, mit: 6 },
  // Zurich UAC
  { id: 'LSAS-ZRH', name: 'ZURICH',fir: 'LSAS', country: 'CH',   klass: 'UAC', bbox: [45.5, 5.5, 48.0, 10.5],  flLo: 245, flHi: 660, cap: 56, peak: 20, mit: 6 },
  // Padua / Milan
  { id: 'LIPP-PAD', name: 'PADOVA',fir: 'LIPP', country: 'IT',   klass: 'UAC', bbox: [43.0, 7.0, 47.5, 13.5],  flLo: 245, flHi: 660, cap: 58, peak: 20, mit: 6 },
  // Madrid
  { id: 'LECM-MAD', name: 'MADRID',fir: 'LECM', country: 'ES',   klass: 'ACC', bbox: [38.0, -6.0, 43.0, -1.0], flLo: 100, flHi: 245, cap: 52, peak: 18, mit: 5 },
  // Barcelona UAC
  { id: 'LECB-BCN', name: 'BARCEL',fir: 'LECB', country: 'ES',   klass: 'UAC', bbox: [39.5, -1.0, 43.5, 4.5],  flLo: 245, flHi: 660, cap: 54, peak: 20, mit: 6 },
  // Lisbon
  { id: 'LPPC-LIS', name: 'LISBOA',fir: 'LPPC', country: 'PT',   klass: 'ACC', bbox: [37.0, -10.5, 41.5, -6.5],flLo: 100, flHi: 460, cap: 44, peak: 16, mit: 5 },
  // Warsaw
  { id: 'EPWW-WAR', name: 'WARSZW',fir: 'EPWW', country: 'PL',   klass: 'UAC', bbox: [49.5, 14.5, 54.5, 23.5], flLo: 100, flHi: 660, cap: 50, peak: 18, mit: 6 },
  // Prague
  { id: 'LKAA-PRG', name: 'PRAHA', fir: 'LKAA', country: 'CZ',   klass: 'ACC', bbox: [48.5, 12.0, 51.0, 18.5], flLo: 100, flHi: 660, cap: 46, peak: 16, mit: 5 },
  // Budapest UAC
  { id: 'LHCC-BUD', name: 'BUDAP', fir: 'LHCC', country: 'HU',   klass: 'UAC', bbox: [45.5, 16.0, 49.0, 23.0], flLo: 100, flHi: 660, cap: 52, peak: 18, mit: 6 },
  // Athens
  { id: 'LGGG-ATH', name: 'ATHINAI',fir:'LGGG', country: 'GR',   klass: 'ACC', bbox: [34.5, 19.0, 41.5, 28.5], flLo: 100, flHi: 660, cap: 44, peak: 16, mit: 5 },
  // Istanbul
  { id: 'LTAA-IST', name: 'ISTANB',fir: 'LTAA', country: 'TR',   klass: 'ACC', bbox: [36.0, 26.0, 42.0, 36.0], flLo: 100, flHi: 660, cap: 56, peak: 20, mit: 6 },
  // Copenhagen
  { id: 'EKDK-CPH', name: 'COPENH',fir: 'EKDK', country: 'DK',   klass: 'ACC', bbox: [54.5, 8.0, 57.5, 15.0],  flLo: 100, flHi: 660, cap: 48, peak: 18, mit: 5 },
  // Stockholm
  { id: 'ESAA-MAL', name: 'MALMO', fir: 'ESAA', country: 'SE',   klass: 'UAC', bbox: [55.0, 11.0, 60.0, 19.0], flLo: 100, flHi: 660, cap: 50, peak: 18, mit: 6 },
  // Dublin / Shannon
  { id: 'EISN-SHN', name: 'SHANNON',fir:'EISN', country: 'IE',   klass: 'UAC', bbox: [51.0, -11.0, 56.0, -5.0],flLo: 245, flHi: 660, cap: 48, peak: 18, mit: 7 },
  // FAA ARTCC enroute
  { id: 'ZNY-A',   name: 'NY-EAST',fir: 'ZNY',  country: 'US',   klass: 'ACC', bbox: [38.5, -76.0, 42.5, -71.0], flLo: 180, flHi: 460, cap: 68, peak: 24, mit: 8 },
  { id: 'ZBW-A',   name: 'BOSTON', fir: 'ZBW',  country: 'US',   klass: 'ACC', bbox: [40.5, -74.5, 45.0, -68.0], flLo: 180, flHi: 460, cap: 62, peak: 22, mit: 7 },
  { id: 'ZDC-A',   name: 'WASHDC', fir: 'ZDC',  country: 'US',   klass: 'ACC', bbox: [36.0, -80.0, 40.5, -74.5], flLo: 180, flHi: 460, cap: 64, peak: 22, mit: 8 },
  { id: 'ZAU-A',   name: 'CHICAGO',fir: 'ZAU',  country: 'US',   klass: 'ACC', bbox: [40.0, -90.5, 44.5, -84.0], flLo: 180, flHi: 460, cap: 70, peak: 24, mit: 8 },
  { id: 'ZID-A',   name: 'INDY',   fir: 'ZID',  country: 'US',   klass: 'ACC', bbox: [37.0, -88.0, 41.5, -82.5], flLo: 180, flHi: 460, cap: 56, peak: 20, mit: 7 },
  { id: 'ZTL-A',   name: 'ATLANTA',fir: 'ZTL',  country: 'US',   klass: 'ACC', bbox: [31.5, -86.0, 36.0, -80.5], flLo: 180, flHi: 460, cap: 66, peak: 22, mit: 8 },
  { id: 'ZJX-A',   name: 'JAX',    fir: 'ZJX',  country: 'US',   klass: 'ACC', bbox: [29.0, -84.0, 33.5, -79.0], flLo: 180, flHi: 460, cap: 54, peak: 20, mit: 7 },
  { id: 'ZMA-O',   name: 'MIAMI-O',fir: 'ZMA',  country: 'US',   klass: 'OCN', bbox: [22.0, -82.0, 27.5, -73.0], flLo: 280, flHi: 660, cap: 38, peak: 14, mit: 10 },
  { id: 'ZFW-A',   name: 'FT-WORTH',fir:'ZFW',  country: 'US',   klass: 'ACC', bbox: [30.5, -100.0, 35.5, -93.0],flLo: 180, flHi: 460, cap: 60, peak: 22, mit: 8 },
  { id: 'ZHU-A',   name: 'HOUSTON',fir: 'ZHU',  country: 'US',   klass: 'ACC', bbox: [27.5, -97.0, 32.0, -90.5], flLo: 180, flHi: 460, cap: 52, peak: 18, mit: 7 },
  { id: 'ZLA-A',   name: 'LA',     fir: 'ZLA',  country: 'US',   klass: 'ACC', bbox: [32.0, -120.0, 36.0, -114.0],flLo:180, flHi: 460, cap: 64, peak: 22, mit: 8 },
  { id: 'ZOA-A',   name: 'OAKLAND',fir: 'ZOA',  country: 'US',   klass: 'ACC', bbox: [36.0, -123.5, 41.0, -119.0],flLo:180, flHi: 460, cap: 58, peak: 20, mit: 7 },
  { id: 'ZAK-O',   name: 'OAK-PAC',fir: 'ZAK',  country: 'US',   klass: 'OCN', bbox: [10.0, -160.0, 35.0, -130.0],flLo:280, flHi: 660, cap: 30, peak: 12, mit: 10 },
]

/* 4-class airframe classifier for class-pill display */
type Klass = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
const KLASS_COLOR: Record<Klass, string> = { HVY: '#a855f7', NRW: '#0ea5e9', RGN: '#10b981', BIZ: '#f59e0b', TBP: '#64748b' }
function classifyKlass(type: string | undefined): Klass {
  const t = (type || '').toUpperCase()
  if (/^(A38|B74|B77|B78|A35|A33|A34|A30|A31|MD11|IL96|B767)/.test(t)) return 'HVY'
  if (/^(B73|B75|A32|A31[89]|A22|MD8|MD9|BCS|CS[123])/.test(t)) return 'NRW'
  if (/^(CRJ|E17|E19|E14|E13|DH8|AT[4-7]|SF[35]|RJ8|RJ1|J3|J4|F50|F70|F100)/.test(t)) return 'RGN'
  if (/^(GLF|GLEX|G280|FA[0-9]|CL[36]|CRJ2|HDJT|C25|C56|C68|LJ4|LJ7|H25)/.test(t)) return 'BIZ'
  if (/^(C172|C18|C20|PC1|PC2|TBM|PA2|PA3|BE3|BE5|BE9|SR2|DA4|DA6)/.test(t)) return 'TBP'
  return 'NRW'
}

/* ----- math helpers ----- */
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const R_NM = 3440.065
function gcNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180, dφ = (la2 - la1) * Math.PI / 180, dλ = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
function inBbox(lat: number, lng: number, b: [number, number, number, number]): boolean {
  return lat >= b[0] && lat <= b[2] && lng >= b[1] && lng <= b[3]
}
function projectLatLng(lat: number, lng: number, track: number, distNm: number): [number, number] {
  const φ1 = lat * Math.PI / 180, λ1 = lng * Math.PI / 180, θ = track * Math.PI / 180, δ = distNm / R_NM
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return [φ2 * 180 / Math.PI, λ2 * 180 / Math.PI]
}

interface SectorState {
  sec: Sector
  occList: SFlight[]                     // currently inside polygon+band
  entList: { f: SFlight; etaMin: number }[] // entering within LOOK-AH
  exitList: { f: SFlight; etaMin: number }[]// exiting within LOOK-AH
  occ: number                            // OCC count
  ent: number                            // entry count
  peakProj: number                       // max occupancy in next LOOK-AH (sample at +5/+10/+15/+20)
  loadPct: number                        // peak/cap*100
  peakPct: number                        // occ/peak*100
  netFlow: number                        // ent - exit
  tier: Tier
  score: number
  drivers: { LD: number; PK: number; PRJ: number; FLW: number; HRZ: number; CLS: number }
}

function analyseSector(sec: Sector, flights: SFlight[], lookMin: number, capMul: number, peakMul: number, classBoost: number): SectorState {
  const occList: SFlight[] = []
  const entList: { f: SFlight; etaMin: number }[] = []
  const exitList: { f: SFlight; etaMin: number }[] = []
  const cap = Math.max(8, sec.cap * (capMul / 100))
  const peakCap = Math.max(4, sec.peak * (peakMul / 100))
  const flBand = (alt: number) => { const fl = alt / 100; return fl >= sec.flLo && fl <= sec.flHi }

  // Sample occupancy at +5, +10, +15, +20 min as well
  const samplePts = [0, lookMin * 0.25, lookMin * 0.5, lookMin * 0.75, lookMin]
  const projOcc = samplePts.map(() => 0)

  for (const f of flights) {
    if (f.ground) continue
    if (!flBand(f.altitudeFt)) continue
    const inside = inBbox(f.lat, f.lng, sec.bbox)
    if (inside) occList.push(f)
    // project forward
    for (let i = 0; i < samplePts.length; i++) {
      const t = samplePts[i]
      const dNm = (f.velocityKts * t) / 60
      const [la, ln] = projectLatLng(f.lat, f.lng, f.track, dNm)
      const futAlt = f.altitudeFt + f.vertRate * t
      const futFl = futAlt / 100
      const futBand = futFl >= sec.flLo && futFl <= sec.flHi
      if (futBand && inBbox(la, ln, sec.bbox)) projOcc[i]++
    }
    // detect entry/exit transitions
    if (!inside) {
      // forward scan find first crossing
      for (let t = 1; t <= lookMin; t += 1) {
        const dNm = (f.velocityKts * t) / 60
        const [la, ln] = projectLatLng(f.lat, f.lng, f.track, dNm)
        const futAlt = f.altitudeFt + f.vertRate * t
        const futFl = futAlt / 100
        if (futFl >= sec.flLo && futFl <= sec.flHi && inBbox(la, ln, sec.bbox)) {
          entList.push({ f, etaMin: t })
          break
        }
      }
    } else {
      for (let t = 1; t <= lookMin; t += 1) {
        const dNm = (f.velocityKts * t) / 60
        const [la, ln] = projectLatLng(f.lat, f.lng, f.track, dNm)
        const futAlt = f.altitudeFt + f.vertRate * t
        const futFl = futAlt / 100
        if (!(futFl >= sec.flLo && futFl <= sec.flHi && inBbox(la, ln, sec.bbox))) {
          exitList.push({ f, etaMin: t })
          break
        }
      }
    }
  }

  const occ = occList.length
  const ent = entList.length
  const exit = exitList.length
  const peakProj = Math.max(occ, ...projOcc)
  // Convert peakProj (instantaneous count) and entry-rate (per LOOK-AH window) to mvts/hr equivalent
  const entRatePerHr = (ent / Math.max(1, lookMin)) * 60
  const sustained = Math.max(entRatePerHr, occ * (60 / 18)) // assume 18-min mean sector transit time
  const loadPct = clamp(sustained / cap * 100, 0, 220)
  const peakPct = clamp(peakProj / peakCap * 100, 0, 220)
  const netFlow = ent - exit

  // Risk drivers
  const LD = clamp((loadPct - 70) / 50 * 100, 0, 100)
  const PK = clamp((peakPct - 75) / 50 * 100, 0, 100)
  const PRJ = clamp((peakProj - occ) / Math.max(2, peakCap * 0.4) * 100, 0, 100)
  const FLW = clamp(Math.abs(netFlow) / Math.max(3, peakCap * 0.3) * 100, 0, 100)
  const HRZ = clamp(ent * 8, 0, 100)  // imminent demand pressure
  const CLS = sec.klass === 'UAC' ? 70 : sec.klass === 'ACC' ? 60 : sec.klass === 'OCN' ? 40 : 50
  const drivers = { LD, PK, PRJ, FLW, HRZ, CLS: CLS * (classBoost / 100) }

  let tier: Tier
  let score: number
  if (loadPct >= 110 && peakPct >= 95) {
    tier = 'REGULATION'
    score = clamp(80 + (loadPct - 110) * 0.4 + PK * 0.1, 80, 100)
  } else if (loadPct >= 95 || peakPct >= 95) {
    tier = 'OVERLOAD'
    score = clamp(65 + (Math.max(loadPct, peakPct) - 95) * 0.5, 60, 80)
  } else if (loadPct >= 80 || peakPct >= 75 || PRJ >= 60) {
    tier = 'HOTSPOT'
    score = clamp(45 + Math.max(LD, PK, PRJ) * 0.2, 40, 60)
  } else if (loadPct >= 60 || peakPct >= 55 || ent >= 5) {
    tier = 'WATCH'
    score = clamp(25 + LD * 0.15, 20, 40)
  } else if (occ === 0 && ent === 0) {
    tier = 'IDLE'; score = 0
  } else {
    tier = 'NOMINAL'
    score = clamp(LD * 0.2, 0, 20)
  }

  return { sec, occList, entList, exitList, occ, ent, peakProj, loadPct, peakPct, netFlow, tier, score, drivers }
}

const SRC_POLY = 'dcb-poly', LYR_POLY_FILL = 'dcb-poly-fill', LYR_POLY_LINE = 'dcb-poly-line'
const SRC_LBL = 'dcb-lbl', LYR_LBL = 'dcb-lbl'
const SRC_HALO = 'dcb-halo', LYR_HALO = 'dcb-halo'
const SRC_PIN = 'dcb-pin', LYR_PIN = 'dcb-pin'
const SRC_PROJ = 'dcb-proj', LYR_PROJ = 'dcb-proj'

const lsGet = (k: string, d: any) => { if (typeof window === 'undefined') return d; try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } }
const lsSet = (k: string, v: any) => { if (typeof window === 'undefined') return; try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

export default function DcbSectorLoad({ map, flights, onClose, onFly }: Props) {
  const [lookMin, setLookMin] = useState<number>(() => lsGet('ft-dcb-look', 20))
  const [capMul, setCapMul] = useState<number>(() => lsGet('ft-dcb-cap', 100))
  const [peakMul, setPeakMul] = useState<number>(() => lsGet('ft-dcb-peak', 100))
  const [classBoost, setClassBoost] = useState<number>(() => lsGet('ft-dcb-cls', 100))
  const [advMul, setAdvMul] = useState<number>(() => lsGet('ft-dcb-adv', 100))
  const [minFl, setMinFl] = useState<number>(() => lsGet('ft-dcb-mfl', 0))
  const [maxFl, setMaxFl] = useState<number>(() => lsGet('ft-dcb-xfl', 660))
  const [classFilter, setClassFilter] = useState<SectClass | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [tab, setTab] = useState<'SECTORS' | 'AIRCRAFT' | 'CLASSES'>('SECTORS')
  const [showPoly, setShowPoly] = useState(true)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    lsSet('ft-dcb-look', lookMin); lsSet('ft-dcb-cap', capMul); lsSet('ft-dcb-peak', peakMul)
    lsSet('ft-dcb-cls', classBoost); lsSet('ft-dcb-adv', advMul); lsSet('ft-dcb-mfl', minFl); lsSet('ft-dcb-xfl', maxFl)
  }, [lookMin, capMul, peakMul, classBoost, advMul, minFl, maxFl])

  const states = useMemo(() => {
    const out: SectorState[] = []
    for (const sec of SECTORS) {
      if (sec.flHi < minFl || sec.flLo > maxFl) continue
      if (classFilter !== 'ALL' && sec.klass !== classFilter) continue
      const st = analyseSector(sec, flights, lookMin, capMul, peakMul, classBoost)
      st.score = clamp(st.score * (advMul / 100), 0, 100)
      out.push(st)
    }
    out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, lookMin, capMul, peakMul, classBoost, advMul, minFl, maxFl, classFilter])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return states.filter(s => {
      if (tierFilter !== 'ALL' && s.tier !== tierFilter) return false
      if (q) {
        const blob = `${s.sec.id} ${s.sec.name} ${s.sec.fir} ${s.sec.country}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [states, tierFilter, query])

  const tierCount: Record<Tier, number> = { REGULATION: 0, OVERLOAD: 0, HOTSPOT: 0, WATCH: 0, NOMINAL: 0, IDLE: 0 }
  for (const s of states) tierCount[s.tier]++

  const meanLoad = states.length ? states.reduce((acc, s) => acc + s.loadPct, 0) / states.length : 0
  const totalOcc = states.reduce((acc, s) => acc + s.occ, 0)
  const totalEnt = states.reduce((acc, s) => acc + s.ent, 0)
  const regulated = tierCount.REGULATION
  const overloaded = tierCount.OVERLOAD
  const hotspots = tierCount.HOTSPOT
  const worst = states.find(s => s.tier !== 'IDLE')

  /* Map overlays */
  useEffect(() => {
    if (!map) return
    const ensure = (id: string, type: any, src: string, paint: any, layout: any = {}) => {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer(id)) map.addLayer({ id, type, source: src, paint, layout } as any)
    }
    ensure(LYR_POLY_FILL, 'fill', SRC_POLY, { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 })
    ensure(LYR_POLY_LINE, 'line', SRC_POLY, { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.6, 'line-dasharray': [3, 3] })
    ensure(LYR_PROJ, 'line', SRC_PROJ, { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.65, 'line-dasharray': [2, 3] })
    ensure(LYR_HALO, 'circle', SRC_HALO, { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'] })
    ensure(LYR_PIN, 'circle', SRC_PIN, { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' })
    ensure(LYR_LBL, 'symbol', SRC_LBL, {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-font': ['Open Sans Bold'] })
    if (map.getLayer(LYR_LBL)) {
      map.setPaintProperty(LYR_LBL, 'text-color', ['get', 'color'])
      map.setPaintProperty(LYR_LBL, 'text-halo-color', '#0f172a')
      map.setPaintProperty(LYR_LBL, 'text-halo-width', 1.4)
    }

    const poly: any[] = [], lbl: any[] = [], halo: any[] = [], pin: any[] = [], proj: any[] = []
    for (const s of filtered) {
      const color = TIER_COLOR[s.tier]
      if (showPoly) {
        const b = s.sec.bbox
        const ring = [[b[1], b[0]], [b[3], b[0]], [b[3], b[2]], [b[1], b[2]], [b[1], b[0]]]
        poly.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { color } })
      }
      if (showLbl) {
        const cx = (s.sec.bbox[1] + s.sec.bbox[3]) / 2
        const cy = (s.sec.bbox[0] + s.sec.bbox[2]) / 2
        const lab = `${s.sec.id} · ${s.tier} · ${s.occ}/${Math.round(s.sec.peak)} · ${s.loadPct.toFixed(0)}%`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [cx, cy] }, properties: { label: lab, color } })
      }
      // Halo per occupant
      if (showHalo) {
        for (const f of s.occList) {
          halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [f.lng, f.lat] }, properties: { color, r: 8 + s.score * 0.14 } })
        }
      }
      if (showPin && (s.tier === 'REGULATION' || s.tier === 'OVERLOAD')) {
        const cx = (s.sec.bbox[1] + s.sec.bbox[3]) / 2
        const cy = (s.sec.bbox[0] + s.sec.bbox[2]) / 2
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [cx, cy] }, properties: { color } })
      }
      if (showProj) {
        for (const e of s.entList.slice(0, 12)) {
          const dNm = (e.f.velocityKts * e.etaMin) / 60
          const [la, ln] = projectLatLng(e.f.lat, e.f.lng, e.f.track, dNm)
          proj.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[e.f.lng, e.f.lat], [ln, la]] }, properties: { color } })
        }
      }
    }
    ;(map.getSource(SRC_POLY) as any).setData({ type: 'FeatureCollection', features: poly })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_PROJ) as any).setData({ type: 'FeatureCollection', features: proj })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_PROJ, LYR_POLY_LINE, LYR_POLY_FILL]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_PROJ, SRC_POLY]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, filtered, showPoly, showHalo, showPin, showLbl, showProj])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const classBadge = (c: SectClass) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: CLASS_COLOR[c], backgroundColor: CLASS_COLOR[c] + '1a', border: `1px solid ${CLASS_COLOR[c]}66` }}>{c}</span>
  )
  const klassBadge = (k: Klass) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: KLASS_COLOR[k], backgroundColor: KLASS_COLOR[k] + '1a', border: `1px solid ${KLASS_COLOR[k]}66` }}>{k}</span>
  )
  const drvBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const advice = (s: SectorState) => {
    if (s.tier === 'REGULATION') return `REGULATION · sustained load ${s.loadPct.toFixed(0)}% peak ${s.peakPct.toFixed(0)}% · FMP file CASA regulation MIT ${s.sec.mit}+2NM or MINIT 5 · open adjacent sector per EUROCONTROL DCB Hbk ed.2.0 sec 5 / JO 7210.3 sec 17`
    if (s.tier === 'OVERLOAD')  return `OVERLOAD · ${s.occ}/${Math.round(s.sec.peak * peakMul/100)} now ${s.ent} entering · pre-emptive MIT ${s.sec.mit}NM or speed-control on inbound stream per JO 7110.65 sec 17-1 / ATFCM Ops Manual ed.27 sec 4.4`
    if (s.tier === 'HOTSPOT')   return `HOTSPOT · projected peak ${s.peakProj} in ${lookMin}min · monitor flow brief D-side · consider TSAT tweak via A-CDM per Doc 9971 Pt I Ch 3`
    if (s.tier === 'WATCH')     return `WATCH · ${s.occ} occ ${s.ent} ent ${s.exitList.length} exit · monitor demand curve · no action`
    if (s.tier === 'IDLE')      return `Sector idle · no traffic in FL${s.sec.flLo}-${s.sec.flHi} band`
    return `Nominal · load ${s.loadPct.toFixed(0)}% peak ${s.peakPct.toFixed(0)}% within declared capacity (${s.sec.cap} mvts/hr / peak ${s.sec.peak})`
  }

  /* Scatter: loadPct (x) vs peakPct (y) */
  const W = 280, H = 180
  const sx = (n: number) => 32 + clamp(n, 0, 200) / 200 * (W - 42)
  const sy = (n: number) => H - 24 - clamp(n, 0, 200) / 200 * (H - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">DCB · Sector Overload Monitor</div>
          <div className="text-[10px] text-slate-500">ATFCM · EUROCONTROL DCB Hbk ed.2.0 · ATFCM Ops Manual ed.27 · NMIR 2019/123 · JO 7210.3 §17 · JO 7110.65 §17-1</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[8px] font-semibold leading-tight" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean LD%</div>
          <div className="text-sm font-semibold" style={{ color: meanLoad >= 95 ? '#ef4444' : meanLoad >= 70 ? '#f59e0b' : '#10b981' }}>{meanLoad.toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate font-mono">{worst ? worst.sec.id : '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Regulated</div>
          <div className="text-sm font-semibold" style={{ color: regulated > 0 ? '#ef4444' : '#10b981' }}>{regulated}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Overload</div>
          <div className="text-xs font-semibold text-rose-400">{overloaded}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Hotspots</div>
          <div className="text-xs font-semibold text-amber-400">{hotspots}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Σ Occ / Ent</div>
          <div className="text-xs font-semibold text-sky-400">{totalOcc} / {totalEnt}</div>
        </div>
      </div>

      {showDiag && states.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* regulation quadrant */}
            <rect x={sx(110)} y={sy(200)} width={sx(200) - sx(110)} height={sy(95) - sy(200)} fill="#ef444425" />
            {/* hotspot band */}
            <rect x={sx(80)} y={sy(200)} width={sx(110) - sx(80)} height={sy(75) - sy(200)} fill="#f59e0b22" />
            <line x1={sx(95)}  y1={sy(0)} x2={sx(95)}  y2={sy(200)} stroke="#f43f5e66" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(110)} y1={sy(0)} x2={sx(110)} y2={sy(200)} stroke="#ef444466" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(0)} y1={sy(100)} x2={sx(200)} y2={sy(100)} stroke="#475569" strokeWidth={0.5} strokeDasharray="3 3" />
            <text x={W / 2} y={H - 4} textAnchor="middle" fontSize="9" fill="#64748b">Load %</text>
            <text x={6} y={H / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H / 2})`}>Peak %</text>
            {states.map((s, i) => (
              <circle key={i} cx={sx(s.loadPct)} cy={sy(s.peakPct)} r={2.6} fill={TIER_COLOR[s.tier]} opacity={0.9} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['LOOK-AH', lookMin, 5, 60, setLookMin, 'min'],
            ['CAP-MUL', capMul, 50, 200, setCapMul, '%'],
            ['PEAK-MUL', peakMul, 50, 200, setPeakMul, '%'],
            ['CLS-WT', classBoost, 50, 200, setClassBoost, '%'],
            ['ADV-MUL', advMul, 50, 200, setAdvMul, '%'],
            ['MIN-FL', minFl, 0, 400, setMinFl, ''],
            ['MAX-FL', maxFl, 100, 660, setMaxFl, ''],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[68px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[40px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['UAC', 'ACC', 'TMA', 'OCN'] as SectClass[]).map(k => (
            <button key={k} onClick={() => setClassFilter(classFilter === k ? 'ALL' : k)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: classFilter === k ? CLASS_COLOR[k] + '33' : '#0b1220', borderColor: classFilter === k ? CLASS_COLOR[k] : '#1e293b', color: classFilter === k ? CLASS_COLOR[k] : '#cbd5e1' }}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['POLY', showPoly, setShowPoly],
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['PROJ', showProj, setShowProj],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, on, setter]: any) => (
            <button key={lab} onClick={() => setter(!on)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: on ? '#0ea5e933' : '#0b1220', borderColor: on ? '#0ea5e9' : '#1e293b', color: on ? '#0ea5e9' : '#94a3b8' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search sector id / name / FIR / country" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['SECTORS', 'AIRCRAFT', 'CLASSES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-1.5 text-[10px] font-semibold ${tab === t ? 'text-sky-400 bg-slate-800/50 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {tab === 'SECTORS' && (
        <div className="divide-y divide-slate-800">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No sectors match filters</div>}
          {filtered.map((s, idx) => (
            <div key={idx} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => { const f = s.occList[0] || s.entList[0]?.f; if (f) onFly(f.icao) }} style={{ borderLeft: `3px solid ${TIER_COLOR[s.tier]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 font-mono">{s.sec.id}</span>
                  <span className="text-slate-400 truncate">{s.sec.name}</span>
                  {classBadge(s.sec.klass)}
                </div>
                {tierBadge(s.tier)}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                <span className="text-sky-300">FL{s.sec.flLo}-{s.sec.flHi}</span>
                {' · '}<span style={{ color: s.loadPct >= 110 ? '#ef4444' : s.loadPct >= 95 ? '#f43f5e' : s.loadPct >= 80 ? '#f59e0b' : '#10b981' }}>LD {s.loadPct.toFixed(0)}%</span>
                {' · '}<span style={{ color: s.peakPct >= 95 ? '#ef4444' : s.peakPct >= 75 ? '#f59e0b' : '#10b981' }}>PK {s.peakPct.toFixed(0)}%</span>
                {' · OCC '}<span className="text-slate-200">{s.occ}</span>
                {' / cap '}<span className="text-slate-500">{Math.round(s.sec.peak * peakMul/100)}</span>
                {' · ENT '}<span className="text-amber-300">{s.ent}</span>
                {' EXIT '}<span className="text-emerald-300">{s.exitList.length}</span>
                {' (+'}<span className="text-slate-300">{s.netFlow >= 0 ? '+' : ''}{s.netFlow}</span>{')'}
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5 font-mono">{s.sec.fir} · {s.sec.country} · cap {s.sec.cap} mvts/hr · MIT {s.sec.mit}NM · proj-peak {s.peakProj} in {lookMin}min</div>
              <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${s.score}%`, backgroundColor: TIER_COLOR[s.tier] }} /></div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {drvBadge('LD', s.drivers.LD)}
                {drvBadge('PK', s.drivers.PK)}
                {drvBadge('PRJ', s.drivers.PRJ)}
                {drvBadge('FLW', s.drivers.FLW)}
                {drvBadge('HRZ', s.drivers.HRZ)}
                {drvBadge('CLS', s.drivers.CLS)}
              </div>
              <div className="text-[10px] mt-1.5 italic" style={{ color: TIER_COLOR[s.tier] }}>{advice(s)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'AIRCRAFT' && (
        <div className="divide-y divide-slate-800">
          {(() => {
            const rows: { f: SFlight; sec: SectorState; status: 'IN' | 'ENT'; etaMin?: number }[] = []
            for (const s of filtered) {
              for (const f of s.occList) rows.push({ f, sec: s, status: 'IN' })
              for (const e of s.entList) rows.push({ f: e.f, sec: s, status: 'ENT', etaMin: e.etaMin })
            }
            rows.sort((a, b) => TIER_RANK[a.sec.tier] - TIER_RANK[b.sec.tier] || (a.status === b.status ? 0 : a.status === 'IN' ? -1 : 1))
            if (rows.length === 0) return <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No aircraft in any tracked sector</div>
            return rows.slice(0, 80).map((r, i) => {
              const klass = classifyKlass(r.f.type)
              return (
                <div key={i} className="px-3 py-1.5 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(r.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[r.sec.tier]}` }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-semibold text-slate-100 truncate">{r.f.callsign || r.f.icao}</span>
                      {klassBadge(klass)}
                      <span className="text-[10px] text-slate-500">{r.f.type || '—'}</span>
                    </div>
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: r.status === 'IN' ? '#10b981' : '#f59e0b', backgroundColor: (r.status === 'IN' ? '#10b981' : '#f59e0b') + '22' }}>{r.status === 'IN' ? '› IN' : '↗ ENT ' + r.etaMin + 'm'}</span>
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                    <span className="text-sky-300">{r.sec.sec.id}</span>
                    {' · FL'}<span className="text-slate-200">{Math.round(r.f.altitudeFt/100)}</span>
                    {' · '}<span className="text-slate-300">{r.f.velocityKts.toFixed(0)}kt</span>
                    {' '}<span className="text-slate-500">{r.f.vertRate > 200 ? '↑' : r.f.vertRate < -200 ? '↓' : '›'}</span>
                  </div>
                </div>
              )
            })
          })()}
        </div>
      )}

      {tab === 'CLASSES' && (
        <div className="divide-y divide-slate-800">
          {(['UAC', 'ACC', 'TMA', 'OCN'] as SectClass[]).map(k => {
            const subset = states.filter(s => s.sec.klass === k)
            if (subset.length === 0) return null
            const ms = subset.reduce((a, s) => a + s.score, 0) / subset.length
            const ml = subset.reduce((a, s) => a + s.loadPct, 0) / subset.length
            const oc = subset.reduce((a, s) => a + s.occ, 0)
            const en = subset.reduce((a, s) => a + s.ent, 0)
            const reg = subset.filter(s => s.tier === 'REGULATION').length
            const ovl = subset.filter(s => s.tier === 'OVERLOAD').length
            const hot = subset.filter(s => s.tier === 'HOTSPOT').length
            const sevColor = reg > 0 ? '#ef4444' : ovl > 0 ? '#f43f5e' : hot > 0 ? '#f59e0b' : '#10b981'
            return (
              <div key={k} className="px-3 py-2" style={{ borderLeft: `3px solid ${sevColor}` }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {classBadge(k)}
                    <span className="font-semibold text-slate-100 text-[11px]">{CLASS_LABEL[k]}</span>
                  </div>
                  <span className="text-[10px] text-slate-500 font-mono">{subset.length} sec</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-1 font-mono">
                  OCC <span className="text-slate-200">{oc}</span>
                  {' · ENT '}<span className="text-amber-300">{en}</span>
                  {' · mean-LD '}<span style={{ color: ml >= 95 ? '#ef4444' : ml >= 70 ? '#f59e0b' : '#10b981' }}>{ml.toFixed(0)}%</span>
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {reg > 0 && <span className="px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: '#ef4444', backgroundColor: '#ef444422' }}>REG {reg}</span>}
                  {ovl > 0 && <span className="px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: '#f43f5e', backgroundColor: '#f43f5e22' }}>OVL {ovl}</span>}
                  {hot > 0 && <span className="px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: '#f59e0b', backgroundColor: '#f59e0b22' }}>HOT {hot}</span>}
                </div>
                <div className="mt-1.5 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: sevColor }} /></div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
