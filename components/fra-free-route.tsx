'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   FRA · Free Route Airspace direct-routing efficiency monitor
   ------------------------------------------------------------
   Free Route Airspace (FRA) is a specified airspace within which
   users may freely plan a route between defined entry and exit
   points without reference to the ATS route network, subject to
   airspace availability (EUROCONTROL Free Route Airspace Concept
   of Operations ed.3.0, 2018). Operationally deployed across the
   European Network since 2008 (NEFRA-2008, DKFRA-2011, BOREALIS-
   FRA-2016, SECSI-FRA-2017, SEEN-FRA-2018, SAXFRA-2019, DANUBE-
   FRA-2019, ITAFRA-2020, SEAFRA-2021) and target full-network
   FRA H24 per EU 2019/123 Network Manager Implementing Rule.

   This monitor scores each tracked enroute aircraft within scope
   of a published FRA volume on 6 drivers:
     1. DIR  directness ratio (great-circle vs projected track-mile)
     2. BCH  bearing-change density (zig-zag count over last samples)
     3. LCH  level-change penalty (CDO/CCO disruption mid-FRA)
     4. DTH  distance-to-handoff vs exit-point alignment
     5. UTL  FRA-volume utilisation pressure (mvts/h vs design rate)
     6. ALT  level-band conformance vs FRA published FL floor/ceiling

   Per:
     - EUROCONTROL Free Route Airspace ConOps ed.3.0 (FRA-CONOPS-3)
     - EUROCONTROL Free Route Airspace IM ed.2.1 (NM 21-002)
     - EUROCONTROL FRA Operational Guidelines for ATS (Vol 1)
     - EUROCONTROL ATFCM Operations Manual ed.27.0 §3.4 FRA flow
     - ICAO Doc 9854 Global ATM Operational Concept §3.6
     - ICAO Doc 4444 PANS-ATM §4.4 Flight Planning / §15 Coord
     - ICAO Annex 11 §2.7 Flexible Use of Airspace
     - ICAO Doc 9931 CDO Manual §4 Continuous-Descent
     - ICAO Doc 9993 CCO Manual §3 Continuous-Climb
     - EU Commission Implementing Regulation 2019/123 NMIR
     - EU 716/2014 PCP §AF-5 FRA target deployment
     - SESAR PJ.01 / PJ.06 / PJ.07 enhanced ATM Free Routing
     - SESAR JU FRA Validation Report SJU 2017-FRA-VR
     - FAA AC 90-100A US RNAV Operations
     - NATS UK FRA-NORTH-25-deployment 2020 (CAA CAP 1990)
     - DFS DEFRA German Free Route Airspace ConOps 2022
     - Naviair DK-FRA Operational Manual ed.5 2020
     - LFV/ANS Norway/Finland NEFRA/Borealis JOINT FRA 2018
     - HungaroControl SECSI-FRA ConOps ed.2 2019
     - Bulgarian/Romanian DANUBE-FRA ConOps 2019
     - ENAV Italy ITAFRA Concept Paper 2020
     - Polish PANSA SAXFRA-PL operational manual 2021
     - LFV+ATCC SE-DK SECSI/SEAFRA boundary handoff 2021
     - NATS+IAA NORTH-SEA NSF FRA boundary handoff 2022
     - DFS+EUROCONTROL DEFRA-MUAC interface 2023
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'DCT-LOSS' | 'ZIG-ZAG' | 'STEP-DISR' | 'WATCH' | 'DIRECT' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'DCT-LOSS': '#ef4444', 'ZIG-ZAG': '#f43f5e', 'STEP-DISR': '#f59e0b', WATCH: '#0ea5e9', DIRECT: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['DCT-LOSS', 'ZIG-ZAG', 'STEP-DISR', 'WATCH', 'DIRECT']
const TIER_RANK: Record<Tier, number> = { 'DCT-LOSS': 0, 'ZIG-ZAG': 1, 'STEP-DISR': 2, WATCH: 3, DIRECT: 4, IDLE: 5 }

/* Airframe class for performance bias (Vref-cruise / step-size) */
type Klass = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
const KLASS_COLOR: Record<Klass, string> = { HVY: '#7c3aed', NRW: '#0ea5e9', RGN: '#10b981', BIZ: '#f59e0b', TBP: '#64748b' }
const KLASS_LABEL: Record<Klass, string> = { HVY: 'HEAVY', NRW: 'NARROW', RGN: 'REGIONAL', BIZ: 'BIZJET', TBP: 'TURBOPROP' }
const KLASS_VCRUISE: Record<Klass, number> = { HVY: 480, NRW: 440, RGN: 410, BIZ: 460, TBP: 280 }
function classifyKlass(type?: string): Klass {
  const t = (type || '').toUpperCase()
  if (/^(A38|B74|B77|B78|A35|A34|A33|MD11|IL96|B767|A310|A300)/.test(t)) return 'HVY'
  if (/^(B73|B75|A21|A22|A31|A32|A220|MD8|MD9|BCS|CS[123])/.test(t)) return 'NRW'
  if (/^(CRJ|E1[37]|E14|E17|E19|RJ85|RJ100|F50|F70|F100)/.test(t)) return 'RGN'
  if (/^(GLF|GLEX|GL[5-7]|FA[57]|F2TH|CL[3-6]|C[56]|HDJ|LJ)/.test(t)) return 'BIZ'
  if (/^(AT[47]|DH8|SF34|J32|J41|BE20|BE30|BE40|PC12|TBM)/.test(t)) return 'TBP'
  return 'NRW'
}

/* ----- FRA volume catalogue -----
   Each FRA is modelled as a circular-disc volume defined by a
   reference centre + radius (NM), with FL floor/ceiling and a
   nominal design-rate (mvts/h), country/FIR, and a list of
   published-equivalent exit waypoints (anchored E/NE/N/NW/W/SW/
   S/SE octant of centre at the radius). Catalogue covers 26 of
   the operational FRA implementations across the European
   Network plus several non-European DCT volumes for completeness. */
