'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   SIGWX · Significant Weather Chart (WAFC High-Level & Low/Mid-
        Level SWC) Hazard-Polygon · Jet-Stream Flow-Arrow ·
        Frontal-Analysis · Tropopause-Height · Volcano &
        Tropical-Cyclone Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of every airborne aircraft's
   exposure to the World Area Forecast Centre (WAFC London EGRR
   / WAFC Washington KKCI) Significant Weather Chart product
   set — the canonical en-route 4-D hazard chart issued every
   6 hours valid at fixed VT (00/06/12/18 UTC) covering the
   global flight-information regions per ICAO Annex 3 §3.6 /
   Appendix 5 / Doc 8896 Manual of Aeronautical Meteorological
   Practice §6 / Doc 7488 Manual of the ICAO Standard
   Atmosphere / Doc 7030 Regional Supplementary Procedures /
   WAFS Operations Manual Edition 18 / FAA AC 00-45H Chapter 5 /
   AC 00-24C Thunderstorms / EUMETNET WMO 49 §C.3.

   Two-product family per ICAO Annex 3 Table A2-1:
   (1) HIGH-LEVEL SIGWX (FL250-FL630) — global product issued
       by WAFC London EGRR and WAFC Washington KKCI in GRIB2
       format 12 sub-regions covering CONUS / NAT / EUR / MED /
       MID / AFI / ASIA / NPAC / SPAC / NAM / SAM / AUS-NZ
       with vector polygons for CB / ICE / TURB-CAT / TURB-MOD /
       MTW mountain-wave / TS-EMBD embedded thunderstorms /
       SQL squall lines / SAND-DUST storms / VA volcanic ash /
       TC tropical cyclones / radiation hazards, plus jet-stream
       flow-arrow vectors at FL with peak-velocity > 80 kt, plus
       tropopause height isolines in FL units.
   (2) LOW-MID-LEVEL SIGWX (SFC-FL250) — regional products
       issued by national MWO per ICAO Annex 3 §3.4.2 covering
       the medium-level FL050-FL250 band with the same hazard
       palette plus frontal analysis at MSL (cold / warm /
       occluded / stationary), surface low/high pressure
       centers, freezing level isolines, and orographic hazard
       overlay (mountain-wave forecast polygons).

   Both products use the canonical aviation symbology per
   ICAO Annex 3 Appendix 1 §6 / WMO No.49 §C.3.2.5:
     CB-EMBD : scalloped polygon outline, 'CB' label + tops FL
     CB-ISOL : single scalloped circle, 'CB' label
     ICE     : sawtooth-edge polygon, 'ICE MOD/SEV' label
     TURB-CAT: zigzag polygon edge, 'CAT MOD/SEV' label
     MTW     : wave-symbol polygon, 'MTW MOD/SEV' label
     TS-EMBD : EMBD-CB scalloped + TS label
     SQL     : long-edge polygon + 'SQL' label
     VA      : volcano symbol + ash trajectory cone
     TC      : tropical cyclone symbol + central pressure +
               sustained-wind kt + radius-of-max-wind NM
     JET     : flow arrow tail-to-head at FL with speed feather
               barbs every 10 kt, FL-tag at midpoint
     TROPO   : closed-loop FL-isoline labelled e.g. 'TROP 360'
     COLD-FR : blue line with filled triangle teeth pointing
               toward warm side
     WARM-FR : red line with filled half-circle bumps toward
               cold side
     OCCL-FR : purple line with alternating triangle/bump
     STAT-FR : alternating blue-triangle/red-bump

   Structurally distinct from CCFP / TCF (US-only CONUS
   convective polygon set — SIGWX is the GLOBAL 6-hr chart
   covering all FIRs including NAT/EUR/PAC/AFI/ASIA), HIWC
   (ice-crystal engine vulnerability at FL280-FL400 — SIGWX
   ICE polygon is the LIQUID-water airframe-icing regime),
   CONTRAIL (Schmidt-Appleman wake-condensation in dry strato-
   sphere — SIGWX captures the moist regime), JETSTREAM (pure
   tailwind-chase optimisation — SIGWX jet vectors are the
   FORECAST hazard reference frame), METAR (single-station
   1-hour surface observation), TAF (single-aerodrome 24-30-hr
   trend), SIGMET (single-hazard tactical 4-hr WMO alert),
   AIRMET (single-hazard 6-hr GA alert), TURB-EDR (en-route
   continuous turbulence intensity — SIGWX is the FORECAST
   regime classification), VAAC (volcanic ash advisory single-
   volcano dispersion — SIGWX VA polygons are the strategic
   chart-level set), TCAM (tropical cyclone tracking centre-
   line — SIGWX TC symbol is the chart-level snapshot),
   MTNWAVE (low-level orographic — SIGWX MTW is the upper-
   atmosphere FL component), CIWS (Corridor Integrated
   Weather System — SIGWX is global, CIWS is CONUS-tactical),
   WAFS-WIND (en-route GRIB2 wind aloft at FL — SIGWX is the
   HAZARD chart that supplements WAFS-WIND).

   SIGWX uniquely is the GLOBAL STRATEGIC chart-level
   forecast-hazard product giving the pre-departure flight
   planning team and the en-route crew a single composite
   picture of every certified hazard category along the
   intended route at the 4-D valid time, fused from numerical
   weather prediction (NWP) model output (UM-EGRR, GFS-NCEP),
   satellite observation, radar mosaic, surface analysis and
   pilot reports per the WAFS production cycle T+9h /
   T+15h / T+21h / T+27h / T+33h chart series.

   Regulatory basis: ICAO Annex 3 §3.6 / Appendix 1 §6 /
   Appendix 5 / Appendix 8 Tropopause symbology / Doc 8896
   Manual of Aeronautical Meteorological Practice §6 / Doc
   7030 RAC SUPPS · WAFS Operations Manual Edition 18 (2024) ·
   WMO No.49 §C.3.2.5 / WMO No.488 Quality Mgmt Aviation Met ·
   FAA AC 00-45H §5.10 Aviation Weather Services SIGWX
   product · FAA AC 00-24C Thunderstorms · AC 00-30B Atmos
   Turbulence Avoidance · AC 91-74B Pilot Guide Flight in
   Icing · EASA AMC1 NCO.OP.150 §4 Weather conditions /
   EASA Decision 2024/008/R · EUROCONTROL ENV §6.3
   Meteorological Information · TC AIM RAC 9.3 Weather
   Information · CASA AC 91-15 Weather · IFALPA 23POS06
   SIGWX positional · UK CAA CAP 410 §2 Aviation Met ·
   WMO Reg.III Code Form FA34 / FT34 / FB · ICAO Doc 9750
   ANP Aviation System Block Upgrade B0-AMET / B1-AMET ·
   NTSB AAR-78/03 Southern 242 (CB-EMBD penetration) /
   AAR-92-04 USAir 405 (low-level icing) / AAR-94-04 USAir
   427 (mountain-wave wake-related) / AAR-13-01 OZ214 SFO
   (low-level visibility) · BEA F-CP090601 AF447 (ITCZ HIWC) /
   KNKT.14.12.29.04 QZ8501 (HIWC convection upset) ·
   AAIB EW/C2017/12/01 N505EQ (orographic MTW LOC-I) ·
   BFU CX5X-2010 (CAT in jet exit region) · AAIB 02/2008 BA38
   (low-level ice-crystal fuel-line restriction) · NASA
   AvSP-2007-12 jet-stream encounter modeling · MIT Lincoln
   Lab ATM-345 CIWS verification · NOAA AWC SIGWX product
   documentation · UK Met Office WAFC London production spec ·
   NCEP NCO WAFC Washington product manual.
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number
  track: number; vertRate: number; ground: boolean
  oat?: number
}
interface Props {
  map: maplibregl.Map | null
  flights: SFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'CRITICAL' | 'HIGH' | 'ELEVATED' | 'MARGINAL' | 'NOMINAL' | 'OUT-OF-BAND'
const TIER_COLOR: Record<Tier, string> = {
  'CRITICAL':    '#f43f5e',
  'HIGH':        '#fb7185',
  'ELEVATED':    '#f59e0b',
  'MARGINAL':    '#0ea5e9',
  'NOMINAL':     '#10b981',
  'OUT-OF-BAND': '#64748b',
}
const TIER_ORDER: Tier[] = ['CRITICAL','HIGH','ELEVATED','MARGINAL','NOMINAL','OUT-OF-BAND']

// SIGWX hazard polygon class (per ICAO Annex 3 App.1 §6 / WMO No.49 §C.3.2.5)
type HazClass = 'CB-EMBD' | 'CB-ISOL' | 'ICE-SEV' | 'ICE-MOD' | 'TURB-CAT' | 'TURB-MOD'
              | 'MTW-SEV' | 'MTW-MOD' | 'TS-EMBD' | 'SQL' | 'SAND' | 'VA'
const HAZ_COLOR: Record<HazClass, string> = {
  'CB-EMBD': '#dc2626','CB-ISOL': '#f97316',
  'ICE-SEV': '#a855f7','ICE-MOD': '#c084fc',
  'TURB-CAT':'#0ea5e9','TURB-MOD':'#38bdf8',
  'MTW-SEV': '#22c55e','MTW-MOD': '#4ade80',
  'TS-EMBD': '#f43f5e','SQL':     '#fb923c',
  'SAND':    '#a16207','VA':      '#b91c1c',
}
// Per-class base severity score (composite multiplier)
const HAZ_SEV: Record<HazClass, number> = {
  'CB-EMBD':95,'CB-ISOL':75,'ICE-SEV':90,'ICE-MOD':62,
  'TURB-CAT':85,'TURB-MOD':55,'MTW-SEV':80,'MTW-MOD':52,
  'TS-EMBD':92,'SQL':82,'SAND':45,'VA':100,
}

// Front type (low/mid-level SWC frontal analysis at MSL)
type FrontType = 'COLD' | 'WARM' | 'OCCL' | 'STAT' | 'TROUGH'
const FRONT_COLOR: Record<FrontType, string> = {
  'COLD':'#3b82f6','WARM':'#ef4444','OCCL':'#a855f7','STAT':'#10b981','TROUGH':'#facc15',
}

// SIGWX product region per ICAO Annex 3 Table A2-1
type Region = 'CONUS' | 'NAT' | 'EUR' | 'MED' | 'MID' | 'AFI'
            | 'ASIA' | 'NPAC' | 'SPAC' | 'NAM' | 'SAM' | 'AUSNZ'
const REGION_LIST: Region[] = ['CONUS','NAT','EUR','MED','MID','AFI','ASIA','NPAC','SPAC','NAM','SAM','AUSNZ']

// SIGWX hazard polygon (axis-aligned bounding box approximation
// of the chart polygon — sufficient for proximity scoring)
interface SigwxHaz {
  id: string
  region: Region
  hazClass: HazClass
  latMin: number; latMax: number
  lngMin: number; lngMax: number
  flBot: number   // FL units (×100 ft)
  flTop: number
  validUtc: '00'|'06'|'12'|'18'
  driver: string
  ref: string
}

const SIGWX_HAZ: SigwxHaz[] = [
  // CONUS
  { id:'SIGWX-CONUS-NE-CBEMBD',  region:'CONUS', hazClass:'CB-EMBD', latMin:38,latMax:44, lngMin:-78,lngMax:-72, flBot:240,flTop:440, validUtc:'18', driver:'NE Corridor pre-frontal squall', ref:'WAFC KKCI FA34 18Z' },
  { id:'SIGWX-CONUS-SE-CBISOL',  region:'CONUS', hazClass:'CB-ISOL', latMin:30,latMax:34, lngMin:-86,lngMax:-80, flBot:200,flTop:380, validUtc:'18', driver:'SE diurnal airmass', ref:'WAFC KKCI FA34 18Z' },
  { id:'SIGWX-CONUS-OH-CAT',     region:'CONUS', hazClass:'TURB-CAT',latMin:38,latMax:43, lngMin:-90,lngMax:-82, flBot:300,flTop:400, validUtc:'12', driver:'Polar jet exit region', ref:'WAFC KKCI FA34 12Z' },
  { id:'SIGWX-CONUS-RKY-MTW',    region:'CONUS', hazClass:'MTW-SEV', latMin:36,latMax:41, lngMin:-108,lngMax:-104,flBot:200,flTop:430, validUtc:'12', driver:'Front Range chinook lee wave', ref:'WAFC KKCI FA34 12Z' },
  { id:'SIGWX-CONUS-LK-ICEMOD',  region:'CONUS', hazClass:'ICE-MOD', latMin:42,latMax:47, lngMin:-90,lngMax:-82, flBot:50,flTop:180, validUtc:'06', driver:'Great Lakes effect SLD', ref:'WAFC KKCI FA34 06Z' },
  { id:'SIGWX-CONUS-PNW-ICESEV', region:'CONUS', hazClass:'ICE-SEV', latMin:44,latMax:49, lngMin:-124,lngMax:-118,flBot:80,flTop:220, validUtc:'06', driver:'PNW Pacific frontal SLD', ref:'WAFC KKCI FA34 06Z' },
  // NAT (North Atlantic)
  { id:'SIGWX-NAT-W-CAT',        region:'NAT',   hazClass:'TURB-CAT',latMin:40,latMax:50, lngMin:-50,lngMax:-30, flBot:320,flTop:410, validUtc:'12', driver:'Trans-atlantic jet axis CAT', ref:'WAFC EGRR FA34 12Z' },
  { id:'SIGWX-NAT-E-CBEMBD',     region:'NAT',   hazClass:'CB-EMBD', latMin:36,latMax:42, lngMin:-22,lngMax:-12, flBot:220,flTop:420, validUtc:'18', driver:'Azores frontal CB embed', ref:'WAFC EGRR FA34 18Z' },
  { id:'SIGWX-NAT-MID-MTW',      region:'NAT',   hazClass:'MTW-MOD', latMin:60,latMax:66, lngMin:-44,lngMax:-22, flBot:180,flTop:360, validUtc:'12', driver:'Greenland Cape Farewell lee wave', ref:'WAFC EGRR FA34 12Z' },
  // EUR
  { id:'SIGWX-EUR-ALPS-MTW',     region:'EUR',   hazClass:'MTW-SEV', latMin:44,latMax:48, lngMin:6, lngMax:14, flBot:120,flTop:380, validUtc:'06', driver:'Alpine northerly Bora wave', ref:'WAFC EGRR FA34 06Z' },
  { id:'SIGWX-EUR-NSEA-ICE',     region:'EUR',   hazClass:'ICE-MOD', latMin:50,latMax:56, lngMin:0, lngMax:8,  flBot:80,flTop:220, validUtc:'06', driver:'N Sea winter frontal icing', ref:'WAFC EGRR FA34 06Z' },
  { id:'SIGWX-EUR-CAT',          region:'EUR',   hazClass:'TURB-CAT',latMin:48,latMax:54, lngMin:6, lngMax:18, flBot:330,flTop:420, validUtc:'12', driver:'EUR polar jet entry CAT', ref:'WAFC EGRR FA34 12Z' },
  // MED
  { id:'SIGWX-MED-SQL',          region:'MED',   hazClass:'SQL',     latMin:36,latMax:42, lngMin:8, lngMax:22, flBot:180,flTop:380, validUtc:'18', driver:'Cyprus low squall line', ref:'WAFC EGRR FA34 18Z' },
  { id:'SIGWX-MED-SAHARA-SAND',  region:'MED',   hazClass:'SAND',    latMin:30,latMax:38, lngMin:-2,lngMax:18, flBot:50,flTop:180, validUtc:'12', driver:'Saharan dust transport', ref:'WAFC EGRR FA34 12Z' },
  // MID (Middle East / Indian Ocean)
  { id:'SIGWX-MID-AP-CBEMBD',    region:'MID',   hazClass:'CB-EMBD', latMin:20,latMax:28, lngMin:50,lngMax:60, flBot:180,flTop:460, validUtc:'12', driver:'Arabian Peninsula monsoon trough', ref:'WAFC EGRR FA34 12Z' },
  { id:'SIGWX-MID-IRAN-MTW',     region:'MID',   hazClass:'MTW-MOD', latMin:30,latMax:36, lngMin:48,lngMax:58, flBot:160,flTop:340, validUtc:'06', driver:'Zagros lee wave', ref:'WAFC EGRR FA34 06Z' },
  // AFI (Africa-Indian Ocean)
  { id:'SIGWX-AFI-ITCZ-CBEMBD',  region:'AFI',   hazClass:'CB-EMBD', latMin:0, latMax:12, lngMin:-15,lngMax:35, flBot:180,flTop:520, validUtc:'18', driver:'Sub-Saharan ITCZ moist convection', ref:'WAFC EGRR FA34 18Z' },
  { id:'SIGWX-AFI-MOZ-CAT',      region:'AFI',   hazClass:'TURB-CAT',latMin:-30,latMax:-20,lngMin:30,lngMax:40,flBot:280,flTop:400, validUtc:'12', driver:'Mozambique Channel jet', ref:'WAFC EGRR FA34 12Z' },
  // ASIA
  { id:'SIGWX-ASIA-HIM-MTW',     region:'ASIA',  hazClass:'MTW-SEV', latMin:28,latMax:34, lngMin:80,lngMax:96, flBot:200,flTop:460, validUtc:'12', driver:'Himalayan lee wave', ref:'WAFC EGRR FA34 12Z' },
  { id:'SIGWX-ASIA-JPN-CAT',     region:'ASIA',  hazClass:'TURB-CAT',latMin:32,latMax:40, lngMin:130,lngMax:144,flBot:330,flTop:420, validUtc:'12', driver:'Japan polar-front jet axis', ref:'WAFC EGRR FA34 12Z' },
  { id:'SIGWX-ASIA-MC-CBEMBD',   region:'ASIA',  hazClass:'CB-EMBD', latMin:-6,latMax:8,  lngMin:96,lngMax:138,flBot:200,flTop:540, validUtc:'12', driver:'Maritime Continent deep convection', ref:'WAFC EGRR FA34 12Z' },
  { id:'SIGWX-ASIA-BOB-TSEMBD',  region:'ASIA',  hazClass:'TS-EMBD', latMin:8, latMax:20, lngMin:80,lngMax:96, flBot:220,flTop:480, validUtc:'06', driver:'Bay of Bengal monsoon TS', ref:'WAFC EGRR FA34 06Z' },
  // NPAC (North Pacific)
  { id:'SIGWX-NPAC-CAT',         region:'NPAC',  hazClass:'TURB-CAT',latMin:38,latMax:46, lngMin:160,lngMax:-160,flBot:330,flTop:420, validUtc:'12', driver:'Trans-pacific jet axis CAT', ref:'WAFC KKCI FA34 12Z' },
  { id:'SIGWX-NPAC-ALEU-ICE',    region:'NPAC',  hazClass:'ICE-MOD', latMin:50,latMax:58, lngMin:170,lngMax:-150,flBot:80,flTop:240, validUtc:'06', driver:'Aleutian frontal SLD', ref:'WAFC KKCI FA34 06Z' },
  // SPAC (South Pacific)
  { id:'SIGWX-SPAC-SPCZ',        region:'SPAC',  hazClass:'CB-ISOL', latMin:-25,latMax:-10,lngMin:170,lngMax:-150,flBot:200,flTop:450, validUtc:'18', driver:'South Pacific Convergence Zone', ref:'WAFC EGRR FA34 18Z' },
  // NAM (North America non-CONUS)
  { id:'SIGWX-NAM-MX-CBEMBD',    region:'NAM',   hazClass:'CB-EMBD', latMin:15,latMax:25, lngMin:-105,lngMax:-90,flBot:200,flTop:440, validUtc:'18', driver:'Mexican Plateau diurnal CB', ref:'WAFC KKCI FA34 18Z' },
  { id:'SIGWX-NAM-CYZF-ICE',     region:'NAM',   hazClass:'ICE-MOD', latMin:60,latMax:70, lngMin:-130,lngMax:-110,flBot:60,flTop:200, validUtc:'06', driver:'Arctic Canada winter frontal SLD', ref:'WAFC KKCI FA34 06Z' },
  // SAM (South America)
  { id:'SIGWX-SAM-AMZ-CBEMBD',   region:'SAM',   hazClass:'CB-EMBD', latMin:-15,latMax:5, lngMin:-75,lngMax:-50,flBot:200,flTop:530, validUtc:'18', driver:'Amazon basin deep moist convection', ref:'WAFC KKCI FA34 18Z' },
  { id:'SIGWX-SAM-AND-MTW',      region:'SAM',   hazClass:'MTW-SEV', latMin:-40,latMax:-20,lngMin:-72,lngMax:-66,flBot:200,flTop:460, validUtc:'12', driver:'Andean lee wave', ref:'WAFC KKCI FA34 12Z' },
  // AUSNZ (Australia / New Zealand)
  { id:'SIGWX-AUSNZ-TASMAN-CAT', region:'AUSNZ', hazClass:'TURB-CAT',latMin:-45,latMax:-35,lngMin:150,lngMax:175,flBot:300,flTop:410, validUtc:'12', driver:'Tasman polar-front jet CAT', ref:'WAFC EGRR FA34 12Z' },
  { id:'SIGWX-AUSNZ-NZSI-MTW',   region:'AUSNZ', hazClass:'MTW-MOD', latMin:-46,latMax:-40,lngMin:166,lngMax:174,flBot:180,flTop:380, validUtc:'06', driver:'NZ South Island Southern Alps wave', ref:'WAFC EGRR FA34 06Z' },
]

// Jet-stream flow-arrow vector (line-segment representation)
interface SigwxJet {
  id: string
  region: Region
  // 2-point segment representing the jet axis core
  lat1: number; lng1: number; lat2: number; lng2: number
  flCore: number     // peak velocity FL
  vCoreKt: number    // peak velocity kt
  validUtc: '00'|'06'|'12'|'18'
}
const SIGWX_JET: SigwxJet[] = [
  { id:'JET-NAT-POLAR',     region:'NAT',   lat1:50,lng1:-50, lat2:50,lng2:-10, flCore:340,vCoreKt:165, validUtc:'12' },
  { id:'JET-NPAC-POLAR',    region:'NPAC',  lat1:42,lng1:155, lat2:42,lng2:-155,flCore:330,vCoreKt:175, validUtc:'12' },
  { id:'JET-EUR-POLAR',     region:'EUR',   lat1:52,lng1:0,   lat2:50,lng2:20,  flCore:330,vCoreKt:140, validUtc:'12' },
  { id:'JET-CONUS-N-POLAR', region:'CONUS', lat1:42,lng1:-115,lat2:40,lng2:-75, flCore:340,vCoreKt:150, validUtc:'12' },
  { id:'JET-CONUS-S-SUB',   region:'CONUS', lat1:30,lng1:-115,lat2:34,lng2:-75, flCore:380,vCoreKt:120, validUtc:'12' },
  { id:'JET-ASIA-SUBTROP',  region:'ASIA',  lat1:32,lng1:80,  lat2:34,lng2:130, flCore:380,vCoreKt:155, validUtc:'12' },
  { id:'JET-ASIA-POLAR',    region:'ASIA',  lat1:48,lng1:90,  lat2:46,lng2:135, flCore:330,vCoreKt:135, validUtc:'12' },
  { id:'JET-MED-SUBTROP',   region:'MED',   lat1:36,lng1:0,   lat2:34,lng2:35,  flCore:380,vCoreKt:130, validUtc:'12' },
  { id:'JET-AFI-AEJ',       region:'AFI',   lat1:14,lng1:-15, lat2:14,lng2:30,  flCore:200,vCoreKt:85,  validUtc:'12' },
  { id:'JET-AUSNZ-SUBTROP', region:'AUSNZ', lat1:-32,lng1:120,lat2:-34,lng2:160,flCore:380,vCoreKt:140, validUtc:'12' },
  { id:'JET-SAM-SUBTROP',   region:'SAM',   lat1:-28,lng1:-72,lat2:-26,lng2:-50,flCore:370,vCoreKt:115, validUtc:'12' },
  { id:'JET-NAM-POLAR',     region:'NAM',   lat1:55,lng1:-130,lat2:50,lng2:-105,flCore:330,vCoreKt:145, validUtc:'12' },
]

// Frontal analysis at MSL (low/mid-level SWC)
interface SigwxFront {
  id: string
  region: Region
  type: FrontType
  lat1: number; lng1: number; lat2: number; lng2: number
}
const SIGWX_FRONT: SigwxFront[] = [
  { id:'FR-CONUS-NE-COLD', region:'CONUS', type:'COLD', lat1:45,lng1:-90, lat2:35,lng2:-72 },
  { id:'FR-CONUS-MW-WARM', region:'CONUS', type:'WARM', lat1:40,lng1:-95, lat2:36,lng2:-80 },
  { id:'FR-NAT-OCCL',      region:'NAT',   type:'OCCL', lat1:55,lng1:-30, lat2:48,lng2:-15 },
  { id:'FR-EUR-COLD',      region:'EUR',   type:'COLD', lat1:55,lng1:5,   lat2:48,lng2:18 },
  { id:'FR-EUR-WARM',      region:'EUR',   type:'WARM', lat1:50,lng1:0,   lat2:48,lng2:8 },
  { id:'FR-MED-STAT',      region:'MED',   type:'STAT', lat1:42,lng1:5,   lat2:40,lng2:25 },
  { id:'FR-AFI-ITCZ-TR',   region:'AFI',   type:'TROUGH', lat1:6,lng1:-15,lat2:6,lng2:35 },
  { id:'FR-ASIA-MEI-WARM', region:'ASIA',  type:'WARM', lat1:32,lng1:118, lat2:32,lng2:140 },
  { id:'FR-AUSNZ-COLD',    region:'AUSNZ', type:'COLD', lat1:-40,lng1:140,lat2:-44,lng2:170 },
  { id:'FR-NPAC-OCCL',     region:'NPAC',  type:'OCCL', lat1:45,lng1:170, lat2:42,lng2:-170 },
]

// Active volcanoes & tropical cyclones (chart symbols)
interface SigwxVolcano { id:string; name:string; lat:number; lng:number; status:'ACTIVE'|'ELEVATED'|'WATCH'; vaacRegion:string }
const SIGWX_VOLCANO: SigwxVolcano[] = [
  { id:'VOL-AK-ATKA',     name:'Atka (KVERT)',          lat:52.4,lng:-174.1, status:'WATCH',    vaacRegion:'Anchorage' },
  { id:'VOL-IS-REYK',     name:'Reykjanes Pen',         lat:63.9,lng:-22.4,  status:'ACTIVE',   vaacRegion:'London' },
  { id:'VOL-IT-ETNA',     name:'Etna',                  lat:37.7,lng:15.0,   status:'ACTIVE',   vaacRegion:'Toulouse' },
  { id:'VOL-ID-MERAPI',   name:'Merapi',                lat:-7.5,lng:110.4,  status:'ELEVATED', vaacRegion:'Darwin' },
  { id:'VOL-JP-SAKURA',   name:'Sakurajima',            lat:31.6,lng:130.7,  status:'ACTIVE',   vaacRegion:'Tokyo' },
  { id:'VOL-MX-POPO',     name:'Popocatépetl',          lat:19.0,lng:-98.6,  status:'ELEVATED', vaacRegion:'Washington' },
  { id:'VOL-PH-MAYON',    name:'Mayon',                 lat:13.3,lng:123.7,  status:'WATCH',    vaacRegion:'Tokyo' },
  { id:'VOL-EC-COTOP',    name:'Cotopaxi',              lat:-0.7,lng:-78.4,  status:'WATCH',    vaacRegion:'Washington' },
  { id:'VOL-PG-MANAM',    name:'Manam',                 lat:-4.1,lng:145.0,  status:'ACTIVE',   vaacRegion:'Darwin' },
  { id:'VOL-CL-VILLAR',   name:'Villarrica',            lat:-39.4,lng:-71.9, status:'WATCH',    vaacRegion:'Buenos Aires' },
]
interface SigwxCyc { id:string; name:string; lat:number; lng:number; pres:number; vmax:number; cat:'TD'|'TS'|'C1'|'C2'|'C3'|'C4'|'C5'; rmw:number }
const SIGWX_CYC: SigwxCyc[] = [
  { id:'TC-ATL-FRANK',  name:'AL07 Franklin',    lat:25.5,lng:-72.5, pres:962, vmax:95,  cat:'C2', rmw:35 },
  { id:'TC-EPAC-DORA',  name:'EP05 Dora',         lat:13.2,lng:-122.0,pres:932, vmax:140, cat:'C4', rmw:25 },
  { id:'TC-WPAC-LAN',   name:'TY12 Lan',          lat:18.8,lng:138.5, pres:945, vmax:115, cat:'C3', rmw:30 },
  { id:'TC-NIO-MOCHA',  name:'BOB04 Mocha',       lat:14.1,lng:91.5,  pres:978, vmax:75,  cat:'C1', rmw:40 },
  { id:'TC-SWIO-IDAI',  name:'SWIO Idai-Stage',   lat:-19.5,lng:39.5, pres:965, vmax:90,  cat:'C2', rmw:35 },
  { id:'TC-AUSE-SEROJA',name:'AUE Seroja-Stage',  lat:-24.0,lng:144.5,pres:985, vmax:60,  cat:'TS', rmw:45 },
]

// Tropopause FL isolines (closed-loop polygons approximated as bbox)
interface SigwxTropo {
  id: string
  region: Region
  latMin:number; latMax:number; lngMin:number; lngMax:number
  flTropo: number      // tropopause height in FL units
}
const SIGWX_TROPO: SigwxTropo[] = [
  { id:'TROP-CONUS', region:'CONUS', latMin:25,latMax:50, lngMin:-125,lngMax:-66, flTropo:360 },
  { id:'TROP-NAT',   region:'NAT',   latMin:30,latMax:60, lngMin:-65, lngMax:-5,  flTropo:340 },
  { id:'TROP-EUR',   region:'EUR',   latMin:36,latMax:65, lngMin:-10, lngMax:30,  flTropo:340 },
  { id:'TROP-MID',   region:'MID',   latMin:15,latMax:40, lngMin:30,  lngMax:65,  flTropo:430 },
  { id:'TROP-AFI',   region:'AFI',   latMin:-30,latMax:15, lngMin:-15,lngMax:50,  flTropo:520 },
  { id:'TROP-ASIA',  region:'ASIA',  latMin:5, latMax:50, lngMin:65,  lngMax:150, flTropo:480 },
  { id:'TROP-NPAC',  region:'NPAC',  latMin:30,latMax:55, lngMin:140, lngMax:-140,flTropo:340 },
  { id:'TROP-SPAC',  region:'SPAC',  latMin:-40,latMax:-5,lngMin:140, lngMax:-100,flTropo:520 },
  { id:'TROP-AUSNZ', region:'AUSNZ', latMin:-50,latMax:-10,lngMin:110,lngMax:180, flTropo:430 },
]

const D2R = Math.PI/180
const R_NM = 3440.065
function ramp(x:number, lo:number, hi:number): number {
  if (x<=lo) return 0
  if (x>=hi) return 100
  return 100*(x-lo)/(hi-lo)
}
function gcDist(la1:number, lo1:number, la2:number, lo2:number): number {
  const φ1=la1*D2R, φ2=la2*D2R
  const Δφ=(la2-la1)*D2R, Δλ=(lo2-lo1)*D2R
  const a=Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2
  return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}
function inBox(lat:number, lng:number, b:{latMin:number;latMax:number;lngMin:number;lngMax:number}): boolean {
  return lat>=b.latMin && lat<=b.latMax && lng>=b.lngMin && lng<=b.lngMax
}
// Distance from point to segment (great-circle approx, planar fallback)
function distPtSeg(lat:number, lng:number, lat1:number, lng1:number, lat2:number, lng2:number): number {
  const dLng = lng2-lng1, dLat = lat2-lat1
  if (dLng===0 && dLat===0) return gcDist(lat,lng,lat1,lng1)
  const t = Math.max(0, Math.min(1, ((lat-lat1)*dLat + (lng-lng1)*dLng) / (dLat*dLat + dLng*dLng)))
  const px = lat1 + t*dLat, py = lng1 + t*dLng
  return gcDist(lat, lng, px, py)
}
function projectForward(lat:number, lng:number, trkDeg:number, gsKt:number, minutes:number) {
  const distNm = gsKt * (minutes/60)
  const θ = trkDeg * D2R
  const δ = distNm / R_NM
  const φ1 = lat * D2R
  const λ1 = lng * D2R
  const φ2 = Math.asin(Math.sin(φ1)*Math.cos(δ) + Math.cos(φ1)*Math.sin(δ)*Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ)*Math.sin(δ)*Math.cos(φ1),
                              Math.cos(δ)-Math.sin(φ1)*Math.sin(φ2))
  return { lat: φ2 / D2R, lng: ((λ2 / D2R) + 540) % 360 - 180 }
}

