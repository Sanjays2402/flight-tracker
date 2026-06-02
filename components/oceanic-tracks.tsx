'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Oceanic Track Monitor
   -----------------------------------------------------------
   North Atlantic (NAT-OTS) and North Pacific (PACOTS) organised
   track-system conformance picture for every airborne aircraft
   in oceanic airspace.

   Each daily track is a polyline of named ten-degree fix points
   (e.g. NICSO, ELSIR, 50N50W, 50N40W, ...). For every airborne
   aircraft above FL280 we:
     - find the nearest published track + nearest segment
     - compute great-circle cross-track distance (XTK) in nm
     - compute along-track direction conformance vs segment bearing
     - compute longitudinal spacing to the nearest same-track
       same-direction aircraft (MNT / 10-min rule proxy)
     - classify into 4 tiers ON-TRACK / OFFSET / DEVIATING / RANDOM
       (RANDOM = not following any track, free routing)

   Side panel: tier strip, 3-cell summary (active tracks /
   oceanic A/C / mean XTK), SVG NAT lane-grid showing every
   tracked aircraft as a tier-coloured dot on its track, sliders
   (XTK-LIMIT / IN-TRAIL-LIMIT / MIN-FL), tracks/aircraft tabs.
   ============================================================ */

export interface OtFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  mach?: number
  track: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: OtFlight[]
  onClose: () => void
  onFly: (icao: string) => void
  onFlyLatLng: (lat: number, lng: number, zoom?: number) => void
}

type Tier = 'ONTRACK' | 'OFFSET' | 'DEVIATING' | 'RANDOM'
const TIER_COLOR: Record<Tier, string> = {
  ONTRACK: '#0ea5e9',
  OFFSET: '#fde047',
  DEVIATING: '#f59e0b',
  RANDOM: '#ef4444',
}
const TIER_ORDER: Tier[] = ['RANDOM', 'DEVIATING', 'OFFSET', 'ONTRACK']

type System = 'NAT' | 'PACOT'
type Dir = 'EB' | 'WB'

interface Track {
  id: string
  sys: System
  dir: Dir
  fl: [number, number]  // FL band low..high
  // waypoints as [lng, lat]
  pts: Array<[number, number]>
  // human label / first+last fix names
  desc: string
}

/* Representative NAT-OTS tracks (sample of a published bulletin) and
   PACOTS lanes. Coordinates are at 10deg meridians as is standard. */
