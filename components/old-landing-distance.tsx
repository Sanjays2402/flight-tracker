'use client'
/* OLD · Operational Landing-Distance & Runway-Stop-Margin Monitor
 * Per-airframe scorer comparing Required Landing Distance (RLD) vs
 * Landing Distance Available (LDA) at the most-likely destination runway
 * under prevailing Runway Condition Code (RWYCC 6→1) per FAA TALPA ARC
 * (AC 25-32 / AC 91-79B / SAFO 19001 / 14 CFR §121.195 §25.125) and
 * ICAO GRF (Annex 14 §2.9 / Doc 9981 PANS-Aerodromes Pt I).
 */
import { useEffect, useMemo, useRef, useState } from 'react'

interface FlightLite {
  icao: string
  callsign?: string
  type?: string
  operator?: string
  lat: number
  lng: number
  alt?: number      // ft
  speed?: number    // kt GS
  track?: number    // deg
  vs?: number       // fpm
  squawk?: string
}

interface Props {
  map: any
  flights: FlightLite[]
  onClose: () => void
  onFly: (icao: string) => void
}

/* ============================== Catalogues ============================== */

interface Runway {
  apt: string; rwy: string; lat: number; lng: number
  hdg: number  // landing heading (true)
  lda: number  // metres
  elev: number // ft
  slope: number // % (positive = uphill)
}

// 24-runway catalogue (longest active landing runway per hub)
const RUNWAYS: Runway[] = [
  { apt:'KJFK', rwy:'04R', lat:40.6238, lng:-73.7785, hdg: 40, lda:2560, elev:13, slope:0.0 },
  { apt:'KLAX', rwy:'25L', lat:33.9425, lng:-118.4081, hdg:250, lda:3318, elev:126, slope:-0.1 },
  { apt:'KORD', rwy:'10C', lat:41.9786, lng:-87.9048, hdg:100, lda:3290, elev:672, slope:0.1 },
  { apt:'KATL', rwy:'09L', lat:33.6367, lng:-84.4281, hdg: 92, lda:2743, elev:1026, slope:-0.2 },
  { apt:'KDFW', rwy:'17C', lat:32.8998, lng:-97.0403, hdg:175, lda:4084, elev:607, slope:0.0 },
  { apt:'KSFO', rwy:'28L', lat:37.6188, lng:-122.3756, hdg:284, lda:3231, elev:13, slope:0.0 },
  { apt:'KSEA', rwy:'16L', lat:47.4502, lng:-122.3088, hdg:160, lda:3627, elev:433, slope:0.0 },
  { apt:'KDEN', rwy:'16R', lat:39.8617, lng:-104.6731, hdg:172, lda:4877, elev:5431, slope:0.0 },
  { apt:'KBOS', rwy:'04R', lat:42.3656, lng:-71.0096, hdg: 40, lda:3073, elev:20, slope:0.0 },
  { apt:'KMDW', rwy:'31C', lat:41.7868, lng:-87.7524, hdg:314, lda:1985, elev:620, slope:0.1 },
  { apt:'CYYZ', rwy:'05',  lat:43.6772, lng:-79.6306, hdg: 50, lda:3389, elev:569, slope:0.0 },
  { apt:'EGLL', rwy:'27L', lat:51.4775, lng:-0.4614, hdg:270, lda:3902, elev:83, slope:0.0 },
  { apt:'EGKK', rwy:'26L', lat:51.1481, lng:-0.1903, hdg:259, lda:3159, elev:202, slope:0.0 },
  { apt:'EHAM', rwy:'18R', lat:52.3621, lng:4.7113, hdg:183, lda:3800, elev:-11, slope:0.0 },
  { apt:'EDDF', rwy:'25C', lat:50.0379, lng:8.5622, hdg:249, lda:4000, elev:364, slope:0.0 },
  { apt:'EDDM', rwy:'26R', lat:48.3537, lng:11.7860, hdg:263, lda:4000, elev:1487, slope:0.0 },
  { apt:'LFPG', rwy:'26R', lat:49.0097, lng:2.5479, hdg:263, lda:2700, elev:392, slope:0.0 },
  { apt:'LSZH', rwy:'14',  lat:47.4647, lng:8.5492, hdg:138, lda:3300, elev:1416, slope:0.0 },
  { apt:'LIRF', rwy:'16L', lat:41.8003, lng:12.2389, hdg:160, lda:3902, elev:13, slope:0.0 },
  { apt:'LEMD', rwy:'32L', lat:40.4719, lng:-3.5626, hdg:323, lda:3500, elev:1998, slope:0.0 },
  { apt:'OMDB', rwy:'12L', lat:25.2528, lng:55.3644, hdg:122, lda:4000, elev:62, slope:0.0 },
  { apt:'WSSS', rwy:'02L', lat:1.3592, lng:103.9886, hdg: 23, lda:4000, elev:22, slope:0.0 },
  { apt:'VHHH', rwy:'07L', lat:22.3080, lng:113.9189, hdg: 73, lda:3800, elev:28, slope:0.0 },
  { apt:'RJTT', rwy:'34L', lat:35.5494, lng:139.7798, hdg:343, lda:3000, elev:21, slope:0.0 },
]

