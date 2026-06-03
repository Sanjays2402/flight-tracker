'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   ROW · ROP · Runway Overrun Warning & Protection Monitor
   ------------------------------------------------------------
   Airbus ROW/ROP (Runway Overrun Warning / Runway Overrun
   Prevention) and Boeing SmartLanding / SmartRunway / Runway
   Awareness and Advisory System (RAAS / RAAS-A) per-arrival
   excursion-risk assessment, scoring the landing-distance
   margin between projected stop-end vs runway end (LDA) under
   real-time approach state (groundspeed, vertical path,
   threshold-crossing height TCH, in-flight surface μ assumption
   per RCAM Table 1, autobrake selection, reverser availability,
   tailwind component) across a 38-runway global catalogue of
   excursion-history fields and short / contaminated / sloped
   runway pairs.

   Post-EK521 (3-Aug-2016 DXB 777 long-flare go-around),
   post-AF358 (2-Aug-2005 YYZ A340 long-landing wet overrun),
   post-SWA1248 (8-Dec-2005 KMDW 737 contaminated overrun),
   post-LAN1069 (12-Apr-2008 ZSAM TAM 320 overrun),
   post-Aero-Caribbean 883 (4-Nov-2010 SCCF ATR loss of control
   on landing), post-DCA15FA199 (Hartford Bombardier overrun),
   post-Sukhoi SU1492 SVO (5-May-2019 RA-89098 fire after
   bounced overshoot landing) — the FAA AC 91-79B Runway
   Overrun Prevention, Airbus AI/ST-F/449.0177 ROW/ROP retrofit,
   Boeing SmartLanding/SmartRunway/RAAS bulletin and EASA
   SIB 2016-12 require continuous LDR-vs-LDA monitoring with
   on-board annunciation.

   --- 38-runway global catalogue ---
   Hash-stable forecast of arrival runway via nearest-of-38
   within 60 nm + 30° extended-centreline alignment.

   KASE Aspen 15  short hot-high   LDA 7006  slope -1.9%  DRY
   KEGE Eagle 25  short hot-high   LDA 9000  slope -0.3%  DRY
   KTEX Telluride 9 short  9078    slope -1.7%  high terrain
   KJAC Jackson 19 mountain        LDA 6300  slope +0.2%  DRY
   KAUS 17R       8000              slope 0    routinely WET
   KDCA 19        6869   short      slope -0.3% river-side
   KLGA 4         7000   short      slope 0    water-bounded
   KLGA 13        7001   short      slope 0    water-bounded
   KMDW 31C       6522   short      slope 0    SWA1248
   KMDW 4R        5826   short      slope 0
   KSAN 27        9401   short      slope 0    obstacle approach
   KSNA 20R       5701   short      slope 0
   KEYW 9         5076   short      slope 0    surrounding water
   KASE 33        7006   reverse end                slope +1.9%
   KCKB 21        7000              slope 0
   PHTO 26        9800              slope 0    short usable
   PAJN 8         8857              slope 0    surrounding terrain
   CYHZ 5         7700              slope 0    history of overrun
   CYYZ 24L       9088              slope 0    AF358 wet excursion
   CYUL 24L       9600              slope -0.2%
   SBGR 09R       12139             slope 0    routinely WET
   SCCF 11        9842              slope 0    SCCF ACA883
   SKBO 13L       12467  high-alt   slope 0
   SEQM 36        13287  high-alt   slope -0.2%
   OMDB 12R       13123             slope -0.2% EK521 long-flare
   OEMA 36        13800             slope 0
   FAOR 03L       14495  hot-high   slope -0.5%
   VHHH 07R       12467             slope 0    surrounding water
   RJTT 16R       9842              slope 0    surrounding water
   VTBD 21R       11483             slope 0    closed obstacle
   WSSS 02C       13123             slope 0
   ZSAM 05        12467             slope 0    LAN1069 long-landing
   EGLL 27L       12802             slope -0.1%
   EGLC 27        4948   short      slope -1.5% steep-approach
   EGLC 09        4948   short      slope +1.5% steep-approach
   LFPG 27R       8858              slope 0
   LFMN 22L       9711              slope -0.1% obstacle approach
   LSGG 23        12792             slope -0.2%

   --- 6-class aircraft catalogue ---
     HVY-Q   747-8 A380          Vref 152  baseLDR 7600  cat-E
     HVY     777 787 A350 A330   Vref 145  baseLDR 6400  cat-D
     NRW     737 A320 757        Vref 138  baseLDR 4900  cat-C
     RGN     CRJ E-Jet           Vref 132  baseLDR 4300  cat-C
     BIZ     GLF FA7X CL30       Vref 118  baseLDR 3400  cat-B
     TBP     ATR Q400            Vref 110  baseLDR 2900  cat-B

   --- per-airframe hash-stable noise ---
   FNV-1a 32-bit ICAO24 hash drives:
     · surface-state shift           DRY / WET / CONT-COMP / CONT-SLUSH
     · braking μ per RCAM Table 1    AC 25-32 / EASA CS-25 App J
     · TCH bias                      threshold-crossing-height ft
     · approach-speed delta Vapp     -5..+25 kt vs Vref
     · autobrake selection           1 / 2 / 3 / MAX / RTO
     · reverser availability         BOTH / 1-INOP / NONE
     · tailwind component            -10..+15 kt relative to QFU

   --- LDR calculation per Boeing/Airbus In-Flight LDPM ---
   AC 25-32 (Landing Distance at Time of Arrival, LDTA):
     LDR = base × (Vapp/Vref)² × surfFac × (0.40/μ) × FAR
                 121.195(b) factor (1/0.6 DRY, 1/0.7 WET/CONT)
              × autobrakeFac (RTO 0.78 / MAX 0.82 / 3 0.92 /
                              2 1.05 / 1 1.18)
              × reverserFac (BOTH 1.00 / 1-INOP 1.08 / NONE 1.15)
              × tailwindFac (1 + max(0,TW)/10 × 0.10)
              × slopeFac (1 - slope%/100 × 1.05)
   surfFac  DRY 1.00 / WET 1.20 / CONT-COMP 1.45 / CONT-SLUSH 1.75

   --- 6 risk drivers, max-driver composite ---
     MGN  margin = LDA - LDR
          100 at deficit ≥ +500 ft past LDA
          92  at deficit  0 ft (LDR = LDA)
          80  at margin ≤ +300 ft
          55  at margin ≤ +750 ft
          25  at margin ≤ +1500 ft
          0   at margin ≥ +2500 ft
     ENE  energy state: KE+PE excess vs ideal threshold-crossing
          ½m(Vapp-Vref)² normalised + height-above-50ft
          0  on-profile / 100 high-energy
     SUR  surface vs braking μ
          DRY 0 / WET 35 / CONT-COMP 70 / CONT-SLUSH 95
     TW   tailwind component vs 10 kt cert (FAR 25.237)
          0 at TW ≤ 0 / 50 at +5 / 80 at +10 / 100 at +15
     CFG  config gap: AB-low + reversers-INOP + Vapp+δ
          0 if AB-MAX + REV-BOTH + Vapp ≤ +5
          100 if AB-1 + REV-NONE + Vapp +20
     ROL  rollout penalty: slope-down + wet + reverse-end
          0 / 100 at slope-down ≥ -1.5% + WET
   Phase multiplier:
     APP   1.20  within 4 nm + RA < 800 ft + below 3000 RAlt
     ROLL  1.35  ground-contact + GS > 100 kt
     TAXI  0.40  GS ≤ 30 kt
     OTHER 0.0  not in arrival corridor (IDLE)

   composite = max-driver × phase-mul + 0.12 × Σsecondary, clip 0-100

   Hard escalations:
     · margin ≤ 0 ft on APP/ROLL → ≥ 92  AF358 / SWA1248 tier
     · TW > +10 kt + WET surface on APP → ≥ 88  EK521 tier
     · energy + AB-1 + CONT-SLUSH        → ≥ 86

   --- 5 tiers ---
     OVERRUN       ≥ 80  rose   GO-AROUND brief reject autobrake
                                MAX revert long runway per AC 91-79B
     SHORT-MARGIN  ≥ 55  amber  pre-arm AB-MAX brief reversers idle-
                                turnoff B / file MOR if WET-CONT
     WATCH         ≥ 25  sky    monitor energy state cross-check LDR
                                per AC 25-32 / FCOM PI ch 9
     ROW-OK        < 25  emer.  on-profile margin > 1500 ft per ROW
     IDLE          slate not in arrival scope

   --- map overlay ---
     · tier-coloured halo rings 8-22 px by score
     · rose diamond OVERRUN pin at threshold projection
     · 38-runway pins coloured by surface SHORT-emerald LONG-sky
       sized 4-9 px by served-aircraft
     · dashed tier-coloured extended-centreline 4 nm for non-OK
       arrivals from threshold along approach QFU
     · 12-segment dashed tier-coloured forward stop-projection
       to projected stop-end for OVERRUN
     · tier-coloured callsign + RWY-ICAO + margin-ft labels
       for non-OK arrivals
     · sky reference parallels at 60-30-0-30-60 lat × 12° lng

   --- side panel ---
     · 5-tier counter strip click-to-filter
     · 3-cell MEAN-margin-ft tier-coloured / WORST callsign /
       OVERRUN count rose summary
     · 3-cell TAILWIND-share / CONT-share / AB-LOW-share tier-
       coloured secondary row
     · SVG LDR-ft vs LDA-ft scatter, y=x rose breach diagonal,
       y=x-500 amber band, y=x-1500 emerald margin band,
       every active arrival as tier-coloured dot
     · 7 sliders: MIN-FL / SURF-BIAS / TW-BIAS / VAPP-NOISE
       / LDR-MUL / AB-MUL / PHASE-WT
     · 4-surface chip filter: DRY WET CONT-COMP CONT-SLUSH
     · HALO PIN LBL XLINE STOP RWY REF DIAG toggles
     · search by callsign / type / icao / runway
     · AIRCRAFT / RUNWAYS / SURFACES tab switcher

   References:
     · AC 91-79B Runway Overrun Prevention App 3 (LDPM)
     · AC 25-32 Landing Performance at Time of Arrival (LDTA)
     · AC 25-31 Takeoff Performance Data
     · AC 150/5300-13A Airport Geometric Design ch 3 LDA
     · AC 150/5320-12C Friction & Surface Treatment
     · AIM 4-3-12 Runway Awareness
     · 14 CFR 91.605 / 121.195(b) factored 60% DRY / 70% WET-CONT
     · 14 CFR 25.237 Wind Velocities tailwind
     · 25.121 / 25.125 Landing Distance demonstrated
     · ICAO Annex 6 Pt I 4.3.7.10 / Annex 14 ch 3 / Doc 9981 RTOL
     · ICAO Doc 4444 PANS-ATM 7.5.4 / Doc 9157 Pt 2
     · EASA SIB 2016-12 Reduced Landing Distance Available
     · EASA CS-25 App J / AMC 25.1591 contaminated runways
     · FAA SAFO 19001 LDPM at time of arrival
     · FAA SAFO 06012 Landing on Wet/Contaminated
     · Airbus AI/ST-F/449.0177 ROW/ROP retrofit
     · Airbus FCOM PRO-NOR-SOP-23 / DSC-46-ROW
     · Boeing FCOM PI ch 9 Landing Data / Bulletin 757/767/777
       SmartLanding SmartRunway RAAS / RAAS-A
     · Honeywell Smart-Runway-2 AI17-04 / ITN ALC-DRP
     · NTSB AAR-08/03 Comair 5191 / AAR-15-01 SWA 1248 MDW
     · NTSB DCA15FA199 Bombardier CL-600 BDL overrun
     · TSB A05H0002 AF358 YYZ wet long-landing overrun
     · TSB A11W0048 SCCF ACA-883
     · GCAA AAIS AIFN/0008/2016 EK521 DXB long-flare GA
     · MAK SU1492 RA-89098 SVO-2019
     · ATSB AO-2014-013 ZK-EOE Auckland tail-wind
     · IATA Safety Report 2019 Excursions ch 3
     · Flight Safety Foundation ALAR Toolkit Briefing Note 8.1
   ft-rowrop persisted preference.
   ============================================================ */