const TRACKS: Track[] = [
  // ---- NAT eastbound (overnight) ----
  { id: 'NAT-A', sys: 'NAT', dir: 'EB', fl: [340, 400], desc: 'NICSO 56N-50W 58N-40W 59N-30W 59N-20W BEXET',
    pts: [[-67.5,46.5],[-55,54],[-50,56],[-40,58],[-30,59],[-20,59],[-10,55.5],[-8,54]] },
  { id: 'NAT-B', sys: 'NAT', dir: 'EB', fl: [340, 400], desc: 'JOOPY 55N-50W 57N-40W 58N-30W 58N-20W LIMRI',
    pts: [[-65,45],[-55,52],[-50,55],[-40,57],[-30,58],[-20,58],[-10,54],[-8,53]] },
  { id: 'NAT-C', sys: 'NAT', dir: 'EB', fl: [340, 400], desc: 'ALLRY 54N-50W 56N-40W 57N-30W 57N-20W DOGAL',
    pts: [[-62,44],[-55,50],[-50,54],[-40,56],[-30,57],[-20,57],[-10,53],[-8,52.5]] },
  { id: 'NAT-D', sys: 'NAT', dir: 'EB', fl: [320, 400], desc: 'PORTI 52N-50W 55N-40W 56N-30W 56N-20W BURAK',
    pts: [[-60,42],[-55,48],[-50,52],[-40,55],[-30,56],[-20,56],[-10,52],[-8,51.5]] },
  { id: 'NAT-E', sys: 'NAT', dir: 'EB', fl: [320, 390], desc: 'PLYMM 50N-50W 53N-40W 54N-30W 55N-20W OMOKO',
    pts: [[-57,40],[-55,46],[-50,50],[-40,53],[-30,54],[-20,55],[-10,51],[-8,50.5]] },
  // ---- NAT westbound (daytime) ----
  { id: 'NAT-V', sys: 'NAT', dir: 'WB', fl: [320, 390], desc: 'GUNSO 56N-20W 58N-30W 59N-40W 58N-50W NEEKO',
    pts: [[-8,55.5],[-15,56.5],[-20,58],[-30,59],[-40,58],[-50,56],[-55,54],[-65,49]] },
  { id: 'NAT-W', sys: 'NAT', dir: 'WB', fl: [320, 390], desc: 'TIRPO 55N-20W 57N-30W 58N-40W 57N-50W KOBEV',
    pts: [[-8,54.5],[-15,55],[-20,55],[-30,57],[-40,58],[-50,57],[-55,53],[-65,47]] },
  { id: 'NAT-X', sys: 'NAT', dir: 'WB', fl: [320, 400], desc: 'BANCS 54N-20W 56N-30W 57N-40W 56N-50W TUDEP',
    pts: [[-8,53.5],[-15,53.8],[-20,54],[-30,56],[-40,57],[-50,56],[-55,52],[-65,46]] },
  { id: 'NAT-Y', sys: 'NAT', dir: 'WB', fl: [320, 400], desc: 'RESNO 52N-20W 54N-30W 55N-40W 54N-50W ALLRY',
    pts: [[-8,52],[-15,52.3],[-20,52],[-30,54],[-40,55],[-50,54],[-55,50],[-65,44.5]] },
  { id: 'NAT-Z', sys: 'NAT', dir: 'WB', fl: [310, 390], desc: 'NETKIN 50N-20W 52N-30W 53N-40W 52N-50W JEBBY',
    pts: [[-8,50.5],[-15,50.5],[-20,50],[-30,52],[-40,53],[-50,52],[-55,48],[-65,42]] },
  // ---- PACOTS westbound (KSFO/KLAX → RJ**) ----
  { id: 'PAC-1', sys: 'PACOT', dir: 'WB', fl: [320, 400], desc: 'PIRAT 41N-160W 43N-170W 43N-180 41N-170E KALNA',
    pts: [[-122.4,37.6],[-140,40],[-150,41],[-160,41],[-170,43],[-180,43],[170,41],[160,38.5],[140,35.5]] },
  { id: 'PAC-2', sys: 'PACOT', dir: 'WB', fl: [310, 390], desc: 'OOSTA 39N-160W 41N-170W 41N-180 39N-170E KAGIS',
    pts: [[-118.4,33.9],[-140,38],[-150,39],[-160,39],[-170,41],[-180,41],[170,39],[160,36],[140,34]] },
  { id: 'PAC-3', sys: 'PACOT', dir: 'WB', fl: [300, 400], desc: 'BUTAL 35N-160W 37N-170W 37N-180 35N-170E ADGOR',
    pts: [[-117.2,32.7],[-140,34],[-150,35],[-160,35],[-170,37],[-180,37],[170,35],[160,33],[140,32]] },
  // ---- PACOTS eastbound (RJ** → North America) ----
  { id: 'PAC-A', sys: 'PACOT', dir: 'EB', fl: [330, 400], desc: 'NANAC 42N-170E 43N-180 43N-170W 41N-160W AVE',
    pts: [[140,35],[160,38],[170,42],[180,43],[-170,43],[-160,41],[-140,39],[-122.4,37.6]] },
  { id: 'PAC-B', sys: 'PACOT', dir: 'EB', fl: [320, 390], desc: 'KAGIS 40N-170E 41N-180 41N-170W 39N-160W LAX',
    pts: [[140,34],[160,36],[170,40],[180,41],[-170,41],[-160,39],[-140,38],[-118.4,33.9]] },
]