interface AcCert {
  // certified unfactored landing distance ALD (dry) at MLW in metres, plus Vref kt + MLW kg
  ald: number; vref: number; mlw: number; cat: string
}

// 42-type aircraft certification table
const ACFT: Record<string, AcCert> = {
  // Narrowbody
  'B737': { ald:1450, vref:142, mlw:58604, cat:'NB' },
  'B738': { ald:1530, vref:147, mlw:66360, cat:'NB' },
  'B739': { ald:1620, vref:149, mlw:71350, cat:'NB' },
  'B38M': { ald:1540, vref:147, mlw:69300, cat:'NB' },
  'B39M': { ald:1640, vref:149, mlw:72600, cat:'NB' },
  'A319': { ald:1390, vref:138, mlw:62500, cat:'NB' },
  'A320': { ald:1470, vref:140, mlw:66000, cat:'NB' },
  'A321': { ald:1610, vref:144, mlw:75500, cat:'NB' },
  'A20N': { ald:1490, vref:141, mlw:67400, cat:'NB' },
  'A21N': { ald:1640, vref:145, mlw:79200, cat:'NB' },
  // Widebody
  'B763': { ald:1670, vref:148, mlw:145150, cat:'WB' },
  'B764': { ald:1750, vref:152, mlw:158760, cat:'WB' },
  'B772': { ald:1620, vref:144, mlw:201840, cat:'WB' },
  'B77L': { ald:1700, vref:148, mlw:223168, cat:'WB' },
  'B77W': { ald:1810, vref:152, mlw:251290, cat:'WB' },
  'B788': { ald:1560, vref:141, mlw:172000, cat:'WB' },
  'B789': { ald:1660, vref:144, mlw:192700, cat:'WB' },
  'B78X': { ald:1720, vref:146, mlw:202000, cat:'WB' },
  'B744': { ald:2120, vref:154, mlw:295740, cat:'WB' },
  'B748': { ald:2230, vref:155, mlw:312070, cat:'WB' },
  'A332': { ald:1750, vref:142, mlw:182000, cat:'WB' },
  'A333': { ald:1800, vref:144, mlw:187000, cat:'WB' },
  'A339': { ald:1810, vref:144, mlw:191000, cat:'WB' },
  'A338': { ald:1770, vref:142, mlw:186000, cat:'WB' },
  'A359': { ald:1700, vref:143, mlw:207000, cat:'WB' },
  'A35K': { ald:1830, vref:148, mlw:233000, cat:'WB' },
  'A388': { ald:2100, vref:145, mlw:391000, cat:'WB' },
  // Regional jets
  'E170': { ald:1170, vref:128, mlw:32800, cat:'RJ' },
  'E75L': { ald:1300, vref:131, mlw:34000, cat:'RJ' },
  'E190': { ald:1350, vref:132, mlw:43000, cat:'RJ' },
  'E195': { ald:1410, vref:136, mlw:45200, cat:'RJ' },
  'E290': { ald:1370, vref:132, mlw:44000, cat:'RJ' },
  'E295': { ald:1430, vref:135, mlw:48800, cat:'RJ' },
  'CRJ2': { ald:1480, vref:138, mlw:21319, cat:'RJ' },
  'CRJ7': { ald:1540, vref:138, mlw:30391, cat:'RJ' },
  'CRJ9': { ald:1640, vref:142, mlw:33339, cat:'RJ' },
  'CRJX': { ald:1720, vref:144, mlw:36740, cat:'RJ' },
  // Turboprops
  'AT72': { ald: 970, vref:108, mlw:22350, cat:'TP' },
  'AT76': { ald:1020, vref:110, mlw:22850, cat:'TP' },
  'DH8D': { ald:1290, vref:120, mlw:28009, cat:'TP' },
  // Business
  'GLEX': { ald:830, vref:115, mlw:35153, cat:'BJ' },
  'GL5T': { ald:870, vref:118, mlw:36514, cat:'BJ' },
  'G650': { ald:950, vref:124, mlw:38600, cat:'BJ' },
}

