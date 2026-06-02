'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   Departure Sequencer
   -----------------------------------------------------------
   Counterpart to the Approach Sequencer. Picks an origin
   airport (nearest to map center by default, or user-picked)
   and builds a live departure stream by:
     1. Scanning every airborne aircraft within INITIAL_CLIMB
        range of the field (default 30nm), filtering to those
        actively climbing out (vertRate >= MIN_VS fpm, alt <=
        MAX_ALT, and outbound — closure component < 0 / range
        increasing in track-projection)
     2. Estimating Time-Since-Takeoff (TST) by reverse-integrating
        the current altitude using a class-typical initial ROC
        (heavy 1800 / narrow 2200 / regional 2400 / biz 2800 /
        turboprop 1500 / GA 700 / fighter 6000 fpm) clamped to
        the observed VS if observed VS is positive and smaller
        (an aircraft levelled at 4000ft must have departed
        longer ago than one still climbing through 4000ft)
     3. Inferring departure runway heading per aircraft from
        its current ground track minus any post-departure turn
        bias (we use raw track — early climb is rarely far off
        runway heading inside 30nm) and computing dominant
        departure radial as the bearing-from-airport circular
        mean weighted by 1/range over the leading 8 departures
     4. Sequencing departures by ASCENDING TST (most-recent
        takeoff = #1 lead-out at the runway, oldest = trailing)
        — opposite of approach sequencing which orders by
        arrival ETA — and for every consecutive pair computing:
          * raw in-trail separation: nm + seconds gap
          * required wake separation per ICAO Doc 4444 wake
            matrix on same runway (behind SUPER 6/7/8nm,
            HEAVY 4/5/6nm M/H/L, MEDIUM 5nm light) and time
            mins (2/3min variants) — picks the tighter of the
            two constraints translated to a single nm-equivalent
            using the FOLLOWING aircraft's current GS
          * compliance ratio actual_nm / required_nm
     5. Computing per-aircraft climb gradient ft/nm = altitude
        gained since brake-release / nm-from-airport, comparing
        to required 200 ft/nm initial-climb minimum (FAA Part 25
        OEI net flight-path), flagging SHALLOW < 250 ft/nm,
        STD 250-400, STRONG > 400
     6. Classifying each pair into 4 tiers:
        CONFLICT (actual < 0.85 * required wake nm)
        TIGHT    (< 1.0 * required)
        OK       (>= 1.0 * required)
        LEAD     (first plane out — no preceding constraint)
   ----------
   MapLibre overlay paints:
     - dashed sky departure corridor along dominant outbound
       radial (out 40nm + reciprocal 5nm threshold)
     - tier-colored halo circle around every sequenced aircraft
     - dashed forward-track projection line 15nm ahead of each
       aircraft showing initial climb-out vector with chevron
     - dashed link from each aircraft back to airport (departure
       trace, shrinks over time as plane climbs out)
     - violet airport pin with IATA + active-runway label
       (estimated runway from dominant radial / 10 = rwy ident)
     - on-map labels: callsign | #seq | T+mm:ss since takeoff
   Side panel:
     - airport picker (searchable IATA/ICAO/city) + NEAREST snap
     - 4-cell counter strip CONF/TIGHT/OK/LEAD click-to-filter
     - 4-cell summary: DEP count / RWY estimated / DOMINANT
       outbound radial / FLEET avg climb gradient ft/nm
     - sliders: RANGE 5-100nm, MIN VS 100-2000 fpm, MAX ALT
       2000-15000ft
     - toggles: OVL / TRACE / LBL / CORR (departure corridor)
     - search box (callsign / type / operator / icao)
     - ranked list sorted by ASCENDING TST (most recent first)
       with tier color stripe, callsign+type+operator, T+mm:ss
       chip, range/FL/GS/VS line, climb gradient + ICAO wake
       category chip (J/H/M/L), and in-trail required-nm vs
       actual-nm wake compliance bar
   ============================================================ */

export interface DepFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  category?: any
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
  flights: DepFlight[]
  onClose: () => void
  onFly: (icao: string) => void
  onFlyLatLng?: (lat: number, lng: number, zoom?: number) => void
}

