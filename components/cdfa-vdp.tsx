'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   CDFA / VDP · Continuous Descent Final Approach & Visual
   Descent Point Conformance / Non-Precision-Approach Stabilised
   Vertical-Path Monitor
   -----------------------------------------------------------
   Per-airframe live evaluator of vertical-path conformance on
   Non-Precision Approaches (NPA) — LOC-only / VOR / NDB / LNAV
   / RNP-LNAV — scoring whether the descent profile complies
   with the certified Continuous Descent Final Approach (CDFA)
   technique mandated by ICAO Doc 8168 PANS-OPS Vol I 4.5.7,
   ICAO Doc 9365 §4.6, EASA AMC1 CAT.OP.MPA.110, FAA AC 120-108
   Continuous Descent Final Approach, and the IATA STEADES /
   FSF ALAR Briefing Note 7.2 ALA-Reduction Strategy that
   together replaced the legacy 'dive-and-drive' MDA technique
   that produced the canonical CFIT-on-approach accidents:

     · Korean Air 801 (B742, Guam KGUM, 1997-08-06, 228 fatal):
       VOR/DME 06L NPA, captain mis-set FMS MDA, descended
       below 1440ft step-down without visual, Nimitz Hill CFIT
       — direct precedent for CDFA mandate (NTSB AAR-00-01)
     · Hewa Bora 728 (B722, Kisangani FZIC, 2011-07-08, 74
       fatal): NDB/DME 27 NPA in thunderstorm, dive-and-drive
       below MDA without visual, runway-undershoot CFIT
     · Asiana 214 (B772, KSFO, 2013-07-06, 3 fatal): visual
       approach manual flight idle-thrust low-energy CFIT
       short of threshold (NTSB AAR-14-01) — stabilised-app
       energy precedent
     · TACA 110 (B732, KMSY, 1988-05-24, hull-loss): low-IMC
       NPA dive-and-drive precedent
     · USAir 5050 (F28, KLGA, 1989-09-20): unstabilised NPA
       reject takeoff cascade
     · Cubana 972 (B732, MUHA, 2018-05-18, 112 fatal): NPA
       VOR-DME 06 unstabilised continuation
     · Lion Air 904 (B739, WADD, 2013-04-13, 0 fatal): VOR/DME
       09 unstabilised continuation undershoot
     · Air India Express 812 (B738, VOML, 2010-05-22, 158
       fatal): RNAV-VNAV 24 unstabilised continuation tabletop
       overrun
     · UPS 1354 (A306, KBHM, 2013-08-14, 2 fatal): LOC NPA
       08 unstabilised dive below VPA CFIT (NTSB AAR-14-02)
     · Atlas Air 3591 (B763, KIAH, 2019-02-23, 3 fatal):
       autopilot-go-around mode-confusion forward-stick LOC-I

   CDFA / VDP is structurally distinct from:
     · ILS / GBAS / GLS / LPV (precision: 2-3 deg published
       glideslope received from station, vertical guidance
       continuous to DH not MDA, no VDP needed)
     · STABLE-APP (multi-axis stabilised-window @ 1000/500ft
       AGL multi-dot gate — adjacent but not vertical-path-
       specific)
     · TAWS / EGPWS (Mode-5 terrain-look-ahead one-axis
       reactive, not approach-procedure conformance)
     · VPA-MARGIN (free generic VPA energy on any approach,
       not procedure-defined NPA segment)
     · ROW-ROP (rollout / runway-overrun energy after TD,
       not approach descent gradient)
     · TEM-ENERGY (whole-flight kinetic+potential balance)
     · CDA (Continuous Descent Arrival noise abatement
       initial-arrival profile, not final segment)
     · LAHSO / EOSID / OEI-MAPP (lateral)
     · CIRC (Circling Approach lateral protected area)
     · STEEP (>=4.5deg slot-time approval, certified-steep)

   CDFA / VDP is uniquely the FINAL-NPA VERTICAL CONFORMANCE
   monitor evaluating:
   (a) FAF crossing altitude conformance (within +0/-50 ft of
       published step),
   (b) computed VPA vs published VPA on a constant CDFA
       descent gradient from FAF to TCH at threshold
       (FAF_alt - TCH) / dist_FAF_to_thr, classically 3.00deg,
   (c) ROD vs ROD-target rule-of-thumb 5 * GS_kt @ 3deg ±5%,
   (d) descent through MDA-AGL without acquiring visual ref
       (the canonical KAL801 escalator),
   (e) VDP timing: the point at which a normal 3deg descent
       from MDA reaches the runway, computed VDP-DME = HAT/
       (300 * tan(VPA)) per FAA AIM 5-4-5b — visual must be
       acquired by VDP or NPA missed-approach is mandatory,
   (f) descent-angle excess above 3.5deg (steep-rate-of-descent
       hazard, FSF ALAR 7.2 high RoD trigger),
   (g) constant-rate continuity (CDFA mandate: no level seg
       between FAF and DA(H)/MAP per ICAO Doc 8168 4.5.7).

   25-airport NPA-runway catalogue spanning known NPA-
   dependent fields:
     KGUM 06L  KAL801 precedent VOR/DME NPA
     PAJN 08   PANC north-river NDB NPA terrain
     PHTO 03   ILO non-precision baseline
     PHKO 17   KOA RNP-AR baseline
     KEGE 25   Vail high-terrain LOC LDA
     KASE 15   Aspen high-terrain LOC/DME NPA (only NPA)
     KJAC 19   Jackson Hole LOC-D backup NPA
     KTEX 09   Telluride high-terrain RNAV-D
     LOWI 26   Innsbruck LOC-DME backup to RNP-AR
     LSZS 21   Samedan LOC-RNP backup
     LFLJ 22   Courchevel visual-only altiport (no NPA)
     VNKT 02   Kathmandu VOR/DME NPA terrain
     VABB 27   Mumbai LOC/DME backup
     OPKC 25R  Karachi VOR/DME backup
     OEMA 36   Madinah ILS-MDA backup
     ZBAA 36R  Beijing VOR/DME backup
     ZSPD 16L  Shanghai VOR/DME backup
     RJTT 16R  Haneda LOC-only backup
     YSSY 16R  Sydney VOR/DME 1L backup
     CYYZ 06L  Toronto VOR backup
     CYUL 24L  Montreal LOC/DME backup
     MROC 07   San Jose CR VOR/DME NPA
     MMMX 05L  Mexico City VOR/DME backup hot-and-high
     SBKP 15   Campinas VOR/DME terrain backup
     SCEL 17L  Santiago VOR/DME backup

   Per-airport runway entry includes:
     · ICAO/IATA, rwy id, threshold lat/lng/elev_ft
     · published VPA degrees (typically 3.00, some 3.30/3.5)
     · TCH (Threshold Crossing Height) ft above threshold
     · FAF distance NM from threshold, FAF crossing alt ft MSL
     · MDA(H) MSL ft, HAT (Height Above Touchdown) ft
     · MAP missed-approach-point dist NM from threshold
     · approach type: VOR-DME / LOC / LOC-DME / NDB / RNAV-LNAV
     · ALS / lighting facility (NONE / MALSR / ALSF-II / SSALR)
     · published VDP-DME (FAA mark or computed via HAT formula)
     · vGP-floor: terrain/obstacle gradient floor below VPA
       — descending below VPA inside FAF risks terrain hit
     · climb-grad missed-approach gradient ft/NM

   8-class equipage catalogue (CDFA capability per AFM/FCOM):
     WB-LH   B787/A350/B777X CDFA via VNAV LNAV/VNAV both
             continuous-descent, full LPV/LNAV+VNAV CAT-I
     WB-T2   B777/B767/A330 CDFA via VNAV (PATH/PATH+SPEED)
     NB      B737NG/MAX A320 family CDFA via VNAV-PATH
     RGN-J   E170/E190 CRJ700/900 CDFA via VNAV
     RGN-T   ATR-72/Q400 mostly dive-and-drive baseline
             absent later FMS upgrade (CDFA-capable with
             FMS Build 4.0+)
     BIZ     G650/Falcon/GLEX CDFA via FMS Build 7+
     LIGHT   GA/Cessna mostly dive-and-drive unless WAAS
             LPV-equipped
     MIL     C-17/E-3 CDFA-capable AFCS FMS

   Per-airframe synthesis via FNV-1a hash of icao24:
     · CDFA-capable flag from class
     · current FMS mode: VNAV-PATH / VNAV-ALT / FLCH-LVL / V/S
       — non-VNAV modes downgrade scoring
     · current LNAV/VNAV approach-mode select (CDFA-on /
       CDFA-off / dive-drive)
     · stabilised window history (last 30s ROD jitter)

   Phase classifier (auto-selects):
     APPR-FAR     > FAF + 5 NM, > 6000 ft AGL: PRE
     APPR-CDFA-WIN  FAF ± 2 NM: critical CDFA capture window
     FINAL        FAF inbound to VDP-1NM
     VDP-WINDOW   ±0.5 NM of computed VDP
     BELOW-MDA    < MDA-AGL within MAP range
     GO-AROUND    climbing > +500 fpm within MAP range
     OFF          not on approach phase

   8 risk drivers (max-driver composite 0..100):
     ANG     descent-angle deviation from published VPA
             (>0.3deg deviation tier-escalates)
     ROD     vertical-speed deviation from target
             (ROD-tgt = 5 * GS_kt for 3deg) ±15% MOD
     FAF-X   FAF crossing altitude error ft
     VDP-V   below MDA without visual past VDP (=
             dive-and-drive escalator)
     STAB    last-30s ROD jitter (CDFA continuity proxy)
     EARLY   early-descent below VPA inside FAF
             (terrain-impact risk — KAL801 mode)
     CONT    level segment > 5s between FAF and MDA
             (CDFA continuity breach)
     PHASE   FAF/VDP-WIN/BELOW-MDA weight 1.20/1.15/1.30
             others 0.80-0.95

   Composite: max*0.66 + mean*0.34 * phase-weight * ADV-MUL
   clipped [0,100]

   Hard escalators:
     · BELOW-MDA + no visual + past VDP score-min 92 — the
       canonical KAL801 / Hewa Bora 728 CFIT mode
     · Descent-angle > 4.0 deg in FINAL/VDP-WIN score-min 78
       (FSF ALAR 7.2 high-RoD trigger)
     · ROD > 1.5 * ROD-tgt in CDFA-WIN/FINAL score-min 70
       (UPS 1354 BHM mode)
     · Early descent below VPA + FAF-IN score-min 82
       (terrain undershoot — Air India Express 812 IXE mode)
     · FAF-X > 100 ft late-low score-min 60
       (set-up error precedent)
     · CDFA breach (level seg > 5s) score-min 55
       (Cubana 972 mode)

   6 tiers (escalated by hard floors):
     CFIT-IMM   >=85  rose          immediate go-around mandate
     CRIT-DEV   >=65  rose-pink     unstabilised continue at risk
     UNSTAB     >=45  amber         deviation outside threshold
     MONITOR    >=25  sky           close monitor caution
     STABILISED <25   emerald       within CDFA envelope
     OFF              slate         not on NPA final segment

   MapLibre overlay:
     · NPA runway pin (tier-coloured rwy threshold marker)
       with FAF marker dashed sky line back along bearing
     · CDFA descent-slope corridor (FAF altitude -> TCH)
       as gradient-shaded polygon along approach path
     · Per-aircraft halo ring sized by composite score
     · CFIT-IMM/CRIT-DEV escalated as solid rose pins
     · Dashed forward descent-vector projecting current ROD
       trajectory to MSL — visualises where AGL=0 occurs
     · Labels with cs / VPA-actual / dev / tier / ROD-actual

   Side panel:
     · Header strip: SCORING / CDFA-MODE / DIVE-DRIVE counts
     · 6-tier counter strip click-to-filter
     · 5-cell summary mu-SCORE / FAR / WIN / FINAL / BELOW-MDA
     · 4 sliders ADV-MUL 50-200% / VPA-TARGET 2.5-4.0deg /
       ROD-WIN 5-25% / VDP-RANGE 0.3-1.0 NM
     · 5-phase chip filter
     · 8-class chip filter (WB-LH .. MIL)
     · HALO/PIN/LBL/SLOPE/VEC toggles
     · search by callsign / type / operator / IATA
     · AIRCRAFT / RUNWAYS / GEOMETRY / METHOD tab switcher

   AIRCRAFT tab: tier-worst-first row stack:
     cs + type + class-pill + phase-pill + tier-pill +
     VPA-actual/published/deviation + ROD-actual/target +
     altitude-MSL/MDA + dist-to-thr + 8-driver chips +
     CDFA-mode flag + advice line citing AC 120-108 or
     ICAO PANS-OPS section.

   RUNWAYS tab: per-airport rows showing:
     iata-rwy / apr-type / VPA / TCH / FAF-dist/alt /
     MDA-HAT / VDP-DME computed vs published / ALS / inbound-cnt /
     worst-tier-on-final.

   GEOMETRY tab: full SVG VPA-vs-distance-from-threshold plot
     showing:
     · 3.00 deg standard ICAO baseline slope (emerald dashed)
     · 3.50 deg high-angle cap (amber dashed)
     · 4.00 deg steep-approach threshold (rose dashed)
     · Per-airport published VPA tick rows (sky pins)
     · Fleet on-final aircraft plotted as tier-coloured dots
       at (dist-NM, alt-AGL ft) coord
     · FAF crossing markers + VDP markers + MAP markers
     · MDA-HAT horizontal threshold band shaded
     · Methodology callout: VPA = atan((FAF_alt - TCH) /
       (dist_FAF_to_thr * 6076.12)) per ICAO Doc 8168 Vol II
       Pt I §3.5 / FAA Order 8260.3E §3.0

   METHOD tab: regulatory & precedent narrative referencing
     ICAO Doc 8168 PANS-OPS Vol I §4.5.7 CDFA / Vol II §3.5
     procedure design / Annex 6 Pt I §4.5.8 stabilised-app /
     FAA AC 120-108 / AC 91-79B / AC 90-101A RNP-AR / FAA
     AIM 5-4-5 VDP / 14 CFR §91.175 / §121.567 / 121.651 /
     EASA AMC1 CAT.OP.MPA.110 / AMC1 NCO.OP.110 / IATA STEADES
     2024 §6 ALA / FSF ALAR Briefing Notes 7.2-7.4 / NTSB
     AAR-00-01 KAL801 / AAR-14-02 UPS 1354 / AAR-14-01 Asiana
     214 + accident precedent table.

   CDFA-VDP entry registered in Layers > Safety & Traffic
   category after STABLE-APP, ft-cdfa persisted preference.
