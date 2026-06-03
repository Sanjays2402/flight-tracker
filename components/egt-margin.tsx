'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   EGT Margin Monitor
   -----------------------------------------------------------
   FAA AC 33.4-3 · EASA CS-E 740 · ICAO Annex 8 Part IIIB ·
   IATA IOSA MNT 3.2.5 · CFM/PW/RR/GE OEM Engine Trend Monitoring.
   For every airborne aircraft we synthesise per-engine on-wing
   condition by combining the live thrust setting (derived from
   phase of flight and climb energy) with a hash-stable engine
   serial-number wear curve and the ambient ISA deviation aloft,
   then score the remaining Exhaust Gas Temperature margin to
   the EGT Red Line (EGT-RL) certified for that engine class.

   Engine class catalogue (OEM TCDS · EGT-RL @ takeoff):
     hi-bypass    HBP   CFM56 / PW2000 / V2500    945 C   28k-thrust class
     ge-genx      GEX   GE GEnx-1B / -2B / Trent  1060 C  whisper-class HBPR
     pw-pratt     GTF   PW1100/1500/1900 GTF      955 C   geared turbofan
     rr-trent     TXX   Trent 700/900/1000/XWB    900 C   3-shaft
     cf6-class    CF6   CF6-80E / PW4000-94       960 C   legacy HBPR
     small-tfan   STF   AE3007 / TFE731 / HTF7000 855 C   biz/regional
     turboprop    TPP   PW100 / PT6 / TPE331      790 C   ITT proxy
     small-piston PST   Lycoming / Continental    260 C   CHT proxy
     mil-low      MIL   F100/F110/F404 dry        875 C   afterburner

   Per-engine model (each aircraft carries N=class engines):
     EGT_RL_C        red-line ºC per class (see catalogue)
     wear_h          on-wing hours since CSV/SOH 0 - 28000
                     deterministic FNV-1a hash of ICAO24 + engine#
     wear_C          ageing deg C = (wear_h / 1000) * AGE-SLOPE
                     OEM trend rate slider 1.5-4.5 C / 1000h
     phase_C         phase-of-flight thermal load
                     APPR + GROUND: idle  EGT_RL * 0.45
                     CRUISE:        crz   EGT_RL * 0.74
                     CLIMB:         clb   EGT_RL * 0.86
                     TAKEOFF prox:  to    EGT_RL * 0.94 (below FL050 + VS>2200)
     isa_dC          ISA deviation aloft scaled by ISA-DEV slider -30..+30C
                     +1C ISA-dev rises EGT by ~ISA-SCALE 1.0-3.0 deg C/C
     derate_dC       hash-stable per-airframe FLEX/derate USED for take-off
                     0/2/5/10/15/20% derate giving -10/-25/-50/-72 C relief
                     (overridable by DERATE-MIN slider 0-25% minimum policy)
     egt_C           = phase_C + wear_C + isa_dC*isa_scale - derate_dC
     margin_C        = EGT_RL - egt_C    (positive = healthy)
   Composite aircraft score = max(per-engine 0-100 severity) where
     severity = clip( (MARG-WARN - margin_C) / MARG-WARN * 100, 0, 100 )
   and aircraftMinMargin = min over engines.

   Tier classification per aircraft:
     RL-BUST any engine margin <= 0      rose    EGT red-line exceeded · land asap
     LOW     any engine margin <= 25     amber   margin low · trend monitor next-flt
     WATCH   any engine margin <= 60     sky     within trend baseline · log peak
     OK      all engines margin > 60     emerald healthy on-wing
     IDLE    on ground or below MIN-FL   slate   excluded

   MapLibre overlay (registered in Layers > Analysis):
     - Tier-coloured halo rings sized by score 8-22 px
     - Tier-coloured callsign + minMargin labels for LOW/RL-BUST
     - Rose diamond marker over RL-BUST aircraft
     - Sky dashed great-circle projection 200nm forward-track
       for RL-BUST + LOW so dispatcher sees where degraded engine
       is heading (handy for divert planning)

   Side panel:
     - 5-tier counter strip click-to-filter
     - 3-cell MEAN-MARG / WORST callsign+margin / RL-BUST-COUNT
     - 2-cell MEAN-WEAR-h / MEAN-DERATE-% secondary row
     - SVG margin-vs-FL scatter with 0/25/60 rose/amber/sky bands
       shaded + dashed threshold lines + every aircraft plotted
     - 5 sliders MIN-FL / MAX-FL / AGE-SLOPE / ISA-DEV / DERATE-MIN
       in 2-col grid + ISA-SCALE full-width
     - 9-class chip filter (engine families)
     - HALO / LBL / PIN / PROJ / DIAG toggles + search
     - AIRCRAFT / ENGINES tab switcher
     - AIRCRAFT tab tier-worst-first then minMargin asc with tier
       color stripe + callsign+type+engine-pill+tier-pill + FL /
       phase / wear-h / minMargin-C line + tier-coloured margin
       bar 0..EGT_RL with 0/25/60 ticks + per-engine cells row
       showing each engine margin as tier-coloured pill + advice
     - ENGINES tab grouped by engine family sorted by worst-tier
       then ac-count desc + family-pill + ac-count + worst-tier
       + mean-margin progress + worst-callsign + tier-coloured
       advice click-to-fly to worst aircraft on family

   Persisted: ft-egt
   ============================================================ */

