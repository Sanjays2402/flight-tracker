'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   RTA / 4D Trajectory Conformance Monitor
   -----------------------------------------------------------
   Eurocontrol PCP / SESAR i4D / ICAO Doc 9750 ATMP Required
   Time of Arrival conformance watch. In trajectory-based
   operations (TBO) the FMS publishes a Controlled Time of
   Arrival (CTA) at a meter-fix or destination; ATC expects
   the aircraft to cross the fix within +/- TOL seconds of
   the CTA (typically +/- 30 s for arrival metering, +/- 10 s
   for merge points in TMA, +/- 60 s en-route).

   For every airborne aircraft between MIN-FL and MAX-FL the
   monitor:
     1) Infers an intended destination by picking the closest
        aligned IATA airport AHEAD of the ground track within
        CAPTURE nm and within +/- 60 deg of the track vector;
     2) Computes great-circle distance-to-go (DTG) to that
        fix, and ETA at present groundspeed (assumes no
        further wind change). Class-typical descent profile
        adds DESC-PEN seconds where DTG fits inside the
        terminal descent envelope (DTG < 200 nm + 3 nm/kft).
     3) Synthesises a deterministic per-airframe CTA using
        FNV-1a hash of ICAO24 as the seed and a published
        "scheduled" arrival aligned to nearest 5-minute slot,
        biased by SLOT-DRIFT slider -300..+300 sec to let the
        operator simulate metering pressure.
     4) Computes signed time error
           tErr = ETA - CTA  (sec, +late / -early)
        and a "control authority" envelope -- how much time
        the aircraft can still absorb between now and CTA via
        speed change alone, derived from per-class Mach band
        (HVY .76..M_mo / NRW .74..M_mo / RGN .70..M_mo /
        BIZ .76..M_mo / TBP 220..280 KTAS / GA 110..160 /
        FTR .80..M_mo) -> max speed-up dt_up = DTG/v_min -
        DTG/v_cur, max slow-down dt_dn = DTG/v_max - DTG/v_cur.
        absorption = [-dt_up, +dt_dn] seconds (signed).
     5) Recommends a required Mach/IAS bias to null tErr:
        v_req = DTG / ((DTG/v_cur) - tErr/3600)   in kt
        delta_v = v_req - v_cur clipped to the class envelope,
        delta_M = delta_v * Mach/v_cur as cruise mach proxy.

   Tier classification (per Eurocontrol PCP CTA tolerance):
     ON-TIME   |tErr| <= TOL                        emerald
     DRIFT     |tErr| <= 2*TOL                      sky
     LATE      tErr  >  2*TOL  AND can-absorb       amber
     EARLY     tErr  < -2*TOL  AND can-absorb       amber
     MISSED    |tErr| > 2*TOL AND beyond absorption rose
     OUT       no destination inferrable            slate

   MapLibre overlay:
     - Tier-coloured halo ring sized by |tErr|/TOL (8-22px).
     - Dashed tier-coloured projection line aircraft -> dest
       sampled great-circle (24 pts), thicker for MISSED.
     - Tier-coloured destination airport pin "›IATA CTA"
       label with seconds-since-midnight UTC clock.
     - Tier-coloured callsign + signed-tErr-sec label.

   Side panel:
     - 6-tier counter strip click-to-filter (incl OUT).
     - 3-cell MEAN-|tErr| / WORST callsign+sec /
       MISSED-COUNT summary row.
     - 2-cell MEAN-ABS-ENV / SLOT-DRIFT secondary row.
     - SVG ETA-vs-CTA scatter (x=DTG nm 0..1500 with verticals
       at 250/500/750/1000/1250; y=signed tErr -300..+300 sec
       with emerald +/-TOL, sky +/-2*TOL, amber +/-180,
       rose >|180| shaded bands; dashed threshold lines; zero
       centerline; every aircraft plotted as tier-coloured
       dot).
     - 5 sliders MIN-FL / MAX-FL / CAPTURE-NM / TOL-SEC /
       SLOT-DRIFT.
     - 7-class chip filter row.
     - HALO/PROJ/PIN/LBL/DIAG toggles + search.
     - AIRCRAFT/DESTS tab switcher.
     - AIRCRAFT tab sorted tier-worst-first then |tErr| desc.
     - DESTS tab grouped by destination airport sorted worst
       tier first then ac-count desc.

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

