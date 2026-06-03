'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   VHF Voice Channel Congestion Monitor (Erlang-B saturation)
   -----------------------------------------------------------
   ICAO Annex 10 Vol. III / Doc 9863 / EUROCONTROL VCS-CSP /
   FAA Order 6510.13B air–ground voice channel-loading model.
   For every airborne aircraft we compute the per-aircraft
   contribution to the controller's primary VHF voice channel
   (PTT seconds per minute) and aggregate per ACC sector
   producing an Erlang-A traffic intensity, then evaluate the
   Erlang-B blocking probability for a single-server channel.

   Per-aircraft transmission rate from ICAO ATM Voice Channel
   Loading Studies (Eurocontrol VCO 2018, Vol. I App. C) varies
   by phase of flight:
     CRUISE  ≈ 0.7 ptt/min · 4.5 s mean   (3.15 s/min PTT)
     CLIMB   ≈ 1.4 ptt/min · 5.0 s mean   (7.00 s/min PTT)
     DESCENT ≈ 1.6 ptt/min · 5.2 s mean   (8.32 s/min PTT)
     APPR    ≈ 2.3 ptt/min · 4.8 s mean  (11.04 s/min PTT)
   Heavy/oceanic class +20% (long position reports, HF-relay
   readbacks). CPDLC-equipped aircraft offload routine clearance
   readbacks → x0.55 PTT factor (Eurocontrol DLS PCP shows
   ~45% voice reduction in Maastricht UAC trials). Slider
   CPDLC-OFF 0-100% scales the offload aggressively.

   Erlang-A traffic intensity for sector:
     A = Σ(ptt_sec_per_min_i) / 60   (Erlangs, fractional)
   Single-channel Erlang-B blocking probability:
     B(1, A) = A / (1 + A)
   For multi-frequency sector groups (declared sectors S):
     B(S, A) recursive: B[0]=1; B[n]=A·B[n-1]/(n + A·B[n-1])
   ITU-T E.500 / ICAO ATM target B ≤ 0.01 (1%) at peak hour;
   ≤ 0.005 (0.5%) for Class-A en-route per FAA Order 6510.13B.

   Tier classification:
     SAT  B ≥ 0.10 rose   step-on / over-transmission, advise frequency split
     CONG 0.03 ≤ B < 0.10 amber blocked calls likely, monitor pilot reports
     LOAD 0.01 ≤ B < 0.03 sky   above ICAO 1% threshold but workable
     OK   B < 0.01 emerald nominal channel grade-of-service
     QUIET A < 0.05 Erl    slate (very low traffic, rural sector)

   MapLibre overlay:
     - Sector polygon fills tier-coloured at 6% opacity + dashed outline
     - Centroid pin with ACC code + B%
     - Tier-coloured aircraft halo rings sized by per-aircraft PTT
     - Tier-coloured callsign + PTT-s/min labels for CONG/SAT aircraft

   Side panel:
     - 5-tier counter strip click-to-filter
     - 3-cell MEAN-B / WORST-SECTOR / SAT-COUNT summary
     - 2-cell BLOCKED-CALLS-PER-HR / CPDLC-OFFLOAD-AC secondary
     - SVG B-vs-A scatter (x=Erlangs 0-30, y=B 0-25%)
       with 0.005/0.01/0.03/0.10 threshold bands shaded + lines
     - 5 sliders MIN-FL / MAX-FL / CPDLC-OFF 0-150% / PTT-MULT 50-150% /
       SECTORS-FORCE 0=AUTO..6
     - 7-class chip filter (HVY/NRW/RGN/BIZ/TBP/GA/FTR)
     - HALO/SECT/PIN/LBL/DIAG toggles + search
     - SECTORS/AIRCRAFT tab switcher
     - SECTORS tab grouped by ACC sorted tier-worst-first then
       B desc with tier stripe, ACC name, ac-count, B%, Erlangs,
       per-sector blocked-calls/hr, channel-occupancy progress bar
     - AIRCRAFT tab sorted tier-worst-first then PTT desc with
       tier color stripe, callsign+type+class-pill+tier-pill,
       FL/phase/sector/PTT-s/min line, PTT bar, advice
     - click-to-fly per row

   Registered: Layers > Safety & Traffic
   Persisted: ft-vhf
   ============================================================ */

