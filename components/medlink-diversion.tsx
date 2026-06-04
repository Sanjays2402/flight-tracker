'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   MEDLINK · In-Flight Medical Diversion & Trauma-Center Advisor
   ------------------------------------------------------------
   Per-airframe scorer for airborne traffic evaluating the
   suitability of nearby diversion airports as a medical-emergency
   landing site, combining:

     - Airport runway-length / category (B763 minimum 2400m)
     - Distance-to-hospital ground-leg with EMS response curve
     - Hospital ACS verified-trauma-center level (I/II/III)
     - Helipad availability + 24/7 ED + cardiac cath-lab / stroke-
       certified (TJC / DNV Comprehensive Stroke Center)
     - MedAire MEDLINK / STAT-MD / GlobaLifeline coverage region

   Built around MedAire / STAT-MD / Lufthansa Medical Operations
   ground-physician escalation framework:

     CARDIAC-ARREST / STROKE       → DIVERT-IMMEDIATE (rose)
     CARDIAC-CHEST / ANAPHYLAXIS   → DIVERT-CONSIDER (rose-pink)
     SEIZURE / OB-LABOR            → DIVERT-MONITOR (amber)
     SYNCOPE / GI / OTHER          → CONTINUE-MONITOR (sky)

   References:
     ICAO Annex 6 Pt I §6.2.2 medical supplies on board
     ICAO Doc 8984 Manual of Civil Aviation Medicine ch.2 §2.6 in-flight
     ICAO Annex 9 Ch.8 §8.16 public-health emergency landing
     FAA AC 121-33B Emergency Medical Equipment
     FAA 14 CFR §121.803 EMK / §121.805 AED
     FAA Order JO 7110.65 §10-2 Aircraft Emergencies — medical
     FAA Order 8900.1 Vol 3 Ch 33 § 5 medical kit oversight
     EASA AMC1 CAT.IDE.A.220 medical kit / AED
     EASA AMC1 CAT.GEN.MPA.155 in-flight emergency procedures
     EASA SIB 2018-04 IFR diversion airport selection
     IATA Medical Manual ed.13 ch.4 in-flight assistance / ch.5 diversion
     IATA Cabin Crew Medical Aspects of Flight Operations ed.4
     UK CAA CAP 757 Annex C medical incapacitation
     CAP 666 Air Traffic Services emergency / urgency
     ACS Resources for Optimal Care of the Injured Patient (Orange Book) 2022
       — verified Level-I / II / III trauma center criteria
     TJC Comprehensive Stroke Center certification (2024)
     ACC/AHA STEMI Guidelines — door-to-balloon ≤90min
     AHA Acute Stroke Guidelines — door-to-needle ≤45min, LVO IA ≤6hr
     MedAire MedLink Global Response Center service spec rev.12
     STAT-MD University of Pittsburgh telemedicine protocols 2023
     GlobaLifeline / Aerocare Atlanta ground-medical service guides
     Lufthansa Medical Operations FRA OCC SOP 4.2 in-flight
     NTSB SR-95-01 Cabin Safety Compendium (medical)
     NEJM 2013;368:2075 In-Flight Medical Emergencies (Peterson et al)
     JAMA 2018;320:2580 In-Flight Medical Emergencies on Commercial Air Travel
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  emergency?: string; squawk?: string
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'DIVERT-IMM' | 'DIVERT-CONS' | 'DIVERT-MON' | 'CONTINUE' | 'WATCH' | 'NOMINAL' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'DIVERT-IMM': '#ef4444', 'DIVERT-CONS': '#f43f5e', 'DIVERT-MON': '#f59e0b',
  CONTINUE: '#0ea5e9', WATCH: '#0ea5e9', NOMINAL: '#10b981', IDLE: '#64748b',
}
const TIER_RANK: Record<Tier, number> = { 'DIVERT-IMM': 0, 'DIVERT-CONS': 1, 'DIVERT-MON': 2, CONTINUE: 3, WATCH: 4, NOMINAL: 5, IDLE: 6 }

type Etiology = 'CARDIAC-ARREST' | 'STROKE' | 'CARDIAC-CHEST' | 'ANAPHYLAXIS' | 'RESP-FAILURE' | 'SEIZURE' | 'OB-LABOR' | 'SYNCOPE' | 'GI' | 'TRAUMA' | 'OTHER'
const ETIO_SEV: Record<Etiology, number> = {
  'CARDIAC-ARREST': 100, STROKE: 96, 'CARDIAC-CHEST': 86, ANAPHYLAXIS: 82,
  'RESP-FAILURE': 78, SEIZURE: 62, 'OB-LABOR': 60, TRAUMA: 70, SYNCOPE: 36, GI: 22, OTHER: 18,
}
const ETIO_NEED: Record<Etiology, { trauma?: 1|2|3; cath?: boolean; stroke?: boolean; ob?: boolean }> = {
  'CARDIAC-ARREST': { cath: true, trauma: 2 }, STROKE: { stroke: true, trauma: 2 },
  'CARDIAC-CHEST': { cath: true }, ANAPHYLAXIS: { trauma: 3 }, 'RESP-FAILURE': { trauma: 2 },
  SEIZURE: { trauma: 3 }, 'OB-LABOR': { ob: true }, TRAUMA: { trauma: 1 },
  SYNCOPE: {}, GI: {}, OTHER: {},
}

