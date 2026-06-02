'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Navaid Coverage Atlas (DME/DME + VOR/DME positioning)
   -----------------------------------------------------------
   Live ground-based-navaid backup-positioning availability for
   every airborne aircraft, scored against the FAA AC 90-100A /
   ICAO Doc 9613 PBN manual DME/DME RNAV-1 receiver criteria:

     - line-of-sight slant-range visibility to a curated set of
       VOR/DME and VORTAC stations (encoded constant table — 95
       major North-American, European, and Asian high-altitude
       facilities tagged H = high-alt (130nm SSV) / L = low-alt
       (40nm) / T = terminal (25nm)).
     - per-aircraft RANGE = min(SSV-class-range, radio-horizon)
       where radio-horizon-nm = 1.23 * (sqrt(altFt) + sqrt(120))
       (assuming 120ft typical antenna mast height).
     - station considered "in-view" when slant-range <= RANGE.
     - DME/DME RNAV-1 fix quality requires at least 2 in-view
       DMEs whose intersection angle (angle between aircraft
       bearings to the two stations) falls in the 30°–150° band
       (FAA AC 90-100A §5.4.1.4); we compute the BEST pair as
       the pair maximising |sin(intersect-angle)| (most orthogonal
       geometry → smallest position-fix error ellipse), then a
       FOM (Figure of Merit) = sin(angle) * sqrt(N_in_view)/sqrt(8)
       capped at 1.0 — both geometry and redundancy.

   Tier classification per airframe:
     RNP-1   FOM >= 0.65 AND >= 4 DMEs in view AND geometry 60–120°  emerald
     RNP-2   FOM >= 0.40 AND >= 3 DMEs in view AND geometry 30–150°  sky
     VOR-ONLY <2 useful DMEs but >=1 VOR in view                     amber
     GAP    <1 VOR in view                                           rose

   GAP tier flags the aircraft as fully dependent on GPS for
   primary navigation — a real concern in the modern jamming /
   ionospheric scintillation environment (pairs naturally with
   the existing RAIM monitor).

   MapLibre overlay:
     - tier-coloured halo ring per aircraft sized by 1 - FOM
       (worse geometry → bigger halo, 7-20px)
     - dashed sky lines from each RNP-1/RNP-2 aircraft to its
       BEST pair of DMEs (2 short lines, faint, to visualise
       the position-fix triangle)
     - tier-coloured station pins (size 4-6 by SSV class) with
       4-char ICAO labels (e.g. SBV, CYN, LAS)
     - tier-coloured callsign + tier + FOM-percent labels

   Side panel:
     - 4-tier counter strip click-to-filter
     - 3-cell GAP-COUNT / MEAN-FOM / MEAN-DMES summary
     - SVG geometry diagram: x = intersect-angle 0-180°, y = FOM
       0-1, with tier-threshold dashed boxes shaded, every
       aircraft plotted as a tier-coloured dot at (angle, FOM)
     - 4 sliders: MIN-FL / MAX-FL / MAST-FT (antenna height) /
       SSV-MULT (range scaling, 60-130%)
     - 7-class chip filter row
     - HALO/PINS/LINES/LBL toggle row
     - callsign / type / operator / icao / VOR-id search
     - AIRCRAFT tab: sorted by tier worst-first then asc FOM
       with tier color stripe, callsign + type + class-pill +
       tier-pill, FL/dmesInView/vors/angle line, tier-coloured
       FOM progress bar 0-100% with rose/amber/sky/emerald
       threshold ticks at 0/20/40/65%, best-pair-ids+sin-angle
       footer, operator footer, click-to-fly per row
     - STATIONS tab: sorted by aircraft-count desc with usage-
       coloured stripe + id + name + ssv-class-pill + count line
       + tier-coloured aircraft count progress bar, lat/lng+freq
       footer, click-to-fly to station

   Registered under Layers > Safety & Traffic category.
   ft-navaid persisted preference.
   ============================================================ */

export interface NavaidFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  category?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: NavaidFlight[]
  onClose: () => void
  onFly: (icao: string) => void
  onFlyLatLng?: (lat: number, lng: number, zoom?: number) => void
}

type Tier = 'RNP-1' | 'RNP-2' | 'VOR-ONLY' | 'GAP'
const TIER_COLOR: Record<Tier, string> = {
  'RNP-1': '#10b981',
  'RNP-2': '#0ea5e9',
  'VOR-ONLY': '#f59e0b',
  GAP: '#ef4444',
}
const TIER_ORDER: Tier[] = ['GAP', 'VOR-ONLY', 'RNP-2', 'RNP-1']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}

function classify(t: string | undefined, cat?: string): Klass {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || /^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139)/.test(x)) return 'ga'
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|A30|B76|C5|C17)/.test(x)) return 'heavy'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|E19|E29|CRJ9|CS|BCS)/.test(x)) return 'narrow'
  if (/^(CRJ|E14|E15|E17|E70|E75|AT4|AT5|AT7|DH8|SF34|J32|J41|ATR)/.test(x)) return 'regional'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'biz'
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS)/.test(x)) return 'fighter'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|BE9|BE3|TBM|PC12|TB|PC6|C20|DHC2|DHC6|AN2)/.test(x)) return 'turboprop'
  return 'narrow'
}

