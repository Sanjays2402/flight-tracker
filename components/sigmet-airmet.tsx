'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   SIGMET / AIRMET · MWO hazard polygon penetration monitor
   -----------------------------------------------------------
   Per-airframe enroute scorer correlating each tracked target
   against active SIGMET (Significant Meteorological Information)
   and AIRMET (Airmen's Meteorological Information) polygons
   issued by Meteorological Watch Offices (MWO) per ICAO Annex 3
   Appendix 6 and disseminated through the WAFS WIFS bundle /
   FAA AWC / EUROCONTROL ATM-MET portal.

   Each bulletin carries a 4-5 vertex polygon, an FL band, a
   phenomenon class, a forecast/valid window, and a movement
   vector (speed kt + bearing deg).  We test:
     · current geometric containment of target lat/lng
     · forward-track projection through polygon over LOOK-AH min
     · vertical FL overlap incl. ± buffer
     · hazard severity weight (e.g. SEV TURB > MOD TURB)
     · phenomenon-vs-airframe susceptibility
     · validity countdown (decay toward VALID-TO time)
     · polygon-edge proximity for awareness

   References
     · ICAO Annex 3 §7 & Appendix 6 SIGMET/AIRMET specifications
     · ICAO Doc 8896 Manual of Aero Meteorology §7, §10
     · ICAO Doc 7488 WAFC global SIGWX forecasting
     · WMO No.49 Vol II §11 & WMO No.485 Manual on the GDPFS
     · WMO No.731 GAMET Area Forecast
     · FAA AC 00-45H §9 In-Flight Weather Advisories
     · FAA AC 00-24C Thunderstorms
     · FAA AIM 7-1-6 SIGMET / 7-1-7 Convective SIGMET / 7-1-8 AIRMET
     · FAA Order JO 7110.65 §2-6-3 hazardous weather advisories
     · NWS Instruction 10-811 AWC SIGMET / AIRMET / Convective SIGMET
     · NWS WSOM E-32 AWC hazardous weather product specification
     · ICAO Doc 4444 PANS-ATM §4.10 MET information to ATS units
     · ICAO Doc 9613 PBN Vol I §A2 weather considerations
     · EUROCONTROL ATM-MET Implementation Specification ed 1.2
     · IATA Hazardous Weather Avoidance Guidance Material 2022
     · NTSB AAR-94-04 USAir 1016 CLT microburst (Conv SIGMET miss)
     · NTSB AAR-79-09 Pan Am 759 NEW LLWS (Conv SIGMET pattern)
     · NTSB AAR-09-01 Colgan 3407 BUF (AIRMET ZULU icing)
     · ATSB AO-2008-070 Qantas 30 SEV TURB SIGMET ECHO area
     · NTSB DCA17FA021 N121JM TEB upset (SIGMET ALFA turbulence)
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'PENETRATE' | 'IMMINENT' | 'FORECAST' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  PENETRATE: '#ef4444', IMMINENT: '#f43f5e', FORECAST: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['PENETRATE', 'IMMINENT', 'FORECAST', 'WATCH', 'OK']
const TIER_RANK: Record<Tier, number> = { PENETRATE: 0, IMMINENT: 1, FORECAST: 2, WATCH: 3, OK: 4, IDLE: 5 }

type Kind = 'SIGMET' | 'CONV-SIGMET' | 'AIRMET' | 'GAMET' | 'VAA-SIGMET'
const KIND_COLOR: Record<Kind, string> = {
  SIGMET: '#ef4444', 'CONV-SIGMET': '#f43f5e', AIRMET: '#f59e0b', GAMET: '#0ea5e9', 'VAA-SIGMET': '#a855f7',
}

type Phenom =
  | 'OBSC-TS' | 'EMBD-TS' | 'FRQ-TS' | 'SQL-TS'          // SIGMET TS
  | 'SEV-TURB' | 'MOD-TURB'                              // Turb
  | 'SEV-ICE' | 'MOD-ICE' | 'SEV-ICE-FZRA'               // Icing
  | 'SEV-MTW'                                            // Mtn wave
  | 'HVY-DS' | 'HVY-SS'                                  // Dust/Sand
  | 'VA-CLD' | 'RDOACT-CLD'                              // Volcanic / Radioactive
  | 'IFR' | 'MTN-OBSC' | 'STG-SFC-WIND' | 'LLWS'         // AIRMET
const PHENOM_COLOR: Record<Phenom, string> = {
  'OBSC-TS': '#ef4444', 'EMBD-TS': '#ef4444', 'FRQ-TS': '#ef4444', 'SQL-TS': '#f43f5e',
  'SEV-TURB': '#ef4444', 'MOD-TURB': '#f59e0b',
  'SEV-ICE': '#ef4444', 'MOD-ICE': '#0ea5e9', 'SEV-ICE-FZRA': '#ef4444',
  'SEV-MTW': '#8b5cf6',
  'HVY-DS': '#eab308', 'HVY-SS': '#eab308',
  'VA-CLD': '#a855f7', 'RDOACT-CLD': '#a855f7',
  IFR: '#64748b', 'MTN-OBSC': '#94a3b8', 'STG-SFC-WIND': '#f59e0b', LLWS: '#f43f5e',
}
const PHENOM_SEV: Record<Phenom, number> = {
  'OBSC-TS': 0.92, 'EMBD-TS': 1.00, 'FRQ-TS': 0.95, 'SQL-TS': 1.00,
  'SEV-TURB': 0.95, 'MOD-TURB': 0.55,
  'SEV-ICE': 0.92, 'MOD-ICE': 0.55, 'SEV-ICE-FZRA': 1.00,
  'SEV-MTW': 0.85,
  'HVY-DS': 0.55, 'HVY-SS': 0.55,
  'VA-CLD': 1.00, 'RDOACT-CLD': 1.00,
  IFR: 0.35, 'MTN-OBSC': 0.45, 'STG-SFC-WIND': 0.50, LLWS: 0.85,
}

type Phase = 'TKO' | 'CLB' | 'CRZ' | 'DES' | 'APP' | 'GND' | 'OTHER'
const PHASE_MUL: Record<Phase, number> = { TKO: 1.20, CLB: 1.10, CRZ: 1.00, DES: 1.10, APP: 1.30, GND: 0.0, OTHER: 0.50 }

interface Bulletin {
  id: string
  mwo: string        // issuing MWO (e.g. KKCI, EGRR, RJTD)
  fir: string        // FIR/UIR identifier
  kind: Kind
  phenom: Phenom
  poly: [number, number][]   // [lng,lat] vertices, closed (last == first OK or not)
  flLo: number; flHi: number
  validFromMin: number  // minutes since issue (synthetic)
  validToMin: number    // minutes until expiry (synthetic, positive)
  mvSpdKt: number
  mvBrgDeg: number
  note: string
}

/* Synthetic 36-bulletin catalogue spanning major MWO products.
   Geometry kept simple (3-5 vertex polygons) reflecting AWC
   Convective SIGMET shapes plus EU/APAC SIGMET polygons.       */
const BULLETINS: Bulletin[] = [
  // Convective SIGMETs (AWC KKCI)
  { id: 'KMKC-WST-71C', mwo: 'KKCI', fir: 'KZKC', kind: 'CONV-SIGMET', phenom: 'EMBD-TS', poly: [[-97.5,33.0],[-95.0,34.5],[-93.5,33.2],[-95.0,31.5],[-97.5,33.0]], flLo: 30, flHi: 450, validFromMin: 12, validToMin: 108, mvSpdKt: 25, mvBrgDeg: 60, note: 'EMBD TS MOV NE 25KT TOPS FL450 HAIL 2IN' },
  { id: 'KMKC-WST-72E', mwo: 'KKCI', fir: 'KZAU', kind: 'CONV-SIGMET', phenom: 'FRQ-TS', poly: [[-89.5,42.5],[-87.2,43.8],[-85.5,42.5],[-87.0,41.0],[-89.5,42.5]], flLo: 30, flHi: 420, validFromMin: 8, validToMin: 112, mvSpdKt: 30, mvBrgDeg: 70, note: 'FRQ TS LN MOV ENE 30KT TOPS 420 LGT FREQ' },
  { id: 'KMKC-WST-73W', mwo: 'KKCI', fir: 'KZDV', kind: 'CONV-SIGMET', phenom: 'SQL-TS', poly: [[-104.5,38.0],[-102.5,40.0],[-100.5,38.5],[-102.5,36.5],[-104.5,38.0]], flLo: 30, flHi: 480, validFromMin: 22, validToMin: 98, mvSpdKt: 35, mvBrgDeg: 80, note: 'SQUALL LINE SVR TS TOPS 480 TORNADO POSS' },
  { id: 'KMKC-WST-74C', mwo: 'KKCI', fir: 'KZME', kind: 'CONV-SIGMET', phenom: 'EMBD-TS', poly: [[-92.0,35.5],[-90.0,36.5],[-88.5,35.0],[-90.5,34.0],[-92.0,35.5]], flLo: 30, flHi: 410, validFromMin: 30, validToMin: 90, mvSpdKt: 20, mvBrgDeg: 50, note: 'EMBD TS MOV NE 20KT TOPS 410' },
  // SIGMET turbulence (AWC KKCI ALFA series)
  { id: 'KMKC-SIGA-1', mwo: 'KKCI', fir: 'KZNY', kind: 'SIGMET', phenom: 'SEV-TURB', poly: [[-76.0,40.0],[-72.5,41.5],[-70.0,40.5],[-72.5,38.5],[-76.0,40.0]], flLo: 280, flHi: 400, validFromMin: 18, validToMin: 222, mvSpdKt: 0, mvBrgDeg: 0, note: 'SEV TURB FL280-400 JET STREAM EXIT REG' },
  { id: 'KMKC-SIGB-2', mwo: 'KKCI', fir: 'KZLA', kind: 'SIGMET', phenom: 'SEV-MTW', poly: [[-119.0,36.5],[-117.0,37.5],[-115.5,36.0],[-117.5,35.0],[-119.0,36.5]], flLo: 200, flHi: 350, validFromMin: 35, validToMin: 145, mvSpdKt: 0, mvBrgDeg: 0, note: 'SEV MTW LEE SIERRA NEVADA ALT LOSS 800FT' },
  { id: 'KMKC-SIGC-3', mwo: 'KKCI', fir: 'KZMA', kind: 'SIGMET', phenom: 'OBSC-TS', poly: [[-82.0,26.5],[-79.5,27.5],[-78.5,25.0],[-80.5,24.0],[-82.0,26.5]], flLo: 30, flHi: 440, validFromMin: 6, validToMin: 174, mvSpdKt: 18, mvBrgDeg: 290, note: 'OBSC TS WLY 18KT TOPS 440' },
  // SIGMET icing
  { id: 'KMKC-SIGI-4', mwo: 'KKCI', fir: 'KZBW', kind: 'SIGMET', phenom: 'SEV-ICE-FZRA', poly: [[-73.5,42.5],[-71.0,43.5],[-69.5,42.0],[-71.5,41.0],[-73.5,42.5]], flLo: 30, flHi: 180, validFromMin: 14, validToMin: 166, mvSpdKt: 12, mvBrgDeg: 60, note: 'SEV ICE FZRA SFC-FL180 LFM PRE-WARM FRONT' },
  { id: 'KMKC-SIGI-5', mwo: 'KKCI', fir: 'KZSE', kind: 'SIGMET', phenom: 'SEV-ICE', poly: [[-124.0,47.5],[-122.0,48.5],[-120.5,47.0],[-122.5,46.0],[-124.0,47.5]], flLo: 60, flHi: 200, validFromMin: 20, validToMin: 160, mvSpdKt: 15, mvBrgDeg: 80, note: 'SEV ICE 060-200 PAC FRONT' },
  // Volcanic Ash Advisory SIGMETs
  { id: 'PHNL-VAA-1', mwo: 'PHFO', fir: 'PAZA', kind: 'VAA-SIGMET', phenom: 'VA-CLD', poly: [[-153.0,61.0],[-151.0,62.5],[-149.0,61.0],[-151.0,59.5],[-153.0,61.0]], flLo: 200, flHi: 350, validFromMin: 45, validToMin: 315, mvSpdKt: 28, mvBrgDeg: 85, note: 'VA REDOUBT MOV E 28KT FL200-350 EAST OF ANC' },
  { id: 'RJTD-VAA-1', mwo: 'RJTD', fir: 'RJJJ', kind: 'VAA-SIGMET', phenom: 'VA-CLD', poly: [[140.0,32.5],[142.5,33.5],[143.0,31.5],[140.5,30.5],[140.0,32.5]], flLo: 150, flHi: 280, validFromMin: 25, validToMin: 335, mvSpdKt: 22, mvBrgDeg: 110, note: 'VA NISHINOSHIMA MOV SE 22KT' },
  // AIRMETs (FAA AC 00-45H §9)
  { id: 'KMKC-WA-S1', mwo: 'KKCI', fir: 'KZAB', kind: 'AIRMET', phenom: 'IFR', poly: [[-110.0,33.5],[-107.0,35.5],[-105.0,33.5],[-107.5,31.5],[-110.0,33.5]], flLo: 0, flHi: 60, validFromMin: 40, validToMin: 320, mvSpdKt: 8, mvBrgDeg: 90, note: 'AIRMET SIERRA IFR CIG OVC005 VIS 2SM' },
  { id: 'KMKC-WA-S2', mwo: 'KKCI', fir: 'KZDV', kind: 'AIRMET', phenom: 'MTN-OBSC', poly: [[-108.5,39.0],[-105.5,40.5],[-104.0,38.5],[-106.5,37.0],[-108.5,39.0]], flLo: 60, flHi: 180, validFromMin: 30, validToMin: 330, mvSpdKt: 0, mvBrgDeg: 0, note: 'AIRMET SIERRA MTN OBSCN BY CLD/PCPN' },
  { id: 'KMKC-WA-T1', mwo: 'KKCI', fir: 'KZBW', kind: 'AIRMET', phenom: 'MOD-TURB', poly: [[-75.0,41.5],[-71.0,43.0],[-68.5,41.5],[-72.0,40.0],[-75.0,41.5]], flLo: 180, flHi: 380, validFromMin: 50, validToMin: 310, mvSpdKt: 0, mvBrgDeg: 0, note: 'AIRMET TANGO MOD TURB FL180-380 JET' },
  { id: 'KMKC-WA-T2', mwo: 'KKCI', fir: 'KZTL', kind: 'AIRMET', phenom: 'STG-SFC-WIND', poly: [[-86.0,33.0],[-83.0,34.5],[-81.0,33.0],[-83.5,31.5],[-86.0,33.0]], flLo: 0, flHi: 60, validFromMin: 22, validToMin: 338, mvSpdKt: 12, mvBrgDeg: 60, note: 'AIRMET TANGO STG SFC WIND GUSTS 35KT' },
  { id: 'KMKC-WA-Z1', mwo: 'KKCI', fir: 'KZOB', kind: 'AIRMET', phenom: 'MOD-ICE', poly: [[-85.0,41.0],[-82.0,42.5],[-80.0,41.0],[-82.5,39.5],[-85.0,41.0]], flLo: 60, flHi: 180, validFromMin: 38, validToMin: 322, mvSpdKt: 14, mvBrgDeg: 70, note: 'AIRMET ZULU MOD ICE 060-180 FZL 040' },
  { id: 'KMKC-WA-Z2', mwo: 'KKCI', fir: 'KZMP', kind: 'AIRMET', phenom: 'MOD-ICE', poly: [[-96.5,45.0],[-93.0,46.5],[-91.0,45.0],[-93.5,43.5],[-96.5,45.0]], flLo: 80, flHi: 200, validFromMin: 18, validToMin: 342, mvSpdKt: 16, mvBrgDeg: 80, note: 'AIRMET ZULU MOD ICE 080-200 FZL 060' },
  // EUROCONTROL EUR SIGMETs (EGRR / LFPW / EDZM / LSAZ)
  { id: 'EGRR-SIG-1', mwo: 'EGRR', fir: 'EGTT', kind: 'SIGMET', phenom: 'SEV-TURB', poly: [[-3.0,52.0],[1.0,53.5],[3.0,52.0],[0.5,50.5],[-3.0,52.0]], flLo: 280, flHi: 410, validFromMin: 28, validToMin: 152, mvSpdKt: 0, mvBrgDeg: 0, note: 'SEV TURB FL280-410 LJS' },
  { id: 'LFPW-SIG-1', mwo: 'LFPW', fir: 'LFFF', kind: 'SIGMET', phenom: 'EMBD-TS', poly: [[1.5,47.5],[4.5,48.5],[5.5,46.5],[3.0,45.5],[1.5,47.5]], flLo: 30, flHi: 380, validFromMin: 16, validToMin: 164, mvSpdKt: 22, mvBrgDeg: 50, note: 'EMBD TS MOV NE 22KT TOPS 380' },
  { id: 'EDZM-SIG-1', mwo: 'EDZM', fir: 'EDMM', kind: 'SIGMET', phenom: 'SEV-MTW', poly: [[10.5,47.5],[12.5,48.0],[13.0,46.5],[11.0,46.0],[10.5,47.5]], flLo: 100, flHi: 280, validFromMin: 24, validToMin: 156, mvSpdKt: 0, mvBrgDeg: 0, note: 'SEV MTW ALPS S WIND FL100-280' },
  { id: 'LSAZ-SIG-1', mwo: 'LSAZ', fir: 'LSAS', kind: 'SIGMET', phenom: 'SEV-ICE', poly: [[6.5,46.5],[9.0,47.5],[10.0,46.0],[7.5,45.5],[6.5,46.5]], flLo: 80, flHi: 200, validFromMin: 12, validToMin: 168, mvSpdKt: 10, mvBrgDeg: 90, note: 'SEV ICE 080-200 ALPS PRE-FRONT' },
  // APAC
  { id: 'RJTD-SIG-1', mwo: 'RJTD', fir: 'RJJJ', kind: 'SIGMET', phenom: 'SEV-TURB', poly: [[138.0,35.0],[141.5,36.5],[143.0,34.5],[140.0,33.0],[138.0,35.0]], flLo: 280, flHi: 410, validFromMin: 9, validToMin: 171, mvSpdKt: 0, mvBrgDeg: 0, note: 'SEV CAT FL280-410 JETSTREAM 180KT' },
  { id: 'VHHK-SIG-1', mwo: 'VHHK', fir: 'VHHK', kind: 'SIGMET', phenom: 'EMBD-TS', poly: [[112.5,22.0],[114.5,23.0],[115.5,21.5],[113.5,20.5],[112.5,22.0]], flLo: 30, flHi: 450, validFromMin: 20, validToMin: 160, mvSpdKt: 18, mvBrgDeg: 30, note: 'EMBD TS MOV NNE 18KT TOPS 450' },
  { id: 'WSSS-SIG-1', mwo: 'WSSS', fir: 'WSJC', kind: 'SIGMET', phenom: 'EMBD-TS', poly: [[103.0,2.5],[105.0,3.5],[106.0,1.5],[104.0,0.5],[103.0,2.5]], flLo: 30, flHi: 480, validFromMin: 14, validToMin: 166, mvSpdKt: 12, mvBrgDeg: 90, note: 'EMBD TS ITCZ TOPS 480 MOV E 12KT' },
  { id: 'YBBN-SIG-1', mwo: 'YBBN', fir: 'YBBB', kind: 'SIGMET', phenom: 'SEV-TURB', poly: [[150.0,-29.0],[154.0,-28.0],[155.0,-31.0],[151.5,-32.0],[150.0,-29.0]], flLo: 260, flHi: 400, validFromMin: 26, validToMin: 154, mvSpdKt: 0, mvBrgDeg: 0, note: 'SEV TURB FL260-400 SUBTROP JET' },
  { id: 'NZKL-SIG-1', mwo: 'NZKL', fir: 'NZZC', kind: 'SIGMET', phenom: 'SEV-MTW', poly: [[167.5,-44.5],[170.5,-43.5],[171.5,-45.5],[168.5,-46.5],[167.5,-44.5]], flLo: 100, flHi: 280, validFromMin: 32, validToMin: 148, mvSpdKt: 0, mvBrgDeg: 0, note: 'SEV MTW SOUTHERN ALPS 700FPM DOWN' },
  // Middle East
  { id: 'OMDB-SIG-1', mwo: 'OMDB', fir: 'OMAE', kind: 'SIGMET', phenom: 'HVY-DS', poly: [[53.5,24.0],[56.0,25.5],[57.5,23.5],[55.0,22.0],[53.5,24.0]], flLo: 0, flHi: 100, validFromMin: 8, validToMin: 172, mvSpdKt: 20, mvBrgDeg: 60, note: 'HVY DS SHAMAL VIS 1500M FL010-100' },
  // South America
  { id: 'SBGR-SIG-1', mwo: 'SBGR', fir: 'SBBS', kind: 'SIGMET', phenom: 'OBSC-TS', poly: [[-48.5,-22.0],[-45.0,-21.0],[-44.0,-24.0],[-47.5,-25.0],[-48.5,-22.0]], flLo: 30, flHi: 440, validFromMin: 16, validToMin: 164, mvSpdKt: 22, mvBrgDeg: 120, note: 'OBSC TS SUMMER MOV ESE 22KT TOPS 440' },
  { id: 'SCEL-SIG-1', mwo: 'SCEL', fir: 'SCEZ', kind: 'SIGMET', phenom: 'SEV-MTW', poly: [[-71.5,-32.5],[-69.5,-33.0],[-69.0,-35.0],[-71.0,-34.5],[-71.5,-32.5]], flLo: 200, flHi: 350, validFromMin: 28, validToMin: 152, mvSpdKt: 0, mvBrgDeg: 0, note: 'SEV MTW ANDES WAVE FL200-350' },
  // Africa
  { id: 'FAJS-SIG-1', mwo: 'FAJS', fir: 'FAJO', kind: 'SIGMET', phenom: 'OBSC-TS', poly: [[27.0,-25.0],[30.0,-24.0],[31.0,-26.5],[28.5,-27.5],[27.0,-25.0]], flLo: 30, flHi: 420, validFromMin: 22, validToMin: 158, mvSpdKt: 18, mvBrgDeg: 80, note: 'OBSC TS HIGHVELD TOPS 420' },
  { id: 'HKNC-SIG-1', mwo: 'HKNC', fir: 'HKNA', kind: 'SIGMET', phenom: 'EMBD-TS', poly: [[36.0,-1.0],[38.5,0.0],[39.0,-2.5],[36.5,-3.0],[36.0,-1.0]], flLo: 30, flHi: 460, validFromMin: 18, validToMin: 162, mvSpdKt: 14, mvBrgDeg: 90, note: 'EMBD TS ITCZ TOPS 460' },
  // North Atlantic / Oceanic
  { id: 'CZQX-SIG-1', mwo: 'CZQX', fir: 'CZQX', kind: 'SIGMET', phenom: 'SEV-TURB', poly: [[-50.0,52.0],[-42.0,53.5],[-40.0,49.0],[-48.0,48.0],[-50.0,52.0]], flLo: 320, flHi: 410, validFromMin: 24, validToMin: 156, mvSpdKt: 0, mvBrgDeg: 0, note: 'SEV CAT NAT TRACK ALFA FL320-410' },
  { id: 'EGGX-SIG-1', mwo: 'EGGX', fir: 'EGGX', kind: 'SIGMET', phenom: 'SEV-TURB', poly: [[-30.0,56.0],[-22.0,57.5],[-20.0,53.0],[-28.0,52.0],[-30.0,56.0]], flLo: 320, flHi: 400, validFromMin: 30, validToMin: 150, mvSpdKt: 0, mvBrgDeg: 0, note: 'SEV CAT FL320-400 SHANWICK EAST' },
  // Sandstorm
  { id: 'OEJD-SIG-1', mwo: 'OEJD', fir: 'OEJD', kind: 'SIGMET', phenom: 'HVY-SS', poly: [[42.0,23.0],[45.5,24.5],[46.5,21.5],[43.5,20.5],[42.0,23.0]], flLo: 0, flHi: 120, validFromMin: 14, validToMin: 166, mvSpdKt: 22, mvBrgDeg: 320, note: 'HVY SS SHAMAL VIS 1500M FL010-120' },
  // LLWS AIRMET
  { id: 'KMKC-WA-X1', mwo: 'KKCI', fir: 'KZHU', kind: 'AIRMET', phenom: 'LLWS', poly: [[-97.5,29.0],[-94.5,30.5],[-92.5,29.0],[-95.0,27.5],[-97.5,29.0]], flLo: 0, flHi: 20, validFromMin: 10, validToMin: 170, mvSpdKt: 0, mvBrgDeg: 0, note: 'AIRMET TANGO LLWS BLW 2000FT' },
  // GAMET (low-level area forecast)
  { id: 'LSGG-GAM-1', mwo: 'LSGG', fir: 'LSAG', kind: 'GAMET', phenom: 'MOD-TURB', poly: [[5.5,46.0],[7.5,46.5],[7.0,45.0],[5.5,45.0],[5.5,46.0]], flLo: 30, flHi: 100, validFromMin: 35, validToMin: 145, mvSpdKt: 0, mvBrgDeg: 0, note: 'GAMET MOD TURB BLW FL100 GENEVA FIR' },
]

/* Aircraft susceptibility per phenomenon class — heavier widebodies
   absorb light turbulence/icing better, turboprops more susceptible
   to icing and LLWS, all aircraft equally vulnerable to VA-CLD. */
type ACClass = 'HVY-Q' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
const ACCLASS_SUS: Record<ACClass, number> = {
  'HVY-Q': 0.78, HVY: 0.85, NRW: 1.00, RGN: 1.12, BIZ: 1.05, TBP: 1.28,
}
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

function distNm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3440.065
  const φ1 = a.lat * Math.PI / 180, φ2 = b.lat * Math.PI / 180
  const Δφ = (b.lat - a.lat) * Math.PI / 180, Δλ = (b.lng - a.lng) * Math.PI / 180
  const h = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const wrapLng = (l: number) => ((l + 540) % 360) - 180

/* Ray-casting point-in-polygon on (lng,lat). Treats polygon as
   planar in the local region (acceptable for the typical few-deg
   SIGMET sizes); for huge polar polys this would need great-circle
   handling but our catalogue stays well clear of the seams. */
function pointInPoly(lng: number, lat: number, poly: [number, number][]): boolean {
  let inside = false
  const n = poly.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i][0], yi = poly[i][1]
    const xj = poly[j][0], yj = poly[j][1]
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-9) + xi)
    if (intersect) inside = !inside
  }
  return inside
}

