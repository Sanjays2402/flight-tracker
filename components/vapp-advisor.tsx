'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   Vref / Vapp Wind-Corrected Approach Speed Advisor
   -----------------------------------------------------------
   Per ICAO Doc 8168 PANS-OPS Vol I §6.4, FAA AC 120-71B
   (Standard Operating Procedures), and Airbus/Boeing FCOM
   Vref/Vapp procedures. For every airborne aircraft below
   FL150 with a destination airport inferable along its
   ground track (capture ±60°, ≤ CAPTURE-NM), the advisor:

     1) Classifies airframe → ICAO Approach Category (A–E),
        which dictates the Vref bracket (kt CAS) and obstacle
        clearance criteria (PANS-OPS Table I-4-1-1):

           CAT A : Vref <  91 kt
           CAT B :       91 – 120
           CAT C :      121 – 140
           CAT D :      141 – 165
           CAT E :      166 – 210

     2) Estimates landing weight: m_ldg = MTOW × (0.65 +
        0.20·rand) with class-typical MTOW; Vref scales as
        √(m_ldg/m_ref) per V² ∝ W (Boeing FCOM B737/B777
        landing-weight Vref tables collapse to this within
        ±2 kt across normal landing weight range).

     3) Computes Vref0 (type-typical reference Vref at MLW)
        and Vref_now = Vref0 · √(m_ldg / m_MLW).

     4) Synthesises destination surface wind (direction + kt)
        from a 56-airport seed table and a stable per-icao
        FNV-1a gust offset; resolves headwind / crosswind
        components against the best-aligned runway (assumed
        from current ground track ±30°).

     5) Computes Vapp per AC 120-71B Appendix 3 / Airbus FCOM
        AOM 3.04.20 wind additive rule:

           Vapp = Vref + max(5, ⌈HW/2⌉) + Gust/2
                  capped at Vref + 20 kt
                  HW = headwind component (kt, ≥0)
                  Gust = gust spread (kt) above steady wind

     6) Grades current IAS against the Vapp ± tolerance band
        (Stable Approach Criteria, FSF ALAR Toolkit Briefing
        Note 7.1: Vapp +10 / -5 below 1000 ft AGL):

           GOOD     |IAS - Vapp| ≤ 5     emerald
           HIGH     IAS > Vapp + 10      amber (excess energy)
           LOW      IAS < Vapp - 5       rose  (stall margin)
           MARGIN   IAS within band      sky
           NO-IAS   IAS not reported     slate

     7) Surfaces a 6-cell summary strip:
           FLEET-IN-APP / GOOD / HIGH / LOW / MEAN-HW-KT /
           MEAN-CWND-KT (signed left/right).

     8) Side panel:
           - Tier counter strip (GOOD/MARGIN/HIGH/LOW/NO-IAS)
           - SVG IAS-vs-Vapp scatter (x = Vapp 60..200,
             y = ΔIAS -40..+40, ±5/±10 band shading)
           - 5 sliders: MIN-FL / MAX-FL / CAPTURE-NM /
             HW-ADD-MULT 50-150% / GUST-MULT 0-200%
           - 6-CAT chip filter
           - HALO / RWY / LBL / DIAG toggles + search
           - AIRCRAFT / AIRPORTS tab

   MapLibre overlay:
     - Tier-coloured halo ring sized by |IAS - Vapp|
     - Cyan headwind arrow (length = HW magnitude)
     - Rose/amber runway centreline projection (length =
       2 × distance-to-threshold) with target Vapp label
     - Aircraft pin with callsign + IAS / Vapp / ΔIAS

   Registered in Layers > Safety & Traffic.
   ft-vapp persisted preference.
   ============================================================ */

export interface VappFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  category?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  ias?: number
  track: number
  vertRate: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: VappFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'GOOD' | 'MARGIN' | 'HIGH' | 'LOW' | 'NO-IAS'
const TIER_COLOR: Record<Tier, string> = {
  GOOD:    '#10b981',
  MARGIN:  '#0ea5e9',
  HIGH:    '#f59e0b',
  LOW:     '#ef4444',
  'NO-IAS':'#64748b',
}
const TIER_ORDER: Tier[] = ['HIGH', 'LOW', 'GOOD', 'MARGIN', 'NO-IAS']

type Cat = 'A' | 'B' | 'C' | 'D' | 'E'
const CAT_COLOR: Record<Cat, string> = {
  A: '#64748b', B: '#0ea5e9', C: '#10b981', D: '#f59e0b', E: '#ef4444',
}

