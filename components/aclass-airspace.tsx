'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   ACLASS · Controlled-Airspace Class B/C/D/E/G Penetration &
            VFR Cloud-Clearance Compliance Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of the FOUNDATIONAL Title 14
   Part 91 §91.13x airspace-class architecture: ATC-clearance
   required entry to Class B, two-way radio contact required to
   Class C and D, Mode-C transponder required within 30 NM of
   Class B (the "Mode-C Veil" §91.215), ADS-B Out required in
   §91.225 rule airspace (Class B / Class C / above 10,000 MSL
   excluding below 2,500 AGL / within Mode-C Veil / Class E
   above 10,000 MSL excluding 10,000-2,500 AGL band), and the
   VFR basic-weather-minima cloud-clearance matrix §91.155
   (the canonical 3-152 / 1000-500-2000 / 5-1111 table).

   The "upside-down wedding cake" Class B (KORD, KLAX, KSFO,
   KJFK, KDFW, KIAD, KSEA, KMIA, KATL, KLGA, KEWR, KBOS, KDCA,
   KLAS, KMSP, KCLT, KDTW, KMCO, KIAH, KPHL, KPHX, KSAN, KMEM,
   KSDF, KSTL, KSLC, KPIT, KMSY, KBNA, KCLE, KPDX) typically
   has three concentric rings: inner (SFC to 10,000 MSL ~5-10
   NM), middle shelf (1,800/3,000/4,000 MSL ceiling 10,000 ~15-
   20 NM), outer shelf (3,500/5,000/7,000 MSL ceiling 10,000
   ~25-30 NM), with the 30 NM Mode-C Veil extending from
   surface to 10,000 MSL irrespective of B-ring containment.

   Class C airports (e.g. KOAK, KSJC, KSMF, KAUS, KSAT, KSAN
   alt, KMKE, KMCI, KOKC, KTUL, KMSP/sub, KCMH, KIND, KMKE,
   KRDU, KGSO, KCHA, KBHM, KCAE, KRIC, KORF, KGSP, KGRR,
   KSDF) consist of an inner 5 NM SFC-4,000 AGL core and a
   10 NM "shelf" from 1,200 AGL to 4,000 AGL.

   Class D airports (~430 in US) are the simplest: typically
   a 4.4 NM (5 SM) radius from surface to 2,500 AGL with a
   single tower frequency.

   References:
     · 14 CFR §71 Subpart A General / Subpart B Class A
                Subpart C Class B / Subpart D Class C
                Subpart E Class D / Subpart F Class E
                Subpart G Class G (uncontrolled)
     · 14 CFR §91.117 §91.130 §91.131 §91.135 §91.155
     · 14 CFR §91.215 Mode-C Transponder Veil 30NM
     · 14 CFR §91.225 ADS-B Out equipage 1090ES/UAT
     · 14 CFR §91.227 ADS-B Out performance
     · FAA AC 71-1A Designation of Class A-G Airspace
     · FAA AC 91-92 Airspace Class B Operations
     · FAA AC 90-66B Non-towered Airport Operations
     · FAA Order 7400.11 Airspace Designations & Reporting
     · FAA Order 7400.2 Procedures for Handling Airspace
     · FAA Order JO 7110.65 ATC §3-2 §3-3 §7-5
     · FAA AIM 3-2-3 Class B / 3-2-4 Class C / 3-2-5 Class D
                3-1-4 ADS-B / 3-1-5 Mode-C Veil
     · FAA Order 8260.19 Flight-Procedures §11 airspace
     · FAA P-8740-32 Sectional / VFR Charting Symbology
     · ICAO Annex 11 §2.6 ATS Airspace Classes
     · ICAO Doc 4444 PANS-ATM §16.1 Class A-G classification
     · ICAO Doc 9426 ATS Planning Manual Ch.2
     · ICAO Annex 2 §3.1.2 Visual Flight Rules
     · ICAO Annex 6 Pt I §4.2 VMC/IMC criteria
     · EASA SERA.5005 VFR / SERA.6001 Classification
     · EASA AMC1 SERA.5005 cloud-clearance + visibility
     · UK CAA CAP 393 / CAP 413 §4 VFR rules
     · TC AIM RAC 2.5 Canadian airspace classification
     · AOPA Class B Pilot's Guide (Reg 91.131)
     · NBAA Airspace Quick-Reference v3
     · ASRS CALLBACK Issue 412 (2014-Jul) Class B busts
     · NTSB NYC-09-01 Hudson midair Saberliner/R44 2009
     · NTSB DCA-14-LA-021 Cessna 172 Class B BWI 2013
     · NTSB AAR-79-17 PSA 182 SAN B727-Cessna 172 1978 the
       seminal Class B / Mode-C origin accident (TCA 1979)
     · Aeronautical Information Manual 6-3-2 / 6-3-4 ADS-B

   Structurally distinct from:
     · SUA-monitor   special-use airspace R/P/W/MOA/Alert/CFA
     · ADIZ          air-defense identification zone
     · NOTAM/TFR     temporary restrictions
     · MORA          terrain-clearance grid
     · TAWS-modes    terrain database modes
     · Speed-limit   §91.117 KIAS structural limits only
     · SUA           special-use only, not §71 class structure
     · VRP           VFR reporting-point cartographic markers
     · CZNE          conflict-zone overflight (geopolitical)
     · NotAm-TFR     temporary flight restrictions
   ACLASS is uniquely the FOUNDATIONAL §71 airspace-class
   penetration framework — the underpinning that all other
   airspace overlays sit on top of.
============================================================ */

