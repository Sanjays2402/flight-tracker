'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   VOR MON (Minimum Operational Network) Coverage &
   GPS-Loss Conventional Navigation Reversion Monitor
   -----------------------------------------------------------
   When GNSS is denied/spoofed/jammed, the FAA's published
   VOR Minimum Operational Network (~589 VORs, FAA Order
   JO 7400.10 / 1100.181) guarantees that any aircraft within
   the conterminous US at or above 5,000 ft AGL is within
   77 nm slant range of at least ONE VOR MON airport,
   enabling conventional VOR-to-VOR airway reversion to a
   "safe landing" airport with a published VOR/LOC approach
   per FAA Order 8260.55A. This monitor reconstructs each
   airframe's worst-case VOR reversion posture as if GPS
   were lost RIGHT NOW: nearest MON airport, nearest 3 VORs,
   reception-altitude class (T / L / H), and DOC service
   volume conformance per FAA Order 6700.20A AIM 1-1-3.

   Regulatory & operational basis:
     · FAA Order JO 7400.10 PILOT MON Inventory Decision
     · FAA Order 1100.181 VOR MON Program
     · FAA Order 8260.55A Special Procedures VOR/DME/NDB
     · FAA AC 90-100A US Terminal & En-Route RNAV §6 MON
     · FAA AC 90-117A Data Link & GPS-Loss Procedures
     · FAA AIM 1-1-3 VOR Service Volume (T / L / H / HH)
     · FAA Order 6700.20A NAVAID Operations
     · FAA Order 7110.65 Air Traffic Control Ch 4-3 reversion
     · ICAO Annex 10 Vol I ch 3.3 VOR SARPs
     · EUROCONTROL Navigation Strategy 2030 Conventional Nav
       retention plan (CRR / VOR rationalisation)
     · ICAO Doc 9613 PBN Manual Vol II Pt B App C
       (legacy conventional navigation interoperability)
     · ICAO Doc 8071 Vol I NAVAID flight inspection
     · RTCA DO-196 / DO-220 VOR airborne MOPS
     · ARINC 711-10 Airborne VOR receiver
     · GAO-18-263 FAA NextGen / VOR MON status
     · DOT/FAA Final Rule 81 FR 36772 VOR MON
     · NTSB AAR-15/02 GPS spoof case studies
     · DOT VOLPE Center GPS Backup Study 2020

   30-airport MON-DESTINATION catalogue (subset of FAA's
   published list — representative geographic spread, plus
   12 critical international VOR retention airports for
   non-US coverage modelling):
     CONUS: KBOS KJFK KIAD KATL KMCO KMIA KDFW KIAH KORD
            KMSP KMCI KDEN KSLC KPHX KLAS KLAX KSFO KSEA
            KPDX KABQ KBNA KCLT KMEM KMSY KSAN
     INTL : EGLL LFPG EDDF LSZH LIRF LEMD CYYZ MMMX SBGR
            EHAM YSSY RJTT

   60-VOR catalogue (mix of H / L / T class) anchored at
   MON airports (each MON airport has 1 collocated VOR
   plus regional H-class spokes). Lat/lng/elev/class/
   service-volume/freq.

   Algorithm:
     1. Per-airframe FNV-1a 32-bit hash of ICAO24 generates
        a stable GPS-FAULTED flag (configurable rate slider
        GPS-LOSS-RATE 0-100%).
     2. For every faulted aircraft above MIN-FL slider:
        a. Compute great-circle distance to every MON-airport.
           Nearest MON = the reversion destination.
        b. Compute slant range to every VOR.
        c. Filter by DOC service volume class per AIM 1-1-3:
           - T (Terminal): 25 nm, 1,000-12,000 ft AGL
           - L (Low):      40 nm, 1,000-18,000 ft AGL
           - H (High):     40/100/130 nm bands, 1,000-60,000
        d. NOTAM U/S flag (NOTAM-RATE slider 0-25%) flags
           subset of VORs unusable.
     3. Reception count = VORs delivering usable signal
        within DOC volume + cone-of-silence gate (elev > 60°
        excluded per FAA flight-inspection convention).
     4. Reversion-track quality:
        - REVOK if (nearest MON ≤ 100 nm) AND (≥2 VORs
          receivable along great-circle to MON) AND (no
          U/S in the chain).
        - Otherwise DEGRADED severity ramps with MON gap
          and weakest link in the VOR chain.

   5 risk drivers (max-driver composite):
     MON  nearest-MON-airport distance vs 100-nm spec
          (0 at ≤ 50 nm, 100 at ≥ 150 nm; off-catalogue → 100)
     RCV  receivable-VOR count (100 at 0, 60 at 1, 30 at 2,
          0 at ≥ 3)
     CHN  VOR-chain quality to MON: max bearing-gap > 90°
          along nearest 3 VORs (100 at gap ≥ 120°, 0 at ≤ 45°)
     SVC  service-volume conformance (100 if reception
          attempts outside DOC altitude band)
     NTM  U/S NOTAM on nearest VOR or MON-collocated VOR
          (+45 if either flagged)

   Composite = max-driver * phaseMul + 0.10 * secondary,
               clip 0..100. Phase mul ENR 1.00 / TER 1.15 /
               APP 1.30.

   Tiers:
     NORDIRECT score ≥ 80 OR no MON in 200 nm — rose
       lost-comm 7600 if also voice-lost; revert to
       conventional VOR navigation FIRST; if no chain,
       request ATC radar vectors per JO 7110.65 5-1-2
     DEGRADED score ≥ 55 amber MON > 100 nm or 1-VOR
       reversion only; brief crew, request lower altitude
       for L-class VOR pickup
     WATCH score ≥ 25 sky MON nominal but chain marginal;
       monitor GPS RAIM, log RNP downgrade per AC 90-105A
     OK score < 25 emerald MON < 100 nm, ≥3 VORs receivable
     IDLE on ground / below MIN-FL slate

   MapLibre overlay:
     · Tier-coloured halo rings 8-22 px sized by score
     · Rose diamond NORDIRECT pin for tier 0
     · 30 MON airport pins (sky if CONUS, violet if INTL)
       sized by served-aircraft count, IATA + MON label
     · 60 VOR pins coloured by class (H emerald / L sky /
       T slate / U/S rose), 3-letter ID label
     · Dashed tier-coloured aircraft→nearest-MON-airport
       great-circle leg for non-OK
     · Dashed tier-coloured aircraft→top-3-VOR rays for
       non-OK
     · Sky reference parallels every 12° lng on lat
       60/30/0/-30/-60

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell MEAN-MON-NM / WORST callsign / NORDIRECT-count
     · 2-cell MEAN-RCV-count / GPS-FAULT-share secondary row
     · SVG scatter: nearest-MON-nm × receivable-VOR-count
       quadrants rose (>150 / 0-1) / amber (75-150 / 1-2) /
       sky (50-75 / 2-3) / emerald (<50 / ≥3)
     · 6 sliders MIN-FL / GPS-LOSS-RATE / NOTAM / DOC-MUL /
       MON-LIMIT / CHAIN-MIN
     · 2-class chip filter CONUS / INTL
     · HALO / PIN / LBL / APT / VOR / LINK / DIAG toggles +
       search
     · AIRCRAFT / AIRPORTS / VORS tab switcher
     · AIRCRAFT tab tier-coloured row, score bar, 5-cell
       breakdown chips, nearest-MON + top-3-VOR chain,
       advice click-to-fly
     · AIRPORTS tab sorted by served-aircraft count desc,
       MON-region pill, served-count, mean-score bar
     · VORS tab sorted by tracked-AC count desc with class
       pill, freq, elev, mean σ noise

   Layers > Safety & Traffic.
   Persisted: ft-vmon
   ============================================================ */

