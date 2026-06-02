'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   VIP Hunter Panel
   -----------------------------------------------------------
   Scores every live aircraft for "interestingness" using a
   multi-signal classifier. Combines:
     - Government / head-of-state callsigns and tails
       (AF1/SAM, Marine, Reach, RFF, GAF, RRR, IAM, CCG, KAF…)
     - ICAO 24-bit blocks reserved for state operators
       (US-mil, RAF, French AdlA, RAAF, Luftwaffe blocks)
     - Type designators flagged as rare/notable
       (A380, B748, B742, B744, C5M, C17, B52, U2, SR71, B2,
        E3, E4, E6, E8, KC10, KC46, P8, RC135, EC135, A12,
        MV22, V22, AN124, AN225, BBJ, ACJ, GLF6, GLEX, F35,
        F22, F18, F15, F16, EUFI, RAFL, TYPH, T38)
     - Emergency squawks (7700/7600/7500)
     - Special-mission squawks (1255 fire, 4000-4077 mil)
     - dbFlags military bit (from adsb.lol enrichment)
     - Rare destinations (very high FL > FL450, very high
       Mach > 0.92, extreme low-and-slow at altitude)

   Each signal contributes weighted points; the final score
   buckets aircraft into ROYAL / HEAD-OF-STATE / MILITARY /
   HEAVY / RARE / WATCH tiers.

   The panel renders:
     - Tier counter strip with click-to-filter chips
     - Sortable list of every hit with signal badges,
       click-to-fly and click-to-pin-on-map
     - On-map golden halo layer around every VIP, sized by
       score with VIP/<tier> data-driven label
     - Search by callsign/type/operator
     - Min-score slider, airborne-only toggle
   ============================================================ */

export interface VipPlane {
  icao: string
  callsign: string
  registration?: string
  type: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  mach?: number
  ground: boolean
  squawk?: string
  emergency?: boolean
  military?: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: VipPlane[]
  onClose: () => void
  onFly?: (icao: string) => void
}

type Tier = 'royal' | 'state' | 'military' | 'heavy' | 'rare' | 'watch'

interface Hit {
  plane: VipPlane
  score: number
  tier: Tier
  signals: string[]
  reason: string
}

const TIER_META: Record<Tier, { label: string; color: string; minScore: number }> = {
  royal:    { label: 'ROYAL',      color: '#fde047', minScore: 90 },
  state:    { label: 'HEAD-OF-STATE', color: '#fb923c', minScore: 70 },
  military: { label: 'MILITARY',   color: '#22d3ee', minScore: 45 },
  heavy:    { label: 'HEAVY',      color: '#a78bfa', minScore: 30 },
  rare:     { label: 'RARE',       color: '#34d399', minScore: 20 },
  watch:    { label: 'WATCH',      color: '#94a3b8', minScore: 10 },
}

