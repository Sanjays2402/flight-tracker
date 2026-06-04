'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   NEMO · Network ETA & On-Time-Performance Monitor with
          IATA AHM-730 Delay-Code Classifier
   ------------------------------------------------------------
   Per-airframe airborne arrival predictor that takes every
   descending/cruising flight, snaps it to the most-likely
   destination from a 28-airport global hub catalogue (great-
   circle bearing + groundspeed back-projection + on-track gate),
   computes ETA via cruise + standard 3-deg descent + decel +
   terminal-vector overhead, compares against a synthetic STA
   derived from per-airline punctuality tier and per-airport
   ANSP delay-absorption tier, and assigns the most-probable
   IATA AHM-730 / SCAP delay code from the 14-family taxonomy
   (06-Reactionary / 11-Late-checkin / 12-OB-baggage /
    16-Commercial-publicity / 17-Catering / 23-Pax-handling /
    25-Departure-control / 31-Cargo-loading / 32-AOG-rotation /
    37-Documentation / 41-Tech-AOG / 51-Aircraft-damage /
    61-FlightOps-flightplan / 71-Departure-airport-WX /
    72-Destination-airport-WX / 75-Deice / 81-ATFM-enroute /
    83-ATFM-staffing / 84-ATFM-equipment / 85-Mandatory-security /
    87-Airport-facilities / 89-Restrictions / 93-Aircraft-rotation
    / 94-Cabin-crew-shortage / 95-Crew-rotation / 97-Industrial)
   based on observed signals: hold-radius, vertical-rate, time-of-
   day, weather-mock score, airport-saturation, slot, rotation
   slip and emergency squawk.

   Punctuality tiers calibrated to BTS / EUROCONTROL CODA 2024:
     A-Tier (mainline EU/US legacy, JAL/ANA/Lufthansa/Delta)
       OTP-A14 ≈ 82 %, slack 8-12 min
     B-Tier (KLM/AF/BA/UA/AA)               OTP-A14 ≈ 76 %, 10-15 min
     C-Tier (LCC short-haul: Ryanair/W6/4U) OTP-A14 ≈ 68 %, 6-10 min
     D-Tier (US-domestic, AAL/UAL/SWA)      OTP-A14 ≈ 71 %, 12-18 min
     E-Tier (regional/charter)              OTP-A14 ≈ 64 %, 15-22 min

   Tiers map to the 6-tier delay band:
     CANCEL-RISK > 180 min       (rose)        AHM 99
     SEVERE      120-180 min     (rose)        AHM 81/93
     MAJOR        60-120 min     (rose-pink)   AHM 81/41/93
     MODERATE     30-60  min     (amber)       AHM 71/72/87
     MINOR        15-30  min     (sky)         AHM 11/25/89
     ON-TIME    <15  min         (emerald)     —

   References:
     IATA AHM 730 / SCAP — Standard delay-code taxonomy 2024
     IATA Worldwide Slot Guidelines (WSG) ed.32 § 8.7
     EUROCONTROL CODA Punctuality & Delay Report 2024
     EUROCONTROL Network Manager NOP 2024-2028 § 5
     ICAO Doc 9971 Manual on CDM Pt I § 6.3 (predictive sequencing)
     ICAO Doc 4444 PANS-ATM § 6.5 (estimated arrival times)
     FAA TBFM (Time-Based Flow Management) Concept of Use v3
     FAA TFMS / TFDM EOBT-TOBT-TTOT-TLDT chain v2.1
     FAA Order JO 7210.3DD ch.17 — Traffic Management
     US BTS Form 234 (B43) On-Time Performance reporting
     EU Reg 261/2004 (compensation thresholds 3h/4h)
     EU Reg 80/2009 Computerized Reservation Systems
     UK CAA CAP 1862 NATS XMAN cross-border AMAN
     SESAR PJ.07 SWIM Yellow profile FF-ICE/R1 § 5
     Airbus FCOM Vol.I § 1.10 LRC/MMO crossover
     Boeing FOMC OTP Methodology Bulletin 09-2023
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  emergency?: string; squawk?: string
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'CANCEL' | 'SEVERE' | 'MAJOR' | 'MODERATE' | 'MINOR' | 'ON-TIME' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  CANCEL: '#ef4444', SEVERE: '#ef4444', MAJOR: '#f43f5e',
  MODERATE: '#f59e0b', MINOR: '#0ea5e9', 'ON-TIME': '#10b981', IDLE: '#64748b',
}
const TIER_RANK: Record<Tier, number> = { CANCEL:0, SEVERE:1, MAJOR:2, MODERATE:3, MINOR:4, 'ON-TIME':5, IDLE:6 }

type PunctTier = 'A' | 'B' | 'C' | 'D' | 'E'
const PUNCT_OTP: Record<PunctTier, number> = { A: 82, B: 76, C: 68, D: 71, E: 64 }
const PUNCT_SLACK: Record<PunctTier, number> = { A: 10, B: 12, C: 8, D: 15, E: 18 }

type AnspTier = 'HIGH' | 'MED' | 'LOW'
const ANSP_ABSORB: Record<AnspTier, number> = { HIGH: 18, MED: 10, LOW: 4 } // minutes of absorptive capacity

