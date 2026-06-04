'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   DAA-WC · Detect-And-Avoid Well-Clear monitor
   ------------------------------------------------------------
   Per-pair UAS / OPA Well-Clear (DWC) violation predictor for
   integration of unmanned and optionally-piloted aircraft into
   non-segregated airspace, scoring each cooperative-intruder
   pair against the RTCA DO-365B / SC-228 MOPS Well-Clear volume
   defined by:
       · HMD    Horizontal Miss Distance projected to tCPA
       · DH     Vertical separation at tCPA
       · TauMOD modified-tau time-to-CPA with HMD* offset
       · DMOD   distance modification threshold
       · ZTHR   vertical threshold (ft)

   DWC violated when ALL of:
       |dh|    <  ZTHR
       tauMod  <  TauMOD  (and closing)
       HMD     <  DMOD
   per DO-365B §2.2.4.3.2.1.

   Layered alert ladder (per DO-365B Table 2-15):
       PREVENTIVE   warning ≥ 75s
       CORRECTIVE   maneuver ≥ 55s
       WARNING      immediate ≥ 25s loss of DAA WC
       LOWC         Loss-of-Well-Clear (already inside DWC volume)
       NMAC         Near-Mid-Air-Collision (< 500ft HMD & < 100ft DH)

   ACAS Xu / ACAS sXu coordination per DO-386 / DO-389
   FAA UAS in NAS ConOps v3.0, AC 90-114B ADS-B Out, AC 91-57C sUAS,
   ICAO RPAS Concept of Operations Doc 10019,
   EASA SORA v2.5, JARUS RPAS Manual.

   References:
     · RTCA DO-365B MOPS Detect-And-Avoid Systems §2.2.4.3
     · RTCA DO-366A MOPS Air-to-Air Radar
     · RTCA DO-386 / DO-389 ACAS Xu / sXu
     · RTCA SC-228 TOR
     · FAA UAS-NAS ConOps v3.0
     · FAA AC 90-114B ADS-B Out
     · FAA AC 91-57C Small UAS
     · FAA Order 8900.1 Vol 16 UAS
     · ICAO Doc 10019 RPAS Concept of Operations
     · ICAO Annex 2 Appendix 4 RPA
     · EASA SORA v2.5 Specific Operations Risk Assessment
     · JARUS RPAS Manual Issue 4
     · NASA UTM ConOps v2.0 / NASA TM-2020-220615 DAA test
     · NAS-NM-21-001 UAS integration roadmap
     · NTSB DCA15IA191 inadvertent UAS encounter
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'NMAC' | 'LOWC' | 'WARNING' | 'CORRECTIVE' | 'PREVENTIVE' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  NMAC: '#ef4444', LOWC: '#f43f5e', WARNING: '#fb7185', CORRECTIVE: '#f59e0b',
  PREVENTIVE: '#0ea5e9', WATCH: '#22d3ee', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['NMAC', 'LOWC', 'WARNING', 'CORRECTIVE', 'PREVENTIVE', 'WATCH', 'OK']
const TIER_RANK: Record<Tier, number> = { NMAC: 0, LOWC: 1, WARNING: 2, CORRECTIVE: 3, PREVENTIVE: 4, WATCH: 5, OK: 6, IDLE: 7 }

/* ---- UAS / RPAS class taxonomy ---------------------------- */
type UClass = 'sUAS' | 'MALE' | 'HALE' | 'OPA' | 'eVTOL' | 'UAM'
const UCLASS_COLOR: Record<UClass, string> = {
  sUAS: '#22d3ee', MALE: '#0ea5e9', HALE: '#a855f7', OPA: '#10b981', eVTOL: '#f59e0b', UAM: '#fb7185',
}
interface UProfile {
  klass: UClass
  /** RTCA DO-365B DWC thresholds */
  dmodNm: number; zthrFt: number; tauModSec: number
  /** Service ceiling FL */
  ceilFl: number
  /** Typical cruise kt */
  vCruiseKt: number
  /** ACAS variant fitted */
  acas: 'Xu' | 'sXu' | 'X' | 'II' | 'none'
  /** Examples for label */
  ex: string
}
const UPROFILE: UProfile[] = [
  { klass: 'sUAS',  dmodNm: 0.27, zthrFt: 250, tauModSec: 35, ceilFl: 40,  vCruiseKt: 45,  acas: 'sXu', ex: 'M300/Mavic/Skydio' },
  { klass: 'MALE',  dmodNm: 0.66, zthrFt: 450, tauModSec: 35, ceilFl: 250, vCruiseKt: 180, acas: 'Xu',  ex: 'MQ-9/SkyGuardian/Hermes 900' },
  { klass: 'HALE',  dmodNm: 0.75, zthrFt: 500, tauModSec: 35, ceilFl: 600, vCruiseKt: 310, acas: 'Xu',  ex: 'RQ-4/Zephyr/Aquila' },
  { klass: 'OPA',   dmodNm: 0.50, zthrFt: 450, tauModSec: 35, ceilFl: 300, vCruiseKt: 240, acas: 'X',   ex: 'OPV C-130J/767-OPA' },
  { klass: 'eVTOL', dmodNm: 0.40, zthrFt: 350, tauModSec: 35, ceilFl: 100, vCruiseKt: 120, acas: 'sXu', ex: 'Joby/Archer/EHang' },
  { klass: 'UAM',   dmodNm: 0.40, zthrFt: 350, tauModSec: 35, ceilFl: 60,  vCruiseKt: 130, acas: 'sXu', ex: 'Wisk/Lilium/Volocopter' },
]

/* ---- Synthetic UAS / RPAS catalogue ---- 18 platforms across
       active US/EU/AsiaPac corridors. Production would feed from
       UTM USS / U-Space CIS / FAA LAANC / DFR feeds. */