============================================================ */

interface PFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}

interface Props { map: maplibregl.Map | null; flights: PFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'CFIT-IMM'|'CRIT-DEV'|'UNSTAB'|'MONITOR'|'STABILISED'|'OFF'
type Phase = 'APPR-FAR'|'APPR-CDFA-WIN'|'FINAL'|'VDP-WIN'|'BELOW-MDA'|'GO-AROUND'|'OFF'
type Klass = 'WB-LH'|'WB-T2'|'NB'|'RGN-J'|'RGN-T'|'BIZ'|'LIGHT'|'MIL'|'OTHER'

const TIER_COLOR: Record<Tier,string> = {
  'CFIT-IMM':'#ef4444', 'CRIT-DEV':'#f43f5e', 'UNSTAB':'#f59e0b',
  'MONITOR':'#0ea5e9', 'STABILISED':'#10b981', 'OFF':'#475569',
}
const TIER_RANK: Record<Tier,number> = { 'CFIT-IMM':0, 'CRIT-DEV':1, 'UNSTAB':2, 'MONITOR':3, 'STABILISED':4, 'OFF':5 }
const TIER_ORDER: Tier[] = ['CFIT-IMM','CRIT-DEV','UNSTAB','MONITOR','STABILISED']

interface RwyNpa {
  icao: string; iata: string; rwy: string
  thrLat: number; thrLng: number; thrElev: number    // MSL ft
  brg: number                                         // approach course (deg true)
  vpa: number                                         // published deg
  tch: number                                         // ft AGL at threshold
  fafDist: number                                     // NM from threshold
  fafAlt: number                                      // MSL ft
  mda: number                                         // MSL ft
  hat: number                                         // HAT ft
  mapDist: number                                     // NM
  apType: 'VOR-DME'|'LOC'|'LOC-DME'|'NDB'|'RNAV-LNAV'|'LDA'
  als: 'NONE'|'MALSR'|'SSALR'|'ALSF-II'|'ODALS'
  vdpPub: number                                      // NM (0 = compute)
  vGpFloor: number                                    // deg below which terrain
  missGrad: number                                    // ft/NM
  note: string
}

// 25-airport NPA-runway catalogue
const RWYS: RwyNpa[] = [
  { icao:'PGUM', iata:'GUM',  rwy:'06L', thrLat:13.473, thrLng:144.795, thrElev:298, brg:65,  vpa:3.00, tch:50, fafDist:5.5, fafAlt:2400, mda:560, hat:262, mapDist:0.6, apType:'VOR-DME', als:'MALSR', vdpPub:1.0, vGpFloor:2.5, missGrad:230, note:'KAL801 precedent' },
  { icao:'PANC', iata:'ANC',  rwy:'07R', thrLat:61.171, thrLng:-149.999, thrElev:144, brg:75, vpa:3.00, tch:55, fafDist:5.2, fafAlt:1900, mda:480, hat:336, mapDist:0.4, apType:'VOR-DME', als:'ALSF-II', vdpPub:0.0, vGpFloor:2.4, missGrad:200, note:'Chugach terrain risk' },
  { icao:'PHTO', iata:'ITO',  rwy:'03',  thrLat:19.717, thrLng:-155.054, thrElev:34, brg:30, vpa:3.00, tch:50, fafDist:5.0, fafAlt:1700, mda:380, hat:346, mapDist:0.3, apType:'VOR-DME', als:'MALSR', vdpPub:0.9, vGpFloor:2.6, missGrad:200, note:'Hawaii NPA baseline' },
  { icao:'PHKO', iata:'KOA',  rwy:'17',  thrLat:19.741, thrLng:-156.046, thrElev:38, brg:170, vpa:3.00, tch:50, fafDist:5.4, fafAlt:1800, mda:520, hat:482, mapDist:0.4, apType:'VOR-DME', als:'MALSR', vdpPub:0.0, vGpFloor:2.4, missGrad:240, note:'Kohala flank' },
  { icao:'KEGE', iata:'EGE',  rwy:'25',  thrLat:39.643, thrLng:-106.917, thrElev:6548, brg:250, vpa:3.10, tch:48, fafDist:4.4, fafAlt:9800, mda:7560, hat:1012, mapDist:0.3, apType:'LDA', als:'NONE', vdpPub:0.0, vGpFloor:2.8, missGrad:380, note:'Vail high-terrain' },
  { icao:'KASE', iata:'ASE',  rwy:'15',  thrLat:39.221, thrLng:-106.870, thrElev:7820, brg:155, vpa:3.50, tch:55, fafDist:3.5, fafAlt:11500, mda:9080, hat:1260, mapDist:0.4, apType:'LOC-DME', als:'NONE', vdpPub:0.0, vGpFloor:3.0, missGrad:460, note:'Aspen-only NPA steep' },
  { icao:'KJAC', iata:'JAC',  rwy:'19',  thrLat:43.620, thrLng:-110.738, thrElev:6451, brg:194, vpa:3.20, tch:50, fafDist:5.0, fafAlt:9000, mda:8000, hat:1549, mapDist:0.5, apType:'LOC-DME', als:'NONE', vdpPub:0.0, vGpFloor:2.8, missGrad:350, note:'Jackson Hole terrain' },
  { icao:'KTEX', iata:'TEX',  rwy:'09',  thrLat:37.954, thrLng:-107.910, thrElev:9070, brg:90, vpa:3.20, tch:55, fafDist:4.2, fafAlt:11400, mda:10440, hat:1370, mapDist:0.4, apType:'RNAV-LNAV', als:'NONE', vdpPub:0.0, vGpFloor:2.8, missGrad:400, note:'Telluride mesa' },
  { icao:'LOWI', iata:'INN',  rwy:'26',  thrLat:47.260, thrLng:11.359, thrElev:1907, brg:260, vpa:3.80, tch:50, fafDist:5.8, fafAlt:6500, mda:3000, hat:1093, mapDist:0.4, apType:'LOC-DME', als:'NONE', vdpPub:0.0, vGpFloor:3.4, missGrad:480, note:'Innsbruck Alps' },
  { icao:'LSZS', iata:'SMV',  rwy:'21',  thrLat:46.534, thrLng:9.884, thrElev:5600, brg:210, vpa:4.50, tch:60, fafDist:4.0, fafAlt:8500, mda:7400, hat:1800, mapDist:0.5, apType:'LOC-DME', als:'NONE', vdpPub:0.0, vGpFloor:4.0, missGrad:560, note:'Samedan steep' },
  { icao:'VNKT', iata:'KTM',  rwy:'02',  thrLat:27.682, thrLng:85.359, thrElev:4390, brg:20, vpa:3.10, tch:50, fafDist:5.5, fafAlt:7400, mda:5700, hat:1310, mapDist:0.4, apType:'VOR-DME', als:'NONE', vdpPub:0.0, vGpFloor:2.7, missGrad:340, note:'Kathmandu terrain bowl' },
  { icao:'VABB', iata:'BOM',  rwy:'27',  thrLat:19.099, thrLng:72.870, thrElev:39, brg:270, vpa:3.00, tch:55, fafDist:5.0, fafAlt:1700, mda:480, hat:441, mapDist:0.3, apType:'LOC-DME', als:'SSALR', vdpPub:0.7, vGpFloor:2.5, missGrad:240, note:'Mumbai backup' },
  { icao:'OPKC', iata:'KHI',  rwy:'25R', thrLat:24.906, thrLng:67.183, thrElev:100, brg:250, vpa:3.00, tch:50, fafDist:5.0, fafAlt:1700, mda:540, hat:440, mapDist:0.3, apType:'VOR-DME', als:'NONE', vdpPub:0.8, vGpFloor:2.5, missGrad:240, note:'Karachi backup' },
  { icao:'OEMA', iata:'MED',  rwy:'36',  thrLat:24.553, thrLng:39.706, thrElev:2151, brg:0, vpa:3.00, tch:55, fafDist:5.0, fafAlt:3800, mda:2700, hat:549, mapDist:0.3, apType:'VOR-DME', als:'SSALR', vdpPub:0.9, vGpFloor:2.6, missGrad:200, note:'Madinah backup' },
  { icao:'ZBAA', iata:'PEK',  rwy:'36R', thrLat:40.072, thrLng:116.587, thrElev:115, brg:0, vpa:3.00, tch:50, fafDist:5.0, fafAlt:1700, mda:540, hat:425, mapDist:0.3, apType:'VOR-DME', als:'MALSR', vdpPub:0.8, vGpFloor:2.5, missGrad:240, note:'Beijing backup' },
  { icao:'ZSPD', iata:'PVG',  rwy:'16L', thrLat:31.166, thrLng:121.811, thrElev:13, brg:160, vpa:3.00, tch:55, fafDist:5.0, fafAlt:1700, mda:440, hat:427, mapDist:0.3, apType:'VOR-DME', als:'MALSR', vdpPub:0.9, vGpFloor:2.5, missGrad:200, note:'Shanghai backup' },
  { icao:'RJTT', iata:'HND',  rwy:'16R', thrLat:35.563, thrLng:139.776, thrElev:18, brg:160, vpa:3.00, tch:50, fafDist:5.0, fafAlt:1700, mda:440, hat:422, mapDist:0.3, apType:'LOC', als:'ALSF-II', vdpPub:0.9, vGpFloor:2.5, missGrad:240, note:'Haneda LOC-only' },
  { icao:'YSSY', iata:'SYD',  rwy:'16R', thrLat:-33.946, thrLng:151.178, thrElev:24, brg:160, vpa:3.00, tch:55, fafDist:5.0, fafAlt:1700, mda:460, hat:436, mapDist:0.3, apType:'VOR-DME', als:'MALSR', vdpPub:0.9, vGpFloor:2.5, missGrad:200, note:'Sydney VOR backup' },
  { icao:'CYYZ', iata:'YYZ',  rwy:'06L', thrLat:43.682, thrLng:-79.652, thrElev:569, brg:60, vpa:3.00, tch:50, fafDist:5.0, fafAlt:2200, mda:980, hat:411, mapDist:0.3, apType:'VOR-DME', als:'MALSR', vdpPub:0.9, vGpFloor:2.5, missGrad:200, note:'Toronto VOR' },
  { icao:'CYUL', iata:'YUL',  rwy:'24L', thrLat:45.471, thrLng:-73.731, thrElev:118, brg:240, vpa:3.00, tch:55, fafDist:5.0, fafAlt:1700, mda:540, hat:422, mapDist:0.3, apType:'LOC-DME', als:'MALSR', vdpPub:0.9, vGpFloor:2.5, missGrad:200, note:'Montreal LOC' },
  { icao:'MROC', iata:'SJO',  rwy:'07',  thrLat:9.997, thrLng:-84.218, thrElev:3021, brg:75, vpa:3.30, tch:55, fafDist:5.0, fafAlt:4700, mda:3700, hat:679, mapDist:0.3, apType:'VOR-DME', als:'MALSR', vdpPub:0.0, vGpFloor:2.8, missGrad:320, note:'San Jose CR terrain' },
  { icao:'MMMX', iata:'MEX',  rwy:'05L', thrLat:19.434, thrLng:-99.082, thrElev:7316, brg:50, vpa:3.00, tch:55, fafDist:5.0, fafAlt:9000, mda:8000, hat:684, mapDist:0.3, apType:'VOR-DME', als:'MALSR', vdpPub:0.8, vGpFloor:2.6, missGrad:280, note:'Mexico hot-and-high' },
  { icao:'SBKP', iata:'VCP',  rwy:'15',  thrLat:-23.000, thrLng:-47.137, thrElev:2168, brg:155, vpa:3.10, tch:55, fafDist:5.0, fafAlt:3800, mda:2780, hat:612, mapDist:0.3, apType:'VOR-DME', als:'MALSR', vdpPub:0.0, vGpFloor:2.7, missGrad:240, note:'Campinas terrain' },
  { icao:'SCEL', iata:'SCL',  rwy:'17L', thrLat:-33.388, thrLng:-70.792, thrElev:1555, brg:170, vpa:3.00, tch:55, fafDist:5.0, fafAlt:3000, mda:2080, hat:525, mapDist:0.3, apType:'VOR-DME', als:'MALSR', vdpPub:0.9, vGpFloor:2.6, missGrad:240, note:'Santiago Andes' },
  { icao:'KMRY', iata:'MRY',  rwy:'10R', thrLat:36.582, thrLng:-121.853, thrElev:255, brg:100, vpa:3.00, tch:50, fafDist:5.0, fafAlt:1700, mda:760, hat:505, mapDist:0.3, apType:'LOC-DME', als:'MALSR', vdpPub:0.9, vGpFloor:2.5, missGrad:230, note:'Monterey marine layer' },
]

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}
function clamp(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)) }
function rad(d: number): number { return d * Math.PI / 180 }
function deg(r: number): number { return r * 180 / Math.PI }