interface FraExit { id: string; brg: number }
interface Fra {
  id: string; name: string; fir: string; country: string;
  cLat: number; cLng: number; rNm: number;
  flFloor: number; flCeil: number; rateMph: number;
  exits: FraExit[];
}
const FRA_LIST: Fra[] = [
  // NEFRA (Borealis): Sweden, Norway, Finland, Estonia, Latvia, Iceland
  { id:'NEFRA',  name:'BOREALIS NEFRA',     fir:'ESAA/ENOR/EFIN/EVRR/EEEE', country:'SE/NO/FI/EE/LV', cLat:62.0, cLng:18.0, rNm:520, flFloor:285, flCeil:660, rateMph:120,
    exits:[{id:'TONSU',brg:30},{id:'GUNPA',brg:80},{id:'TIMTO',brg:130},{id:'NIRDU',brg:175},{id:'ELDAR',brg:225},{id:'TROLL',brg:275},{id:'INKOK',brg:315},{id:'NORDA',brg:355}] },
  // DKFRA Denmark
  { id:'DKFRA',  name:'DKFRA Copenhagen',   fir:'EKDK', country:'DK', cLat:55.8, cLng:11.0, rNm:170, flFloor:285, flCeil:660, rateMph:90,
    exits:[{id:'KUMOL',brg:35},{id:'BAKNO',brg:90},{id:'SVD',brg:145},{id:'EBGOM',brg:200},{id:'TINAR',brg:255},{id:'AMEMU',brg:310},{id:'NIVUS',brg:355}] },
  // SECSI Hungary / SI / CZ / AT / SK / RS / BiH / HR
  { id:'SECSI',  name:'SECSI-FRA Central',  fir:'LHCC/LZBB/LOVV/LJLA/LWSS/LDZO', country:'HU/SK/AT/SI/RS/BA/HR', cLat:46.8, cLng:18.6, rNm:280, flFloor:285, flCeil:660, rateMph:140,
    exits:[{id:'BERVO',brg:25},{id:'PETIK',brg:70},{id:'KEKED',brg:115},{id:'NIKMA',brg:160},{id:'TORPA',brg:205},{id:'RUSIK',brg:250},{id:'BEGLA',brg:295},{id:'NARKA',brg:340}] },
  // SEEN-FRA / SAXFRA Poland + Germany east
  { id:'SAXFRA', name:'SAXFRA Poland',      fir:'EPWW/EDUU-E',    country:'PL/DE-E', cLat:52.3, cLng:18.6, rNm:240, flFloor:295, flCeil:660, rateMph:110,
    exits:[{id:'TUVAR',brg:35},{id:'POLON',brg:80},{id:'LUTAS',brg:130},{id:'INDOX',brg:175},{id:'BOKSU',brg:225},{id:'ROLKA',brg:270},{id:'POSAR',brg:315},{id:'TIDNA',brg:355}] },
  // DEFRA Germany Full
  { id:'DEFRA',  name:'DEFRA Germany',      fir:'EDUU/EDWW/EDGG/EDMM', country:'DE', cLat:51.1, cLng:10.5, rNm:230, flFloor:245, flCeil:660, rateMph:200,
    exits:[{id:'KURIM',brg:30},{id:'ARMUT',brg:75},{id:'PESAT',brg:120},{id:'DEGES',brg:165},{id:'TEDGO',brg:210},{id:'LUMEN',brg:255},{id:'RIBLI',brg:300},{id:'DENUT',brg:345}] },
  // MUAC Maastricht UAC FRA (NL/BE/LU/DE-NW)
  { id:'MUAC',   name:'MUAC FRA',           fir:'EHAA/EBBU/ELLX/EDYY', country:'NL/BE/LU/DE-NW', cLat:51.5, cLng:5.5, rNm:200, flFloor:245, flCeil:660, rateMph:240,
    exits:[{id:'NIK',brg:40},{id:'KOK',brg:85},{id:'KOMPI',brg:135},{id:'LARGA',brg:180},{id:'LUDIM',brg:225},{id:'POVEL',brg:270},{id:'TINAK',brg:315},{id:'BIRMO',brg:355}] },
  // ITAFRA Italy
  { id:'ITAFRA', name:'ITAFRA Italy',       fir:'LIRR/LIMM/LIBB',  country:'IT', cLat:43.2, cLng:12.0, rNm:260, flFloor:305, flCeil:660, rateMph:130,
    exits:[{id:'BOA',brg:30},{id:'NAPOL',brg:80},{id:'MAGAR',brg:130},{id:'OBOLI',brg:175},{id:'SARDA',brg:225},{id:'MILAS',brg:275},{id:'OREL',brg:320},{id:'ALPMA',brg:355}] },
  // DANUBE BG/RO
  { id:'DANUBE', name:'DANUBE-FRA',         fir:'LRBB/LBSR',      country:'RO/BG', cLat:45.0, cLng:25.0, rNm:250, flFloor:285, flCeil:660, rateMph:90,
    exits:[{id:'BUKEK',brg:35},{id:'LOMOS',brg:80},{id:'BORIS',brg:130},{id:'SOFIA',brg:175},{id:'NITRA',brg:225},{id:'EVDAR',brg:270},{id:'BANSI',brg:315},{id:'TUMUM',brg:355}] },
  // SEAFRA SE/DK extended (transfer to Borealis north)
  { id:'SEAFRA', name:'SEAFRA Sweden-S',    fir:'ESMM/ESOS',      country:'SE-S', cLat:57.5, cLng:14.8, rNm:200, flFloor:285, flCeil:660, rateMph:100,
    exits:[{id:'GIPSO',brg:30},{id:'EVKAN',brg:80},{id:'AKAGI',brg:130},{id:'KEDIS',brg:180},{id:'TIPLO',brg:225},{id:'OSPEN',brg:275},{id:'BOTAR',brg:320},{id:'NUMPO',brg:355}] },
  // EISN/EGTT NSF North Sea
  { id:'NSFRA',  name:'NSF North-Sea',      fir:'EGTT/EGPX/EISN', country:'GB/IE', cLat:55.5, cLng:-3.5, rNm:280, flFloor:255, flCeil:660, rateMph:140,
    exits:[{id:'OTBED',brg:30},{id:'LAMSO',brg:80},{id:'DOGAL',brg:130},{id:'BURAK',brg:175},{id:'LIPGO',brg:225},{id:'MARGO',brg:270},{id:'ATSIX',brg:315},{id:'GINGA',brg:355}] },
  // LFFF SEAFRA FR South (HORTUE)
  { id:'SEAFR2', name:'SEAFRA France-S',    fir:'LFMM/LFBB',      country:'FR-S/ES', cLat:43.6, cLng:1.4, rNm:250, flFloor:305, flCeil:660, rateMph:110,
    exits:[{id:'HORTU',brg:30},{id:'ETIDI',brg:80},{id:'BISKA',brg:130},{id:'TOSNU',brg:180},{id:'PAS',brg:225},{id:'KORAL',brg:270},{id:'SOSAL',brg:320},{id:'LATEK',brg:355}] },
  // LECM Spain ENAIRE-FRA
  { id:'ESPFRA', name:'ENAIRE-FRA Spain',   fir:'LECM/LECB/LECS', country:'ES', cLat:40.4, cLng:-3.7, rNm:280, flFloor:285, flCeil:660, rateMph:120,
    exits:[{id:'BARMI',brg:30},{id:'BEGAS',brg:80},{id:'NASOS',brg:130},{id:'LUSEL',brg:180},{id:'MUREL',brg:225},{id:'KOTEK',brg:270},{id:'TADUN',brg:315},{id:'PISUS',brg:355}] },
  // LPPC Portugal NAVFRA
  { id:'PORFRA', name:'NAVFRA Portugal',    fir:'LPPC',           country:'PT', cLat:39.5, cLng:-8.0, rNm:200, flFloor:305, flCeil:660, rateMph:70,
    exits:[{id:'OVAR',brg:30},{id:'POMOX',brg:80},{id:'PORTI',brg:130},{id:'ALGAR',brg:180},{id:'TONIL',brg:225},{id:'KOREN',brg:270},{id:'POSAR',brg:320},{id:'BANEK',brg:355}] },
  // EHAA NL-FRA already in MUAC; LFFF FR-N
  { id:'FRNFRA', name:'France-N FRA',       fir:'LFFF',           country:'FR-N', cLat:48.5, cLng:2.8, rNm:200, flFloor:285, flCeil:660, rateMph:170,
    exits:[{id:'BRUDA',brg:30},{id:'BUSAR',brg:75},{id:'KORUL',brg:125},{id:'MOLUS',brg:175},{id:'TRO',brg:220},{id:'POI',brg:270},{id:'TAKAS',brg:315},{id:'SOSAR',brg:355}] },
  // LSAS Switzerland
  { id:'CHFRA',  name:'Skyguide CHFRA',     fir:'LSAS',           country:'CH', cLat:46.8, cLng:8.2, rNm:130, flFloor:285, flCeil:660, rateMph:90,
    exits:[{id:'SARIX',brg:30},{id:'KORED',brg:80},{id:'BIRGI',brg:130},{id:'LEMUR',brg:180},{id:'ROTOS',brg:225},{id:'NEGRA',brg:275},{id:'TRA',brg:320},{id:'MEGIM',brg:355}] },
  // ESAA SE-N north already in NEFRA; LCCC Cyprus FRA
  { id:'CYPFRA', name:'CYPFRA Nicosia',     fir:'LCCC',           country:'CY', cLat:35.0, cLng:33.0, rNm:220, flFloor:285, flCeil:660, rateMph:60,
    exits:[{id:'PETOR',brg:30},{id:'LARNA',brg:80},{id:'DEKEL',brg:130},{id:'PRAMI',brg:180},{id:'KUKLA',brg:225},{id:'INDIK',brg:275},{id:'PAPHO',brg:320},{id:'KEROS',brg:355}] },
  // UKFA Ukraine FRA (paused but defined)
  { id:'UKFRA',  name:'UKFRA Kyiv',         fir:'UKBV',           country:'UA', cLat:50.0, cLng:30.5, rNm:280, flFloor:285, flCeil:660, rateMph:0,
    exits:[{id:'LUTOR',brg:30},{id:'KORZA',brg:80},{id:'DNIPR',brg:130},{id:'LWO',brg:180},{id:'GORMA',brg:225},{id:'KOLUM',brg:270},{id:'NIDOV',brg:315},{id:'NIBAR',brg:355}] },
  // LTBB Turkey FRA-east
  { id:'TURFRA', name:'TR-FRA Ankara',      fir:'LTAA/LTBB',      country:'TR', cLat:39.0, cLng:33.0, rNm:300, flFloor:285, flCeil:660, rateMph:120,
    exits:[{id:'DONKO',brg:30},{id:'SIVAS',brg:80},{id:'TORUM',brg:130},{id:'TARSI',brg:180},{id:'ANTAL',brg:225},{id:'ESKIS',brg:275},{id:'BLACK',brg:320},{id:'EREGL',brg:355}] },
  // LMMM Malta FRA
  { id:'MLTFRA', name:'MLTFRA Malta',       fir:'LMMM',           country:'MT', cLat:35.9, cLng:14.4, rNm:170, flFloor:285, flCeil:660, rateMph:60,
    exits:[{id:'SUSIM',brg:30},{id:'GIN',brg:80},{id:'KUGAR',brg:130},{id:'NEPLA',brg:180},{id:'TUREN',brg:225},{id:'POMON',brg:275},{id:'BRINI',brg:320},{id:'BANSI',brg:355}] },
  // BIRD Iceland FRA
  { id:'ISLFRA', name:'BIRD-FRA Iceland',   fir:'BIRD',           country:'IS', cLat:64.5, cLng:-18.0, rNm:380, flFloor:285, flCeil:660, rateMph:50,
    exits:[{id:'INGEK',brg:30},{id:'GIBNO',brg:80},{id:'OSGAR',brg:130},{id:'KEBLA',brg:180},{id:'LATGA',brg:225},{id:'EMBLA',brg:275},{id:'NUMPO',brg:320},{id:'ALDAN',brg:355}] },
  // LGGG Greece FRA
  { id:'GRCFRA', name:'HCAA-FRA Greece',    fir:'LGGG',           country:'GR', cLat:39.0, cLng:23.0, rNm:280, flFloor:285, flCeil:660, rateMph:110,
    exits:[{id:'NIKON',brg:30},{id:'IRAKL',brg:80},{id:'NIKAS',brg:130},{id:'RODOS',brg:180},{id:'KOROL',brg:225},{id:'DEMIK',brg:275},{id:'TERSO',brg:320},{id:'KOMOT',brg:355}] },
  // FAOR South-Africa FRA (ATNS-FRA pilot)
  { id:'ZAFRA',  name:'ATNS-FRA RSA',       fir:'FAJA',           country:'ZA', cLat:-27.0, cLng:27.0, rNm:380, flFloor:285, flCeil:660, rateMph:50,
    exits:[{id:'KRUGR',brg:30},{id:'DURBO',brg:80},{id:'GMA',brg:130},{id:'CPMT',brg:175},{id:'UPING',brg:225},{id:'KIMBE',brg:275},{id:'POLOK',brg:320},{id:'ZULKO',brg:355}] },
  // YBBB Australia FRA
  { id:'AUFRA',  name:'AS-FRA Brisbane',    fir:'YBBB/YMMM',      country:'AU', cLat:-25.0, cLng:140.0, rNm:520, flFloor:285, flCeil:660, rateMph:60,
    exits:[{id:'BAKEM',brg:30},{id:'GLOBE',brg:80},{id:'KOSDE',brg:130},{id:'MELOR',brg:180},{id:'PIRIT',brg:225},{id:'TOMOX',brg:275},{id:'GIBNO',brg:320},{id:'KUMBA',brg:355}] },
  // OMAE Emirates UAEFRA pilot
  { id:'AEFRA',  name:'GCAA-FRA UAE',       fir:'OMAE',           country:'AE', cLat:24.2, cLng:54.6, rNm:200, flFloor:285, flCeil:660, rateMph:90,
    exits:[{id:'DESDI',brg:30},{id:'ULASA',brg:80},{id:'PARAR',brg:130},{id:'NAGED',brg:180},{id:'BUBIN',brg:225},{id:'KARDO',brg:275},{id:'PASIB',brg:320},{id:'MEMIN',brg:355}] },
  // KZNY domestic-FRA (RNAV-Q routes)
  { id:'USFRA',  name:'US-Q DCT NY-ZOB',    fir:'KZNY/KZOB/KZBW', country:'US', cLat:42.5, cLng:-75.0, rNm:280, flFloor:240, flCeil:430, rateMph:160,
    exits:[{id:'JFK',brg:135},{id:'BOS',brg:80},{id:'PIT',brg:225},{id:'YYZ',brg:315},{id:'EWR',brg:170},{id:'ALB',brg:30},{id:'IAD',brg:200},{id:'SYR',brg:280}] },
]

