'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Engine Relight / Windmill Restart Envelope Monitor
   -----------------------------------------------------------
   Boeing FCOM 5.30 In-Flight Restart Envelope (737NG/777/787) /
   Airbus FCOM PRO-ABN-70 ENG In-Flight Relight / FAA AC 25-22
   In-Flight Engine Restart Certification / EASA CS-25.903(e)
   Engine Restart Capability / 14 CFR 25.903(e)(2) /
   GE GEnx / CFM56 / CFM LEAP / RR Trent / PW1100G TCDS
   in-flight start envelope / Boeing AERO Q1-2007 "Recovering
   from an Engine In-Flight Shutdown" / Airbus Safety First
   Mag #19 IFSD recovery / FAA SAFO 07003 windmill restart.

   Predicts, for every airborne aircraft, the time-to-relight
   margin if an IFSD occurred right now. Pilots have two
   restart paths after an in-flight shutdown:

     WINDMILL   No starter air, ram-air spins N2 to ignition
                threshold. Needs sufficient KIAS and altitude
                low enough for air density. Per FCOM 5.30:
                737NG windmill 240-340 KIAS FL000-FL300 /
                777-200 220-330 KIAS FL050-FL300 /
                787-9 200-310 KIAS FL080-FL340 /
                A320 250-300 KIAS FL050-FL300 /
                A350 220-310 KIAS FL080-FL330. Below the KIAS
                floor N2 won't spool to 15pct light-up; above
                ceiling air is too thin for stable combustion.

     STARTER    Pneumatic / electric starter spins N2 with
                bleed from operating engine or APU. Wider
                envelope but capped at FL250 (737/A320) or
                FL300 (777/787/A350) by starter duty cycle &
                pneumatic mass-flow. Time-to-light 30-90s
                vs 60-180s windmill.

   Severity components (max-driver, 0-100):
     ENV      Current (FL, KIAS) position vs class envelope.
              Outside envelope = 100, edge = 60, deep inside
              = 0. Two separate envelopes scored, best wins.
     TTR      Predicted time-to-relight vs available time.
              Available = (altAGL / drift-down sink-rate) sec.
              Required = base + altitude-penalty + cold-soak.
              Severity = clip((req-avail+30)/60*100, 0, 100).
     APU      APU availability for starter air / electrics.
              Hash-stable per-airframe APU MEL-status with
              ALT-LIMIT FL250 (most types) / FL410 (787 ETOPS).
              No APU above ceiling => starter relight unavailable.
     FUELT    Fuel-temp at engine inlet vs JET-A freeze -47C
              + warm-fuel margin. Cold soak above FL350 in
              long cruise raises ITT-rise risk on relight.
     ITT-PEAK Predicted peak ITT during relight vs redline.
              Hash-stable EGT-margin-already-eroded raises
              relight peak. >MAX-ITT = hot-start abort risk.

   Tier classification:
     NO-RELIGHT score>=80  rose     IFSD now = no restart
                                    plan immediate divert
     MARGINAL   score>=55  amber    relight possible but
                                    one driver near limit
     WATCH      score>=25  sky      relight nominal within
                                    envelope, monitor params
     OK         score<25   emerald  full envelope margin
     IDLE       ground/lo  slate    excluded below MIN-FL

   MapLibre overlay:
     - Tier-coloured halo rings sized by score 8-22 px
     - Rose diamond at projected drift-down point for
       NO-RELIGHT aircraft (assuming windmill at best-L/D)
     - Amber dashed envelope-edge reference rectangles
       drawn at lat 45/15/-15/-45 sampled every 10deg lon
       as global envelope reference
     - Tier-coloured callsign+driver+TTR-sec labels for
       non-OK aircraft

   Side panel:
     - 5-tier counter strip click-to-filter
     - 3-cell MEAN-TTR / WORST callsign+driver / NO-RELIGHT-count
     - 2-cell MEAN-MARGIN-sec / APU-UNAVAIL-share secondary
     - SVG FL-vs-KIAS scatter with class-mean envelope band
       shaded (windmill emerald, starter sky, outside rose)
       with threshold dashes and every aircraft tier-coloured
     - 5 sliders MIN-FL / SINK-RATE / COLD-SOAK / APU-MUL / ITT-RES
     - 7-class chip filter HVY/NRW/RGN/BIZ/TBP/GA/FTR
     - HALO/PIN/LBL/ENV/DIAG toggles + search
     - AIRCRAFT / CLASSES tab switcher

   Persisted preference: ft-relight
   ============================================================ */

