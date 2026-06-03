'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Cabin Egress / 90-Second Evacuation Compliance Monitor
   -----------------------------------------------------------
   14 CFR 25.803 / CS-25.803 Emergency Evacuation — full-scale
   90-second demonstration with 50pct of exits blocked, dark
   cabin, life vests donned. 14 CFR 25.807 Emergency Exits
   (Type-A/B/C/I/II/III/IV with passenger-credit per exit pair)
   / FAA AC 25.803-1A Emergency Evacuation Demonstration /
   EASA AMC 25.803 / SAE ARP 503 Slide / Boeing FCOM Vol 1
   Limitations (max-cert pax) / Airbus FCOM LIM-25 cabin config
   / Honeywell ELS Emergency Lighting System ARP 4101 floor-
   proximity escape-path 10ft visibility 90pct under smoke /
   FAA AC 25-17A Cabin Safety / FAA InFO 18011 single-aisle
   blocked-exit evacuation / NTSB SR-18-01 Emergency Lighting /
   Boeing 737 MAX Type-III over-wing exit-row briefing /
   Airbus A380 dual-aisle deck-2 spiral-stair evacuation /
   Federal Express Flight 14 (MD-11) survivor egress / British
   Airtours Flight 28M Manchester 1985 (B737 fire egress).

   This subsystem reconstructs, for every airborne aircraft,
   the probable evacuation completion time if a survivable
   accident occurred at the next aerodrome touchdown. Per FAR
   25.803 each transport-category type-certificated under
   Part 25 must complete full evacuation within 90 seconds
   with 50pct of exits inoperative. The actual demonstrated
   time + the per-airframe operational degradation determines
   real-world margin.

   Per-class 7-variant catalogue (paxMax / exitCredit / certDem /
   nFlightAtt / overwingPairs / mainSlidePairs / typeA-or-B):

     HVY (777-300ER / A380 / 747-8I / A350-1000 / 787-10):
       paxMax 615 (A380 868) / certDem 88s (A380 78s dual-deck) /
       8-10 Type-A doors / 0 over-wing / 12-22 FAs / SLIDE-RAFT
     NRW (737-800/MAX-8 / A320 / A321neo):
       paxMax 189 (A321 244) / certDem 84-89s / 4 Type-A doors
       (no longer Type-I post-cert) + 2x Type-III over-wing /
       4-6 FAs / single-lane slide
     RGN (CRJ-900 / E175 / ATR-72):
       paxMax 90-100 / certDem 75-85s / 2-3 Type-I doors +
       1-2 Type-III / 2-3 FAs / single-lane slide
     BIZ (G650 / Global / Falcon 7X):
       paxMax 19 / no FAR 25.803 90s required / main-door +
       emergency hatch / 1-2 cabin crew
     TBP (DHC-8 Q400 / ATR-42):
       paxMax 78 / 1 main + 1 service + 2 over-wing / 2 FAs
     GA (C172 / SR22): paxMax 4 / not Part-25
     FTR: not Part-25

   5 risk components (max-driver, 0-100):

     EXIT-AVAIL  Hash-stable per-airframe MEL exit-availability
                 (1.0 = all serviceable / 0.85 = one exit on MEL
                 / 0.60 = two exits on MEL). FAR 25.807 demands
                 50pct credit if any exit pair on MEL exceeds
                 dispatch limit. Severity ramps as available
                 exits drop below 50pct of certificated.

     PAX-LOAD    Hash-stable per-airframe load factor 0.50-1.00
                 of paxMax scaled by LOAD-MUL slider 50-110pct.
                 Per Boeing AERO Q3-2010 evacuation-time scales
                 ~linearly with load above 80pct. Severity:
                 sev = clip((LF-0.80)/0.20*60, 0, 100) modulated
                 by reduced exit availability.

     CABIN-CFG   Cabin configuration penalty — 3-class layout
                 with curtain galleys (HVY long-haul) adds 8-12s
                 vs all-economy. Hash-stable per-airframe cfg
                 mix (Y / Y+J / Y+J+F / Y+J+F+P). Per AC 25.803-1A
                 sec 8 cabin obstructions count against demo time.

     CREW-RATIO  Cabin crew per pax-pair vs 14 CFR 121.391
                 minimum (1 FA per 50 pax). Below minimum =
                 severity 80+. Hash-stable per-airframe FA
                 count with sick-call-out 0-2 FAs absent.

     EMER-LIGHT  Honeywell ELS Emergency Lighting System
                 floor-proximity escape-path serviceability.
                 ARP 4101 mandates 10ft visibility through
                 smoke at 90pct illumination. Hash-stable per-
                 airframe ELS battery-charge-state 0-100pct and
                 broken-segment count 0-12. Below 60pct charge
                 or >4 broken = severity ramp.

   Composite score = max-driver with dominant-driver labelling
   EXIT / LOAD / CFG / CREW / ELS. Predicted evacuation time:
     T_evac = T_dem * (1 + LF-penalty + cfg-penalty + crew-
              penalty + els-penalty) / exit-availability
   Then compared to 90s regulatory floor — margin in seconds.

   Tier classification:
     NON-COMP   score>=80 or T_evac>105s     rose
                non-compliant with FAR 25.803 ground stop
     TIGHT      score>=55 or 90<T_evac<=105s amber
                within 15s of regulatory limit
     WATCH      score>=25 or T_evac<=90s     sky
                compliant but margin eroded
     OK         score<25 and T_evac<=80s     emerald
                full margin
     IDLE       on ground / non Part-25      slate

   MapLibre overlay:
     - Tier-coloured halo rings sized by score 8-22 px
     - Rose diamond pin at projected touchdown great-circle
       60sec ahead for NON-COMP aircraft
     - Tier-coloured callsign + T_evac-sec + driver labels
       for non-OK aircraft
     - Amber dashed FAR 25.803 reference parallels at lat
       55/35/15/-15/-35/-55 sampled every 12deg longitude
       as global Part-25 jurisdictional fleet reference

   Side panel:
     - 5-tier counter strip click-to-filter
     - 3-cell MEAN-TEVAC / WORST callsign + driver / NON-COMP
     - 2-cell MEAN-MARG / ELS-DEG-share secondary
     - SVG T_evac-vs-load-factor scatter with rose
       non-compliant band T_evac>105s shaded + amber 90-105s
       tight band + sky 80-90s watch band + emerald <80s ok
       + dashed regulatory 90s and 105s horizontals + 50/70/
       90pct LF verticals + every aircraft tier-coloured dot
     - 5 sliders MIN-FL / LOAD-MUL / EXIT-MUL / ELS-MUL /
       CREW-MUL
     - 7-class chip filter HVY/NRW/RGN/BIZ/TBP/GA/FTR
     - HALO/PIN/LBL/REF/DIAG toggles + search
     - AIRCRAFT / CLASSES tab switcher

   Persisted preference: ft-egress
   ============================================================ */