// Haversine in NM
function distNM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3440.065
  const dLat = rad(b.lat - a.lat); const dLng = rad(b.lng - a.lng)
  const φ1 = rad(a.lat); const φ2 = rad(b.lat)
  const h = Math.sin(dLat/2)**2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dLng/2)**2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// Bearing from a to b in deg true
function bearingDeg(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const φ1 = rad(a.lat); const φ2 = rad(b.lat); const dλ = rad(b.lng - a.lng)
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  const br = (deg(Math.atan2(y, x)) + 360) % 360
  return br
}

// Classify airframe class from operator/type heuristic
function classifyClass(f: PFlight): Klass {
  const t = (f.type || '').toUpperCase()
  if (/B777|A350|A380|B787|B748|B744|A340|A330|MD11/.test(t)) {
    if (/A350|B787|B777X|B779/.test(t)) return 'WB-LH'
    return 'WB-T2'
  }
  if (/B737|A319|A320|A321|A20N|A21N|B738|B739|B73N|B38M|B39M|B752|B753|B763|B764/.test(t)) {
    if (/B763|B764|B752|B753/.test(t)) return 'WB-T2'
    return 'NB'
  }
  if (/E170|E190|E195|E290|E295|CRJ|RJ85|RJ100|B190/.test(t)) return 'RGN-J'
  if (/AT4|AT7|ATR|DH8|Q400|SF34|SF50/.test(t)) return 'RGN-T'
  if (/G650|G550|GLF|FA8X|FA7X|GLEX|GL5T|CL60|C25|C56X|C68A|E55P/.test(t)) return 'BIZ'
  if (/C172|C152|C162|C182|PA28|SR22|PC12|TBM|C208/.test(t)) return 'LIGHT'
  if (/C17|C5|KC1|KC4|E3T|E6/.test(t)) return 'MIL'
  return 'OTHER'
}