// RWYCC multipliers — RLD = ALD_dry × MUL × dispatch_factor
const RWYCC_TABLE: Array<{ code: string; label: string; mul: number; note: string }> = [
  { code:'6', label:'Dry',          mul:1.00, note:'Dry, paved' },
  { code:'5', label:'Wet',          mul:1.15, note:'Wet ≤3mm or compacted snow ≤-15°C' },
  { code:'4', label:'Slush ≤3mm',   mul:1.40, note:'Wet snow / slush ≤3mm / dry snow ≤3mm' },
  { code:'3', label:'Wet snow >3mm',mul:1.65, note:'Compacted snow >-15°C / dry snow >3mm' },
  { code:'2', label:'Standing water',mul:2.00, note:'Standing water / slush >3mm' },
  { code:'1', label:'Ice',          mul:2.50, note:'Ice / cold-soaked / wet ice' },
  { code:'0', label:'Wet ice',      mul:99.0, note:'Wet ice — landing prohibited per OEM' },
  { code:'U', label:'Unknown',      mul:1.92, note:'Default wet dispatch factor' },
]

/* ============================== Helpers ============================== */

const R_EARTH_NM = 3440.065
function gcDistNM(a:[number,number], b:[number,number]): number {
  const [la1, lo1] = a.map(d => d * Math.PI/180)
  const [la2, lo2] = b.map(d => d * Math.PI/180)
  const dl = lo2 - lo1, dla = la2 - la1
  const h = Math.sin(dla/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dl/2)**2
  return 2 * R_EARTH_NM * Math.asin(Math.min(1, Math.sqrt(h)))
}
function bearing(a:[number,number], b:[number,number]): number {
  const [la1, lo1] = a.map(d => d * Math.PI/180)
  const [la2, lo2] = b.map(d => d * Math.PI/180)
  const y = Math.sin(lo2-lo1) * Math.cos(la2)
  const x = Math.cos(la1)*Math.sin(la2) - Math.sin(la1)*Math.cos(la2)*Math.cos(lo2-lo1)
  return ((Math.atan2(y, x) * 180/Math.PI) + 360) % 360
}
function angDiff(a:number, b:number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}
function typeKey(t?: string): string {
  if (!t) return ''
  const u = t.toUpperCase().trim()
  if (ACFT[u]) return u
  // crude family folding
  if (u.startsWith('B737') || u === 'B73G') return 'B738'
  if (u.startsWith('B738')) return 'B738'
  if (u.startsWith('A320')) return 'A320'
  if (u.startsWith('A321')) return 'A321'
  if (u.startsWith('A319')) return 'A319'
  if (u.startsWith('B777')) return 'B77W'
  if (u.startsWith('B787')) return 'B789'
  if (u.startsWith('A350')) return 'A359'
  if (u.startsWith('A330')) return 'A333'
  if (u.startsWith('A380')) return 'A388'
  if (u.startsWith('E19'))  return 'E190'
  if (u.startsWith('CRJ'))  return 'CRJ9'
  return ''
}
function phaseOf(f: FlightLite, distNM: number): string {
  const alt = f.alt ?? 0, vs = f.vs ?? 0
  if (alt < 100) return 'GND'
  if (alt < 4000 && distNM < 12) return 'APPR'
  if (alt < 12000 && distNM < 30) return 'TMA'
  if (vs < -300 && distNM < 80) return 'DES'
  return 'CRZ'
}
// ISA density ratio σ from elevation ft
function sigmaISA(elevFt: number): number {
  const T0 = 288.15, L = 0.0065, R = 287.05, g = 9.80665
  const hM = elevFt * 0.3048
  const T = T0 - L * hM
  const rho = 1.225 * Math.pow(T/T0, g/(R*L) - 1)
  return rho / 1.225
}