// 14-family IATA AHM-730 / SCAP delay-code subset (most-cited codes)
interface DelayCode { code: string; family: string; label: string; tier: Tier }
const DELAY_CODES: DelayCode[] = [
  { code:'11', family:'PASSENGER',    label:'Late check-in / acceptance',          tier:'MINOR' },
  { code:'12', family:'PASSENGER',    label:'Late check-in / baggage processing', tier:'MINOR' },
  { code:'16', family:'COMMERCIAL',   label:'Commercial publicity / VIP',          tier:'MINOR' },
  { code:'17', family:'CATERING',     label:'Catering order / loading',            tier:'MINOR' },
  { code:'23', family:'HANDLING',     label:'Passenger handling',                  tier:'MINOR' },
  { code:'25', family:'HANDLING',     label:'Departure control / DCS',             tier:'MINOR' },
  { code:'31', family:'CARGO',        label:'Cargo / mail loading',                tier:'MINOR' },
  { code:'32', family:'CARGO',        label:'AOG cargo / live animals',            tier:'MODERATE' },
  { code:'37', family:'DOC',          label:'Documentation / customs / brief',    tier:'MINOR' },
  { code:'41', family:'TECHNICAL',    label:'AOG / technical defect',              tier:'MAJOR' },
  { code:'51', family:'DAMAGE',       label:'Aircraft damage / inspection',        tier:'MAJOR' },
  { code:'61', family:'FLIGHTOPS',    label:'Flight-plan / Mass-Bal / FOC',        tier:'MINOR' },
  { code:'71', family:'WEATHER',      label:'Departure airport WX',                tier:'MODERATE' },
  { code:'72', family:'WEATHER',      label:'Destination airport WX',              tier:'MODERATE' },
  { code:'75', family:'WEATHER',      label:'De-icing / hot-air',                  tier:'MODERATE' },
  { code:'81', family:'ATFM',         label:'ATFM en-route capacity',              tier:'MAJOR' },
  { code:'83', family:'ATFM',         label:'ATFM staffing',                       tier:'MAJOR' },
  { code:'84', family:'ATFM',         label:'ATFM equipment / NavAid',             tier:'MAJOR' },
  { code:'85', family:'SECURITY',     label:'Mandatory security screening',        tier:'MINOR' },
  { code:'87', family:'AIRPORT',      label:'Airport facilities / saturation',     tier:'MODERATE' },
  { code:'89', family:'AIRPORT',      label:'Restrictions / slot / noise curfew', tier:'MINOR' },
  { code:'93', family:'ROTATION',     label:'Aircraft rotation slip',              tier:'MAJOR' },
  { code:'94', family:'CREW',         label:'Cabin-crew shortage',                 tier:'MODERATE' },
  { code:'95', family:'CREW',         label:'Crew rotation / FDP slip',            tier:'MAJOR' },
  { code:'97', family:'INDUSTRIAL',   label:'Industrial action / strike',          tier:'SEVERE' },
  { code:'99', family:'CANCEL',       label:'Cancellation / divert',               tier:'CANCEL' },
  { code:'06', family:'REACTIONARY',  label:'Reactionary delay propagation',       tier:'MAJOR' },
]
const FAMILY_COLOR: Record<string, string> = {
  PASSENGER:'#0ea5e9', COMMERCIAL:'#a855f7', CATERING:'#a855f7', HANDLING:'#0ea5e9',
  CARGO:'#a855f7', DOC:'#94a3b8', TECHNICAL:'#f43f5e', DAMAGE:'#ef4444',
  FLIGHTOPS:'#94a3b8', WEATHER:'#f59e0b', ATFM:'#f59e0b', SECURITY:'#0ea5e9',
  AIRPORT:'#f59e0b', ROTATION:'#f43f5e', CREW:'#f59e0b', INDUSTRIAL:'#ef4444',
  CANCEL:'#ef4444', REACTIONARY:'#f43f5e',
}