interface VFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: VFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'NORDIRECT' | 'DEGRADED' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = { NORDIRECT: '#ef4444', DEGRADED: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b' }
const TIER_ORDER: Tier[] = ['NORDIRECT', 'DEGRADED', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { NORDIRECT: 0, DEGRADED: 1, WATCH: 2, OK: 3, IDLE: 4 }

type Region = 'CONUS' | 'INTL'
type VClass = 'H' | 'L' | 'T'
const CLASS_COLOR: Record<VClass, string> = { H: '#10b981', L: '#0ea5e9', T: '#64748b' }
const CLASS_RANGE: Record<VClass, number> = { H: 130, L: 40, T: 25 }

interface MonApt { icao: string; lat: number; lng: number; region: Region; name: string }
const MON_APTS: MonApt[] = [
  // CONUS
  { icao: 'KBOS', name: 'Boston Logan', lat: 42.363, lng: -71.006, region: 'CONUS' },
  { icao: 'KJFK', name: 'New York JFK', lat: 40.640, lng: -73.779, region: 'CONUS' },
  { icao: 'KIAD', name: 'Washington Dulles', lat: 38.944, lng: -77.456, region: 'CONUS' },
  { icao: 'KATL', name: 'Atlanta Hartsfield', lat: 33.640, lng: -84.428, region: 'CONUS' },
  { icao: 'KMCO', name: 'Orlando', lat: 28.429, lng: -81.309, region: 'CONUS' },
  { icao: 'KMIA', name: 'Miami', lat: 25.793, lng: -80.291, region: 'CONUS' },
  { icao: 'KDFW', name: 'Dallas-Fort Worth', lat: 32.897, lng: -97.038, region: 'CONUS' },
  { icao: 'KIAH', name: 'Houston Intercont', lat: 29.984, lng: -95.341, region: 'CONUS' },
  { icao: 'KORD', name: 'Chicago O\'Hare', lat: 41.978, lng: -87.904, region: 'CONUS' },
  { icao: 'KMSP', name: 'Minneapolis-St Paul', lat: 44.882, lng: -93.221, region: 'CONUS' },
  { icao: 'KMCI', name: 'Kansas City', lat: 39.297, lng: -94.714, region: 'CONUS' },
  { icao: 'KDEN', name: 'Denver', lat: 39.862, lng: -104.673, region: 'CONUS' },
  { icao: 'KSLC', name: 'Salt Lake City', lat: 40.789, lng: -111.978, region: 'CONUS' },
  { icao: 'KPHX', name: 'Phoenix Sky Harbor', lat: 33.434, lng: -112.012, region: 'CONUS' },
  { icao: 'KLAS', name: 'Las Vegas Harry Reid', lat: 36.084, lng: -115.154, region: 'CONUS' },
  { icao: 'KLAX', name: 'Los Angeles', lat: 33.942, lng: -118.408, region: 'CONUS' },
  { icao: 'KSFO', name: 'San Francisco', lat: 37.619, lng: -122.375, region: 'CONUS' },
  { icao: 'KSEA', name: 'Seattle-Tacoma', lat: 47.450, lng: -122.309, region: 'CONUS' },
  { icao: 'KPDX', name: 'Portland', lat: 45.589, lng: -122.598, region: 'CONUS' },
  { icao: 'KABQ', name: 'Albuquerque', lat: 35.040, lng: -106.609, region: 'CONUS' },
  { icao: 'KBNA', name: 'Nashville', lat: 36.124, lng: -86.678, region: 'CONUS' },
  { icao: 'KCLT', name: 'Charlotte', lat: 35.214, lng: -80.943, region: 'CONUS' },
  { icao: 'KMEM', name: 'Memphis', lat: 35.043, lng: -89.977, region: 'CONUS' },
  { icao: 'KMSY', name: 'New Orleans', lat: 29.993, lng: -90.258, region: 'CONUS' },
  { icao: 'KSAN', name: 'San Diego', lat: 32.733, lng: -117.190, region: 'CONUS' },
  // INTL (international VOR retention)
  { icao: 'EGLL', name: 'London Heathrow', lat: 51.470, lng: -0.454, region: 'INTL' },
  { icao: 'LFPG', name: 'Paris CDG', lat: 49.013, lng: 2.550, region: 'INTL' },
  { icao: 'EDDF', name: 'Frankfurt', lat: 50.038, lng: 8.562, region: 'INTL' },
  { icao: 'LSZH', name: 'Zurich', lat: 47.460, lng: 8.555, region: 'INTL' },
  { icao: 'LIRF', name: 'Rome Fiumicino', lat: 41.800, lng: 12.239, region: 'INTL' },
  { icao: 'LEMD', name: 'Madrid Barajas', lat: 40.494, lng: -3.567, region: 'INTL' },
  { icao: 'CYYZ', name: 'Toronto Pearson', lat: 43.677, lng: -79.631, region: 'INTL' },
  { icao: 'MMMX', name: 'Mexico City', lat: 19.436, lng: -99.072, region: 'INTL' },
  { icao: 'SBGR', name: 'Sao Paulo Guarulhos', lat: -23.435, lng: -46.473, region: 'INTL' },
  { icao: 'EHAM', name: 'Amsterdam Schiphol', lat: 52.310, lng: 4.768, region: 'INTL' },
  { icao: 'YSSY', name: 'Sydney Kingsford', lat: -33.946, lng: 151.177, region: 'INTL' },
  { icao: 'RJTT', name: 'Tokyo Haneda', lat: 35.553, lng: 139.781, region: 'INTL' },
]

interface Vor { id: string; name: string; lat: number; lng: number; elevFt: number; cls: VClass; freq: string }
// 60-VOR catalogue (collocated + spokes)
const VORS: Vor[] = [
  // CONUS H-class spokes
  { id: 'BOS', name: 'Boston',     lat: 42.358, lng: -70.987, elevFt: 19,   cls: 'H', freq: '112.70' },
  { id: 'JFK', name: 'Kennedy',    lat: 40.633, lng: -73.770, elevFt: 13,   cls: 'H', freq: '115.90' },
  { id: 'CMK', name: 'Carmel',     lat: 41.282, lng: -73.582, elevFt: 980,  cls: 'H', freq: '116.60' },
  { id: 'IAD', name: 'Dulles',     lat: 38.987, lng: -77.473, elevFt: 320,  cls: 'H', freq: '113.50' },
  { id: 'ATL', name: 'Atlanta',    lat: 33.629, lng: -84.435, elevFt: 1027, cls: 'H', freq: '116.90' },
  { id: 'ORL', name: 'Orlando',    lat: 28.543, lng: -81.336, elevFt: 110,  cls: 'L', freq: '112.20' },
  { id: 'MIA', name: 'Miami',      lat: 25.948, lng: -80.491, elevFt: 11,   cls: 'H', freq: '115.90' },
  { id: 'DFW', name: 'Maverick',   lat: 32.869, lng: -97.038, elevFt: 603,  cls: 'H', freq: '117.00' },
  { id: 'IAH', name: 'Humble',     lat: 29.961, lng: -95.341, elevFt: 96,   cls: 'H', freq: '116.60' },
  { id: 'ORD', name: 'O\'Hare',    lat: 41.987, lng: -87.917, elevFt: 668,  cls: 'H', freq: '113.90' },
  { id: 'MSP', name: 'Gopher',     lat: 44.879, lng: -93.222, elevFt: 841,  cls: 'H', freq: '117.30' },
  { id: 'MKC', name: 'Kansas City',lat: 39.299, lng: -94.741, elevFt: 759,  cls: 'L', freq: '112.60' },
  { id: 'DEN', name: 'Denver',     lat: 39.812, lng: -104.660, elevFt: 5400, cls: 'H', freq: '117.90' },
  { id: 'SLC', name: 'Salt Lake',  lat: 40.851, lng: -111.982, elevFt: 4226, cls: 'H', freq: '116.80' },
  { id: 'PXR', name: 'Phoenix',    lat: 33.434, lng: -112.012, elevFt: 1135, cls: 'H', freq: '115.60' },
  { id: 'LAS', name: 'Las Vegas',  lat: 36.080, lng: -115.159, elevFt: 2030, cls: 'H', freq: '116.90' },
  { id: 'LAX', name: 'Los Angeles',lat: 33.933, lng: -118.434, elevFt: 102,  cls: 'H', freq: '113.60' },
  { id: 'SFO', name: 'San Francisco',lat: 37.620, lng: -122.375, elevFt: 13,  cls: 'H', freq: '115.80' },
  { id: 'SEA', name: 'Seattle',    lat: 47.435, lng: -122.310, elevFt: 305,  cls: 'H', freq: '116.80' },
  { id: 'PDX', name: 'Portland',   lat: 45.589, lng: -122.598, elevFt: 26,   cls: 'H', freq: '111.80' },
  { id: 'ABQ', name: 'Albuquerque',lat: 35.045, lng: -106.815, elevFt: 5500, cls: 'H', freq: '113.20' },
  { id: 'BNA', name: 'Nashville',  lat: 36.137, lng: -86.687, elevFt: 600,  cls: 'H', freq: '114.10' },
  { id: 'CLT', name: 'Charlotte',  lat: 35.190, lng: -80.951, elevFt: 740,  cls: 'H', freq: '115.00' },
  { id: 'MEM', name: 'Memphis',    lat: 35.060, lng: -89.987, elevFt: 343,  cls: 'H', freq: '117.50' },
  { id: 'MSY', name: 'New Orleans',lat: 30.000, lng: -90.286, elevFt: 5,    cls: 'H', freq: '113.20' },
  { id: 'MZB', name: 'Mission Bay',lat: 32.781, lng: -117.225, elevFt: 13,  cls: 'L', freq: '117.80' },
  // CONUS additional fill (L/T for terminal density)
  { id: 'PVD', name: 'Providence', lat: 41.724, lng: -71.428, elevFt: 55,   cls: 'L', freq: '115.60' },
  { id: 'HPN', name: 'Westchester',lat: 41.067, lng: -73.708, elevFt: 439,  cls: 'T', freq: '111.40' },
  { id: 'RIC', name: 'Richmond',   lat: 37.500, lng: -77.319, elevFt: 167,  cls: 'L', freq: '114.10' },
  { id: 'JAX', name: 'Craig',      lat: 30.696, lng: -81.504, elevFt: 41,   cls: 'L', freq: '114.50' },
  { id: 'TLH', name: 'Seminole',   lat: 30.557, lng: -84.366, elevFt: 81,   cls: 'L', freq: '115.90' },
  { id: 'AUS', name: 'Austin',     lat: 30.298, lng: -97.700, elevFt: 542,  cls: 'L', freq: '114.00' },
  { id: 'OKC', name: 'Will Rogers',lat: 35.392, lng: -97.621, elevFt: 1290, cls: 'L', freq: '113.20' },
  { id: 'STL', name: 'St Louis',   lat: 38.857, lng: -90.480, elevFt: 605,  cls: 'L', freq: '117.40' },
  { id: 'DSM', name: 'Des Moines', lat: 41.438, lng: -93.649, elevFt: 957,  cls: 'L', freq: '114.10' },
  { id: 'BIL', name: 'Billings',   lat: 45.808, lng: -108.625, elevFt: 3650, cls: 'L', freq: '114.50' },
  { id: 'BOI', name: 'Boise',      lat: 43.552, lng: -116.197, elevFt: 2868, cls: 'L', freq: '113.30' },
  { id: 'RNO', name: 'Mustang',    lat: 39.530, lng: -119.659, elevFt: 5520, cls: 'L', freq: '113.20' },
  { id: 'SAC', name: 'Sacramento', lat: 38.444, lng: -121.551, elevFt: 23,  cls: 'L', freq: '115.20' },
  { id: 'GEG', name: 'Spokane',    lat: 47.566, lng: -117.625, elevFt: 2400, cls: 'L', freq: '115.50' },
  // INTL VORs
  { id: 'LON', name: 'London',     lat: 51.490, lng: -0.460, elevFt: 80,   cls: 'H', freq: '113.60' },
  { id: 'BIG', name: 'Biggin',     lat: 51.331, lng: 0.034,  elevFt: 600,  cls: 'H', freq: '115.10' },
  { id: 'PON', name: 'Pontoise',   lat: 49.097, lng: 2.038,  elevFt: 326,  cls: 'L', freq: '111.60' },
  { id: 'FFM', name: 'Frankfurt',  lat: 50.054, lng: 8.587,  elevFt: 364,  cls: 'H', freq: '114.20' },
  { id: 'KLO', name: 'Kloten',     lat: 47.458, lng: 8.547,  elevFt: 1416, cls: 'H', freq: '114.85' },
  { id: 'ROM', name: 'Roma',       lat: 41.795, lng: 12.500, elevFt: 13,   cls: 'H', freq: '114.90' },
  { id: 'MAD', name: 'Madrid',     lat: 40.466, lng: -3.522, elevFt: 1998, cls: 'H', freq: '112.30' },
  { id: 'YTO', name: 'Toronto',    lat: 43.677, lng: -79.631, elevFt: 569,  cls: 'H', freq: '113.70' },
  { id: 'MEX', name: 'Mexico',     lat: 19.436, lng: -99.072, elevFt: 7300, cls: 'H', freq: '115.70' },
  { id: 'CNF', name: 'Confins',    lat: -23.435, lng: -46.473, elevFt: 2459, cls: 'H', freq: '115.70' },
  { id: 'PAM', name: 'Pampus',     lat: 52.355, lng: 5.020,  elevFt: 0,    cls: 'H', freq: '117.80' },
  { id: 'WOL', name: 'Wollongong', lat: -34.560, lng: 150.789, elevFt: 30,  cls: 'L', freq: '114.10' },
  { id: 'TYO', name: 'Tokyo',      lat: 35.553, lng: 139.781, elevFt: 21,  cls: 'H', freq: '113.70' },
  { id: 'KCC', name: 'Kobuchizawa',lat: 35.881, lng: 138.378, elevFt: 3120, cls: 'L', freq: '116.20' },
]

type Driver = 'MON' | 'RCV' | 'CHN' | 'SVC' | 'NTM' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  MON: 'Nearest MON > 100 nm',
  RCV: 'Insufficient VOR reception',
  CHN: 'VOR chain gap > 90°',
  SVC: 'Outside DOC service volume',
  NTM: 'NOTAM U/S on key VOR',
  NONE: 'Nominal',
}
type Phase = 'ENR' | 'TER' | 'APP'
const PHASE_MUL: Record<Phase, number> = { ENR: 1.00, TER: 1.15, APP: 1.30 }
function classifyPhase(alt: number): Phase {
  if (alt < 6000) return 'APP'
  if (alt < 12000) return 'TER'
  return 'ENR'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}
function haversineNm(la1: number, lo1: number, la2: number, lo2: number) {
  const R = 3440.065
  const dLat = (la2 - la1) * Math.PI / 180
  const dLon = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}
function bearingDeg(la1: number, lo1: number, la2: number, lo2: number) {
  const phi1 = la1 * Math.PI / 180, phi2 = la2 * Math.PI / 180
  const dLon = (lo2 - lo1) * Math.PI / 180
  const y = Math.sin(dLon) * Math.cos(phi2)
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon)
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360
}