type ServiceRegion = 'MedAire-AZ' | 'STAT-MD-PIT' | 'GlobaLifeline-ATL' | 'LH-MedOps-FRA' | 'CMC-Sydney' | 'AeroCare-DEL' | 'JAL-DOCONE-TYO'
const REGION_COLOR: Record<ServiceRegion, string> = {
  'MedAire-AZ': '#0ea5e9', 'STAT-MD-PIT': '#a855f7', 'GlobaLifeline-ATL': '#10b981',
  'LH-MedOps-FRA': '#f59e0b', 'CMC-Sydney': '#06b6d4', 'AeroCare-DEL': '#f43f5e', 'JAL-DOCONE-TYO': '#ec4899',
}

interface Hospital {
  id: string; name: string; lat: number; lng: number;
  trauma: 1 | 2 | 3 | 0;            // ACS verification level (0 = ED only)
  cath: boolean; stroke: boolean; ob: boolean;
  helipad: boolean; ed24: boolean;
  service: ServiceRegion;
  city: string; country: string;
}

interface Airport {
  icao: string; name: string; lat: number; lng: number;
  rwyLenM: number; cat: 4|5|6|7|8|9|10;
  region: ServiceRegion;
  hospitals: string[];           // ids of nearby hospitals
}

// 16-hospital + 22-airport global catalogue (Level I trauma centers w/ helipad + cath + stroke)
const HOSPITALS: Hospital[] = [
  { id:'NYP-WCM',  name:'NewYork-Presbyterian / Weill Cornell',           lat:40.7649, lng:-73.9540, trauma:1, cath:true, stroke:true, ob:true,  helipad:true, ed24:true, service:'MedAire-AZ', city:'New York', country:'USA' },
  { id:'MGH-BOS',  name:'Massachusetts General Hospital',                  lat:42.3633, lng:-71.0686, trauma:1, cath:true, stroke:true, ob:true,  helipad:true, ed24:true, service:'MedAire-AZ', city:'Boston',  country:'USA' },
  { id:'JHH-BAL',  name:'Johns Hopkins Hospital',                          lat:39.2965, lng:-76.5928, trauma:1, cath:true, stroke:true, ob:true,  helipad:true, ed24:true, service:'STAT-MD-PIT', city:'Baltimore', country:'USA' },
  { id:'EMORY-ATL',name:'Emory University Hospital Midtown',               lat:33.7733, lng:-84.3868, trauma:1, cath:true, stroke:true, ob:true,  helipad:true, ed24:true, service:'GlobaLifeline-ATL', city:'Atlanta', country:'USA' },
  { id:'PMHM-MIA', name:'Jackson Memorial Hospital / Ryder Trauma',        lat:25.7886, lng:-80.2092, trauma:1, cath:true, stroke:true, ob:true,  helipad:true, ed24:true, service:'MedAire-AZ', city:'Miami', country:'USA' },
  { id:'NWMH-CHI', name:'Northwestern Memorial Hospital',                  lat:41.8945, lng:-87.6206, trauma:1, cath:true, stroke:true, ob:true,  helipad:true, ed24:true, service:'STAT-MD-PIT', city:'Chicago', country:'USA' },
  { id:'BWMC-DAL', name:'Parkland Memorial / Baylor Univ Med Ctr',         lat:32.8120, lng:-96.8389, trauma:1, cath:true, stroke:true, ob:true,  helipad:true, ed24:true, service:'GlobaLifeline-ATL', city:'Dallas', country:'USA' },
  { id:'BNH-PHX',  name:'Banner – University Medical Center Phoenix',      lat:33.4779, lng:-112.0729,trauma:1, cath:true, stroke:true, ob:true,  helipad:true, ed24:true, service:'MedAire-AZ', city:'Phoenix', country:'USA' },
  { id:'HMC-SEA',  name:'Harborview Medical Center',                       lat:47.6038, lng:-122.3220,trauma:1, cath:true, stroke:true, ob:true,  helipad:true, ed24:true, service:'STAT-MD-PIT', city:'Seattle', country:'USA' },
  { id:'UCLA-LA',  name:'Ronald Reagan UCLA Medical Center',               lat:34.0664, lng:-118.4456,trauma:1, cath:true, stroke:true, ob:true,  helipad:true, ed24:true, service:'MedAire-AZ', city:'Los Angeles', country:'USA' },
  { id:'STM-LON',  name:"St Mary's Hospital London (Major Trauma Ctr)",    lat:51.5169, lng:-0.1739,  trauma:1, cath:true, stroke:true, ob:true,  helipad:true, ed24:true, service:'LH-MedOps-FRA', city:'London', country:'UK' },
  { id:'CHU-LFPG', name:'CHU Bichat / GHU AP-HP Nord',                     lat:48.8989, lng:2.3322,   trauma:1, cath:true, stroke:true, ob:true,  helipad:true, ed24:true, service:'LH-MedOps-FRA', city:'Paris', country:'France' },
  { id:'UKF-FRA',  name:'Universitätsklinikum Frankfurt',                  lat:50.0926, lng:8.6520,   trauma:1, cath:true, stroke:true, ob:true,  helipad:true, ed24:true, service:'LH-MedOps-FRA', city:'Frankfurt', country:'Germany' },
  { id:'AMC-AMS',  name:'Amsterdam UMC – AMC',                             lat:52.2933, lng:4.9577,   trauma:1, cath:true, stroke:true, ob:true,  helipad:true, ed24:true, service:'LH-MedOps-FRA', city:'Amsterdam', country:'Netherlands' },
  { id:'RPA-SYD',  name:'Royal Prince Alfred Hospital',                    lat:-33.8896,lng:151.1830, trauma:1, cath:true, stroke:true, ob:true,  helipad:true, ed24:true, service:'CMC-Sydney', city:'Sydney', country:'Australia' },
  { id:'TMG-TYO',  name:'Tokyo Medical Univ Hosp (DOCONE)',                lat:35.6900, lng:139.6928, trauma:1, cath:true, stroke:true, ob:true,  helipad:true, ed24:true, service:'JAL-DOCONE-TYO', city:'Tokyo', country:'Japan' },
  { id:'AIIMS-DEL',name:'AIIMS New Delhi (JPNATC)',                        lat:28.5664, lng:77.2090,  trauma:1, cath:true, stroke:true, ob:true,  helipad:true, ed24:true, service:'AeroCare-DEL', city:'New Delhi', country:'India' },
  { id:'RH-DXB',   name:'Rashid Hospital Trauma Center',                   lat:25.2371, lng:55.3265,  trauma:1, cath:true, stroke:true, ob:true,  helipad:true, ed24:true, service:'AeroCare-DEL', city:'Dubai', country:'UAE' },
  { id:'TTSH-SIN', name:'Tan Tock Seng / NCID',                            lat:1.3214,  lng:103.8463, trauma:1, cath:true, stroke:true, ob:true,  helipad:true, ed24:true, service:'CMC-Sydney', city:'Singapore', country:'Singapore' },
  { id:'QMH-HKG',  name:'Queen Mary Hospital',                             lat:22.2700, lng:114.1310, trauma:1, cath:true, stroke:true, ob:true,  helipad:true, ed24:true, service:'JAL-DOCONE-TYO', city:'Hong Kong', country:'HK' },
]

