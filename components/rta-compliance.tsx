'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   RTA / 4D Trajectory Compliance Monitor
   -----------------------------------------------------------
   Required Time of Arrival (RTA) is the cornerstone of 4D
   trajectory-based operations under FAA NextGen TBO,
   EUROCONTROL i4D / SESAR, and ICAO PBN Doc 9613 RNP-RTA. ATC
   issues a Controlled Time of Arrival (CTA) at a metering fix
   or runway threshold; the FMS-managed aircraft must cross
   that fix within ±30 s of the CTA (ICAO PBN GM Vol. II §C.5)
   to preserve arrival-stream spacing, runway acceptance rate,
   and CDA / continuous-descent benefits. Failure to hold the
   CTA triggers a re-sequencing (extra vectoring, holding, or
   speed-control restart) and is the dominant cause of CDA
   breakdown at saturated hubs (LHR, JFK, CDG, ORD).

   This overlay synthesises a live RTA-compliance picture for
   every descending arrival within CAPTURE-NM of an aligned
   IATA destination:

   1) PICK DESTINATION. Closest IATA field whose bearing from
      the aircraft is within ±90° of track (i.e. aircraft is
      heading toward the field). Discards heads-away traffic.

   2) DIST-TO-GO nm = great-circle to the airport reference
      point. ETA-sec = dist_nm / GS_kt * 3600 from current
      groundspeed (held constant).

   3) CTA (CONTROLLED TIME OF ARRIVAL). Synthesised
      deterministically per ICAO24 hash: CTA_target = ETA at
      first detection ± hash-derived offset in
      [-OFFSET-MAX, +OFFSET-MAX] minutes. The offset models
      the realistic ATC-issued slot vs the aircraft's
      natural ETA. Because the hash is stable per airframe,
      the assigned CTA does not drift between renders.

   4) ERROR seconds = ETA - CTA_target (positive = LATE,
      negative = EARLY). Used as the primary metric.

   5) REQUIRED dV kt to nullify error in the remaining
      flight time. dV_req = -error * GS / ETA. Bounded by
      class-typical Mach band (HVY ±0.04 / NRW ±0.04 / RGN
      ±0.03 / BIZ ±0.05 / TBP ±0.02 / GA ±0.01 / FTR ±0.10).
      If |required dV| > class max → flagged UNABLE in
      advice text (RTA cannot be met by speed alone, vectoring
      or holding required).

   6) Mach delta dM = dV_req / speed_of_sound at altitude
      using ISA dual-troposphere/stratosphere temperature
      profile (T_s = 288.15 - 1.98°C/kft below 36 kft,
      216.65 K above) and a = sqrt(1.4 * 287.05 * T) * 1.94384
      kt.

   7) TIER CLASSIFICATION (ICAO RTA tolerance bands):
        ON-TIME   |err| ≤ TOL-SEC slider (default 30 s)  emerald
        SLIP      |err| ≤ 120 s                          sky
        DELAY     |err| ≤ 300 s                          amber
        MISS      |err| > 300 s OR UNABLE                rose
        OUTSIDE   no aligned IATA destination            slate

   8) EARLY vs LATE bucket per aircraft for the secondary
      summary row.

   MAP OVERLAY (MapLibre):
     - Tier-coloured halo rings sized by |err|/30 clamped 7-22 px
     - Dashed tier-coloured projection line aircraft → destination
       ARP with diamond marker (for non-OUTSIDE rows)
     - Tier-coloured airport pin ›IATA bold label
     - Tier-coloured callsign + ±err-sec + ›IATA labels for
       non-ON-TIME aircraft (OK suppressed to keep map quiet)

   SIDE PANEL:
     - 5-tier counter strip (incl. OUTSIDE) click-to-filter
     - 3-cell MEAN-|ERR|-sec tier-coloured / WORST callsign+err /
       MISS-count summary
     - 2-cell EARLY-count sky-if-any / LATE-count amber-if-any
       secondary row
     - SVG err-vs-dist scatter:
         x=dist 0-300 nm with 50/100/150/200/250/300 verticals
         y=signed err -600..+600 sec with 0 centerline
         emerald ±TOL band shaded with dashed thresholds
         sky ±120 band, amber ±300 band, dashed threshold lines
         every aircraft plotted as tier-coloured dot at (dist, err)
     - 5 sliders MIN-FL / MAX-FL / CAPTURE / TOL-SEC / OFFSET-MAX
     - 7-class chip filter + HALO / PROJ / LBL / DIAG toggles
     - Search (callsign / type / operator / icao / IATA)
     - AIRCRAFT / AIRPORTS tab switcher
     - AIRCRAFT tab: sorted tier-worst-first then |err| desc with
       tier color stripe, callsign+type+class-pill+tier-pill,
       FL+IATA+dist-nm+signed-err-sec line, centred tier-coloured
       err bar -300..+300 sec with emerald ±TOL ticks + sky ±120 +
       amber ±300, GS+ETA+CTA+dV-req+dM-req line, EARLY/LATE pill +
       advice click-to-fly per row
     - AIRPORTS tab: sorted ac-count desc with worst-tier stripe,
       IATA+name+ac-count+worst-tier-pill, mean-|err| progress bar
       0-300 sec, mean-err signed + worst callsign+err footer
       click-to-fly to airport ARP

   Registered under Layers > Routes & Flow category.
   ft-rta persisted preference.
   ============================================================ */