export interface VhfFlight {
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
  flights: VhfFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'LOAD' | 'CONG' | 'SAT' | 'QUIET'
const TIER_COLOR: Record<Tier, string> = {
  OK: '#10b981',
  LOAD: '#0ea5e9',
  CONG: '#f59e0b',
  SAT: '#ef4444',
  QUIET: '#64748b',
}
const TIER_ORDER: Tier[] = ['SAT', 'CONG', 'LOAD', 'OK', 'QUIET']
const TIER_RANK: Record<Tier, number> = { SAT: 0, CONG: 1, LOAD: 2, OK: 3, QUIET: 4 }

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}
const KLASS_PTT_BIAS: Record<Klass, number> = { heavy: 1.2, narrow: 1.0, regional: 0.9, biz: 0.95, turboprop: 0.85, ga: 0.7, fighter: 0.6 }
// CPDLC equipage probability (per ICAO/EASA DLS Mandate Implementation Report 2023)
const KLASS_CPDLC_P: Record<Klass, number> = { heavy: 0.97, narrow: 0.78, regional: 0.55, biz: 0.92, turboprop: 0.20, ga: 0.05, fighter: 0.10 }

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
// Base PTT seconds per minute per phase (ICAO ATM Voice Channel Loading Studies)
const PHASE_PTT: Record<Phase, number> = { CLIMB: 7.0, CRUISE: 3.15, DESCENT: 8.32, APPR: 11.04 }

function inferPhase(altFt: number, vsFpm: number): Phase {
  if (altFt < 8000) return 'APPR'
  if (vsFpm > 600) return 'CLIMB'
  if (vsFpm < -600) return 'DESCENT'
  if (altFt < 18000 && vsFpm < -200) return 'DESCENT'
  return 'CRUISE'
}

// FNV-1a 32-bit hash for deterministic per-airframe CPDLC equipage
function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h >>> 0
}

interface Sector {
  id: string         // ICAO 4-letter ACC
  acc: string
  region: string
  sectors: number    // declared frequency-channel count at peak
  poly: [number, number][]
}

/* 30 globally significant ACC sectors with approximate boundaries.
   `sectors` = peak-hour count of staffed voice frequencies (sum of
   sector splits). Sourced from EUROCONTROL NM Capacity Plans 2024,
   FAA TFMS sector decomposition, JCAB/CASA/CAAC public data. */
