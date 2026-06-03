'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   CAT-II / CAT-III Autoland Fail-Operational Capability &
   Low-Visibility-Operations (LVO) Compliance Monitor
   -----------------------------------------------------------
   Watches every airborne aircraft on approach phase (descending
   below FL120, within capture range of a catalogued destination
   airport along the projected ground track) and reconstructs:

     · Aircraft autoland equipage tier (NO / CAT-I / CAT-II /
       CAT-IIIA / CAT-IIIB / CAT-IIIC) and channel status
       (FO Fail-Operational dual-channel, FP Fail-Passive,
       DEG single-channel, INOP)
     · Destination airport published lowest-CAT capability,
       RVR minima per category, runway-lighting facilities
       (centreline lights / TDZL / SALS / ALSF-II / ICAO HIALS)
     · Current reported RVR (TDZ / MID / RO) and ceiling AGL
     · Required visual segment at DH per FAA AC 120-29A / AMC1
       CAT.OP.MPA.110 LVO and FAA InFO 11005 ALSF visibility
     · Crosswind component vs autoland crosswind limit
       (Boeing FCOM 9.20: 25kt CAT-I / 20kt CAT-II / 15kt CAT-IIIB
        Airbus FCOM PRO-NOR-SOP-15: 30/15/10kt LAND ROLL OUT)
     · Required redundant systems (dual ILS, dual AFCS channels,
       dual auto-throttle, dual radio altimeters, GPWS Mode 5,
       autobrake LO/MED/MAX per Cat)

   Regulatory & operational basis:
     · 14 CFR 121.651 Authority over flight in LVO
     · 14 CFR 91.175 IFR takeoff / approach / landing minima
     · 14 CFR 121.349 Approach approach instrument requirements
     · FAA AC 120-29A Criteria for Approval of CAT-II Ops
     · FAA AC 120-28D Criteria for Approval of CAT-III Ops
     · FAA AC 120-118 CAT-II / CAT-III Visual Reference Reqs
     · FAA Order 8400.13D LVO Crew Qualification
     · FAA InFO 11005 ALSF-II Visual Reference at DH
     · ICAO Annex 6 Pt I 4.4 LVO operations
     · ICAO Doc 9365 All-Weather Operations Manual
     · ICAO Annex 14 Vol I 5.3.4 Runway lighting categories
     · EASA CAT.OP.MPA.110 LVO Procedures
     · EASA AMC1 CAT.OP.MPA.110 / AMC1 CAT.OP.MPA.115 RVR
     · EASA AMC1 SPA.LVO.105 Operator approval
     · Boeing FCOM 9.20 / SP.16 Autoland Operation
     · Airbus FCOM PRO-NOR-SOP-15 LAND / 22-30-00 AFCS
     · Honeywell SmartRunway / SmartLanding LVO advisory

   8-class autoland-equipage catalogue:
     HVY  B777 B787 A350 A380          CAT-IIIB FO baseline
     HMB  B767 B747-400 A330 A340      CAT-IIIA FP baseline
     NRW  B737NG/MAX A320 A321         CAT-IIIA mostly FP
     RGN  CRJ-700/900 E170/E190        CAT-II baseline
     BIZ  G550 G650 Global Falcon      CAT-IIIA optional (HUD)
     TBP  Q400 ATR-72                  CAT-I only
     GA   Light GA                     NO autoland
     FTR  Military fast-jet            NO civil autoland

   Per-airframe hash-stable synthesis (FNV-1a 32-bit of ICAO24):
     · base CAT capability per class
     · channel status (FO 60% / FP 30% / DEG 8% / INOP 2%)
     · MEL deferral state (LAND2 / LAND3 / NO AUTOLAND)
     · radio-altimeter dual or single state
     · autobrake / auto-throttle armed state
     · 100% of class capability when channel=FO, downgrade
       one tier when FP, two tiers when DEG, NO when INOP

   48 destination-airport catalogue with published CAT capability,
   per-runway lighting fit, current weather:
     CAT-IIIB ALSF-II  EGLL EDDF LFPG EHAM EDDM LSZH KJFK KORD
                       KSFO KSEA KDEN KATL KIAD KMSP KMEM KMCI
                       KMCO KCLT KDTW KBWI KIAH RJTT RJAA RKSI
                       VHHH WSSS LIRF LEMD EFHK ESSA ENGM LFSB
     CAT-IIIA          EGCC EGGW LEBL LIRN ZBAA ZSPD VABB OERK
     CAT-II            KDCA KLAS KSMF KSAN KMIA KPHL KAUS RPLL
     CAT-I only        KMRY KASE KEGE KSCK PANC PHNL PAJN OTHH

   Current weather sampled per-airport per-tick from hash of
   IATA + minute-bucket: ceiling AGL 100..5000ft, RVR TDZ
   200..6000m, wind dir/speed for crosswind on landing runway.

   Computes for each aircraft × destination row:
     · effectiveCat = min(aircraft-cap, airport-cap)
     · catReq = lowest cat at which RVR + ceiling are met
     · downgrade tiers if MEL deferral, channel status, or
       RA single only
     · crosswind component on assigned runway vs LAND limit
     · ALS reach: HIALS/CL TDZ required for IIIB; SALS only
       limits to CAT-I

   5 risk components, composite = max-driver:
     CAT    aircraft-cap vs airport-cap required severity
            (sev 100 if aircraft-cap < required, ramped)
     RVR    reported RVR vs CAT minima
            (sev 100 if below by >100m, ramped)
     EQUIP  channel status / MEL deferral / RA-single
            (sev 100 INOP, 75 DEG, 40 FP-needing-FO, 0 FO)
     LITES  airport lighting reach vs CAT requirement
            (sev 100 if SALS/no-CL but IIIB required)
     XWND   crosswind component vs autoland limit per FCOM

   Tier classification (per AC 120-28D appendix):
     UNABLE   score>=80 / RVR + ceiling below catReq AND
              aircraft cap below catReq — rose — divert,
              alternate required per 121.619, request CAT-I
              clearance only or hold for improvement
     RESTRICT score>=55 — amber — fly to CAT-I/CAT-II
              minima only, brief crew NO autoland or
              fail-passive autoland with go-around required
     WATCH    score>=25 — sky — within minima with low margin,
              brief crew rapid-deteriorate go-around criteria
     OK       score<25 — emerald — fully equipped, autoland
              available to lowest published minima
     IDLE     not on approach / no airport in capture — slate

   MapLibre overlay:
     · tier-coloured halo rings sized by score 8-22 px
     · rose diamond pin at destination airport for UNABLE
       with category gap callout
     · tier-coloured callsign + IATA + cap-gap + driver labels
       for RESTRICT/UNABLE
     · 48 airport pins coloured by published CAT capability
       (CAT-IIIB rose halo, IIIA amber, II sky, I slate)
     · dashed tier-coloured projection aircraft→airport
       threshold for RESTRICT/UNABLE

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell MEAN-RVR-DEFICIT / WORST callsign / UNABLE-count
     · 2-cell MEAN-CHANNEL-FO-share / XWND-LIMITED-share
       secondary row
     · SVG aircraft-cap-tier vs airport-RVR scatter with
       rose-shaded below-mins band, amber tight band, sky margin,
       emerald nominal, per-CAT verticals
     · 5 sliders MIN-FL / CAPTURE / RVR-OFFSET / WIND-MUL /
       MEL-RATE
     · 8-class chip filter + 4-cat capability chip filter
     · HALO / PIN / LBL / PROJ / APT / DIAG toggles + search
     · AIRCRAFT / AIRPORTS tab switcher
     · AIRCRAFT tab: callsign / type / IATA-pill / tier
       capability / channel / RVR / ceiling / xwnd / advice
     · AIRPORTS tab: IATA / name / capability / current RVR /
       inbound count / worst-tier
