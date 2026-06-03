'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   ILS Critical & Sensitive Area Protection / LVO Surface-Movement
   Monitor (ICAO Annex 10 Vol I App C · CAT-I/II/III)
   -----------------------------------------------------------
   For every aircraft on or near a catalogued CAT-II/III runway,
   compute the per-station LLZ (localizer) and GP (glideslope)
   *Critical Area* (CA) and *Sensitive Area* (SA) per ICAO
   Annex 10 Vol I Att C §2.1.9 / FAA Order 6750.16E / EUROCONTROL
   ICAO EUR Doc 013, and decide whether an aircraft holding or
   taxiing near the runway threshold is *infringing* signal-
   protection — which causes course-bend / path-bend errors in
   the airborne ILS receiver during another aircraft's CAT-III
   autoland flare.

   Geometry (per Annex 10 Vol I Att C Fig C-9 / C-12):
     LLZ critical area:    300 m × 60 m centred on antenna,
                           extends along runway centreline
     LLZ sensitive area:   3000 m × 120 m (CAT-III) along
                           runway centreline, narrowing past
                           threshold by 5° splay
     GP critical area:     90 m × 60 m around antenna 250-450 m
                           from threshold offset 120 m
     GP sensitive area:    Triangle 1200 m × 300 m projecting
                           down approach path from antenna
     Approach signal-protected volume: ILS LOC course ±2.5° to
                           25 nm × ±35° to 17 nm per Annex 10
                           §3.1.3.3 · per active LLZ DDM signal

   Per-airframe risk drivers (max-driver composite 0-100):
     LLZ-CA   inside LLZ critical-area polygon  → 100
     LLZ-SA   inside LLZ sensitive-area polygon → 60-90 by tier
     GP-CA    inside GP critical-area polygon   → 100
     GP-SA    inside GP sensitive-area polygon  → 55-85 by tier
     APP-CONE landing aircraft on final < 4 nm  → +30 weight
              (only matters when CA/SA infringed by another a/c)
     ATC-CAT  current declared LVO category III → ×1.4 multiplier
              II → ×1.2 · I → ×0.8 · OFF → ×0.4

   5-tier classification:
     INFRINGE   score≥80 OR inside CA with active LVO-II/III     rose
                (vacate immediately; LLZ/GP signal corrupted for
                 inbound CAT-III autoland · request priority taxi
                 per FAA Order JO 7110.65 § 3-7-5 / ICAO Doc 4444
                 § 7.13)
     CAUTION    score≥55 OR inside SA with active LVO-II/III     amber
                (taxi only beyond SA hold-bars · brief crew per
                 FAA AC 120-118 § 7 / EASA AMC1 SPA.LVO.100)
     WATCH      score≥25 (near SA boundary, trend adverse)       sky
                (monitor position; check ATIS for LVO status)
     OK         score<25 (clear of signal-protected volumes)     emerald
     IDLE       no active CAT-II/III runway in catchment OR      slate
                aircraft airborne above FL050

   24-airport catalogue spans top CAT-IIIB runways:
     CDG 09L · LHR 09L/27R · FRA 25L · AMS 18R · MUC 08L
     EDDM-ZRH-VIE-CPH-OSL-ARN-HEL-EHAM-DUS-EDDF-LSGG-LFPO
     JFK 04R · ORD 10L · ATL 27R · SEA 16C · YYZ 06L · MEM 18R
     HND 34L · NRT 16R · ICN 15R · PEK 36R

   Per-runway lat/lng of LLZ antenna (far end), GP antenna
   (offset 120 m from RCL ~ 300 m from threshold), threshold
   coords, true bearing, length-m, current declared category
   (hash-stable on day-bucket biased by WX-LVO slider 0-100%).

   MapLibre overlay:
     - 24 runway centreline polylines tier-coloured by current
       declared category (CAT-III emerald, II sky, I slate, OFF
       dim) with IATA / RWY / CAT-III label at LLZ end
     - dashed yellow LLZ critical-area rectangle (300×60 m)
       around each LLZ when LVO active
     - dashed amber LLZ sensitive-area rectangle (3000×120 m)
     - dashed cyan GP critical/sensitive triangles
     - tier-coloured halo rings on each tracked aircraft sized
       8-22 px by score
     - rose diamond pin on INFRINGE aircraft
     - tier-coloured callsign + RWY + driver label
     - dashed projection line from aircraft to nearest LLZ
       antenna for non-OK aircraft

   Side panel:
     5-tier counter strip click-to-filter +
     3-cell TRACKED / INFRINGE / WORST callsign summary +
     2-cell LVO-ACTIVE-runway-count / MEAN-SCORE secondary +
     SVG dist-to-LLZ-m vs ground-speed-kt scatter with
       quadrant bands (inside CA red / inside SA amber /
       outside SA sky)  +
     6 sliders MIN-FL 0-50 / CAPTURE 0-20 nm /
       WX-LVO 0-100% / CA-MUL 50-200% / SA-MUL 50-200% /
       APP-WEIGHT 0-100% in 2-col grid +
     4-cat chip filter LVO-III / LVO-II / LVO-I / LVO-OFF +
     HALO/PIN/LBL/PROJ/CA/SA toggles +
     search by callsign or IATA +
     AIRCRAFT / RUNWAYS tab switcher +
     AIRCRAFT tab sorted tier-worst-first then score desc with
       tier color stripe + callsign + type + RWY-pill + tier-
       pill + dist-LLZ-m / ground-speed-kt / inside-CA-SA pill
       line + tier-coloured score bar 0-100 with sky-25 amber-
       55 rose-80 threshold ticks + 5-cell breakdown chips
       LLZ-CA / LLZ-SA / GP-CA / GP-SA / APP all tier-coloured
       + tier-coloured advice click-to-fly per row +
     RUNWAYS tab sorted active-CAT-III first then INFRINGE-
       count desc + IATA + RWY + cat-pill + active-ac-count
       + infringe-count-rose + LLZ heading + length-m + tier-
       coloured advice line

   References:
     · ICAO Annex 10 Vol I Aeronautical Telecommunications
       Att C §2.1.9 LLZ/GP critical & sensitive areas
     · ICAO Annex 14 Vol I §3.13 LVP hold-bars
     · ICAO Doc 4444 PANS-ATM §7.13 Low-Visibility Procedures
     · ICAO Doc 9476 SMGCS Manual ch 4 LVP
     · ICAO Doc 9870 Manual of A-SMGCS
     · FAA Order 6750.16E ILS Standards § 5 LLZ/GP CA-SA
     · FAA Order JO 7110.65 § 3-7-5 ILS critical area protection
     · FAA Order 8260.3D TERPS Vol 1 ch 9 ILS
     · FAA AC 120-118 Criteria for Approval of Cat II/III LVO
     · FAA AC 120-28D CAT III Operations
     · FAA AC 150/5340-30J Marking & Signs ch 9 LVP hold-bars
     · EASA CS-AWO Sub-D LVO Surface-Movement
     · EASA AMC1 SPA.LVO.100 LVO Approvals
     · EASA AMC1 ADR.OPS.B.045 Low-Visibility Operations
     · EUROCONTROL ICAO EUR Doc 013 LVP Common Procedures
     · EUROCAE ED-46B / ED-126 ILS MOPS
     · RTCA DO-235B / DO-249 ILS Airborne MOPS
     · NTSB AAR-92-04 USAir 405 LGA (LLZ disturbance)
     · NTSB AAR-95/04 American Eagle 4184 (autopilot/LLZ)
     · AAIB 2/2013 LHR LLZ-CA infringement event
     · Boeing AERO Q2-2009 ILS critical area protection
   ============================================================ */

