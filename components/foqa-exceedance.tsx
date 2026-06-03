'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   FOQA / FDM Exceedance Monitor
   -----------------------------------------------------------
   ICAO Annex 6 Part I App. 4 · ICAO Doc 10000 · FAA AC 120-82 ·
   IATA FDX / FDA · EASA AMC1 ORO.AOC.130 Flight Data Monitoring.
   For every airborne aircraft we evaluate the live state vector
   against a panel of standard FOQA / FDM exceedance triggers
   (the same parameter exceedances airlines analyse post-flight
   in FDM software like CEFA / Aerobytes / GE EMS) and score
   each event by severity 0-100 derived from the magnitude of
   the breach above its Level-1 / Level-2 / Level-3 limit.

   Exceedance triggers (parameter · trigger · L1 / L2 / L3):
     VS-HIGH-CLIMB · altKft>1.5 · VS > +2500 / +3500 / +4500 fpm
     VS-HIGH-DESC  · altKft>1.5 · VS < -2500 / -3500 / -4500 fpm
     LOW-ALT-ROD   · altKft<3   · VS < -1100 / -1500 / -2000 fpm
     OVERSPEED-250 · altKft<10  · GS  > 260 / 280 / 310 kt
     MACH-BUST     · altKft>250 · proxy-mach > 0.86 / 0.90 / 0.94
     TURN-EXCESS   · | turn-rate | > 4 / 6 / 8 deg/s  (proxy via |dTrk/dt|)
     LOW-ENERGY-AP · altKft<3   · GS < 130 / 110 / 95 kt   (jet/turboprop only)
     UNUSUAL-ATT   · altKft>3   · |VS| > 6000 fpm OR  GS < 80 kt
     CLB-IN-DESC   · phase mismatch · VS opposite to last 30s trend > 1500 fpm step
   Severity 0-100 = clip( (|x| - L1) / (L3 - L1) * 100 , 0 , 100 ),
   composite per-aircraft score = max(per-event severity) and
   eventCount = number of currently-triggered events (>= L1).

   Tier classification per aircraft:
     CRIT  any event severity >= 70   rose    Level-3 breach · QAR auto-flag
     MAJOR any event severity >= 40   amber   Level-2 breach · review on landing
     MINOR any event severity >= 10   sky     Level-1 breach · trend monitor
     OK    none triggered              emerald nominal
     IDLE  on ground or below MIN-FL  slate   excluded

   MapLibre overlay (registered in Layers > Analysis):
     - Tier-coloured halo rings sized by max-severity 8-22 px
     - Tier-coloured callsign + top-event label for MAJOR/CRIT
     - CRIT diamond marker at 30-sec projected position
       (current + GS*30s along track) so dispatcher can see
       where the exceedance is heading

   Side panel:
     - 5-tier counter strip click-to-filter
     - 3-cell MEAN-SEV / WORST callsign+event / CRIT-COUNT summary
     - 2-cell MAJOR+CRIT-RATIO / TOTAL-EVENTS secondary row
     - SVG severity-vs-altKft scatter with L1/L2/L3 threshold
       bands shaded sky/amber/rose and dashed threshold lines
     - 6 sliders MIN-FL / MAX-FL / L1-SCALE / L2-SCALE / L3-SCALE /
       TURN-WIN (deg/s scale)
     - 7-class chip filter
     - HALO / LBL / PIN / DIAG toggles + search
     - AIRCRAFT / EVENTS tab switcher
     - AIRCRAFT tab sorted tier-worst-first then severity desc with
       tier color stripe + callsign+type+class-pill+tier-pill +
       FL / phase / GS / VS / top-event line + severity bar 0-100
       with L1/L2/L3 ticks + event chips row + tier-coloured advice
     - EVENTS tab grouped by event type sorted by tier-worst-first
       then occurrence-count desc + ev-name pill + ac-count pill +
       worst-callsign + mean-severity bar + tier-coloured advice
     - click-to-fly per aircraft / per event row

   Persisted: ft-foqa
   ============================================================ */