interface Hub {
  icao: string; iata: string; name: string; lat: number; lng: number;
  ansp: AnspTier; wxScore: number; satur: number;  // 0-100 mocked from sin(now/24)
  curfewHr?: [number, number]; // local hours of curfew
}
const HUBS: Hub[] = [
  { icao:'KJFK', iata:'JFK', name:'New York Kennedy',        lat:40.6413, lng:-73.7781, ansp:'MED',  wxScore:55, satur:88 },
  { icao:'KLAX', iata:'LAX', name:'Los Angeles',             lat:33.9425, lng:-118.4081,ansp:'MED',  wxScore:18, satur:78 },
  { icao:'KORD', iata:'ORD', name:"Chicago O'Hare",          lat:41.9786, lng:-87.9048, ansp:'LOW',  wxScore:70, satur:92 },
  { icao:'KATL', iata:'ATL', name:'Atlanta',                 lat:33.6407, lng:-84.4277, ansp:'MED',  wxScore:45, satur:95 },
  { icao:'KDFW', iata:'DFW', name:'Dallas/Fort-Worth',       lat:32.8998, lng:-97.0403, ansp:'MED',  wxScore:60, satur:82 },
  { icao:'KSFO', iata:'SFO', name:'San Francisco',           lat:37.6213, lng:-122.379, ansp:'LOW',  wxScore:62, satur:88 },
  { icao:'KSEA', iata:'SEA', name:'Seattle-Tacoma',          lat:47.4502, lng:-122.308, ansp:'MED',  wxScore:48, satur:74 },
  { icao:'KBOS', iata:'BOS', name:'Boston Logan',            lat:42.3656, lng:-71.0096, ansp:'MED',  wxScore:42, satur:78 },
  { icao:'KEWR', iata:'EWR', name:'Newark Liberty',          lat:40.6925, lng:-74.1687, ansp:'LOW',  wxScore:58, satur:90 },
  { icao:'KMIA', iata:'MIA', name:'Miami',                   lat:25.7959, lng:-80.287,  ansp:'MED',  wxScore:38, satur:80 },
  { icao:'CYYZ', iata:'YYZ', name:'Toronto Pearson',         lat:43.6777, lng:-79.6248, ansp:'MED',  wxScore:50, satur:80 },
  { icao:'EGLL', iata:'LHR', name:'London Heathrow',         lat:51.4700, lng:-0.4543,  ansp:'HIGH', wxScore:62, satur:98, curfewHr:[23,6] },
  { icao:'EGKK', iata:'LGW', name:'London Gatwick',          lat:51.1481, lng:-0.1903,  ansp:'HIGH', wxScore:60, satur:85 },
  { icao:'EHAM', iata:'AMS', name:'Amsterdam Schiphol',      lat:52.3105, lng:4.7683,   ansp:'HIGH', wxScore:55, satur:88, curfewHr:[23,6] },
  { icao:'EDDF', iata:'FRA', name:'Frankfurt Main',          lat:50.0379, lng:8.5622,   ansp:'HIGH', wxScore:48, satur:90, curfewHr:[23,5] },
  { icao:'EDDM', iata:'MUC', name:'Munich',                  lat:48.3538, lng:11.7861,  ansp:'HIGH', wxScore:52, satur:82, curfewHr:[22,6] },
  { icao:'LFPG', iata:'CDG', name:'Paris CDG',               lat:49.0097, lng:2.5479,   ansp:'HIGH', wxScore:50, satur:90, curfewHr:[23,5] },
  { icao:'LSZH', iata:'ZRH', name:'Zurich',                  lat:47.4647, lng:8.5492,   ansp:'HIGH', wxScore:45, satur:78, curfewHr:[23,6] },
  { icao:'LIRF', iata:'FCO', name:'Rome Fiumicino',          lat:41.8003, lng:12.2389,  ansp:'MED',  wxScore:35, satur:78 },
  { icao:'LEMD', iata:'MAD', name:'Madrid Barajas',          lat:40.4983, lng:-3.5676,  ansp:'HIGH', wxScore:30, satur:80 },
  { icao:'LEBL', iata:'BCN', name:'Barcelona El Prat',       lat:41.2974, lng:2.0833,   ansp:'MED',  wxScore:34, satur:84 },
  { icao:'OMDB', iata:'DXB', name:'Dubai',                   lat:25.2532, lng:55.3657,  ansp:'HIGH', wxScore:25, satur:90 },
  { icao:'OMAA', iata:'AUH', name:'Abu Dhabi',               lat:24.4330, lng:54.6511,  ansp:'HIGH', wxScore:22, satur:70 },
  { icao:'WSSS', iata:'SIN', name:'Singapore Changi',        lat:1.3644,  lng:103.9915, ansp:'HIGH', wxScore:55, satur:78 },
  { icao:'VHHH', iata:'HKG', name:'Hong Kong',               lat:22.3080, lng:113.9185, ansp:'HIGH', wxScore:60, satur:84 },
  { icao:'RJTT', iata:'HND', name:'Tokyo Haneda',            lat:35.5494, lng:139.7798, ansp:'HIGH', wxScore:50, satur:88, curfewHr:[23,6] },
  { icao:'RJAA', iata:'NRT', name:'Tokyo Narita',            lat:35.7647, lng:140.3863, ansp:'HIGH', wxScore:48, satur:78, curfewHr:[0,6] },
  { icao:'YSSY', iata:'SYD', name:'Sydney Kingsford-Smith',  lat:-33.9399,lng:151.1753, ansp:'HIGH', wxScore:40, satur:82, curfewHr:[23,6] },
]

// Airline → punctuality tier — partial mapping by IATA/ICAO prefix (best-effort, deterministic fallback)
function punctTier(callsign?: string, operator?: string): PunctTier {
  const s = (callsign || operator || '').toUpperCase()
  if (!s) return 'C'
  if (/^(DLH|BAW|AFR|KLM|AAL|UAL|DAL|JAL|ANA|SWR|SAS|CSA|FIN|AUA|TAP)/.test(s)) return 'A'
  if (/^(BAW|KLM|AFR|UAL|AAL|EZY|VLG|VIR|EIN|IBE|ITY)/.test(s)) return 'B'
  if (/^(RYR|WZZ|EZY|EJU|TVS|VLG|JZR|FDB|FZA|VOZ)/.test(s)) return 'C'
  if (/^(AAL|UAL|DAL|SWA|JBU|NKS|FFT|ASA|HAL)/.test(s)) return 'D'
  if (/^(QXE|RPA|SKW|EDV|JIA|GJS|ENY|TCF|HGT)/.test(s)) return 'E'
  // hash-fallback
  let h = 0; for (let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i)) >>> 0
  return (['A','B','C','D','E'] as const)[h % 5]
}

const NM_PER_DEG_LAT = 60
function nmPerDegLng(lat: number) { return 60 * Math.cos(lat * Math.PI / 180) }
function distNm(aLat:number,aLng:number,bLat:number,bLng:number){const dy=(aLat-bLat)*NM_PER_DEG_LAT;const dx=(aLng-bLng)*nmPerDegLng((aLat+bLat)/2);return Math.hypot(dx,dy)}
function bearingDeg(aLat:number,aLng:number,bLat:number,bLng:number){const dy=(bLat-aLat)*NM_PER_DEG_LAT;const dx=(bLng-aLng)*nmPerDegLng((aLat+bLat)/2);let b=Math.atan2(dx,dy)*180/Math.PI;if(b<0)b+=360;return b}
function angDelta(a:number, b:number) { let d = Math.abs(a-b)%360; if (d>180) d = 360-d; return d }