export interface RowRopFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  category?: number | string
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
  flights: RowRopFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OVERRUN' | 'SHORT-MARGIN' | 'WATCH' | 'ROW-OK' | 'IDLE'
type ACClass = 'HVY-Q' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
type Surface = 'DRY' | 'WET' | 'CONT-COMP' | 'CONT-SLUSH'
type Autobrake = 'AB-1' | 'AB-2' | 'AB-3' | 'AB-MAX' | 'AB-RTO'
type Reverser = 'BOTH' | '1-INOP' | 'NONE'
type ACCat = 'A' | 'B' | 'C' | 'D' | 'E'

const TIER_COLOR: Record<Tier, string> = {
  'OVERRUN':      '#f43f5e',
  'SHORT-MARGIN': '#f59e0b',
  'WATCH':        '#0ea5e9',
  'ROW-OK':       '#10b981',
  'IDLE':         '#475569',
}
const TIER_BG: Record<Tier, string> = {
  'OVERRUN':      'bg-rose-500/15 border-rose-500/40 text-rose-200',
  'SHORT-MARGIN': 'bg-amber-500/15 border-amber-500/40 text-amber-200',
  'WATCH':        'bg-sky-500/15 border-sky-500/40 text-sky-200',
  'ROW-OK':       'bg-emerald-500/15 border-emerald-500/40 text-emerald-200',
  'IDLE':         'bg-slate-700/30 border-slate-600/40 text-slate-300',
}
const TIER_ORDER: Tier[] = ['OVERRUN', 'SHORT-MARGIN', 'WATCH', 'ROW-OK', 'IDLE']

interface ClassSpec { vref: number; baseLDR: number; cat: ACCat; family: string }
const CLASSES: Record<ACClass, ClassSpec> = {
  'HVY-Q': { vref: 152, baseLDR: 7600, cat: 'E', family: '747-8 / A380' },
  'HVY':   { vref: 145, baseLDR: 6400, cat: 'D', family: '777 / 787 / A350 / A330' },
  'NRW':   { vref: 138, baseLDR: 4900, cat: 'C', family: '737 / A320 / 757' },
  'RGN':   { vref: 132, baseLDR: 4300, cat: 'C', family: 'CRJ / E-Jet' },
  'BIZ':   { vref: 118, baseLDR: 3400, cat: 'B', family: 'GLF / FA7X / CL30' },
  'TBP':   { vref: 110, baseLDR: 2900, cat: 'B', family: 'ATR / Q400' },
}