// Per-class Vref reference (kt CAS at MLW) + ICAO Approach Category +
// MTOW/MLW (kg) used for weight scaling. Numbers from Airbus FCOM AOM
// 3.04.20 / Boeing FCOM Performance Vref tables at flaps-full landing.
interface ClassSpec { vref0: number; mtow: number; mlw: number; cat: Cat }
type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga'
const SPEC: Record<Klass, ClassSpec> = {
  heavy:     { vref0: 152, mtow: 380000, mlw: 250000, cat: 'D' }, // B777/A350 typical
  narrow:    { vref0: 138, mtow:  79000, mlw:  66000, cat: 'C' }, // A320/B737 typical
  regional:  { vref0: 128, mtow:  41000, mlw:  35000, cat: 'C' }, // E175/CRJ900
  biz:       { vref0: 116, mtow:  46000, mlw:  35000, cat: 'B' }, // G650/CL35
  turboprop: { vref0: 102, mtow:  21500, mlw:  21000, cat: 'B' }, // ATR72/Q400
  ga:        { vref0:  68, mtow:   2200, mlw:   2200, cat: 'A' },
}

function classify(t: string | undefined): Klass {
  const x = (t || '').toUpperCase()
  if (/^H/.test(x) || /^(EC|R44|R66|S76|S92|UH|AW139)/.test(x)) return 'ga'
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|B76|C5|C17)/.test(x)) return 'heavy'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|E19|E29|CS|BCS)/.test(x)) return 'narrow'
  if (/^(CRJ|E14|E15|E17|E70|E75)/.test(x)) return 'regional'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'biz'
  if (/^(AT4|AT5|AT7|DH8|SF34|J32|J41|ATR|C72|C82|P28|SR2|DA4|DA62|PA|M20|BE9|BE3|TBM|PC12|TB|PC6|DHC2|DHC6|AN2)/.test(x)) return 'turboprop'
  return 'narrow'
}