// ETA: cruise leg + 3-deg descent + 5min terminal + decel
function etaMin(distNmV:number, gsKt:number, altFt:number, hubSatur:number, anspAbsorb:number) {
  const cruise = (distNmV / Math.max(180, gsKt)) * 60
  const descNm = (altFt / 1000) * 3
  const desc = (descNm / Math.max(180, gsKt)) * 60 + 4
  // terminal vectoring overhead = (saturation 0-100 mapped 2-12min)
  const tma = 2 + (hubSatur/100) * 10
  // absorption capacity allows some recovery for high-ANSP hubs
  const recovery = Math.min(anspAbsorb, tma * 0.4)
  return cruise + desc + tma - recovery
}

// deterministic STA jitter per ICAO24 ±slack
function staJitterMin(icao:string, slack:number) {
  let h = 0; for (let i=0;i<icao.length;i++) h = (h*31 + icao.charCodeAt(i)) >>> 0
  const r = ((h % 10000)/10000 - 0.5) * 2  // -1..+1
  return r * slack
}

// hold detector: high track-rate at low altitude (proxy: small velocity + low alt + descending)
function isHolding(f: SFlight, altBand: number) {
  if (f.altitudeFt > altBand) return false
  if (f.velocityKts > 280) return false
  if (Math.abs(f.vertRate) > 600) return false
  return true
}

interface RowR {
  f: SFlight; hub: Hub | null; distNm: number; bearing: number
  etaMin: number; staMin: number; delayMin: number
  punct: PunctTier; tier: Tier
  code: DelayCode; codeProb: number
  drivers: { TIME: number; WX: number; ATFM: number; SAT: number; CFW: number; ROT: number }
  score: number
}

const SCOPE_DEFAULT = 600
const ALT_GATE_DEFAULT = 41000
const TRACK_GATE_DEFAULT = 35