type Tier = 'ON-TIME' | 'DRIFT' | 'LATE' | 'EARLY' | 'MISSED' | 'OUT'
const TIER_COLOR: Record<Tier, string> = {
  'ON-TIME': '#10b981',
  DRIFT: '#0ea5e9',
  LATE: '#f59e0b',
  EARLY: '#f59e0b',
  MISSED: '#ef4444',
  OUT: '#64748b',
}
const TIER_ORDER: Tier[] = ['MISSED', 'LATE', 'EARLY', 'DRIFT', 'ON-TIME', 'OUT']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
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

// Per-class cruise GS envelope (KTAS approx for absorption capability calc)
const KLASS_GS: Record<Klass, [number, number]> = {
  heavy: [410, 510],
  narrow: [400, 490],
  regional: [330, 440],
  biz: [410, 520],
  turboprop: [220, 320],
  ga: [110, 170],
  fighter: [400, 700],
}
// Cruise Mach band proxy
const KLASS_MACH: Record<Klass, [number, number]> = {
  heavy: [0.76, 0.88],
  narrow: [0.74, 0.82],
  regional: [0.70, 0.78],
  biz: [0.76, 0.90],
  turboprop: [0.40, 0.55],
  ga: [0.20, 0.30],
  fighter: [0.80, 0.95],
}

const D2R = Math.PI / 180
const R_NM = 3440.065
function gcDistNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R
  const dφ = (la2 - la1) * D2R, dλ = (lo2 - lo1) * D2R
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}
function gcBearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R, dλ = (lo2 - lo1) * D2R
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return ((Math.atan2(y, x) / D2R) + 360) % 360
}
function headingDelta(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180)
}
function gcInterp(latA: number, lngA: number, latB: number, lngB: number, f: number): [number, number] {
  const φ1 = latA * D2R, φ2 = latB * D2R, λ1 = lngA * D2R, λ2 = lngB * D2R
  const d = 2 * Math.asin(Math.sqrt(Math.sin((φ2-φ1)/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin((λ2-λ1)/2)**2))
  if (d < 1e-9) return [latA, lngA]
  const a = Math.sin((1-f)*d)/Math.sin(d)
  const b = Math.sin(f*d)/Math.sin(d)
  const x = a*Math.cos(φ1)*Math.cos(λ1) + b*Math.cos(φ2)*Math.cos(λ2)
  const y = a*Math.cos(φ1)*Math.sin(λ1) + b*Math.cos(φ2)*Math.sin(λ2)
  const z = a*Math.sin(φ1) + b*Math.sin(φ2)
  return [Math.atan2(z, Math.sqrt(x*x+y*y))/D2R, Math.atan2(y, x)/D2R]
}

// FNV-1a 32-bit hash for deterministic per-airframe CTA seed
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}

interface Row {
  f: RtaFlight
  klass: Klass
  altFt: number
  gs: number
  dI: string; dIcao: string; dName: string; dLat: number; dLng: number
  dtgNm: number
  etaSec: number       // seconds from now to arrival at current GS (+ descent penalty)
  ctaSec: number       // seconds from now to CTA
  tErr: number         // ETA - CTA (sec, +late / -early)
  vCur: number         // current GS proxy
  vMin: number; vMax: number
  absorbUp: number     // sec available by speeding up (positive = can be earlier)
  absorbDn: number     // sec available by slowing down (positive = can be later)
  vReq: number         // required GS to null tErr
  deltaV: number       // recommended delta GS, clipped to envelope
  deltaMach: number    // mach equivalent
  machCur: number
  tier: Tier
}

const SRC_RING = 'rta-ring', SRC_PRJ = 'rta-prj', SRC_AP = 'rta-ap', SRC_LBL = 'rta-lbl'
const LYR_RING = 'rta-ring-l', LYR_PRJ = 'rta-prj-l', LYR_AP = 'rta-ap-l', LYR_LBL = 'rta-lbl-l'

const ALL_AP = AIRPORTS.filter(a => a.a && a.a.length === 3)