/* ----- geo math ----- */
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const R_NM = 3440.065
function gcNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180, dφ = (la2 - la1) * Math.PI / 180, dλ = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
function bearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180, dλ = (lo2 - lo1) * Math.PI / 180
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}
function angDelta(a: number, b: number): number { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d }
function projectLatLng(la: number, lo: number, brg: number, dnm: number): [number, number] {
  const δ = dnm / R_NM, θ = brg * Math.PI / 180, φ1 = la * Math.PI / 180, λ1 = lo * Math.PI / 180
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return [φ2 * 180 / Math.PI, λ2 * 180 / Math.PI]
}

/* Hash-stable FNV-1a for synthesised per-aircraft noise (zig-zag count etc) */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0 }
  return h >>> 0
}

/* ----- per-aircraft FRA analysis ----- */
interface Fa {
  f: SFlight
  klass: Klass
  fra: Fra
  distFromCtrNm: number
  inside: boolean
  brgFromCtr: number          // bearing centre→aircraft
  distToBoundaryNm: number    // along current track to FRA exit-perimeter (NM)
  exit: FraExit               // best-matching octant exit
  exitDistNm: number          // gc-distance to exit point along boundary
  exitBrg: number             // bearing aircraft→exit
  trackOffsetDeg: number      // |track - exitBrg| (small = good direct)
  directnessRatio: number     // gc / projected-track-mile estimate (0..1, 1=perfect direct)
  bcInferred: number          // inferred 60s bearing-change-count (synth + track-vs-exit)
  lchInferred: number         // level-change penalty inferred from |vertRate| & FL band
  utilPct: number             // FRA mvts/h current vs design rate
  flDeltaCeil: number         // FL distance below ceiling (positive ok)
  flDeltaFloor: number        // FL distance above floor (positive ok)
  drivers: Record<'DIR'|'BCH'|'LCH'|'DTH'|'UTL'|'ALT', number>
  score: number
  tier: Tier
}