export interface RtaFlight {
  icao: string
  callsign: string
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
  flights: RtaFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'ON-TIME' | 'SLIP' | 'DELAY' | 'MISS' | 'OUTSIDE'
const TIER_COLOR: Record<Tier, string> = {
  'ON-TIME': '#10b981', SLIP: '#0ea5e9', DELAY: '#f59e0b', MISS: '#ef4444', OUTSIDE: '#64748b',
}
const TIER_ORDER: Tier[] = ['MISS', 'DELAY', 'SLIP', 'ON-TIME', 'OUTSIDE']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = { heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR' }

interface ClassSpec { dMmax: number }
const SPEC: Record<Klass, ClassSpec> = {
  heavy:     { dMmax: 0.04 },
  narrow:    { dMmax: 0.04 },
  regional:  { dMmax: 0.03 },
  biz:       { dMmax: 0.05 },
  turboprop: { dMmax: 0.02 },
  ga:        { dMmax: 0.01 },
  fighter:   { dMmax: 0.10 },
}

function classify(t: string | undefined, cat?: string): Klass {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || /^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139)/.test(x)) return 'ga'
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|A30|B76|C5|C17)/.test(x)) return 'heavy'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|E19|E29|CRJ9|CS|BCS)/.test(x)) return 'narrow'
  if (/^(CRJ|E14|E15|E17|E70|E75|AT4|AT5|AT7|DH8|SF34|J32|J41|ATR)/.test(x)) return 'regional'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'biz'
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS)/.test(x)) return 'fighter'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|BE9|BE3|TBM|PC12|TB|PC6|C20|DHC2|DHC6|AN2)/.test(x)) return 'turboprop'
  return 'narrow'
}

function fnv(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0) / 4294967295
}

function gcNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}
function bearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180
  const dλ = (lng2 - lng1) * Math.PI / 180
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}
function angDiff(a: number, b: number): number {
  let d = ((a - b + 540) % 360) - 180
  return Math.abs(d)
}

// ISA speed of sound (kt) at altitude
function aSound(altFt: number): number {
  const altM = altFt * 0.3048
  let T = altM <= 11000 ? 288.15 - 0.0065 * altM : 216.65
  return Math.sqrt(1.4 * 287.05 * T) * 1.94384
}

interface Row {
  f: RtaFlight
  klass: Klass
  altFt: number
  fl: number
  iata: string
  apName: string
  apLat: number
  apLng: number
  distNm: number
  gsKt: number
  etaSec: number
  ctaSec: number
  errSec: number  // eta - cta; positive = late
  dVreq: number   // kt
  dMreq: number
  dMmax: number
  unable: boolean
  tier: Tier
  bucket: 'EARLY' | 'LATE' | 'ON'
}