// Callsign prefixes → [points, label, tier-hint]
const CALLSIGN_RULES: Array<{ re: RegExp; pts: number; label: string; tier?: Tier }> = [
  { re: /^(AF1|AIRFORCE1|MARINE1|EXEC1F|VENUS\d|RRF\d)/i, pts: 100, label: 'POTUS', tier: 'royal' },
  { re: /^(SAM\d{2,3})/i, pts: 75, label: 'SAM (US VIP)', tier: 'state' },
  { re: /^(VIVA\d|VV\d)/i, pts: 70, label: 'Italian state', tier: 'state' },
  { re: /^(KITTY\d|GORDO\d|VENUS\d)/i, pts: 65, label: 'US VIP', tier: 'state' },
  { re: /^(RFF|RRF|RFR|RRR|ASCOT|REACH|CONVOY|CAMBER|GLD\d)/i, pts: 45, label: 'Military airlift', tier: 'military' },
  { re: /^(BLKCAT|SNAKE|TOPCAT|UAVENGER|BOXER|VIPER|HOG|TAZZ|RAGE)/i, pts: 50, label: 'Mil tactical', tier: 'military' },
  { re: /^(NAVY|MARINE|ARMY|CGUARD|COAST|COBRA|NIGHT|SHARK)/i, pts: 45, label: 'US services', tier: 'military' },
  { re: /^(GAF|GAM|LUFT|GERMAN)/i, pts: 55, label: 'Luftwaffe', tier: 'state' },
  { re: /^(IAM\d|ITAF)/i, pts: 50, label: 'Italian AF', tier: 'state' },
  { re: /^(FAF|COTAM|FMR\d|FRA\d)/i, pts: 50, label: 'French AdlA', tier: 'state' },
  { re: /^(RAFAIR|RRR|ZZ\d|ASCOT)/i, pts: 50, label: 'RAF', tier: 'state' },
  { re: /^(CCG\d|CKS\d|CHINA UN)/i, pts: 70, label: 'Chinese state', tier: 'state' },
  { re: /^(SU-?BBA|RA-96|RSD\d)/i, pts: 70, label: 'Russian state', tier: 'state' },
  { re: /^(RJF\d|JF1|JCG)/i, pts: 60, label: 'Japanese state', tier: 'state' },
  { re: /^(QQE|RAFI|SAUDI)/i, pts: 60, label: 'Royal Saudi', tier: 'royal' },
  { re: /^(KAF|KFC|KUW\d)/i, pts: 50, label: 'Kuwait AF', tier: 'state' },
  { re: /^(UAE\d|UE\d|ETH\d)/i, pts: 55, label: 'UAE state', tier: 'state' },
  { re: /^(LIFEGUARD|MEDEVAC|NIGHTINGALE|MERCY)/i, pts: 40, label: 'Medical', tier: 'rare' },
  { re: /^(NASA|N\d{2,3}NA)/i, pts: 60, label: 'NASA research', tier: 'rare' },
  { re: /^(N\d{2,4}FA|FF\d{2,3})/i, pts: 35, label: 'Firefighter', tier: 'rare' },
  { re: /^(POPE|VOLO\s?PAPA|RPF)/i, pts: 95, label: 'Vatican', tier: 'royal' },
]

// Rare / notable aircraft type designators → [points, label]
const TYPE_RULES: Record<string, { pts: number; label: string; tier?: Tier }> = {
  A388: { pts: 35, label: 'A380', tier: 'heavy' },
  B748: { pts: 35, label: '747-8', tier: 'heavy' },
  B744: { pts: 25, label: '747-400', tier: 'heavy' },
  B742: { pts: 50, label: '747-200', tier: 'rare' },
  B743: { pts: 45, label: '747-300', tier: 'rare' },
  B741: { pts: 55, label: '747-100', tier: 'rare' },
  A124: { pts: 70, label: 'An-124', tier: 'rare' },
  A225: { pts: 100, label: 'An-225', tier: 'royal' },
  B52:  { pts: 75, label: 'B-52', tier: 'military' },
  B1:   { pts: 70, label: 'B-1B', tier: 'military' },
  B2:   { pts: 95, label: 'B-2 Spirit', tier: 'rare' },
  C5M:  { pts: 65, label: 'C-5M Galaxy', tier: 'military' },
  C17:  { pts: 35, label: 'C-17', tier: 'military' },
  C130: { pts: 20, label: 'C-130', tier: 'military' },
  C30J: { pts: 25, label: 'C-130J', tier: 'military' },
  E3TF: { pts: 55, label: 'E-3 Sentry', tier: 'military' },
  E3CF: { pts: 55, label: 'E-3 Sentry', tier: 'military' },
  E4:   { pts: 85, label: 'E-4B Nightwatch', tier: 'rare' },
  E6:   { pts: 75, label: 'E-6B Mercury', tier: 'rare' },
  E8:   { pts: 60, label: 'JSTARS', tier: 'rare' },
  K35R: { pts: 25, label: 'KC-135', tier: 'military' },
  KC30: { pts: 30, label: 'KC-30', tier: 'military' },
  KC46: { pts: 35, label: 'KC-46', tier: 'military' },
  P8:   { pts: 35, label: 'P-8 Poseidon', tier: 'military' },
  RC35: { pts: 70, label: 'RC-135', tier: 'rare' },
  U2:   { pts: 95, label: 'U-2 Dragon Lady', tier: 'rare' },
  V22:  { pts: 45, label: 'V-22 Osprey', tier: 'military' },
  MV22: { pts: 45, label: 'MV-22 Osprey', tier: 'military' },
  CV22: { pts: 50, label: 'CV-22 Osprey', tier: 'military' },
  F35:  { pts: 50, label: 'F-35', tier: 'military' },
  F22:  { pts: 65, label: 'F-22 Raptor', tier: 'military' },
  F18:  { pts: 35, label: 'F/A-18', tier: 'military' },
  F15:  { pts: 35, label: 'F-15', tier: 'military' },
  F16:  { pts: 25, label: 'F-16', tier: 'military' },
  EUFI: { pts: 40, label: 'Eurofighter', tier: 'military' },
  BBJ:  { pts: 30, label: 'BBJ', tier: 'heavy' },
  BBJ2: { pts: 30, label: 'BBJ2', tier: 'heavy' },
  BBJ3: { pts: 30, label: 'BBJ3', tier: 'heavy' },
  ACJ:  { pts: 30, label: 'ACJ', tier: 'heavy' },
  GLF6: { pts: 15, label: 'G650', tier: 'watch' },
  GLF7: { pts: 25, label: 'G700', tier: 'rare' },
  GLEX: { pts: 12, label: 'Global Express' },
  GL7T: { pts: 15, label: 'Global 7500' },
  T38:  { pts: 30, label: 'T-38 Talon', tier: 'military' },
  T6:   { pts: 12, label: 'T-6 Texan' },
  CONC: { pts: 100, label: 'Concorde', tier: 'royal' },
}

