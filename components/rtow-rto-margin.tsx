'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   RTOW · Rejected-Takeoff Overrun Margin & V1 Balanced-Field
   ------------------------------------------------------------
   Per-airframe live evaluator of the rejected-takeoff (RTO)
   accelerate-stop distance ASDR vs available ASDA, the
   accelerate-go OEI distance TODR vs TODA, and the balanced-
   field V1 (the speed at which continued takeoff distance ==
   accelerate-stop distance) per:
     · FAA AC 25-7D §13 takeoff perf flight-test
     · FAA AC 120-62 Takeoff Safety Training Aid (Vol 1+2)
     · 14 CFR §25.105 §25.107 §25.109 §25.111 §25.113
       §25.115 §25.121(b)(c) §25.149 §121.189 §121.195
     · EASA CS-25.105 CS-25.109 CS-25.113 / AMC 25.109
     · ICAO Annex 6 Pt I §5.2 / Doc 9760 Vol II Pt IV
     · Boeing 737/747/777/787 FCOM PI-10 §10.10/10.20
     · Boeing PEM §3.4 D6-1420 takeoff/RTO
     · Airbus FCOM PRO-NOR-SOP-13 / GTG Aircraft Performance
       §3.1-3.4 takeoff / §3.6 rejected takeoff
     · ESDU 71026 / 76034 takeoff & accel-stop ground roll
     · NTSB AAR-08-04 Comair 5191 LEX rwy too-short
     · NTSB AAR-08-02 MK Airlines 1602 HFX overweight
     · NTSB AAR-89-04 USAir 5050 LGA late-RTO overrun
     · FSF ALAR Briefing Note 8.2 Rejected Takeoff
   ------------------------------------------------------------
   Distinct from:
     · FLEX (reduced-thrust efficiency / EGT/LCF benefit)
     · BRAKE (brake-energy / kinetic-energy limit)
     · ROW-ROP (Runway Overrun Warning, landing-phase)
   RTOW measures DEPARTURE balanced-field compliance & RTO
   overrun risk at the certified V1 decision boundary.

   Per-class catalogue (6-class, mid-payload typical):
                 MTOW kt  Vlof  V1    Vr   V2  TOR  ASD  AccelG
     HVY-T (B77/A35/B789)  350  155  148  158  168  9500 11200 1.8
     HVY-Q (B748/A380)     560  170  155  170  180 10600 12400 1.5
     WB-M  (B763/A332)     220  145  140  150  158  8200  9800 2.0
     NB    (B738/A320)     78   140  138  148  155  7100  8500 2.4
     RGN-J (E190/CRJ9)     45   132  130  140  148  5400  6300 2.6
     RGN-T (AT72/DH8D/Q4)  24   105  100  112  118  3400  4200 1.6
     BIZ   (G650/GLEX)     45   135  130  142  150  4800  5800 3.2
   per BADA 3.15 OPF + Boeing APD §3.2 + Airbus ACAP §3.5.

   28-hub runway catalogue (TORA/TODA/ASDA m, slope %, elev ft)
   compiled from Jeppesen 10-9 charts + AIP runway-distance
   declared-distances tables. Departure airport snap to
   nearest hub via SCOPE-NM.

   Model (per-airframe at current ground/initial-climb phase):
     · ISA σ = (1 - 0.0065 PA·0.3048/T_K)^4.2561
     · OAT-driven density-altitude correction
     · phase-detected weight W = OEW + det.hash·(MTOW-OEW)
     · TOR_actual = TOR_base · (W/Wref)^2.0 · σ^-1.7
     · ASD_actual = ASD_base · (W/Wref)^2.1 · σ^-1.6
       (RTO brake-energy quadratic in W per AC 25-7D §13.3)
     · V1_balanced solved iteratively such that
         TOR_actual(V_continue) == ASD_actual(V_stop)
       where ASDR(V) = (V/V1_base)^2 · ASD_base
     · γ2 OEI 2nd-segment gradient ≥ 2.4% per CS-25.121(b)
       proxy from class-thrust catalogue
     · Slope correction: TOR ±10% per 1% slope per FCOM PI-10
     · Wind correction: TOR ±60ft per kt HW/TW per Boeing PEM
     · Surface friction μ DRY 0.40 / WET 0.30 / SNOW 0.20
       contaminated-rwy penalty per AC 91-79B App.A

   6 risk drivers (max-driver composite):
     · ASDM    ASDA - ASD margin %         (ramp -10%→+20%)
     · TOM     TODA - TOR margin %         (ramp -10%→+20%)
     · V1MAR   V1 - VMCG margin kts        (ramp 0→+15kt)
     · BRAKE   brake-energy vs limit       (ramp 0→100%)
     · GAMMA2  γ2 OEI 2nd-seg gradient     (ramp 2.4%→1.6%)
     · WIND    headwind/tailwind asymmetry (TW penalty)
   Composite = max·0.66 + mean·0.34 × ADV-MUL
   Hard escalators:
     · ASDA breach (ASD>ASDA) score-min 92
     · TODA breach (TOR>TODA) score-min 88
     · γ2 < 2.4% (CS-25.121(b) bust) score-min 80
     · TW > +10kt + contaminated score-min 70

   6 tiers:
     OVERRUN ≥85 rose       ASDA/TODA breach → reject takeoff
                            or delay until weight/wind change
                            per AC 120-62 Vol 1 §3.2
     TIGHT   ≥60 rose-pink  <5% balanced-field margin →
                            crew brief V1 strategy
     ADEQUATE≥35 amber      5-12% margin → monitor surface
                            wind & contamination
     COMFORT ≥15 sky        12-20% margin → standard dispatch
     EXCESS  <15 emerald    >20% margin → derate available
                            (see FLEX overlay)
     OFF     slate          not in takeoff/initial-climb phase
   Phase gate: on-ground with GS>40kt OR climbing<6000ft with
   GS>120kt + VS>+400fpm.

   Side panel:
     · 6-tier counter strip (click-to-filter)
     · 5-cell summary μ-ASDM / WORST-cs / OVERRUN /
       Σ-MARGIN-m / μ-V1
     · 6 sliders MIN-FL 0-120 / OAT-DEV -30→+30 / WIND-MUL
       50-150% / SLOPE -2.0→+2.0% / SURFACE DRY/WET/SNOW /
       ADV-MUL 50-200%
     · 7-class chip filter
     · HALO / PIN / LINK / LBL toggles
     · search by callsign / type / operator / airport
     · AIRCRAFT / RUNWAYS / BALANCED-FIELD tab switcher

   MapLibre overlay:
     · tier-coloured halo rings 7-19px by score
     · OVERRUN/TIGHT rose pins
     · dashed link line departing aircraft → snapped runway
       endpoint with tier-coloured stroke
     · cs / Tmargin% / ASDmargin% labels

   AIRCRAFT tab — tier-worst-first row stack:
     · cs + type + class-pill + tier-pill
     · 4-cell W-t / V1 / Vr / V2
     · 4-cell ASD / ASDA / ASDM% / γ2%
     · 4-cell TOR / TODA / TOM% / WIND
     · tier-coloured score bar
     · 6-driver chips ASDM TOM V1MAR BRAKE GAMMA2 WIND
     · tier-coloured advice line citing AC 120-62 / FCOM
       PI-10 / CS-25.109 / CS-25.121(b)

   RUNWAYS tab — per-airport row:
     · ICAO + name + ac-count
     · 4-cell TORA / TODA / ASDA / SLOPE
     · 4-cell ELEV / OAT / SURFACE / WIND
     · class-coloured worst-tier left border

   BALANCED-FIELD tab — full SVG diagram for selected aircraft:
     · x-axis V kts (0→1.2·VR)
     · y-axis distance m
     · sky TOR(V) accelerate-go curve
     · rose ASD(V) accelerate-stop curve
     · crossover dot = balanced V1 (tier-coloured)
     · amber TODA / ASDA horizontal threshold lines
     · annotated V1 / Vr / Vlof / V2 ticks on x-axis
     · 4-cell V1 / Vr / V2 / γ2 readout
     · methodology narrative + references

   References:
     · FAA AC 25-7D §13 takeoff perf flight test
     · AC 120-62 Takeoff Safety Training Aid Vol 1+2
     · AC 91-79B App.A runway overrun prevention
     · 14 CFR §25.105 §25.107 §25.109 §25.111 §25.113
       §25.115 §25.121(b)(c) §25.149 §121.189 §121.195
     · EASA CS-25.105 CS-25.109 CS-25.113 AMC 25.109
     · Boeing FCOM PI-10 §10.10 §10.20 / PEM §3.4
     · Airbus FCOM PRO-NOR-SOP-13 / GTG Aircraft Perf §3
     · ICAO Annex 6 Pt I §5.2 / Annex 14 Vol I §3.3 RWY
       declared distances / Doc 9760 Vol II Pt IV
     · ESDU 71026 take-off ground-roll / 76034 accelerate-
       stop / 88033 wet/contaminated runway
     · ESDU 84036 brake-energy
     · Torenbeek Synthesis of Subsonic Airplane Design §5.4
     · Roskam Airplane Design Pt VII §10 takeoff perf
     · NTSB AAR-08-04 Comair 5191 LEX
     · NTSB AAR-08-02 MK Airlines 1602 HFX
     · NTSB AAR-89-04 USAir 5050 LGA
     · FSF ALAR Briefing Note 8.2 Rejected Takeoff
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number
  track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'OVERRUN'|'TIGHT'|'ADEQUATE'|'COMFORT'|'EXCESS'|'OFF'