const SRC_RING = 'rta-ring', SRC_PROJ = 'rta-proj', SRC_DOT = 'rta-dot', SRC_PIN = 'rta-pin', SRC_LBL = 'rta-lbl', SRC_PLBL = 'rta-plbl'
const LYR_RING = 'rta-ring-l', LYR_PROJ = 'rta-proj-l', LYR_DOT = 'rta-dot-l', LYR_PIN = 'rta-pin-l', LYR_LBL = 'rta-lbl-l', LYR_PLBL = 'rta-plbl-l'

// minimal index by lat/lng grid for fast nearest lookup (5° cells)
const AP_GRID = (() => {
  const g = new Map<string, typeof AIRPORTS>()
  for (const a of AIRPORTS) {
    if (!a.a) continue
    const key = `${Math.floor(a.lat / 5)}|${Math.floor(a.lon / 5)}`
    let arr = g.get(key); if (!arr) { arr = []; g.set(key, arr) }
    arr.push(a)
  }
  return g
})()
function nearbyAirports(lat: number, lng: number, rangeNm: number): typeof AIRPORTS {
  const span = Math.ceil(rangeNm / 60 / 5) + 1 // ~60nm per deg
  const cy = Math.floor(lat / 5), cx = Math.floor(lng / 5)
  const out: any[] = []
  for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) {
    const arr = AP_GRID.get(`${cy + dy}|${cx + dx}`)
    if (arr) out.push(...arr)
  }
  return out
}