/* ============================== Tiering ============================== */

interface Score {
  f: FlightLite
  rwy: Runway | null
  distNM: number
  phase: string
  acKey: string
  ac: AcCert | null
  rldDry: number   // m, factored at dispatch
  rld: number      // m, factored × RWYCC × wind × slope × density
  lda: number
  marginPct: number   // (LDA - RLD)/LDA * 100
  tier: string
  trkGate: boolean
  headwindKt: number
}

const TIERS = ['OVERRUN','CRITICAL','MARGINAL','ADEQUATE','COMFORTABLE','AMPLE'] as const
type Tier = typeof TIERS[number]
const TIER_COLOR: Record<Tier, string> = {
  OVERRUN:    '#f43f5e',
  CRITICAL:   '#fb7185',
  MARGINAL:   '#f59e0b',
  ADEQUATE:   '#0ea5e9',
  COMFORTABLE:'#10b981',
  AMPLE:      '#94a3b8',
}
function tierOf(marginPct: number): Tier {
  if (marginPct <  0) return 'OVERRUN'
  if (marginPct < 10) return 'CRITICAL'
  if (marginPct < 25) return 'MARGINAL'
  if (marginPct < 50) return 'ADEQUATE'
  if (marginPct < 75) return 'COMFORTABLE'
  return 'AMPLE'
}

/* ============================== Component ============================== */