const AIRPORTS: Airport[] = [
  { icao:'KJFK', name:'John F. Kennedy Intl',     lat:40.6413, lng:-73.7781, rwyLenM:4423, cat:9,  region:'MedAire-AZ',        hospitals:['NYP-WCM'] },
  { icao:'KLGA', name:'LaGuardia',                lat:40.7769, lng:-73.8740, rwyLenM:2134, cat:7,  region:'MedAire-AZ',        hospitals:['NYP-WCM'] },
  { icao:'KEWR', name:'Newark Liberty Intl',      lat:40.6925, lng:-74.1687, rwyLenM:3353, cat:9,  region:'MedAire-AZ',        hospitals:['NYP-WCM'] },
  { icao:'KBOS', name:'Boston Logan Intl',        lat:42.3656, lng:-71.0096, rwyLenM:3073, cat:9,  region:'MedAire-AZ',        hospitals:['MGH-BOS'] },
  { icao:'KBWI', name:'Baltimore/Washington',     lat:39.1754, lng:-76.6683, rwyLenM:3204, cat:9,  region:'STAT-MD-PIT',       hospitals:['JHH-BAL'] },
  { icao:'KATL', name:'Hartsfield-Jackson ATL',   lat:33.6407, lng:-84.4277, rwyLenM:3776, cat:10, region:'GlobaLifeline-ATL', hospitals:['EMORY-ATL'] },
  { icao:'KMIA', name:'Miami Intl',               lat:25.7959, lng:-80.2870, rwyLenM:3962, cat:10, region:'MedAire-AZ',        hospitals:['PMHM-MIA'] },
  { icao:'KORD', name:"O'Hare Intl",              lat:41.9786, lng:-87.9048, rwyLenM:3962, cat:10, region:'STAT-MD-PIT',       hospitals:['NWMH-CHI'] },
  { icao:'KDFW', name:'Dallas/Fort Worth',        lat:32.8998, lng:-97.0403, rwyLenM:4085, cat:10, region:'GlobaLifeline-ATL', hospitals:['BWMC-DAL'] },
  { icao:'KPHX', name:'Phoenix Sky Harbor',       lat:33.4343, lng:-112.0116,rwyLenM:3502, cat:9,  region:'MedAire-AZ',        hospitals:['BNH-PHX'] },
  { icao:'KSEA', name:'Seattle-Tacoma',           lat:47.4502, lng:-122.3088,rwyLenM:3627, cat:10, region:'STAT-MD-PIT',       hospitals:['HMC-SEA'] },
  { icao:'KLAX', name:'Los Angeles Intl',         lat:33.9425, lng:-118.4081,rwyLenM:3685, cat:10, region:'MedAire-AZ',        hospitals:['UCLA-LA'] },
  { icao:'EGLL', name:'London Heathrow',          lat:51.4700, lng:-0.4543,  rwyLenM:3902, cat:10, region:'LH-MedOps-FRA',     hospitals:['STM-LON'] },
  { icao:'LFPG', name:'Paris Charles de Gaulle',  lat:49.0097, lng:2.5479,   rwyLenM:4215, cat:10, region:'LH-MedOps-FRA',     hospitals:['CHU-LFPG'] },
  { icao:'EDDF', name:'Frankfurt Main',           lat:50.0379, lng:8.5622,   rwyLenM:4000, cat:10, region:'LH-MedOps-FRA',     hospitals:['UKF-FRA'] },
  { icao:'EHAM', name:'Amsterdam Schiphol',       lat:52.3105, lng:4.7683,   rwyLenM:3800, cat:10, region:'LH-MedOps-FRA',     hospitals:['AMC-AMS'] },
  { icao:'YSSY', name:'Sydney Kingsford-Smith',   lat:-33.9399,lng:151.1753, rwyLenM:3962, cat:10, region:'CMC-Sydney',        hospitals:['RPA-SYD'] },
  { icao:'RJTT', name:'Tokyo Haneda',             lat:35.5494, lng:139.7798, rwyLenM:3360, cat:10, region:'JAL-DOCONE-TYO',    hospitals:['TMG-TYO'] },
  { icao:'VIDP', name:'Indira Gandhi Intl Delhi', lat:28.5562, lng:77.1000,  rwyLenM:4430, cat:10, region:'AeroCare-DEL',      hospitals:['AIIMS-DEL'] },
  { icao:'OMDB', name:'Dubai Intl',               lat:25.2532, lng:55.3657,  rwyLenM:4000, cat:10, region:'AeroCare-DEL',      hospitals:['RH-DXB'] },
  { icao:'WSSS', name:'Singapore Changi',         lat:1.3644,  lng:103.9915, rwyLenM:4000, cat:10, region:'CMC-Sydney',        hospitals:['TTSH-SIN'] },
  { icao:'VHHH', name:'Hong Kong Intl',           lat:22.3080, lng:113.9185, rwyLenM:3800, cat:10, region:'JAL-DOCONE-TYO',    hospitals:['QMH-HKG'] },
]

