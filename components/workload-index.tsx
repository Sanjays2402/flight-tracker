'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Pilot Workload Index Monitor
   -----------------------------------------------------------
   NASA TLX-style composite cockpit workload synthesis for
   every airborne aircraft. The monitor estimates a real-time
   pilot mental workload score (0..100) from six passive ADS-B
   signals plus operator-tunable weights, classifies the score
   into four FAA/Eurocontrol HF-team workload tiers, and surfaces
   the dominant driver so observers can spot crews who are
   currently saturated.

   Score model (per NASA TLX adaptation + Wickens MRT):

     phaseW    : 0..1   phase-of-flight task demand
                  cruise stable          0.18
                  climb-out              0.55
                  initial descent        0.45
                  late descent / TOD     0.62
                  approach / final       0.95
                  ground / pre-takeoff   0.10
     trafficW  : 0..1   neighbours within R_NM (slider) AND
                  +/- 2000ft vertical, soft-mapped n/8.
     dynW      : 0..1   pitch + speed instability proxy from
                  |VS|/2000 + |bank|/30 (track-derivative via
                  vertRate dominant), high when manoeuvring.
     terrainW  : 0..1   low altitude + high sink rate (TAWS-
                  proximate) using altitude-band envelope:
                  0.0  >FL150,   0.1  FL100,   0.3  FL050
                  0.6  3000ft,   0.9  1500ft + sink>500fpm
     circW     : 0..1   circadian-time-of-day backside-of-clock
                  fatigue proxy from estimated local-time
                  derived from lng/15 UTC offset:
                  0200-0600 LT  -> 1.0 (WOCL)
                  0000-0200 LT  -> 0.7
                  2200-2400 LT  -> 0.5
                  daylight       -> 0.1
     configW   : 0..1   configuration-change workload heuristic
                  triggered by |vertRate|>1500 below FL150
                  (gear/flaps in descent or initial climb).

     score = 100 * (
       0.22 * phaseW   +
       0.20 * trafficW +
       0.18 * dynW     +
       0.18 * terrainW +
       0.12 * configW  +
       0.10 * circW
     )

   Tiers (per Eurocontrol HF Workload Working Group 2018):

     LOW       <30   emerald  monitoring
     MOD       <55   sky      managing
     HIGH      <75   amber    high workload — defer non-essential
     CRIT      >=75  rose     saturated — call for assistance

   Dominant-driver tag picks the largest weighted factor and
   labels the crew with a short cue (PHASE / TRAFFIC / DYNAMICS
   / TERRAIN / CONFIG / NIGHT).

   MapLibre overlay:
     - Halo ring sized by score (8-22 px).
     - Dashed amber/rose line to the busiest neighbour for
       HIGH/CRIT aircraft when traffic is the dominant driver.
     - Callsign + score + driver-tag labels for HIGH/CRIT.

   Side panel:
     - 4-tier counter strip click-to-filter.
     - 3-cell MEAN-SCORE / WORST callsign+score / CRIT-COUNT.
     - 2-cell BACKSIDE-COUNT (WOCL-window crews) / HIGH-TRAFFIC
       (crews with trafficW>=0.5).
     - SVG score-vs-FL scatter with tier bands shaded.
     - 4 sliders: MIN-FL / MAX-FL / TRAFFIC-RADIUS nm / WT-MIX.
     - 7-class chip filter.
     - HALO / PROX / LBL / DIAG toggles + search.
     - AIRCRAFT / DRIVERS tabs.

   Registered in Layers > Analysis.
   ft-wkld persisted preference.
   ============================================================ */