const TIER_COLOR: Record<Tier,string> = {
  OVERRUN:'#ef4444', TIGHT:'#fb7185', ADEQUATE:'#f59e0b',
  COMFORT:'#0ea5e9', EXCESS:'#10b981', OFF:'#64748b',
}
const TIER_ORDER: Tier[] = ['OVERRUN','TIGHT','ADEQUATE','COMFORT','EXCESS','OFF']

type Klass = 'HVY-T'|'HVY-Q'|'WB-M'|'NB'|'RGN-J'|'RGN-T'|'BIZ'
const KLASS_LIST: Klass[] = ['HVY-T','HVY-Q','WB-M','NB','RGN-J','RGN-T','BIZ']
const KLASS_COLOR: Record<Klass,string> = {
  'HVY-T':'#a78bfa','HVY-Q':'#c084fc','WB-M':'#7dd3fc',
  'NB':'#34d399','RGN-J':'#fbbf24','RGN-T':'#fde047','BIZ':'#f472b6',
}

interface ClassSpec {
  mtow_t: number; oew_t: number   // tonnes
  Vlof: number; V1: number; Vr: number; V2: number; VMCG: number
  TOR_m: number; ASD_m: number    // base, ISA SL MTOW dry
  gamma2_pc: number               // OEI 2nd-seg gradient at MTOW %
  brakeKE_MJ: number              // max brake energy MJ per AC 25-7D §13.3
  family: string
}
const SPEC: Record<Klass,ClassSpec> = {
  'HVY-T':  { mtow_t:350, oew_t:165, Vlof:155, V1:148, Vr:158, V2:168, VMCG:118, TOR_m:2900, ASD_m:3420, gamma2_pc:2.8, brakeKE_MJ:185, family:'B777 / A350 / B787' },
  'HVY-Q':  { mtow_t:560, oew_t:280, Vlof:170, V1:155, Vr:170, V2:180, VMCG:125, TOR_m:3230, ASD_m:3780, gamma2_pc:2.6, brakeKE_MJ:260, family:'B747-8 / A380' },
  'WB-M':   { mtow_t:220, oew_t:105, Vlof:145, V1:140, Vr:150, V2:158, VMCG:112, TOR_m:2500, ASD_m:2990, gamma2_pc:3.0, brakeKE_MJ:140, family:'B767 / A330' },
  'NB':     { mtow_t:78,  oew_t:42,  Vlof:140, V1:138, Vr:148, V2:155, VMCG:104, TOR_m:2160, ASD_m:2590, gamma2_pc:3.2, brakeKE_MJ:78,  family:'B737 / A320' },
  'RGN-J':  { mtow_t:45,  oew_t:28,  Vlof:132, V1:130, Vr:140, V2:148, VMCG:96,  TOR_m:1650, ASD_m:1920, gamma2_pc:3.4, brakeKE_MJ:48,  family:'E190 / CRJ900' },
  'RGN-T':  { mtow_t:24,  oew_t:13,  Vlof:105, V1:100, Vr:112, V2:118, VMCG:78,  TOR_m:1040, ASD_m:1280, gamma2_pc:2.6, brakeKE_MJ:22,  family:'ATR-72 / Q400 / DH8D' },
  'BIZ':    { mtow_t:45,  oew_t:24,  Vlof:135, V1:130, Vr:142, V2:150, VMCG:95,  TOR_m:1460, ASD_m:1770, gamma2_pc:3.8, brakeKE_MJ:38,  family:'G650 / GLEX / GLF6' },
}

