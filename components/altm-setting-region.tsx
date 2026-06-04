'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   ALTM · Altimeter Setting Region & Transition Altitude/Level
   ------------------------------------------------------------
   Per-airframe Altimeter-Setting-Region (ASR) conformance and
   cold-temperature altimeter-correction scorer.

   Background — three setting domains per ICAO/FAA/EASA:

     · QNH  local sea-level barometric pressure inHg/hPa applied
            so altimeter reads altitude-above-MSL. Required at
            and below the Transition Altitude (TA) per Doc 8168
            §I.2.7, AIM 7-2-2, SERA.5005(d).

     · QNE  standard pressure 29.92 inHg / 1013.25 hPa applied
            so altimeter reads pressure-altitude as a Flight
            Level (FL). Required at and above the Transition
            Level (TL) per Annex 2 §3.6.2 / Doc 7030.

     · QFE  local field-elevation pressure (legacy CIS/AFI use).
            Modelled but not actively scored.

   Transition layer = (TA, TL) — a no-mans-band where altitude
   reference must be switched. Mis-set altimeter inside the
   layer is a textbook level-bust precursor (NTSB AAR-96-03
   Cali, BFU 5X005-99 BAW 2069, ATSB AO-2009-072).

   Cold-temperature correction (CTA): below ISA at low altitudes
   the indicated altitude OVER-reads — true altitude is LOWER
   than indicated, eroding terrain clearance on approach. FAA
   AIM 7-2-3 mandates correction at 53 CTA airports below
   published threshold OAT. ICAO Doc 8168 Vol I §4.3 Table III
   gives the correction = H × (15 − OAT) × 4 / (273 + OAT) ft.

   ============================================================
   Catalogue: 30 Altimeter Setting Regions globally — each
   tagged with bbox, default TA-ft, TL-FL (set per-day by ATIS
   but modelled here as a stable default), units (HPA/INHG),
   QFE-allowed flag, region authority. Plus 14 CTA-listed
   airports with threshold OAT and lowest published intermediate
   altitude per FAA AC 91-79A App B.

   Regions: US-FAA contiguous + Alaska + Hawaii + Canada
   Southern Domestic + Northern Domestic + Arctic; UK CAA;
   Eurocontrol common-TA 18000ft (Maastricht); France SIA;
   Germany DFS; Italy ENAV; Spain ENAIRE; Iberia OCN; Russia
   FATA (QFE-legacy); China CAAC; Japan JCAB; Singapore CAAS;
   Australia AsA; Brazil DECEA; South Africa ATNS.

   ============================================================
   Per-airframe analysis:
     · Identify enclosing region from lat/lng bbox match.
     · Compute pressure-altitude band classifier:
         BELOW-TA   altitudeFt < TA
         IN-LAYER   TA ≤ altitudeFt ≤ TL × 100
         ABOVE-TL   altitudeFt > TL × 100
     · Phase classifier from vertical rate + altitude:
         CLB-TRANS  vRate > +500 fpm and band == IN-LAYER
         DES-TRANS  vRate < -500 fpm and band == IN-LAYER
         CRZ-FL     band == ABOVE-TL and |vRate| < 300
         APP-LOW    band == BELOW-TA and vRate < -200
         DEP-LOW    band == BELOW-TA and vRate > +200
         TERM       band == BELOW-TA and |vRate| < 200
         OCEANIC    region.class == OCN
         IDLE       on ground or below 100 ft AGL
     · Synthetic QNH derived from FNV-1a hash of region-id +
       30-min epoch bucket producing stable +/- 12 hPa range
       around 1013.25 modelling daily/hourly drift.
     · Synthetic OAT from latitude + altitude using ISA lapse
       2°C/1000ft from surface modulated by latitude-cosine,
       stable per ICAO24 hash for cross-tick continuity.

   6 risk drivers (max-driver + secondary-mean composite):
     · ZON  inside-region depth, hard 100 if no region match
     · TRA  transition-layer mismatch: in-layer + climbing
            still on QNH (above TA) 80; descending still on
            QNE below TL 90; ramp by depth into layer
     · QNH  deviation from ISA 1013.25 × QNH-MUL slider 0-100
            at 10 hPa delta
     · CTA  cold-temperature correction magnitude per
            Doc 8168 formula, 100 at 250 ft correction
     · ALT  pressure-altitude vs indicated-altitude error
            from delta-QNH proxy (1 hPa ≈ 27 ft)
     · PHA  phase-criticality APP-LOW 1.40 DES-TRANS 1.30
            CLB-TRANS 1.25 DEP-LOW 1.20 TERM 1.15 CRZ-FL 0.85

   5 tiers:
     · ALT-BUST  score≥80 OR (TRA-bust + CTA-active in app)
                 rose : VERIFY altimeter setting NOW, request
                 QNH from ATIS/ATC, apply CTA per AIM 7-2-3
     · CORR-RQ   score≥55 OR (APP-LOW + CTA>50)
                 rose-pink: cold-temp correction required,
                 add per ICAO Doc 8168 Vol I §4.3 Table III
     · CHECK     score≥35 amber: monitor altimeter setting,
                 cross-check with ATIS/D-ATIS QNH
     · WATCH     score≥18 sky: brief crew on TA/TL transition
                 ahead, set QNH bug
     · OK        score<18 emerald: setting domain conformant
                 / IDLE on ground or no region match slate

   References:
     · ICAO Annex 2 §3.6.2 altimeter operating procedures
     · ICAO Doc 8168 PANS-OPS Vol I §I.2.7 transition altitude
     · ICAO Doc 8168 PANS-OPS Vol I §4.3 cold-temp correction
     · ICAO Doc 7030 Regional Supplementary Procedures
     · ICAO Annex 11 §3.5 ATIS dissemination of QNH/QFE
     · FAA AIM 7-2-1 / 7-2-2 / 7-2-3 altimeter procedures
     · FAA Order JO 7110.65 §2-7 altimeter setting
     · FAA AC 91-79A App B CTA-listed airports
     · FAA AC 91-67 altimeter use
     · FAA 14 CFR §91.121 altimeter settings
     · EU SERA.5005(d) altimeter setting procedures
     · EU SERA.13001 transition altitude harmonisation
     · UK CAA CAP 493 §1.7 altimeter setting
     · UK MATS Part 1 §1.7 QNH dissemination
     · DFS DEFRA AIP GEN 3.3 transition altitude
     · DSNA France AIP GEN 3.3 altimeter regions
     · ENAV Italy AIP GEN 3.3 / RAR
     · ENAIRE Spain AIP GEN 3.3 RAR-Iberia
     · CAAC China AIP ENR 1.7 QNH/QFE dual-use
     · JCAB Japan AIP ENR 1.7
     · CAAS Singapore AIP ENR 1.7
     · Airservices Australia AIP ENR 1.7 area-QNH zones
     · DECEA Brazil ICA 100-12 §15 altimeter procedures
     · Transport Canada TC AIM RAC 9 altimeter regions
     · NAV CANADA Designated Mountainous Region 1-5
     · NTSB AAR-96-03 American 965 Cali CFIT (altimeter)
     · BFU 5X005-99 BAW 2069 Hamburg TA bust
     · ATSB AO-2009-072 ALPHA-737 wrong-altimeter approach
     · ICAO State Letter AN 13/2.1-23/40 TA harmonisation
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'ALT-BUST' | 'CORR-RQ' | 'CHECK' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'ALT-BUST': '#ef4444', 'CORR-RQ': '#f43f5e', CHECK: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['ALT-BUST', 'CORR-RQ', 'CHECK', 'WATCH', 'OK']
const TIER_RANK: Record<Tier, number> = { 'ALT-BUST': 0, 'CORR-RQ': 1, CHECK: 2, WATCH: 3, OK: 4, IDLE: 5 }