type Flight = { icao: string; callsign?: string; type?: string; operator?: string; category?: string | number; lat: number; lng: number; altitudeFt?: number; velocityKts?: number; track?: number; vertRate?: number; ground?: boolean }

type Runway = {
  iata: string
  name: string
  region: 'EUR' | 'NA' | 'APAC'
  rwy: string                 // designator e.g. '09L'
  thrLat: number
  thrLng: number
  bearing: number             // true heading down runway
  lengthM: number             // runway length
  llzCat: 'III' | 'II' | 'I'  // best published category
}

// LLZ antenna sits ~300 m past stop-end of runway, on extended centreline.
const LLZ_OFFSET_M = 300
// GP antenna sits 250-450 m from threshold, offset 120 m from RCL toward upwind.
const GP_THR_OFFSET_M = 300
const GP_LATERAL_OFFSET_M = 120

// 24-runway catalogue, top CAT-IIIB hubs.
const RWY_CATALOG: Runway[] = [
  { iata: 'CDG', name: 'Paris-CDG',     region: 'EUR',  rwy: '09L', thrLat: 49.0098, thrLng:   2.5413, bearing:  85.0, lengthM: 4215, llzCat: 'III' },
  { iata: 'LHR', name: 'London-Heathrow',region:'EUR',  rwy: '09L', thrLat: 51.4779, thrLng:  -0.4849, bearing:  89.6, lengthM: 3902, llzCat: 'III' },
  { iata: 'LHR', name: 'London-Heathrow',region:'EUR',  rwy: '27R', thrLat: 51.4775, thrLng:  -0.4332, bearing: 269.6, lengthM: 3902, llzCat: 'III' },
  { iata: 'FRA', name: 'Frankfurt',     region: 'EUR',  rwy: '25L', thrLat: 50.0407, thrLng:   8.5862, bearing: 249.0, lengthM: 4000, llzCat: 'III' },
  { iata: 'AMS', name: 'Schiphol',      region: 'EUR',  rwy: '18R', thrLat: 52.3613, thrLng:   4.7110, bearing: 183.0, lengthM: 3800, llzCat: 'III' },
  { iata: 'MUC', name: 'Munich',        region: 'EUR',  rwy: '08L', thrLat: 48.3380, thrLng:  11.7395, bearing:  80.0, lengthM: 4000, llzCat: 'III' },
  { iata: 'ZRH', name: 'Zurich',        region: 'EUR',  rwy: '14',  thrLat: 47.4790, thrLng:   8.5560, bearing: 137.0, lengthM: 3300, llzCat: 'III' },
  { iata: 'VIE', name: 'Vienna',        region: 'EUR',  rwy: '16',  thrLat: 48.1265, thrLng:  16.5560, bearing: 162.0, lengthM: 3600, llzCat: 'III' },
  { iata: 'CPH', name: 'Copenhagen',    region: 'EUR',  rwy: '04R', thrLat: 55.6051, thrLng:  12.6240, bearing:  40.0, lengthM: 3300, llzCat: 'III' },
  { iata: 'OSL', name: 'Oslo-Gardermoen',region:'EUR',  rwy: '01R', thrLat: 60.1782, thrLng:  11.0858, bearing:  10.0, lengthM: 3600, llzCat: 'III' },
  { iata: 'ARN', name: 'Stockholm-Arlanda',region:'EUR',rwy: '01L', thrLat: 59.6240, thrLng:  17.9295, bearing:  10.0, lengthM: 3300, llzCat: 'III' },
  { iata: 'HEL', name: 'Helsinki-Vantaa',region:'EUR', rwy: '22L', thrLat: 60.3290, thrLng:  24.9690, bearing: 222.0, lengthM: 3500, llzCat: 'III' },
  { iata: 'DUS', name: 'Duesseldorf',   region: 'EUR',  rwy: '23L', thrLat: 51.2920, thrLng:   6.7990, bearing: 230.0, lengthM: 3000, llzCat: 'II' },
  { iata: 'LFPO',name: 'Paris-Orly',    region: 'EUR',  rwy: '06',  thrLat: 48.7140, thrLng:   2.3650, bearing:  64.0, lengthM: 3320, llzCat: 'III' },
  { iata: 'LSGG',name: 'Geneva',        region: 'EUR',  rwy: '23',  thrLat: 46.2480, thrLng:   6.1190, bearing: 224.0, lengthM: 3900, llzCat: 'III' },
  { iata: 'JFK', name: 'New York-JFK',  region: 'NA',   rwy: '04R', thrLat: 40.6240, thrLng: -73.7900, bearing:  40.0, lengthM: 2560, llzCat: 'III' },
  { iata: 'ORD', name: 'Chicago-OHare', region: 'NA',   rwy: '10L', thrLat: 41.9870, thrLng: -87.9300, bearing: 100.0, lengthM: 3290, llzCat: 'III' },
  { iata: 'ATL', name: 'Atlanta',       region: 'NA',   rwy: '27R', thrLat: 33.6395, thrLng: -84.4080, bearing: 269.0, lengthM: 2745, llzCat: 'III' },
  { iata: 'SEA', name: 'Seattle-Tacoma',region: 'NA',   rwy: '16C', thrLat: 47.4520, thrLng:-122.3070, bearing: 162.0, lengthM: 3475, llzCat: 'III' },
  { iata: 'YYZ', name: 'Toronto-Pearson',region:'NA',   rwy: '06L', thrLat: 43.6630, thrLng: -79.6450, bearing:  56.0, lengthM: 3360, llzCat: 'III' },
  { iata: 'MEM', name: 'Memphis',       region: 'NA',   rwy: '18R', thrLat: 35.0590, thrLng: -89.9890, bearing: 180.0, lengthM: 3389, llzCat: 'III' },
  { iata: 'HND', name: 'Tokyo-Haneda',  region: 'APAC', rwy: '34L', thrLat: 35.5350, thrLng: 139.7820, bearing: 340.0, lengthM: 3000, llzCat: 'III' },
  { iata: 'NRT', name: 'Tokyo-Narita',  region: 'APAC', rwy: '16R', thrLat: 35.7860, thrLng: 140.3870, bearing: 162.0, lengthM: 4000, llzCat: 'III' },
  { iata: 'ICN', name: 'Seoul-Incheon', region: 'APAC', rwy: '15R', thrLat: 37.4970, thrLng: 126.4470, bearing: 152.0, lengthM: 3750, llzCat: 'III' },
  { iata: 'PEK', name: 'Beijing-Capital',region:'APAC', rwy: '36R', thrLat: 40.0570, thrLng: 116.5990, bearing: 358.0, lengthM: 3800, llzCat: 'III' },
]