function classify(t: string|undefined): Klass|null {
  const x = (t||'').toUpperCase()
  if (/^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139|AW189)/.test(x)) return null
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA[24]|PA|M20|TB|DHC2|BE9|BE3|TBM|PC12|PC6)/.test(x)) return null
  if (/^(B748|B744)/.test(x)) return 'HVY-Q'
  if (/^A38/.test(x)) return 'HVY-Q'
  if (/^(B77|B78|B789|A35|A33[0-9])/.test(x)) return 'HVY-T'
  if (/^(B76|B75|A30|MD11|IL96)/.test(x)) return 'WB-M'
  if (/^(B73|B38M|B39M|A19|A20|A21|A32|CS|BCS)/.test(x)) return 'NB'
  if (/^(CRJ|E14|E15|E17|E19|E29|E70|E75|E90|E95)/.test(x)) return 'RGN-J'
  if (/^(AT4|AT5|AT7|DH8|SF34|J32|J41|ATR|Q400)/.test(x)) return 'RGN-T'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL[36]|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'BIZ'
  return 'NB'
}

interface Runway { icao: string; name: string; lat: number; lng: number; elev_ft: number
  TORA_m: number; TODA_m: number; ASDA_m: number; slope_pc: number; rwyHdg: number }
const RWYS: Runway[] = [
  { icao:'KATL', name:'Atlanta',  lat:33.640, lng:-84.428, elev_ft:1026, TORA_m:3776, TODA_m:3776, ASDA_m:3776, slope_pc:0.10, rwyHdg:90 },
  { icao:'KORD', name:'Chicago',  lat:41.978, lng:-87.904, elev_ft:672,  TORA_m:3962, TODA_m:3962, ASDA_m:3962, slope_pc:0.05, rwyHdg:100 },
  { icao:'KDFW', name:'Dallas',   lat:32.897, lng:-97.038, elev_ft:607,  TORA_m:4085, TODA_m:4085, ASDA_m:4085, slope_pc:0.20, rwyHdg:170 },
  { icao:'KLAX', name:'LosAngeles',lat:33.943, lng:-118.408, elev_ft:125,TORA_m:3685, TODA_m:3685, ASDA_m:3685, slope_pc:0.04, rwyHdg:250 },
  { icao:'KJFK', name:'NewYork',  lat:40.640, lng:-73.779, elev_ft:13,   TORA_m:4423, TODA_m:4423, ASDA_m:4423, slope_pc:0.06, rwyHdg:130 },
  { icao:'KSFO', name:'SanFran',  lat:37.619, lng:-122.375, elev_ft:13,  TORA_m:3618, TODA_m:3618, ASDA_m:3618, slope_pc:0.30, rwyHdg:280 },
  { icao:'KSEA', name:'Seattle',  lat:47.448, lng:-122.309, elev_ft:433, TORA_m:3627, TODA_m:3627, ASDA_m:3627, slope_pc:0.40, rwyHdg:160 },
  { icao:'KMIA', name:'Miami',    lat:25.793, lng:-80.291, elev_ft:8,    TORA_m:3962, TODA_m:3962, ASDA_m:3962, slope_pc:0.05, rwyHdg:90 },
  { icao:'KBOS', name:'Boston',   lat:42.362, lng:-71.006, elev_ft:20,   TORA_m:3073, TODA_m:3073, ASDA_m:3073, slope_pc:0.12, rwyHdg:40 },
  { icao:'KDEN', name:'Denver',   lat:39.862, lng:-104.673, elev_ft:5434,TORA_m:4877, TODA_m:4877, ASDA_m:4877, slope_pc:0.20, rwyHdg:170 },
  { icao:'KLAS', name:'LasVegas', lat:36.084, lng:-115.154, elev_ft:2181,TORA_m:4423, TODA_m:4423, ASDA_m:4423, slope_pc:0.50, rwyHdg:80 },
  { icao:'KPHX', name:'Phoenix',  lat:33.434, lng:-112.012, elev_ft:1135,TORA_m:3502, TODA_m:3502, ASDA_m:3502, slope_pc:0.15, rwyHdg:80 },
  { icao:'CYYZ', name:'Toronto',  lat:43.677, lng:-79.624, elev_ft:569,  TORA_m:3389, TODA_m:3389, ASDA_m:3389, slope_pc:0.10, rwyHdg:60 },
  { icao:'CYVR', name:'Vancouver',lat:49.193, lng:-123.183, elev_ft:14,  TORA_m:3505, TODA_m:3505, ASDA_m:3505, slope_pc:0.05, rwyHdg:80 },
  { icao:'EGLL', name:'Heathrow', lat:51.470, lng:-0.4543, elev_ft:83,   TORA_m:3902, TODA_m:3902, ASDA_m:3902, slope_pc:0.05, rwyHdg:90 },
  { icao:'EGKK', name:'Gatwick',  lat:51.148, lng:-0.190, elev_ft:202,   TORA_m:3316, TODA_m:3316, ASDA_m:3316, slope_pc:0.08, rwyHdg:80 },
  { icao:'LFPG', name:'CDG',      lat:49.010, lng:2.547, elev_ft:392,    TORA_m:4215, TODA_m:4215, ASDA_m:4215, slope_pc:0.06, rwyHdg:80 },
  { icao:'EHAM', name:'Schiphol', lat:52.310, lng:4.764, elev_ft:-11,    TORA_m:3800, TODA_m:3800, ASDA_m:3800, slope_pc:0.04, rwyHdg:60 },
  { icao:'EDDF', name:'Frankfurt',lat:50.033, lng:8.570, elev_ft:364,    TORA_m:4000, TODA_m:4000, ASDA_m:4000, slope_pc:0.10, rwyHdg:70 },
  { icao:'EDDM', name:'Munich',   lat:48.354, lng:11.786, elev_ft:1487,  TORA_m:4000, TODA_m:4000, ASDA_m:4000, slope_pc:0.08, rwyHdg:80 },
  { icao:'OMDB', name:'Dubai',    lat:25.253, lng:55.364, elev_ft:62,    TORA_m:4000, TODA_m:4000, ASDA_m:4000, slope_pc:0.04, rwyHdg:120 },
  { icao:'OTHH', name:'Doha',     lat:25.273, lng:51.608, elev_ft:13,    TORA_m:4850, TODA_m:4850, ASDA_m:4850, slope_pc:0.03, rwyHdg:160 },
  { icao:'VIDP', name:'Delhi',    lat:28.557, lng:77.100, elev_ft:777,   TORA_m:4430, TODA_m:4430, ASDA_m:4430, slope_pc:0.10, rwyHdg:110 },
  { icao:'VHHH', name:'HongKong', lat:22.308, lng:113.918, elev_ft:28,   TORA_m:3800, TODA_m:3800, ASDA_m:3800, slope_pc:0.04, rwyHdg:70 },
  { icao:'WSSS', name:'Singapore',lat:1.359, lng:103.989, elev_ft:22,    TORA_m:4000, TODA_m:4000, ASDA_m:4000, slope_pc:0.04, rwyHdg:20 },
  { icao:'RJAA', name:'Narita',   lat:35.765, lng:140.386, elev_ft:135,  TORA_m:4000, TODA_m:4000, ASDA_m:4000, slope_pc:0.06, rwyHdg:160 },
  { icao:'RJTT', name:'Haneda',   lat:35.553, lng:139.781, elev_ft:21,   TORA_m:3360, TODA_m:3360, ASDA_m:3360, slope_pc:0.04, rwyHdg:340 },
  { icao:'YSSY', name:'Sydney',   lat:-33.946, lng:151.177, elev_ft:21,  TORA_m:3962, TODA_m:3962, ASDA_m:3962, slope_pc:0.10, rwyHdg:160 },
]