const SECTORS: Sector[] = [
  // EUROPE
  { id: 'EDUU', acc: 'Maastricht UAC',  region: 'EUR', sectors: 6, poly: [[2.0,49.0],[9.0,49.0],[10.0,52.0],[9.0,55.0],[3.0,55.0],[2.0,52.5]] },
  { id: 'EDMM', acc: 'Munich ACC',      region: 'EUR', sectors: 5, poly: [[7.0,47.0],[13.5,47.0],[13.5,50.5],[7.0,50.5]] },
  { id: 'EDWW', acc: 'Bremen ACC',      region: 'EUR', sectors: 4, poly: [[5.5,52.0],[11.0,52.0],[11.0,55.0],[5.5,55.0]] },
  { id: 'LFFF', acc: 'Paris ACC',       region: 'EUR', sectors: 6, poly: [[-1.5,46.0],[5.0,46.0],[5.0,50.5],[-1.5,50.5]] },
  { id: 'LFBB', acc: 'Bordeaux ACC',    region: 'EUR', sectors: 4, poly: [[-4.0,42.5],[3.0,42.5],[3.0,46.5],[-4.0,46.5]] },
  { id: 'EGTT', acc: 'London ACC',      region: 'EUR', sectors: 6, poly: [[-6.0,49.5],[2.5,49.5],[2.5,55.0],[-6.0,55.0]] },
  { id: 'EGPX', acc: 'Scottish ACC',    region: 'EUR', sectors: 4, poly: [[-9.0,54.5],[2.5,54.5],[2.5,61.0],[-9.0,61.0]] },
  { id: 'EHAA', acc: 'Amsterdam ACC',   region: 'EUR', sectors: 4, poly: [[2.5,51.0],[7.5,51.0],[7.5,55.0],[2.5,55.0]] },
  { id: 'LSAS', acc: 'Swiss ACC',       region: 'EUR', sectors: 4, poly: [[5.8,45.7],[10.6,45.7],[10.6,47.9],[5.8,47.9]] },
  { id: 'LIMM', acc: 'Milan ACC',       region: 'EUR', sectors: 4, poly: [[6.5,43.5],[14.0,43.5],[14.0,47.0],[6.5,47.0]] },
  { id: 'LECM', acc: 'Madrid ACC',      region: 'EUR', sectors: 5, poly: [[-9.5,36.0],[3.5,36.0],[3.5,43.5],[-9.5,43.5]] },
  { id: 'LTAA', acc: 'Ankara ACC',      region: 'EUR', sectors: 4, poly: [[26.0,36.0],[44.5,36.0],[44.5,42.0],[26.0,42.0]] },
  { id: 'EPWW', acc: 'Warsaw ACC',      region: 'EUR', sectors: 4, poly: [[14.0,49.0],[24.0,49.0],[24.0,55.0],[14.0,55.0]] },
  // N.AMERICA
  { id: 'KZNY', acc: 'New York ARTCC',  region: 'NAM', sectors: 8, poly: [[-77.0,38.5],[-71.0,38.5],[-71.0,42.5],[-77.0,42.5]] },
  { id: 'KZID', acc: 'Indianapolis',    region: 'NAM', sectors: 6, poly: [[-89.0,36.0],[-82.0,36.0],[-82.0,41.5],[-89.0,41.5]] },
  { id: 'KZAU', acc: 'Chicago ARTCC',   region: 'NAM', sectors: 7, poly: [[-92.0,40.0],[-84.5,40.0],[-84.5,46.0],[-92.0,46.0]] },
  { id: 'KZLA', acc: 'Los Angeles',     region: 'NAM', sectors: 6, poly: [[-122.0,32.0],[-114.0,32.0],[-114.0,37.0],[-122.0,37.0]] },
  { id: 'KZOA', acc: 'Oakland ARTCC',   region: 'NAM', sectors: 5, poly: [[-126.0,36.0],[-119.0,36.0],[-119.0,42.0],[-126.0,42.0]] },
  { id: 'KZDV', acc: 'Denver ARTCC',    region: 'NAM', sectors: 5, poly: [[-110.0,37.0],[-101.0,37.0],[-101.0,44.0],[-110.0,44.0]] },
  { id: 'KZTL', acc: 'Atlanta ARTCC',   region: 'NAM', sectors: 6, poly: [[-86.5,30.5],[-79.0,30.5],[-79.0,35.5],[-86.5,35.5]] },
  { id: 'CZUL', acc: 'Montreal ACC',    region: 'NAM', sectors: 4, poly: [[-79.0,44.0],[-69.0,44.0],[-69.0,50.0],[-79.0,50.0]] },
  // ASIA
  { id: 'RJJJ', acc: 'Fukuoka ACC',     region: 'ASIA', sectors: 6, poly: [[127.0,30.0],[145.0,30.0],[145.0,42.0],[127.0,42.0]] },
  { id: 'ZBPE', acc: 'Beijing ACC',     region: 'ASIA', sectors: 6, poly: [[113.0,36.0],[122.0,36.0],[122.0,42.0],[113.0,42.0]] },
  { id: 'ZSHA', acc: 'Shanghai ACC',    region: 'ASIA', sectors: 7, poly: [[116.0,28.0],[125.0,28.0],[125.0,35.0],[116.0,35.0]] },
  { id: 'ZGGG', acc: 'Guangzhou ACC',   region: 'ASIA', sectors: 5, poly: [[108.0,21.0],[118.0,21.0],[118.0,27.0],[108.0,27.0]] },
  { id: 'VHHK', acc: 'Hong Kong ACC',   region: 'ASIA', sectors: 4, poly: [[111.5,19.5],[117.5,19.5],[117.5,23.5],[111.5,23.5]] },
  { id: 'VTBB', acc: 'Bangkok ACC',     region: 'ASIA', sectors: 5, poly: [[97.0,5.5],[106.0,5.5],[106.0,20.5],[97.0,20.5]] },
  { id: 'WSJC', acc: 'Singapore ACC',   region: 'ASIA', sectors: 4, poly: [[103.0,0.0],[107.5,0.0],[107.5,5.0],[103.0,5.0]] },
  { id: 'VABF', acc: 'Mumbai ACC',      region: 'ASIA', sectors: 5, poly: [[68.0,15.0],[78.0,15.0],[78.0,23.0],[68.0,23.0]] },
  { id: 'OMAE', acc: 'Emirates ACC',    region: 'ASIA', sectors: 6, poly: [[51.0,22.5],[57.0,22.5],[57.0,26.5],[51.0,26.5]] },
  // OCEANIA / S.AMERICA
  { id: 'YBBB', acc: 'Brisbane ACC',    region: 'OCE', sectors: 4, poly: [[138.0,-29.0],[155.0,-29.0],[155.0,-10.0],[138.0,-10.0]] },
  { id: 'YMMM', acc: 'Melbourne ACC',   region: 'OCE', sectors: 5, poly: [[129.0,-39.0],[150.0,-39.0],[150.0,-29.0],[129.0,-29.0]] },
  { id: 'SBBS', acc: 'Brasilia ACC',    region: 'SAM', sectors: 4, poly: [[-58.0,-22.0],[-42.0,-22.0],[-42.0,-12.0],[-58.0,-12.0]] },
]