/* ---------- math ---------- */
const R_NM = 3440.065
const D2R = Math.PI / 180
const R2D = 180 / Math.PI
function distNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R
  const dφ = (la2 - la1) * D2R, dλ = (lo2 - lo1) * D2R
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_NM * Math.asin(Math.sqrt(a))
}
function bearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R
  const dλ = (lo2 - lo1) * D2R
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (Math.atan2(y, x) * R2D + 360) % 360
}
function crossTrackNm(lat: number, lng: number, la1: number, lo1: number, la2: number, lo2: number): number {
  const δ13 = distNm(la1, lo1, lat, lng) / R_NM
  const θ13 = bearingDeg(la1, lo1, lat, lng) * D2R
  const θ12 = bearingDeg(la1, lo1, la2, lo2) * D2R
  return Math.asin(Math.sin(δ13) * Math.sin(θ13 - θ12)) * R_NM
}
function alongTrackNm(lat: number, lng: number, la1: number, lo1: number, la2: number, lo2: number): number {
  const δ13 = distNm(la1, lo1, lat, lng) / R_NM
  const xtk = crossTrackNm(lat, lng, la1, lo1, la2, lo2) / R_NM
  // along-track distance from segment start
  return Math.acos(Math.max(-1, Math.min(1, Math.cos(δ13) / Math.cos(xtk)))) * R_NM
}
function angleDiff(a: number, b: number): number {
  let d = ((a - b + 540) % 360) - 180
  return Math.abs(d)
}

interface SegHit {
  trackIdx: number
  segIdx: number
  xtkNm: number   // signed; right positive
  alongNm: number // from segment start
  segBearing: number
  segLenNm: number
  // projection lat/lng along segment
  pLat: number
  pLng: number
}

function nearestSegment(lat: number, lng: number, tr: Track): SegHit | null {
  let best: SegHit | null = null
  let bestAbs = Infinity
  for (let i = 0; i < tr.pts.length - 1; i++) {
    const [lo1, la1] = tr.pts[i]
    const [lo2, la2] = tr.pts[i + 1]
    const segLen = distNm(la1, lo1, la2, lo2)
    if (segLen < 1) continue
    const along = alongTrackNm(lat, lng, la1, lo1, la2, lo2)
    if (along < -25 || along > segLen + 25) continue
    const xtk = crossTrackNm(lat, lng, la1, lo1, la2, lo2)
    const segB = bearingDeg(la1, lo1, la2, lo2)
    if (Math.abs(xtk) < bestAbs) {
      bestAbs = Math.abs(xtk)
      // project: walk from start along segB by along nm
      const φ1 = la1 * D2R, θ = segB * D2R, d = Math.max(0, Math.min(segLen, along)) / R_NM
      const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(θ))
      const λ2 = lo1 * D2R + Math.atan2(Math.sin(θ) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2))
      best = {
        trackIdx: -1, segIdx: i, xtkNm: xtk, alongNm: along, segBearing: segB, segLenNm: segLen,
        pLat: φ2 * R2D, pLng: ((λ2 * R2D + 540) % 360) - 180,
      }
    }
  }
  return best
}

interface Row {
  f: OtFlight
  altFt: number
  fl: number
  track: Track | null
  hit: SegHit | null
  xtkNm: number      // abs cross-track for display
  hdgDelta: number   // |a/c track - segment bearing|
  cumulAlongNm: number  // total nm from track origin
  tier: Tier
  inTrailNm: number  // nearest same-track same-dir aircraft ahead
  inTrailCallsign: string
  flBandOk: boolean
  reasonChip: string
}

const SRC_TRK = 'ot-trk', SRC_RING = 'ot-ring', SRC_LINK = 'ot-link', SRC_LBL = 'ot-lbl', SRC_WP = 'ot-wp', SRC_TLBL = 'ot-tlbl'
const LYR_TRK = 'ot-trk-l', LYR_RING = 'ot-ring-l', LYR_LINK = 'ot-link-l', LYR_LBL = 'ot-lbl-l', LYR_WP = 'ot-wp-l', LYR_TLBL = 'ot-tlbl-l'