const R_NM = 3440.065
const RAD = Math.PI / 180
const DEG = 180 / Math.PI

function distNm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const φ1 = lat1 * RAD, φ2 = lat2 * RAD
  const dφ = (lat2 - lat1) * RAD
  const dλ = (lng2 - lng1) * RAD
  const s = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(s)))
}
function bearing(lat1: number, lng1: number, lat2: number, lng2: number) {
  const φ1 = lat1 * RAD, φ2 = lat2 * RAD
  const dλ = (lng2 - lng1) * RAD
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (Math.atan2(y, x) * DEG + 360) % 360
}
function destPt(lat: number, lng: number, brg: number, nm: number): [number, number] {
  const d = nm / R_NM
  const φ1 = lat * RAD, λ1 = lng * RAD, θ = brg * RAD
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(d) * Math.cos(φ1),
                             Math.cos(d) - Math.sin(φ1) * Math.sin(φ2))
  let lng2 = λ2 * DEG
  lng2 = ((lng2 + 540) % 360) - 180
  return [lng2, φ2 * DEG]
}
function geodesic(lat1: number, lng1: number, lat2: number, lng2: number, n = 16): number[][] {
  const out: number[][] = []
  const b = bearing(lat1, lng1, lat2, lng2)
  const d = distNm(lat1, lng1, lat2, lng2)
  for (let i = 0; i <= n; i++) {
    const [lo, la] = destPt(lat1, lng1, b, d * (i / n))
    out.push([lo, la])
  }
  return out
}
function fmtMMSS(s: number) {
  if (!isFinite(s) || s < 0) return '--:--'
  const m = Math.floor(s / 60), ss = Math.floor(s % 60)
  return `${m}:${ss.toString().padStart(2, '0')}`
}

// ---- airframe-class climb / wake-cat model ---------------------------
type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter' | 'heli'
const KLASS_ROC: Record<Klass, number> = {
  heavy: 1800, narrow: 2200, regional: 2400, biz: 2800,
  turboprop: 1500, ga: 700, fighter: 6000, heli: 800,
}
// ICAO wake category: SUPER (J=A388), HEAVY (H), MEDIUM (M), LIGHT (L)
type Wake = 'J' | 'H' | 'M' | 'L'
const KLASS_WAKE: Record<Klass, Wake> = {
  heavy: 'H', narrow: 'M', regional: 'M', biz: 'M',
  turboprop: 'M', ga: 'L', fighter: 'M', heli: 'L',
}
function classifyType(type?: string, cat?: number): Klass {
  const t = (type || '').toUpperCase()
  if (cat === 7) return 'heli'
  if (/^A38|^B74|^B77|^B78|^A33|^A34|^A35|^MD11|^IL96|^B767|^A330|^A350|^B772|^B773|^B777|^B788|^B789|^B78X|^B748|^B744/.test(t)) return 'heavy'
  if (/^B73|^A31|^A32|^A22|^E19|^E29|^E2|^MD8|^MD9|^B71|^B72|^B752|^B753/.test(t)) return 'narrow'
  if (/^E1|^CRJ|^DH8|^ATR|^AT7|^E70|^E75|^Q4|^SF3|^RJ/.test(t)) return 'regional'
  if (/^GLF|^G280|^G450|^G500|^G550|^G650|^GL5|^GL6|^GL7|^CL3|^CL6|^FA7|^FA8|^FA9|^F2TH|^E55P|^C56X|^C68A|^C25/.test(t)) return 'biz'
  if (/^C172|^C152|^C182|^C208|^PA28|^PA32|^SR2|^DA40|^DA42|^M20|^BE3|^BE9/.test(t)) return 'ga'
  if (/^F16|^F15|^F18|^F22|^F35|^EUR|^RFA|^GR4|^A10|^B1|^B2|^B52|^T38|^T6|^A4/.test(t)) return 'fighter'
  if (cat === 5 || cat === 6) return 'heavy'
  if (cat === 4) return 'narrow'
  if (cat === 3) return 'regional'
  if (cat === 2) return 'ga'
  return 'narrow'
}