type Phase = 'CLB-TRANS' | 'DES-TRANS' | 'CRZ-FL' | 'APP-LOW' | 'DEP-LOW' | 'TERM' | 'OCEANIC' | 'IDLE'
const PHASE_COLOR: Record<Phase, string> = {
  'CLB-TRANS': '#a855f7', 'DES-TRANS': '#ec4899', 'CRZ-FL': '#10b981',
  'APP-LOW': '#ef4444', 'DEP-LOW': '#f59e0b', TERM: '#0ea5e9', OCEANIC: '#6366f1', IDLE: '#475569',
}

type Band = 'BELOW-TA' | 'IN-LAYER' | 'ABOVE-TL'
const BAND_COLOR: Record<Band, string> = {
  'BELOW-TA': '#10b981', 'IN-LAYER': '#f59e0b', 'ABOVE-TL': '#0ea5e9',
}

type RegClass = 'CONT' | 'MTN' | 'OCN' | 'ARC' | 'TROP'

interface Region {
  id: string; name: string; auth: string; klass: RegClass
  bbox: [number, number, number, number] // [latMin, lngMin, latMax, lngMax]
  taFt: number; tlFl: number
  units: 'HPA' | 'INHG'
  qfeOk: boolean
}

const REGIONS: Region[] = [
  { id: 'US-48',  name: 'US Contiguous',           auth: 'FAA',       klass: 'CONT', bbox: [24, -125, 49, -66],   taFt: 18000, tlFl: 180, units: 'INHG', qfeOk: false },
  { id: 'US-AK',  name: 'US Alaska',               auth: 'FAA',       klass: 'MTN',  bbox: [54, -170, 71, -130],  taFt: 18000, tlFl: 180, units: 'INHG', qfeOk: false },
  { id: 'US-HI',  name: 'US Hawaii',               auth: 'FAA',       klass: 'TROP', bbox: [18, -161, 23, -154],  taFt: 18000, tlFl: 180, units: 'INHG', qfeOk: false },
  { id: 'CA-S',   name: 'Canada Southern Domestic',auth: 'NAV CDA',   klass: 'CONT', bbox: [49, -141, 60, -52],   taFt: 18000, tlFl: 180, units: 'INHG', qfeOk: false },
  { id: 'CA-N',   name: 'Canada Northern Domestic',auth: 'NAV CDA',   klass: 'ARC',  bbox: [60, -141, 83, -52],   taFt: 18000, tlFl: 180, units: 'INHG', qfeOk: false },
  { id: 'UK',     name: 'United Kingdom',          auth: 'CAA UK',    klass: 'CONT', bbox: [49.5, -10, 61, 2.5],  taFt: 6000,  tlFl: 70,  units: 'HPA',  qfeOk: false },
  { id: 'IE',     name: 'Ireland',                 auth: 'IAA',       klass: 'CONT', bbox: [51, -11, 56, -5.5],   taFt: 5000,  tlFl: 60,  units: 'HPA',  qfeOk: false },
  { id: 'EU-CMN', name: 'Maastricht UAC (EU-CMN)', auth: 'EUROCONTROL', klass: 'CONT', bbox: [49, 2, 55, 9],      taFt: 18000, tlFl: 195, units: 'HPA',  qfeOk: false },
  { id: 'FR',     name: 'France',                  auth: 'DSNA',      klass: 'CONT', bbox: [42, -5, 51, 8.5],     taFt: 5000,  tlFl: 60,  units: 'HPA',  qfeOk: false },
  { id: 'DE',     name: 'Germany',                 auth: 'DFS',       klass: 'CONT', bbox: [47, 5.5, 55, 15],     taFt: 5000,  tlFl: 70,  units: 'HPA',  qfeOk: false },
  { id: 'IT',     name: 'Italy',                   auth: 'ENAV',      klass: 'MTN',  bbox: [36, 6.5, 47, 19],     taFt: 7000,  tlFl: 80,  units: 'HPA',  qfeOk: false },
  { id: 'ES',     name: 'Spain',                   auth: 'ENAIRE',    klass: 'CONT', bbox: [36, -10, 44, 4],      taFt: 6000,  tlFl: 70,  units: 'HPA',  qfeOk: false },
  { id: 'PT',     name: 'Portugal',                auth: 'NAV PT',    klass: 'CONT', bbox: [36.5, -10, 42.5, -6], taFt: 6000,  tlFl: 70,  units: 'HPA',  qfeOk: false },
  { id: 'CH',     name: 'Switzerland',             auth: 'skyguide',  klass: 'MTN',  bbox: [45.7, 5.8, 47.9, 10.6], taFt: 7000, tlFl: 80, units: 'HPA',  qfeOk: false },
  { id: 'AT',     name: 'Austria',                 auth: 'AustroCtl', klass: 'MTN',  bbox: [46.3, 9.3, 49.1, 17.3], taFt: 10000, tlFl: 110, units: 'HPA', qfeOk: false },
  { id: 'NL-BE',  name: 'Benelux',                 auth: 'LVNL/skeyes', klass:'CONT', bbox: [49.4, 2.5, 53.5, 7.3], taFt: 4500, tlFl: 55, units: 'HPA', qfeOk: false },
  { id: 'NO-SE',  name: 'Scandinavia',             auth: 'NEFAB',     klass: 'ARC',  bbox: [55, 4, 71, 32],       taFt: 5000,  tlFl: 65,  units: 'HPA',  qfeOk: false },
  { id: 'FI-BAL', name: 'Finland & Baltic',        auth: 'Fintraffic',klass: 'CONT', bbox: [54, 20, 70, 32],      taFt: 5000,  tlFl: 65,  units: 'HPA',  qfeOk: false },
  { id: 'PL-CZ',  name: 'Poland & Czechia',        auth: 'PANSA/ANS', klass: 'CONT', bbox: [48.5, 12, 55, 24],    taFt: 6500,  tlFl: 75,  units: 'HPA',  qfeOk: false },
  { id: 'RU-W',   name: 'Russia Western',          auth: 'FATA',      klass: 'CONT', bbox: [41, 19, 70, 60],      taFt: 9800,  tlFl: 105, units: 'HPA',  qfeOk: true  },
  { id: 'CN',     name: 'China',                   auth: 'CAAC',      klass: 'CONT', bbox: [18, 73, 53, 135],     taFt: 9800,  tlFl: 110, units: 'HPA',  qfeOk: true  },
  { id: 'JP',     name: 'Japan',                   auth: 'JCAB',      klass: 'CONT', bbox: [24, 122, 46, 146],    taFt: 14000, tlFl: 150, units: 'HPA',  qfeOk: false },
  { id: 'KR',     name: 'South Korea',             auth: 'KCAB',      klass: 'CONT', bbox: [33, 124, 39, 132],    taFt: 14000, tlFl: 150, units: 'HPA',  qfeOk: false },
  { id: 'SG-MY',  name: 'Singapore-Malaysia',      auth: 'CAAS/DCA',  klass: 'TROP', bbox: [0, 99, 7, 120],       taFt: 11000, tlFl: 130, units: 'HPA',  qfeOk: false },
  { id: 'AU',     name: 'Australia',               auth: 'Airservices', klass:'CONT', bbox: [-44, 112, -10, 154], taFt: 10000, tlFl: 110, units: 'HPA', qfeOk: false },
  { id: 'NZ',     name: 'New Zealand',             auth: 'Airways NZ',klass: 'MTN',  bbox: [-48, 165, -34, 179],  taFt: 11000, tlFl: 130, units: 'HPA',  qfeOk: false },
  { id: 'BR',     name: 'Brazil',                  auth: 'DECEA',     klass: 'TROP', bbox: [-34, -74, 5, -34],    taFt: 7000,  tlFl: 80,  units: 'HPA',  qfeOk: false },
  { id: 'AR-CL',  name: 'Argentina-Chile',         auth: 'EANA/DGAC', klass: 'MTN',  bbox: [-56, -76, -22, -53],  taFt: 12500, tlFl: 145, units: 'HPA',  qfeOk: false },
  { id: 'ZA',     name: 'South Africa',            auth: 'ATNS',      klass: 'CONT', bbox: [-35, 16, -22, 33],    taFt: 8000,  tlFl: 95,  units: 'HPA',  qfeOk: false },
  { id: 'IN',     name: 'India',                   auth: 'AAI',       klass: 'CONT', bbox: [8, 68, 35, 97],       taFt: 4000,  tlFl: 55,  units: 'HPA',  qfeOk: false },
  { id: 'NAT',    name: 'North Atlantic Oceanic',  auth: 'NAT-OPS',   klass: 'OCN',  bbox: [40, -52, 65, -10],    taFt: 18000, tlFl: 180, units: 'HPA',  qfeOk: false },
  { id: 'WPAC',   name: 'West Pacific Oceanic',    auth: 'JCAB/CAAC', klass: 'OCN',  bbox: [-10, 130, 30, 175],   taFt: 18000, tlFl: 180, units: 'HPA',  qfeOk: false },
]