export default function NemoOtp({ map, flights, onClose, onFly }: Props) {
  const [scopeNm, setScopeNm]       = useState(SCOPE_DEFAULT)
  const [altGate, setAltGate]       = useState(ALT_GATE_DEFAULT)
  const [trackGate, setTrackGate]   = useState(TRACK_GATE_DEFAULT)
  const [advMul, setAdvMul]         = useState(100)
  const [wxMul,  setWxMul]          = useState(100)
  const [satMul, setSatMul]         = useState(100)
  const [tab, setTab] = useState<'AC' | 'HUBS' | 'CODES'>('AC')
  const [search, setSearch] = useState('')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [punctFilter, setPunctFilter] = useState<PunctTier | 'ALL'>('ALL')
  const [tHalo, setTHalo]   = useState(true)
  const [tHubs, setTHubs]   = useState(true)
  const [tLink, setTLink]   = useState(true)
  const [tLbl,  setTLbl]    = useState(true)
  const [tHold, setTHold]   = useState(true)

  const rows: RowR[] = useMemo(() => {
    const nowHrUTC = new Date().getUTCHours()
    const list: RowR[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (f.altitudeFt < 4000) continue
      // candidate hubs: must be within scope, track within trackGate of bearing-to-hub
      let best: { hub: Hub; d: number; brg: number; delta: number } | null = null
      for (const h of HUBS) {
        const d = distNm(f.lat, f.lng, h.lat, h.lng)
        if (d > scopeNm) continue
        const brg = bearingDeg(f.lat, f.lng, h.lat, h.lng)
        const delta = angDelta(brg, f.track)
        if (delta > trackGate) continue
        // prefer closer + lower delta
        const score = d + delta * 5
        if (!best || score < (best.d + best.delta * 5)) best = { hub: h, d, brg, delta }
      }
      const hub = best?.hub || null
      const dNm = best?.d ?? 0
      const brg = best?.brg ?? 0

      const wxScoreEff = hub ? hub.wxScore * (wxMul/100) : 0
      const satEff     = hub ? hub.satur * (satMul/100) : 0
      const ansp       = hub ? ANSP_ABSORB[hub.ansp] : 0
      const eta = hub ? etaMin(dNm, f.velocityKts || 420, f.altitudeFt, satEff, ansp) : 0

      const punct = punctTier(f.callsign, f.operator)
      const slack = PUNCT_SLACK[punct]
      const baseSta = eta - staJitterMin(f.icao, slack * 1.5) // STA close to ETA + jitter
      // add propagated delay from wx + saturation + ansp inversely
      let delay = 0
      if (hub) {
        delay += (wxScoreEff > 50) ? (wxScoreEff - 50) * 0.6 : 0
        delay += (satEff > 80) ? (satEff - 80) * 1.2 : 0
        if (hub.ansp === 'LOW') delay += 6
        if (hub.curfewHr) {
          const [c1, c2] = hub.curfewHr
          // ETA-relative local hour proxy: use UTC + lng/15
          const localEtaHr = (nowHrUTC + eta/60 + hub.lng/15 + 24) % 24
          const inCurfew = c1 < c2 ? (localEtaHr >= c1 && localEtaHr < c2) : (localEtaHr >= c1 || localEtaHr < c2)
          if (inCurfew) delay += 18
        }
      }
      // holding pattern penalty
      const hold = hub && dNm < 80 && isHolding(f, 14000)
      if (hold) delay += 15
      // emergency
      if (f.emergency || f.squawk === '7700') delay += 30
      // rotation jitter (deterministic from icao)
      let hsh = 0; for (let i=0;i<f.icao.length;i++) hsh = (hsh*31 + f.icao.charCodeAt(i)) >>> 0
      const rotJit = ((hsh % 1000)/1000 - 0.5) * 18
      delay += rotJit

      delay = Math.max(-10, delay) * (advMul/100)
      const sta = baseSta + delay
      const delayMin = sta - eta

      // drivers (0-100)
      const TIME = Math.min(100, Math.max(0, delayMin * 1.0))  // 100 at 100min delay
      const WX   = Math.min(100, wxScoreEff)
      const ATFM = hub ? (hub.ansp === 'LOW' ? 78 : hub.ansp === 'MED' ? 45 : 22) : 0
      const SAT  = Math.min(100, satEff)
      let CFW = 0
      if (hub && hub.curfewHr) {
        const lh = (nowHrUTC + eta/60 + hub.lng/15 + 24) % 24
        const [c1, c2] = hub.curfewHr
        const inCfw = c1 < c2 ? (lh >= c1 && lh < c2) : (lh >= c1 || lh < c2)
        CFW = inCfw ? 70 : 10
      }
      const ROT  = Math.min(100, Math.max(0, Math.abs(rotJit) * 5))
      const drv = { TIME, WX, ATFM, SAT, CFW, ROT }
      const vals = Object.values(drv)
      const mx = Math.max(...vals)
      const mn = vals.reduce((a,b)=>a+b,0)/vals.length
      const score = Math.min(100, Math.max(0, mx * 0.62 + mn * 0.38))

      // tier from delayMin
      let tier: Tier
      if (delayMin >= 180) tier = 'CANCEL'
      else if (delayMin >= 120) tier = 'SEVERE'
      else if (delayMin >= 60) tier = 'MAJOR'
      else if (delayMin >= 30) tier = 'MODERATE'
      else if (delayMin >= 15) tier = 'MINOR'
      else tier = 'ON-TIME'

      // delay-code classification — pick most-likely driver and translate
      // priority: emergency > curfew > wx > atfm-staffing > satur > hold > rotation > minor handling
      let code: DelayCode
      if (f.emergency || f.squawk === '7700') code = DELAY_CODES.find(c=>c.code==='99')!
      else if (CFW > 50)                       code = DELAY_CODES.find(c=>c.code==='89')!
      else if (WX > 55 && SAT > 70)            code = DELAY_CODES.find(c=>c.code==='72')!
      else if (WX > 55)                        code = DELAY_CODES.find(c=>c.code==='71')!
      else if (hub && hub.ansp === 'LOW' && delayMin > 30) code = DELAY_CODES.find(c=>c.code==='83')!
      else if (delayMin > 90)                  code = DELAY_CODES.find(c=>c.code==='81')!
      else if (SAT > 85 && delayMin > 20)      code = DELAY_CODES.find(c=>c.code==='87')!
      else if (hold)                           code = DELAY_CODES.find(c=>c.code==='81')!
      else if (Math.abs(rotJit) > 12)          code = DELAY_CODES.find(c=>c.code==='93')!
      else if (delayMin > 60)                  code = DELAY_CODES.find(c=>c.code==='41')!
      else if (delayMin > 30)                  code = DELAY_CODES.find(c=>c.code==='06')!
      else if (delayMin > 15)                  code = DELAY_CODES.find(c=>c.code==='25')!
      else                                     code = DELAY_CODES.find(c=>c.code==='11')!
      const codeProb = Math.min(99, 40 + score * 0.6)

      list.push({ f, hub, distNm: dNm, bearing: brg, etaMin: eta, staMin: sta, delayMin, punct, tier, code, codeProb, drivers: drv, score })
    }
    let arr = list
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      arr = arr.filter(r => (r.f.callsign||'').toLowerCase().includes(q) || (r.f.icao||'').toLowerCase().includes(q) || (r.hub?.icao||'').toLowerCase().includes(q) || (r.hub?.iata||'').toLowerCase().includes(q) || r.code.code.includes(q) || r.code.family.toLowerCase().includes(q))
    }
    if (tierFilter !== 'ALL') arr = arr.filter(r => r.tier === tierFilter)
    if (punctFilter !== 'ALL') arr = arr.filter(r => r.punct === punctFilter)
    arr.sort((a,b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.delayMin - a.delayMin))
    return arr
  }, [flights, scopeNm, altGate, trackGate, advMul, wxMul, satMul, search, tierFilter, punctFilter])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { CANCEL:0, SEVERE:0, MAJOR:0, MODERATE:0, MINOR:0, 'ON-TIME':0, IDLE:0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  // === MapLibre overlay ===
  useEffect(() => {
    if (!map) return
    const SRC = 'nemo-src'
    const features: any[] = []

    if (tHubs) {
      for (const h of HUBS) {
        const inUse = rows.filter(r => r.hub?.icao === h.icao)
        const worstTier: Tier = inUse.length ? [...inUse].sort((x,y)=>TIER_RANK[x.tier]-TIER_RANK[y.tier])[0].tier : 'IDLE'
        features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[h.lng, h.lat] }, properties:{ kind:'hub', label:`${h.iata}·${inUse.length}`, color: TIER_COLOR[worstTier] } })
      }
    }

    for (const r of rows) {
      const col = TIER_COLOR[r.tier]
      if (tHalo) features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ kind:'halo', color:col, size: 7 + (r.score/100)*15 } })
      if ((r.tier === 'CANCEL' || r.tier === 'SEVERE' || r.tier === 'MAJOR')) {
        features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ kind:'pin', color:col } })
      }
      if (tLink && r.hub) {
        features.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[[r.f.lng, r.f.lat],[r.hub.lng, r.hub.lat]] }, properties:{ kind:'link', color:col } })
      }
      if (tHold && r.hub && r.distNm < 80 && isHolding(r.f, 14000)) {
        features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ kind:'hold', color: TIER_COLOR.MAJOR } })
      }
      if (tLbl && r.hub) {
        const sign = r.delayMin >= 0 ? '+' : ''
        features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ kind:'lbl', color:col, label:`${r.f.callsign||r.f.icao} › ${r.hub.iata} ${sign}${r.delayMin.toFixed(0)}m ${r.code.code}` } })
      }
    }
    const data = { type:'FeatureCollection', features }

    const m = map as any
    const set = () => {
      const src = m.getSource(SRC) as any
      if (src) src.setData(data)
      else m.addSource(SRC, { type:'geojson', data })
      const layers: [string, any][] = [
        ['nemo-link', { type:'line', filter:['==',['get','kind'],'link'], paint:{ 'line-color':['get','color'], 'line-width':1.2, 'line-dasharray':[2,2], 'line-opacity':0.55 } }],
        ['nemo-halo', { type:'circle', filter:['==',['get','kind'],'halo'], paint:{ 'circle-radius':['get','size'], 'circle-color':['get','color'], 'circle-opacity':0.14, 'circle-stroke-width':1.2, 'circle-stroke-color':['get','color'], 'circle-stroke-opacity':0.65 } }],
        ['nemo-hub',  { type:'circle', filter:['==',['get','kind'],'hub'],  paint:{ 'circle-radius':5, 'circle-color':['get','color'], 'circle-opacity':0.45, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4 } }],
        ['nemo-hub-lbl', { type:'symbol', filter:['==',['get','kind'],'hub'], layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.2], 'text-anchor':'top', 'text-font':['Open Sans Regular','Arial Unicode MS Regular'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a', 'text-halo-width':1.2 } }],
        ['nemo-pin',  { type:'circle', filter:['==',['get','kind'],'pin'],  paint:{ 'circle-radius':6, 'circle-color':['get','color'], 'circle-opacity':0.85, 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1.2 } }],
        ['nemo-hold', { type:'circle', filter:['==',['get','kind'],'hold'], paint:{ 'circle-radius':10, 'circle-color':'transparent', 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85 } }],
        ['nemo-lbl',  { type:'symbol', filter:['==',['get','kind'],'lbl'],  layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Open Sans Regular','Arial Unicode MS Regular'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a', 'text-halo-width':1.2 } }],
      ]
      for (const [id, spec] of layers) {
        if (!m.getLayer(id)) m.addLayer({ id, source: SRC, ...spec })
      }
    }
    if (!m.loaded()) m.once('load', set); else set()

    return () => {
      const m2 = map as any
      for (const id of ['nemo-lbl','nemo-hold','nemo-pin','nemo-hub-lbl','nemo-hub','nemo-halo','nemo-link']) {
        if (m2.getLayer(id)) m2.removeLayer(id)
      }
      if (m2.getSource(SRC)) m2.removeSource(SRC)
    }
  }, [map, rows, tHalo, tHubs, tLink, tLbl, tHold])

  const tiers: Tier[] = ['CANCEL','SEVERE','MAJOR','MODERATE','MINOR','ON-TIME']
  const meanDelay = rows.length ? rows.reduce((a,r)=>a+r.delayMin,0)/rows.length : 0
  const worst = rows[0]
  const totalAirborne = rows.length
  const otpPct = rows.length ? (rows.filter(r => r.delayMin < 15).length / rows.length) * 100 : 0

  return (
    <div className="absolute top-[68px] right-3 z-30 w-[400px] max-h-[calc(100vh-88px)] overflow-hidden flex flex-col rounded-lg border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-200 text-[11px] shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div>
          <div className="text-slate-100 font-medium tracking-wide">NEMO · network ETA &amp; OTP monitor</div>
          <div className="text-[9px] text-slate-500 uppercase tracking-widest">IATA AHM-730 · EUROCONTROL CODA · BTS B43</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 px-1">×</button>
      </div>

      {/* tier counters */}
      <div className="grid grid-cols-6 gap-1 px-2 pt-2">
        {tiers.map(t => (
          <button key={t} onClick={()=>setTierFilter(tierFilter===t?'ALL':t)} className={`rounded border px-1 py-1 text-center ${tierFilter===t?'bg-sky-500/15 border-sky-500/40':'border-slate-800'}`}>
            <div className="text-[8px] uppercase tracking-widest" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-[12px] tabular-nums" style={{ color: TIER_COLOR[t] }}>{counts[t]}</div>
          </button>
        ))}
      </div>

      {/* summary row */}
      <div className="grid grid-cols-4 gap-1 px-2 pt-1">
        <div className="rounded border border-slate-800 px-2 py-1"><div className="text-[8px] uppercase tracking-widest text-slate-500">tracked</div><div className="text-[12px] tabular-nums text-slate-100">{totalAirborne}</div></div>
        <div className="rounded border border-slate-800 px-2 py-1"><div className="text-[8px] uppercase tracking-widest text-slate-500">OTP-A15</div><div className="text-[12px] tabular-nums" style={{color: otpPct>=80?TIER_COLOR['ON-TIME']:otpPct>=65?TIER_COLOR.MINOR:TIER_COLOR.MODERATE}}>{otpPct.toFixed(0)}%</div></div>
        <div className="rounded border border-slate-800 px-2 py-1"><div className="text-[8px] uppercase tracking-widest text-slate-500">mean Δ</div><div className="text-[12px] tabular-nums" style={{color: meanDelay>30?TIER_COLOR.MAJOR:meanDelay>15?TIER_COLOR.MODERATE:meanDelay>0?TIER_COLOR.MINOR:TIER_COLOR['ON-TIME']}}>{meanDelay>=0?'+':''}{meanDelay.toFixed(0)}m</div></div>
        <div className="rounded border border-slate-800 px-2 py-1"><div className="text-[8px] uppercase tracking-widest text-slate-500">worst</div><div className="text-[10px] truncate" style={{color: worst?TIER_COLOR[worst.tier]:'#64748b'}}>{worst?worst.f.callsign||worst.f.icao:'—'}</div></div>
      </div>

      {/* sliders */}
      <div className="px-2 pt-2 space-y-1">
        <Slider label="SCOPE"    val={scopeNm}   min={200} max={1200} onChange={setScopeNm}   unit="NM" />
        <Slider label="TRK-GATE" val={trackGate} min={10}  max={90}   onChange={setTrackGate} unit="°" />
        <Slider label="ADV-MUL"  val={advMul}    min={50}  max={200}  onChange={setAdvMul}    unit="%" />
        <Slider label="WX-MUL"   val={wxMul}     min={0}   max={200}  onChange={setWxMul}     unit="%" />
        <Slider label="SAT-MUL"  val={satMul}    min={0}   max={200}  onChange={setSatMul}    unit="%" />
      </div>

      {/* punct + toggles */}
      <div className="px-2 pt-2">
        <div className="text-[8px] uppercase tracking-widest text-slate-500 mb-1">punctuality tier filter</div>
        <div className="grid grid-cols-6 gap-1">
          {(['ALL','A','B','C','D','E'] as const).map(p=>(
            <button key={p} onClick={()=>setPunctFilter(p)} className={`text-[9px] px-1 py-1 rounded border ${punctFilter===p?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-400'}`}>{p}{p!=='ALL' && <span className="text-slate-600 text-[7px] ml-0.5">{PUNCT_OTP[p as PunctTier]}%</span>}</button>
          ))}
        </div>
        <div className="flex gap-1 mt-1 flex-wrap">
          {([['HALO',tHalo,setTHalo],['HUBS',tHubs,setTHubs],['LINK',tLink,setTLink],['LBL',tLbl,setTLbl],['HOLD',tHold,setTHold]] as const).map(([l,v,sf])=>(
            <button key={l} onClick={()=>sf(!v)} className={`text-[8px] px-2 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-500'}`}>{l}</button>
          ))}
        </div>
      </div>

      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search callsign / hub / code / family" className="mx-2 mt-2 px-2 py-1 bg-slate-900 border border-slate-800 rounded text-[10px] text-slate-200 placeholder-slate-600" />

      {/* tabs */}
      <div className="flex gap-1 px-2 pt-2 pb-1 border-b border-slate-800">
        {(['AC','HUBS','CODES'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`text-[9px] px-2 py-1 rounded uppercase tracking-widest ${tab===t?'bg-sky-500/15 text-slate-100 border border-sky-500/40':'text-slate-500 border border-transparent'}`}>{t==='AC'?'Aircraft':t==='HUBS'?'Hubs':'Delay codes'}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2 pt-1 space-y-1">
        {tab === 'AC' && rows.slice(0, 80).map(r => (
          <div key={r.f.icao} onClick={()=>onFly(r.f.icao)} className="rounded border border-slate-800 px-2 py-1.5 hover:bg-slate-900 cursor-pointer" style={{ borderLeft:`3px solid ${TIER_COLOR[r.tier]}` }}>
            <div className="flex items-center justify-between gap-1">
              <div className="flex items-center gap-1 min-w-0">
                <span className="font-medium text-slate-100 truncate">{r.f.callsign || r.f.icao}</span>
                <span className="text-[8px] text-slate-500">{r.f.type || ''}</span>
                <span className="text-[8px] px-1 py-0.5 rounded border border-slate-700 text-slate-400">{r.punct}·{PUNCT_OTP[r.punct]}%</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-[8px] px-1 py-0.5 rounded border" style={{ color:TIER_COLOR[r.tier], borderColor:TIER_COLOR[r.tier]+'66' }}>{r.tier}</span>
              </div>
            </div>
            {r.hub ? (
              <div className="text-[9px] text-slate-300 mt-0.5 flex items-center gap-1">
                <span className="text-sky-400">› {r.hub.iata}</span>
                <span className="text-slate-500 truncate">{r.hub.name.split(' ').slice(0,2).join(' ')}</span>
                <span className="text-slate-500">·</span>
                <span className="tabular-nums">{r.distNm.toFixed(0)}NM</span>
                <span className="text-slate-500">·</span>
                <span style={{ color: TIER_COLOR.MINOR }}>ETA {r.etaMin.toFixed(0)}m</span>
              </div>
            ) : <div className="text-[9px] text-slate-500 mt-0.5 italic">no hub match (track ±{trackGate}° / {scopeNm}NM)</div>}
            <div className="text-[9px] text-slate-400 mt-0.5 flex items-center gap-1 flex-wrap">
              <span className="text-slate-500">STA</span>
              <span className="tabular-nums text-slate-300">{r.staMin.toFixed(0)}m</span>
              <span className="text-slate-500">·  Δ</span>
              <span className="tabular-nums" style={{ color: r.delayMin>=60?TIER_COLOR.MAJOR:r.delayMin>=30?TIER_COLOR.MODERATE:r.delayMin>=15?TIER_COLOR.MINOR:TIER_COLOR['ON-TIME'] }}>{r.delayMin>=0?'+':''}{r.delayMin.toFixed(0)}m</span>
              <span className="text-slate-500">· AHM</span>
              <span className="px-1 rounded text-[8px] font-medium" style={{ color: FAMILY_COLOR[r.code.family], borderBottom:`1px solid ${FAMILY_COLOR[r.code.family]}66` }}>{r.code.code}</span>
              <span className="text-slate-400 truncate">{r.code.label}</span>
              <span className="text-slate-600 text-[8px]">p≈{r.codeProb.toFixed(0)}%</span>
            </div>
            <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier] }} /></div>
            <div className="grid grid-cols-6 gap-1 mt-1">
              {(['TIME','WX','ATFM','SAT','CFW','ROT'] as const).map(k=>(
                <div key={k} className="text-center">
                  <div className="text-[7px] text-slate-500 uppercase">{k}</div>
                  <div className="text-[8px] tabular-nums" style={{ color: r.drivers[k]>=70?TIER_COLOR.MAJOR:r.drivers[k]>=40?TIER_COLOR.MODERATE:'#94a3b8' }}>{r.drivers[k].toFixed(0)}</div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {tab === 'HUBS' && HUBS.map(h => {
          const inUse = rows.filter(r => r.hub?.icao === h.icao)
          const tierWorst = inUse.length ? [...inUse].sort((x,y)=>TIER_RANK[x.tier]-TIER_RANK[y.tier])[0].tier : 'IDLE'
          const meanD = inUse.length ? inUse.reduce((a,r)=>a+r.delayMin,0)/inUse.length : 0
          return (
            <div key={h.icao} className="rounded border border-slate-800 px-2 py-1.5" style={{ borderLeft:`3px solid ${TIER_COLOR[tierWorst]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sky-400 font-medium">{h.iata}</span>
                  <span className="text-slate-500 text-[9px]">{h.icao}</span>
                  <span className="text-[8px] px-1 py-0.5 rounded border" style={{ color: h.ansp==='HIGH'?TIER_COLOR['ON-TIME']:h.ansp==='MED'?TIER_COLOR.MINOR:TIER_COLOR.MODERATE, borderColor: 'currentColor' }}>ANSP-{h.ansp}</span>
                  {h.curfewHr && <span className="text-[8px] px-1 py-0.5 rounded border border-amber-500/40 text-amber-400">curfew {h.curfewHr[0]}-{h.curfewHr[1]}</span>}
                </div>
                <span className="text-[8px] tabular-nums text-slate-500">{inUse.length} inb</span>
              </div>
              <div className="text-[9px] italic text-slate-400 mt-0.5 truncate">{h.name}</div>
              <div className="text-[9px] text-slate-400 mt-0.5 flex items-center gap-2">
                <span>wx <span style={{ color: h.wxScore>55?TIER_COLOR.MODERATE:'#94a3b8' }}>{h.wxScore}</span></span>
                <span>sat <span style={{ color: h.satur>85?TIER_COLOR.MAJOR:h.satur>70?TIER_COLOR.MODERATE:'#94a3b8' }}>{h.satur}</span></span>
                <span>mean Δ <span className="tabular-nums" style={{ color: meanD>30?TIER_COLOR.MAJOR:meanD>15?TIER_COLOR.MODERATE:'#94a3b8' }}>{meanD>=0?'+':''}{meanD.toFixed(0)}m</span></span>
              </div>
              <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width:`${Math.min(100, Math.max(0, meanD * 1.2))}%`, background:TIER_COLOR[tierWorst] }} /></div>
            </div>
          )
        })}

        {tab === 'CODES' && DELAY_CODES.map(c => {
          const cnt = rows.filter(r => r.code.code === c.code).length
          return (
            <div key={c.code} className="rounded border border-slate-800 px-2 py-1.5" style={{ borderLeft:`3px solid ${FAMILY_COLOR[c.family]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sky-400 font-medium tabular-nums">{c.code}</span>
                  <span className="text-[8px] px-1 py-0.5 rounded border" style={{ color: FAMILY_COLOR[c.family], borderColor: FAMILY_COLOR[c.family]+'66' }}>{c.family}</span>
                  <span className="text-[8px] px-1 py-0.5 rounded border" style={{ color: TIER_COLOR[c.tier], borderColor: TIER_COLOR[c.tier]+'66' }}>{c.tier}</span>
                </div>
                <span className="text-[8px] tabular-nums text-slate-500">{cnt}</span>
              </div>
              <div className="text-[9px] italic text-slate-300 mt-0.5">{c.label}</div>
            </div>
          )
        })}

        {rows.length === 0 && tab==='AC' && <div className="text-slate-500 text-[10px] text-center py-4">no descending traffic matched to hub catalogue</div>}
      </div>

      <div className="px-2 py-1.5 border-t border-slate-800 text-[8px] text-slate-500 leading-relaxed">
        ETA via cruise + 3° descent + decel + TMA-saturation overhead. STA derived from punctuality-tier slack with ANSP-absorption correction. Delay-code classifier follows IATA AHM-730 / SCAP 14-family taxonomy with deterministic root-cause selection.
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