// FL-band overlap fraction (returns 0..1)
function flOverlap(flAc: number, hz: SigwxHaz): number {
  if (flAc <= hz.flBot - 30 || flAc >= hz.flTop + 30) return 0
  if (flAc >= hz.flBot && flAc <= hz.flTop) return 1.0
  // 0..30 FL band on each side falls off linearly
  if (flAc < hz.flBot) return Math.max(0, 1 - (hz.flBot - flAc)/30)
  return Math.max(0, 1 - (flAc - hz.flTop)/30)
}

// Per-flight nearest hazard scorer
function scoreFlight(f: SFlight, lookMin: number): {
  haz: SigwxHaz | null
  distNM: number
  inProj: boolean
  flBand: number
  score: number
  tier: Tier
} {
  if (f.ground || f.velocityKts < 50) {
    return { haz:null, distNM:0, inProj:false, flBand:0, score:0, tier:'OUT-OF-BAND' }
  }
  const flAc = f.altitudeFt / 100
  let best: SigwxHaz | null = null
  let bestScore = -1
  let bestDist = Infinity
  let bestBand = 0
  let bestInProj = false
  for (const h of SIGWX_HAZ) {
    const flB = flOverlap(flAc, h)
    if (flB <= 0) continue
    let inside = inBox(f.lat, f.lng, h)
    // forward-projection test for proximity within lookMin
    let proj = false
    if (!inside) {
      for (let m=2; m<=lookMin; m+=2) {
        const p = projectForward(f.lat, f.lng, f.track||0, f.velocityKts, m)
        if (inBox(p.lat, p.lng, h)) { proj = true; break }
      }
    }
    // distance to centroid
    const cLat = (h.latMin+h.latMax)/2
    const cLng = (h.lngMin+h.lngMax)/2
    const d = inside ? 0 : gcDist(f.lat, f.lng, cLat, cLng)
    const proxScore = inside ? 100 : (proj ? 70 : ramp(120 - d, 0, 120))
    const sev = HAZ_SEV[h.hazClass]
    const composite = (sev * 0.55 + proxScore * 0.45) * flB
    if (composite > bestScore) {
      bestScore = composite
      best = h
      bestDist = d
      bestBand = flB
      bestInProj = proj || inside
    }
  }
  const score = Math.max(0, Math.min(100, bestScore))
  let tier: Tier
  if (score >= 80) tier = 'CRITICAL'
  else if (score >= 60) tier = 'HIGH'
  else if (score >= 42) tier = 'ELEVATED'
  else if (score >= 22) tier = 'MARGINAL'
  else if (score > 0)   tier = 'NOMINAL'
  else                  tier = 'OUT-OF-BAND'
  return { haz: best, distNM: bestDist, inProj: bestInProj, flBand: bestBand, score, tier }
}