/* CTA — cold-temperature-correction airports (FAA AC 91-79A App B, selection) */
interface CtaApt {
  icao: string; name: string; elevFt: number; thrOAT: number; intAltFt: number; lat: number; lng: number
}
const CTA: CtaApt[] = [
  { icao: 'KBZN', name: 'Bozeman MT',         elevFt: 4474, thrOAT: -27, intAltFt: 6700, lat: 45.778, lng: -111.16 },
  { icao: 'KASE', name: 'Aspen-Pitkin CO',    elevFt: 7820, thrOAT: -12, intAltFt: 10400, lat: 39.223, lng: -106.87 },
  { icao: 'KEGE', name: 'Eagle CO',           elevFt: 6548, thrOAT: -19, intAltFt: 9200, lat: 39.643, lng: -106.92 },
  { icao: 'KJAC', name: 'Jackson WY',         elevFt: 6451, thrOAT: -24, intAltFt: 9000, lat: 43.607, lng: -110.74 },
  { icao: 'KSUN', name: 'Sun Valley ID',      elevFt: 5318, thrOAT: -22, intAltFt: 8200, lat: 43.504, lng: -114.30 },
  { icao: 'KMSO', name: 'Missoula MT',        elevFt: 3206, thrOAT: -28, intAltFt: 5800, lat: 46.916, lng: -114.09 },
  { icao: 'KTEX', name: 'Telluride CO',       elevFt: 9078, thrOAT: -14, intAltFt: 12000, lat: 37.954, lng: -107.91 },
  { icao: 'CYYC', name: 'Calgary AB',         elevFt: 3557, thrOAT: -30, intAltFt: 6200, lat: 51.114, lng: -114.02 },
  { icao: 'CYEG', name: 'Edmonton AB',        elevFt: 2373, thrOAT: -32, intAltFt: 5100, lat: 53.310, lng: -113.58 },
  { icao: 'BIRK', name: 'Reykjavik IS',       elevFt: 48,   thrOAT: -15, intAltFt: 2500, lat: 64.130, lng: -21.94 },
  { icao: 'ENGM', name: 'Oslo NO',            elevFt: 681,  thrOAT: -27, intAltFt: 3500, lat: 60.193, lng: 11.10  },
  { icao: 'ESSA', name: 'Stockholm SE',       elevFt: 137,  thrOAT: -23, intAltFt: 2800, lat: 59.652, lng: 17.92  },
  { icao: 'EFHK', name: 'Helsinki FI',        elevFt: 179,  thrOAT: -28, intAltFt: 2900, lat: 60.317, lng: 24.96  },
  { icao: 'UUEE', name: 'Moscow-Sheremetyevo',elevFt: 622,  thrOAT: -25, intAltFt: 3600, lat: 55.972, lng: 37.41  },
]

