'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   RAIM / Ionospheric Scintillation Monitor
   -----------------------------------------------------------
   Real ops concern: GPS-based navigation (RNP-AR approaches,
   LPV minima, oceanic RNP-4/RNP-10) depends on Receiver
   Autonomous Integrity Monitoring (RAIM) availability — at
   least 5 satellites in view with adequate geometry (HPL <
   alert limit). Two classes of degradation routinely take
   RAIM offline:

     (1) Ionospheric scintillation: rapid amplitude/phase
         fluctuations of the GNSS signal driven by F-region
         plasma irregularities. Concentrated in the equatorial
         anomaly bands (~+/-15deg geomagnetic, 1900-0200 local
         worst) and the auroral oval (>|55|deg geomagnetic
         during Kp>=5 storms). Indexed by S4 (amplitude) and
         sigma-phi (phase). S4 > 0.5 = strong; S4 > 0.8 = loss
         of lock is common.

     (2) GPS jamming/spoofing zones: regional EW activity
         (Eastern Med, Black Sea, Korean DMZ, Persian Gulf,
         Baltic, NW India/Pakistan, Libya) where ADS-B drop
         and unreliable position is repeatedly reported by
         OPSGROUP and ICAO.

   This panel computes a live RAIM-availability score for
   every airborne aircraft by composing:

     - geomagnetic latitude via IGRF-13 dipole transform
       (north pole 80.65N / -72.68W)
     - solar local time from longitude + UTC hour
     - F-region scintillation probability via Gaussian decay
       at +/-12deg geomagnetic latitude with a post-sunset
       (LT 19-02) 1.8x amplifier
     - auroral oval scintillation via |lambda_m| >= 55 with
       Kp-modulated boundary equatorward expansion
       (1.5deg per Kp step above Kp=3)
     - distance-to-nearest active jamming polygon (12 zones)
       Gaussian decay with sigma = 80nm
     - solar storm modifier (Kp slider 0-9) globally amps
       both scintillation and auroral terms

   Per-aircraft score = clamp(0, 1, 0.45*ionoScint +
   0.45*jamProx + 0.10*kpAmp) classified into 4 tiers
   LOSS>=0.65 rose / DEGRADED>=0.40 amber / WATCH>=0.18
   yellow / NOMINAL sky. RNP-capability impact computed
   per-aircraft: NOMINAL flies LPV-200 / 0.3, WATCH demoted
   to LNAV/VNAV / 0.5, DEGRADED RNP-1 only, LOSS = RAIM
   UNAVAILABLE (must revert to ground-based nav, GPS-no
   procedure).

   MapLibre overlay:
     - dashed kind-coloured jamming-zone polygons with id
     - 4 dashed iso-geomagnetic-latitude bands at +/-15/55
       (rose equatorial anomaly / amber auroral oval)
     - tier-coloured halo rings sized by score
     - dashed sky link from each aircraft to nearest jamming
       zone when within 200nm
     - callsign + tier + S4-equivalent labels

   Side panel:
     - 4-tier counter strip click-to-filter
     - 3-cell summary: LOSS-COUNT / KP-LEVEL / RAIM-AVAIL%
     - SVG geomag-latitude vs score scatter (every aircraft
       plotted, scintillation envelopes shaded)
     - KP slider 0-9, JAM-SIGMA slider, MIN-FL slider
     - jamming-zone enable/disable per-zone chip row
     - OVL/BANDS/ZONES/LINK/LBL toggles
     - search callsign / icao / type / operator / zone
     - AIRCRAFT tab sorted tier worst-first then score desc
     - ZONES tab sorted by enclosed-aircraft count desc
     - click-to-fly per row
   ============================================================ */

export interface RmFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: RmFlight[]
  onClose: () => void
  onFly: (icao: string) => void
  onFlyLatLng: (lat: number, lng: number, zoom?: number) => void
}