const NM_PER_DEG_LAT = 60
function nmPerDegLng(lat: number) { return 60 * Math.cos(lat * Math.PI / 180) }
function distNm(aLat:number,aLng:number,bLat:number,bLng:number){const dy=(aLat-bLat)*NM_PER_DEG_LAT;const dx=(aLng-bLng)*nmPerDegLng((aLat+bLat)/2);return Math.hypot(dx,dy)}
function bearingDeg(aLat:number,aLng:number,bLat:number,bLng:number){const dy=(bLat-aLat)*NM_PER_DEG_LAT;const dx=(bLng-aLng)*nmPerDegLng((aLat+bLat)/2);let b=Math.atan2(dx,dy)*180/Math.PI;if(b<0)b+=360;return b}
function nmToKm(nm:number){return nm*1.852}

// deterministic etiology per ICAO24
function pickEtiology(icao:string, baseSelected: Etiology | 'AUTO'): Etiology {
  if (baseSelected !== 'AUTO') return baseSelected
  // NEJM 2013 distribution (Peterson) approximate
  const buckets: [Etiology, number][] = [
    ['SYNCOPE', 0.37], ['RESP-FAILURE', 0.12], ['CARDIAC-CHEST', 0.07], ['GI', 0.09],
    ['SEIZURE', 0.06], ['ANAPHYLAXIS', 0.03], ['STROKE', 0.02], ['CARDIAC-ARREST', 0.012],
    ['OB-LABOR', 0.005], ['TRAUMA', 0.05], ['OTHER', 0.193],
  ]
  let h = 0; for (let i=0;i<icao.length;i++) h = (h*31 + icao.charCodeAt(i)) >>> 0
  const r = (h % 10000) / 10000
  let c = 0; for (const [k,p] of buckets) { c += p; if (r < c) return k }
  return 'OTHER'
}

// time-to-airport in minutes given groundspeed + descent
function timeToFieldMin(distNmV:number, gsKt:number, altFt:number) {
  const cruiseMin = (distNmV / Math.max(180, gsKt)) * 60
  // descent: 3deg ≈ 3nm per 1000ft + decel ≈ 5min
  const descMin = (altFt / 1000) * 3 / Math.max(180, gsKt) * 60 + 5
  return cruiseMin + descMin
}

// EMS ground-transit minutes (urban 35 mph, rural 50 mph) per US EMS literature
function emsGroundMin(distNmHosp:number) {
  const km = nmToKm(distNmHosp)
  const speedKmh = km < 20 ? 45 : 65
  return (km / speedKmh) * 60 + 4 // 4min load
}

// match-quality: does the hospital actually meet etiology need?
function hospitalFit(etio: Etiology, h: Hospital): { fit: number; missing: string[] } {
  const need = ETIO_NEED[etio]
  const missing: string[] = []
  let fit = 100
  if (need.cath && !h.cath) { fit -= 35; missing.push('cath-lab') }
  if (need.stroke && !h.stroke) { fit -= 35; missing.push('stroke-ctr') }
  if (need.ob && !h.ob) { fit -= 25; missing.push('OB') }
  if (need.trauma && (h.trauma === 0 || h.trauma > need.trauma)) {
    fit -= 20; missing.push(`Lvl-${need.trauma}`)
  }
  if (!h.helipad) { fit -= 8; missing.push('helipad') }
  if (!h.ed24) { fit -= 20; missing.push('24/7-ED') }
  return { fit: Math.max(0, fit), missing }
}

interface Pick {
  apt: Airport; hosp: Hospital; distApNm: number; distHospNm: number;
  ttf: number; ttHosp: number; ttDef: number; // mins
  fit: number; missing: string[]
  rwyOk: boolean
}

interface RowR {
  f: SFlight; etio: Etiology; sev: number
  best: Pick | null; alts: Pick[]
  drivers: { TTH: number; FIT: number; RWY: number; EMS: number; ETO: number; REG: number }
  score: number; tier: Tier; advice: string
}

// runway requirement by aircraft category (A0-A7 ADS-B emitter cat)
function rwyMinM(cat?: string): number {
  switch (cat) {
    case 'A5': case 'A4': return 2700 // heavy / large
    case 'A3': return 2200
    case 'A2': return 1800
    default: return 1500
  }
}

const SCOPE_DEFAULT = 220
const HORIZON_DEFAULT = 60

