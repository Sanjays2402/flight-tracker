'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   RECAT-EU Pairwise Wake Vortex Separation Monitor
   -----------------------------------------------------------
   ICAO Doc 9426 ATS Planning Manual / EUROCONTROL RECAT-EU
   Wake Turbulence Re-Categorisation Edition 1.2 (2018) /
   FAA JO 7110.659C RECAT 1.5 / EASA SIB 2014-23 Wake
   Re-Categorisation. Live pairwise leader→follower distance
   compliance check for every airborne aircraft on final-approach
   capture (within CAPTURE nm of inferred destination, descending
   below FL120 with intercept track aligned ±45° to runway
   bearing to airport).

   RECAT-EU defines six wake categories A..F by MTOW + wingspan
   (and approach-speed band for E/F light singles):
     CAT-A  Super-Heavy   MTOW ≥ 136 t & span ≥ 72m  (A380, AN-225)
     CAT-B  Upper Heavy   MTOW ≥ 136 t & 60 ≤ span < 72m
                            (B777, B748, A340-500/600, B788, A350)
     CAT-C  Lower Heavy   MTOW ≥ 136 t & span < 60m
                            (A310, B767, B772, A330 short-span)
     CAT-D  Upper Medium  100 t > MTOW < 136 t OR
                            15 < MTOW < 100 t & span > 32m
                            (B757, B767-200, EMB190 long-span)
     CAT-E  Lower Medium  15 < MTOW ≤ 100 t & span ≤ 32m
                            (B737, A320, A220, EMB145, CRJ)
     CAT-F  Light         MTOW ≤ 15 t  (LJ, C172, PC12, PA28)

   RECAT-EU pairwise distance minima (nm) on common approach
   track (Doc 9426 Tab 4-2 + EUROCONTROL RECAT-EU Annex A):
                  Follower
   Leader   A    B    C    D    E    F
     A     3    4    5    5    6    8
     B     -    3    4    4    5    7
     C     -    -    3    3    4    6
     D     -    -    -    -    -    5
     E     -    -    -    -    -    4
     F     -    -    -    -    -    3
   (cells "-" inherit the ICAO baseline 2.5 nm radar minimum)

   Tier classification per follower-pair:
     OK        gap >= req + 0.5 nm        emerald nominal
     TIGHT     req <= gap < req + 0.5 nm  sky within margin
     PRESS     0.85*req <= gap < req      amber compressing
     BUST      gap < 0.85*req             rose RECAT bust
     SOLO      no qualifying leader       slate single
     OUT       no inferrable destination  slate excluded

   MapLibre overlay:
     - Tier-coloured halo rings sized by deficit 8-22 px
     - Dashed pair-line follower↔leader great-circle 24-pt
     - Rose diamond pin at midpoint for BUST
     - Tier-coloured callsign + gap-nm labels for non-OK
     - Per-airport rose pin when any BUST on that field

   Side panel:
     - 6-tier counter strip click-to-filter (no OUT chip)
     - 3-cell MEAN-GAP / WORST callsign+gap / BUST-COUNT
     - 2-cell MEAN-REQ / PAIR-COUNT secondary row
     - SVG gap-vs-req-nm scatter, emerald/sky/amber/rose
       threshold bands shaded with dashed identity & 0.85x lines
     - 5 sliders MIN-FL / MAX-FL / CAPTURE / MIN-GAP /
       FOLLOWER-MUL in 2-col grid + INTERCEPT-TOL full-width
     - 6-category chip filter A..F
     - HALO / PAIR / PIN / LBL / DIAG toggles + search
     - PAIRS / AIRPORTS tab switcher
     - PAIRS tier-worst-first then deficit desc
     - AIRPORTS grouped by destination worst-tier-first

   Persisted: ft-recat
   ============================================================ */