export default function RtaCompliance({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(30)
  const [maxFl, setMaxFl] = useState(300)
  const [captureNm, setCaptureNm] = useState(200)
  const [tolSec, setTolSec] = useState(30)
  const [offsetMaxMin, setOffsetMaxMin] = useState(3)
  const [showRing, setShowRing] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [tab, setTab] = useState<'AC' | 'AP'>('AC')
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt) || !isFinite(f.lat) || !isFinite(f.lng)) continue
      const fl = f.altitudeFt / 100
      const gs = Math.max(0, f.velocityKts || 0)
      if (gs < 80) continue
      const klass = classify(f.type, f.category)
      // OUTSIDE if not in FL window: still emit as OUTSIDE for visibility
      const inWindow = fl >= minFl && fl <= maxFl && (f.vertRate || 0) < 0
      // pick best aligned dest within capture range (only if inWindow)
      let best: { ap: any, d: number } | null = null
      if (inWindow) {
        const aps = nearbyAirports(f.lat, f.lng, captureNm)
        for (const ap of aps) {
          const d = gcNm(f.lat, f.lng, ap.lat, ap.lon)
          if (d > captureNm || d < 4) continue
          const brg = bearing(f.lat, f.lng, ap.lat, ap.lon)
          if (angDiff(brg, f.track || 0) > 90) continue
          if (!best || d < best.d) best = { ap, d }
        }
      }
      if (!best) {
        out.push({
          f, klass, altFt: f.altitudeFt, fl, iata: '', apName: '', apLat: 0, apLng: 0,
          distNm: 0, gsKt: gs, etaSec: 0, ctaSec: 0, errSec: 0, dVreq: 0, dMreq: 0, dMmax: SPEC[klass].dMmax,
          unable: false, tier: 'OUTSIDE', bucket: 'ON',
        })
        continue
      }
      const dist = best.d
      const etaSec = (dist / gs) * 3600
      // synth CTA: stable hash offset within [-offsetMaxMin, +offsetMaxMin] minutes
      const h = fnv(f.icao + best.ap.a)
      const offSec = (h * 2 - 1) * offsetMaxMin * 60
      const ctaSec = etaSec + offSec
      const errSec = etaSec - ctaSec  // = -offSec, deterministic per (icao, dest)
      // required speed change to nullify error: dV * remTime = -err * gs
      // err = (dist/gs - cta) * 3600 ⇒ to push eta toward cta:
      // new gs' = dist / ((cta_sec)/3600) ⇒ dV = gs' - gs
      const gsPrime = ctaSec > 30 ? dist / (ctaSec / 3600) : gs
      const dVreq = gsPrime - gs
      const a = aSound(f.altitudeFt)
      const dMreq = dVreq / a
      const dMmax = SPEC[klass].dMmax
      const unable = Math.abs(dMreq) > dMmax * 1.05
      const absErr = Math.abs(errSec)
      let tier: Tier
      if (absErr > 300 || unable) tier = 'MISS'
      else if (absErr > 120) tier = 'DELAY'
      else if (absErr > tolSec) tier = 'SLIP'
      else tier = 'ON-TIME'
      const bucket: 'EARLY' | 'LATE' | 'ON' = errSec > tolSec ? 'LATE' : errSec < -tolSec ? 'EARLY' : 'ON'
      out.push({
        f, klass, altFt: f.altitudeFt, fl,
        iata: best.ap.a, apName: best.ap.m || best.ap.n || '',
        apLat: best.ap.lat, apLng: best.ap.lon,
        distNm: dist, gsKt: gs, etaSec, ctaSec, errSec, dVreq, dMreq, dMmax, unable, tier, bucket,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return Math.abs(b.errSec) - Math.abs(a.errSec)
    })
    return out
  }, [flights, minFl, maxFl, captureNm, tolSec, offsetMaxMin])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { 'ON-TIME': 0, SLIP: 0, DELAY: 0, MISS: 0, OUTSIDE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let meanErr = 0, worstAbs = 0, worstCs = '', worstErr = 0, miss = 0, early = 0, late = 0, n = 0
    for (const r of rows) {
      if (r.tier === 'OUTSIDE') continue
      n++
      meanErr += Math.abs(r.errSec)
      if (Math.abs(r.errSec) > worstAbs) { worstAbs = Math.abs(r.errSec); worstErr = r.errSec; worstCs = (r.f.callsign || r.f.icao).trim() }
      if (r.tier === 'MISS') miss++
      if (r.bucket === 'EARLY') early++
      if (r.bucket === 'LATE') late++
    }
    if (n) meanErr /= n
    return { meanErr, worstAbs, worstErr, worstCs, miss, early, late, tracked: n }
  }, [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.iata].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [rows, tierFilter, klassFilter, query])

  // group by airport
  const airports = useMemo(() => {
    const m = new Map<string, { iata: string, name: string, lat: number, lng: number, count: number, sumAbs: number, sumSigned: number, worstAbs: number, worstErr: number, worstCs: string, worstTier: Tier }>()
    for (const r of rows) {
      if (!r.iata) continue
      let z = m.get(r.iata)
      if (!z) { z = { iata: r.iata, name: r.apName, lat: r.apLat, lng: r.apLng, count: 0, sumAbs: 0, sumSigned: 0, worstAbs: 0, worstErr: 0, worstCs: '', worstTier: 'ON-TIME' }; m.set(r.iata, z) }
      z.count++
      z.sumAbs += Math.abs(r.errSec)
      z.sumSigned += r.errSec
      if (Math.abs(r.errSec) > z.worstAbs) { z.worstAbs = Math.abs(r.errSec); z.worstErr = r.errSec; z.worstCs = (r.f.callsign || r.f.icao).trim() }
      if (TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(z.worstTier)) z.worstTier = r.tier
    }
    const arr = Array.from(m.values()).map(z => ({ ...z, meanAbs: z.sumAbs / z.count, meanSigned: z.sumSigned / z.count }))
    arr.sort((a, b) => (TIER_ORDER.indexOf(a.worstTier) - TIER_ORDER.indexOf(b.worstTier)) || b.count - a.count)
    return arr
  }, [rows])

  useEffect(() => {
    if (!map) return
    const active = rows.filter(r => r.tier !== 'OUTSIDE')
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? active.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, Math.abs(r.errSec) / 30) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const projFc = { type: 'FeatureCollection' as const, features: showProj ? active.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.apLng, r.apLat]] },
    })) : [] }
    const dotFc = { type: 'FeatureCollection' as const, features: showProj ? active.filter(r => r.tier !== 'ON-TIME').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'Point' as const, coordinates: [r.apLng, r.apLat] },
    })) : [] }
    // airport pins (unique)
    const pinMap = new Map<string, { iata: string, lat: number, lng: number, tier: Tier }>()
    for (const r of active) {
      const ex = pinMap.get(r.iata)
      if (!ex || TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(ex.tier)) pinMap.set(r.iata, { iata: r.iata, lat: r.apLat, lng: r.apLng, tier: r.tier })
    }
    const pinFc = { type: 'FeatureCollection' as const, features: Array.from(pinMap.values()).map(p => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[p.tier], text: `›${p.iata}` },
      geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
    })) }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? active.filter(r => r.tier !== 'ON-TIME').map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${r.errSec >= 0 ? '+' : ''}${r.errSec.toFixed(0)}s ›${r.iata}`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const plblFc = { type: 'FeatureCollection' as const, features: Array.from(pinMap.values()).map(p => ({
      type: 'Feature' as const, properties: { color: TIER_COLOR[p.tier], text: `›${p.iata}` },
      geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
    })) }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_RING, ringFc, () => map.addLayer({ id: LYR_RING, type: 'circle', source: SRC_RING, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.14,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.6, 'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PROJ, projFc, () => map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.7, 'line-dasharray': [3, 2],
      } }))
      ensure(SRC_DOT, dotFc, () => map.addLayer({ id: LYR_DOT, type: 'circle', source: SRC_DOT, paint: {
        'circle-radius': 4.5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#020617', 'circle-stroke-width': 1.2,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'circle', source: SRC_PIN, paint: {
        'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-opacity': 0.9, 'circle-stroke-color': '#020617', 'circle-stroke-width': 1.4,
      } }))
      ensure(SRC_PLBL, plblFc, () => map.addLayer({ id: LYR_PLBL, type: 'symbol', source: SRC_PLBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 11, 'text-offset': [0, -1.4], 'text-anchor': 'bottom',
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.3 } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_PLBL, LYR_PIN, LYR_DOT, LYR_PROJ, LYR_RING]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PLBL, SRC_PIN, SRC_DOT, SRC_PROJ, SRC_RING]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showRing, showProj, showLabels])

  // diagram: err vs dist
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 28
    const xMaxNm = 300, yMaxSec = 600
    const xs = (nm: number) => PAD + Math.max(0, Math.min(xMaxNm, nm)) / xMaxNm * (W - PAD - 6)
    const ys = (s: number) => 6 + (1 - (Math.max(-yMaxSec, Math.min(yMaxSec, s)) + yMaxSec) / (2 * yMaxSec)) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMaxNm, yMaxSec }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">RTA / 4D</span>
        <span className="text-[10px] text-slate-500 ml-auto">{summary.tracked} tracked · ICAO PBN RNP-RTA ±{tolSec}s</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[9px] font-bold" style={{ color: TIER_COLOR[t] }}>{t === 'ON-TIME' ? 'ONTIME' : t}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean |err|</div>
          <div className="font-mono text-sm" style={{ color: summary.meanErr > 300 ? '#ef4444' : summary.meanErr > 120 ? '#f59e0b' : summary.meanErr > tolSec ? '#0ea5e9' : '#10b981' }}>
            {summary.meanErr.toFixed(0)}s
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstErr >= 0 ? '+' : ''}${summary.worstErr.toFixed(0)}s` : '\u2014'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Miss</div>
          <div className="font-mono text-sm" style={{ color: summary.miss > 0 ? '#ef4444' : '#10b981' }}>{summary.miss}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Early</div>
          <div className="font-mono text-sm" style={{ color: summary.early > 0 ? '#0ea5e9' : '#64748b' }}>{summary.early}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Late</div>
          <div className="font-mono text-sm" style={{ color: summary.late > 0 ? '#f59e0b' : '#64748b' }}>{summary.late}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Err sec vs Dist nm · ±{tolSec}s ON-TIME band</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {/* shaded bands */}
            <rect x={diag.PAD} y={diag.ys(tolSec)} width={diag.W - diag.PAD - 6} height={diag.ys(-tolSec) - diag.ys(tolSec)} fill="#10b981" opacity={0.10} />
            <rect x={diag.PAD} y={diag.ys(120)} width={diag.W - diag.PAD - 6} height={diag.ys(tolSec) - diag.ys(120)} fill="#0ea5e9" opacity={0.07} />
            <rect x={diag.PAD} y={diag.ys(-tolSec)} width={diag.W - diag.PAD - 6} height={diag.ys(-120) - diag.ys(-tolSec)} fill="#0ea5e9" opacity={0.07} />
            <rect x={diag.PAD} y={diag.ys(300)} width={diag.W - diag.PAD - 6} height={diag.ys(120) - diag.ys(300)} fill="#f59e0b" opacity={0.07} />
            <rect x={diag.PAD} y={diag.ys(-120)} width={diag.W - diag.PAD - 6} height={diag.ys(-300) - diag.ys(-120)} fill="#f59e0b" opacity={0.07} />
            {[-300, -120, -tolSec, 0, tolSec, 120, 300].map(v => (
              <g key={v}>
                <line x1={diag.PAD} y1={diag.ys(v)} x2={diag.W - 6} y2={diag.ys(v)} stroke={v === 0 ? '#475569' : '#1e293b'} strokeDasharray={v === 0 ? '' : '2 3'} />
                <text x={diag.PAD - 2} y={diag.ys(v) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{v > 0 ? '+' : ''}{v}</text>
              </g>
            ))}
            {[50, 100, 150, 200, 250, 300].map(nm => (
              <g key={nm}>
                <line x1={diag.xs(nm)} y1={6} x2={diag.xs(nm)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(nm)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{nm}nm</text>
              </g>
            ))}
            {rows.filter(r => r.tier !== 'OUTSIDE').map(r => (
              <circle key={r.f.icao} cx={diag.xs(r.distNm)} cy={diag.ys(r.errSec)} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.95} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-FL</span><span className="font-mono text-slate-300">{minFl}</span></div>
            <input type="range" min={0} max={300} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-FL</span><span className="font-mono text-slate-300">{maxFl}</span></div>
            <input type="range" min={50} max={450} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>CAPTURE</span><span className="font-mono text-slate-300">{captureNm}nm</span></div>
            <input type="range" min={50} max={400} step={10} value={captureNm} onChange={e => setCaptureNm(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>TOL-SEC</span><span className="font-mono text-slate-300">±{tolSec}</span></div>
            <input type="range" min={10} max={120} step={5} value={tolSec} onChange={e => setTolSec(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div className="col-span-2">
            <div className="flex justify-between text-[10px] text-slate-500"><span>OFFSET-MAX</span><span className="font-mono text-slate-300">±{offsetMaxMin}min</span></div>
            <input type="range" min={1} max={10} step={1} value={offsetMaxMin} onChange={e => setOffsetMaxMin(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setKlassFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${klassFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['heavy', 'narrow', 'regional', 'biz', 'turboprop', 'ga', 'fighter'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlassFilter(klassFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${klassFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{KLASS_LABEL[k]}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showRing} onChange={e => setShowRing(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <div className="flex gap-1">
          {(['AC','AP'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab===t?'bg-sky-500/15 border-sky-500/40 text-sky-100':'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t==='AC'?'AIRCRAFT':'AIRPORTS'}</button>
          ))}
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao / IATA"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab==='AC'?`${filtered.length} shown / ${rows.length} total`:`${airports.length} airports`}</span>
        <span>{tab==='AC'?'err · dV · Mach · advice':'mean · worst · count'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab==='AC' && filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab==='AC' && filtered.map(r => {
          if (r.tier === 'OUTSIDE') {
            return (
              <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
                className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
                <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR.OUTSIDE }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                    <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                    <span className="ml-auto text-[10px] font-mono text-slate-400">{KLASS_LABEL[r.klass]}</span>
                    <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR.OUTSIDE }}>OUT</span>
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">F{Math.round(r.fl)} · no aligned destination within capture</div>
                </div>
              </button>
            )
          }
          const pct = Math.max(0, Math.min(100, ((r.errSec + 300) / 600) * 100))
          const advice = r.unable ? `UNABLE RNP-RTA, request vectors (Δm ${r.dMreq >= 0 ? '+' : ''}${r.dMreq.toFixed(3)} > ±${r.dMmax.toFixed(2)})`
            : r.tier === 'MISS' ? `MISS, re-request CTA per ICAO PBN Doc 9613`
            : r.tier === 'DELAY' ? `${r.bucket === 'LATE' ? 'accelerate' : 'decelerate'} to recover ${Math.abs(r.errSec).toFixed(0)}s`
            : r.tier === 'SLIP' ? `minor slip Δv ${r.dVreq >= 0 ? '+' : ''}${r.dVreq.toFixed(0)}kt`
            : `on time within ±${tolSec}s`
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{KLASS_LABEL[r.klass]}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="flight level">F{Math.round(r.fl)}</span>
                  <span title="destination IATA" style={{ color: TIER_COLOR[r.tier] }}>›{r.iata}</span>
                  <span title="distance to go">{r.distNm.toFixed(0)}nm</span>
                  <span className="ml-auto" style={{ color: TIER_COLOR[r.tier] }}>err {r.errSec >= 0 ? '+' : ''}{r.errSec.toFixed(0)}s</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="err position -300..+300 s">
                  <div className="absolute inset-y-0 w-px bg-slate-600" style={{ left: '50%' }} />
                  <div className="absolute inset-y-0 bg-emerald-500/30" style={{ left: `${50 - (tolSec/300)*50}%`, width: `${(tolSec/300)*100}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-emerald-400" style={{ left: `${50 - (tolSec/300)*50}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-emerald-400" style={{ left: `${50 + (tolSec/300)*50}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: `${50 - (120/300)*50}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: `${50 + (120/300)*50}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: '0%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: '100%' }} />
                  <div className="absolute top-0 bottom-0 w-1 rounded" style={{ left: `calc(${pct}% - 2px)`, background: TIER_COLOR[r.tier] }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="ground speed">GS {r.gsKt.toFixed(0)}kt</span>
                  <span title="ETA / CTA seconds">eta {(r.etaSec/60).toFixed(1)}m</span>
                  <span title="required dV">Δv {r.dVreq >= 0 ? '+' : ''}{r.dVreq.toFixed(0)}kt</span>
                  <span className="ml-auto" title="required Mach delta" style={{ color: Math.abs(r.dMreq) > r.dMmax ? '#ef4444' : '#94a3b8' }}>Δm {r.dMreq >= 0 ? '+' : ''}{r.dMreq.toFixed(3)}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="px-1 rounded" style={{ background: r.bucket === 'EARLY' ? 'rgba(14,165,233,0.15)' : r.bucket === 'LATE' ? 'rgba(245,158,11,0.15)' : 'rgba(16,185,129,0.15)', color: r.bucket === 'EARLY' ? '#0ea5e9' : r.bucket === 'LATE' ? '#f59e0b' : '#10b981' }}>{r.bucket}</span>
                  <span className="ml-auto truncate" style={{ color: TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate" title="operator">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" title={r.apName}>{r.apName}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab==='AP' && airports.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No airports populated.</div>
        )}
        {tab==='AP' && airports.map(z => {
          const pct = Math.max(0, Math.min(100, (z.meanAbs / 300) * 100))
          const firstAc = rows.find(r => r.iata === z.iata && Math.abs(r.errSec) === z.worstAbs)
          return (
            <button key={z.iata} onClick={() => firstAc ? onFly(firstAc.f.icao) : null}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[z.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">›{z.iata}</span>
                  <span className="text-slate-500 truncate">{z.name}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">n {z.count}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[z.worstTier] }}>{z.worstTier}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="mean |err| 0-300s">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${pct}%`, background: TIER_COLOR[z.worstTier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-emerald-400" style={{ left: `${(tolSec/300)*100}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: `${(120/300)*100}%` }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span>mean |{z.meanAbs.toFixed(0)}s|</span>
                  <span>signed {z.meanSigned >= 0 ? '+' : ''}{z.meanSigned.toFixed(0)}s</span>
                  <span className="ml-auto truncate">{z.worstCs} {z.worstErr >= 0 ? '+' : ''}{z.worstErr.toFixed(0)}s</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
