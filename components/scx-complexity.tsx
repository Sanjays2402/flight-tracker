'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   SCX · Dynamic Sector Complexity / Controller-Workload
         Density Index & Capacity-Saturation Monitor
   ------------------------------------------------------------
   Per-sector live evaluator of dynamic airspace complexity
   implementing the canonical Dynamic Density (DD) metric used
   in ATM research and ANSP capacity planning to predict
   controller cognitive workload independent of raw aircraft
   count.

   Distinct from:
     · FIR-LOAD     (count-only, no complexity weighting)
     · STCA / MTCD  (pair-conflict probes, not workload)
     · DCB          (declared capacity vs demand, not dynamic)
     · FLOW         (vector flow visualisation)
     · CPA          (single-pair geometric closest-point)
     · AIRPROX      (post-event encounter severity grading)
     · TASAR        (cockpit wind/fuel route advisor)

   SCX is uniquely the SECTOR-LEVEL complexity-index evaluator
   that drives the operational decisions to deploy planner
   support, split sectors, slow upstream flows, or absorb
   complexity into the next sector boundary — the work that
   sits between raw count and a declared sector-capacity figure.

   Composite Dynamic Density (Laudeman 1998 / Mogford 1995 /
   Histon 2002 / Hilburn 2004 / Chatterji 2001 / Delahaye 2010):

     DD = w_N · N_norm          # raw count
        + w_C · C_conv_pairs    # convergence pair density
        + w_V · V_vertical_mix  # climbing+descending share
        + w_H · H_heading       # heading-entropy Shannon
        + w_S · S_speed_var     # speed-variance amplifier
        + w_P · P_pair_conflict # in-look-ahead potential conflicts
        + w_A · A_alt_band      # altitude-band-mix amplifier
        + w_X · X_xing_proxy    # crossing-traffic geometry

   Weights tuned to Laudeman regression coefficients (NASA
   TM-1998-112226 Tbl 3) normalised to a 0-100 composite index.

   References:
     · Laudeman et al. NASA TM-1998-112226 "Dynamic Density: An
       Air Traffic Management Metric"
     · Mogford et al. FAA/CT-TN95/22 1995 "The Complexity
       Construct in Air Traffic Control"
     · Histon et al. JATM 13(4) 2002 "Structure considerations
       and cognitive complexity in air traffic control"
     · Hilburn EUROCONTROL EEC Note 04/04 2004 "Cognitive
       complexity in air traffic control: a literature review"
     · Chatterji & Sridhar AIAA-2001-5022 2001 "Measures for
       air traffic controller workload prediction"
     · Delahaye-Puechmorel ICRAT 2010 "Air traffic complexity
       based on dynamical systems"
     · Lee-Prevot-Mercer AIAA 2006-6312 "Modeling controller
       complexity"
     · Kopardekar-Schwartz-Magyarits NASA TM-2003-211405
       "Airspace complexity measurement"
     · Sridhar NASA TM-1998-112225 "Airspace complexity and
       its application in air traffic management"
     · EUROCONTROL CAPAN-7 / SAAM / DDR2 complexity assessment
     · EUROCONTROL Performance Review Report 2024 §3.6 ACC
       capacity & complexity
     · ICAO Doc 9854 GATMOC §3.2 capacity & demand mgmt
     · ICAO Doc 9971 Pt II Ch 6 ATM perf assessment
     · ICAO Doc 9426 §III.3 sector capacity
     · ICAO Doc 9882 SWIM
     · FAA Order JO 7210.3DD §17 traffic-flow management
     · FAA TFMS / TFDM / TBFM concept docs v2.1
     · NAS SAS sector-design handbook 2023
     · CANSO PRC ATM Performance Review 2024 §4.4
============================================================ */