interface UAS {
  id: string; callsign: string; klass: UClass; ex: string
  lat: number; lng: number; altitudeFt: number; track: number; velocityKts: number; vertRate: number
  operator: string
  /** Authorized operating volume label (CONOPS / LAANC / U-Space) */
  vol: string
}
const UAS_FLEET: UAS[] = [
  { id: 'N210MQ', callsign: 'REAPER01', klass: 'MALE', ex: 'MQ-9B',          lat:  32.86, lng:-117.12, altitudeFt: 24000, track:  90, velocityKts: 185, vertRate:   0, operator: 'USAF',         vol: 'KMYF-DAA' },
  { id: 'N431GH', callsign: 'GUARDIAN', klass: 'HALE', ex: 'RQ-4B',          lat:  37.91, lng:-122.21, altitudeFt: 51000, track: 270, velocityKts: 305, vertRate:   0, operator: 'NORTHROP',     vol: 'KEDW-HALE' },
  { id: 'EI-EVT', callsign: 'JOBY12',   klass: 'eVTOL', ex: 'JOBY-S4',       lat:  40.69, lng: -74.04, altitudeFt:  1500, track:  35, velocityKts: 115, vertRate: 200, operator: 'JOBY',         vol: 'KJRB-UAM' },
  { id: 'N977WK', callsign: 'WISK04',   klass: 'UAM',  ex: 'Wisk-Gen-6',     lat:  37.62, lng:-122.38, altitudeFt:  2200, track: 290, velocityKts: 125, vertRate:-100, operator: 'WISK',         vol: 'KSFO-UAM' },
  { id: 'D-EFLY', callsign: 'LILIUM07', klass: 'UAM',  ex: 'Lilium-Jet',     lat:  48.13, lng:  11.70, altitudeFt:  3200, track: 200, velocityKts: 135, vertRate:   0, operator: 'LILIUM',       vol: 'EDDM-UAM' },
  { id: 'F-WIVT', callsign: 'VOLO03',   klass: 'UAM',  ex: 'VoloCity',       lat:  43.66, lng:   7.21, altitudeFt:  1800, track: 180, velocityKts:  85, vertRate:   0, operator: 'VOLOCOPTER',   vol: 'LFMD-UAM' },
  { id: 'G-MQ9X', callsign: 'PROTECT2', klass: 'MALE', ex: 'SkyGuardian',    lat:  53.42, lng:  -2.27, altitudeFt: 18000, track: 145, velocityKts: 175, vertRate: 100, operator: 'GA-ASI',       vol: 'EGCC-DAA' },
  { id: '4X-UMS', callsign: 'HERMES9',  klass: 'MALE', ex: 'Hermes-900',     lat:  32.01, lng:  34.88, altitudeFt: 19500, track: 270, velocityKts: 165, vertRate:   0, operator: 'IAI',          vol: 'LLBG-DAA' },
  { id: 'JA88UA', callsign: 'TERRA04',  klass: 'sUAS', ex: 'Terra-Drone',    lat:  35.55, lng: 139.78, altitudeFt:   380, track:  60, velocityKts:  40, vertRate:   0, operator: 'TERRA',        vol: 'RJTT-LAANC' },
  { id: 'VH-DRN', callsign: 'WING21',   klass: 'sUAS', ex: 'Wing-Hummingbird', lat:-35.31, lng: 149.13, altitudeFt:   300, track: 270, velocityKts:  55, vertRate:   0, operator: 'WING',         vol: 'YSCB-LAANC' },
  { id: 'B-KEX1', callsign: 'EHANG18',  klass: 'UAM',  ex: 'EHang-216-S',    lat:  22.31, lng: 114.18, altitudeFt:  1400, track:  90, velocityKts:  60, vertRate:   0, operator: 'EHANG',        vol: 'VHHH-UAM' },
  { id: 'N762AR', callsign: 'ARCHER05', klass: 'eVTOL', ex: 'Archer-Midnight', lat: 37.71, lng:-122.22, altitudeFt:  2800, track: 100, velocityKts: 130, vertRate:   0, operator: 'ARCHER',       vol: 'KOAK-UAM' },
  { id: 'N100QS', callsign: 'OPA01',    klass: 'OPA',  ex: 'C-130J-OPA',     lat:  41.41, lng: -75.66, altitudeFt: 22000, track: 270, velocityKts: 240, vertRate:-200, operator: 'LM-SKUNK',     vol: 'KAVP-OPA' },
  { id: 'PH-ZPR', callsign: 'ZEPHYR1',  klass: 'HALE', ex: 'Zephyr-S',       lat:  52.10, lng:   5.18, altitudeFt: 70000, track: 180, velocityKts: 250, vertRate:   0, operator: 'AIRBUS-AS',    vol: 'EHAM-HALE' },
  { id: 'N201UA', callsign: 'SKYDIO9',  klass: 'sUAS', ex: 'Skydio-X10',     lat:  40.75, lng: -73.99, altitudeFt:   210, track: 180, velocityKts:  35, vertRate:   0, operator: 'SKYDIO',       vol: 'KJRB-LAANC' },
  { id: 'CC-EVT', callsign: 'EVE02',    klass: 'eVTOL', ex: 'Eve-EVTOL',     lat: -23.43, lng: -46.48, altitudeFt:  2100, track:  45, velocityKts: 110, vertRate: 100, operator: 'EVE',          vol: 'SBSP-UAM' },
  { id: 'A6-RPA', callsign: 'SKYWAY11', klass: 'eVTOL', ex: 'Joby-S4',       lat:  25.25, lng:  55.36, altitudeFt:  1900, track: 280, velocityKts: 115, vertRate:   0, operator: 'SKYPORTS',     vol: 'OMDB-UAM' },
  { id: 'F-MALE', callsign: 'EURMQ9',   klass: 'MALE', ex: 'Eurodrone',      lat:  44.62, lng:   5.32, altitudeFt: 20500, track: 200, velocityKts: 180, vertRate:   0, operator: 'AIRBUS-DS',    vol: 'LFKC-DAA' },
]