type SsvClass = 'H' | 'L' | 'T'
const SSV_RANGE_NM: Record<SsvClass, number> = { H: 130, L: 40, T: 25 }

interface Station {
  id: string
  name: string
  lat: number
  lng: number
  freq: number   // VHF MHz
  cls: SsvClass
  hasDme: boolean
}

// Curated VOR/VORTAC/DME stations — major high-altitude facilities worldwide.
const STATIONS: Station[] = [
  // USA HIGH-altitude VORs (Hs - typically 130nm at FL180+)
  { id: 'JFK', name: 'KENNEDY', lat: 40.633, lng: -73.778, freq: 115.9, cls: 'H', hasDme: true },
  { id: 'LGA', name: 'LA GUARDIA', lat: 40.778, lng: -73.872, freq: 113.1, cls: 'H', hasDme: true },
  { id: 'BWZ', name: 'BREWSTER', lat: 41.527, lng: -73.610, freq: 116.6, cls: 'H', hasDme: true },
  { id: 'SBJ', name: 'SOLBERG', lat: 40.578, lng: -74.745, freq: 112.9, cls: 'H', hasDme: true },
  { id: 'ETX', name: 'EAST TEXAS', lat: 40.580, lng: -75.683, freq: 110.6, cls: 'H', hasDme: true },
  { id: 'BOS', name: 'BOSTON', lat: 42.357, lng: -70.989, freq: 112.7, cls: 'H', hasDme: true },
  { id: 'DCA', name: 'WASHINGTON', lat: 38.860, lng: -77.035, freq: 111.0, cls: 'H', hasDme: true },
  { id: 'IAD', name: 'DULLES', lat: 38.945, lng: -77.464, freq: 113.5, cls: 'H', hasDme: true },
  { id: 'RIC', name: 'RICHMOND', lat: 37.500, lng: -77.319, freq: 114.1, cls: 'H', hasDme: true },
  { id: 'ORF', name: 'NORFOLK', lat: 36.894, lng: -76.201, freq: 116.9, cls: 'H', hasDme: true },
  { id: 'RDU', name: 'RALEIGH', lat: 35.872, lng: -78.783, freq: 117.2, cls: 'H', hasDme: true },
  { id: 'CLT', name: 'CHARLOTTE', lat: 35.190, lng: -80.948, freq: 115.0, cls: 'H', hasDme: true },
  { id: 'ATL', name: 'ATLANTA', lat: 33.629, lng: -84.439, freq: 116.9, cls: 'H', hasDme: true },
  { id: 'MCO', name: 'ORLANDO', lat: 28.542, lng: -81.336, freq: 112.2, cls: 'H', hasDme: true },
  { id: 'MIA', name: 'MIAMI', lat: 25.820, lng: -80.290, freq: 115.9, cls: 'H', hasDme: true },
  { id: 'TPA', name: 'TAMPA', lat: 27.967, lng: -82.456, freq: 110.8, cls: 'H', hasDme: true },
  { id: 'JAX', name: 'JACKSONVILLE', lat: 30.494, lng: -81.535, freq: 112.6, cls: 'H', hasDme: true },
  { id: 'MEM', name: 'MEMPHIS', lat: 35.064, lng: -89.985, freq: 117.5, cls: 'H', hasDme: true },
  { id: 'BNA', name: 'NASHVILLE', lat: 36.137, lng: -86.682, freq: 114.1, cls: 'H', hasDme: true },
  { id: 'ORD', name: 'CHICAGO O\'HARE', lat: 41.985, lng: -87.907, freq: 113.9, cls: 'H', hasDme: true },
  { id: 'DPA', name: 'DUPAGE', lat: 41.910, lng: -88.249, freq: 108.4, cls: 'L', hasDme: true },
  { id: 'JOT', name: 'JOLIET', lat: 41.547, lng: -88.319, freq: 112.3, cls: 'H', hasDme: true },
  { id: 'IOW', name: 'IOWA CITY', lat: 41.668, lng: -91.535, freq: 117.1, cls: 'H', hasDme: true },
  { id: 'DSM', name: 'DES MOINES', lat: 41.438, lng: -93.648, freq: 114.1, cls: 'H', hasDme: true },
  { id: 'MSP', name: 'MINNEAPOLIS', lat: 44.880, lng: -93.225, freq: 115.3, cls: 'H', hasDme: true },
  { id: 'DEN', name: 'DENVER', lat: 39.812, lng: -104.660, freq: 117.9, cls: 'H', hasDme: true },
  { id: 'BJC', name: 'BROOMFIELD', lat: 39.918, lng: -105.118, freq: 115.4, cls: 'L', hasDme: true },
  { id: 'PUB', name: 'PUEBLO', lat: 38.286, lng: -104.426, freq: 116.7, cls: 'H', hasDme: true },
  { id: 'ABQ', name: 'ALBUQUERQUE', lat: 35.041, lng: -106.815, freq: 113.2, cls: 'H', hasDme: true },
  { id: 'PHX', name: 'PHOENIX', lat: 33.434, lng: -112.011, freq: 115.6, cls: 'H', hasDme: true },
  { id: 'TUS', name: 'TUCSON', lat: 32.094, lng: -110.917, freq: 116.0, cls: 'H', hasDme: true },
  { id: 'LAS', name: 'LAS VEGAS', lat: 36.080, lng: -115.159, freq: 116.9, cls: 'H', hasDme: true },
  { id: 'LAX', name: 'LOS ANGELES', lat: 33.933, lng: -118.434, freq: 113.6, cls: 'H', hasDme: true },
  { id: 'PMD', name: 'PALMDALE', lat: 34.629, lng: -118.057, freq: 114.5, cls: 'H', hasDme: true },
  { id: 'SAN', name: 'SAN DIEGO', lat: 32.733, lng: -117.196, freq: 117.8, cls: 'H', hasDme: true },
  { id: 'SFO', name: 'SAN FRANCISCO', lat: 37.620, lng: -122.374, freq: 115.8, cls: 'H', hasDme: true },
  { id: 'OAK', name: 'OAKLAND', lat: 37.722, lng: -122.222, freq: 116.8, cls: 'H', hasDme: true },
  { id: 'SAC', name: 'SACRAMENTO', lat: 38.444, lng: -121.553, freq: 115.2, cls: 'H', hasDme: true },
  { id: 'PDX', name: 'PORTLAND', lat: 45.595, lng: -122.605, freq: 111.8, cls: 'H', hasDme: true },
  { id: 'SEA', name: 'SEATTLE', lat: 47.435, lng: -122.310, freq: 116.8, cls: 'H', hasDme: true },
  { id: 'GEG', name: 'SPOKANE', lat: 47.566, lng: -117.625, freq: 115.5, cls: 'H', hasDme: true },
  { id: 'SLC', name: 'SALT LAKE', lat: 40.853, lng: -111.983, freq: 116.8, cls: 'H', hasDme: true },
  { id: 'BIL', name: 'BILLINGS', lat: 45.807, lng: -108.625, freq: 114.5, cls: 'H', hasDme: true },
  { id: 'MSY', name: 'NEW ORLEANS', lat: 30.000, lng: -90.265, freq: 113.2, cls: 'H', hasDme: true },
  { id: 'IAH', name: 'HOUSTON', lat: 29.939, lng: -95.341, freq: 116.6, cls: 'H', hasDme: true },
  { id: 'DFW', name: 'DALLAS', lat: 32.864, lng: -97.027, freq: 117.0, cls: 'H', hasDme: true },
  { id: 'OKC', name: 'OKLAHOMA CITY', lat: 35.391, lng: -97.601, freq: 113.2, cls: 'H', hasDme: true },
  { id: 'ICT', name: 'WICHITA', lat: 37.748, lng: -97.221, freq: 113.8, cls: 'H', hasDme: true },
  // CANADA
  { id: 'YYZ', name: 'TORONTO', lat: 43.677, lng: -79.631, freq: 113.3, cls: 'H', hasDme: true },
  { id: 'YOW', name: 'OTTAWA', lat: 45.322, lng: -75.669, freq: 114.6, cls: 'H', hasDme: true },
  { id: 'YUL', name: 'MONTREAL', lat: 45.470, lng: -73.741, freq: 116.3, cls: 'H', hasDme: true },
  { id: 'YVR', name: 'VANCOUVER', lat: 49.196, lng: -123.183, freq: 115.9, cls: 'H', hasDme: true },
  { id: 'YYC', name: 'CALGARY', lat: 51.114, lng: -114.020, freq: 116.7, cls: 'H', hasDme: true },
  { id: 'YEG', name: 'EDMONTON', lat: 53.310, lng: -113.580, freq: 113.1, cls: 'H', hasDme: true },
  { id: 'YHZ', name: 'HALIFAX', lat: 44.881, lng: -63.508, freq: 115.1, cls: 'H', hasDme: true },
  // EUROPE
  { id: 'LON', name: 'LONDON', lat: 51.488, lng: -0.461, freq: 113.6, cls: 'H', hasDme: true },
  { id: 'BPK', name: 'BROOKMANS PARK', lat: 51.749, lng: -0.108, freq: 117.5, cls: 'H', hasDme: true },
  { id: 'BIG', name: 'BIGGIN', lat: 51.331, lng: 0.034, freq: 115.1, cls: 'H', hasDme: true },
  { id: 'DVR', name: 'DOVER', lat: 51.162, lng: 1.350, freq: 114.9, cls: 'H', hasDme: true },
  { id: 'POL', name: 'POLE HILL', lat: 53.745, lng: -2.105, freq: 112.1, cls: 'H', hasDme: true },
  { id: 'SAB', name: 'SABA', lat: 52.026, lng: 5.139, freq: 113.3, cls: 'H', hasDme: true },
  { id: 'PAM', name: 'PAMPUS', lat: 52.354, lng: 5.012, freq: 117.8, cls: 'H', hasDme: true },
  { id: 'SPI', name: 'SPIJKERBOOR', lat: 52.541, lng: 4.853, freq: 113.6, cls: 'H', hasDme: true },
  { id: 'BRU', name: 'BRUSSELS', lat: 50.901, lng: 4.539, freq: 114.6, cls: 'H', hasDme: true },
  { id: 'PAR', name: 'PARIS', lat: 49.018, lng: 2.561, freq: 115.6, cls: 'H', hasDme: true },
  { id: 'CDN', name: 'COULOMMIERS', lat: 48.840, lng: 3.026, freq: 116.5, cls: 'H', hasDme: true },
  { id: 'FFM', name: 'FRANKFURT', lat: 50.082, lng: 8.555, freq: 114.2, cls: 'H', hasDme: true },
  { id: 'KRH', name: 'KARLSRUHE', lat: 49.001, lng: 8.456, freq: 115.9, cls: 'H', hasDme: true },
  { id: 'MUN', name: 'MUNICH', lat: 48.180, lng: 11.816, freq: 112.3, cls: 'H', hasDme: true },
  { id: 'ZUE', name: 'ZURICH', lat: 47.586, lng: 8.818, freq: 110.0, cls: 'H', hasDme: true },
  { id: 'GVA', name: 'GENEVA', lat: 46.247, lng: 6.130, freq: 114.0, cls: 'H', hasDme: true },
  { id: 'TGO', name: 'TANGO', lat: 41.799, lng: 12.244, freq: 114.9, cls: 'H', hasDme: true },
  { id: 'OST', name: 'OSTIA', lat: 41.802, lng: 12.236, freq: 114.9, cls: 'H', hasDme: true },
  { id: 'MIL', name: 'MALPENSA', lat: 45.628, lng: 8.728, freq: 117.3, cls: 'H', hasDme: true },
  { id: 'MAD', name: 'MADRID', lat: 40.494, lng: -3.566, freq: 112.1, cls: 'H', hasDme: true },
  { id: 'BCN', name: 'BARCELONA', lat: 41.297, lng: 2.077, freq: 117.0, cls: 'H', hasDme: true },
  { id: 'LIS', name: 'LISBON', lat: 38.776, lng: -9.131, freq: 116.1, cls: 'H', hasDme: true },
  { id: 'CPH', name: 'COPENHAGEN', lat: 55.617, lng: 12.656, freq: 117.9, cls: 'H', hasDme: true },
  { id: 'ARN', name: 'STOCKHOLM', lat: 59.651, lng: 17.918, freq: 110.7, cls: 'H', hasDme: true },
  { id: 'OSL', name: 'OSLO', lat: 60.193, lng: 11.083, freq: 117.1, cls: 'H', hasDme: true },
  { id: 'HEL', name: 'HELSINKI', lat: 60.317, lng: 24.963, freq: 114.2, cls: 'H', hasDme: true },
  { id: 'VIE', name: 'VIENNA', lat: 48.110, lng: 16.570, freq: 113.8, cls: 'H', hasDme: true },
  { id: 'PRG', name: 'PRAGUE', lat: 50.101, lng: 14.260, freq: 114.0, cls: 'H', hasDme: true },
  { id: 'WAW', name: 'WARSAW', lat: 52.166, lng: 20.967, freq: 115.0, cls: 'H', hasDme: true },
  { id: 'IST', name: 'ISTANBUL', lat: 41.275, lng: 28.751, freq: 116.0, cls: 'H', hasDme: true },
  { id: 'ATH', name: 'ATHENS', lat: 37.937, lng: 23.945, freq: 114.4, cls: 'H', hasDme: true },
  // ASIA / PACIFIC
  { id: 'DXB', name: 'DUBAI', lat: 25.252, lng: 55.364, freq: 114.4, cls: 'H', hasDme: true },
  { id: 'BOM', name: 'MUMBAI', lat: 19.089, lng: 72.868, freq: 116.6, cls: 'H', hasDme: true },
  { id: 'DEL', name: 'DELHI', lat: 28.566, lng: 77.103, freq: 116.6, cls: 'H', hasDme: true },
  { id: 'BKK', name: 'BANGKOK', lat: 13.681, lng: 100.747, freq: 116.7, cls: 'H', hasDme: true },
  { id: 'SIN', name: 'SINGAPORE', lat: 1.349, lng: 103.994, freq: 114.5, cls: 'H', hasDme: true },
  { id: 'HKG', name: 'HONG KONG', lat: 22.310, lng: 113.918, freq: 114.5, cls: 'H', hasDme: true },
  { id: 'PEK', name: 'BEIJING', lat: 40.080, lng: 116.585, freq: 112.0, cls: 'H', hasDme: true },
  { id: 'PVG', name: 'SHANGHAI', lat: 31.143, lng: 121.805, freq: 114.4, cls: 'H', hasDme: true },
  { id: 'CAN', name: 'GUANGZHOU', lat: 23.392, lng: 113.299, freq: 114.7, cls: 'H', hasDme: true },
  { id: 'NRT', name: 'NARITA', lat: 35.765, lng: 140.386, freq: 117.6, cls: 'H', hasDme: true },
  { id: 'HND', name: 'HANEDA', lat: 35.553, lng: 139.781, freq: 113.7, cls: 'H', hasDme: true },
  { id: 'ICN', name: 'INCHEON', lat: 37.469, lng: 126.451, freq: 114.0, cls: 'H', hasDme: true },
  { id: 'SYD', name: 'SYDNEY', lat: -33.939, lng: 151.175, freq: 115.4, cls: 'H', hasDme: true },
  { id: 'MEL', name: 'MELBOURNE', lat: -37.673, lng: 144.843, freq: 114.1, cls: 'H', hasDme: true },
  { id: 'AKL', name: 'AUCKLAND', lat: -37.008, lng: 174.792, freq: 116.4, cls: 'H', hasDme: true },
]