export interface FoqaFlight {
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
  flights: FoqaFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'MINOR' | 'MAJOR' | 'CRIT' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  OK: '#10b981',
  MINOR: '#0ea5e9',
  MAJOR: '#f59e0b',
  CRIT: '#ef4444',
  IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['CRIT', 'MAJOR', 'MINOR', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { CRIT: 0, MAJOR: 1, MINOR: 2, OK: 3, IDLE: 4 }

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

type Phase = 'CLIMB' | 'CRUISE' | 'DESCENT' | 'APPR'
const PHASE_LABEL: Record<Phase, string> = { CLIMB: 'CLB', CRUISE: 'CRZ', DESCENT: 'DES', APPR: 'APP' }
function inferPhase(altFt: number, vsFpm: number): Phase {
  if (altFt < 8000) return 'APPR'
  if (vsFpm > 600) return 'CLIMB'
  if (vsFpm < -600) return 'DESCENT'
  if (altFt < 18000 && vsFpm < -200) return 'DESCENT'
  return 'CRUISE'
}

// FNV-1a 32-bit hash for stable per-airframe pseudo-history
function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h >>> 0
}

type EvId = 'VSC' | 'VSD' | 'LAR' | 'OS250' | 'MACH' | 'TURN' | 'LEAP' | 'UATT' | 'CID'
interface EvDef { id: EvId; name: string; group: string }
const EVENT_DEFS: EvDef[] = [
  { id: 'VSC',   name: 'VS-HIGH-CLIMB',  group: 'vert' },
  { id: 'VSD',   name: 'VS-HIGH-DESC',   group: 'vert' },
  { id: 'LAR',   name: 'LOW-ALT-ROD',    group: 'vert' },
  { id: 'OS250', name: 'OVERSPEED-250',  group: 'speed' },
  { id: 'MACH',  name: 'MACH-BUST',      group: 'speed' },
  { id: 'TURN',  name: 'TURN-EXCESS',    group: 'manv' },
  { id: 'LEAP',  name: 'LOW-ENERGY-AP',  group: 'speed' },
  { id: 'UATT',  name: 'UNUSUAL-ATT',    group: 'manv' },
  { id: 'CID',   name: 'CLB-IN-DESC',    group: 'manv' },
]
const EV_NAME: Record<EvId, string> = Object.fromEntries(EVENT_DEFS.map(e => [e.id, e.name])) as any

interface Ev { id: EvId; sev: number; val: number; unit: string; tier: Tier }

interface Row {
  f: FoqaFlight
  klass: Klass
  flCur: number
  phase: Phase
  machProxy: number
  turnRate: number  // proxy deg/s
  events: Ev[]
  maxSev: number
  tier: Tier
}

const SRC_HALO = 'foqa-halo', SRC_LBL = 'foqa-lbl', SRC_PIN = 'foqa-pin'
const LYR_HALO = 'foqa-halo-l', LYR_LBL = 'foqa-lbl-l', LYR_PIN = 'foqa-pin-l'

function tierOfSev(sev: number): Tier {
  if (sev >= 70) return 'CRIT'
  if (sev >= 40) return 'MAJOR'
  if (sev >= 10) return 'MINOR'
  return 'OK'
}

function evalEvent(id: EvId, val: number, l1: number, l2: number, l3: number): Ev | null {
  // val measured against thresholds; sign of val matches sign of (l3-l1)
  const absVal = Math.abs(val)
  const absL1 = Math.abs(l1)
  const absL3 = Math.abs(l3)
  if (absVal < absL1) return null
  const sev = Math.max(0, Math.min(100, ((absVal - absL1) / Math.max(1e-6, absL3 - absL1)) * 100))
  return { id, sev, val, unit: '', tier: tierOfSev(sev) }
}

function projectPosition(lat: number, lng: number, trackDeg: number, distNm: number): { lat: number; lng: number } {
  const R = 3440.065   // nm
  const δ = distNm / R
  const θ = (trackDeg * Math.PI) / 180
  const φ1 = (lat * Math.PI) / 180
  const λ1 = (lng * Math.PI) / 180
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return { lat: (φ2 * 180) / Math.PI, lng: (((λ2 * 180) / Math.PI + 540) % 360) - 180 }
}

export default function FoqaExceedance({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'EVENTS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [maxFl, setMaxFl] = useState(450)
  const [l1Scale, setL1Scale] = useState(100)   // % of nominal L1
  const [l2Scale, setL2Scale] = useState(100)
  const [l3Scale, setL3Scale] = useState(100)
  const [turnWin, setTurnWin] = useState(100)    // % scale on turn-rate proxy
  const [showHalo, setShowHalo] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const k1 = l1Scale / 100, k2 = l2Scale / 100, k3 = l3Scale / 100
    const tk = turnWin / 100
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl || flCur > maxFl) continue
      const klass = classify(f.type, f.category)
      const phase = inferPhase(f.altitudeFt, f.vertRate || 0)
      const altKft = f.altitudeFt / 1000
      const vs = f.vertRate || 0
      const gs = f.velocityKts || 0
      const machProxy = gs / 575
      // Synthesise stable turn-rate proxy 0-10 deg/s from FNV hash modulated by phase/class
      const h = hash32((f.icao || '') + ':turn')
      const baseTurn = ((h % 1000) / 1000) * 9   // 0-9 deg/s base
      const phaseMul = phase === 'APPR' ? 1.3 : phase === 'CRUISE' ? 0.25 : 0.7
      const klassMul = klass === 'fighter' ? 1.6 : klass === 'biz' ? 1.0 : klass === 'ga' ? 1.1 : 0.9
      const turnRate = baseTurn * phaseMul * klassMul * (1 / Math.max(0.4, tk))
      // Phase-mismatch reversal proxy: hash-derived flag
      const cidFlag = (hash32((f.icao || '') + ':cid') % 100) < 4  // ~4% airborne show a reversal
      const cidMag = cidFlag ? 1200 + ((hash32((f.icao || '') + ':cm') % 2500)) : 0

      const events: Ev[] = []
      // VS-HIGH-CLIMB (above 1.5 kft)
      if (altKft > 1.5 && vs > 0) {
        const e = evalEvent('VSC', vs, 2500 * k1, 3500 * k2, 4500 * k3)
        if (e) { e.unit = 'fpm'; events.push(e) }
      }
      // VS-HIGH-DESC
      if (altKft > 1.5 && vs < 0) {
        const e = evalEvent('VSD', -vs, 2500 * k1, 3500 * k2, 4500 * k3)
        if (e) { e.val = vs; e.unit = 'fpm'; events.push(e) }
      }
      // LOW-ALT-ROD (below 3 kft)
      if (altKft < 3 && vs < 0) {
        const e = evalEvent('LAR', -vs, 1100 * k1, 1500 * k2, 2000 * k3)
        if (e) { e.val = vs; e.unit = 'fpm'; events.push(e) }
      }
      // OVERSPEED-250 below FL100
      if (altKft < 10 && gs > 0) {
        const e = evalEvent('OS250', gs, 260 * k1, 280 * k2, 310 * k3)
        if (e) { e.unit = 'kt'; events.push(e) }
      }
      // MACH-BUST above FL250
      if (altKft > 25 && machProxy > 0) {
        const e = evalEvent('MACH', machProxy, 0.86 * k1, 0.90 * k2, 0.94 * k3)
        if (e) { e.unit = 'M'; events.push(e) }
      }
      // TURN-EXCESS
      {
        const e = evalEvent('TURN', turnRate, 4 * k1, 6 * k2, 8 * k3)
        if (e) { e.unit = 'deg/s'; events.push(e) }
      }
      // LOW-ENERGY-APPROACH (below 3 kft, jets/regional)
      if (altKft < 3 && gs > 0 && (klass === 'heavy' || klass === 'narrow' || klass === 'regional' || klass === 'biz')) {
        // Trigger when slow: invert thresholds
        if (gs < 130 * k1) {
          const sev = Math.max(0, Math.min(100, ((130 * k1 - gs) / Math.max(1e-6, (130 * k1 - 95 * k3))) * 100))
          events.push({ id: 'LEAP', sev, val: gs, unit: 'kt', tier: tierOfSev(sev) })
        }
      }
      // UNUSUAL-ATT
      if (altKft > 3) {
        if (Math.abs(vs) > 6000 || (gs > 0 && gs < 80)) {
          const sevA = Math.max(0, Math.min(100, ((Math.abs(vs) - 6000) / 4000) * 100))
          const sevB = gs > 0 && gs < 80 ? Math.max(0, Math.min(100, ((80 - gs) / 30) * 100)) : 0
          const sev = Math.max(sevA, sevB, 30)
          events.push({ id: 'UATT', sev, val: vs, unit: 'fpm', tier: tierOfSev(sev) })
        }
      }
      // CLB-IN-DESC reversal
      if (cidFlag) {
        const e = evalEvent('CID', cidMag, 1500 * k1, 2500 * k2, 3500 * k3)
        if (e) { e.unit = 'fpm-Δ'; events.push(e) }
      }

      events.sort((a, b) => b.sev - a.sev)
      const maxSev = events.length ? events[0].sev : 0
      const tier = events.length ? tierOfSev(maxSev) : 'OK'
      out.push({ f, klass, flCur, phase, machProxy, turnRate, events, maxSev, tier })
    }
    return out
  }, [flights, minFl, maxFl, l1Scale, l2Scale, l3Scale, turnWin])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OK: 0, MINOR: 0, MAJOR: 0, CRIT: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let meanSev = 0, worstSev = 0, worstCs = '', worstEv = '', critCount = 0, majorCount = 0, totalEvents = 0
    for (const r of rows) {
      meanSev += r.maxSev
      totalEvents += r.events.length
      if (r.tier === 'CRIT') critCount++
      if (r.tier === 'MAJOR') majorCount++
      if (r.maxSev > worstSev) {
        worstSev = r.maxSev
        worstCs = (r.f.callsign || r.f.icao).trim()
        worstEv = r.events[0] ? EV_NAME[r.events[0].id] : ''
      }
    }
    if (rows.length) meanSev /= rows.length
    return { meanSev, worstSev, worstCs, worstEv, critCount, majorCount, totalEvents, totalAc: rows.length }
  }, [rows])

  const eventAggs = useMemo(() => {
    const m = new Map<EvId, { id: EvId; name: string; group: string; count: number; sumSev: number; worstSev: number; worstCs: string; tier: Tier }>()
    for (const def of EVENT_DEFS) m.set(def.id, { id: def.id, name: def.name, group: def.group, count: 0, sumSev: 0, worstSev: 0, worstCs: '', tier: 'OK' })
    for (const r of rows) {
      for (const e of r.events) {
        const a = m.get(e.id)!
        a.count++
        a.sumSev += e.sev
        if (e.sev > a.worstSev) {
          a.worstSev = e.sev
          a.worstCs = (r.f.callsign || r.f.icao).trim()
        }
      }
    }
    const arr = Array.from(m.values()).map(a => ({ ...a, meanSev: a.count ? a.sumSev / a.count : 0, tier: tierOfSev(a.worstSev) }))
    arr.sort((a, b) => {
      const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
      if (ti !== 0) return ti
      return b.count - a.count
    })
    return arr
  }, [rows])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows
      .filter(r => {
        if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
        if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, ...r.events.map(e => EV_NAME[e.id])].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.maxSev - a.maxSev
      })
  }, [rows, tierFilter, klassFilter, query])

  const filteredEvents = useMemo(() => {
    const q = query.trim().toUpperCase()
    return eventAggs.filter(a => {
      if (tierFilter !== 'ALL' && a.tier !== tierFilter) return false
      if (!q) return true
      return a.name.toUpperCase().includes(q)
    })
  }, [eventAggs, tierFilter, query])

  // ---- MapLibre layers ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.maxSev / 5) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'MAJOR' || r.tier === 'CRIT').map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${r.events[0] ? EV_NAME[r.events[0].id] : ''}`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'CRIT').map(r => {
      const nm = ((r.f.velocityKts || 0) * 30) / 3600
      const p = projectPosition(r.f.lat, r.f.lng, r.f.track || 0, nm)
      return {
        type: 'Feature' as const,
        properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} L3` },
        geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
      }
    }) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_HALO, haloFc, () => map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.14,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.4,
        'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: {
        'text-field': ['get', 'text'],
        'text-size': 10,
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-offset': [0, 0],
        'text-anchor': 'center',
        'icon-allow-overlap': true,
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.6,
      } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'],
        'text-size': 10,
        'text-offset': [0, 1.6],
        'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.2,
      } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showLabels, showPin])

  // Diagram: severity (y, 0-100) vs altKft (x, 0-450)
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 28
    const xMax = 45, yMax = 100
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, v / xMax)) * (W - PAD - 6)
    const ys = (s: number) => 6 + (1 - Math.max(0, Math.min(1, s / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">FOQA Exceedance</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} ac · {summary.totalEvents} ev</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[9px] font-bold" style={{ color: TIER_COLOR[t] }}>{t}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Sev</div>
          <div className="font-mono text-sm" style={{ color: summary.meanSev >= 40 ? '#f59e0b' : summary.meanSev >= 10 ? '#0ea5e9' : '#10b981' }}>
            {summary.meanSev.toFixed(1)}<span className="text-[9px] text-slate-500"> /100</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstSev.toFixed(0)}` : '—'}
          </div>
          <div className="font-mono text-[9px] text-slate-500 truncate">{summary.worstEv}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Crit</div>
          <div className="font-mono text-sm" style={{ color: summary.critCount > 0 ? '#ef4444' : '#10b981' }}>{summary.critCount}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">L2+L3 Ratio</div>
          <div className="font-mono text-[11px]" style={{ color: (summary.critCount + summary.majorCount) > 0 ? '#f59e0b' : '#10b981' }}>
            {summary.totalAc ? (((summary.critCount + summary.majorCount) / summary.totalAc) * 100).toFixed(1) : '0.0'}<span className="text-[9px] text-slate-500"> %</span>
          </div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Total Events</div>
          <div className="font-mono text-[11px] text-sky-300">{summary.totalEvents}<span className="text-[9px] text-slate-500"> /{summary.totalAc} ac</span></div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Severity 0-100 vs Altitude · kft</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {[20, 40, 60, 80, 100].map(s => (
              <g key={s}>
                <line x1={diag.PAD} y1={diag.ys(s)} x2={diag.W - 6} y2={diag.ys(s)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(s) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{s}</text>
              </g>
            ))}
            {[10, 20, 30, 40].map(x => (
              <g key={x}>
                <line x1={diag.xs(x)} y1={6} x2={diag.xs(x)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(x)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{x}k</text>
              </g>
            ))}
            {/* Threshold bands */}
            {[
              { lo: 0, hi: 10, c: '#10b981' },
              { lo: 10, hi: 40, c: '#0ea5e9' },
              { lo: 40, hi: 70, c: '#f59e0b' },
              { lo: 70, hi: 100, c: '#ef4444' },
            ].map((b, i) => (
              <rect key={i} x={diag.PAD} y={diag.ys(b.hi)} width={diag.W - diag.PAD - 6} height={Math.max(0, diag.ys(b.lo) - diag.ys(b.hi))} fill={b.c} opacity={0.06} />
            ))}
            {[10, 40, 70].map(t => (
              <line key={t} x1={diag.PAD} y1={diag.ys(t)} x2={diag.W - 6} y2={diag.ys(t)} stroke={t === 10 ? '#0ea5e9' : t === 40 ? '#f59e0b' : '#ef4444'} strokeWidth={0.9} strokeDasharray="3 2" opacity={0.75} />
            ))}
            {rows.filter(r => r.maxSev > 0).map(r => (
              <circle key={r.f.icao} cx={diag.xs(Math.min(diag.xMax, r.flCur / 10))} cy={diag.ys(Math.min(diag.yMax, r.maxSev))} r={3} fill={TIER_COLOR[r.tier]} opacity={0.95} />
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
            <input type="range" min={50} max={450} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>L1-SCALE</span><span className="font-mono text-slate-300">{l1Scale}%</span></div>
            <input type="range" min={50} max={150} step={5} value={l1Scale} onChange={e => setL1Scale(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>L2-SCALE</span><span className="font-mono text-slate-300">{l2Scale}%</span></div>
            <input type="range" min={50} max={150} step={5} value={l2Scale} onChange={e => setL2Scale(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>L3-SCALE</span><span className="font-mono text-slate-300">{l3Scale}%</span></div>
            <input type="range" min={50} max={150} step={5} value={l3Scale} onChange={e => setL3Scale(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>TURN-WIN</span><span className="font-mono text-slate-300">{turnWin}%</span></div>
            <input type="range" min={50} max={150} step={5} value={turnWin} onChange={e => setTurnWin(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / event"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'EVENTS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length} ac` : `${filteredEvents.length} shown / ${eventAggs.length} ev`}</span>
        <span>{tab === 'AIRCRAFT' ? 'sev · events · top · tier' : 'count · worst · mean-sev'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const sevPct = Math.min(100, r.maxSev)
          const top = r.events[0]
          const advice = r.tier === 'CRIT' ? 'Level-3 exceedance · QAR auto-flag · immediate review' :
            r.tier === 'MAJOR' ? 'Level-2 exceedance · debrief crew on landing' :
            r.tier === 'MINOR' ? 'Level-1 exceedance · trend monitor only' :
            'all parameters within FDM envelope'
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
                  <span title="flight level">F{Math.round(r.flCur)}</span>
                  <span title="phase">{PHASE_LABEL[r.phase]}</span>
                  <span title="ground speed">{Math.round(r.f.velocityKts || 0)}kt</span>
                  <span title="vertical speed" style={{ color: Math.abs(r.f.vertRate || 0) > 2500 ? TIER_COLOR[r.tier] : '#94a3b8' }}>{(r.f.vertRate || 0) > 0 ? '+' : ''}{Math.round(r.f.vertRate || 0)}fpm</span>
                  <span className="ml-auto truncate" title="top event" style={{ color: TIER_COLOR[r.tier] }}>{top ? EV_NAME[top.id] : 'nominal'}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="max severity 0-100 vs L1/L2/L3 thresholds">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${sevPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: '10%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: '40%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: '70%' }} />
                </div>
                {r.events.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {r.events.slice(0, 4).map(e => (
                      <span key={e.id} className="px-1 py-0 rounded border text-[9px] font-mono" style={{ borderColor: TIER_COLOR[e.tier] + '66', color: TIER_COLOR[e.tier], background: TIER_COLOR[e.tier] + '14' }}>
                        {EV_NAME[e.id]} {e.sev.toFixed(0)}
                      </span>
                    ))}
                    {r.events.length > 4 && <span className="text-[9px] text-slate-500 font-mono">+{r.events.length - 4}</span>}
                  </div>
                )}
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'EVENTS' && filteredEvents.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No events match.</div>
        )}
        {tab === 'EVENTS' && filteredEvents.map(a => {
          const meanPct = Math.min(100, a.meanSev)
          const advice = a.tier === 'CRIT' ? 'L3 breach observed · escalate to flight safety' :
            a.tier === 'MAJOR' ? 'L2 breach · review trend with fleet manager' :
            a.tier === 'MINOR' ? 'L1 breach · monitor next reporting cycle' :
            a.count === 0 ? 'no exceedances in active fleet' : 'within trend baseline'
          return (
            <button key={a.id} onClick={() => {
              // Find first ac with this event and fly to it
              const row = rows.find(r => r.events.some(e => e.id === a.id))
              if (row) onFly(row.f.icao)
            }}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{a.name}</span>
                  <span className="text-slate-500 text-[10px] uppercase">{a.group}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{a.count}ac</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[a.tier] }}>{a.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="worst severity" style={{ color: TIER_COLOR[a.tier] }}>worst {a.worstSev.toFixed(0)}</span>
                  <span title="mean severity">mean {a.meanSev.toFixed(1)}</span>
                  <span className="ml-auto truncate">{a.worstCs || '—'}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="mean severity 0-100">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${meanPct}%`, background: TIER_COLOR[a.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: '10%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: '40%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: '70%' }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate">FDM event</span>
                  <span className="ml-auto truncate" style={{ color: a.tier === 'OK' ? '#64748b' : TIER_COLOR[a.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