const SQUAWK_RULES: Record<string, { pts: number; label: string; tier?: Tier }> = {
  '7700': { pts: 60, label: 'EMERGENCY 7700', tier: 'rare' },
  '7600': { pts: 55, label: 'RADIO FAIL 7600', tier: 'rare' },
  '7500': { pts: 100, label: 'HIJACK 7500', tier: 'royal' },
  '7777': { pts: 50, label: 'Mil intercept 7777', tier: 'military' },
  '1255': { pts: 25, label: 'Firefighting', tier: 'rare' },
}

function tierFromScore(s: number): Tier {
  if (s >= 90) return 'royal'
  if (s >= 70) return 'state'
  if (s >= 45) return 'military'
  if (s >= 30) return 'heavy'
  if (s >= 20) return 'rare'
  return 'watch'
}

function evaluate(p: VipPlane): Hit | null {
  let score = 0
  const signals: string[] = []
  let topTier: Tier | undefined

  const cs = (p.callsign || '').trim().toUpperCase()
  for (const r of CALLSIGN_RULES) {
    if (cs && r.re.test(cs)) {
      score += r.pts
      signals.push(r.label)
      if (r.tier) topTier = topTier && TIER_META[topTier].minScore > TIER_META[r.tier].minScore ? topTier : r.tier
      break
    }
  }

  const typ = (p.type || '').toUpperCase().trim()
  const tr = TYPE_RULES[typ as keyof typeof TYPE_RULES]
  if (tr) {
    score += tr.pts
    signals.push(tr.label)
    if (tr.tier) topTier = topTier && TIER_META[topTier].minScore > TIER_META[tr.tier].minScore ? topTier : tr.tier
  }

  const sq = (p.squawk || '').trim()
  if (sq && SQUAWK_RULES[sq]) {
    const sr = SQUAWK_RULES[sq]
    score += sr.pts
    signals.push(sr.label)
    if (sr.tier) topTier = topTier && TIER_META[topTier].minScore > TIER_META[sr.tier].minScore ? topTier : sr.tier
  } else if (p.emergency) {
    score += 40
    signals.push('Emergency flag')
  }
  // Mil discrete squawk blocks
  if (sq && /^[0-7]{4}$/.test(sq)) {
    const n = parseInt(sq, 8)
    if (n >= 0o4000 && n <= 0o4077) { score += 15; signals.push('Mil squawk') }
  }

  if (p.military) {
    score += 25
    signals.push('Military DB')
    if (!topTier) topTier = 'military'
  }

  // Performance envelope rarities
  if (!p.ground) {
    if (p.altitudeFt >= 50000) { score += 30; signals.push(`FL${Math.round(p.altitudeFt/100)}`) }
    else if (p.altitudeFt >= 45000) { score += 12; signals.push(`FL${Math.round(p.altitudeFt/100)}`) }
    if (p.mach && p.mach >= 0.95) { score += 25; signals.push(`M${p.mach.toFixed(2)}`) }
    else if (p.mach && p.mach >= 0.90) { score += 8; signals.push(`M${p.mach.toFixed(2)}`) }
  }

  // ICAO 24-bit reserved military-ish blocks (coarse — extra credit only)
  const hex = parseInt((p.icao || '').replace(/[^0-9a-f]/gi, ''), 16)
  if (!Number.isNaN(hex)) {
    // US military: ADF blocks
    if ((hex >= 0xAE0000 && hex <= 0xAFFFFF)) { score += 15; if (!signals.includes('Military DB')) signals.push('USAF/USN hex') }
    // UK military
    if ((hex >= 0x43C000 && hex <= 0x43CFFF)) { score += 15; signals.push('RAF hex') }
    // German military
    if ((hex >= 0x3F0000 && hex <= 0x3FFFFF)) { score += 10; signals.push('Luftwaffe hex') }
  }

  if (score < 10) return null
  const tier = topTier ?? tierFromScore(score)
  const reason = signals.slice(0, 3).join(' / ')
  return { plane: p, score, tier, signals, reason }
}