function hav(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3440.065
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180
  const dφ = (lat2 - lat1) * Math.PI / 180, dλ = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180
  const dλ = (lon2 - lon1) * Math.PI / 180
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360
}

function angleDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % 360
  if (d > 180) d = 360 - d
  return d
}

interface InView { st: Station; distNm: number; brg: number }
interface Row {
  f: NavaidFlight
  klass: Klass
  inView: InView[]
  vorCount: number
  dmeCount: number
  bestA?: InView
  bestB?: InView
  bestAngle: number       // 0..180 deg
  bestSin: number         // sin(angle)
  fom: number             // 0..1
  rangeNm: number
  tier: Tier
}

const SRC_RING = 'navaid-ring', SRC_LINE = 'navaid-line', SRC_STA = 'navaid-sta', SRC_LBL = 'navaid-lbl', SRC_STALBL = 'navaid-stalbl'
const LYR_RING = 'navaid-ring-l', LYR_LINE = 'navaid-line-l', LYR_STA = 'navaid-sta-l', LYR_LBL = 'navaid-lbl-l', LYR_STALBL = 'navaid-stalbl-l'

export default function NavaidCoverage({ map, flights, onClose, onFly, onFlyLatLng }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(50)
  const [maxFl, setMaxFl] = useState(500)
  const [mastFt, setMastFt] = useState(120)        // station antenna mast height
  const [ssvMult, setSsvMult] = useState(100)      // % multiplier on SSV class range
  const [showRing, setShowRing] = useState(true)
  const [showPins, setShowPins] = useState(true)
  const [showLines, setShowLines] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'AC' | 'STA'>('AC')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const mast = Math.max(10, mastFt)
    const mult = Math.max(0.5, ssvMult / 100)
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl || flCur > maxFl) continue
      const klass = classify(f.type, f.category)
      const horizon = 1.23 * (Math.sqrt(f.altitudeFt) + Math.sqrt(mast))
      const inView: InView[] = []
      for (const st of STATIONS) {
        const baseRng = SSV_RANGE_NM[st.cls] * mult
        const r = Math.min(baseRng, horizon)
        const d = hav(f.lat, f.lng, st.lat, st.lng)
        if (d <= r) {
          inView.push({ st, distNm: d, brg: bearing(f.lat, f.lng, st.lat, st.lng) })
        }
      }
      // sort by distance ascending — closer DMEs preferred
      inView.sort((a, b) => a.distNm - b.distNm)
      const dmes = inView.filter(v => v.st.hasDme)
      const dmeCount = dmes.length
      const vorCount = inView.length
      // pick BEST pair: scan top 8 closest DMEs, maximise sin(angle)
      let bestA: InView | undefined, bestB: InView | undefined, bestSin = 0, bestAngle = 0
      const top = dmes.slice(0, 8)
      for (let i = 0; i < top.length; i++) {
        for (let j = i + 1; j < top.length; j++) {
          const ang = angleDiff(top[i].brg, top[j].brg)
          const s = Math.sin(ang * Math.PI / 180)
          if (s > bestSin) { bestSin = s; bestAngle = ang; bestA = top[i]; bestB = top[j] }
        }
      }
      const fom = Math.min(1, bestSin * Math.sqrt(Math.max(1, dmeCount) / 8))
      let tier: Tier
      if (fom >= 0.65 && dmeCount >= 4 && bestAngle >= 60 && bestAngle <= 120) tier = 'RNP-1'
      else if (fom >= 0.40 && dmeCount >= 3 && bestAngle >= 30 && bestAngle <= 150) tier = 'RNP-2'
      else if (vorCount >= 1) tier = 'VOR-ONLY'
      else tier = 'GAP'
      const rangeNm = horizon
      out.push({ f, klass, inView, vorCount, dmeCount, bestA, bestB, bestAngle, bestSin, fom, rangeNm, tier })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return a.fom - b.fom
    })
    return out
  }, [flights, minFl, maxFl, mastFt, ssvMult])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { 'RNP-1': 0, 'RNP-2': 0, 'VOR-ONLY': 0, GAP: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let fomSum = 0, dmeSum = 0
    for (const r of rows) { fomSum += r.fom; dmeSum += r.dmeCount }
    const total = rows.length
    return {
      total,
      gap: tally.GAP,
      meanFom: total > 0 ? fomSum / total : 0,
      meanDmes: total > 0 ? dmeSum / total : 0,
    }
  }, [rows, tally])

  const stationUsage = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) for (const iv of r.inView) m.set(iv.st.id, (m.get(iv.st.id) || 0) + 1)
    const list = STATIONS.map(s => ({ st: s, count: m.get(s.id) || 0 }))
    list.sort((a, b) => b.count - a.count)
    return list
  }, [rows])

  const maxStationCount = useMemo(() => stationUsage.reduce((m, x) => Math.max(m, x.count), 1), [stationUsage])

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      if ([r.f.callsign, r.f.type, r.f.operator, r.f.icao].some(s => (s || '').toUpperCase().includes(q))) return true
      if (r.bestA && r.bestA.st.id.includes(q)) return true
      if (r.bestB && r.bestB.st.id.includes(q)) return true
      return false
    })
  }, [rows, tierFilter, klassFilter, query])

  const filteredStations = useMemo(() => {
    const q = query.trim().toUpperCase()
    if (!q) return stationUsage
    return stationUsage.filter(x => x.st.id.includes(q) || x.st.name.includes(q))
  }, [stationUsage, query])

  useEffect(() => {
    if (!map) return
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(13, (1 - r.fom) * 14) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const lineFeats: any[] = []
    if (showLines) {
      for (const r of rows) {
        if (r.tier !== 'RNP-1' && r.tier !== 'RNP-2') continue
        if (!r.bestA || !r.bestB) continue
        lineFeats.push({
          type: 'Feature', properties: { color: TIER_COLOR[r.tier] },
          geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.bestA.st.lng, r.bestA.st.lat]] },
        })
        lineFeats.push({
          type: 'Feature', properties: { color: TIER_COLOR[r.tier] },
          geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.bestB.st.lng, r.bestB.st.lat]] },
        })
      }
    }
    const lineFc = { type: 'FeatureCollection' as const, features: lineFeats }
    const usageMap = new Map<string, number>()
    for (const r of rows) for (const iv of r.inView) usageMap.set(iv.st.id, (usageMap.get(iv.st.id) || 0) + 1)
    const staFc = { type: 'FeatureCollection' as const, features: showPins ? STATIONS.map(s => {
      const cnt = usageMap.get(s.id) || 0
      const color = cnt > 0 ? '#0ea5e9' : '#475569'
      const radius = s.cls === 'H' ? 5.5 : s.cls === 'L' ? 4 : 3
      return {
        type: 'Feature' as const,
        properties: { color, radius, id: s.id },
        geometry: { type: 'Point' as const, coordinates: [s.lng, s.lat] },
      }
    }) : [] }
    const staLblFc = { type: 'FeatureCollection' as const, features: showPins ? STATIONS.map(s => ({
      type: 'Feature' as const,
      properties: { text: s.id },
      geometry: { type: 'Point' as const, coordinates: [s.lng, s.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${r.tier} ${(r.fom * 100).toFixed(0)}%`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_RING, ringFc, () => map.addLayer({ id: LYR_RING, type: 'circle', source: SRC_RING, paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.14,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.4,
        'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_LINE, lineFc, () => map.addLayer({ id: LYR_LINE, type: 'line', source: SRC_LINE, paint: {
        'line-color': ['get', 'color'],
        'line-width': 1,
        'line-opacity': 0.45,
        'line-dasharray': [2, 2],
      } }))
      ensure(SRC_STA, staFc, () => map.addLayer({ id: LYR_STA, type: 'circle', source: SRC_STA, paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#020617',
        'circle-stroke-width': 1.2,
        'circle-opacity': 0.95,
      } }))
      ensure(SRC_STALBL, staLblFc, () => map.addLayer({ id: LYR_STALBL, type: 'symbol', source: SRC_STALBL, layout: {
        'text-field': ['get', 'text'],
        'text-size': 9,
        'text-offset': [0, -1.2],
        'text-anchor': 'bottom',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: {
        'text-color': '#7dd3fc',
        'text-halo-color': '#020617',
        'text-halo-width': 1.2,
      } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'],
        'text-size': 10,
        'text-offset': [0, 1.5],
        'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.2,
      } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_STALBL, LYR_STA, LYR_LINE, LYR_RING]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_STALBL, SRC_STA, SRC_LINE, SRC_RING]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showRing, showLines, showPins, showLabels])

  // SVG: x = intersect angle 0-180°, y = FOM 0-1, threshold boxes shaded.
  const diag = useMemo(() => {
    const W = 360, H = 160, PAD = 26
    const xs = (a: number) => PAD + (Math.max(0, Math.min(180, a)) / 180) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, v))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,420px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Navaid Coverage</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} tracked · {STATIONS.length} stations</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-4 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[10px] font-bold" style={{ color: TIER_COLOR[t] }}>{t}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">GAP</div>
          <div className="font-mono text-sm" style={{ color: summary.gap > 0 ? '#ef4444' : '#10b981' }}>{summary.gap}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean FOM</div>
          <div className="font-mono text-sm" style={{ color: summary.meanFom >= 0.65 ? '#10b981' : summary.meanFom >= 0.4 ? '#0ea5e9' : summary.meanFom >= 0.2 ? '#f59e0b' : '#ef4444' }}>
            {(summary.meanFom * 100).toFixed(0)}<span className="text-[9px] text-slate-500"> %</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean DMEs</div>
          <div className="font-mono text-sm text-slate-200">{summary.meanDmes.toFixed(1)}</div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">FOM · intersect angle vs figure of merit</div>
        <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
          {/* tier-threshold shaded bands */}
          <rect x={diag.xs(60)} y={diag.ys(1)} width={diag.xs(120) - diag.xs(60)} height={diag.ys(0.65) - diag.ys(1)} fill="#10b981" opacity={0.07} />
          <rect x={diag.xs(30)} y={diag.ys(0.65)} width={diag.xs(150) - diag.xs(30)} height={diag.ys(0.40) - diag.ys(0.65)} fill="#0ea5e9" opacity={0.06} />
          {/* axes */}
          <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
          <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
          {[0, 30, 60, 90, 120, 150, 180].map(a => (
            <g key={a}>
              <line x1={diag.xs(a)} y1={diag.H - diag.PAD} x2={diag.xs(a)} y2={diag.H - diag.PAD + 3} stroke="#475569" />
              <text x={diag.xs(a)} y={diag.H - diag.PAD + 12} textAnchor="middle" fontSize={8} fill="#64748b">{a}°</text>
            </g>
          ))}
          {[0, 0.2, 0.4, 0.65, 1].map(v => (
            <g key={v}>
              <line x1={diag.PAD - 3} y1={diag.ys(v)} x2={diag.PAD} y2={diag.ys(v)} stroke="#475569" />
              <text x={diag.PAD - 5} y={diag.ys(v) + 3} textAnchor="end" fontSize={8} fill="#64748b">{(v * 100).toFixed(0)}</text>
            </g>
          ))}
          {/* threshold dashed lines */}
          <line x1={diag.PAD} y1={diag.ys(0.65)} x2={diag.W - 6} y2={diag.ys(0.65)} stroke="#10b981" strokeWidth={0.8} strokeDasharray="3 3" opacity={0.6} />
          <line x1={diag.PAD} y1={diag.ys(0.40)} x2={diag.W - 6} y2={diag.ys(0.40)} stroke="#0ea5e9" strokeWidth={0.8} strokeDasharray="3 3" opacity={0.6} />
          {rows.map((r, i) => (
            <circle key={i} cx={diag.xs(r.bestAngle)} cy={diag.ys(r.fom)} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.85} />
          ))}
        </svg>
      </div>

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col gap-0.5">
          <span className="text-[9px] uppercase tracking-widest text-slate-500">MIN-FL {minFl}</span>
          <input type="range" min={0} max={500} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="accent-sky-500" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[9px] uppercase tracking-widest text-slate-500">MAX-FL {maxFl}</span>
          <input type="range" min={0} max={500} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="accent-sky-500" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[9px] uppercase tracking-widest text-slate-500">MAST {mastFt} ft</span>
          <input type="range" min={20} max={500} step={10} value={mastFt} onChange={e => setMastFt(parseInt(e.target.value))} className="accent-sky-500" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[9px] uppercase tracking-widest text-slate-500">SSV× {ssvMult}%</span>
          <input type="range" min={60} max={130} step={5} value={ssvMult} onChange={e => setSsvMult(parseInt(e.target.value))} className="accent-sky-500" />
        </label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-1 border-b border-slate-800">
        {(['ALL', 'heavy', 'narrow', 'regional', 'biz', 'turboprop', 'ga', 'fighter'] as const).map(k => {
          const on = klassFilter === k
          return (
            <button key={k} onClick={() => setKlassFilter(k as any)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition ${on ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-800 text-slate-500 hover:text-slate-300'}`}>
              {k === 'ALL' ? 'ALL' : KLASS_LABEL[k as Klass]}
            </button>
          )
        })}
      </div>

      <div className="flex gap-2 px-3 py-1 border-b border-slate-800 text-[10px] text-slate-500">
        <label className="flex items-center gap-1"><input type="checkbox" checked={showRing} onChange={e => setShowRing(e.target.checked)} className="accent-sky-500" />HALO</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={showPins} onChange={e => setShowPins(e.target.checked)} className="accent-sky-500" />PINS</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={showLines} onChange={e => setShowLines(e.target.checked)} className="accent-sky-500" />LINES</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" />LBL</label>
      </div>

      <div className="px-3 py-1 border-b border-slate-800 flex gap-1">
        {(['AC', 'STA'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2 py-0.5 rounded text-[10px] font-mono border transition ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-800 text-slate-500 hover:text-slate-300'}`}>
            {t === 'AC' ? 'AIRCRAFT' : 'STATIONS'}
          </button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / VOR-id…"
          className="ml-auto flex-1 max-w-[180px] bg-slate-900/60 border border-slate-800 rounded px-2 py-0.5 text-[10px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/40" />
      </div>

      <div className="overflow-y-auto flex-1">
        {tab === 'AC' && filtered.map((r, idx) => {
          const cs = (r.f.callsign || r.f.icao).trim()
          const fomPct = r.fom * 100
          return (
            <div key={r.f.icao + idx} onClick={() => onFly(r.f.icao)}
              className="px-3 py-1.5 border-b border-slate-900 hover:bg-slate-900/40 cursor-pointer flex flex-col gap-0.5"
              style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <div className="flex items-center gap-1.5">
                <span className="font-mono font-bold text-slate-100">{cs}</span>
                <span className="text-[10px] text-slate-500">{r.f.type || '—'}</span>
                <span className="text-[9px] px-1 rounded bg-slate-800/80 text-slate-400">{KLASS_LABEL[r.klass]}</span>
                <span className="text-[9px] px-1 rounded font-bold ml-auto" style={{ background: TIER_COLOR[r.tier] + '22', color: TIER_COLOR[r.tier] }}>{r.tier}</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-slate-400 font-mono">
                <span>F{(r.f.altitudeFt / 100).toFixed(0)}</span>
                <span>DME×{r.dmeCount}</span>
                <span>VOR×{r.vorCount}</span>
                <span>∠{r.bestAngle.toFixed(0)}°</span>
                <span className="ml-auto">RNG {r.rangeNm.toFixed(0)}nm</span>
              </div>
              <div className="relative h-1.5 bg-slate-800/60 rounded-full overflow-hidden mt-0.5">
                {/* threshold ticks at 20, 40, 65% */}
                {[20, 40, 65].map(p => (
                  <div key={p} className="absolute top-0 bottom-0 w-px bg-slate-700" style={{ left: `${p}%` }} />
                ))}
                <div className="absolute top-0 bottom-0 rounded-full" style={{ width: `${Math.max(0, Math.min(100, fomPct))}%`, background: TIER_COLOR[r.tier] }} />
              </div>
              <div className="flex items-center gap-1.5 text-[9px] text-slate-500 font-mono">
                <span>FOM {fomPct.toFixed(0)}%</span>
                {r.bestA && r.bestB && <span className="text-slate-400">{r.bestA.st.id}/{r.bestB.st.id} sin{r.bestSin.toFixed(2)}</span>}
                <span className="truncate ml-auto text-slate-500">{r.f.operator || '—'}</span>
              </div>
            </div>
          )
        })}
        {tab === 'STA' && filteredStations.map((x, idx) => {
          const pct = (x.count / maxStationCount) * 100
          const color = x.count > 0 ? '#0ea5e9' : '#475569'
          return (
            <div key={x.st.id + idx} onClick={() => onFlyLatLng && onFlyLatLng(x.st.lat, x.st.lng, 6)}
              className="px-3 py-1.5 border-b border-slate-900 hover:bg-slate-900/40 cursor-pointer flex flex-col gap-0.5"
              style={{ borderLeft: `3px solid ${color}` }}>
              <div className="flex items-center gap-1.5">
                <span className="font-mono font-bold text-slate-100">{x.st.id}</span>
                <span className="text-[10px] text-slate-400">{x.st.name}</span>
                <span className="text-[9px] px-1 rounded bg-slate-800/80 text-slate-400 ml-auto">SSV-{x.st.cls}</span>
                <span className="text-[10px] font-mono text-slate-200">×{x.count}</span>
              </div>
              <div className="relative h-1.5 bg-slate-800/60 rounded-full overflow-hidden">
                <div className="absolute top-0 bottom-0 rounded-full" style={{ width: `${pct}%`, background: color }} />
              </div>
              <div className="flex items-center gap-1.5 text-[9px] text-slate-500 font-mono">
                <span>{x.st.lat.toFixed(2)},{x.st.lng.toFixed(2)}</span>
                <span>{x.st.freq.toFixed(1)} MHz</span>
                <span className="ml-auto">{x.st.hasDme ? 'DME' : 'VOR'}</span>
              </div>
            </div>
          )
        })}
        {tab === 'AC' && filtered.length === 0 && (
          <div className="px-3 py-4 text-center text-slate-600">no aircraft match filters</div>
        )}
      </div>
    </div>
  )
}