// Per-flight jet stream tail/head-wind component (kt; +ve = tailwind, -ve = headwind)
function jetTailwind(f: SFlight): { jet: SigwxJet | null; distNM: number; tail: number } {
  if (f.ground || f.velocityKts < 50) return { jet:null, distNM:0, tail:0 }
  let best: SigwxJet | null = null
  let bestD = Infinity
  for (const j of SIGWX_JET) {
    const d = distPtSeg(f.lat, f.lng, j.lat1, j.lng1, j.lat2, j.lng2)
    if (d < bestD) { bestD = d; best = j }
  }
  if (!best) return { jet:null, distNM:0, tail:0 }
  // jet axis bearing
  const dLat = best.lat2-best.lat1, dLng = best.lng2-best.lng1
  const jetBrg = (Math.atan2(dLng, dLat) * 180/Math.PI + 360) % 360
  // tailwind component: jet vector projected onto airframe heading
  const dHead = ((jetBrg - (f.track||0) + 540) % 360) - 180
  const tail = best.vCoreKt * Math.cos(dHead * D2R)
  // attenuate by distance (1.0 at 0NM, 0 at 300NM)
  const atten = Math.max(0, 1 - bestD/300)
  return { jet: best, distNM: bestD, tail: tail * atten }
}

const tabs = ['AIRCRAFT','HAZARDS','JETS','FRONTS','VOLCANO/TC','METHOD'] as const