// ICAO Doc 4444 wake distance separation matrix (nm), follower-behind-leader.
// Order rows = leader, cols = follower. Same-runway departures.
//                   J     H     M     L
const WAKE_NM: Record<Wake, Record<Wake, number>> = {
  J: { J: 4, H: 6, M: 7, L: 8 },
  H: { J: 0, H: 4, M: 5, L: 6 },
  M: { J: 0, H: 0, M: 3, L: 5 },
  L: { J: 0, H: 0, M: 0, L: 3 },
}
// Departure time-separation (min) — same runway, same SID
const WAKE_MIN: Record<Wake, Record<Wake, number>> = {
  J: { J: 2, H: 2, M: 2, L: 3 },
  H: { J: 0, H: 2, M: 2, L: 2 },
  M: { J: 0, H: 0, M: 1, L: 2 },
  L: { J: 0, H: 0, M: 0, L: 1 },
}

type Departure = {
  f: DepFlight
  klass: Klass
  wake: Wake
  rangeNm: number
  bearingFromAp: number
  trackOut: number
  altAgl: number
  tstSec: number       // estimated time since takeoff
  rocFpm: number
  climbGradFtNm: number
  seq: number
  prevGapNm: number
  prevGapSec: number
  reqNm: number        // required wake separation behind preceding aircraft
  compliance: number   // actual / required (1.0 = on limit)
  status: 'conflict' | 'tight' | 'ok' | 'lead'
  gradeStatus: 'shallow' | 'std' | 'strong'
}

const SRC = 'dep-seq-src'
const SRC_LINK = 'dep-seq-link-src'
const SRC_PROJ = 'dep-seq-proj-src'
const SRC_AP = 'dep-seq-ap-src'
const SRC_CORR = 'dep-seq-corr-src'
const LYR_HALO = 'dep-seq-halo'
const LYR_NUM = 'dep-seq-num'
const LYR_LINK = 'dep-seq-link'
const LYR_PROJ = 'dep-seq-proj'
const LYR_AP = 'dep-seq-ap'
const LYR_AP_LBL = 'dep-seq-ap-lbl'
const LYR_CORR = 'dep-seq-corr'