interface VisibleVor { v: Vor; distNm: number; elevDeg: number; inCos: boolean; inSvc: boolean; flagged: boolean; bearing: number; sigma: number }
interface Row {
  f: VFlight; phase: Phase; gpsFault: boolean
  nearestMon: MonApt | null; monNm: number
  visible: VisibleVor[]
  chain: VisibleVor[]
  chainGap: number
  sev: { mon: number; rcv: number; chn: number; svc: number; ntm: number }
  score: number; driver: Driver; tier: Tier
}

const SRC_HALO = 'vmon-halo', SRC_LBL = 'vmon-lbl', SRC_PIN = 'vmon-pin', SRC_APT = 'vmon-apt', SRC_VOR = 'vmon-vor', SRC_LINK = 'vmon-link', SRC_LEG = 'vmon-leg', SRC_REF = 'vmon-ref'
const LYR_HALO = SRC_HALO + '-l', LYR_LBL = SRC_LBL + '-l', LYR_PIN = SRC_PIN + '-l', LYR_APT = SRC_APT + '-l', LYR_APT_LBL = SRC_APT + '-lbl-l', LYR_VOR = SRC_VOR + '-l', LYR_VOR_LBL = SRC_VOR + '-lbl-l', LYR_LINK = SRC_LINK + '-l', LYR_LEG = SRC_LEG + '-l', LYR_REF = SRC_REF + '-l'