function fmtClock(secFromNow: number): string {
  const nowSec = Math.floor(Date.now() / 1000) % 86400
  const t = (nowSec + Math.round(secFromNow) + 86400) % 86400
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60)
  return `${h.toString().padStart(2, '0')}${m.toString().padStart(2, '0')}Z`
}
function fmtSigned(sec: number): string {
  const s = Math.round(sec)
  if (Math.abs(s) < 60) return `${s >= 0 ? '+' : ''}${s}s`
  const m = Math.round(s / 60)
  return `${m >= 0 ? '+' : ''}${m}m`
}

export default function RtaConformance({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'DESTS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(50)
  const [maxFl, setMaxFl] = useState(450)
  const [captureNm, setCaptureNm] = useState(1200)
  const [tolSec, setTolSec] = useState(30)
  const [slotDrift, setSlotDrift] = useState(0)
  const [showRing, setShowRing] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    let outCount = 0
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt) || !isFinite(f.lat) || !isFinite(f.lng)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl || flCur > maxFl) continue
      const klass = classify(f.type, f.category)
      const gs = Math.max(80, f.velocityKts || 250)
      const trk = f.track || 0
      // Destination: best-aligned IATA AHEAD aircraft (within +/- 60 deg of track)
      let dest: { i: string, icao: string, name: string, lat: number, lng: number, d: number } | null = null
      for (const ap of ALL_AP) {
        const d = gcDistNm(f.lat, f.lng, ap.lat, ap.lon)
        if (d > captureNm || d < 15) continue
        const br = gcBearingDeg(f.lat, f.lng, ap.lat, ap.lon)
        const dFwd = headingDelta(br, trk)
        if (dFwd <= 60) {
          if (!dest || d < dest.d) dest = { i: ap.a, icao: ap.i, name: ap.m || ap.n || ap.a, lat: ap.lat, lng: ap.lon, d }
        }
      }
      if (!dest) { outCount++; continue }
      const dtgNm = dest.d
      // Descent penalty: if inside terminal descent envelope (DTG < 200 + 3*alt_kft),
      // groundspeed will decay roughly linearly to 220kt over the last 100nm
      const altKft = f.altitudeFt / 1000
      const inDescent = dtgNm < 200 + 3 * altKft
      const descPen = inDescent ? Math.min(180, Math.max(0, (200 - dtgNm) * 0.6)) : 0
      const etaSec = (dtgNm / gs) * 3600 + descPen
      // Deterministic CTA seed: hash ICAO -> stable 5-min slot offset within a +/- 25 min window of ETA,
      // biased by SLOT-DRIFT slider so user can simulate metering pressure.
      const h = fnv1a(f.icao)
      // baseOffset in seconds: pick a slot in -1500..+1500 in 60-sec quanta
      const baseOff = ((h % 51) - 25) * 60
      const ctaSec = etaSec + baseOff + slotDrift
      const tErr = etaSec - ctaSec   // tErr = -baseOff - slotDrift; positive = late
      // Mach proxy: TAS at FL250 standard atmos ~ a = 575kt; M = gs / 575 as cruise proxy
      const machCur = gs / 575
      const [vMin, vMax] = KLASS_GS[klass]
      // Absorption envelope (sec). Positive absorbDn means can delay by up to that many seconds.
      const tCur = (dtgNm / gs) * 3600
      const absorbUp = Math.max(0, tCur - (dtgNm / vMax) * 3600)   // seconds we could shave (be earlier)
      const absorbDn = Math.max(0, (dtgNm / vMin) * 3600 - tCur)   // seconds we could add (be later)
      // Required GS to null tErr (tErr>0 means late -> need to speed up)
      const tTargetHrs = Math.max(1e-3, (dtgNm / gs) - tErr / 3600)
      const vReq = dtgNm / tTargetHrs
      const vReqClip = Math.max(vMin, Math.min(vMax, vReq))
      const deltaV = vReqClip - gs
      const [mMin, mMax] = KLASS_MACH[klass]
      const machReq = machCur * (vReqClip / gs)
      const machReqClip = Math.max(mMin, Math.min(mMax, machReq))
      const deltaMach = machReqClip - machCur
      // Tier
      let tier: Tier
      const aTe = Math.abs(tErr)
      if (aTe <= tolSec) tier = 'ON-TIME'
      else if (aTe <= 2 * tolSec) tier = 'DRIFT'
      else {
        // Can absorption resolve it?
        const canFix = tErr > 0 ? absorbUp >= tErr * 0.6 : absorbDn >= -tErr * 0.6
        if (!canFix) tier = 'MISSED'
        else tier = tErr > 0 ? 'LATE' : 'EARLY'
      }
      out.push({
        f, klass, altFt: f.altitudeFt, gs,
        dI: dest.i, dIcao: dest.icao, dName: dest.name, dLat: dest.lat, dLng: dest.lng,
        dtgNm, etaSec, ctaSec, tErr,
        vCur: gs, vMin, vMax, absorbUp, absorbDn,
        vReq: vReqClip, deltaV, deltaMach, machCur,
        tier,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return Math.abs(b.tErr) - Math.abs(a.tErr)
    })
    ;(out as any)._outCount = outCount
    return out
  }, [flights, minFl, maxFl, captureNm, tolSec, slotDrift])

  const outCount: number = (rows as any)._outCount || 0

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { 'ON-TIME': 0, DRIFT: 0, LATE: 0, EARLY: 0, MISSED: 0, OUT: 0 }
    for (const r of rows) t[r.tier]++
    t.OUT = outCount
    return t
  }, [rows, outCount])

  const summary = useMemo(() => {
    const total = rows.length
    let meanAbs = 0, worstAbs = 0, worstCs = '', worstSigned = 0, missed = 0, meanEnv = 0
    for (const r of rows) {
      meanAbs += Math.abs(r.tErr)
      meanEnv += (r.absorbUp + r.absorbDn) / 2
      if (Math.abs(r.tErr) > worstAbs) { worstAbs = Math.abs(r.tErr); worstCs = (r.f.callsign || r.f.icao).trim(); worstSigned = r.tErr }
      if (r.tier === 'MISSED') missed++
    }
    if (total > 0) { meanAbs /= total; meanEnv /= total }
    return { total, meanAbs, worstAbs, worstCs, worstSigned, missed, meanEnv }
  }, [rows])

  const dests = useMemo(() => {
    const m = new Map<string, { key: string, i: string, icao: string, name: string, lat: number, lng: number, count: number, worstTier: Tier, meanAbs: number, missed: number, meanCta: number }>()
    for (const r of rows) {
      const k = r.dI
      const e = m.get(k)
      if (e) {
        e.count++
        e.meanAbs += Math.abs(r.tErr)
        e.meanCta += r.ctaSec
        if (r.tier === 'MISSED') e.missed++
        if (TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(e.worstTier)) e.worstTier = r.tier
      } else {
        m.set(k, { key: k, i: r.dI, icao: r.dIcao, name: r.dName, lat: r.dLat, lng: r.dLng, count: 1, worstTier: r.tier, meanAbs: Math.abs(r.tErr), missed: r.tier === 'MISSED' ? 1 : 0, meanCta: r.ctaSec })
      }
    }
    const arr = Array.from(m.values())
    for (const e of arr) { e.meanAbs /= e.count; e.meanCta /= e.count }
    arr.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.worstTier) - TIER_ORDER.indexOf(b.worstTier)
      if (ti !== 0) return ti
      return b.count - a.count
    })
    return arr
  }, [rows])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.dI, r.dIcao].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [rows, tierFilter, klassFilter, query])

  const filteredDests = useMemo(() => {
    const q = query.trim().toUpperCase()
    return dests.filter(d => {
      if (tierFilter !== 'ALL' && d.worstTier !== tierFilter) return false
      if (!q) return true
      return [d.i, d.icao, d.name].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [dests, tierFilter, query])

  useEffect(() => {
    if (!map) return
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, (Math.abs(r.tErr) / Math.max(5, tolSec)) * 3) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const prjFc = { type: 'FeatureCollection' as const, features: showProj ? rows.map(r => {
      const pts: number[][] = []
      for (let i = 0; i <= 24; i++) {
        const [lat, lng] = gcInterp(r.f.lat, r.f.lng, r.dLat, r.dLng, i / 24)
        pts.push([lng, lat])
      }
      return {
        type: 'Feature' as const,
        properties: { color: TIER_COLOR[r.tier], width: r.tier === 'MISSED' ? 2.2 : 1.4 },
        geometry: { type: 'LineString' as const, coordinates: pts },
      }
    }) : [] }
    const apMap = new Map<string, { lng: number, lat: number, text: string, tier: Tier }>()
    for (const r of rows) {
      const prev = apMap.get(r.dI)
      const txt = `›${r.dI} ${fmtClock(r.ctaSec)}`
      if (!prev || TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(prev.tier)) {
        apMap.set(r.dI, { lng: r.dLng, lat: r.dLat, text: txt, tier: r.tier })
      }
    }
    const apFc = { type: 'FeatureCollection' as const, features: showPin ? Array.from(apMap.values()).map(a => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[a.tier], text: a.text },
      geometry: { type: 'Point' as const, coordinates: [a.lng, a.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier !== 'ON-TIME').map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${fmtSigned(r.tErr)}`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_PRJ, prjFc, () => map.addLayer({ id: LYR_PRJ, type: 'line', source: SRC_PRJ, paint: {
        'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': 0.55, 'line-dasharray': [3, 3],
      } }))
      ensure(SRC_RING, ringFc, () => map.addLayer({ id: LYR_RING, type: 'circle', source: SRC_RING, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.16,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.6, 'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_AP, apFc, () => map.addLayer({ id: LYR_AP, type: 'symbol', source: SRC_AP, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, -1.3], 'text-anchor': 'bottom',
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.4 } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_AP, LYR_RING, LYR_PRJ]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_AP, SRC_RING, SRC_PRJ]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showRing, showProj, showPin, showLabels, tolSec])

  // Diagram: x = DTG nm 0..1500, y = signed tErr -300..+300 sec
  const diag = useMemo(() => {
    const W = 360, H = 180, PAD_L = 32, PAD_B = 22
    const xs = (nm: number) => PAD_L + (Math.min(1500, nm) / 1500) * (W - PAD_L - 8)
    const ys = (sec: number) => 6 + (1 - (Math.max(-300, Math.min(300, sec)) + 300) / 600) * (H - PAD_B - 8)
    return { W, H, PAD_L, PAD_B, xs, ys }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">RTA / 4D Trajectory</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} ac · {outCount} OUT</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800">
        {(['ON-TIME', 'DRIFT', 'LATE', 'EARLY', 'MISSED', 'OUT'] as Tier[]).map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[8px] font-bold" style={{ color: TIER_COLOR[t] }}>{t === 'ON-TIME' ? 'OK' : t === 'MISSED' ? 'MISS' : t}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean |tErr|</div>
          <div className="font-mono text-sm" style={{ color: summary.meanAbs > 2 * tolSec ? '#f59e0b' : summary.meanAbs > tolSec ? '#0ea5e9' : '#10b981' }}>
            {fmtSigned(summary.meanAbs).replace('+', '')}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${fmtSigned(summary.worstSigned)}` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Missed</div>
          <div className="font-mono text-sm" style={{ color: summary.missed > 0 ? '#ef4444' : '#10b981' }}>{summary.missed}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Absorb ±</div>
          <div className="font-mono text-[11px] text-slate-300">{fmtSigned(summary.meanEnv).replace('+', '±')}</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Slot Drift</div>
          <div className="font-mono text-[11px]" style={{ color: Math.abs(slotDrift) > 60 ? '#f59e0b' : '#64748b' }}>{slotDrift >= 0 ? '+' : ''}{slotDrift}s</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">tErr vs DTG · TOL ±{tolSec}s</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD_L} y1={diag.H - diag.PAD_B} x2={diag.W - 6} y2={diag.H - diag.PAD_B} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD_L} y1={6} x2={diag.PAD_L} y2={diag.H - diag.PAD_B} stroke="#334155" strokeWidth={1} />
            {/* y bands */}
            <rect x={diag.PAD_L} y={diag.ys(tolSec)} width={diag.W - diag.PAD_L - 6} height={diag.ys(-tolSec) - diag.ys(tolSec)} fill="#10b981" opacity={0.10} />
            <rect x={diag.PAD_L} y={diag.ys(2 * tolSec)} width={diag.W - diag.PAD_L - 6} height={diag.ys(tolSec) - diag.ys(2 * tolSec)} fill="#0ea5e9" opacity={0.08} />
            <rect x={diag.PAD_L} y={diag.ys(-tolSec)} width={diag.W - diag.PAD_L - 6} height={diag.ys(-2 * tolSec) - diag.ys(-tolSec)} fill="#0ea5e9" opacity={0.08} />
            <rect x={diag.PAD_L} y={diag.ys(180)} width={diag.W - diag.PAD_L - 6} height={diag.ys(2 * tolSec) - diag.ys(180)} fill="#f59e0b" opacity={0.06} />
            <rect x={diag.PAD_L} y={diag.ys(-2 * tolSec)} width={diag.W - diag.PAD_L - 6} height={diag.ys(-180) - diag.ys(-2 * tolSec)} fill="#f59e0b" opacity={0.06} />
            {/* threshold lines */}
            {[tolSec, -tolSec, 2 * tolSec, -2 * tolSec].map(y => {
              const c = Math.abs(y) === tolSec ? '#10b981' : '#0ea5e9'
              return <line key={y} x1={diag.PAD_L} y1={diag.ys(y)} x2={diag.W - 6} y2={diag.ys(y)} stroke={c} strokeDasharray="2 3" opacity={0.6} />
            })}
            <line x1={diag.PAD_L} y1={diag.ys(0)} x2={diag.W - 6} y2={diag.ys(0)} stroke="#475569" strokeWidth={1} />
            {/* y labels */}
            {[-300, -180, -60, 0, 60, 180, 300].map(y => (
              <text key={y} x={diag.PAD_L - 2} y={diag.ys(y) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{y > 0 ? '+' : ''}{y}s</text>
            ))}
            {/* x labels */}
            {[250, 500, 750, 1000, 1250].map(nm => (
              <g key={nm}>
                <line x1={diag.xs(nm)} y1={6} x2={diag.xs(nm)} y2={diag.H - diag.PAD_B} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(nm)} y={diag.H - diag.PAD_B + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{nm}nm</text>
              </g>
            ))}
            {/* aircraft dots */}
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(r.dtgNm)} cy={diag.ys(r.tErr)} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.95} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-FL</span><span className="font-mono text-slate-300">{minFl}</span></div>
            <input type="range" min={0} max={400} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-FL</span><span className="font-mono text-slate-300">{maxFl}</span></div>
            <input type="range" min={50} max={500} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>CAPTURE</span><span className="font-mono text-slate-300">{captureNm}nm</span></div>
            <input type="range" min={200} max={2500} step={50} value={captureNm} onChange={e => setCaptureNm(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>TOL-SEC</span><span className="font-mono text-slate-300">±{tolSec}s</span></div>
            <input type="range" min={10} max={120} step={5} value={tolSec} onChange={e => setTolSec(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div className="col-span-2">
            <div className="flex justify-between text-[10px] text-slate-500"><span>SLOT-DRIFT</span><span className="font-mono text-slate-300">{slotDrift >= 0 ? '+' : ''}{slotDrift}s</span></div>
            <input type="range" min={-300} max={300} step={15} value={slotDrift} onChange={e => setSlotDrift(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao / IATA"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'DESTS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length} ac` : `${filteredDests.length} dest`}</span>
        <span>{tab === 'AIRCRAFT' ? 'tErr · CTA · absorb · ΔM' : 'count · worst · mean'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          // tErr bar: -300..+300 sec mapped 0..100
          const pct = Math.max(0, Math.min(100, ((Math.max(-300, Math.min(300, r.tErr)) + 300) / 600) * 100))
          const center = 50
          const advice = r.tier === 'ON-TIME' ? 'on time · maintain Mach/IAS' :
            r.tier === 'DRIFT' ? 'minor drift · monitor TAS · trim ±1kt' :
            r.tier === 'LATE' ? `late · request +${Math.abs(Math.round(r.deltaV))}kt / M${r.deltaMach >= 0 ? '+' : ''}${r.deltaMach.toFixed(3)} per CTA` :
            r.tier === 'EARLY' ? `early · reduce ${Math.abs(Math.round(r.deltaV))}kt / M${r.deltaMach.toFixed(3)} or request path stretch` :
            'cannot meet CTA via speed · request reslot / radar vector'
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
                  <span title="flight level">F{Math.round(r.altFt / 100)}</span>
                  <span title="destination">›{r.dI}</span>
                  <span title="distance to go">{r.dtgNm.toFixed(0)}nm</span>
                  <span title="CTA UTC">{fmtClock(r.ctaSec)}</span>
                  <span className="ml-auto" title="signed time error" style={{ color: TIER_COLOR[r.tier] }}>{fmtSigned(r.tErr)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="time error -300..+300 sec">
                  <div className="absolute inset-y-0" style={{ left: `${Math.min(center, pct)}%`, width: `${Math.abs(pct - center)}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-slate-500" style={{ left: `${center}%` }} />
                  {[-2 * tolSec, -tolSec, tolSec, 2 * tolSec].map(y => {
                    const x = ((Math.max(-300, Math.min(300, y)) + 300) / 600) * 100
                    const c = Math.abs(y) === tolSec ? '#10b981' : '#0ea5e9'
                    return <div key={y} className="absolute inset-y-0 w-0.5" style={{ left: `${x}%`, background: c }} />
                  })}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="ETA from now">ETA{fmtSigned(r.etaSec).replace('+', '')}</span>
                  <span title="GS current">{r.gs.toFixed(0)}kt</span>
                  <span title="Mach current">M{r.machCur.toFixed(2)}</span>
                  <span title="absorption envelope ± sec">±{Math.round((r.absorbUp + r.absorbDn) / 2)}s</span>
                  <span className="ml-auto" title="required GS" style={{ color: Math.abs(r.deltaV) > 30 ? '#f59e0b' : '#64748b' }}>v★{r.vReq.toFixed(0)}kt</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="speed envelope">v[{r.vMin}-{r.vMax}]</span>
                  <span title="recommended delta GS" style={{ color: r.deltaV !== 0 ? TIER_COLOR[r.tier] : '#64748b' }}>Δv{r.deltaV >= 0 ? '+' : ''}{Math.round(r.deltaV)}kt</span>
                  <span title="recommended delta Mach" style={{ color: r.deltaMach !== 0 ? TIER_COLOR[r.tier] : '#64748b' }}>ΔM{r.deltaMach >= 0 ? '+' : ''}{r.deltaMach.toFixed(3)}</span>
                  <span className="ml-auto truncate" title="operator">{r.f.operator || '\u2014'}</span>
                </div>
                <div className="text-[10px] font-mono mt-0.5 truncate" title="advice" style={{ color: r.tier === 'ON-TIME' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</div>
                <div className="text-[10px] text-slate-600 font-mono mt-0.5 truncate" title="destination">{r.dIcao} · {r.dName}</div>
              </div>
            </button>
          )
        })}
        {tab === 'DESTS' && filteredDests.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No destinations match.</div>
        )}
        {tab === 'DESTS' && filteredDests.map(d => {
          const meanPct = Math.min(100, (d.meanAbs / Math.max(10, tolSec * 4)) * 100)
          return (
            <button key={d.key} onClick={() => { try { map?.flyTo({ center: [d.lng, d.lat], zoom: 7 }) } catch {} }}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[d.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{d.i}</span>
                  <span className="text-slate-500 truncate">{d.name}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{d.count} ac</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[d.worstTier] }}>{d.worstTier}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="mean |tErr| vs 4×TOL">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${meanPct}%`, background: TIER_COLOR[d.worstTier], opacity: 0.85 }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="mean |tErr|">μ|tErr|{fmtSigned(d.meanAbs).replace('+', '')}</span>
                  <span title="missed-count" style={{ color: d.missed > 0 ? '#ef4444' : '#64748b' }}>miss·{d.missed}</span>
                  <span title="mean CTA UTC">μCTA {fmtClock(d.meanCta)}</span>
                  <span className="ml-auto">{d.icao}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