export default function DepartureSequencer({ map, flights, onClose, onFly, onFlyLatLng }: Props) {
  const [airportI, setAirportI] = useState<string>(() => { try { return localStorage.getItem('ft-depseq-ap') || '' } catch { return '' } })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQ, setPickerQ] = useState('')
  const [rangeNm, setRangeNm] = useState(30)
  const [minVs, setMinVs] = useState(500)
  const [maxAlt, setMaxAlt] = useState(10000)
  const [search, setSearch] = useState('')
  const [showOverlay, setShowOverlay] = useState(true)
  const [showTrace, setShowTrace] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showCorridor, setShowCorridor] = useState(true)
  const [filterTier, setFilterTier] = useState<'conflict' | 'tight' | 'ok' | 'lead' | null>(null)

  const center = useMemo(() => {
    try { const c = map?.getCenter(); return c ? { lat: c.lat, lng: c.lng } : { lat: 40, lng: -95 } } catch { return { lat: 40, lng: -95 } }
  }, [map, flights])

  const airport = useMemo(() => {
    if (airportI) {
      const a = AIRPORTS.find(x => x.i === airportI)
      if (a) return a
    }
    let best = AIRPORTS[0], bd = Infinity
    for (const a of AIRPORTS) {
      const d = distNm(center.lat, center.lng, a.lat, a.lon)
      if (d < bd) { bd = d; best = a }
    }
    return best
  }, [airportI, center.lat, center.lng])

  useEffect(() => { try { localStorage.setItem('ft-depseq-ap', airportI) } catch {} }, [airportI])

  // build departure candidates
  const departures = useMemo<Departure[]>(() => {
    if (!airport) return []
    const apLat = airport.lat, apLng = airport.lon
    // estimated field elevation (default 500 ft if unknown — AIRPORTS dataset has no elev)
    const fieldElevFt = 500
    const cands: Departure[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (f.altitudeFt > maxAlt) continue
      if (f.vertRate < minVs) continue
      const r = distNm(f.lat, f.lng, apLat, apLng)
      if (r > rangeNm || r < 0.5) continue
      // outbound test: track is roughly away from airport
      const brgFromAp = bearing(apLat, apLng, f.lat, f.lng)
      const headingDelta = Math.abs(((f.track - brgFromAp + 540) % 360) - 180)
      if (headingDelta > 70) continue   // not flying outbound — likely overflight/turn
      const klass = classifyType(f.type, f.category)
      const wake = KLASS_WAKE[klass]
      const altAgl = Math.max(0, f.altitudeFt - fieldElevFt)
      // estimate ROC used so far: max of observed and 0.6 * class typical
      const effRoc = Math.max(f.vertRate, KLASS_ROC[klass] * 0.6)
      const tstSec = (altAgl / effRoc) * 60   // minutes * 60
      const climbGrad = r > 0.1 ? altAgl / r : 0
      cands.push({
        f, klass, wake,
        rangeNm: r,
        bearingFromAp: brgFromAp,
        trackOut: f.track,
        altAgl,
        tstSec,
        rocFpm: f.vertRate,
        climbGradFtNm: climbGrad,
        seq: 0, prevGapNm: 0, prevGapSec: 0, reqNm: 0, compliance: 1,
        status: 'lead',
        gradeStatus: climbGrad < 250 ? 'shallow' : climbGrad < 400 ? 'std' : 'strong',
      })
    }
    // sort ascending TST (most recent takeoff first = #1)
    cands.sort((a, b) => a.tstSec - b.tstSec)
    for (let i = 0; i < cands.length; i++) {
      cands[i].seq = i + 1
      if (i === 0) {
        cands[i].status = 'lead'
        cands[i].prevGapNm = 0
        cands[i].prevGapSec = 0
        cands[i].reqNm = 0
        cands[i].compliance = 1
      } else {
        const lead = cands[i - 1]   // older = ahead
        const cur = cands[i]
        // in-trail gap = lead.rangeNm - cur.rangeNm (lead farther out)
        const gapNm = Math.max(0, lead.rangeNm - cur.rangeNm)
        const gapSec = Math.max(0, lead.tstSec - cur.tstSec)
        cur.prevGapNm = gapNm
        cur.prevGapSec = gapSec
        const wakeNm = WAKE_NM[lead.wake][cur.wake] || 3
        const wakeMin = WAKE_MIN[lead.wake][cur.wake] || 1
        // translate time-min to nm using follower's GS (kt * h)
        const wakeNmFromMin = wakeMin * (Math.max(120, cur.f.velocityKts) / 60)
        cur.reqNm = Math.min(wakeNm, wakeNmFromMin)
        cur.compliance = cur.reqNm > 0 ? gapNm / cur.reqNm : 1
        cur.status = cur.compliance < 0.85 ? 'conflict' : cur.compliance < 1.0 ? 'tight' : 'ok'
      }
    }
    return cands
  }, [flights, airport, rangeNm, minVs, maxAlt])

  const filtered = useMemo(() => {
    let list = departures
    if (filterTier) list = list.filter(d => d.status === filterTier)
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(a =>
      a.f.callsign.toLowerCase().includes(q) ||
      (a.f.type || '').toLowerCase().includes(q) ||
      (a.f.operator || '').toLowerCase().includes(q) ||
      a.f.icao.toLowerCase().includes(q)
    )
  }, [departures, search, filterTier])

  // dominant outbound radial (mean bearingFromAp weighted by inverse range)
  const dominantRadial = useMemo(() => {
    if (!departures.length) return null
    let sx = 0, sy = 0, sw = 0
    for (const a of departures.slice(0, 8)) {
      const w = 1 / Math.max(2, a.rangeNm)
      sx += Math.sin(a.bearingFromAp * RAD) * w
      sy += Math.cos(a.bearingFromAp * RAD) * w
      sw += w
    }
    if (sw === 0) return null
    return (Math.atan2(sx / sw, sy / sw) * DEG + 360) % 360
  }, [departures])
  const estRunway = useMemo(() => {
    if (dominantRadial == null) return '—'
    const r = Math.round(dominantRadial / 10)
    return r === 0 ? '36' : r.toString().padStart(2, '0')
  }, [dominantRadial])

  const counts = useMemo(() => ({
    total: departures.length,
    conflict: departures.filter(a => a.status === 'conflict').length,
    tight: departures.filter(a => a.status === 'tight').length,
    ok: departures.filter(a => a.status === 'ok').length,
    avgGrad: departures.length ? departures.reduce((s, a) => s + a.climbGradFtNm, 0) / departures.length : 0,
  }), [departures])

  // -------- map overlays --------
  useEffect(() => {
    if (!map) return
    const m = map as any
    const remove = () => {
      for (const id of [LYR_HALO, LYR_NUM, LYR_LINK, LYR_PROJ, LYR_CORR, LYR_AP, LYR_AP_LBL]) {
        try { if (m.getLayer(id)) m.removeLayer(id) } catch {}
      }
      for (const id of [SRC, SRC_LINK, SRC_PROJ, SRC_AP, SRC_CORR]) {
        try { if (m.getSource(id)) m.removeSource(id) } catch {}
      }
    }
    if (!showOverlay || !airport) { remove(); return }

    const tierColor = (s: Departure['status']) =>
      s === 'conflict' ? '#f43f5e' : s === 'tight' ? '#fbbf24' : s === 'lead' ? '#a78bfa' : '#22d3ee'

    // halos + labels
    const haloFC: any = {
      type: 'FeatureCollection',
      features: departures.map(d => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [d.f.lng, d.f.lat] },
        properties: {
          color: tierColor(d.status),
          label: showLabels
            ? `#${d.seq}  ${d.f.callsign}  T+${fmtMMSS(d.tstSec)}`
            : '',
        },
      })),
    }

    // trace lines back to airport
    const linkFC: any = {
      type: 'FeatureCollection',
      features: showTrace ? departures.map(d => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: geodesic(airport.lat, airport.lon, d.f.lat, d.f.lng, 14) },
        properties: { color: tierColor(d.status) },
      })) : [],
    }

    // forward projection 15nm along current track
    const projFC: any = {
      type: 'FeatureCollection',
      features: departures.map(d => {
        const fwd = destPt(d.f.lat, d.f.lng, d.trackOut, 15)
        return {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[d.f.lng, d.f.lat], fwd] },
          properties: { color: tierColor(d.status) },
        }
      }),
    }

    // departure corridor along dominant radial (40nm out + 5nm reciprocal threshold marker)
    const corrFC: any = { type: 'FeatureCollection', features: [] }
    if (showCorridor && dominantRadial != null) {
      const out = destPt(airport.lat, airport.lon, dominantRadial, 40)
      const back = destPt(airport.lat, airport.lon, (dominantRadial + 180) % 360, 5)
      const leftEdge = destPt(airport.lat, airport.lon, (dominantRadial - 12 + 360) % 360, 30)
      const rightEdge = destPt(airport.lat, airport.lon, (dominantRadial + 12) % 360, 30)
      corrFC.features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [back, [airport.lon, airport.lat], out] },
        properties: { kind: 'centerline' },
      })
      corrFC.features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[airport.lon, airport.lat], leftEdge] },
        properties: { kind: 'edge' },
      })
      corrFC.features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[airport.lon, airport.lat], rightEdge] },
        properties: { kind: 'edge' },
      })
    }

    // airport pin
    const apFC: any = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [airport.lon, airport.lat] },
        properties: { label: `${airport.a || airport.i}  RWY ${estRunway}` },
      }],
    }

    const upsert = (id: string, data: any) => {
      const s = m.getSource(id)
      if (s) s.setData(data)
      else m.addSource(id, { type: 'geojson', data })
    }
    upsert(SRC, haloFC)
    upsert(SRC_LINK, linkFC)
    upsert(SRC_PROJ, projFC)
    upsert(SRC_CORR, corrFC)
    upsert(SRC_AP, apFC)

    if (!m.getLayer(LYR_CORR)) m.addLayer({ id: LYR_CORR, type: 'line', source: SRC_CORR, paint: { 'line-color': '#7dd3fc', 'line-width': ['case', ['==', ['get', 'kind'], 'centerline'], 1.6, 1.0], 'line-dasharray': [4, 3], 'line-opacity': 0.55 } })
    if (!m.getLayer(LYR_LINK)) m.addLayer({ id: LYR_LINK, type: 'line', source: SRC_LINK, paint: { 'line-color': ['get', 'color'], 'line-width': 1.1, 'line-dasharray': [2, 3], 'line-opacity': 0.45 } })
    if (!m.getLayer(LYR_PROJ)) m.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-dasharray': [1, 2], 'line-opacity': 0.75 } })
    if (!m.getLayer(LYR_HALO)) m.addLayer({ id: LYR_HALO, type: 'circle', source: SRC, paint: { 'circle-radius': 16, 'circle-color': ['get', 'color'], 'circle-opacity': 0.15, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 2, 'circle-stroke-opacity': 0.9 } })
    if (!m.getLayer(LYR_NUM)) m.addLayer({ id: LYR_NUM, type: 'symbol', source: SRC, layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, 1.6], 'text-anchor': 'top', 'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'], 'text-allow-overlap': false }, paint: { 'text-color': '#f1f5f9', 'text-halo-color': '#0b1220', 'text-halo-width': 1.4 } })
    if (!m.getLayer(LYR_AP)) m.addLayer({ id: LYR_AP, type: 'circle', source: SRC_AP, paint: { 'circle-radius': 6, 'circle-color': '#a78bfa', 'circle-stroke-color': '#ede9fe', 'circle-stroke-width': 1.5 } })
    if (!m.getLayer(LYR_AP_LBL)) m.addLayer({ id: LYR_AP_LBL, type: 'symbol', source: SRC_AP, layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, -1.4], 'text-anchor': 'bottom', 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'] }, paint: { 'text-color': '#ede9fe', 'text-halo-color': '#1e1b4b', 'text-halo-width': 1.4 } })

    return () => { remove() }
  }, [map, departures, showOverlay, showTrace, showLabels, showCorridor, airport, dominantRadial, estRunway])

  const airportLabel = airport ? `${airport.a || airport.i} — ${airport.m}` : '—'
  const picks = useMemo(() => {
    const q = pickerQ.trim().toLowerCase()
    const base = q
      ? AIRPORTS.filter(a => a.a.toLowerCase().includes(q) || a.i.toLowerCase().includes(q) || a.m.toLowerCase().includes(q))
      : AIRPORTS.slice().sort((a, b) => distNm(center.lat, center.lng, a.lat, a.lon) - distNm(center.lat, center.lng, b.lat, b.lon))
    return base.slice(0, 80)
  }, [pickerQ, center.lat, center.lng])

  return (
    <div className="absolute top-2 right-2 z-30 w-[390px] max-h-[88vh] overflow-hidden bg-slate-900/95 border border-slate-700 rounded-lg shadow-2xl flex flex-col text-slate-100 backdrop-blur-md">
      <div className="px-3 py-2 border-b border-slate-700 flex items-center justify-between bg-slate-900/70">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-sky-400">Departure Sequencer</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{airportLabel}</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-1.5 flex-wrap">
        <button onClick={() => setPickerOpen(v => !v)} className="px-2 py-1 text-[10px] bg-slate-800 hover:bg-slate-700 rounded border border-slate-700 uppercase tracking-wide text-slate-300">{pickerOpen ? 'Close' : 'Airport'}</button>
        <button onClick={() => { setAirportI(''); setPickerOpen(false) }} className="px-2 py-1 text-[10px] bg-slate-800 hover:bg-slate-700 rounded border border-slate-700 uppercase tracking-wide text-slate-300">Nearest</button>
        <button onClick={() => onFlyLatLng && airport && onFlyLatLng(airport.lat, airport.lon, 10)} className="px-2 py-1 text-[10px] bg-slate-800 hover:bg-slate-700 rounded border border-slate-700 uppercase tracking-wide text-slate-300">Fit</button>
        <div className="ml-auto flex items-center gap-2 text-[10px] text-slate-400">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showOverlay} onChange={e => setShowOverlay(e.target.checked)} className="accent-sky-500" />OVL</label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showTrace} onChange={e => setShowTrace(e.target.checked)} className="accent-sky-500" />TRC</label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" />LBL</label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showCorridor} onChange={e => setShowCorridor(e.target.checked)} className="accent-sky-500" />CRR</label>
        </div>
      </div>

      {pickerOpen && (
        <div className="px-3 py-2 border-b border-slate-800 max-h-48 overflow-y-auto bg-slate-950/60">
          <input value={pickerQ} onChange={e => setPickerQ(e.target.value)} placeholder="IATA / ICAO / city" className="w-full px-2 py-1 mb-1 text-xs bg-slate-900 border border-slate-700 rounded outline-none focus:border-sky-500" />
          {picks.map(a => (
            <button key={a.i} onClick={() => { setAirportI(a.i); setPickerOpen(false) }} className="w-full text-left px-2 py-1 text-[11px] hover:bg-slate-800 rounded flex items-center justify-between">
              <span><span className="font-mono text-sky-300">{a.a || a.i}</span> <span className="text-slate-300">{a.m}</span></span>
              <span className="text-[9px] text-slate-500">{distNm(center.lat, center.lng, a.lat, a.lon).toFixed(0)}nm</span>
            </button>
          ))}
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 grid grid-cols-4 gap-1.5">
        {([
          ['lead', 'LEAD', counts.total > 0 ? (departures[0]?.f.callsign?.slice(0, 6) || '—') : '—'],
          ['conflict', 'CONF', counts.conflict],
          ['tight', 'TIGHT', counts.tight],
          ['ok', 'OK', counts.ok],
        ] as Array<[Departure['status'], string, any]>).map(([k, lbl, v]) => {
          const active = filterTier === k
          const color = k === 'conflict' ? 'text-rose-400 border-rose-500/40 bg-rose-500/10'
            : k === 'tight' ? 'text-amber-300 border-amber-500/40 bg-amber-500/10'
            : k === 'lead' ? 'text-violet-300 border-violet-500/40 bg-violet-500/10'
            : 'text-sky-300 border-sky-500/40 bg-sky-500/10'
          return (
            <button key={k} onClick={() => setFilterTier(active ? null : k)} className={`px-1.5 py-1 rounded border text-center transition ${active ? color : 'bg-slate-800/60 border-slate-700/60 text-slate-300 hover:bg-slate-800'}`}>
              <div className="text-[9px] uppercase tracking-wide text-slate-500">{lbl}</div>
              <div className="text-sm font-bold">{v}</div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-2 border-b border-slate-800 grid grid-cols-3 gap-1.5">
        <div className="px-1.5 py-1 bg-slate-800/40 rounded border border-slate-800 text-center">
          <div className="text-[9px] uppercase tracking-wide text-slate-500">DEP</div>
          <div className="text-sm font-bold text-slate-100">{counts.total}</div>
        </div>
        <div className="px-1.5 py-1 bg-slate-800/40 rounded border border-slate-800 text-center">
          <div className="text-[9px] uppercase tracking-wide text-slate-500">RWY · RDL</div>
          <div className="text-sm font-bold text-sky-300">{estRunway} · {dominantRadial != null ? `${dominantRadial.toFixed(0)}°` : '—'}</div>
        </div>
        <div className="px-1.5 py-1 bg-slate-800/40 rounded border border-slate-800 text-center">
          <div className="text-[9px] uppercase tracking-wide text-slate-500">AVG GRAD</div>
          <div className={`text-sm font-bold ${counts.avgGrad < 250 ? 'text-amber-300' : 'text-slate-100'}`}>{counts.avgGrad.toFixed(0)} ft/nm</div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-1.5">
        <label className="block text-[10px] text-slate-400">RANGE <span className="text-sky-300 font-mono">{rangeNm}nm</span>
          <input type="range" min={5} max={100} value={rangeNm} onChange={e => setRangeNm(+e.target.value)} className="w-full accent-sky-500 h-1" />
        </label>
        <label className="block text-[10px] text-slate-400">MIN VS <span className="text-sky-300 font-mono">{minVs} fpm</span>
          <input type="range" min={100} max={2000} step={50} value={minVs} onChange={e => setMinVs(+e.target.value)} className="w-full accent-sky-500 h-1" />
        </label>
        <label className="block text-[10px] text-slate-400">MAX ALT <span className="text-sky-300 font-mono">{maxAlt} ft</span>
          <input type="range" min={2000} max={15000} step={500} value={maxAlt} onChange={e => setMaxAlt(+e.target.value)} className="w-full accent-sky-500 h-1" />
        </label>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="callsign / type / operator / icao" className="w-full px-2 py-1 text-xs bg-slate-800 border border-slate-700 rounded outline-none focus:border-sky-500" />
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && <div className="px-3 py-6 text-center text-[11px] text-slate-500">No departures detected within {rangeNm}nm{filterTier ? ` matching ${filterTier.toUpperCase()}` : ''}</div>}
        {filtered.map(d => {
          const stripe = d.status === 'conflict' ? 'bg-rose-500'
            : d.status === 'tight' ? 'bg-amber-400'
            : d.status === 'lead' ? 'bg-violet-400'
            : 'bg-sky-400'
          const wakeColor = d.wake === 'J' ? 'text-violet-300 border-violet-500/40'
            : d.wake === 'H' ? 'text-rose-300 border-rose-500/40'
            : d.wake === 'M' ? 'text-sky-300 border-sky-500/40'
            : 'text-slate-300 border-slate-700'
          const gradColor = d.gradeStatus === 'shallow' ? 'text-amber-300'
            : d.gradeStatus === 'strong' ? 'text-emerald-300'
            : 'text-slate-300'
          // wake compliance bar: 0..150% range
          const cw = Math.min(150, d.compliance * 100)
          const cwColor = d.compliance < 0.85 ? 'bg-rose-500' : d.compliance < 1.0 ? 'bg-amber-400' : 'bg-sky-500'
          return (
            <button key={d.f.icao} onClick={() => onFly(d.f.icao)} className="w-full text-left px-3 py-2 border-b border-slate-800/60 hover:bg-slate-800/50 flex items-stretch gap-2">
              <div className={`w-1 rounded-sm ${stripe}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-slate-500 w-5">#{d.seq}</span>
                  <span className="text-sm font-semibold text-slate-100 truncate">{d.f.callsign || d.f.icao}</span>
                  <span className="text-[10px] text-slate-500 font-mono">{d.f.type || ''}</span>
                  <span className={`ml-auto text-[9px] px-1 rounded border font-mono ${wakeColor}`}>{d.wake}</span>
                  <span className="text-[10px] font-mono text-sky-300">T+{fmtMMSS(d.tstSec)}</span>
                </div>
                <div className="text-[10px] text-slate-500 truncate">{d.f.operator || '—'}</div>
                <div className="text-[10px] font-mono text-slate-300 flex gap-3 mt-0.5">
                  <span><span className="text-slate-500">RNG</span> {d.rangeNm.toFixed(1)}</span>
                  <span><span className="text-slate-500">FL</span>{Math.round(d.f.altitudeFt / 100).toString().padStart(3, '0')}</span>
                  <span><span className="text-slate-500">GS</span> {Math.round(d.f.velocityKts)}</span>
                  <span><span className="text-slate-500">VS</span> ↑{Math.round(d.f.vertRate)}</span>
                </div>
                <div className="text-[10px] font-mono mt-0.5 flex gap-3">
                  <span className={gradColor}><span className="text-slate-500">GRAD</span> {d.climbGradFtNm.toFixed(0)}ft/nm</span>
                  <span className="text-slate-400"><span className="text-slate-500">TRK</span> {Math.round(d.trackOut).toString().padStart(3, '0')}°</span>
                </div>
                {d.seq > 1 && (
                  <>
                    <div className="text-[10px] font-mono text-slate-400 mt-0.5 flex gap-3">
                      <span><span className="text-slate-500">in-trail</span> {d.prevGapNm.toFixed(1)}nm / {fmtMMSS(d.prevGapSec)}</span>
                      <span><span className="text-slate-500">wake req</span> {d.reqNm.toFixed(1)}nm</span>
                    </div>
                    <div className="mt-1 h-1.5 bg-slate-800 rounded overflow-hidden relative">
                      <div className={`absolute inset-y-0 left-0 ${cwColor}`} style={{ width: `${(cw / 150) * 100}%` }} />
                      {/* 100% wake-min marker */}
                      <div className="absolute inset-y-0 w-px bg-slate-500" style={{ left: `${(100 / 150) * 100}%` }} />
                    </div>
                  </>
                )}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
