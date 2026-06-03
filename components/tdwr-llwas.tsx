'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   TDWR / LLWAS · Terminal Doppler Weather Radar &
   Low-Level Wind-Shear Alert System Microburst / Gust-Front /
   Wind-Shear Arrival/Departure Corridor Threat Monitor
   -----------------------------------------------------------
   Per-arrival / departure terminal-area scorer that correlates
   each tracked target against a synthetic catalogue of TDWR
   (Terminal Doppler Weather Radar) and LLWAS-NE (Low-Level
   Wind-Shear Alert System — Network Expansion) products
   published on the ATIS / tower frequency at 47 ATCT-served
   airports. Each product reports a Microburst Alert (MBA, loss
   ≥ 30 kt), Wind-Shear Alert with Loss (WSA-L, 15–29 kt loss),
   Wind-Shear Alert with Gain (WSA-G, ≥ 15 kt gain), or
   Gust-Front detection with phenom severity, corridor
   (arrival/departure), runway, distance band (RWY / 1MF / 2MF
   / 3MF), and age since issue. TDWR products carry a 60-180 s
   automatic refresh; LLWAS-NE refreshes every 10 s. Each
   product carries a per-runway "loss/gain" headwind delta
   broadcast to controllers per FAA Order JO 7110.65 §3-1-8
   ("Microburst Alert RWY 17R, threshold wind 240 at 18,
   2 mile final, 40 knot loss").

   Aircraft are scored on:
     · runway-corridor membership (nearest TDWR-equipped airport
       within 30 NM, alignment ≤ 35° of QFU, within arr/dep
       corridor)
     · headwind-loss / gain magnitude vs class energy margin
     · corridor section penetration (RWY = 100, 1MF = 75, 2MF
       = 55, 3MF = 35)
     · age-decay of TDWR/LLWAS product (τ MBA 90 s, WSA 120 s,
       GFRT 180 s)
     · airframe susceptibility (HVY 0.85, NRW 1.00, RGN 1.15,
       BIZ 1.05, TBP 1.30)
     · phase (FLARE 1.45, SHRT-FNL 1.40, APP 1.20, DEP-INIT
       1.30, DEP 1.10, OTHER 0.50)

   References
     · FAA Order JO 7110.65 §3-1-8 Low-Level Wind Shear / MBA
     · §2-6-3 Hazardous Weather Information dissemination
     · FAA Order 6560.21 LLWAS-NE Specifications
     · FAA Order 6560.20 TDWR Operation
     · FAA AC 00-54 Pilot Windshear Guide
     · FAA AC 120-41A Criteria for Operational Approval of
       Airborne Windshear Detection Systems
     · FAA AIM 7-1-23 Wind-Shear Reports
     · FAA AIM 7-1-26 LLWAS
     · FAA NextGen TDWR Product Replacement Program
     · ICAO Doc 9817 Manual on Low-Level Wind Shear
     · ICAO Annex 3 §4 / App 2 §4.8 wind-shear reports
     · ICAO Doc 4444 PANS-ATM §7.4 wind-shear warning
     · NTSB AAR-86-05 Delta 191 DFW microburst
     · NTSB AAR-94-04 USAir 1016 CLT microburst
     · NTSB AAR-95-03 American 102 DFW windshear
     · NTSB AAR-08-01 wind-shear advisory study
     · MIT Lincoln Lab TDWR Functional Description AD-A210456
     · NCAR FCM-H11-2017 LLWAS-NE Maintenance Manual
     · NWS Instruction 10-813 TDWR weather broadcasts
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'GO-AROUND' | 'CAUTION' | 'COORD' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'GO-AROUND': '#ef4444', CAUTION: '#f43f5e', COORD: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['GO-AROUND', 'CAUTION', 'COORD', 'WATCH', 'OK']
const TIER_RANK: Record<Tier, number> = { 'GO-AROUND': 0, CAUTION: 1, COORD: 2, WATCH: 3, OK: 4, IDLE: 5 }

type Phenom = 'MBA' | 'WSA-L' | 'WSA-G' | 'GFRT'
const PHENOM_COLOR: Record<Phenom, string> = { MBA: '#ef4444', 'WSA-L': '#f43f5e', 'WSA-G': '#f59e0b', GFRT: '#a855f7' }
const PHENOM_TAU_S: Record<Phenom, number> = { MBA: 90, 'WSA-L': 120, 'WSA-G': 120, GFRT: 180 }

type Corridor = 'ARR' | 'DEP'
type Section = 'RWY' | '1MF' | '2MF' | '3MF'
const SECTION_WEIGHT: Record<Section, number> = { RWY: 100, '1MF': 75, '2MF': 55, '3MF': 35 }

type Phase = 'FLARE' | 'SHRT-FNL' | 'APP' | 'DEP-INIT' | 'DEP' | 'GND' | 'OTHER'
const PHASE_MUL: Record<Phase, number> = { FLARE: 1.45, 'SHRT-FNL': 1.40, APP: 1.20, 'DEP-INIT': 1.30, DEP: 1.10, GND: 0.0, OTHER: 0.50 }

interface TdwrProduct {
  id: string
  apt: string         // airport ICAO
  rwy: string         // runway id e.g. 17C
  qfu: number         // magnetic heading deg
  lat: number; lng: number   // threshold lat/lng
  phenom: Phenom
  corridor: Corridor
  section: Section
  lossKt: number      // signed: + loss (MBA / WSA-L) / - gain (WSA-G)
  ageSec: number      // synthetic time-since-issue
  source: 'TDWR' | 'LLWAS-NE'
}

/* 47 synthetic TDWR / LLWAS-NE products across major US ATCT.
   Coordinates approximate threshold positions; phenom + section
   selected to span MBA / WSA-L / WSA-G / GFRT across ARR/DEP
   corridors. */
const PRODUCTS: TdwrProduct[] = [
  // DFW summer convective ring — Delta 191 site
  { id: 'TDWR-DFW-17C-MBA', apt: 'KDFW', rwy: '17C', qfu: 175, lat: 32.910, lng: -97.038, phenom: 'MBA',   corridor: 'ARR', section: '1MF', lossKt: 45, ageSec: 35, source: 'TDWR' },
  { id: 'TDWR-DFW-18R-WSL', apt: 'KDFW', rwy: '18R', qfu: 180, lat: 32.927, lng: -97.045, phenom: 'WSA-L', corridor: 'ARR', section: '2MF', lossKt: 25, ageSec: 60, source: 'TDWR' },
  { id: 'LLWAS-DFW-35L-WSG',apt: 'KDFW', rwy: '35L', qfu: 355, lat: 32.881, lng: -97.045, phenom: 'WSA-G', corridor: 'DEP', section: 'RWY', lossKt:-22, ageSec: 18, source: 'LLWAS-NE' },
  { id: 'TDWR-DFW-13R-GF',  apt: 'KDFW', rwy: '13R', qfu: 130, lat: 32.886, lng: -97.063, phenom: 'GFRT',  corridor: 'ARR', section: '3MF', lossKt: 15, ageSec: 110, source: 'TDWR' },
  // CLT — USAir 1016 site
  { id: 'TDWR-CLT-18C-MBA', apt: 'KCLT', rwy: '18C', qfu: 180, lat: 35.222, lng: -80.943, phenom: 'MBA',   corridor: 'ARR', section: 'RWY', lossKt: 50, ageSec: 22, source: 'TDWR' },
  { id: 'TDWR-CLT-36R-WSL', apt: 'KCLT', rwy: '36R', qfu: 360, lat: 35.205, lng: -80.937, phenom: 'WSA-L', corridor: 'DEP', section: '1MF', lossKt: 28, ageSec: 55, source: 'TDWR' },
  { id: 'TDWR-CLT-23-WSG',  apt: 'KCLT', rwy: '23',  qfu: 230, lat: 35.215, lng: -80.945, phenom: 'WSA-G', corridor: 'ARR', section: '2MF', lossKt:-18, ageSec: 70, source: 'LLWAS-NE' },
  // ATL
  { id: 'TDWR-ATL-26L-MBA', apt: 'KATL', rwy: '26L', qfu: 261, lat: 33.638, lng: -84.402, phenom: 'MBA',   corridor: 'ARR', section: '2MF', lossKt: 38, ageSec: 40, source: 'TDWR' },
  { id: 'TDWR-ATL-27R-WSL', apt: 'KATL', rwy: '27R', qfu: 268, lat: 33.640, lng: -84.443, phenom: 'WSA-L', corridor: 'ARR', section: '3MF', lossKt: 20, ageSec: 90, source: 'TDWR' },
  { id: 'TDWR-ATL-8L-GF',   apt: 'KATL', rwy: '8L',  qfu: 89,  lat: 33.642, lng: -84.466, phenom: 'GFRT',  corridor: 'DEP', section: '2MF', lossKt: 12, ageSec: 130, source: 'TDWR' },
  // ORD
  { id: 'TDWR-ORD-10C-MBA', apt: 'KORD', rwy: '10C', qfu: 100, lat: 41.989, lng: -87.913, phenom: 'MBA',   corridor: 'ARR', section: '1MF', lossKt: 35, ageSec: 30, source: 'TDWR' },
  { id: 'LLWAS-ORD-28C-WSL',apt: 'KORD', rwy: '28C', qfu: 280, lat: 41.986, lng: -87.901, phenom: 'WSA-L', corridor: 'ARR', section: 'RWY', lossKt: 26, ageSec: 12, source: 'LLWAS-NE' },
  { id: 'TDWR-ORD-22L-WSG', apt: 'KORD', rwy: '22L', qfu: 220, lat: 41.998, lng: -87.918, phenom: 'WSA-G', corridor: 'DEP', section: '1MF', lossKt:-16, ageSec: 80, source: 'TDWR' },
  // IAH
  { id: 'TDWR-IAH-8L-MBA',  apt: 'KIAH', rwy: '8L',  qfu: 86,  lat: 29.998, lng: -95.355, phenom: 'MBA',   corridor: 'ARR', section: 'RWY', lossKt: 42, ageSec: 25, source: 'TDWR' },
  { id: 'TDWR-IAH-26R-WSL', apt: 'KIAH', rwy: '26R', qfu: 266, lat: 30.000, lng: -95.330, phenom: 'WSA-L', corridor: 'DEP', section: '2MF', lossKt: 22, ageSec: 70, source: 'TDWR' },
  // MIA
  { id: 'TDWR-MIA-9-MBA',   apt: 'KMIA', rwy: '9',   qfu: 89,  lat: 25.795, lng: -80.319, phenom: 'MBA',   corridor: 'ARR', section: '1MF', lossKt: 40, ageSec: 45, source: 'TDWR' },
  { id: 'LLWAS-MIA-12-WSG', apt: 'KMIA', rwy: '12',  qfu: 121, lat: 25.798, lng: -80.299, phenom: 'WSA-G', corridor: 'DEP', section: 'RWY', lossKt:-20, ageSec: 15, source: 'LLWAS-NE' },
  { id: 'TDWR-MIA-30-GF',   apt: 'KMIA', rwy: '30',  qfu: 301, lat: 25.799, lng: -80.286, phenom: 'GFRT',  corridor: 'ARR', section: '3MF', lossKt: 14, ageSec: 150, source: 'TDWR' },
  // MCO
  { id: 'TDWR-MCO-17L-MBA', apt: 'KMCO', rwy: '17L', qfu: 175, lat: 28.434, lng: -81.319, phenom: 'MBA',   corridor: 'ARR', section: '2MF', lossKt: 33, ageSec: 50, source: 'TDWR' },
  { id: 'TDWR-MCO-18R-WSL', apt: 'KMCO', rwy: '18R', qfu: 180, lat: 28.435, lng: -81.327, phenom: 'WSA-L', corridor: 'DEP', section: '1MF', lossKt: 24, ageSec: 65, source: 'TDWR' },
  // TPA
  { id: 'TDWR-TPA-19L-MBA', apt: 'KTPA', rwy: '19L', qfu: 185, lat: 27.985, lng: -82.541, phenom: 'MBA',   corridor: 'ARR', section: 'RWY', lossKt: 46, ageSec: 20, source: 'TDWR' },
  // STL
  { id: 'LLWAS-STL-12R-WSL',apt: 'KSTL', rwy: '12R', qfu: 121, lat: 38.745, lng: -90.371, phenom: 'WSA-L', corridor: 'ARR', section: '1MF', lossKt: 27, ageSec: 28, source: 'LLWAS-NE' },
  // MEM
  { id: 'TDWR-MEM-18C-MBA', apt: 'KMEM', rwy: '18C', qfu: 180, lat: 35.045, lng: -89.978, phenom: 'MBA',   corridor: 'ARR', section: '2MF', lossKt: 32, ageSec: 60, source: 'TDWR' },
  { id: 'TDWR-MEM-9-GF',    apt: 'KMEM', rwy: '9',   qfu: 89,  lat: 35.043, lng: -89.988, phenom: 'GFRT',  corridor: 'DEP', section: '3MF', lossKt: 11, ageSec: 140, source: 'TDWR' },
  // BNA
  { id: 'TDWR-BNA-20R-WSL', apt: 'KBNA', rwy: '20R', qfu: 201, lat: 36.131, lng: -86.677, phenom: 'WSA-L', corridor: 'ARR', section: '2MF', lossKt: 23, ageSec: 75, source: 'TDWR' },
  // RDU
  { id: 'TDWR-RDU-23R-WSG', apt: 'KRDU', rwy: '23R', qfu: 230, lat: 35.881, lng: -78.788, phenom: 'WSA-G', corridor: 'DEP', section: '1MF', lossKt:-19, ageSec: 50, source: 'LLWAS-NE' },
  // IAD
  { id: 'TDWR-IAD-1C-MBA',  apt: 'KIAD', rwy: '1C',  qfu: 12,  lat: 38.937, lng: -77.460, phenom: 'MBA',   corridor: 'ARR', section: '1MF', lossKt: 36, ageSec: 38, source: 'TDWR' },
  { id: 'TDWR-IAD-19R-WSL', apt: 'KIAD', rwy: '19R', qfu: 195, lat: 38.961, lng: -77.461, phenom: 'WSA-L', corridor: 'DEP', section: '2MF', lossKt: 21, ageSec: 85, source: 'TDWR' },
  // DCA
  { id: 'LLWAS-DCA-1-WSL',  apt: 'KDCA', rwy: '1',   qfu: 11,  lat: 38.842, lng: -77.041, phenom: 'WSA-L', corridor: 'ARR', section: 'RWY', lossKt: 30, ageSec: 18, source: 'LLWAS-NE' },
  // JFK
  { id: 'TDWR-JFK-22R-MBA', apt: 'KJFK', rwy: '22R', qfu: 220, lat: 40.652, lng: -73.755, phenom: 'MBA',   corridor: 'ARR', section: '2MF', lossKt: 34, ageSec: 55, source: 'TDWR' },
  { id: 'TDWR-JFK-31L-WSG', apt: 'KJFK', rwy: '31L', qfu: 308, lat: 40.628, lng: -73.794, phenom: 'WSA-G', corridor: 'DEP', section: '1MF', lossKt:-17, ageSec: 90, source: 'TDWR' },
  // EWR
  { id: 'TDWR-EWR-22L-MBA', apt: 'KEWR', rwy: '22L', qfu: 220, lat: 40.706, lng: -74.171, phenom: 'MBA',   corridor: 'ARR', section: '1MF', lossKt: 39, ageSec: 32, source: 'TDWR' },
  { id: 'LLWAS-EWR-4R-WSL', apt: 'KEWR', rwy: '4R',  qfu: 40,  lat: 40.673, lng: -74.187, phenom: 'WSA-L', corridor: 'DEP', section: 'RWY', lossKt: 28, ageSec: 11, source: 'LLWAS-NE' },
  // LGA
  { id: 'TDWR-LGA-22-MBA',  apt: 'KLGA', rwy: '22',  qfu: 222, lat: 40.787, lng: -73.866, phenom: 'MBA',   corridor: 'ARR', section: 'RWY', lossKt: 48, ageSec: 25, source: 'TDWR' },
  // PHL
  { id: 'TDWR-PHL-9R-WSL',  apt: 'KPHL', rwy: '9R',  qfu: 89,  lat: 39.875, lng: -75.260, phenom: 'WSA-L', corridor: 'ARR', section: '2MF', lossKt: 24, ageSec: 65, source: 'TDWR' },
  { id: 'TDWR-PHL-27L-GF',  apt: 'KPHL', rwy: '27L', qfu: 269, lat: 39.875, lng: -75.232, phenom: 'GFRT',  corridor: 'DEP', section: '3MF', lossKt: 13, ageSec: 160, source: 'TDWR' },
  // BOS
  { id: 'TDWR-BOS-22L-MBA', apt: 'KBOS', rwy: '22L', qfu: 219, lat: 42.376, lng: -71.022, phenom: 'MBA',   corridor: 'ARR', section: '1MF', lossKt: 37, ageSec: 42, source: 'TDWR' },
  // MSY
  { id: 'TDWR-MSY-11-MBA',  apt: 'KMSY', rwy: '11',  qfu: 110, lat: 29.987, lng: -90.260, phenom: 'MBA',   corridor: 'ARR', section: 'RWY', lossKt: 44, ageSec: 28, source: 'TDWR' },
  // HOU
  { id: 'TDWR-HOU-4-WSL',   apt: 'KHOU', rwy: '4',   qfu: 39,  lat: 29.638, lng: -95.281, phenom: 'WSA-L', corridor: 'ARR', section: '1MF', lossKt: 26, ageSec: 70, source: 'TDWR' },
  // OKC
  { id: 'TDWR-OKC-17R-MBA', apt: 'KOKC', rwy: '17R', qfu: 175, lat: 35.404, lng: -97.602, phenom: 'MBA',   corridor: 'ARR', section: '2MF', lossKt: 31, ageSec: 80, source: 'TDWR' },
  // TUL
  { id: 'TDWR-TUL-18L-WSG', apt: 'KTUL', rwy: '18L', qfu: 175, lat: 36.197, lng: -95.886, phenom: 'WSA-G', corridor: 'DEP', section: '2MF', lossKt:-15, ageSec: 95, source: 'LLWAS-NE' },
  // ICT
  { id: 'TDWR-ICT-1R-MBA',  apt: 'KICT', rwy: '1R',  qfu: 12,  lat: 37.640, lng: -97.435, phenom: 'MBA',   corridor: 'ARR', section: '1MF', lossKt: 33, ageSec: 35, source: 'TDWR' },
  // SDF
  { id: 'TDWR-SDF-17R-WSL', apt: 'KSDF', rwy: '17R', qfu: 175, lat: 38.190, lng: -85.736, phenom: 'WSA-L', corridor: 'ARR', section: '2MF', lossKt: 22, ageSec: 75, source: 'TDWR' },
  // CVG
  { id: 'TDWR-CVG-36L-MBA', apt: 'KCVG', rwy: '36L', qfu: 360, lat: 39.045, lng: -84.671, phenom: 'MBA',   corridor: 'ARR', section: 'RWY', lossKt: 41, ageSec: 30, source: 'TDWR' },
  // CMH
  { id: 'LLWAS-CMH-10L-WSL',apt: 'KCMH', rwy: '10L', qfu: 100, lat: 40.000, lng: -82.901, phenom: 'WSA-L', corridor: 'ARR', section: '1MF', lossKt: 28, ageSec: 22, source: 'LLWAS-NE' },
  // BWI
  { id: 'TDWR-BWI-15R-MBA', apt: 'KBWI', rwy: '15R', qfu: 154, lat: 39.181, lng: -76.668, phenom: 'MBA',   corridor: 'ARR', section: '1MF', lossKt: 35, ageSec: 48, source: 'TDWR' },
  // FLL
  { id: 'TDWR-FLL-10R-WSL', apt: 'KFLL', rwy: '10R', qfu: 100, lat: 26.066, lng: -80.176, phenom: 'WSA-L', corridor: 'ARR', section: '2MF', lossKt: 23, ageSec: 88, source: 'TDWR' },
  // PBI
  { id: 'TDWR-PBI-10L-MBA', apt: 'KPBI', rwy: '10L', qfu: 99,  lat: 26.681, lng: -80.103, phenom: 'MBA',   corridor: 'ARR', section: '2MF', lossKt: 30, ageSec: 65, source: 'TDWR' },
]

/* aircraft susceptibility — heavier aircraft handle wind-shear
   energy delta better due to higher mass / inertia */
type ACClass = 'HVY-Q' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
const ACCLASS_SUS: Record<ACClass, number> = { 'HVY-Q': 0.75, HVY: 0.85, NRW: 1.00, RGN: 1.15, BIZ: 1.05, TBP: 1.30 }
const ACCLASS_VREF: Record<ACClass, number> = { 'HVY-Q': 158, HVY: 148, NRW: 138, RGN: 130, BIZ: 122, TBP: 110 }

function classify(type?: string, category?: string): ACClass {
  const t = (type || '').toUpperCase()
  if (/^(A38|B74|B77W|B748|A340|A35K)/.test(t)) return 'HVY-Q'
  if (/^(B77|B78|A33|A34|A35|MD11|B767)/.test(t)) return 'HVY'
  if (/^(B73|B75|A31|A32|A20|A21)/.test(t)) return 'NRW'
  if (/^(CRJ|E17|E19|E29|RJ|DH4)/.test(t)) return 'RGN'
  if (/^(GLF|GL|G2|G3|G4|G5|G6|G7|FA|F2T|F8X|F900|CL3|CL6|HDJ)/.test(t)) return 'BIZ'
  if (/^(ATR|AT4|AT7|DH8|SF3|J32|BE)/.test(t)) return 'TBP'
  if (category === '5' || category === '6') return 'HVY'
  return 'NRW'
}

interface Row {
  f: SFlight
  cls: ACClass
  apt?: { icao: string }
  prod?: TdwrProduct
  distNm: number
  alignDeg: number
  corridor?: Corridor
  phase: Phase
  decay: number
  lossEff: number     // age-adjusted loss kt
  energyMargin: number // kt of Vref tolerance vs |loss|
  cor: number; los: number; sec: number; rec: number; sus: number; ene: number
  driver: 'COR' | 'LOS' | 'SEC' | 'REC' | 'SUS' | 'ENE' | 'NONE'
  score: number
  tier: Tier
}

function distNm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3440.065
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180
  const sa = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(sa), Math.sqrt(1 - sa))
}
function bearingDeg(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const y = Math.sin(dLng) * Math.cos(la2)
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng)
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360
}
function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)) }
function map01(n: number, a: number, b: number) { if (a === b) return 0; return Math.max(0, Math.min(1, (n - a) / (b - a))) }