type Tier = 'NOMINAL' | 'WATCH' | 'DEGRADED' | 'LOSS'
const TIER_COLOR: Record<Tier, string> = {
  NOMINAL: '#0ea5e9',
  WATCH: '#fde047',
  DEGRADED: '#f59e0b',
  LOSS: '#ef4444',
}
const TIER_ORDER: Tier[] = ['LOSS', 'DEGRADED', 'WATCH', 'NOMINAL']
const RNP_BY_TIER: Record<Tier, string> = {
  NOMINAL: 'LPV-200 / RNP 0.3',
  WATCH: 'LNAV-VNAV / RNP 0.5',
  DEGRADED: 'RNP 1.0 only',
  LOSS: 'RAIM UNAVAIL',
}

type JamKind = 'EW' | 'CONFLICT' | 'TEST'
const KIND_COLOR: Record<JamKind, string> = {
  EW: '#ef4444',
  CONFLICT: '#f59e0b',
  TEST: '#a78bfa',
}

interface JamZone {
  id: string
  name: string
  region: string
  kind: JamKind
  // polygon vertices (lon, lat) — coarse OPSGROUP / ICAO bulletins
  poly: Array<[number, number]>
  intensity: number  // 0..1 baseline
}

/* OPSGROUP / EASA bulletin GPS-interference zones (coarse) */
const JAM_ZONES: JamZone[] = [
  { id: 'EMED', name: 'Eastern Mediterranean', region: 'LCCC/LLLL/LCNC', kind: 'EW', intensity: 0.95,
    poly: [[31.5, 32.5], [37.5, 32.5], [37.5, 37.0], [31.5, 37.0]] },
  { id: 'BSEA', name: 'Black Sea', region: 'UKFV/LTAA', kind: 'EW', intensity: 0.85,
    poly: [[27.0, 41.0], [41.0, 41.0], [41.0, 47.0], [27.0, 47.0]] },
  { id: 'KAL', name: 'Kaliningrad / Baltic', region: 'EYVL/EVRR/EFIN', kind: 'EW', intensity: 0.80,
    poly: [[18.0, 53.5], [27.5, 53.5], [27.5, 60.0], [18.0, 60.0]] },
  { id: 'PG', name: 'Persian Gulf', region: 'OBBB/OEJD/OOMM', kind: 'EW', intensity: 0.75,
    poly: [[47.0, 24.0], [56.5, 24.0], [56.5, 31.0], [47.0, 31.0]] },
  { id: 'DMZ', name: 'Korea DMZ / Yellow Sea', region: 'RKRR/ZSHA', kind: 'CONFLICT', intensity: 0.70,
    poly: [[124.0, 36.5], [130.5, 36.5], [130.5, 40.0], [124.0, 40.0]] },
  { id: 'NWI', name: 'NW India / Pakistan border', region: 'OPLR/VIDP', kind: 'CONFLICT', intensity: 0.65,
    poly: [[68.5, 28.0], [76.0, 28.0], [76.0, 34.5], [68.5, 34.5]] },
  { id: 'LIBY', name: 'Libya / Central Med', region: 'HLLL', kind: 'CONFLICT', intensity: 0.60,
    poly: [[10.0, 30.0], [25.0, 30.0], [25.0, 35.0], [10.0, 35.0]] },
  { id: 'SYR', name: 'Syria / Levant inland', region: 'OSTT/LLLL', kind: 'EW', intensity: 0.90,
    poly: [[35.5, 32.0], [42.5, 32.0], [42.5, 37.5], [35.5, 37.5]] },
  { id: 'YEM', name: 'Yemen / Bab-el-Mandeb', region: 'OYSC/HHAA', kind: 'CONFLICT', intensity: 0.70,
    poly: [[42.0, 12.0], [54.0, 12.0], [54.0, 18.0], [42.0, 18.0]] },
  { id: 'AFG', name: 'Afghanistan corridor', region: 'OAKB', kind: 'CONFLICT', intensity: 0.55,
    poly: [[60.5, 29.5], [75.0, 29.5], [75.0, 38.5], [60.5, 38.5]] },
  { id: 'NCYP', name: 'Cyprus FIR', region: 'LCCC', kind: 'EW', intensity: 0.78,
    poly: [[32.0, 33.5], [36.0, 33.5], [36.0, 36.5], [32.0, 36.5]] },
  { id: 'CHRD', name: 'China Sea / Hainan', region: 'ZJSA/ZGZU', kind: 'TEST', intensity: 0.50,
    poly: [[108.0, 16.0], [114.0, 16.0], [114.0, 22.0], [108.0, 22.0]] },
]