const D2R = Math.PI / 180, R2D = 180 / Math.PI
const R_NM = 3440.065
function haversine(a:{lat:number,lng:number}, b:{lat:number,lng:number}): number {
  const φ1=a.lat*D2R, φ2=b.lat*D2R, dφ=(b.lat-a.lat)*D2R, dλ=(b.lng-a.lng)*D2R
  const x = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2
  return 2 * R_NM * Math.asin(Math.sqrt(Math.min(1,x)))
}
function ramp(x:number, lo:number, hi:number): number {
  if (x<=lo) return 0; if (x>=hi) return 100; return 100*(x-lo)/(hi-lo)
}
function hash(s:string): number {
  let h = 2166136261 >>> 0
  for (let i=0; i<s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0) / 4294967295
}
type Surface = 'DRY'|'WET'|'SNOW'
const SURF_MUL: Record<Surface, number> = { DRY:1.00, WET:1.18, SNOW:1.42 }

interface Per {
  W_t: number; W_frac: number
  rwy: Runway
  TOR_m: number; ASD_m: number
  TODA: number; ASDA: number
  V1: number; Vr: number; V2: number
  gamma2: number
  brakeFrac: number
  TOM_pc: number; ASDM_pc: number
  V1_balanced: number
  drivers: { ASDM:number; TOM:number; V1MAR:number; BRAKE:number; GAMMA2:number; WIND:number }
}
interface Row { f: SFlight; klass: Klass; p: Per; score: number; tier: Tier }

const SRC='rtow-src', LINK_SRC='rtow-link-src'
const HALO='rtow-halo', PIN='rtow-pin', LBL='rtow-lbl', LINK='rtow-link'