const SRC_HALO = 'tdwr-halo'; const LYR_HALO = 'tdwr-halo-l'
const SRC_LBL = 'tdwr-lbl'; const LYR_LBL = 'tdwr-lbl-l'
const SRC_PIN = 'tdwr-pin'; const LYR_PIN = 'tdwr-pin-l'
const SRC_PROD = 'tdwr-prod'; const LYR_PROD = 'tdwr-prod-l'
const SRC_PLBL = 'tdwr-plbl'; const LYR_PLBL = 'tdwr-plbl-l'
const SRC_CORR = 'tdwr-corr'; const LYR_CORR = 'tdwr-corr-l'
const SRC_LINK = 'tdwr-link'; const LYR_LINK = 'tdwr-link-l'
const SRC_REF = 'tdwr-ref'; const LYR_REF = 'tdwr-ref-l'

export default function TdwrLlwas({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'PRODUCTS' | 'AIRPORTS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [phenomFilter, setPhenomFilter] = useState<Phenom | 'ALL'>('ALL')
  const [query, setQuery] = useState('')
  const [maxAGL, setMaxAGL] = useState(8000)
  const [scopeNm, setScopeNm] = useState(30)
  const [alignDeg, setAlignDeg] = useState(35)
  const [decayMul, setDecayMul] = useState(100)
  const [lossMul, setLossMul] = useState(100)
  const [secMul, setSecMul] = useState(100)
  const [phaseWt, setPhaseWt] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showProd, setShowProd] = useState(true)
  const [showCorr, setShowCorr] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showRef, setShowRef] = useState(false)
  const [showDiag, setShowDiag] = useState(true)

  const active = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const cls = classify(f.type, f.category)
      // phase from altitude AGL proxy and vertical rate
      let phase: Phase = 'OTHER'
      if (f.ground) phase = 'GND'
      else if (f.altitudeFt < 200 && Math.abs(f.vertRate) < 600) phase = 'FLARE'
      else if (f.altitudeFt < 1500 && f.vertRate < -200) phase = 'SHRT-FNL'
      else if (f.altitudeFt < maxAGL && f.vertRate < -200) phase = 'APP'
      else if (f.altitudeFt < 1500 && f.vertRate > 300) phase = 'DEP-INIT'
      else if (f.altitudeFt < maxAGL && f.vertRate > 300) phase = 'DEP'
      else phase = 'OTHER'

      // nearest TDWR product within scope, aligned within alignDeg of QFU
      let best: { p: TdwrProduct; d: number; brg: number; align: number; cor: Corridor } | undefined
      for (const p of PRODUCTS) {
        if (phenomFilter !== 'ALL' && p.phenom !== phenomFilter) continue
        const d = distNm(f, p)
        if (d > scopeNm) continue
        const brg = bearingDeg(p, f) // bearing from threshold to aircraft
        // For arrival corridor: aircraft is roughly along extended centreline reciprocal of QFU
        const recip = (p.qfu + 180) % 360
        const arrAlign = Math.abs(((brg - recip + 540) % 360) - 180)
        const depAlign = Math.abs(((brg - p.qfu + 540) % 360) - 180)
        const cor: Corridor = arrAlign < depAlign ? 'ARR' : 'DEP'
        const align = Math.min(arrAlign, depAlign)
        if (align > alignDeg) continue
        // must match product corridor type (don't credit dep product to arr aircraft)
        if (cor !== p.corridor) continue
        // for arr we want aircraft descending / final; for dep want climbing
        if (cor === 'ARR' && (phase === 'DEP' || phase === 'DEP-INIT')) continue
        if (cor === 'DEP' && (phase === 'APP' || phase === 'SHRT-FNL' || phase === 'FLARE')) continue
        if (!best || d < best.d) best = { p, d, brg, align, cor }
      }

      const decay = best ? Math.exp(-best.p.ageSec / Math.max(15, PHENOM_TAU_S[best.p.phenom] * (decayMul / 100))) : 0
      const lossEff = best ? Math.abs(best.p.lossKt) * decay * (lossMul / 100) : 0
      const vref = ACCLASS_VREF[cls]
      const energyMargin = best ? Math.max(0, 0.18 * vref - lossEff * ACCLASS_SUS[cls]) : vref

      // drivers
      const cor = best ? clamp(map01(scopeNm - best.d, 0, scopeNm) * 100, 0, 100) : 0
      // LOS: loss magnitude scaled
      const los = best ? clamp(lossEff / 50 * 100, 0, 100) : 0
      // SEC: corridor section weight × decay
      const sec = best ? SECTION_WEIGHT[best.p.section] * decay * (secMul / 100) : 0
      // REC: recency (1-age/tau curve)
      const rec = best ? clamp(decay * 95, 0, 100) : 0
      // SUS: airframe susceptibility × loss
      const sus = best ? clamp(ACCLASS_SUS[cls] * Math.abs(best.p.lossKt) / 50 * 100, 0, 100) : 0
      // ENE: energy margin deficit
      const ene = best ? clamp(100 - (energyMargin / Math.max(1, 0.18 * vref)) * 100, 0, 100) : 0

      let score = Math.max(cor * 0.55, los * 1.10, sec * 0.95, rec * 0.70, sus * 0.85, ene * 1.05)
      score = score * (PHASE_MUL[phase] * (phaseWt / 100))
      score = clamp(score, 0, 100)

      let driver: Row['driver'] = 'NONE'
      const mx = Math.max(cor, los, sec, rec, sus, ene)
      if (mx === ene && ene > 0) driver = 'ENE'
      else if (mx === los && los > 0) driver = 'LOS'
      else if (mx === sus && sus > 0) driver = 'SUS'
      else if (mx === sec && sec > 0) driver = 'SEC'
      else if (mx === rec && rec > 0) driver = 'REC'
      else if (mx === cor && cor > 0) driver = 'COR'

      let tier: Tier
      if (!best) tier = 'IDLE'
      else if (score >= 80 && best.p.phenom === 'MBA' && (phase === 'FLARE' || phase === 'SHRT-FNL' || phase === 'APP' || phase === 'DEP-INIT')) tier = 'GO-AROUND'
      else if (score >= 55) tier = 'CAUTION'
      else if (score >= 35) tier = 'COORD'
      else if (score >= 18) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, cls,
        apt: best ? { icao: best.p.apt } : undefined,
        prod: best?.p, distNm: best?.d ?? 999, alignDeg: best?.align ?? 999,
        corridor: best?.cor, phase, decay, lossEff, energyMargin,
        cor, los, sec, rec, sus, ene, driver, score, tier,
      })
    }
    return out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [flights, maxAGL, scopeNm, alignDeg, decayMul, lossMul, secMul, phaseWt, phenomFilter])

  const tierCount: Record<Tier, number> = { 'GO-AROUND': 0, CAUTION: 0, COORD: 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const r of active) tierCount[r.tier]++
  const worst = active[0]
  const inScope = active.filter(r => r.prod)
  const meanLoss = inScope.length ? inScope.reduce((s, r) => s + r.lossEff, 0) / inScope.length : 0
  const meanMargin = inScope.length ? inScope.reduce((s, r) => s + r.energyMargin, 0) / inScope.length : 0
  const mbaHits = active.filter(r => r.prod?.phenom === 'MBA' && r.tier !== 'OK' && r.tier !== 'IDLE').length
  const activeProducts = PRODUCTS.filter(p => Math.exp(-p.ageSec / Math.max(15, PHENOM_TAU_S[p.phenom] * (decayMul / 100))) >= 0.10).length

  const filtered = active.filter(r => {
    if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
    if (query) {
      const q = query.toLowerCase()
      const hay = `${r.f.callsign || ''} ${r.f.icao} ${r.f.type || ''} ${r.prod?.id || ''} ${r.prod?.apt || ''} ${r.prod?.phenom || ''} ${r.prod?.rwy || ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  /* per-product rollup */
  const productRows = useMemo(() => {
    const m = new Map<string, { p: TdwrProduct; ac: number; ga: number; caut: number; coord: number; meanScore: number; decay: number; worst?: Row }>()
    for (const p of PRODUCTS) {
      const decay = Math.exp(-p.ageSec / Math.max(15, PHENOM_TAU_S[p.phenom] * (decayMul / 100)))
      m.set(p.id, { p, ac: 0, ga: 0, caut: 0, coord: 0, meanScore: 0, decay })
    }
    for (const r of active) {
      if (r.prod) {
        const e = m.get(r.prod.id)!
        e.ac++
        if (r.tier === 'GO-AROUND') e.ga++
        if (r.tier === 'CAUTION') e.caut++
        if (r.tier === 'COORD') e.coord++
        e.meanScore += r.score
        if (!e.worst || r.score > e.worst.score) e.worst = r
      }
    }
    const out = Array.from(m.values()).map(v => ({ ...v, meanScore: v.ac ? v.meanScore / v.ac : 0 }))
    return out.sort((a, b) => b.ga - a.ga || b.ac - a.ac || b.meanScore - a.meanScore)
  }, [active, decayMul])

  const airportRows = useMemo(() => {
    const m = new Map<string, { icao: string; products: TdwrProduct[]; ac: number; ga: number; caut: number; meanScore: number; worst?: Row }>()
    for (const p of PRODUCTS) {
      if (!m.has(p.apt)) m.set(p.apt, { icao: p.apt, products: [], ac: 0, ga: 0, caut: 0, meanScore: 0 })
      m.get(p.apt)!.products.push(p)
    }
    for (const r of active) {
      if (r.prod) {
        const e = m.get(r.prod.apt)!
        e.ac++
        if (r.tier === 'GO-AROUND') e.ga++
        if (r.tier === 'CAUTION') e.caut++
        e.meanScore += r.score
        if (!e.worst || r.score > e.worst.score) e.worst = r
      }
    }
    const out = Array.from(m.values()).map(v => ({ ...v, meanScore: v.ac ? v.meanScore / v.ac : 0 }))
    return out.sort((a, b) => b.ga - a.ga || b.caut - a.caut || b.ac - a.ac)
  }, [active])

  useEffect(() => {
    if (!map) return
    for (const [src, lyr, type, paint, layout] of ([
      [SRC_REF, LYR_REF, 'line', { 'line-color': '#0ea5e955', 'line-width': 0.5, 'line-dasharray': [3, 4] }, null],
      [SRC_CORR, LYR_CORR, 'line', { 'line-color': ['get', 'color'], 'line-width': 1, 'line-dasharray': [4, 3], 'line-opacity': 0.55 }, null],
      [SRC_LINK, LYR_LINK, 'line', { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-dasharray': [2, 2], 'line-opacity': 0.85 }, null],
      [SRC_PROD, LYR_PROD, 'circle', { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 4, 9, 9], 'circle-color': ['get', 'color'], 'circle-opacity': ['get', 'opacity'], 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 0.8 }, null],
      [SRC_HALO, LYR_HALO, 'circle', { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.28, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.2, 'circle-stroke-opacity': 0.85 }, null],
      [SRC_PIN, LYR_PIN, 'circle', { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1 }, null],
      [SRC_PLBL, LYR_PLBL, 'symbol', { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 }, { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, -1.4], 'text-allow-overlap': true }],
      [SRC_LBL, LYR_LBL, 'symbol', { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.4 }, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-allow-overlap': true }],
    ] as Array<[string, string, string, any, any]>)) {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      if (!map.getLayer(lyr)) {
        const def: any = { id: lyr, type, source: src, paint }
        if (layout) def.layout = layout
        map.addLayer(def)
      }
    }
    const prod: any[] = []; const plbl: any[] = []; const halo: any[] = []; const pin: any[] = []; const link: any[] = []; const corr: any[] = []; const lbl: any[] = []; const ref: any[] = []

    if (showProd) {
      for (const p of PRODUCTS) {
        if (phenomFilter !== 'ALL' && p.phenom !== phenomFilter) continue
        const decay = Math.exp(-p.ageSec / Math.max(15, PHENOM_TAU_S[p.phenom] * (decayMul / 100)))
        if (decay < 0.10) continue
        const color = PHENOM_COLOR[p.phenom]
        prod.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { color, opacity: 0.35 + 0.55 * decay } })
        plbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { color, label: `${p.apt} ${p.rwy} ${p.phenom} ${p.lossKt > 0 ? '−' : '+'}${Math.abs(p.lossKt)}kt ${p.section}` } })
        if (showCorr) {
          // dashed extended-centreline visualisation 3 NM each way
          const recip = (p.qfu + 180) % 360
          const proj = (brg: number, nm: number) => {
            const R = 3440.065
            const br = brg * Math.PI / 180
            const la1 = p.lat * Math.PI / 180, lo1 = p.lng * Math.PI / 180
            const dr = nm / R
            const la2 = Math.asin(Math.sin(la1) * Math.cos(dr) + Math.cos(la1) * Math.sin(dr) * Math.cos(br))
            const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(dr) * Math.cos(la1), Math.cos(dr) - Math.sin(la1) * Math.sin(la2))
            return [((lo2 * 180 / Math.PI + 540) % 360) - 180, la2 * 180 / Math.PI]
          }
          const tip = proj(p.corridor === 'ARR' ? recip : p.qfu, 3)
          corr.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[p.lng, p.lat], tip] }, properties: { color } })
        }
      }
    }
    for (const r of active) {
      const color = TIER_COLOR[r.tier]
      if (showHalo && r.tier !== 'OK' && r.tier !== 'IDLE') {
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, r: 8 + r.score * 0.14 } })
      }
      if (showPin && (r.tier === 'GO-AROUND' || r.tier === 'CAUTION')) {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color } })
      }
      if (showLbl && r.tier !== 'OK' && r.tier !== 'IDLE') {
        const lab = `${r.f.callsign || r.f.icao} · ${r.tier}${r.prod ? ' · ' + r.prod.phenom + ' ' + Math.round(r.lossEff) + 'kt' : ''}`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { label: lab, color } })
      }
      if (showLink && r.prod && r.tier !== 'OK' && r.tier !== 'IDLE') {
        link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.prod.lng, r.prod.lat]] }, properties: { color } })
      }
    }
    if (showRef) {
      for (const lat of [60, 30, 0, -30, -60]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, lat])
        ref.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} })
      }
    }
    ;(map.getSource(SRC_PROD) as any).setData({ type: 'FeatureCollection', features: prod })
    ;(map.getSource(SRC_PLBL) as any).setData({ type: 'FeatureCollection', features: plbl })
    ;(map.getSource(SRC_CORR) as any).setData({ type: 'FeatureCollection', features: corr })
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: ref })
    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PLBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_PROD, LYR_CORR, LYR_REF]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_LBL, SRC_PLBL, SRC_PIN, SRC_LINK, SRC_PROD, SRC_CORR, SRC_REF]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, active, showHalo, showPin, showLbl, showProd, showCorr, showLink, showRef, decayMul, phenomFilter])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const drvBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const advice = (r: Row) => {
    if (!r.prod) return 'No active TDWR / LLWAS product within scope · monitor ATIS for terminal wind-shear advisory'
    const p = r.prod
    if (r.tier === 'GO-AROUND') return `MICROBURST ALERT ${p.rwy} · ${Math.abs(p.lossKt)} kt loss ${p.section} · execute go-around per AC 00-54 · request escape vector · file ASRS / file PIREP per AIM 7-1-23`
    if (r.tier === 'CAUTION') return `Wind-shear ${p.phenom} ${p.rwy} · ${Math.abs(p.lossKt)} kt ${p.lossKt > 0 ? 'loss' : 'gain'} ${p.section} · arm reactive WS / brief escape · stable approach gate per FCOM 5.10`
    if (r.tier === 'COORD') return `Pre-coord with tower · WS alert ${p.rwy} ${p.section} age ${p.ageSec}s · monitor ATIS letter cycle · brief F/O per AC 120-41A`
    if (r.tier === 'WATCH') return `Within TDWR ring · monitor ride · request ATIS update per JO 7110.65 §3-1-8`
    if (r.tier === 'OK') return 'Clear of active wind-shear corridor · nominal'
    return ''
  }

  /* Scatter: loss vs energy margin */
  const W = 280, H = 180
  const sx = (n: number) => 32 + (clamp(n, 0, 60) / 60) * (W - 42)
  const sy = (n: number) => H - 24 - clamp(n, 0, 30) / 30 * (H - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">TDWR / LLWAS-NE · Wind-Shear Monitor</div>
          <div className="text-[10px] text-slate-500">JO 7110.65 §3-1-8 · AC 00-54 / 120-41A · AIM 7-1-23 / 26 · ICAO Doc 9817</div>
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
          <div className="text-[9px] text-slate-500 uppercase">Mean loss</div>
          <div className="text-sm font-semibold" style={{ color: meanLoss >= 30 ? '#ef4444' : meanLoss >= 15 ? '#f59e0b' : '#10b981' }}>{meanLoss.toFixed(0)}kt</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">MBA hits</div>
          <div className="text-sm font-semibold" style={{ color: mbaHits > 0 ? '#ef4444' : '#10b981' }}>{mbaHits}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">GA share</div>
          <div className="text-xs font-semibold" style={{ color: (tierCount['GO-AROUND'] / Math.max(1, active.length)) >= 0.10 ? '#ef4444' : '#10b981' }}>{((tierCount['GO-AROUND'] / Math.max(1, active.length)) * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean margin</div>
          <div className="text-xs font-semibold" style={{ color: meanMargin <= 8 ? '#ef4444' : meanMargin <= 14 ? '#f59e0b' : '#10b981' }}>{meanMargin.toFixed(0)}kt</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Active prods</div>
          <div className="text-xs font-semibold text-sky-400">{activeProducts}</div>
        </div>
      </div>

      {showDiag && active.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            <rect x={sx(30)} y={sy(30)} width={sx(60) - sx(30)} height={sy(8) - sy(30)} fill="#ef444425" />
            <rect x={sx(15)} y={sy(30)} width={sx(30) - sx(15)} height={sy(14) - sy(30)} fill="#f59e0b22" />
            <line x1={sx(15)} y1={sy(0)} x2={sx(15)} y2={sy(30)} stroke="#475569" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(30)} y1={sy(0)} x2={sx(30)} y2={sy(30)} stroke="#f43f5e66" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(0)} y1={sy(14)} x2={sx(60)} y2={sy(14)} stroke="#f59e0b66" strokeWidth={0.5} strokeDasharray="3 3" />
            <text x={W / 2} y={H - 4} textAnchor="middle" fontSize="9" fill="#64748b">Effective loss (kt)</text>
            <text x={6} y={H / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H / 2})`}>Energy margin (kt)</text>
            {active.filter(r => r.prod).map((r, i) => (
              <circle key={i} cx={sx(r.lossEff)} cy={sy(r.energyMargin)} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['MAX-AGL', maxAGL, 1000, 15000, setMaxAGL, 'ft'],
            ['SCOPE', scopeNm, 5, 60, setScopeNm, 'nm'],
            ['ALIGN', alignDeg, 10, 60, setAlignDeg, '°'],
            ['DECAY', decayMul, 25, 250, setDecayMul, '%'],
            ['LOSS-MUL', lossMul, 50, 200, setLossMul, '%'],
            ['SEC-MUL', secMul, 50, 200, setSecMul, '%'],
            ['PHASE-WT', phaseWt, 50, 150, setPhaseWt, '%'],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[68px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[40px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['MBA', 'WSA-L', 'WSA-G', 'GFRT'] as Phenom[]).map(k => (
            <button key={k} onClick={() => setPhenomFilter(phenomFilter === k ? 'ALL' : k)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: phenomFilter === k ? PHENOM_COLOR[k] + '33' : '#0b1220', borderColor: phenomFilter === k ? PHENOM_COLOR[k] : '#1e293b', color: phenomFilter === k ? PHENOM_COLOR[k] : '#cbd5e1' }}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['PROD', showProd, setShowProd],
            ['CORR', showCorr, setShowCorr],
            ['LINK', showLink, setShowLink],
            ['REF', showRef, setShowRef],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, on, setter]: any) => (
            <button key={lab} onClick={() => setter(!on)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: on ? '#0ea5e933' : '#0b1220', borderColor: on ? '#0ea5e9' : '#1e293b', color: on ? '#0ea5e9' : '#94a3b8' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / apt / rwy / phenom" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'PRODUCTS', 'AIRPORTS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-1.5 text-[10px] font-semibold ${tab === t ? 'text-sky-400 bg-slate-800/50 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {tab === 'AIRCRAFT' && (
        <div className="divide-y divide-slate-800">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No aircraft match filters</div>}
          {filtered.map(r => (
            <div key={r.f.icao} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(r.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 truncate">{r.f.callsign || r.f.icao}</span>
                  <span className="text-[10px] text-slate-500 font-mono">{r.f.type || '—'}</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-300 bg-slate-800 border border-slate-700">{r.cls}</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono text-sky-300 bg-sky-500/10 border border-sky-500/40">{r.phase}</span>
                  {r.prod && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: PHENOM_COLOR[r.prod.phenom], backgroundColor: PHENOM_COLOR[r.prod.phenom] + '1a', border: `1px solid ${PHENOM_COLOR[r.prod.phenom]}66` }}>{r.prod.phenom}</span>}
                </div>
                {tierBadge(r.tier)}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                {r.prod ? `${r.prod.apt}/${r.prod.rwy} · ${r.corridor} · ${r.prod.section} · ${r.distNm.toFixed(1)}nm · align ${r.alignDeg.toFixed(0)}° · ${r.prod.lossKt > 0 ? '−' : '+'}${Math.abs(r.prod.lossKt)}kt nom / ` : 'no scope · '}
                <span style={{ color: r.lossEff >= 30 ? '#ef4444' : r.lossEff >= 15 ? '#f59e0b' : '#10b981' }}>{r.lossEff.toFixed(0)}kt eff</span>
                {' / margin '}<span style={{ color: r.energyMargin <= 8 ? '#ef4444' : r.energyMargin <= 14 ? '#f59e0b' : '#10b981' }}>{r.energyMargin.toFixed(0)}kt</span>
                {r.prod && ` · age ${r.prod.ageSec}s decay ${(r.decay * 100).toFixed(0)}%`}
              </div>
              <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} /></div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {drvBadge('COR', r.cor)}
                {drvBadge('LOS', r.los)}
                {drvBadge('SEC', r.sec)}
                {drvBadge('REC', r.rec)}
                {drvBadge('SUS', r.sus)}
                {drvBadge('ENE', r.ene)}
              </div>
              <div className="text-[10px] mt-1" style={{ color: TIER_COLOR[r.tier] }}>{advice(r)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'PRODUCTS' && (
        <div className="divide-y divide-slate-800">
          {productRows.map((e, i) => (
            <div key={i} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => e.worst && onFly(e.worst.f.icao)} style={{ borderLeft: `3px solid ${PHENOM_COLOR[e.p.phenom]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 font-mono">{e.p.id}</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: PHENOM_COLOR[e.p.phenom], backgroundColor: PHENOM_COLOR[e.p.phenom] + '1a', border: `1px solid ${PHENOM_COLOR[e.p.phenom]}66` }}>{e.p.phenom}</span>
                  <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] text-slate-300 bg-slate-800 border border-slate-700 font-mono">{e.p.source}</span>
                </div>
                <div className="text-[10px] text-slate-400">{e.ac} ac</div>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                {e.p.apt} {e.p.rwy} · QFU {e.p.qfu}° · {e.p.corridor} · {e.p.section} · {e.p.lossKt > 0 ? '−' : '+'}{Math.abs(e.p.lossKt)}kt · age {e.p.ageSec}s · decay <span style={{ color: e.decay >= 0.6 ? '#ef4444' : e.decay >= 0.3 ? '#f59e0b' : '#0ea5e9' }}>{(e.decay * 100).toFixed(0)}%</span>
              </div>
              <div className="flex items-center gap-2 mt-1">
                {e.ga > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-rose-400 bg-rose-500/10 border border-rose-500/40">GA {e.ga}</span>}
                {e.caut > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: '#f43f5e', backgroundColor: '#f43f5e1a', border: '1px solid #f43f5e66' }}>CAUT {e.caut}</span>}
                {e.coord > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/40">COORD {e.coord}</span>}
                <div className="flex-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${e.meanScore}%`, backgroundColor: e.meanScore >= 80 ? '#ef4444' : e.meanScore >= 55 ? '#f59e0b' : e.meanScore >= 25 ? '#0ea5e9' : '#10b981' }} /></div>
                <span className="text-[10px] text-slate-400 tabular-nums w-8 text-right">{e.meanScore.toFixed(0)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'AIRPORTS' && (
        <div className="divide-y divide-slate-800">
          {airportRows.map((b, i) => (
            <div key={i} className="px-3 py-2" style={{ borderLeft: `3px solid ${b.ga > 0 ? '#ef4444' : b.caut > 0 ? '#f43f5e' : '#0ea5e9'}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-slate-100 font-mono">{b.icao}</span>
                  <span className="text-[10px] text-slate-500">{b.products.length} prods</span>
                </div>
                <div className="text-[10px] text-slate-400">{b.ac} ac</div>
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5 font-mono">{Array.from(new Set(b.products.map(p => p.rwy))).join(' / ')}</div>
              <div className="flex items-center gap-2 mt-1">
                {b.ga > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-rose-400 bg-rose-500/10 border border-rose-500/40">GA {b.ga}</span>}
                {b.caut > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: '#f43f5e', backgroundColor: '#f43f5e1a', border: '1px solid #f43f5e66' }}>CAUT {b.caut}</span>}
                <div className="flex-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${b.meanScore}%`, backgroundColor: b.meanScore >= 80 ? '#ef4444' : b.meanScore >= 55 ? '#f59e0b' : b.meanScore >= 25 ? '#0ea5e9' : '#10b981' }} /></div>
                <span className="text-[10px] text-slate-400 tabular-nums w-8 text-right">{b.meanScore.toFixed(0)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 leading-tight">
        FAA JO 7110.65 §3-1-8 LLWS/MBA · §2-6-3 hazardous wx · Order 6560.21 LLWAS-NE · 6560.20 TDWR · AC 00-54 / 120-41A · AIM 7-1-23 / 26 · ICAO Doc 9817 · Annex 3 App 2 §4.8 · NTSB AAR-86-05 DAL191 · AAR-94-04 USAir 1016 · MIT/LL TDWR FD AD-A210456
      </div>
    </div>
  )
}