export interface EgtFlight {
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
  flights: EgtFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'WATCH' | 'LOW' | 'RL-BUST' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  OK: '#10b981',
  WATCH: '#0ea5e9',
  LOW: '#f59e0b',
  'RL-BUST': '#ef4444',
  IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['RL-BUST', 'LOW', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { 'RL-BUST': 0, LOW: 1, WATCH: 2, OK: 3, IDLE: 4 }

type EngFam = 'HBP' | 'GEX' | 'GTF' | 'TXX' | 'CF6' | 'STF' | 'TPP' | 'PST' | 'MIL'
const FAM_LABEL: Record<EngFam, string> = {
  HBP: 'HBP', GEX: 'GEX', GTF: 'GTF', TXX: 'TXX', CF6: 'CF6', STF: 'STF', TPP: 'TPP', PST: 'PST', MIL: 'MIL',
}
const FAM_NAME: Record<EngFam, string> = {
  HBP: 'High-bypass turbofan (CFM56 / PW2000 / V2500)',
  GEX: 'GEnx / Trent 1000 / Trent XWB whisper class',
  GTF: 'Geared turbofan PW1000 series',
  TXX: 'Rolls-Royce Trent 3-shaft',
  CF6: 'CF6-80E / PW4000 legacy high-bypass',
  STF: 'Small turbofan AE3007 / TFE731 / HTF7000',
  TPP: 'Turboprop PW100 / PT6 / TPE331 (ITT)',
  PST: 'Piston small (CHT)',
  MIL: 'Military low-bypass dry rating',
}
const FAM_RL: Record<EngFam, number> = {
  HBP: 945, GEX: 1060, GTF: 955, TXX: 900, CF6: 960, STF: 855, TPP: 790, PST: 260, MIL: 875,
}
const FAM_ECOUNT: Record<EngFam, number> = {
  HBP: 2, GEX: 2, GTF: 2, TXX: 2, CF6: 2, STF: 2, TPP: 2, PST: 1, MIL: 1,
}

function classifyEngine(t: string | undefined, cat?: string): EngFam {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || /^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139)/.test(x)) return 'PST'
  if (/^(B78|A35|A33|A34|MD11|IL96|A30)/.test(x)) return 'GEX'
  if (/^(A38|B74|B77|C5|C17|B76)/.test(x)) return 'CF6'
  if (/^(A22[01]|A31[89]NEO|A32[01]NEO|BCS|CS1|CS3)/.test(x)) return 'GTF'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|E19|E29|CRJ9)/.test(x)) return 'HBP'
  if (/^(A330|A340|A350|B787|B777)/.test(x)) return 'TXX'
  if (/^(CRJ|E14|E15|E17|E70|E75)/.test(x)) return 'STF'
  if (/^(AT4|AT5|AT7|DH8|SF34|J32|J41|ATR|TBM|PC12|TB|PC6|DHC2|DHC6|AN2|BE9|BE3)/.test(x)) return 'TPP'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'STF'
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS)/.test(x)) return 'MIL'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|C20)/.test(x)) return 'PST'
  return 'HBP'
}