/* ---------- math helpers ---------- */
const R_NM = 3440.065
function distNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dφ = (la2 - la1) * Math.PI / 180, dλ = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_NM * Math.asin(Math.sqrt(a))
}

/* IGRF-13 dipole pole 80.65N, -72.68W */
const NMP_LAT = 80.65 * Math.PI / 180
const NMP_LON = -72.68 * Math.PI / 180
function geomagLatDeg(latDeg: number, lonDeg: number): number {
  const φ = latDeg * Math.PI / 180
  const λ = lonDeg * Math.PI / 180
  const sinLm = Math.sin(φ) * Math.sin(NMP_LAT) + Math.cos(φ) * Math.cos(NMP_LAT) * Math.cos(λ - NMP_LON)
  return Math.asin(Math.max(-1, Math.min(1, sinLm))) * 180 / Math.PI
}

/* point-in-polygon ray cast (poly = array of [lon, lat]) */
function pointInPoly(lat: number, lng: number, poly: Array<[number, number]>): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi)) inside = !inside
  }
  return inside
}

function distToPolyNm(lat: number, lng: number, poly: Array<[number, number]>): number {
  if (pointInPoly(lat, lng, poly)) return 0
  let best = Infinity
  for (let i = 0; i < poly.length; i++) {
    const [x, y] = poly[i]
    const d = distNm(lat, lng, y, x)
    if (d < best) best = d
  }
  return best
}

function polyCentroid(poly: Array<[number, number]>): { lat: number, lng: number } {
  let sx = 0, sy = 0
  for (const [x, y] of poly) { sx += x; sy += y }
  return { lat: sy / poly.length, lng: sx / poly.length }
}

interface Row {
  f: RmFlight
  altFt: number
  glat: number    // geomagnetic latitude
  slt: number     // solar local time (h, 0-24)
  scintEq: number // equatorial anomaly contribution 0..1
  scintAur: number // auroral oval contribution 0..1
  ionoScint: number
  jamProx: number
  nearestZone: JamZone | null
  nearestNm: number
  insideZone: boolean
  score: number
  tier: Tier
  s4: number  // approx S4 amplitude index 0..1.2
}

const SRC_RING = 'rm-ring', SRC_LINK = 'rm-link', SRC_LBL = 'rm-lbl', SRC_BAND = 'rm-band', SRC_ZONE = 'rm-zone', SRC_ZLBL = 'rm-zlbl'
const LYR_RING = 'rm-ring-l', LYR_LINK = 'rm-link-l', LYR_LBL = 'rm-lbl-l', LYR_BAND = 'rm-band-l', LYR_ZONE_FILL = 'rm-zonef-l', LYR_ZONE_LINE = 'rm-zonel-l', LYR_ZLBL = 'rm-zlbl-l'