============================================================ */

export interface AutolandFlight {
  icao: string
  callsign?: string
  type?: string
  operator?: string
  category?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  vertRate: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: AutolandFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'UNABLE' | 'RESTRICT' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  UNABLE: '#ef4444', RESTRICT: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['UNABLE', 'RESTRICT', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { UNABLE: 0, RESTRICT: 1, WATCH: 2, OK: 3, IDLE: 4 }

type Cat = 'NO' | 'CAT-I' | 'CAT-II' | 'CAT-IIIA' | 'CAT-IIIB' | 'CAT-IIIC'
const CAT_LIST: Cat[] = ['NO', 'CAT-I', 'CAT-II', 'CAT-IIIA', 'CAT-IIIB', 'CAT-IIIC']
const CAT_RANK: Record<Cat, number> = { 'NO': 0, 'CAT-I': 1, 'CAT-II': 2, 'CAT-IIIA': 3, 'CAT-IIIB': 4, 'CAT-IIIC': 5 }
// RVR minima per cat in metres (FAA AC 120-29A / AC 120-28D / EASA AMC1 CAT.OP.MPA.115)
const CAT_RVR_M: Record<Cat, number> = { 'NO': 1600, 'CAT-I': 550, 'CAT-II': 300, 'CAT-IIIA': 200, 'CAT-IIIB': 75, 'CAT-IIIC': 0 }
// DH per cat in ft AGL
const CAT_DH_FT: Record<Cat, number> = { 'NO': 250, 'CAT-I': 200, 'CAT-II': 100, 'CAT-IIIA': 50, 'CAT-IIIB': 0, 'CAT-IIIC': 0 }
// Crosswind autoland limit kt per cat
const CAT_XWND_KT: Record<Cat, number> = { 'NO': 30, 'CAT-I': 25, 'CAT-II': 20, 'CAT-IIIA': 15, 'CAT-IIIB': 15, 'CAT-IIIC': 10 }

type AcClass = 'HVY' | 'HMB' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA' | 'FTR'
const CLASS_LIST: AcClass[] = ['HVY', 'HMB', 'NRW', 'RGN', 'BIZ', 'TBP', 'GA', 'FTR']

interface ClassSpec {
  baseCap: Cat
  fcom: string
  raDualProb: number
}
const CLASS_SPEC: Record<AcClass, ClassSpec> = {
  HVY: { baseCap: 'CAT-IIIB', fcom: 'B777/B787/A350/A380 FCOM 9.20 / SP.16',                   raDualProb: 0.98 },
  HMB: { baseCap: 'CAT-IIIA', fcom: 'B767/B747-400/A330/A340 FCOM 9.20',                       raDualProb: 0.95 },
  NRW: { baseCap: 'CAT-IIIA', fcom: 'B737NG/MAX FCOM 9.20 · A320/A321 FCOM PRO-NOR-SOP-15',    raDualProb: 0.92 },
  RGN: { baseCap: 'CAT-II',   fcom: 'CRJ-700/900 AOM 4-30 · E170/E190 FCOM 9.20',              raDualProb: 0.85 },
  BIZ: { baseCap: 'CAT-IIIA', fcom: 'G550/G650/Global/Falcon FCOM 6-22 HUD/CAT-III opt',       raDualProb: 0.90 },
  TBP: { baseCap: 'CAT-I',    fcom: 'Q400 AFM 4-20 · ATR-72 FCOM 4.04',                        raDualProb: 0.70 },
  GA:  { baseCap: 'NO',       fcom: 'POH §4 IFR',                                              raDualProb: 0.10 },
  FTR: { baseCap: 'NO',       fcom: 'NATOPS / -1 mil approach plate',                          raDualProb: 0.60 },
}

function classifyClass(type: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B77|B78|A35|A38|B74-?8/.test(t)) return 'HVY'
  if (/B76|B74|A33|A34|MD11/.test(t)) return 'HMB'
  if (/B73|B72|A22|A31|A32|MD8|MD9|A22/.test(t)) return 'NRW'
  if (/CRJ|E17|E19|E29|RJ85|F70|F100|AT[47]/.test(t)) return 'RGN'
  if (/G[VI458]|GLF|GLEX|CL[36]|FA[5789]|F2TH|E[35]5/.test(t)) return 'BIZ'
  if (/DH8|PC1|TBM|PT6|KING|BE20|C208|C30|DH3/.test(t)) return 'TBP'
  if (/F[-]?(15|16|18|22|35)|EFA|RAFL|MIG|SUKH|F[A-Z]{2,}\d/.test(t)) return 'FTR'
  return 'GA'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

type ChannelStatus = 'FO' | 'FP' | 'DEG' | 'INOP'
type Driver = 'CAT' | 'RVR' | 'EQUIP' | 'LITES' | 'XWND' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  CAT:   'Aircraft category below required',
  RVR:   'Reported RVR below CAT minima',
  EQUIP: 'Autoland channel / MEL degraded',
  LITES: 'Runway lighting insufficient',
  XWND:  'Crosswind above autoland limit',
  NONE:  'Nominal',
}

interface Airport {
  iata: string
  icao: string
  name: string
  lat: number
  lng: number
  elevFt: number
  cap: Cat
  rwyHdg: number       // primary landing runway magnetic heading (deg)
  lighting: 'ALSF-II' | 'HIALS' | 'SALS' | 'MALSR' | 'NONE'
  hasTDZL: boolean
  hasCL: boolean
}
// 48 catalogued airports
const AIRPORTS: Airport[] = [
  // CAT-IIIB hubs with ALSF-II + TDZL + centreline lights
  { iata:'LHR', icao:'EGLL', name:'London Heathrow',   lat:51.477, lng:-0.461, elevFt:83,   cap:'CAT-IIIB', rwyHdg:270, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'FRA', icao:'EDDF', name:'Frankfurt',         lat:50.033, lng: 8.570, elevFt:364,  cap:'CAT-IIIB', rwyHdg: 70, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'CDG', icao:'LFPG', name:'Paris CDG',         lat:49.010, lng: 2.547, elevFt:392,  cap:'CAT-IIIB', rwyHdg: 90, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'AMS', icao:'EHAM', name:'Amsterdam Schiphol',lat:52.308, lng: 4.764, elevFt:-11,  cap:'CAT-IIIB', rwyHdg:180, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'MUC', icao:'EDDM', name:'Munich',            lat:48.354, lng:11.786, elevFt:1487, cap:'CAT-IIIB', rwyHdg: 80, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'ZRH', icao:'LSZH', name:'Zurich',            lat:47.464, lng: 8.549, elevFt:1416, cap:'CAT-IIIB', rwyHdg:140, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'JFK', icao:'KJFK', name:'New York JFK',      lat:40.640, lng:-73.778, elevFt:13,  cap:'CAT-IIIB', rwyHdg:130, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'ORD', icao:'KORD', name:'Chicago O\'Hare',   lat:41.978, lng:-87.905, elevFt:672, cap:'CAT-IIIB', rwyHdg:280, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'SFO', icao:'KSFO', name:'San Francisco',     lat:37.619, lng:-122.375,elevFt:13,  cap:'CAT-IIIB', rwyHdg:280, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'SEA', icao:'KSEA', name:'Seattle-Tacoma',    lat:47.450, lng:-122.309,elevFt:433, cap:'CAT-IIIB', rwyHdg:160, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'DEN', icao:'KDEN', name:'Denver',            lat:39.862, lng:-104.673,elevFt:5431,cap:'CAT-IIIB', rwyHdg:170, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'ATL', icao:'KATL', name:'Atlanta',           lat:33.640, lng:-84.428, elevFt:1026,cap:'CAT-IIIB', rwyHdg: 90, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'IAD', icao:'KIAD', name:'Washington Dulles', lat:38.944, lng:-77.456, elevFt:313, cap:'CAT-IIIB', rwyHdg:190, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'MSP', icao:'KMSP', name:'Minneapolis-StPaul',lat:44.882, lng:-93.222, elevFt:841, cap:'CAT-IIIB', rwyHdg:300, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'MEM', icao:'KMEM', name:'Memphis',           lat:35.043, lng:-89.977, elevFt:341, cap:'CAT-IIIB', rwyHdg:180, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'MCI', icao:'KMCI', name:'Kansas City',       lat:39.297, lng:-94.714, elevFt:1026,cap:'CAT-IIIB', rwyHdg:190, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'MCO', icao:'KMCO', name:'Orlando',           lat:28.429, lng:-81.309, elevFt:96,  cap:'CAT-IIIB', rwyHdg:180, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'CLT', icao:'KCLT', name:'Charlotte',         lat:35.214, lng:-80.943, elevFt:748, cap:'CAT-IIIB', rwyHdg:180, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'DTW', icao:'KDTW', name:'Detroit',           lat:42.212, lng:-83.349, elevFt:645, cap:'CAT-IIIB', rwyHdg:220, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'BWI', icao:'KBWI', name:'Baltimore',         lat:39.176, lng:-76.668, elevFt:146, cap:'CAT-IIIB', rwyHdg:280, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'IAH', icao:'KIAH', name:'Houston Bush',      lat:29.984, lng:-95.341, elevFt:97,  cap:'CAT-IIIB', rwyHdg:260, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'HND', icao:'RJTT', name:'Tokyo Haneda',      lat:35.553, lng:139.781, elevFt:21,  cap:'CAT-IIIB', rwyHdg:340, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'NRT', icao:'RJAA', name:'Tokyo Narita',      lat:35.765, lng:140.386, elevFt:135, cap:'CAT-IIIB', rwyHdg:160, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'ICN', icao:'RKSI', name:'Seoul Incheon',     lat:37.469, lng:126.450, elevFt:23,  cap:'CAT-IIIB', rwyHdg:150, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'HKG', icao:'VHHH', name:'Hong Kong',         lat:22.308, lng:113.918, elevFt:28,  cap:'CAT-IIIB', rwyHdg: 70, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'SIN', icao:'WSSS', name:'Singapore Changi',  lat: 1.359, lng:103.989, elevFt:22,  cap:'CAT-IIIB', rwyHdg:200, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'FCO', icao:'LIRF', name:'Rome Fiumicino',    lat:41.800, lng:12.252,  elevFt:13,  cap:'CAT-IIIB', rwyHdg:160, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'MAD', icao:'LEMD', name:'Madrid Barajas',    lat:40.493, lng:-3.566,  elevFt:1998,cap:'CAT-IIIB', rwyHdg:320, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'HEL', icao:'EFHK', name:'Helsinki-Vantaa',   lat:60.317, lng:24.963,  elevFt:179, cap:'CAT-IIIB', rwyHdg: 40, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'ARN', icao:'ESSA', name:'Stockholm Arlanda', lat:59.652, lng:17.918,  elevFt:138, cap:'CAT-IIIB', rwyHdg: 10, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'OSL', icao:'ENGM', name:'Oslo Gardermoen',   lat:60.194, lng:11.100,  elevFt:681, cap:'CAT-IIIB', rwyHdg: 10, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  { iata:'BSL', icao:'LFSB', name:'Basel-Mulhouse',    lat:47.590, lng:7.529,   elevFt:885, cap:'CAT-IIIB', rwyHdg:150, lighting:'ALSF-II', hasTDZL:true,  hasCL:true  },
  // CAT-IIIA HIALS + TDZL
  { iata:'MAN', icao:'EGCC', name:'Manchester',        lat:53.354, lng:-2.275,  elevFt:257, cap:'CAT-IIIA', rwyHdg: 50, lighting:'HIALS',   hasTDZL:true,  hasCL:true  },
  { iata:'LTN', icao:'EGGW', name:'London Luton',      lat:51.874, lng:-0.368,  elevFt:526, cap:'CAT-IIIA', rwyHdg: 80, lighting:'HIALS',   hasTDZL:true,  hasCL:true  },
  { iata:'BCN', icao:'LEBL', name:'Barcelona',         lat:41.297, lng: 2.083,  elevFt:13,  cap:'CAT-IIIA', rwyHdg: 60, lighting:'HIALS',   hasTDZL:true,  hasCL:true  },
  { iata:'NAP', icao:'LIRN', name:'Naples',            lat:40.886, lng:14.291,  elevFt:294, cap:'CAT-IIIA', rwyHdg:240, lighting:'HIALS',   hasTDZL:true,  hasCL:true  },
  { iata:'PEK', icao:'ZBAA', name:'Beijing Capital',   lat:40.080, lng:116.585, elevFt:116, cap:'CAT-IIIA', rwyHdg:180, lighting:'HIALS',   hasTDZL:true,  hasCL:true  },
  { iata:'PVG', icao:'ZSPD', name:'Shanghai Pudong',   lat:31.143, lng:121.805, elevFt:13,  cap:'CAT-IIIA', rwyHdg:170, lighting:'HIALS',   hasTDZL:true,  hasCL:true  },
  { iata:'BOM', icao:'VABB', name:'Mumbai',            lat:19.089, lng:72.868,  elevFt:39,  cap:'CAT-IIIA', rwyHdg:270, lighting:'HIALS',   hasTDZL:true,  hasCL:true  },
  { iata:'RUH', icao:'OERK', name:'Riyadh',            lat:24.957, lng:46.699,  elevFt:2049,cap:'CAT-IIIA', rwyHdg:340, lighting:'HIALS',   hasTDZL:true,  hasCL:true  },
  // CAT-II MALSR
  { iata:'DCA', icao:'KDCA', name:'Washington Reagan', lat:38.852, lng:-77.038, elevFt:15,  cap:'CAT-II',   rwyHdg:190, lighting:'MALSR',   hasTDZL:true,  hasCL:false },
  { iata:'LAS', icao:'KLAS', name:'Las Vegas',         lat:36.080, lng:-115.152,elevFt:2181,cap:'CAT-II',   rwyHdg: 80, lighting:'MALSR',   hasTDZL:true,  hasCL:false },
  { iata:'SMF', icao:'KSMF', name:'Sacramento',        lat:38.695, lng:-121.591,elevFt:27,  cap:'CAT-II',   rwyHdg:170, lighting:'MALSR',   hasTDZL:false, hasCL:false },
  { iata:'SAN', icao:'KSAN', name:'San Diego',         lat:32.733, lng:-117.190,elevFt:17,  cap:'CAT-II',   rwyHdg:270, lighting:'MALSR',   hasTDZL:true,  hasCL:false },
  { iata:'MIA', icao:'KMIA', name:'Miami',             lat:25.795, lng:-80.290, elevFt:8,   cap:'CAT-II',   rwyHdg: 90, lighting:'MALSR',   hasTDZL:true,  hasCL:false },
  { iata:'PHL', icao:'KPHL', name:'Philadelphia',      lat:39.873, lng:-75.241, elevFt:36,  cap:'CAT-II',   rwyHdg: 90, lighting:'MALSR',   hasTDZL:true,  hasCL:false },
  { iata:'AUS', icao:'KAUS', name:'Austin-Bergstrom',  lat:30.194, lng:-97.669, elevFt:541, cap:'CAT-II',   rwyHdg:170, lighting:'MALSR',   hasTDZL:false, hasCL:false },
  { iata:'MNL', icao:'RPLL', name:'Manila',            lat:14.508, lng:121.020, elevFt:75,  cap:'CAT-II',   rwyHdg: 60, lighting:'MALSR',   hasTDZL:false, hasCL:false },
  // CAT-I only (SALS)
  { iata:'MRY', icao:'KMRY', name:'Monterey',          lat:36.587, lng:-121.843,elevFt:257, cap:'CAT-I',    rwyHdg:100, lighting:'SALS',    hasTDZL:false, hasCL:false },
  { iata:'ASE', icao:'KASE', name:'Aspen-Pitkin',      lat:39.223, lng:-106.869,elevFt:7838,cap:'CAT-I',    rwyHdg:150, lighting:'SALS',    hasTDZL:false, hasCL:false },
  { iata:'EGE', icao:'KEGE', name:'Eagle-Vail',        lat:39.643, lng:-106.918,elevFt:6548,cap:'CAT-I',    rwyHdg: 70, lighting:'SALS',    hasTDZL:false, hasCL:false },
  { iata:'ANC', icao:'PANC', name:'Anchorage',         lat:61.174, lng:-149.996,elevFt:152, cap:'CAT-I',    rwyHdg:310, lighting:'MALSR',   hasTDZL:false, hasCL:false },
  { iata:'HNL', icao:'PHNL', name:'Honolulu',          lat:21.318, lng:-157.922,elevFt:13,  cap:'CAT-I',    rwyHdg: 80, lighting:'MALSR',   hasTDZL:false, hasCL:false },
  { iata:'JNU', icao:'PAJN', name:'Juneau',            lat:58.355, lng:-134.576,elevFt:18,  cap:'CAT-I',    rwyHdg: 80, lighting:'SALS',    hasTDZL:false, hasCL:false },
  { iata:'DOH', icao:'OTHH', name:'Doha Hamad',        lat:25.273, lng:51.608,  elevFt:13,  cap:'CAT-I',    rwyHdg:160, lighting:'MALSR',   hasTDZL:false, hasCL:false },
]

interface Row {
  f: AutolandFlight
  klass: AcClass
  spec: ClassSpec
  channel: ChannelStatus
  acCap: Cat               // aircraft effective capability after MEL/channel
  acBaseCap: Cat
  apt: Airport
  distNm: number
  bearingDeg: number
  catReq: Cat              // lowest cat at which current RVR+ceiling meet mins
  rvrM: number             // reported TDZ RVR
  ceilingFt: number        // ceiling AGL
  windDirDeg: number
  windKt: number
  xwndKt: number
  effCat: Cat              // min(acCap, aptCap)
  meets: boolean           // catReq <= effCat
  rvrDeficit: number       // m, positive if below mins
  sev: { cat: number; rvr: number; equip: number; lites: number; xwnd: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'aut-halo', SRC_LBL = 'aut-lbl', SRC_PIN = 'aut-pin', SRC_APT = 'aut-apt', SRC_APTLBL = 'aut-aptlbl', SRC_PROJ = 'aut-proj'
const LYR_HALO = 'aut-halo-l', LYR_LBL = 'aut-lbl-l', LYR_PIN = 'aut-pin-l', LYR_APT = 'aut-apt-l', LYR_APTLBL = 'aut-aptlbl-l', LYR_PROJ = 'aut-proj-l'

function bearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180
  const Δλ = (lng2 - lng1) * Math.PI / 180
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}
function distNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180
  const dφ = (lat2 - lat1) * Math.PI / 180, dλ = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dφ/2)**2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ/2)**2
  return 2 * R * Math.asin(Math.sqrt(a))
}
function downgradeCap(c: Cat, steps: number): Cat {
  const r = Math.max(0, CAT_RANK[c] - steps)
  return (CAT_LIST.find(k => CAT_RANK[k] === r) || 'NO') as Cat
}