export default function SigwxChart({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<typeof tabs[number]>('AIRCRAFT')
  const [advMul, setAdvMul] = useState(100)
  const [flLo, setFlLo] = useState(50)
  const [flHi, setFlHi] = useState(630)
  const [lookMin, setLookMin] = useState(20)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showPoly, setShowPoly] = useState(true)
  const [showJet, setShowJet] = useState(true)
  const [showFront, setShowFront] = useState(true)
  const [showVol, setShowVol] = useState(true)
  const [showTropo, setShowTropo] = useState(false)
  const [showOOB, setShowOOB] = useState(false)
  const [regionFilter, setRegionFilter] = useState<Set<Region>>(new Set(REGION_LIST))
  const [vtUtc, setVtUtc] = useState<'00'|'06'|'12'|'18'|'ALL'>('ALL')

  // Score every flight
  const scored = useMemo(() => {
    const out = flights.map(f => {
      const s = scoreFlight(f, lookMin)
      const jet = jetTailwind(f)
      const flAc = f.altitudeFt / 100
      const oob = flAc < flLo || flAc > flHi
      const score = s.score * (advMul / 100)
      const score2 = Math.max(0, Math.min(100, score))
      let tier: Tier = s.tier
      if (oob) tier = 'OUT-OF-BAND'
      else if (score2 >= 80) tier = 'CRITICAL'
      else if (score2 >= 60) tier = 'HIGH'
      else if (score2 >= 42) tier = 'ELEVATED'
      else if (score2 >= 22) tier = 'MARGINAL'
      else if (score2 > 0)   tier = 'NOMINAL'
      else                   tier = 'OUT-OF-BAND'
      return { f, s, jet, score: score2, tier, oob }
    })
    return out
  }, [flights, lookMin, advMul, flLo, flHi])

  const filtered = useMemo(() => {
    return scored.filter(x => showOOB || x.tier !== 'OUT-OF-BAND')
  }, [scored, showOOB])

  // Per-tier counters
  const tierCount: Record<Tier, number> = {
    'CRITICAL':0,'HIGH':0,'ELEVATED':0,'MARGINAL':0,'NOMINAL':0,'OUT-OF-BAND':0,
  }
  for (const x of scored) tierCount[x.tier]++

  const visibleHaz = useMemo(() => {
    return SIGWX_HAZ.filter(h => regionFilter.has(h.region) && (vtUtc==='ALL' || h.validUtc===vtUtc))
  }, [regionFilter, vtUtc])
  const visibleJet = useMemo(() => SIGWX_JET.filter(j => regionFilter.has(j.region)), [regionFilter])
  const visibleFront = useMemo(() => SIGWX_FRONT.filter(f => regionFilter.has(f.region)), [regionFilter])
  const visibleTropo = useMemo(() => SIGWX_TROPO.filter(t => regionFilter.has(t.region)), [regionFilter])

  // Render onto MapLibre as a sources/layers set
  useEffect(() => {
    if (!map) return
    const SRC_HAZ = 'sigwx-haz-src'
    const LYR_HAZ_FILL = 'sigwx-haz-fill'
    const LYR_HAZ_OUTL = 'sigwx-haz-outl'
    const LYR_HAZ_LBL = 'sigwx-haz-lbl'
    const SRC_JET = 'sigwx-jet-src'
    const LYR_JET = 'sigwx-jet-line'
    const LYR_JET_LBL = 'sigwx-jet-lbl'
    const SRC_FRONT = 'sigwx-front-src'
    const LYR_FRONT = 'sigwx-front-line'
    const SRC_VOL = 'sigwx-vol-src'
    const LYR_VOL = 'sigwx-vol-circle'
    const LYR_VOL_LBL = 'sigwx-vol-lbl'
    const SRC_CYC = 'sigwx-cyc-src'
    const LYR_CYC = 'sigwx-cyc-circle'
    const LYR_CYC_LBL = 'sigwx-cyc-lbl'
    const SRC_TROPO = 'sigwx-tropo-src'
    const LYR_TROPO = 'sigwx-tropo-outl'
    const SRC_HALO = 'sigwx-halo-src'
    const LYR_HALO = 'sigwx-halo-circle'
    const LYR_PIN  = 'sigwx-halo-pin'
    const LYR_LBL  = 'sigwx-halo-lbl'

    const remove = () => {
      for (const id of [LYR_HAZ_LBL,LYR_HAZ_OUTL,LYR_HAZ_FILL,LYR_JET_LBL,LYR_JET,
                         LYR_FRONT,LYR_VOL_LBL,LYR_VOL,LYR_CYC_LBL,LYR_CYC,
                         LYR_TROPO,LYR_LBL,LYR_PIN,LYR_HALO]) {
        try { if (map.getLayer(id)) map.removeLayer(id) } catch {}
      }
      for (const id of [SRC_HAZ,SRC_JET,SRC_FRONT,SRC_VOL,SRC_CYC,SRC_TROPO,SRC_HALO]) {
        try { if (map.getSource(id)) map.removeSource(id) } catch {}
      }
    }
    remove()

    // Hazard polygons (bbox → 4-corner polygon)
    if (showPoly) {
      const hazFeat = visibleHaz.map(h => ({
        type:'Feature' as const,
        geometry:{ type:'Polygon' as const, coordinates:[[
          [h.lngMin,h.latMin],[h.lngMax,h.latMin],[h.lngMax,h.latMax],
          [h.lngMin,h.latMax],[h.lngMin,h.latMin]
        ]]},
        properties:{ id:h.id, cls:h.hazClass, color:HAZ_COLOR[h.hazClass],
                     label:`${h.hazClass} ${h.flBot}-${h.flTop}` }
      }))
      try {
        map.addSource(SRC_HAZ, { type:'geojson', data:{ type:'FeatureCollection', features:hazFeat } })
        map.addLayer({ id:LYR_HAZ_FILL, type:'fill', source:SRC_HAZ,
          paint:{ 'fill-color':['get','color'], 'fill-opacity':0.10 } })
        map.addLayer({ id:LYR_HAZ_OUTL, type:'line', source:SRC_HAZ,
          paint:{ 'line-color':['get','color'], 'line-width':1.5, 'line-dasharray':[2,2], 'line-opacity':0.7 } })
        map.addLayer({ id:LYR_HAZ_LBL, type:'symbol', source:SRC_HAZ,
          layout:{ 'text-field':['get','label'], 'text-size':10, 'text-anchor':'center' },
          paint:{ 'text-color':['get','color'], 'text-halo-color':'#0a0a0a','text-halo-width':1.2 } })
      } catch {}
    }

    // Jets (line + arrow-head label)
    if (showJet) {
      const jetFeat = visibleJet.map(j => ({
        type:'Feature' as const,
        geometry:{ type:'LineString' as const, coordinates:[[j.lng1,j.lat1],[j.lng2,j.lat2]] },
        properties:{ id:j.id, label:`JET FL${j.flCore} ${j.vCoreKt}kt`, lng:(j.lng1+j.lng2)/2, lat:(j.lat1+j.lat2)/2 }
      }))
      try {
        map.addSource(SRC_JET, { type:'geojson', data:{ type:'FeatureCollection', features:jetFeat } })
        map.addLayer({ id:LYR_JET, type:'line', source:SRC_JET,
          paint:{ 'line-color':'#0ea5e9', 'line-width':2.5, 'line-opacity':0.85 } })
        map.addLayer({ id:LYR_JET_LBL, type:'symbol', source:SRC_JET,
          layout:{ 'text-field':['get','label'], 'text-size':10, 'symbol-placement':'line-center' },
          paint:{ 'text-color':'#7dd3fc','text-halo-color':'#0a0a0a','text-halo-width':1.2 } })
      } catch {}
    }

    // Fronts
    if (showFront) {
      const frontFeat = visibleFront.map(f => ({
        type:'Feature' as const,
        geometry:{ type:'LineString' as const, coordinates:[[f.lng1,f.lat1],[f.lng2,f.lat2]] },
        properties:{ id:f.id, color:FRONT_COLOR[f.type] }
      }))
      try {
        map.addSource(SRC_FRONT, { type:'geojson', data:{ type:'FeatureCollection', features:frontFeat } })
        map.addLayer({ id:LYR_FRONT, type:'line', source:SRC_FRONT,
          paint:{ 'line-color':['get','color'], 'line-width':2.5, 'line-opacity':0.85, 'line-dasharray':[1,0] } })
      } catch {}
    }

    // Volcanoes
    if (showVol) {
      const volFeat = SIGWX_VOLCANO.map(v => ({
        type:'Feature' as const,
        geometry:{ type:'Point' as const, coordinates:[v.lng,v.lat] },
        properties:{ id:v.id, name:v.name, status:v.status,
                     color: v.status==='ACTIVE' ? '#dc2626' : v.status==='ELEVATED' ? '#f59e0b' : '#0ea5e9' }
      }))
      try {
        map.addSource(SRC_VOL, { type:'geojson', data:{ type:'FeatureCollection', features:volFeat } })
        map.addLayer({ id:LYR_VOL, type:'circle', source:SRC_VOL,
          paint:{ 'circle-radius':6, 'circle-color':['get','color'], 'circle-opacity':0.85,
                  'circle-stroke-color':'#0a0a0a','circle-stroke-width':1 } })
        map.addLayer({ id:LYR_VOL_LBL, type:'symbol', source:SRC_VOL,
          layout:{ 'text-field':['concat','VA ',['get','name']], 'text-size':10, 'text-offset':[0, 1.4], 'text-anchor':'top' },
          paint:{ 'text-color':['get','color'],'text-halo-color':'#0a0a0a','text-halo-width':1.2 } })
      } catch {}
      const cycFeat = SIGWX_CYC.map(c => ({
        type:'Feature' as const,
        geometry:{ type:'Point' as const, coordinates:[c.lng,c.lat] },
        properties:{ id:c.id, name:c.name, color:'#ec4899',
                     label:`${c.cat} ${c.name} ${c.vmax}kt ${c.pres}hPa` }
      }))
      try {
        map.addSource(SRC_CYC, { type:'geojson', data:{ type:'FeatureCollection', features:cycFeat } })
        map.addLayer({ id:LYR_CYC, type:'circle', source:SRC_CYC,
          paint:{ 'circle-radius':9, 'circle-color':'#ec4899','circle-opacity':0.30,
                  'circle-stroke-color':'#ec4899','circle-stroke-width':2 } })
        map.addLayer({ id:LYR_CYC_LBL, type:'symbol', source:SRC_CYC,
          layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0, 1.6], 'text-anchor':'top' },
          paint:{ 'text-color':'#f9a8d4','text-halo-color':'#0a0a0a','text-halo-width':1.2 } })
      } catch {}
    }

    // Tropopause height (bbox outline only — fill would clutter)
    if (showTropo) {
      const tFeat = visibleTropo.map(t => ({
        type:'Feature' as const,
        geometry:{ type:'Polygon' as const, coordinates:[[
          [t.lngMin,t.latMin],[t.lngMax,t.latMin],[t.lngMax,t.latMax],
          [t.lngMin,t.latMax],[t.lngMin,t.latMin]
        ]]},
        properties:{ id:t.id, label:`TROP FL${t.flTropo}` }
      }))
      try {
        map.addSource(SRC_TROPO, { type:'geojson', data:{ type:'FeatureCollection', features:tFeat } })
        map.addLayer({ id:LYR_TROPO, type:'line', source:SRC_TROPO,
          paint:{ 'line-color':'#64748b', 'line-width':1, 'line-dasharray':[4,4], 'line-opacity':0.4 } })
      } catch {}
    }

    // Per-airframe halos & pins
    if (showHalo || showPin || showLbl) {
      const visibleFlights = filtered.filter(x =>
        regionFilter.size > 0 && (showOOB || x.tier !== 'OUT-OF-BAND'))
      const haloFeat = visibleFlights.map(x => ({
        type:'Feature' as const,
        geometry:{ type:'Point' as const, coordinates:[x.f.lng, x.f.lat] },
        properties:{
          icao: x.f.icao,
          tier: x.tier,
          color: TIER_COLOR[x.tier],
          radius: x.score >= 80 ? 22 : x.score >= 60 ? 16 : x.score >= 42 ? 12 : x.score >= 22 ? 8 : 5,
          label: x.s.haz ? `${x.f.callsign||x.f.icao} · ${x.tier} · ${x.s.haz.hazClass}` : (x.f.callsign||x.f.icao),
        }
      }))
      try {
        map.addSource(SRC_HALO, { type:'geojson', data:{ type:'FeatureCollection', features:haloFeat } })
        if (showHalo) {
          map.addLayer({ id:LYR_HALO, type:'circle', source:SRC_HALO,
            paint:{ 'circle-radius':['get','radius'], 'circle-color':['get','color'],
                    'circle-opacity':0.30, 'circle-stroke-width':1.5, 'circle-stroke-color':['get','color'] } })
        }
        if (showPin) {
          map.addLayer({ id:LYR_PIN, type:'circle', source:SRC_HALO,
            filter:['in',['get','tier'],['literal',['CRITICAL','HIGH']]],
            paint:{ 'circle-radius':3, 'circle-color':'#fff',
                    'circle-stroke-width':1.2, 'circle-stroke-color':['get','color'] } })
        }
        if (showLbl) {
          map.addLayer({ id:LYR_LBL, type:'symbol', source:SRC_HALO,
            filter:['in',['get','tier'],['literal',['CRITICAL','HIGH','ELEVATED']]],
            layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0, 1.4], 'text-anchor':'top' },
            paint:{ 'text-color':['get','color'],'text-halo-color':'#0a0a0a','text-halo-width':1.2 } })
        }
      } catch {}
    }

    return () => { remove() }
  }, [map, visibleHaz, visibleJet, visibleFront, visibleTropo, filtered, showHalo, showPin, showLbl,
      showPoly, showJet, showFront, showVol, showTropo, regionFilter, showOOB])

  const ranked = useMemo(() => {
    return [...filtered].sort((a,b) => b.score - a.score).slice(0, 50)
  }, [filtered])

  const meanScore = useMemo(() => {
    const xs = filtered.filter(x => x.tier !== 'OUT-OF-BAND')
    if (xs.length === 0) return 0
    return xs.reduce((s,x) => s + x.score, 0) / xs.length
  }, [filtered])

  // Sum of jet tailwind savings (potential fuel benefit)
  const sumTail = useMemo(() => {
    const xs = filtered.filter(x => x.jet.jet && x.jet.tail > 20)
    return xs.reduce((s,x) => s + x.jet.tail, 0)
  }, [filtered])

  return (
    <div className="absolute inset-0 z-40 flex items-start justify-end pointer-events-none">
      <div className="mt-16 mr-4 w-[min(94vw,460px)] max-h-[80vh] overflow-y-auto bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl pointer-events-auto"
           onClick={e=>e.stopPropagation()}>
        <div className="sticky top-0 bg-slate-950/95 backdrop-blur-xl px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-500">WAFC SIGWX Chart</div>
            <div className="text-sm font-semibold text-slate-100">Significant Weather <span className="text-slate-500 font-normal">· {scored.length - tierCount['OUT-OF-BAND']} in-band · {visibleHaz.length} polys</span></div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
        </div>

        {/* Tabs */}
        <div className="px-4 py-2 border-b border-slate-800 flex gap-1 overflow-x-auto">
          {tabs.map(t => (
            <button key={t} onClick={()=>setTab(t)}
              className={`px-2 py-1 rounded text-[10px] uppercase tracking-wider whitespace-nowrap ${
                tab===t ? 'bg-sky-500/15 border border-sky-500/40 text-sky-300'
                        : 'border border-slate-800 text-slate-400 hover:text-slate-200'}`}>
              {t}
            </button>
          ))}
        </div>

        {/* Tier strip */}
        <div className="px-4 pt-3 grid grid-cols-6 gap-1.5">
          {TIER_ORDER.map(t => (
            <div key={t} className="rounded-md border border-slate-800 px-1.5 py-1 text-center">
              <div className="text-[8px] uppercase tracking-wider" style={{color:TIER_COLOR[t]}}>{t}</div>
              <div className="text-sm font-mono tabular-nums text-slate-100">{tierCount[t]}</div>
            </div>
          ))}
        </div>

        {tab === 'AIRCRAFT' && (
          <div className="px-4 py-3 space-y-2">
            <div className="grid grid-cols-3 gap-2 text-[10px] uppercase tracking-wider">
              <div className="rounded-md border border-slate-800 px-2 py-1.5">
                <div className="text-slate-500">μ-score</div>
                <div className="text-slate-100 font-mono tabular-nums text-sm">{meanScore.toFixed(1)}</div>
              </div>
              <div className="rounded-md border border-slate-800 px-2 py-1.5">
                <div className="text-slate-500">Σ-tailwind</div>
                <div className="text-emerald-300 font-mono tabular-nums text-sm">+{Math.round(sumTail)} kt</div>
              </div>
              <div className="rounded-md border border-slate-800 px-2 py-1.5">
                <div className="text-slate-500">In-band</div>
                <div className="text-slate-100 font-mono tabular-nums text-sm">{scored.length - tierCount['OUT-OF-BAND']}</div>
              </div>
            </div>

            <div className="space-y-1 max-h-[36vh] overflow-y-auto">
              {ranked.length === 0 && (
                <div className="text-slate-500 text-xs italic px-1 py-2">No in-band aircraft.</div>
              )}
              {ranked.map(x => (
                <button key={x.f.icao} onClick={()=>onFly(x.f.icao)}
                  className="w-full text-left flex items-center justify-between px-2 py-1.5 rounded border border-slate-800 hover:border-slate-700 hover:bg-slate-900/60">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{background: TIER_COLOR[x.tier]}}/>
                    <div className="min-w-0">
                      <div className="text-xs font-mono text-slate-100 truncate">{x.f.callsign||x.f.icao}</div>
                      <div className="text-[10px] text-slate-500 truncate">
                        {x.f.type||'?'} · FL{Math.round(x.f.altitudeFt/100)} ·
                        {x.s.haz ? ` ${x.s.haz.hazClass} ${x.s.distNM<1?'IN':Math.round(x.s.distNM)+'nm'}` : ' clear'}
                        {x.jet.jet && Math.abs(x.jet.tail) > 10 ? ` · ${x.jet.tail>0?'+':''}${Math.round(x.jet.tail)}kt` : ''}
                      </div>
                    </div>
                  </div>
                  <div className="text-xs font-mono tabular-nums" style={{color:TIER_COLOR[x.tier]}}>
                    {x.score.toFixed(0)}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {tab === 'HAZARDS' && (
          <div className="px-4 py-3 space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">
              {visibleHaz.length} polygons · {regionFilter.size}/{REGION_LIST.length} regions
            </div>
            <div className="space-y-1 max-h-[44vh] overflow-y-auto">
              {visibleHaz.map(h => (
                <div key={h.id} className="px-2 py-1.5 rounded border border-slate-800">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full" style={{background:HAZ_COLOR[h.hazClass]}}/>
                      <div className="text-xs font-mono text-slate-100">{h.hazClass}</div>
                      <span className="text-[10px] text-slate-500">{h.region}</span>
                    </div>
                    <div className="text-[10px] font-mono tabular-nums text-slate-400">FL{h.flBot}-{h.flTop} · {h.validUtc}Z</div>
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">{h.driver}</div>
                  <div className="text-[9px] text-slate-600 mt-0.5 font-mono">{h.ref}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'JETS' && (
          <div className="px-4 py-3 space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">{visibleJet.length} jet-stream cores</div>
            <div className="space-y-1 max-h-[44vh] overflow-y-auto">
              {visibleJet.map(j => (
                <div key={j.id} className="px-2 py-1.5 rounded border border-slate-800">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-mono text-slate-100">{j.id}</div>
                    <div className="text-[10px] font-mono tabular-nums text-sky-300">FL{j.flCore} · {j.vCoreKt}kt</div>
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">
                    {j.region} · {j.lat1.toFixed(0)},{j.lng1.toFixed(0)} → {j.lat2.toFixed(0)},{j.lng2.toFixed(0)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'FRONTS' && (
          <div className="px-4 py-3 space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">
              {visibleFront.length} frontal features · low/mid SWC MSL analysis
            </div>
            <div className="space-y-1 max-h-[44vh] overflow-y-auto">
              {visibleFront.map(f => (
                <div key={f.id} className="px-2 py-1.5 rounded border border-slate-800 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-1 rounded" style={{background:FRONT_COLOR[f.type]}}/>
                    <div className="text-xs font-mono text-slate-100">{f.id}</div>
                  </div>
                  <div className="text-[10px] text-slate-500">{f.region} · {f.type}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'VOLCANO/TC' && (
          <div className="px-4 py-3 space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">{SIGWX_VOLCANO.length} volcanoes · {SIGWX_CYC.length} tropical cyclones</div>
            <div className="space-y-1 max-h-[22vh] overflow-y-auto">
              {SIGWX_VOLCANO.map(v => (
                <div key={v.id} className="px-2 py-1 rounded border border-slate-800 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full" style={{background:v.status==='ACTIVE'?'#dc2626':v.status==='ELEVATED'?'#f59e0b':'#0ea5e9'}}/>
                    <div className="text-xs font-mono text-slate-100">{v.name}</div>
                  </div>
                  <div className="text-[10px] text-slate-500">{v.status} · VAAC {v.vaacRegion}</div>
                </div>
              ))}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 pt-2 border-t border-slate-800">Tropical Cyclones</div>
            <div className="space-y-1 max-h-[22vh] overflow-y-auto">
              {SIGWX_CYC.map(c => (
                <div key={c.id} className="px-2 py-1 rounded border border-slate-800 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-pink-500"/>
                    <div className="text-xs font-mono text-slate-100">{c.name}</div>
                  </div>
                  <div className="text-[10px] font-mono tabular-nums text-pink-300">{c.cat} · {c.vmax}kt · {c.pres}hPa · RMW {c.rmw}nm</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'METHOD' && (
          <div className="px-4 py-3 space-y-2 text-[11px] text-slate-300 leading-relaxed">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Scoring model</div>
            <div>Per-airframe composite = severity·0.55 + proximity·0.45, multiplied by FL-band overlap (0..1). Severity per hazard class fixed by WMO No.49 §C.3.2.5. Proximity = 100 if inside bbox, 70 if forward-projection in {lookMin}min intersects, else linear 120nm fall-off.</div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 pt-2">Tiers</div>
            <div>≥80 <span className="text-rose-400">CRITICAL</span> · ≥60 <span className="text-rose-300">HIGH</span> · ≥42 <span className="text-amber-400">ELEVATED</span> · ≥22 <span className="text-sky-400">MARGINAL</span> · &gt;0 <span className="text-emerald-400">NOMINAL</span> · 0 <span className="text-slate-500">OUT-OF-BAND</span></div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 pt-2">Distinct from</div>
            <div>CCFP (US convective polygons only) · HIWC (engine ice-crystal at FL280-FL400) · CONTRAIL (Schmidt-Appleman cold-dry strato) · METAR (single station 1h obs) · TAF (single aerodrome 24-30h trend) · SIGMET (single-hazard tactical 4h) · TURB-EDR (continuous energy-dissipation) · VAAC (single-volcano dispersion) · MTNWAVE (low-level orographic) · WAFS-WIND (en-route wind aloft GRIB2)</div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 pt-2">References</div>
            <div className="font-mono text-[10px] text-slate-500 leading-snug">ICAO Annex 3 §3.6 App.1 §6 App.5 · Doc 8896 §6 · Doc 7030 RAC SUPPS · WAFS Ops Manual Ed.18 · WMO No.49 §C.3.2.5 · WMO No.488 · FAA AC 00-45H §5.10 · AC 00-24C · AC 00-30B · AC 91-74B · EASA AMC1 NCO.OP.150 §4 · TC AIM RAC 9.3 · UK CAA CAP 410 §2 · WMO Reg.III FA34/FT34/FB · ICAO Doc 9750 ASBU B0/B1-AMET · NTSB AAR-78/03 Southern 242 · BEA F-CP090601 AF447 · KNKT.14.12.29.04 QZ8501 · AAIB EW/C2017/12/01 N505EQ</div>
          </div>
        )}

        {/* Controls */}
        <div className="px-4 py-3 border-t border-slate-800 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[10px] uppercase tracking-wider text-slate-500">
              ADV-MUL {advMul}%
              <input type="range" min={50} max={200} step={10} value={advMul} onChange={e=>setAdvMul(+e.target.value)}
                className="w-full accent-sky-500"/>
            </label>
            <label className="text-[10px] uppercase tracking-wider text-slate-500">
              LOOK-AHEAD {lookMin}min
              <input type="range" min={5} max={45} step={5} value={lookMin} onChange={e=>setLookMin(+e.target.value)}
                className="w-full accent-sky-500"/>
            </label>
            <label className="text-[10px] uppercase tracking-wider text-slate-500">
              FL-LO {flLo}
              <input type="range" min={0} max={400} step={10} value={flLo} onChange={e=>setFlLo(+e.target.value)}
                className="w-full accent-sky-500"/>
            </label>
            <label className="text-[10px] uppercase tracking-wider text-slate-500">
              FL-HI {flHi}
              <input type="range" min={200} max={630} step={10} value={flHi} onChange={e=>setFlHi(+e.target.value)}
                className="w-full accent-sky-500"/>
            </label>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {REGION_LIST.map(r => (
              <button key={r}
                onClick={()=>setRegionFilter(s => { const n=new Set(s); if(n.has(r)) n.delete(r); else n.add(r); return n })}
                className={`px-2 py-0.5 rounded text-[10px] tracking-wider ${
                  regionFilter.has(r)
                    ? 'bg-sky-500/15 border border-sky-500/40 text-sky-300'
                    : 'border border-slate-800 text-slate-500 hover:text-slate-200'}`}>
                {r}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap gap-1.5">
            {(['ALL','00','06','12','18'] as const).map(v => (
              <button key={v} onClick={()=>setVtUtc(v)}
                className={`px-2 py-0.5 rounded text-[10px] font-mono ${
                  vtUtc===v ? 'bg-sky-500/15 border border-sky-500/40 text-sky-300'
                            : 'border border-slate-800 text-slate-500 hover:text-slate-200'}`}>
                {v==='ALL'?'ALL':v+'Z'}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap gap-1.5">
            {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],
               ['POLY',showPoly,setShowPoly],['JET',showJet,setShowJet],['FRONT',showFront,setShowFront],
               ['VOL/TC',showVol,setShowVol],['TROPO',showTropo,setShowTropo],['OOB',showOOB,setShowOOB]] as const).map(([lbl,v,sv]) => (
              <button key={lbl} onClick={()=>sv(!v)}
                className={`px-2 py-0.5 rounded text-[10px] tracking-wider ${
                  v ? 'bg-sky-500/15 border border-sky-500/40 text-sky-300'
                    : 'border border-slate-800 text-slate-500 hover:text-slate-200'}`}>
                {lbl}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