export interface RecatFlight {
  icao: string
  callsign?: string
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
  flights: RecatFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'TIGHT' | 'PRESS' | 'BUST' | 'SOLO' | 'OUT'
const TIER_COLOR: Record<Tier, string> = {
  OK: '#10b981',
  TIGHT: '#0ea5e9',
  PRESS: '#f59e0b',
  BUST: '#f43f5e',
  SOLO: '#64748b',
  OUT: '#475569',
}
const TIER_ORDER: Tier[] = ['BUST', 'PRESS', 'TIGHT', 'OK', 'SOLO']
const TIER_RANK: Record<Tier, number> = { BUST: 0, PRESS: 1, TIGHT: 2, OK: 3, SOLO: 4, OUT: 5 }

type Cat = 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
const CAT_NAME: Record<Cat, string> = {
  A: 'Super-Heavy (A380 / AN-225)',
  B: 'Upper Heavy (B777 / B748 / A350 / A340-600)',
  C: 'Lower Heavy (B767 / A330 short-span)',
  D: 'Upper Medium (B757 / E190 long-span)',
  E: 'Lower Medium (B737 / A320 / E145 / CRJ)',
  F: 'Light (LJ / C172 / PA28 / PC12)',
}
const CAT_ORDER: Cat[] = ['A', 'B', 'C', 'D', 'E', 'F']

// RECAT-EU minima matrix (nm). 0 means "fallback to ICAO 2.5 nm radar baseline".
const RECAT_MIN: Record<Cat, Record<Cat, number>> = {
  A: { A: 3, B: 4, C: 5, D: 5, E: 6, F: 8 },
  B: { A: 0, B: 3, C: 4, D: 4, E: 5, F: 7 },
  C: { A: 0, B: 0, C: 3, D: 3, E: 4, F: 6 },
  D: { A: 0, B: 0, C: 0, D: 0, E: 0, F: 5 },
  E: { A: 0, B: 0, C: 0, D: 0, E: 0, F: 4 },
  F: { A: 0, B: 0, C: 0, D: 0, E: 0, F: 3 },
}
const BASELINE_NM = 2.5

function classify(t: string | undefined, cat?: string): Cat {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || /(EC|R44|R66|S76|S92|UH|AW139|H125|H145|H160)/.test(x)) return 'F'
  if (/^A38/.test(x) || /AN225/.test(x)) return 'A'
  if (/^(B77|B74|A35|A34[56])/.test(x)) return 'B'
  if (/^(B76|A33|A31[0]|IL96|MD11|DC10|L101)/.test(x)) return 'C'
  if (/^(B75|E290|E29[5-9])/.test(x)) return 'D'
  if (/^(B73|B72|B71|A31[789]|A32|A19|A20|A21|A22|MD8|MD9|BCS|CS1|CS3|CRJ|E14|E15|E17|E19|AT4|AT5|AT7|DH8|Q40|SF34|J32|J41|ATR)/.test(x)) return 'E'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40|TBM|PC12|TB|PC6|DHC|AN2|BE9|BE3|BE2|C72|C82|C17|P28|SR2|DA4|DA62|PA|M20|C20)/.test(x)) return 'F'
  return 'E'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

function haversineNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const toRad = (x: number) => (x * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (x: number) => (x * Math.PI) / 180
  const φ1 = toRad(lat1), φ2 = toRad(lat2)
  const Δλ = toRad(lng2 - lng1)
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

function angDiff(a: number, b: number): number {
  const d = Math.abs(((a - b + 540) % 360) - 180)
  return d
}

function greatCirclePoints(lat1: number, lng1: number, lat2: number, lng2: number, n: number): [number, number][] {
  const toRad = (x: number) => (x * Math.PI) / 180
  const toDeg = (x: number) => (x * 180) / Math.PI
  const φ1 = toRad(lat1), λ1 = toRad(lng1), φ2 = toRad(lat2), λ2 = toRad(lng2)
  const d = 2 * Math.asin(Math.sqrt(Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2))
  if (!isFinite(d) || d < 1e-9) return [[lng1, lat1], [lng2, lat2]]
  const pts: [number, number][] = []
  for (let i = 0; i <= n; i++) {
    const f = i / n
    const A = Math.sin((1 - f) * d) / Math.sin(d)
    const B = Math.sin(f * d) / Math.sin(d)
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2)
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2)
    const z = A * Math.sin(φ1) + B * Math.sin(φ2)
    const φ = Math.atan2(z, Math.sqrt(x * x + y * y))
    const λ = Math.atan2(y, x)
    pts.push([toDeg(λ), toDeg(φ)])
  }
  return pts
}

type Phase = 'CRUISE' | 'DESCENT' | 'APPR' | 'OTHER'
function inferPhase(altFt: number, vsFpm: number): Phase {
  if (altFt < 8000 && vsFpm < 200) return 'APPR'
  if (altFt < 18000 && vsFpm < -400) return 'DESCENT'
  if (vsFpm < -600) return 'DESCENT'
  if (altFt > 18000) return 'CRUISE'
  return 'OTHER'
}

interface Approach {
  f: RecatFlight
  cat: Cat
  destIata: string
  destIcao: string
  destName: string
  destLat: number
  destLng: number
  distNm: number
  brgToDest: number
  alignDeg: number
  altKft: number
  gs: number
}