/* ----- util ----- */
const clamp = (v: number, mn: number, mx: number) => Math.max(mn, Math.min(mx, v))
const gcNm = (la1: number, lo1: number, la2: number, lo2: number) => {
  const R = 3440.065, t = Math.PI / 180
  const d = Math.sin((la2 - la1) * t / 2) ** 2 + Math.cos(la1 * t) * Math.cos(la2 * t) * Math.sin((lo2 - lo1) * t / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(d))
}
const fnv = (s: string) => { let h = 0x811c9dc5 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 } return h }
const hashf = (s: string) => (fnv(s) % 10000) / 10000

const lsKey = (k: string) => `ft-altm-${k}`
const lsGet = (k: string, dflt: number) => { try { const v = localStorage.getItem(lsKey(k)); return v ? parseInt(v) : dflt } catch { return dflt } }
const lsSet = (k: string, v: number) => { try { localStorage.setItem(lsKey(k), String(v)) } catch {} }

const enclosingRegion = (lat: number, lng: number): Region | null => {
  // prefer non-OCN matches; OCN as fallback
  let oceanic: Region | null = null
  for (const r of REGIONS) {
    const [la0, lo0, la1, lo1] = r.bbox
    if (lat >= la0 && lat <= la1 && lng >= lo0 && lng <= lo1) {
      if (r.klass === 'OCN') { oceanic = oceanic || r; continue }
      return r
    }
  }
  return oceanic
}

const synthQnhHpa = (r: Region, epochBucket: number) => {
  const h = hashf(`${r.id}|${epochBucket}|qnh`)
  // +/- 12 hPa around 1013.25, bias by region klass (MTN/ARC slightly lower mean)
  const bias = r.klass === 'MTN' ? -2 : r.klass === 'ARC' ? -3 : r.klass === 'TROP' ? +1 : 0
  return 1013.25 + bias + (h - 0.5) * 24
}

const synthOAT = (lat: number, altFt: number, icao: string) => {
  // surface temp by lat: 30°C tropics down to -15°C poles, jitter +/- 8 per ac
  const surf = 30 - Math.abs(lat) * 0.55
  const jitter = (hashf(icao + '|oat') - 0.5) * 16
  // ISA lapse 1.98°C / 1000 ft
  return surf + jitter - altFt * 0.00198
}

const cold = (H: number, OAT: number) => {
  // ICAO Doc 8168 Vol I §4.3: correction ≈ H × (15 − OAT) × 4 / (273 + OAT)
  // Only applicable when OAT < ISA at altitude. We use total cold-correction ft.
  if (OAT >= 15) return 0
  const corrPerFt = (15 - OAT) * 4 / (273 + OAT)
  return Math.max(0, H * corrPerFt / 1000)
}

interface Drv { ZON: number; TRA: number; QNH: number; CTA: number; ALT: number; PHA: number }
interface Pm {
  f: SFlight
  region: Region | null
  band: Band
  phase: Phase
  qnhHpa: number
  qnhDeltaHpa: number
  oatC: number
  ctaFt: number
  altErrFt: number
  ctaApt: CtaApt | null
  ctaActive: boolean
  drivers: Drv
  score: number
  tier: Tier
  traBust: boolean
}