/* ---- Math helpers ---- */
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const ramp  = (v: number, a: number, b: number) => clamp((v - a) / (b - a), 0, 1) * 100
const D2R = Math.PI / 180, R2D = 180 / Math.PI

function nm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3440.065
  const dLat = (b.lat - a.lat) * D2R
  const dLng = (b.lng - a.lng) * D2R
  const lat1 = a.lat * D2R, lat2 = b.lat * D2R
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(x))
}
function destPoint(p: { lat: number; lng: number }, brgDeg: number, distNm: number): { lat: number; lng: number } {
  const R = 3440.065
  const δ = distNm / R
  const θ = brgDeg * D2R
  const φ1 = p.lat * D2R, λ1 = p.lng * D2R
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return { lat: φ2 * R2D, lng: ((λ2 * R2D + 540) % 360) - 180 }
}
function profileOf(k: UClass): UProfile { return UPROFILE.find(p => p.klass === k)! }

/* Project flight state into local-tangent NM frame around midpoint */
function toLocal(refLat: number, refLng: number, p: { lat: number; lng: number }): { x: number; y: number } {
  const dLat = (p.lat - refLat) * D2R
  const dLng = (p.lng - refLng) * D2R
  const meanLat = refLat * D2R
  const y = dLat * 3440.065
  const x = dLng * Math.cos(meanLat) * 3440.065
  return { x, y }
}
function velVec(track: number, vKts: number): { vx: number; vy: number } {
  // track 0 = north, 90 = east; vx = east-NM/h, vy = north-NM/h
  const rad = track * D2R
  return { vx: Math.sin(rad) * vKts, vy: Math.cos(rad) * vKts }
}

/* ---- Per-pair DWC eval ---- */
interface Drv { HMD: number; DH: number; TAU: number; GEO: number; CLS: number; CMP: number }
interface Ev {
  uas: UAS; intr: SFlight; uProf: UProfile
  hmdNm: number; dhFt: number; tauSec: number
  cpaLat: number; cpaLng: number
  closingKt: number; relTrack: number
  geometry: 'HEAD-ON' | 'CROSSING' | 'OVERTAKE' | 'CONVERGE' | 'CO-ALT'
  inDwc: boolean; inNmac: boolean
  score: number; tier: Tier; advice: string
  drv: Drv
  uClass: UClass
}