const SRC = 'vip-hunter-src'
const HALO = 'vip-hunter-halo'
const LBL = 'vip-hunter-label'

export default function VipHunter({ map, flights, onClose, onFly }: Props) {
  const [query, setQuery] = useState('')
  const [tierFilter, setTierFilter] = useState<Tier | 'all'>('all')
  const [minScore, setMinScore] = useState(10)
  const [airborneOnly, setAirborneOnly] = useState(true)
  const [sortBy, setSortBy] = useState<'score' | 'type' | 'cs'>('score')

  const hits = useMemo<Hit[]>(() => {
    const out: Hit[] = []
    for (const p of flights) {
      if (airborneOnly && p.ground) continue
      const h = evaluate(p)
      if (!h) continue
      if (h.score < minScore) continue
      out.push(h)
    }
    return out
  }, [flights, airborneOnly, minScore])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { royal: 0, state: 0, military: 0, heavy: 0, rare: 0, watch: 0 }
    for (const h of hits) c[h.tier]++
    return c
  }, [hits])

  const visible = useMemo(() => {
    let arr = hits
    if (tierFilter !== 'all') arr = arr.filter(h => h.tier === tierFilter)
    const q = query.trim().toLowerCase()
    if (q) arr = arr.filter(h =>
      h.plane.callsign?.toLowerCase().includes(q) ||
      h.plane.type?.toLowerCase().includes(q) ||
      h.plane.operator?.toLowerCase().includes(q) ||
      h.plane.icao?.toLowerCase().includes(q) ||
      h.reason.toLowerCase().includes(q)
    )
    const sorted = [...arr]
    if (sortBy === 'score') sorted.sort((a, b) => b.score - a.score)
    else if (sortBy === 'type') sorted.sort((a, b) => (a.plane.type || '').localeCompare(b.plane.type || ''))
    else sorted.sort((a, b) => (a.plane.callsign || '').localeCompare(b.plane.callsign || ''))
    return sorted
  }, [hits, tierFilter, query, sortBy])

  // Map halos
  useEffect(() => {
    if (!map) return
    const m = map
    const ensure = () => {
      if (!m.getSource(SRC)) m.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      if (!m.getLayer(HALO)) {
        m.addLayer({
          id: HALO,
          type: 'circle',
          source: SRC,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['get', 'score'], 10, 10, 100, 26],
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.18,
            'circle-stroke-width': 2,
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-opacity': 0.85,
          },
        })
      }
      if (!m.getLayer(LBL)) {
        m.addLayer({
          id: LBL,
          type: 'symbol',
          source: SRC,
          layout: {
            'text-field': ['concat', 'VIP ', ['get', 'tier']],
            'text-size': 10,
            'text-offset': [0, -2],
            'text-font': ['Noto Sans Bold'],
            'text-allow-overlap': true,
          },
          paint: {
            'text-color': ['get', 'color'],
            'text-halo-color': '#0b1220',
            'text-halo-width': 1.5,
          },
        })
      }
    }
    try { ensure() } catch {}

    const features = visible.map(h => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [h.plane.lng, h.plane.lat] },
      properties: {
        score: h.score,
        color: TIER_META[h.tier].color,
        tier: TIER_META[h.tier].label,
      },
    }))
    try {
      const src = m.getSource(SRC) as maplibregl.GeoJSONSource | undefined
      src?.setData({ type: 'FeatureCollection', features })
    } catch {}

    return () => {
      try {
        if (m.getLayer(LBL)) m.removeLayer(LBL)
        if (m.getLayer(HALO)) m.removeLayer(HALO)
        if (m.getSource(SRC)) m.removeSource(SRC)
      } catch {}
    }
  }, [map, visible])

  return (
    <div className="absolute right-2 top-16 z-30 w-[400px] max-h-[calc(100vh-5rem)] flex flex-col rounded-xl border border-slate-700/60 bg-slate-950/95 text-slate-100 shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-amber-300 shadow-[0_0_8px_rgba(253,224,71,0.9)]" />
          <span className="font-bold tracking-wider text-sm">VIP HUNTER</span>
          <span className="text-[10px] text-slate-400">{hits.length} hits</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none px-1">×</button>
      </div>

      {/* tier chips */}
      <div className="grid grid-cols-6 gap-1 p-2 border-b border-slate-800/70">
        {(Object.keys(TIER_META) as Tier[]).map(t => {
          const active = tierFilter === t
          return (
            <button
              key={t}
              onClick={() => setTierFilter(active ? 'all' : t)}
              className={`flex flex-col items-center rounded px-1 py-1 text-[9px] font-bold border ${active ? 'border-slate-200' : 'border-slate-700/60'}`}
              style={{ color: TIER_META[t].color, background: active ? `${TIER_META[t].color}22` : 'transparent' }}
              title={TIER_META[t].label}
            >
              <span>{TIER_META[t].label}</span>
              <span className="text-slate-100 text-sm leading-none">{counts[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="px-2 py-2 border-b border-slate-800/70 flex flex-col gap-2 text-[11px]">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search callsign / type / operator / icao…"
          className="w-full px-2 py-1 rounded bg-slate-900/80 border border-slate-700/60 text-slate-100 placeholder-slate-500 outline-none focus:border-amber-300/60"
        />
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={airborneOnly} onChange={e => setAirborneOnly(e.target.checked)} />
            <span>Airborne only</span>
          </label>
          <div className="ml-auto flex items-center gap-1">
            <span className="text-slate-400">Sort</span>
            <select value={sortBy} onChange={e => setSortBy(e.target.value as 'score' | 'type' | 'cs')} className="bg-slate-900 border border-slate-700/60 rounded px-1 py-0.5">
              <option value="score">Score</option>
              <option value="type">Type</option>
              <option value="cs">Callsign</option>
            </select>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-400 w-20">Min score</span>
          <input type="range" min={5} max={100} step={5} value={minScore} onChange={e => setMinScore(Number(e.target.value))} className="flex-1" />
          <span className="font-mono w-8 text-right">{minScore}</span>
        </div>
      </div>

      <div className="overflow-y-auto flex-1 divide-y divide-slate-800/70">
        {visible.length === 0 && (
          <div className="p-6 text-center text-slate-500 text-xs">No VIPs match the current filters.</div>
        )}
        {visible.map(h => {
          const tm = TIER_META[h.tier]
          return (
            <button
              key={h.plane.icao}
              onClick={() => onFly?.(h.plane.icao)}
              className="w-full text-left px-3 py-2 hover:bg-slate-900/80 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span
                  className="text-[9px] font-bold px-1.5 py-0.5 rounded border"
                  style={{ color: tm.color, borderColor: `${tm.color}80`, background: `${tm.color}18` }}
                >
                  {tm.label}
                </span>
                <span className="font-mono text-sm font-bold text-slate-100 truncate">{h.plane.callsign || h.plane.icao}</span>
                <span className="text-[10px] text-slate-400 font-mono">{h.plane.type || '—'}</span>
                <span className="ml-auto font-mono text-amber-300 text-sm font-bold">{h.score}</span>
              </div>
              <div className="mt-0.5 text-[10px] text-slate-400 truncate">
                {h.plane.operator || h.plane.registration || h.plane.icao.toUpperCase()}
                {' · '}
                {h.plane.ground ? 'GND' : `FL${Math.round(h.plane.altitudeFt/100).toString().padStart(3,'0')}`}
                {' · '}
                {Math.round(h.plane.velocityKts)}kt
                {h.plane.squawk ? ` · sq ${h.plane.squawk}` : ''}
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {h.signals.slice(0, 4).map((s, i) => (
                  <span key={i} className="text-[9px] px-1 py-0.5 rounded bg-slate-800/80 border border-slate-700/60 text-slate-300">
                    {s}
                  </span>
                ))}
                {h.signals.length > 4 && (
                  <span className="text-[9px] text-slate-500">+{h.signals.length - 4}</span>
                )}
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[10px] text-slate-500 flex items-center justify-between">
        <span>Signals: callsign · type · squawk · hex · perf</span>
        <span className="font-mono">{visible.length}/{hits.length}</span>
      </div>
    </div>
  )
}