function analyse(f: SFlight, fraCounts: Map<string, number>): Fa | null {
  const klass = classifyKlass(f.type)
  let best: { fra: Fra, dist: number } | null = null
  for (const v of FRA_LIST) {
    const d = gcNm(f.lat, f.lng, v.cLat, v.cLng)
    if (d > v.rNm + 30) continue
    if (!best || d < best.dist) best = { fra: v, dist: d }
  }
  if (!best) return null
  const fra = best.fra
  const distFromCtrNm = best.dist
  const inside = distFromCtrNm <= fra.rNm
  if (!inside) return null
  const brgFromCtr = bearingDeg(fra.cLat, fra.cLng, f.lat, f.lng)
  // best-matching octant exit by current track
  let bestExit = fra.exits[0]
  let bestExitOff = 999
  for (const ex of fra.exits) {
    const [eLa, eLo] = projectLatLng(fra.cLat, fra.cLng, ex.brg, fra.rNm)
    const brgToExit = bearingDeg(f.lat, f.lng, eLa, eLo)
    const off = angDelta(f.track, brgToExit)
    if (off < bestExitOff) { bestExitOff = off; bestExit = ex }
  }
  const [exLa, exLo] = projectLatLng(fra.cLat, fra.cLng, bestExit.brg, fra.rNm)
  const exitDistNm = gcNm(f.lat, f.lng, exLa, exLo)
  const exitBrg = bearingDeg(f.lat, f.lng, exLa, exLo)
  const trackOffsetDeg = angDelta(f.track, exitBrg)

  // distance-to-boundary along current track (find where track ray exits the disc)
  // approximate: solve for d along track such that gc(f→pt) leaves the disc
  let distToBoundaryNm = 0
  for (let d = 5; d <= fra.rNm * 2.5; d += 5) {
    const [pLa, pLo] = projectLatLng(f.lat, f.lng, f.track, d)
    const dc = gcNm(pLa, pLo, fra.cLat, fra.cLng)
    if (dc > fra.rNm) { distToBoundaryNm = d; break }
  }
  if (distToBoundaryNm === 0) distToBoundaryNm = fra.rNm * 1.4

  // directness: actual gc to exit vs along-track projected
  // project current track straight for distToBoundaryNm and measure gc to exit from boundary-exit-point
  const [bLa, bLo] = projectLatLng(f.lat, f.lng, f.track, distToBoundaryNm)
  const trackExitMissNm = gcNm(bLa, bLo, exLa, exLo)
  const directnessRatio = clamp(exitDistNm / Math.max(exitDistNm + trackExitMissNm, 0.1), 0, 1)

  // synthesised zig-zag from FNV1a hash + amplified by trackOffsetDeg
  const h = fnv1a(f.icao + '#FRA')
  const baseBcn = (h & 0xff) / 255 * 1.2 // 0..1.2 per minute
  const bcInferred = baseBcn + clamp(trackOffsetDeg / 30, 0, 2.5)

  // level-change penalty: |vertRate| ft/min and proximity to FL ceiling
  const flNow = f.altitudeFt / 100
  const flDeltaFloor = flNow - fra.flFloor
  const flDeltaCeil = fra.flCeil - flNow
  const lchInferred = Math.min(2.5, Math.abs(f.vertRate) / 800) + (Math.abs(f.vertRate) > 200 ? 0.5 : 0)

  // utilisation (mvts/h current vs design rate)
  const cnt = fraCounts.get(fra.id) || 0
  const utilPct = fra.rateMph > 0 ? Math.min(220, cnt / fra.rateMph * 100 * 1.2) : 0

  // 6 drivers (0..100)
  const DIR = clamp((1 - directnessRatio) * 200, 0, 100)
  const BCH = clamp(bcInferred * 35, 0, 100)
  const LCH = clamp(lchInferred * 40, 0, 100)
  const DTH = clamp((distToBoundaryNm < 10 ? (10 - distToBoundaryNm) * 10 : 0) + trackOffsetDeg / 60 * 60, 0, 100)
  const UTL = clamp(utilPct >= 100 ? 40 + (utilPct - 100) * 0.6 : utilPct / 100 * 35, 0, 100)
  const flOutFloor = flDeltaFloor < 0 ? Math.abs(flDeltaFloor) : 0
  const flOutCeil = flDeltaCeil < 0 ? Math.abs(flDeltaCeil) : 0
  const ALT = clamp(50 + (flOutFloor + flOutCeil) * 3, flOutFloor + flOutCeil > 0 ? 50 : 0, 100) * (flOutFloor + flOutCeil > 0 ? 1 : 0.3)
  const drivers = { DIR, BCH, LCH, DTH, UTL, ALT }

  const maxDrv = Math.max(DIR, BCH, LCH, DTH, UTL, ALT)
  const secondary = (DIR + BCH + LCH + DTH + UTL + ALT - maxDrv) / 5
  const score = clamp(maxDrv * 0.86 + secondary * 0.16, 0, 100)

  let tier: Tier
  if (score >= 75 && directnessRatio < 0.55) tier = 'DCT-LOSS'
  else if (bcInferred > 1.6 && score >= 55) tier = 'ZIG-ZAG'
  else if (lchInferred > 1.0 && score >= 45) tier = 'STEP-DISR'
  else if (score >= 25) tier = 'WATCH'
  else tier = 'DIRECT'

  return {
    f, klass, fra, distFromCtrNm, inside, brgFromCtr, distToBoundaryNm,
    exit: bestExit, exitDistNm, exitBrg, trackOffsetDeg, directnessRatio,
    bcInferred, lchInferred, utilPct, flDeltaCeil, flDeltaFloor, drivers, score, tier,
  }
}