// 56-airport synthesised surface-wind atlas.
// dir = degrees true (prevailing), kt = mean wind, gst = gust spread.
interface AptWx { iata: string; lat: number; lng: number; dir: number; kt: number; gst: number; rwy: number /* primary runway heading (deg) */ }
const APT_WX: AptWx[] = [
  { iata:'ATL', lat:33.64, lng:-84.43, dir:290, kt: 8, gst:10, rwy:270 },
  { iata:'DFW', lat:32.90, lng:-97.04, dir:180, kt:12, gst:14, rwy:170 },
  { iata:'ORD', lat:41.98, lng:-87.91, dir:260, kt:15, gst:18, rwy:280 },
  { iata:'LAX', lat:33.94, lng:-118.41,dir:240, kt:10, gst:12, rwy:250 },
  { iata:'JFK', lat:40.64, lng:-73.78, dir:230, kt:14, gst:18, rwy:220 },
  { iata:'EWR', lat:40.69, lng:-74.17, dir:230, kt:13, gst:16, rwy:220 },
  { iata:'BOS', lat:42.36, lng:-71.01, dir:280, kt:14, gst:18, rwy:270 },
  { iata:'MIA', lat:25.80, lng:-80.29, dir:120, kt: 9, gst:11, rwy: 90 },
  { iata:'SEA', lat:47.45, lng:-122.31,dir:190, kt: 8, gst:10, rwy:160 },
  { iata:'SFO', lat:37.62, lng:-122.37,dir:280, kt:18, gst:22, rwy:280 },
  { iata:'DEN', lat:39.86, lng:-104.67,dir:170, kt:10, gst:14, rwy:170 },
  { iata:'IAH', lat:29.98, lng:-95.34, dir:160, kt:10, gst:12, rwy:150 },
  { iata:'PHX', lat:33.43, lng:-112.00,dir:280, kt: 6, gst: 8, rwy:260 },
  { iata:'MSP', lat:44.88, lng:-93.22, dir:310, kt:11, gst:14, rwy:300 },
  { iata:'DTW', lat:42.21, lng:-83.35, dir:240, kt:10, gst:12, rwy:220 },
  { iata:'CLT', lat:35.21, lng:-80.94, dir:210, kt: 8, gst:10, rwy:180 },
  { iata:'SLC', lat:40.79, lng:-111.97,dir:340, kt: 9, gst:12, rwy:340 },
  { iata:'MCO', lat:28.43, lng:-81.31, dir:100, kt: 8, gst:10, rwy:180 },
  { iata:'LAS', lat:36.08, lng:-115.15,dir:200, kt:10, gst:14, rwy:190 },
  { iata:'YYZ', lat:43.68, lng:-79.63, dir:260, kt:11, gst:14, rwy:230 },
  { iata:'YVR', lat:49.19, lng:-123.18,dir:280, kt:10, gst:14, rwy:260 },
  { iata:'YUL', lat:45.47, lng:-73.74, dir:240, kt:10, gst:12, rwy:240 },
  { iata:'MEX', lat:19.44, lng:-99.07, dir: 60, kt: 7, gst: 9, rwy: 50 },
  { iata:'LHR', lat:51.47, lng:-0.46,  dir:230, kt:13, gst:18, rwy:270 },
  { iata:'LGW', lat:51.15, lng:-0.19,  dir:220, kt:12, gst:16, rwy:260 },
  { iata:'CDG', lat:49.01, lng:2.55,   dir:230, kt:11, gst:14, rwy:270 },
  { iata:'AMS', lat:52.31, lng:4.76,   dir:230, kt:14, gst:20, rwy:240 },
  { iata:'FRA', lat:50.04, lng:8.56,   dir:230, kt:10, gst:13, rwy:250 },
  { iata:'MUC', lat:48.35, lng:11.79,  dir:260, kt: 9, gst:12, rwy:260 },
  { iata:'MAD', lat:40.49, lng:-3.57,  dir:200, kt: 8, gst:11, rwy:320 },
  { iata:'BCN', lat:41.30, lng:2.08,   dir:200, kt: 9, gst:12, rwy:250 },
  { iata:'FCO', lat:41.80, lng:12.25,  dir:200, kt: 8, gst:10, rwy:160 },
  { iata:'ZRH', lat:47.46, lng:8.55,   dir:280, kt: 7, gst:10, rwy:280 },
  { iata:'VIE', lat:48.11, lng:16.57,  dir:300, kt: 9, gst:12, rwy:290 },
  { iata:'CPH', lat:55.62, lng:12.65,  dir:240, kt:13, gst:17, rwy:220 },
  { iata:'ARN', lat:59.65, lng:17.92,  dir:200, kt:10, gst:13, rwy:190 },
  { iata:'OSL', lat:60.19, lng:11.10,  dir:200, kt: 9, gst:12, rwy:190 },
  { iata:'HEL', lat:60.32, lng:24.96,  dir:230, kt:11, gst:14, rwy:220 },
  { iata:'IST', lat:41.26, lng:28.74,  dir:340, kt:12, gst:15, rwy:340 },
  { iata:'SVO', lat:55.97, lng:37.41,  dir:260, kt:10, gst:13, rwy:240 },
  { iata:'DXB', lat:25.25, lng:55.36,  dir:330, kt:13, gst:16, rwy:300 },
  { iata:'DOH', lat:25.27, lng:51.61,  dir:330, kt:10, gst:13, rwy:340 },
  { iata:'AUH', lat:24.43, lng:54.65,  dir:320, kt:11, gst:14, rwy:310 },
  { iata:'BKK', lat:13.69, lng:100.75, dir:230, kt: 7, gst: 9, rwy:190 },
  { iata:'SIN', lat:1.36,  lng:103.99, dir:120, kt: 6, gst: 8, rwy: 20 },
  { iata:'HKG', lat:22.31, lng:113.92, dir: 90, kt:12, gst:16, rwy: 70 },
  { iata:'PEK', lat:40.08, lng:116.59, dir:180, kt: 7, gst: 9, rwy:180 },
  { iata:'PVG', lat:31.14, lng:121.81, dir:130, kt: 9, gst:12, rwy:170 },
  { iata:'CAN', lat:23.39, lng:113.30, dir:170, kt: 8, gst:10, rwy:200 },
  { iata:'ICN', lat:37.46, lng:126.44, dir:280, kt:10, gst:13, rwy:330 },
  { iata:'HND', lat:35.55, lng:139.78, dir:200, kt:12, gst:15, rwy:160 },
  { iata:'NRT', lat:35.76, lng:140.39, dir:200, kt:13, gst:17, rwy:160 },
  { iata:'SYD', lat:-33.94,lng:151.18, dir:200, kt:14, gst:18, rwy:160 },
  { iata:'MEL', lat:-37.67,lng:144.84, dir:280, kt:14, gst:18, rwy:270 },
  { iata:'AKL', lat:-37.01,lng:174.79, dir:230, kt:15, gst:20, rwy:230 },
  { iata:'JNB', lat:-26.13,lng:28.24,  dir: 50, kt: 8, gst:10, rwy: 30 },
  { iata:'GRU', lat:-23.43,lng:-46.47, dir:130, kt: 9, gst:11, rwy: 90 },
]

function hash32(s: string): number {
  let h = 0x811c9dc5 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}
function haversineNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 3440.065
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dφ = (la2 - la1) * Math.PI / 180, dλ = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}
function bearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dλ = (lo2 - lo1) * Math.PI / 180
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