export default function OceanicTracks({ map, flights, onClose, onFly, onFlyLatLng }: Props) {
  const [tab, setTab] = useState<'AC' | 'TR'>('AC')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [sysFilter, setSysFilter] = useState<Record<System, boolean>>({ NAT: true, PACOT: true })
  const [dirFilter, setDirFilter] = useState<Record<Dir, boolean>>({ EB: true, WB: true })
  const [xtkLimit, setXtkLimit] = useState<number>(25)
  const [trailLimit, setTrailLimit] = useState<number>(60)
  const [maxAssocNm, setMaxAssocNm] = useState<number>(120)
  const [minFl, setMinFl] = useState<number>(280)
  const [showOverlay, setShowOverlay] = useState(true)
  const [showTracks, setShowTracks] = useState(true)
  const [showWaypoints, setShowWaypoints] = useState(true)
  const [showLinks, setShowLinks] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [query, setQuery] = useState('')

  const activeTracks = useMemo(() => TRACKS.filter(t => sysFilter[t.sys] && dirFilter[t.dir]), [sysFilter, dirFilter])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      const fl = Math.round(f.altitudeFt / 100)
      if (!isFinite(fl) || fl < minFl) continue
      // find best track by minimum |xtk|
      let bestTr: Track | null = null
      let bestHit: SegHit | null = null
      let bestAbs = Infinity
      let bestTrIdx = -1
      for (let ti = 0; ti < activeTracks.length; ti++) {
        const tr = activeTracks[ti]
        const hit = nearestSegment(f.lat, f.lng, tr)
        if (!hit) continue
        if (Math.abs(hit.xtkNm) < bestAbs) {
          bestAbs = Math.abs(hit.xtkNm)
          bestHit = hit
          bestTr = tr
          bestTrIdx = ti
        }
      }
      let tier: Tier = 'RANDOM'
      let hdgDelta = 0
      let cumulAlong = 0
      let flOk = true
      let reason = '—'
      if (bestTr && bestHit && bestAbs <= maxAssocNm) {
        hdgDelta = angleDiff(f.track, bestHit.segBearing)
        flOk = fl >= bestTr.fl[0] && fl <= bestTr.fl[1]
        // sum lengths up to seg
        for (let i = 0; i < bestHit.segIdx; i++) {
          const [lo1, la1] = bestTr.pts[i], [lo2, la2] = bestTr.pts[i + 1]
          cumulAlong += distNm(la1, lo1, la2, lo2)
        }
        cumulAlong += Math.max(0, bestHit.alongNm)
        // tier: if heading is reciprocal, this is RANDOM (wrong way)
        if (hdgDelta > 60) {
          tier = 'RANDOM'
          reason = 'wrong-way'
        } else if (bestAbs <= xtkLimit) {
          tier = 'ONTRACK'
          reason = 'SLOP-0'
        } else if (bestAbs <= xtkLimit * 2.4) {
          tier = 'OFFSET'
          reason = bestAbs > xtkLimit + 0.5 ? `SLOP-${(Math.round(bestAbs/5)*5)}R` : 'OFFSET'
        } else if (bestAbs <= maxAssocNm) {
          tier = 'DEVIATING'
          reason = 'XTK-OVER'
        }
        if (!flOk) {
          reason = `FL${fl} NOT ${bestTr.fl[0]}-${bestTr.fl[1]}`
          if (tier === 'ONTRACK') tier = 'OFFSET'
        }
      } else {
        reason = 'no-track'
      }
      out.push({
        f, altFt: f.altitudeFt, fl,
        track: bestTr && bestAbs <= maxAssocNm ? bestTr : null,
        hit: bestTr && bestAbs <= maxAssocNm ? bestHit : null,
        xtkNm: bestTr && bestAbs <= maxAssocNm ? bestAbs : -1,
        hdgDelta, cumulAlongNm: cumulAlong,
        tier,
        inTrailNm: Infinity,
        inTrailCallsign: '',
        flBandOk: flOk,
        reasonChip: reason,
      })
      // suppress unused
      void bestTrIdx
    }
    // in-trail: for each aircraft on a track, find nearest same-track same-direction A/C ahead (cumulAlong larger)
    for (const r of out) {
      if (!r.track) continue
      let bestNm = Infinity
      let bestCs = ''
      for (const r2 of out) {
        if (r2 === r || r2.track !== r.track) continue
        const d = r2.cumulAlongNm - r.cumulAlongNm
        if (d > 0 && d < bestNm) { bestNm = d; bestCs = r2.f.callsign || r2.f.icao }
      }
      if (isFinite(bestNm)) { r.inTrailNm = bestNm; r.inTrailCallsign = bestCs }
      if (isFinite(bestNm) && bestNm < trailLimit && (r.tier === 'ONTRACK' || r.tier === 'OFFSET')) {
        r.tier = 'DEVIATING'
        r.reasonChip = `IN-TRAIL ${bestNm.toFixed(0)}nm`
      }
    }
    return out
  }, [flights, activeTracks, xtkLimit, trailLimit, maxAssocNm, minFl])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { ONTRACK: 0, OFFSET: 0, DEVIATING: 0, RANDOM: 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const filteredAC = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (!q) return true
      return (r.f.callsign || '').toLowerCase().includes(q)
        || r.f.icao.toLowerCase().includes(q)
        || (r.f.type || '').toLowerCase().includes(q)
        || (r.f.operator || '').toLowerCase().includes(q)
        || (r.track?.id || '').toLowerCase().includes(q)
    }).sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return b.xtkNm - a.xtkNm
    })
  }, [rows, tierFilter, query])

  const trackRollup = useMemo(() => {
    const out = activeTracks.map(tr => {
      const rs = rows.filter(r => r.track === tr)
      let worst: Tier = 'ONTRACK'
      let meanX = 0
      for (const r of rs) {
        if (TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(worst)) worst = r.tier
        if (r.xtkNm >= 0) meanX += r.xtkNm
      }
      const meanXtk = rs.length ? meanX / rs.length : 0
      return { tr, count: rs.length, worst, meanXtk }
    })
    const q = query.trim().toLowerCase()
    return out.filter(o => !q || o.tr.id.toLowerCase().includes(q) || o.tr.desc.toLowerCase().includes(q))
      .sort((a, b) => (b.count - a.count) || (TIER_ORDER.indexOf(a.worst) - TIER_ORDER.indexOf(b.worst)))
  }, [activeTracks, rows, query])

  const summary = useMemo(() => {
    let sum = 0, n = 0
    for (const r of rows) if (r.xtkNm >= 0) { sum += r.xtkNm; n++ }
    const activeTrackCount = trackRollup.filter(t => t.count > 0).length
    return { meanXtk: n ? sum / n : 0, oceanic: rows.length, activeTrackCount }
  }, [rows, trackRollup])

  /* ---------- MapLibre overlay ---------- */
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        for (const s of [SRC_TRK, SRC_WP, SRC_RING, SRC_LINK, SRC_LBL, SRC_TLBL]) {
          if (!map.getSource(s)) map.addSource(s, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        }
        if (!map.getLayer(LYR_TRK)) map.addLayer({
          id: LYR_TRK, type: 'line', source: SRC_TRK,
          paint: { 'line-color': ['get', 'color'], 'line-width': 1.8, 'line-opacity': 0.75, 'line-dasharray': [4, 2] },
        })
        if (!map.getLayer(LYR_WP)) map.addLayer({
          id: LYR_WP, type: 'circle', source: SRC_WP,
          paint: { 'circle-radius': 3, 'circle-color': ['get', 'color'], 'circle-opacity': 0.8, 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1 },
        })
        if (!map.getLayer(LYR_LINK)) map.addLayer({
          id: LYR_LINK, type: 'line', source: SRC_LINK,
          paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.7, 'line-dasharray': [2, 2] },
        })
        if (!map.getLayer(LYR_RING)) map.addLayer({
          id: LYR_RING, type: 'circle', source: SRC_RING,
          paint: {
            'circle-radius': ['get', 'r'],
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.12,
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-width': 1.4,
            'circle-stroke-opacity': 0.9,
          },
        })
        if (!map.getLayer(LYR_LBL)) map.addLayer({
          id: LYR_LBL, type: 'symbol', source: SRC_LBL,
          layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, -1.7], 'text-anchor': 'bottom', 'text-allow-overlap': false },
          paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 },
        })
        if (!map.getLayer(LYR_TLBL)) map.addLayer({
          id: LYR_TLBL, type: 'symbol', source: SRC_TLBL,
          layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-anchor': 'center', 'text-allow-overlap': true },
          paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.4 },
        })
      } catch {}
    }
    if (map.isStyleLoaded()) ensure()
    else map.once('load', ensure)
  }, [map])

  useEffect(() => {
    if (!map) return
    const trkFeats: any[] = []
    const wpFeats: any[] = []
    const ringFeats: any[] = []
    const linkFeats: any[] = []
    const lblFeats: any[] = []
    const tlblFeats: any[] = []

    if (showTracks && showOverlay) {
      for (const tr of activeTracks) {
        const color = tr.sys === 'NAT' ? '#38bdf8' : '#a78bfa'
        trkFeats.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: tr.pts },
          properties: { color, id: tr.id },
        })
        if (showWaypoints) {
          for (const p of tr.pts) {
            wpFeats.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: p },
              properties: { color },
            })
          }
        }
        // mid label
        const mid = tr.pts[Math.floor(tr.pts.length / 2)]
        tlblFeats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: mid },
          properties: { color, label: `${tr.id} ${tr.dir} FL${tr.fl[0]}-${tr.fl[1]}` },
        })
      }
    }

    const visible = showOverlay ? (tierFilter === 'ALL' ? rows : rows.filter(r => r.tier === tierFilter)) : []
    for (const r of visible) {
      ringFeats.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
        properties: { color: TIER_COLOR[r.tier], r: 8 + Math.min(22, Math.max(0, r.xtkNm) * 0.6) },
      })
      if (showLinks && r.hit) {
        linkFeats.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.hit.pLng, r.hit.pLat]] },
          properties: { color: TIER_COLOR[r.tier] },
        })
      }
      if (showLabels) {
        const tag = r.track ? `${r.track.id} \u00B7 ${r.xtkNm.toFixed(0)}nm` : 'RND'
        lblFeats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
          properties: { color: TIER_COLOR[r.tier], label: `${(r.f.callsign || r.f.icao).trim()} \u2022 ${tag}` },
        })
      }
    }

    try {
      ;(map.getSource(SRC_TRK) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: trkFeats })
      ;(map.getSource(SRC_WP) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: wpFeats })
      ;(map.getSource(SRC_TLBL) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: tlblFeats })
      ;(map.getSource(SRC_RING) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: ringFeats })
      ;(map.getSource(SRC_LINK) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: linkFeats })
      ;(map.getSource(SRC_LBL) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lblFeats })
    } catch {}
  }, [map, rows, activeTracks, tierFilter, showOverlay, showTracks, showWaypoints, showLinks, showLabels])

  useEffect(() => () => {
    if (!map) return
    try { for (const l of [LYR_TLBL, LYR_LBL, LYR_RING, LYR_LINK, LYR_WP, LYR_TRK]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
    try { for (const s of [SRC_TLBL, SRC_LBL, SRC_RING, SRC_LINK, SRC_WP, SRC_TRK]) if (map.getSource(s)) map.removeSource(s) } catch {}
  }, [map])

  /* ---------- lane diagram (cumul-along nm vs |XTK|) ---------- */
  const diag = useMemo(() => {
    const W = 348, H = 170, padL = 30, padR = 8, padT = 8, padB = 22
    // max along across all tracks
    let maxAlong = 1000
    for (const tr of activeTracks) {
      let s = 0
      for (let i = 0; i < tr.pts.length - 1; i++) {
        const [lo1, la1] = tr.pts[i], [lo2, la2] = tr.pts[i + 1]
        s += distNm(la1, lo1, la2, lo2)
      }
      if (s > maxAlong) maxAlong = s
    }
    const xtkMax = Math.max(50, xtkLimit * 4)
    const sx = (along: number) => padL + (along / maxAlong) * (W - padL - padR)
    const sy = (xtk: number) => H - padB - Math.min(1, xtk / xtkMax) * (H - padT - padB)
    return { W, H, sx, sy, padL, padR, padT, padB, maxAlong, xtkMax }
  }, [activeTracks, xtkLimit])

  return (
    <div className="fixed top-16 right-3 z-40 w-[390px] max-h-[calc(100vh-5rem)] flex flex-col rounded-lg border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">&#8767;</span>
          <span className="text-sm font-semibold tracking-wide">OCEANIC TRACKS</span>
          <span className="text-[10px] text-slate-500">NAT-OTS + PACOTS</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="px-3 py-2 grid grid-cols-4 gap-1 border-b border-slate-800">
        {(['RANDOM', 'DEVIATING', 'OFFSET', 'ONTRACK'] as Tier[]).map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`flex flex-col items-center rounded px-1 py-1 border ${tierFilter === t ? 'border-sky-500/50 bg-sky-500/10' : 'border-slate-800 bg-slate-900/40'}`}
            style={{ color: TIER_COLOR[t] }} title={t}>
            <span className="text-[9px] tracking-wider">{t.slice(0, 4)}</span>
            <span className="text-sm font-mono">{counts[t]}</span>
          </button>
        ))}
      </div>

      <div className="px-3 py-2 grid grid-cols-3 gap-1 border-b border-slate-800">
        <div className="text-center">
          <div className="text-[9px] text-slate-500 tracking-wider">ACTIVE TRK</div>
          <div className="text-base font-mono text-sky-300">{summary.activeTrackCount}/{activeTracks.length}</div>
        </div>
        <div className="text-center">
          <div className="text-[9px] text-slate-500 tracking-wider">OCEANIC A/C</div>
          <div className="text-base font-mono text-slate-200">{summary.oceanic}</div>
        </div>
        <div className="text-center">
          <div className="text-[9px] text-slate-500 tracking-wider">MEAN XTK</div>
          <div className="text-base font-mono" style={{ color: summary.meanXtk > xtkLimit ? TIER_COLOR.OFFSET : '#94a3b8' }}>{summary.meanXtk.toFixed(1)}nm</div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 bg-slate-900/30">
        <div className="text-[10px] text-slate-500 tracking-wider flex items-center justify-between mb-1">
          <span>{'ALONG-TRACK \u00D7 |XTK|'}</span>
          <span className="font-mono text-slate-400">{rows.length} a/c</span>
        </div>
        <svg width={diag.W} height={diag.H} className="block">
          <rect x={0} y={0} width={diag.W} height={diag.H} fill="#0b1220" />
          {/* XTK threshold bands */}
          <rect x={diag.padL} y={diag.sy(xtkLimit)} width={diag.W - diag.padL - diag.padR} height={diag.H - diag.padB - diag.sy(xtkLimit)} fill="#0ea5e9" opacity={0.05} />
          {/* x grid every 500 nm */}
          {Array.from({ length: Math.ceil(diag.maxAlong / 500) + 1 }).map((_, i) => i * 500).filter(g => g <= diag.maxAlong).map(g => (
            <g key={g}>
              <line x1={diag.sx(g)} x2={diag.sx(g)} y1={diag.padT} y2={diag.H - diag.padB} stroke="#1e293b" strokeWidth={0.5} />
              <text x={diag.sx(g) + 2} y={diag.H - 8} fill="#475569" fontSize={8} fontFamily="ui-monospace, monospace">{g}</text>
            </g>
          ))}
          {/* thresholds */}
          {[{ y: xtkLimit, c: '#0ea5e9' }, { y: xtkLimit * 2.4, c: '#f59e0b' }].map(t => (
            <line key={t.y} x1={diag.padL} x2={diag.W - diag.padR} y1={diag.sy(t.y)} y2={diag.sy(t.y)} stroke={t.c} strokeWidth={0.6} strokeDasharray="3 2" opacity={0.6} />
          ))}
          {filteredAC.map(r => (
            <circle key={r.f.icao} cx={diag.sx(r.cumulAlongNm)} cy={diag.sy(Math.max(0, r.xtkNm))} r={2.6}
              fill={TIER_COLOR[r.tier]} stroke="#0b1220" strokeWidth={0.6} />
          ))}
        </svg>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>XTK LIMIT</span><span className="font-mono text-slate-300">{xtkLimit} nm</span>
          </div>
          <input type="range" min={5} max={60} step={1} value={xtkLimit} onChange={e => setXtkLimit(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>IN-TRAIL MIN</span><span className="font-mono text-slate-300">{trailLimit} nm</span>
          </div>
          <input type="range" min={20} max={120} step={5} value={trailLimit} onChange={e => setTrailLimit(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>ASSOC RNG</span><span className="font-mono text-slate-300">{maxAssocNm} nm</span>
          </div>
          <input type="range" min={40} max={250} step={10} value={maxAssocNm} onChange={e => setMaxAssocNm(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>MIN FL</span><span className="font-mono text-slate-300">FL{minFl}</span>
          </div>
          <input type="range" min={200} max={420} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap gap-1">
          {(['NAT', 'PACOT'] as System[]).map(s => (
            <button key={s} onClick={() => setSysFilter(o => ({ ...o, [s]: !o[s] }))}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${sysFilter[s] ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-500'}`}>{s}</button>
          ))}
          {(['EB', 'WB'] as Dir[]).map(d => (
            <button key={d} onClick={() => setDirFilter(o => ({ ...o, [d]: !o[d] }))}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${dirFilter[d] ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-500'}`}>{d}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showOverlay} onChange={e => setShowOverlay(e.target.checked)} className="accent-sky-500" /><span>OVL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showTracks} onChange={e => setShowTracks(e.target.checked)} className="accent-sky-500" /><span>TRK</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showWaypoints} onChange={e => setShowWaypoints(e.target.checked)} className="accent-sky-500" /><span>WPT</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLinks} onChange={e => setShowLinks(e.target.checked)} className="accent-sky-500" /><span>LINK</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / track"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 pt-2 flex gap-1 border-b border-slate-800">
        {(['AC', 'TR'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2.5 py-1 text-[10px] rounded-t border-x border-t font-mono ${tab === t ? 'bg-sky-500/10 border-sky-500/40 text-sky-100' : 'bg-slate-900/40 border-slate-800 text-slate-500'}`}>
            {t === 'AC' ? `AIRCRAFT (${filteredAC.length})` : `TRACKS (${trackRollup.length})`}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AC' && filteredAC.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No oceanic aircraft match.</div>
        )}
        {tab === 'AC' && filteredAC.map(r => (
          <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
            <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                <span className="ml-auto text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                <span>{r.track ? r.track.id : 'RND'}</span>
                <span>FL{r.fl}</span>
                <span>{r.f.velocityKts.toFixed(0)}kt</span>
                <span className="ml-auto">{r.xtkNm >= 0 ? `XTK ${r.xtkNm.toFixed(1)}nm` : '—'}</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                <span title="heading vs segment bearing">{'\u0394hdg'} {r.hdgDelta.toFixed(0)}{'\u00B0'}</span>
                <span title="cumulative along-track distance">A/T {r.cumulAlongNm.toFixed(0)}nm</span>
                <span className="ml-auto" title="in-trail to next a/c on same track">{isFinite(r.inTrailNm) ? `IT ${r.inTrailNm.toFixed(0)}nm` : 'IT —'}</span>
              </div>
              <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden">
                <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, (Math.max(0, r.xtkNm) / Math.max(xtkLimit * 4, 1)) * 100)}%`, background: TIER_COLOR[r.tier], opacity: 0.6 }} />
                <div className="absolute inset-y-0 w-px bg-sky-400/70" style={{ left: `${(1 / 4) * 100}%` }} />
                <div className="absolute inset-y-0 w-px bg-amber-400/70" style={{ left: `${(2.4 / 4) * 100}%` }} />
              </div>
              <div className="flex items-center gap-2 text-[10px] text-slate-500 font-mono mt-0.5">
                <span>{r.reasonChip}</span>
                <span className="ml-auto truncate">{r.inTrailCallsign ? `lead ${r.inTrailCallsign}` : (r.track ? r.track.dir : '')}</span>
              </div>
            </div>
          </button>
        ))}
        {tab === 'TR' && trackRollup.map(o => (
          <button key={o.tr.id} onClick={() => {
            const mid = o.tr.pts[Math.floor(o.tr.pts.length / 2)]
            onFlyLatLng(mid[1], mid[0], 4)
          }}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
            <span className="w-1 self-stretch rounded" style={{ background: o.tr.sys === 'NAT' ? '#38bdf8' : '#a78bfa' }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono font-semibold truncate" style={{ color: o.tr.sys === 'NAT' ? '#38bdf8' : '#a78bfa' }}>{o.tr.id}</span>
                <span className="text-slate-300 truncate">{o.tr.sys} {o.tr.dir}</span>
                <span className="ml-auto text-[10px] font-mono" style={{ color: TIER_COLOR[o.worst] }}>{o.worst}</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                <span>FL{o.tr.fl[0]}-{o.tr.fl[1]}</span>
                <span>{o.count} a/c</span>
                <span className="ml-auto">mean XTK {o.meanXtk.toFixed(1)}nm</span>
              </div>
              <div className="text-[10px] text-slate-500 font-mono mt-0.5 truncate" title={o.tr.desc}>{o.tr.desc}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