type Phase = 'TAKEOFF' | 'CLIMB' | 'CRUISE' | 'DESCENT' | 'APPR'
const PHASE_LABEL: Record<Phase, string> = { TAKEOFF: 'TO', CLIMB: 'CLB', CRUISE: 'CRZ', DESCENT: 'DES', APPR: 'APP' }
const PHASE_MUL: Record<Phase, number> = { TAKEOFF: 0.94, CLIMB: 0.86, CRUISE: 0.74, DESCENT: 0.55, APPR: 0.45 }
function inferPhase(altFt: number, vsFpm: number): Phase {
  if (altFt < 5000 && vsFpm > 2200) return 'TAKEOFF'
  if (altFt < 8000) return 'APPR'
  if (vsFpm > 600) return 'CLIMB'
  if (vsFpm < -600) return 'DESCENT'
  if (altFt < 18000 && vsFpm < -200) return 'DESCENT'
  return 'CRUISE'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h >>> 0
}

// Derate ladder (% reduction from full thrust → EGT relief in C)
const DERATE_TABLE: Array<{ pct: number; reliefC: number }> = [
  { pct: 0,  reliefC: 0 },
  { pct: 2,  reliefC: 10 },
  { pct: 5,  reliefC: 25 },
  { pct: 10, reliefC: 50 },
  { pct: 15, reliefC: 65 },
  { pct: 20, reliefC: 72 },
  { pct: 25, reliefC: 80 },
]
function pickDerate(h: number, minPct: number): { pct: number; reliefC: number } {
  // Use hash to pick a stable derate bucket per airframe, clamped to >= minPct
  const idx = h % DERATE_TABLE.length
  const pick = DERATE_TABLE[idx]
  if (pick.pct >= minPct) return pick
  // Walk up the ladder
  for (const d of DERATE_TABLE) if (d.pct >= minPct) return d
  return DERATE_TABLE[DERATE_TABLE.length - 1]
}

interface EngineState {
  i: number          // engine index 1..N
  wearH: number      // on-wing hours
  ageC: number       // ageing degrees C
  isaC: number       // C added by ambient
  deratePct: number
  reliefC: number
  egtC: number
  marginC: number
  tier: Tier
}

interface Row {
  f: EgtFlight
  fam: EngFam
  rlC: number
  ecount: number
  flCur: number
  phase: Phase
  phaseC: number
  engines: EngineState[]
  minMargin: number
  maxSeverity: number
  meanWearH: number
  meanDeratePct: number
  tier: Tier
}

function tierOfMargin(margin: number, warnC: number): Tier {
  if (margin <= 0) return 'RL-BUST'
  if (margin <= 25) return 'LOW'
  if (margin <= warnC) return 'WATCH'
  return 'OK'
}

function projectPosition(lat: number, lng: number, trackDeg: number, distNm: number): { lat: number; lng: number } {
  const R = 3440.065
  const δ = distNm / R
  const θ = (trackDeg * Math.PI) / 180
  const φ1 = (lat * Math.PI) / 180
  const λ1 = (lng * Math.PI) / 180
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return { lat: (φ2 * 180) / Math.PI, lng: (((λ2 * 180) / Math.PI + 540) % 360) - 180 }
}