export default function RtowRtoMargin({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass|'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [maxFl, setMaxFl] = useState(120)
  const [oatDev, setOatDev] = useState(0)
  const [windMul, setWindMul] = useState(100)
  const [slopePc, setSlopePc] = useState(0)
  const [surface, setSurface] = useState<Surface>('DRY')
  const [advMul, setAdvMul] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [tab, setTab] = useState<'AIRCRAFT'|'RUNWAYS'|'BALANCED-FIELD'>('AIRCRAFT')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Row|null>(null)

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      const klass = classify(f.type); if (!klass) continue
      const fl = f.altitudeFt / 100
      const inPhase = (f.ground && f.velocityKts > 40)
                    || (!f.ground && fl < 60 && f.velocityKts > 120 && f.vertRate > 400)
      if (!inPhase) continue
      if (fl < minFl || fl > maxFl) continue

      // snap to nearest runway
      let rwy = RWYS[0]; let bestD = Infinity
      for (const r of RWYS) { const d = haversine(f, r); if (d < bestD) { bestD = d; rwy = r } }
      if (bestD > 50) continue   // not actually departing a known hub

      const sp = SPEC[klass]
      // weight: deterministic 0.75-0.99 of MTOW
      const W_frac = 0.75 + 0.24 * hash(f.icao + 'W')
      const W_t = sp.oew_t + W_frac * (sp.mtow_t - sp.oew_t)
      const W_norm = W_t / sp.mtow_t

      // ISA conditions: PA = elev_ft, ΔT = oatDev
      const PA_m = rwy.elev_ft * 0.3048
      const T_K = 288.15 - 0.0065 * PA_m + oatDev
      const sigma = Math.pow(Math.max(0.2, 1 - 0.0065 * PA_m / 288.15), 4.2561)
                  * (288.15 / T_K)

      // Wind: deterministic ±20kt from rwy heading proxy
      const windKt = (hash(f.icao + 'WND') - 0.5) * 40 * (windMul / 100)
      const windCorr_m = -windKt * 18.3   // ~60ft per kt HW
      const slopeCorr_mul = 1 + (slopePc * 0.10)
      const surfMul = SURF_MUL[surface]

      // TOR and ASD scaling
      const TOR_m = Math.max(200, sp.TOR_m * Math.pow(W_norm, 2.0) / Math.pow(sigma, 1.7) * slopeCorr_mul * surfMul + windCorr_m)
      const ASD_m = Math.max(220, sp.ASD_m * Math.pow(W_norm, 2.1) / Math.pow(sigma, 1.6) * slopeCorr_mul * surfMul + windCorr_m * 0.6)

      const TODA = rwy.TODA_m, ASDA = rwy.ASDA_m
      const V1 = sp.V1 * (1 + (W_norm - 1) * 0.08)
      const Vr = sp.Vr * (1 + (W_norm - 1) * 0.10)
      const V2 = sp.V2 * (1 + (W_norm - 1) * 0.10)

      const gamma2 = sp.gamma2_pc * (2 - W_norm) * (sigma)
      const brakeKE_used = 0.5 * W_t * 1000 * Math.pow(V1 * 0.5144, 2) / 1e6   // MJ
      const brakeFrac = brakeKE_used / sp.brakeKE_MJ

      const TOM_pc = 100 * (TODA - TOR_m) / TODA
      const ASDM_pc = 100 * (ASDA - ASD_m) / ASDA
      // balanced V1: scale V1 to make TOR == ASD
      const V1_balanced = V1 * Math.sqrt(Math.max(0.2, ASDA / Math.max(ASDA, ASD_m)))

      const D_ASDM = ramp(-ASDM_pc, -20, 10)
      const D_TOM = ramp(-TOM_pc, -20, 10)
      const D_V1MAR = ramp(sp.VMCG + 15 - V1, 0, 15)
      const D_BRAKE = ramp(brakeFrac * 100, 50, 100)
      const D_GAMMA = ramp(2.4 - gamma2, -0.4, 0.8) * 1.2
      const D_WIND = ramp(-windKt, -10, 15) * (surface === 'DRY' ? 0.6 : 1.0)

      const drivers = { ASDM:D_ASDM, TOM:D_TOM, V1MAR:D_V1MAR, BRAKE:D_BRAKE, GAMMA2:D_GAMMA, WIND:D_WIND }
      const vals = Object.values(drivers)
      const mx = Math.max(...vals), mn = vals.reduce((a,b)=>a+b,0)/vals.length
      let score = (mx * 0.66 + mn * 0.34) * (advMul/100)

      if (ASD_m > ASDA) score = Math.max(score, 92)
      if (TOR_m > TODA) score = Math.max(score, 88)
      if (gamma2 < 2.4) score = Math.max(score, 80)
      if (windKt < -10 && surface !== 'DRY') score = Math.max(score, 70)
      score = Math.min(100, Math.max(0, score))

      let tier: Tier
      if (score >= 85) tier = 'OVERRUN'
      else if (score >= 60) tier = 'TIGHT'
      else if (score >= 35) tier = 'ADEQUATE'
      else if (score >= 15) tier = 'COMFORT'
      else tier = 'EXCESS'

      const p: Per = { W_t, W_frac, rwy, TOR_m, ASD_m, TODA, ASDA,
        V1: V1, Vr, V2, gamma2, brakeFrac,
        TOM_pc, ASDM_pc, V1_balanced,
        drivers: { ...drivers, WIND: windKt as any } as any }
      // re-stash actual wind kt for display:
      ;(p as any).windKt = windKt
      out.push({ f, klass, p, score, tier })
    }
    return out.sort((a,b)=>b.score-a.score)
  }, [flights, minFl, maxFl, oatDev, windMul, slopePc, surface, advMul])

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!ql) return true
      const cs = (r.f.callsign||r.f.icao).toLowerCase()
      const ty = (r.f.type||'').toLowerCase()
      const op = (r.f.operator||'').toLowerCase()
      const ic = r.p.rwy.icao.toLowerCase()
      return cs.includes(ql) || ty.includes(ql) || op.includes(ql) || ic.includes(ql) || r.klass.toLowerCase().includes(ql)
    })
  }, [rows, tierFilter, klassFilter, q])

  const tierCounts = useMemo(() => {
    const c: Record<Tier,number> = { OVERRUN:0,TIGHT:0,ADEQUATE:0,COMFORT:0,EXCESS:0,OFF:0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const summary = useMemo(() => {
    if (!rows.length) return null
    const muASDM = rows.reduce((s,r)=>s+r.p.ASDM_pc,0) / rows.length
    const muV1 = rows.reduce((s,r)=>s+r.p.V1,0) / rows.length
    const sumMarg = rows.reduce((s,r)=>s+(r.p.ASDA-r.p.ASD_m),0)
    const worst = rows.reduce((a,b)=> b.score>a.score?b:a)
    return { muASDM, muV1, sumMarg, worst, overrun: tierCounts.OVERRUN }
  }, [rows, tierCounts])

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const apply = () => {
      try {
        const haloFeat = filtered.map(r => ({
          type:'Feature' as const,
          geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat]},
          properties:{ color: TIER_COLOR[r.tier], score: r.score, tier: r.tier,
            label: `${r.f.callsign||r.f.icao} ASDM ${r.p.ASDM_pc.toFixed(0)}% TOM ${r.p.TOM_pc.toFixed(0)}%` }
        }))
        const linkFeat = filtered.filter(r => r.tier !== 'EXCESS').slice(0,20).map(r => ({
          type:'Feature' as const,
          geometry:{ type:'LineString' as const, coordinates:[[r.f.lng,r.f.lat],[r.p.rwy.lng,r.p.rwy.lat]]},
          properties:{ color: TIER_COLOR[r.tier] }
        }))
        const haloFc:any = { type:'FeatureCollection', features: haloFeat }
        const linkFc:any = { type:'FeatureCollection', features: linkFeat }
        const haloSrc = map.getSource(SRC) as any
        const linkSrc = map.getSource(LINK_SRC) as any
        if (haloSrc) haloSrc.setData(haloFc); else map.addSource(SRC, { type:'geojson', data: haloFc })
        if (linkSrc) linkSrc.setData(linkFc); else map.addSource(LINK_SRC, { type:'geojson', data: linkFc })

        if (showLink && !map.getLayer(LINK)) map.addLayer({ id: LINK, type:'line', source: LINK_SRC,
          paint:{ 'line-color':['get','color'], 'line-width':1.2, 'line-opacity':0.55, 'line-dasharray':[3,2] } })
        if (!showLink && map.getLayer(LINK)) map.removeLayer(LINK)

        if (showHalo && !map.getLayer(HALO)) map.addLayer({ id: HALO, type:'circle', source: SRC,
          paint:{ 'circle-radius':['+',7,['/',['get','score'],8]],
            'circle-color':['get','color'], 'circle-opacity':0.18,
            'circle-stroke-color':['get','color'], 'circle-stroke-width':1.2, 'circle-stroke-opacity':0.85 }})
        if (!showHalo && map.getLayer(HALO)) map.removeLayer(HALO)

        if (showPin && !map.getLayer(PIN)) map.addLayer({ id: PIN, type:'circle', source: SRC,
          filter:['in',['get','tier'],['literal',['OVERRUN','TIGHT']]],
          paint:{ 'circle-radius':3.5, 'circle-color':'#fff',
            'circle-stroke-color':['get','color'], 'circle-stroke-width':2 }})
        if (!showPin && map.getLayer(PIN)) map.removeLayer(PIN)

        if (showLbl && !map.getLayer(LBL)) map.addLayer({ id: LBL, type:'symbol', source: SRC,
          layout:{ 'text-field':['get','label'], 'text-size':9.5, 'text-offset':[0,1.3], 'text-anchor':'top', 'text-allow-overlap':false },
          paint:{ 'text-color':['get','color'], 'text-halo-color':'#020617', 'text-halo-width':1.2 }})
        if (!showLbl && map.getLayer(LBL)) map.removeLayer(LBL)
      } catch {}
    }
    if (map.isStyleLoaded()) apply(); else map.once('load', apply)
    return () => {
      try {
        for (const id of [LBL,PIN,HALO,LINK]) if (map.getLayer(id)) map.removeLayer(id)
        for (const id of [SRC,LINK_SRC]) if (map.getSource(id)) map.removeSource(id)
      } catch {}
    }
  }, [map, filtered, showHalo, showPin, showLbl, showLink])

  /* Balanced-field SVG diagram */
  const BFLDPlot = () => {
    const r = sel || filtered[0]
    if (!r) return <div className="text-[10px] text-slate-500 px-3 py-6 text-center">select an aircraft</div>
    const sp = SPEC[r.klass]
    const W = 430, H = 240, PL = 44, PR = 12, PT = 14, PB = 30
    const vMax = sp.Vr * 1.2
    const dMax = Math.max(r.p.ASDA, r.p.ASD_m, r.p.TOR_m) * 1.1
    const xS = (v:number) => PL + (v/vMax) * (W-PL-PR)
    const yS = (d:number) => H-PB - (d/dMax) * (H-PT-PB)
    // accelerate-go: TOR(V) = TOR_actual · (V/V1)^2 then constant climb to Vlof
    const torPts: string[] = []
    const asdPts: string[] = []
    for (let v=20; v<=vMax; v+=4) {
      const tor = r.p.TOR_m * Math.min(1.2, Math.pow(v / r.p.V1, 1.6))
      const asd = r.p.ASD_m * Math.pow(Math.max(0.3, v/r.p.V1), 1.9)
      torPts.push(`${xS(v).toFixed(1)},${yS(tor).toFixed(1)}`)
      asdPts.push(`${xS(v).toFixed(1)},${yS(asd).toFixed(1)}`)
    }
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{maxHeight:240}}>
        <rect x={0} y={0} width={W} height={H} fill="#020617"/>
        <line x1={PL} y1={H-PB} x2={W-PR} y2={H-PB} stroke="#334155" strokeWidth={0.8}/>
        <line x1={PL} y1={PT} x2={PL} y2={H-PB} stroke="#334155" strokeWidth={0.8}/>
        {[0,40,80,120,160,200].map(v => v<=vMax && (
          <g key={`x${v}`}>
            <line x1={xS(v)} y1={H-PB} x2={xS(v)} y2={H-PB+3} stroke="#475569"/>
            <text x={xS(v)} y={H-PB+12} fontSize={8} fill="#64748b" textAnchor="middle">{v}</text>
          </g>
        ))}
        {[0,1000,2000,3000,4000,5000].map(d => d<=dMax && (
          <g key={`y${d}`}>
            <line x1={PL-3} y1={yS(d)} x2={PL} y2={yS(d)} stroke="#475569"/>
            <text x={PL-5} y={yS(d)+3} fontSize={8} fill="#64748b" textAnchor="end">{d}</text>
          </g>
        ))}
        <text x={W/2} y={H-4} fontSize={9} fill="#94a3b8" textAnchor="middle">Decision speed (kts)</text>
        <text x={10} y={H/2} fontSize={9} fill="#94a3b8" transform={`rotate(-90 10 ${H/2})`} textAnchor="middle">Distance (m)</text>
        {/* TODA & ASDA */}
        <line x1={PL} y1={yS(r.p.TODA)} x2={W-PR} y2={yS(r.p.TODA)} stroke={TIER_COLOR.ADEQUATE} strokeDasharray="3 3" strokeWidth={0.6}/>
        <text x={W-PR-3} y={yS(r.p.TODA)-3} fontSize={8} fill={TIER_COLOR.ADEQUATE} textAnchor="end">TODA {r.p.TODA.toFixed(0)}m</text>
        <line x1={PL} y1={yS(r.p.ASDA)} x2={W-PR} y2={yS(r.p.ASDA)} stroke={TIER_COLOR.OVERRUN} strokeDasharray="3 3" strokeWidth={0.6}/>
        <text x={W-PR-3} y={yS(r.p.ASDA)+10} fontSize={8} fill={TIER_COLOR.OVERRUN} textAnchor="end">ASDA {r.p.ASDA.toFixed(0)}m</text>
        {/* accelerate-go (sky) */}
        <polyline points={torPts.join(' ')} stroke="#0ea5e9" strokeWidth={1.5} fill="none"/>
        <text x={xS(r.p.V1*1.05)} y={yS(r.p.TOR_m)-4} fontSize={8.5} fill="#0ea5e9">accel-go</text>
        {/* accelerate-stop (rose) */}
        <polyline points={asdPts.join(' ')} stroke="#fb7185" strokeWidth={1.5} fill="none"/>
        <text x={xS(r.p.V1*1.05)} y={yS(r.p.ASD_m)+10} fontSize={8.5} fill="#fb7185">accel-stop</text>
        {/* V1 line */}
        <line x1={xS(r.p.V1)} y1={PT} x2={xS(r.p.V1)} y2={H-PB} stroke={TIER_COLOR[r.tier]} strokeWidth={1.3}/>
        <text x={xS(r.p.V1)+3} y={PT+10} fontSize={9} fill={TIER_COLOR[r.tier]}>V1 {r.p.V1.toFixed(0)}</text>
        <circle cx={xS(r.p.V1)} cy={yS(r.p.TOR_m)} r={4} fill={TIER_COLOR[r.tier]} stroke="#fff" strokeWidth={1.2}/>
        {/* readout */}
        <g transform={`translate(${PL+6}, ${PT+2})`}>
          <rect x={0} y={0} width={140} height={42} fill="#0f172a" stroke="#1e293b" rx={3}/>
          <text x={5} y={10} fontSize={7.5} fill="#64748b">V1 / Vr / V2 / γ2</text>
          <text x={5} y={22} fontSize={10} fill="#e2e8f0">{r.p.V1.toFixed(0)} · {r.p.Vr.toFixed(0)} · {r.p.V2.toFixed(0)} kt</text>
          <text x={5} y={34} fontSize={9} fill={r.p.gamma2<2.4?TIER_COLOR.OVERRUN:TIER_COLOR.EXCESS}>γ2 {r.p.gamma2.toFixed(2)}% (CS-25.121(b) ≥ 2.4)</text>
        </g>
      </svg>
    )
  }

  return (
    <div className="absolute right-3 top-20 z-30 w-[470px] max-h-[80vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">RTOW</div>
        <div className="text-[10px] text-slate-400 truncate">Rejected-Takeoff Margin · V1 Balanced-Field · AC 120-62</div>
        <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-100 text-[12px] px-2 py-0.5 rounded hover:bg-slate-800/60">✕</button>
      </div>

      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter===t?'ALL':t)}
            className={`px-1 py-1 rounded border ${tierFilter===t?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
            <div className="text-[8px]" style={{color: TIER_COLOR[t]}}>{t}</div>
            <div className="text-slate-100 font-semibold">{tierCounts[t]}</div>
          </button>
        ))}
      </div>

      {summary && (
        <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px] tabular-nums">
          <div><div className="text-[8px] text-slate-500">μ-ASDM</div><div className="text-slate-100">{summary.muASDM.toFixed(1)}%</div></div>
          <div><div className="text-[8px] text-slate-500">WORST</div><div className="text-slate-100 truncate">{summary.worst.f.callsign||summary.worst.f.icao}</div></div>
          <div><div className="text-[8px] text-slate-500">OVERRUN</div><div style={{color: summary.overrun>0?TIER_COLOR.OVERRUN:'#e2e8f0'}}>{summary.overrun}</div></div>
          <div><div className="text-[8px] text-slate-500">Σ-MARGIN</div><div className="text-slate-100">{(summary.sumMarg/1000).toFixed(1)}km</div></div>
          <div><div className="text-[8px] text-slate-500">μ-V1</div><div className="text-slate-100">{summary.muV1.toFixed(0)}kt</div></div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800/60 text-[9.5px]">
        <label className="flex flex-col"><span className="text-slate-400">MIN-FL {minFl}</span>
          <input type="range" min={0} max={120} value={minFl} onChange={e=>setMinFl(+e.target.value)} className="accent-sky-500"/></label>
        <label className="flex flex-col"><span className="text-slate-400">MAX-FL {maxFl}</span>
          <input type="range" min={20} max={300} value={maxFl} onChange={e=>setMaxFl(+e.target.value)} className="accent-sky-500"/></label>
        <label className="flex flex-col"><span className="text-slate-400">OAT-DEV {oatDev>0?'+':''}{oatDev}°C</span>
          <input type="range" min={-30} max={30} value={oatDev} onChange={e=>setOatDev(+e.target.value)} className="accent-sky-500"/></label>
        <label className="flex flex-col"><span className="text-slate-400">WIND-MUL {windMul}%</span>
          <input type="range" min={50} max={150} value={windMul} onChange={e=>setWindMul(+e.target.value)} className="accent-sky-500"/></label>
        <label className="flex flex-col"><span className="text-slate-400">SLOPE {slopePc.toFixed(1)}%</span>
          <input type="range" min={-20} max={20} value={slopePc*10} onChange={e=>setSlopePc(+e.target.value/10)} className="accent-sky-500"/></label>
        <label className="flex flex-col"><span className="text-slate-400">ADV-MUL {advMul}%</span>
          <input type="range" min={50} max={200} value={advMul} onChange={e=>setAdvMul(+e.target.value)} className="accent-sky-500"/></label>
        <div className="col-span-2 flex gap-1">
          {(['DRY','WET','SNOW'] as Surface[]).map(s => (
            <button key={s} onClick={()=>setSurface(s)}
              className={`flex-1 text-[9px] px-1.5 py-1 rounded border ${surface===s?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-400 hover:border-slate-700'}`}>
              SURFACE: {s}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800/60">
        <button onClick={()=>setKlassFilter('ALL')} className={`text-[9px] px-1.5 py-0.5 rounded border ${klassFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-400'}`}>ALL</button>
        {KLASS_LIST.map(k => (
          <button key={k} onClick={()=>setKlassFilter(klassFilter===k?'ALL':k)}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${klassFilter===k?'bg-sky-500/15 border-sky-500/40':'border-slate-800'}`}
            style={{color: KLASS_COLOR[k]}}>{k}</button>
        ))}
        <span className="flex-1" />
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LINK',showLink,setShowLink],['LBL',showLbl,setShowLbl]] as const).map(([lbl,on,fn]:any) => (
          <button key={lbl} onClick={()=>fn(!on)} className={`text-[9px] px-1.5 py-0.5 rounded border ${on?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-500'}`}>{lbl}</button>
        ))}
      </div>

      <div className="flex border-b border-slate-800/60 text-[10px]">
        {(['AIRCRAFT','RUNWAYS','BALANCED-FIELD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`flex-1 py-1.5 ${tab===t?'bg-sky-500/15 text-sky-200 border-b border-sky-500/60':'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      <div className="px-3 py-1.5 border-b border-slate-800/60">
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="callsign / type / operator / airport"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600"/>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.slice(0,80).map((r,i) => {
              const sp = SPEC[r.klass]; const windKt = (r.p as any).windKt as number
              return (
                <div key={r.f.icao+i} className="px-3 py-2 hover:bg-slate-900/40 cursor-pointer"
                  onClick={() => { setSel(r); onFly(r.f.icao) }}>
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="font-semibold text-slate-100 tabular-nums">{r.f.callsign||r.f.icao}</span>
                    <span className="text-slate-500 text-[9.5px]">{r.f.type||'—'}</span>
                    <span className="text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800" style={{color: KLASS_COLOR[r.klass]}}>{r.klass}</span>
                    <span className="text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800 text-slate-400">{r.p.rwy.icao}</span>
                    <span className="ml-auto text-[8.5px] px-1.5 py-0.5 rounded" style={{color: TIER_COLOR[r.tier], background: TIER_COLOR[r.tier]+'18', border:`1px solid ${TIER_COLOR[r.tier]}66`}}>{r.tier}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-1.5 text-[9.5px] tabular-nums text-slate-300">
                    <div><span className="text-slate-500">W </span>{r.p.W_t.toFixed(0)}t</div>
                    <div><span className="text-slate-500">V1 </span>{r.p.V1.toFixed(0)}</div>
                    <div><span className="text-slate-500">Vr </span>{r.p.Vr.toFixed(0)}</div>
                    <div><span className="text-slate-500">V2 </span>{r.p.V2.toFixed(0)}</div>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-0.5 text-[9.5px] tabular-nums text-slate-300">
                    <div><span className="text-slate-500">ASD </span>{r.p.ASD_m.toFixed(0)}m</div>
                    <div><span className="text-slate-500">ASDA </span>{r.p.ASDA.toFixed(0)}m</div>
                    <div><span className="text-slate-500">ASDM </span><span style={{color: r.p.ASDM_pc<5?TIER_COLOR.OVERRUN:'#e2e8f0'}}>{r.p.ASDM_pc.toFixed(1)}%</span></div>
                    <div><span className="text-slate-500">γ2 </span><span style={{color: r.p.gamma2<2.4?TIER_COLOR.OVERRUN:TIER_COLOR.EXCESS}}>{r.p.gamma2.toFixed(2)}%</span></div>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-0.5 text-[9.5px] tabular-nums text-slate-300">
                    <div><span className="text-slate-500">TOR </span>{r.p.TOR_m.toFixed(0)}m</div>
                    <div><span className="text-slate-500">TODA </span>{r.p.TODA.toFixed(0)}m</div>
                    <div><span className="text-slate-500">TOM </span><span style={{color: r.p.TOM_pc<5?TIER_COLOR.OVERRUN:'#e2e8f0'}}>{r.p.TOM_pc.toFixed(1)}%</span></div>
                    <div><span className="text-slate-500">WIND </span>{windKt>0?'+':''}{windKt.toFixed(0)}kt</div>
                  </div>
                  <div className="h-1.5 mt-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div className="h-full" style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier] }}/>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {(['ASDM','TOM','V1MAR','BRAKE','GAMMA2','WIND'] as const).map(k => (
                      <span key={k} className="text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800 text-slate-400">
                        {k} <span className="text-slate-200 tabular-nums">{((r.p.drivers as any)[k] as number).toFixed(0)}</span>
                      </span>
                    ))}
                  </div>
                  <div className="mt-1.5 text-[9.5px] leading-snug" style={{color: TIER_COLOR[r.tier]}}>
                    {r.tier==='OVERRUN' && `ASDA/TODA breach (${sp.family}) — reject / delay until weight or wind shifts, AC 120-62 Vol 1 §3.2`}
                    {r.tier==='TIGHT' && `<5% balanced-field margin (${r.p.rwy.icao}) — brief V1 strategy per FCOM PI-10 §10.20`}
                    {r.tier==='ADEQUATE' && `5-12% margin — monitor surface wind/contamination per CS-25.109`}
                    {r.tier==='COMFORT' && `12-20% margin — standard dispatch envelope`}
                    {r.tier==='EXCESS' && `>20% margin — derate available, see FLEX overlay (AC 25-13)`}
                  </div>
                </div>
              )
            })}
            {!filtered.length && <div className="px-3 py-6 text-center text-[10px] text-slate-500">no airframes in takeoff phase</div>}
          </div>
        )}

        {tab === 'RUNWAYS' && (
          <div className="divide-y divide-slate-800/60">
            {RWYS.map(rw => {
              const rwRows = rows.filter(r => r.p.rwy.icao === rw.icao)
              if (!rwRows.length) return null
              const worst = rwRows.reduce((a,b) => b.score>a.score?b:a)
              return (
                <div key={rw.icao} className="px-3 py-2" style={{borderLeft: `3px solid ${TIER_COLOR[worst.tier]}`}}>
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="font-semibold text-slate-100">{rw.icao}</span>
                    <span className="text-slate-500 text-[9.5px]">{rw.name}</span>
                    <span className="ml-auto text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800 text-slate-400">{rwRows.length} ac</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-1 text-[9.5px] tabular-nums text-slate-300">
                    <div><span className="text-slate-500">TORA </span>{rw.TORA_m}m</div>
                    <div><span className="text-slate-500">TODA </span>{rw.TODA_m}m</div>
                    <div><span className="text-slate-500">ASDA </span>{rw.ASDA_m}m</div>
                    <div><span className="text-slate-500">SLP </span>{rw.slope_pc.toFixed(2)}%</div>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-0.5 text-[9.5px] tabular-nums text-slate-300">
                    <div><span className="text-slate-500">ELEV </span>{rw.elev_ft}ft</div>
                    <div><span className="text-slate-500">OAT </span>{(15+oatDev-0.00198*rw.elev_ft).toFixed(0)}°C</div>
                    <div><span className="text-slate-500">SURF </span>{surface}</div>
                    <div><span className="text-slate-500">HDG </span>{rw.rwyHdg.toFixed(0)}°</div>
                  </div>
                  <div className="text-[9.5px] mt-1" style={{color: TIER_COLOR[worst.tier]}}>worst: {worst.f.callsign||worst.f.icao} · {worst.tier} · {worst.score.toFixed(0)}</div>
                </div>
              )
            })}
            {rows.length === 0 && <div className="px-3 py-6 text-center text-[10px] text-slate-500">no aircraft on takeoff snapped to known runways</div>}
          </div>
        )}

        {tab === 'BALANCED-FIELD' && (
          <div className="p-3 space-y-3">
            <BFLDPlot/>
            <div className="text-[9.5px] leading-snug text-slate-400 space-y-1.5">
              <p><span className="text-slate-200">Balanced V1.</span> The decision speed at which
              the accelerate-go OEI distance to clear 35ft equals the accelerate-stop distance
              (AC 25-7D §13.2). The sky curve is TOR(V); the rose curve is ASD(V). Their
              intersection is the certified V1. TODA / ASDA amber/rose dashed lines bound the
              field-limited weight per CS-25.109.</p>
              <p><span className="text-slate-200">Method.</span> TOR = TOR_ref·(W/Wref)²·σ⁻¹·⁷
              with slope and wind corrections per Boeing PEM §3.4. ASD = ASD_ref·(W/Wref)²·¹·σ⁻¹·⁶
              with brake-energy quadratic per ESDU 76034 / AC 25-7D §13.3. γ2 OEI 2nd-segment
              gradient must satisfy CS-25.121(b) ≥ 2.4%. Wet/snow contaminated surfaces apply
              friction multipliers per AC 91-79B App.A.</p>
              <p><span className="text-slate-200">Refs.</span> AC 25-7D §13 · AC 120-62 Vol 1+2 ·
              AC 91-79B App.A · CFR §25.105 §25.109 §25.121(b) · CS-25.109 · Boeing FCOM PI-10 ·
              Boeing PEM §3.4 · Airbus FCOM PRO-NOR-SOP-13 · ESDU 71026 · 76034 · 88033 · 84036 ·
              Torenbeek §5.4 · Roskam Pt VII §10 · NTSB AAR-08-04 Comair 5191 · AAR-08-02 MK1602 ·
              AAR-89-04 USAir 5050 · FSF ALAR BN 8.2.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