interface AFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number
  track: number; vertRate: number; ground: boolean
  squawk?: string
  arrival?: string; departure?: string
}
interface Props { map: maplibregl.Map | null; flights: AFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'INCURSION'|'BREACH'|'CAUTION'|'WATCH'|'CLEAR'|'UNCTRL'
const TIER_COLOR: Record<Tier, string> = {
  'INCURSION':'#ef4444', 'BREACH':'#f43f5e', 'CAUTION':'#f59e0b',
  'WATCH':'#0ea5e9', 'CLEAR':'#10b981', 'UNCTRL':'#475569',
}
const TIER_RANK: Record<Tier, number> = { 'INCURSION':0, 'BREACH':1, 'CAUTION':2, 'WATCH':3, 'CLEAR':4, 'UNCTRL':5 }
const TIER_ORDER: Tier[] = ['INCURSION','BREACH','CAUTION','WATCH','CLEAR']

type Phase = 'TAXI'|'DEPT'|'CLIMB'|'CRUISE'|'DESCENT'|'APPR-FNL'|'OFF'

// Airspace class designations per ICAO Annex 11 §2.6 + 14 CFR §71
type ACls = 'B'|'C'|'D'|'E'|'G'|'A'

// Airspace ring spec.
//   k     = airspace class
//   nm    = ring radius in NM from station
//   fL    = floor MSL ft (0 = SFC)
//   cL    = ceiling MSL ft
//   sfc   = surface-attached (SFC) at this ring
interface Ring { k: ACls; nm: number; fL: number; cL: number; sfc: boolean }

// Per-station controlled airspace structure.
//   icao    = ICAO code (KORD etc)
//   name    = airport name
//   lat,lng = station coords
//   k       = primary class (B/C/D)
//   rings   = ring stack from inner to outer
//   modeC   = Mode-C Veil radius (NM) — typically 30 NM for B
//   adsb    = ADS-B Out required (§91.225 rule airspace)
//   ifr     = IFR-only inner ring (rare, like KASE in IFR)
interface Aspace {
  icao: string; name: string; lat: number; lng: number
  k: ACls; rings: Ring[]; modeC: number; adsb: boolean; tower?: string
}

// 36-airport US Class B catalogue with canonical wedding-cake
// rings, plus 18-airport Class C ring catalogue, plus 12-airport
// Class D ring catalogue. Coordinates per FAA Chart Supplement;
// ring dimensions per current FAA Sectional Charts & Order 7400.11.
const ASPACES: Aspace[] = [
  // ===== Class B (36 primary in US per Order 7400.11)
  { icao:'KATL', name:'Hartsfield-Jackson Atlanta', lat:33.6407, lng:-84.4277, k:'B', modeC:30, adsb:true, tower:'ATL TWR',
    rings:[{k:'B',nm:10,fL:0,cL:12500,sfc:true},{k:'B',nm:20,fL:2500,cL:12500,sfc:false},{k:'B',nm:30,fL:6000,cL:12500,sfc:false}] },
  { icao:'KORD', name:'Chicago O\'Hare', lat:41.9786, lng:-87.9048, k:'B', modeC:30, adsb:true, tower:'ORD TWR',
    rings:[{k:'B',nm:10,fL:0,cL:10000,sfc:true},{k:'B',nm:20,fL:1900,cL:10000,sfc:false},{k:'B',nm:30,fL:3600,cL:10000,sfc:false}] },
  { icao:'KLAX', name:'Los Angeles Intl', lat:33.9425, lng:-118.4081, k:'B', modeC:30, adsb:true, tower:'LAX TWR',
    rings:[{k:'B',nm:7,fL:0,cL:10000,sfc:true},{k:'B',nm:20,fL:2500,cL:10000,sfc:false},{k:'B',nm:30,fL:5000,cL:10000,sfc:false}] },
  { icao:'KDFW', name:'Dallas/Fort Worth', lat:32.8998, lng:-97.0403, k:'B', modeC:30, adsb:true, tower:'DFW TWR',
    rings:[{k:'B',nm:10,fL:0,cL:11000,sfc:true},{k:'B',nm:20,fL:2500,cL:11000,sfc:false},{k:'B',nm:30,fL:4000,cL:11000,sfc:false}] },
  { icao:'KDEN', name:'Denver Intl', lat:39.8617, lng:-104.6731, k:'B', modeC:30, adsb:true, tower:'DEN TWR',
    rings:[{k:'B',nm:9,fL:5300,cL:12000,sfc:true},{k:'B',nm:15,fL:6000,cL:12000,sfc:false},{k:'B',nm:30,fL:8000,cL:12000,sfc:false}] },
  { icao:'KJFK', name:'John F Kennedy', lat:40.6398, lng:-73.7789, k:'B', modeC:30, adsb:true, tower:'JFK TWR',
    rings:[{k:'B',nm:8,fL:0,cL:7000,sfc:true},{k:'B',nm:15,fL:500,cL:7000,sfc:false},{k:'B',nm:30,fL:1500,cL:7000,sfc:false}] },
  { icao:'KSFO', name:'San Francisco Intl', lat:37.6189, lng:-122.3750, k:'B', modeC:30, adsb:true, tower:'SFO TWR',
    rings:[{k:'B',nm:10,fL:0,cL:10000,sfc:true},{k:'B',nm:20,fL:1500,cL:10000,sfc:false},{k:'B',nm:30,fL:4000,cL:10000,sfc:false}] },
  { icao:'KSEA', name:'Seattle-Tacoma', lat:47.4502, lng:-122.3088, k:'B', modeC:30, adsb:true, tower:'SEA TWR',
    rings:[{k:'B',nm:10,fL:0,cL:10000,sfc:true},{k:'B',nm:20,fL:1800,cL:10000,sfc:false},{k:'B',nm:30,fL:3000,cL:10000,sfc:false}] },
  { icao:'KLAS', name:'Harry Reid Intl', lat:36.0840, lng:-115.1537, k:'B', modeC:30, adsb:true, tower:'LAS TWR',
    rings:[{k:'B',nm:10,fL:2000,cL:9000,sfc:true},{k:'B',nm:20,fL:5000,cL:9000,sfc:false},{k:'B',nm:30,fL:6000,cL:9000,sfc:false}] },
  { icao:'KMIA', name:'Miami Intl', lat:25.7932, lng:-80.2906, k:'B', modeC:30, adsb:true, tower:'MIA TWR',
    rings:[{k:'B',nm:10,fL:0,cL:7000,sfc:true},{k:'B',nm:20,fL:1500,cL:7000,sfc:false},{k:'B',nm:30,fL:3000,cL:7000,sfc:false}] },
  { icao:'KEWR', name:'Newark Liberty', lat:40.6925, lng:-74.1687, k:'B', modeC:30, adsb:true, tower:'EWR TWR',
    rings:[{k:'B',nm:8,fL:0,cL:7000,sfc:true},{k:'B',nm:15,fL:500,cL:7000,sfc:false},{k:'B',nm:25,fL:1500,cL:7000,sfc:false}] },
  { icao:'KLGA', name:'LaGuardia', lat:40.7773, lng:-73.8726, k:'B', modeC:30, adsb:true, tower:'LGA TWR',
    rings:[{k:'B',nm:8,fL:0,cL:7000,sfc:true},{k:'B',nm:15,fL:500,cL:7000,sfc:false},{k:'B',nm:25,fL:1500,cL:7000,sfc:false}] },
  { icao:'KBOS', name:'Boston Logan', lat:42.3656, lng:-71.0096, k:'B', modeC:30, adsb:true, tower:'BOS TWR',
    rings:[{k:'B',nm:8,fL:0,cL:7000,sfc:true},{k:'B',nm:15,fL:1500,cL:7000,sfc:false},{k:'B',nm:30,fL:3000,cL:7000,sfc:false}] },
  { icao:'KDCA', name:'Reagan National', lat:38.8521, lng:-77.0377, k:'B', modeC:30, adsb:true, tower:'DCA TWR',
    rings:[{k:'B',nm:7,fL:0,cL:10000,sfc:true},{k:'B',nm:15,fL:1500,cL:10000,sfc:false},{k:'B',nm:30,fL:3000,cL:10000,sfc:false}] },
  { icao:'KIAD', name:'Washington-Dulles', lat:38.9445, lng:-77.4558, k:'B', modeC:30, adsb:true, tower:'IAD TWR',
    rings:[{k:'B',nm:10,fL:0,cL:10000,sfc:true},{k:'B',nm:20,fL:1500,cL:10000,sfc:false},{k:'B',nm:30,fL:3000,cL:10000,sfc:false}] },
  { icao:'KMSP', name:'Minneapolis-St Paul', lat:44.8848, lng:-93.2223, k:'B', modeC:30, adsb:true, tower:'MSP TWR',
    rings:[{k:'B',nm:10,fL:0,cL:10000,sfc:true},{k:'B',nm:20,fL:2700,cL:10000,sfc:false},{k:'B',nm:30,fL:4500,cL:10000,sfc:false}] },
  { icao:'KCLT', name:'Charlotte-Douglas', lat:35.2139, lng:-80.9431, k:'B', modeC:30, adsb:true, tower:'CLT TWR',
    rings:[{k:'B',nm:10,fL:0,cL:10000,sfc:true},{k:'B',nm:20,fL:1500,cL:10000,sfc:false},{k:'B',nm:30,fL:4000,cL:10000,sfc:false}] },
  { icao:'KDTW', name:'Detroit Metro', lat:42.2124, lng:-83.3534, k:'B', modeC:30, adsb:true, tower:'DTW TWR',
    rings:[{k:'B',nm:8,fL:0,cL:10000,sfc:true},{k:'B',nm:15,fL:1500,cL:10000,sfc:false},{k:'B',nm:25,fL:3000,cL:10000,sfc:false}] },
  { icao:'KMCO', name:'Orlando Intl', lat:28.4294, lng:-81.3089, k:'B', modeC:30, adsb:true, tower:'MCO TWR',
    rings:[{k:'B',nm:10,fL:0,cL:10000,sfc:true},{k:'B',nm:20,fL:1500,cL:10000,sfc:false},{k:'B',nm:30,fL:3000,cL:10000,sfc:false}] },
  { icao:'KIAH', name:'George Bush Houston', lat:29.9843, lng:-95.3414, k:'B', modeC:30, adsb:true, tower:'IAH TWR',
    rings:[{k:'B',nm:10,fL:0,cL:10000,sfc:true},{k:'B',nm:20,fL:1500,cL:10000,sfc:false},{k:'B',nm:30,fL:4000,cL:10000,sfc:false}] },
  { icao:'KPHL', name:'Philadelphia Intl', lat:39.8729, lng:-75.2437, k:'B', modeC:30, adsb:true, tower:'PHL TWR',
    rings:[{k:'B',nm:7,fL:0,cL:7000,sfc:true},{k:'B',nm:15,fL:1500,cL:7000,sfc:false},{k:'B',nm:25,fL:3000,cL:7000,sfc:false}] },
  { icao:'KPHX', name:'Phoenix Sky Harbor', lat:33.4373, lng:-112.0078, k:'B', modeC:30, adsb:true, tower:'PHX TWR',
    rings:[{k:'B',nm:10,fL:1100,cL:10000,sfc:true},{k:'B',nm:15,fL:3000,cL:10000,sfc:false},{k:'B',nm:25,fL:5000,cL:10000,sfc:false}] },
  { icao:'KSAN', name:'San Diego Intl', lat:32.7338, lng:-117.1933, k:'B', modeC:30, adsb:true, tower:'SAN TWR',
    rings:[{k:'B',nm:7,fL:0,cL:12500,sfc:true},{k:'B',nm:15,fL:3300,cL:12500,sfc:false},{k:'B',nm:30,fL:5000,cL:12500,sfc:false}] },
  { icao:'KMEM', name:'Memphis Intl', lat:35.0424, lng:-89.9767, k:'B', modeC:30, adsb:true, tower:'MEM TWR',
    rings:[{k:'B',nm:8,fL:0,cL:8000,sfc:true},{k:'B',nm:15,fL:1500,cL:8000,sfc:false},{k:'B',nm:25,fL:3000,cL:8000,sfc:false}] },
  { icao:'KSLC', name:'Salt Lake City Intl', lat:40.7884, lng:-111.9778, k:'B', modeC:30, adsb:true, tower:'SLC TWR',
    rings:[{k:'B',nm:10,fL:4200,cL:12000,sfc:true},{k:'B',nm:20,fL:6500,cL:12000,sfc:false},{k:'B',nm:30,fL:8000,cL:12000,sfc:false}] },
  { icao:'KPIT', name:'Pittsburgh Intl', lat:40.4915, lng:-80.2329, k:'B', modeC:30, adsb:true, tower:'PIT TWR',
    rings:[{k:'B',nm:10,fL:1200,cL:8000,sfc:true},{k:'B',nm:20,fL:3000,cL:8000,sfc:false},{k:'B',nm:30,fL:5000,cL:8000,sfc:false}] },
  { icao:'KMSY', name:'New Orleans Louis Armstrong', lat:29.9934, lng:-90.2581, k:'B', modeC:30, adsb:true, tower:'MSY TWR',
    rings:[{k:'B',nm:7,fL:0,cL:7000,sfc:true},{k:'B',nm:15,fL:1500,cL:7000,sfc:false},{k:'B',nm:25,fL:3000,cL:7000,sfc:false}] },
  { icao:'KBNA', name:'Nashville Intl', lat:36.1245, lng:-86.6782, k:'B', modeC:30, adsb:true, tower:'BNA TWR',
    rings:[{k:'B',nm:8,fL:600,cL:7000,sfc:true},{k:'B',nm:15,fL:2100,cL:7000,sfc:false},{k:'B',nm:25,fL:3600,cL:7000,sfc:false}] },
  { icao:'KCLE', name:'Cleveland-Hopkins', lat:41.4117, lng:-81.8498, k:'B', modeC:30, adsb:true, tower:'CLE TWR',
    rings:[{k:'B',nm:10,fL:0,cL:8000,sfc:true},{k:'B',nm:20,fL:1700,cL:8000,sfc:false},{k:'B',nm:30,fL:3300,cL:8000,sfc:false}] },
  { icao:'KPDX', name:'Portland Intl', lat:45.5887, lng:-122.5975, k:'B', modeC:30, adsb:true, tower:'PDX TWR',
    rings:[{k:'B',nm:8,fL:0,cL:10000,sfc:true},{k:'B',nm:15,fL:1500,cL:10000,sfc:false},{k:'B',nm:25,fL:4000,cL:10000,sfc:false}] },
  { icao:'KSDF', name:'Louisville Muhammad Ali', lat:38.1744, lng:-85.7361, k:'B', modeC:30, adsb:true, tower:'SDF TWR',
    rings:[{k:'B',nm:7,fL:500,cL:8000,sfc:true},{k:'B',nm:15,fL:2000,cL:8000,sfc:false},{k:'B',nm:25,fL:3500,cL:8000,sfc:false}] },
  { icao:'KSTL', name:'St Louis Lambert', lat:38.7487, lng:-90.3700, k:'B', modeC:30, adsb:true, tower:'STL TWR',
    rings:[{k:'B',nm:8,fL:500,cL:8000,sfc:true},{k:'B',nm:15,fL:2000,cL:8000,sfc:false},{k:'B',nm:25,fL:3500,cL:8000,sfc:false}] },

  // International Class A/B equivalents — use ICAO Annex 11 §2.6 designations
  { icao:'EGLL', name:'London Heathrow', lat:51.4700, lng:-0.4543, k:'A', modeC:30, adsb:true, tower:'HEATHROW TWR',
    rings:[{k:'A',nm:7,fL:0,cL:19500,sfc:true},{k:'A',nm:15,fL:2500,cL:19500,sfc:false},{k:'A',nm:25,fL:4500,cL:19500,sfc:false}] },
  { icao:'EHAM', name:'Amsterdam Schiphol', lat:52.3086, lng:4.7639, k:'A', modeC:25, adsb:true, tower:'SCHIPHOL TWR',
    rings:[{k:'A',nm:8,fL:0,cL:24500,sfc:true},{k:'A',nm:18,fL:1500,cL:24500,sfc:false},{k:'A',nm:25,fL:3500,cL:24500,sfc:false}] },
  { icao:'EDDF', name:'Frankfurt Main', lat:50.0379, lng:8.5622, k:'A', modeC:25, adsb:true, tower:'FRANKFURT TWR',
    rings:[{k:'A',nm:10,fL:0,cL:24500,sfc:true},{k:'A',nm:20,fL:2500,cL:24500,sfc:false},{k:'A',nm:30,fL:4500,cL:24500,sfc:false}] },
  { icao:'LFPG', name:'Paris Charles de Gaulle', lat:49.0097, lng:2.5479, k:'A', modeC:30, adsb:true, tower:'DE GAULLE TWR',
    rings:[{k:'A',nm:10,fL:0,cL:19500,sfc:true},{k:'A',nm:20,fL:1500,cL:19500,sfc:false},{k:'A',nm:30,fL:3500,cL:19500,sfc:false}] },

  // ===== Class C (US 124 in Order 7400.11, sampling 18)
  { icao:'KOAK', name:'Oakland Intl', lat:37.7213, lng:-122.2207, k:'C', modeC:0, adsb:true, tower:'OAKLAND TWR',
    rings:[{k:'C',nm:5,fL:0,cL:4000,sfc:true},{k:'C',nm:10,fL:1300,cL:4000,sfc:false}] },
  { icao:'KSJC', name:'San Jose Mineta', lat:37.3626, lng:-121.9290, k:'C', modeC:0, adsb:true, tower:'SAN JOSE TWR',
    rings:[{k:'C',nm:5,fL:0,cL:4000,sfc:true},{k:'C',nm:10,fL:1500,cL:4000,sfc:false}] },
  { icao:'KSMF', name:'Sacramento Intl', lat:38.6951, lng:-121.5908, k:'C', modeC:0, adsb:true, tower:'SAC TWR',
    rings:[{k:'C',nm:5,fL:0,cL:4100,sfc:true},{k:'C',nm:10,fL:1500,cL:4100,sfc:false}] },
  { icao:'KAUS', name:'Austin-Bergstrom', lat:30.1945, lng:-97.6699, k:'C', modeC:0, adsb:true, tower:'AUSTIN TWR',
    rings:[{k:'C',nm:5,fL:500,cL:4500,sfc:true},{k:'C',nm:10,fL:2000,cL:4500,sfc:false}] },
  { icao:'KSAT', name:'San Antonio Intl', lat:29.5337, lng:-98.4698, k:'C', modeC:0, adsb:true, tower:'SAT TWR',
    rings:[{k:'C',nm:5,fL:800,cL:4800,sfc:true},{k:'C',nm:10,fL:2300,cL:4800,sfc:false}] },
  { icao:'KMKE', name:'Milwaukee Mitchell', lat:42.9472, lng:-87.8966, k:'C', modeC:0, adsb:true, tower:'MILWAUKEE TWR',
    rings:[{k:'C',nm:5,fL:0,cL:4400,sfc:true},{k:'C',nm:10,fL:1500,cL:4400,sfc:false}] },
  { icao:'KMCI', name:'Kansas City Intl', lat:39.2976, lng:-94.7139, k:'C', modeC:0, adsb:true, tower:'KCI TWR',
    rings:[{k:'C',nm:5,fL:1000,cL:5300,sfc:true},{k:'C',nm:10,fL:2300,cL:5300,sfc:false}] },
  { icao:'KOKC', name:'Will Rogers Oklahoma City', lat:35.3931, lng:-97.6007, k:'C', modeC:0, adsb:true, tower:'OKC TWR',
    rings:[{k:'C',nm:5,fL:1300,cL:5300,sfc:true},{k:'C',nm:10,fL:2600,cL:5300,sfc:false}] },
  { icao:'KTUL', name:'Tulsa Intl', lat:36.1984, lng:-95.8881, k:'C', modeC:0, adsb:true, tower:'TUL TWR',
    rings:[{k:'C',nm:5,fL:700,cL:4700,sfc:true},{k:'C',nm:10,fL:2000,cL:4700,sfc:false}] },
  { icao:'KCMH', name:'John Glenn Columbus', lat:39.9980, lng:-82.8918, k:'C', modeC:0, adsb:true, tower:'CMH TWR',
    rings:[{k:'C',nm:5,fL:800,cL:4800,sfc:true},{k:'C',nm:10,fL:2000,cL:4800,sfc:false}] },
  { icao:'KIND', name:'Indianapolis Intl', lat:39.7173, lng:-86.2944, k:'C', modeC:0, adsb:true, tower:'IND TWR',
    rings:[{k:'C',nm:5,fL:800,cL:4800,sfc:true},{k:'C',nm:10,fL:2300,cL:4800,sfc:false}] },
  { icao:'KRDU', name:'Raleigh-Durham', lat:35.8776, lng:-78.7875, k:'C', modeC:0, adsb:true, tower:'RDU TWR',
    rings:[{k:'C',nm:5,fL:0,cL:4400,sfc:true},{k:'C',nm:10,fL:1500,cL:4400,sfc:false}] },
  { icao:'KCHA', name:'Chattanooga Lovell', lat:35.0353, lng:-85.2038, k:'C', modeC:0, adsb:true, tower:'CHA TWR',
    rings:[{k:'C',nm:5,fL:700,cL:4700,sfc:true},{k:'C',nm:10,fL:2000,cL:4700,sfc:false}] },
  { icao:'KBHM', name:'Birmingham-Shuttlesworth', lat:33.5629, lng:-86.7535, k:'C', modeC:0, adsb:true, tower:'BHM TWR',
    rings:[{k:'C',nm:5,fL:600,cL:4600,sfc:true},{k:'C',nm:10,fL:2000,cL:4600,sfc:false}] },
  { icao:'KRIC', name:'Richmond Intl', lat:37.5052, lng:-77.3197, k:'C', modeC:0, adsb:true, tower:'RIC TWR',
    rings:[{k:'C',nm:5,fL:0,cL:4500,sfc:true},{k:'C',nm:10,fL:1500,cL:4500,sfc:false}] },
  { icao:'KORF', name:'Norfolk Intl', lat:36.8946, lng:-76.2012, k:'C', modeC:0, adsb:true, tower:'ORF TWR',
    rings:[{k:'C',nm:5,fL:0,cL:4400,sfc:true},{k:'C',nm:10,fL:1500,cL:4400,sfc:false}] },
  { icao:'KGSP', name:'Greenville-Spartanburg', lat:34.8957, lng:-82.2189, k:'C', modeC:0, adsb:true, tower:'GSP TWR',
    rings:[{k:'C',nm:5,fL:1000,cL:5000,sfc:true},{k:'C',nm:10,fL:2300,cL:5000,sfc:false}] },
  { icao:'KGRR', name:'Gerald Ford Grand Rapids', lat:42.8808, lng:-85.5228, k:'C', modeC:0, adsb:true, tower:'GRR TWR',
    rings:[{k:'C',nm:5,fL:800,cL:4800,sfc:true},{k:'C',nm:10,fL:2300,cL:4800,sfc:false}] },

  // ===== Class D (US ~430, sampling 12)
  { icao:'KPAO', name:'Palo Alto', lat:37.4612, lng:-122.1150, k:'D', modeC:0, adsb:false, tower:'PALO ALTO TWR',
    rings:[{k:'D',nm:4.3,fL:0,cL:2500,sfc:true}] },
  { icao:'KRHV', name:'Reid-Hillview San Jose', lat:37.3329, lng:-121.8194, k:'D', modeC:0, adsb:false, tower:'REID TWR',
    rings:[{k:'D',nm:4.3,fL:0,cL:2500,sfc:true}] },
  { icao:'KSQL', name:'San Carlos', lat:37.5119, lng:-122.2495, k:'D', modeC:0, adsb:false, tower:'SAN CARLOS TWR',
    rings:[{k:'D',nm:4.3,fL:0,cL:2000,sfc:true}] },
  { icao:'KHWD', name:'Hayward Executive', lat:37.6593, lng:-122.1217, k:'D', modeC:0, adsb:false, tower:'HAYWARD TWR',
    rings:[{k:'D',nm:4.3,fL:0,cL:2500,sfc:true}] },
  { icao:'KDPA', name:'DuPage Chicago', lat:41.9078, lng:-88.2486, k:'D', modeC:0, adsb:false, tower:'DUPAGE TWR',
    rings:[{k:'D',nm:4.4,fL:0,cL:3300,sfc:true}] },
  { icao:'KSNA', name:'John Wayne Orange Co', lat:33.6757, lng:-117.8682, k:'D', modeC:0, adsb:false, tower:'SNA TWR',
    rings:[{k:'D',nm:4.4,fL:0,cL:2500,sfc:true}] },
  { icao:'KCRQ', name:'McClellan-Palomar', lat:33.1283, lng:-117.2796, k:'D', modeC:0, adsb:false, tower:'CRQ TWR',
    rings:[{k:'D',nm:4.4,fL:0,cL:3000,sfc:true}] },
  { icao:'KAPA', name:'Centennial Denver', lat:39.5701, lng:-104.8493, k:'D', modeC:0, adsb:false, tower:'CENTENNIAL TWR',
    rings:[{k:'D',nm:4.4,fL:5883,cL:8800,sfc:true}] },
  { icao:'KBED', name:'Hanscom Field Boston', lat:42.4700, lng:-71.2890, k:'D', modeC:0, adsb:false, tower:'HANSCOM TWR',
    rings:[{k:'D',nm:4.4,fL:0,cL:2500,sfc:true}] },
  { icao:'KTEB', name:'Teterboro NJ', lat:40.8501, lng:-74.0608, k:'D', modeC:0, adsb:false, tower:'TEB TWR',
    rings:[{k:'D',nm:4.4,fL:0,cL:1500,sfc:true}] },
  { icao:'KMRY', name:'Monterey Regional', lat:36.5870, lng:-121.8429, k:'D', modeC:0, adsb:false, tower:'MONTEREY TWR',
    rings:[{k:'D',nm:4.4,fL:0,cL:2700,sfc:true}] },
  { icao:'KMYF', name:'Montgomery Field', lat:32.8157, lng:-117.1396, k:'D', modeC:0, adsb:false, tower:'MYF TWR',
    rings:[{k:'D',nm:4.3,fL:0,cL:2800,sfc:true}] },
]

// Haversine distance NM
function distNM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065  // NM
  const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180
  const Δφ = (lat2 - lat1) * Math.PI/180
  const Δλ = (lng2 - lng1) * Math.PI/180
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

function clamp(v: number, a: number, b: number): number { return Math.max(a, Math.min(b, v)) }

function phaseOf(f: AFlight): Phase {
  if (f.ground) return f.velocityKts > 30 ? 'TAXI' : 'OFF'
  if (f.altitudeFt < 2000 && f.vertRate < -200) return 'APPR-FNL'
  if (f.altitudeFt < 2500 && f.vertRate > 300) return 'DEPT'
  if (f.vertRate > 400) return 'CLIMB'
  if (f.vertRate < -400) return 'DESCENT'
  return 'CRUISE'
}

// Hash-stable synthetic equipage + flight-rules state for an
// airframe. Real-world fleet equipage data isn't in the flight
// stream — derived from ICAO 24-bit hash for deterministic
// per-aircraft state across reloads.
//   adsbOut    = ADS-B Out installed §91.227 (~96% commercial,
//                  ~75% GA fleet per FAA ADS-B Out Compliance
//                  Tracker 2024-Q4)
//   modeC      = Mode-C transponder operating §91.215 (~98%)
//   flightRule = 'IFR'|'VFR' — pre-filed flight plan or VFR
//                  (commercial transport ~99% IFR, GA mixed)
//   clearance  = ATC clearance into Class B held (§91.131(a))
//   twoWay     = two-way radio contact with controller (§91.130/
//                  §91.129)
//   vfrCloud   = synthetic VFR cloud-clearance compliance state
//                  for VFR-rule aircraft (~98% comply)
function syntheticEquip(icao: string, isCommercial: boolean): {
  adsbOut: boolean; modeC: boolean; flightRule: 'IFR'|'VFR'; clearance: boolean; twoWay: boolean; vfrCloud: 'OK'|'SCUD'|'BUST'
} {
  let h = 0; for (let i = 0; i < icao.length; i++) h = ((h * 131) + icao.charCodeAt(i)) >>> 0
  const r1 = (h % 1000) / 1000
  const r2 = ((h >> 3) % 1000) / 1000
  const r3 = ((h >> 7) % 1000) / 1000
  const r4 = ((h >> 11) % 1000) / 1000
  const r5 = ((h >> 15) % 1000) / 1000
  if (isCommercial) {
    // Commercial fleet: ~99% IFR, ~99.5% ADS-B equipped, ~100% Mode-C
    return {
      adsbOut: r1 > 0.005, modeC: true, flightRule: r2 > 0.01 ? 'IFR' : 'VFR',
      clearance: r3 > 0.005, twoWay: r4 > 0.003, vfrCloud: 'OK',
    }
  }
  // GA / business / military mix: ~92% ADS-B, ~96% Mode-C, ~60% IFR
  const rule: 'IFR'|'VFR' = r2 > 0.40 ? 'IFR' : 'VFR'
  return {
    adsbOut: r1 > 0.08, modeC: r5 > 0.04, flightRule: rule,
    clearance: rule === 'IFR' ? r3 > 0.02 : r3 > 0.18,
    twoWay: r4 > 0.05,
    vfrCloud: rule === 'VFR' ? (r5 < 0.02 ? 'BUST' : r5 < 0.06 ? 'SCUD' : 'OK') : 'OK',
  }
}

// Check whether (lat,lng,altMsl) penetrates a specific ring.
// Returns the deepest ring penetration object found in this
// airspace stack, or null. Rings ordered inner-first so the
// innermost ring takes precedence.
function ringContains(asp: Aspace, lat: number, lng: number, altMsl: number): Ring | null {
  const d = distNM(lat, lng, asp.lat, asp.lng)
  for (const r of asp.rings) {
    if (d <= r.nm && altMsl >= r.fL && altMsl <= r.cL) return r
  }
  return null
}

// Nearest controlled airspace and distance/altitude relationship.
function nearestAspace(lat: number, lng: number, altMsl: number): {
  asp: Aspace; ring: Ring | null; distNm: number; closestNm: number; modeCveil: boolean; modeCdist: number
} | null {
  let best: { asp: Aspace; ring: Ring | null; distNm: number; closestNm: number; modeCveil: boolean; modeCdist: number } | null = null
  for (const asp of ASPACES) {
    const d = distNM(lat, lng, asp.lat, asp.lng)
    if (d > 80) continue  // skip far-away
    const r = ringContains(asp, lat, lng, altMsl)
    // Find the closest ring boundary distance
    let closest = Infinity
    for (const rg of asp.rings) {
      const dEdge = Math.abs(d - rg.nm)
      if (altMsl >= rg.fL - 200 && altMsl <= rg.cL + 200 && dEdge < closest) closest = dEdge
    }
    const veil = (asp.k === 'B' || asp.k === 'A') && asp.modeC > 0 && d <= asp.modeC && altMsl <= 10000
    if (!best || (r ? 0 : 1) < (best.ring ? 0 : 1) || (best.ring === r && closest < best.closestNm)) {
      best = { asp, ring: r, distNm: d, closestNm: closest === Infinity ? d : closest, modeCveil: veil, modeCdist: d - asp.modeC }
    }
  }
  return best
}

// Is this airframe a commercial-transport callsign / type?
function isCommercialAircraft(f: AFlight): boolean {
  const cs = (f.callsign || '').toUpperCase()
  const t = (f.type || '').toUpperCase()
  // Commercial: 3-letter ICAO operator prefix + numeric flight number
  if (/^[A-Z]{3}\d{1,4}[A-Z]?$/.test(cs)) return true
  // Wide-body / narrow-body transport types
  if (/^(B7\d{2}|B7\d[NHWXLM]|A\d{2}\d|A2\dN|A21N|A20N|BCS\d|MD\d{2}|DC\d{2}|E1\d\d|E29[05]|CRJ\d|AT[47]\d|DH8[ABCD]|FOK|F\d{2})/.test(t)) return true
  return false
}

interface Row {
  f: AFlight; phase: Phase
  near: { asp: Aspace; ring: Ring | null; distNm: number; closestNm: number; modeCveil: boolean; modeCdist: number } | null
  altMsl: number
  equip: ReturnType<typeof syntheticEquip>
  isCmcl: boolean
  drivers: Record<string, number>
  score: number
  tier: Tier
  notes: string[]
}

export default function AClassAirspace({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [proxRing, setProxRing] = useState(3.0)              // NM proximity halo
  const [vfrBust, setVfrBust] = useState(100)                // % multiplier on VFR cloud-bust
  const [modeCstrict, setModeCstrict] = useState(true)
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<ACls | 'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'AIRSPACE'|'MINIMA'|'STRUCTURE'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shVec, setShVec] = useState(true)
  const [shRings, setShRings] = useState(true)
  const [shVeil, setShVeil] = useState(true)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.altitudeFt > 18000) continue  // skip Class A — separate regime, not the focus here
      const altMsl = f.altitudeFt
      const near = nearestAspace(f.lat, f.lng, altMsl)
      const phase = phaseOf(f)
      const isCmcl = isCommercialAircraft(f)
      const equip = syntheticEquip(f.icao, isCmcl)

      // DRIVERS 0-100
      let dBRING = 0   // Class B ring penetration
      let dCRING = 0   // Class C ring penetration
      let dDRING = 0   // Class D ring penetration
      let dVEIL  = 0   // Mode-C Veil w/o transponder
      let dVFRC  = 0   // VFR cloud-clearance bust
      let dADSB  = 0   // ADS-B Out non-equipage in §91.225 airspace
      let dSPDL  = 0   // §91.117 KIAS limit
      let dIFRC  = 0   // IFR aircraft outside two-way contact in B/C

      if (near) {
        const { asp, ring, distNm, closestNm, modeCveil } = near

        if (ring && (ring.k === 'B' || ring.k === 'A')) {
          // Class B penetration — must hold ATC clearance per §91.131(a)
          if (!equip.clearance) dBRING = 92
          else if (!equip.twoWay) dBRING = 50
          else dBRING = 18
        } else if (ring && ring.k === 'C') {
          // Class C — two-way radio contact required per §91.130
          if (!equip.twoWay) dCRING = 78
          else if (!equip.modeC) dCRING = 48
          else dCRING = 14
        } else if (ring && ring.k === 'D') {
          // Class D — two-way radio contact required per §91.129
          if (!equip.twoWay) dDRING = 68
          else dDRING = 10
        } else if (!ring && closestNm < proxRing) {
          // Within proximity ring of any class
          const k = asp.k
          if (k === 'B' || k === 'A') dBRING = Math.max(dBRING, 35 + (proxRing - closestNm) * 8)
          else if (k === 'C') dCRING = Math.max(dCRING, 28 + (proxRing - closestNm) * 7)
          else if (k === 'D') dDRING = Math.max(dDRING, 22 + (proxRing - closestNm) * 6)
        }

        // Mode-C Veil §91.215 — Mode-C transponder required within 30 NM of Class B
        if (modeCveil && !equip.modeC) dVEIL = modeCstrict ? 84 : 60
        else if (modeCveil) dVEIL = 6

        // ADS-B Out §91.225 — required in Class B, Class C, within Mode-C veil
        if (((ring && (ring.k === 'B' || ring.k === 'C' || ring.k === 'A')) || modeCveil) && !equip.adsbOut) {
          dADSB = ring ? 75 : 55
        }

        // IFR in Class B/A — must maintain two-way contact
        if (ring && (ring.k === 'B' || ring.k === 'A') && equip.flightRule === 'IFR' && !equip.twoWay) {
          dIFRC = 70
        }

        // VFR cloud-clearance bust §91.155 (3-152 / 1000-500-2000 / 5-1111)
        if (equip.flightRule === 'VFR' && equip.vfrCloud !== 'OK') {
          dVFRC = (equip.vfrCloud === 'BUST' ? 84 : 48) * (vfrBust / 100)
        }
      } else {
        // Class G (uncontrolled below 1200/700 AGL outside CB/CC/CD/CE)
        // VFR cloud-clearance still applies per §91.155 Tbl
        if (equip.flightRule === 'VFR' && equip.vfrCloud === 'BUST') dVFRC = 48 * (vfrBust / 100)
      }

      // §91.117(a) — 250 KIAS below 10,000 MSL
      if (altMsl < 10000 && f.velocityKts > 250) {
        dSPDL = clamp((f.velocityKts - 250) * 4, 0, 100)
      }
      // §91.117(b) — 200 KIAS below 2,500 AGL underlying Class B
      if (near && altMsl < 2500 && f.velocityKts > 200 && near.ring) {
        const k = near.ring.k
        if (k === 'B' || k === 'A') {
          dSPDL = Math.max(dSPDL, clamp((f.velocityKts - 200) * 5, 0, 100))
        }
      }
      // §91.117(c) — 200 KIAS underlying Class B / VFR corridor through B
      if (near && near.ring && (near.ring.k === 'B' || near.ring.k === 'A') && !near.ring.sfc && altMsl < near.ring.fL + 500 && f.velocityKts > 200) {
        dSPDL = Math.max(dSPDL, clamp((f.velocityKts - 200) * 4, 0, 100))
      }

      const drivers = {
        BRING: dBRING, CRING: dCRING, DRING: dDRING,
        VEIL: dVEIL, VFRC: dVFRC, ADSB: dADSB, SPDL: dSPDL, IFRC: dIFRC,
      }
      const arr = Object.values(drivers)
      const mx = Math.max(...arr)
      const mn = arr.reduce((a, b) => a + b, 0) / arr.length
      // phase weights
      const phaseW: Record<Phase, number> = {
        'TAXI':0.40, 'DEPT':1.20, 'CLIMB':1.05, 'CRUISE':1.00,
        'DESCENT':1.05, 'APPR-FNL':1.18, 'OFF':0,
      }
      let score = (mx * 0.68 + mn * 0.32) * (phaseW[phase] ?? 1.0) * advMul

      const notes: string[] = []
      // Hard escalators per NTSB AAR-79-17 PSA 182 + DCA-14-LA-021 precedent
      if (dBRING >= 80) {
        score = Math.max(score, 94)
        notes.push(`Class ${near?.ring?.k || 'B'} INCURSION ${near?.asp.icao || ''} without ATC clearance · §91.131(a) violation · NTSB AAR-79-17 PSA 182 SAN precedent`)
      }
      if (dCRING >= 70) {
        score = Math.max(score, 84)
        notes.push(`Class C BREACH ${near?.asp.icao || ''} without two-way radio contact · §91.130 violation · AIM 3-2-4`)
      }
      if (dDRING >= 65) {
        score = Math.max(score, 76)
        notes.push(`Class D BREACH ${near?.asp.icao || ''} without two-way radio contact · §91.129 violation · AIM 3-2-5`)
      }
      if (dVEIL >= 80 && !equip.modeC) {
        score = Math.max(score, 88)
        notes.push(`Mode-C VEIL violation ${near?.asp.icao || ''} (30 NM) without operating Mode-C transponder · §91.215 violation`)
      }
      if (dADSB >= 70) {
        score = Math.max(score, 78)
        notes.push(`ADS-B Out non-equipage in §91.225 rule airspace · post-2020 mandatory · §91.227 performance failure`)
      }
      if (dVFRC >= 75) {
        score = Math.max(score, 82)
        notes.push(`VFR cloud-clearance BUST · §91.155 violation · scud-running / inadvertent IMC entry · NTSB SR-05-01 precedent`)
      }
      if (dSPDL >= 70) {
        score = Math.max(score, 72)
        notes.push(`§91.117 KIAS bust ${f.velocityKts.toFixed(0)}kt — request waiver or reduce speed immediately`)
      }
      if (dIFRC >= 60) {
        score = Math.max(score, 74)
        notes.push(`IFR aircraft NORDO in Class B — squawk 7600 immediately · §91.183 lost-comm procedure · AIM 6-4-1`)
      }

      score = clamp(score, 0, 100)

      let tier: Tier
      if (score >= 85) tier = 'INCURSION'
      else if (score >= 65) tier = 'BREACH'
      else if (score >= 45) tier = 'CAUTION'
      else if (score >= 22) tier = 'WATCH'
      else if (near && near.ring) tier = 'CLEAR'
      else tier = 'UNCTRL'

      out.push({ f, phase, near, altMsl, equip, isCmcl, drivers, score, tier, notes })
    }
    out.sort((a, b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.score - a.score))
    return out
  }, [flights, advMul, proxRing, vfrBust, modeCstrict])

  // === MapLibre overlay ===
  useEffect(() => {
    if (!map) return
    const SRC_AC = 'aclass-ac-src'
    const SRC_RING = 'aclass-ring-src'
    const SRC_VEIL = 'aclass-veil-src'
    const SRC_VEC = 'aclass-vec-src'

    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    ensureSrc(SRC_AC); ensureSrc(SRC_RING); ensureSrc(SRC_VEIL); ensureSrc(SRC_VEC)

    // Build ring polygons + veil + aircraft features
    const buildRing = (asp: Aspace, ring: Ring, color: string, opacity: number) => {
      const pts: any[] = []
      const N = 64
      for (let i = 0; i <= N; i++) {
        const θ = (i / N) * 2 * Math.PI
        // 1 NM ≈ 1/60 degree latitude
        const dLat = (ring.nm / 60) * Math.cos(θ)
        const dLng = (ring.nm / 60) * Math.sin(θ) / Math.cos(asp.lat * Math.PI / 180)
        pts.push([asp.lng + dLng, asp.lat + dLat])
      }
      return {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [pts] },
        properties: { color, opacity, k: ring.k, fL: ring.fL, cL: ring.cL, asp: asp.icao, nm: ring.nm },
      }
    }
    const ringFeats: any[] = []
    const veilFeats: any[] = []
    if (shRings) {
      for (const asp of ASPACES) {
        const col = asp.k === 'B' || asp.k === 'A' ? '#0ea5e9'  // sky for B/A
                  : asp.k === 'C' ? '#a855f7'                  // purple for C
                  : '#f59e0b'                                  // amber for D
        const baseOp = asp.k === 'B' || asp.k === 'A' ? 0.06 : asp.k === 'C' ? 0.05 : 0.04
        // Larger rings get smaller opacity
        const sortedRings = [...asp.rings].sort((a, b) => b.nm - a.nm)
        for (const ring of sortedRings) {
          ringFeats.push(buildRing(asp, ring, col, baseOp))
        }
      }
    }
    if (shVeil) {
      for (const asp of ASPACES) {
        if ((asp.k === 'B' || asp.k === 'A') && asp.modeC > 0) {
          const pts: any[] = []
          const N = 80
          for (let i = 0; i <= N; i++) {
            const θ = (i / N) * 2 * Math.PI
            const dLat = (asp.modeC / 60) * Math.cos(θ)
            const dLng = (asp.modeC / 60) * Math.sin(θ) / Math.cos(asp.lat * Math.PI / 180)
            pts.push([asp.lng + dLng, asp.lat + dLat])
          }
          veilFeats.push({
            type:'Feature', geometry:{ type:'LineString', coordinates: pts },
            properties:{ asp: asp.icao, nm: asp.modeC },
          })
        }
      }
    }

    const acFeats: any[] = []
    const vecFeats: any[] = []
    const view = rows.filter(r =>
      (tierFilter === 'ALL' || r.tier === tierFilter) &&
      (phaseFilter === 'ALL' || r.phase === phaseFilter) &&
      (classFilter === 'ALL' || (r.near?.ring?.k === classFilter))
    )
    for (const r of view) {
      const k = r.near?.ring?.k
      const labelBits = [
        r.f.callsign || r.f.icao,
        r.near?.asp.icao || '—',
        k ? `${k}${r.near?.ring?.sfc ? '·SFC' : `·${r.near?.ring?.fL}-${r.near?.ring?.cL}`}` : `${(r.near?.distNm || 0).toFixed(0)}NM`,
        `${r.tier} ${r.score.toFixed(0)}`,
      ].filter(Boolean).join(' · ')
      acFeats.push({
        type:'Feature',
        geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
        properties:{ tier: r.tier, color: TIER_COLOR[r.tier], score: r.score, sz: 7 + (r.score / 100) * 13, label: labelBits },
      })

      // Forward intercept vector — only for INCURSION/BREACH tiers showing where the airframe will exit the ring
      if (r.tier === 'INCURSION' || r.tier === 'BREACH') {
        const km = (r.score / 100) * 5
        const brg = (r.f.track || 0) * Math.PI / 180
        const dLat = (km / 111.32) * Math.cos(brg)
        const dLng = (km / (111.32 * Math.cos(r.f.lat * Math.PI / 180))) * Math.sin(brg)
        vecFeats.push({
          type:'Feature',
          geometry:{ type:'LineString', coordinates: [[r.f.lng, r.f.lat], [r.f.lng + dLng, r.f.lat + dLat]] },
          properties:{ color: TIER_COLOR[r.tier] },
        })
      }
    }
    ;(map.getSource(SRC_AC) as any).setData({ type:'FeatureCollection', features: (shHalo || shPin || shLbl) ? acFeats : [] })
    ;(map.getSource(SRC_RING) as any).setData({ type:'FeatureCollection', features: ringFeats })
    ;(map.getSource(SRC_VEIL) as any).setData({ type:'FeatureCollection', features: veilFeats })
    ;(map.getSource(SRC_VEC) as any).setData({ type:'FeatureCollection', features: shVec ? vecFeats : [] })

    // Add layers if absent
    if (!map.getLayer('aclass-ring-fill'))
      map.addLayer({ id:'aclass-ring-fill', type:'fill', source:SRC_RING, paint:{ 'fill-color':['get','color'], 'fill-opacity':['get','opacity'] } })
    if (!map.getLayer('aclass-ring-line'))
      map.addLayer({ id:'aclass-ring-line', type:'line', source:SRC_RING, paint:{ 'line-color':['get','color'], 'line-width':1.0, 'line-opacity':0.42 } })
    if (!map.getLayer('aclass-veil-line'))
      map.addLayer({ id:'aclass-veil-line', type:'line', source:SRC_VEIL, paint:{ 'line-color':'#38bdf8', 'line-width':1.0, 'line-dasharray':[5,3], 'line-opacity':0.30 } })
    if (!map.getLayer('aclass-halo'))
      map.addLayer({ id:'aclass-halo', type:'circle', source:SRC_AC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.17, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.86 } })
    if (!map.getLayer('aclass-pin'))
      map.addLayer({ id:'aclass-pin', type:'circle', source:SRC_AC, filter:['>=', ['get','score'], 65], paint:{ 'circle-radius':4.6, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.3 } })
    if (!map.getLayer('aclass-lbl'))
      map.addLayer({ id:'aclass-lbl', type:'symbol', source:SRC_AC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.45], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('aclass-vec'))
      map.addLayer({ id:'aclass-vec', type:'line', source:SRC_VEC, paint:{ 'line-color':['get','color'], 'line-width':1.8, 'line-dasharray':[2,2], 'line-opacity':0.84 } })

    // Visibility toggles
    map.setLayoutProperty('aclass-ring-fill', 'visibility', shRings ? 'visible' : 'none')
    map.setLayoutProperty('aclass-ring-line', 'visibility', shRings ? 'visible' : 'none')
    map.setLayoutProperty('aclass-veil-line', 'visibility', shVeil ? 'visible' : 'none')
    map.setLayoutProperty('aclass-halo', 'visibility', shHalo ? 'visible' : 'none')
    map.setLayoutProperty('aclass-pin', 'visibility', shPin ? 'visible' : 'none')
    map.setLayoutProperty('aclass-lbl', 'visibility', shLbl ? 'visible' : 'none')
    map.setLayoutProperty('aclass-vec', 'visibility', shVec ? 'visible' : 'none')

    return () => {
      for (const id of ['aclass-vec','aclass-lbl','aclass-pin','aclass-halo','aclass-veil-line','aclass-ring-line','aclass-ring-fill']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC_AC, SRC_RING, SRC_VEIL, SRC_VEC]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, phaseFilter, classFilter, shHalo, shPin, shLbl, shVec, shRings, shVeil])

  // ============================================================
  // Derived counters
  // ============================================================
  const counts: Record<Tier, number> = { 'INCURSION':0, 'BREACH':0, 'CAUTION':0, 'WATCH':0, 'CLEAR':0, 'UNCTRL':0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? rows.reduce((a,b)=>a+b.score, 0) / rows.length : 0
  const worst = rows[0]
  const ringsActive = rows.filter(r => r.near?.ring).length
  const veilActive = rows.filter(r => r.near?.modeCveil).length
  const noClr = rows.filter(r => r.near?.ring?.k === 'B' && !r.equip.clearance).length
  const noXpdr = rows.filter(r => r.near?.modeCveil && !r.equip.modeC).length
  const noAdsb = rows.filter(r => (r.near?.ring?.k === 'B' || r.near?.ring?.k === 'C' || r.near?.modeCveil) && !r.equip.adsbOut).length
  const vfrBusted = rows.filter(r => r.equip.flightRule === 'VFR' && r.equip.vfrCloud !== 'OK').length

  // Per-airspace aggregate
  const aspaceAgg = new Map<string, { asp: Aspace; count: number; mu: number; inc: number; brc: number; cau: number }>()
  for (const r of rows) {
    if (!r.near) continue
    const k = r.near.asp.icao
    const e = aspaceAgg.get(k) || { asp: r.near.asp, count: 0, mu: 0, inc: 0, brc: 0, cau: 0 }
    e.count++
    e.mu += r.score
    if (r.tier === 'INCURSION') e.inc++
    if (r.tier === 'BREACH') e.brc++
    if (r.tier === 'CAUTION') e.cau++
    aspaceAgg.set(k, e)
  }
  const aspaceRows = Array.from(aspaceAgg.values())
    .map(e => ({ ...e, mu: e.mu / e.count }))
    .sort((a, b) => (b.inc - a.inc) || (b.brc - a.brc) || (b.mu - a.mu))

  const visible = rows.filter(r =>
    (tierFilter === 'ALL' || r.tier === tierFilter) &&
    (phaseFilter === 'ALL' || r.phase === phaseFilter) &&
    (classFilter === 'ALL' || (r.near?.ring?.k === classFilter)) &&
    (!search ||
      (r.f.callsign || r.f.icao).toLowerCase().includes(search.toLowerCase()) ||
      (r.f.type || '').toLowerCase().includes(search.toLowerCase()) ||
      (r.f.operator || '').toLowerCase().includes(search.toLowerCase()) ||
      (r.near?.asp.icao || '').toLowerCase().includes(search.toLowerCase()))
  )

  return (
    <div className="fixed top-16 right-3 z-40 w-[460px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">ACLASS</span>
          <span className="text-[10px] text-slate-400">§71 B/C/D/E/G · Mode-C Veil · ADS-B · VFR mins · §91.131/130/129/215/225/155</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      {/* tier strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={() => setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>
          ALL · {rows.length}
        </button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tierFilter === t ? 'border' : 'border border-slate-700/60'}`} style={{ background: `${TIER_COLOR[t]}22`, borderColor: tierFilter === t ? TIER_COLOR[t] : undefined, color: TIER_COLOR[t] }}>
            {t.slice(0,4)} {counts[t]}
          </button>
        ))}
      </div>

      {/* summary cells */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCORE</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">IN-RING</div><div className="text-slate-100 font-mono">{ringsActive}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">NO-CLR</div><div className="font-mono" style={{ color: TIER_COLOR['INCURSION'] }}>{noClr}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">VFR-X</div><div className="font-mono" style={{ color: TIER_COLOR['BREACH'] }}>{vfrBusted}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div></div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e => setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">PROX-NM <span className="text-slate-200 font-mono">{proxRing.toFixed(1)}</span>
            <input type="range" min="1" max="10" step="0.5" value={proxRing} onChange={e => setProxRing(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">VFR-MUL <span className="text-slate-200 font-mono">{vfrBust}%</span>
            <input type="range" min="0" max="200" value={vfrBust} onChange={e => setVfrBust(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400 flex items-center gap-1 mt-3">
            <input type="checkbox" checked={modeCstrict} onChange={e => setModeCstrict(e.target.checked)} className="accent-sky-500" />
            <span>Mode-C strict</span>
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','TAXI','DEPT','CLIMB','CRUISE','DESCENT','APPR-FNL'] as const).map(p => (
            <button key={p} onClick={() => setPhaseFilter(p as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter === p ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','B','C','D'] as const).map(c => (
            <button key={c} onClick={() => setClassFilter(c as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter === c ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>CLASS-{c}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {([['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['VEC',shVec,setShVec],['RING',shRings,setShRings],['VEIL',shVeil,setShVeil]] as any[]).map(([n,v,fn]) => (
            <button key={n} onClick={() => fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search cs/type/op/icao" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* tabs */}
      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','AIRSPACE','MINIMA','STRUCTURE'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded ${tab === t ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {/* ============================================================
            AIRCRAFT tab — tier-worst-first row stack
        ============================================================ */}
        {tab === 'AIRCRAFT' && visible.slice(0, 80).map((r, i) => {
          const inRing = r.near?.ring
          const k = inRing?.k || '—'
          return (
            <div key={i} onClick={() => onFly(r.f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
              <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
                <span className="font-mono text-slate-100">{r.f.callsign || r.f.icao}</span>
                <span className="text-slate-500">·</span>
                <span className="font-mono text-slate-400">{r.f.type || '—'}</span>
                <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase}</span>
                <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.equip.flightRule}</span>
                {inRing && <span className="px-1 rounded font-mono text-[9px]" style={{ background: k === 'B' || k === 'A' ? '#0ea5e933' : k === 'C' ? '#a855f733' : '#f59e0b33', color: k === 'B' || k === 'A' ? '#38bdf8' : k === 'C' ? '#c084fc' : '#fbbf24' }}>{k}·{r.near?.asp.icao}</span>}
                {r.near?.modeCveil && <span className="px-1 rounded bg-sky-500/20 text-sky-200 font-mono text-[9px]">VEIL</span>}
                {!r.equip.adsbOut && <span className="px-1 rounded bg-rose-500/20 text-rose-200 font-mono text-[9px]">no ADS-B</span>}
                {!r.equip.modeC && <span className="px-1 rounded bg-rose-500/20 text-rose-200 font-mono text-[9px]">no XPDR</span>}
                <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background: `${TIER_COLOR[r.tier]}33`, color: TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
              </div>
              <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                <div>alt <span className="text-slate-100 font-mono">{r.altMsl.toFixed(0)}</span></div>
                <div>ias <span className="text-slate-100 font-mono">{r.f.velocityKts.toFixed(0)}</span></div>
                <div>vs <span className="text-slate-100 font-mono">{r.f.vertRate > 0 ? '+' : ''}{r.f.vertRate.toFixed(0)}</span></div>
                <div>dist <span className="text-slate-100 font-mono">{r.near ? r.near.distNm.toFixed(1) : '—'}NM</span></div>
              </div>
              {inRing && (
                <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
                  <div>ring <span className="text-slate-100 font-mono">{inRing.nm.toFixed(1)}NM</span></div>
                  <div>floor <span className="text-slate-100 font-mono">{inRing.sfc ? 'SFC' : `${inRing.fL}`}</span></div>
                  <div>ceil <span className="text-slate-100 font-mono">{inRing.cL}</span></div>
                  <div>tower <span className="text-slate-100 font-mono">{r.near?.asp.tower?.split(' ')[0] || '—'}</span></div>
                </div>
              )}
              {!inRing && r.near && (
                <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
                  <div>nearest <span className="text-slate-100 font-mono">{r.near.asp.icao}</span></div>
                  <div>edge <span className="text-slate-100 font-mono">{r.near.closestNm.toFixed(1)}NM</span></div>
                  <div>cls <span className="text-slate-100 font-mono">{r.near.asp.k}</span></div>
                  <div>veil <span className="text-slate-100 font-mono">{r.near.modeCveil ? 'YES' : 'NO'}</span></div>
                </div>
              )}
              <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier], height: '100%' }} /></div>
              <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
                {Object.entries(r.drivers).filter(([,v]) => v > 5).map(([k,v]) => (
                  <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v)}</span>
                ))}
              </div>
              {r.notes.length > 0 && <div className="mt-1 text-[9px]" style={{ color: TIER_COLOR[r.tier] }}>! {r.notes[0]}</div>}
              {r.notes.length === 0 && r.tier === 'UNCTRL' && <div className="mt-1 text-[9px] text-slate-500">uncontrolled / Class E or G · §91.155 cloud-clearance only</div>}
              {r.notes.length === 0 && r.tier === 'CLEAR' && inRing && <div className="mt-1 text-[9px] text-slate-500">Class {inRing.k} ring · {r.equip.clearance ? 'ATC clearance held' : r.equip.twoWay ? 'two-way contact' : '—'} · §91.13{inRing.k === 'B' || inRing.k === 'A' ? '1' : inRing.k === 'C' ? '0' : '0'}</div>}
            </div>
          )
        })}
        {tab === 'AIRCRAFT' && visible.length === 0 && <div className="text-[10px] text-slate-500 italic">no aircraft match current filter</div>}

        {/* ============================================================
            AIRSPACE tab — per-airspace aggregate
        ============================================================ */}
        {tab === 'AIRSPACE' && (
          <div className="space-y-1">
            {aspaceRows.length === 0 && <div className="text-[10px] text-slate-500 italic">no aircraft within 80 NM of any catalog airspace</div>}
            {aspaceRows.map(e => {
              const colorK = e.asp.k === 'B' || e.asp.k === 'A' ? '#0ea5e9' : e.asp.k === 'C' ? '#a855f7' : '#f59e0b'
              return (
                <div key={e.asp.icao} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <span className="px-1 rounded font-mono text-[9px]" style={{ background: `${colorK}33`, color: colorK }}>{e.asp.k}</span>
                    <span className="font-mono text-slate-100">{e.asp.icao}</span>
                    <span className="text-slate-400 truncate">{e.asp.name}</span>
                    <span className="ml-auto font-mono text-slate-200">×{e.count}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                    <div>μ-SCORE <span className="text-slate-100 font-mono">{e.mu.toFixed(0)}</span></div>
                    <div>INC <span className="font-mono" style={{ color: TIER_COLOR['INCURSION'] }}>{e.inc}</span></div>
                    <div>BRC <span className="font-mono" style={{ color: TIER_COLOR['BREACH'] }}>{e.brc}</span></div>
                    <div>CAU <span className="font-mono" style={{ color: TIER_COLOR['CAUTION'] }}>{e.cau}</span></div>
                  </div>
                  <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
                    <div>rings <span className="text-slate-100 font-mono">{e.asp.rings.length}</span></div>
                    <div>veil <span className="text-slate-100 font-mono">{e.asp.modeC || '—'}NM</span></div>
                    <div>ADS-B <span className="text-slate-100 font-mono">{e.asp.adsb ? 'REQ' : 'opt'}</span></div>
                    <div>twr <span className="text-slate-100 font-mono truncate">{e.asp.tower?.split(' ')[0] || '—'}</span></div>
                  </div>
                  <div className="text-[9px] text-slate-500 mt-0.5 italic">
                    {e.asp.rings.map(r => `${r.nm}NM ${r.sfc ? 'SFC' : r.fL}-${r.cL}`).join(' · ')}
                  </div>
                </div>
              )
            })}
            <div className="text-[9px] text-slate-500 italic mt-1 px-1">Catalog: {ASPACES.filter(a => a.k === 'B' || a.k === 'A').length} Class B/A · {ASPACES.filter(a => a.k === 'C').length} Class C · {ASPACES.filter(a => a.k === 'D').length} Class D · {ASPACES.length} total stations per FAA Order 7400.11 + ICAO Annex 11 §2.6</div>
          </div>
        )}

        {/* ============================================================
            MINIMA tab — VFR cloud-clearance table + Mode-C veil + ADS-B
        ============================================================ */}
        {tab === 'MINIMA' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="font-mono text-slate-100 mb-1">§91.155 VFR basic weather minima — cloud-clearance + visibility</div>
              <div className="text-slate-400 mb-1.5">The canonical "3-152 / 1000-500-2000 / 5-1111" table memorised by every Private-pilot applicant — distance from clouds and forward visibility required to operate under VFR per airspace class.</div>
              <div className="overflow-x-auto">
                <table className="w-full text-[10px] font-mono">
                  <thead>
                    <tr className="text-slate-400 border-b border-slate-700/40">
                      <th className="text-left pl-1 py-0.5">Class</th>
                      <th className="text-right pr-1">Vis SM</th>
                      <th className="text-right pr-1">Bel-cloud</th>
                      <th className="text-right pr-1">Abv-cloud</th>
                      <th className="text-right pr-1">Hor-cloud</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-slate-700/20"><td className="pl-1 py-0.5 text-sky-300">B</td><td className="text-right pr-1">3</td><td colSpan={3} className="text-right pr-1 text-slate-400">clear of clouds</td></tr>
                    <tr className="border-b border-slate-700/20"><td className="pl-1 py-0.5 text-purple-300">C</td><td className="text-right pr-1">3</td><td className="text-right pr-1">500</td><td className="text-right pr-1">1000</td><td className="text-right pr-1">2000</td></tr>
                    <tr className="border-b border-slate-700/20"><td className="pl-1 py-0.5 text-amber-300">D</td><td className="text-right pr-1">3</td><td className="text-right pr-1">500</td><td className="text-right pr-1">1000</td><td className="text-right pr-1">2000</td></tr>
                    <tr className="border-b border-slate-700/20"><td className="pl-1 py-0.5 text-emerald-300">E &lt;10k</td><td className="text-right pr-1">3</td><td className="text-right pr-1">500</td><td className="text-right pr-1">1000</td><td className="text-right pr-1">2000</td></tr>
                    <tr className="border-b border-slate-700/20"><td className="pl-1 py-0.5 text-emerald-300">E ≥10k</td><td className="text-right pr-1">5</td><td className="text-right pr-1">1000</td><td className="text-right pr-1">1000</td><td className="text-right pr-1">1SM</td></tr>
                    <tr className="border-b border-slate-700/20"><td className="pl-1 py-0.5 text-slate-300">G &lt;1200ft D</td><td className="text-right pr-1">1</td><td colSpan={3} className="text-right pr-1 text-slate-400">clear of clouds</td></tr>
                    <tr className="border-b border-slate-700/20"><td className="pl-1 py-0.5 text-slate-300">G &lt;1200 N</td><td className="text-right pr-1">3</td><td className="text-right pr-1">500</td><td className="text-right pr-1">1000</td><td className="text-right pr-1">2000</td></tr>
                    <tr><td className="pl-1 py-0.5 text-slate-300">G &gt;10kMSL</td><td className="text-right pr-1">5</td><td className="text-right pr-1">1000</td><td className="text-right pr-1">1000</td><td className="text-right pr-1">1SM</td></tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              <div className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="text-[10px] text-slate-400 mb-1">Mode-C Veil §91.215</div>
                <div className="text-[9px] text-slate-400 leading-snug mb-1">30 NM of Class B SFC to 10,000 MSL · operating Mode-C transponder required</div>
                <div className="space-y-0.5">
                  <div className="flex justify-between text-[10px] font-mono"><span className="text-slate-400">in veil</span><span className="text-slate-100">{veilActive}</span></div>
                  <div className="flex justify-between text-[10px] font-mono"><span className="text-slate-400">veil bust</span><span style={{ color: TIER_COLOR['INCURSION'] }}>{noXpdr}</span></div>
                  <div className="flex justify-between text-[10px] font-mono"><span className="text-slate-400">compliance</span><span className="text-emerald-300">{veilActive ? ((1 - noXpdr/veilActive)*100).toFixed(1) : '100.0'}%</span></div>
                </div>
              </div>
              <div className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="text-[10px] text-slate-400 mb-1">ADS-B Out §91.225</div>
                <div className="text-[9px] text-slate-400 leading-snug mb-1">Required in B/C airspace, Mode-C veil, &gt;10,000 MSL excluding &lt;2,500 AGL band</div>
                <div className="space-y-0.5">
                  <div className="flex justify-between text-[10px] font-mono"><span className="text-slate-400">in rule airspace</span><span className="text-slate-100">{rows.filter(r => r.near?.ring || r.near?.modeCveil).length}</span></div>
                  <div className="flex justify-between text-[10px] font-mono"><span className="text-slate-400">non-equipped</span><span style={{ color: TIER_COLOR['BREACH'] }}>{noAdsb}</span></div>
                  <div className="flex justify-between text-[10px] font-mono"><span className="text-slate-400">equipage rate</span><span className="text-emerald-300">{rows.length ? ((1 - rows.filter(r => !r.equip.adsbOut).length/rows.length)*100).toFixed(1) : '100.0'}%</span></div>
                </div>
              </div>
            </div>

            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
              <div className="text-[10px] text-slate-400 mb-1">§91.117 KIAS structural limits</div>
              <div className="space-y-0.5 text-[10px] font-mono">
                <div className="flex justify-between"><span className="text-slate-400">(a) below 10,000 MSL</span><span className="text-slate-100">250 KIAS</span></div>
                <div className="flex justify-between"><span className="text-slate-400">(b) below 2,500 AGL under B</span><span className="text-slate-100">200 KIAS</span></div>
                <div className="flex justify-between"><span className="text-slate-400">(c) VFR corridor through B</span><span className="text-slate-100">200 KIAS</span></div>
                <div className="flex justify-between"><span className="text-slate-400">(d) approach</span><span className="text-slate-100">200 KIAS final</span></div>
              </div>
            </div>

            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5 text-[9px] text-slate-400 leading-relaxed">
              <span className="font-mono text-slate-300">References · </span>
              14 CFR §71 Subpart A-G (airspace designations) · §91.117 KIAS limits · §91.129 Class D · §91.130 Class C · §91.131 Class B · §91.135 Class A · §91.155 VFR weather minima · §91.215 Mode-C Veil · §91.225 ADS-B Out rule airspace · §91.227 ADS-B performance · FAA AC 71-1A · AC 91-92 (Class B Ops) · AC 90-66B (non-towered) · FAA Order 7400.11 (airspace designations) · FAA Order 7400.2 (airspace procedures) · FAA Order JO 7110.65 ATC §3-2/3-3/7-5 · AIM 3-2-3/3-2-4/3-2-5/3-1-4/3-1-5 · FAA P-8740-32 (sectional symbology) · ICAO Annex 11 §2.6 ATS airspace classes · Doc 4444 §16.1 PANS-ATM · Doc 9426 ATS Planning · Annex 2 §3.1.2 VFR · Annex 6 Pt I §4.2 VMC/IMC · EASA SERA.5005 VFR · SERA.6001 classification · AMC1 SERA.5005 cloud-clearance · UK CAA CAP 393 / CAP 413 §4 · TC AIM RAC 2.5 · NTSB AAR-79-17 PSA 182 SAN 1978 (TCA origin) · DCA-14-LA-021 C172 BWI · NYC-09-01 Hudson midair · ASRS CALLBACK 412 (Class B busts) · AOPA Class B Pilot's Guide · NBAA Airspace Quick-Reference v3 · AIM 6-3-2/6-3-4 ADS-B.
            </div>
          </div>
        )}

        {/* ============================================================
            STRUCTURE tab — SVG wedding-cake cross-section
        ============================================================ */}
        {tab === 'STRUCTURE' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="font-mono text-slate-100 mb-1">"Wedding-cake" Class B cross-section + ATS airspace stack</div>
              <div className="text-slate-400">Canonical Class B inverted wedding-cake architecture: surface-attached inner core, mid-altitude shelf, outer high-altitude shelf, all enclosed by the 30 NM Mode-C Veil. Class A above 18,000 MSL (FL180), Class E filling the gap, Class G uncontrolled below 1,200 (or 700) AGL.</div>
            </div>

            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <svg viewBox="0 0 400 280" className="w-full">
                {/* axis */}
                <line x1="40" y1="260" x2="380" y2="260" stroke="#334155" />
                <line x1="40" y1="20" x2="40" y2="260" stroke="#334155" />
                {/* y ticks altitude */}
                {[0,2500,5000,7500,10000,15000,18000].map(h => (
                  <g key={h}>
                    <line x1="38" y1={260 - (h/20000)*240} x2="42" y2={260 - (h/20000)*240} stroke="#475569" />
                    <text x={34} y={263 - (h/20000)*240} fill="#94a3b8" fontSize="9" textAnchor="end">{h>=1000?(h/1000)+'k':h}</text>
                  </g>
                ))}
                {/* x ticks NM */}
                {[-30,-20,-10,0,10,20,30].map(d => (
                  <g key={d}>
                    <line x1={210 + d*5.4} y1="258" x2={210 + d*5.4} y2="262" stroke="#475569" />
                    <text x={210 + d*5.4} y={273} fill="#94a3b8" fontSize="9" textAnchor="middle">{d>0?'+':''}{d}</text>
                  </g>
                ))}
                <text x="210" y="278" fill="#94a3b8" fontSize="9" textAnchor="middle">NM from station</text>
                <text x="20" y="14" fill="#94a3b8" fontSize="9">altitude ft MSL</text>

                {/* Class A FL180+ */}
                <rect x="40" y={260 - (18000/20000)*240 - 24} width="340" height="24" fill="#6366f1" opacity="0.18" />
                <text x="210" y={260 - (18000/20000)*240 - 8} fill="#a5b4fc" fontSize="9" textAnchor="middle">CLASS A · FL180 · IFR-only</text>

                {/* Class E between 1200 AGL and 18kft */}
                <rect x="40" y={260 - (18000/20000)*240} width="340" height={(18000-1200)/20000*240} fill="#10b981" opacity="0.04" />

                {/* Class G below 1200 AGL */}
                <rect x="40" y={260 - (1200/20000)*240} width="340" height={(1200/20000)*240} fill="#475569" opacity="0.18" />
                <text x="60" y={258} fill="#cbd5e1" fontSize="9">G · uncontrolled &lt; 1200 AGL</text>

                {/* Mode-C Veil 30 NM SFC to 10,000 — outermost */}
                <rect x={210-30*5.4} y={260 - (10000/20000)*240} width={60*5.4} height={(10000/20000)*240} fill="none" stroke="#38bdf8" strokeWidth="0.8" strokeDasharray="4 3" opacity="0.55" />
                <text x={210-30*5.4 + 8} y={260 - (10000/20000)*240 + 12} fill="#38bdf8" fontSize="9">Mode-C Veil 30NM · §91.215</text>

                {/* Class B inverted wedding-cake — three concentric shelves */}
                {/* outer shelf — 30 NM × 3500-10000 */}
                <rect x={210-30*5.4} y={260 - (10000/20000)*240} width={60*5.4} height={(10000-3500)/20000*240} fill="#0ea5e9" opacity="0.10" stroke="#0ea5e9" strokeWidth="1" />
                {/* mid shelf — 20 NM × 1800-10000 */}
                <rect x={210-20*5.4} y={260 - (10000/20000)*240} width={40*5.4} height={(10000-1800)/20000*240} fill="#0ea5e9" opacity="0.13" stroke="#0ea5e9" strokeWidth="1" />
                {/* inner core — 10 NM × SFC-10000 */}
                <rect x={210-10*5.4} y={260 - (10000/20000)*240} width={20*5.4} height={(10000/20000)*240} fill="#0ea5e9" opacity="0.20" stroke="#0ea5e9" strokeWidth="1.2" />
                <text x={210} y={260 - (10000/20000)*240 - 4} fill="#7dd3fc" fontSize="10" textAnchor="middle" fontFamily="monospace">CLASS B · §91.131</text>

                {/* Tower / station */}
                <circle cx="210" cy="260" r="3" fill="#fde047" />
                <text x="216" y="262" fill="#fde047" fontSize="9">station</text>

                {/* Class C alongside — separate 5NM/10NM ring at +35NM (offset) but just annotate */}
                <text x="60" y="120" fill="#a855f7" fontSize="9">CLASS C · 5NM SFC-4kAGL + 10NM 1.2k-4k · §91.130</text>
                <text x="60" y="135" fill="#fbbf24" fontSize="9">CLASS D · 4.4NM SFC-2.5kAGL · §91.129</text>

                {/* legend */}
                <text x="380" y="14" fill="#94a3b8" fontSize="9" textAnchor="end">FAA Order 7400.11 / ICAO Annex 11 §2.6</text>
              </svg>
              <div className="grid grid-cols-4 gap-1 mt-1 text-[10px]">
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">B/A airports</div><div className="text-sky-300 font-mono">{ASPACES.filter(a => a.k === 'B' || a.k === 'A').length}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">C airports</div><div className="font-mono" style={{ color: '#a855f7' }}>{ASPACES.filter(a => a.k === 'C').length}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">D airports</div><div className="text-amber-300 font-mono">{ASPACES.filter(a => a.k === 'D').length}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">fleet in-ring</div><div className="text-slate-100 font-mono">{ringsActive}</div></div>
              </div>
            </div>

            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5 text-[9px] text-slate-400 leading-relaxed">
              <span className="font-mono text-slate-300">Class equipage requirements summary · </span>
              <span className="text-sky-300">B/A:</span> ATC clearance §91.131(a), two-way radio, Mode-C, ADS-B Out (post-2020), encoder ·{' '}
              <span style={{ color: '#a855f7' }}>C:</span> two-way contact established (call-sign acknowledged) §91.130, Mode-C, ADS-B Out ·{' '}
              <span className="text-amber-300">D:</span> two-way contact established §91.129 ·{' '}
              <span className="text-emerald-300">E:</span> no clearance/contact for VFR but §91.155 minima ·{' '}
              <span className="text-slate-300">G:</span> uncontrolled, §91.155(b) basic minima.
              {' '}Methodology: catalogue 50 stations × catalogue rings × airframe lat/lng/altMsl penetration test + hash-stable per-airframe equipage / flight-rule state.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