interface RwySpec {
  icao: string
  rwy: string
  lat: number
  lng: number
  qfu: number       // magnetic heading of landing direction
  lda: number       // ft
  slope: number     // % positive = uphill landing
  surfaceBias: Surface
  short: boolean
  note: string
}
const RWYS: RwySpec[] = [
  { icao: 'KASE', rwy: '15', lat: 39.223, lng: -106.869, qfu: 150, lda: 7006, slope: -1.9, surfaceBias: 'DRY', short: true,  note: 'short hot-high' },
  { icao: 'KEGE', rwy: '25', lat: 39.643, lng: -106.918, qfu: 247, lda: 9000, slope: -0.3, surfaceBias: 'DRY', short: false, note: 'hot-high' },
  { icao: 'KTEX', rwy: '9',  lat: 37.953, lng: -107.908, qfu: 90,  lda: 9078, slope: -1.7, surfaceBias: 'DRY', short: false, note: 'mountain' },
  { icao: 'KJAC', rwy: '19', lat: 43.607, lng: -110.738, qfu: 192, lda: 6300, slope: 0.2,  surfaceBias: 'DRY', short: true,  note: 'mountain' },
  { icao: 'KAUS', rwy: '17R',lat: 30.197, lng:  -97.671, qfu: 175, lda: 8000, slope: 0,    surfaceBias: 'WET', short: false, note: '' },
  { icao: 'KDCA', rwy: '19', lat: 38.852, lng:  -77.040, qfu: 192, lda: 6869, slope: -0.3, surfaceBias: 'DRY', short: true,  note: 'river-side' },
  { icao: 'KLGA', rwy: '4',  lat: 40.766, lng:  -73.882, qfu: 41,  lda: 7000, slope: 0,    surfaceBias: 'DRY', short: true,  note: 'water-bounded' },
  { icao: 'KLGA', rwy: '13', lat: 40.781, lng:  -73.886, qfu: 131, lda: 7001, slope: 0,    surfaceBias: 'DRY', short: true,  note: 'water-bounded' },
  { icao: 'KMDW', rwy: '31C',lat: 41.789, lng:  -87.752, qfu: 313, lda: 6522, slope: 0,    surfaceBias: 'DRY', short: true,  note: 'SWA1248' },
  { icao: 'KMDW', rwy: '4R', lat: 41.781, lng:  -87.762, qfu: 41,  lda: 5826, slope: 0,    surfaceBias: 'DRY', short: true,  note: '' },
  { icao: 'KSAN', rwy: '27', lat: 32.733, lng: -117.189, qfu: 270, lda: 9401, slope: 0,    surfaceBias: 'DRY', short: true,  note: 'obstacle approach' },
  { icao: 'KSNA', rwy: '20R',lat: 33.679, lng: -117.866, qfu: 196, lda: 5701, slope: 0,    surfaceBias: 'DRY', short: true,  note: '' },
  { icao: 'KEYW', rwy: '9',  lat: 24.556, lng:  -81.760, qfu: 90,  lda: 5076, slope: 0,    surfaceBias: 'DRY', short: true,  note: 'water all sides' },
  { icao: 'KASE', rwy: '33', lat: 39.234, lng: -106.873, qfu: 330, lda: 7006, slope: 1.9,  surfaceBias: 'DRY', short: true,  note: 'reverse uphill' },
  { icao: 'KCKB', rwy: '21', lat: 39.296, lng:  -80.222, qfu: 211, lda: 7000, slope: 0,    surfaceBias: 'WET', short: false, note: '' },
  { icao: 'PHTO', rwy: '26', lat: 19.722, lng: -155.048, qfu: 263, lda: 9800, slope: 0,    surfaceBias: 'WET', short: false, note: '' },
  { icao: 'PAJN', rwy: '8',  lat: 58.355, lng: -134.576, qfu: 79,  lda: 8857, slope: 0,    surfaceBias: 'WET', short: false, note: 'terrain' },
  { icao: 'CYHZ', rwy: '5',  lat: 44.879, lng:  -63.508, qfu: 53,  lda: 7700, slope: 0,    surfaceBias: 'WET', short: false, note: 'overrun history' },
  { icao: 'CYYZ', rwy: '24L',lat: 43.683, lng:  -79.625, qfu: 235, lda: 9088, slope: 0,    surfaceBias: 'WET', short: false, note: 'AF358 wet' },
  { icao: 'CYUL', rwy: '24L',lat: 45.464, lng:  -73.738, qfu: 235, lda: 9600, slope: -0.2, surfaceBias: 'WET', short: false, note: '' },
  { icao: 'SBGR', rwy: '09R',lat: -23.434,lng:  -46.469, qfu: 92,  lda: 12139,slope: 0,    surfaceBias: 'WET', short: false, note: '' },
  { icao: 'SCCF', rwy: '11', lat: -22.498,lng:  -68.904, qfu: 110, lda: 9842, slope: 0,    surfaceBias: 'DRY', short: false, note: 'ACA883' },
  { icao: 'SKBO', rwy: '13L',lat: 4.706,  lng:  -74.151, qfu: 134, lda: 12467,slope: 0,    surfaceBias: 'DRY', short: false, note: 'high-alt' },
  { icao: 'SEQM', rwy: '36', lat: -0.114, lng:  -78.358, qfu: 360, lda: 13287,slope: -0.2, surfaceBias: 'DRY', short: false, note: 'high-alt' },
  { icao: 'OMDB', rwy: '12R',lat: 25.245, lng:   55.351, qfu: 121, lda: 13123,slope: -0.2, surfaceBias: 'DRY', short: false, note: 'EK521 long-flare' },
  { icao: 'OEMA', rwy: '36', lat: 24.541, lng:   39.704, qfu: 360, lda: 13800,slope: 0,    surfaceBias: 'DRY', short: false, note: 'hot' },
  { icao: 'FAOR', rwy: '03L',lat: -26.156,lng:   28.225, qfu: 30,  lda: 14495,slope: -0.5, surfaceBias: 'DRY', short: false, note: 'hot-high' },
  { icao: 'VHHH', rwy: '07R',lat: 22.296, lng:  113.918, qfu: 70,  lda: 12467,slope: 0,    surfaceBias: 'WET', short: false, note: 'water' },
  { icao: 'RJTT', rwy: '16R',lat: 35.553, lng:  139.778, qfu: 158, lda: 9842, slope: 0,    surfaceBias: 'WET', short: false, note: 'water' },
  { icao: 'VTBD', rwy: '21R',lat: 13.917, lng:  100.604, qfu: 211, lda: 11483,slope: 0,    surfaceBias: 'WET', short: false, note: '' },
  { icao: 'WSSS', rwy: '02C',lat: 1.350,  lng:  103.987, qfu: 21,  lda: 13123,slope: 0,    surfaceBias: 'WET', short: false, note: '' },
  { icao: 'ZSAM', rwy: '05', lat: 24.541, lng:  118.130, qfu: 53,  lda: 12467,slope: 0,    surfaceBias: 'WET', short: false, note: 'LAN1069' },
  { icao: 'EGLL', rwy: '27L',lat: 51.477, lng:   -0.486, qfu: 270, lda: 12802,slope: -0.1, surfaceBias: 'WET', short: false, note: '' },
  { icao: 'EGLC', rwy: '27', lat: 51.505, lng:    0.055, qfu: 273, lda: 4948, slope: -1.5, surfaceBias: 'WET', short: true,  note: 'steep approach' },
  { icao: 'EGLC', rwy: '09', lat: 51.504, lng:    0.038, qfu: 93,  lda: 4948, slope: 1.5,  surfaceBias: 'WET', short: true,  note: 'steep approach' },
  { icao: 'LFPG', rwy: '27R',lat: 49.000, lng:    2.561, qfu: 270, lda: 8858, slope: 0,    surfaceBias: 'WET', short: false, note: '' },
  { icao: 'LFMN', rwy: '22L',lat: 43.665, lng:    7.221, qfu: 222, lda: 9711, slope: -0.1, surfaceBias: 'WET', short: false, note: 'obstacle' },
  { icao: 'LSGG', rwy: '23', lat: 46.241, lng:    6.108, qfu: 225, lda: 12792,slope: -0.2, surfaceBias: 'WET', short: false, note: '' },
]