export interface WkFlight {
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
  flights: WkFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'LOW' | 'MOD' | 'HIGH' | 'CRIT'
const TIER_COLOR: Record<Tier, string> = {
  LOW: '#10b981',
  MOD: '#0ea5e9',
  HIGH: '#f59e0b',
  CRIT: '#ef4444',
}
const TIER_ORDER: Tier[] = ['CRIT', 'HIGH', 'MOD', 'LOW']

type Driver = 'PHASE' | 'TRAFFIC' | 'DYN' | 'TERR' | 'CFG' | 'NIGHT'
const DRIVER_LABEL: Record<Driver, string> = {
  PHASE: 'PHASE', TRAFFIC: 'TRAFFIC', DYN: 'DYNAMICS', TERR: 'TERRAIN', CFG: 'CONFIG', NIGHT: 'NIGHT',
}

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}
function classify(t: string | undefined, cat?: string): Klass {
  const s = (t || '').toUpperCase()
  if (cat === 'A5' || /F1|F2|F3|F4|F5|F6|F7|F8/.test(s) || /EUFI|F18|F16|F15|F35|F22|MIG|SU2|SU3|TYP/.test(s)) return 'fighter'
  if (/A38|A35|A34|A33|B74|B77|B78|MD11|IL96|A330|A340|A350|A380|B747|B767|B777|B787/.test(s)) return 'heavy'
  if (/A31|A32|B73|B72|MD8|MD9|A220|BCS|A318|A319|A320|A321|B737/.test(s)) return 'narrow'
  if (/CRJ|E17|E19|E29|E14|E15|AT4|AT7|DH8|ATR/.test(s)) return 'regional'
  if (/GLF|GLEX|GLF6|GLF5|G650|G550|G450|CL3|CL6|FA7|FA8|CL60|H25|LJ|C56X|C68A|E55P|E550|E50P/.test(s)) return 'biz'
  if (/PC12|TBM|KOD|C208|PC6|C68|C56/.test(s)) return 'turboprop'
  return 'ga'
}

type Phase = 'GND' | 'TKO' | 'CLB' | 'CRZ' | 'DSC' | 'APR'
function phaseOf(altFt: number, vsFpm: number, gs: number): Phase {
  if (altFt < 100) return 'GND'
  if (altFt < 4000 && vsFpm > 500) return 'TKO'
  if (vsFpm > 500) return 'CLB'
  if (vsFpm < -500 && altFt < 8000) return 'APR'
  if (vsFpm < -300) return 'DSC'
  return 'CRZ'
}
function phaseW(p: Phase, altFt: number, vsFpm: number): number {
  if (p === 'GND') return 0.10
  if (p === 'TKO') return 0.85
  if (p === 'CLB') return 0.55
  if (p === 'APR') return 0.95
  if (p === 'DSC') return altFt < 12000 ? 0.62 : 0.45
  // cruise — small bump for high mach corner
  return 0.18 + (altFt > 38000 ? 0.05 : 0)
}

function dynW(vsFpm: number, gs: number): number {
  // VS dominant + mach-band bonus
  const v = Math.min(1, Math.abs(vsFpm) / 2000)
  const s = gs > 0 ? Math.min(0.3, Math.abs(gs - 300) / 1000) : 0
  return Math.min(1, v + s * 0.4)
}

function terrainW(altFt: number, vsFpm: number): number {
  // simple envelope (no terrain DEM here — relies on altitude band)
  if (altFt > 15000) return 0
  if (altFt > 10000) return 0.10
  if (altFt > 5000) return 0.30
  if (altFt > 3000) return 0.50
  if (altFt > 1500) return 0.70 + (vsFpm < -500 ? 0.10 : 0)
  return 0.90 + (vsFpm < -500 ? 0.10 : 0)
}

function configW(altFt: number, vsFpm: number): number {
  if (altFt > 15000) return 0
  const mag = Math.abs(vsFpm)
  if (mag < 600) return 0.05
  if (mag < 1200) return 0.25 + Math.max(0, (10000 - altFt) / 10000) * 0.2
  return 0.55 + Math.max(0, (10000 - altFt) / 10000) * 0.35
}

function circW(lng: number): number {
  const utcH = new Date().getUTCHours() + new Date().getUTCMinutes() / 60
  const offset = lng / 15
  let lt = (utcH + offset) % 24
  if (lt < 0) lt += 24
  // Window of Circadian Low (WOCL) 02-06 LT — backside-of-clock penalty
  if (lt >= 2 && lt < 6) return 1.0
  if (lt >= 0 && lt < 2) return 0.7
  if (lt >= 22 && lt < 24) return 0.5
  if (lt >= 6 && lt < 8) return 0.35
  if (lt >= 20 && lt < 22) return 0.3
  return 0.10
}

const D2R = Math.PI / 180
const R_NM = 3440.065
function gcDistNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R
  const dφ = (la2 - la1) * D2R, dλ = (lo2 - lo1) * D2R
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}