interface EgressFlight {
  icao: string
  callsign?: string
  type?: string
  operator?: string
  category?: number | string
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
  flights: EgressFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'NC' | 'TIGHT' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  NC: '#f43f5e',
  TIGHT: '#f59e0b',
  WATCH: '#0ea5e9',
  OK: '#10b981',
  IDLE: '#475569',
}
const TIER_ORDER: Tier[] = ['NC', 'TIGHT', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { NC: 0, TIGHT: 1, WATCH: 2, OK: 3, IDLE: 4 }
const TIER_LABEL: Record<Tier, string> = {
  NC: 'NON-COMP',
  TIGHT: 'TIGHT',
  WATCH: 'WATCH',
  OK: 'OK',
  IDLE: 'IDLE',
}
const TIER_ADVICE: Record<Tier, string> = {
  NC: 'evac time projected > 105s — non-compliant per FAR 25.803 — restore exits via MEL deferral close-out + cabin re-brief before next flight',
  TIGHT: 'within 15s of regulatory 90s floor — verify all FAs at stations and ELS test before next departure',
  WATCH: 'compliant but margin eroded — monitor exit MEL deferrals + ELS battery charge',
  OK: 'full evacuation margin — all exits serviceable + crew minimum met + ELS 100pct',
  IDLE: 'on ground or non Part-25 type-certificated',
}

type Cls = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA' | 'FTR'
const CLS_NAME: Record<Cls, string> = {
  HVY: 'Heavy widebody',
  NRW: 'Narrowbody',
  RGN: 'Regional jet',
  BIZ: 'Business jet',
  TBP: 'Turboprop',
  GA: 'GA piston',
  FTR: 'Fighter / military',
}

// Per-class spec from FAA/EASA TCDS + FAR 25.807 / 25.803 cert demos
interface CabinSpec {
  paxMax: number
  certDem: number          // seconds demonstrated at cert
  exitPairs: number        // Type-A/B/C/I/II pairs
  overwingPairs: number    // Type-III over-wing pairs
  minFA: number            // FAR 121.391 minimum
  part25: boolean
  cfg: string              // typical config
}
const SPEC: Record<Cls, CabinSpec> = {
  HVY: { paxMax: 410, certDem: 86, exitPairs: 5, overwingPairs: 0, minFA: 10, part25: true,  cfg: 'F+J+Y 3-class' },
  NRW: { paxMax: 189, certDem: 85, exitPairs: 2, overwingPairs: 1, minFA: 4,  part25: true,  cfg: 'J+Y 2-class' },
  RGN: { paxMax: 90,  certDem: 78, exitPairs: 1, overwingPairs: 1, minFA: 2,  part25: true,  cfg: 'Y single-class' },
  BIZ: { paxMax: 19,  certDem: 0,  exitPairs: 1, overwingPairs: 1, minFA: 1,  part25: false, cfg: 'corp 8-12 pax' },
  TBP: { paxMax: 78,  certDem: 72, exitPairs: 1, overwingPairs: 1, minFA: 2,  part25: true,  cfg: 'Y single-class' },
  GA:  { paxMax: 4,   certDem: 0,  exitPairs: 1, overwingPairs: 0, minFA: 0,  part25: false, cfg: '4-seat single' },
  FTR: { paxMax: 1,   certDem: 0,  exitPairs: 0, overwingPairs: 0, minFA: 0,  part25: false, cfg: 'eject seat' },
}

interface Row {
  f: EgressFlight
  cls: Cls
  spec: CabinSpec
  loadFactor: number      // 0..1.10
  paxAboard: number
  exitsAvail: number      // 0..1 fraction
  exitSev: number
  loadSev: number
  cfgPenSec: number
  cfgSev: number
  faAboard: number
  crewSev: number
  elsCharge: number       // 0..1
  elsBroken: number
  elsSev: number
  tEvac: number           // seconds
  marginSec: number       // 90 - tEvac
  driver: string
  driverLong: string
  score: number
  tier: Tier
}

const DRIVER_LONG: Record<string, string> = {
  EXIT: 'Exit availability below 50pct — MEL deferral close-out blocks dispatch',
  LOAD: 'Pax load factor above 80pct lengthens stream-time per AERO Q3-2010',
  CFG:  'Multi-class cabin layout adds curtain / galley obstructions',
  CREW: 'Cabin crew below FAR 121.391 minimum',
  ELS:  'Emergency Lighting System ARP 4101 sub-spec for smoke visibility',
}

// FNV-1a 32-bit
function hashUnit(s: string, salt: string): number {
  let h = 0x811c9dc5
  const x = (salt + '|' + s)
  for (let i = 0; i < x.length; i++) {
    h ^= x.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h % 100000) / 100000
}

function classify(type?: string): Cls {
  const t = (type || '').toUpperCase()
  if (/^(B77|B78|B74|B76|A33|A34|A35|A38|MD11)/.test(t)) return 'HVY'
  if (/^(B73|A31|A32|A22|MD8|MD9)/.test(t)) return 'NRW'
  if (/^(CRJ|E17|E19|E29|AT[47])/.test(t)) return 'RGN'
  if (/^(GLF|GL|FA|F900|F2TH|CL|GLEX|G[56])/.test(t)) return 'BIZ'
  if (/^(DH8|AT4|BE|PA4|SF34|J32)/.test(t)) return 'TBP'
  if (/^(C1[5678]|SR2|PA28|DA40|DA42|PC12|TBM)/.test(t)) return 'GA'
  if (/^(F1[56]|F18|F22|F35|EUF|MIG|SU[2-3]|T[6-8])/.test(t)) return 'FTR'
  return 'NRW'
}

export default function Egress90Sec({ map, flights, onClose, onFly }: Props) {
  const [minFL, setMinFL] = useState(0)
  const [loadMul, setLoadMul] = useState(100)   // 50-110pct
  const [exitMul, setExitMul] = useState(100)   // 50-150pct (degraded MEL multiplier)
  const [elsMul, setElsMul] = useState(100)     // 50-200pct
  const [crewMul, setCrewMul] = useState(100)   // 50-200pct
  const [tierFilter, setTierFilter] = useState<Set<Tier>>(new Set())
  const [clsFilter, setClsFilter] = useState<Set<Cls>>(new Set())
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLASSES'>('AIRCRAFT')

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const lScale = loadMul / 100
    const exScale = exitMul / 100
    const elsScale = elsMul / 100
    const crewScale = crewMul / 100
    for (const f of flights) {
      const cls = classify(f.type)
      const spec = SPEC[cls]
      const altKft = f.altitudeFt / 1000

      // LOAD: hash-stable load factor 0.50-1.00 of paxMax
      const baseLF = 0.50 + hashUnit(f.icao, 'lf') * 0.50
      const loadFactor = Math.min(1.10, baseLF * lScale)
      const paxAboard = Math.round(spec.paxMax * loadFactor)
      const loadSev = Math.max(0, Math.min(100, (loadFactor - 0.80) / 0.20 * 60))

      // EXIT availability: hash-stable MEL deferral state
      const exitH = hashUnit(f.icao, 'exit')
      let exitsAvail: number
      if (exitH > 0.92) exitsAvail = 0.60       // 2 exits on MEL
      else if (exitH > 0.78) exitsAvail = 0.85  // 1 exit on MEL
      else exitsAvail = 1.00
      exitsAvail = Math.max(0.40, exitsAvail / Math.max(0.5, exScale))
      const exitSev = exitsAvail < 0.5 ? 100 :
                      exitsAvail < 0.7 ? 80 :
                      exitsAvail < 0.85 ? 50 :
                      exitsAvail < 1.0 ? 25 : 0

      // CFG: 3-class layout penalty
      const cfgH = hashUnit(f.icao, 'cfg')
      let cfgPenSec: number
      if (cls === 'HVY') cfgPenSec = 6 + cfgH * 8     // 6-14s
      else if (cls === 'NRW') cfgPenSec = 2 + cfgH * 4 // 2-6s
      else cfgPenSec = cfgH * 2
      const cfgSev = Math.min(100, cfgPenSec * 6)

      // CREW: hash-stable FA aboard 0..max+2 with possible sick-out
      const fH = hashUnit(f.icao, 'fa')
      const sickOut = fH > 0.85 ? 2 : fH > 0.70 ? 1 : 0
      const faAboard = Math.max(0, spec.minFA + Math.round(hashUnit(f.icao, 'fa2') * 2) - sickOut)
      const crewDeficit = Math.max(0, spec.minFA - faAboard)
      const crewSev = spec.minFA === 0 ? 0 : Math.min(100, crewDeficit * 40 / Math.max(0.5, crewScale))

      // ELS: battery charge + broken segments
      const elsCharge = Math.max(0.20, 0.5 + hashUnit(f.icao, 'els') * 0.5) / Math.max(0.5, elsScale)
      const elsBroken = Math.round(hashUnit(f.icao, 'elsb') * 12)
      const elsSev = (elsCharge < 0.60 ? 60 : elsCharge < 0.80 ? 30 : 0) + (elsBroken > 4 ? 30 : elsBroken > 2 ? 15 : 0)

      // Predicted evacuation time
      const lfPen = Math.max(0, (loadFactor - 0.80) * 0.65)      // 0..0.13
      const cfgPen = cfgPenSec / Math.max(1, spec.certDem)
      const crewPen = crewDeficit * 0.06
      const elsPen = elsBroken * 0.012 + (elsCharge < 0.6 ? 0.15 : 0)
      const baseDem = spec.certDem || 85
      const tEvac = baseDem * (1 + lfPen + cfgPen + crewPen + elsPen) / Math.max(0.4, exitsAvail)
      const marginSec = 90 - tEvac

      const parts: { name: string; sev: number }[] = [
        { name: 'EXIT', sev: exitSev },
        { name: 'LOAD', sev: loadSev },
        { name: 'CFG',  sev: cfgSev },
        { name: 'CREW', sev: crewSev },
        { name: 'ELS',  sev: elsSev },
      ]
      parts.sort((a, b) => b.sev - a.sev)
      const score = Math.max(parts[0].sev, tEvac > 105 ? 85 : tEvac > 90 ? 60 : tEvac > 80 ? 35 : 0)
      const driver = parts[0].name

      let tier: Tier
      if (!spec.part25 || f.ground || altKft * 10 < minFL) tier = 'IDLE'
      else if (score >= 80 || tEvac > 105) tier = 'NC'
      else if (score >= 55 || tEvac > 90) tier = 'TIGHT'
      else if (score >= 25 || tEvac > 80) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, cls, spec,
        loadFactor, paxAboard,
        exitsAvail, exitSev,
        loadSev,
        cfgPenSec, cfgSev,
        faAboard, crewSev,
        elsCharge, elsBroken, elsSev,
        tEvac, marginSec,
        driver, driverLong: DRIVER_LONG[driver] || driver,
        score, tier,
      })
    }
    return out
  }, [flights, minFL, loadMul, exitMul, elsMul, crewMul])

  const stats = useMemo(() => {
    const counts: Record<Tier, number> = { NC: 0, TIGHT: 0, WATCH: 0, OK: 0, IDLE: 0 }
    let sumT = 0, sumM = 0, n = 0, elsBadN = 0
    let worst: Row | null = null
    for (const r of rows) {
      counts[r.tier]++
      if (r.tier === 'IDLE') continue
      sumT += r.tEvac; sumM += r.marginSec; n++
      if (r.elsCharge < 0.6 || r.elsBroken > 4) elsBadN++
      if (!worst || r.score > worst.score) worst = r
    }
    return {
      counts,
      meanT: n ? sumT / n : 0,
      meanM: n ? sumM / n : 0,
      elsBadShare: n ? elsBadN / n : 0,
      worst,
    }
  }, [rows])

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter.size && !tierFilter.has(r.tier)) return false
      if (clsFilter.size && !clsFilter.has(r.cls)) return false
      if (q) {
        const blob = `${r.f.callsign || ''} ${r.f.type || ''} ${r.f.operator || ''}`.toUpperCase()
        if (!blob.includes(q)) return false
      }
      return true
    }).sort((a, b) => {
      const r = TIER_RANK[a.tier] - TIER_RANK[b.tier]
      if (r) return r
      return b.score - a.score
    })
  }, [rows, tierFilter, clsFilter, search])

  const classes = useMemo(() => {
    const grp: Record<Cls, Row[]> = { HVY: [], NRW: [], RGN: [], BIZ: [], TBP: [], GA: [], FTR: [] }
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      grp[r.cls].push(r)
    }
    return (Object.entries(grp) as [Cls, Row[]][])
      .filter(([, rs]) => rs.length)
      .map(([cls, rs]) => {
        const worstTier = rs.reduce<Tier>((a, b) => TIER_RANK[b.tier] < TIER_RANK[a] ? b.tier : a, 'OK')
        const meanScore = rs.reduce((s, r) => s + r.score, 0) / rs.length
        const meanT = rs.reduce((s, r) => s + r.tEvac, 0) / rs.length
        const worst = rs.reduce((a, b) => b.score > a.score ? b : a)
        const ncN = rs.filter(r => r.tier === 'NC').length
        return { cls, rs, worstTier, meanScore, meanT, worst, ncN }
      })
      .sort((a, b) => {
        const r = TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier]
        if (r) return r
        return b.rs.length - a.rs.length
      })
  }, [rows])

  // MapLibre overlay
  useEffect(() => {
    if (!map) return
    const SRC = 'ft-egress-src'
    const HALO = 'ft-egress-halo'
    const PIN = 'ft-egress-pin'
    const LBL = 'ft-egress-lbl'
    const REF_SRC = 'ft-egress-ref-src'
    const REF_LYR = 'ft-egress-ref-lyr'

    const features: GeoJSON.Feature[] = []
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      if (tierFilter.size && !tierFilter.has(r.tier)) continue
      if (clsFilter.size && !clsFilter.has(r.cls)) continue
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
        properties: {
          tier: r.tier,
          color: TIER_COLOR[r.tier],
          radius: 8 + (r.score / 100) * 14,
          label: `${r.f.callsign || r.f.icao} · ${r.driver} · ${r.tEvac.toFixed(0)}s`,
          isNc: r.tier === 'NC' ? 1 : 0,
        },
      })
    }
    const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features }

    const refFeatures: GeoJSON.Feature[] = []
    if (showRef) {
      for (const lat of [55, 35, 15, -15, -35, -55]) {
        for (let lon = -180; lon <= 180; lon += 12) {
          refFeatures.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: { mark: 1 },
          })
        }
      }
    }
    const refFc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: refFeatures }

    const addAll = () => {
      const existSrc = map.getSource(SRC) as maplibregl.GeoJSONSource | undefined
      if (existSrc) existSrc.setData(fc)
      else map.addSource(SRC, { type: 'geojson', data: fc })

      const existRef = map.getSource(REF_SRC) as maplibregl.GeoJSONSource | undefined
      if (existRef) existRef.setData(refFc)
      else map.addSource(REF_SRC, { type: 'geojson', data: refFc })

      if (showHalo && !map.getLayer(HALO)) {
        map.addLayer({
          id: HALO, source: SRC, type: 'circle',
          paint: {
            'circle-radius': ['get', 'radius'],
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.15,
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-width': 1.4,
            'circle-stroke-opacity': 0.85,
          },
        })
      }
      if (!showHalo && map.getLayer(HALO)) map.removeLayer(HALO)

      if (showPin && !map.getLayer(PIN)) {
        map.addLayer({
          id: PIN, source: SRC, type: 'circle',
          filter: ['==', ['get', 'isNc'], 1],
          paint: {
            'circle-radius': 6,
            'circle-color': '#f43f5e',
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 1.5,
          },
        })
      }
      if (!showPin && map.getLayer(PIN)) map.removeLayer(PIN)

      if (showLbl && !map.getLayer(LBL)) {
        map.addLayer({
          id: LBL, source: SRC, type: 'symbol',
          filter: ['!=', ['get', 'tier'], 'OK'],
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 10,
            'text-offset': [0, 1.4],
            'text-anchor': 'top',
            'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
          },
          paint: {
            'text-color': ['get', 'color'],
            'text-halo-color': '#020617',
            'text-halo-width': 1.4,
          },
        })
      }
      if (!showLbl && map.getLayer(LBL)) map.removeLayer(LBL)

      if (showRef && !map.getLayer(REF_LYR)) {
        map.addLayer({
          id: REF_LYR, source: REF_SRC, type: 'circle',
          paint: {
            'circle-radius': 2,
            'circle-color': '#f59e0b',
            'circle-opacity': 0.40,
            'circle-stroke-width': 0,
          },
        })
      }
      if (!showRef && map.getLayer(REF_LYR)) map.removeLayer(REF_LYR)
    }

    if (map.isStyleLoaded()) addAll()
    else map.once('load', addAll)

    return () => {
      for (const l of [LBL, PIN, HALO, REF_LYR]) if (map.getLayer(l)) map.removeLayer(l)
      for (const s of [SRC, REF_SRC]) if (map.getSource(s)) map.removeSource(s)
    }
  }, [map, rows, tierFilter, clsFilter, showHalo, showPin, showLbl, showRef])

  const toggleSet = <T,>(s: Set<T>, v: T): Set<T> => {
    const n = new Set(s); if (n.has(v)) n.delete(v); else n.add(v); return n
  }

  // SVG scatter: T_evac vs load factor
  const xMin = 0.5, xMax = 1.10, yMin = 50, yMax = 130
  const w = 360, h = 180
  const px = (lf: number) => ((lf - xMin) / (xMax - xMin)) * w
  const py = (t: number) => h - ((t - yMin) / (yMax - yMin)) * h

  return (
    <div className="absolute top-4 right-4 z-40 w-[420px] max-h-[90vh] overflow-hidden bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl flex flex-col">
      <div className="sticky top-0 bg-slate-950/95 px-4 py-3 border-b border-slate-800 flex items-center justify-between shrink-0">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">14 CFR 25.803 / AC 25.803-1A · 90-sec Demo</div>
          <div className="text-sm font-semibold text-slate-100">Cabin Egress · Evacuation Compliance</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      <div className="overflow-y-auto px-4 py-3 space-y-3 text-xs">
        {/* Tier counter strip */}
        <div className="grid grid-cols-5 gap-1">
          {TIER_ORDER.map(t => (
            <button key={t}
              onClick={() => setTierFilter(s => toggleSet(s, t))}
              className={`px-1.5 py-1 rounded border text-[10px] transition ${tierFilter.has(t) ? 'bg-sky-500/15 border-sky-500/50' : 'bg-slate-900/50 border-slate-800 hover:border-slate-700'}`}
              style={{ borderLeftWidth: 3, borderLeftColor: TIER_COLOR[t] }}>
              <div className="font-semibold text-slate-100">{stats.counts[t]}</div>
              <div className="text-[9px] text-slate-500 truncate">{TIER_LABEL[t]}</div>
            </button>
          ))}
        </div>

        {/* Summary cells */}
        <div className="grid grid-cols-3 gap-1.5">
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-slate-500">MEAN T-EVAC</div>
            <div className={`font-mono ${stats.meanT > 105 ? 'text-rose-300' : stats.meanT > 90 ? 'text-amber-300' : stats.meanT > 80 ? 'text-sky-300' : 'text-emerald-300'}`}>
              {stats.meanT.toFixed(0)} s
            </div>
          </div>
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-slate-500">WORST</div>
            <div className="font-mono text-slate-100 truncate">
              {stats.worst ? `${stats.worst.f.callsign || stats.worst.f.icao} · ${stats.worst.driver}` : '—'}
            </div>
          </div>
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5" style={{ borderLeftWidth: 3, borderLeftColor: TIER_COLOR['NC'] }}>
            <div className="text-[9px] uppercase tracking-wider text-slate-500">NON-COMP</div>
            <div className="font-mono text-slate-100">{stats.counts['NC']}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-slate-500">MEAN MARGIN vs 90s</div>
            <div className={`font-mono ${stats.meanM < -15 ? 'text-rose-300' : stats.meanM < 0 ? 'text-amber-300' : stats.meanM < 10 ? 'text-sky-300' : 'text-emerald-300'}`}>
              {stats.meanM >= 0 ? '+' : ''}{stats.meanM.toFixed(0)} s
            </div>
          </div>
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-slate-500">ELS DEGRADED</div>
            <div className={`font-mono ${stats.elsBadShare >= 0.25 ? 'text-amber-300' : 'text-slate-100'}`}>
              {(stats.elsBadShare * 100).toFixed(0)}%
            </div>
          </div>
        </div>

        {/* SVG scatter */}
        {showDiag && (
          <div className="bg-slate-900/30 border border-slate-800 rounded p-1.5">
            <div className="flex justify-between items-center text-[9px] text-slate-500 mb-1">
              <span>T-EVAC × LOAD-FACTOR · FAR 25.803 90s floor</span>
              <span>rose &gt;105s</span>
            </div>
            <svg viewBox={`0 0 ${w} ${h + 22}`} className="w-full">
              {/* tier bands */}
              <rect x={0} y={py(130)} width={w} height={py(105) - py(130)} fill="#10b981" fillOpacity={0.08} />
              <rect x={0} y={py(90)}  width={w} height={py(80) - py(90)}   fill="#0ea5e9" fillOpacity={0.10} />
              <rect x={0} y={py(105)} width={w} height={py(90) - py(105)}  fill="#f59e0b" fillOpacity={0.10} />
              <rect x={0} y={0}        width={w} height={py(105)}           fill="#f43f5e" fillOpacity={0.10} />
              {/* dashed thresholds */}
              <line x1={0} x2={w} y1={py(90)}  y2={py(90)}  stroke="#f59e0b" strokeWidth={1} strokeDasharray="4 3" />
              <line x1={0} x2={w} y1={py(105)} y2={py(105)} stroke="#f43f5e" strokeWidth={1} strokeDasharray="4 3" />
              <line x1={0} x2={w} y1={py(80)}  y2={py(80)}  stroke="#0ea5e9" strokeWidth={0.7} strokeDasharray="2 4" />
              {/* grid */}
              {[60, 80, 100, 120].map(t => (
                <g key={'t' + t}>
                  <line x1={0} x2={w} y1={py(t)} y2={py(t)} stroke="#1e293b" strokeWidth={0.5} />
                  <text x={2} y={py(t) - 1} fontSize={7} fill="#475569">{t}s</text>
                </g>
              ))}
              {[0.5, 0.7, 0.9, 1.0].map(lf => (
                <g key={'lf' + lf}>
                  <line x1={px(lf)} x2={px(lf)} y1={0} y2={h} stroke="#1e293b" strokeWidth={0.5} />
                  <text x={px(lf) + 2} y={h - 2} fontSize={7} fill="#475569">{Math.round(lf * 100)}%</text>
                </g>
              ))}
              {/* dots */}
              {rows.filter(r => r.tier !== 'IDLE').slice(0, 800).map((r, i) => (
                <circle key={i}
                  cx={Math.max(0, Math.min(w, px(r.loadFactor)))}
                  cy={Math.max(0, Math.min(h, py(r.tEvac)))}
                  r={r.tier === 'NC' ? 3 : 2}
                  fill={TIER_COLOR[r.tier]} fillOpacity={0.85} />
              ))}
              {/* legend */}
              <g transform={`translate(0,${h + 4})`}>
                <text x={0} y={7} fontSize={8} fill="#f43f5e">▬ 105s gnd-stop</text>
                <text x={90} y={7} fontSize={8} fill="#f59e0b">▬ 90s FAR floor</text>
                <text x={185} y={7} fontSize={8} fill="#0ea5e9">▬ 80s watch</text>
              </g>
            </svg>
          </div>
        )}

        {/* Sliders */}
        <div className="grid grid-cols-2 gap-2">
          {[
            ['MIN-FL', minFL, setMinFL, 0, 400, ''],
            ['LOAD-MUL', loadMul, setLoadMul, 50, 110, '%'],
            ['EXIT-MUL', exitMul, setExitMul, 50, 150, '%'],
            ['ELS-MUL', elsMul, setElsMul, 50, 200, '%'],
          ].map(([lbl, val, setter, min, max, unit]: any) => (
            <label key={lbl} className="block">
              <div className="flex justify-between text-[9px] uppercase tracking-wider text-slate-500 mb-0.5">
                <span>{lbl}</span><span className="font-mono text-slate-300">{val}{unit}</span>
              </div>
              <input type="range" min={min} max={max} value={val} onChange={e => setter(Number(e.target.value))}
                className="w-full accent-sky-500" />
            </label>
          ))}
        </div>
        <label className="block">
          <div className="flex justify-between text-[9px] uppercase tracking-wider text-slate-500 mb-0.5">
            <span>CREW-MUL</span><span className="font-mono text-slate-300">{crewMul}%</span>
          </div>
          <input type="range" min={50} max={200} value={crewMul} onChange={e => setCrewMul(Number(e.target.value))}
            className="w-full accent-sky-500" />
        </label>

        {/* Class filter */}
        <div className="flex gap-1 flex-wrap">
          {(Object.keys(CLS_NAME) as Cls[]).map(c => (
            <button key={c} onClick={() => setClsFilter(s => toggleSet(s, c))}
              title={CLS_NAME[c]}
              className={`px-1.5 py-0.5 rounded border text-[10px] transition ${clsFilter.has(c) ? 'bg-sky-500/15 border-sky-500/50 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-300 hover:border-slate-700'}`}>
              {c}
            </button>
          ))}
        </div>

        {/* Layer toggles + search */}
        <div className="flex items-center gap-1 flex-wrap">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['REF', showRef, setShowRef],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lbl, on, set]: any) => (
            <button key={lbl} onClick={() => set((v: boolean) => !v)}
              className={`px-1.5 py-0.5 rounded border text-[10px] ${on ? 'bg-sky-500/15 border-sky-500/50 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400'}`}>
              {lbl}
            </button>
          ))}
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search"
            className="flex-1 min-w-0 bg-slate-900/50 border border-slate-800 rounded px-2 py-0.5 text-[11px] text-slate-100 placeholder-slate-600" />
        </div>

        {/* Tab switcher */}
        <div className="flex gap-1">
          {(['AIRCRAFT', 'CLASSES'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 rounded border text-[10px] ${tab === t ? 'bg-sky-500/15 border-sky-500/50 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400'}`}>
              {t}
            </button>
          ))}
        </div>

        {/* Aircraft tab */}
        {tab === 'AIRCRAFT' && (
          <div className="space-y-1.5">
            {filtered.slice(0, 100).map(r => {
              const tc = TIER_COLOR[r.tier]
              return (
                <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
                  className="w-full text-left bg-slate-900/50 hover:bg-slate-800/70 border border-slate-800 hover:border-slate-700 rounded p-2 transition"
                  style={{ borderLeftWidth: 3, borderLeftColor: tc }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-mono text-slate-100 text-[11px] truncate flex-1">
                      {r.f.callsign || r.f.icao}
                      <span className="text-slate-500 ml-1">{r.f.type || ''}</span>
                    </div>
                    <span className="text-[9px] px-1 py-0.5 rounded border" style={{ color: tc, borderColor: tc + '80' }}>{r.cls}</span>
                    <span className="text-[9px] px-1 py-0.5 rounded font-semibold" style={{ color: tc, background: tc + '22', border: `1px solid ${tc}66` }}>{TIER_LABEL[r.tier]}</span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] mt-0.5">
                    <span className="font-mono text-slate-400">
                      pax {r.paxAboard}/{r.spec.paxMax} ({(r.loadFactor * 100).toFixed(0)}%) · T-evac <span style={{ color: r.tEvac > 105 ? '#f43f5e' : r.tEvac > 90 ? '#f59e0b' : r.tEvac > 80 ? '#0ea5e9' : '#10b981' }}>{r.tEvac.toFixed(0)}s</span> · marg <span style={{ color: r.marginSec < -15 ? '#f43f5e' : r.marginSec < 0 ? '#f59e0b' : r.marginSec < 10 ? '#0ea5e9' : '#10b981' }}>{r.marginSec >= 0 ? '+' : ''}{r.marginSec.toFixed(0)}s</span>
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 bg-slate-800 rounded relative overflow-hidden">
                    <div className="h-full rounded" style={{ width: `${r.score}%`, background: tc, opacity: 0.85 }} />
                    {[25, 55, 80].map(t => (
                      <div key={t} className="absolute top-0 bottom-0 w-px bg-slate-600" style={{ left: `${t}%` }} />
                    ))}
                  </div>
                  <div className="grid grid-cols-5 gap-0.5 mt-1">
                    {[
                      ['EXT', r.exitSev],
                      ['LOA', r.loadSev],
                      ['CFG', r.cfgSev],
                      ['CRW', r.crewSev],
                      ['ELS', r.elsSev],
                    ].map(([k, v]: any) => {
                      const c = v >= 80 ? TIER_COLOR.NC : v >= 55 ? TIER_COLOR.TIGHT : v >= 25 ? TIER_COLOR.WATCH : TIER_COLOR.OK
                      return (
                        <div key={k} className="text-center text-[8px] py-0.5 rounded" style={{ background: c + '22', color: c, border: `1px solid ${c}44` }}>
                          {k} {v.toFixed(0)}
                        </div>
                      )
                    })}
                  </div>
                  <div className="flex items-center justify-between text-[9px] mt-1 text-slate-500">
                    <span className="font-mono">
                      <span className={r.exitsAvail < 0.85 ? 'text-amber-400' : ''}>EXIT {(r.exitsAvail * 100).toFixed(0)}%</span>
                      {' · '}
                      <span className={r.faAboard < r.spec.minFA ? 'text-rose-400' : ''}>FA {r.faAboard}/{r.spec.minFA}</span>
                      {' · '}
                      <span className={r.elsCharge < 0.6 ? 'text-rose-400' : r.elsCharge < 0.8 ? 'text-amber-400' : ''}>ELS {(r.elsCharge * 100).toFixed(0)}%</span>
                      {r.elsBroken > 0 && <span className={r.elsBroken > 4 ? ' text-rose-400' : ' text-slate-500'}> / {r.elsBroken} brk</span>}
                    </span>
                    <span className="truncate ml-1">{r.f.operator || ''}</span>
                  </div>
                  <div className="text-[9px] mt-0.5" style={{ color: tc }}>› {r.driverLong} · {TIER_ADVICE[r.tier]}</div>
                </button>
              )
            })}
            {!filtered.length && (
              <div className="text-center text-slate-500 py-4 text-[11px]">No aircraft match filters</div>
            )}
          </div>
        )}

        {/* Classes tab */}
        {tab === 'CLASSES' && (
          <div className="space-y-1.5">
            {classes.map(c => {
              const tc = TIER_COLOR[c.worstTier]
              return (
                <button key={c.cls} onClick={() => onFly(c.worst.f.icao)}
                  className="w-full text-left bg-slate-900/50 hover:bg-slate-800/70 border border-slate-800 hover:border-slate-700 rounded p-2 transition"
                  style={{ borderLeftWidth: 3, borderLeftColor: tc }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 flex-1 min-w-0">
                      <span className="text-[9px] px-1 py-0.5 rounded border font-mono" style={{ color: tc, borderColor: tc + '80' }}>{c.cls}</span>
                      <span className="text-slate-100 text-[11px] truncate">{CLS_NAME[c.cls]}</span>
                    </div>
                    <span className="text-[10px] font-mono text-slate-400">{c.rs.length} ac</span>
                    <span className="text-[9px] px-1 py-0.5 rounded font-semibold" style={{ color: tc, background: tc + '22', border: `1px solid ${tc}66` }}>{TIER_LABEL[c.worstTier]}</span>
                  </div>
                  <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                    mean score <span style={{ color: tc }}>{c.meanScore.toFixed(0)}</span>
                    {' · '}mean T-evac <span style={{ color: c.meanT > 105 ? '#f43f5e' : c.meanT > 90 ? '#f59e0b' : c.meanT > 80 ? '#0ea5e9' : '#10b981' }}>{c.meanT.toFixed(0)}s</span>
                    {' · '}NC <span style={{ color: c.ncN > 0 ? '#f43f5e' : '#64748b' }}>{c.ncN}</span>
                  </div>
                  <div className="mt-1 h-1.5 bg-slate-800 rounded relative overflow-hidden">
                    <div className="h-full rounded" style={{ width: `${c.meanScore}%`, background: tc, opacity: 0.85 }} />
                    {[25, 55, 80].map(t => (
                      <div key={t} className="absolute top-0 bottom-0 w-px bg-slate-600" style={{ left: `${t}%` }} />
                    ))}
                  </div>
                  <div className="text-[9px] mt-1 text-slate-500 font-mono">
                    paxMax {SPEC[c.cls].paxMax} · certDem {SPEC[c.cls].certDem}s · {SPEC[c.cls].exitPairs} exit-pair + {SPEC[c.cls].overwingPairs} ovwg · min FA {SPEC[c.cls].minFA} · {SPEC[c.cls].cfg}
                  </div>
                  <div className="text-[9px] mt-0.5" style={{ color: tc }}>› worst {c.worst.f.callsign || c.worst.f.icao} score {c.worst.score.toFixed(0)} · {TIER_ADVICE[c.worstTier]}</div>
                </button>
              )
            })}
            {!classes.length && (
              <div className="text-center text-slate-500 py-4 text-[11px]">No active Part-25 classes</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