function pointInPoly(lng: number, lat: number, poly: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1]
    const xj = poly[j][0], yj = poly[j][1]
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-9) + xi)) inside = !inside
  }
  return inside
}
function polyCentroid(poly: [number, number][]): { lat: number; lng: number } {
  let sx = 0, sy = 0
  for (const [x, y] of poly) { sx += x; sy += y }
  return { lng: sx / poly.length, lat: sy / poly.length }
}

// Erlang-B recursive: B(0,A)=1, B(n,A) = A·B(n-1,A) / (n + A·B(n-1,A))
function erlangB(servers: number, A: number): number {
  if (A <= 0) return 0
  let b = 1
  for (let n = 1; n <= servers; n++) {
    b = (A * b) / (n + A * b)
  }
  return b
}

interface Row {
  f: VhfFlight
  klass: Klass
  flCur: number
  phase: Phase
  sec: Sector | null
  cpdlcOn: boolean
  pttSecMin: number   // per-aircraft contribution
  tier: Tier
}

interface SecAgg {
  sec: Sector
  count: number
  klassCounts: Record<Klass, number>
  totalPtt: number   // seconds per minute summed
  A: number          // Erlangs
  blockProb: number  // B(S,A)
  tier: Tier
  meanFL: number
  blockedCallsHr: number  // call attempts per hour * B
  cpdlcOnAc: number
  worstCs: string
  worstPtt: number
}

const SRC_HALO = 'vhf-halo', SRC_SECT = 'vhf-sect', SRC_OUT = 'vhf-out', SRC_PIN = 'vhf-pin', SRC_LBL = 'vhf-lbl'
const LYR_HALO = 'vhf-halo-l', LYR_SECT = 'vhf-sect-l', LYR_OUT = 'vhf-out-l', LYR_PIN = 'vhf-pin-l', LYR_LBL = 'vhf-lbl-l'

function tierOfBlock(B: number, A: number): Tier {
  if (A < 0.05) return 'QUIET'
  if (B >= 0.10) return 'SAT'
  if (B >= 0.03) return 'CONG'
  if (B >= 0.01) return 'LOAD'
  return 'OK'
}