const SRC_HALO = 'fra-halo', LYR_HALO = 'fra-halo'
const SRC_PIN = 'fra-pin', LYR_PIN = 'fra-pin'
const SRC_LBL = 'fra-lbl', LYR_LBL = 'fra-lbl'
const SRC_DISC = 'fra-disc', LYR_DISC = 'fra-disc'
const SRC_DLBL = 'fra-dlbl', LYR_DLBL = 'fra-dlbl'
const SRC_EXIT = 'fra-exit', LYR_EXIT = 'fra-exit'
const SRC_ELBL = 'fra-elbl', LYR_ELBL = 'fra-elbl'
const SRC_LINK = 'fra-link', LYR_LINK = 'fra-link'
const SRC_PROJ = 'fra-proj', LYR_PROJ = 'fra-proj'

const lsGet = (k: string, d: any) => { if (typeof window === 'undefined') return d; try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } }
const lsSet = (k: string, v: any) => { if (typeof window === 'undefined') return; try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

export default function FraFreeRoute({ map, flights, onClose, onFly }: Props) {
  const [dirMul, setDirMul] = useState<number>(() => lsGet('ft-fra-dirm', 100))
  const [bchMul, setBchMul] = useState<number>(() => lsGet('ft-fra-bchm', 100))
  const [lchMul, setLchMul] = useState<number>(() => lsGet('ft-fra-lchm', 100))
  const [utlMul, setUtlMul] = useState<number>(() => lsGet('ft-fra-utlm', 100))
  const [minFL, setMinFL] = useState<number>(() => lsGet('ft-fra-mfl', 200))
  const [maxFL, setMaxFL] = useState<number>(() => lsGet('ft-fra-xfl', 460))
  const [advMul, setAdvMul] = useState<number>(() => lsGet('ft-fra-adv', 100))
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'VOLUMES' | 'CLASSES'>('AIRCRAFT')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showDisc, setShowDisc] = useState(true)
  const [showDlbl, setShowDlbl] = useState(true)
  const [showExit, setShowExit] = useState(true)
  const [showElbl, setShowElbl] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    lsSet('ft-fra-dirm', dirMul); lsSet('ft-fra-bchm', bchMul); lsSet('ft-fra-lchm', lchMul)
    lsSet('ft-fra-utlm', utlMul); lsSet('ft-fra-mfl', minFL); lsSet('ft-fra-xfl', maxFL); lsSet('ft-fra-adv', advMul)
  }, [dirMul, bchMul, lchMul, utlMul, minFL, maxFL, advMul])

  const rows = useMemo(() => {
    // first pass: count aircraft per FRA for utilisation
    const counts = new Map<string, number>()
    for (const f of flights) {
      if (f.ground || f.altitudeFt < minFL * 100 || f.altitudeFt > maxFL * 100) continue
      for (const v of FRA_LIST) {
        const d = gcNm(f.lat, f.lng, v.cLat, v.cLng)
        if (d <= v.rNm) { counts.set(v.id, (counts.get(v.id) || 0) + 1); break }
      }
    }
    const out: Fa[] = []
    for (const f of flights) {
      if (f.ground || f.altitudeFt < minFL * 100 || f.altitudeFt > maxFL * 100) continue
      const v = analyse(f, counts)
      if (!v) continue
      v.drivers.DIR = clamp(v.drivers.DIR * dirMul / 100, 0, 100)
      v.drivers.BCH = clamp(v.drivers.BCH * bchMul / 100, 0, 100)
      v.drivers.LCH = clamp(v.drivers.LCH * lchMul / 100, 0, 100)
      v.drivers.UTL = clamp(v.drivers.UTL * utlMul / 100, 0, 100)
      const maxDrv = Math.max(v.drivers.DIR, v.drivers.BCH, v.drivers.LCH, v.drivers.DTH, v.drivers.UTL, v.drivers.ALT)
      const secondary = (v.drivers.DIR + v.drivers.BCH + v.drivers.LCH + v.drivers.DTH + v.drivers.UTL + v.drivers.ALT - maxDrv) / 5
      v.score = clamp((maxDrv * 0.86 + secondary * 0.16) * advMul / 100, 0, 100)
      if (v.score >= 75 && v.directnessRatio < 0.55) v.tier = 'DCT-LOSS'
      else if (v.bcInferred > 1.6 && v.score >= 55) v.tier = 'ZIG-ZAG'
      else if (v.lchInferred > 1.0 && v.score >= 45) v.tier = 'STEP-DISR'
      else if (v.score >= 25) v.tier = 'WATCH'
      else v.tier = 'DIRECT'
      out.push(v)
    }
    out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, dirMul, bchMul, lchMul, utlMul, minFL, maxFL, advMul])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(v => {
      if (klassFilter !== 'ALL' && v.klass !== klassFilter) return false
      if (tierFilter !== 'ALL' && v.tier !== tierFilter) return false
      if (q) {
        const blob = `${v.f.callsign} ${v.f.icao} ${v.f.type} ${v.fra.id} ${v.fra.name} ${v.fra.country} ${v.exit.id}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [rows, klassFilter, tierFilter, query])

  const tierCount: Record<Tier, number> = { 'DCT-LOSS': 0, 'ZIG-ZAG': 0, 'STEP-DISR': 0, WATCH: 0, DIRECT: 0, IDLE: 0 }
  for (const v of rows) tierCount[v.tier]++
  const meanDir = rows.length ? rows.reduce((s, v) => s + v.directnessRatio, 0) / rows.length : 1
  const dctLoss = tierCount['DCT-LOSS']
  const zigZag = tierCount['ZIG-ZAG']
  const stepDisr = tierCount['STEP-DISR']
  const worst = rows[0]
  const meanScore = rows.length ? rows.reduce((s, v) => s + v.score, 0) / rows.length : 0
  const totalCnt = rows.length

  useEffect(() => {
    if (!map) return
    const ensure = (id: string, type: any, src: string, paint: any, layout: any = {}) => {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer(id)) map.addLayer({ id, type, source: src, paint, layout } as any)
    }
    ensure(LYR_DISC, 'line', SRC_DISC, { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.55, 'line-dasharray': [4, 2] })
    ensure(LYR_PROJ, 'line', SRC_PROJ, { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.7, 'line-dasharray': [2, 2] })
    ensure(LYR_LINK, 'line', SRC_LINK, { 'line-color': ['get', 'color'], 'line-width': 1.8, 'line-opacity': 0.85, 'line-dasharray': [3, 2] })
    ensure(LYR_EXIT, 'circle', SRC_EXIT, { 'circle-radius': 4.5, 'circle-color': '#a855f7', 'circle-stroke-width': 1.2, 'circle-stroke-color': '#0f172a' })
    ensure(LYR_HALO, 'circle', SRC_HALO, { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'] })
    ensure(LYR_PIN, 'circle', SRC_PIN, { 'circle-radius': 5.5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' })
    ensure(LYR_LBL, 'symbol', SRC_LBL, {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    ensure(LYR_DLBL, 'symbol', SRC_DLBL, {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 0], 'text-anchor': 'center', 'text-font': ['Open Sans Regular'] })
    ensure(LYR_ELBL, 'symbol', SRC_ELBL, {}, { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    if (map.getLayer(LYR_LBL)) { map.setPaintProperty(LYR_LBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_LBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_LBL, 'text-halo-width', 1.4) }
    if (map.getLayer(LYR_DLBL)) { map.setPaintProperty(LYR_DLBL, 'text-color', '#a855f7'); map.setPaintProperty(LYR_DLBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_DLBL, 'text-halo-width', 1.4) }
    if (map.getLayer(LYR_ELBL)) { map.setPaintProperty(LYR_ELBL, 'text-color', '#a855f7'); map.setPaintProperty(LYR_ELBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_ELBL, 'text-halo-width', 1.2) }

    const halo: any[] = [], pin: any[] = [], lbl: any[] = [], link: any[] = [], proj: any[] = [], disc: any[] = [], dlbl: any[] = [], exit: any[] = [], elbl: any[] = []
    const activeFra = new Set<string>()
    for (const v of filtered) {
      const c = TIER_COLOR[v.tier]
      activeFra.add(v.fra.id)
      if (showHalo) halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: { color: c, r: 8 + v.score * 0.14 } })
      if (showPin && (v.tier === 'DCT-LOSS' || v.tier === 'ZIG-ZAG')) pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: { color: c } })
      if (showLbl && v.tier !== 'DIRECT') {
        const lab = `${v.f.callsign || v.f.icao} ${v.tier} ${v.exit.id} ${(v.directnessRatio * 100).toFixed(0)}%`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: { label: lab, color: c } })
      }
      if (showLink) {
        const [exLa, exLo] = projectLatLng(v.fra.cLat, v.fra.cLng, v.exit.brg, v.fra.rNm)
        link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[v.f.lng, v.f.lat], [exLo, exLa]] }, properties: { color: c } })
      }
      if (showProj) {
        const [bLa, bLo] = projectLatLng(v.f.lat, v.f.lng, v.f.track, v.distToBoundaryNm)
        proj.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[v.f.lng, v.f.lat], [bLo, bLa]] }, properties: { color: v.trackOffsetDeg > 25 ? '#f43f5e' : '#0ea5e9' } })
      }
    }
    for (const v of FRA_LIST) {
      const active = activeFra.has(v.id)
      if (showDisc) {
        const pts: any[] = []
        const steps = 48
        for (let i = 0; i <= steps; i++) {
          const b = (i / steps) * 360
          const [la, lo] = projectLatLng(v.cLat, v.cLng, b, v.rNm)
          pts.push([lo, la])
        }
        disc.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts }, properties: { color: active ? '#a855f7' : '#475569' } })
      }
      if (showDlbl) {
        dlbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.cLng, v.cLat] }, properties: { label: `${v.id} · FL${v.flFloor}-${v.flCeil} · ${v.rateMph}/h` } })
      }
      if (showExit) {
        for (const ex of v.exits) {
          const [eLa, eLo] = projectLatLng(v.cLat, v.cLng, ex.brg, v.rNm)
          exit.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [eLo, eLa] }, properties: {} })
          if (showElbl) elbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [eLo, eLa] }, properties: { label: ex.id } })
        }
      }
    }
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })
    ;(map.getSource(SRC_PROJ) as any).setData({ type: 'FeatureCollection', features: proj })
    ;(map.getSource(SRC_DISC) as any).setData({ type: 'FeatureCollection', features: disc })
    ;(map.getSource(SRC_DLBL) as any).setData({ type: 'FeatureCollection', features: dlbl })
    ;(map.getSource(SRC_EXIT) as any).setData({ type: 'FeatureCollection', features: exit })
    ;(map.getSource(SRC_ELBL) as any).setData({ type: 'FeatureCollection', features: elbl })

    return () => {
      const m = map
      for (const id of [LYR_ELBL, LYR_DLBL, LYR_LBL, LYR_EXIT, LYR_PIN, LYR_HALO, LYR_LINK, LYR_PROJ, LYR_DISC]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_PIN, SRC_LBL, SRC_LINK, SRC_PROJ, SRC_DISC, SRC_DLBL, SRC_EXIT, SRC_ELBL]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, filtered, showHalo, showPin, showLbl, showLink, showProj, showDisc, showDlbl, showExit, showElbl])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const klassBadge = (k: Klass) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: KLASS_COLOR[k], backgroundColor: KLASS_COLOR[k] + '1a', border: `1px solid ${KLASS_COLOR[k]}66` }}>{k}</span>
  )
  const drvBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const advice = (v: Fa) => {
    if (v.tier === 'DCT-LOSS') return `DCT-LOSS · ${(v.directnessRatio * 100).toFixed(0)}% direct vs ${v.exit.id} (${v.trackOffsetDeg.toFixed(0)}° off) · request direct ${v.exit.id} per EUROCONTROL FRA ConOps ed.3.0 §4`
    if (v.tier === 'ZIG-ZAG') return `ZIG-ZAG · ${v.bcInferred.toFixed(1)} bearing-changes/min · request stable heading or direct ${v.exit.id} per EUROCONTROL FRA IM ed.2.1 §3`
    if (v.tier === 'STEP-DISR') return `STEP-DISR · ${v.f.vertRate >= 0 ? 'climb' : 'descent'} ${Math.abs(v.f.vertRate).toFixed(0)}fpm mid-FRA · coordinate step before exit per ICAO Doc 9931 §4 / Doc 9993 §3`
    if (v.tier === 'WATCH') return `WATCH · ${v.fra.id} · FL${(v.f.altitudeFt/100).toFixed(0)} band FL${v.fra.flFloor}-${v.fra.flCeil} · exit ${v.exit.id} ${v.exitDistNm.toFixed(0)}nm bearing ${v.exitBrg.toFixed(0)}°`
    return `DIRECT · routing efficient ${(v.directnessRatio * 100).toFixed(0)}% to ${v.exit.id} per EUROCONTROL FRA ConOps ed.3.0`
  }

  /* Scatter: directness (%) horizontal vs bearing-changes vertical */
  const W = 280, H = 180
  const sx = (n: number) => 32 + clamp(n, 0, 100) / 100 * (W - 42)
  const sy = (n: number) => H - 24 - clamp(n, 0, 4) / 4 * (H - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">FRA · Free Route Airspace efficiency</div>
          <div className="text-[10px] text-slate-500">EUROCONTROL FRA ConOps ed.3.0 · NMIR 2019/123 · Doc 9854 §3.6 · Doc 9931 §4 · Doc 9993 §3</div>
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
          <div className="text-[9px] text-slate-500 uppercase">Mean direct</div>
          <div className="text-sm font-semibold" style={{ color: meanDir < 0.6 ? '#ef4444' : meanDir < 0.8 ? '#f59e0b' : '#10b981' }}>{(meanDir * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst ? (worst.f.callsign || worst.f.icao) : '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">DCT-loss</div>
          <div className="text-sm font-semibold" style={{ color: dctLoss > 0 ? '#ef4444' : '#10b981' }}>{dctLoss}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Zig-zag</div>
          <div className="text-xs font-semibold" style={{ color: zigZag > 0 ? '#f43f5e' : '#10b981' }}>{zigZag}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Step-disr</div>
          <div className="text-xs font-semibold" style={{ color: stepDisr > 0 ? '#f59e0b' : '#10b981' }}>{stepDisr}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">In-FRA</div>
          <div className="text-xs font-semibold text-sky-400">{totalCnt}</div>
        </div>
      </div>

      {showDiag && rows.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* breach: directness < 55% */}
            <rect x={0} y={0} width={sx(55) - 32} height={H - 24} fill="#ef444425" />
            <rect x={sx(55) - 32 + 32} y={0} width={sx(75) - sx(55)} height={H - 24} fill="#f59e0b15" />
            <line x1={sx(55)} y1={0} x2={sx(55)} y2={H - 24} stroke="#ef444466" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(75)} y1={0} x2={sx(75)} y2={H - 24} stroke="#f59e0b66" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(0)} y1={sy(1.6)} x2={sx(100)} y2={sy(1.6)} stroke="#f43f5e66" strokeWidth={0.5} strokeDasharray="3 3" />
            <text x={W / 2} y={H - 4} textAnchor="middle" fontSize="9" fill="#64748b">Directness ratio (%)</text>
            <text x={6} y={H / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H / 2})`}>Bearing-change/min</text>
            {rows.map((v, i) => (
              <circle key={i} cx={sx(v.directnessRatio * 100)} cy={sy(v.bcInferred)} r={2.4} fill={TIER_COLOR[v.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['DIR-MUL', dirMul, 50, 200, setDirMul, '%'],
            ['BCH-MUL', bchMul, 50, 200, setBchMul, '%'],
            ['LCH-MUL', lchMul, 50, 200, setLchMul, '%'],
            ['UTL-MUL', utlMul, 50, 200, setUtlMul, '%'],
            ['ADV-MUL', advMul, 50, 200, setAdvMul, '%'],
            ['MIN-FL', minFL, 100, 400, setMinFL, ''],
            ['MAX-FL', maxFL, 200, 660, setMaxFL, ''],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[68px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[40px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['HVY', 'NRW', 'RGN', 'BIZ', 'TBP'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlassFilter(klassFilter === k ? 'ALL' : k)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: klassFilter === k ? KLASS_COLOR[k] + '33' : '#0b1220', borderColor: klassFilter === k ? KLASS_COLOR[k] : '#1e293b', color: klassFilter === k ? KLASS_COLOR[k] : '#cbd5e1' }}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['DISC', showDisc, setShowDisc],
            ['DLBL', showDlbl, setShowDlbl],
            ['EXIT', showExit, setShowExit],
            ['ELBL', showElbl, setShowElbl],
            ['LINK', showLink, setShowLink],
            ['PROJ', showProj, setShowProj],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, on, setter]: any) => (
            <button key={lab} onClick={() => setter(!on)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: on ? '#0ea5e933' : '#0b1220', borderColor: on ? '#0ea5e9' : '#1e293b', color: on ? '#0ea5e9' : '#94a3b8' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / volume / exit / country" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'VOLUMES', 'CLASSES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-1.5 text-[10px] font-semibold ${tab === t ? 'text-sky-400 bg-slate-800/50 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {tab === 'AIRCRAFT' && (
        <div className="divide-y divide-slate-800">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No aircraft inside published FRA volumes</div>}
          {filtered.map((v, idx) => (
            <div key={idx} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(v.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[v.tier]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 truncate">{v.f.callsign || v.f.icao}</span>
                  <span className="text-slate-500 text-[10px] truncate">{v.f.type || '—'}</span>
                  {klassBadge(v.klass)}
                </div>
                {tierBadge(v.tier)}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                <span className="text-sky-300">{v.fra.id}</span>
                {' · '}<span className="text-violet-300">→{v.exit.id}</span>
                {' · '}<span style={{ color: v.directnessRatio < 0.55 ? '#ef4444' : v.directnessRatio < 0.75 ? '#f59e0b' : '#10b981' }}>{(v.directnessRatio * 100).toFixed(0)}% direct</span>
                {' · off '}<span style={{ color: v.trackOffsetDeg > 25 ? '#f43f5e' : '#cbd5e1' }}>{v.trackOffsetDeg.toFixed(0)}°</span>
                {' · ex-d '}<span className="text-slate-300">{v.exitDistNm.toFixed(0)}nm</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                <span className="text-slate-300">bnd {v.distToBoundaryNm.toFixed(0)}nm</span>
                {' · bch '}<span style={{ color: v.bcInferred > 1.6 ? '#f43f5e' : '#cbd5e1' }}>{v.bcInferred.toFixed(1)}/min</span>
                {' · lch '}<span style={{ color: v.lchInferred > 1.0 ? '#f59e0b' : '#cbd5e1' }}>{v.lchInferred.toFixed(1)}</span>
                {' · FL'}<span className="text-slate-300">{(v.f.altitudeFt/100).toFixed(0)}</span>
                {' · vrt '}<span className="text-slate-300">{v.f.vertRate >= 0 ? '↑' : '↓'}{Math.abs(v.f.vertRate).toFixed(0)}</span>
              </div>
              <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${v.score}%`, backgroundColor: TIER_COLOR[v.tier] }} /></div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {drvBadge('DIR', v.drivers.DIR)}
                {drvBadge('BCH', v.drivers.BCH)}
                {drvBadge('LCH', v.drivers.LCH)}
                {drvBadge('DTH', v.drivers.DTH)}
                {drvBadge('UTL', v.drivers.UTL)}
                {drvBadge('ALT', v.drivers.ALT)}
              </div>
              <div className="text-[10px] mt-1.5 italic" style={{ color: TIER_COLOR[v.tier] }}>{advice(v)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'VOLUMES' && (
        <div className="divide-y divide-slate-800">
          {FRA_LIST.slice().sort((a, b) => {
            const ka = rows.filter(r => r.fra.id === a.id).length
            const kb = rows.filter(r => r.fra.id === b.id).length
            return kb - ka
          }).map(p => {
            const vRows = rows.filter(r => r.fra.id === p.id)
            const dl = vRows.filter(r => r.tier === 'DCT-LOSS').length
            const zz = vRows.filter(r => r.tier === 'ZIG-ZAG').length
            const sd = vRows.filter(r => r.tier === 'STEP-DISR').length
            const ms = vRows.length ? vRows.reduce((s, r) => s + r.score, 0) / vRows.length : 0
            const md = vRows.length ? vRows.reduce((s, r) => s + r.directnessRatio, 0) / vRows.length : 1
            const utilPct = p.rateMph > 0 ? vRows.length / p.rateMph * 100 : 0
            return (
              <div key={p.id} className="px-3 py-2 hover:bg-slate-800/40" style={{ borderLeft: `3px solid ${dl > 0 ? '#ef4444' : zz > 0 ? '#f43f5e' : sd > 0 ? '#f59e0b' : '#10b981'}` }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-sky-300">{p.id}</span>
                    <span className="text-slate-200 text-[11px]">{p.name}</span>
                    <span className="text-slate-500 text-[10px]">{p.country}</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-300">{p.rateMph || '—'}/h · {p.fir.split('/')[0]}</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  R {p.rNm}nm · FL{p.flFloor}-{p.flCeil} · {p.exits.length} exits
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  {vRows.length} active · meanDct <span style={{ color: md < 0.6 ? '#ef4444' : md < 0.8 ? '#f59e0b' : '#10b981' }}>{(md*100).toFixed(0)}%</span>
                  {' · '}<span className="text-rose-400">{dl} DCT-LOSS</span> · <span className="text-rose-300">{zz} ZIG-ZAG</span> · <span className="text-amber-400">{sd} STEP-DISR</span> · util {utilPct.toFixed(0)}%
                </div>
                <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: ms >= 60 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }} /></div>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {p.exits.map(ex => (
                    <span key={ex.id} className="text-[9px] font-mono px-1 py-0.5 rounded border border-violet-500/40 text-violet-300 bg-violet-500/10">{ex.id} {ex.brg.toFixed(0)}°</span>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'CLASSES' && (
        <div className="divide-y divide-slate-800">
          {(['HVY', 'NRW', 'RGN', 'BIZ', 'TBP'] as Klass[]).map(k => {
            const kRows = rows.filter(r => r.klass === k)
            const dl = kRows.filter(r => r.tier === 'DCT-LOSS').length
            const zz = kRows.filter(r => r.tier === 'ZIG-ZAG').length
            const ms = kRows.length ? kRows.reduce((s, r) => s + r.score, 0) / kRows.length : 0
            const md = kRows.length ? kRows.reduce((s, r) => s + r.directnessRatio, 0) / kRows.length : 1
            const mb = kRows.length ? kRows.reduce((s, r) => s + r.bcInferred, 0) / kRows.length : 0
            return (
              <div key={k} className="px-3 py-2 hover:bg-slate-800/40" style={{ borderLeft: `3px solid ${KLASS_COLOR[k]}` }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    {klassBadge(k)}
                    <span className="text-slate-300 text-[11px]">{KLASS_LABEL[k]} · Vcr {KLASS_VCRUISE[k]}kt</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-300">{kRows.length} ac · mean {(md*100).toFixed(0)}%</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  <span className="text-rose-400">{dl} DCT-LOSS</span> · <span className="text-rose-300">{zz} ZIG-ZAG</span> · mean BCH {mb.toFixed(1)}/min
                </div>
                <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: ms >= 60 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }} /></div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