export default function MedlinkDiversion({ map, flights, onClose, onFly }: Props) {
  const [scopeNm, setScopeNm]   = useState(SCOPE_DEFAULT)
  const [horizonMin, setHorMin] = useState(HORIZON_DEFAULT)
  const [advMul, setAdvMul]     = useState(100)
  const [etiOverride, setEtiOverride] = useState<Etiology | 'AUTO'>('AUTO')
  const [tab, setTab] = useState<'AC' | 'APT' | 'HOSP'>('AC')
  const [search, setSearch] = useState('')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [tHalo, setTHalo] = useState(true)
  const [tApt, setTApt] = useState(true)
  const [tLink, setTLink] = useState(true)
  const [tLbl, setTLbl] = useState(true)

  // === scoring loop ===
  const rows: RowR[] = useMemo(() => {
    const list: RowR[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (f.altitudeFt < 3000) continue
      const etio = pickEtiology(f.icao, etiOverride)
      const sev = ETIO_SEV[etio]
      // forced override: squawk 7700 boosts severity
      const sevAdj = (f.emergency || f.squawk === '7700') ? Math.max(sev, 90) : sev
      const rwyMin = rwyMinM(f.category)
      const picks: Pick[] = []
      for (const a of AIRPORTS) {
        const d = distNm(f.lat, f.lng, a.lat, a.lng)
        if (d > scopeNm) continue
        const ttf = timeToFieldMin(d, f.velocityKts || 420, f.altitudeFt)
        for (const hid of a.hospitals) {
          const h = HOSPITALS.find(x => x.id === hid); if (!h) continue
          const dh = distNm(a.lat, a.lng, h.lat, h.lng)
          const ttg = emsGroundMin(dh)
          const fit = hospitalFit(etio, h)
          const rwyOk = a.rwyLenM >= rwyMin
          const ttDef = ttf + ttg + 6 // 6min taxi
          picks.push({ apt:a, hosp:h, distApNm:d, distHospNm:dh, ttf, ttHosp:ttg, ttDef, fit:fit.fit, missing:fit.missing, rwyOk })
        }
      }
      // sort by composite: ttDef weighted by fit + runway
      picks.sort((x,y) => {
        const px = (x.rwyOk?0:1)*1000 + x.ttDef * (1 + (100-x.fit)/100)
        const py = (y.rwyOk?0:1)*1000 + y.ttDef * (1 + (100-y.fit)/100)
        return px - py
      })
      const best = picks[0] || null

      // drivers
      const TTH = best ? Math.min(100, Math.max(0, (best.ttDef - 25) * 100 / 75)) : 100  // 25min→0  100min→100
      const FIT = best ? (100 - best.fit) : 100
      const RWY = best ? (best.rwyOk ? 0 : 92) : 100
      const EMS = best ? Math.min(100, best.ttHosp * 4) : 100
      const ETO = sevAdj
      const REG = best ? 0 : 70

      const drv = { TTH, FIT, RWY, EMS, ETO, REG }
      const vals = Object.values(drv)
      const mx = Math.max(...vals)
      const mn = vals.reduce((a,b)=>a+b,0) / vals.length
      let score = (mx * 0.62 + mn * 0.38) * (advMul/100) * (sevAdj/60)
      score = Math.min(100, Math.max(0, score))

      // tier
      let tier: Tier
      const critical = sevAdj >= 90
      if (critical && best && best.rwyOk && best.ttf < horizonMin) tier = 'DIVERT-IMM'
      else if (critical) tier = 'DIVERT-CONS'
      else if (sevAdj >= 75) tier = 'DIVERT-CONS'
      else if (sevAdj >= 55) tier = 'DIVERT-MON'
      else if (sevAdj >= 30) tier = 'CONTINUE'
      else if (score >= 18) tier = 'WATCH'
      else tier = 'NOMINAL'

      const advice =
        tier === 'DIVERT-IMM'  ? `DIVERT NOW to ${best?.apt.icao} → ${best?.hosp.name.split(' ').slice(0,3).join(' ')} · ETA ${best?.ttDef.toFixed(0)}min · MedLink relay per IATA Med Manual §5`
      : tier === 'DIVERT-CONS' ? `Consult MedAire / STAT-MD · prepare divert ${best?.apt.icao} · door-to-care ${best?.ttDef.toFixed(0)}min`
      : tier === 'DIVERT-MON'  ? `Move pax to crew rest, monitor vitals · ${best?.apt.icao} ${best?.ttf.toFixed(0)}min away · AED ready per 14 CFR §121.805`
      : tier === 'CONTINUE'    ? `Continue · cabin-crew protocol per AC 121-33B · nearest ${best?.apt.icao} ${best?.ttf.toFixed(0)}min`
      : tier === 'WATCH'       ? `Monitor · note diversion ${best?.apt.icao}`
      : 'Nominal · no medical action'

      list.push({ f, etio, sev:sevAdj, best, alts: picks.slice(1, 4), drivers: drv, score, tier, advice })
    }
    // filter & sort
    let f = list
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      f = f.filter(r => (r.f.callsign||'').toLowerCase().includes(q) || (r.f.icao||'').toLowerCase().includes(q) || (r.best?.apt.icao||'').toLowerCase().includes(q) || (r.best?.hosp.name||'').toLowerCase().includes(q) || r.etio.toLowerCase().includes(q))
    }
    if (tierFilter !== 'ALL') f = f.filter(r => r.tier === tierFilter)
    f.sort((a,b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.score - a.score))
    return f
  }, [flights, scopeNm, horizonMin, advMul, etiOverride, search, tierFilter])

  // counters
  const counts = useMemo(() => {
    const c: Record<Tier, number> = { 'DIVERT-IMM':0,'DIVERT-CONS':0,'DIVERT-MON':0, CONTINUE:0, WATCH:0, NOMINAL:0, IDLE:0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  // === MapLibre overlay ===
  useEffect(() => {
    if (!map) return
    const SRC = 'medlink-src'
    const features: any[] = []

    if (tApt) {
      for (const a of AIRPORTS) {
        features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[a.lng, a.lat] }, properties:{ kind:'apt', label:a.icao, color: REGION_COLOR[a.region] } })
      }
      for (const h of HOSPITALS) {
        features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[h.lng, h.lat] }, properties:{ kind:'hosp', label:`${h.id}·L${h.trauma}`, color: REGION_COLOR[h.service] } })
      }
    }

    for (const r of rows) {
      const col = TIER_COLOR[r.tier]
      if (tHalo) {
        features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ kind:'halo', color:col, size: 8 + (r.score/100)*14 } })
      }
      if (r.tier === 'DIVERT-IMM' || r.tier === 'DIVERT-CONS') {
        features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ kind:'pin', label:r.tier, color:col } })
      }
      if (tLink && r.best) {
        features.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[[r.f.lng, r.f.lat],[r.best.apt.lng, r.best.apt.lat]] }, properties:{ kind:'link', color:col } })
        features.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[[r.best.apt.lng, r.best.apt.lat],[r.best.hosp.lng, r.best.hosp.lat]] }, properties:{ kind:'link2', color:col } })
      }
      if (tLbl && r.best) {
        features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ kind:'lbl', color:col, label:`${r.f.callsign||r.f.icao} → ${r.best.apt.icao} ${r.best.ttDef.toFixed(0)}m ${r.tier}` } })
      }
    }
    const data = { type:'FeatureCollection', features }

    const m = map as any
    const set = () => {
      const src = m.getSource(SRC) as any
      if (src) src.setData(data)
      else m.addSource(SRC, { type:'geojson', data })
      const layers: [string, any][] = [
        ['medlink-link',  { type:'line',   filter:['==',['get','kind'],'link'],   paint:{ 'line-color':['get','color'], 'line-width':1.4, 'line-dasharray':[2,2], 'line-opacity':0.7 } }],
        ['medlink-link2', { type:'line',   filter:['==',['get','kind'],'link2'],  paint:{ 'line-color':['get','color'], 'line-width':1.0, 'line-dasharray':[1,2], 'line-opacity':0.55 } }],
        ['medlink-halo',  { type:'circle', filter:['==',['get','kind'],'halo'],   paint:{ 'circle-radius':['get','size'], 'circle-color':['get','color'], 'circle-opacity':0.15, 'circle-stroke-width':1.2, 'circle-stroke-color':['get','color'], 'circle-stroke-opacity':0.7 } }],
        ['medlink-apt',   { type:'circle', filter:['==',['get','kind'],'apt'],    paint:{ 'circle-radius':5, 'circle-color':['get','color'], 'circle-opacity':0.5, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.2 } }],
        ['medlink-hosp',  { type:'circle', filter:['==',['get','kind'],'hosp'],   paint:{ 'circle-radius':4, 'circle-color':'#fff', 'circle-opacity':0.85, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.6 } }],
        ['medlink-pin',   { type:'circle', filter:['==',['get','kind'],'pin'],    paint:{ 'circle-radius':6, 'circle-color':['get','color'], 'circle-opacity':0.85, 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1.2 } }],
        ['medlink-lbl',   { type:'symbol', filter:['==',['get','kind'],'lbl'],    layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Open Sans Regular','Arial Unicode MS Regular'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a', 'text-halo-width':1.2 } }],
      ]
      for (const [id, spec] of layers) {
        if (!m.getLayer(id)) m.addLayer({ id, source: SRC, ...spec })
      }
    }
    if (!m.loaded()) m.once('load', set); else set()

    return () => {
      const m2 = map as any
      for (const id of ['medlink-lbl','medlink-pin','medlink-hosp','medlink-apt','medlink-halo','medlink-link2','medlink-link']) {
        if (m2.getLayer(id)) m2.removeLayer(id)
      }
      if (m2.getSource(SRC)) m2.removeSource(SRC)
    }
  }, [map, rows, tHalo, tApt, tLink, tLbl])

  // === side panel ===
  const tiers: Tier[] = ['DIVERT-IMM','DIVERT-CONS','DIVERT-MON','CONTINUE','WATCH','NOMINAL']
  const mean = rows.length ? rows.reduce((a,r)=>a+r.score,0) / rows.length : 0
  const worst = rows[0]

  return (
    <div className="absolute top-[68px] right-3 z-30 w-[380px] max-h-[calc(100vh-88px)] overflow-hidden flex flex-col rounded-lg border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-200 text-[11px] shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div>
          <div className="text-slate-100 font-medium tracking-wide">MEDLINK · medical diversion advisor</div>
          <div className="text-[9px] text-slate-500 uppercase tracking-widest">MedAire / STAT-MD · ACS Level I/II · IATA Med ed.13</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 px-1">×</button>
      </div>

      {/* counters */}
      <div className="grid grid-cols-6 gap-1 px-2 pt-2">
        {tiers.map(t => (
          <button key={t} onClick={()=>setTierFilter(tierFilter===t?'ALL':t)} className={`rounded border px-1 py-1 text-center ${tierFilter===t?'bg-sky-500/15 border-sky-500/40':'border-slate-800'}`}>
            <div className="text-[8px] uppercase tracking-widest" style={{ color: TIER_COLOR[t] }}>{t.replace('DIVERT-','D-')}</div>
            <div className="text-[12px] tabular-nums" style={{ color: TIER_COLOR[t] }}>{counts[t]}</div>
          </button>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-1 px-2 pt-1">
        <div className="rounded border border-slate-800 px-2 py-1"><div className="text-[8px] uppercase tracking-widest text-slate-500">mean</div><div className="text-[12px] tabular-nums" style={{color: mean>50?TIER_COLOR['DIVERT-CONS']:mean>25?TIER_COLOR['DIVERT-MON']:TIER_COLOR.NOMINAL}}>{mean.toFixed(0)}</div></div>
        <div className="rounded border border-slate-800 px-2 py-1"><div className="text-[8px] uppercase tracking-widest text-slate-500">worst</div><div className="text-[10px] truncate" style={{color: worst?TIER_COLOR[worst.tier]:'#64748b'}}>{worst?worst.f.callsign||worst.f.icao:'—'}</div></div>
        <div className="rounded border border-slate-800 px-2 py-1"><div className="text-[8px] uppercase tracking-widest text-slate-500">IMM</div><div className="text-[12px] tabular-nums" style={{color: TIER_COLOR['DIVERT-IMM']}}>{counts['DIVERT-IMM']}</div></div>
      </div>

      {/* sliders */}
      <div className="px-2 pt-2 space-y-1">
        <Slider label="SCOPE" val={scopeNm} min={80} max={500} onChange={setScopeNm} unit="NM" />
        <Slider label="HORIZON" val={horizonMin} min={20} max={180} onChange={setHorMin} unit="min" />
        <Slider label="ADV-MUL" val={advMul} min={50} max={200} onChange={setAdvMul} unit="%" />
      </div>

      {/* etiology + toggles */}
      <div className="px-2 pt-2">
        <div className="text-[8px] uppercase tracking-widest text-slate-500 mb-1">etiology override</div>
        <div className="grid grid-cols-4 gap-1">
          {(['AUTO','CARDIAC-ARREST','STROKE','CARDIAC-CHEST','ANAPHYLAXIS','RESP-FAILURE','SEIZURE','OB-LABOR','TRAUMA','SYNCOPE','GI','OTHER'] as const).map(e=>(
            <button key={e} onClick={()=>setEtiOverride(e)} className={`text-[8px] px-1 py-1 rounded border truncate ${etiOverride===e?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-400'}`}>{e}</button>
          ))}
        </div>
        <div className="flex gap-1 mt-1">
          {([['HALO',tHalo,setTHalo],['APT',tApt,setTApt],['LINK',tLink,setTLink],['LBL',tLbl,setTLbl]] as const).map(([l,v,sf])=>(
            <button key={l} onClick={()=>sf(!v)} className={`text-[8px] px-2 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-500'}`}>{l}</button>
          ))}
        </div>
      </div>

      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search callsign / etio / airport / hospital" className="mx-2 mt-2 px-2 py-1 bg-slate-900 border border-slate-800 rounded text-[10px] text-slate-200 placeholder-slate-600" />

      {/* tabs */}
      <div className="flex gap-1 px-2 pt-2 pb-1 border-b border-slate-800">
        {(['AC','APT','HOSP'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`text-[9px] px-2 py-1 rounded uppercase tracking-widest ${tab===t?'bg-sky-500/15 text-slate-100 border border-sky-500/40':'text-slate-500 border border-transparent'}`}>{t==='AC'?'Aircraft':t==='APT'?'Airports':'Hospitals'}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2 pt-1 space-y-1">
        {tab === 'AC' && rows.slice(0, 60).map(r => (
          <div key={r.f.icao} onClick={()=>onFly(r.f.icao)} className="rounded border border-slate-800 px-2 py-1.5 hover:bg-slate-900 cursor-pointer" style={{ borderLeft:`3px solid ${TIER_COLOR[r.tier]}` }}>
            <div className="flex items-center justify-between gap-1">
              <div className="flex items-center gap-1 min-w-0">
                <span className="font-medium text-slate-100 truncate">{r.f.callsign || r.f.icao}</span>
                <span className="text-[8px] text-slate-500">{r.f.type || ''}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-[8px] px-1 py-0.5 rounded border" style={{ color:TIER_COLOR[r.tier], borderColor:TIER_COLOR[r.tier]+'66' }}>{r.tier}</span>
              </div>
            </div>
            <div className="text-[9px] text-slate-400 mt-0.5 flex items-center gap-1">
              <span className="px-1 rounded" style={{ color: ETIO_SEV[r.etio]>=80?TIER_COLOR['DIVERT-CONS']:ETIO_SEV[r.etio]>=50?TIER_COLOR['DIVERT-MON']:'#94a3b8', borderLeft:`2px solid ${ETIO_SEV[r.etio]>=80?TIER_COLOR['DIVERT-CONS']:'#475569'}` }}>{r.etio}</span>
              <span className="text-slate-600">sev</span>
              <span className="tabular-nums">{r.sev.toFixed(0)}</span>
              {(r.f.emergency || r.f.squawk==='7700') && <span className="text-rose-400 text-[9px]">!7700</span>}
            </div>
            {r.best ? (
              <div className="text-[9px] text-slate-300 mt-0.5">
                <span className="text-sky-400">{r.best.apt.icao}</span>
                <span className="text-slate-500"> ({r.best.apt.name.split(' ').slice(0,2).join(' ')}) </span>
                <span className={r.best.rwyOk?'text-emerald-400':'text-rose-400'}>{r.best.apt.rwyLenM}m</span>
                <span className="text-slate-500"> · </span>
                <span className="text-slate-300">{r.best.distApNm.toFixed(0)}NM</span>
                <span className="text-slate-500"> · </span>
                <span style={{ color: r.best.ttf<30?TIER_COLOR.NOMINAL:r.best.ttf<60?TIER_COLOR['DIVERT-MON']:TIER_COLOR['DIVERT-CONS'] }}>TTF {r.best.ttf.toFixed(0)}m</span>
              </div>
            ) : <div className="text-[9px] text-rose-400 mt-0.5">no airport in scope</div>}
            {r.best && (
              <div className="text-[9px] text-slate-400 mt-0.5">
                <span className="italic text-slate-300">{r.best.hosp.name.split(' ').slice(0,3).join(' ')}</span>
                <span className="text-slate-500"> · Lvl-{r.best.hosp.trauma}</span>
                {r.best.hosp.cath && <span className="text-emerald-400"> · cath</span>}
                {r.best.hosp.stroke && <span className="text-emerald-400"> · stroke</span>}
                {r.best.hosp.ob && <span className="text-emerald-400"> · OB</span>}
                <span className="text-slate-500"> · EMS {r.best.ttHosp.toFixed(0)}m</span>
                <span className="text-slate-500"> · door-to-care </span>
                <span style={{ color: r.best.ttDef<45?TIER_COLOR.NOMINAL:r.best.ttDef<75?TIER_COLOR['DIVERT-MON']:TIER_COLOR['DIVERT-CONS'] }}>{r.best.ttDef.toFixed(0)}m</span>
              </div>
            )}
            <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier] }} /></div>
            <div className="grid grid-cols-6 gap-1 mt-1">
              {(['TTH','FIT','RWY','EMS','ETO','REG'] as const).map(k=>(
                <div key={k} className="text-center">
                  <div className="text-[7px] text-slate-500 uppercase">{k}</div>
                  <div className="text-[8px] tabular-nums" style={{ color: r.drivers[k]>=80?TIER_COLOR['DIVERT-CONS']:r.drivers[k]>=50?TIER_COLOR['DIVERT-MON']:'#94a3b8' }}>{r.drivers[k].toFixed(0)}</div>
                </div>
              ))}
            </div>
            <div className="text-[9px] mt-1 italic" style={{ color: TIER_COLOR[r.tier] }}>{r.advice}</div>
            {r.best?.missing.length ? <div className="text-[8px] text-amber-400 mt-0.5">missing: {r.best.missing.join(', ')}</div> : null}
            {r.alts.length > 0 && (
              <div className="text-[8px] text-slate-500 mt-0.5">alt: {r.alts.map(a => `${a.apt.icao}/${a.ttDef.toFixed(0)}m`).join(' · ')}</div>
            )}
          </div>
        ))}

        {tab === 'APT' && AIRPORTS.map(a => {
          const inUse = rows.filter(r => r.best?.apt.icao === a.icao)
          const tierWorst = inUse.length ? [...inUse].sort((x,y)=>TIER_RANK[x.tier]-TIER_RANK[y.tier])[0].tier : 'IDLE'
          return (
            <div key={a.icao} className="rounded border border-slate-800 px-2 py-1.5" style={{ borderLeft:`3px solid ${TIER_COLOR[tierWorst]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sky-400 font-medium">{a.icao}</span>
                  <span className="text-[8px] px-1 py-0.5 rounded border" style={{ color:REGION_COLOR[a.region], borderColor:REGION_COLOR[a.region]+'66' }}>{a.region}</span>
                  <span className="text-[8px] text-slate-500">Cat-{a.cat}</span>
                </div>
                <span className="text-[8px] text-slate-500 tabular-nums">{a.rwyLenM}m</span>
              </div>
              <div className="text-[9px] text-slate-400 italic mt-0.5 truncate">{a.name}</div>
              <div className="text-[9px] text-slate-400 mt-0.5">in-scope AC: <span className="text-slate-200">{inUse.length}</span></div>
            </div>
          )
        })}

        {tab === 'HOSP' && HOSPITALS.map(h => (
          <div key={h.id} className="rounded border border-slate-800 px-2 py-1.5" style={{ borderLeft:`3px solid ${REGION_COLOR[h.service]}` }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1 min-w-0">
                <span className="text-sky-400 font-medium">{h.id}</span>
                <span className="text-[8px] px-1 py-0.5 rounded border border-rose-500/40 text-rose-400">Lvl-{h.trauma}</span>
              </div>
              <span className="text-[8px]" style={{ color: REGION_COLOR[h.service] }}>{h.service}</span>
            </div>
            <div className="text-[9px] italic text-slate-300 truncate">{h.name}</div>
            <div className="text-[9px] text-slate-500 mt-0.5">
              {h.cath && <span className="text-emerald-400">cath </span>}
              {h.stroke && <span className="text-emerald-400">stroke </span>}
              {h.ob && <span className="text-emerald-400">OB </span>}
              {h.helipad && <span className="text-sky-400">helipad </span>}
              {h.ed24 && <span className="text-sky-400">24/7-ED </span>}
            </div>
            <div className="text-[8px] text-slate-500">{h.city}, {h.country}</div>
          </div>
        ))}
        {rows.length === 0 && tab==='AC' && <div className="text-slate-500 text-[10px] text-center py-4">no airborne traffic in scope</div>}
      </div>
    </div>
  )
}

function Slider({ label, val, min, max, onChange, unit }: { label:string; val:number; min:number; max:number; onChange:(v:number)=>void; unit:string }) {
  return (
    <div>
      <div className="flex items-center justify-between text-[8px] uppercase tracking-widest">
        <span className="text-slate-500">{label}</span>
        <span className="text-slate-300 tabular-nums">{val}{unit}</span>
      </div>
      <input type="range" min={min} max={max} value={val} onChange={e=>onChange(Number(e.target.value))} className="w-full h-1 accent-sky-500" />
    </div>
  )
}