function evaluate(intruders: SFlight[], scopeNm: number, lookSec: number, advMul: number, hmdMul: number, vertBandFt: number, minFl: number, maxFl: number): Ev[] {
  const out: Ev[] = []
  for (const u of UAS_FLEET) {
    const prof = profileOf(u.klass)
    const uFl = Math.round(u.altitudeFt / 100)
    if (uFl < minFl || uFl > maxFl) continue
    const uVel = velVec(u.track, u.velocityKts)
    for (const t of intruders) {
      if (t.ground) continue
      // skip self-pairing if intruder is same ICAO
      if (t.icao === u.id) continue
      const tFl = Math.round(t.altitudeFt / 100)
      if (Math.abs((t.altitudeFt - u.altitudeFt)) > vertBandFt) continue
      const dNow = nm({ lat: u.lat, lng: u.lng }, { lat: t.lat, lng: t.lng })
      if (dNow > scopeNm) continue

      // Local frame at midpoint
      const midLat = (u.lat + t.lat) / 2, midLng = (u.lng + t.lng) / 2
      const Pu = toLocal(midLat, midLng, { lat: u.lat, lng: u.lng })
      const Pt = toLocal(midLat, midLng, { lat: t.lat, lng: t.lng })
      const Vu = uVel
      const Vt = velVec(t.track, t.velocityKts)
      // Relative: r0 = Pt - Pu, v = Vt - Vu (NM, NM/h)
      const rx = Pt.x - Pu.x, ry = Pt.y - Pu.y
      const vx = (Vt.vx - Vu.vx), vy = (Vt.vy - Vu.vy)
      const v2 = vx * vx + vy * vy
      const r2 = rx * rx + ry * ry
      const r0 = Math.sqrt(r2)
      let tCpaHr = 0
      if (v2 > 1e-9) {
        tCpaHr = -(rx * vx + ry * vy) / v2
      }
      // clamp lookahead and skip already-diverging pairs
      const tCpaSec = tCpaHr * 3600
      const closingNmH = -(rx * vx + ry * vy) / Math.max(r0, 1e-6)
      const closingKt = closingNmH
      // HMD (perpendicular miss distance at CPA)
      let hmd = r0
      if (tCpaSec > 0) {
        const cx = rx + vx * tCpaHr, cy = ry + vy * tCpaHr
        hmd = Math.sqrt(cx * cx + cy * cy)
      } else if (closingKt <= 0) {
        // diverging — only score current state
      }
      // CPA position in lat/lng
      const uCpa = { lat: u.lat + (Vu.vy * tCpaHr) / 60.0, lng: u.lng + (Vu.vx * tCpaHr) / (60.0 * Math.cos(u.lat * D2R)) }
      const cpaLat = uCpa.lat, cpaLng = uCpa.lng

      // Vertical projection at tCPA
      const uAltCpa = u.altitudeFt + u.vertRate * (tCpaSec / 60.0)
      const tAltCpa = t.altitudeFt + t.vertRate * (tCpaSec / 60.0)
      const dhFt = Math.abs(tAltCpa - uAltCpa)

      // Modified tau (per DO-365B): τ_mod = -(r² - DMOD²) / (r·ṙ)
      const dmodNm = prof.dmodNm * (hmdMul / 100)
      let tauMod = tCpaSec
      if (closingKt > 0 && r0 > 0) {
        const adj = (r2 - dmodNm * dmodNm) / Math.max(r0 * closingNmH, 1e-6)
        tauMod = adj * 3600
      }

      const inDwc = (dhFt < prof.zthrFt) && (tauMod > 0 && tauMod < prof.tauModSec) && (hmd < dmodNm)
      const nmacHmdNm = 500 / 6076  // 500ft horizontal in NM
      const inNmac = (hmd < nmacHmdNm) && (dhFt < 100)

      // Geometry classifier
      let rel = ((t.track - u.track) + 540) % 360 - 180
      const aRel = Math.abs(rel)
      let geom: Ev['geometry'] = 'CROSSING'
      if (aRel >= 135) geom = 'HEAD-ON'
      else if (aRel <= 25 && Math.abs(t.velocityKts - u.velocityKts) > 60) geom = 'OVERTAKE'
      else if (aRel <= 25) geom = 'CO-ALT'
      else if (closingKt > 100) geom = 'CONVERGE'

      // Skip far-future / diverging pairs except those currently inside DWC
      if (!inDwc && (tauMod > 240 || closingKt <= 0)) {
        if (dNow > prof.dmodNm * 4) continue
      }

      // Drivers (0-100)
      const drv: Drv = {
        HMD: ramp(dmodNm - hmd, 0, dmodNm * 1.5),
        DH:  ramp(prof.zthrFt - dhFt, 0, prof.zthrFt * 1.5),
        TAU: tauMod > 0 ? ramp(prof.tauModSec - tauMod, -prof.tauModSec * 2, prof.tauModSec) : 0,
        GEO: geom === 'HEAD-ON' ? 95 : geom === 'CROSSING' ? 65 : geom === 'CONVERGE' ? 55 : geom === 'OVERTAKE' ? 35 : 25,
        CLS: ramp(closingKt, 30, 600),
        CMP: prof.acas === 'none' ? 60 : prof.acas === 'sXu' ? 18 : prof.acas === 'Xu' ? 10 : 25,
      }

      const arr = [drv.HMD, drv.DH, drv.TAU, drv.GEO, drv.CLS, drv.CMP]
      const max = Math.max(...arr)
      const mean = arr.reduce((s, v) => s + v, 0) / arr.length
      let score = clamp((max * 0.78 + mean * 0.22) * (advMul / 100), 0, 100)

      // Hard escalations
      if (inNmac) score = Math.max(score, 100)
      if (inDwc) score = Math.max(score, 92)
      if (tauMod > 0 && tauMod < 25 && hmd < dmodNm * 1.4 && dhFt < prof.zthrFt) score = Math.max(score, 84)

      let tier: Tier = 'OK'
      let advice = `Pair separated · HMD ${hmd.toFixed(2)}NM > DMOD ${dmodNm.toFixed(2)}NM · maintain DAA WC per RTCA DO-365B §2.2.4.3`
      if (inNmac) {
        tier = 'NMAC'
        advice = `NMAC IMMINENT — HMD ${(hmd * 6076).toFixed(0)}ft / ΔH ${dhFt.toFixed(0)}ft · ACAS ${prof.acas} RA execute immediately per RTCA DO-386 §5`
      } else if (inDwc) {
        tier = 'LOWC'
        advice = `LOSS-OF-WELL-CLEAR with ${t.callsign || t.icao} · execute DAA maneuver (turn 30° away or climb/descend 700fpm) per DO-365B §2.2.4.3.2.1`
      } else if (tauMod > 0 && tauMod < 25) {
        tier = 'WARNING'
        advice = `WARNING ${tauMod.toFixed(0)}s to DWC breach · pilot must maneuver now · DO-365B Table 2-15 · UAS-NAS ConOps v3.0 §4.2`
      } else if (tauMod > 0 && tauMod < 55) {
        tier = 'CORRECTIVE'
        advice = `CORRECTIVE — ${tauMod.toFixed(0)}s · plan & execute resolution maneuver per DO-365B Table 2-15 · co-ord ATC if cooperative`
      } else if (tauMod > 0 && tauMod < 75) {
        tier = 'PREVENTIVE'
        advice = `PREVENTIVE alert — ${tauMod.toFixed(0)}s · monitor & be prepared to maneuver per DO-365B §2.2.4.4`
      } else if (score >= 18) {
        tier = 'WATCH'
        advice = `WATCH ${geom} geometry · HMD ${hmd.toFixed(2)}NM / closing ${closingKt.toFixed(0)}kt · monitor per UAS-NAS ConOps v3.0`
      }

      out.push({
        uas: u, intr: t, uProf: prof, uClass: u.klass,
        hmdNm: hmd, dhFt, tauSec: tauMod,
        cpaLat, cpaLng, closingKt, relTrack: rel,
        geometry: geom, inDwc, inNmac,
        score, tier, advice, drv,
      })
    }
  }
  out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  return out
}

/* ---- Component ---- */
const SRC_HALO='daa-halo', SRC_PIN='daa-pin', SRC_LBL='daa-lbl', SRC_LINK='daa-link'
const SRC_UAS='daa-uas', SRC_ULBL='daa-ulbl', SRC_CPA='daa-cpa', SRC_PROJ='daa-proj'
const SRC_DWC='daa-dwc'
const LYR_HALO='daa-halo-l', LYR_PIN='daa-pin-l', LYR_LBL='daa-lbl-l', LYR_LINK='daa-link-l'
const LYR_UAS='daa-uas-l', LYR_ULBL='daa-ulbl-l', LYR_CPA='daa-cpa-l', LYR_PROJ='daa-proj-l'
const LYR_DWC='daa-dwc-l'

function circlePoly(c: { lat: number; lng: number }, radiusNm: number, steps = 48): number[][] {
  const pts: number[][] = []
  for (let i = 0; i <= steps; i++) {
    const b = (360 * i) / steps
    const p = destPoint(c, b, radiusNm)
    pts.push([p.lng, p.lat])
  }
  return pts
}