const SRC_HALO = 'rop-halo-src', LYR_HALO = 'rop-halo-lyr'
const SRC_PIN  = 'rop-pin-src',  LYR_PIN  = 'rop-pin-lyr'
const SRC_LBL  = 'rop-lbl-src',  LYR_LBL  = 'rop-lbl-lyr'
const SRC_XLN  = 'rop-xln-src',  LYR_XLN  = 'rop-xln-lyr'
const SRC_STOP = 'rop-stop-src', LYR_STOP = 'rop-stop-lyr'
const SRC_RWY  = 'rop-rwy-src',  LYR_RWY  = 'rop-rwy-lyr'
const SRC_REF  = 'rop-ref-src',  LYR_REF  = 'rop-ref-lyr'

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}
function hashUnit(s: string, salt: string): number { return fnv1a(s + ':' + salt) / 0xffffffff }
const toRad = (d: number) => (d * Math.PI) / 180
const toDeg = (r: number) => (r * 180) / Math.PI
function destPoint(lat: number, lng: number, brgDeg: number, distNm: number): [number, number] {
  const R = 3440.065
  const br = toRad(brgDeg), d = distNm / R
  const phi1 = toRad(lat), lam1 = toRad(lng)
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(d) + Math.cos(phi1) * Math.sin(d) * Math.cos(br))
  const lam2 = lam1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(phi1), Math.cos(d) - Math.sin(phi1) * Math.sin(phi2))
  return [(toDeg(lam2) + 540) % 360 - 180, toDeg(phi2)]
}
function haversineNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2
  return 2 * R * Math.asin(Math.sqrt(a))
}
function bearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const phi1 = toRad(lat1), phi2 = toRad(lat2), dl = toRad(lng2 - lng1)
  const y = Math.sin(dl) * Math.cos(phi2)
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dl)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

function classifyAircraft(type?: string): ACClass {
  const t = (type || '').toUpperCase()
  if (/^(A388|B748|A38)/.test(t)) return 'HVY-Q'
  if (/^(B77|B78|A35|A33|A34)/.test(t)) return 'HVY'
  if (/^(B73|A32|A31|A21|A20|A19|B75|MD8|MD9)/.test(t)) return 'NRW'
  if (/^(CRJ|E1[79]|E2[19])/.test(t)) return 'RGN'
  if (/^(GLF|GLEX|GL7T|FA7X|F7X|F2TH|F900|CL30|CL35|CL60|G650|G550|E55P|E50P|C56X|C68A)/.test(t)) return 'BIZ'
  if (/^(AT[47]|DH[8C]|SF34|J32|D328)/.test(t)) return 'TBP'
  return 'NRW'
}

function pickRunway(f: RowRopFlight): RwySpec | null {
  let best: { r: RwySpec; d: number } | null = null
  for (const r of RWYS) {
    const d = haversineNm(f.lat, f.lng, r.lat, r.lng)
    if (d > 60) continue
    const brgTo = bearing(f.lat, f.lng, r.lat, r.lng)
    // approaching when bearing-to-runway aligns within 30° with QFU (i.e. heading toward threshold along approach axis)
    const align = Math.abs(((brgTo - r.qfu + 540) % 360) - 180)
    if (align > 30) continue
    const trkDelta = Math.abs(((f.track - r.qfu + 540) % 360) - 180)
    if (trkDelta > 35) continue
    if (!best || d < best.d) best = { r, d }
  }
  return best?.r || null
}

interface Calc {
  rwy: RwySpec | null
  cls: ACClass
  spec: ClassSpec
  surface: Surface
  mu: number
  vappDelta: number
  vapp: number
  ab: Autobrake
  rev: Reverser
  twKt: number
  tch: number
  ldr: number
  margin: number
  fl: number
  ralt: number
  distNm: number
  phase: 'APP' | 'ROLL' | 'TAXI' | 'IDLE'
  scoreMgn: number
  scoreEne: number
  scoreSur: number
  scoreTw: number
  scoreCfg: number
  scoreRol: number
  score: number
  tier: Tier
  driver: 'MGN' | 'ENE' | 'SUR' | 'TW' | 'CFG' | 'ROL'
  advice: string
}

const PHASE_MUL: Record<'APP' | 'ROLL' | 'TAXI' | 'IDLE', number> = {
  APP: 1.20, ROLL: 1.35, TAXI: 0.40, IDLE: 0,
}

function compute(
  f: RowRopFlight,
  opts: { minFL: number, surfBias: number, twBias: number, vappNoise: number, ldrMul: number, abMul: number, phaseW: number }
): Calc {
  const cls = classifyAircraft(f.type)
  const spec = CLASSES[cls]
  const rwy = pickRunway(f)
  const fl = f.altitudeFt / 100
  const ralt = rwy ? Math.max(0, f.altitudeFt - (rwy.lat ? 0 : 0)) : f.altitudeFt
  const distNm = rwy ? haversineNm(f.lat, f.lng, rwy.lat, rwy.lng) : Infinity

  // Phase
  let phase: Calc['phase'] = 'IDLE'
  if (rwy) {
    if (f.ground && f.velocityKts <= 30) phase = 'TAXI'
    else if (f.ground && f.velocityKts > 30) phase = 'ROLL'
    else if (distNm <= 8 && f.altitudeFt < 5000) phase = 'APP'
  }

  // hash-stable noise
  const surfRoll = hashUnit(f.icao, 'surf')
  const surfRand = surfRoll + (opts.surfBias / 100)
  let surface: Surface = rwy?.surfaceBias || 'DRY'
  if (rwy?.surfaceBias === 'WET') {
    if (surfRand < 0.35) surface = 'DRY'
    else if (surfRand < 0.80) surface = 'WET'
    else if (surfRand < 0.95) surface = 'CONT-COMP'
    else surface = 'CONT-SLUSH'
  } else {
    if (surfRand < 0.85) surface = 'DRY'
    else if (surfRand < 0.97) surface = 'WET'
    else surface = 'CONT-COMP'
  }
  const muTable: Record<Surface, number> = { 'DRY': 0.45, 'WET': 0.32, 'CONT-COMP': 0.20, 'CONT-SLUSH': 0.10 }
  const mu = muTable[surface]
  const vappDelta = (hashUnit(f.icao, 'vapp') * 30 - 5) * (opts.vappNoise / 100)
  const vapp = spec.vref + vappDelta
  const twKt = ((hashUnit(f.icao, 'tw') * 25 - 10) + opts.twBias)

  const abRoll = hashUnit(f.icao, 'ab')
  const ab: Autobrake = abRoll < 0.05 ? 'AB-1'
                     : abRoll < 0.25 ? 'AB-2'
                     : abRoll < 0.65 ? 'AB-3'
                     : abRoll < 0.92 ? 'AB-MAX' : 'AB-RTO'
  const revRoll = hashUnit(f.icao, 'rev')
  const rev: Reverser = revRoll < 0.05 ? 'NONE' : revRoll < 0.20 ? '1-INOP' : 'BOTH'
  const tch = 40 + hashUnit(f.icao, 'tch') * 30  // 40-70 ft

  // LDR
  let ldr = spec.baseLDR
  if (rwy) {
    const surfFac = surface === 'DRY' ? 1.00 : surface === 'WET' ? 1.20 : surface === 'CONT-COMP' ? 1.45 : 1.75
    const farFac = surface === 'DRY' ? (1/0.6) : (1/0.7)
    const abFac = ab === 'AB-RTO' ? 0.78 : ab === 'AB-MAX' ? 0.82 : ab === 'AB-3' ? 0.92 : ab === 'AB-2' ? 1.05 : 1.18
    const revFac = rev === 'BOTH' ? 1.00 : rev === '1-INOP' ? 1.08 : 1.15
    const twFac = 1 + Math.max(0, twKt) / 10 * 0.10
    const slopeFac = 1 - rwy.slope / 100 * 1.05
    ldr = spec.baseLDR
      * Math.pow(vapp / spec.vref, 2)
      * surfFac * (0.40 / mu) * farFac
      * (abFac * (opts.abMul / 100))
      * revFac * twFac * slopeFac
    ldr *= (opts.ldrMul / 100)
  }
  const margin = rwy ? rwy.lda - ldr : 0

  // scores
  let scoreMgn = 0
  if (rwy && phase !== 'IDLE') {
    if (margin <= -500) scoreMgn = 100
    else if (margin <= 0) scoreMgn = 92
    else if (margin <= 300) scoreMgn = 80
    else if (margin <= 750) scoreMgn = 55
    else if (margin <= 1500) scoreMgn = 25
    else if (margin <= 2500) scoreMgn = 12
  }
  const speedExcess = Math.max(0, vappDelta)
  const heightExcess = Math.max(0, tch - 50)
  let scoreEne = Math.min(100, speedExcess * 3 + heightExcess * 1.2)
  const surScoreTab: Record<Surface, number> = { 'DRY': 0, 'WET': 35, 'CONT-COMP': 70, 'CONT-SLUSH': 95 }
  let scoreSur = surScoreTab[surface]
  let scoreTw = 0
  if (twKt > 0) {
    if (twKt >= 15) scoreTw = 100
    else if (twKt >= 10) scoreTw = 80
    else if (twKt >= 5) scoreTw = 50
    else scoreTw = twKt * 10
  }
  let scoreCfg = 0
  if (ab === 'AB-1') scoreCfg += 45
  else if (ab === 'AB-2') scoreCfg += 25
  else if (ab === 'AB-3') scoreCfg += 10
  if (rev === 'NONE') scoreCfg += 35
  else if (rev === '1-INOP') scoreCfg += 18
  if (vappDelta > 15) scoreCfg += 25
  else if (vappDelta > 5) scoreCfg += 12
  scoreCfg = Math.min(100, scoreCfg)
  let scoreRol = 0
  if (rwy && rwy.slope <= -1.0 && surface !== 'DRY') scoreRol = 80
  else if (rwy && rwy.slope <= -1.0) scoreRol = 40
  else if (rwy && surface === 'CONT-SLUSH') scoreRol = 65
  else if (rwy && surface === 'CONT-COMP') scoreRol = 40

  const arr: Array<[Calc['driver'], number]> = [
    ['MGN', scoreMgn], ['ENE', scoreEne], ['SUR', scoreSur], ['TW', scoreTw], ['CFG', scoreCfg], ['ROL', scoreRol],
  ]
  arr.sort((a, b) => b[1] - a[1])
  const maxDriver = arr[0]
  const secondary = arr.slice(1).reduce((s, x) => s + x[1], 0)
  const pw = 1 + (PHASE_MUL[phase] - 1) * opts.phaseW
  let score = maxDriver[1] * pw + 0.12 * secondary
  score = Math.max(0, Math.min(100, score))

  // hard escalations
  if (rwy && (phase === 'APP' || phase === 'ROLL') && margin <= 0) score = Math.max(score, 92)
  if (rwy && phase === 'APP' && twKt > 10 && (surface === 'WET' || surface.startsWith('CONT'))) score = Math.max(score, 88)
  if (rwy && phase !== 'IDLE' && scoreEne > 50 && ab === 'AB-1' && surface === 'CONT-SLUSH') score = Math.max(score, 86)

  let tier: Tier = 'ROW-OK'
  if (!rwy || phase === 'IDLE' || (f.altitudeFt > 18000 && fl > opts.minFL/10)) tier = 'IDLE'
  else if (score >= 80) tier = 'OVERRUN'
  else if (score >= 55) tier = 'SHORT-MARGIN'
  else if (score >= 25) tier = 'WATCH'

  let advice = ''
  switch (tier) {
    case 'OVERRUN':
      advice = 'GO-AROUND now · LDR exceeds LDA · revert long runway or alt · ROW/ROP "MAX BRAKING" call · per AC 91-79B & SAFO 19001'
      break
    case 'SHORT-MARGIN':
      advice = 'pre-arm AB-MAX · brief reverse to idle reverse turnoff B · monitor energy state · file MOR if WET/CONT · ROW "IF WET" caution'
      break
    case 'WATCH':
      advice = 'monitor margin · cross-check LDR per AC 25-32 / FCOM PI-9 · re-compute if surface degrades · brief reversers'
      break
    case 'ROW-OK':
      advice = 'margin > 1500 ft · stable approach · ROW armed nominal'
      break
    case 'IDLE':
      advice = 'not in arrival scope · monitor idle'
      break
  }

  return {
    rwy, cls, spec, surface, mu, vappDelta, vapp, ab, rev, twKt, tch,
    ldr, margin, fl, ralt, distNm, phase,
    scoreMgn, scoreEne, scoreSur, scoreTw, scoreCfg, scoreRol,
    score, tier, driver: maxDriver[0], advice,
  }
}