const analyse = (f: SFlight, epochBucket: number, ctaScopeNm: number, oatBias: number): Pm | null => {
  if (f.ground) return null
  const region = enclosingRegion(f.lat, f.lng)
  if (!region) {
    return {
      f, region: null, band: 'BELOW-TA', phase: 'IDLE', qnhHpa: 1013.25, qnhDeltaHpa: 0,
      oatC: 15, ctaFt: 0, altErrFt: 0, ctaApt: null, ctaActive: false,
      drivers: { ZON: 100, TRA: 0, QNH: 0, CTA: 0, ALT: 0, PHA: 0 },
      score: 0, tier: 'IDLE', traBust: false,
    }
  }
  const taFt = region.taFt
  const tlFt = region.tlFl * 100
  let band: Band
  if (f.altitudeFt < taFt) band = 'BELOW-TA'
  else if (f.altitudeFt > tlFt) band = 'ABOVE-TL'
  else band = 'IN-LAYER'

  let phase: Phase
  if (region.klass === 'OCN' && band === 'ABOVE-TL') phase = 'OCEANIC'
  else if (band === 'IN-LAYER' && f.vertRate > 500) phase = 'CLB-TRANS'
  else if (band === 'IN-LAYER' && f.vertRate < -500) phase = 'DES-TRANS'
  else if (band === 'ABOVE-TL' && Math.abs(f.vertRate) < 300) phase = 'CRZ-FL'
  else if (band === 'BELOW-TA' && f.vertRate < -200) phase = 'APP-LOW'
  else if (band === 'BELOW-TA' && f.vertRate > 200) phase = 'DEP-LOW'
  else if (band === 'BELOW-TA') phase = 'TERM'
  else if (band === 'ABOVE-TL') phase = 'CRZ-FL'
  else phase = 'IDLE'

  const qnhHpa = synthQnhHpa(region, epochBucket)
  const qnhDeltaHpa = qnhHpa - 1013.25
  const oatC = synthOAT(f.lat, f.altitudeFt, f.icao) + oatBias
  // nearest CTA-listed airport within scope
  let ctaApt: CtaApt | null = null
  let ctaDist = 9999
  for (const a of CTA) {
    const d = gcNm(f.lat, f.lng, a.lat, a.lng)
    if (d < ctaScopeNm && d < ctaDist) { ctaApt = a; ctaDist = d }
  }
  let ctaFt = 0
  let ctaActive = false
  if (ctaApt && (phase === 'APP-LOW' || phase === 'TERM' || phase === 'DEP-LOW')) {
    const aglFt = Math.max(0, f.altitudeFt - ctaApt.elevFt)
    if (aglFt > 0 && aglFt < 12000 && oatC < ctaApt.thrOAT) {
      ctaFt = cold(aglFt, oatC)
      ctaActive = true
    }
  }
  // altimeter-error proxy: 1 hPa ≈ 27 ft. If wrong setting on wrong side of layer, full delta applies.
  let altErrFt = 0
  let traBust = false
  if (band === 'IN-LAYER') {
    // half-application during transition
    altErrFt = Math.abs(qnhDeltaHpa) * 27 * 0.5
    // detect TRA-bust: climbing through layer past TA still on QNH (above TA boundary by >300ft)
    if ((phase === 'CLB-TRANS' && f.altitudeFt - taFt > 300) || (phase === 'DES-TRANS' && tlFt - f.altitudeFt > 300)) traBust = true
  } else if (band === 'BELOW-TA') {
    altErrFt = Math.abs(qnhDeltaHpa) * 27 * 0.05 // marginal, you should be on QNH
  } else {
    altErrFt = Math.abs(qnhDeltaHpa) * 27 * 0.05 // marginal, you should be on QNE — but for FL display, QNH-delta = ALT delta
  }
  // drivers
  const ZON = 0
  const TRA = band === 'IN-LAYER'
    ? clamp(40 + (traBust ? 50 : 0) + Math.abs(f.vertRate) / 50, 0, 100)
    : 0
  const QNH = clamp(Math.abs(qnhDeltaHpa) * 10, 0, 100)
  const CTAd = ctaActive ? clamp(ctaFt / 2.5, 0, 100) : 0
  const ALT = clamp(altErrFt / 1.2, 0, 100)
  const phaseMul = phase === 'APP-LOW' ? 1.40 : phase === 'DES-TRANS' ? 1.30 : phase === 'CLB-TRANS' ? 1.25
    : phase === 'DEP-LOW' ? 1.20 : phase === 'TERM' ? 1.15 : phase === 'CRZ-FL' ? 0.85 : phase === 'OCEANIC' ? 0.75 : 0.40
  const phaCore = Math.max(TRA, CTAd * 0.6, ALT * 0.6)
  const PHA = clamp(phaCore * phaseMul, 0, 100)
  return {
    f, region, band, phase, qnhHpa, qnhDeltaHpa, oatC, ctaFt, altErrFt, ctaApt, ctaActive,
    drivers: { ZON, TRA, QNH, CTA: CTAd, ALT, PHA }, score: 0, tier: 'OK', traBust,
  }
}

const SRC_REG = 'altm-reg', LYR_REG_FILL = 'altm-reg-fill', LYR_REG_LINE = 'altm-reg-line', LYR_REG_LBL = 'altm-reg-lbl'
const SRC_HALO = 'altm-halo', LYR_HALO = 'altm-halo'
const SRC_PIN = 'altm-pin', LYR_PIN = 'altm-pin'
const SRC_LBL = 'altm-lbl', LYR_LBL = 'altm-lbl'
const SRC_CTA = 'altm-cta', LYR_CTA = 'altm-cta'