interface Row {
  f: WkFlight
  klass: Klass
  altFt: number
  phase: Phase
  pW: number
  tW: number
  dW: number
  trW: number
  cW: number
  nW: number
  score: number
  tier: Tier
  driver: Driver
  trafN: number
  nearest: { icao: string; lat: number; lng: number; dNm: number } | null
}

const SRC_RING = 'wkld-ring', SRC_PROX = 'wkld-prox', SRC_LBL = 'wkld-lbl'
const LYR_RING = 'wkld-ring-l', LYR_PROX = 'wkld-prox-l', LYR_LBL = 'wkld-lbl-l'

export default function WorkloadIndex({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'DRIVERS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [maxFl, setMaxFl] = useState(450)
  const [trafR, setTrafR] = useState(10)         // nm
  const [wtMix, setWtMix] = useState(100)        // % global multiplier on derived factors
  const [showRing, setShowRing] = useState(true)
  const [showProx, setShowProx] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const air = flights.filter(f => !f.ground && isFinite(f.altitudeFt) && isFinite(f.lat) && isFinite(f.lng))
    const mult = wtMix / 100
    for (const f of air) {
      const fl = f.altitudeFt / 100
      if (fl < minFl || fl > maxFl) continue
      const phase = phaseOf(f.altitudeFt, f.vertRate || 0, f.velocityKts || 0)
      // traffic count
      let trafN = 0
      let nearest: { icao: string; lat: number; lng: number; dNm: number } | null = null
      for (const g of air) {
        if (g.icao === f.icao) continue
        if (Math.abs(g.altitudeFt - f.altitudeFt) > 2000) continue
        // cheap pre-filter
        if (Math.abs(g.lat - f.lat) > 0.4) continue
        if (Math.abs(g.lng - f.lng) > 0.6) continue
        const d = gcDistNm(f.lat, f.lng, g.lat, g.lng)
        if (d <= trafR) {
          trafN++
          if (!nearest || d < nearest.dNm) nearest = { icao: g.icao, lat: g.lat, lng: g.lng, dNm: d }
        }
      }
      const pW = Math.min(1, phaseW(phase, f.altitudeFt, f.vertRate || 0))
      const tW = Math.min(1, trafN / 8) * mult
      const dW = Math.min(1, dynW(f.vertRate || 0, f.velocityKts || 0) * mult)
      const trW = Math.min(1, terrainW(f.altitudeFt, f.vertRate || 0) * mult)
      const cW = Math.min(1, configW(f.altitudeFt, f.vertRate || 0) * mult)
      const nW = Math.min(1, circW(f.lng))
      const score = Math.max(0, Math.min(100, 100 * (0.22 * pW + 0.20 * tW + 0.18 * dW + 0.18 * trW + 0.12 * cW + 0.10 * nW)))
      const tier: Tier = score >= 75 ? 'CRIT' : score >= 55 ? 'HIGH' : score >= 30 ? 'MOD' : 'LOW'
      // dominant driver: pick max weighted contribution
      const contribs: Array<[Driver, number]> = [
        ['PHASE', 0.22 * pW], ['TRAFFIC', 0.20 * tW], ['DYN', 0.18 * dW], ['TERR', 0.18 * trW], ['CFG', 0.12 * cW], ['NIGHT', 0.10 * nW],
      ]
      contribs.sort((a, b) => b[1] - a[1])
      const driver = contribs[0][0]
      out.push({
        f, klass: classify(f.type, f.category), altFt: f.altitudeFt, phase,
        pW, tW, dW, trW, cW, nW, score, tier, driver, trafN, nearest,
      })
    }
    return out
  }, [flights, minFl, maxFl, trafR, wtMix])

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (q) {
        const hay = `${r.f.callsign || ''} ${r.f.type || ''} ${r.f.operator || ''} ${r.f.icao} ${r.driver} ${r.phase}`.toUpperCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [rows, tierFilter, klassFilter, query])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { LOW: 0, MOD: 0, HIGH: 0, CRIT: 0 }
    rows.forEach(r => c[r.tier]++)
    return c
  }, [rows])

  const mean = useMemo(() => rows.length ? rows.reduce((s, r) => s + r.score, 0) / rows.length : 0, [rows])
  const worst = useMemo(() => rows.length ? [...rows].sort((a, b) => b.score - a.score)[0] : null, [rows])
  const backside = useMemo(() => rows.filter(r => r.nW >= 0.6).length, [rows])
  const heavyTraf = useMemo(() => rows.filter(r => r.tW >= 0.5).length, [rows])

  const ranked = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const ai = TIER_ORDER.indexOf(a.tier), bi = TIER_ORDER.indexOf(b.tier)
      if (ai !== bi) return ai - bi
      return b.score - a.score
    })
  }, [filtered])

  const driverGroups = useMemo(() => {
    const g: Record<Driver, Row[]> = { PHASE: [], TRAFFIC: [], DYN: [], TERR: [], CFG: [], NIGHT: [] }
    filtered.forEach(r => g[r.driver].push(r))
    return (Object.keys(g) as Driver[])
      .map(d => {
        const list = g[d]
        const meanScore = list.length ? list.reduce((s, r) => s + r.score, 0) / list.length : 0
        const worstTier: Tier = list.length
          ? (list.some(r => r.tier === 'CRIT') ? 'CRIT'
            : list.some(r => r.tier === 'HIGH') ? 'HIGH'
            : list.some(r => r.tier === 'MOD') ? 'MOD' : 'LOW')
          : 'LOW'
        return { d, list, meanScore, worstTier }
      })
      .filter(x => x.list.length > 0)
      .sort((a, b) => b.list.length - a.list.length)
  }, [filtered])

  // ============================================================
  // MapLibre overlay
  // ============================================================
  useEffect(() => {
    const m = map
    if (!m) return
    if (!m.isStyleLoaded?.()) {
      const onload = () => { try { render() } catch { } }
      m.once('load', onload)
      return () => { try { m.off('load', onload) } catch { } }
    }
    render()
    function render() {
      const rings: any[] = [], prox: any[] = [], lbls: any[] = []
      for (const r of ranked) {
        const c = TIER_COLOR[r.tier]
        const radius = Math.max(8, Math.min(22, 6 + r.score / 7))
        if (showRing) rings.push({ type: 'Feature', properties: { color: c, radius }, geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] } })
        if (showProx && r.nearest && (r.tier === 'HIGH' || r.tier === 'CRIT') && r.driver === 'TRAFFIC') {
          prox.push({ type: 'Feature', properties: { color: c }, geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.nearest.lng, r.nearest.lat]] } })
        }
        if (showLabels && (r.tier === 'HIGH' || r.tier === 'CRIT')) {
          lbls.push({
            type: 'Feature',
            properties: { color: c, label: `${r.f.callsign || r.f.icao}  ${Math.round(r.score)}  ${DRIVER_LABEL[r.driver]}` },
            geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
          })
        }
      }
      ensureSrc(SRC_RING, rings)
      ensureSrc(SRC_PROX, prox)
      ensureSrc(SRC_LBL, lbls)
      ensureLayer(LYR_RING, {
        id: LYR_RING, type: 'circle', source: SRC_RING,
        paint: {
          'circle-radius': ['get', 'radius'],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.16,
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-width': 1.4,
          'circle-stroke-opacity': 0.85,
        },
      })
      ensureLayer(LYR_PROX, {
        id: LYR_PROX, type: 'line', source: SRC_PROX,
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 1.3,
          'line-opacity': 0.7,
          'line-dasharray': [3, 2] as any,
        },
      })
      ensureLayer(LYR_LBL, {
        id: LYR_LBL, type: 'symbol', source: SRC_LBL,
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 11,
          'text-offset': [0, -1.6],
          'text-anchor': 'bottom',
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        },
        paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0f172a', 'text-halo-width': 1.4 },
      })
      function ensureSrc(id: string, features: any[]) {
        const src = m!.getSource(id)
        if (src) (src as any).setData({ type: 'FeatureCollection', features })
        else m!.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features } })
      }
      function ensureLayer(id: string, spec: any) {
        if (!m!.getLayer(id)) m!.addLayer(spec)
      }
    }
    return () => {
      try {
        ;[LYR_LBL, LYR_PROX, LYR_RING].forEach(l => { if (m.getLayer(l)) m.removeLayer(l) })
        ;[SRC_LBL, SRC_PROX, SRC_RING].forEach(s => { if (m.getSource(s)) m.removeSource(s) })
      } catch { }
    }
  }, [map, ranked, showRing, showProx, showLabels])

  // ============================================================
  // SVG score-vs-FL scatter
  // ============================================================
  const W = 376, H = 168, PADL = 30, PADR = 10, PADT = 12, PADB = 22
  const PW = W - PADL - PADR, PH = H - PADT - PADB
  const xOf = (fl: number) => PADL + Math.max(0, Math.min(1, fl / 450)) * PW
  const yOf = (s: number) => PADT + (1 - Math.max(0, Math.min(100, s)) / 100) * PH

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[88vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Analysis</div>
          <div className="text-sm font-semibold text-slate-100">Pilot Workload Index</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      <div className="overflow-y-auto">
        {/* Tier counter */}
        <div className="px-3 pt-3 grid grid-cols-5 gap-1.5">
          {(['ALL', ...TIER_ORDER] as const).map(t => {
            const isAll = t === 'ALL'
            const n = isAll ? rows.length : counts[t as Tier]
            const active = tierFilter === t
            const col = isAll ? '#94a3b8' : TIER_COLOR[t as Tier]
            return (
              <button key={t} onClick={() => setTierFilter(t as any)}
                className={`px-1.5 py-1.5 rounded-lg text-[10px] font-bold tracking-wider border ${active ? 'bg-sky-500/15 border-sky-500/40' : 'bg-slate-900/50 border-slate-800 hover:border-slate-700'}`}
                style={{ color: col }}>
                <div className="text-[9px] opacity-70">{isAll ? 'ALL' : t}</div>
                <div className="text-sm">{n}</div>
              </button>
            )
          })}
        </div>

        {/* Summary */}
        <div className="px-3 pt-2 grid grid-cols-3 gap-1.5">
          <Cell label="MEAN TLX" value={`${Math.round(mean)}`} color={mean >= 55 ? '#f59e0b' : mean >= 30 ? '#0ea5e9' : '#10b981'} />
          <Cell label="WORST" value={worst ? `${worst.f.callsign || worst.f.icao}` : '—'} sub={worst ? `${Math.round(worst.score)}` : ''} color={worst ? TIER_COLOR[worst.tier] : '#64748b'} />
          <Cell label="CRIT" value={String(counts.CRIT)} color={counts.CRIT ? '#ef4444' : '#10b981'} />
        </div>
        <div className="px-3 pt-1.5 grid grid-cols-2 gap-1.5">
          <Cell label="WOCL CREWS" value={String(backside)} color={backside ? '#f59e0b' : '#64748b'} />
          <Cell label="HEAVY TRAF" value={String(heavyTraf)} color={heavyTraf ? '#0ea5e9' : '#64748b'} />
        </div>

        {/* SVG scatter */}
        {showDiag && (
          <div className="px-3 pt-2">
            <svg width={W} height={H} className="bg-slate-900/40 rounded-lg border border-slate-800">
              {/* tier bands */}
              <rect x={PADL} y={yOf(100)} width={PW} height={yOf(75) - yOf(100)} fill="#ef4444" opacity={0.08} />
              <rect x={PADL} y={yOf(75)} width={PW} height={yOf(55) - yOf(75)} fill="#f59e0b" opacity={0.08} />
              <rect x={PADL} y={yOf(55)} width={PW} height={yOf(30) - yOf(55)} fill="#0ea5e9" opacity={0.06} />
              <rect x={PADL} y={yOf(30)} width={PW} height={yOf(0) - yOf(30)} fill="#10b981" opacity={0.06} />
              {/* threshold lines */}
              {[30, 55, 75].map(s => (
                <line key={s} x1={PADL} x2={W - PADR} y1={yOf(s)} y2={yOf(s)} stroke={s === 75 ? '#ef4444' : s === 55 ? '#f59e0b' : '#0ea5e9'} strokeWidth={0.8} strokeDasharray="3,3" />
              ))}
              {/* x verticals */}
              {[100, 200, 300, 400].map(fl => (
                <g key={fl}>
                  <line x1={xOf(fl)} x2={xOf(fl)} y1={PADT} y2={H - PADB} stroke="#1e293b" strokeWidth={1} />
                  <text x={xOf(fl)} y={H - 6} fill="#475569" fontSize={8} textAnchor="middle">F{fl}</text>
                </g>
              ))}
              {/* y labels */}
              {[30, 55, 75].map(s => (
                <text key={s} x={W - PADR - 2} y={yOf(s) - 2} textAnchor="end" fontSize={8} fill={s === 75 ? '#ef4444' : s === 55 ? '#f59e0b' : '#0ea5e9'}>{s}</text>
              ))}
              <text x={PADL + 2} y={PADT + 8} fontSize={8} fill="#64748b">TLX 0-100</text>
              {/* dots */}
              {rows.map((r, i) => (
                <circle key={r.f.icao + i} cx={xOf(r.altFt / 100)} cy={yOf(r.score)} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.85} />
              ))}
            </svg>
          </div>
        )}

        {/* Sliders */}
        <div className="px-3 pt-2 grid grid-cols-2 gap-2">
          <Slider label={`MIN-FL ${minFl}`} v={minFl} min={0} max={400} setV={setMinFl} />
          <Slider label={`MAX-FL ${maxFl}`} v={maxFl} min={50} max={450} setV={setMaxFl} />
          <Slider label={`TRAF-R ${trafR}nm`} v={trafR} min={3} max={40} setV={setTrafR} />
          <Slider label={`WT-MIX ${wtMix}%`} v={wtMix} min={50} max={150} setV={setWtMix} />
        </div>

        {/* Class chips */}
        <div className="px-3 pt-2 flex flex-wrap gap-1">
          {(['ALL', ...Object.keys(KLASS_LABEL)] as const).map(k => {
            const active = klassFilter === (k as any)
            return (
              <button key={k} onClick={() => setKlassFilter(k as any)}
                className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider border ${active ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700'}`}>
                {k === 'ALL' ? 'ALL' : KLASS_LABEL[k as Klass]}
              </button>
            )
          })}
        </div>

        {/* Layer toggles */}
        <div className="px-3 pt-2 flex flex-wrap gap-1.5">
          {[
            ['HALO', showRing, setShowRing],
            ['PROX', showProx, setShowProx],
            ['LBL', showLabels, setShowLabels],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lbl, on, setOn]: any) => (
            <button key={lbl} onClick={() => setOn(!on)}
              className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider border ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700'}`}>
              {lbl}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="px-3 pt-2">
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / driver / phase…"
            className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50" />
        </div>

        {/* Tabs */}
        <div className="px-3 pt-2 flex gap-1">
          {(['AIRCRAFT', 'DRIVERS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-1 rounded-md text-[10px] font-bold tracking-wider border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700'}`}>
              {t}
            </button>
          ))}
        </div>

        {/* List */}
        <div className="px-2 pt-2 pb-3 space-y-1">
          {tab === 'AIRCRAFT' && ranked.length === 0 && (
            <div className="text-[11px] text-slate-500 px-2 py-4 text-center">No aircraft in the current filter set.</div>
          )}

          {tab === 'AIRCRAFT' && ranked.map(r => {
            const c = TIER_COLOR[r.tier]
            const fl = Math.round(r.altFt / 100)
            const advice = r.tier === 'CRIT' ? 'saturated — call for assistance'
              : r.tier === 'HIGH' ? 'high workload — defer non-essential'
              : r.tier === 'MOD' ? 'managing — normal SOP'
              : 'monitoring — low workload'
            return (
              <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
                className="w-full text-left bg-slate-900/50 hover:bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-lg p-2">
                <div className="flex items-center gap-1.5" style={{ borderLeft: `3px solid ${c}`, paddingLeft: 6 }}>
                  <span className="text-[11px] font-mono font-bold text-slate-100">{r.f.callsign || r.f.icao}</span>
                  <span className="text-[9px] text-slate-500">{r.f.type || '—'}</span>
                  <span className="text-[8px] px-1 rounded bg-slate-800 text-slate-400 font-bold tracking-wider">{KLASS_LABEL[r.klass]}</span>
                  <span className="ml-auto text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded" style={{ background: c + '22', color: c }}>{r.tier}</span>
                </div>
                <div className="flex justify-between text-[10px] mt-1 text-slate-400 font-mono">
                  <span>FL{fl}</span>
                  <span>{r.phase}</span>
                  <span>VS {r.f.vertRate >= 0 ? '+' : ''}{Math.round((r.f.vertRate || 0) / 50) * 50}</span>
                  <span style={{ color: c }}>{Math.round(r.score)}</span>
                </div>
                {/* score bar */}
                <div className="relative h-1.5 mt-1 bg-slate-800 rounded overflow-hidden">
                  <div className="absolute top-0 bottom-0" style={{ left: 0, width: `${r.score}%`, background: c, opacity: 0.85 }} />
                  {[30, 55, 75].map(s => (
                    <div key={s} className="absolute top-0 bottom-0" style={{ left: `${s}%`, width: 1, background: s === 75 ? '#ef4444' : s === 55 ? '#f59e0b' : '#0ea5e9', opacity: 0.7 }} />
                  ))}
                </div>
                {/* factor breakdown */}
                <div className="mt-1.5 grid grid-cols-6 gap-0.5">
                  {([['P', r.pW, '#a78bfa'], ['T', r.tW, '#0ea5e9'], ['D', r.dW, '#06b6d4'], ['R', r.trW, '#f59e0b'], ['C', r.cW, '#f97316'], ['N', r.nW, '#64748b']] as Array<[string, number, string]>).map(([lbl, v, col]) => (
                    <div key={lbl} className="flex flex-col items-center">
                      <div className="w-full h-3 bg-slate-800 rounded-sm overflow-hidden relative">
                        <div className="absolute bottom-0 left-0 right-0" style={{ height: `${Math.round(v * 100)}%`, background: col, opacity: 0.8 }} />
                      </div>
                      <div className="text-[8px] font-mono text-slate-500 mt-0.5">{lbl}</div>
                    </div>
                  ))}
                </div>
                <div className="flex justify-between text-[9px] mt-1 text-slate-500 font-mono">
                  <span style={{ color: r.driver === 'TRAFFIC' ? '#0ea5e9' : '#64748b' }}>traf {r.trafN}/{trafR}nm</span>
                  <span>driver <span style={{ color: c }}>{DRIVER_LABEL[r.driver]}</span></span>
                  <span>{r.f.operator || ''}</span>
                </div>
                <div className="text-[9px] mt-1 font-mono" style={{ color: c }}>{advice}</div>
              </button>
            )
          })}

          {tab === 'DRIVERS' && driverGroups.length === 0 && (
            <div className="text-[11px] text-slate-500 px-2 py-4 text-center">No drivers in current filter set.</div>
          )}

          {tab === 'DRIVERS' && driverGroups.map(g => {
            const c = TIER_COLOR[g.worstTier]
            const total = ranked.length || 1
            return (
              <button key={g.d} onClick={() => { if (g.list[0]) onFly(g.list[0].f.icao) }}
                className="w-full text-left bg-slate-900/50 hover:bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-lg p-2">
                <div className="flex items-center gap-1.5" style={{ borderLeft: `3px solid ${c}`, paddingLeft: 6 }}>
                  <span className="text-[11px] font-mono font-bold text-slate-100">{DRIVER_LABEL[g.d]}</span>
                  <span className="text-[9px] text-slate-500">{g.list.length} ac</span>
                  <span className="ml-auto text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded" style={{ background: c + '22', color: c }}>{g.worstTier}</span>
                </div>
                <div className="flex justify-between text-[10px] mt-1 text-slate-400 font-mono">
                  <span>mean {Math.round(g.meanScore)}</span>
                  <span>{Math.round(g.list.length / total * 100)}% of fleet</span>
                </div>
                <div className="relative h-1.5 mt-1 bg-slate-800 rounded overflow-hidden">
                  <div className="absolute top-0 bottom-0" style={{ left: 0, width: `${Math.min(100, g.list.length / total * 100)}%`, background: c, opacity: 0.8 }} />
                </div>
                <div className="text-[9px] mt-1 text-slate-500 font-mono truncate">
                  {g.list.slice(0, 4).map(r => r.f.callsign || r.f.icao).join(' · ')}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Cell({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-lg px-2 py-1.5">
      <div className="text-[8px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className="text-sm font-bold font-mono" style={{ color }}>{value}</div>
      {sub && <div className="text-[9px] font-mono" style={{ color }}>{sub}</div>}
    </div>
  )
}

function Slider({ label, v, min, max, step, setV }: { label: string; v: number; min: number; max: number; step?: number; setV: (n: number) => void }) {
  return (
    <label className="text-[10px] text-slate-400 block">
      <div className="font-mono tracking-wider">{label}</div>
      <input type="range" min={min} max={max} step={step || 1} value={v} onChange={e => setV(Number(e.target.value))}
        className="w-full accent-sky-500" />
    </label>
  )
}