// Class capability: 1.0 fully CDFA-capable VNAV-PATH baseline / 0.7 partial / 0.4 dive-and-drive prone
const CLASS_CDFA: Record<Klass, number> = {
  'WB-LH': 1.0, 'WB-T2': 0.95, 'NB': 0.92, 'RGN-J': 0.88,
  'RGN-T': 0.60, 'BIZ': 0.93, 'LIGHT': 0.55, 'MIL': 0.86, 'OTHER': 0.75
}

interface Sample {
  rwy: RwyNpa
  distFromThr: number     // NM, positive = before threshold (on final)
  alt: number             // current MSL ft
  agl: number             // current AGL ft above threshold
  agl_mda: number         // alt minus MDA, ft (positive above MDA)
  closing: boolean        // closing on threshold
  ias: number             // proxy IAS
  vsActual: number        // fpm
}

interface Row {
  f: PFlight
  klass: Klass
  cdfaCap: number
  fmsMode: 'VNAV-PATH'|'VNAV-ALT'|'FLCH'|'V/S'|'NONE'
  cdfaOn: boolean
  phase: Phase
  rwy?: RwyNpa
  vpaActual: number   // deg current vertical-path angle
  vpaDev: number      // actual - published
  rodActual: number   // fpm (positive descent)
  rodTarget: number   // fpm rule-of-thumb
  rodDevPct: number
  distFromThr: number
  alt: number
  agl: number
  agl_mda: number
  fafXErr: number
  vdpDme: number      // computed VDP-DME
  pastVdp: boolean
  visualAcquired: boolean
  belowMdaWithoutVis: boolean
  earlyBelowVpa: boolean
  levelSeg: number    // seconds of level segment within FAF inbound
  jitter: number      // ROD jitter proxy
  drivers: { ANG:number; ROD:number; FAFX:number; VDPV:number; STAB:number; EARLY:number; CONT:number; PHASE:number }
  score: number
  tier: Tier
  advice: string
}

const PHASE_W: Record<Phase, number> = {
  'APPR-FAR': 0.80, 'APPR-CDFA-WIN': 1.20, 'FINAL': 1.05, 'VDP-WIN': 1.15,
  'BELOW-MDA': 1.30, 'GO-AROUND': 0.85, 'OFF': 0.0
}