export default function AltmSettingRegion({ map, flights, onClose, onFly }: Props) {
  const [traMul, setTraMul] = useState<number>(() => lsGet('tra', 100))
  const [qnhMul, setQnhMul] = useState<number>(() => lsGet('qnh', 100))
  const [ctaMul, setCtaMul] = useState<number>(() => lsGet('cta', 100))
  const [phaseWt, setPhaseWt] = useState<number>(() => lsGet('pwt', 100))
  const [oatBias, setOatBias] = useState<number>(() => lsGet('oatb', 0))
  const [ctaScopeNm, setCtaScopeNm] = useState<number>(() => lsGet('csc', 30))
  const [tab, setTab] = useState<'AIRCRAFT' | 'REGIONS' | 'CTA'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [bandFilter, setBandFilter] = useState<Band | 'ALL'>('ALL')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showReg, setShowReg] = useState(true)
  const [showCtaP, setShowCtaP] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    lsSet('tra', traMul); lsSet('qnh', qnhMul); lsSet('cta', ctaMul)
    lsSet('pwt', phaseWt); lsSet('oatb', oatBias); lsSet('csc', ctaScopeNm)
  }, [traMul, qnhMul, ctaMul, phaseWt, oatBias, ctaScopeNm])

  const rows = useMemo(() => {
    const epochBucket = Math.floor(Date.now() / (30 * 60 * 1000))
    const out: Pm[] = []
    for (const f of flights) {
      const v = analyse(f, epochBucket, ctaScopeNm, oatBias); if (!v) continue
      v.drivers.TRA = clamp(v.drivers.TRA * traMul / 100, 0, 100)
      v.drivers.QNH = clamp(v.drivers.QNH * qnhMul / 100, 0, 100)
      v.drivers.CTA = clamp(v.drivers.CTA * ctaMul / 100, 0, 100)
      v.drivers.PHA = clamp(v.drivers.PHA * phaseWt / 100, 0, 100)
      const maxDrv = Math.max(v.drivers.ZON, v.drivers.TRA, v.drivers.QNH, v.drivers.CTA, v.drivers.ALT, v.drivers.PHA)
      const sec = (v.drivers.ZON + v.drivers.TRA + v.drivers.QNH + v.drivers.CTA + v.drivers.ALT + v.drivers.PHA - maxDrv) / 5
      v.score = clamp(maxDrv * 0.84 + sec * 0.16, 0, 100)
      if (v.score >= 80 || (v.traBust && v.ctaActive)) v.tier = 'ALT-BUST'
      else if (v.score >= 55 || (v.phase === 'APP-LOW' && v.drivers.CTA >= 50)) v.tier = 'CORR-RQ'
      else if (v.score >= 35) v.tier = 'CHECK'
      else if (v.score >= 18) v.tier = 'WATCH'
      else v.tier = 'OK'
      if (v.phase === 'IDLE' || !v.region) v.tier = 'IDLE'
      out.push(v)
    }
    out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, traMul, qnhMul, ctaMul, phaseWt, oatBias, ctaScopeNm])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(v => {
      if (tierFilter !== 'ALL' && v.tier !== tierFilter) return false
      if (bandFilter !== 'ALL' && v.band !== bandFilter) return false
      if (q) {
        const blob = `${v.f.callsign} ${v.f.icao} ${v.f.type} ${v.region?.id} ${v.region?.name} ${v.ctaApt?.icao || ''}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [rows, tierFilter, bandFilter, query])

  const tierCount: Record<Tier, number> = { 'ALT-BUST': 0, 'CORR-RQ': 0, CHECK: 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const v of rows) tierCount[v.tier]++
  const bustN = tierCount['ALT-BUST']
  const corrN = tierCount['CORR-RQ']
  const traBustN = rows.filter(v => v.traBust).length
  const ctaActN = rows.filter(v => v.ctaActive).length
  const inLayerN = rows.filter(v => v.band === 'IN-LAYER').length
  const worst = rows[0]
  const meanScore = rows.length ? rows.reduce((s, v) => s + v.score, 0) / rows.length : 0
  const meanCta = (() => { const xs = rows.filter(v => v.ctaActive); return xs.length ? xs.reduce((s, v) => s + v.ctaFt, 0) / xs.length : 0 })()

  useEffect(() => {
    if (!map) return
    const ensure = (id: string, type: any, src: string, paint: any, layout: any = {}) => {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer(id)) map.addLayer({ id, type, source: src, paint, layout } as any)
    }
    ensure(LYR_REG_FILL, 'fill', SRC_REG, { 'fill-color': ['get', 'color'], 'fill-opacity': 0.06 })
    ensure(LYR_REG_LINE, 'line', SRC_REG, { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.6, 'line-dasharray': [3, 3] })
    ensure(LYR_REG_LBL, 'symbol', SRC_REG, {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 0], 'text-anchor': 'center', 'text-font': ['Open Sans Regular'] })
    if (map.getLayer(LYR_REG_LBL)) { map.setPaintProperty(LYR_REG_LBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_REG_LBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_REG_LBL, 'text-halo-width', 1.2) }
    ensure(LYR_CTA, 'circle', SRC_CTA, { 'circle-radius': 4.5, 'circle-color': '#a855f7', 'circle-stroke-width': 1.4, 'circle-stroke-color': '#0f172a' })
    ensure(LYR_HALO, 'circle', SRC_HALO, { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.2, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'] })
    ensure(LYR_PIN, 'circle', SRC_PIN, { 'circle-radius': 5.5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' })
    ensure(LYR_LBL, 'symbol', SRC_LBL, {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    if (map.getLayer(LYR_LBL)) { map.setPaintProperty(LYR_LBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_LBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_LBL, 'text-halo-width', 1.4) }

    const activeReg = new Set<string>()
    for (const v of filtered) if (v.region) activeReg.add(v.region.id)
    const reg: any[] = []
    if (showReg) {
      for (const r of REGIONS) {
        const isAct = activeReg.has(r.id)
        const col = isAct ? '#0ea5e9' : r.klass === 'OCN' ? '#475569' : r.klass === 'MTN' ? '#7c5b3a' : r.klass === 'ARC' ? '#3a5a7c' : '#334155'
        const [la0, lo0, la1, lo1] = r.bbox
        const ring = [[lo0, la0], [lo1, la0], [lo1, la1], [lo0, la1], [lo0, la0]]
        reg.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { color: col } })
        const cla = (la0 + la1) / 2, clo = (lo0 + lo1) / 2
        reg.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [clo, cla] }, properties: { color: col, label: `${r.id} TA${(r.taFt / 1000).toFixed(0)}k/TL${r.tlFl}` } })
      }
    }
    const cta: any[] = []
    if (showCtaP) for (const a of CTA) cta.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [a.lng, a.lat] }, properties: {} })

    const halo: any[] = [], pin: any[] = [], lbl: any[] = []
    for (const v of filtered) {
      if (v.tier === 'IDLE') continue
      const c = TIER_COLOR[v.tier]
      if (showHalo) halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: { color: c, r: 8 + v.score * 0.14 } })
      if (showPin && (v.tier === 'ALT-BUST' || v.tier === 'CORR-RQ')) pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: { color: c } })
      if (showLbl && v.tier !== 'OK') {
        const sign = v.qnhDeltaHpa >= 0 ? '+' : ''
        const lab = `${v.f.callsign || v.f.icao} ${v.tier} ${v.band} Q${sign}${v.qnhDeltaHpa.toFixed(0)}hPa${v.ctaActive ? ` CTA${v.ctaFt.toFixed(0)}ft` : ''}`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: { label: lab, color: c } })
      }
    }
    ;(map.getSource(SRC_REG) as any).setData({ type: 'FeatureCollection', features: reg })
    ;(map.getSource(SRC_CTA) as any).setData({ type: 'FeatureCollection', features: cta })
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_CTA, LYR_REG_LBL, LYR_REG_LINE, LYR_REG_FILL]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_CTA, SRC_REG]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, filtered, showHalo, showPin, showLbl, showReg, showCtaP])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const phaseBadge = (p: Phase) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: PHASE_COLOR[p], backgroundColor: PHASE_COLOR[p] + '1a', border: `1px solid ${PHASE_COLOR[p]}66` }}>{p}</span>
  )
  const bandBadge = (b: Band) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: BAND_COLOR[b], backgroundColor: BAND_COLOR[b] + '1a', border: `1px solid ${BAND_COLOR[b]}66` }}>{b}</span>
  )
  const drvBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const advice = (v: Pm) => {
    if (!v.region) return 'No altimeter-setting region match - aircraft outside catalogued ASR coverage'
    if (v.tier === 'ALT-BUST') return `ALT-BUST · VERIFY altimeter setting NOW · ${v.band} on ${v.region.id} TA${(v.region.taFt / 1000).toFixed(0)}k/TL${v.region.tlFl} · request QNH ${v.qnhHpa.toFixed(0)}hPa from ATIS/ATC · per ICAO Doc 8168 §I.2.7 / FAA AIM 7-2-2`
    if (v.tier === 'CORR-RQ') return `CORR-RQ · cold-temp correction +${v.ctaFt.toFixed(0)}ft required for ${v.ctaApt?.icao} (OAT ${v.oatC.toFixed(0)}°C < thr ${v.ctaApt?.thrOAT}°C) · add per ICAO Doc 8168 Vol I §4.3 Table III / FAA AIM 7-2-3`
    if (v.tier === 'CHECK') return `CHECK · monitor altimeter setting · QNH Δ${v.qnhDeltaHpa >= 0 ? '+' : ''}${v.qnhDeltaHpa.toFixed(0)}hPa from std · cross-check with ATIS · per JO 7110.65 §2-7`
    if (v.tier === 'WATCH') return `WATCH · ${v.band} on ${v.region.id} · brief crew on TA${(v.region.taFt / 1000).toFixed(0)}k transition ahead · per SERA.5005(d)`
    return `OK · ${v.band} setting domain conformant · QNH ${v.qnhHpa.toFixed(0)}hPa per ${v.region.auth}`
  }

  /* Scatter: |QNH-delta| hPa horizontal vs altitude-error ft vertical */
  const W = 280, H = 180
  const sx = (n: number) => 32 + clamp(n / 15, 0, 1) * (W - 42)
  const sy = (n: number) => H - 24 - clamp(n / 400, 0, 1) * (H - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">ALTM · Altimeter Setting Region &amp; TA/TL · CTA</div>
          <div className="text-[10px] text-slate-500">ICAO Annex 2 §3.6 · Doc 8168 §I.2.7 / §4.3 · Doc 7030 · FAA AIM 7-2 · 14 CFR §91.121 · AC 91-79A · SERA.5005(d)</div>
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
          <div className="text-[9px] text-slate-500 uppercase">Mean score</div>
          <div className="text-sm font-semibold" style={{ color: meanScore >= 55 ? '#ef4444' : meanScore >= 25 ? '#f59e0b' : '#10b981' }}>{meanScore.toFixed(0)}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst ? (worst.f.callsign || worst.f.icao) : '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">ALT-BUST</div>
          <div className="text-sm font-semibold" style={{ color: bustN > 0 ? '#ef4444' : '#10b981' }}>{bustN}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">CORR-RQ</div>
          <div className="text-xs font-semibold" style={{ color: corrN > 0 ? '#f43f5e' : '#10b981' }}>{corrN}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">CTA active</div>
          <div className="text-xs font-semibold" style={{ color: ctaActN > 0 ? '#a855f7' : '#10b981' }}>{ctaActN}<span className="text-slate-500"> · μ{meanCta.toFixed(0)}ft</span></div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">In layer</div>
          <div className="text-xs font-semibold text-amber-400">{inLayerN}<span className="text-slate-500"> · tra-bust {traBustN}</span></div>
        </div>
      </div>

      {showDiag && rows.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            <rect x={sx(10)} y={0} width={W - sx(10)} height={sy(200) - 0} fill="#ef444425" />
            <rect x={sx(5)} y={sy(400)} width={W - sx(5)} height={H - 24 - sy(400)} fill="#f59e0b20" />
            <line x1={sx(5)} y1={0} x2={sx(5)} y2={H - 24} stroke="#f59e0b55" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(10)} y1={0} x2={sx(10)} y2={H - 24} stroke="#ef444466" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={0} y1={sy(200)} x2={W} y2={sy(200)} stroke="#ef444466" strokeWidth={0.4} strokeDasharray="3 3" />
            <text x={W / 2} y={H - 4} textAnchor="middle" fontSize="9" fill="#64748b">|QNH Δ| hPa</text>
            <text x={6} y={H / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H / 2})`}>alt-err ft</text>
            {rows.map((v, i) => (
              <circle key={i} cx={sx(Math.abs(v.qnhDeltaHpa))} cy={sy(Math.max(0, v.altErrFt + v.ctaFt))} r={2.4} fill={TIER_COLOR[v.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['TRA-MUL', traMul, 50, 200, setTraMul, '%'],
            ['QNH-MUL', qnhMul, 50, 200, setQnhMul, '%'],
            ['CTA-MUL', ctaMul, 50, 200, setCtaMul, '%'],
            ['PHASE-WT', phaseWt, 50, 150, setPhaseWt, '%'],
            ['OAT-BIAS', oatBias, -30, 20, setOatBias, '°C'],
            ['CTA-SCOPE', ctaScopeNm, 10, 80, setCtaScopeNm, 'nm'],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[72px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[44px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['BELOW-TA', 'IN-LAYER', 'ABOVE-TL'] as Band[]).map(b => (
            <button key={b} onClick={() => setBandFilter(bandFilter === b ? 'ALL' : b)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: bandFilter === b ? BAND_COLOR[b] + '33' : '#0b1220', borderColor: bandFilter === b ? BAND_COLOR[b] : '#1e293b', color: bandFilter === b ? BAND_COLOR[b] : '#cbd5e1' }}>{b}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['REG', showReg, setShowReg],
            ['CTA', showCtaP, setShowCtaP],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, on, setter]: any) => (
            <button key={lab} onClick={() => setter(!on)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: on ? '#0ea5e933' : '#0b1220', borderColor: on ? '#0ea5e9' : '#1e293b', color: on ? '#0ea5e9' : '#94a3b8' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / region / CTA airport" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'REGIONS', 'CTA'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-1.5 text-[10px] font-semibold ${tab === t ? 'text-sky-400 bg-slate-800/50 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {tab === 'AIRCRAFT' && (
        <div className="divide-y divide-slate-800">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No tracked targets in altimeter-setting scope</div>}
          {filtered.map((v, idx) => (
            <div key={idx} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(v.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[v.tier]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 truncate">{v.f.callsign || v.f.icao}</span>
                  <span className="text-slate-500 text-[10px] truncate">{v.f.type || '—'}</span>
                  {phaseBadge(v.phase)}
                  {bandBadge(v.band)}
                </div>
                {tierBadge(v.tier)}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                <span className="text-sky-300">{v.region?.id || 'NO-REG'}</span>
                {v.region && <> · TA<span className="text-slate-200">{(v.region.taFt / 1000).toFixed(0)}k</span> TL<span className="text-slate-200">{v.region.tlFl}</span> · {v.region.units}</>}
                {' · alt '}<span className="text-slate-200">{v.f.altitudeFt.toFixed(0)}ft</span>
                {' · vs '}<span className="text-slate-300">{v.f.vertRate >= 0 ? '↑' : '↓'}{Math.abs(v.f.vertRate).toFixed(0)}fpm</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                <span className="text-slate-500">QNH</span> <span className="text-slate-200">{v.qnhHpa.toFixed(0)}</span>
                <span className="text-slate-500"> Δ</span><span style={{ color: Math.abs(v.qnhDeltaHpa) >= 10 ? '#ef4444' : Math.abs(v.qnhDeltaHpa) >= 5 ? '#f59e0b' : '#cbd5e1' }}>{v.qnhDeltaHpa >= 0 ? '+' : ''}{v.qnhDeltaHpa.toFixed(1)}hPa</span>
                {' · '}<span className="text-slate-500">OAT</span> <span style={{ color: v.oatC < -15 ? '#0ea5e9' : '#cbd5e1' }}>{v.oatC.toFixed(0)}°C</span>
                {v.ctaApt && <> · <span className="text-purple-400">{v.ctaApt.icao}</span> {v.ctaActive ? <span className="text-rose-300">CTA +{v.ctaFt.toFixed(0)}ft</span> : <span className="text-slate-500">thr {v.ctaApt.thrOAT}°C</span>}</>}
                {v.traBust && <span className="text-rose-400"> · TRA-BUST ›</span>}
              </div>
              <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${v.score}%`, backgroundColor: TIER_COLOR[v.tier] }} /></div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {drvBadge('ZON', v.drivers.ZON)}
                {drvBadge('TRA', v.drivers.TRA)}
                {drvBadge('QNH', v.drivers.QNH)}
                {drvBadge('CTA', v.drivers.CTA)}
                {drvBadge('ALT', v.drivers.ALT)}
                {drvBadge('PHA', v.drivers.PHA)}
              </div>
              <div className="text-[10px] mt-1.5 italic" style={{ color: TIER_COLOR[v.tier] }}>{advice(v)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'REGIONS' && (
        <div className="divide-y divide-slate-800">
          {REGIONS.slice().sort((a, b) => {
            const ka = rows.filter(r => r.region?.id === a.id).length
            const kb = rows.filter(r => r.region?.id === b.id).length
            return kb - ka
          }).map(r => {
            const rRows = rows.filter(x => x.region?.id === r.id)
            const ms = rRows.length ? rRows.reduce((s, x) => s + x.score, 0) / rRows.length : 0
            const bst = rRows.filter(x => x.tier === 'ALT-BUST').length
            const cor = rRows.filter(x => x.tier === 'CORR-RQ').length
            const lay = rRows.filter(x => x.band === 'IN-LAYER').length
            return (
              <div key={r.id} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => { if (rRows[0]) onFly(rRows[0].f.icao) }} style={{ borderLeft: `3px solid ${bst > 0 ? '#ef4444' : cor > 0 ? '#f43f5e' : ms >= 35 ? '#f59e0b' : '#10b981'}` }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-sky-300">{r.id}</span>
                    <span className="text-slate-200 text-[11px]">{r.name}</span>
                    <span className="text-[9px] px-1 rounded font-mono" style={{ color: r.klass === 'OCN' ? '#6366f1' : r.klass === 'MTN' ? '#a855f7' : r.klass === 'ARC' ? '#0ea5e9' : r.klass === 'TROP' ? '#f59e0b' : '#94a3b8', backgroundColor: '#0b1220', border: '1px solid #33415566' }}>{r.klass}</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-300">TA<span className="text-amber-300">{(r.taFt / 1000).toFixed(0)}k</span>/TL<span className="text-sky-300">{r.tlFl}</span></span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  {r.auth} · {r.units}{r.qfeOk && <span className="text-purple-400"> · QFE-OK</span>}
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  {rRows.length} ac · <span className="text-rose-400">{bst} BUST</span> · <span className="text-rose-300">{cor} CORR</span> · <span className="text-amber-400">{lay} in-layer</span>
                </div>
                <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: ms >= 60 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }} /></div>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'CTA' && (
        <div className="divide-y divide-slate-800">
          {CTA.slice().sort((a, b) => {
            const ka = rows.filter(r => r.ctaApt?.icao === a.icao && r.ctaActive).length
            const kb = rows.filter(r => r.ctaApt?.icao === b.icao && r.ctaActive).length
            return kb - ka
          }).map(a => {
            const aRows = rows.filter(r => r.ctaApt?.icao === a.icao)
            const act = aRows.filter(r => r.ctaActive).length
            const meanC = aRows.filter(r => r.ctaActive).length ? aRows.filter(r => r.ctaActive).reduce((s, r) => s + r.ctaFt, 0) / aRows.filter(r => r.ctaActive).length : 0
            const meanOat = aRows.length ? aRows.reduce((s, r) => s + r.oatC, 0) / aRows.length : 0
            return (
              <div key={a.icao} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => { if (aRows[0]) onFly(aRows[0].f.icao) }} style={{ borderLeft: `3px solid ${act > 0 ? '#a855f7' : '#475569'}` }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-purple-300">{a.icao}</span>
                    <span className="text-slate-200 text-[11px]">{a.name}</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-300">elev <span className="text-amber-300">{a.elevFt}ft</span> · thr <span className="text-sky-300">{a.thrOAT}°C</span></span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  int-alt <span className="text-slate-200">{a.intAltFt}ft</span> · per FAA AC 91-79A App B · AIM 7-2-3
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  {aRows.length} ac in scope · <span className="text-purple-400">{act} CTA-active</span> · μOAT <span style={{ color: meanOat < -15 ? '#0ea5e9' : '#cbd5e1' }}>{meanOat.toFixed(0)}°C</span>{act > 0 && <> · μcorr <span className="text-rose-300">+{meanC.toFixed(0)}ft</span></>}
                </div>
              </div>
            )
          })}
          <div className="px-3 py-2 text-[10px] text-slate-500">
            Cold-temperature altimeter correction is mandatory when surface temperature is at or below the published threshold per AIM 7-2-3 / FAA AC 91-79A. Indicated altitude over-reads in cold air - true altitude is LOWER - eroding terrain and obstacle clearance on intermediate, final, and missed-approach segments. Correction formula per ICAO Doc 8168 Vol I §4.3 Table III.
          </div>
        </div>
      )}
    </div>
  )
}