export default function DaaWellClear({ map, flights, onClose, onFly }: Props) {
  const [scope, setScope] = useState(15)
  const [look, setLook] = useState(120)
  const [advMul, setAdvMul] = useState(100)
  const [hmdMul, setHmdMul] = useState(100)
  const [vertBand, setVertBand] = useState(2000)
  const [minFl, setMinFl] = useState(0)
  const [maxFl, setMaxFl] = useState(600)
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<UClass | 'ALL'>('ALL')
  const [tab, setTab] = useState<'PAIRS' | 'PLATFORMS' | 'CLASSES'>('PAIRS')
  const [query, setQuery] = useState('')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin]   = useState(true)
  const [showLbl, setShowLbl]   = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showUas, setShowUas]   = useState(true)
  const [showDwc, setShowDwc]   = useState(true)
  const [showCpa, setShowCpa]   = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showDiag, setShowDiag] = useState(true)

  // Treat UAS fleet as potential intruders too (so a UAS↔UAS pair is also scored)
  const allIntr: SFlight[] = useMemo(() => {
    const tracked: SFlight[] = flights
    const synth: SFlight[] = UAS_FLEET.map(u => ({
      icao: u.id, callsign: u.callsign, type: u.ex, operator: u.operator,
      lat: u.lat, lng: u.lng, altitudeFt: u.altitudeFt, velocityKts: u.velocityKts,
      track: u.track, vertRate: u.vertRate, ground: false, category: u.klass,
    }))
    return [...synth, ...tracked]
  }, [flights])

  const evals = useMemo(() => evaluate(allIntr, scope, look, advMul, hmdMul, vertBand, minFl, maxFl),
    [allIntr, scope, look, advMul, hmdMul, vertBand, minFl, maxFl])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return evals.filter(e => {
      if (classFilter !== 'ALL' && e.uClass !== classFilter) return false
      if (tierFilter !== 'ALL' && e.tier !== tierFilter) return false
      if (q) {
        const blob = `${e.uas.callsign} ${e.uas.id} ${e.uas.ex} ${e.uas.operator} ${e.intr.callsign} ${e.intr.icao} ${e.intr.type}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [evals, classFilter, tierFilter, query])

  const tierCount: Record<Tier, number> = { NMAC: 0, LOWC: 0, WARNING: 0, CORRECTIVE: 0, PREVENTIVE: 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const e of evals) tierCount[e.tier]++
  const meanScore = evals.length ? evals.reduce((s, e) => s + e.score, 0) / evals.length : 0
  const worst = evals[0]
  const nmac = evals.filter(e => e.tier === 'NMAC').length
  const lowc = evals.filter(e => e.tier === 'LOWC').length
  const warn = evals.filter(e => e.tier === 'WARNING').length

  /* Map layers */
  useEffect(() => {
    if (!map) return
    const ensure = (id: string, type: any, src: string, paint: any, layout: any = {}) => {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer(id)) map.addLayer({ id, type, source: src, paint, layout } as any)
    }
    ensure(LYR_DWC, 'line', SRC_DWC, { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [2, 2] })
    ensure(LYR_UAS, 'circle', SRC_UAS, { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' })
    ensure(LYR_ULBL, 'symbol', SRC_ULBL, {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, -1.2], 'text-anchor': 'bottom', 'text-font': ['Open Sans Bold'] })
    ensure(LYR_PROJ, 'line', SRC_PROJ, { 'line-color': ['get', 'color'], 'line-width': 1.0, 'line-opacity': 0.6, 'line-dasharray': [4, 2] })
    ensure(LYR_LINK, 'line', SRC_LINK, { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.85, 'line-dasharray': [2, 2] })
    ensure(LYR_CPA, 'circle', SRC_CPA, { 'circle-radius': 3, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1, 'circle-stroke-color': '#fff' })
    ensure(LYR_HALO, 'circle', SRC_HALO, { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'] })
    ensure(LYR_PIN, 'circle', SRC_PIN, { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' })
    ensure(LYR_LBL, 'symbol', SRC_LBL, {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    if (map.getLayer(LYR_LBL))  { map.setPaintProperty(LYR_LBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_LBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_LBL, 'text-halo-width', 1.4) }
    if (map.getLayer(LYR_ULBL)) { map.setPaintProperty(LYR_ULBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_ULBL, 'text-halo-color', '#020617'); map.setPaintProperty(LYR_ULBL, 'text-halo-width', 1.6) }

    const uasF: any[] = [], ulbl: any[] = [], dwc: any[] = []
    if (showUas) {
      for (const u of UAS_FLEET) {
        if (classFilter !== 'ALL' && u.klass !== classFilter) continue
        const fl = Math.round(u.altitudeFt / 100)
        if (fl < minFl || fl > maxFl) continue
        const col = UCLASS_COLOR[u.klass]
        uasF.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [u.lng, u.lat] }, properties: { color: col } })
        ulbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [u.lng, u.lat] }, properties: { color: col, label: `${u.callsign} ${u.klass}·FL${fl.toString().padStart(3, '0')}` } })
        if (showDwc) {
          const prof = profileOf(u.klass)
          dwc.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [circlePoly(u, prof.dmodNm * (hmdMul / 100))] }, properties: { color: col } })
        }
      }
    }

    const halo: any[] = [], pin: any[] = [], lbl: any[] = [], link: any[] = []
    const cpa: any[] = [], proj: any[] = []
    for (const e of filtered) {
      const color = TIER_COLOR[e.tier]
      if (showHalo && e.tier !== 'IDLE' && e.tier !== 'OK') {
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.uas.lng, e.uas.lat] }, properties: { color, r: 8 + e.score * 0.14 } })
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.intr.lng, e.intr.lat] }, properties: { color, r: 8 + e.score * 0.14 } })
      }
      if (showPin && (e.tier === 'NMAC' || e.tier === 'LOWC' || e.tier === 'WARNING')) {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.uas.lng, e.uas.lat] }, properties: { color } })
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.intr.lng, e.intr.lat] }, properties: { color } })
      }
      if (showLbl && e.tier !== 'OK' && e.tier !== 'IDLE') {
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [(e.uas.lng + e.intr.lng) / 2, (e.uas.lat + e.intr.lat) / 2] }, properties: { color, label: `${e.uas.callsign} › ${e.intr.callsign || e.intr.icao} ${e.tier} ${e.tauSec > 0 ? e.tauSec.toFixed(0) + 's' : ''} HMD${e.hmdNm.toFixed(2)}` } })
      }
      if (showLink && e.tier !== 'OK' && e.tier !== 'IDLE') {
        link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[e.uas.lng, e.uas.lat], [e.intr.lng, e.intr.lat]] }, properties: { color } })
      }
      if (showCpa && e.tauSec > 0 && e.tauSec < look) {
        cpa.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.cpaLng, e.cpaLat] }, properties: { color } })
      }
      if (showProj) {
        const uF = destPoint({ lat: e.uas.lat, lng: e.uas.lng }, e.uas.track, e.uas.velocityKts * (look / 3600))
        const tF = destPoint({ lat: e.intr.lat, lng: e.intr.lng }, e.intr.track, e.intr.velocityKts * (look / 3600))
        proj.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[e.uas.lng, e.uas.lat], [uF.lng, uF.lat]] }, properties: { color: UCLASS_COLOR[e.uClass] } })
        proj.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[e.intr.lng, e.intr.lat], [tF.lng, tF.lat]] }, properties: { color } })
      }
    }

    ;(map.getSource(SRC_DWC) as any).setData({ type: 'FeatureCollection', features: dwc })
    ;(map.getSource(SRC_UAS) as any).setData({ type: 'FeatureCollection', features: uasF })
    ;(map.getSource(SRC_ULBL) as any).setData({ type: 'FeatureCollection', features: ulbl })
    ;(map.getSource(SRC_PROJ) as any).setData({ type: 'FeatureCollection', features: proj })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })
    ;(map.getSource(SRC_CPA) as any).setData({ type: 'FeatureCollection', features: cpa })
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_CPA, LYR_LINK, LYR_PROJ, LYR_ULBL, LYR_UAS, LYR_DWC]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_PIN, SRC_LBL, SRC_LINK, SRC_CPA, SRC_PROJ, SRC_ULBL, SRC_UAS, SRC_DWC]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, filtered, showHalo, showPin, showLbl, showLink, showUas, showDwc, showCpa, showProj, classFilter, minFl, maxFl, hmdMul, look])

  const tierBadge = (t: Tier) => <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  const classBadge = (k: UClass) => <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: UCLASS_COLOR[k], backgroundColor: UCLASS_COLOR[k] + '1f', border: `1px solid ${UCLASS_COLOR[k]}55` }}>{k}</span>
  const drvBadge = (k: string, v: number) => {
    const c = v >= 70 ? '#ef4444' : v >= 40 ? '#f59e0b' : v >= 18 ? '#0ea5e9' : '#10b981'
    return <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: c, backgroundColor: c + '1c', border: `1px solid ${c}55` }}>{k}{v.toFixed(0)}</span>
  }
  const tcol = (v: number, breaks: [number, string][]) => { for (const [t, c] of breaks) if (v >= t) return c; return '#10b981' }

  /* Scatter: tau (x) vs HMD (y) */
  const W = 280, H = 110, padL = 26, padB = 16, padT = 6, padR = 6
  const xMin = 0, xMax = look
  const yMin = 0, yMax = 4
  const sx = (v: number) => padL + ((v - xMin) / (xMax - xMin)) * (W - padL - padR)
  const sy = (v: number) => padT + ((yMax - v) / (yMax - yMin)) * (H - padT - padB)

  return (
    <div className="absolute right-3 top-20 z-40 w-[26rem] max-h-[calc(100vh-6rem)] flex flex-col bg-slate-900/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-sky-500 animate-pulse" />
          <span className="text-[10px] font-bold tracking-widest uppercase text-sky-400">DAA-WC · Detect-And-Avoid Well-Clear</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-sm leading-none">×</button>
      </div>

      <div className="grid grid-cols-7 gap-1 px-3 py-2 border-b border-slate-800 text-[10px]">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[8px] font-semibold leading-tight" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Mean score</div><div className="text-sm font-semibold" style={{ color: tcol(meanScore, [[65,'#ef4444'],[35,'#f59e0b'],[18,'#0ea5e9']]) }}>{meanScore.toFixed(0)}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Worst</div><div className="text-sm font-semibold text-slate-100 truncate">{worst ? `${worst.uas.callsign}›${worst.intr.callsign || worst.intr.icao}` : '—'}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">NMAC</div><div className="text-sm font-semibold" style={{ color: nmac > 0 ? '#ef4444' : '#10b981' }}>{nmac}</div></div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">LoWC</div><div className="text-xs font-semibold text-rose-400">{lowc}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Warning</div><div className="text-xs font-semibold text-rose-300">{warn}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">UAS active</div><div className="text-xs font-semibold text-sky-400">{UAS_FLEET.length}</div></div>
      </div>

      {showDiag && evals.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* DWC breach band: tau < 35s and HMD < 0.66nm typical */}
            <rect x={sx(0)} y={sy(0.66)} width={sx(35) - sx(0)} height={sy(0) - sy(0.66)} fill="#ef444418" />
            {/* OK band: tau > 75s */}
            <rect x={sx(75)} y={padT} width={W - padR - sx(75)} height={H - padB - padT} fill="#10b98112" />
            <line x1={sx(25)} y1={padT} x2={sx(25)} y2={H - padB} stroke="#ef444466" strokeDasharray="3 3" strokeWidth={0.5} />
            <line x1={sx(55)} y1={padT} x2={sx(55)} y2={H - padB} stroke="#f59e0b66" strokeDasharray="3 3" strokeWidth={0.5} />
            <line x1={sx(75)} y1={padT} x2={sx(75)} y2={H - padB} stroke="#0ea5e966" strokeDasharray="3 3" strokeWidth={0.5} />
            <line x1={padL} y1={sy(0.66)} x2={W - padR} y2={sy(0.66)} stroke="#ef444466" strokeDasharray="3 3" strokeWidth={0.5} />
            <text x={W / 2} y={H - 3} textAnchor="middle" fontSize="9" fill="#64748b">τ-mod seconds</text>
            <text x={6} y={H / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H / 2})`}>HMD NM</text>
            {evals.map((e, i) => (
              <circle key={i} cx={sx(clamp(e.tauSec > 0 ? e.tauSec : 0, xMin, xMax))} cy={sy(clamp(e.hmdNm, yMin, yMax))} r={2.4} fill={TIER_COLOR[e.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['SCOPE',    scope,    2,    50,   setScope,    'nm'],
            ['LOOK',     look,     30,   300,  setLook,     's'],
            ['ADV-MUL',  advMul,   50,   200,  setAdvMul,   '%'],
            ['HMD-MUL',  hmdMul,   50,   200,  setHmdMul,   '%'],
            ['V-BAND',   vertBand, 500,  5000, setVertBand, 'ft'],
            ['MIN-FL',   minFl,    0,    400,  setMinFl,    ''],
            ['MAX-FL',   maxFl,    50,   650,  setMaxFl,    ''],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[78px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[42px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['sUAS', 'MALE', 'HALE', 'OPA', 'eVTOL', 'UAM'] as UClass[]).map(k => (
            <button key={k} onClick={() => setClassFilter(classFilter === k ? 'ALL' : k)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: classFilter === k ? UCLASS_COLOR[k] + '33' : '#0b1220', borderColor: classFilter === k ? UCLASS_COLOR[k] : '#1e293b', color: classFilter === k ? UCLASS_COLOR[k] : '#cbd5e1' }}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN',  showPin,  setShowPin],
            ['LBL',  showLbl,  setShowLbl],
            ['LINK', showLink, setShowLink],
            ['UAS',  showUas,  setShowUas],
            ['DWC',  showDwc,  setShowDwc],
            ['CPA',  showCpa,  setShowCpa],
            ['PROJ', showProj, setShowProj],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, v, setter]: any) => (
            <button key={lab} onClick={() => setter(!v)} className="px-1.5 py-0.5 rounded text-[9px] font-mono border" style={{ backgroundColor: v ? '#0ea5e933' : '#0b1220', borderColor: v ? '#0ea5e9' : '#1e293b', color: v ? '#7dd3fc' : '#64748b' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / type / operator" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['PAIRS', 'PLATFORMS', 'CLASSES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-1.5 text-[10px] font-semibold ${tab === t ? 'text-sky-400 bg-slate-800/50 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'PAIRS' && (
          <div className="divide-y divide-slate-800">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No DAA Well-Clear pair within {scope}NM / {vertBand}ft vertical band.</div>}
            {filtered.map((e, idx) => {
              const hmdCol = e.hmdNm < e.uProf.dmodNm ? '#ef4444' : e.hmdNm < e.uProf.dmodNm * 1.5 ? '#f59e0b' : '#10b981'
              const dhCol  = e.dhFt  < e.uProf.zthrFt ? '#ef4444' : e.dhFt < e.uProf.zthrFt * 1.5 ? '#f59e0b' : '#10b981'
              const tauCol = e.tauSec <= 0 ? '#10b981' : e.tauSec < 25 ? '#ef4444' : e.tauSec < 55 ? '#f59e0b' : e.tauSec < 75 ? '#0ea5e9' : '#10b981'
              return (
                <div key={idx} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(e.intr.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[e.tier]}` }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-slate-200 text-[11px] font-semibold truncate">{e.uas.callsign}</span>
                      {classBadge(e.uClass)}
                      <span className="text-slate-500 text-[10px]">›</span>
                      <span className="text-slate-100 text-[11px] font-semibold truncate">{e.intr.callsign || e.intr.icao}</span>
                      <span className="text-slate-500 text-[10px] font-mono">{e.intr.type || '—'}</span>
                    </div>
                    {tierBadge(e.tier)}
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] mt-0.5 flex-wrap">
                    <span className="px-1 py-0.5 rounded text-[9px] font-mono text-slate-400 bg-slate-800/60 border border-slate-700">{e.geometry}</span>
                    <span className="text-slate-500 font-mono">DMOD {e.uProf.dmodNm.toFixed(2)}NM · ZTHR {e.uProf.zthrFt}ft · τ {e.uProf.tauModSec}s</span>
                    <span className="text-slate-500 font-mono">ACAS {e.uProf.acas}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-[10px] mt-1 font-mono">
                    <div><span className="text-slate-500">HMD </span><span style={{ color: hmdCol }}>{e.hmdNm.toFixed(2)}NM</span></div>
                    <div><span className="text-slate-500">ΔH </span><span style={{ color: dhCol }}>{e.dhFt.toFixed(0)}ft</span></div>
                    <div><span className="text-slate-500">τ-mod </span><span style={{ color: tauCol }}>{e.tauSec > 0 ? e.tauSec.toFixed(0) + 's' : 'div'}</span></div>
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-[10px] mt-0.5 font-mono">
                    <div><span className="text-slate-500">closing </span><span className="text-slate-200">{e.closingKt.toFixed(0)}kt</span></div>
                    <div><span className="text-slate-500">UAS </span><span className="text-slate-200">FL{Math.round(e.uas.altitudeFt/100).toString().padStart(3,'0')}</span></div>
                    <div><span className="text-slate-500">intr </span><span className="text-slate-200">FL{Math.round(e.intr.altitudeFt/100).toString().padStart(3,'0')}</span></div>
                  </div>
                  <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden">
                    <div className="h-full" style={{ width: `${e.score}%`, backgroundColor: TIER_COLOR[e.tier] }} />
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {drvBadge('HMD', e.drv.HMD)}{drvBadge('DH', e.drv.DH)}{drvBadge('TAU', e.drv.TAU)}
                    {drvBadge('GEO', e.drv.GEO)}{drvBadge('CLS', e.drv.CLS)}{drvBadge('CMP', e.drv.CMP)}
                  </div>
                  <div className="mt-1 text-[10px] leading-tight" style={{ color: TIER_COLOR[e.tier] }}>{e.advice}</div>
                </div>
              )
            })}
          </div>
        )}
        {tab === 'PLATFORMS' && (
          <div className="divide-y divide-slate-800">
            {UAS_FLEET
              .filter(u => classFilter === 'ALL' || u.klass === classFilter)
              .map(u => {
                const inE = evals.filter(e => e.uas.id === u.id)
                const mean = inE.length ? inE.reduce((s, e) => s + e.score, 0) / inE.length : 0
                const lowcN = inE.filter(e => e.tier === 'LOWC' || e.tier === 'NMAC').length
                const warnN = inE.filter(e => e.tier === 'WARNING').length
                const prof = profileOf(u.klass)
                return (
                  <div key={u.id} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => inE[0] && onFly(inE[0].intr.icao)} style={{ borderLeft: `3px solid ${UCLASS_COLOR[u.klass]}` }}>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sky-400 font-mono text-[11px]">{u.callsign}</span>
                      {classBadge(u.klass)}
                      <span className="text-slate-300 text-[10px] italic">{u.ex}</span>
                      <span className="text-slate-500 text-[9px] font-mono">{u.operator}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-1 text-[10px] mt-1 font-mono">
                      <div><span className="text-slate-500">FL </span><span className="text-slate-200">{Math.round(u.altitudeFt/100).toString().padStart(3,'0')}</span></div>
                      <div><span className="text-slate-500">trk </span><span className="text-slate-200">{u.track.toFixed(0)}°</span></div>
                      <div><span className="text-slate-500">spd </span><span className="text-slate-200">{u.velocityKts}kt</span></div>
                    </div>
                    <div className="grid grid-cols-3 gap-1 text-[10px] mt-0.5 font-mono">
                      <div><span className="text-slate-500">vol </span><span className="text-sky-300">{u.vol}</span></div>
                      <div><span className="text-slate-500">ceil </span><span className="text-slate-200">FL{prof.ceilFl}</span></div>
                      <div><span className="text-slate-500">ACAS </span><span className="text-slate-200">{prof.acas}</span></div>
                    </div>
                    <div className="grid grid-cols-3 gap-1 text-[10px] mt-0.5 font-mono">
                      <div><span className="text-slate-500">pairs </span><span className="text-slate-200">{inE.length}</span></div>
                      <div><span className="text-slate-500">LoWC </span><span className="text-rose-400">{lowcN}</span></div>
                      <div><span className="text-slate-500">warn </span><span className="text-rose-300">{warnN}</span></div>
                    </div>
                    {inE.length > 0 && (
                      <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden">
                        <div className="h-full" style={{ width: `${mean}%`, backgroundColor: tcol(mean, [[65,'#ef4444'],[35,'#f59e0b'],[18,'#0ea5e9']]) }} />
                      </div>
                    )}
                  </div>
                )
              })}
          </div>
        )}
        {tab === 'CLASSES' && (
          <div className="divide-y divide-slate-800">
            {UPROFILE.map(p => {
              const ofClass = UAS_FLEET.filter(u => u.klass === p.klass)
              const inE = evals.filter(e => e.uClass === p.klass)
              const mean = inE.length ? inE.reduce((s, e) => s + e.score, 0) / inE.length : 0
              const lowcN = inE.filter(e => e.tier === 'LOWC' || e.tier === 'NMAC').length
              const warnN = inE.filter(e => e.tier === 'WARNING').length
              return (
                <div key={p.klass} className="px-3 py-2" style={{ borderLeft: `3px solid ${UCLASS_COLOR[p.klass]}` }}>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {classBadge(p.klass)}
                    <span className="text-slate-300 text-[10px] italic">{p.ex}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-[10px] mt-1 font-mono">
                    <div><span className="text-slate-500">DMOD </span><span className="text-slate-200">{p.dmodNm.toFixed(2)}NM</span></div>
                    <div><span className="text-slate-500">ZTHR </span><span className="text-slate-200">{p.zthrFt}ft</span></div>
                    <div><span className="text-slate-500">τmod </span><span className="text-slate-200">{p.tauModSec}s</span></div>
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-[10px] mt-0.5 font-mono">
                    <div><span className="text-slate-500">Vcruise </span><span className="text-slate-200">{p.vCruiseKt}kt</span></div>
                    <div><span className="text-slate-500">ceil </span><span className="text-slate-200">FL{p.ceilFl}</span></div>
                    <div><span className="text-slate-500">ACAS </span><span className="text-slate-200">{p.acas}</span></div>
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-[10px] mt-0.5 font-mono">
                    <div><span className="text-slate-500">fleet </span><span className="text-slate-200">{ofClass.length}</span></div>
                    <div><span className="text-slate-500">LoWC </span><span className="text-rose-400">{lowcN}</span></div>
                    <div><span className="text-slate-500">warn </span><span className="text-rose-300">{warnN}</span></div>
                  </div>
                  {inE.length > 0 && (
                    <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden">
                      <div className="h-full" style={{ width: `${mean}%`, backgroundColor: tcol(mean, [[65,'#ef4444'],[35,'#f59e0b'],[18,'#0ea5e9']]) }} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