/* Approximate distance (nm) from a (lng,lat) point to nearest polygon edge.
   Returns 0 if inside. Uses local equirectangular projection. */
function edgeDistNm(lng: number, lat: number, poly: [number, number][]): number {
  if (pointInPoly(lng, lat, poly)) return 0
  const φ = lat * Math.PI / 180
  const kx = 60 * Math.cos(φ), ky = 60
  let min = Infinity
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length
    const ax = poly[i][0], ay = poly[i][1]
    const bx = poly[j][0], by = poly[j][1]
    const apx = (lng - ax) * kx, apy = (lat - ay) * ky
    const abx = (bx - ax) * kx, aby = (by - ay) * ky
    const ab2 = abx * abx + aby * aby || 1e-9
    const t = clamp((apx * abx + apy * aby) / ab2, 0, 1)
    const cx = ax * kx + abx * t, cy = ay * ky + aby * t
    const px = lng * kx, py = lat * ky
    const d = Math.hypot(px - cx, py - cy)
    if (d < min) min = d
  }
  return min
}

/* Forward-project flight along great-circle track for N minutes,
   advect polygon by movement vector for same N min, then test
   if projected target lies inside advected polygon. */
function projectLatLng(lat: number, lng: number, brgDeg: number, distNm: number): [number, number] {
  const R = 3440.065
  const δ = distNm / R
  const θ = brgDeg * Math.PI / 180
  const φ1 = lat * Math.PI / 180
  const λ1 = lng * Math.PI / 180
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return [φ2 * 180 / Math.PI, wrapLng(λ2 * 180 / Math.PI)]
}
function advectPoly(poly: [number, number][], brgDeg: number, distNm: number): [number, number][] {
  if (distNm < 0.1) return poly
  return poly.map(([lng, lat]) => {
    const [nlat, nlng] = projectLatLng(lat, lng, brgDeg, distNm)
    return [nlng, nlat] as [number, number]
  })
}