export default function OldLandingDistance({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'RUNWAYS'|'RWYCC'>('AIRCRAFT')
  const [search, setSearch] = useState('')
  const [rwycc, setRwycc] = useState<string>('6')
  const [scopeNM, setScopeNM] = useState(40)        // 8-80
  const [trkGateDeg, setTrkGateDeg] = useState(45)  // 15-90
  const [brkMul, setBrkMul] = useState(100)         // 70-150 (%)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin]   = useState(true)
  const [showLbl, setShowLbl]   = useState(true)
  const [wetDispatch, setWetDispatch] = useState(true) // 1.92x vs 1.67x
  const [tailwindKt, setTailwindKt]   = useState(0)    // -20..+20 (negative = headwind)
  const containerRef = useRef<HTMLDivElement|null>(null)

  /* scoring */
  const scores = useMemo<Score[]>(() => {
    const rwyMul = RWYCC_TABLE.find(r => r.code === rwycc)?.mul ?? 1.0
    const dispatch = wetDispatch ? 1.92 : 1.67
    const brakeF = brkMul / 100
    return flights.map(f => {
      // nearest runway within scope by GC distance and bearing gate
      let bestRwy: Runway | null = null
      let bestDist = Infinity
      let trkGate = false
      for (const r of RUNWAYS) {
        const d = gcDistNM([f.lat, f.lng], [r.lat, r.lng])
        if (d > scopeNM) continue
        // track gate: aircraft heading vs runway heading
        if (f.track != null) {
          const dt = angDiff(f.track, r.hdg)
          if (dt > trkGateDeg) continue
        }
        // also require we're roughly aligned with runway end (bearing TO runway near hdg)
        const brg = bearing([f.lat, f.lng], [r.lat, r.lng])
        const da = angDiff(brg, r.hdg)
        if (da > Math.max(trkGateDeg, 60)) continue
        if (d < bestDist) { bestDist = d; bestRwy = r; trkGate = true }
      }
      const acKey = typeKey(f.type)
      const ac = acKey ? ACFT[acKey] : null
      const phase = phaseOf(f, bestDist === Infinity ? 9999 : bestDist)

      let rldDry = 0, rld = 0, marginPct = 0, lda = 0, hwKt = 0
      if (ac) {
        rldDry = ac.ald * dispatch * brakeF
        // wind: tailwindKt user-provided crude proxy along runway
        // headwind: -5%/10kt;  tailwind: +50%/10kt
        const tw = tailwindKt
        const windF = tw >= 0
          ? 1 + (tw / 10) * 0.50
          : 1 - (Math.abs(tw) / 10) * 0.05
        hwKt = -tw
        // slope: +10% per 1% downslope (negative slope = downhill)
        const slope = bestRwy?.slope ?? 0
        const slopeF = slope >= 0 ? 1 - slope * 0.02 : 1 + Math.abs(slope) * 0.10
        // density altitude
        const sig = bestRwy ? sigmaISA(bestRwy.elev) : 1.0
        const densF = 1 / sig
        rld = rldDry * rwyMul * windF * slopeF * densF
        lda = bestRwy?.lda ?? 0
        marginPct = lda > 0 ? ((lda - rld) / lda) * 100 : -100
      }
      return {
        f, rwy: bestRwy, distNM: bestDist === Infinity ? -1 : bestDist,
        phase, acKey, ac,
        rldDry, rld, lda, marginPct,
        tier: ac && bestRwy ? tierOf(marginPct) : 'AMPLE',
        trkGate, headwindKt: hwKt,
      } as Score
    })
  }, [flights, rwycc, scopeNM, trkGateDeg, brkMul, wetDispatch, tailwindKt])

  const active = useMemo(() =>
    scores.filter(s => s.ac && s.rwy && s.distNM >= 0 && (s.phase === 'APPR' || s.phase === 'TMA' || s.phase === 'DES'))
  , [scores])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = active
    if (q) list = list.filter(s => {
      return (s.f.callsign||'').toLowerCase().includes(q)
          || (s.f.type||'').toLowerCase().includes(q)
          || (s.f.operator||'').toLowerCase().includes(q)
          || (s.rwy?.apt||'').toLowerCase().includes(q)
          || s.tier.toLowerCase().includes(q)
    })
    const ord = (t:string) => TIERS.indexOf(t as Tier)
    return list.slice().sort((a,b) => ord(a.tier) - ord(b.tier) || a.marginPct - b.marginPct)
  }, [active, search])

  /* MapLibre overlay */
  const SRC_HALO = 'old-halo-src'
  const SRC_PIN  = 'old-pin-src'
  const SRC_LBL  = 'old-lbl-src'
  const SRC_LINK = 'old-link-src'
  const LYR_HALO = 'old-halo-lyr'
  const LYR_PIN  = 'old-pin-lyr'
  const LYR_LBL  = 'old-lbl-lyr'
  const LYR_LINK = 'old-link-lyr'

  useEffect(() => {
    const m = map; if (!m || !m.getStyle) return
    const ensure = (id:string, def:any) => { try { if (!m.getSource(id)) m.addSource(id, def) } catch {} }
    const ensureLyr = (def:any) => { try { if (!m.getLayer(def.id)) m.addLayer(def) } catch {} }
    ensure(SRC_HALO, { type:'geojson', data:{ type:'FeatureCollection', features:[] } })
    ensure(SRC_PIN,  { type:'geojson', data:{ type:'FeatureCollection', features:[] } })
    ensure(SRC_LBL,  { type:'geojson', data:{ type:'FeatureCollection', features:[] } })
    ensure(SRC_LINK, { type:'geojson', data:{ type:'FeatureCollection', features:[] } })
    ensureLyr({ id:LYR_LINK, type:'line', source:SRC_LINK, paint:{
      'line-color':['get','color'], 'line-width':1.2, 'line-opacity':0.55, 'line-dasharray':[2,2]
    }})
    ensureLyr({ id:LYR_HALO, type:'circle', source:SRC_HALO, paint:{
      'circle-radius':['get','r'], 'circle-color':['get','color'],
      'circle-opacity':0.12, 'circle-stroke-color':['get','color'],
      'circle-stroke-width':1.4, 'circle-stroke-opacity':0.75,
    }})
    ensureLyr({ id:LYR_PIN, type:'circle', source:SRC_PIN, paint:{
      'circle-radius':4, 'circle-color':['get','color'],
      'circle-stroke-color':'#0f172a', 'circle-stroke-width':1,
    }})
    ensureLyr({ id:LYR_LBL, type:'symbol', source:SRC_LBL, layout:{
      'text-field':['get','t'], 'text-size':10,
      'text-font':['Open Sans Semibold','Arial Unicode MS Bold'],
      'text-offset':[0,1.2], 'text-anchor':'top', 'text-allow-overlap':true,
    }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0b1220', 'text-halo-width':1.4 }})
    return () => {
      try {
        for (const l of [LYR_LINK, LYR_HALO, LYR_PIN, LYR_LBL]) if (m.getLayer(l)) m.removeLayer(l)
        for (const s of [SRC_HALO, SRC_PIN, SRC_LBL, SRC_LINK]) if (m.getSource(s)) m.removeSource(s)
      } catch {}
    }
  }, [map])

  useEffect(() => {
    const m = map; if (!m || !m.getSource) return
    const halo:any[] = [], pin:any[] = [], lbl:any[] = [], link:any[] = []
    for (const s of active) {
      const c = TIER_COLOR[s.tier as Tier]
      const tIdx = TIERS.indexOf(s.tier as Tier)
      const r = 8 + (5 - tIdx) * 2.2  // worse tier = bigger
      if (showHalo) halo.push({
        type:'Feature', properties:{ color:c, r }, geometry:{ type:'Point', coordinates:[s.f.lng, s.f.lat] }
      })
      if (showPin && (s.tier === 'OVERRUN' || s.tier === 'CRITICAL')) pin.push({
        type:'Feature', properties:{ color:c },
        geometry:{ type:'Point', coordinates:[s.f.lng, s.f.lat] }
      })
      if (showLbl) lbl.push({
        type:'Feature', properties:{
          color:c,
          t: `${(s.f.callsign||s.f.icao).trim()} · ${s.rwy?.apt}/${s.rwy?.rwy} · ${s.marginPct.toFixed(0)}%`
        },
        geometry:{ type:'Point', coordinates:[s.f.lng, s.f.lat] }
      })
      if (s.rwy) link.push({
        type:'Feature', properties:{ color:c },
        geometry:{ type:'LineString', coordinates:[[s.f.lng, s.f.lat],[s.rwy.lng, s.rwy.lat]] }
      })
    }
    try { (m.getSource(SRC_HALO) as any)?.setData({ type:'FeatureCollection', features:halo }) } catch {}
    try { (m.getSource(SRC_PIN)  as any)?.setData({ type:'FeatureCollection', features:pin }) } catch {}
    try { (m.getSource(SRC_LBL)  as any)?.setData({ type:'FeatureCollection', features:lbl }) } catch {}
    try { (m.getSource(SRC_LINK) as any)?.setData({ type:'FeatureCollection', features:link }) } catch {}
  }, [map, active, showHalo, showPin, showLbl])

  /* counters */
  const counts = useMemo(() => {
    const c: Record<Tier, number> = { OVERRUN:0, CRITICAL:0, MARGINAL:0, ADEQUATE:0, COMFORTABLE:0, AMPLE:0 }
    for (const s of active) c[s.tier as Tier]++
    return c
  }, [active])

  /* render */
  return (
    <div ref={containerRef} className="absolute top-16 right-3 z-30 w-[420px] max-h-[78vh] flex flex-col rounded-lg bg-slate-900/95 backdrop-blur border border-slate-700 shadow-2xl text-slate-200 text-[12px]">
      {/* header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-sky-500"></div>
          <div className="font-semibold tracking-wide text-slate-100">OLD</div>
          <div className="text-slate-500 text-[11px]">Landing-Distance & Stop-Margin</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-[14px] leading-none">×</button>
      </div>

      {/* tier strip */}
      <div className="px-3 py-2 border-b border-slate-700 flex flex-wrap gap-1">
        {TIERS.map(t => (
          <div key={t} className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-800/70 border border-slate-700">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: TIER_COLOR[t] }}></span>
            <span className="text-[10px] text-slate-300">{t}</span>
            <span className="text-[10px] text-slate-500">{counts[t]}</span>
          </div>
        ))}
      </div>

      {/* tabs */}
      <div className="flex border-b border-slate-700">
        {(['AIRCRAFT','RUNWAYS','RWYCC'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 px-2 py-1.5 text-[11px] tracking-wide ${tab===t ? 'bg-sky-500/15 text-slate-100 border-b border-sky-500/40' : 'text-slate-400 hover:text-slate-200'}`}>
            {t}
          </button>
        ))}
      </div>

      {/* controls */}
      <div className="px-3 py-2 border-b border-slate-700 space-y-1.5">
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-slate-500 w-16">RWYCC</label>
          <select value={rwycc} onChange={e => setRwycc(e.target.value)}
            className="flex-1 bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-[11px]">
            {RWYCC_TABLE.map(r => <option key={r.code} value={r.code}>{r.code} · {r.label}</option>)}
          </select>
          <span className="text-[10px] text-slate-500">×{(RWYCC_TABLE.find(r=>r.code===rwycc)?.mul||1).toFixed(2)}</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-slate-500 w-16">SCOPE</label>
          <input type="range" min={8} max={80} value={scopeNM} onChange={e => setScopeNM(+e.target.value)} className="flex-1 accent-sky-500"/>
          <span className="text-[10px] text-slate-400 w-12 text-right">{scopeNM}NM</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-slate-500 w-16">TRK-GATE</label>
          <input type="range" min={15} max={90} value={trkGateDeg} onChange={e => setTrkGateDeg(+e.target.value)} className="flex-1 accent-sky-500"/>
          <span className="text-[10px] text-slate-400 w-12 text-right">{trkGateDeg}°</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-slate-500 w-16">BRK-MUL</label>
          <input type="range" min={70} max={150} value={brkMul} onChange={e => setBrkMul(+e.target.value)} className="flex-1 accent-sky-500"/>
          <span className="text-[10px] text-slate-400 w-12 text-right">{brkMul}%</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-slate-500 w-16">WIND</label>
          <input type="range" min={-20} max={20} value={tailwindKt} onChange={e => setTailwindKt(+e.target.value)} className="flex-1 accent-sky-500"/>
          <span className="text-[10px] text-slate-400 w-16 text-right">
            {tailwindKt > 0 ? `+${tailwindKt}kt TW` : tailwindKt < 0 ? `${Math.abs(tailwindKt)}kt HW` : 'calm'}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap text-[10px]">
          <button onClick={() => setWetDispatch(v=>!v)}
            className={`px-1.5 py-0.5 rounded border ${wetDispatch ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-400'}`}>
            DSP {wetDispatch ? '1.92×' : '1.67×'}
          </button>
          {[['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl]].map((row:any) => (
            <button key={row[0]} onClick={() => row[2]((v:boolean) => !v)}
              className={`px-1.5 py-0.5 rounded border ${row[1] ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-400'}`}>
              {row[0]}
            </button>
          ))}
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search cs/type/op/apt"
            className="flex-1 min-w-[120px] bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] placeholder:text-slate-600"/>
        </div>
      </div>

      {/* body */}
      <div className="flex-1 overflow-auto px-2 py-2 space-y-1">
        {tab === 'AIRCRAFT' && (
          filtered.length === 0
            ? <div className="text-slate-500 text-[11px] px-2 py-3">No aircraft on landing approach within {scopeNM}NM of a catalogued runway.</div>
            : filtered.map(s => {
                const c = TIER_COLOR[s.tier as Tier]
                return (
                  <div key={s.f.icao} className="flex flex-col rounded border border-slate-700/70 bg-slate-800/40 hover:bg-slate-800/70 cursor-pointer"
                       onClick={() => onFly(s.f.icao)}>
                    <div className="flex items-stretch">
                      <div className="w-1 rounded-l" style={{ background: c }}/>
                      <div className="flex-1 px-2 py-1.5 space-y-0.5">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-slate-100">{(s.f.callsign||s.f.icao).trim()}</span>
                          <span className="text-[10px] text-slate-500">{s.acKey || s.f.type || '—'}</span>
                          <span className="text-[10px] px-1 rounded border border-slate-700 text-slate-400">{s.phase}</span>
                          <span className="ml-auto text-[10px] px-1.5 rounded font-medium"
                            style={{ background: `${c}22`, color: c, border: `1px solid ${c}66` }}>{s.tier}</span>
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-slate-400">
                          <span>{s.rwy?.apt}/{s.rwy?.rwy}</span>
                          <span>›</span>
                          <span>{s.distNM.toFixed(1)}NM</span>
                          <span className="text-slate-600">|</span>
                          <span>RLD {s.rld.toFixed(0)}m</span>
                          <span>/ LDA {s.lda}m</span>
                          <span className="ml-auto font-mono" style={{ color: c }}>{s.marginPct >= 0 ? '+' : ''}{s.marginPct.toFixed(0)}%</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })
        )}

        {tab === 'RUNWAYS' && (
          <div className="space-y-1">
            {RUNWAYS.map(r => {
              const here = active.filter(s => s.rwy?.apt === r.apt && s.rwy?.rwy === r.rwy)
              const worst = here.reduce((p, s) => Math.min(p, s.marginPct), 999)
              const color = here.length ? TIER_COLOR[tierOf(worst)] : '#475569'
              return (
                <div key={r.apt+r.rwy} className="flex items-stretch rounded border border-slate-700/70 bg-slate-800/40">
                  <div className="w-1 rounded-l" style={{ background: color }}/>
                  <div className="flex-1 px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-100">{r.apt}/{r.rwy}</span>
                      <span className="text-[10px] text-slate-500">LDA {r.lda}m · elev {r.elev}ft</span>
                      <span className="text-[10px] text-slate-500">hdg {r.hdg}°</span>
                      <span className="ml-auto text-[10px] text-slate-400">{here.length} ac</span>
                    </div>
                    {here.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {here.slice(0, 6).map(s => (
                          <span key={s.f.icao}
                            className="text-[10px] px-1 rounded"
                            style={{ background:`${TIER_COLOR[s.tier as Tier]}22`, color:TIER_COLOR[s.tier as Tier], border:`1px solid ${TIER_COLOR[s.tier as Tier]}55` }}>
                            {(s.f.callsign||s.f.icao).trim()} {s.marginPct.toFixed(0)}%
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'RWYCC' && (
          <div className="space-y-1">
            <div className="text-[10px] text-slate-500 px-1 pb-1">
              FAA TALPA ARC / ICAO GRF surface contamination matrix. RLD = ALD<sub>dry</sub> × dispatch factor × RWYCC multiplier × wind × slope × density.
            </div>
            {RWYCC_TABLE.map(r => (
              <div key={r.code} className={`flex items-stretch rounded border ${rwycc===r.code ? 'border-sky-500/40 bg-sky-500/10' : 'border-slate-700/70 bg-slate-800/40'} cursor-pointer`}
                   onClick={() => setRwycc(r.code)}>
                <div className="w-1 rounded-l" style={{ background: rwycc===r.code ? '#0ea5e9' : '#475569' }}/>
                <div className="flex-1 px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-slate-100 w-4">{r.code}</span>
                    <span className="text-slate-200">{r.label}</span>
                    <span className="ml-auto text-[11px] font-mono text-slate-300">×{r.mul.toFixed(2)}</span>
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">{r.note}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* footer */}
      <div className="px-3 py-1.5 border-t border-slate-700 text-[10px] text-slate-500 flex items-center justify-between">
        <span>{active.length} ac · {RUNWAYS.length} rwy · {Object.keys(ACFT).length} types</span>
        <span className="font-mono">AC 25-32 / 91-79B · ICAO Doc 9981 GRF</span>
      </div>
    </div>
  )
}