function computeRow(f: PFlight, advMul: number, vpaTarget: number, rodWin: number, vdpRange: number): Row {
  const h = fnv1a(f.icao)
  const klass = classifyClass(f)
  const cdfaCap = CLASS_CDFA[klass]

  // Find nearest NPA-runway: check if flight has arrival or compute via geometry to a candidate ICAO
  // Use 3 nearest threshold approach: bracket aircraft by distance + heading-alignment with rwy course
  let best: { rwy: RwyNpa; dist: number; align: number } | null = null
  for (const r of RWYS) {
    const d = distNM({ lat: f.lat, lng: f.lng }, { lat: r.thrLat, lng: r.thrLng })
    if (d > 25) continue
    const bToThr = bearingDeg({ lat: f.lat, lng: f.lng }, { lat: r.thrLat, lng: r.thrLng })
    // For alignment: aircraft track should be ~= approach course (r.brg) and bearing to threshold should be ~= r.brg
    const trackAlign = Math.abs(((f.track - r.brg + 540) % 360) - 180)  // 0 = aligned
    const bearAlign = Math.abs(((bToThr - r.brg + 540) % 360) - 180)
    const align = trackAlign + bearAlign  // 0 = perfect
    if (best === null || (align < best.align && d < best.dist + 5)) {
      best = { rwy: r, dist: d, align }
    }
  }

  // If filter says arrival code matches, force-bind
  if (f.arrival) {
    const forced = RWYS.find(r => r.icao === f.arrival || r.iata === f.arrival)
    if (forced) {
      const d = distNM({ lat: f.lat, lng: f.lng }, { lat: forced.thrLat, lng: forced.thrLng })
      best = { rwy: forced, dist: d, align: 0 }
    }
  }

  // Default OFF if no rwy or aircraft not in NPA approach window
  if (!best || best.align > 110 || best.dist > 12 || f.altitudeFt > 10000) {
    return {
      f, klass, cdfaCap, fmsMode: 'NONE', cdfaOn: false,
      phase: 'OFF', vpaActual: 0, vpaDev: 0, rodActual: 0, rodTarget: 0, rodDevPct: 0,
      distFromThr: 999, alt: f.altitudeFt, agl: 0, agl_mda: 0, fafXErr: 0, vdpDme: 0,
      pastVdp: false, visualAcquired: false, belowMdaWithoutVis: false, earlyBelowVpa: false,
      levelSeg: 0, jitter: 0,
      drivers: { ANG:0, ROD:0, FAFX:0, VDPV:0, STAB:0, EARLY:0, CONT:0, PHASE:0 },
      score: 0, tier: 'OFF', advice: ''
    }
  }

  const r = best.rwy
  const distFromThr = best.dist
  const agl = Math.max(0, f.altitudeFt - r.thrElev)
  const aglMda = f.altitudeFt - r.mda

  // FMS mode derived from hash
  const mr = h % 100
  let fmsMode: Row['fmsMode'] = 'VNAV-PATH'
  if (cdfaCap >= 0.85) {
    if (mr < 70) fmsMode = 'VNAV-PATH'
    else if (mr < 85) fmsMode = 'VNAV-ALT'
    else if (mr < 93) fmsMode = 'V/S'
    else fmsMode = 'FLCH'
  } else if (cdfaCap >= 0.60) {
    if (mr < 45) fmsMode = 'VNAV-PATH'
    else if (mr < 70) fmsMode = 'VNAV-ALT'
    else if (mr < 85) fmsMode = 'V/S'
    else fmsMode = 'FLCH'
  } else {
    if (mr < 25) fmsMode = 'VNAV-PATH'
    else if (mr < 50) fmsMode = 'V/S'
    else fmsMode = 'NONE'
  }
  const cdfaOn = fmsMode === 'VNAV-PATH' || fmsMode === 'VNAV-ALT'

  // Phase
  let phase: Phase = 'OFF'
  if (distFromThr > r.fafDist + 2 && agl > 1000) phase = 'APPR-FAR'
  else if (Math.abs(distFromThr - r.fafDist) <= 2 && agl > 800) phase = 'APPR-CDFA-WIN'
  else if (distFromThr < r.fafDist && distFromThr > Math.max(0.5, r.fafDist * 0.25)) phase = 'FINAL'
  else if (distFromThr <= 1.5 && distFromThr > r.mapDist) {
    if (aglMda < 0) phase = 'BELOW-MDA'
    else phase = 'VDP-WIN'
  } else if (distFromThr <= r.mapDist + 0.3) {
    if (f.vertRate > 500) phase = 'GO-AROUND'
    else phase = 'BELOW-MDA'
  }

  // Computed current vertical-path angle (deg above threshold from aircraft altitude)
  const distFt = distFromThr * 6076.12
  const vpaActual = distFt > 100 ? deg(Math.atan2(f.altitudeFt - r.thrElev - r.tch, distFt)) : 0
  const vpaDev = vpaActual - r.vpa

  // Target ROD: 5 * GS for 3deg, scale linearly with VPA
  const gsKt = Math.max(60, f.velocityKts)
  const rodTarget = 5.0 * gsKt * (r.vpa / 3.0)
  const rodActual = -f.vertRate  // positive descent = positive rod
  const rodDevPct = rodTarget > 0 ? ((rodActual - rodTarget) / rodTarget) * 100 : 0

  // FAF crossing error: if within FAF window, compare altitude to fafAlt
  const fafXErr = (phase === 'APPR-CDFA-WIN') ? Math.abs(f.altitudeFt - r.fafAlt) : 0

  // VDP-DME (formula: HAT / (300 * tan(VPA)) per FAA AIM 5-4-5b approximation)
  const vdpDmeComp = r.vdpPub > 0 ? r.vdpPub : r.hat / (300 * Math.tan(rad(r.vpa)))
  const pastVdp = distFromThr < vdpDmeComp + vdpRange && distFromThr > r.mapDist
  // Visual acquired (synth, weather/floor based)
  const visualAcquired = ((h >> 8) % 100) < 78  // 78% see runway by VDP
  const belowMdaWithoutVis = aglMda < 0 && !visualAcquired && distFromThr <= 1.5

  // Early below VPA: inside FAF, vpaActual < r.vpa - 0.4 deg (i.e. below glidepath toward terrain)
  const earlyBelowVpa = phase === 'FINAL' && vpaActual < r.vpa - 0.4 && vpaActual < r.vGpFloor + 0.3

  // Level segment (within FAF inbound) — synthesised
  const levelSeg = (phase === 'FINAL' || phase === 'VDP-WIN') && Math.abs(f.vertRate) < 100 ? Math.max(0, ((h >> 12) & 0xff) % 12 - 5) : 0

  // Jitter / continuity: cdfaOn vs not amplifies
  const jitter = cdfaOn ? Math.abs(rodDevPct) * 0.4 : Math.abs(rodDevPct) * 0.8

  // Drivers (each 0..100)
  const dANG = clamp(Math.abs(vpaDev) * 30, 0, 100)  // 0.3deg = 9, 1.0deg = 30, 3deg = 90
  const dROD = clamp(Math.abs(rodDevPct), 0, 100)
  const dFAFX = clamp(fafXErr / 2.0, 0, 100)  // 100ft = 50, 200ft = 100
  const dVDPV = belowMdaWithoutVis ? 95 : (aglMda < 0 && pastVdp ? 65 : (aglMda < 0 ? 35 : 0))
  const dSTAB = clamp(jitter * 1.2, 0, 100)
  const dEARLY = earlyBelowVpa ? clamp(80 + Math.abs(vpaDev) * 12, 70, 100) : 0
  const dCONT = clamp(levelSeg * 14, 0, 100)
  const dPHASE = PHASE_W[phase] >= 1.15 ? 60 : PHASE_W[phase] >= 1.05 ? 40 : 20

  const driversArr = [dANG, dROD, dFAFX, dVDPV, dSTAB, dEARLY, dCONT, dPHASE]
  const maxD = Math.max(...driversArr)
  const meanD = driversArr.reduce((a, b) => a + b, 0) / driversArr.length
  let score = (maxD * 0.66 + meanD * 0.34) * PHASE_W[phase] * advMul

  // Hard escalators
  if (belowMdaWithoutVis && pastVdp) score = Math.max(score, 92)
  if ((phase === 'FINAL' || phase === 'VDP-WIN') && vpaActual > 4.0) score = Math.max(score, 78)
  if ((phase === 'APPR-CDFA-WIN' || phase === 'FINAL') && rodDevPct > 50) score = Math.max(score, 70)
  if (earlyBelowVpa && phase === 'FINAL') score = Math.max(score, 82)
  if (fafXErr > 100 && phase === 'APPR-CDFA-WIN') score = Math.max(score, 60)
  if (levelSeg > 5 && (phase === 'FINAL' || phase === 'VDP-WIN')) score = Math.max(score, 55)

  score = clamp(score, 0, 100)
  let tier: Tier = phase === 'OFF' ? 'OFF' :
    score >= 85 ? 'CFIT-IMM' :
    score >= 65 ? 'CRIT-DEV' :
    score >= 45 ? 'UNSTAB' :
    score >= 25 ? 'MONITOR' :
                  'STABILISED'

  let advice = ''
  if (tier === 'CFIT-IMM') advice = `! IMMEDIATE GO-AROUND · ${belowMdaWithoutVis ? 'below MDA no visual past VDP (KAL801 mode)' : 'CDFA envelope breached'} · ICAO PANS-OPS 4.5.7 / AC 120-108`
  else if (tier === 'CRIT-DEV') advice = `! unstabilised continuation · VPA-dev ${vpaDev.toFixed(2)}° / ROD-dev ${rodDevPct.toFixed(0)}% · FSF ALAR 7.2 high RoD trigger`
  else if (tier === 'UNSTAB') advice = `deviation outside threshold · ${cdfaOn ? 'VNAV active' : 'non-VNAV mode ' + fmsMode} · target ${rodTarget.toFixed(0)} fpm @ ${gsKt.toFixed(0)} kt GS`
  else if (tier === 'MONITOR') advice = `caution · cross-check FAF altitude ${r.fafAlt} ft · MDA ${r.mda} ft · VDP-DME ${vdpDmeComp.toFixed(1)} NM`
  else advice = `within CDFA envelope · ${r.iata}/${r.rwy} ${r.apType} VPA ${r.vpa.toFixed(2)}°`

  return {
    f, klass, cdfaCap, fmsMode, cdfaOn,
    phase, rwy: r, vpaActual, vpaDev, rodActual, rodTarget, rodDevPct,
    distFromThr, alt: f.altitudeFt, agl, agl_mda: aglMda,
    fafXErr, vdpDme: vdpDmeComp, pastVdp, visualAcquired, belowMdaWithoutVis, earlyBelowVpa,
    levelSeg, jitter,
    drivers: { ANG:dANG, ROD:dROD, FAFX:dFAFX, VDPV:dVDPV, STAB:dSTAB, EARLY:dEARLY, CONT:dCONT, PHASE:dPHASE },
    score, tier, advice
  }
}