interface Hit { b: Bulletin; edgeNm: number; vBandHit: boolean; bandGapFt: number; inside: boolean; fwdInside: boolean; fwdEtaMin: number }
interface Row {
  f: SFlight
  cls: ACClass
  flLevel: number
  phase: Phase
  hits: Hit[]
  worst?: Hit
  pen: number; fwd: number; vbd: number; sus: number; rec: number; edg: number
  driver: 'PEN' | 'FWD' | 'VBD' | 'SUS' | 'REC' | 'EDG' | 'NONE'
  score: number
  tier: Tier
}

export default function SigmetAirmet({ map, flights, onClose, onFly }: Props) {
  const [minFL, setMinFL] = useState(0)
  const [maxFL, setMaxFL] = useState(450)
  const [lookAhMin, setLookAhMin] = useState(20)
  const [vBufFt, setVBufFt] = useState(2000)
  const [edgeNmWarn, setEdgeNmWarn] = useState(40)
  const [sevMul, setSevMul] = useState(100)
  const [phaseWt, setPhaseWt] = useState(100)
  const [validMul, setValidMul] = useState(100)
  const [kindFilter, setKindFilter] = useState<Kind | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'BULLETINS' | 'MWO'>('AIRCRAFT')
  const [query, setQuery] = useState('')

  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showPoly, setShowPoly] = useState(true)
  const [showAdv, setShowAdv] = useState(true)   // movement advection ghost
  const [showFwd, setShowFwd] = useState(true)
  const [showRef, setShowRef] = useState(false)
  const [showDiag, setShowDiag] = useState(true)

  const active = useMemo(() => {
    const out: Row[] = []
    const valid = BULLETINS.filter(b => {
      const validNow = b.validFromMin <= 0 || b.validFromMin <= 60 * 6  // synthetic always "current"
      return validNow && b.validToMin > 0
    })

    for (const f of flights) {
      if (f.ground) continue
      const fl = Math.round((f.altitudeFt || 0) / 100)
      if (fl < minFL || fl > maxFL) continue
      const cls = classify(f.type, f.category)
      const susBase = ACCLASS_SUS[cls]
      const phase: Phase = (f.altitudeFt < 1500 && f.vertRate > 800) ? 'TKO'
        : f.vertRate > 500 ? 'CLB'
        : (f.altitudeFt < 8000 && f.vertRate < -300) ? 'APP'
        : f.vertRate < -300 ? 'DES'
        : f.altitudeFt > 25000 ? 'CRZ'
        : 'OTHER'

      const hits: Hit[] = []
      for (const b of valid) {
        if (kindFilter !== 'ALL' && b.kind !== kindFilter) continue
        // Movement-advected polygon for the "now" frame
        const advNow = advectPoly(b.poly, b.mvBrgDeg, b.mvSpdKt * (b.validFromMin / 60))
        const edge = edgeDistNm(f.lng, f.lat, advNow)
        if (edge > 250) continue   // far outside, skip
        const inside = pointInPoly(f.lng, f.lat, advNow)
        // FL overlap
        const vGap = Math.max(0, b.flLo - fl, fl - b.flHi) * 100   // ft outside band
        const vBandHit = vGap === 0 || vGap <= vBufFt
        // Forward projection
        const fwdMin = lookAhMin
        const fwdDistNm = (f.velocityKts || 0) * (fwdMin / 60)
        const [fwLat, fwLng] = projectLatLng(f.lat, f.lng, f.track || 0, fwdDistNm)
        const advFwd = advectPoly(b.poly, b.mvBrgDeg, b.mvSpdKt * ((b.validFromMin + fwdMin) / 60))
        const fwdInside = pointInPoly(fwLng, fwLat, advFwd)
        let fwdEta = -1
        if (fwdInside) {
          // Bisection ETA estimate
          let lo = 0, hi = fwdMin
          for (let k = 0; k < 14; k++) {
            const mid = (lo + hi) / 2
            const [mLat, mLng] = projectLatLng(f.lat, f.lng, f.track || 0, (f.velocityKts || 0) * (mid / 60))
            const advMid = advectPoly(b.poly, b.mvBrgDeg, b.mvSpdKt * ((b.validFromMin + mid) / 60))
            if (pointInPoly(mLng, mLat, advMid)) hi = mid
            else lo = mid
          }
          fwdEta = hi
        }
        hits.push({ b, edgeNm: edge, vBandHit, bandGapFt: vGap, inside, fwdInside, fwdEtaMin: fwdEta })
      }

      // worst-of bulletin selection
      hits.sort((a, c) => (Number(c.inside) - Number(a.inside)) || (Number(c.fwdInside) - Number(a.fwdInside)) || (a.edgeNm - c.edgeNm))
      const worst = hits[0]

      // drivers
      let pen = 0, fwd = 0, vbd = 0, sus = 0, rec = 0, edg = 0
      if (worst) {
        const sev = PHENOM_SEV[worst.b.phenom] * (sevMul / 100)
        if (worst.inside && worst.vBandHit) pen = clamp(100 * sev, 0, 100)
        else if (worst.inside && !worst.vBandHit) pen = clamp(60 * sev - worst.bandGapFt / 200, 0, 100)
        else pen = 0
        if (worst.fwdInside) fwd = clamp(85 * sev - worst.fwdEtaMin * 1.5, 0, 100)
        if (worst.bandGapFt === 0) vbd = 70
        else if (worst.bandGapFt <= vBufFt) vbd = clamp(70 - (worst.bandGapFt / vBufFt) * 50, 20, 70)
        else vbd = 0
        sus = clamp(40 * susBase * sev, 0, 100)
        const validShare = clamp(worst.b.validToMin / Math.max(60, worst.b.validToMin + worst.b.validFromMin), 0, 1) * (validMul / 100)
        rec = clamp(50 * validShare, 0, 60)
        edg = worst.edgeNm <= 0 ? 100 : clamp(100 - (worst.edgeNm / edgeNmWarn) * 100, 0, 100)
      }
      const drivers: Array<[Row['driver'], number]> = [['PEN', pen], ['FWD', fwd], ['VBD', vbd], ['SUS', sus], ['REC', rec], ['EDG', edg]]
      drivers.sort((a, c) => c[1] - a[1])
      const driver = drivers[0][1] === 0 ? 'NONE' : drivers[0][0]
      let score = drivers[0][1] * PHASE_MUL[phase] * (phaseWt / 100)
      score = clamp(score, 0, 100)

      let tier: Tier = 'IDLE'
      if (worst) {
        if (worst.inside && worst.vBandHit) tier = 'PENETRATE'
        else if (worst.fwdInside && worst.fwdEtaMin <= 8 && worst.vBandHit) tier = 'IMMINENT'
        else if (worst.fwdInside && worst.vBandHit) tier = 'FORECAST'
        else if (score >= 25 || (worst.edgeNm <= edgeNmWarn && worst.vBandHit)) tier = 'WATCH'
        else tier = 'OK'
      }
      out.push({ f, cls, flLevel: fl, phase, hits, worst, pen, fwd, vbd, sus, rec, edg, driver, score, tier })
    }
    out.sort((a, c) => TIER_RANK[a.tier] - TIER_RANK[c.tier] || c.score - a.score)
    return out
  }, [flights, minFL, maxFL, lookAhMin, vBufFt, edgeNmWarn, sevMul, phaseWt, validMul, kindFilter])

  const tierCount = useMemo(() => {
    const c: Record<Tier, number> = { PENETRATE: 0, IMMINENT: 0, FORECAST: 0, WATCH: 0, OK: 0, IDLE: 0 }
    active.forEach(r => { c[r.tier]++ })
    return c
  }, [active])

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim()
    return active.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (!q) return true
      return (r.f.callsign || '').toLowerCase().includes(q) ||
        (r.f.icao || '').toLowerCase().includes(q) ||
        (r.f.type || '').toLowerCase().includes(q) ||
        (r.worst?.b.id || '').toLowerCase().includes(q) ||
        (r.worst?.b.phenom || '').toLowerCase().includes(q) ||
        (r.worst?.b.mwo || '').toLowerCase().includes(q)
    })
  }, [active, tierFilter, query])

  const worstAc = useMemo(() => active.find(r => r.tier === 'PENETRATE') || active.find(r => r.tier === 'IMMINENT') || active[0], [active])
  const meanScore = useMemo(() => active.length ? active.reduce((a, r) => a + r.score, 0) / active.length : 0, [active])
  const penShare = useMemo(() => active.length ? active.filter(r => r.tier === 'PENETRATE' || r.tier === 'IMMINENT').length / active.length : 0, [active])

  const bulletinRows = useMemo(() => {
    type B = { b: Bulletin; ac: number; pen: number; fwd: number; meanScore: number }
    const map = new Map<string, B>()
    for (const b of BULLETINS) map.set(b.id, { b, ac: 0, pen: 0, fwd: 0, meanScore: 0 })
    let acc = new Map<string, number>()
    for (const r of active) {
      for (const h of r.hits) {
        const e = map.get(h.b.id)!
        e.ac++
        if (h.inside && h.vBandHit) e.pen++
        if (h.fwdInside && h.vBandHit) e.fwd++
        acc.set(h.b.id, (acc.get(h.b.id) || 0) + r.score)
      }
    }
    for (const [id, sum] of acc) {
      const e = map.get(id)!
      if (e.ac) e.meanScore = sum / e.ac
    }
    return Array.from(map.values())
      .filter(e => kindFilter === 'ALL' || e.b.kind === kindFilter)
      .sort((a, c) => c.pen - a.pen || c.fwd - a.fwd || c.ac - a.ac)
  }, [active, kindFilter])

  const mwoRows = useMemo(() => {
    type M = { mwo: string; bulls: number; ac: number; pen: number; fwd: number }
    const map = new Map<string, M>()
    for (const b of BULLETINS) {
      const e = map.get(b.mwo) || { mwo: b.mwo, bulls: 0, ac: 0, pen: 0, fwd: 0 }
      e.bulls++
      map.set(b.mwo, e)
    }
    for (const r of active) {
      for (const h of r.hits) {
        const e = map.get(h.b.mwo)!
        e.ac++
        if (h.inside && h.vBandHit) e.pen++
        if (h.fwdInside && h.vBandHit) e.fwd++
      }
    }
    return Array.from(map.values()).sort((a, c) => c.pen - a.pen || c.fwd - a.fwd || c.bulls - a.bulls)
  }, [active])

  /* Map overlay */
  useEffect(() => {
    if (!map) return
    const SRC_POLY = 'sigmet-poly', LYR_POLY_FILL = 'sigmet-poly-fill', LYR_POLY_LINE = 'sigmet-poly-line'
    const SRC_ADV = 'sigmet-adv', LYR_ADV = 'sigmet-adv'
    const SRC_HALO = 'sigmet-halo', LYR_HALO = 'sigmet-halo'
    const SRC_PIN = 'sigmet-pin', LYR_PIN = 'sigmet-pin'
    const SRC_FWD = 'sigmet-fwd', LYR_FWD = 'sigmet-fwd'
    const SRC_LBL = 'sigmet-lbl', LYR_LBL = 'sigmet-lbl'
    const SRC_BLBL = 'sigmet-blbl', LYR_BLBL = 'sigmet-blbl'
    const SRC_REF = 'sigmet-ref', LYR_REF = 'sigmet-ref'

    const layers: Array<[string, string, string, any, any]> = [
      [SRC_POLY, LYR_POLY_FILL, 'fill', { 'fill-color': ['get', 'color'], 'fill-opacity': 0.10 }, null],
      [SRC_POLY, LYR_POLY_LINE, 'line', { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.85 }, null],
      [SRC_ADV, LYR_ADV, 'line', { 'line-color': ['get', 'color'], 'line-width': 0.8, 'line-dasharray': [2, 2], 'line-opacity': 0.55 }, null],
      [SRC_HALO, LYR_HALO, 'circle', { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.28, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.2, 'circle-stroke-opacity': 0.85 }, null],
      [SRC_PIN, LYR_PIN, 'circle', { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1 }, null],
      [SRC_FWD, LYR_FWD, 'line', { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-dasharray': [2, 2], 'line-opacity': 0.85 }, null],
      [SRC_REF, LYR_REF, 'line', { 'line-color': '#0ea5e955', 'line-width': 0.5, 'line-dasharray': [3, 4] }, null],
      [SRC_LBL, LYR_LBL, 'symbol', { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.4 }, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-allow-overlap': true }],
      [SRC_BLBL, LYR_BLBL, 'symbol', { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 }, { 'text-field': ['get', 'label'], 'text-size': 9, 'text-allow-overlap': true }],
    ]
    for (const [src, lyr, type, paint, layout] of layers) {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      if (!map.getLayer(lyr)) {
        const def: any = { id: lyr, type, source: src, paint }
        if (layout) def.layout = layout
        map.addLayer(def)
      }
    }

    const polyF: any[] = []; const advF: any[] = []; const haloF: any[] = []; const pinF: any[] = []; const fwdF: any[] = []; const refF: any[] = []; const lblF: any[] = []; const blblF: any[] = []

    if (showPoly) {
      for (const b of BULLETINS) {
        if (kindFilter !== 'ALL' && b.kind !== kindFilter) continue
        const color = KIND_COLOR[b.kind]
        const advNow = advectPoly(b.poly, b.mvBrgDeg, b.mvSpdKt * (b.validFromMin / 60))
        const ring = advNow.map(([lng, lat]) => [lng, lat])
        if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) ring.push(ring[0])
        polyF.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { color } })
        // Centroid for label
        let cx = 0, cy = 0
        for (const [lng, lat] of advNow) { cx += lng; cy += lat }
        cx /= advNow.length; cy /= advNow.length
        if (showLbl) blblF.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [cx, cy] }, properties: { color, label: `${b.id} ${b.phenom} FL${b.flLo}-${b.flHi}` } })
        if (showAdv && b.mvSpdKt > 0) {
          const advFut = advectPoly(b.poly, b.mvBrgDeg, b.mvSpdKt * ((b.validFromMin + lookAhMin) / 60))
          const ringF = advFut.map(([lng, lat]) => [lng, lat])
          if (ringF.length && (ringF[0][0] !== ringF[ringF.length - 1][0] || ringF[0][1] !== ringF[ringF.length - 1][1])) ringF.push(ringF[0])
          advF.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: ringF }, properties: { color } })
        }
      }
    }

    for (const r of active) {
      const color = TIER_COLOR[r.tier]
      if (showHalo && r.tier !== 'OK' && r.tier !== 'IDLE') {
        haloF.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, r: 8 + r.score * 0.14 } })
      }
      if (showPin && (r.tier === 'PENETRATE' || r.tier === 'IMMINENT')) {
        pinF.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color } })
      }
      if (showLbl && r.tier !== 'OK' && r.tier !== 'IDLE') {
        const lab = `${r.f.callsign || r.f.icao} · ${r.tier}${r.worst ? ' · ' + r.worst.b.phenom : ''}`
        lblF.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { label: lab, color } })
      }
      if (showFwd && r.worst?.fwdInside) {
        const fwdDist = (r.f.velocityKts || 0) * (r.worst.fwdEtaMin / 60)
        const [fwLat, fwLng] = projectLatLng(r.f.lat, r.f.lng, r.f.track || 0, fwdDist)
        fwdF.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [fwLng, fwLat]] }, properties: { color } })
      }
    }
    if (showRef) {
      for (const lat of [60, 30, 0, -30, -60]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, lat])
        refF.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} })
      }
    }

    ;(map.getSource(SRC_POLY) as any).setData({ type: 'FeatureCollection', features: polyF })
    ;(map.getSource(SRC_ADV) as any).setData({ type: 'FeatureCollection', features: advF })
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: haloF })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pinF })
    ;(map.getSource(SRC_FWD) as any).setData({ type: 'FeatureCollection', features: fwdF })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: refF })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lblF })
    ;(map.getSource(SRC_BLBL) as any).setData({ type: 'FeatureCollection', features: blblF })
    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_BLBL, LYR_PIN, LYR_HALO, LYR_FWD, LYR_ADV, LYR_POLY_LINE, LYR_POLY_FILL, LYR_REF]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_LBL, SRC_BLBL, SRC_PIN, SRC_FWD, SRC_ADV, SRC_POLY, SRC_REF]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, active, showHalo, showPin, showLbl, showPoly, showAdv, showFwd, showRef, kindFilter, lookAhMin])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const drvBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const advice = (r: Row): string => {
    if (!r.worst) return 'No SIGMET / AIRMET intersection · monitor next AIRAC cycle'
    const w = r.worst.b
    if (r.tier === 'PENETRATE') return `INSIDE ${w.kind} ${w.id} · ${w.phenom} · ${w.note} · request deviation per AIM 7-1-6 · file SPECIAL AIREP per Annex 3 §5.5 · ${w.mwo} MWO`
    if (r.tier === 'IMMINENT') return `Imminent penetration in ${r.worst.fwdEtaMin.toFixed(0)}min · pre-coord vector / FL change per JO 7110.65 §2-6-3 · brief crew QRH ${w.phenom}`
    if (r.tier === 'FORECAST') return `Forward track enters ${w.id} (${w.phenom}) within LOOK-AH window · plan lateral deviation ${(r.worst.edgeNm).toFixed(0)}nm to clear edge`
    if (r.tier === 'WATCH') return `${(r.worst.edgeNm).toFixed(0)}nm from ${w.id} edge · monitor ride / cross-check WAFS SIGWX per AC 00-45H §9`
    return `Clear of all active SIGMET/AIRMET polygons`
  }

  /* Scatter: edge dist vs score */
  const W = 280, H = 180
  const sx = (n: number) => 32 + (clamp(n, 0, 250) / 250) * (W - 42)
  const sy = (n: number) => H - 24 - clamp(n, 0, 100) / 100 * (H - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">SIGMET / AIRMET · MWO Hazard Monitor</div>
          <div className="text-[10px] text-slate-500">ICAO Annex 3 App 6 · AC 00-45H §9 · AIM 7-1-6/7/8 · JO 7110.65 §2-6-3</div>
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
          <div className="text-sm font-semibold text-slate-100 truncate">{worstAc?.f.callsign || worstAc?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Penetrations</div>
          <div className="text-sm font-semibold" style={{ color: tierCount.PENETRATE > 0 ? '#ef4444' : '#10b981' }}>{tierCount.PENETRATE}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Pen share</div>
          <div className="text-xs font-semibold" style={{ color: penShare >= 0.10 ? '#ef4444' : penShare >= 0.05 ? '#f59e0b' : '#10b981' }}>{(penShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Forecast hits</div>
          <div className="text-xs font-semibold" style={{ color: tierCount.FORECAST + tierCount.IMMINENT > 0 ? '#f59e0b' : '#10b981' }}>{tierCount.FORECAST + tierCount.IMMINENT}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Active bulletins</div>
          <div className="text-xs font-semibold text-slate-100">{BULLETINS.length}</div>
        </div>
      </div>

      {showDiag && active.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* breach zone: edge<=0 + score>=55 */}
            <rect x={sx(0)} y={sy(100)} width={sx(20) - sx(0)} height={sy(55) - sy(100)} fill="#ef444425" />
            <rect x={sx(0)} y={sy(55)} width={sx(edgeNmWarn) - sx(0)} height={sy(25) - sy(55)} fill="#f59e0b22" />
            <line x1={sx(edgeNmWarn)} y1={sy(0)} x2={sx(edgeNmWarn)} y2={sy(100)} stroke="#475569" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(0)} y1={sy(55)} x2={sx(250)} y2={sy(55)} stroke="#f59e0b66" strokeWidth={0.5} strokeDasharray="3 3" />
            <text x={W / 2} y={H - 4} textAnchor="middle" fontSize="9" fill="#64748b">Edge distance (nm)</text>
            <text x={6} y={H / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H / 2})`}>Score</text>
            {active.filter(r => r.worst).map((r, i) => (
              <circle key={i} cx={sx(r.worst!.edgeNm)} cy={sy(r.score)} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['MIN-FL', minFL, 0, 200, setMinFL, ''],
            ['MAX-FL', maxFL, 50, 450, setMaxFL, ''],
            ['LOOK-AH', lookAhMin, 5, 60, setLookAhMin, 'm'],
            ['V-BUF', vBufFt, 0, 8000, setVBufFt, 'ft'],
            ['EDGE-NM', edgeNmWarn, 5, 150, setEdgeNmWarn, 'nm'],
            ['SEV-MUL', sevMul, 50, 200, setSevMul, '%'],
            ['PHASE-WT', phaseWt, 50, 150, setPhaseWt, '%'],
            ['VALID-MUL', validMul, 50, 200, setValidMul, '%'],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[68px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[40px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['SIGMET', 'CONV-SIGMET', 'AIRMET', 'GAMET', 'VAA-SIGMET'] as Kind[]).map(k => (
            <button key={k} onClick={() => setKindFilter(kindFilter === k ? 'ALL' : k)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: kindFilter === k ? KIND_COLOR[k] + '33' : '#0b1220', borderColor: kindFilter === k ? KIND_COLOR[k] : '#1e293b', color: kindFilter === k ? KIND_COLOR[k] : '#cbd5e1' }}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['POLY', showPoly, setShowPoly],
            ['ADV', showAdv, setShowAdv],
            ['FWD', showFwd, setShowFwd],
            ['REF', showRef, setShowRef],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, on, setter]: any) => (
            <button key={lab} onClick={() => setter(!on)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: on ? '#0ea5e933' : '#0b1220', borderColor: on ? '#0ea5e9' : '#1e293b', color: on ? '#0ea5e9' : '#94a3b8' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / id / phenom / mwo" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'BULLETINS', 'MWO'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className="flex-1 px-2 py-1.5 text-[11px]" style={{ color: tab === t ? '#0ea5e9' : '#94a3b8', backgroundColor: tab === t ? '#0ea5e915' : 'transparent', borderBottom: tab === t ? '2px solid #0ea5e9' : '2px solid transparent' }}>{t}</button>
        ))}
      </div>

      {tab === 'AIRCRAFT' && (
        <div className="divide-y divide-slate-800">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No targets within SIGMET/AIRMET geometry · adjust filters</div>}
          {filtered.slice(0, 80).map((r, i) => (
            <div key={i} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(r.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 truncate">{r.f.callsign || r.f.icao}</span>
                  <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 border border-slate-700 font-mono">{r.cls}</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 border border-slate-700">{r.phase}</span>
                  {r.worst && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: KIND_COLOR[r.worst.b.kind], backgroundColor: KIND_COLOR[r.worst.b.kind] + '1a', border: `1px solid ${KIND_COLOR[r.worst.b.kind]}66` }}>{r.worst.b.kind}</span>}
                  {r.worst?.inside && <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] text-rose-400 bg-rose-500/10 border border-rose-500/40 font-semibold">IN</span>}
                </div>
                {tierBadge(r.tier)}
              </div>
              {r.worst && (
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  FL{r.flLevel} · {r.worst.b.id} · {r.worst.b.phenom} · band FL{r.worst.b.flLo}-{r.worst.b.flHi} <span style={{ color: r.worst.vBandHit ? '#ef4444' : '#64748b' }}>{r.worst.vBandHit ? 'IN-BAND' : `+${(r.worst.bandGapFt / 1000).toFixed(1)}kft`}</span> · edge {r.worst.edgeNm.toFixed(0)}nm · MWO {r.worst.b.mwo}
                </div>
              )}
              {r.worst?.fwdInside && (
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  FWD → ENTER in {r.worst.fwdEtaMin.toFixed(0)}min · mv {r.worst.b.mvSpdKt}kt/{r.worst.b.mvBrgDeg.toFixed(0)}°
                </div>
              )}
              {r.worst && (
                <div className="text-[10px] text-slate-500 mt-0.5 italic truncate">"{r.worst.b.note}"</div>
              )}
              <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} /></div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {drvBadge('PEN', r.pen)}
                {drvBadge('FWD', r.fwd)}
                {drvBadge('VBD', r.vbd)}
                {drvBadge('SUS', r.sus)}
                {drvBadge('REC', r.rec)}
                {drvBadge('EDG', r.edg)}
              </div>
              <div className="text-[10px] mt-1" style={{ color: TIER_COLOR[r.tier] }}>{advice(r)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'BULLETINS' && (
        <div className="divide-y divide-slate-800">
          {bulletinRows.map((e, i) => (
            <div key={i} className="px-3 py-2" style={{ borderLeft: `3px solid ${KIND_COLOR[e.b.kind]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 font-mono truncate">{e.b.id}</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: KIND_COLOR[e.b.kind], backgroundColor: KIND_COLOR[e.b.kind] + '1a', border: `1px solid ${KIND_COLOR[e.b.kind]}66` }}>{e.b.kind}</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: PHENOM_COLOR[e.b.phenom], backgroundColor: PHENOM_COLOR[e.b.phenom] + '1a', border: `1px solid ${PHENOM_COLOR[e.b.phenom]}66` }}>{e.b.phenom}</span>
                </div>
                <div className="text-[10px] text-slate-400">{e.ac} ac</div>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                {e.b.mwo} · {e.b.fir} · FL{e.b.flLo}-{e.b.flHi} · mv {e.b.mvSpdKt}kt/{e.b.mvBrgDeg}° · valid -{e.b.validFromMin}/+{e.b.validToMin}m
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5 italic truncate">"{e.b.note}"</div>
              <div className="flex items-center gap-2 mt-1">
                {e.pen > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-rose-400 bg-rose-500/10 border border-rose-500/40">PEN {e.pen}</span>}
                {e.fwd > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/40">FWD {e.fwd}</span>}
                <div className="flex-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${e.meanScore}%`, backgroundColor: e.meanScore >= 80 ? '#ef4444' : e.meanScore >= 55 ? '#f59e0b' : e.meanScore >= 25 ? '#0ea5e9' : '#10b981' }} /></div>
                <span className="text-[10px] text-slate-400 tabular-nums w-8 text-right">{e.meanScore.toFixed(0)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'MWO' && (
        <div className="divide-y divide-slate-800">
          {mwoRows.map((m, i) => (
            <div key={i} className="px-3 py-2" style={{ borderLeft: `3px solid ${m.pen > 0 ? '#ef4444' : m.fwd > 0 ? '#f59e0b' : '#64748b'}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-slate-100 font-mono">{m.mwo}</span>
                  <span className="text-[10px] text-slate-500">{m.bulls} bulletins</span>
                </div>
                <div className="text-[10px] text-slate-400">{m.ac} ac</div>
              </div>
              <div className="flex items-center gap-2 mt-1">
                {m.pen > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-rose-400 bg-rose-500/10 border border-rose-500/40">PEN {m.pen}</span>}
                {m.fwd > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/40">FWD {m.fwd}</span>}
                <div className="flex-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${Math.min(100, m.ac * 6)}%`, backgroundColor: m.pen > 0 ? '#ef4444' : m.fwd > 0 ? '#f59e0b' : '#10b981' }} /></div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="px-3 py-2 text-[9px] text-slate-600 border-t border-slate-800">
        Polygon containment via ray-casting on movement-advected geometry · forward-track projection per ICAO Doc 4444 §4.10 · synthetic catalogue mirrors AWC / EUROCONTROL / RJTD live products
      </div>
    </div>
  )
}