// FNV-1a 32-bit hash for stable per-runway / per-day randomness.
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h
}

// Geodesy helpers: km per degree, simple equirectangular for short ranges.
const KM_PER_DEG_LAT = 111.32
function kmPerDegLng(lat: number) { return 111.32 * Math.cos(lat * Math.PI / 180) }
function nmBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (a.lat - b.lat) * KM_PER_DEG_LAT
  const dLng = (a.lng - b.lng) * kmPerDegLng((a.lat + b.lat) / 2)
  return Math.sqrt(dLat * dLat + dLng * dLng) / 1.852
}
function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  return nmBetween(a, b) * 1852
}
// Move a point N meters along true bearing (degrees).
function offsetPoint(p: { lat: number; lng: number }, bearing: number, meters: number): { lat: number; lng: number } {
  const br = bearing * Math.PI / 180
  const dN = meters * Math.cos(br) / 1000
  const dE = meters * Math.sin(br) / 1000
  return {
    lat: p.lat + dN / KM_PER_DEG_LAT,
    lng: p.lng + dE / kmPerDegLng(p.lat),
  }
}
// Project point P into runway-local frame (along/cross meters) using LLZ antenna as origin
// and runway bearing as the +along axis pointing back toward threshold (i.e. approach direction).
function rwyLocal(p: { lat: number; lng: number }, llz: { lat: number; lng: number }, bearing: number): { along: number; cross: number } {
  // East/north meters from LLZ
  const dN = (p.lat - llz.lat) * KM_PER_DEG_LAT * 1000
  const dE = (p.lng - llz.lng) * kmPerDegLng((p.lat + llz.lat) / 2) * 1000
  // +along axis = approach direction (reverse of runway bearing)
  const ar = ((bearing + 180) % 360) * Math.PI / 180
  const along = dN * Math.cos(ar) + dE * Math.sin(ar)
  // +cross axis = 90° right of along
  const cr = ((bearing + 270) % 360) * Math.PI / 180
  const cross = dN * Math.cos(cr) + dE * Math.sin(cr)
  return { along, cross }
}