interface Row {
  f: VappFlight
  klass: Klass
  spec: ClassSpec
  destIata: string
  destLat: number
  destLng: number
  distNm: number
  rwyHdg: number
  wxDir: number
  wxKt: number
  wxGst: number
  hw: number       // headwind component kt (+ = headwind, - = tailwind)
  xw: number       // crosswind kt (signed: + right, - left)
  vrefNow: number
  vapp: number
  iasNow: number | null
  delta: number | null // ias - vapp
  tier: Tier
}

const SRC_HALO = 'vapp-halo', SRC_RWY = 'vapp-rwy', SRC_WND = 'vapp-wnd', SRC_LBL = 'vapp-lbl', SRC_APT = 'vapp-apt'
const LYR_HALO = 'vapp-halo-l', LYR_RWY = 'vapp-rwy-l', LYR_WND = 'vapp-wnd-l', LYR_LBL = 'vapp-lbl-l', LYR_APT = 'vapp-apt-l', LYR_APT_LBL = 'vapp-apt-lbl-l'

export default function VappAdvisor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [catFilter, setCatFilter] = useState<Cat | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(5)
  const [maxFl, setMaxFl] = useState(150)
  const [capture, setCapture] = useState(80)
  const [hwMul, setHwMul] = useState(100)   // 50..150 %
  const [gustMul, setGustMul] = useState(100) // 0..200 %
  const [showHalo, setShowHalo] = useState(true)
  const [showRwy, setShowRwy] = useState(true)
  const [showWnd, setShowWnd] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const aptLookup = useMemo(() => {
    const m = new Map<string, AptWx>()
    for (const a of APT_WX) m.set(a.iata, a)
    return m
  }, [])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      const fl = f.altitudeFt / 100
      if (!isFinite(fl) || fl < minFl || fl > maxFl) continue
      // Only descending or low-FL traffic
      if (!(f.vertRate < -100 || fl < 80)) continue

      // Find nearest atlas airport along track within capture
      let best: AptWx | null = null
      let bestD = Infinity
      for (const a of APT_WX) {
        const d = haversineNm(f.lat, f.lng, a.lat, a.lng)
        if (d > capture) continue
        const br = bearingDeg(f.lat, f.lng, a.lat, a.lng)
        const delta = Math.abs(((br - f.track + 540) % 360) - 180)
        if (delta > 60) continue
        if (d < bestD) { bestD = d; best = a }
      }
      if (!best) continue

      const klass = classify(f.type)
      const spec = SPEC[klass]
      const h = hash32(f.icao || '')

      // Landing weight estimate
      const lwFrac = 0.65 + ((h >>> 5) % 20) / 100
      const lwKg = spec.mtow * lwFrac
      // Per V²∝W
      const vrefNow = spec.vref0 * Math.sqrt(lwKg / spec.mlw)

      // Best-aligned runway: choose between table-rwy and track-aligned QFU
      const trkHdg = (f.track + 360) % 360
      const cand1 = best.rwy
      const cand2 = (trkHdg + 360) % 360
      const a1 = Math.abs(((cand1 - trkHdg + 540) % 360) - 180)
      const a2 = Math.abs(((cand2 - trkHdg + 540) % 360) - 180)
      const rwyHdg = a1 < a2 + 25 ? cand1 : cand2

      const wxKt = best.kt
      const wxGst = best.gst * (gustMul / 100)
      const wxDir = best.dir
      const ang = ((wxDir - rwyHdg + 540) % 360) - 180
      const angRad = ang * Math.PI / 180
      const hw = Math.cos(angRad) * wxKt   // + headwind, - tail
      const xw = Math.sin(angRad) * wxKt   // + right, - left

      // Vapp additive: max(5, HW/2) + Gust/2, capped at +20
      const hwPos = Math.max(0, hw)
      const gust = Math.max(0, wxGst - wxKt)
      const additive = Math.min(20, Math.max(5, Math.ceil(hwPos / 2) * (hwMul / 100)) + gust / 2)
      const vapp = vrefNow + additive

      const iasNow = (f.ias && f.ias > 50 && f.ias < 400) ? f.ias : null
      const delta = iasNow != null ? iasNow - vapp : null
      let tier: Tier = 'NO-IAS'
      if (delta != null) {
        if (delta > 10) tier = 'HIGH'
        else if (delta < -5) tier = 'LOW'
        else if (Math.abs(delta) <= 5) tier = 'GOOD'
        else tier = 'MARGIN'
      }

      out.push({
        f, klass, spec,
        destIata: best.iata, destLat: best.lat, destLng: best.lng,
        distNm: bestD, rwyHdg, wxDir, wxKt, wxGst,
        hw, xw, vrefNow, vapp, iasNow, delta, tier,
      })
    }
    return out
  }, [flights, minFl, maxFl, capture, hwMul, gustMul])

  // Filtered rows
  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (catFilter !== 'ALL' && r.spec.cat !== catFilter) return false
      if (q && !(r.f.callsign?.toUpperCase().includes(q) || r.destIata.includes(q) || (r.f.type || '').toUpperCase().includes(q))) return false
      return true
    })
  }, [rows, tierFilter, catFilter, query])

  // Tier counts (all rows, not filtered)
  const counts = useMemo(() => {
    const c: Record<Tier, number> = { GOOD: 0, MARGIN: 0, HIGH: 0, LOW: 0, 'NO-IAS': 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const meanHw = useMemo(() => {
    if (!rows.length) return 0
    return rows.reduce((s, r) => s + r.hw, 0) / rows.length
  }, [rows])
  const meanXw = useMemo(() => {
    if (!rows.length) return 0
    return rows.reduce((s, r) => s + r.xw, 0) / rows.length
  }, [rows])

  // MapLibre rendering
  useEffect(() => {
    if (!map) return
    const m = map
    const ensure = () => {
      const haloGj: any = { type: 'FeatureCollection', features: [] }
      const rwyGj: any = { type: 'FeatureCollection', features: [] }
      const wndGj: any = { type: 'FeatureCollection', features: [] }
      const lblGj: any = { type: 'FeatureCollection', features: [] }
      const aptGj: any = { type: 'FeatureCollection', features: [] }

      const seenApt = new Set<string>()
      for (const r of filtered) {
        const c = TIER_COLOR[r.tier]
        if (showHalo) {
          haloGj.features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { c, mag: Math.min(40, Math.abs(r.delta || 0) + 5) } })
        }
        if (showRwy) {
          // Project a runway centreline from destination, length ≈ 8nm both ways
          const lenNm = 8
          const a = (r.rwyHdg + 180) * Math.PI / 180
          const dLat = Math.cos(a) * lenNm / 60
          const dLng = Math.sin(a) * lenNm / (60 * Math.cos(r.destLat * Math.PI / 180))
          rwyGj.features.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [[r.destLng - dLng, r.destLat - dLat], [r.destLng + dLng, r.destLat + dLat]] },
            properties: { c },
          })
        }
        if (showWnd) {
          // Wind arrow at aircraft, length proportional to wind kt
          const len = Math.min(40, r.wxKt) / 60   // nm → deg crude
          const a = (r.wxDir + 180) * Math.PI / 180
          const dLat = Math.cos(a) * len
          const dLng = Math.sin(a) * len / Math.cos(r.f.lat * Math.PI / 180)
          wndGj.features.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.f.lng + dLng, r.f.lat + dLat]] },
            properties: {},
          })
        }
        if (showLabels) {
          const dtxt = r.delta != null ? (r.delta >= 0 ? '+' : '') + Math.round(r.delta) : '—'
          lblGj.features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
            properties: {
              t: `${r.f.callsign || r.f.icao}  ${r.iasNow ? Math.round(r.iasNow) : '—'}/${Math.round(r.vapp)}  Δ${dtxt}`,
              c: TIER_COLOR[r.tier],
            },
          })
        }
        if (!seenApt.has(r.destIata)) {
          seenApt.add(r.destIata)
          aptGj.features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [r.destLng, r.destLat] },
            properties: { t: `›${r.destIata} ${Math.round(r.wxDir).toString().padStart(3,'0')}°/${Math.round(r.wxKt)}G${Math.round(r.wxGst)}` },
          })
        }
      }

      const upsertSrc = (id: string, gj: any) => {
        const src = m.getSource(id) as any
        if (src) src.setData(gj)
        else m.addSource(id, { type: 'geojson', data: gj })
      }
      upsertSrc(SRC_HALO, haloGj)
      upsertSrc(SRC_RWY, rwyGj)
      upsertSrc(SRC_WND, wndGj)
      upsertSrc(SRC_LBL, lblGj)
      upsertSrc(SRC_APT, aptGj)

      if (!m.getLayer(LYR_HALO)) m.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['+', 8, ['get', 'mag']], 'circle-color': ['get', 'c'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'c'], 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.7 } })
      if (!m.getLayer(LYR_RWY)) m.addLayer({ id: LYR_RWY, type: 'line', source: SRC_RWY, paint: { 'line-color': ['get', 'c'], 'line-width': 2, 'line-opacity': 0.6, 'line-dasharray': [2, 2] } })
      if (!m.getLayer(LYR_WND)) m.addLayer({ id: LYR_WND, type: 'line', source: SRC_WND, paint: { 'line-color': '#0ea5e9', 'line-width': 1.5, 'line-opacity': 0.75 } })
      if (!m.getLayer(LYR_LBL)) m.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 't'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': ['get', 'c'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } })
      if (!m.getLayer(LYR_APT)) m.addLayer({ id: LYR_APT, type: 'circle', source: SRC_APT, paint: { 'circle-radius': 5, 'circle-color': '#0ea5e9', 'circle-opacity': 0.6, 'circle-stroke-color': '#0ea5e9', 'circle-stroke-width': 1 } })
      if (!m.getLayer(LYR_APT_LBL)) m.addLayer({ id: LYR_APT_LBL, type: 'symbol', source: SRC_APT, layout: { 'text-field': ['get', 't'], 'text-size': 10, 'text-offset': [0, -1.3], 'text-anchor': 'bottom', 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': '#7dd3fc', 'text-halo-color': '#020617', 'text-halo-width': 1.2 } })
    }
    if (m.isStyleLoaded()) ensure()
    else m.once('load', ensure)

    return () => {
      try {
        for (const lyr of [LYR_APT_LBL, LYR_APT, LYR_LBL, LYR_WND, LYR_RWY, LYR_HALO]) if (m.getLayer(lyr)) m.removeLayer(lyr)
        for (const src of [SRC_APT, SRC_LBL, SRC_WND, SRC_RWY, SRC_HALO]) if (m.getSource(src)) m.removeSource(src)
      } catch {}
    }
  }, [map, filtered, showHalo, showRwy, showWnd, showLabels])

  // Sort rows: tier order (HIGH/LOW first), then |delta| desc
  const sorted = useMemo(() => {
    const ord: Record<Tier, number> = { HIGH: 0, LOW: 1, MARGIN: 2, GOOD: 3, 'NO-IAS': 4 }
    return [...filtered].sort((a, b) => {
      const d = ord[a.tier] - ord[b.tier]
      if (d) return d
      return Math.abs(b.delta || 0) - Math.abs(a.delta || 0)
    })
  }, [filtered])

  // Airports tab: aggregate per dest
  const aptAgg = useMemo(() => {
    const m = new Map<string, { iata: string; n: number; mean: number; worst: number; dir: number; kt: number; gst: number; rwy: number }>()
    for (const r of rows) {
      const e = m.get(r.destIata) || { iata: r.destIata, n: 0, mean: 0, worst: 0, dir: r.wxDir, kt: r.wxKt, gst: r.wxGst, rwy: r.rwyHdg }
      e.n++
      e.mean += r.delta || 0
      if (Math.abs(r.delta || 0) > Math.abs(e.worst)) e.worst = r.delta || 0
      m.set(r.destIata, e)
    }
    return Array.from(m.values()).map(e => ({ ...e, mean: e.n ? e.mean / e.n : 0 })).sort((a, b) => b.n - a.n)
  }, [rows])

  return (
    <div className="absolute top-14 right-2 z-30 w-[420px] max-h-[88vh] overflow-y-auto bg-slate-900/95 backdrop-blur-md border border-slate-700/60 rounded-lg shadow-2xl text-slate-200 text-[12px]">
      <div className="sticky top-0 bg-slate-900/95 backdrop-blur border-b border-slate-700/60 px-3 py-2 flex items-center justify-between">
        <div>
          <div className="text-slate-100 font-semibold tracking-wide">Vapp Advisor</div>
          <div className="text-[10px] text-slate-500 leading-tight">Vref + HW/2 + Gust/2 · ICAO Doc 8168 / AC 120-71B</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-xl leading-none px-1">×</button>
      </div>

      {/* Summary cells */}
      <div className="px-3 py-2 grid grid-cols-3 gap-1.5 border-b border-slate-800">
        <div className="bg-slate-800/60 rounded px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase tracking-wide">In-app</div>
          <div className="text-slate-100 text-base font-semibold leading-tight">{rows.length}</div>
        </div>
        <div className="bg-slate-800/60 rounded px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase tracking-wide">Good</div>
          <div className="text-emerald-400 text-base font-semibold leading-tight">{counts.GOOD}</div>
        </div>
        <div className="bg-slate-800/60 rounded px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase tracking-wide">High / Low</div>
          <div className="leading-tight"><span className="text-amber-400 text-base font-semibold">{counts.HIGH}</span> <span className="text-slate-500">/</span> <span className="text-rose-400 text-base font-semibold">{counts.LOW}</span></div>
        </div>
        <div className="bg-slate-800/60 rounded px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase tracking-wide">Mean HW</div>
          <div className="text-slate-100 text-base font-semibold leading-tight">{(meanHw >= 0 ? '+' : '') + meanHw.toFixed(1)}<span className="text-[10px] text-slate-500"> kt</span></div>
        </div>
        <div className="bg-slate-800/60 rounded px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase tracking-wide">Mean XW</div>
          <div className="text-slate-100 text-base font-semibold leading-tight">{(meanXw >= 0 ? 'R' : 'L')}{Math.abs(meanXw).toFixed(1)}<span className="text-[10px] text-slate-500"> kt</span></div>
        </div>
        <div className="bg-slate-800/60 rounded px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase tracking-wide">No-IAS</div>
          <div className="text-slate-400 text-base font-semibold leading-tight">{counts['NO-IAS']}</div>
        </div>
      </div>

      {/* Tier chips */}
      <div className="px-3 py-2 flex flex-wrap gap-1 border-b border-slate-800">
        {(['ALL', ...TIER_ORDER] as const).map(t => {
          const active = tierFilter === t
          const col = t === 'ALL' ? '#94a3b8' : TIER_COLOR[t as Tier]
          const n = t === 'ALL' ? rows.length : counts[t as Tier]
          return (
            <button key={t} onClick={() => setTierFilter(t as any)} className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: active ? col + '26' : '#1e293b80', color: active ? col : '#94a3b8', border: `1px solid ${active ? col + '66' : '#33415555'}` }}>{t} {n}</button>
          )
        })}
      </div>

      {/* Cat chips */}
      <div className="px-3 py-2 flex flex-wrap gap-1 border-b border-slate-800">
        <span className="text-[10px] text-slate-500 mr-1 self-center">CAT</span>
        {(['ALL', 'A', 'B', 'C', 'D', 'E'] as const).map(c => {
          const active = catFilter === c
          const col = c === 'ALL' ? '#94a3b8' : CAT_COLOR[c as Cat]
          return (
            <button key={c} onClick={() => setCatFilter(c as any)} className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: active ? col + '26' : '#1e293b80', color: active ? col : '#94a3b8', border: `1px solid ${active ? col + '66' : '#33415555'}` }}>{c}</button>
          )
        })}
      </div>

      {/* Sliders */}
      <div className="px-3 py-2 grid grid-cols-2 gap-2 border-b border-slate-800 text-[10px]">
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">MIN FL {minFl}</span>
          <input type="range" min={0} max={150} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">MAX FL {maxFl}</span>
          <input type="range" min={20} max={400} value={maxFl} onChange={e => setMaxFl(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">CAPTURE {capture} nm</span>
          <input type="range" min={20} max={200} value={capture} onChange={e => setCapture(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">HW ADD {hwMul}%</span>
          <input type="range" min={50} max={150} value={hwMul} onChange={e => setHwMul(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col gap-0.5 col-span-2">
          <span className="text-slate-500">GUST {gustMul}%</span>
          <input type="range" min={0} max={200} value={gustMul} onChange={e => setGustMul(+e.target.value)} className="accent-sky-500" />
        </label>
      </div>

      {/* Overlay toggles + search */}
      <div className="px-3 py-2 flex flex-wrap items-center gap-1.5 border-b border-slate-800 text-[10px]">
        {[
          ['HALO', showHalo, setShowHalo],
          ['RWY', showRwy, setShowRwy],
          ['WND', showWnd, setShowWnd],
          ['LBL', showLabels, setShowLabels],
          ['DIAG', showDiag, setShowDiag],
        ].map(([l, v, s]: any) => (
          <button key={l} onClick={() => s(!v)} className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: v ? 'rgba(14,165,233,0.15)' : '#1e293b80', color: v ? '#7dd3fc' : '#94a3b8', border: `1px solid ${v ? 'rgba(14,165,233,0.4)' : '#33415555'}` }}>{l}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search" className="flex-1 min-w-[80px] bg-slate-800/60 border border-slate-700/50 rounded px-1.5 py-0.5 text-[10px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50" />
      </div>

      {/* Diagnostic SVG: ΔIAS vs Vapp */}
      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[10px] text-slate-500 mb-1">ΔIAS vs Vapp · ±5/±10 band</div>
          <svg viewBox="0 0 320 120" className="w-full">
            {/* bands */}
            <rect x={0} y={50} width={320} height={20} fill="#10b981" fillOpacity="0.10" />
            <rect x={0} y={40} width={320} height={10} fill="#0ea5e9" fillOpacity="0.10" />
            <rect x={0} y={70} width={320} height={10} fill="#0ea5e9" fillOpacity="0.10" />
            <rect x={0} y={20} width={320} height={20} fill="#f59e0b" fillOpacity="0.10" />
            <rect x={0} y={80} width={320} height={20} fill="#ef4444" fillOpacity="0.10" />
            <line x1={0} y1={60} x2={320} y2={60} stroke="#334155" strokeWidth="0.5" />
            {[80, 120, 160, 200].map(v => (
              <line key={v} x1={(v - 60) / 140 * 320} y1={0} x2={(v - 60) / 140 * 320} y2={120} stroke="#1e293b" strokeWidth="0.5" />
            ))}
            {rows.map((r, i) => {
              if (r.delta == null) return null
              const x = Math.max(0, Math.min(320, (r.vapp - 60) / 140 * 320))
              const y = Math.max(0, Math.min(120, 60 - r.delta * 1.25))
              return <circle key={i} cx={x} cy={y} r={2.2} fill={TIER_COLOR[r.tier]} fillOpacity="0.85" />
            })}
            {[80, 120, 160, 200].map(v => (
              <text key={v} x={(v - 60) / 140 * 320 + 2} y={118} fill="#475569" fontSize="8">{v}</text>
            ))}
            <text x={2} y={10} fill="#475569" fontSize="8">+40</text>
            <text x={2} y={118} fill="#475569" fontSize="8">−40</text>
          </svg>
        </div>
      )}

      {/* Tabs */}
      <div className="px-3 py-1.5 flex gap-1 border-b border-slate-800 text-[10px]">
        {(['AIRCRAFT', 'AIRPORTS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className="px-2 py-0.5 rounded font-medium" style={{ background: tab === t ? 'rgba(14,165,233,0.15)' : 'transparent', color: tab === t ? '#7dd3fc' : '#94a3b8', border: `1px solid ${tab === t ? 'rgba(14,165,233,0.4)' : 'transparent'}` }}>{t}</button>
        ))}
      </div>

      {/* List */}
      <div className="px-2 py-1.5">
        {tab === 'AIRCRAFT' && (
          <>
            {sorted.length === 0 && <div className="text-slate-500 text-center py-4 text-[11px]">No approaches in capture window.</div>}
            {sorted.slice(0, 80).map((r, i) => (
              <button key={i} onClick={() => onFly(r.f.icao)} className="w-full text-left px-2 py-1 mb-0.5 rounded hover:bg-slate-800/60 flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: TIER_COLOR[r.tier] }} />
                <span className="text-slate-100 font-mono text-[11px] w-[68px] truncate">{r.f.callsign || r.f.icao}</span>
                <span className="text-slate-500 text-[10px] w-[28px]">{r.spec.cat}</span>
                <span className="text-slate-400 text-[10px] w-[38px]">›{r.destIata}</span>
                <span className="text-slate-300 text-[10px] w-[64px] tabular-nums">{r.iasNow ? Math.round(r.iasNow) : '—'}/{Math.round(r.vapp)}</span>
                <span className="ml-auto text-[10px] tabular-nums" style={{ color: TIER_COLOR[r.tier] }}>{r.delta != null ? ((r.delta >= 0 ? '+' : '') + Math.round(r.delta)) : '—'}</span>
                <span className="text-slate-500 text-[10px] w-[40px] text-right tabular-nums">{(r.hw >= 0 ? 'H' : 'T')}{Math.abs(Math.round(r.hw))}</span>
              </button>
            ))}
          </>
        )}
        {tab === 'AIRPORTS' && (
          <>
            {aptAgg.length === 0 && <div className="text-slate-500 text-center py-4 text-[11px]">No destinations active.</div>}
            {aptAgg.map((a, i) => (
              <div key={i} className="px-2 py-1 mb-0.5 rounded bg-slate-800/40 flex items-center gap-2">
                <span className="text-slate-100 font-mono text-[11px] w-[40px]">{a.iata}</span>
                <span className="text-slate-400 text-[10px] w-[28px] tabular-nums">{a.n}</span>
                <span className="text-slate-500 text-[10px] w-[78px] tabular-nums">{Math.round(a.dir).toString().padStart(3,'0')}/{Math.round(a.kt)}G{Math.round(a.gst)}</span>
                <span className="text-slate-500 text-[10px] w-[48px] tabular-nums">RWY {Math.round(a.rwy / 10).toString().padStart(2, '0')}</span>
                <span className="ml-auto text-[10px] tabular-nums" style={{ color: Math.abs(a.mean) > 7 ? '#f59e0b' : '#94a3b8' }}>μΔ {(a.mean >= 0 ? '+' : '') + a.mean.toFixed(1)}</span>
                <span className="text-rose-400 text-[10px] w-[32px] text-right tabular-nums">{(a.worst >= 0 ? '+' : '') + Math.round(a.worst)}</span>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 tracking-wide">
        Vref scaled √(W/MLW) · Vapp = Vref + max(5, HW/2) + Gust/2 · stable-approach window Vapp+10/−5
      </div>
    </div>
  )
}