export default function VhfCongestion({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'SECTORS' | 'AIRCRAFT'>('SECTORS')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [maxFl, setMaxFl] = useState(450)
  const [cpdlcOff, setCpdlcOff] = useState(100)  // % of nominal CPDLC offload
  const [pttMult, setPttMult] = useState(100)    // % global PTT multiplier
  const [sectorsForce, setSectorsForce] = useState(0)  // 0=AUTO else override S
  const [showHalo, setShowHalo] = useState(true)
  const [showSect, setShowSect] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const cpdlcK = Math.max(0, cpdlcOff / 100)
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl || flCur > maxFl) continue
      const klass = classify(f.type, f.category)
      const phase = inferPhase(f.altitudeFt, f.vertRate || 0)
      // Find sector
      let sec: Sector | null = null
      for (const s of SECTORS) {
        if (pointInPoly(f.lng, f.lat, s.poly)) { sec = s; break }
      }
      // CPDLC equipage stable per ICAO24
      const h = hash32(f.icao || f.callsign || 'x')
      const cpdlcOn = (h % 1000) / 1000 < KLASS_CPDLC_P[klass]
      const offloadFactor = cpdlcOn ? (1 - 0.45 * cpdlcK) : 1.0
      const basePtt = PHASE_PTT[phase] * KLASS_PTT_BIAS[klass] * (pttMult / 100) * offloadFactor
      out.push({
        f, klass, flCur, phase, sec, cpdlcOn,
        pttSecMin: basePtt,
        tier: 'OK',  // placeholder, set after sector aggregation
      })
    }
    return out
  }, [flights, minFl, maxFl, cpdlcOff, pttMult])

  const secAggs: SecAgg[] = useMemo(() => {
    const m = new Map<string, SecAgg>()
    for (const r of rows) {
      if (!r.sec) continue
      let e = m.get(r.sec.id)
      if (!e) {
        e = {
          sec: r.sec,
          count: 0,
          klassCounts: { heavy: 0, narrow: 0, regional: 0, biz: 0, turboprop: 0, ga: 0, fighter: 0 },
          totalPtt: 0,
          A: 0, blockProb: 0, tier: 'OK',
          meanFL: 0,
          blockedCallsHr: 0,
          cpdlcOnAc: 0,
          worstCs: '', worstPtt: 0,
        }
        m.set(r.sec.id, e)
      }
      e.count++
      e.klassCounts[r.klass]++
      e.totalPtt += r.pttSecMin
      e.meanFL += r.flCur
      if (r.cpdlcOn) e.cpdlcOnAc++
      if (r.pttSecMin > e.worstPtt) { e.worstPtt = r.pttSecMin; e.worstCs = (r.f.callsign || r.f.icao).trim() }
    }
    const aggs = Array.from(m.values())
    for (const a of aggs) {
      a.meanFL /= Math.max(1, a.count)
      a.A = a.totalPtt / 60   // Erlangs
      const S = sectorsForce > 0 ? sectorsForce : a.sec.sectors
      a.blockProb = erlangB(S, a.A)
      a.tier = tierOfBlock(a.blockProb, a.A)
      // Call attempts per hour ≈ Σ(ptt/min) * 60 / mean-call-duration (5s) and B fraction blocked
      const callAttemptsHr = (a.totalPtt * 60) / 5
      a.blockedCallsHr = callAttemptsHr * a.blockProb
    }
    aggs.sort((x, y) => {
      const ti = TIER_RANK[x.tier] - TIER_RANK[y.tier]
      if (ti !== 0) return ti
      return y.blockProb - x.blockProb
    })
    return aggs
  }, [rows, sectorsForce])

  // Stamp per-aircraft tier from owning sector
  const stampedRows = useMemo(() => {
    const tierBySec = new Map<string, Tier>()
    for (const a of secAggs) tierBySec.set(a.sec.id, a.tier)
    return rows.map(r => ({ ...r, tier: r.sec ? (tierBySec.get(r.sec.id) || 'QUIET') : 'QUIET' as Tier }))
  }, [rows, secAggs])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OK: 0, LOAD: 0, CONG: 0, SAT: 0, QUIET: 0 }
    for (const a of secAggs) t[a.tier]++
    return t
  }, [secAggs])

  const summary = useMemo(() => {
    let meanB = 0, worstB = 0, worstAcc = '', satCount = 0, blockedHr = 0, cpdlcOnTotal = 0
    for (const a of secAggs) {
      meanB += a.blockProb
      blockedHr += a.blockedCallsHr
      cpdlcOnTotal += a.cpdlcOnAc
      if (a.blockProb > worstB) { worstB = a.blockProb; worstAcc = a.sec.id }
      if (a.tier === 'SAT') satCount++
    }
    if (secAggs.length) meanB /= secAggs.length
    return { meanB, worstB, worstAcc, satCount, blockedHr, cpdlcOnTotal, totalSec: secAggs.length, totalAc: stampedRows.length }
  }, [secAggs, stampedRows])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return stampedRows
      .filter(r => {
        if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
        if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.sec?.id, r.sec?.acc].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.pttSecMin - a.pttSecMin
      })
  }, [stampedRows, tierFilter, klassFilter, query])

  const filteredSectors = useMemo(() => {
    const q = query.trim().toUpperCase()
    return secAggs.filter(a => {
      if (tierFilter !== 'ALL' && a.tier !== tierFilter) return false
      if (!q) return true
      return [a.sec.id, a.sec.acc, a.sec.region].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [secAggs, tierFilter, query])

  // ---- MapLibre layers ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? stampedRows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.pttSecMin / 1.2) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const sectFc = { type: 'FeatureCollection' as const, features: showSect ? secAggs.map(a => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[a.tier] },
      geometry: { type: 'Polygon' as const, coordinates: [[...a.sec.poly, a.sec.poly[0]]] },
    })) : [] }
    const outFc = { type: 'FeatureCollection' as const, features: showSect ? secAggs.map(a => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[a.tier] },
      geometry: { type: 'LineString' as const, coordinates: [...a.sec.poly, a.sec.poly[0]] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? secAggs.map(a => {
      const c = polyCentroid(a.sec.poly)
      return {
        type: 'Feature' as const,
        properties: { color: TIER_COLOR[a.tier], text: `${a.sec.id} ${(a.blockProb * 100).toFixed(1)}%` },
        geometry: { type: 'Point' as const, coordinates: [c.lng, c.lat] },
      }
    }) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? stampedRows.filter(r => r.tier === 'CONG' || r.tier === 'SAT').map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${r.pttSecMin.toFixed(1)}s/m`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_SECT, sectFc, () => map.addLayer({ id: LYR_SECT, type: 'fill', source: SRC_SECT, paint: {
        'fill-color': ['get', 'color'], 'fill-opacity': 0.06,
      } }))
      ensure(SRC_OUT, outFc, () => map.addLayer({ id: LYR_OUT, type: 'line', source: SRC_OUT, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.3, 'line-dasharray': [3, 2], 'line-opacity': 0.7,
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
        'text-size': 11,
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-offset': [0, 0],
        'text-anchor': 'center',
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
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_OUT, LYR_SECT]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_OUT, SRC_SECT]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, stampedRows, secAggs, showHalo, showSect, showPin, showLabels])

  // Diagram: B (y, 0-25%) vs Erlangs (x, 0-30)
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 28
    const xMax = 30, yMax = 0.25
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, v / xMax)) * (W - PAD - 6)
    const ys = (b: number) => 6 + (1 - Math.max(0, Math.min(1, b / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">VHF Congestion</span>
        <span className="text-[10px] text-slate-500 ml-auto">{secAggs.length} ACC · {stampedRows.length} ac</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean B</div>
          <div className="font-mono text-sm" style={{ color: summary.meanB >= 0.03 ? '#f59e0b' : summary.meanB >= 0.01 ? '#0ea5e9' : '#10b981' }}>
            {(summary.meanB * 100).toFixed(2)}<span className="text-[9px] text-slate-500"> %</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst Sector</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstAcc}>
            {summary.worstAcc ? `${summary.worstAcc} ${(summary.worstB * 100).toFixed(1)}%` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Saturated</div>
          <div className="font-mono text-sm" style={{ color: summary.satCount > 0 ? '#ef4444' : '#10b981' }}>{summary.satCount}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Blocked Calls/hr</div>
          <div className="font-mono text-[11px]" style={{ color: summary.blockedHr > 100 ? '#ef4444' : summary.blockedHr > 20 ? '#f59e0b' : '#10b981' }}>{summary.blockedHr.toFixed(0)}<span className="text-[9px] text-slate-500"> calls</span></div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">CPDLC Offload</div>
          <div className="font-mono text-[11px] text-sky-300">{summary.cpdlcOnTotal}<span className="text-[9px] text-slate-500"> /{summary.totalAc} ac</span></div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Erlang-B blocking · B%  vs  offered load A · Erlangs</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {[0.05, 0.10, 0.15, 0.20, 0.25].map(b => (
              <g key={b}>
                <line x1={diag.PAD} y1={diag.ys(b)} x2={diag.W - 6} y2={diag.ys(b)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(b) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{(b * 100).toFixed(0)}%</text>
              </g>
            ))}
            {[5, 10, 15, 20, 25, 30].map(a => (
              <g key={a}>
                <line x1={diag.xs(a)} y1={6} x2={diag.xs(a)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(a)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{a}E</text>
              </g>
            ))}
            {/* Threshold bands */}
            {[
              { lo: 0, hi: 0.005, c: '#10b981' },
              { lo: 0.005, hi: 0.01, c: '#10b981' },
              { lo: 0.01, hi: 0.03, c: '#0ea5e9' },
              { lo: 0.03, hi: 0.10, c: '#f59e0b' },
              { lo: 0.10, hi: 0.25, c: '#ef4444' },
            ].map((b, i) => (
              <rect key={i} x={diag.PAD} y={diag.ys(b.hi)} width={diag.W - diag.PAD - 6} height={Math.max(0, diag.ys(b.lo) - diag.ys(b.hi))} fill={b.c} opacity={0.05} />
            ))}
            {[0.01, 0.03, 0.10].map(t => (
              <line key={t} x1={diag.PAD} y1={diag.ys(t)} x2={diag.W - 6} y2={diag.ys(t)} stroke={t === 0.01 ? '#0ea5e9' : t === 0.03 ? '#f59e0b' : '#ef4444'} strokeWidth={0.9} strokeDasharray="3 2" opacity={0.7} />
            ))}
            {secAggs.map(a => (
              <circle key={a.sec.id} cx={diag.xs(Math.min(diag.xMax, a.A))} cy={diag.ys(Math.min(diag.yMax, a.blockProb))} r={3} fill={TIER_COLOR[a.tier]} opacity={0.95} />
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
            <div className="flex justify-between text-[10px] text-slate-500"><span>CPDLC-OFF</span><span className="font-mono text-slate-300">{cpdlcOff}%</span></div>
            <input type="range" min={0} max={150} step={10} value={cpdlcOff} onChange={e => setCpdlcOff(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>PTT-MULT</span><span className="font-mono text-slate-300">{pttMult}%</span></div>
            <input type="range" min={50} max={150} step={10} value={pttMult} onChange={e => setPttMult(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div className="col-span-2">
            <div className="flex justify-between text-[10px] text-slate-500"><span>SECTORS-FORCE</span><span className="font-mono text-slate-300">{sectorsForce === 0 ? 'AUTO' : `S=${sectorsForce}`}</span></div>
            <input type="range" min={0} max={8} step={1} value={sectorsForce} onChange={e => setSectorsForce(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showSect} onChange={e => setShowSect(e.target.checked)} className="accent-sky-500" /><span>SECT</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / ACC"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['SECTORS', 'AIRCRAFT'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'SECTORS' ? `${filteredSectors.length} shown / ${secAggs.length} active` : `${filteredAircraft.length} shown / ${stampedRows.length} ac`}</span>
        <span>{tab === 'SECTORS' ? 'B · A · ac · blocked/hr' : 'PTT · phase · sec · tier'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'SECTORS' && filteredSectors.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No sectors match.</div>
        )}
        {tab === 'SECTORS' && filteredSectors.map(a => {
          const Bpct = a.blockProb * 100
          const refMax = 25 // % bar scale
          const barPct = Math.min(100, (Bpct / refMax) * 100)
          const loadPct = (1 / refMax) * 100
          const congPct = (3 / refMax) * 100
          const satPct = (10 / refMax) * 100
          const advice = a.tier === 'SAT' ? 'channel saturated · split frequency or push CPDLC offload now' :
            a.tier === 'CONG' ? 'above ICAO 3% blocking · expect step-ons · brief crews' :
            a.tier === 'LOAD' ? 'above 1% target · workable · monitor pilot wait-times' :
            a.tier === 'QUIET' ? 'low offered load · no comms pressure' :
            'nominal channel grade-of-service'
          const S = sectorsForce > 0 ? sectorsForce : a.sec.sectors
          return (
            <button key={a.sec.id} onClick={() => {
              const c = polyCentroid(a.sec.poly)
              try { map?.flyTo({ center: [c.lng, c.lat], zoom: 5 }) } catch {}
            }}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{a.sec.id}</span>
                  <span className="text-slate-500 truncate">{a.sec.acc}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{a.count}ac</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[a.tier] }}>{a.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="blocking probability" style={{ color: TIER_COLOR[a.tier] }}>B {Bpct.toFixed(2)}%</span>
                  <span title="offered load Erlangs">A {a.A.toFixed(2)}E</span>
                  <span title="frequency channels">S={S}</span>
                  <span title="mean flight level">F{Math.round(a.meanFL)}</span>
                  <span className="ml-auto" title="blocked calls per hour">{a.blockedCallsHr.toFixed(0)} blk/hr</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="blocking B vs ICAO/FAA thresholds">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${barPct}%`, background: TIER_COLOR[a.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: `${loadPct}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${congPct}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${satPct}%` }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="PTT total">PTT {a.totalPtt.toFixed(0)}s/min</span>
                  <span title="CPDLC equipped" style={{ color: '#0ea5e9' }}>DL {a.cpdlcOnAc}/{a.count}</span>
                  <span title="worst caller" className="ml-auto truncate">{a.worstCs ? `${a.worstCs} ${a.worstPtt.toFixed(1)}s/m` : '—'}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="region">{a.sec.region}</span>
                  <span className="ml-auto truncate" style={{ color: a.tier === 'OK' || a.tier === 'QUIET' ? '#64748b' : TIER_COLOR[a.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const refMax = 18 // s/min bar
          const pct = Math.min(100, (r.pttSecMin / refMax) * 100)
          const advice = r.tier === 'SAT' ? 'sector saturated · expect blocked calls' :
            r.tier === 'CONG' ? 'sector congested · short readbacks · use CPDLC' :
            r.tier === 'LOAD' ? 'sector above 1% blocking · normal SOP' :
            r.tier === 'QUIET' ? 'quiet sector · low channel demand' :
            'channel nominal'
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
                  <span title="sector">{r.sec ? r.sec.id : '—'}</span>
                  <span title="CPDLC" style={{ color: r.cpdlcOn ? '#0ea5e9' : '#64748b' }}>{r.cpdlcOn ? 'CPDLC' : 'voice'}</span>
                  <span className="ml-auto" title="PTT contribution" style={{ color: TIER_COLOR[r.tier] }}>{r.pttSecMin.toFixed(1)}s/m</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="per-aircraft PTT s/min vs 18 s/min ref">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${pct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: `${(5/refMax)*100}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${(10/refMax)*100}%` }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' || r.tier === 'QUIET' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