export default function AutolandLvo({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [capFilter, setCapFilter] = useState<Cat | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [captureNm, setCaptureNm] = useState(100)
  const [rvrOffset, setRvrOffset] = useState(0)        // -2000..+2000 m bias
  const [windMul, setWindMul] = useState(100)          // 50..200
  const [melRate, setMelRate] = useState(8)            // 0..30 % deferred
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showApt, setShowApt] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  // Live per-airport weather sampled per minute-bucket
  const aptWx = useMemo(() => {
    const bucket = Math.floor(Date.now() / 60000)
    const m = new Map<string, { rvrM: number; ceilingFt: number; windDirDeg: number; windKt: number }>()
    for (const a of AIRPORTS) {
      const h = hash32(a.iata + ':' + bucket)
      // RVR distribution: 25% below CAT-I (300-1200m), 50% normal (1500-5000m), 25% great (5000-6000m)
      const r = (h % 1000) / 1000
      let rvr: number
      if (r < 0.25) rvr = 200 + ((h >>> 5) % 1000)
      else if (r < 0.75) rvr = 1500 + ((h >>> 7) % 3500)
      else rvr = 5000 + ((h >>> 9) % 1000)
      // ceiling: tend low when RVR low
      const ceiling = rvr < 800 ? 50 + ((h >>> 11) % 250)
                    : rvr < 1600 ? 200 + ((h >>> 11) % 600)
                    : 1500 + ((h >>> 11) % 3500)
      const windDir = (h >>> 13) % 360
      const windKt = 4 + ((h >>> 17) % 30)
      m.set(a.iata, {
        rvrM: Math.max(75, rvr + rvrOffset),
        ceilingFt: ceiling,
        windDirDeg: windDir,
        windKt: windKt * (windMul / 100),
      })
    }
    return m
  }, [rvrOffset, windMul])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      if (f.altitudeFt / 100 < minFl) continue
      // Only consider arrival-phase aircraft: descending and below FL120
      if (f.altitudeFt / 100 > 120) continue
      if (f.vertRate > -100) continue
      const klass = classifyClass(f.type || '')
      const spec = CLASS_SPEC[klass]
      const h = hash32(f.icao || '')
      // Find best-matching airport on projected track within capture range
      let bestApt: Airport | null = null
      let bestDist = Infinity
      let bestBrg = 0
      for (const a of AIRPORTS) {
        const d = distNm(f.lat, f.lng, a.lat, a.lng)
        if (d > captureNm) continue
        const brg = bearing(f.lat, f.lng, a.lat, a.lng)
        const off = Math.abs(((brg - f.track + 540) % 360) - 180)
        if (off > 60) continue
        if (d < bestDist) { bestDist = d; bestApt = a; bestBrg = brg }
      }
      if (!bestApt) continue
      const wx = aptWx.get(bestApt.iata)!
      // Per-airframe channel status
      const chRoll = (h >>> 3) % 1000
      let channel: ChannelStatus
      if (spec.baseCap === 'NO') channel = 'INOP'
      else if (chRoll < 600) channel = 'FO'
      else if (chRoll < 900) channel = 'FP'
      else if (chRoll < 980) channel = 'DEG'
      else channel = 'INOP'
      // MEL deferral
      const melRoll = (h >>> 11) % 1000
      const melDeferred = melRoll < melRate * 10
      // RA dual?
      const raDual = ((h >>> 17) % 100) / 100 < spec.raDualProb
      // Effective aircraft capability
      let downgrades = 0
      if (channel === 'FP') downgrades += 1
      else if (channel === 'DEG') downgrades += 2
      else if (channel === 'INOP') downgrades = 99
      if (melDeferred) downgrades += 1
      if (!raDual) downgrades += 1
      const acCap = downgradeCap(spec.baseCap, downgrades)
      // Airport effective capability is fixed by infrastructure
      const aptCap = bestApt.cap
      // Effective combined capability = min
      const effRank = Math.min(CAT_RANK[acCap], CAT_RANK[aptCap])
      const effCat = (CAT_LIST.find(k => CAT_RANK[k] === effRank) || 'NO') as Cat
      // catReq: lowest cat where RVR+ceiling are sufficient
      let catReq: Cat = 'CAT-IIIC'
      for (const c of [...CAT_LIST].reverse()) {
        if (wx.rvrM >= CAT_RVR_M[c] && wx.ceilingFt >= CAT_DH_FT[c]) { catReq = c; break }
      }
      // Crosswind on landing runway
      const rwyDeg = bestApt.rwyHdg
      const ang = ((wx.windDirDeg - rwyDeg + 540) % 360) - 180
      const xwndKt = Math.abs(Math.sin(ang * Math.PI / 180) * wx.windKt)
      // Severities
      const catGap = CAT_RANK[catReq] - CAT_RANK[effCat]
      const catSev = catGap <= 0 ? 0 : Math.min(100, 40 + catGap * 25)
      const rvrDeficit = CAT_RVR_M[effCat] - wx.rvrM
      const rvrSev = rvrDeficit <= 0 ? 0 : Math.min(100, (rvrDeficit / 150) * 100)
      let equipSev = 0
      if (channel === 'INOP') equipSev = 100
      else if (channel === 'DEG') equipSev = 75
      else if (channel === 'FP' && CAT_RANK[catReq] >= CAT_RANK['CAT-IIIB']) equipSev = 60
      else if (melDeferred) equipSev = 35
      else if (!raDual && CAT_RANK[catReq] >= CAT_RANK['CAT-II']) equipSev = 30
      let litesSev = 0
      // CAT-IIIB needs ALSF-II+TDZL+CL; CAT-IIIA needs HIALS+TDZL; CAT-II needs MALSR+TDZL
      if (CAT_RANK[catReq] >= CAT_RANK['CAT-IIIB']) {
        if (bestApt.lighting !== 'ALSF-II' || !bestApt.hasTDZL || !bestApt.hasCL) litesSev = 100
      } else if (CAT_RANK[catReq] >= CAT_RANK['CAT-IIIA']) {
        if (!(bestApt.lighting === 'ALSF-II' || bestApt.lighting === 'HIALS') || !bestApt.hasTDZL) litesSev = 80
      } else if (CAT_RANK[catReq] >= CAT_RANK['CAT-II']) {
        if (bestApt.lighting === 'SALS' || bestApt.lighting === 'NONE') litesSev = 55
      }
      // Crosswind limit
      const xLim = CAT_XWND_KT[catReq] || 30
      const xwndSev = xwndKt <= xLim - 4 ? 0 : xwndKt >= xLim + 6 ? 100 : ((xwndKt - (xLim - 4)) / 10) * 100
      const drvList: Array<[Driver, number]> = [
        ['CAT', catSev], ['RVR', rvrSev], ['EQUIP', equipSev], ['LITES', litesSev], ['XWND', xwndSev],
      ]
      drvList.sort((a, b) => b[1] - a[1])
      const driver: Driver = drvList[0][1] > 0 ? drvList[0][0] : 'NONE'
      const score = drvList[0][1]
      let tier: Tier
      if ((CAT_RANK[catReq] > CAT_RANK[effCat] && rvrDeficit > 50) || score >= 80) tier = 'UNABLE'
      else if (score >= 55) tier = 'RESTRICT'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'
      out.push({
        f, klass, spec, channel,
        acCap, acBaseCap: spec.baseCap, apt: bestApt,
        distNm: bestDist, bearingDeg: bestBrg,
        catReq,
        rvrM: wx.rvrM, ceilingFt: wx.ceilingFt,
        windDirDeg: wx.windDirDeg, windKt: wx.windKt, xwndKt,
        effCat, meets: CAT_RANK[catReq] <= CAT_RANK[effCat],
        rvrDeficit,
        sev: { cat: catSev, rvr: rvrSev, equip: equipSev, lites: litesSev, xwnd: xwndSev },
        score, driver, tier,
      })
    }
    return out
  }, [flights, minFl, captureNm, aptWx, melRate])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { UNABLE: 0, RESTRICT: 0, WATCH: 0, OK: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumDef = 0, sumXw = 0, worst = 0, worstCs = '', worstScore = 0
    let unable = 0, foN = 0, xwndN = 0, count = 0
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      count++
      if (r.rvrDeficit > 0) sumDef += r.rvrDeficit
      sumXw += r.xwndKt
      if (r.tier === 'UNABLE') unable++
      if (r.channel === 'FO') foN++
      if (r.sev.xwnd > 50) xwndN++
      if (r.score > worst) { worst = r.score; worstCs = (r.f.callsign || r.f.icao).trim(); worstScore = r.score }
    }
    return {
      meanDeficit: count ? sumDef / count : 0,
      meanXwnd: count ? sumXw / count : 0,
      worst, worstCs, worstScore, unable,
      foShare: count ? foN / count : 0,
      xwndShare: count ? xwndN / count : 0,
      activeCount: count,
    }
  }, [rows])

  const aptAggs = useMemo(() => {
    const m = new Map<string, { apt: Airport; count: number; sumScore: number; worst: number; worstCs: string; worstIcao: string; worstTier: Tier; unable: number }>()
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      let a = m.get(r.apt.iata)
      if (!a) { a = { apt: r.apt, count: 0, sumScore: 0, worst: 0, worstCs: '', worstIcao: '', worstTier: 'OK', unable: 0 }; m.set(r.apt.iata, a) }
      a.count++; a.sumScore += r.score
      if (r.tier === 'UNABLE') a.unable++
      if (TIER_RANK[r.tier] < TIER_RANK[a.worstTier]) a.worstTier = r.tier
      if (r.score > a.worst) { a.worst = r.score; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao }
    }
    const arr = Array.from(m.values()).map(a => ({ ...a, meanScore: a.count ? a.sumScore / a.count : 0 }))
    arr.sort((a, b) => {
      const ti = TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier]
      if (ti !== 0) return ti
      return b.count - a.count
    })
    return arr
  }, [rows])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows
      .filter(r => r.tier !== 'IDLE')
      .filter(r => {
        if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
        if (classFilter !== 'ALL' && r.klass !== classFilter) return false
        if (capFilter !== 'ALL' && r.acCap !== capFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.apt.iata].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.score - a.score
      })
  }, [rows, tierFilter, classFilter, capFilter, query])

  const filteredAirports = useMemo(() => {
    const q = query.trim().toUpperCase()
    return aptAggs.filter(a => {
      if (tierFilter !== 'ALL' && a.worstTier !== tierFilter) return false
      if (capFilter !== 'ALL' && a.apt.cap !== capFilter) return false
      if (!q) return true
      return (a.apt.iata + ' ' + a.apt.name).toUpperCase().includes(q)
    })
  }, [aptAggs, tierFilter, capFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.filter(r => r.tier !== 'OK' && r.tier !== 'IDLE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.score / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'RESTRICT' || r.tier === 'UNABLE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ${r.apt.iata} ${r.acCap}\u203a${r.catReq} ${r.driver}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'UNABLE').map(r => ({
      type: 'Feature' as const,
      properties: { color: '#ef4444', text: `\u203a ${r.apt.iata} need ${r.catReq} have ${r.effCat} RVR ${r.rvrM.toFixed(0)}m` },
      geometry: { type: 'Point' as const, coordinates: [r.apt.lng, r.apt.lat] },
    })) : [] }

    const projFeatures: any[] = []
    if (showProj) {
      for (const r of rows) {
        if (r.tier !== 'UNABLE' && r.tier !== 'RESTRICT') continue
        const coords: [number, number][] = []
        const segs = 16
        for (let i = 0; i <= segs; i++) {
          const t = i / segs
          coords.push([r.f.lng + (r.apt.lng - r.f.lng) * t, r.f.lat + (r.apt.lat - r.f.lat) * t])
        }
        projFeatures.push({ type: 'Feature' as const, properties: { color: TIER_COLOR[r.tier] }, geometry: { type: 'LineString' as const, coordinates: coords } })
      }
    }
    const projFc = { type: 'FeatureCollection' as const, features: projFeatures }

    const aptFeatures: any[] = []
    const aptLblFeatures: any[] = []
    if (showApt) {
      // Build set of in-use airports for highlighting
      const inUse = new Set(rows.filter(r => r.tier !== 'IDLE').map(r => r.apt.iata))
      for (const a of AIRPORTS) {
        const baseColor = a.cap === 'CAT-IIIB' ? '#ef4444' : a.cap === 'CAT-IIIA' ? '#f59e0b' : a.cap === 'CAT-II' ? '#0ea5e9' : '#64748b'
        const color = inUse.has(a.iata) ? '#38bdf8' : baseColor
        aptFeatures.push({
          type: 'Feature' as const, properties: { color, opacity: inUse.has(a.iata) ? 0.85 : 0.35 },
          geometry: { type: 'Point' as const, coordinates: [a.lng, a.lat] },
        })
        const wx = aptWx.get(a.iata)
        aptLblFeatures.push({
          type: 'Feature' as const,
          properties: { color, text: `${a.iata} ${a.cap.replace('CAT-','')} ${wx ? Math.round(wx.rvrM) + 'm' : ''}` },
          geometry: { type: 'Point' as const, coordinates: [a.lng, a.lat] },
        })
      }
    }
    const aptFc = { type: 'FeatureCollection' as const, features: aptFeatures }
    const aptLblFc = { type: 'FeatureCollection' as const, features: aptLblFeatures }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_APT, aptFc, () => map.addLayer({ id: LYR_APT, type: 'circle', source: SRC_APT, paint: {
        'circle-radius': 3, 'circle-color': ['get', 'color'], 'circle-opacity': ['get','opacity'],
        'circle-stroke-color': ['get','color'], 'circle-stroke-width': 0.8, 'circle-stroke-opacity': 0.7,
      } }))
      ensure(SRC_APTLBL, aptLblFc, () => map.addLayer({ id: LYR_APTLBL, type: 'symbol', source: SRC_APTLBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 9, 'text-offset': [0, 0.8], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get','color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2, 'text-opacity': 0.85 } }))
      ensure(SRC_PROJ, projFc, () => map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [3, 3],
      } }))
      ensure(SRC_HALO, haloFc, () => map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.14,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: {
        'text-field': ['get', 'text'], 'text-size': 10,
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-offset': [0, -1.5], 'text-anchor': 'bottom', 'icon-allow-overlap': true,
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.6 } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_PROJ, LYR_APTLBL, LYR_APT]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_PROJ, SRC_APTLBL, SRC_APT]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, aptWx, showHalo, showLabels, showPin, showProj, showApt])

  // SVG diagram: RVR-m (x) vs ceiling-ft (y) with CAT bands
  const diag = useMemo(() => {
    const W = 360, H = 180, PAD = 30
    const xMax = 3000, yMax = 1500
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, v / xMax)) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, v / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMax, yMax }
  }, [])

  const tierColorOf = (s: number) => s >= 80 ? '#ef4444' : s >= 55 ? '#f59e0b' : s >= 25 ? '#0ea5e9' : '#10b981'
  const adviceFor = (r: Row): string => {
    if (r.tier === 'UNABLE') {
      if (r.driver === 'CAT') return `Aircraft cap ${r.acCap} below required ${r.catReq} at ${r.apt.iata} — divert to alternate per 14 CFR 121.619, request CAT-I clearance only`
      if (r.driver === 'RVR') return `RVR ${r.rvrM.toFixed(0)}m below ${r.catReq} mins ${CAT_RVR_M[r.catReq]}m — hold for improvement or divert`
      if (r.driver === 'EQUIP') return `Autoland ${r.channel} with MEL/RA gap — file CAT-I only, brief no-autoland landing`
      if (r.driver === 'XWND') return `Crosswind ${r.xwndKt.toFixed(0)}kt exceeds ${r.catReq} autoland limit ${CAT_XWND_KT[r.catReq]}kt — request alternate runway`
      if (r.driver === 'LITES') return `${r.apt.iata} lighting (${r.apt.lighting}) insufficient for ${r.catReq} — request CAT-II/I procedure`
      return 'Unable to meet LVO criteria — divert per 14 CFR 121.651'
    }
    if (r.tier === 'RESTRICT') return `Fly to ${r.acCap} mins only — brief crew autoland ${r.channel} fail-passive go-around required if below DH`
    if (r.tier === 'WATCH') return 'Within mins with low margin — brief rapid-deterioration go-around criteria, monitor RVR trend'
    return `Fully equipped ${r.acCap} autoland — RVR ${r.rvrM.toFixed(0)}m / ceiling ${r.ceilingFt}ft within ${r.catReq} mins`
  }

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Autoland · LVO Compliance</span>
        <span className="text-[10px] text-slate-500 ml-auto">{summary.activeCount} ac · {summary.unable} UNABLE</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[9px] font-bold" style={{ color: TIER_COLOR[t] }}>{t}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean RVR deficit</div>
          <div className="font-mono text-sm" style={{ color: summary.meanDeficit > 150 ? '#ef4444' : summary.meanDeficit > 50 ? '#f59e0b' : summary.meanDeficit > 0 ? '#0ea5e9' : '#10b981' }}>{summary.meanDeficit.toFixed(0)}m</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] truncate" style={{ color: tierColorOf(summary.worstScore) }}>{summary.worstCs || '—'}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Unable</div>
          <div className="font-mono text-sm text-rose-400">{summary.unable}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">FO-channel share</div>
          <div className="font-mono text-[11px]" style={{ color: summary.foShare < 0.5 ? '#ef4444' : summary.foShare < 0.7 ? '#f59e0b' : '#10b981' }}>{(summary.foShare * 100).toFixed(0)}%</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean xwnd</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanXwnd > 20 ? '#ef4444' : summary.meanXwnd > 12 ? '#f59e0b' : '#10b981' }}>{summary.meanXwnd.toFixed(0)}kt</div>
        </div>
      </div>

      {/* Diagram: RVR vs ceiling with CAT bands */}
      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg viewBox={`0 0 ${diag.W} ${diag.H}`} className="w-full h-auto">
            {/* CAT band rectangles */}
            <rect x={diag.PAD} y={6}                 width={diag.xs(200)-diag.PAD}    height={diag.H-30-6} fill="#ef4444" opacity={0.08} />
            <rect x={diag.xs(200)} y={6}             width={diag.xs(550)-diag.xs(200)} height={diag.H-30-6} fill="#f59e0b" opacity={0.07} />
            <rect x={diag.xs(550)} y={6}             width={diag.xs(1600)-diag.xs(550)} height={diag.H-30-6} fill="#0ea5e9" opacity={0.06} />
            <rect x={diag.xs(1600)} y={6}            width={diag.W-6-diag.xs(1600)}   height={diag.H-30-6} fill="#10b981" opacity={0.05} />
            {/* CAT verticals */}
            {([['III B', 75],['III A', 200],['II', 300],['I', 550],['NPA', 1600]] as Array<[string,number]>).map(([l,v]) => (
              <g key={l}>
                <line x1={diag.xs(v)} y1={6} x2={diag.xs(v)} y2={diag.H - 22} stroke="#475569" strokeWidth={0.5} strokeDasharray="2 3" />
                <text x={diag.xs(v)+2} y={14} fill="#64748b" fontSize={8}>{l}</text>
              </g>
            ))}
            {/* gridlines */}
            {[1000, 2000].map(v => (
              <g key={'x'+v}>
                <text x={diag.xs(v)} y={diag.H - 12} fill="#64748b" fontSize={8} textAnchor="middle">{v}m</text>
              </g>
            ))}
            {[100, 500, 1000].map(v => (
              <g key={'y'+v}>
                <line x1={diag.PAD} y1={diag.ys(v)} x2={diag.W - 6} y2={diag.ys(v)} stroke="#334155" strokeWidth={0.4} strokeDasharray="2 3" />
                <text x={4} y={diag.ys(v) + 3} fill="#64748b" fontSize={8}>{v}ft</text>
              </g>
            ))}
            {/* dots: rvr × ceiling */}
            {rows.filter(r => r.tier !== 'IDLE').slice(0, 800).map((r, i) => (
              <circle key={i} cx={diag.xs(r.rvrM)} cy={diag.ys(r.ceilingFt)} r={2} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
            <text x={diag.W - 6} y={diag.H - 2} fill="#475569" fontSize={8} textAnchor="end">RVR m · ceiling AGL ft</text>
          </svg>
        </div>
      )}

      {/* sliders */}
      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>Min FL</span><span className="text-slate-300 font-mono">{minFl}</span></span>
          <input type="range" min={0} max={400} step={10} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>Capture nm</span><span className="text-slate-300 font-mono">{captureNm}</span></span>
          <input type="range" min={20} max={200} step={10} value={captureNm} onChange={e => setCaptureNm(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>RVR bias</span><span className="text-slate-300 font-mono">{rvrOffset>=0?'+':''}{rvrOffset}m</span></span>
          <input type="range" min={-2000} max={2000} step={100} value={rvrOffset} onChange={e => setRvrOffset(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>Wind ×</span><span className="text-slate-300 font-mono">{windMul}%</span></span>
          <input type="range" min={50} max={200} step={5} value={windMul} onChange={e => setWindMul(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest col-span-2">
          <span className="flex justify-between"><span>MEL deferral rate</span><span className="text-slate-300 font-mono">{melRate}%</span></span>
          <input type="range" min={0} max={30} step={1} value={melRate} onChange={e => setMelRate(+e.target.value)} className="accent-sky-500" />
        </label>
      </div>

      {/* chip filters: class + cap */}
      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {CLASS_LIST.map(c => {
          const on = classFilter === c
          return <button key={c} onClick={() => setClassFilter(on ? 'ALL' : c)}
            className={`px-1.5 py-0.5 rounded border text-[10px] font-mono transition ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'border-slate-800 text-slate-400 hover:text-slate-200'}`}>{c}</button>
        })}
      </div>
      <div className="flex flex-wrap gap-1 px-3 py-1 border-b border-slate-800">
        {(['CAT-I','CAT-II','CAT-IIIA','CAT-IIIB'] as Cat[]).map(c => {
          const on = capFilter === c
          return <button key={c} onClick={() => setCapFilter(on ? 'ALL' : c)}
            className={`px-1.5 py-0.5 rounded border text-[9px] font-mono transition ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'border-slate-800 text-slate-400 hover:text-slate-200'}`}>{c}</button>
        })}
      </div>

      <div className="flex items-center gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLabels, setShowLabels], ['PROJ', showProj, setShowProj], ['APT', showApt, setShowApt], ['DIAG', showDiag, setShowDiag]] as const).map(([l, v, fn]) => (
          <button key={l} onClick={() => (fn as any)((x: boolean) => !x)}
            className={`px-1.5 py-0.5 rounded border text-[10px] font-mono transition ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'border-slate-800 text-slate-500'}`}>{l}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search…"
          className="ml-auto bg-slate-900 border border-slate-800 rounded px-2 py-0.5 text-[10px] text-slate-200 placeholder:text-slate-600 w-24 focus:outline-none focus:border-sky-500/40" />
      </div>

      <div className="flex border-b border-slate-800 text-[10px]">
        {(['AIRCRAFT', 'AIRPORTS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 py-1.5 uppercase tracking-widest font-bold ${tab === t ? 'text-sky-300 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-8 text-center text-slate-500 text-[11px]">No aircraft on approach.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => (
          <button key={r.f.icao + r.apt.iata} onClick={() => onFly(r.f.icao)}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/70 transition relative">
            <span className="absolute left-0 top-0 bottom-0 w-0.5" style={{ background: TIER_COLOR[r.tier] }} />
            <div className="flex items-center gap-1.5">
              <span className="font-mono font-bold text-slate-100">{(r.f.callsign || r.f.icao).trim()}</span>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              <span className="text-[9px] font-mono px-1 rounded border border-slate-800 text-slate-400">{r.klass}</span>
              <span className="text-[9px] font-mono px-1 rounded border border-sky-500/40 text-sky-200">{r.apt.iata}</span>
              <span className="text-[9px] font-mono px-1 rounded border ml-auto" style={{ borderColor: TIER_COLOR[r.tier], color: TIER_COLOR[r.tier] }}>{r.tier}</span>
            </div>
            <div className="flex items-baseline gap-2 mt-0.5 text-[10px] font-mono text-slate-400">
              <span style={{ color: CAT_RANK[r.acCap] < CAT_RANK[r.catReq] ? '#ef4444' : '#10b981' }}>{r.acCap}</span>
              <span className="text-slate-600">need {r.catReq}</span>
              <span style={{ color: r.rvrDeficit > 0 ? '#ef4444' : r.rvrDeficit > -200 ? '#f59e0b' : '#10b981' }}>RVR {r.rvrM.toFixed(0)}m</span>
              <span style={{ color: r.ceilingFt < CAT_DH_FT[r.catReq] + 50 ? '#f59e0b' : '#10b981' }}>CIG {r.ceilingFt}ft</span>
              <span style={{ color: r.xwndKt > CAT_XWND_KT[r.catReq] ? '#ef4444' : r.xwndKt > CAT_XWND_KT[r.catReq] - 4 ? '#f59e0b' : '#10b981' }}>X{r.xwndKt.toFixed(0)}</span>
            </div>
            <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden relative">
              <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, r.score)}%`, background: TIER_COLOR[r.tier] }} />
              <div className="absolute inset-y-0" style={{ left: '25%', width: 1, background: '#0ea5e966' }} />
              <div className="absolute inset-y-0" style={{ left: '55%', width: 1, background: '#f59e0b66' }} />
              <div className="absolute inset-y-0" style={{ left: '80%', width: 1, background: '#ef444466' }} />
            </div>
            <div className="flex flex-wrap gap-1 mt-1 text-[9px] font-mono">
              {(['CAT', 'RVR', 'EQUIP', 'LITES', 'XWND'] as const).map(k => {
                const v = (r.sev as any)[k.toLowerCase()] as number
                return <span key={k} className="px-1 rounded border" style={{ borderColor: tierColorOf(v) + '88', color: tierColorOf(v) }}>{k} {v.toFixed(0)}</span>
              })}
            </div>
            <div className="flex flex-wrap gap-1 mt-1 text-[9px] font-mono text-slate-400">
              <span className="px-1 rounded border" style={{ borderColor: r.channel === 'FO' ? '#10b98188' : r.channel === 'FP' ? '#f59e0b88' : '#ef444488', color: r.channel === 'FO' ? '#10b981' : r.channel === 'FP' ? '#f59e0b' : '#ef4444' }}>CH {r.channel}</span>
              <span className="px-1 rounded border border-slate-800">DIST {r.distNm.toFixed(0)}nm</span>
              <span className="px-1 rounded border border-slate-800">{r.apt.lighting}</span>
              <span className="px-1 rounded border border-slate-800">RW{r.apt.rwyHdg.toString().padStart(3,'0')}</span>
              <span className="px-1 rounded border border-slate-800">WND {Math.round(r.windDirDeg).toString().padStart(3,'0')}/{Math.round(r.windKt)}</span>
            </div>
            <div className="mt-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>{adviceFor(r)}</div>
            <div className="mt-0.5 text-[9px] text-slate-600">{r.spec.fcom} · {r.f.operator || '—'}</div>
          </button>
        ))}
        {tab === 'AIRPORTS' && filteredAirports.length === 0 && (
          <div className="px-3 py-8 text-center text-slate-500 text-[11px]">No airports with inbound traffic.</div>
        )}
        {tab === 'AIRPORTS' && filteredAirports.map(a => {
          const wx = aptWx.get(a.apt.iata)!
          return (
            <button key={a.apt.iata} onClick={() => a.worstIcao && onFly(a.worstIcao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/70 transition relative">
              <span className="absolute left-0 top-0 bottom-0 w-0.5" style={{ background: TIER_COLOR[a.worstTier] }} />
              <div className="flex items-center gap-1.5">
                <span className="font-mono font-bold text-slate-100">{a.apt.iata}</span>
                <span className="text-slate-500 text-[10px] truncate">{a.apt.name}</span>
                <span className="text-[9px] font-mono px-1 rounded border border-slate-800 text-slate-300">{a.apt.cap}</span>
                <span className="text-[9px] font-mono px-1 rounded border ml-auto" style={{ borderColor: TIER_COLOR[a.worstTier], color: TIER_COLOR[a.worstTier] }}>{a.worstTier}</span>
              </div>
              <div className="flex items-baseline gap-2 mt-0.5 text-[10px] font-mono text-slate-400">
                <span style={{ color: wx.rvrM < 200 ? '#ef4444' : wx.rvrM < 550 ? '#f59e0b' : wx.rvrM < 1600 ? '#0ea5e9' : '#10b981' }}>RVR {wx.rvrM.toFixed(0)}m</span>
                <span style={{ color: wx.ceilingFt < 100 ? '#ef4444' : wx.ceilingFt < 500 ? '#f59e0b' : '#10b981' }}>CIG {wx.ceilingFt}ft</span>
                <span>WND {Math.round(wx.windDirDeg).toString().padStart(3,'0')}/{Math.round(wx.windKt)}</span>
                <span className="ml-auto">{a.count} ac{a.unable > 0 && <span className="text-rose-400"> · {a.unable} UNABLE</span>}</span>
              </div>
              <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden relative">
                <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, a.meanScore)}%`, background: TIER_COLOR[a.worstTier] }} />
              </div>
              <div className="mt-0.5 text-[9px] text-slate-600">{a.apt.lighting} · {a.apt.hasTDZL ? 'TDZL' : 'no-TDZL'} · {a.apt.hasCL ? 'CL' : 'no-CL'} · elev {a.apt.elevFt}ft · worst {a.worstCs}</div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        FAA AC 120-29A · AC 120-28D · AC 120-118 · 14 CFR 121.651 · ICAO Doc 9365 · EASA AMC1 CAT.OP.MPA.110 · Boeing FCOM 9.20 SP.16 · Airbus FCOM PRO-NOR-SOP-15
      </div>
    </div>
  )
}