export default function VorMonReversion({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS' | 'VORS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [regFilter, setRegFilter] = useState<Region | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(30)
  const [gpsLossRate, setGpsLossRate] = useState(35)   // 0-100%
  const [notamRate, setNotamRate] = useState(4)        // 0-25%
  const [docMul, setDocMul] = useState(100)            // 50-200%
  const [monLimit, setMonLimit] = useState(100)        // 50-200 nm
  const [chainMin, setChainMin] = useState(3)          // 1-5
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showApt, setShowApt] = useState(true)
  const [showVor, setShowVor] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showLeg, setShowLeg] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const flaggedVors = useMemo(() => {
    const s = new Set<string>()
    const target = Math.floor(VORS.length * (notamRate / 100))
    const sorted = VORS.slice().sort((a, b) => hash32(a.id) - hash32(b.id))
    for (let i = 0; i < target; i++) s.add(sorted[i].id)
    return s
  }, [notamRate])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt) || f.altitudeFt / 100 < minFl) continue
      const h = hash32(f.icao || '')
      const gpsFault = ((h & 0xffff) / 0xffff) * 100 < gpsLossRate
      const phase = classifyPhase(f.altitudeFt)

      // Nearest MON airport
      let nearestMon: MonApt | null = null
      let monNm = 1e9
      const aptPool = regFilter === 'ALL' ? MON_APTS : MON_APTS.filter(a => a.region === regFilter)
      for (const a of aptPool) {
        const d = haversineNm(f.lat, f.lng, a.lat, a.lng)
        if (d < monNm) { monNm = d; nearestMon = a }
      }

      // Visible VORs
      const acH = Math.max(0, f.altitudeFt)
      const vis: VisibleVor[] = []
      for (const v of VORS) {
        const ground = haversineNm(f.lat, f.lng, v.lat, v.lng)
        const horizon = 1.23 * (Math.sqrt(acH) + Math.sqrt(Math.max(0, v.elevFt)))
        if (ground > horizon) continue
        const rng = CLASS_RANGE[v.cls] * (docMul / 100)
        const dh = acH - v.elevFt
        const slant = Math.sqrt(ground * ground + (dh / 6076.12) ** 2)
        const elev = Math.atan2(dh / 6076.12, ground) * 180 / Math.PI
        const inCos = elev > 60
        // Service volume altitude band per AIM 1-1-3
        const altOk = v.cls === 'T' ? (acH >= 1000 && acH <= 12000)
                    : v.cls === 'L' ? (acH >= 1000 && acH <= 18000)
                    : (acH >= 1000 && acH <= 60000)
        const inSvc = ground <= rng && altOk
        if (!inSvc) continue
        const flagged = flaggedVors.has(v.id)
        if (inCos) continue
        const sigma = 0.5 + 0.012 * ground + (flagged ? 0.8 : 0)
        vis.push({ v, distNm: slant, elevDeg: elev, inCos, inSvc, flagged, bearing: bearingDeg(f.lat, f.lng, v.lat, v.lng), sigma })
      }
      vis.sort((a, b) => a.distNm - b.distNm)
      const chain = vis.slice(0, 3)

      // Chain bearing gap (max difference between consecutive bearings around the circle)
      let chainGap = 0
      if (chain.length >= 2) {
        const bs = chain.map(c => c.bearing).sort((a, b) => a - b)
        for (let i = 0; i < bs.length; i++) {
          const next = bs[(i + 1) % bs.length]
          let d = (next - bs[i] + 360) % 360
          if (d > chainGap) chainGap = d
        }
        chainGap = Math.min(chainGap, 360 - chainGap < chainGap ? 360 - chainGap : chainGap)
      } else {
        chainGap = 360
      }

      const monSev = monNm >= 150 ? 100 : monNm <= 50 ? 0 : ((monNm - 50) / 100) * 100
      const rcvSev = vis.length === 0 ? 100 : vis.length === 1 ? 60 : vis.length === 2 ? 30 : 0
      const chnSev = chain.length < 2 ? 100 : chainGap >= 120 ? 100 : chainGap <= 45 ? 0 : ((chainGap - 45) / 75) * 100
      const svcSev = vis.length === 0 && !gpsFault ? 0 : (vis.length === 0 ? 60 : 0)
      const nearestVorFlagged = chain.length > 0 && chain[0].flagged
      const monColloc = nearestMon ? VORS.find(v => v.id === nearestMon!.icao.slice(1, 4)) : null
      const monVorFlagged = monColloc ? flaggedVors.has(monColloc.id) : false
      const ntmSev = (nearestVorFlagged || monVorFlagged) ? 45 : 0

      // Only score risk if GPS is faulted; otherwise it's just an advisory measurement
      const sev = { mon: monSev, rcv: rcvSev, chn: chnSev, svc: svcSev, ntm: ntmSev }
      const drivers: Array<[Driver, number]> = [['MON', sev.mon], ['RCV', sev.rcv], ['CHN', sev.chn], ['SVC', sev.svc], ['NTM', sev.ntm]]
      drivers.sort((a, b) => b[1] - a[1])
      const driver: Driver = drivers[0][1] >= 12 ? drivers[0][0] : 'NONE'
      let score = Math.min(100, drivers[0][1] * PHASE_MUL[phase] + 0.10 * drivers[1][1])
      if (!gpsFault) score = score * 0.35   // Advisory mode when GPS healthy
      if (monNm > 200 || !nearestMon) score = Math.max(score, gpsFault ? 90 : 30)
      if (monNm > monLimit && gpsFault) score = Math.max(score, 60)

      let tier: Tier
      if (gpsFault && (score >= 80 || monNm > 200)) tier = 'NORDIRECT'
      else if (gpsFault && (score >= 55 || monNm > monLimit || vis.length < 2)) tier = 'DEGRADED'
      else if (score >= 25 || (gpsFault && vis.length < chainMin)) tier = 'WATCH'
      else tier = 'OK'

      out.push({ f, phase, gpsFault, nearestMon, monNm, visible: vis, chain, chainGap, sev, score, driver, tier })
    }
    return out
  }, [flights, minFl, gpsLossRate, notamRate, docMul, monLimit, chainMin, regFilter, flaggedVors])

  const tierCount: Record<Tier, number> = { NORDIRECT: 0, DEGRADED: 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const r of rows) tierCount[r.tier]++

  const meanMon = rows.length ? rows.reduce((a, r) => a + Math.min(300, r.monNm), 0) / rows.length : 0
  const meanRcv = rows.length ? rows.reduce((a, r) => a + r.visible.length, 0) / rows.length : 0
  const gpsFaultShare = rows.length ? rows.filter(r => r.gpsFault).length / rows.length : 0
  const worst = rows.length ? rows.slice().sort((a, b) => b.score - a.score)[0] : null

  const aptRows = useMemo(() => {
    const m = new Map<string, { apt: MonApt; served: number; sumScore: number; nordCount: number }>()
    for (const r of rows) {
      if (!r.nearestMon) continue
      const e = m.get(r.nearestMon.icao) || { apt: r.nearestMon, served: 0, sumScore: 0, nordCount: 0 }
      e.served++; e.sumScore += r.score; if (r.tier === 'NORDIRECT') e.nordCount++
      m.set(r.nearestMon.icao, e)
    }
    const arr: Array<{ apt: MonApt; served: number; meanScore: number; nordCount: number }> = []
    for (const [, v] of m) arr.push({ apt: v.apt, served: v.served, meanScore: v.served ? v.sumScore / v.served : 0, nordCount: v.nordCount })
    for (const a of MON_APTS) if (!m.has(a.icao)) arr.push({ apt: a, served: 0, meanScore: 0, nordCount: 0 })
    arr.sort((a, b) => b.served - a.served || a.apt.icao.localeCompare(b.apt.icao))
    return arr
  }, [rows])

  const vorRows = useMemo(() => {
    const m = new Map<string, { v: Vor; tracked: number; sumSig: number; flagged: boolean }>()
    for (const r of rows) for (const v of r.chain) {
      const e = m.get(v.v.id) || { v: v.v, tracked: 0, sumSig: 0, flagged: v.flagged }
      e.tracked++; e.sumSig += v.sigma
      m.set(v.v.id, e)
    }
    const arr: Array<{ v: Vor; tracked: number; meanSig: number; flagged: boolean }> = []
    for (const [, e] of m) arr.push({ v: e.v, tracked: e.tracked, meanSig: e.tracked ? e.sumSig / e.tracked : 0, flagged: e.flagged })
    for (const v of VORS) if (!m.has(v.id)) arr.push({ v, tracked: 0, meanSig: 0, flagged: flaggedVors.has(v.id) })
    arr.sort((a, b) => b.tracked - a.tracked || a.v.id.localeCompare(b.v.id))
    return arr
  }, [rows, flaggedVors])

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    const q = query.trim().toLowerCase()
    if (q) r = r.filter(x => (x.f.callsign || '').toLowerCase().includes(q) || (x.f.type || '').toLowerCase().includes(q) || (x.f.icao || '').toLowerCase().includes(q))
    return r.slice().sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [rows, tierFilter, query])

  useEffect(() => {
    if (!map) return
    const ensure = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }) }
    const sources = [SRC_HALO, SRC_LBL, SRC_PIN, SRC_APT, SRC_VOR, SRC_LINK, SRC_LEG, SRC_REF]
    sources.forEach(ensure)
    if (!map.getLayer(LYR_REF)) map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: { 'line-color': '#0ea5e9', 'line-opacity': 0.14, 'line-width': 0.7, 'line-dasharray': [2, 4] } })
    if (!map.getLayer(LYR_LEG)) map.addLayer({ id: LYR_LEG, type: 'line', source: SRC_LEG, paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.7, 'line-dasharray': [3, 2] } })
    if (!map.getLayer(LYR_LINK)) map.addLayer({ id: LYR_LINK, type: 'line', source: SRC_LINK, paint: { 'line-color': ['get', 'color'], 'line-width': 1, 'line-opacity': 0.5, 'line-dasharray': [1.5, 2] } })
    if (!map.getLayer(LYR_HALO)) map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.16, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-opacity': 0.65, 'circle-stroke-width': 1.4 } })
    if (!map.getLayer(LYR_VOR)) map.addLayer({ id: LYR_VOR, type: 'circle', source: SRC_VOR, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.85, 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1 } })
    if (!map.getLayer(LYR_VOR_LBL)) map.addLayer({ id: LYR_VOR_LBL, type: 'symbol', source: SRC_VOR, layout: { 'text-field': ['get', 'id'], 'text-size': 9, 'text-offset': [0, 0.9], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    if (!map.getLayer(LYR_APT)) map.addLayer({ id: LYR_APT, type: 'circle', source: SRC_APT, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.85, 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1.4 } })
    if (!map.getLayer(LYR_APT_LBL)) map.addLayer({ id: LYR_APT_LBL, type: 'symbol', source: SRC_APT, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.1], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.4 } })
    if (!map.getLayer(LYR_PIN)) map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: { 'text-field': '◆', 'text-size': 13, 'text-allow-overlap': true }, paint: { 'text-color': '#ef4444', 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    if (!map.getLayer(LYR_LBL)) map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })

    const halo: any[] = [], lbl: any[] = [], pin: any[] = [], apt: any[] = [], vor: any[] = [], link: any[] = [], leg: any[] = [], ref: any[] = []

    if (showApt) {
      for (const ar of aptRows) {
        if (regFilter !== 'ALL' && ar.apt.region !== regFilter) continue
        const c = ar.apt.region === 'CONUS' ? '#0ea5e9' : '#a855f7'
        const r = 4 + Math.min(5, Math.sqrt(ar.served))
        apt.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [ar.apt.lng, ar.apt.lat] }, properties: { color: c, r, label: ar.apt.icao + ' · MON' } })
      }
    }
    if (showVor) {
      for (const vr of vorRows) {
        const c = vr.flagged ? '#ef4444' : CLASS_COLOR[vr.v.cls]
        const r = 3 + Math.min(3, Math.sqrt(vr.tracked))
        vor.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [vr.v.lng, vr.v.lat] }, properties: { id: vr.v.id, color: c, r } })
      }
    }
    for (const r of rows) {
      const color = TIER_COLOR[r.tier]
      if (showHalo && r.tier !== 'OK' && r.tier !== 'IDLE') {
        const rad = 8 + (r.score / 100) * 14
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, r: rad } })
      }
      if (showPin && r.tier === 'NORDIRECT') pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      if (showLbl && (r.tier === 'NORDIRECT' || r.tier === 'DEGRADED')) {
        const label = `${r.f.callsign || r.f.icao} ${r.gpsFault ? '! ' : ''}· MON ${r.monNm.toFixed(0)}nm ${r.nearestMon?.icao || ''} · ${r.visible.length}VOR`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, label } })
      }
      if (showLeg && r.nearestMon && r.tier !== 'OK' && r.tier !== 'IDLE') {
        leg.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.nearestMon.lng, r.nearestMon.lat]] }, properties: { color } })
      }
      if (showLink && r.tier !== 'OK' && r.tier !== 'IDLE') {
        for (const c of r.chain) link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [c.v.lng, c.v.lat]] }, properties: { color } })
      }
    }
    for (const lat of [60, 30, 0, -30, -60]) {
      const coords: [number, number][] = []
      for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, lat])
      ref.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} })
    }

    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_APT) as any).setData({ type: 'FeatureCollection', features: apt })
    ;(map.getSource(SRC_VOR) as any).setData({ type: 'FeatureCollection', features: vor })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })
    ;(map.getSource(SRC_LEG) as any).setData({ type: 'FeatureCollection', features: leg })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: ref })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_LEG, LYR_VOR_LBL, LYR_VOR, LYR_APT_LBL, LYR_APT, LYR_REF]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of sources) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, rows, aptRows, vorRows, showHalo, showPin, showLbl, showApt, showVor, showLink, showLeg, regFilter])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const driverBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const advice = (r: Row) => {
    if (r.tier === 'NORDIRECT') return 'Revert conventional VOR nav · request ATC radar vectors per JO 7110.65 5-1-2 · squawk 7600 if comm also lost · file PBN deviation per AC 90-105A'
    if (r.tier === 'DEGRADED') return `Brief crew · request lower for L-class VOR pickup · proceed direct ${r.nearestMon?.icao || 'MON'} (${r.monNm.toFixed(0)}nm) per Order 8260.55A`
    if (r.tier === 'WATCH') return 'Monitor GPS RAIM · log RNP downgrade per AC 90-105A · pre-tune nearest VOR for instant reversion'
    return `MON ready · ${r.nearestMon?.icao} ${r.monNm.toFixed(0)}nm · ${r.visible.length} VORs receivable`
  }

  // Scatter
  const W = 280, H = 180
  const xMax = 200, yMax = 6
  const sx = (n: number) => 32 + (Math.min(xMax, n) / xMax) * (W - 42)
  const sy = (e: number) => H - 24 - (Math.min(yMax, e) / yMax) * (H - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">VOR MON · GPS-Loss Reversion</div>
          <div className="text-[10px] text-slate-500">FAA Order JO 7400.10 / 1100.181 · 8260.55A · AC 90-100A §6 · AIM 1-1-3</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[10px] font-semibold" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean MON</div>
          <div className="text-sm font-semibold" style={{ color: meanMon > 100 ? '#ef4444' : meanMon > 60 ? '#f59e0b' : '#10b981' }}>{meanMon.toFixed(0)} nm</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">NORDIRECT</div>
          <div className="text-sm font-semibold" style={{ color: tierCount.NORDIRECT > 0 ? '#ef4444' : '#10b981' }}>{tierCount.NORDIRECT}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean receivable VOR</div>
          <div className="text-xs font-semibold" style={{ color: meanRcv >= 3 ? '#10b981' : meanRcv >= 2 ? '#0ea5e9' : meanRcv >= 1 ? '#f59e0b' : '#ef4444' }}>{meanRcv.toFixed(1)}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">GPS fault share</div>
          <div className="text-xs font-semibold" style={{ color: gpsFaultShare > 0.5 ? '#ef4444' : gpsFaultShare > 0.2 ? '#f59e0b' : '#10b981' }}>{(gpsFaultShare * 100).toFixed(1)}%</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={32} y={24} width={W - 42} height={H - 48} fill="#0b1220" />
            <rect x={sx(150)} y={24} width={W - 10 - sx(150)} height={sy(0) - 24} fill="#ef4444" opacity={0.10} />
            <rect x={sx(75)} y={24} width={sx(150) - sx(75)} height={sy(0) - 24} fill="#f59e0b" opacity={0.08} />
            <rect x={sx(50)} y={sy(3)} width={sx(75) - sx(50)} height={sy(0) - sy(3)} fill="#0ea5e9" opacity={0.08} />
            <line x1={sx(monLimit)} x2={sx(monLimit)} y1={24} y2={H - 24} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.7} />
            <line x1={32} x2={W - 10} y1={sy(chainMin)} y2={sy(chainMin)} stroke="#10b981" strokeDasharray="3 3" strokeOpacity={0.6} />
            {rows.map((r, i) => (
              <circle key={i} cx={sx(r.monNm)} cy={sy(r.visible.length)} r={2.4} fill={TIER_COLOR[r.tier]} opacity={r.gpsFault ? 0.9 : 0.4} />
            ))}
            <text x={W / 2} y={H - 6} fontSize={9} fill="#64748b" textAnchor="middle">nearest MON nm</text>
            <text x={6} y={H / 2} fontSize={9} fill="#64748b" transform={`rotate(-90 6 ${H / 2})`} textAnchor="middle">receivable VOR</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-FL {minFl}</span><input type="range" min={0} max={400} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">GPS-LOSS {gpsLossRate}%</span><input type="range" min={0} max={100} value={gpsLossRate} onChange={e => setGpsLossRate(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">NOTAM U/S {notamRate}%</span><input type="range" min={0} max={25} value={notamRate} onChange={e => setNotamRate(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">DOC-MUL {docMul}%</span><input type="range" min={50} max={200} value={docMul} onChange={e => setDocMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MON-LIMIT {monLimit} nm</span><input type="range" min={50} max={200} value={monLimit} onChange={e => setMonLimit(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">CHAIN-MIN {chainMin}</span><input type="range" min={1} max={5} value={chainMin} onChange={e => setChainMin(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setRegFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${regFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {(['CONUS', 'INTL'] as const).map(r => (
          <button key={r} onClick={() => setRegFilter(regFilter === r ? 'ALL' : r)} className={`px-2 py-0.5 rounded text-[10px] border ${regFilter === r ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{r}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLbl, setShowLbl], ['APT', showApt, setShowApt], ['VOR', showVor, setShowVor], ['LINK', showLink, setShowLink], ['LEG', showLeg, setShowLeg], ['DIAG', showDiag, setShowDiag]] as const).map(([l, v, s]) => (
          <button key={l} onClick={() => s(!v)} className={`px-2 py-0.5 rounded text-[10px] border ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-500'}`}>{l}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search callsign / type / icao" className="flex-1 min-w-[120px] px-2 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        {(['AIRCRAFT', 'AIRPORTS', 'VORS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded text-[11px] border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.slice(0, 80).map((r, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <button onClick={() => onFly(r.f.icao)} className="font-semibold text-slate-100 hover:text-sky-300 truncate">{r.f.callsign || r.f.icao}</button>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{r.phase}</span>
              {r.gpsFault && <span className="px-1 py-px rounded text-[9px] bg-rose-500/15 text-rose-300 border border-rose-500/30">GPS!</span>}
              <div className="ml-auto">{tierBadge(r.tier)}</div>
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              FL{Math.round(r.f.altitudeFt / 100)} · MON {r.nearestMon?.icao || '—'} @ {r.monNm.toFixed(0)}nm · {r.visible.length} VORs · chain {r.chain.map(c => c.v.id).join('›') || '—'} · gap {r.chainGap.toFixed(0)}°
            </div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} className="h-full" />
              </div>
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {driverBadge('MON', r.sev.mon)}{driverBadge('RCV', r.sev.rcv)}{driverBadge('CHN', r.sev.chn)}{driverBadge('SVC', r.sev.svc)}{driverBadge('NTM', r.sev.ntm)}
            </div>
            <div className="px-2 pb-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>› {advice(r)}</div>
          </div>
        ))}
        {tab === 'AIRCRAFT' && filtered.length === 0 && <div className="text-center py-6 text-slate-500 text-[11px]">No aircraft match the current filters.</div>}

        {tab === 'AIRPORTS' && aptRows.slice(0, 80).map((ar, i) => {
          const c = ar.apt.region === 'CONUS' ? '#0ea5e9' : '#a855f7'
          return (
            <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
              <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${c}` }}>
                <span className="font-semibold text-slate-100">{ar.apt.icao}</span>
                <span className="text-slate-500 text-[10px] truncate">{ar.apt.name}</span>
                <span className="px-1 py-px rounded text-[9px]" style={{ color: c, backgroundColor: c + '22', border: `1px solid ${c}66` }}>{ar.apt.region}</span>
                <span className="ml-auto px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{ar.served} AC</span>
                {ar.nordCount > 0 && <span className="px-1 py-px rounded text-[9px] bg-rose-500/15 text-rose-300 border border-rose-500/30">{ar.nordCount} NORD</span>}
              </div>
              <div className="px-2 pb-1">
                <div className="h-1 rounded bg-slate-800 overflow-hidden">
                  <div style={{ width: `${ar.meanScore}%`, backgroundColor: ar.meanScore >= 55 ? '#f59e0b' : ar.meanScore >= 25 ? '#0ea5e9' : '#10b981' }} className="h-full" />
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">mean score {ar.meanScore.toFixed(0)} · MON destination per 8260.55A</div>
              </div>
            </div>
          )
        })}

        {tab === 'VORS' && vorRows.slice(0, 80).map((vr, i) => {
          const c = vr.flagged ? '#ef4444' : CLASS_COLOR[vr.v.cls]
          return (
            <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
              <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${c}` }}>
                <span className="font-semibold text-slate-100">{vr.v.id}</span>
                <span className="text-slate-500 text-[10px] truncate">{vr.v.name}</span>
                <span className="px-1 py-px rounded text-[9px]" style={{ color: c, backgroundColor: c + '22', border: `1px solid ${c}66` }}>{vr.v.cls}-class</span>
                {vr.flagged && <span className="px-1 py-px rounded text-[9px] bg-rose-500/15 text-rose-300 border border-rose-500/30">U/S</span>}
                <span className="ml-auto px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{vr.tracked} AC</span>
              </div>
              <div className="px-2 pb-1 text-[10px] text-slate-500">{vr.v.freq} MHz · elev {vr.v.elevFt} ft · range {CLASS_RANGE[vr.v.cls]} nm · σ̄ {vr.meanSig.toFixed(2)}</div>
            </div>
          )
        })}
      </div>

      <div className="px-3 py-2 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        Refs: FAA Order JO 7400.10 VOR MON Inventory · 1100.181 MON Program · 8260.55A Special VOR/DME/NDB · AC 90-100A §6 · AC 90-117A · AIM 1-1-3 · Order 6700.20A · Order 7110.65 4-3 · 81 FR 36772 · GAO-18-263 · DOT VOLPE GPS Backup 2020 · ICAO Annex 10 Vol I 3.3 · Doc 8071 Vol I · Doc 9613 Vol II Pt B App C · RTCA DO-196/DO-220 · ARINC 711-10. MON spec: within 5,000 ft AGL of any CONUS point at most 77 nm slant to a MON airport per FAA Final Rule 81 FR 36772.
      </div>
    </div>
  )
}