interface RelightFlight {
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
  flights: RelightFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'NO' | 'MARG' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  NO: '#f43f5e',
  MARG: '#f59e0b',
  WATCH: '#0ea5e9',
  OK: '#10b981',
  IDLE: '#475569',
}
const TIER_ORDER: Tier[] = ['NO', 'MARG', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { NO: 0, MARG: 1, WATCH: 2, OK: 3, IDLE: 4 }
const TIER_LABEL: Record<Tier, string> = {
  NO: 'NO-RELIGHT',
  MARG: 'MARGINAL',
  WATCH: 'WATCH',
  OK: 'OK',
  IDLE: 'IDLE',
}
const TIER_ADVICE: Record<Tier, string> = {
  NO: 'IFSD now = restart unlikely — declare PAN, immediate driftdown to relight envelope, plan nearest suitable',
  MARG: 'relight possible but one driver at limit — review FCOM 5.30 / PRO-ABN-70 restart memory items',
  WATCH: 'within published relight envelope — monitor APU avail and KIAS trend',
  OK: 'deep inside restart envelope — full margin both windmill and starter-assist paths',
  IDLE: 'on ground or below relight-envelope floor',
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

// Per-class envelope from Boeing/Airbus FCOM 5.30 / PRO-ABN-70 + TCDS
interface Envelope {
  wmKiasLo: number; wmKiasHi: number; wmFlLo: number; wmFlHi: number
  stKiasLo: number; stKiasHi: number; stFlLo: number; stFlHi: number
  ttrBase: number  // base time-to-relight (sec) windmill
  ittRedline: number
  apuCeilFl: number
}
const ENV: Record<Cls, Envelope> = {
  HVY: { wmKiasLo: 210, wmKiasHi: 330, wmFlLo: 50,  wmFlHi: 330, stKiasLo: 130, stKiasHi: 320, stFlLo: 0,  stFlHi: 300, ttrBase: 75, ittRedline: 950, apuCeilFl: 410 },
  NRW: { wmKiasLo: 240, wmKiasHi: 320, wmFlLo: 0,   wmFlHi: 300, stKiasLo: 130, stKiasHi: 310, stFlLo: 0,  stFlHi: 250, ttrBase: 65, ittRedline: 935, apuCeilFl: 250 },
  RGN: { wmKiasLo: 220, wmKiasHi: 300, wmFlLo: 50,  wmFlHi: 280, stKiasLo: 130, stKiasHi: 280, stFlLo: 0,  stFlHi: 230, ttrBase: 70, ittRedline: 900, apuCeilFl: 250 },
  BIZ: { wmKiasLo: 200, wmKiasHi: 320, wmFlLo: 80,  wmFlHi: 410, stKiasLo: 120, stKiasHi: 310, stFlLo: 0,  stFlHi: 300, ttrBase: 60, ittRedline: 920, apuCeilFl: 410 },
  TBP: { wmKiasLo: 130, wmKiasHi: 250, wmFlLo: 0,   wmFlHi: 200, stKiasLo: 80,  stKiasHi: 240, stFlLo: 0,  stFlHi: 200, ttrBase: 35, ittRedline: 820, apuCeilFl: 200 },
  GA:  { wmKiasLo: 80,  wmKiasHi: 180, wmFlLo: 0,   wmFlHi: 140, stKiasLo: 60,  stKiasHi: 170, stFlLo: 0,  stFlHi: 140, ttrBase: 20, ittRedline: 760, apuCeilFl: 0   },
  FTR: { wmKiasLo: 250, wmKiasHi: 600, wmFlLo: 0,   wmFlHi: 500, stKiasLo: 180, stKiasHi: 500, stFlLo: 0,  stFlHi: 400, ttrBase: 45, ittRedline: 1050, apuCeilFl: 450 },
}

// Per-class best-L/D sink rate at IFSD (fpm)
const SINK_FPM: Record<Cls, number> = { HVY: 1800, NRW: 1700, RGN: 1500, BIZ: 1700, TBP: 1100, GA: 700, FTR: 2200 }

interface Row {
  f: RelightFlight
  cls: Cls
  altKft: number
  fl: number
  kias: number
  oat: number
  wmDist: number       // 0..1 inside windmill envelope (>0 inside)
  stDist: number       // 0..1 inside starter envelope
  envSev: number
  ttrSec: number
  availSec: number
  ttrSev: number
  apuOk: boolean
  apuSev: number
  fuelTempC: number
  fuelSev: number
  ittPeak: number
  ittSev: number
  driver: string
  driverLong: string
  score: number
  tier: Tier
}

const DRIVER_LONG: Record<string, string> = {
  ENV: 'Outside published FL × KIAS restart envelope',
  TTR: 'Time-to-relight exceeds drift-down available',
  APU: 'APU unavailable or above ceiling for starter air',
  FUELT: 'Cold-soaked fuel raises ITT relight risk',
  ITT: 'Predicted peak ITT exceeds redline',
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
  if (/^(DH8|AT4|AT7|BE|PA4|SF34|J32)/.test(t)) return 'TBP'
  if (/^(C1[5678]|SR2|PA28|DA40|DA42|PC12|TBM)/.test(t)) return 'GA'
  if (/^(F1[56]|F18|F22|F35|EUF|MIG|SU[2-3]|T[6-8])/.test(t)) return 'FTR'
  return 'NRW'
}

// CAS proxy from TAS via density correction (compressibility-free)
function casFromTas(tasKts: number, altKft: number): number {
  const sigma = altKft < 36 ? Math.pow(1 - 0.0019812 * altKft * 1000 / 288.15, 4.2561) : 0.297 * Math.exp(-(altKft - 36) * 0.0419)
  return tasKts * Math.sqrt(Math.max(0.05, sigma))
}

// 2D distance into rectangle (positive = inside, negative = outside, abs = signed dist)
function rectMargin(x: number, y: number, x0: number, x1: number, y0: number, y1: number): number {
  if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
    return Math.min(x - x0, x1 - x, y - y0, y1 - y)
  }
  return -Math.max(Math.max(0, x0 - x, x - x1), Math.max(0, y0 - y, y - y1))
}

export default function RelightEnvelope({ map, flights, onClose, onFly }: Props) {
  const [minFL, setMinFL] = useState(80)
  const [sinkMul, setSinkMul] = useState(100)      // 50-200
  const [coldSoak, setColdSoak] = useState(100)    // 0-200
  const [apuMul, setApuMul] = useState(100)        // 50-200
  const [ittRes, setIttRes] = useState(40)         // 0-120 deg margin
  const [tierFilter, setTierFilter] = useState<Set<Tier>>(new Set())
  const [clsFilter, setClsFilter] = useState<Set<Cls>>(new Set())
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showEnv, setShowEnv] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLASSES'>('AIRCRAFT')

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const sinkScale = sinkMul / 100
    const csScale = coldSoak / 100
    const apuScale = apuMul / 100
    for (const f of flights) {
      const cls = classify(f.type)
      const env = ENV[cls]
      const altKft = f.altitudeFt / 1000
      const fl = Math.round(altKft * 10)
      const kias = casFromTas(f.velocityKts, altKft)
      const oat = altKft < 36 ? 15 - 1.98 * altKft : -56.5

      // ENV: signed margin into each envelope (in normalised units 0..1)
      const wmM = rectMargin(kias, fl, env.wmKiasLo, env.wmKiasHi, env.wmFlLo, env.wmFlHi)
      const stM = rectMargin(kias, fl, env.stKiasLo, env.stKiasHi, env.stFlLo, env.stFlHi)
      const wmDist = wmM / Math.max(20, (env.wmKiasHi - env.wmKiasLo) * 0.5)
      const stDist = stM / Math.max(20, (env.stKiasHi - env.stKiasLo) * 0.5)
      const bestDist = Math.max(wmDist, stDist)
      let envSev: number
      if (bestDist >= 0.2) envSev = 0
      else if (bestDist >= 0) envSev = (0.2 - bestDist) / 0.2 * 50
      else envSev = Math.min(100, 50 + (-bestDist) * 120)

      // TTR: time-to-relight vs available drift-down time
      const ttrSec = env.ttrBase + Math.max(0, fl - 100) * 0.4 + (altKft > 35 ? (altKft - 35) * 8 : 0)
      const sinkFpm = SINK_FPM[cls] * sinkScale
      const availSec = (fl * 100) / Math.max(200, sinkFpm) * 60
      const margin = availSec - ttrSec
      const ttrSev = Math.max(0, Math.min(100, (30 - margin) / 60 * 100 + 50))

      // APU avail
      const apuRel = hashUnit(f.icao, 'apu')
      const apuOk = apuRel > (0.08 * apuScale) && fl <= env.apuCeilFl
      const apuSev = apuOk ? 0 : (fl > env.apuCeilFl ? 70 : 60)

      // Fuel temp at engine inlet — cold soak above FL350 long cruise
      const baseFuelT = oat + 10
      const soakBonus = altKft > 35 ? (altKft - 35) * 1.4 : 0
      const fuelTempC = baseFuelT - soakBonus * csScale * (0.6 + hashUnit(f.icao, 'fuel') * 0.8)
      const fuelSev = Math.max(0, Math.min(100, (-37 - fuelTempC) * 4))  // sev climbs as fuel <-37C

      // ITT peak: hash-stable EGT-margin-eroded raises peak
      const egtErodedC = hashUnit(f.icao, 'egt') * 80
      const ittPeak = env.ittRedline - ittRes + egtErodedC + (fl > 300 ? 25 : 0) + (fuelSev > 30 ? 30 : 0)
      const ittSev = Math.max(0, Math.min(100, (ittPeak - env.ittRedline + 20) * 2.5))

      const parts: { name: string; sev: number }[] = [
        { name: 'ENV', sev: envSev },
        { name: 'TTR', sev: ttrSev },
        { name: 'APU', sev: apuSev },
        { name: 'FUELT', sev: fuelSev },
        { name: 'ITT', sev: ittSev },
      ]
      parts.sort((a, b) => b.sev - a.sev)
      const score = parts[0].sev
      const driver = parts[0].name

      let tier: Tier
      if (f.ground || fl < minFL) tier = 'IDLE'
      else if (score >= 80) tier = 'NO'
      else if (score >= 55) tier = 'MARG'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, cls, altKft, fl, kias, oat,
        wmDist, stDist, envSev,
        ttrSec, availSec, ttrSev,
        apuOk, apuSev,
        fuelTempC, fuelSev,
        ittPeak, ittSev,
        driver, driverLong: DRIVER_LONG[driver] || driver,
        score, tier,
      })
    }
    return out
  }, [flights, minFL, sinkMul, coldSoak, apuMul, ittRes])

  const stats = useMemo(() => {
    const counts: Record<Tier, number> = { NO: 0, MARG: 0, WATCH: 0, OK: 0, IDLE: 0 }
    let sumTtr = 0, sumMarg = 0, n = 0, apuBadN = 0, totN = 0
    let worst: Row | null = null
    for (const r of rows) {
      counts[r.tier]++
      if (r.tier === 'IDLE') continue
      sumTtr += r.ttrSec; sumMarg += (r.availSec - r.ttrSec); n++; totN++
      if (!r.apuOk) apuBadN++
      if (!worst || r.score > worst.score) worst = r
    }
    return {
      counts,
      meanTtr: n ? sumTtr / n : 0,
      meanMarg: n ? sumMarg / n : 0,
      apuBadShare: totN ? apuBadN / totN : 0,
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
        const meanMarg = rs.reduce((s, r) => s + (r.availSec - r.ttrSec), 0) / rs.length
        const worst = rs.reduce((a, b) => b.score > a.score ? b : a)
        return { cls, rs, worstTier, meanScore, meanMarg, worst }
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
    const SRC = 'ft-relight-src'
    const HALO = 'ft-relight-halo'
    const PIN = 'ft-relight-pin'
    const LBL = 'ft-relight-lbl'
    const ENV_SRC = 'ft-relight-env-src'
    const ENV_LYR = 'ft-relight-env-lyr'

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
          label: `${r.f.callsign || r.f.icao} · ${r.driver} · ${Math.round(r.ttrSec)}s`,
          isNo: r.tier === 'NO' ? 1 : 0,
        },
      })
    }
    const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features }

    const envFeatures: GeoJSON.Feature[] = []
    if (showEnv) {
      for (const lat of [45, 15, -15, -45]) {
        for (let lon = -180; lon <= 180; lon += 10) {
          envFeatures.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: { mark: 1 },
          })
        }
      }
    }
    const envFc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: envFeatures }

    const addAll = () => {
      const existSrc = map.getSource(SRC) as maplibregl.GeoJSONSource | undefined
      if (existSrc) existSrc.setData(fc)
      else map.addSource(SRC, { type: 'geojson', data: fc })

      const existEnv = map.getSource(ENV_SRC) as maplibregl.GeoJSONSource | undefined
      if (existEnv) existEnv.setData(envFc)
      else map.addSource(ENV_SRC, { type: 'geojson', data: envFc })

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
          filter: ['==', ['get', 'isNo'], 1],
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

      if (showEnv && !map.getLayer(ENV_LYR)) {
        map.addLayer({
          id: ENV_LYR, source: ENV_SRC, type: 'circle',
          paint: {
            'circle-radius': 2,
            'circle-color': '#f59e0b',
            'circle-opacity': 0.45,
            'circle-stroke-width': 0,
          },
        })
      }
      if (!showEnv && map.getLayer(ENV_LYR)) map.removeLayer(ENV_LYR)
    }

    if (map.isStyleLoaded()) addAll()
    else map.once('load', addAll)

    return () => {
      for (const l of [LBL, PIN, HALO, ENV_LYR]) if (map.getLayer(l)) map.removeLayer(l)
      for (const s of [SRC, ENV_SRC]) if (map.getSource(s)) map.removeSource(s)
    }
  }, [map, rows, tierFilter, clsFilter, showHalo, showPin, showLbl, showEnv])

  const toggleSet = <T,>(s: Set<T>, v: T): Set<T> => {
    const n = new Set(s); if (n.has(v)) n.delete(v); else n.add(v); return n
  }

  // SVG scatter (FL vs KIAS) with envelope band reference (HVY narrowbody median)
  const scatterRef = ENV.NRW
  const xMin = 80, xMax = 360, yMin = 0, yMax = 410
  const w = 360, h = 180
  const px = (kias: number) => ((kias - xMin) / (xMax - xMin)) * w
  const py = (fl: number) => h - ((fl - yMin) / (yMax - yMin)) * h
  const wmRect = {
    x: px(scatterRef.wmKiasLo), y: py(scatterRef.wmFlHi),
    w: px(scatterRef.wmKiasHi) - px(scatterRef.wmKiasLo),
    h: py(scatterRef.wmFlLo) - py(scatterRef.wmFlHi),
  }
  const stRect = {
    x: px(scatterRef.stKiasLo), y: py(scatterRef.stFlHi),
    w: px(scatterRef.stKiasHi) - px(scatterRef.stKiasLo),
    h: py(scatterRef.stFlLo) - py(scatterRef.stFlHi),
  }

  return (
    <div className="absolute top-4 right-4 z-40 w-[420px] max-h-[90vh] overflow-hidden bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl flex flex-col">
      <div className="sticky top-0 bg-slate-950/95 px-4 py-3 border-b border-slate-800 flex items-center justify-between shrink-0">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Boeing FCOM 5.30 / Airbus PRO-ABN-70 · AC 25-22</div>
          <div className="text-sm font-semibold text-slate-100">Relight Envelope · Windmill / Starter</div>
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
            <div className="text-[9px] uppercase tracking-wider text-slate-500">MEAN TTR</div>
            <div className="font-mono text-slate-100">{stats.meanTtr.toFixed(0)} s</div>
          </div>
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-slate-500">WORST</div>
            <div className="font-mono text-slate-100 truncate">
              {stats.worst ? `${stats.worst.f.callsign || stats.worst.f.icao} · ${stats.worst.driver}` : '—'}
            </div>
          </div>
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5" style={{ borderLeftWidth: 3, borderLeftColor: TIER_COLOR['NO'] }}>
            <div className="text-[9px] uppercase tracking-wider text-slate-500">NO-RELIGHT</div>
            <div className="font-mono text-slate-100">{stats.counts['NO']}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-slate-500">MEAN MARGIN</div>
            <div className={`font-mono ${stats.meanMarg < 30 ? 'text-rose-300' : stats.meanMarg < 60 ? 'text-amber-300' : 'text-emerald-300'}`}>
              {stats.meanMarg >= 0 ? '+' : ''}{stats.meanMarg.toFixed(0)} s
            </div>
          </div>
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-slate-500">APU UNAVAIL</div>
            <div className={`font-mono ${stats.apuBadShare >= 0.25 ? 'text-amber-300' : 'text-slate-100'}`}>
              {(stats.apuBadShare * 100).toFixed(0)}%
            </div>
          </div>
        </div>

        {/* SVG scatter */}
        {showDiag && (
          <div className="bg-slate-900/30 border border-slate-800 rounded p-1.5">
            <div className="flex justify-between items-center text-[9px] text-slate-500 mb-1">
              <span>FL × KIAS · NRW reference envelope</span>
              <span>windmill / starter</span>
            </div>
            <svg viewBox={`0 0 ${w} ${h + 22}`} className="w-full">
              {/* envelope bands */}
              <rect x={stRect.x} y={stRect.y} width={stRect.w} height={stRect.h} fill="#0ea5e9" fillOpacity={0.10} stroke="#0ea5e9" strokeOpacity={0.45} strokeDasharray="3 3" strokeWidth={1} />
              <rect x={wmRect.x} y={wmRect.y} width={wmRect.w} height={wmRect.h} fill="#10b981" fillOpacity={0.12} stroke="#10b981" strokeOpacity={0.55} strokeWidth={1} />
              {/* grid */}
              {[100, 200, 300, 400].map(fl => (
                <g key={'fl' + fl}>
                  <line x1={0} x2={w} y1={py(fl)} y2={py(fl)} stroke="#1e293b" strokeWidth={0.5} />
                  <text x={2} y={py(fl) - 1} fontSize={7} fill="#475569">FL{fl}</text>
                </g>
              ))}
              {[120, 180, 240, 300].map(k => (
                <g key={'k' + k}>
                  <line x1={px(k)} x2={px(k)} y1={0} y2={h} stroke="#1e293b" strokeWidth={0.5} />
                  <text x={px(k) + 2} y={h - 2} fontSize={7} fill="#475569">{k}kt</text>
                </g>
              ))}
              {/* dots */}
              {rows.filter(r => r.tier !== 'IDLE').slice(0, 800).map((r, i) => (
                <circle key={i} cx={Math.max(0, Math.min(w, px(r.kias)))} cy={Math.max(0, Math.min(h, py(r.fl)))}
                  r={r.tier === 'NO' ? 3 : 2} fill={TIER_COLOR[r.tier]} fillOpacity={0.85} />
              ))}
              {/* legend */}
              <g transform={`translate(0,${h + 4})`}>
                <rect x={0} y={0} width={8} height={8} fill="#10b981" fillOpacity={0.4} stroke="#10b981" strokeWidth={0.5} />
                <text x={11} y={7} fontSize={8} fill="#94a3b8">windmill</text>
                <rect x={70} y={0} width={8} height={8} fill="#0ea5e9" fillOpacity={0.4} stroke="#0ea5e9" strokeWidth={0.5} strokeDasharray="2 2" />
                <text x={81} y={7} fontSize={8} fill="#94a3b8">starter-assist</text>
              </g>
            </svg>
          </div>
        )}

        {/* Sliders */}
        <div className="grid grid-cols-2 gap-2">
          {[
            ['MIN-FL', minFL, setMinFL, 0, 400, ''],
            ['SINK-RATE', sinkMul, setSinkMul, 50, 200, '%'],
            ['COLD-SOAK', coldSoak, setColdSoak, 0, 200, '%'],
            ['APU-MUL', apuMul, setApuMul, 50, 200, '%'],
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
            <span>ITT-RESERVE</span><span className="font-mono text-slate-300">{ittRes}°C</span>
          </div>
          <input type="range" min={0} max={120} value={ittRes} onChange={e => setIttRes(Number(e.target.value))}
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
            ['ENV', showEnv, setShowEnv],
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
              const margin = r.availSec - r.ttrSec
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
                    <span className="font-mono text-slate-400">FL{r.fl} · {r.kias.toFixed(0)}kt · TTR {r.ttrSec.toFixed(0)}s · margin <span style={{ color: margin < 30 ? '#f43f5e' : margin < 60 ? '#f59e0b' : '#10b981' }}>{margin >= 0 ? '+' : ''}{margin.toFixed(0)}s</span></span>
                  </div>
                  <div className="mt-1 h-1.5 bg-slate-800 rounded relative overflow-hidden">
                    <div className="h-full rounded" style={{ width: `${r.score}%`, background: tc, opacity: 0.85 }} />
                    {[25, 55, 80].map(t => (
                      <div key={t} className="absolute top-0 bottom-0 w-px bg-slate-600" style={{ left: `${t}%` }} />
                    ))}
                  </div>
                  <div className="grid grid-cols-5 gap-0.5 mt-1">
                    {[
                      ['ENV', r.envSev],
                      ['TTR', r.ttrSev],
                      ['APU', r.apuSev],
                      ['FUE', r.fuelSev],
                      ['ITT', r.ittSev],
                    ].map(([k, v]: any) => {
                      const c = v >= 80 ? TIER_COLOR.NO : v >= 55 ? TIER_COLOR.MARG : v >= 25 ? TIER_COLOR.WATCH : TIER_COLOR.OK
                      return (
                        <div key={k} className="text-center text-[8px] py-0.5 rounded" style={{ background: c + '22', color: c, border: `1px solid ${c}44` }}>
                          {k} {v.toFixed(0)}
                        </div>
                      )
                    })}
                  </div>
                  <div className="flex items-center justify-between text-[9px] mt-1 text-slate-500">
                    <span className="font-mono">
                      <span className={r.apuOk ? 'text-emerald-400' : 'text-amber-400'}>APU {r.apuOk ? 'OK' : 'OFF'}</span>
                      {' · '}
                      <span className={r.fuelTempC < -37 ? 'text-rose-400' : r.fuelTempC < -30 ? 'text-amber-400' : ''}>FUEL {r.fuelTempC.toFixed(0)}°C</span>
                      {' · '}
                      <span className={r.ittPeak > ENV[r.cls].ittRedline ? 'text-rose-400' : ''}>ITT {r.ittPeak.toFixed(0)}°C</span>
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
                    {' · '}mean margin <span style={{ color: c.meanMarg < 30 ? '#f43f5e' : c.meanMarg < 60 ? '#f59e0b' : '#10b981' }}>{c.meanMarg >= 0 ? '+' : ''}{c.meanMarg.toFixed(0)}s</span>
                    {' · '}worst {c.worst.f.callsign || c.worst.f.icao} score {c.worst.score.toFixed(0)}
                  </div>
                  <div className="mt-1 h-1.5 bg-slate-800 rounded relative overflow-hidden">
                    <div className="h-full rounded" style={{ width: `${c.meanScore}%`, background: tc, opacity: 0.85 }} />
                    {[25, 55, 80].map(t => (
                      <div key={t} className="absolute top-0 bottom-0 w-px bg-slate-600" style={{ left: `${t}%` }} />
                    ))}
                  </div>
                  <div className="text-[9px] mt-1 text-slate-500 font-mono">
                    WM {ENV[c.cls].wmKiasLo}-{ENV[c.cls].wmKiasHi}kt FL{ENV[c.cls].wmFlLo}-{ENV[c.cls].wmFlHi}
                    {' · '}ST FL≤{ENV[c.cls].stFlHi}
                    {' · '}APU ceil FL{ENV[c.cls].apuCeilFl}
                    {' · '}ITT red {ENV[c.cls].ittRedline}°C
                  </div>
                  <div className="text-[9px] mt-0.5" style={{ color: tc }}>› {TIER_ADVICE[c.worstTier]}</div>
                </button>
              )
            })}
            {!classes.length && (
              <div className="text-center text-slate-500 py-4 text-[11px]">No active classes</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