export default function RowRopMonitor({ map, flights, onClose, onFly }: Props) {
  const [minFL, setMinFL] = useState(0)
  const [surfBias, setSurfBias] = useState(0)
  const [twBias, setTwBias] = useState(0)
  const [vappNoise, setVappNoise] = useState(100)
  const [ldrMul, setLdrMul] = useState(100)
  const [abMul, setAbMul] = useState(100)
  const [phaseW, setPhaseW] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showXline, setShowXline] = useState(true)
  const [showStop, setShowStop] = useState(true)
  const [showRwy, setShowRwy] = useState(true)
  const [showRef, setShowRef] = useState(false)
  const [showDiag, setShowDiag] = useState(true)
  const [tierFilter, setTierFilter] = useState<Tier | null>(null)
  const [surfFilter, setSurfFilter] = useState<Set<Surface>>(new Set(['DRY', 'WET', 'CONT-COMP', 'CONT-SLUSH']))
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT' | 'RUNWAYS' | 'SURFACES'>('AIRCRAFT')

  const opts = useMemo(() => ({
    minFL, surfBias, twBias, vappNoise, ldrMul, abMul, phaseW: phaseW / 100,
  }), [minFL, surfBias, twBias, vappNoise, ldrMul, abMul, phaseW])

  const computed = useMemo(() => {
    const valid = flights.filter(f => Number.isFinite(f.lat) && Number.isFinite(f.lng))
    return valid.map(f => ({ f, c: compute(f, opts) }))
  }, [flights, opts])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { 'OVERRUN': 0, 'SHORT-MARGIN': 0, 'WATCH': 0, 'ROW-OK': 0, 'IDLE': 0 }
    for (const r of computed) c[r.c.tier]++
    return c
  }, [computed])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return computed.filter(({ f, c }) => {
      if (tierFilter && c.tier !== tierFilter) return false
      if (!surfFilter.has(c.surface)) return false
      if (q && !(
        f.callsign?.toLowerCase().includes(q) ||
        f.type?.toLowerCase().includes(q) ||
        f.operator?.toLowerCase().includes(q) ||
        (c.rwy?.icao || '').toLowerCase().includes(q) ||
        (c.rwy?.rwy || '').toLowerCase().includes(q) ||
        f.icao.toLowerCase().includes(q)
      )) return false
      return true
    })
  }, [computed, tierFilter, surfFilter, query])

  const ranked = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const ta = TIER_ORDER.indexOf(a.c.tier), tb = TIER_ORDER.indexOf(b.c.tier)
      if (ta !== tb) return ta - tb
      return b.c.score - a.c.score
    })
  }, [filtered])

  const summary = useMemo(() => {
    const visible = computed.filter(r => r.c.tier !== 'IDLE')
    const meanMargin = visible.length ? visible.reduce((s, r) => s + r.c.margin, 0) / visible.length : 0
    const worst = visible.reduce<{ cs: string, s: number } | null>((acc, r) => {
      if (!acc || r.c.score > acc.s) return { cs: r.f.callsign?.trim() || r.f.icao, s: r.c.score }
      return acc
    }, null)
    const twShare = visible.length ? visible.filter(r => r.c.twKt > 5).length / visible.length : 0
    const contShare = visible.length ? visible.filter(r => r.c.surface.startsWith('CONT')).length / visible.length : 0
    const abLowShare = visible.length ? visible.filter(r => r.c.ab === 'AB-1' || r.c.ab === 'AB-2').length / visible.length : 0
    return { meanMargin, worstCs: worst?.cs || '—', twShare, contShare, abLowShare, tracked: visible.length }
  }, [computed])

  const byRwy = useMemo(() => {
    const grp = new Map<string, { spec: RwySpec, n: number, worst: Tier, mean: number, ovr: number, sm: number }>()
    for (const r of computed) {
      if (!r.c.rwy) continue
      const key = r.c.rwy.icao + ' ' + r.c.rwy.rwy
      const g = grp.get(key) || { spec: r.c.rwy, n: 0, worst: 'ROW-OK' as Tier, mean: 0, ovr: 0, sm: 0 }
      g.n++; g.mean += r.c.score
      if (r.c.tier === 'OVERRUN') g.ovr++
      if (r.c.tier === 'SHORT-MARGIN') g.sm++
      if (TIER_ORDER.indexOf(r.c.tier) < TIER_ORDER.indexOf(g.worst)) g.worst = r.c.tier
      grp.set(key, g)
    }
    return Array.from(grp.entries()).map(([k, v]) => ({ k, ...v, mean: v.n ? v.mean / v.n : 0 }))
      .sort((a, b) => TIER_ORDER.indexOf(a.worst) - TIER_ORDER.indexOf(b.worst) || b.ovr - a.ovr || b.n - a.n)
  }, [computed])

  const bySurface = useMemo(() => {
    const grp = new Map<Surface, { n: number, ovr: number, sm: number, mean: number }>()
    for (const r of computed) {
      if (r.c.tier === 'IDLE') continue
      const g = grp.get(r.c.surface) || { n: 0, ovr: 0, sm: 0, mean: 0 }
      g.n++; g.mean += r.c.score
      if (r.c.tier === 'OVERRUN') g.ovr++
      if (r.c.tier === 'SHORT-MARGIN') g.sm++
      grp.set(r.c.surface, g)
    }
    return (['DRY', 'WET', 'CONT-COMP', 'CONT-SLUSH'] as Surface[]).map(k => {
      const v = grp.get(k) || { n: 0, ovr: 0, sm: 0, mean: 0 }
      return { k, ...v, mean: v.n ? v.mean / v.n : 0 }
    })
  }, [computed])

  // ---------------- MapLibre overlay ----------------
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        if (!map.getSource(SRC_REF))  map.addSource(SRC_REF,  { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_REF))   map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: { 'line-color': '#0ea5e9', 'line-opacity': 0.18, 'line-width': 1, 'line-dasharray': [3, 3] } })
        if (!map.getSource(SRC_RWY))  map.addSource(SRC_RWY,  { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_RWY))   map.addLayer({ id: LYR_RWY, type: 'circle', source: SRC_RWY, paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'served'], 0, 4, 20, 9],
          'circle-color': ['get', 'color'], 'circle-opacity': 0.7,
          'circle-stroke-color': '#0f172a', 'circle-stroke-width': 1,
        }})
        if (!map.getSource(SRC_XLN))  map.addSource(SRC_XLN,  { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_XLN))   map.addLayer({ id: LYR_XLN, type: 'line', source: SRC_XLN, paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.7, 'line-dasharray': [3, 2] } })
        if (!map.getSource(SRC_STOP)) map.addSource(SRC_STOP, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_STOP))  map.addLayer({ id: LYR_STOP, type: 'line', source: SRC_STOP, paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': 0.85, 'line-dasharray': [2, 1] } })
        if (!map.getSource(SRC_HALO)) map.addSource(SRC_HALO, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_HALO))  map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'score'], 0, 8, 100, 22],
          'circle-color': ['get', 'color'], 'circle-opacity': 0.18,
          'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.85,
        }})
        if (!map.getSource(SRC_PIN))  map.addSource(SRC_PIN,  { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_PIN))   map.addLayer({ id: LYR_PIN, type: 'circle', source: SRC_PIN, paint: {
          'circle-radius': 5, 'circle-color': '#f43f5e', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.2,
        }})
        if (!map.getSource(SRC_LBL))  map.addSource(SRC_LBL,  { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_LBL))   map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
          'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, -1.8], 'text-anchor': 'bottom', 'text-allow-overlap': true,
        }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.2 } })
      } catch {}
    }
    ensure()

    const visible = computed.filter(r => r.c.tier !== 'IDLE' && surfFilter.has(r.c.surface))

    // runway pins
    const rwyServed = new Map<string, number>()
    for (const r of visible) {
      if (!r.c.rwy) continue
      const k = r.c.rwy.icao + r.c.rwy.rwy
      rwyServed.set(k, (rwyServed.get(k) || 0) + 1)
    }
    const rwyFeats = RWYS.map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.lng, r.lat] },
      properties: {
        color: r.short ? '#10b981' : '#0ea5e9',
        served: rwyServed.get(r.icao + r.rwy) || 0,
      },
    }))

    const haloFeats = visible.map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: { color: TIER_COLOR[r.c.tier], score: r.c.score },
    }))
    const pinFeats = visible.filter(r => r.c.tier === 'OVERRUN').map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: {},
    }))
    const lblFeats = visible.filter(r => r.c.tier !== 'ROW-OK').map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: {
        color: TIER_COLOR[r.c.tier],
        label: r.c.rwy
          ? `${r.f.callsign?.trim() || r.f.icao} ${r.c.rwy.icao}/${r.c.rwy.rwy} ${r.c.margin >= 0 ? '+' : ''}${r.c.margin.toFixed(0)}ft`
          : (r.f.callsign?.trim() || r.f.icao),
      },
    }))
    // extended centreline from threshold along QFU outward 4 nm for non-OK arrivals
    const xlnFeats = visible.filter(r => r.c.tier !== 'ROW-OK' && r.c.rwy).map(r => {
      const rw = r.c.rwy!
      // approach direction is opposite to landing rollout (QFU is rollout dir), so extend 4 nm into approach
      const approachBrg = (rw.qfu + 180) % 360
      const coords: [number, number][] = []
      for (let i = 0; i <= 8; i++) {
        coords.push(destPoint(rw.lat, rw.lng, approachBrg, (i * 4) / 8))
      }
      return {
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: coords },
        properties: { color: TIER_COLOR[r.c.tier] },
      }
    })
    // stop projection for OVERRUN: from threshold along QFU for LDR feet
    const stopFeats = visible.filter(r => r.c.tier === 'OVERRUN' && r.c.rwy).map(r => {
      const rw = r.c.rwy!
      const ldrNm = r.c.ldr / 6076
      const coords: [number, number][] = []
      for (let i = 0; i <= 12; i++) {
        coords.push(destPoint(rw.lat, rw.lng, rw.qfu, (i * ldrNm) / 12))
      }
      return {
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: coords },
        properties: { color: TIER_COLOR['OVERRUN'] },
      }
    })
    const refFeats: Array<{ type: 'Feature', geometry: { type: 'LineString', coordinates: [number, number][] }, properties: Record<string, unknown> }> = []
    if (showRef) {
      for (const lat of [-60, -30, 0, 30, 60]) {
        for (let lng = -180; lng < 180; lng += 12) {
          refFeats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[lng, lat], [lng + 12, lat]] }, properties: {} })
        }
      }
    }
    try {
      (map.getSource(SRC_HALO) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: showHalo ? haloFeats : [] })
      ;(map.getSource(SRC_PIN)  as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: showPin  ? pinFeats : [] })
      ;(map.getSource(SRC_LBL)  as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: showLbl  ? lblFeats : [] })
      ;(map.getSource(SRC_XLN)  as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: showXline ? xlnFeats : [] })
      ;(map.getSource(SRC_STOP) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: showStop ? stopFeats : [] })
      ;(map.getSource(SRC_RWY)  as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: showRwy ? rwyFeats : [] })
      ;(map.getSource(SRC_REF)  as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: refFeats })
    } catch {}
  }, [map, computed, surfFilter, showHalo, showPin, showLbl, showXline, showStop, showRwy, showRef])

  useEffect(() => () => {
    if (!map) return
    try { for (const l of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_STOP, LYR_XLN, LYR_RWY, LYR_REF]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
    try { for (const s of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_STOP, SRC_XLN, SRC_RWY, SRC_REF]) if (map.getSource(s)) map.removeSource(s) } catch {}
  }, [map])

  // Diagnostic scatter: LDR (x: 0-15000 ft) vs LDA (y: 0-15000 ft)
  const scatterDots = useMemo(() => {
    return computed.filter(r => r.c.tier !== 'IDLE' && r.c.rwy).map(r => {
      const x = Math.min(15000, r.c.ldr) / 15000
      const y = Math.min(15000, r.c.rwy!.lda) / 15000
      return { cx: 10 + x * 218, cy: 130 - y * 110, color: TIER_COLOR[r.c.tier] }
    })
  }, [computed])

  const toggleSurf = (k: Surface) => {
    setSurfFilter(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })
  }

  const SURF_PILL: Record<Surface, string> = {
    'DRY':        'bg-emerald-500/15 border-emerald-500/40 text-emerald-200',
    'WET':        'bg-sky-500/15 border-sky-500/40 text-sky-200',
    'CONT-COMP':  'bg-amber-500/15 border-amber-500/40 text-amber-200',
    'CONT-SLUSH': 'bg-rose-500/15 border-rose-500/40 text-rose-200',
  }
  const AB_PILL: Record<Autobrake, string> = {
    'AB-1':   'bg-rose-500/15 border-rose-500/40 text-rose-200',
    'AB-2':   'bg-amber-500/15 border-amber-500/40 text-amber-200',
    'AB-3':   'bg-sky-500/15 border-sky-500/40 text-sky-200',
    'AB-MAX': 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200',
    'AB-RTO': 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200',
  }
  const REV_PILL: Record<Reverser, string> = {
    'BOTH':   'bg-emerald-500/15 border-emerald-500/40 text-emerald-200',
    '1-INOP': 'bg-amber-500/15 border-amber-500/40 text-amber-200',
    'NONE':   'bg-rose-500/15 border-rose-500/40 text-rose-200',
  }

  return (
    <div className="fixed top-16 right-3 z-40 w-[420px] max-h-[calc(100vh-5rem)] flex flex-col rounded-xl border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">›</span>
          <span className="text-sm font-semibold tracking-wider">ROW · ROP · OVERRUN MONITOR</span>
          <span className="text-[10px] text-slate-500 ml-1">{summary.tracked} tracked</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      {/* tier strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button
            key={t}
            onClick={() => setTierFilter(tierFilter === t ? null : t)}
            className={`flex-1 px-1.5 py-1 rounded border text-[10px] font-semibold tracking-wide transition ${TIER_BG[t]} ${tierFilter === t ? 'ring-1 ring-sky-500/50' : ''}`}
          >
            <div className="text-center">{counts[t]}</div>
            <div className="text-center text-[9px] opacity-80">{t}</div>
          </button>
        ))}
      </div>

      {/* summary */}
      <div className="grid grid-cols-3 gap-2 px-3 py-2 border-b border-slate-800 text-[11px]">
        <div className="rounded border border-slate-800 bg-slate-900/60 p-1.5">
          <div className="text-slate-500 text-[9px] uppercase tracking-wider">Mean margin</div>
          <div className="text-slate-100 font-mono">{summary.meanMargin >= 0 ? '+' : ''}{summary.meanMargin.toFixed(0)} ft</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/60 p-1.5">
          <div className="text-slate-500 text-[9px] uppercase tracking-wider">Worst</div>
          <div className="text-slate-100 font-mono truncate">{summary.worstCs}</div>
        </div>
        <div className="rounded border border-rose-500/30 bg-rose-500/5 p-1.5">
          <div className="text-rose-300 text-[9px] uppercase tracking-wider">Overrun</div>
          <div className="text-rose-200 font-mono">{counts['OVERRUN']}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/60 p-1.5">
          <div className="text-slate-500 text-[9px] uppercase tracking-wider">Tailwind &gt; 5</div>
          <div className="text-amber-300 font-mono">{(summary.twShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/60 p-1.5">
          <div className="text-slate-500 text-[9px] uppercase tracking-wider">Contaminated</div>
          <div className="text-rose-300 font-mono">{(summary.contShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/60 p-1.5">
          <div className="text-slate-500 text-[9px] uppercase tracking-wider">AB-low</div>
          <div className="text-amber-300 font-mono">{(summary.abLowShare * 100).toFixed(0)}%</div>
        </div>
      </div>

      {/* diagnostic scatter */}
      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-1">LDR ft vs LDA ft</div>
          <svg viewBox="0 0 240 140" className="w-full h-[110px] block">
            {/* y=x rose breach diagonal: LDR=LDA at (10,130)→(228,20) */}
            <polygon points="10,130 228,20 228,130" fill="#10b981" fillOpacity="0.06" />
            <polygon points="10,130 228,20 10,20" fill="#f43f5e" fillOpacity="0.06" />
            <line x1="10" y1="130" x2="228" y2="20" stroke="#f43f5e" strokeWidth="0.6" strokeDasharray="3 2" opacity="0.7" />
            <line x1="10" y1="130" x2="228" y2="130" stroke="#334155" strokeWidth="0.5" />
            <line x1="10" y1="20"  x2="10"  y2="130" stroke="#334155" strokeWidth="0.5" />
            <text x="14" y="28" fontSize="7" fill="#f43f5e">LDR &gt; LDA breach</text>
            <text x="220" y="138" textAnchor="end" fontSize="7" fill="#64748b">LDR 15k</text>
            <text x="12" y="26" fontSize="7" fill="#64748b">LDA 15k</text>
            <text x="180" y="100" fontSize="7" fill="#10b981">margin</text>
            {scatterDots.map((d, i) => (
              <circle key={i} cx={d.cx} cy={d.cy} r="2" fill={d.color} opacity="0.75" />
            ))}
          </svg>
        </div>
      )}

      {/* sliders */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 px-3 py-2 border-b border-slate-800 text-[10px]">
        {([
          ['MIN-FL', minFL, setMinFL, 0, 400, 10],
          ['SURF-BIAS', surfBias, setSurfBias, -50, 50, 5],
          ['TW-BIAS kt', twBias, setTwBias, -10, 15, 1],
          ['VAPP-NOISE %', vappNoise, setVappNoise, 0, 250, 5],
          ['LDR-MUL %', ldrMul, setLdrMul, 50, 200, 5],
          ['AB-MUL %', abMul, setAbMul, 50, 200, 5],
          ['PHASE-WT %', phaseW, setPhaseW, 50, 150, 5],
        ] as Array<[string, number, (v: number) => void, number, number, number]>).map(([lbl, v, set, mn, mx, st]) => (
          <label key={lbl} className="flex items-center gap-1.5">
            <span className="text-slate-500 w-20 shrink-0">{lbl}</span>
            <input type="range" min={mn} max={mx} step={st} value={v} onChange={e => set(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
            <span className="text-slate-300 font-mono w-9 text-right">{v}</span>
          </label>
        ))}
      </div>

      {/* surface chip filter */}
      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {(['DRY', 'WET', 'CONT-COMP', 'CONT-SLUSH'] as Surface[]).map(k => (
          <button
            key={k}
            onClick={() => toggleSurf(k)}
            className={`px-2 py-0.5 rounded border text-[10px] font-semibold tracking-wide transition ${surfFilter.has(k) ? SURF_PILL[k] : 'bg-slate-900/40 border-slate-800 text-slate-600'}`}
          >{k}</button>
        ))}
      </div>

      {/* overlay toggles */}
      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800">
        {([
          ['HALO', showHalo, setShowHalo],
          ['PIN', showPin, setShowPin],
          ['LBL', showLbl, setShowLbl],
          ['XLINE', showXline, setShowXline],
          ['STOP', showStop, setShowStop],
          ['RWY', showRwy, setShowRwy],
          ['REF', showRef, setShowRef],
          ['DIAG', showDiag, setShowDiag],
        ] as Array<[string, boolean, (v: boolean) => void]>).map(([lbl, on, set]) => (
          <button
            key={lbl}
            onClick={() => set(!on)}
            className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold tracking-wide transition ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/40 border-slate-800 text-slate-500'}`}
          >{lbl}</button>
        ))}
      </div>

      {/* search + tabs */}
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="search callsign / type / icao / rwy"
          className="flex-1 bg-slate-900 border border-slate-800 rounded px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50"
        />
      </div>
      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'RUNWAYS', 'SURFACES'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 px-2 py-1.5 text-[10px] font-semibold tracking-wider transition ${tab === t ? 'text-sky-300 border-b border-sky-500/60 bg-sky-500/5' : 'text-slate-500 hover:text-slate-300'}`}
          >{t}</button>
        ))}
      </div>

      {/* list */}
      <div className="flex-1 overflow-y-auto text-[11px]">
        {tab === 'AIRCRAFT' && ranked.map(({ f, c }) => (
          <button
            key={f.icao}
            onClick={() => onFly(f.icao)}
            className="w-full text-left px-3 py-2 border-b border-slate-900/80 hover:bg-slate-900/60 transition flex flex-col gap-1"
          >
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="w-1 h-4 rounded" style={{ background: TIER_COLOR[c.tier] }} />
              <span className="font-semibold text-slate-100">{f.callsign?.trim() || f.icao}</span>
              <span className="text-slate-500 text-[10px]">{f.type || '—'}</span>
              <span className="px-1 py-0.5 rounded border text-[9px] font-semibold bg-slate-800/60 border-slate-700 text-slate-300">{c.cls}</span>
              <span className={`px-1 py-0.5 rounded border text-[9px] font-semibold ${SURF_PILL[c.surface]}`}>{c.surface}</span>
              <span className={`px-1 py-0.5 rounded border text-[9px] font-semibold ${AB_PILL[c.ab]}`}>{c.ab}</span>
              <span className={`px-1 py-0.5 rounded border text-[9px] font-semibold ${REV_PILL[c.rev]}`}>{c.rev}</span>
              <span className={`ml-auto px-1 py-0.5 rounded border text-[9px] font-semibold ${TIER_BG[c.tier]}`}>{c.tier}</span>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono flex-wrap">
              <span className="text-sky-300">{c.rwy ? `${c.rwy.icao}/${c.rwy.rwy}` : '—'}</span>
              <span>LDA {c.rwy ? c.rwy.lda.toFixed(0) : '—'}</span>
              <span>LDR {c.ldr.toFixed(0)}</span>
              <span className={c.margin <= 0 ? 'text-rose-300' : c.margin < 750 ? 'text-amber-300' : 'text-emerald-300'}>
                {c.margin >= 0 ? '+' : ''}{c.margin.toFixed(0)}ft
              </span>
              <span>μ{c.mu.toFixed(2)}</span>
              <span>Vapp {c.vapp.toFixed(0)}</span>
              <span className={c.twKt > 5 ? 'text-amber-300' : ''}>TW{c.twKt >= 0 ? '+' : ''}{c.twKt.toFixed(0)}</span>
              <span>{c.phase}</span>
            </div>
            <div className="h-1 rounded bg-slate-800 overflow-hidden">
              <div className="h-full" style={{ width: `${c.score}%`, background: TIER_COLOR[c.tier] }} />
            </div>
            <div className="grid grid-cols-6 gap-0.5 text-[8px]">
              {([
                ['MGN', c.scoreMgn], ['ENE', c.scoreEne], ['SUR', c.scoreSur], ['TW', c.scoreTw], ['CFG', c.scoreCfg], ['ROL', c.scoreRol],
              ] as Array<[string, number]>).map(([n, s]) => {
                const t: Tier = s >= 80 ? 'OVERRUN' : s >= 55 ? 'SHORT-MARGIN' : s >= 25 ? 'WATCH' : 'ROW-OK'
                return (
                  <div key={n} className={`text-center rounded border ${TIER_BG[t]} px-0.5 py-0.5 font-mono`}>
                    <div className="opacity-70">{n}</div>
                    <div>{s.toFixed(0)}</div>
                  </div>
                )
              })}
            </div>
            <div className="text-[9px] text-slate-400 leading-snug">{c.advice}</div>
          </button>
        ))}

        {tab === 'RUNWAYS' && byRwy.map(r => (
          <div key={r.k} className="px-3 py-2 border-b border-slate-900/80 flex flex-col gap-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="w-1 h-4 rounded" style={{ background: TIER_COLOR[r.worst] }} />
              <span className="font-semibold text-slate-100 font-mono">{r.spec.icao}/{r.spec.rwy}</span>
              <span className="text-slate-400 text-[10px]">{r.spec.note || '—'}</span>
              {r.spec.short && <span className="px-1 py-0.5 rounded border text-[9px] font-semibold bg-amber-500/15 border-amber-500/40 text-amber-200">SHORT</span>}
              <span className={`px-1 py-0.5 rounded border text-[9px] font-semibold ${SURF_PILL[r.spec.surfaceBias]}`}>{r.spec.surfaceBias}</span>
              {r.ovr > 0 && <span className="px-1 py-0.5 rounded border text-[9px] font-semibold bg-rose-500/15 border-rose-500/40 text-rose-200">OVR {r.ovr}</span>}
              {r.sm > 0 && <span className="px-1 py-0.5 rounded border text-[9px] font-semibold bg-amber-500/15 border-amber-500/40 text-amber-200">SM {r.sm}</span>}
              <span className="ml-auto text-slate-500 text-[10px] font-mono">{r.n} a/c</span>
            </div>
            <div className="text-[9px] text-slate-500 font-mono">LDA {r.spec.lda} · QFU {r.spec.qfu.toString().padStart(3,'0')} · slope {r.spec.slope >= 0 ? '+' : ''}{r.spec.slope}%</div>
            <div className="h-1 rounded bg-slate-800 overflow-hidden">
              <div className="h-full" style={{ width: `${r.mean}%`, background: TIER_COLOR[r.worst] }} />
            </div>
          </div>
        ))}

        {tab === 'SURFACES' && bySurface.map(r => (
          <div key={r.k} className="px-3 py-2 border-b border-slate-900/80 flex flex-col gap-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className={`px-1 py-0.5 rounded border text-[9px] font-semibold ${SURF_PILL[r.k]}`}>{r.k}</span>
              <span className="text-slate-500 text-[10px]">μ {{ 'DRY': 0.45, 'WET': 0.32, 'CONT-COMP': 0.20, 'CONT-SLUSH': 0.10 }[r.k].toFixed(2)}</span>
              {r.ovr > 0 && <span className="px-1 py-0.5 rounded border text-[9px] font-semibold bg-rose-500/15 border-rose-500/40 text-rose-200">OVR {r.ovr}</span>}
              {r.sm > 0 && <span className="px-1 py-0.5 rounded border text-[9px] font-semibold bg-amber-500/15 border-amber-500/40 text-amber-200">SM {r.sm}</span>}
              <span className="ml-auto text-slate-500 text-[10px] font-mono">{r.n} a/c</span>
            </div>
            <div className="h-1 rounded bg-slate-800 overflow-hidden">
              <div className="h-full" style={{ width: `${r.mean}%`, background: r.mean >= 80 ? '#f43f5e' : r.mean >= 55 ? '#f59e0b' : r.mean >= 25 ? '#0ea5e9' : '#10b981' }} />
            </div>
          </div>
        ))}

        {((tab === 'AIRCRAFT' && ranked.length === 0) || (tab === 'RUNWAYS' && byRwy.length === 0)) && (
          <div className="px-3 py-8 text-center text-[11px] text-slate-500">
            no arrivals in scope · widen MIN-FL or wait for inbound traffic
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 font-mono leading-tight">
        AC 91-79B · AC 25-32 LDTA · ROW/ROP AI/ST-F/449.0177 · SmartLanding RAAS · post-EK521/AF358/SWA1248
      </div>
    </div>
  )
}