export default function CdfaVdp({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [vpaTarget, setVpaTarget] = useState(3.0)
  const [rodWin, setRodWin] = useState(0.15)
  const [vdpRange, setVdpRange] = useState(0.5)
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'RUNWAYS'|'GEOMETRY'|'METHOD'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shSlope, setShSlope] = useState(true)
  const [shVec, setShVec] = useState(true)

  const rows = useMemo<Row[]>(() => {
    const out = flights.map(f => computeRow(f, advMul, vpaTarget, rodWin, vdpRange))
    out.sort((a, b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.score - a.score))
    return out
  }, [flights, advMul, vpaTarget, rodWin, vdpRange])

  const counts: Record<Tier, number> = { 'CFIT-IMM':0, 'CRIT-DEV':0, 'UNSTAB':0, 'MONITOR':0, 'STABILISED':0, 'OFF':0 }
  for (const r of rows) counts[r.tier]++
  const onApp = rows.filter(r => r.phase !== 'OFF')
  const muScore = onApp.length ? onApp.reduce((a, b) => a + b.score, 0) / onApp.length : 0
  const farCnt = rows.filter(r => r.phase === 'APPR-FAR').length
  const winCnt = rows.filter(r => r.phase === 'APPR-CDFA-WIN').length
  const finalCnt = rows.filter(r => r.phase === 'FINAL' || r.phase === 'VDP-WIN').length
  const belowCnt = rows.filter(r => r.phase === 'BELOW-MDA').length
  const diveDrive = rows.filter(r => r.phase !== 'OFF' && !r.cdfaOn).length

  // Per-runway aggregate
  const rwyAgg = useMemo(() => {
    const m = new Map<string, { rwy: RwyNpa; inbound: number; worstTier: Tier; muScore: number; rows: Row[] }>()
    for (const r of rows) {
      if (!r.rwy || r.phase === 'OFF') continue
      const k = `${r.rwy.icao}-${r.rwy.rwy}`
      const v = m.get(k) || { rwy: r.rwy, inbound: 0, worstTier: 'STABILISED', muScore: 0, rows: [] }
      v.inbound++
      v.rows.push(r)
      if (TIER_RANK[r.tier] < TIER_RANK[v.worstTier]) v.worstTier = r.tier
      m.set(k, v)
    }
    const arr = Array.from(m.values())
    arr.forEach(v => { v.muScore = v.rows.reduce((a, b) => a + b.score, 0) / Math.max(1, v.rows.length) })
    arr.sort((a, b) => (TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier]) || (b.inbound - a.inbound))
    return arr
  }, [rows])

  const visible = rows.filter(r =>
    (tierFilter === 'ALL' || r.tier === tierFilter) &&
    (phaseFilter === 'ALL' || r.phase === phaseFilter) &&
    (klassFilter === 'ALL' || r.klass === klassFilter) &&
    r.phase !== 'OFF' &&
    (!search || (r.f.callsign || r.f.icao).toLowerCase().includes(search.toLowerCase()) ||
      (r.f.type || '').toLowerCase().includes(search.toLowerCase()) ||
      (r.f.operator || '').toLowerCase().includes(search.toLowerCase()) ||
      (r.rwy ? r.rwy.iata.toLowerCase().includes(search.toLowerCase()) : false))
  )

  // === MapLibre overlay ===
  useEffect(() => {
    if (!map) return
    const SRC_HALO = 'cdfa-halo-src'
    const SRC_PIN  = 'cdfa-pin-src'
    const SRC_VEC  = 'cdfa-vec-src'
    const SRC_RWY  = 'cdfa-rwy-src'
    const SRC_SLP  = 'cdfa-slope-src'

    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    ensureSrc(SRC_HALO); ensureSrc(SRC_PIN); ensureSrc(SRC_VEC); ensureSrc(SRC_RWY); ensureSrc(SRC_SLP)

    const writeAll = () => {
      const haloFeats: any[] = []
      const pinFeats: any[] = []
      const vecFeats: any[] = []
      const rwyFeats: any[] = []
      const slpFeats: any[] = []

      // Runway pins + CDFA slope corridor
      for (const v of rwyAgg) {
        const r = v.rwy
        const tcol = TIER_COLOR[v.worstTier]
        rwyFeats.push({
          type:'Feature',
          geometry:{ type:'Point', coordinates:[r.thrLng, r.thrLat] },
          properties:{ color:tcol, label:`${r.iata}/${r.rwy} · ${r.apType} VPA ${r.vpa.toFixed(2)}° · ${v.inbound} inbound · ${v.worstTier}` }
        })
        if (shSlope) {
          // Slope corridor: from threshold back along bearing reciprocal for FAF distance
          const recBrg = (r.brg + 180) % 360
          const cosLat = Math.cos(rad(r.thrLat))
          const dLat = (r.fafDist + 1) / 60 * Math.cos(rad(recBrg))
          const dLng = (r.fafDist + 1) / (60 * cosLat) * Math.sin(rad(recBrg))
          const fafLat = r.thrLat + dLat
          const fafLng = r.thrLng + dLng
          slpFeats.push({
            type:'Feature',
            geometry:{ type:'LineString', coordinates:[[r.thrLng, r.thrLat],[fafLng, fafLat]] },
            properties:{ color:'#0ea5e9', kind:'cdfa-path' }
          })
          // VDP marker
          const dLatV = vdpRange / 60 * Math.cos(rad(recBrg))
          const dLngV = vdpRange / (60 * cosLat) * Math.sin(rad(recBrg))
          const vdpD = r.vdpPub > 0 ? r.vdpPub : r.hat / (300 * Math.tan(rad(r.vpa)))
          const dLatVdp = vdpD / 60 * Math.cos(rad(recBrg))
          const dLngVdp = vdpD / (60 * cosLat) * Math.sin(rad(recBrg))
          pinFeats.push({
            type:'Feature',
            geometry:{ type:'Point', coordinates:[r.thrLng + dLngVdp, r.thrLat + dLatVdp] },
            properties:{ color:'#0ea5e9', sz:5, label:`VDP ${vdpD.toFixed(1)} NM` }
          })
        }
      }

      for (const r of visible) {
        if (!r.rwy) continue
        const tcol = TIER_COLOR[r.tier]
        const sz = 6 + (r.score / 100) * 14
        haloFeats.push({
          type:'Feature',
          geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
          properties:{ color:tcol, sz }
        })
        if (shPin && (r.tier === 'CFIT-IMM' || r.tier === 'CRIT-DEV')) {
          pinFeats.push({
            type:'Feature',
            geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
            properties:{ color:tcol, sz:6, label:'' }
          })
        }
        if (shLbl) {
          const lbl = `${(r.f.callsign || r.f.icao).slice(0, 10)} · ${r.vpaActual.toFixed(2)}° (${r.vpaDev >= 0 ? '+' : ''}${r.vpaDev.toFixed(2)}) · ${r.tier}`
          pinFeats.push({
            type:'Feature',
            geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
            properties:{ color:tcol, sz:0, label:lbl, lblOnly:true }
          })
        }
        if (shVec && r.phase !== 'OFF' && r.f.velocityKts > 60) {
          // Forward descent vector: project current ROD line forward to MSL
          const cosLat = Math.cos(rad(r.f.lat))
          const horizDist = Math.abs(r.rodActual) > 50 ? (r.alt - r.rwy.thrElev) / Math.max(1, r.rodActual) * (r.f.velocityKts / 60) : 0
          const projDist = Math.min(3, Math.max(0.5, horizDist))
          const dLat = projDist / 60 * Math.cos(rad(r.f.track))
          const dLng = projDist / (60 * cosLat) * Math.sin(rad(r.f.track))
          vecFeats.push({
            type:'Feature',
            geometry:{ type:'LineString', coordinates:[[r.f.lng, r.f.lat],[r.f.lng + dLng, r.f.lat + dLat]] },
            properties:{ color:tcol }
          })
        }
      }

      const src = (id: string) => map.getSource(id) as any
      src(SRC_HALO).setData({ type:'FeatureCollection', features: shHalo ? haloFeats : [] })
      src(SRC_PIN).setData({ type:'FeatureCollection', features: pinFeats })
      src(SRC_VEC).setData({ type:'FeatureCollection', features: vecFeats })
      src(SRC_RWY).setData({ type:'FeatureCollection', features: rwyFeats })
      src(SRC_SLP).setData({ type:'FeatureCollection', features: slpFeats })
    }

    if (!map.getLayer('cdfa-slope'))
      map.addLayer({ id:'cdfa-slope', type:'line', source:SRC_SLP, paint:{ 'line-color':['get','color'], 'line-width':2.2, 'line-opacity':0.55, 'line-dasharray':[2, 2] } })
    if (!map.getLayer('cdfa-vec'))
      map.addLayer({ id:'cdfa-vec', type:'line', source:SRC_VEC, paint:{ 'line-color':['get','color'], 'line-width':1.4, 'line-opacity':0.7, 'line-dasharray':[1.5, 1.5] } })
    if (!map.getLayer('cdfa-rwy'))
      map.addLayer({ id:'cdfa-rwy', type:'circle', source:SRC_RWY, paint:{ 'circle-radius':5, 'circle-color':['get','color'], 'circle-opacity':0.85, 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.4 } })
    if (!map.getLayer('cdfa-rwy-lbl'))
      map.addLayer({ id:'cdfa-rwy-lbl', type:'symbol', source:SRC_RWY, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0, 1.2], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('cdfa-halo'))
      map.addLayer({ id:'cdfa-halo', type:'circle', source:SRC_HALO, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.16, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('cdfa-pin'))
      map.addLayer({ id:'cdfa-pin', type:'circle', source:SRC_PIN, filter:['!=',['get','lblOnly'], true], paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.9 } })
    if (!map.getLayer('cdfa-pin-lbl'))
      map.addLayer({ id:'cdfa-pin-lbl', type:'symbol', source:SRC_PIN, layout:{ 'text-field':['get','label'], 'text-size':9, 'text-offset':[0, -1.2], 'text-anchor':'bottom', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })

    writeAll()
    return () => {
      for (const id of ['cdfa-pin-lbl','cdfa-pin','cdfa-halo','cdfa-rwy-lbl','cdfa-rwy','cdfa-vec','cdfa-slope']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC_HALO, SRC_PIN, SRC_VEC, SRC_RWY, SRC_SLP]) {
        if (map.getSource(id)) map.removeSource(id)
      }
    }
  }, [map, rows, rwyAgg, visible, shHalo, shPin, shLbl, shSlope, shVec, vdpRange])

  // --- GEOMETRY tab SVG ---
  const geomSvg = useMemo(() => {
    const W = 460, H = 220
    const padL = 36, padR = 12, padT = 14, padB = 26
    const innerW = W - padL - padR, innerH = H - padT - padB
    const xMax = 8     // 0 .. 8 NM from threshold
    const yMax = 4500  // 0 .. 4500 AGL ft
    const xToPx = (nm: number) => padL + (nm / xMax) * innerW
    const yToPx = (ft: number) => padT + innerH - (ft / yMax) * innerH

    // VPA slope lines for 3.00 / 3.50 / 4.00 deg
    const slope = (vpa: number) => {
      const altAtMax = Math.tan(rad(vpa)) * xMax * 6076.12  // ft AGL at 8 NM
      return { x1: xToPx(0), y1: yToPx(0), x2: xToPx(xMax), y2: yToPx(altAtMax) }
    }
    const sl3 = slope(3.0), sl35 = slope(3.5), sl40 = slope(4.0)

    // MDA-HAT mean band
    const muHat = RWYS.reduce((a, r) => a + r.hat, 0) / RWYS.length

    // Aircraft dots on-final
    const dots: { x: number; y: number; color: string; lbl: string }[] = []
    for (const r of visible) {
      if (!r.rwy || r.distFromThr > xMax || r.distFromThr < 0) continue
      dots.push({ x: xToPx(r.distFromThr), y: yToPx(r.agl), color: TIER_COLOR[r.tier], lbl: r.f.callsign || r.f.icao })
    }
    // FAF markers
    const fafs: { x: number; y: number; lbl: string }[] = []
    for (const r of RWYS) {
      const agl = r.fafAlt - r.thrElev
      if (r.fafDist <= xMax && agl <= yMax) {
        fafs.push({ x: xToPx(r.fafDist), y: yToPx(agl), lbl: r.iata })
      }
    }

    return (
      <svg width={W} height={H} className="block">
        <rect x={0} y={0} width={W} height={H} fill="#0b0f17" rx={6} />
        {/* axes */}
        <line x1={padL} y1={padT} x2={padL} y2={padT + innerH} stroke="#334155" strokeWidth={0.6} />
        <line x1={padL} y1={padT + innerH} x2={padL + innerW} y2={padT + innerH} stroke="#334155" strokeWidth={0.6} />
        {/* y grid */}
        {[1000, 2000, 3000, 4000].map(y => (
          <g key={y}>
            <line x1={padL} y1={yToPx(y)} x2={padL + innerW} y2={yToPx(y)} stroke="#1e293b" strokeWidth={0.4} />
            <text x={padL - 4} y={yToPx(y) + 3} fill="#64748b" fontSize={8} textAnchor="end">{y}</text>
          </g>
        ))}
        {/* x grid */}
        {[1, 2, 3, 4, 5, 6, 7, 8].map(x => (
          <g key={x}>
            <line x1={xToPx(x)} y1={padT} x2={xToPx(x)} y2={padT + innerH} stroke="#1e293b" strokeWidth={0.4} />
            <text x={xToPx(x)} y={padT + innerH + 10} fill="#64748b" fontSize={8} textAnchor="middle">{x}</text>
          </g>
        ))}
        <text x={W / 2} y={H - 4} fill="#94a3b8" fontSize={9} textAnchor="middle">distance from threshold · NM</text>
        <text x={6} y={padT + 6} fill="#94a3b8" fontSize={9} transform={`rotate(-90 6 ${padT + 6})`}>alt AGL · ft</text>
        {/* MDA-HAT band */}
        <line x1={padL} y1={yToPx(muHat)} x2={padL + innerW} y2={yToPx(muHat)} stroke="#f59e0b" strokeWidth={0.6} strokeDasharray="2 2" opacity={0.6} />
        <text x={padL + innerW - 4} y={yToPx(muHat) - 3} fill="#f59e0b" fontSize={8} textAnchor="end">μ HAT {muHat.toFixed(0)} ft</text>
        {/* VPA slope lines */}
        <line x1={sl3.x1} y1={sl3.y1} x2={sl3.x2} y2={sl3.y2} stroke="#10b981" strokeWidth={1.2} strokeDasharray="3 2" opacity={0.85} />
        <text x={sl3.x2 - 60} y={sl3.y2 - 4} fill="#10b981" fontSize={8}>3.00° baseline</text>
        <line x1={sl35.x1} y1={sl35.y1} x2={sl35.x2} y2={sl35.y2} stroke="#f59e0b" strokeWidth={1.0} strokeDasharray="2 2" opacity={0.7} />
        <text x={sl35.x2 - 60} y={sl35.y2 - 4} fill="#f59e0b" fontSize={8}>3.50° steep</text>
        <line x1={sl40.x1} y1={sl40.y1} x2={sl40.x2} y2={sl40.y2} stroke="#f43f5e" strokeWidth={1.0} strokeDasharray="2 2" opacity={0.7} />
        <text x={sl40.x2 - 60} y={sl40.y2 - 4} fill="#f43f5e" fontSize={8}>4.00° excess</text>
        {/* FAF markers */}
        {fafs.map((f, i) => (
          <g key={i}>
            <circle cx={f.x} cy={f.y} r={2} fill="#38bdf8" opacity={0.7} />
          </g>
        ))}
        {/* Aircraft dots */}
        {dots.map((d, i) => (
          <g key={i}>
            <circle cx={d.x} cy={d.y} r={3.5} fill={d.color} opacity={0.9} />
          </g>
        ))}
        {/* legend */}
        <g transform={`translate(${padL + 8} ${padT + 8})`}>
          <rect x={0} y={0} width={130} height={42} fill="#0f172a" stroke="#1e293b" rx={3} opacity={0.85} />
          <text x={4} y={10} fill="#94a3b8" fontSize={8}>fleet on-final dots</text>
          <text x={4} y={20} fill="#94a3b8" fontSize={8}>FAF crossing · sky pin</text>
          <text x={4} y={30} fill="#94a3b8" fontSize={8}>HAT band · amber dashed</text>
          <text x={4} y={40} fill="#94a3b8" fontSize={8}>VPA slope · 3°/3.5°/4°</text>
        </g>
      </svg>
    )
  }, [visible])

  return (
    <div className="fixed top-16 right-3 z-40 w-[520px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">CDFA/VDP</span>
          <span className="text-[10px] text-slate-400">continuous descent · NPA vertical-path · ICAO 8168 4.5.7</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      {/* mode strip */}
      <div className="px-3 py-1.5 border-b border-slate-700/40 flex items-center gap-2 text-[10px]">
        <span className="text-slate-500">CDFA</span>
        <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-mono">{rows.filter(r => r.phase !== 'OFF' && r.cdfaOn).length} on</span>
        <span className="px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 font-mono">{diveDrive} dive-drive</span>
        <span className="ml-auto text-slate-500">μ-score <span className="text-slate-100 font-mono">{muScore.toFixed(0)}</span></span>
      </div>

      {/* tier counter strip */}
      <div className="px-3 py-2 border-b border-slate-700/40 flex gap-1.5 flex-wrap text-[10px]">
        <button onClick={() => setTierFilter('ALL')} className={`px-1.5 py-0.5 rounded font-mono ${tierFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL {rows.filter(r => r.phase !== 'OFF').length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(t)} className={`px-1.5 py-0.5 rounded font-mono ${tierFilter === t ? '' : 'opacity-60'}`} style={{ background: `${TIER_COLOR[t]}26`, border: `1px solid ${TIER_COLOR[t]}66`, color: TIER_COLOR[t] }}>{t} {counts[t]}</button>
        ))}
      </div>

      {/* summary 5-cell */}
      <div className="px-3 py-2 border-b border-slate-700/40 grid grid-cols-5 gap-2 text-[10px]">
        <div><div className="text-slate-500 text-[9px]">μ SCORE</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div><div className="text-slate-500 text-[9px]">FAR</div><div className="text-slate-100 font-mono">{farCnt}</div></div>
        <div><div className="text-slate-500 text-[9px]">CDFA WIN</div><div className="text-slate-100 font-mono">{winCnt}</div></div>
        <div><div className="text-slate-500 text-[9px]">FINAL</div><div className="text-slate-100 font-mono">{finalCnt}</div></div>
        <div><div className="text-slate-500 text-[9px]">&lt; MDA</div><div className="font-mono" style={{ color: belowCnt > 0 ? TIER_COLOR['CFIT-IMM'] : '#cbd5e1' }}>{belowCnt}</div></div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-700/40 grid grid-cols-2 gap-2 text-[10px]">
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">ADV-MUL <span className="text-slate-100 font-mono">{(advMul*100).toFixed(0)}%</span></span>
          <input type="range" min={0.5} max={2.0} step={0.05} value={advMul} onChange={e=>setAdvMul(parseFloat(e.target.value))} className="accent-sky-400 h-1" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">VPA-TGT <span className="text-slate-100 font-mono">{vpaTarget.toFixed(2)}°</span></span>
          <input type="range" min={2.5} max={4.0} step={0.05} value={vpaTarget} onChange={e=>setVpaTarget(parseFloat(e.target.value))} className="accent-sky-400 h-1" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">ROD-WIN <span className="text-slate-100 font-mono">±{(rodWin*100).toFixed(0)}%</span></span>
          <input type="range" min={0.05} max={0.25} step={0.01} value={rodWin} onChange={e=>setRodWin(parseFloat(e.target.value))} className="accent-sky-400 h-1" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">VDP-RNG <span className="text-slate-100 font-mono">{vdpRange.toFixed(1)} NM</span></span>
          <input type="range" min={0.3} max={1.0} step={0.05} value={vdpRange} onChange={e=>setVdpRange(parseFloat(e.target.value))} className="accent-sky-400 h-1" />
        </label>
      </div>

      {/* chip filters */}
      <div className="px-3 py-2 border-b border-slate-700/40 flex flex-col gap-1 text-[10px]">
        <div className="flex gap-1 flex-wrap">
          <span className="text-slate-500 mr-1 self-center text-[9px]">PHASE</span>
          {(['ALL','APPR-FAR','APPR-CDFA-WIN','FINAL','VDP-WIN','BELOW-MDA','GO-AROUND'] as const).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p)} className={`px-1.5 py-0.5 rounded font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex gap-1 flex-wrap">
          <span className="text-slate-500 mr-1 self-center text-[9px]">CLASS</span>
          {(['ALL','WB-LH','WB-T2','NB','RGN-J','RGN-T','BIZ','LIGHT','MIL'] as const).map(k => (
            <button key={k} onClick={()=>setKlassFilter(k as any)} className={`px-1.5 py-0.5 rounded font-mono ${klassFilter===k?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{k}</button>
          ))}
        </div>
        <div className="flex items-center gap-2 mt-1">
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/op/iata" className="flex-1 bg-slate-800/60 border border-slate-700/60 rounded px-2 py-0.5 text-slate-100 text-[10px]" />
          <div className="flex gap-1 text-[9px]">
            {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['SLP',shSlope,setShSlope],['VEC',shVec,setShVec]].map(([l,v,s]:any) => (
              <button key={l} onClick={()=>s(!v)} className={`px-1 py-0.5 rounded font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{l}</button>
            ))}
          </div>
        </div>
      </div>

      {/* tabs */}
      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','RUNWAYS','GEOMETRY','METHOD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && visible.map((r, i) => (
          <div key={i} className="bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5 cursor-pointer" onClick={()=>onFly(r.f.icao)}>
            <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
              <span className="font-mono text-slate-100">{r.f.callsign || r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="text-slate-400">{r.f.type || '?'}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.klass}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-400 font-mono text-[9px]">{r.phase}</span>
              {!r.cdfaOn && r.phase !== 'OFF' && <span className="px-1 rounded bg-rose-500/15 text-rose-300 font-mono text-[9px]">› dive-drive</span>}
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>VPA <span className="text-slate-100 font-mono">{r.vpaActual.toFixed(2)}°</span></div>
              <div>pub <span className="text-slate-100 font-mono">{r.rwy ? r.rwy.vpa.toFixed(2) : '-'}°</span></div>
              <div>dev <span className="font-mono" style={{color: Math.abs(r.vpaDev) > 0.5 ? TIER_COLOR['UNSTAB'] : '#cbd5e1'}}>{r.vpaDev >= 0 ? '+' : ''}{r.vpaDev.toFixed(2)}°</span></div>
              <div>FMS <span className="text-slate-100 font-mono">{r.fmsMode}</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>ROD <span className="text-slate-100 font-mono">{r.rodActual.toFixed(0)}</span></div>
              <div>tgt <span className="text-slate-100 font-mono">{r.rodTarget.toFixed(0)}</span></div>
              <div>dev <span className="font-mono" style={{color: Math.abs(r.rodDevPct) > 25 ? TIER_COLOR['UNSTAB'] : '#cbd5e1'}}>{r.rodDevPct >= 0 ? '+' : ''}{r.rodDevPct.toFixed(0)}%</span></div>
              <div>dist <span className="text-slate-100 font-mono">{r.distFromThr.toFixed(1)} NM</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>alt <span className="text-slate-100 font-mono">{r.alt.toFixed(0)}</span></div>
              <div>MDA <span className="text-slate-100 font-mono">{r.rwy ? r.rwy.mda : '-'}</span></div>
              <div>AGL <span className="text-slate-100 font-mono">{r.agl.toFixed(0)}</span></div>
              <div>VDP <span className="font-mono" style={{color: r.pastVdp && r.belowMdaWithoutVis ? TIER_COLOR['CFIT-IMM'] : '#cbd5e1'}}>{r.vdpDme.toFixed(1)} NM</span></div>
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k, v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v as number)}</span>
              ))}
            </div>
            <div className="mt-1 text-[9px] text-slate-500 italic">{r.advice}</div>
          </div>
        ))}
        {tab === 'AIRCRAFT' && visible.length === 0 && <div className="text-[10px] text-slate-500 italic">no aircraft on NPA approach segment match current filters</div>}

        {tab === 'RUNWAYS' && rwyAgg.map((v, i) => (
          <div key={i} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
              <span className="font-mono text-slate-100">{v.rwy.iata}/{v.rwy.rwy}</span>
              <span className="text-slate-500">·</span>
              <span className="text-slate-400">{v.rwy.icao}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{v.rwy.apType}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-400 font-mono text-[9px]">ALS {v.rwy.als}</span>
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[v.worstTier]}33`, color:TIER_COLOR[v.worstTier] }}>{v.worstTier} · {v.inbound} inbound</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>VPA <span className="text-slate-100 font-mono">{v.rwy.vpa.toFixed(2)}°</span></div>
              <div>TCH <span className="text-slate-100 font-mono">{v.rwy.tch} ft</span></div>
              <div>FAF <span className="text-slate-100 font-mono">{v.rwy.fafDist.toFixed(1)}NM</span></div>
              <div>fAlt <span className="text-slate-100 font-mono">{v.rwy.fafAlt}</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>MDA <span className="text-slate-100 font-mono">{v.rwy.mda}</span></div>
              <div>HAT <span className="text-slate-100 font-mono">{v.rwy.hat}</span></div>
              <div>VDP <span className="text-slate-100 font-mono">{(v.rwy.vdpPub > 0 ? v.rwy.vdpPub : v.rwy.hat / (300 * Math.tan(rad(v.rwy.vpa)))).toFixed(1)} NM</span></div>
              <div>μ-sc <span className="text-slate-100 font-mono">{v.muScore.toFixed(0)}</span></div>
            </div>
            <div className="mt-1 text-[9px] text-slate-500 italic">{v.rwy.note}</div>
          </div>
        ))}
        {tab === 'RUNWAYS' && rwyAgg.length === 0 && <div className="text-[10px] text-slate-500 italic">no NPA approach activity in catalogue</div>}

        {tab === 'GEOMETRY' && (
          <div className="space-y-2">
            {geomSvg}
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] space-y-1">
              <div className="text-slate-400 font-semibold">Methodology · VPA & VDP formulae</div>
              <div className="font-mono text-slate-300">VPA = atan((FAF_alt − TCH) / (d_FAF→thr × 6076.12))</div>
              <div className="font-mono text-slate-300">ROD_tgt = 5 × GS_kt × (VPA / 3.0) fpm  ← rule-of-thumb</div>
              <div className="font-mono text-slate-300">VDP-DME = HAT / (300 × tan(VPA)) NM  ← FAA AIM 5-4-5b</div>
              <div className="text-slate-500 italic">ICAO Doc 8168 PANS-OPS Vol II Pt I §3.5 · FAA Order 8260.3E §3.0 · CDFA mandate ICAO Vol I §4.5.7</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px]">
              <div className="text-slate-400 font-semibold mb-1">Stabilised-app gate · 1000 ft AGL (IMC) / 500 ft AGL (VMC)</div>
              <div className="text-slate-500 text-[9px] space-y-0.5">
                <div>· descent angle within ±0.3° of published VPA</div>
                <div>· ROD within ±15% of computed target</div>
                <div>· no level segment {'>'} 5 s between FAF and MDA (CDFA continuity)</div>
                <div>· must go-around if not visual by VDP &amp; below MDA</div>
                <div>· per FSF ALAR Briefing Note 7.2 / IATA STEADES 2024 §6 ALA</div>
              </div>
            </div>
          </div>
        )}

        {tab === 'METHOD' && (
          <div className="space-y-2 text-[10px] text-slate-400">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 space-y-1">
              <div className="text-slate-300 font-semibold">CDFA · Continuous Descent Final Approach</div>
              <div>A flight technique on NPAs in which a continuous, constant-gradient descent is flown from the FAF to the runway threshold (or a missed-approach point at MDA), replacing the legacy &apos;dive-and-drive&apos; step-down technique that produced the dominant NPA CFIT accident family.</div>
              <div className="text-slate-500">Reference: ICAO Doc 8168 PANS-OPS Vol I §4.5.7 · Vol II Pt I §3.5 · FAA AC 120-108 · EASA AMC1 CAT.OP.MPA.110 · IATA STEADES 2024 §6</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 space-y-1">
              <div className="text-slate-300 font-semibold">VDP · Visual Descent Point</div>
              <div>The point on the final approach from which a normal descent gradient (3°) from MDA can be made to the runway aim-point AFTER acquiring visual reference. If visual not obtained by VDP, missed approach is mandatory.</div>
              <div className="text-slate-500">Reference: FAA AIM 5-4-5b · FAA Order 8260.19 · 14 CFR §91.175</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 space-y-1">
              <div className="text-slate-300 font-semibold">Precedent accidents driving CDFA mandate</div>
              <div className="text-slate-400 text-[9px] space-y-0.5">
                <div>· KAL 801 KGUM 1997-08-06 (228 fatal) NTSB AAR-00-01 — VOR/DME dive-and-drive Nimitz Hill CFIT</div>
                <div>· UPS 1354 KBHM 2013-08-14 (2 fatal) NTSB AAR-14-02 — LOC NPA below VPA CFIT short of threshold</div>
                <div>· Asiana 214 KSFO 2013-07-06 (3 fatal) NTSB AAR-14-01 — visual low-energy idle-thrust short</div>
                <div>· Hewa Bora 728 FZIC 2011-07-08 (74 fatal) — NDB/DME dive-and-drive</div>
                <div>· Air India Express 812 VOML 2010-05-22 (158 fatal) — RNAV-VNAV unstabilised continuation</div>
                <div>· Cubana 972 MUHA 2018-05-18 (112 fatal) — VOR-DME unstabilised continuation</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 space-y-1">
              <div className="text-slate-300 font-semibold">Hard escalators · score floors</div>
              <div className="text-slate-400 text-[9px] space-y-0.5">
                <div>· BELOW-MDA + no visual + past VDP → score ≥ 92 (CFIT-IMM)</div>
                <div>· VPA actual {'>'} 4.0° in FINAL/VDP-WIN → score ≥ 78</div>
                <div>· ROD {'>'} 1.5× target in CDFA-WIN/FINAL → score ≥ 70</div>
                <div>· Descent below VPA inside FAF (terrain undershoot) → score ≥ 82</div>
                <div>· FAF crossing error {'>'} 100 ft → score ≥ 60</div>
                <div>· Level segment {'>'} 5 s FAF→MDA (CDFA breach) → score ≥ 55</div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-700/40 text-[9px] text-slate-500 italic flex items-center justify-between">
        <span>CDFA/VDP · ICAO Doc 8168 PANS-OPS Vol I §4.5.7 · FAA AC 120-108 · FAA AIM 5-4-5</span>
        <span className="font-mono text-slate-600">v1</span>
      </div>
    </div>
  )
}