interface Pair {
  follower: Approach
  leader: Approach | null
  reqNm: number
  gapNm: number
  ratio: number          // gap / req
  deficit: number        // max(0, req - gap)
  tier: Tier
  margin: number         // gap - req (signed nm)
}

export default function RecatWake({ map, flights, onClose, onFly }: Props) {
  const [minFL, setMinFL] = useState(0)
  const [maxFL, setMaxFL] = useState(180)
  const [capture, setCapture] = useState(40)        // nm from destination
  const [minGap, setMinGap] = useState(2.5)         // ICAO baseline
  const [follMul, setFollMul] = useState(100)       // follower margin scale 50-150
  const [interceptTol, setInterceptTol] = useState(45) // ±deg alignment tol
  const [tierFilter, setTierFilter] = useState<Set<Tier>>(new Set())
  const [catFilter, setCatFilter] = useState<Set<Cat>>(new Set())
  const [showHalo, setShowHalo] = useState(true)
  const [showPair, setShowPair] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'PAIRS' | 'AIRPORTS'>('PAIRS')

  // Snapshot airports (large/medium/regional)
  const apts = useMemo(() => AIRPORTS.filter(a => a.lat && a.lon && a.a && a.a.length === 3).map(a => ({ iata: a.a, icao: a.i, name: a.m || a.n || a.a, lat: a.lat, lng: a.lon })), [])

  // Per-aircraft approach context: which airport is being approached?
  const approaches = useMemo<Approach[]>(() => {
    const out: Approach[] = []
    for (const f of flights) {
      if (f.ground) continue
      const altKft = f.altitudeFt / 1000
      if (altKft * 10 < minFL || altKft * 10 > maxFL) continue
      const phase = inferPhase(f.altitudeFt, f.vertRate)
      if (phase !== 'APPR' && phase !== 'DESCENT') continue
      // pick nearest airport ahead within capture
      let best: { a: typeof apts[number]; d: number; brg: number; align: number } | null = null
      for (const a of apts) {
        const d = haversineNm(f.lat, f.lng, a.lat, a.lng)
        if (d > capture) continue
        const brg = bearingDeg(f.lat, f.lng, a.lat, a.lng)
        const align = angDiff(brg, f.track)
        if (align > interceptTol) continue
        if (!best || d < best.d) best = { a, d, brg, align }
      }
      if (!best) continue
      out.push({
        f,
        cat: classify(f.type, f.category),
        destIata: best.a.iata,
        destIcao: best.a.icao || best.a.iata,
        destName: best.a.name || best.a.iata,
        destLat: best.a.lat,
        destLng: best.a.lng,
        distNm: best.d,
        brgToDest: best.brg,
        alignDeg: best.align,
        altKft,
        gs: f.velocityKts,
      })
    }
    return out
  }, [flights, apts, minFL, maxFL, capture, interceptTol])

  // Compute pairs: for each approach, find leader (same destIata, lower distNm, ahead).
  const pairs = useMemo<Pair[]>(() => {
    const byDest: Record<string, Approach[]> = {}
    for (const a of approaches) {
      ;(byDest[a.destIata] ||= []).push(a)
    }
    const out: Pair[] = []
    const follScale = follMul / 100
    for (const list of Object.values(byDest)) {
      list.sort((x, y) => x.distNm - y.distNm)
      for (let i = 0; i < list.length; i++) {
        const follower = list[i]
        // leader is the next-closer aircraft in front (lower distNm; in this sorted array, that's i-1)
        const leader = i > 0 ? list[i - 1] : null
        let req = minGap, gap = Infinity
        if (leader) {
          const matrixReq = RECAT_MIN[leader.cat][follower.cat]
          req = Math.max(minGap, matrixReq || BASELINE_NM) * follScale
          gap = haversineNm(follower.f.lat, follower.f.lng, leader.f.lat, leader.f.lng)
        }
        const margin = gap - req
        const ratio = gap / req
        let tier: Tier
        if (!leader) tier = 'SOLO'
        else if (ratio < 0.85) tier = 'BUST'
        else if (ratio < 1.0) tier = 'PRESS'
        else if (margin < 0.5) tier = 'TIGHT'
        else tier = 'OK'
        out.push({
          follower,
          leader,
          reqNm: leader ? req : 0,
          gapNm: leader ? gap : 0,
          ratio: leader ? ratio : 0,
          deficit: leader ? Math.max(0, req - gap) : 0,
          tier,
          margin: leader ? margin : 0,
        })
      }
    }
    return out
  }, [approaches, minGap, follMul])

  // Stats
  const stats = useMemo(() => {
    const counts: Record<Tier, number> = { OK: 0, TIGHT: 0, PRESS: 0, BUST: 0, SOLO: 0, OUT: 0 }
    let gapSum = 0, gapN = 0, reqSum = 0, reqN = 0
    let worst: Pair | null = null
    for (const p of pairs) {
      counts[p.tier]++
      if (p.leader) {
        gapSum += p.gapNm; gapN++
        reqSum += p.reqNm; reqN++
        if (!worst || p.deficit > worst.deficit || (p.deficit === worst.deficit && TIER_RANK[p.tier] < TIER_RANK[worst.tier])) {
          worst = p
        }
      }
    }
    return {
      counts,
      meanGap: gapN ? gapSum / gapN : 0,
      meanReq: reqN ? reqSum / reqN : 0,
      worst,
      pairCount: pairs.filter(p => p.leader).length,
    }
  }, [pairs])

  // Filtering for list/render
  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase()
    return pairs.filter(p => {
      if (p.tier === 'OUT') return false
      if (tierFilter.size && !tierFilter.has(p.tier)) return false
      if (catFilter.size && !catFilter.has(p.follower.cat)) return false
      if (q) {
        const blob = `${p.follower.f.callsign || ''} ${p.follower.f.type || ''} ${p.follower.destIata} ${p.leader?.f.callsign || ''}`.toUpperCase()
        if (!blob.includes(q)) return false
      }
      return true
    }).sort((a, b) => {
      const r = TIER_RANK[a.tier] - TIER_RANK[b.tier]
      if (r) return r
      return b.deficit - a.deficit
    })
  }, [pairs, tierFilter, catFilter, search])

  // Airport rollup
  const airports = useMemo(() => {
    const byDest: Record<string, { iata: string; name: string; lat: number; lng: number; pairs: Pair[]; worstTier: Tier; meanReq: number; meanGap: number; bustCount: number }> = {}
    for (const p of pairs) {
      if (p.tier === 'OUT') continue
      const k = p.follower.destIata
      if (!byDest[k]) byDest[k] = { iata: k, name: p.follower.destName, lat: p.follower.destLat, lng: p.follower.destLng, pairs: [], worstTier: 'OK', meanReq: 0, meanGap: 0, bustCount: 0 }
      byDest[k].pairs.push(p)
    }
    return Object.values(byDest).map(d => {
      let worst: Tier = 'OK', gs = 0, gn = 0, rs = 0, rn = 0, bc = 0
      for (const p of d.pairs) {
        if (TIER_RANK[p.tier] < TIER_RANK[worst]) worst = p.tier
        if (p.leader) { gs += p.gapNm; gn++; rs += p.reqNm; rn++ }
        if (p.tier === 'BUST') bc++
      }
      return { ...d, worstTier: worst, meanGap: gn ? gs / gn : 0, meanReq: rn ? rs / rn : 0, bustCount: bc }
    }).sort((a, b) => {
      const r = TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier]
      if (r) return r
      return b.pairs.length - a.pairs.length
    })
  }, [pairs])

  // ---------- MapLibre overlay ----------
  useEffect(() => {
    if (!map) return
    const haloId = 'recat-halo', haloSrc = 'recat-halo-src'
    const pairId = 'recat-pair', pairSrc = 'recat-pair-src'
    const pinId = 'recat-pin', pinSrc = 'recat-pin-src'
    const lblId = 'recat-lbl', lblSrc = 'recat-lbl-src'
    const aptId = 'recat-apt', aptSrc = 'recat-apt-src'

    const haloFeats: GeoJSON.Feature[] = []
    const pairFeats: GeoJSON.Feature[] = []
    const pinFeats: GeoJSON.Feature[] = []
    const lblFeats: GeoJSON.Feature[] = []
    const aptFeats: GeoJSON.Feature[] = []

    const visTiers = tierFilter.size ? tierFilter : new Set<Tier>(['BUST', 'PRESS', 'TIGHT', 'OK', 'SOLO'])

    if (showHalo) {
      for (const p of pairs) {
        if (!visTiers.has(p.tier)) continue
        if (p.tier === 'SOLO' || p.tier === 'OUT' || p.tier === 'OK') continue
        const sev = Math.min(22, 8 + p.deficit * 4)
        haloFeats.push({ type: 'Feature', properties: { color: TIER_COLOR[p.tier], r: sev }, geometry: { type: 'Point', coordinates: [p.follower.f.lng, p.follower.f.lat] } })
      }
    }
    if (showPair) {
      for (const p of pairs) {
        if (!p.leader) continue
        if (!visTiers.has(p.tier)) continue
        if (p.tier === 'OK') continue
        const line = greatCirclePoints(p.follower.f.lat, p.follower.f.lng, p.leader.f.lat, p.leader.f.lng, 24)
        pairFeats.push({ type: 'Feature', properties: { color: TIER_COLOR[p.tier], w: p.tier === 'BUST' ? 2.4 : 1.6 }, geometry: { type: 'LineString', coordinates: line } })
      }
    }
    if (showPin) {
      for (const p of pairs) {
        if (p.tier !== 'BUST' || !p.leader) continue
        const mLat = (p.follower.f.lat + p.leader.f.lat) / 2
        const mLng = (p.follower.f.lng + p.leader.f.lng) / 2
        pinFeats.push({ type: 'Feature', properties: { color: TIER_COLOR.BUST, label: `${p.gapNm.toFixed(1)}/${p.reqNm.toFixed(1)}nm` }, geometry: { type: 'Point', coordinates: [mLng, mLat] } })
      }
      // airport rose pin
      for (const a of airports) {
        if (!a.bustCount) continue
        aptFeats.push({ type: 'Feature', properties: { color: TIER_COLOR.BUST, label: `${a.iata} ✕${a.bustCount}` }, geometry: { type: 'Point', coordinates: [a.lng, a.lat] } })
      }
    }
    if (showLbl) {
      for (const p of pairs) {
        if (!p.leader) continue
        if (p.tier === 'OK' || p.tier === 'SOLO') continue
        if (!visTiers.has(p.tier)) continue
        const txt = `${p.follower.f.callsign || p.follower.f.icao} ${p.gapNm.toFixed(1)}/${p.reqNm.toFixed(1)}nm ${p.leader.cat}→${p.follower.cat}`
        lblFeats.push({ type: 'Feature', properties: { text: txt, color: TIER_COLOR[p.tier] }, geometry: { type: 'Point', coordinates: [p.follower.f.lng, p.follower.f.lat] } })
      }
    }

    const ensureSrc = (id: string, feats: GeoJSON.Feature[]) => {
      const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: feats }
      const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined
      if (src) src.setData(fc as never); else map.addSource(id, { type: 'geojson', data: fc as never })
    }
    ensureSrc(haloSrc, haloFeats)
    ensureSrc(pairSrc, pairFeats)
    ensureSrc(pinSrc, pinFeats)
    ensureSrc(lblSrc, lblFeats)
    ensureSrc(aptSrc, aptFeats)

    if (!map.getLayer(haloId)) {
      map.addLayer({ id: haloId, type: 'circle', source: haloSrc, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.85 } })
    }
    if (!map.getLayer(pairId)) {
      map.addLayer({ id: pairId, type: 'line', source: pairSrc, paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'w'], 'line-dasharray': [2, 2], 'line-opacity': 0.85 } })
    }
    if (!map.getLayer(pinId)) {
      map.addLayer({ id: pinId, type: 'symbol', source: pinSrc, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, -1.4], 'text-anchor': 'bottom' }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.4 } })
    }
    if (!map.getLayer(lblId)) {
      map.addLayer({ id: lblId, type: 'symbol', source: lblSrc, layout: { 'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top', 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } })
    }
    if (!map.getLayer(aptId)) {
      map.addLayer({ id: aptId, type: 'symbol', source: aptSrc, layout: { 'text-field': ['get', 'label'], 'text-size': 12, 'text-anchor': 'center' }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.6 } })
    }

    return () => {
      for (const id of [haloId, pairId, pinId, lblId, aptId]) if (map.getLayer(id)) map.removeLayer(id)
      for (const id of [haloSrc, pairSrc, pinSrc, lblSrc, aptSrc]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, pairs, airports, showHalo, showPair, showPin, showLbl, tierFilter])

  // ---------- SVG diag ----------
  const diagW = 360, diagH = 160
  const diag = useMemo(() => {
    const reqMax = 9, gapMax = 12
    const sx = (r: number) => 26 + (r / reqMax) * (diagW - 36)
    const sy = (g: number) => (diagH - 24) - (g / gapMax) * (diagH - 34)
    const dots = pairs.filter(p => p.leader).map(p => ({ x: sx(p.reqNm), y: sy(p.gapNm), c: TIER_COLOR[p.tier] }))
    const idLine = `M ${sx(0)} ${sy(0)} L ${sx(reqMax)} ${sy(reqMax)}`
    const p85 = `M ${sx(0)} ${sy(0)} L ${sx(reqMax)} ${sy(reqMax * 0.85)}`
    return { dots, idLine, p85, sx, sy, reqMax, gapMax }
  }, [pairs])

  return (
    <div className="absolute inset-y-0 right-0 z-40 w-[min(96vw,460px)] bg-slate-950/95 backdrop-blur-xl border-l border-slate-800 shadow-2xl flex flex-col">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">EUROCONTROL · ICAO Doc 9426</div>
          <div className="text-sm font-semibold text-slate-100">RECAT-EU Wake Separation</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      {/* Tier strip */}
      <div className="px-4 py-2 border-b border-slate-900 grid grid-cols-5 gap-1.5">
        {(['BUST', 'PRESS', 'TIGHT', 'OK', 'SOLO'] as Tier[]).map(t => {
          const on = tierFilter.has(t)
          return (
            <button key={t} onClick={() => setTierFilter(s => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n })}
              className={`px-2 py-1 rounded-lg text-[10px] font-semibold tracking-wider border transition ${on ? 'bg-sky-500/15 border-sky-500/50 text-sky-100' : 'bg-slate-900/60 border-slate-800 text-slate-300 hover:border-slate-700'}`}>
              <span className="block leading-tight" style={{ color: TIER_COLOR[t] }}>{stats.counts[t]}</span>
              <span className="block text-[9px] text-slate-400">{t}</span>
            </button>
          )
        })}
      </div>

      {/* Summary cells */}
      <div className="px-4 py-2 border-b border-slate-900 grid grid-cols-3 gap-2 text-xs">
        <div className="bg-slate-900/50 border border-slate-800 rounded-lg px-2 py-1.5">
          <div className="text-[9px] uppercase text-slate-500">Mean Gap</div>
          <div className="text-slate-100 font-semibold" style={{ color: stats.meanGap >= stats.meanReq ? TIER_COLOR.OK : stats.meanGap >= stats.meanReq * 0.85 ? TIER_COLOR.PRESS : TIER_COLOR.BUST }}>{stats.meanGap.toFixed(2)} nm</div>
        </div>
        <div className="bg-slate-900/50 border border-slate-800 rounded-lg px-2 py-1.5">
          <div className="text-[9px] uppercase text-slate-500">Worst</div>
          <div className="text-slate-100 font-semibold truncate">{stats.worst ? `${stats.worst.follower.f.callsign || stats.worst.follower.f.icao} ${stats.worst.gapNm.toFixed(1)}/${stats.worst.reqNm.toFixed(1)}` : '—'}</div>
        </div>
        <div className="bg-slate-900/50 border border-slate-800 rounded-lg px-2 py-1.5">
          <div className="text-[9px] uppercase text-slate-500">BUST</div>
          <div className="font-semibold" style={{ color: stats.counts.BUST ? TIER_COLOR.BUST : TIER_COLOR.OK }}>{stats.counts.BUST}</div>
        </div>
      </div>
      <div className="px-4 py-2 border-b border-slate-900 grid grid-cols-2 gap-2 text-xs">
        <div className="bg-slate-900/50 border border-slate-800 rounded-lg px-2 py-1.5">
          <div className="text-[9px] uppercase text-slate-500">Mean Req</div>
          <div className="text-sky-300 font-semibold">{stats.meanReq.toFixed(2)} nm</div>
        </div>
        <div className="bg-slate-900/50 border border-slate-800 rounded-lg px-2 py-1.5">
          <div className="text-[9px] uppercase text-slate-500">Pairs</div>
          <div className="text-slate-100 font-semibold">{stats.pairCount}</div>
        </div>
      </div>

      {/* Diag SVG */}
      {showDiag && (
        <div className="px-4 py-2 border-b border-slate-900">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Gap vs Required (nm)</div>
          <svg width={diagW} height={diagH} className="block">
            <rect x={26} y={4} width={diagW - 30} height={diagH - 28} fill="#020617" stroke="#1e293b" />
            {/* threshold bands behind */}
            {[0, 0.85, 1.0].map((t, i) => {
              const arr = [0, 0.85, 1.0, 1.5]
              const c = ['rgba(244,63,94,0.10)', 'rgba(245,158,11,0.10)', 'rgba(14,165,233,0.10)'][i]
              const yTop = diag.sy(diag.reqMax * arr[i + 1])
              const yBot = diag.sy(diag.reqMax * t)
              return <rect key={i} x={26} y={yTop} width={diagW - 30} height={Math.max(0, yBot - yTop)} fill={c} />
            })}
            <path d={diag.idLine} stroke="#0ea5e9" strokeWidth={1} strokeDasharray="3 3" fill="none" />
            <path d={diag.p85} stroke="#f43f5e" strokeWidth={1} strokeDasharray="3 3" fill="none" />
            {diag.dots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={2.5} fill={d.c} fillOpacity={0.85} />)}
            {[2, 4, 6, 8].map(g => (
              <g key={g}>
                <line x1={26} x2={diagW - 4} y1={diag.sy(g)} y2={diag.sy(g)} stroke="#1e293b" strokeWidth={0.5} />
                <text x={2} y={diag.sy(g) + 3} fontSize={9} fill="#475569">{g}</text>
              </g>
            ))}
            {[2, 4, 6, 8].map(r => (
              <g key={r}>
                <line y1={4} y2={diagH - 24} x1={diag.sx(r)} x2={diag.sx(r)} stroke="#1e293b" strokeWidth={0.5} />
                <text y={diagH - 12} x={diag.sx(r) - 4} fontSize={9} fill="#475569">{r}</text>
              </g>
            ))}
            <text x={26} y={diagH - 2} fontSize={9} fill="#64748b">req nm</text>
            <text x={1} y={12} fontSize={9} fill="#64748b">gap</text>
          </svg>
        </div>
      )}

      {/* Sliders */}
      <div className="px-4 py-2 border-b border-slate-900 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
        {([
          ['MIN-FL', minFL, 0, 400, setMinFL, 10],
          ['MAX-FL', maxFL, 50, 450, setMaxFL, 10],
          ['CAPTURE nm', capture, 10, 120, setCapture, 5],
          ['MIN-GAP nm', minGap, 2, 6, (v: number) => setMinGap(v), 0.1],
          ['FOLLOWER %', follMul, 50, 150, setFollMul, 5],
        ] as const).map(([l, v, mn, mx, set, st]) => (
          <label key={l as string} className="block">
            <div className="flex justify-between"><span className="text-slate-500">{l}</span><span className="text-slate-300">{typeof v === 'number' ? (l === 'MIN-GAP nm' ? v.toFixed(1) : v) : v}</span></div>
            <input type="range" min={mn as number} max={mx as number} step={st as number} value={v as number} onChange={e => (set as (n: number) => void)(parseFloat(e.target.value))} className="w-full accent-sky-500" />
          </label>
        ))}
        <label className="block col-span-2">
          <div className="flex justify-between"><span className="text-slate-500">INTERCEPT ±°</span><span className="text-slate-300">{interceptTol}</span></div>
          <input type="range" min={15} max={75} step={5} value={interceptTol} onChange={e => setInterceptTol(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </label>
      </div>

      {/* Cat chips */}
      <div className="px-4 py-2 border-b border-slate-900 flex gap-1 flex-wrap">
        {CAT_ORDER.map(c => {
          const on = catFilter.has(c)
          return <button key={c} onClick={() => setCatFilter(s => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); return n })}
            title={CAT_NAME[c]}
            className={`px-2 py-0.5 rounded text-[10px] font-mono border ${on ? 'bg-sky-500/15 border-sky-500/50 text-sky-100' : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:border-slate-700'}`}>{c}</button>
        })}
      </div>

      {/* Toggles + search + tabs */}
      <div className="px-4 py-2 border-b border-slate-900 flex flex-wrap gap-1.5 items-center text-[10px]">
        {([['HALO', showHalo, setShowHalo], ['PAIR', showPair, setShowPair], ['PIN', showPin, setShowPin], ['LBL', showLbl, setShowLbl], ['DIAG', showDiag, setShowDiag]] as const).map(([l, v, s]) => (
          <button key={l} onClick={() => (s as (b: boolean) => void)(!v)}
            className={`px-2 py-0.5 rounded border ${v ? 'bg-sky-500/15 border-sky-500/50 text-sky-100' : 'bg-slate-900/60 border-slate-800 text-slate-400'}`}>{l}</button>
        ))}
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search" className="ml-auto bg-slate-900/60 border border-slate-800 rounded px-1.5 py-0.5 text-[10px] text-slate-200 w-24 placeholder:text-slate-600" />
      </div>
      <div className="px-4 pt-2 grid grid-cols-2 gap-1">
        {(['PAIRS', 'AIRPORTS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`text-[10px] tracking-widest py-1 rounded ${tab === t ? 'bg-sky-500/15 text-sky-100 border border-sky-500/50' : 'bg-slate-900/40 text-slate-400 border border-slate-800'}`}>{t}</button>
        ))}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab === 'PAIRS' && filtered.map(p => {
          const f = p.follower.f
          const adv = p.tier === 'BUST' ? 'wake bust — extend downwind, request re-spacing'
            : p.tier === 'PRESS' ? 'compressing — reduce 10 kt or S-turn'
            : p.tier === 'TIGHT' ? 'within RECAT margin, monitor closure rate'
            : p.tier === 'OK' ? 'separation nominal'
            : 'no qualifying leader — solo approach'
          return (
            <button key={f.icao + (p.leader?.f.icao || 'solo')} onClick={() => onFly(f.icao)}
              className="w-full text-left bg-slate-900/40 border border-slate-800 hover:border-slate-700 rounded-lg p-2 flex gap-2">
              <div className="w-1 rounded-full shrink-0" style={{ background: TIER_COLOR[p.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="font-mono text-slate-100 truncate">{f.callsign || f.icao}</span>
                  <span className="text-slate-500">{f.type || '—'}</span>
                  <span className="ml-auto px-1.5 py-0.5 rounded text-[9px] font-mono border border-slate-800 text-slate-300">{p.follower.cat}</span>
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-mono" style={{ background: TIER_COLOR[p.tier] + '22', color: TIER_COLOR[p.tier] }}>{p.tier}</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">
                  FL{Math.round(p.follower.altKft * 10)} · {p.follower.gs.toFixed(0)}kt · {p.follower.destIata} {p.follower.distNm.toFixed(0)}nm · {p.leader ? `lead ${p.leader.f.callsign || p.leader.f.icao} ${p.leader.cat}` : 'no leader'}
                </div>
                {p.leader && (
                  <>
                    <div className="mt-1 h-1.5 bg-slate-800 rounded relative overflow-hidden">
                      <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, p.ratio * 60)}%`, background: TIER_COLOR[p.tier] }} />
                      <div className="absolute inset-y-0 w-px bg-slate-500" style={{ left: '60%' }} />
                      <div className="absolute inset-y-0 w-px bg-rose-500/60" style={{ left: '51%' }} />
                    </div>
                    <div className="flex gap-1.5 mt-1 flex-wrap text-[9px]">
                      <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-300">gap {p.gapNm.toFixed(2)}nm</span>
                      <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-300">req {p.reqNm.toFixed(2)}nm</span>
                      <span className="px-1.5 py-0.5 rounded font-mono" style={{ background: TIER_COLOR[p.tier] + '22', color: TIER_COLOR[p.tier] }}>{p.margin >= 0 ? '+' : ''}{p.margin.toFixed(2)}nm</span>
                      <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-300">{p.leader.cat}→{p.follower.cat}</span>
                    </div>
                  </>
                )}
                <div className="text-[10px] mt-1" style={{ color: TIER_COLOR[p.tier] }}>{adv}</div>
              </div>
            </button>
          )
        })}
        {tab === 'AIRPORTS' && airports.map(a => (
          <button key={a.iata} onClick={() => {
            const firstBust = pairs.find(p => p.tier === 'BUST' && p.follower.destIata === a.iata)
            const target = firstBust?.follower.f.icao || pairs.find(p => p.follower.destIata === a.iata)?.follower.f.icao
            if (target) onFly(target)
          }} className="w-full text-left bg-slate-900/40 border border-slate-800 hover:border-slate-700 rounded-lg p-2 flex gap-2">
            <div className="w-1 rounded-full shrink-0" style={{ background: TIER_COLOR[a.worstTier] }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 text-xs">
                <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-900 border border-slate-800 text-slate-200">{a.iata}</span>
                <span className="text-slate-300 truncate">{a.name}</span>
                <span className="ml-auto text-slate-400 text-[10px]">{a.pairs.length} ac</span>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono" style={{ background: TIER_COLOR[a.worstTier] + '22', color: TIER_COLOR[a.worstTier] }}>{a.worstTier}</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">mean gap {a.meanGap.toFixed(2)}nm · mean req {a.meanReq.toFixed(2)}nm · busts {a.bustCount}</div>
              <div className="mt-1 h-1.5 bg-slate-800 rounded">
                <div className="h-full rounded" style={{ width: `${Math.min(100, (a.meanGap / Math.max(0.5, a.meanReq)) * 50)}%`, background: TIER_COLOR[a.worstTier] }} />
              </div>
            </div>
          </button>
        ))}
        {((tab === 'PAIRS' && !filtered.length) || (tab === 'AIRPORTS' && !airports.length)) && (
          <div className="text-center text-[11px] text-slate-500 py-6">No approaches inside capture envelope.</div>
        )}
      </div>
    </div>
  )
}