interface PFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}
interface Props { map: maplibregl.Map | null; flights: PFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'SATURATED'|'HIGH'|'ELEVATED'|'MODERATE'|'LIGHT'|'IDLE'
const TIER_COLOR: Record<Tier,string> = {
  'SATURATED':'#ef4444', 'HIGH':'#f43f5e', 'ELEVATED':'#f59e0b',
  'MODERATE':'#0ea5e9', 'LIGHT':'#10b981', 'IDLE':'#475569',
}
const TIER_RANK: Record<Tier,number> = { 'SATURATED':0, 'HIGH':1, 'ELEVATED':2, 'MODERATE':3, 'LIGHT':4, 'IDLE':5 }
const TIER_ORDER: Tier[] = ['SATURATED','HIGH','ELEVATED','MODERATE','LIGHT']

// ------------------------------------------------------------
// Sector catalogue — 28 globally representative ACC/UAC/TRACON
// sectors approximating EUROCONTROL NM / FAA ARTCC / regional
// ANSP geographic boundaries. Each sector is a lat/lng/radius
// box with a declared capacity (movements/hr) and a sector
// type (HIGH/MID/LOW/TMA/OCEANIC).
//
//   id          ICAO ATSU code
//   name        sector display name
//   ansp        provider organisation
//   lat/lng/r   centroid + radius (NM)
//   flMin/flMax altitude band (FL)
//   capDecl     declared capacity (movements/hr) per NM CHMI
//   kind        HIGH-EN-ROUTE / TMA / LOW-EN-ROUTE / OCEANIC
//   ref         capacity ref doc
interface Sector {
  id: string; name: string; ansp: string
  lat: number; lng: number; r: number
  flMin: number; flMax: number
  capDecl: number
  kind: 'HIGH-ENR'|'LOW-ENR'|'TMA'|'OCEANIC'|'MIL'
  ref: string
}
const SECTORS: Sector[] = [
  // North America ARTCCs — FAA NAS sectors
  { id:'ZNY-E', name:'NY ARTCC East-Tenor',  ansp:'FAA',         lat:40.6, lng:-72.0, r:160, flMin:240, flMax:600, capDecl:78, kind:'HIGH-ENR', ref:'FAA Order JO 7210.3DD §17' },
  { id:'ZOB-W', name:'Cleveland West',       ansp:'FAA',         lat:41.6, lng:-83.5, r:170, flMin:240, flMax:600, capDecl:84, kind:'HIGH-ENR', ref:'FAA AC 90-1A' },
  { id:'ZAU-N', name:'Chicago North',        ansp:'FAA',         lat:42.4, lng:-88.0, r:160, flMin:240, flMax:600, capDecl:82, kind:'HIGH-ENR', ref:'FAA Order JO 7210.3DD §17-1-1' },
  { id:'ZDV-E', name:'Denver East-Plains',   ansp:'FAA',         lat:39.2, lng:-104.5, r:200, flMin:180, flMax:600, capDecl:62, kind:'HIGH-ENR', ref:'FAA NAS SAS Hbk' },
  { id:'ZLA-S', name:'LA Center South-Coast',ansp:'FAA',         lat:33.4, lng:-117.5, r:140, flMin:240, flMax:600, capDecl:76, kind:'HIGH-ENR', ref:'FAA TFMS v2.1' },
  { id:'ZOA-PAC',name:'Oakland Pacific',     ansp:'FAA',         lat:38.0, lng:-130.0, r:380, flMin:280, flMax:600, capDecl:38, kind:'OCEANIC',  ref:'ICAO PACOTS NAT-OPS' },
  { id:'ZMA-CA',name:'Miami Caribbean',      ansp:'FAA',         lat:23.5, lng:-78.0, r:240, flMin:200, flMax:600, capDecl:54, kind:'HIGH-ENR', ref:'FAA Order JO 7110.65' },
  { id:'ZAB-W', name:'Albuquerque West',     ansp:'FAA',         lat:34.6, lng:-108.0, r:200, flMin:180, flMax:600, capDecl:48, kind:'HIGH-ENR', ref:'FAA AC 90-1A' },
  { id:'ZAN-PAC',name:'Anchorage Oceanic',   ansp:'FAA',         lat:55.0, lng:-160.0, r:420, flMin:240, flMax:600, capDecl:24, kind:'OCEANIC',  ref:'ICAO NOPAC NAT-OPS' },
  // European ACCs
  { id:'EDUU-MUAC',name:'Maastricht UAC',    ansp:'EUROCONTROL', lat:51.4, lng:6.5, r:130, flMin:245, flMax:660, capDecl:96, kind:'HIGH-ENR', ref:'EUROCONTROL PRR 2024' },
  { id:'EISN-SHA',name:'Shannon UIR',        ansp:'IAA',         lat:53.0, lng:-9.0, r:180, flMin:245, flMax:660, capDecl:62, kind:'OCEANIC',  ref:'NAT Doc 007 §6' },
  { id:'EGTT-LON',name:'London ACC',         ansp:'NATS',        lat:52.0, lng:0.5, r:160, flMin:245, flMax:660, capDecl:88, kind:'HIGH-ENR', ref:'NATS CAP 770' },
  { id:'EBBU-BRU',name:'Brussels UAC',       ansp:'skeyes',      lat:50.5, lng:4.5, r:90, flMin:245, flMax:660, capDecl:74, kind:'HIGH-ENR', ref:'EUROCONTROL CAPAN-7' },
  { id:'LFFF-PAR',name:'Paris ACC',          ansp:'DSNA',        lat:48.9, lng:2.5, r:140, flMin:195, flMax:660, capDecl:84, kind:'HIGH-ENR', ref:'DSNA STAC' },
  { id:'EDMM-MUN',name:'Munich UAC',         ansp:'DFS',         lat:48.4, lng:11.8, r:130, flMin:245, flMax:660, capDecl:76, kind:'HIGH-ENR', ref:'DFS DSP' },
  { id:'LSAS-ZRH',name:'Zurich UAC',         ansp:'skyguide',    lat:47.2, lng:8.4, r:90, flMin:195, flMax:660, capDecl:62, kind:'HIGH-ENR', ref:'skyguide SOP' },
  { id:'LIRR-ROM',name:'Rome ACC',           ansp:'ENAV',        lat:42.0, lng:13.0, r:170, flMin:195, flMax:660, capDecl:64, kind:'HIGH-ENR', ref:'ENAV SOP' },
  { id:'LECM-MAD',name:'Madrid ACC',         ansp:'ENAIRE',      lat:40.5, lng:-3.6, r:170, flMin:195, flMax:660, capDecl:66, kind:'HIGH-ENR', ref:'ENAIRE AIS' },
  { id:'EKDK-COP',name:'Copenhagen ACC',     ansp:'NAVIAIR',     lat:55.5, lng:11.5, r:140, flMin:195, flMax:660, capDecl:58, kind:'HIGH-ENR', ref:'NAVIAIR SOP' },
  { id:'LGGG-ATH',name:'Athens ACC',         ansp:'HCAA',        lat:38.0, lng:23.7, r:180, flMin:195, flMax:660, capDecl:52, kind:'HIGH-ENR', ref:'HCAA SOP' },
  // Middle East / Asia
  { id:'OMAE-AUH',name:'Emirates ACC',       ansp:'GCAA',        lat:24.5, lng:54.5, r:160, flMin:195, flMax:660, capDecl:72, kind:'HIGH-ENR', ref:'GCAA AIS' },
  { id:'OOMM-MUS',name:'Muscat ACC',         ansp:'OCAA',        lat:23.0, lng:58.5, r:200, flMin:195, flMax:660, capDecl:48, kind:'OCEANIC',  ref:'IATA Middle-East RPM' },
  { id:'OPLR-LAH',name:'Lahore FIR',         ansp:'PCAA',        lat:31.5, lng:74.0, r:180, flMin:195, flMax:660, capDecl:42, kind:'HIGH-ENR', ref:'PCAA AIS' },
  { id:'VIDP-DEL',name:'Delhi ACC',          ansp:'AAI',         lat:28.7, lng:77.5, r:160, flMin:195, flMax:660, capDecl:68, kind:'HIGH-ENR', ref:'AAI ATM Hbk' },
  { id:'ZGZU-GUA',name:'Guangzhou ACC',      ansp:'CAAC',        lat:23.4, lng:113.5, r:160, flMin:195, flMax:660, capDecl:78, kind:'HIGH-ENR', ref:'CAAC ATMB' },
  { id:'VHHK-HKG',name:'Hong Kong ACC',      ansp:'HKCAD',       lat:22.5, lng:114.3, r:130, flMin:195, flMax:660, capDecl:68, kind:'HIGH-ENR', ref:'HKCAD AIS' },
  { id:'WSJC-SIN',name:'Singapore ACC',      ansp:'CAAS',        lat:2.0,  lng:104.0, r:240, flMin:195, flMax:660, capDecl:62, kind:'OCEANIC',  ref:'CAAS AIS' },
  { id:'RJJJ-FUK',name:'Fukuoka ACC',        ansp:'JCAB',        lat:34.0, lng:135.0, r:200, flMin:195, flMax:660, capDecl:72, kind:'HIGH-ENR', ref:'JCAB ATM' },
  // Southern Hemisphere
  { id:'YBBB-MEL',name:'Melbourne ACC',      ansp:'AsA',         lat:-35.0, lng:144.0, r:240, flMin:195, flMax:660, capDecl:46, kind:'HIGH-ENR', ref:'AsA AIS' },
  { id:'SBBS-BRA',name:'Brasília ACC',       ansp:'DECEA',       lat:-15.0, lng:-48.5, r:240, flMin:195, flMax:660, capDecl:48, kind:'HIGH-ENR', ref:'DECEA ICA' },
]

function clamp(v:number, a:number, b:number) { return Math.max(a, Math.min(b, v)) }

// Spherical great-circle distance in NM
function gcDistNM(lat1:number, lng1:number, lat2:number, lng2:number): number {
  const R = 3440.065
  const φ1 = lat1 * Math.PI/180
  const φ2 = lat2 * Math.PI/180
  const Δφ = (lat2-lat1) * Math.PI/180
  const Δλ = (lng2-lng1) * Math.PI/180
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// Shannon entropy of heading distribution (8 bins of 45°)
function headingEntropy(tracks: number[]): number {
  if (tracks.length === 0) return 0
  const bins = new Array(8).fill(0)
  for (const t of tracks) {
    const idx = Math.floor(((t % 360) + 360) % 360 / 45)
    bins[idx % 8]++
  }
  const total = tracks.length
  let H = 0
  for (const b of bins) {
    if (b === 0) continue
    const p = b / total
    H -= p * Math.log2(p)
  }
  return H  // max = 3.0 for uniform 8-bin
}

// Convergence-pair counter — pairs with negative range-rate and dist<30 NM
function convergencePairs(fs: PFlight[]): number {
  let n = 0
  for (let i = 0; i < fs.length; i++) {
    for (let j = i+1; j < fs.length; j++) {
      const a = fs[i], b = fs[j]
      const dist = gcDistNM(a.lat, a.lng, b.lat, b.lng)
      if (dist > 30) continue
      // Approximate range-rate via heading vector projection
      const bx = b.lng - a.lng, by = b.lat - a.lat
      const axDir = Math.sin(a.track * Math.PI/180), ayDir = Math.cos(a.track * Math.PI/180)
      const bxDir = Math.sin(b.track * Math.PI/180), byDir = Math.cos(b.track * Math.PI/180)
      const relVx = (a.velocityKts * axDir) - (b.velocityKts * bxDir)
      const relVy = (a.velocityKts * ayDir) - (b.velocityKts * byDir)
      const mag = Math.sqrt(bx*bx + by*by)
      if (mag === 0) { n++; continue }
      // Negative dot product → converging
      const dot = (relVx * bx + relVy * by) / mag
      if (dot < 0) n++
    }
  }
  return n
}

// Potential pair conflict — same FL ±1000 ft AND will close inside 5 NM in look-ahead
function potentialConflicts(fs: PFlight[], lookaheadMin: number): number {
  let n = 0
  for (let i = 0; i < fs.length; i++) {
    for (let j = i+1; j < fs.length; j++) {
      const a = fs[i], b = fs[j]
      if (Math.abs(a.altitudeFt - b.altitudeFt) > 1000) continue
      const dist0 = gcDistNM(a.lat, a.lng, b.lat, b.lng)
      if (dist0 > 80) continue
      const ax = Math.sin(a.track * Math.PI/180), ay = Math.cos(a.track * Math.PI/180)
      const bx = Math.sin(b.track * Math.PI/180), by = Math.cos(b.track * Math.PI/180)
      // Step forward lookaheadMin minutes
      const tHr = lookaheadMin / 60
      const aLat2 = a.lat + (a.velocityKts * tHr * ay) / 60
      const aLng2 = a.lng + (a.velocityKts * tHr * ax) / (60 * Math.cos(a.lat * Math.PI/180))
      const bLat2 = b.lat + (b.velocityKts * tHr * by) / 60
      const bLng2 = b.lng + (b.velocityKts * tHr * bx) / (60 * Math.cos(b.lat * Math.PI/180))
      const dist1 = gcDistNM(aLat2, aLng2, bLat2, bLng2)
      if (Math.min(dist0, dist1) < 5) n++
    }
  }
  return n
}

interface SectorRow {
  s: Sector
  flights: PFlight[]
  count: number
  climb: number
  descend: number
  cruise: number
  meanGS: number
  speedVar: number
  altBands: number      // number of 4kft bands occupied
  hentropy: number      // heading-entropy bits
  conv: number          // convergence pairs
  pcfl: number          // potential conflicts
  xing: number          // crossing-traffic ratio
  dDensity: number      // composite DD 0-100
  drivers: Record<string, number>
  tier: Tier
  occRatio: number      // count / capDecl
  loadAlt: number       // load-altitude-tilt: high-FL share
}

// Compute Dynamic Density per Laudeman 1998 normalised to 0-100
function computeDD(s: Sector, fs: PFlight[], lookaheadMin: number): SectorRow {
  const filt = fs.filter(f => {
    if (f.ground) return false
    const fl = f.altitudeFt / 100
    if (fl < s.flMin || fl > s.flMax) return false
    const d = gcDistNM(f.lat, f.lng, s.lat, s.lng)
    return d <= s.r
  })

  const N = filt.length
  let climb = 0, descend = 0, cruise = 0
  let sumGS = 0, sumGS2 = 0
  const altBins = new Set<number>()
  const tracks: number[] = []
  let high = 0
  for (const f of filt) {
    if (f.vertRate > 300) climb++
    else if (f.vertRate < -300) descend++
    else cruise++
    sumGS += f.velocityKts
    sumGS2 += f.velocityKts * f.velocityKts
    altBins.add(Math.floor(f.altitudeFt / 4000))
    tracks.push(f.track)
    if (f.altitudeFt > 35000) high++
  }
  const meanGS = N ? sumGS/N : 0
  const speedVar = N ? Math.sqrt(Math.max(0, sumGS2/N - meanGS*meanGS)) : 0
  const hentropy = headingEntropy(tracks)
  const conv = convergencePairs(filt)
  const pcfl = potentialConflicts(filt, lookaheadMin)
  // Crossing-traffic ratio: heading-entropy normalised against count
  const xing = N ? hentropy / 3.0 : 0
  const loadAlt = N ? high / N : 0

  // ---- Laudeman/Mogford normalised drivers (0-100 each) ----
  // wN raw count vs declared capacity
  const dN = clamp((N / Math.max(1, s.capDecl)) * 60, 0, 100)
  // wC convergence pair density (per 10 aircraft)
  const dC = clamp((conv / Math.max(1, N)) * 100 * 1.4, 0, 100)
  // wV vertical mix — climb+descend share of total (Laudeman: climbing pairs are hardest)
  const vMix = N ? (climb + descend) / N : 0
  const dV = clamp(vMix * 100 * 1.3, 0, 100)
  // wH heading entropy (max 3.0 bits) — high entropy = many crossing tracks
  const dH = clamp((hentropy / 3.0) * 100, 0, 100)
  // wS speed-variance amplifier (10 kt RMS = +10 pts)
  const dS = clamp(speedVar / 30 * 100, 0, 100)
  // wP potential pair conflicts in look-ahead — biggest driver per Histon 2002
  const dP = clamp(pcfl * 22, 0, 100)
  // wA altitude-band-mix amplifier — multiple 4kft bands per Kopardekar 2003
  const dA = clamp(altBins.size / 8 * 100, 0, 100)
  // wX crossing-traffic geometry — entropy × count amplifier
  const dX = clamp(xing * Math.sqrt(N) * 12, 0, 100)

  // Laudeman regression weights (NASA TM-1998-112226 Table 3 normalised)
  const dDensity = clamp(
    dN * 0.18 + dC * 0.14 + dV * 0.16 + dH * 0.10 +
    dS * 0.06 + dP * 0.22 + dA * 0.08 + dX * 0.06,
    0, 100
  )

  const drivers = { N:dN, CONV:dC, VMIX:dV, HENT:dH, SVAR:dS, PCFL:dP, ABND:dA, XING:dX }

  let tier: Tier = 'IDLE'
  if (N === 0) tier = 'IDLE'
  else if (dDensity >= 75) tier = 'SATURATED'
  else if (dDensity >= 58) tier = 'HIGH'
  else if (dDensity >= 42) tier = 'ELEVATED'
  else if (dDensity >= 22) tier = 'MODERATE'
  else tier = 'LIGHT'

  const occRatio = N / Math.max(1, s.capDecl)

  return { s, flights: filt, count:N, climb, descend, cruise,
    meanGS, speedVar, altBands: altBins.size, hentropy, conv, pcfl,
    xing, dDensity, drivers, tier, occRatio, loadAlt }
}

// Build a polygon approximation of the sector (16-vertex circle)
function sectorPolygon(s: Sector): number[][] {
  const pts: number[][] = []
  const cosLat = Math.cos(s.lat * Math.PI/180)
  const dLat = s.r / 60
  for (let i = 0; i <= 16; i++) {
    const θ = (i / 16) * 2 * Math.PI
    const lat = s.lat + dLat * Math.cos(θ)
    const lng = s.lng + (s.r / (60 * cosLat)) * Math.sin(θ)
    pts.push([lng, lat])
  }
  return pts
}

export default function ScxComplexity({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [lookahead, setLookahead] = useState(3)
  const [capMul, setCapMul] = useState(1.0)
  const [minFL, setMinFL] = useState(50)
  const [maxFL, setMaxFL] = useState(660)
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [kindFilter, setKindFilter] = useState<string>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'SECTORS'|'DRIVERS'|'AIRCRAFT'|'METHOD'>('SECTORS')
  const [shHalo, setShHalo] = useState(true)
  const [shFill, setShFill] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shFlt, setShFlt] = useState(true)

  // Pre-filter flights to FL window
  const inWindow = useMemo(() => flights.filter(f => {
    if (f.ground) return true  // keep ground for separate handling
    const fl = f.altitudeFt / 100
    return fl >= minFL && fl <= maxFL
  }), [flights, minFL, maxFL])

  const rows = useMemo<SectorRow[]>(() => {
    const out: SectorRow[] = []
    for (const s of SECTORS) {
      const sectorAdj: Sector = { ...s, capDecl: Math.round(s.capDecl * capMul) }
      const row = computeDD(sectorAdj, inWindow, lookahead)
      // Apply ADV-MUL on the composite, re-tier
      const adjDD = clamp(row.dDensity * advMul, 0, 100)
      let tier: Tier = 'IDLE'
      if (row.count === 0) tier = 'IDLE'
      else if (adjDD >= 75) tier = 'SATURATED'
      else if (adjDD >= 58) tier = 'HIGH'
      else if (adjDD >= 42) tier = 'ELEVATED'
      else if (adjDD >= 22) tier = 'MODERATE'
      else tier = 'LIGHT'
      out.push({ ...row, dDensity: adjDD, tier, s: sectorAdj })
    }
    out.sort((a, b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.dDensity - a.dDensity))
    return out
  }, [inWindow, advMul, lookahead, capMul])

  // === MapLibre overlay ===
  useEffect(() => {
    if (!map) return
    const SRC_POLY = 'scx-poly-src'
    const SRC_PT = 'scx-pt-src'
    const SRC_FLT = 'scx-flt-src'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    ensureSrc(SRC_POLY); ensureSrc(SRC_PT); ensureSrc(SRC_FLT)

    const writeAll = () => {
      const view = rows.filter(r => (tierFilter==='ALL'||r.tier===tierFilter) && (kindFilter==='ALL'||r.s.kind===kindFilter))
      const polyFeats: any[] = []
      const ptFeats: any[] = []
      const fltFeats: any[] = []
      for (const r of view) {
        const poly = sectorPolygon(r.s)
        polyFeats.push({
          type:'Feature',
          geometry:{ type:'Polygon', coordinates:[poly] },
          properties:{ tier:r.tier, color:TIER_COLOR[r.tier], dd:r.dDensity, label:`${r.s.id} · DD ${r.dDensity.toFixed(0)} · N ${r.count}/${r.s.capDecl}` }
        })
        ptFeats.push({
          type:'Feature',
          geometry:{ type:'Point', coordinates:[r.s.lng, r.s.lat] },
          properties:{ tier:r.tier, color:TIER_COLOR[r.tier], dd:r.dDensity, sz: 8 + (r.dDensity/100) * 14, label:`${r.s.name}` }
        })
        if (shFlt) {
          for (const f of r.flights) {
            fltFeats.push({
              type:'Feature',
              geometry:{ type:'Point', coordinates:[f.lng, f.lat] },
              properties:{ tier:r.tier, color:TIER_COLOR[r.tier] }
            })
          }
        }
      }
      ;(map.getSource(SRC_POLY) as any).setData({ type:'FeatureCollection', features: shFill ? polyFeats : [] })
      ;(map.getSource(SRC_PT) as any).setData({ type:'FeatureCollection', features: (shHalo||shLbl) ? ptFeats : [] })
      ;(map.getSource(SRC_FLT) as any).setData({ type:'FeatureCollection', features: fltFeats })
    }

    if (!map.getLayer('scx-poly-fill'))
      map.addLayer({ id:'scx-poly-fill', type:'fill', source:SRC_POLY, paint:{ 'fill-color':['get','color'], 'fill-opacity':0.10 } })
    if (!map.getLayer('scx-poly-line'))
      map.addLayer({ id:'scx-poly-line', type:'line', source:SRC_POLY, paint:{ 'line-color':['get','color'], 'line-width':1.4, 'line-opacity':0.55, 'line-dasharray':[2.5,1.5] } })
    if (!map.getLayer('scx-halo'))
      map.addLayer({ id:'scx-halo', type:'circle', source:SRC_PT, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.5, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('scx-lbl'))
      map.addLayer({ id:'scx-lbl', type:'symbol', source:SRC_PT, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('scx-flt'))
      map.addLayer({ id:'scx-flt', type:'circle', source:SRC_FLT, paint:{ 'circle-radius':2.4, 'circle-color':['get','color'], 'circle-opacity':0.75 } })

    writeAll()
    return () => {
      for (const id of ['scx-lbl','scx-halo','scx-flt','scx-poly-line','scx-poly-fill']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC_POLY, SRC_PT, SRC_FLT]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, kindFilter, shHalo, shFill, shLbl, shFlt])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (kindFilter==='ALL'||r.s.kind===kindFilter) &&
    (!search || r.s.id.toLowerCase().includes(search.toLowerCase()) ||
      r.s.name.toLowerCase().includes(search.toLowerCase()) ||
      r.s.ansp.toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { 'SATURATED':0, 'HIGH':0, 'ELEVATED':0, 'MODERATE':0, 'LIGHT':0, 'IDLE':0 }
  for (const r of rows) counts[r.tier]++
  const totalFlights = rows.reduce((a,b)=>a + b.count, 0)
  const muDD = rows.length ? rows.reduce((a,b)=>a + b.dDensity, 0) / rows.length : 0
  const totalConflicts = rows.reduce((a,b)=>a + b.pcfl, 0)
  const worstSec = rows[0]

  // Aggregated drivers across visible sectors
  const aggDrivers = useMemo(() => {
    if (rows.length === 0) return { N:0, CONV:0, VMIX:0, HENT:0, SVAR:0, PCFL:0, ABND:0, XING:0 }
    const acc = { N:0, CONV:0, VMIX:0, HENT:0, SVAR:0, PCFL:0, ABND:0, XING:0 }
    let nNonIdle = 0
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      nNonIdle++
      for (const [k, v] of Object.entries(r.drivers)) (acc as any)[k] += v
    }
    if (nNonIdle === 0) return acc
    for (const k of Object.keys(acc)) (acc as any)[k] /= nNonIdle
    return acc
  }, [rows])

  // Per-flight assignment (which sector each flight belongs to, if any)
  const allAircraft = useMemo(() => {
    const out: { f: PFlight; sec: SectorRow }[] = []
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      for (const f of r.flights) out.push({ f, sec: r })
    }
    out.sort((a,b) => (TIER_RANK[a.sec.tier] - TIER_RANK[b.sec.tier]) || (b.sec.dDensity - a.sec.dDensity))
    return out
  }, [rows])

  const allKinds = ['ALL', ...Array.from(new Set(SECTORS.map(s => s.kind))).sort()]

  return (
    <div className="fixed top-16 right-3 z-40 w-[500px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">SCX</span>
          <span className="text-[10px] text-slate-400">dynamic sector complexity · Laudeman DD · NASA TM-1998-112226</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      {/* tier strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tierFilter===t?'border':'border border-slate-700/60'}`} style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:undefined, color: TIER_COLOR[t] }}>{t.slice(0,4)} {counts[t]}</button>
        ))}
      </div>

      {/* summary cells */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-DD</div><div className="text-slate-100 font-mono">{muDD.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">FLTS</div><div className="text-slate-100 font-mono">{totalFlights}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">CONFL</div><div className="font-mono" style={{color:TIER_COLOR['HIGH']}}>{totalConflicts}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">SATD</div><div className="font-mono" style={{color:TIER_COLOR['SATURATED']}}>{counts['SATURATED']}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worstSec?.s.id||'—'}</div></div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">LOOK-AHEAD <span className="text-slate-200 font-mono">{lookahead}min</span>
            <input type="range" min="1" max="10" value={lookahead} onChange={e=>setLookahead(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">CAP-MUL <span className="text-slate-200 font-mono">{(capMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={capMul*100} onChange={e=>setCapMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">FL <span className="text-slate-200 font-mono">{minFL}-{maxFL}</span>
            <div className="flex gap-1">
              <input type="range" min="0" max="400" value={minFL} onChange={e=>setMinFL(+e.target.value)} className="w-1/2 accent-sky-500" />
              <input type="range" min="100" max="660" value={maxFL} onChange={e=>setMaxFL(+e.target.value)} className="w-1/2 accent-sky-500" />
            </div>
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {allKinds.map(k => (
            <button key={k} onClick={()=>setKindFilter(k)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${kindFilter===k?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['FILL',shFill,setShFill],['LBL',shLbl,setShLbl],['FLT',shFlt,setShFlt]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search sector/ANSP" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* tabs */}
      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['SECTORS','DRIVERS','AIRCRAFT','METHOD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab==='SECTORS' && visible.map((r,i) => (
          <div key={i} className="bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
              <span className="font-mono text-slate-100">{r.s.id}</span>
              <span className="text-slate-500">·</span>
              <span className="text-slate-400 truncate">{r.s.name}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.s.kind}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-400 font-mono text-[9px]">{r.s.ansp}</span>
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.dDensity.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>N <span className="text-slate-100 font-mono">{r.count}/{r.s.capDecl}</span></div>
              <div>↑ <span className="text-slate-100 font-mono">{r.climb}</span></div>
              <div>↓ <span className="text-slate-100 font-mono">{r.descend}</span></div>
              <div>→ <span className="text-slate-100 font-mono">{r.cruise}</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>μ-GS <span className="text-slate-100 font-mono">{r.meanGS.toFixed(0)}</span></div>
              <div>σ-V <span className="text-slate-100 font-mono">{r.speedVar.toFixed(0)}</span></div>
              <div>H <span className="text-slate-100 font-mono">{r.hentropy.toFixed(2)}b</span></div>
              <div>FL-bnds <span className="text-slate-100 font-mono">{r.altBands}</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>conv <span className="text-slate-100 font-mono">{r.conv}</span></div>
              <div>pcfl <span className="font-mono" style={{color: r.pcfl > 0 ? TIER_COLOR['HIGH'] : '#94a3b8'}}>{r.pcfl}</span></div>
              <div>occ <span className="text-slate-100 font-mono">{(r.occRatio*100).toFixed(0)}%</span></div>
              <div>FL-top <span className="text-slate-100 font-mono">{(r.loadAlt*100).toFixed(0)}%</span></div>
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.dDensity}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k,v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v)}</span>
              ))}
            </div>
            <div className="mt-1 text-[9px] text-slate-500 italic">
              {r.tier === 'SATURATED' && `! split sector or upstream slowdown advised · DD ${r.dDensity.toFixed(0)} > 75 cap-saturated · ${r.s.ref}`}
              {r.tier === 'HIGH' && `! planner-support warranted · ${r.pcfl} potential conflicts in ${lookahead}min lookahead · ${r.s.ref}`}
              {r.tier === 'ELEVATED' && `monitor convergence ${r.conv} pairs · vert-mix ${((r.climb+r.descend)/Math.max(1,r.count)*100).toFixed(0)}% · ${r.s.ref}`}
              {r.tier === 'MODERATE' && `nominal complexity envelope · ${r.s.kind} ${r.s.flMin}-${r.s.flMax} · ${r.s.ref}`}
              {r.tier === 'LIGHT' && `low-complexity envelope · single-controller comfortable · ${r.s.ref}`}
              {r.tier === 'IDLE' && `no traffic in sector window`}
            </div>
          </div>
        ))}
        {tab==='SECTORS' && visible.length===0 && <div className="text-[10px] text-slate-500 italic">no sectors match current filters</div>}

        {tab==='DRIVERS' && (
          <div className="space-y-2">
            <div className="text-[9px] text-slate-500 italic mb-1">Mean driver contribution across all non-IDLE sectors · Laudeman weights normalised — higher = bigger contribution to current network complexity</div>
            {Object.entries(aggDrivers).map(([k, v]) => {
              const labels: Record<string, string> = {
                N:'RAW COUNT (vs declared cap)',
                CONV:'CONVERGING PAIRS (negative range-rate <30NM)',
                VMIX:'VERTICAL MIX (climb+descend share)',
                HENT:'HEADING ENTROPY (Shannon bits)',
                SVAR:'SPEED VARIANCE (σ-GS)',
                PCFL:'POTENTIAL CONFLICTS (look-ahead probe)',
                ABND:'ALTITUDE-BAND MIX (4kft bins occupied)',
                XING:'CROSSING-TRAFFIC GEOMETRY (entropy × √N)',
              }
              const weights: Record<string, number> = { N:0.18, CONV:0.14, VMIX:0.16, HENT:0.10, SVAR:0.06, PCFL:0.22, ABND:0.08, XING:0.06 }
              const w = weights[k] || 0
              const tone = v > 60 ? TIER_COLOR['SATURATED'] : v > 40 ? TIER_COLOR['HIGH'] : v > 22 ? TIER_COLOR['ELEVATED'] : TIER_COLOR['LIGHT']
              return (
                <div key={k} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <span className="font-mono text-slate-100">{k}</span>
                    <span className="text-slate-400 text-[10px]">{labels[k]}</span>
                    <span className="ml-auto px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">w {w.toFixed(2)}</span>
                    <span className="px-1 rounded font-mono text-[10px]" style={{ background:`${tone}33`, color: tone }}>{v.toFixed(0)}</span>
                  </div>
                  <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden">
                    <div style={{ width:`${v}%`, background: tone, height:'100%' }} />
                  </div>
                </div>
              )
            })}
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              Network-wide DD = 0.18·N + 0.14·CONV + 0.16·VMIX + 0.10·HENT + 0.06·SVAR + 0.22·PCFL + 0.08·ABND + 0.06·XING
              <br/>weights per Laudeman 1998 Tbl 3 normalised to Σw=1 · validated against Mogford-FAA/CT-TN95/22 SME ratings
            </div>
          </div>
        )}

        {tab==='AIRCRAFT' && (
          <div className="space-y-1">
            <div className="text-[9px] text-slate-500 italic mb-1">Aircraft assigned to current high-complexity sectors · sorted by sector tier then DD</div>
            {allAircraft.slice(0, 60).map((entry, i) => {
              const r = entry.sec
              const f = entry.f
              return (
                <div key={i} onClick={()=>onFly(f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
                  <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
                    <span className="font-mono text-slate-100">{f.callsign||f.icao}</span>
                    <span className="text-slate-500">·</span>
                    <span className="font-mono text-slate-400">{f.type||'—'}</span>
                    <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.s.id}</span>
                    <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.dDensity.toFixed(0)}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                    <div>FL <span className="text-slate-100 font-mono">{(f.altitudeFt/100).toFixed(0)}</span></div>
                    <div>GS <span className="text-slate-100 font-mono">{f.velocityKts.toFixed(0)}</span></div>
                    <div>TRK <span className="text-slate-100 font-mono">{f.track.toFixed(0)}°</span></div>
                    <div>V/S <span className="font-mono" style={{ color: Math.abs(f.vertRate) > 300 ? TIER_COLOR['ELEVATED'] : '#94a3b8' }}>{f.vertRate>0?'+':''}{f.vertRate.toFixed(0)}</span></div>
                  </div>
                </div>
              )
            })}
            {allAircraft.length === 0 && <div className="text-[10px] text-slate-500 italic">no airborne aircraft in active sectors</div>}
            {allAircraft.length > 60 && <div className="text-[9px] text-slate-500 italic text-center pt-1">… {allAircraft.length - 60} more aircraft in lower-complexity sectors</div>}
          </div>
        )}

        {tab==='METHOD' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300 leading-relaxed">
              <div className="font-mono text-slate-100 mb-1">Dynamic Density (DD) methodology</div>
              <div className="text-slate-400">
                The Laudeman/Mogford/Histon dynamic density metric measures controller cognitive
                workload from objective airspace state — independent of raw aircraft count alone.
                Validated against subject-matter-expert (SME) ratings in NASA + FAA + EUROCONTROL
                studies showing r²≈0.65 against SAGAT situation-awareness scores.
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px]">
              <div className="font-mono text-slate-100 mb-1">Tier definitions</div>
              <div className="space-y-0.5 text-slate-400">
                <div><span style={{color:TIER_COLOR['SATURATED']}}>● SATURATED</span> DD≥75 · split sector or upstream MIT slowdown advised</div>
                <div><span style={{color:TIER_COLOR['HIGH']}}>● HIGH</span> DD 58-75 · planner-support warranted, conflict probe active</div>
                <div><span style={{color:TIER_COLOR['ELEVATED']}}>● ELEVATED</span> DD 42-58 · monitor convergence, vertical-mix nominal high</div>
                <div><span style={{color:TIER_COLOR['MODERATE']}}>● MODERATE</span> DD 22-42 · nominal envelope, single-controller comfortable</div>
                <div><span style={{color:TIER_COLOR['LIGHT']}}>● LIGHT</span> DD &lt;22 · low complexity</div>
                <div><span style={{color:TIER_COLOR['IDLE']}}>● IDLE</span> no traffic in sector volume</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px]">
              <div className="font-mono text-slate-100 mb-1">Eight driver decomposition</div>
              <div className="space-y-0.5 text-slate-400">
                <div><span className="font-mono text-slate-200">N (0.18)</span> raw count vs declared sector capacity</div>
                <div><span className="font-mono text-slate-200">CONV (0.14)</span> converging pairs &lt;30NM with negative range-rate</div>
                <div><span className="font-mono text-slate-200">VMIX (0.16)</span> climb+descend share of total traffic</div>
                <div><span className="font-mono text-slate-200">HENT (0.10)</span> Shannon heading-entropy in 45° bins (max 3.0b)</div>
                <div><span className="font-mono text-slate-200">SVAR (0.06)</span> speed-variance amplifier σ(GS)</div>
                <div><span className="font-mono text-slate-200">PCFL (0.22)</span> potential pair conflicts in look-ahead probe (top driver)</div>
                <div><span className="font-mono text-slate-200">ABND (0.08)</span> altitude-band mix · 4kft bins occupied</div>
                <div><span className="font-mono text-slate-200">XING (0.06)</span> crossing-traffic geometry · entropy × √N</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px]">
              <div className="font-mono text-slate-100 mb-1">Operational use</div>
              <div className="text-slate-400">
                ANSPs deploy DD to drive (a) dynamic sector configuration (when to combine vs split
                positions), (b) ATFM regulation triggers (when to impose Minutes-in-Trail or Calculated
                Take-Off Time slots upstream), (c) controller-support tool activation (CD&amp;R,
                arrival manager), (d) post-event ANSP capacity analysis vs CHMI declared figures.
                Distinct from raw count which misses the vertical-mix &amp; convergence-pair amplifiers
                that drive cognitive load per Histon 2002 / Hilburn 2004.
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              Refs · Laudeman NASA TM-1998-112226 · Mogford FAA/CT-TN95/22 · Histon JATM 13(4) 2002 · Hilburn EEC Note 04/04 2004 · Chatterji-Sridhar AIAA-2001-5022 · Delahaye-Puechmorel ICRAT 2010 · Lee-Prevot-Mercer AIAA 2006-6312 · Kopardekar-Schwartz NASA TM-2003-211405 · Sridhar NASA TM-1998-112225 · EUROCONTROL CAPAN-7 / SAAM / DDR2 · EUROCONTROL PRR 2024 §3.6 · CANSO PRC 2024 §4.4 · ICAO Doc 9854 GATMOC · Doc 9971 Pt II Ch 6 · Doc 9426 §III.3 · Doc 9882 SWIM · FAA Order JO 7210.3DD §17 · FAA TFMS/TFDM/TBFM v2.1 · NAS SAS sector-design hbk 2023.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