export default function RaimMonitor({ map, flights, onClose, onFly, onFlyLatLng }: Props) {
  const [tab, setTab] = useState<'AC' | 'ZN'>('AC')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [kp, setKp] = useState<number>(3)
  const [jamSigma, setJamSigma] = useState<number>(80)
  const [minFl, setMinFl] = useState<number>(50)
  const [zonesOn, setZonesOn] = useState<Record<string, boolean>>(() => {
    const o: Record<string, boolean> = {}
    for (const z of JAM_ZONES) o[z.id] = true
    return o
  })
  const [showOverlay, setShowOverlay] = useState(true)
  const [showBands, setShowBands] = useState(true)
  const [showZones, setShowZones] = useState(true)
  const [showLinks, setShowLinks] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [query, setQuery] = useState('')

  /* compute rows */
  const rows: Row[] = useMemo(() => {
    const now = new Date()
    const utcH = now.getUTCHours() + now.getUTCMinutes() / 60
    const activeZones = JAM_ZONES.filter(z => zonesOn[z.id])
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt) || f.altitudeFt < minFl * 100) continue
      const glat = geomagLatDeg(f.lat, f.lng)
      const slt = ((utcH + f.lng / 15) % 24 + 24) % 24
      // equatorial anomaly: Gaussian centered at +/-12deg, sigma 8, post-sunset amp
      const eqDist = Math.min(Math.abs(glat - 12), Math.abs(glat + 12))
      let scintEq = Math.exp(-((eqDist / 8) ** 2))
      const sltAmp = (slt >= 19 || slt <= 2) ? 1.8 : (slt >= 17 && slt < 19 ? 1.2 : 0.4)
      scintEq *= sltAmp
      // auroral oval: |glat| >= (55 - 1.5*max(0, kp-3))
      const auroralEdge = 55 - 1.5 * Math.max(0, kp - 3)
      let scintAur = 0
      if (Math.abs(glat) >= auroralEdge) {
        const into = Math.abs(glat) - auroralEdge
        scintAur = Math.min(1, 0.35 + 0.10 * into) * (0.6 + 0.10 * kp)
      }
      const kpAmp = Math.min(1, kp / 9)
      const ionoScint = Math.min(1, 0.55 * scintEq + 0.9 * scintAur + 0.05 * kpAmp)
      // jamming proximity
      let bestZone: JamZone | null = null
      let bestNm = Infinity
      let bestScore = 0
      let inside = false
      for (const z of activeZones) {
        const d = distToPolyNm(f.lat, f.lng, z.poly)
        if (d < bestNm) { bestNm = d; bestZone = z }
        if (d === 0) inside = true
        const term = Math.exp(-((d / jamSigma) ** 2)) * z.intensity
        if (term > bestScore) bestScore = term
      }
      const jamProx = bestScore
      const score = Math.min(1, 0.45 * ionoScint + 0.45 * jamProx + 0.10 * kpAmp)
      let tier: Tier
      if (score >= 0.65) tier = 'LOSS'
      else if (score >= 0.40) tier = 'DEGRADED'
      else if (score >= 0.18) tier = 'WATCH'
      else tier = 'NOMINAL'
      const s4 = Math.min(1.2, 0.05 + ionoScint * 1.05)
      out.push({
        f, altFt: f.altitudeFt, glat, slt,
        scintEq, scintAur, ionoScint, jamProx,
        nearestZone: bestZone, nearestNm: bestNm === Infinity ? -1 : bestNm, insideZone: inside,
        score, tier, s4,
      })
    }
    return out
  }, [flights, kp, jamSigma, minFl, zonesOn])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { NOMINAL: 0, WATCH: 0, DEGRADED: 0, LOSS: 0 }
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
        || (r.nearestZone?.id || '').toLowerCase().includes(q)
    }).sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return b.score - a.score
    })
  }, [rows, tierFilter, query])

  const zoneRollup = useMemo(() => {
    const out = JAM_ZONES.map(z => {
      let inside = 0, near = 0, worst: Tier = 'NOMINAL'
      for (const r of rows) {
        if (r.insideZone && r.nearestZone?.id === z.id) {
          inside++
          if (TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(worst)) worst = r.tier
        } else if (r.nearestZone?.id === z.id && r.nearestNm < 200) {
          near++
        }
      }
      return { z, inside, near, worst, enabled: !!zonesOn[z.id] }
    })
    const q = query.trim().toLowerCase()
    return out.filter(o => !q || o.z.id.toLowerCase().includes(q) || o.z.name.toLowerCase().includes(q) || o.z.region.toLowerCase().includes(q))
      .sort((a, b) => (b.inside - a.inside) || (b.near - a.near))
  }, [rows, zonesOn, query])

  const summary = useMemo(() => {
    const total = rows.length
    const ok = counts.NOMINAL + counts.WATCH
    return {
      lossCount: counts.LOSS,
      avail: total > 0 ? (ok / total) * 100 : 100,
      total,
    }
  }, [rows, counts])

  /* ---------- MapLibre overlay ---------- */
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        for (const s of [SRC_BAND, SRC_ZONE, SRC_RING, SRC_LINK, SRC_LBL, SRC_ZLBL]) {
          if (!map.getSource(s)) map.addSource(s, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        }
        if (!map.getLayer(LYR_BAND)) map.addLayer({
          id: LYR_BAND, type: 'line', source: SRC_BAND,
          paint: { 'line-color': ['get', 'color'], 'line-width': 1.1, 'line-opacity': 0.45, 'line-dasharray': [4, 3] },
        })
        if (!map.getLayer(LYR_ZONE_FILL)) map.addLayer({
          id: LYR_ZONE_FILL, type: 'fill', source: SRC_ZONE,
          paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.08 },
        })
        if (!map.getLayer(LYR_ZONE_LINE)) map.addLayer({
          id: LYR_ZONE_LINE, type: 'line', source: SRC_ZONE,
          paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.85, 'line-dasharray': [3, 2] },
        })
        if (!map.getLayer(LYR_LINK)) map.addLayer({
          id: LYR_LINK, type: 'line', source: SRC_LINK,
          paint: { 'line-color': ['get', 'color'], 'line-width': 1.1, 'line-opacity': 0.55, 'line-dasharray': [2, 2] },
        })
        if (!map.getLayer(LYR_RING)) map.addLayer({
          id: LYR_RING, type: 'circle', source: SRC_RING,
          paint: {
            'circle-radius': ['get', 'r'],
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.10,
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-width': 1.4,
            'circle-stroke-opacity': 0.85,
          },
        })
        if (!map.getLayer(LYR_LBL)) map.addLayer({
          id: LYR_LBL, type: 'symbol', source: SRC_LBL,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 10,
            'text-offset': [0, -1.7],
            'text-anchor': 'bottom',
            'text-allow-overlap': false,
          },
          paint: {
            'text-color': ['get', 'color'],
            'text-halo-color': '#0b1220',
            'text-halo-width': 1.2,
          },
        })
        if (!map.getLayer(LYR_ZLBL)) map.addLayer({
          id: LYR_ZLBL, type: 'symbol', source: SRC_ZLBL,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 11,
            'text-anchor': 'center',
            'text-allow-overlap': true,
          },
          paint: {
            'text-color': ['get', 'color'],
            'text-halo-color': '#0b1220',
            'text-halo-width': 1.4,
          },
        })
      } catch {}
    }
    if (map.isStyleLoaded()) ensure()
    else map.once('load', ensure)
  }, [map])

  useEffect(() => {
    if (!map) return
    const ringFeats: any[] = []
    const linkFeats: any[] = []
    const lblFeats: any[] = []
    const bandFeats: any[] = []
    const zoneFeats: any[] = []
    const zlblFeats: any[] = []

    // iso-geomagnetic bands at +/-15 (equatorial anomaly) and +/-55 (auroral edge)
    if (showBands && showOverlay) {
      const auroralEdge = 55 - 1.5 * Math.max(0, kp - 3)
      const bandSpecs: Array<{ lm: number, color: string }> = [
        { lm: 15, color: '#ef4444' }, { lm: -15, color: '#ef4444' },
        { lm: auroralEdge, color: '#f59e0b' }, { lm: -auroralEdge, color: '#f59e0b' },
      ]
      for (const b of bandSpecs) {
        // sample each longitude, bisect geographic latitude until geomagLat == lm
        const coords: Array<[number, number]> = []
        for (let lon = -180; lon <= 180; lon += 4) {
          let lo = -85, hi = 85
          // find geographic lat such that geomagLat(lat,lon) == b.lm
          // function is monotonic in lat for fixed lon? not strictly, but bisect is fine for the dominant root
          for (let k = 0; k < 24; k++) {
            const mid = (lo + hi) / 2
            const v = geomagLatDeg(mid, lon)
            if ((v - b.lm) > 0) hi = mid; else lo = mid
          }
          coords.push([lon, (lo + hi) / 2])
        }
        bandFeats.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: { color: b.color },
        })
      }
    }

    // jamming zones
    if (showZones && showOverlay) {
      for (const z of JAM_ZONES) {
        if (!zonesOn[z.id]) continue
        const ring = [...z.poly, z.poly[0]]
        zoneFeats.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [ring] },
          properties: { color: KIND_COLOR[z.kind], id: z.id },
        })
        const c = polyCentroid(z.poly)
        zlblFeats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
          properties: { color: KIND_COLOR[z.kind], label: `\u26A0 ${z.id}` },
        })
      }
    }

    // aircraft + links
    const visible = showOverlay ? (tierFilter === 'ALL' ? rows : rows.filter(r => r.tier === tierFilter)) : []
    for (const r of visible) {
      ringFeats.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
        properties: { color: TIER_COLOR[r.tier], r: 8 + Math.round(r.score * 22) },
      })
      if (showLinks && r.nearestZone && r.nearestNm >= 0 && r.nearestNm < 200 && !r.insideZone) {
        const c = polyCentroid(r.nearestZone.poly)
        linkFeats.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [c.lng, c.lat]] },
          properties: { color: TIER_COLOR[r.tier] },
        })
      }
      if (showLabels) {
        lblFeats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
          properties: {
            color: TIER_COLOR[r.tier],
            label: `${(r.f.callsign || r.f.icao).trim()} \u2022 ${r.tier} \u2022 S4 ${r.s4.toFixed(2)}`,
          },
        })
      }
    }
    try {
      ;(map.getSource(SRC_BAND) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: bandFeats })
      ;(map.getSource(SRC_ZONE) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: zoneFeats })
      ;(map.getSource(SRC_ZLBL) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: zlblFeats })
      ;(map.getSource(SRC_RING) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: ringFeats })
      ;(map.getSource(SRC_LINK) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: linkFeats })
      ;(map.getSource(SRC_LBL) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lblFeats })
    } catch {}
  }, [map, rows, tierFilter, showOverlay, showBands, showZones, showLinks, showLabels, zonesOn, kp])

  useEffect(() => () => {
    if (!map) return
    try { for (const l of [LYR_ZLBL, LYR_LBL, LYR_RING, LYR_LINK, LYR_ZONE_LINE, LYR_ZONE_FILL, LYR_BAND]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
    try { for (const s of [SRC_ZLBL, SRC_LBL, SRC_RING, SRC_LINK, SRC_ZONE, SRC_BAND]) if (map.getSource(s)) map.removeSource(s) } catch {}
  }, [map])

  /* ---------- scatter diagram ---------- */
  const diag = useMemo(() => {
    const W = 348, H = 170, padL = 30, padR = 8, padT = 8, padB = 22
    const sx = (lm: number) => padL + (lm + 90) / 180 * (W - padL - padR)
    const sy = (s: number) => H - padB - s * (H - padT - padB)
    return { W, H, sx, sy, padL, padR, padT, padB }
  }, [])

  return (
    <div className="fixed top-16 right-3 z-40 w-[390px] max-h-[calc(100vh-5rem)] flex flex-col rounded-lg border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">&#9678;</span>
          <span className="text-sm font-semibold tracking-wide">GPS / RAIM</span>
          <span className="text-[10px] text-slate-500">scintillation + jamming</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      {/* tier strip */}
      <div className="px-3 py-2 grid grid-cols-4 gap-1 border-b border-slate-800">
        {(['LOSS', 'DEGRADED', 'WATCH', 'NOMINAL'] as Tier[]).map(t => (
          <button key={t}
            onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`flex flex-col items-center rounded px-1 py-1 border ${tierFilter === t ? 'border-sky-500/50 bg-sky-500/10' : 'border-slate-800 bg-slate-900/40'}`}
            style={{ color: TIER_COLOR[t] }} title={t}>
            <span className="text-[9px] tracking-wider">{t.slice(0, 4)}</span>
            <span className="text-sm font-mono">{counts[t]}</span>
          </button>
        ))}
      </div>

      {/* summary */}
      <div className="px-3 py-2 grid grid-cols-3 gap-1 border-b border-slate-800">
        <div className="text-center">
          <div className="text-[9px] text-slate-500 tracking-wider">LOSS A/C</div>
          <div className="text-base font-mono" style={{ color: counts.LOSS ? TIER_COLOR.LOSS : '#94a3b8' }}>{summary.lossCount}</div>
        </div>
        <div className="text-center">
          <div className="text-[9px] text-slate-500 tracking-wider">KP</div>
          <div className="text-base font-mono" style={{ color: kp >= 5 ? TIER_COLOR.DEGRADED : '#94a3b8' }}>{kp.toFixed(1)}</div>
        </div>
        <div className="text-center">
          <div className="text-[9px] text-slate-500 tracking-wider">RAIM AVAIL</div>
          <div className="text-base font-mono" style={{ color: summary.avail >= 90 ? '#10b981' : summary.avail >= 70 ? TIER_COLOR.WATCH : TIER_COLOR.DEGRADED }}>{summary.avail.toFixed(0)}%</div>
        </div>
      </div>

      {/* scatter diagram */}
      <div className="px-3 py-2 border-b border-slate-800 bg-slate-900/30">
        <div className="text-[10px] text-slate-500 tracking-wider flex items-center justify-between mb-1">
          <span>{'GEOMAG LAT vs RAIM SCORE'}</span>
          <span className="font-mono text-slate-400">{rows.length} a/c</span>
        </div>
        <svg width={diag.W} height={diag.H} className="block">
          <rect x={0} y={0} width={diag.W} height={diag.H} fill="#0b1220" />
          {/* equatorial anomaly band shading +/-15 +/-8 */}
          <rect x={diag.sx(-25)} y={diag.padT} width={diag.sx(25) - diag.sx(-25)} height={diag.H - diag.padT - diag.padB} fill="#ef4444" opacity={0.06} />
          {/* auroral edges */}
          {(() => {
            const e = 55 - 1.5 * Math.max(0, kp - 3)
            return (
              <>
                <rect x={diag.padL} y={diag.padT} width={diag.sx(-e) - diag.padL} height={diag.H - diag.padT - diag.padB} fill="#f59e0b" opacity={0.06} />
                <rect x={diag.sx(e)} y={diag.padT} width={diag.W - diag.padR - diag.sx(e)} height={diag.H - diag.padT - diag.padB} fill="#f59e0b" opacity={0.06} />
              </>
            )
          })()}
          {/* x gridlines */}
          {[-60, -30, 0, 30, 60].map(g => (
            <g key={g}>
              <line x1={diag.sx(g)} x2={diag.sx(g)} y1={diag.padT} y2={diag.H - diag.padB} stroke="#1e293b" strokeWidth={0.5} />
              <text x={diag.sx(g) - 8} y={diag.H - 8} fill="#475569" fontSize={8} fontFamily="ui-monospace, monospace">{g > 0 ? `+${g}` : g}</text>
            </g>
          ))}
          {/* y gridlines / tier thresholds */}
          {[
            { y: 0.18, c: '#fde047' }, { y: 0.40, c: '#f59e0b' }, { y: 0.65, c: '#ef4444' },
          ].map(t => (
            <line key={t.y} x1={diag.padL} x2={diag.W - diag.padR} y1={diag.sy(t.y)} y2={diag.sy(t.y)} stroke={t.c} strokeWidth={0.6} strokeDasharray="3 2" opacity={0.6} />
          ))}
          {filteredAC.map(r => (
            <circle key={r.f.icao} cx={diag.sx(r.glat)} cy={diag.sy(r.score)} r={2.6}
              fill={TIER_COLOR[r.tier]} stroke="#0b1220" strokeWidth={0.6} />
          ))}
        </svg>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>SOLAR Kp INDEX</span>
            <span className="font-mono text-slate-300">{kp.toFixed(1)} {kp >= 5 ? '\u2022 STORM' : kp >= 4 ? '\u2022 ACTIVE' : '\u2022 QUIET'}</span>
          </div>
          <input type="range" min={0} max={9} step={0.5} value={kp} onChange={e => setKp(parseFloat(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>JAM SIGMA</span>
            <span className="font-mono text-slate-300">{jamSigma} nm</span>
          </div>
          <input type="range" min={30} max={250} step={10} value={jamSigma} onChange={e => setJamSigma(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>MIN FL</span>
            <span className="font-mono text-slate-300">FL{minFl}</span>
          </div>
          <input type="range" min={0} max={450} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap gap-1">
          {JAM_ZONES.map(z => (
            <button key={z.id} onClick={() => setZonesOn(s => ({ ...s, [z.id]: !s[z.id] }))}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${zonesOn[z.id] ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-500'}`}
              title={z.name}>{z.id}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showOverlay} onChange={e => setShowOverlay(e.target.checked)} className="accent-sky-500" /><span>OVL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showBands} onChange={e => setShowBands(e.target.checked)} className="accent-sky-500" /><span>BANDS</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showZones} onChange={e => setShowZones(e.target.checked)} className="accent-sky-500" /><span>ZONES</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLinks} onChange={e => setShowLinks(e.target.checked)} className="accent-sky-500" /><span>LINK</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / zone"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      {/* tabs */}
      <div className="px-3 pt-2 flex gap-1 border-b border-slate-800">
        {(['AC', 'ZN'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2.5 py-1 text-[10px] rounded-t border-x border-t font-mono ${tab === t ? 'bg-sky-500/10 border-sky-500/40 text-sky-100' : 'bg-slate-900/40 border-slate-800 text-slate-500'}`}>
            {t === 'AC' ? `AIRCRAFT (${filteredAC.length})` : `ZONES (${zoneRollup.length})`}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AC' && filteredAC.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
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
                <span title="geomagnetic latitude">{'\u03BB'}m {r.glat >= 0 ? '+' : ''}{r.glat.toFixed(1)}{'\u00B0'}</span>
                <span title="solar local time">LT {Math.floor(r.slt).toString().padStart(2,'0')}:{Math.floor((r.slt%1)*60).toString().padStart(2,'0')}</span>
                <span className="ml-auto" title="S4 amplitude index">S4 {r.s4.toFixed(2)}</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                <span title="ionospheric scintillation component">ION {(r.ionoScint*100).toFixed(0)}%</span>
                <span title="jamming proximity component">JAM {(r.jamProx*100).toFixed(0)}%</span>
                <span className="ml-auto" title="RAIM availability score (higher = worse)">SCORE {(r.score*100).toFixed(0)}</span>
              </div>
              <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden">
                <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, r.score*100)}%`, background: TIER_COLOR[r.tier], opacity: 0.6 }} />
                <div className="absolute inset-y-0 w-px bg-yellow-400/60" style={{ left: '18%' }} />
                <div className="absolute inset-y-0 w-px bg-amber-400/60" style={{ left: '40%' }} />
                <div className="absolute inset-y-0 w-px bg-rose-400/70" style={{ left: '65%' }} />
              </div>
              <div className="flex items-center gap-2 text-[10px] text-slate-500 font-mono mt-0.5">
                <span title="RNP capability at this RAIM tier">{RNP_BY_TIER[r.tier]}</span>
                <span className="ml-auto truncate">
                  {r.insideZone ? <span style={{ color: TIER_COLOR.LOSS }}>INSIDE {r.nearestZone?.id}</span>
                    : r.nearestZone && r.nearestNm >= 0 && r.nearestNm < 400 ? `${r.nearestZone.id} ${r.nearestNm.toFixed(0)}nm`
                    : '\u2014'}
                </span>
              </div>
            </div>
          </button>
        ))}
        {tab === 'ZN' && zoneRollup.map(o => (
          <button key={o.z.id} onClick={() => { const c = polyCentroid(o.z.poly); onFlyLatLng(c.lat, c.lng, 5) }}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
            <span className="w-1 self-stretch rounded" style={{ background: KIND_COLOR[o.z.kind] }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono font-semibold truncate" style={{ color: KIND_COLOR[o.z.kind] }}>{o.z.id}</span>
                <span className="text-slate-300 truncate">{o.z.name}</span>
                <span className="ml-auto text-[10px] font-mono" style={{ color: TIER_COLOR[o.worst] }}>{o.worst}</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                <span title="kind">{o.z.kind}</span>
                <span className="truncate">{o.z.region}</span>
                <span className="ml-auto">int {(o.z.intensity*100).toFixed(0)}%</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                <span style={{ color: o.inside ? TIER_COLOR.LOSS : '#94a3b8' }}>inside {o.inside}</span>
                <span>near {o.near}</span>
                <span className="ml-auto" style={{ color: o.enabled ? '#10b981' : '#64748b' }}>{o.enabled ? 'ENABLED' : 'OFF'}</span>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