const SRC_HALO = 'egt-halo', SRC_LBL = 'egt-lbl', SRC_PIN = 'egt-pin', SRC_PROJ = 'egt-proj'
const LYR_HALO = 'egt-halo-l', LYR_LBL = 'egt-lbl-l', LYR_PIN = 'egt-pin-l', LYR_PROJ = 'egt-proj-l'

export default function EgtMargin({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'ENGINES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [famFilter, setFamFilter] = useState<EngFam | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [maxFl, setMaxFl] = useState(450)
  const [ageSlope, setAgeSlope] = useState(28)        // 10ths-C per 1000h → 2.8 C/1000h
  const [isaDev, setIsaDev] = useState(0)             // -30..+30 C
  const [isaScale, setIsaScale] = useState(18)        // 10ths C-per-C-ISA → 1.8 C/C
  const [derateMin, setDerateMin] = useState(0)       // % minimum derate policy
  const [warnC, setWarnC] = useState(60)              // WATCH band edge
  const [showHalo, setShowHalo] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const ageK = ageSlope / 10        // C per 1000h
    const isaK = isaScale / 10        // C per C-ISA
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl || flCur > maxFl) continue
      const fam = classifyEngine(f.type, f.category)
      const rlC = FAM_RL[fam]
      const ecount = FAM_ECOUNT[fam]
      const phase = inferPhase(f.altitudeFt, f.vertRate || 0)
      const phaseC = rlC * PHASE_MUL[phase]

      const engines: EngineState[] = []
      let minMargin = Infinity, sumWear = 0, sumDeratePct = 0
      for (let i = 1; i <= ecount; i++) {
        const h = hash32((f.icao || '') + ':eng' + i)
        const wearH = (h % 28000)
        const ageC = (wearH / 1000) * ageK
        // ISA-dev with per-airframe noise +/-6 C
        const noise = ((h >>> 7) % 1200) / 100 - 6
        const isaCRaw = (isaDev + noise) * isaK
        const isaC = Math.max(-30, Math.min(80, isaCRaw))
        const der = pickDerate(h >>> 11, derateMin)
        const egtC = phaseC + ageC + isaC - der.reliefC
        const marginC = rlC - egtC
        const tier = tierOfMargin(marginC, warnC)
        engines.push({ i, wearH, ageC, isaC, deratePct: der.pct, reliefC: der.reliefC, egtC, marginC, tier })
        if (marginC < minMargin) minMargin = marginC
        sumWear += wearH; sumDeratePct += der.pct
      }
      const meanWearH = sumWear / ecount
      const meanDeratePct = sumDeratePct / ecount
      const maxSeverity = Math.max(0, Math.min(100, ((warnC - minMargin) / Math.max(1, warnC)) * 100))
      const tier = tierOfMargin(minMargin, warnC)
      out.push({ f, fam, rlC, ecount, flCur, phase, phaseC, engines, minMargin, maxSeverity, meanWearH, meanDeratePct, tier })
    }
    return out
  }, [flights, minFl, maxFl, ageSlope, isaDev, isaScale, derateMin, warnC])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OK: 0, WATCH: 0, LOW: 0, 'RL-BUST': 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let meanMarg = 0, worstMarg = Infinity, worstCs = '', rlBust = 0, sumWear = 0, sumDer = 0
    for (const r of rows) {
      meanMarg += r.minMargin
      sumWear += r.meanWearH
      sumDer += r.meanDeratePct
      if (r.tier === 'RL-BUST') rlBust++
      if (r.minMargin < worstMarg) {
        worstMarg = r.minMargin
        worstCs = (r.f.callsign || r.f.icao).trim()
      }
    }
    if (rows.length) { meanMarg /= rows.length; sumWear /= rows.length; sumDer /= rows.length }
    else { worstMarg = 0 }
    return { meanMarg, worstMarg, worstCs, rlBust, meanWearH: sumWear, meanDeratePct: sumDer, totalAc: rows.length }
  }, [rows])

  const famAggs = useMemo(() => {
    const m = new Map<EngFam, { fam: EngFam; count: number; sumMarg: number; worstMarg: number; worstCs: string; worstIcao: string; tier: Tier }>()
    for (const r of rows) {
      let a = m.get(r.fam)
      if (!a) { a = { fam: r.fam, count: 0, sumMarg: 0, worstMarg: Infinity, worstCs: '', worstIcao: '', tier: 'OK' }; m.set(r.fam, a) }
      a.count++
      a.sumMarg += r.minMargin
      if (r.minMargin < a.worstMarg) {
        a.worstMarg = r.minMargin
        a.worstCs = (r.f.callsign || r.f.icao).trim()
        a.worstIcao = r.f.icao
      }
    }
    const arr = Array.from(m.values()).map(a => ({ ...a, meanMarg: a.count ? a.sumMarg / a.count : 0, tier: tierOfMargin(a.worstMarg, warnC) }))
    arr.sort((a, b) => {
      const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
      if (ti !== 0) return ti
      return b.count - a.count
    })
    return arr
  }, [rows, warnC])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows
      .filter(r => {
        if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
        if (famFilter !== 'ALL' && r.fam !== famFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, FAM_LABEL[r.fam]].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return a.minMargin - b.minMargin
      })
  }, [rows, tierFilter, famFilter, query])

  const filteredFams = useMemo(() => {
    const q = query.trim().toUpperCase()
    return famAggs.filter(a => {
      if (tierFilter !== 'ALL' && a.tier !== tierFilter) return false
      if (!q) return true
      return (FAM_LABEL[a.fam] + ' ' + FAM_NAME[a.fam]).toUpperCase().includes(q)
    })
  }, [famAggs, tierFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.maxSeverity / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'LOW' || r.tier === 'RL-BUST').map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} Δ${Math.round(r.minMargin)}C`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'RL-BUST').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ‹ EGT-RL` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const projFeatures: any[] = []
    if (showProj) {
      for (const r of rows) {
        if (r.tier !== 'RL-BUST' && r.tier !== 'LOW') continue
        const coords: [number, number][] = []
        for (let i = 0; i <= 16; i++) {
          const p = projectPosition(r.f.lat, r.f.lng, r.f.track || 0, (200 * i) / 16)
          coords.push([p.lng, p.lat])
        }
        projFeatures.push({
          type: 'Feature' as const,
          properties: { color: TIER_COLOR[r.tier] },
          geometry: { type: 'LineString' as const, coordinates: coords },
        })
      }
    }
    const projFc = { type: 'FeatureCollection' as const, features: projFeatures }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_PROJ, projFc, () => map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.4,
        'line-opacity': 0.7,
        'line-dasharray': [2, 3],
      } }))
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
        'text-offset': [0, -1.8],
        'text-anchor': 'bottom',
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
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_PROJ]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_PROJ]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showLabels, showPin, showProj])

  // Diagram: margin C (y, -50..+200) vs flight level (x, 0..450)
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 28
    const xMax = 45, yMin = -50, yMax = 200
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, v / xMax)) * (W - PAD - 6)
    const ys = (m: number) => 6 + (1 - Math.max(0, Math.min(1, (m - yMin) / (yMax - yMin)))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMax, yMax, yMin }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">EGT Margin</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} ac · {rows.reduce((s, r) => s + r.ecount, 0)} eng</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Marg</div>
          <div className="font-mono text-sm" style={{ color: summary.meanMarg <= 25 ? '#f59e0b' : summary.meanMarg <= 60 ? '#0ea5e9' : '#10b981' }}>
            {summary.meanMarg.toFixed(0)}<span className="text-[9px] text-slate-500"> C</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstMarg.toFixed(0)}C` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">RL-Bust</div>
          <div className="font-mono text-sm" style={{ color: summary.rlBust > 0 ? '#ef4444' : '#10b981' }}>{summary.rlBust}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Wear</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanWearH > 18000 ? '#f59e0b' : '#0ea5e9' }}>
            {(summary.meanWearH / 1000).toFixed(1)}<span className="text-[9px] text-slate-500"> k-h</span>
          </div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Derate</div>
          <div className="font-mono text-[11px] text-sky-300">{summary.meanDeratePct.toFixed(1)}<span className="text-[9px] text-slate-500"> %</span></div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Margin C vs Flight Level</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {[-50, 0, 50, 100, 150, 200].map(s => (
              <g key={s}>
                <line x1={diag.PAD} y1={diag.ys(s)} x2={diag.W - 6} y2={diag.ys(s)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(s) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{s}</text>
              </g>
            ))}
            {[10, 20, 30, 40].map(x => (
              <g key={x}>
                <line x1={diag.xs(x)} y1={6} x2={diag.xs(x)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(x)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">F{x}0</text>
              </g>
            ))}
            {/* Threshold bands */}
            {[
              { lo: -50, hi: 0, c: '#ef4444' },
              { lo: 0, hi: 25, c: '#f59e0b' },
              { lo: 25, hi: warnC, c: '#0ea5e9' },
              { lo: warnC, hi: 200, c: '#10b981' },
            ].map((b, i) => (
              <rect key={i} x={diag.PAD} y={diag.ys(b.hi)} width={diag.W - diag.PAD - 6} height={Math.max(0, diag.ys(b.lo) - diag.ys(b.hi))} fill={b.c} opacity={0.07} />
            ))}
            {[0, 25, warnC].map(t => (
              <line key={t} x1={diag.PAD} y1={diag.ys(t)} x2={diag.W - 6} y2={diag.ys(t)} stroke={t === 0 ? '#ef4444' : t === 25 ? '#f59e0b' : '#0ea5e9'} strokeWidth={0.9} strokeDasharray="3 2" opacity={0.75} />
            ))}
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(Math.min(diag.xMax, r.flCur / 10))} cy={diag.ys(Math.max(diag.yMin, Math.min(diag.yMax, r.minMargin)))} r={3} fill={TIER_COLOR[r.tier]} opacity={0.95} />
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
            <div className="flex justify-between text-[10px] text-slate-500"><span>AGE-SLOPE</span><span className="font-mono text-slate-300">{(ageSlope / 10).toFixed(1)}C/k</span></div>
            <input type="range" min={15} max={45} step={1} value={ageSlope} onChange={e => setAgeSlope(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>ISA-DEV</span><span className="font-mono text-slate-300">{isaDev > 0 ? '+' : ''}{isaDev}C</span></div>
            <input type="range" min={-30} max={30} step={1} value={isaDev} onChange={e => setIsaDev(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>DERATE-MIN</span><span className="font-mono text-slate-300">{derateMin}%</span></div>
            <input type="range" min={0} max={25} step={1} value={derateMin} onChange={e => setDerateMin(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>WARN-C</span><span className="font-mono text-slate-300">{warnC}C</span></div>
            <input type="range" min={30} max={120} step={5} value={warnC} onChange={e => setWarnC(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-[10px] text-slate-500"><span>ISA-SCALE C/C-ISA</span><span className="font-mono text-slate-300">{(isaScale / 10).toFixed(1)}</span></div>
          <input type="range" min={10} max={30} step={1} value={isaScale} onChange={e => setIsaScale(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setFamFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${famFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['HBP', 'GEX', 'GTF', 'TXX', 'CF6', 'STF', 'TPP', 'PST', 'MIL'] as EngFam[]).map(k => (
            <button key={k} onClick={() => setFamFilter(famFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${famFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{FAM_LABEL[k]}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / family"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'ENGINES'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length} ac` : `${filteredFams.length} shown / ${famAggs.length} fam`}</span>
        <span>{tab === 'AIRCRAFT' ? 'Δ-C · wear · derate · tier' : 'fam · ac · mean-Δ · worst'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          // margin bar relative to EGT-RL (use min(0, marginC)→ 0 of bar; warnC = tick)
          const barPct = Math.max(0, Math.min(100, ((r.minMargin + 50) / 250) * 100))
          const zeroTick = ((0 + 50) / 250) * 100
          const warnTick = ((warnC + 50) / 250) * 100
          const lowTick = ((25 + 50) / 250) * 100
          const advice = r.tier === 'RL-BUST' ? 'EGT red-line exceeded · reduce thrust · land asap · log peak EGT' :
            r.tier === 'LOW' ? 'margin low · trend monitor next-flight · consider SV-borescope' :
            r.tier === 'WATCH' ? 'within trend baseline · log peak EGT in QAR' :
            'engines healthy on-wing'
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{FAM_LABEL[r.fam]}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="flight level">F{Math.round(r.flCur)}</span>
                  <span title="phase">{PHASE_LABEL[r.phase]}</span>
                  <span title="mean on-wing hours">{(r.meanWearH / 1000).toFixed(1)}kh</span>
                  <span title="mean derate %">D{r.meanDeratePct.toFixed(0)}%</span>
                  <span className="ml-auto truncate" title="min margin to red-line" style={{ color: TIER_COLOR[r.tier] }}>Δ{Math.round(r.minMargin)}C / RL{r.rlC}C</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="margin -50..+200C with 0/25/warn ticks">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${barPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${zeroTick}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${lowTick}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: `${warnTick}%` }} />
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {r.engines.map(e => (
                    <span key={e.i} className="px-1 py-0 rounded border text-[9px] font-mono" style={{ borderColor: TIER_COLOR[e.tier] + '66', color: TIER_COLOR[e.tier], background: TIER_COLOR[e.tier] + '14' }} title={`engine ${e.i} · wear ${e.wearH}h · derate ${e.deratePct}% (-${e.reliefC}C) · ISA ${e.isaC.toFixed(0)}C · EGT ${e.egtC.toFixed(0)}C`}>
                      E{e.i} Δ{Math.round(e.marginC)}C
                    </span>
                  ))}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'ENGINES' && filteredFams.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No engine families match.</div>
        )}
        {tab === 'ENGINES' && filteredFams.map(a => {
          const meanPct = Math.max(0, Math.min(100, ((a.meanMarg + 50) / 250) * 100))
          const advice = a.tier === 'RL-BUST' ? 'fleet on family has RL exceedance · OEM trend review' :
            a.tier === 'LOW' ? 'family margin low · escalate to powerplant engineering' :
            a.tier === 'WATCH' ? 'family within trend baseline · monitor next cycle' :
            'family healthy on-wing'
          return (
            <button key={a.fam} onClick={() => a.worstIcao && onFly(a.worstIcao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{FAM_LABEL[a.fam]}</span>
                  <span className="text-slate-500 text-[10px] truncate">{FAM_NAME[a.fam]}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{a.count}ac</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[a.tier] }}>{a.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="worst margin in family" style={{ color: TIER_COLOR[a.tier] }}>worst Δ{Math.round(a.worstMarg)}C</span>
                  <span title="mean margin in family">mean Δ{Math.round(a.meanMarg)}C</span>
                  <span title="EGT red-line for family">RL {FAM_RL[a.fam]}C</span>
                  <span className="ml-auto truncate">{a.worstCs || '—'}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="mean margin -50..+200C">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${meanPct}%`, background: TIER_COLOR[a.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${((0 + 50) / 250) * 100}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${((25 + 50) / 250) * 100}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: `${((warnC + 50) / 250) * 100}%` }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate">{FAM_ECOUNT[a.fam]} eng/airframe</span>
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