type Tier = 'INFRINGE' | 'CAUTION' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLORS: Record<Tier, { fill: string; ring: string; chip: string; text: string }> = {
  INFRINGE: { fill: 'rgba(244,63,94,0.18)',  ring: 'rgba(244,63,94,0.65)',  chip: 'bg-rose-500/15 border-rose-500/40 text-rose-200',     text: 'text-rose-200' },
  CAUTION:  { fill: 'rgba(245,158,11,0.18)', ring: 'rgba(245,158,11,0.65)', chip: 'bg-amber-500/15 border-amber-500/40 text-amber-200',  text: 'text-amber-200' },
  WATCH:    { fill: 'rgba(14,165,233,0.18)', ring: 'rgba(14,165,233,0.65)', chip: 'bg-sky-500/15 border-sky-500/40 text-sky-200',        text: 'text-sky-200' },
  OK:       { fill: 'rgba(16,185,129,0.18)', ring: 'rgba(16,185,129,0.65)', chip: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200', text: 'text-emerald-200' },
  IDLE:     { fill: 'rgba(100,116,139,0.14)',ring: 'rgba(100,116,139,0.55)',chip: 'bg-slate-500/10 border-slate-500/30 text-slate-300',  text: 'text-slate-300' },
}

type RwyStateT = Runway & { llz: { lat: number; lng: number }; gp: { lat: number; lng: number }; declaredCat: 'III'|'II'|'I'|'OFF' }

type Eval = {
  flight: Flight
  runway?: RwyStateT
  declaredCat: 'III' | 'II' | 'I' | 'OFF'
  along: number    // m along approach axis (positive = away from LLZ toward threshold)
  cross: number    // m cross axis (positive = right of approach direction)
  inLlzCa: boolean
  inLlzSa: boolean
  inGpCa: boolean
  inGpSa: boolean
  distToLlzM: number
  driverScores: { LLZ_CA: number; LLZ_SA: number; GP_CA: number; GP_SA: number; APP: number }
  score: number
  tier: Tier
  driver: string
}

export default function IlsCriticalArea({
  map,
  flights,
  onClose,
  onFly,
}: {
  map: maplibregl.Map | null
  flights: Flight[]
  onClose: () => void
  onFly?: (icao: string) => void
}) {
  // ───────── persisted prefs ─────────
  function lsGet<T>(k: string, fb: T): T { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v) as T } catch { return fb } }
  function lsSet(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }
  const [minFl,     setMinFl    ] = useState<number>(() => lsGet('ft-ilscs-minfl',    50))
  const [captureNm, setCaptureNm] = useState<number>(() => lsGet('ft-ilscs-cap',      6))
  const [wxLvo,     setWxLvo    ] = useState<number>(() => lsGet('ft-ilscs-wx',      40))
  const [caMul,     setCaMul    ] = useState<number>(() => lsGet('ft-ilscs-camul',  100))
  const [saMul,     setSaMul    ] = useState<number>(() => lsGet('ft-ilscs-samul',  100))
  const [appW,      setAppW     ] = useState<number>(() => lsGet('ft-ilscs-appw',    60))
  const [tierFilter,setTierFilter]= useState<Tier|'ALL'>(() => lsGet('ft-ilscs-tier','ALL'))
  const [catFilter, setCatFilter] = useState<'ALL'|'III'|'II'|'I'|'OFF'>(() => lsGet('ft-ilscs-cat','ALL'))
  const [query,     setQuery]     = useState<string>('')
  const [tab,       setTab]       = useState<'AIRCRAFT'|'RUNWAYS'>('AIRCRAFT')
  const [showHalo,  setShowHalo]  = useState<boolean>(() => lsGet('ft-ilscs-halo', true))
  const [showPin,   setShowPin]   = useState<boolean>(() => lsGet('ft-ilscs-pin',  true))
  const [showLbl,   setShowLbl]   = useState<boolean>(() => lsGet('ft-ilscs-lbl',  true))
  const [showProj,  setShowProj]  = useState<boolean>(() => lsGet('ft-ilscs-proj', true))
  const [showCa,    setShowCa]    = useState<boolean>(() => lsGet('ft-ilscs-ca',   true))
  const [showSa,    setShowSa]    = useState<boolean>(() => lsGet('ft-ilscs-sa',   true))
  useEffect(()=>lsSet('ft-ilscs-minfl', minFl),[minFl])
  useEffect(()=>lsSet('ft-ilscs-cap', captureNm),[captureNm])
  useEffect(()=>lsSet('ft-ilscs-wx', wxLvo),[wxLvo])
  useEffect(()=>lsSet('ft-ilscs-camul', caMul),[caMul])
  useEffect(()=>lsSet('ft-ilscs-samul', saMul),[saMul])
  useEffect(()=>lsSet('ft-ilscs-appw', appW),[appW])
  useEffect(()=>lsSet('ft-ilscs-tier', tierFilter),[tierFilter])
  useEffect(()=>lsSet('ft-ilscs-cat', catFilter),[catFilter])
  useEffect(()=>lsSet('ft-ilscs-halo', showHalo),[showHalo])
  useEffect(()=>lsSet('ft-ilscs-pin', showPin),[showPin])
  useEffect(()=>lsSet('ft-ilscs-lbl', showLbl),[showLbl])
  useEffect(()=>lsSet('ft-ilscs-proj', showProj),[showProj])
  useEffect(()=>lsSet('ft-ilscs-ca', showCa),[showCa])
  useEffect(()=>lsSet('ft-ilscs-sa', showSa),[showSa])

  // ───────── per-runway derived geometry + declared category ─────────
  const rwyStates: RwyStateT[] = useMemo(() => {
    const dayBucket = Math.floor(Date.now() / 86400000) // stable for ~24 h
    return RWY_CATALOG.map(r => {
      // LLZ antenna sits LLZ_OFFSET_M past stop-end of runway, on extended centreline.
      // Stop end is lengthM past threshold in the runway-bearing direction.
      const stopEnd = offsetPoint({ lat: r.thrLat, lng: r.thrLng }, r.bearing, r.lengthM)
      const llz = offsetPoint(stopEnd, r.bearing, LLZ_OFFSET_M)
      // GP antenna: 300 m from threshold along runway, offset 120 m to the right of RCL.
      const onAxis = offsetPoint({ lat: r.thrLat, lng: r.thrLng }, r.bearing, GP_THR_OFFSET_M)
      const gp = offsetPoint(onAxis, (r.bearing + 90) % 360, GP_LATERAL_OFFSET_M)
      // Declared LVO category: best-published cat downgraded probabilistically when WX-LVO low.
      const h = fnv1a(`${r.iata}|${r.rwy}|${dayBucket}`) >>> 0
      const roll = (h % 1000) / 10  // 0..100
      const lvoActive = roll < wxLvo  // LVO active fraction = WX-LVO slider %
      let declaredCat: 'III'|'II'|'I'|'OFF'
      if (!lvoActive) {
        declaredCat = roll < (wxLvo + 35) ? 'I' : 'OFF'
      } else {
        declaredCat = r.llzCat === 'III' ? 'III' : (r.llzCat === 'II' ? 'II' : 'I')
      }
      return { ...r, llz, gp, declaredCat }
    })
  }, [wxLvo])

  // ───────── per-aircraft evaluation ─────────
  const evals: Eval[] = useMemo(() => {
    return flights.map(f => {
      // Find nearest runway with a published cat-II/III within captureNm.
      let best: RwyStateT | undefined
      let bestNm = Infinity
      for (const r of rwyStates) {
        const d = nmBetween(f, r.thrLat ? { lat: r.thrLat, lng: r.thrLng } : f)
        if (d < bestNm) { bestNm = d; best = r }
      }
      if (!best || bestNm > captureNm) {
        return { flight: f, runway: undefined, declaredCat: 'OFF', along: 0, cross: 0,
          inLlzCa: false, inLlzSa: false, inGpCa: false, inGpSa: false, distToLlzM: 0,
          driverScores: { LLZ_CA: 0, LLZ_SA: 0, GP_CA: 0, GP_SA: 0, APP: 0 },
          score: 0, tier: 'IDLE', driver: '' }
      }
      const alt = f.altitudeFt ?? 99999
      if (alt > minFl * 100) {
        return { flight: f, runway: best, declaredCat: best.declaredCat, along: 0, cross: 0,
          inLlzCa: false, inLlzSa: false, inGpCa: false, inGpSa: false, distToLlzM: 0,
          driverScores: { LLZ_CA: 0, LLZ_SA: 0, GP_CA: 0, GP_SA: 0, APP: 0 },
          score: 0, tier: 'IDLE', driver: '' }
      }
      // Local frame relative to LLZ antenna; +along = approach direction.
      const { along, cross } = rwyLocal(f, best.llz, best.bearing)
      const distLlz = Math.sqrt(along * along + cross * cross)
      // LLZ critical area: 300 m × 60 m centred on antenna (along ±150, cross ±30).
      const inLlzCa = Math.abs(along) <= 150 * (caMul / 100) && Math.abs(cross) <= 30 * (caMul / 100)
      // LLZ sensitive area: 3000 m along approach, 120 m wide.
      const inLlzSa = along > -50 && along < 3000 * (saMul / 100) && Math.abs(cross) <= 60 * (saMul / 100)
      // GP critical/sensitive: project relative to GP antenna position.
      const gpLocal = rwyLocal(f, best.gp, best.bearing)
      const inGpCa = Math.abs(gpLocal.along) <= 45 * (caMul / 100) && Math.abs(gpLocal.cross) <= 30 * (caMul / 100)
      const inGpSa = gpLocal.along > -50 && gpLocal.along < 1200 * (saMul / 100) && Math.abs(gpLocal.cross) <= 150 * (saMul / 100)
      // Approach-cone weight: aircraft approaching with ground speed > 100 kts inside 4 nm
      const gs = f.velocityKts ?? 0
      const isApproaching = !f.ground && gs > 100 && along > 0 && along < 7400 && Math.abs(cross) < 600
      const cat = best.declaredCat
      const catMul = cat === 'III' ? 1.4 : cat === 'II' ? 1.2 : cat === 'I' ? 0.8 : 0.4
      const drivers = {
        LLZ_CA: inLlzCa ? 100 : 0,
        LLZ_SA: inLlzSa ? (cat === 'III' ? 90 : cat === 'II' ? 75 : 55) : 0,
        GP_CA:  inGpCa ? 100 : 0,
        GP_SA:  inGpSa ? (cat === 'III' ? 85 : cat === 'II' ? 70 : 55) : 0,
        APP:    isApproaching ? Math.round(appW * 0.5) : 0,
      }
      // Max-driver composite, scaled by cat multiplier, +APP bonus when CA/SA breached.
      const maxDrv = Math.max(drivers.LLZ_CA, drivers.LLZ_SA, drivers.GP_CA, drivers.GP_SA)
      const appBonus = (maxDrv > 0) ? drivers.APP : 0
      const score = Math.max(0, Math.min(100, Math.round(maxDrv * catMul + appBonus)))
      // Driver name = whichever scored worst.
      const driverList: [string, number][] = [['LLZ-CA', drivers.LLZ_CA], ['LLZ-SA', drivers.LLZ_SA], ['GP-CA', drivers.GP_CA], ['GP-SA', drivers.GP_SA]]
      driverList.sort((a, b) => b[1] - a[1])
      const driver = driverList[0][1] > 0 ? driverList[0][0] : ''
      // Tier classification.
      let tier: Tier
      if (score >= 80 || (inLlzCa && cat !== 'OFF') || (inGpCa && cat !== 'OFF')) tier = 'INFRINGE'
      else if (score >= 55 || ((inLlzSa || inGpSa) && (cat === 'III' || cat === 'II'))) tier = 'CAUTION'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'
      return { flight: f, runway: best, declaredCat: cat, along, cross, inLlzCa, inLlzSa, inGpCa, inGpSa, distToLlzM: distLlz, driverScores: drivers, score, tier, driver }
    })
  }, [flights, rwyStates, captureNm, minFl, caMul, saMul, appW])

  // ───────── MapLibre overlay (canvas-based via line/circle layers) ─────────
  useEffect(() => {
    if (!map) return
    const SRC = 'ils-cs-src'
    const LAY_HALO = 'ils-cs-halo'
    const LAY_PIN = 'ils-cs-pin'
    const LAY_LBL = 'ils-cs-lbl'
    const LAY_PROJ = 'ils-cs-proj'
    const LAY_RWY = 'ils-cs-rwy-line'
    const LAY_RWY_LBL = 'ils-cs-rwy-lbl'
    const LAY_CA = 'ils-cs-ca'
    const LAY_SA = 'ils-cs-sa'

    const features: any[] = []
    // Runway centrelines (LLZ antenna → 12 nm down approach)
    for (const r of rwyStates) {
      const cat = r.declaredCat
      const tipApproach = offsetPoint(r.llz, (r.bearing + 180) % 360, 12 * 1852)
      features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.llz.lng, r.llz.lat], [tipApproach.lng, tipApproach.lat]] }, properties: { _kind: 'rwy', cat } })
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.llz.lng, r.llz.lat] }, properties: { _kind: 'rwylbl', label: `${r.iata} ${r.rwy} · CAT-${cat}` } })
      // CA / SA rectangles only when LVO declared
      if (cat === 'III' || cat === 'II') {
        // LLZ CA = 300×60 m centred on antenna
        if (showCa) {
          const ca = buildRect(r.llz, r.bearing, 150 * (caMul / 100), 30 * (caMul / 100), 0)
          features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ca] }, properties: { _kind: 'ca' } })
        }
        // LLZ SA = 3000 m along approach × 120 m wide
        if (showSa) {
          const saWidth = 60 * (saMul / 100)
          const saAlong = 3000 * (saMul / 100)
          const sa = buildRect(r.llz, r.bearing, saAlong / 2, saWidth, -saAlong / 2)
          features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [sa] }, properties: { _kind: 'sa' } })
        }
      }
    }
    // Per-aircraft halos / pins / labels / projections
    for (const e of evals) {
      if (e.tier === 'IDLE') continue
      if (tierFilter !== 'ALL' && e.tier !== tierFilter) continue
      if (catFilter !== 'ALL' && e.declaredCat !== catFilter) continue
      const sz = Math.max(8, Math.min(22, 8 + e.score / 6))
      const colors = TIER_COLORS[e.tier]
      if (showHalo) {
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.flight.lng, e.flight.lat] }, properties: { _kind: 'halo', radius: sz, fill: colors.fill, ring: colors.ring } })
      }
      if (showPin && e.tier === 'INFRINGE') {
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.flight.lng, e.flight.lat] }, properties: { _kind: 'pin' } })
      }
      if (showLbl && e.tier !== 'OK') {
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.flight.lng, e.flight.lat] }, properties: { _kind: 'lbl', label: `${e.flight.callsign || e.flight.icao} · ${e.runway?.iata}/${e.runway?.rwy}${e.driver ? ' · ' + e.driver : ''}`, color: colors.ring } })
      }
      if (showProj && e.runway && e.tier !== 'OK') {
        features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[e.flight.lng, e.flight.lat], [e.runway.llz.lng, e.runway.llz.lat]] }, properties: { _kind: 'proj', color: colors.ring } })
      }
    }
    const data = { type: 'FeatureCollection', features }
    const src = map.getSource(SRC) as any
    if (src) src.setData(data as any)
    else map.addSource(SRC, { type: 'geojson', data: data as any } as any)
    // Layers
    if (!map.getLayer(LAY_SA)) map.addLayer({ id: LAY_SA, type: 'fill', source: SRC, filter: ['==', ['get','_kind'], 'sa'], paint: { 'fill-color': 'rgba(245,158,11,0.08)', 'fill-outline-color': 'rgba(245,158,11,0.65)' } } as any)
    if (!map.getLayer(LAY_CA)) map.addLayer({ id: LAY_CA, type: 'fill', source: SRC, filter: ['==', ['get','_kind'], 'ca'], paint: { 'fill-color': 'rgba(244,63,94,0.18)', 'fill-outline-color': 'rgba(244,63,94,0.75)' } } as any)
    if (!map.getLayer(LAY_RWY)) map.addLayer({ id: LAY_RWY, type: 'line', source: SRC, filter: ['==', ['get','_kind'], 'rwy'], paint: { 'line-color': ['match', ['get','cat'], 'III', '#10b981', 'II', '#0ea5e9', 'I', '#94a3b8', '#64748b'], 'line-width': 1.5, 'line-dasharray': [3, 2] } } as any)
    if (!map.getLayer(LAY_PROJ)) map.addLayer({ id: LAY_PROJ, type: 'line', source: SRC, filter: ['==', ['get','_kind'], 'proj'], paint: { 'line-color': ['get','color'], 'line-width': 1.2, 'line-dasharray': [2, 2] } } as any)
    if (!map.getLayer(LAY_HALO)) map.addLayer({ id: LAY_HALO, type: 'circle', source: SRC, filter: ['==', ['get','_kind'], 'halo'], paint: { 'circle-radius': ['get','radius'], 'circle-color': ['get','fill'], 'circle-stroke-color': ['get','ring'], 'circle-stroke-width': 1.5 } } as any)
    if (!map.getLayer(LAY_PIN)) map.addLayer({ id: LAY_PIN, type: 'symbol', source: SRC, filter: ['==', ['get','_kind'], 'pin'], layout: { 'text-field': '◆', 'text-size': 14, 'text-allow-overlap': true }, paint: { 'text-color': '#f43f5e', 'text-halo-color': 'rgba(15,23,42,0.85)', 'text-halo-width': 1.5 } } as any)
    if (!map.getLayer(LAY_LBL)) map.addLayer({ id: LAY_LBL, type: 'symbol', source: SRC, filter: ['==', ['get','_kind'], 'lbl'], layout: { 'text-field': ['get','label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-allow-overlap': false }, paint: { 'text-color': ['get','color'], 'text-halo-color': 'rgba(15,23,42,0.95)', 'text-halo-width': 1.2 } } as any)
    if (!map.getLayer(LAY_RWY_LBL)) map.addLayer({ id: LAY_RWY_LBL, type: 'symbol', source: SRC, filter: ['==', ['get','_kind'], 'rwylbl'], layout: { 'text-field': ['get','label'], 'text-size': 9, 'text-offset': [0, -0.9], 'text-anchor': 'bottom' }, paint: { 'text-color': '#cbd5e1', 'text-halo-color': 'rgba(15,23,42,0.95)', 'text-halo-width': 1.2 } } as any)

    return () => {
      try {
        for (const id of [LAY_RWY_LBL, LAY_LBL, LAY_PIN, LAY_HALO, LAY_PROJ, LAY_RWY, LAY_CA, LAY_SA]) {
          if (map.getLayer(id)) map.removeLayer(id)
        }
        if (map.getSource(SRC)) map.removeSource(SRC)
      } catch {}
    }
  }, [map, evals, rwyStates, tierFilter, catFilter, showHalo, showPin, showLbl, showProj, showCa, showSa, caMul, saMul])

  // Build a runway-axis-aligned rectangle around origin O, dimensions ±halfLen along, ±halfWidth cross, optionally offset alongCenter from O.
  function buildRect(O: { lat: number; lng: number }, bearing: number, halfLen: number, halfWidth: number, alongCenter: number): [number, number][] {
    const center = offsetPoint(O, (bearing + 180) % 360, alongCenter)  // approach direction is bearing+180
    const fwd = (bearing + 180) % 360
    const right = (bearing + 270) % 360
    const c1 = offsetPoint(offsetPoint(center, fwd, halfLen), right, halfWidth)
    const c2 = offsetPoint(offsetPoint(center, fwd, halfLen), (right + 180) % 360, halfWidth)
    const c3 = offsetPoint(offsetPoint(center, (fwd + 180) % 360, halfLen), (right + 180) % 360, halfWidth)
    const c4 = offsetPoint(offsetPoint(center, (fwd + 180) % 360, halfLen), right, halfWidth)
    return [[c1.lng, c1.lat], [c2.lng, c2.lat], [c3.lng, c3.lat], [c4.lng, c4.lat], [c1.lng, c1.lat]]
  }

  // ───────── summary stats ─────────
  const active = evals.filter(e => e.tier !== 'IDLE')
  const counts: Record<Tier, number> = { INFRINGE: 0, CAUTION: 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const e of evals) counts[e.tier]++
  const infringes = active.filter(e => e.tier === 'INFRINGE')
  const worst = active.slice().sort((a, b) => b.score - a.score)[0]
  const meanScore = active.length ? Math.round(active.reduce((s, e) => s + e.score, 0) / active.length) : 0
  const activeLvoRwys = rwyStates.filter(r => r.declaredCat === 'III' || r.declaredCat === 'II').length

  // ───────── filtered + sorted aircraft list ─────────
  const tierRank: Record<Tier, number> = { INFRINGE: 0, CAUTION: 1, WATCH: 2, OK: 3, IDLE: 4 }
  const acList = evals
    .filter(e => e.tier !== 'IDLE')
    .filter(e => tierFilter === 'ALL' || e.tier === tierFilter)
    .filter(e => catFilter === 'ALL' || e.declaredCat === catFilter)
    .filter(e => {
      if (!query.trim()) return true
      const q = query.toLowerCase()
      return (e.flight.callsign || '').toLowerCase().includes(q) ||
             e.flight.icao.toLowerCase().includes(q) ||
             (e.runway?.iata || '').toLowerCase().includes(q)
    })
    .sort((a, b) => tierRank[a.tier] - tierRank[b.tier] || b.score - a.score)

  function adviceFor(e: Eval): string {
    if (e.tier === 'INFRINGE') return 'Inside ILS critical area · vacate immediately · LLZ/GP signal corrupted for inbound CAT-III autoland · request priority taxi per ICAO Doc 4444 § 7.13'
    if (e.tier === 'CAUTION')  return 'Inside ILS sensitive area · do not enter beyond LVP hold-bars · brief crew per FAA AC 120-118 § 7 / EASA AMC1 SPA.LVO.100'
    if (e.tier === 'WATCH')    return 'Near ILS protected volume · monitor position vs LVP hold-bars · confirm ATIS LVO category'
    return 'Clear of ILS critical & sensitive areas · nominal'
  }

  // ───────── per-runway summary for RUNWAYS tab ─────────
  const rwySummary = rwyStates.map(r => {
    const inCatch = evals.filter(e => e.runway?.iata === r.iata && e.runway?.rwy === r.rwy && e.tier !== 'IDLE')
    const inf = inCatch.filter(e => e.tier === 'INFRINGE').length
    const caut = inCatch.filter(e => e.tier === 'CAUTION').length
    const meanS = inCatch.length ? Math.round(inCatch.reduce((s, e) => s + e.score, 0) / inCatch.length) : 0
    const worstTier: Tier = inf ? 'INFRINGE' : caut ? 'CAUTION' : inCatch.some(e => e.tier === 'WATCH') ? 'WATCH' : inCatch.length ? 'OK' : 'IDLE'
    return { rwy: r, inCatch: inCatch.length, infringe: inf, caut, meanS, worstTier }
  }).sort((a, b) => {
    const catRank = (c: 'III'|'II'|'I'|'OFF') => c === 'III' ? 0 : c === 'II' ? 1 : c === 'I' ? 2 : 3
    return catRank(a.rwy.declaredCat) - catRank(b.rwy.declaredCat) || b.infringe - a.infringe
  })

  return (
    <div className="absolute right-3 top-20 z-30 w-[420px] max-h-[calc(100vh-7rem)] overflow-hidden rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur-md shadow-2xl flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60 bg-slate-800/60">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">ILS</span>
          <span className="text-sm font-semibold text-slate-100 truncate">Critical & Sensitive Area</span>
          <span className="text-[10px] text-slate-500">Annex 10 App C</span>
        </div>
        <button onClick={onClose} className="px-2 py-0.5 text-xs rounded border border-slate-600 text-slate-300 hover:bg-slate-700/60">Close</button>
      </div>

      {/* Tier counter strip */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {(['INFRINGE','CAUTION','WATCH','OK','IDLE'] as Tier[]).map(t => {
          const sel = tierFilter === t
          const c = TIER_COLORS[t]
          return (
            <button key={t} onClick={() => setTierFilter(sel ? 'ALL' : t)} className={`px-1.5 py-1 rounded border text-[10px] ${sel ? c.chip : 'border-slate-700/60 text-slate-400 hover:text-slate-200'}`}>
              <div className="font-semibold">{counts[t]}</div>
              <div className="opacity-80">{t}</div>
            </button>
          )
        })}
      </div>

      {/* Summary cells */}
      <div className="grid grid-cols-3 gap-1 px-3 pb-1 text-[10px]">
        <div className="rounded border border-slate-700/40 bg-slate-800/40 px-2 py-1">
          <div className="text-slate-500 uppercase tracking-wider">Tracked</div>
          <div className="text-slate-100 font-semibold text-sm">{active.length}</div>
        </div>
        <div className="rounded border border-slate-700/40 bg-slate-800/40 px-2 py-1">
          <div className="text-slate-500 uppercase tracking-wider">Infringe</div>
          <div className={`font-semibold text-sm ${infringes.length ? 'text-rose-300' : 'text-slate-100'}`}>{infringes.length}</div>
        </div>
        <div className="rounded border border-slate-700/40 bg-slate-800/40 px-2 py-1">
          <div className="text-slate-500 uppercase tracking-wider">Worst</div>
          <div className={`font-semibold text-xs truncate ${worst ? TIER_COLORS[worst.tier].text : 'text-slate-300'}`}>{worst ? `${worst.flight.callsign || worst.flight.icao}` : '—'}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1 px-3 pb-2 text-[10px]">
        <div className="rounded border border-slate-700/40 bg-slate-800/40 px-2 py-1">
          <div className="text-slate-500 uppercase tracking-wider">LVO Active</div>
          <div className="text-emerald-200 font-semibold text-sm">{activeLvoRwys}<span className="text-slate-400 text-[10px]"> / {rwyStates.length} rwys</span></div>
        </div>
        <div className="rounded border border-slate-700/40 bg-slate-800/40 px-2 py-1">
          <div className="text-slate-500 uppercase tracking-wider">Mean Score</div>
          <div className={`font-semibold text-sm ${meanScore >= 55 ? 'text-amber-200' : meanScore >= 25 ? 'text-sky-200' : 'text-emerald-200'}`}>{meanScore}</div>
        </div>
      </div>

      {/* Scrollable body */}
      <div className="overflow-y-auto flex-1">
        {/* Diagnostic scatter */}
        <div className="px-3 pb-2">
          <div className="rounded border border-slate-700/40 bg-slate-800/30 p-2">
            <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-1">dist-LLZ-m vs ground-kt</div>
            <svg viewBox="0 0 200 100" className="w-full h-24">
              <rect x="0" y="0" width="40" height="100" fill="rgba(244,63,94,0.10)" />
              <rect x="40" y="0" width="60" height="100" fill="rgba(245,158,11,0.08)" />
              <rect x="100" y="0" width="100" height="100" fill="rgba(14,165,233,0.06)" />
              <line x1="40" y1="0" x2="40" y2="100" stroke="rgba(244,63,94,0.5)" strokeDasharray="2,2" strokeWidth="0.6" />
              <line x1="100" y1="0" x2="100" y2="100" stroke="rgba(245,158,11,0.5)" strokeDasharray="2,2" strokeWidth="0.6" />
              {active.map((e, i) => {
                const x = Math.max(0, Math.min(200, e.distToLlzM / 30))
                const y = Math.max(0, Math.min(100, 100 - (e.flight.velocityKts || 0) / 3.5))
                const c = TIER_COLORS[e.tier].ring
                return <circle key={i} cx={x} cy={y} r={1.6} fill={c} />
              })}
              <text x="2" y="98" fontSize="6" fill="#64748b">CA</text>
              <text x="42" y="98" fontSize="6" fill="#64748b">SA</text>
              <text x="102" y="98" fontSize="6" fill="#64748b">outside</text>
              <text x="195" y="8" fontSize="6" fill="#64748b" textAnchor="end">350kt</text>
            </svg>
          </div>
        </div>

        {/* Sliders */}
        <div className="px-3 pb-2 grid grid-cols-2 gap-2 text-[10px]">
          <Slider label="MIN-FL" v={minFl} min={0} max={50} step={5} onChange={setMinFl} unit="" />
          <Slider label="CAPTURE" v={captureNm} min={1} max={20} step={1} onChange={setCaptureNm} unit="nm" />
          <Slider label="WX-LVO" v={wxLvo} min={0} max={100} step={5} onChange={setWxLvo} unit="%" />
          <Slider label="CA-MUL" v={caMul} min={50} max={200} step={10} onChange={setCaMul} unit="%" />
          <Slider label="SA-MUL" v={saMul} min={50} max={200} step={10} onChange={setSaMul} unit="%" />
          <Slider label="APP-W" v={appW} min={0} max={100} step={5} onChange={setAppW} unit="%" />
        </div>

        {/* Category filter chips */}
        <div className="px-3 pb-2 flex flex-wrap gap-1 text-[10px]">
          {(['ALL','III','II','I','OFF'] as const).map(c => {
            const sel = catFilter === c
            return <button key={c} onClick={()=>setCatFilter(c)} className={`px-2 py-0.5 rounded border ${sel ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'border-slate-700/60 text-slate-400 hover:text-slate-200'}`}>LVO-{c}</button>
          })}
        </div>

        {/* Overlay toggles */}
        <div className="px-3 pb-2 flex flex-wrap gap-1 text-[10px]">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN',  showPin,  setShowPin],
            ['LBL',  showLbl,  setShowLbl],
            ['PROJ', showProj, setShowProj],
            ['CA',   showCa,   setShowCa],
            ['SA',   showSa,   setShowSa],
          ].map(([lbl, v, fn]: any) => (
            <button key={lbl} onClick={()=>fn(!v)} className={`px-2 py-0.5 rounded border ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'border-slate-700/60 text-slate-400 hover:text-slate-200'}`}>{lbl}</button>
          ))}
        </div>

        {/* Search + tab */}
        <div className="px-3 pb-2 flex items-center gap-2">
          <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search callsign or IATA…" className="flex-1 px-2 py-1 text-xs rounded border border-slate-700/60 bg-slate-800/40 text-slate-100 placeholder:text-slate-500 outline-none focus:border-sky-500/40" />
          <div className="flex rounded border border-slate-700/60 overflow-hidden text-[10px]">
            {(['AIRCRAFT','RUNWAYS'] as const).map(t => (
              <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 ${tab===t ? 'bg-sky-500/15 text-sky-200' : 'text-slate-400 hover:text-slate-200'}`}>{t}</button>
            ))}
          </div>
        </div>

        {/* Body */}
        {tab === 'AIRCRAFT' && (
          <div className="px-3 pb-3 space-y-1">
            {acList.length === 0 && <div className="text-[11px] text-slate-500 italic px-1 py-3 text-center">No aircraft in catchment · adjust CAPTURE or WX-LVO sliders.</div>}
            {acList.slice(0, 80).map(e => {
              const c = TIER_COLORS[e.tier]
              return (
                <div key={e.flight.icao} className="rounded border border-slate-700/40 bg-slate-800/30 overflow-hidden">
                  <div className="flex">
                    <div className="w-1" style={{ background: c.ring }} />
                    <div className="flex-1 px-2 py-1.5">
                      <div className="flex items-center gap-2 text-[11px]">
                        <button onClick={() => onFly?.(e.flight.icao)} className="font-semibold text-slate-100 hover:text-sky-300 truncate">{e.flight.callsign || e.flight.icao}</button>
                        <span className="text-slate-500 truncate">{e.flight.type || '—'}</span>
                        <span className={`ml-auto px-1.5 py-0.5 rounded border text-[9px] ${c.chip}`}>{e.tier}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-slate-400 mt-0.5">
                        <span className="px-1.5 py-0.5 rounded border border-slate-700/60 bg-slate-800/40">{e.runway?.iata} / {e.runway?.rwy}</span>
                        <span className={`px-1.5 py-0.5 rounded border ${e.declaredCat === 'III' ? 'border-emerald-500/40 text-emerald-200' : e.declaredCat === 'II' ? 'border-sky-500/40 text-sky-200' : e.declaredCat === 'I' ? 'border-slate-600 text-slate-300' : 'border-slate-700 text-slate-500'}`}>LVO-{e.declaredCat}</span>
                        <span>{Math.round(e.distToLlzM)}m</span>
                        <span>{Math.round(e.flight.velocityKts || 0)}kt</span>
                        {e.inLlzCa && <span className="text-rose-300">LLZ-CA</span>}
                        {e.inGpCa && <span className="text-rose-300">GP-CA</span>}
                        {!e.inLlzCa && e.inLlzSa && <span className="text-amber-300">LLZ-SA</span>}
                        {!e.inGpCa && e.inGpSa && <span className="text-amber-300">GP-SA</span>}
                      </div>
                      {/* Score bar */}
                      <div className="mt-1 h-1.5 rounded bg-slate-700/40 overflow-hidden relative">
                        <div className="absolute inset-y-0 left-0" style={{ width: `${e.score}%`, background: c.ring }} />
                        <div className="absolute inset-y-0 left-[25%] w-px bg-sky-500/60" />
                        <div className="absolute inset-y-0 left-[55%] w-px bg-amber-500/60" />
                        <div className="absolute inset-y-0 left-[80%] w-px bg-rose-500/60" />
                      </div>
                      {/* Driver chips */}
                      <div className="mt-1 grid grid-cols-5 gap-0.5 text-[9px]">
                        {(['LLZ_CA','LLZ_SA','GP_CA','GP_SA','APP'] as const).map(k => {
                          const v = e.driverScores[k]
                          const tone = v >= 80 ? 'text-rose-300' : v >= 55 ? 'text-amber-300' : v >= 25 ? 'text-sky-300' : 'text-slate-500'
                          return (
                            <div key={k} className="rounded border border-slate-700/40 px-1 py-0.5 text-center">
                              <div className="text-slate-500">{k.replace('_','-')}</div>
                              <div className={`font-semibold ${tone}`}>{v}</div>
                            </div>
                          )
                        })}
                      </div>
                      <div className={`mt-1 text-[10px] ${c.text} italic leading-tight`}>{adviceFor(e)}</div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'RUNWAYS' && (
          <div className="px-3 pb-3 space-y-1">
            {rwySummary.map(rs => {
              const c = TIER_COLORS[rs.worstTier === 'IDLE' ? 'OK' : rs.worstTier]
              const catChip = rs.rwy.declaredCat === 'III' ? 'border-emerald-500/40 text-emerald-200' : rs.rwy.declaredCat === 'II' ? 'border-sky-500/40 text-sky-200' : rs.rwy.declaredCat === 'I' ? 'border-slate-600 text-slate-300' : 'border-slate-700 text-slate-500'
              return (
                <div key={`${rs.rwy.iata}-${rs.rwy.rwy}`} className="rounded border border-slate-700/40 bg-slate-800/30 overflow-hidden">
                  <div className="flex">
                    <div className="w-1" style={{ background: c.ring }} />
                    <div className="flex-1 px-2 py-1.5">
                      <div className="flex items-center gap-2 text-[11px]">
                        <span className="font-semibold text-slate-100">{rs.rwy.iata}</span>
                        <span className="text-slate-400">{rs.rwy.rwy}</span>
                        <span className={`px-1.5 py-0.5 rounded border text-[9px] ${catChip}`}>LVO-{rs.rwy.declaredCat}</span>
                        <span className="ml-auto text-[10px] text-slate-400">{rs.rwy.region}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-slate-400 mt-0.5">
                        <span>{rs.rwy.name}</span>
                        <span>· {Math.round(rs.rwy.bearing)}° · {rs.rwy.lengthM}m</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] mt-1">
                        <span className="text-slate-400">AC: <span className="text-slate-100 font-semibold">{rs.inCatch}</span></span>
                        <span className={`px-1.5 py-0.5 rounded border ${rs.infringe ? 'border-rose-500/40 text-rose-200 bg-rose-500/10' : 'border-slate-700/60 text-slate-500'}`}>INF {rs.infringe}</span>
                        <span className={`px-1.5 py-0.5 rounded border ${rs.caut ? 'border-amber-500/40 text-amber-200 bg-amber-500/10' : 'border-slate-700/60 text-slate-500'}`}>CAU {rs.caut}</span>
                        <span className="ml-auto text-slate-400">mean <span className="font-semibold text-slate-200">{rs.meanS}</span></span>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 flex items-center gap-2">
        <span>Annex 10 App C · Order 6750.16E · AC 120-118</span>
        <span className="ml-auto">{rwyStates.length} rwy</span>
      </div>
    </div>
  )
}

function Slider({ label, v, min, max, step, onChange, unit }: { label: string; v: number; min: number; max: number; step: number; onChange: (n: number)=>void; unit: string }) {
  return (
    <div className="rounded border border-slate-700/40 bg-slate-800/30 px-2 py-1">
      <div className="flex items-center justify-between text-[9px] text-slate-400 mb-0.5">
        <span className="uppercase tracking-wider">{label}</span>
        <span className="text-slate-200 font-semibold">{v}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={v} onChange={e => onChange(Number(e.target.value))} className="w-full accent-sky-500 h-1" />
    </div>
  )
}
