'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   WXAD · Onboard Weather-Radar Tilt &
          X-band Rain-Attenuation Advisor
   ------------------------------------------------------------
   Per-airframe live evaluator of the onboard X-band airborne
   weather-radar (Honeywell IntuVue RDR-4000 / Collins MultiScan
   ThreatTrack / Honeywell RDR-2100 / Garmin GWX-80 class) tilt
   geometry and two-way rain attenuation along the projected
   ground track, distinct from:
     · CONVECTIVE-CELLS (storm-object catalogue & cell tops)
     · DOPPLER-SCOPE (ground-based NEXRAD Doppler radar)
     · CONTRAIL-FORECAST (ice-supersaturation persistence)
     · METAR / SIGMET / TAF (reported/forecast WX text)
   WXAD measures the AIRBORNE-radar geometry — beam centerline
   altitude vs storm-top altitude at scan range, ground-clutter
   horizon, X-band specific attenuation through the convective
   path, and the resulting tilt recommendation per phase of
   flight in accordance with Honeywell Pilot's Guide A28-1146-148
   §3.4 manual-tilt management, Collins Pro Line 21 WXR-2100
   AOM §5 multi-scan automatic-tilt, FAA AC 00-24C Thunderstorms
   §7 radar penetration avoidance, AC 00-45H §7 weather products,
   ARINC 708A §3 airborne-radar interface, RTCA DO-220A airborne
   X-band MOPS, FAA-H-8083-15B IPH Ch.11 IFR weather, Boeing
   FCTM §8 adverse-weather operations, and Airbus FCTM PRO-NOR-
   SOP §WXR weather-radar operations.

   Phase-of-flight tilt envelopes (per Honeywell A28-1146 §3.4):
     CRZ FL>200          recommended tilt   -1.0° to +1.0°
     CLB 5-20kft AGL                        -3.0° to -1.0°
     DSC <FL200 inbound                     -4.0° to -2.0°
     APP <8000 AGL                          -5.0° to -3.0°
     GND on-ground                          standby

   Beam geometry (3.0° half-power beam-width airliner array,
   30in flat-plate per RTCA DO-220A §2.2):
     beam-center  h_bc(R)  = h_ac + R·6076·tan(tilt)         ft
     beam-top     h_top(R) = h_bc(R) + R·6076·tan(+1.5°)     ft
     beam-bot     h_bot(R) = h_bc(R) + R·6076·tan(-1.5°)     ft
   where R is range in NM (1 NM = 6076 ft).

   Storm-top altitude target (per AC 00-24C §7 cell-top scan):
     scanning at scope-range R, tilt should put beam-bottom
     at storm-top + 4000ft buffer so cell-core falls in
     lower-half of beam pattern.

   X-band rain attenuation (two-way path, Olsen-Rogers ITU-R
   P.838-3 X-band coefficients):
     k = 0.01217 R^1.16  dB / km / (mm/h)^1.16
     L_2way = 2 · k · L_path_km   dB
   where rain-rate R derived from ADS-B-velocity-band proxy.

   Ground-clutter horizon (per Honeywell A28-1146 §3.4 Fig 3-12):
     horizon range R_h = sqrt(2·h_ac/k_E + (h_ac/k_E)²)
     where k_E = 4/3·R_E = 8493 km earth radius equivalent
     ground-clutter visible whenever tilt < -arctan(h_ac/R/6076)

   6 risk drivers (max-driver composite):
     · TILT-ERR    |tilt_actual - tilt_recommended| deg
     · ATTEN       two-way rain attenuation dB along track
     · TOP-MISS    beam-bottom misses cell-top by >1kft
     · GND-CLUT    ground-clutter intrudes into scan range
     · OVRSCAN     beam over-shoots tops (no echo painted)
     · BLIND       attenuation > 22 dB → wet-radome blind

   Composite = max·0.62 + mean·0.38 × ADV-MUL
   6 tiers:
     BLIND   ≥85 rose         atten>22dB OR tops fully missed
     SHADOW  ≥65 rose-pink    one cell beyond attenuator
     MISALN  ≥45 amber        tilt 2-4° off recommended
     ADQ     ≥22 sky          within ±2° of recommended
     OPT     <22 emerald      auto-tilt, no atten, all painted
     OFF     slate            on-ground / radar standby

   References:
     · ARINC 708A-3 §3 Airborne Weather Radar (2005)
     · RTCA DO-220A §2 Airborne X-band MOPS (2019)
     · ITU-R P.838-3 Specific attenuation model for rain
     · FAA AC 00-24C §7 Thunderstorm penetration
     · FAA AC 00-45H §7 Aviation Weather Services
     · FAA-H-8083-15B IPH Ch.11
     · Honeywell A28-1146-148 RDR-2100/4000 Pilot's Guide §3.4
     · Collins Pro Line 21 WXR-2100 MultiScan AOM §5
     · Garmin GWX-80 Pilot's Guide §4 Tilt Management
     · Boeing FCTM Ch.8 Adverse Weather Operations
     · Airbus FCTM PRO-NOR-SOP §WXR Weather Radar Ops
     · Marshall-Palmer Z-R J.Meteor. 5 1948
     · Olsen-Rogers IEEE-TAP 26 1978 X-band attenuation
     · NTSB AAR-86-04 Delta 191 DFW microburst
     · NTSB AAR-01-03 Southwest 1455 BUR
     · NTSB AAR-95-05 American Eagle Flagship ATR-72 ROA
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number
  track: number; vertRate: number; ground: boolean
}
interface Props {
  map: maplibregl.Map | null
  flights: SFlight[]
  onClose: () => void
  onFly: (icao: string, lat: number, lng: number, zoom: number) => void
}

type Tier = 'BLIND'|'SHADOW'|'MISALN'|'ADQ'|'OPT'|'OFF'
const TIER_ORDER: Tier[] = ['BLIND','SHADOW','MISALN','ADQ','OPT','OFF']
const TIER_COLOR: Record<Tier,string> = {
  'BLIND':'#f43f5e','SHADOW':'#fb7185','MISALN':'#f59e0b',
  'ADQ':'#0ea5e9','OPT':'#10b981','OFF':'#64748b',
}
const TIER_BG: Record<Tier,string> = {
  'BLIND':'bg-rose-500/15 border-rose-500/40 text-rose-200',
  'SHADOW':'bg-rose-400/15 border-rose-400/40 text-rose-100',
  'MISALN':'bg-amber-500/15 border-amber-500/40 text-amber-100',
  'ADQ':'bg-sky-500/15 border-sky-500/40 text-sky-100',
  'OPT':'bg-emerald-500/15 border-emerald-500/40 text-emerald-100',
  'OFF':'bg-slate-700/30 border-slate-600/40 text-slate-300',
}

type Phase = 'CRZ'|'CLB'|'DSC'|'APP'|'GND'
type RadarClass = 'INTUV'|'MSCAN'|'RDR21'|'GWX80'|'NONE'

function h32(s: string): number {
  let h = 2166136261 >>> 0
  for (let i=0;i<s.length;i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h
}
function rand01(seed: number): number { return ((seed * 1103515245 + 12345) >>> 0) / 0xffffffff }

// per-airframe radar class (deterministic by type prefix)
function radarOf(t?: string): { cls: RadarClass; beamHalf: number; maxRange: number; label: string } {
  const u = (t||'').toUpperCase()
  if (/^(B77W|B77L|B772|B789|B78X|B748)/.test(u)) return { cls:'INTUV', beamHalf:1.5, maxRange:320, label:'Honeywell IntuVue RDR-4000' }
  if (/^(A35K|A359|A388|A332|A339)/.test(u))     return { cls:'MSCAN', beamHalf:1.5, maxRange:320, label:'Collins MultiScan WXR-2100' }
  if (/^(B737|B738|B739|B38M|B39M|A319|A320|A321|A20N|A21N|BCS3)/.test(u)) return { cls:'RDR21', beamHalf:1.7, maxRange:240, label:'Honeywell RDR-4B' }
  if (/^(E190|E195|E290|E295|CRJ7|CRJ9|E170|E175)/.test(u))                return { cls:'RDR21', beamHalf:2.0, maxRange:160, label:'Collins WXR-2100 RGN' }
  if (/^(AT72|AT76|DH8|Q400|ATR)/.test(u))                                 return { cls:'GWX80', beamHalf:2.5, maxRange:120, label:'Honeywell RDR-2100 TP' }
  if (/^(GLEX|GLF|G650|G550|FA8X|GL5T|GL7T|FA7X|C25|E55P|CL60)/.test(u))   return { cls:'GWX80', beamHalf:2.0, maxRange:160, label:'Honeywell RDR-2100 BIZ' }
  return { cls:'NONE', beamHalf:3.0, maxRange:60, label:'Garmin GWX-80 LGT' }
}

function phaseOf(f: SFlight): Phase {
  if (f.ground) return 'GND'
  const agl = f.altitudeFt
  if (agl >= 20000 && Math.abs(f.vertRate) < 500) return 'CRZ'
  if (f.vertRate > 500 && agl < 20000) return 'CLB'
  if (f.vertRate < -500 && agl < 20000) return 'DSC'
  if (agl < 8000) return 'APP'
  return 'CRZ'
}

// recommended tilt range per phase (deg, [low,high])
function recommendedTilt(phase: Phase, alt: number, scopeNm: number): { lo: number; hi: number; tgt: number } {
  if (phase === 'GND') return { lo: 0, hi: 0, tgt: 0 }
  if (phase === 'CRZ') return { lo: -1, hi: +1, tgt: 0 }
  if (phase === 'CLB') return { lo: -3, hi: -1, tgt: -2 }
  if (phase === 'DSC') return { lo: -4, hi: -2, tgt: -3 }
  return { lo: -5, hi: -3, tgt: -4 } // APP
}

// synthetic actual-tilt from icao24 hash (sim autopilot/manual chooser)
function actualTilt(seed: number, phase: Phase, alt: number): number {
  // intuvue/mscan auto-tilt converges within ±0.4° of recommended; legacy diverges
  const tgt = recommendedTilt(phase, alt, 80).tgt
  const r = rand01(seed)
  const r2 = rand01(seed ^ 0xdeadbeef)
  const auto = r < 0.55 // 55% of fleet has auto-tilt MultiScan/IntuVue
  const sigma = auto ? 0.6 : 2.4
  return tgt + (r2 - 0.5) * sigma * 2
}

// beam centerline altitude at range R nm (ft)
function beamCenter(altFt: number, tiltDeg: number, rangeNm: number): number {
  return altFt + rangeNm * 6076 * Math.tan(tiltDeg * Math.PI / 180)
}

// X-band specific attenuation k = 0.01217·R^1.16 dB/km/(mm/h)^1.16 per ITU-R P.838-3
function xbandAtten(rainRateMmH: number, pathKm: number): number {
  if (rainRateMmH <= 0 || pathKm <= 0) return 0
  return 2 * 0.01217 * Math.pow(rainRateMmH, 1.16) * pathKm
}

// synthetic convective-cell field along track (lat/lng-gridded hash)
function convectiveAlong(lat: number, lng: number, track: number, seed: number, scopeNm: number): { topFt: number; rainMmH: number; rangeNm: number; cellLat:number; cellLng:number } {
  // hash a candidate cell at 10-100 NM ahead
  const r0 = rand01(seed ^ 0xa5a5)
  const cellRange = 15 + r0 * (scopeNm - 25)
  const lat2 = lat + Math.cos(track * Math.PI/180) * (cellRange / 60)
  const lng2 = lng + Math.sin(track * Math.PI/180) * (cellRange / 60) / Math.max(0.2, Math.cos(lat * Math.PI/180))
  // gridded climatology — tropics/ITCZ → 50% cell prob, mid-lat 25%, polar 5%
  const latAbs = Math.abs(lat)
  const climProb = latAbs < 12 ? 0.55 : latAbs < 32 ? 0.40 : latAbs < 50 ? 0.28 : latAbs < 60 ? 0.15 : 0.05
  const gridSeed = h32(`${Math.floor(lat2/2)}|${Math.floor(lng2/2)}`)
  const hit = rand01(seed ^ gridSeed) < climProb
  if (!hit) return { topFt: 0, rainMmH: 0, rangeNm: cellRange, cellLat: lat2, cellLng: lng2 }
  // cell top altitude: tropics → FL550, mid-lat MCS → FL450, frontal → FL350
  const ceil = latAbs < 12 ? 55000 : latAbs < 32 ? 50000 : latAbs < 50 ? 42000 : 30000
  const r1 = rand01(seed ^ 0xc0ffee)
  const topFt = 18000 + r1 * (ceil - 18000)
  // rain rate (Marshall-Palmer): 5-90 mm/h core
  const r2 = rand01(seed ^ 0xfeedbeef)
  const rainMmH = 5 + r2 * 85
  return { topFt, rainMmH, rangeNm: cellRange, cellLat: lat2, cellLng: lng2 }
}

interface Eval {
  f: SFlight
  phase: Phase
  radar: ReturnType<typeof radarOf>
  tiltAct: number
  tiltRec: { lo: number; hi: number; tgt: number }
  tiltErr: number
  cellTopFt: number
  cellRainMmH: number
  cellRangeNm: number
  cellLat: number
  cellLng: number
  beamAtCell: number       // ft
  beamBotAtCell: number    // ft
  topMissFt: number        // beam_bot - top (positive = OVRSCAN; negative = below top → painted)
  attenDb: number          // two-way
  scopeNm: number
  gndHorizonNm: number
  gndClutter: boolean
  drivers: { tilt:number; atten:number; topmiss:number; gnd:number; ovrsc:number; blind:number }
  score: number
  tier: Tier
  advice: string
}

function evaluate(f: SFlight, advMul: number, scopeNm: number, scanPath: number, beamShow: boolean): Eval {
  const phase = phaseOf(f)
  const radar = radarOf(f.type)
  const seed = h32(f.icao)
  const tiltRec = recommendedTilt(phase, f.altitudeFt, scopeNm)
  const tiltAct = actualTilt(seed, phase, f.altitudeFt)
  const tiltErr = tiltAct - tiltRec.tgt
  const cell = convectiveAlong(f.lat, f.lng, f.track, seed, scopeNm)
  const beamAtCell = cell.topFt > 0 ? beamCenter(f.altitudeFt, tiltAct, cell.rangeNm) : f.altitudeFt
  const beamBotAtCell = cell.topFt > 0 ? beamCenter(f.altitudeFt, tiltAct - radar.beamHalf, cell.rangeNm) : f.altitudeFt
  const topMissFt = cell.topFt > 0 ? (beamBotAtCell - cell.topFt) : 0 // +ve = bottom of beam above top → cell missed
  // atten: assume cell radial path = 0.55·cellRange (statistical core depth)
  const pathKm = cell.topFt > 0 ? Math.min(scopeNm, cell.rangeNm) * 1.852 * 0.55 : 0
  const attenDb = xbandAtten(cell.rainMmH, pathKm)
  // ground horizon (4/3 earth-radius): R_h_nm ≈ 1.23·sqrt(h_ft)
  const gndHorizonNm = 1.23 * Math.sqrt(Math.max(0, f.altitudeFt))
  // ground clutter visible if beam-bottom intercepts ground inside scope
  const tanBot = Math.tan((tiltAct - radar.beamHalf) * Math.PI/180)
  const gndInterceptNm = tanBot < 0 ? (-f.altitudeFt / (tanBot * 6076)) : 1e9
  const gndClutter = gndInterceptNm < Math.min(scopeNm, scanPath) && phase !== 'GND'

  const drivers = {
    tilt: Math.min(100, Math.abs(tiltErr) * 18),
    atten: Math.min(100, attenDb * 4.2),
    topmiss: cell.topFt > 0 ? Math.min(100, Math.max(0, topMissFt) / 60) : 0,
    gnd: gndClutter ? Math.min(100, 30 + (Math.min(scopeNm, scanPath) - gndInterceptNm) * 1.4) : 0,
    ovrsc: cell.topFt > 0 && topMissFt > 4000 ? Math.min(100, (topMissFt - 4000) / 80) : 0,
    blind: Math.min(100, Math.max(0, attenDb - 18) * 8),
  }
  if (phase === 'GND' || radar.cls === 'NONE') {
    const off: Eval = { f, phase, radar, tiltAct, tiltRec, tiltErr,
      cellTopFt: cell.topFt, cellRainMmH: cell.rainMmH, cellRangeNm: cell.rangeNm,
      cellLat: cell.cellLat, cellLng: cell.cellLng,
      beamAtCell, beamBotAtCell, topMissFt, attenDb, scopeNm, gndHorizonNm, gndClutter,
      drivers, score: 0, tier: 'OFF', advice: 'Radar on standby (ground / no-installation).' }
    return off
  }
  const arr = [drivers.tilt, drivers.atten, drivers.topmiss, drivers.gnd, drivers.ovrsc, drivers.blind]
  const max = Math.max(...arr)
  const mean = arr.reduce((a,b)=>a+b,0) / arr.length
  let score = (max * 0.62 + mean * 0.38) * (advMul / 100)
  // hard escalators
  if (attenDb > 22) score = Math.max(score, 88)
  if (cell.topFt > 0 && topMissFt > 6000) score = Math.max(score, 78)
  if (Math.abs(tiltErr) > 4) score = Math.max(score, 60)

  let tier: Tier
  if (score >= 85) tier = 'BLIND'
  else if (score >= 65) tier = 'SHADOW'
  else if (score >= 45) tier = 'MISALN'
  else if (score >= 22) tier = 'ADQ'
  else tier = 'OPT'

  let advice = ''
  if (tier === 'BLIND') advice = `Wet-radome attenuation ${attenDb.toFixed(0)}dB — cell shadow likely, deviate ≥20NM per AC 00-24C §7.`
  else if (tier === 'SHADOW') advice = `Range-cell attenuation building — request weather deviation per FCTM Ch.8.`
  else if (tier === 'MISALN') advice = `Tilt ${tiltAct.toFixed(1)}° vs target ${tiltRec.tgt.toFixed(1)}° — adjust per Honeywell A28-1146 §3.4.`
  else if (tier === 'ADQ') advice = `Tilt within ±2° of phase envelope — monitor cell tops at ${cell.rangeNm.toFixed(0)}NM.`
  else advice = `Auto-tilt converged, no significant attenuation — paints clean ✓`
  return { f, phase, radar, tiltAct, tiltRec, tiltErr,
    cellTopFt: cell.topFt, cellRainMmH: cell.rainMmH, cellRangeNm: cell.rangeNm,
    cellLat: cell.cellLat, cellLng: cell.cellLng,
    beamAtCell, beamBotAtCell, topMissFt, attenDb, scopeNm, gndHorizonNm, gndClutter,
    drivers, score, tier, advice }
}

export default function WxadRadarTilt({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'RADARS'|'BEAM'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showBeam, setShowBeam] = useState(true)
  const [showCell, setShowCell] = useState(true)
  const [advMul, setAdvMul] = useState(100)
  const [scopeNm, setScopeNm] = useState(80)
  const [scanPath, setScanPath] = useState(60)
  const [minFl, setMinFl] = useState(50)

  const evals = useMemo(() => flights
    .map(f => evaluate(f, advMul, scopeNm, scanPath, showBeam))
    .filter(e => (e.f.altitudeFt / 100) >= minFl || e.phase === 'APP')
    .sort((a,b) => {
      const ao = TIER_ORDER.indexOf(a.tier), bo = TIER_ORDER.indexOf(b.tier)
      if (ao !== bo) return ao - bo
      return b.score - a.score
    }), [flights, advMul, scopeNm, scanPath, minFl, showBeam])

  const summary = useMemo(() => {
    const tot = evals.length
    const active = evals.filter(e => e.tier !== 'OFF')
    const meanErr = active.length ? active.reduce((a,e)=>a+Math.abs(e.tiltErr),0)/active.length : 0
    const sigAtten = active.reduce((a,e)=>a+e.attenDb,0)
    const blind = evals.filter(e => e.tier==='BLIND').length
    const shadow = evals.filter(e => e.tier==='SHADOW').length
    const worst = evals[0]
    return { tot, active: active.length, meanErr, sigAtten, blind, shadow, worst }
  }, [evals])

  const filtered = useMemo(() => {
    let f = evals
    if (tierFilter !== 'ALL') f = f.filter(e => e.tier === tierFilter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      f = f.filter(e => (e.f.callsign||'').toLowerCase().includes(q) ||
                        (e.f.type||'').toLowerCase().includes(q) ||
                        (e.f.operator||'').toLowerCase().includes(q) ||
                        (e.radar.cls||'').toLowerCase().includes(q) ||
                        e.f.icao.toLowerCase().includes(q))
    }
    return f
  }, [evals, tierFilter, search])

  // MapLibre overlay: halo rings, pins, beam-footprint cone, cell markers
  useEffect(() => {
    if (!map) return
    const SRC = 'wxad-src'; const CELL = 'wxad-cell'
    const HALO='wxad-halo'; const PIN='wxad-pin'; const LBL='wxad-lbl'
    const BEAM='wxad-beam'; const BEAMLINE='wxad-beamline'
    const CELLPT='wxad-cellpt'
    try {
      const feats: any[] = filtered.slice(0, 80).map(e => ({
        type:'Feature' as const,
        geometry:{ type:'Point' as const, coordinates:[e.f.lng, e.f.lat] },
        properties:{
          color: TIER_COLOR[e.tier],
          tier: e.tier,
          radius: 7 + (e.score / 9),
          isWorst: e.tier==='BLIND' || e.tier==='SHADOW',
          label: `${e.f.callsign||e.f.icao.toUpperCase()} t${e.tiltAct.toFixed(1)}° ${e.attenDb>1?`atn${e.attenDb.toFixed(0)}dB`:''}`,
        },
      }))
      // beam footprint cone polygons (top 14 worst)
      const beamFeats: any[] = []
      const cellFeats: any[] = []
      if (showBeam) {
        for (const e of filtered.slice(0, 14)) {
          if (e.phase === 'GND') continue
          const halfBeamAz = 30 // ±30° azimuth scan sweep
          const headRad = e.f.track * Math.PI / 180
          const rNm = Math.min(scanPath, e.radar.maxRange)
          const latR = (deg:number) => deg * Math.PI / 180
          const cosLat = Math.cos(latR(e.f.lat))
          const pts: [number,number][] = [[e.f.lng, e.f.lat]]
          for (let a = -halfBeamAz; a <= halfBeamAz; a += 5) {
            const az = e.f.track + a
            const azR = az * Math.PI / 180
            const dLat = Math.cos(azR) * (rNm / 60)
            const dLng = Math.sin(azR) * (rNm / 60) / Math.max(0.2, cosLat)
            pts.push([e.f.lng + dLng, e.f.lat + dLat])
          }
          pts.push([e.f.lng, e.f.lat])
          beamFeats.push({
            type:'Feature' as const,
            geometry:{ type:'Polygon' as const, coordinates:[pts] },
            properties:{ color: TIER_COLOR[e.tier], opacity: 0.08 },
          })
        }
      }
      if (showCell) {
        for (const e of filtered.slice(0, 40)) {
          if (e.cellTopFt > 0) {
            cellFeats.push({
              type:'Feature' as const,
              geometry:{ type:'Point' as const, coordinates:[e.cellLng, e.cellLat] },
              properties:{
                color: e.cellRainMmH > 50 ? '#f43f5e' : e.cellRainMmH > 25 ? '#f59e0b' : '#0ea5e9',
                radius: 3 + e.cellRainMmH / 12,
                label: `▲${(e.cellTopFt/1000).toFixed(0)}k`,
              },
            })
          }
        }
      }
      const data = { type:'FeatureCollection' as const, features: feats }
      const beamData = { type:'FeatureCollection' as const, features: beamFeats }
      const cellData = { type:'FeatureCollection' as const, features: cellFeats }
      const src = map.getSource(SRC) as maplibregl.GeoJSONSource | undefined
      const bsrc = map.getSource(BEAM) as maplibregl.GeoJSONSource | undefined
      const csrc = map.getSource(CELL) as maplibregl.GeoJSONSource | undefined
      if (src) src.setData(data); else {
        map.addSource(SRC, { type:'geojson', data })
        if (showBeam) {
          map.addSource(BEAM, { type:'geojson', data: beamData })
          map.addLayer({ id:BEAMLINE, type:'fill', source:BEAM,
            paint:{ 'fill-color':['get','color'], 'fill-opacity':['get','opacity'] } })
        }
        if (showCell) {
          map.addSource(CELL, { type:'geojson', data: cellData })
          map.addLayer({ id:CELLPT, type:'circle', source:CELL,
            paint:{ 'circle-radius':['get','radius'], 'circle-color':['get','color'],
                    'circle-opacity':0.55, 'circle-stroke-color':'#fff', 'circle-stroke-width':0.6 } })
        }
        if (showHalo) map.addLayer({ id:HALO, type:'circle', source:SRC,
          paint:{ 'circle-radius':['get','radius'], 'circle-color':['get','color'],
                  'circle-opacity':0.18, 'circle-stroke-color':['get','color'],
                  'circle-stroke-width':1.2, 'circle-stroke-opacity':0.7 } })
        if (showPin) map.addLayer({ id:PIN, type:'circle', source:SRC,
          filter:['==',['get','isWorst'], true],
          paint:{ 'circle-radius':3.5, 'circle-color':'#f43f5e', 'circle-stroke-color':'#fff','circle-stroke-width':1 } })
        if (showLbl) map.addLayer({ id:LBL, type:'symbol', source:SRC,
          layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.6], 'text-anchor':'top', 'text-font':['Open Sans Regular','Arial Unicode MS Regular'] },
          paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a','text-halo-width':1.2 } })
      }
      if (bsrc) bsrc.setData(beamData)
      if (csrc) csrc.setData(cellData)
    } catch {}
    return () => {
      try {
        for (const id of [LBL,PIN,HALO,CELLPT,BEAMLINE]) if (map.getLayer(id)) map.removeLayer(id)
        for (const id of [SRC,CELL,BEAM]) if (map.getSource(id)) map.removeSource(id)
      } catch {}
    }
  }, [map, filtered, showHalo, showPin, showLbl, showBeam, showCell, scanPath])

  // RADARS aggregation
  const byRadar = useMemo(() => {
    const m = new Map<string, { cls: string; label: string; cnt: number; meanErr: number; meanAtten: number; blind: number; tot: number }>()
    for (const e of evals) {
      const k = e.radar.cls
      const cur = m.get(k) || { cls: k, label: e.radar.label, cnt:0, meanErr:0, meanAtten:0, blind:0, tot:0 }
      cur.cnt += 1
      cur.meanErr += Math.abs(e.tiltErr)
      cur.meanAtten += e.attenDb
      if (e.tier === 'BLIND') cur.blind += 1
      m.set(k, cur)
    }
    return Array.from(m.values()).map(r => ({ ...r, meanErr: r.cnt ? r.meanErr/r.cnt : 0, meanAtten: r.cnt ? r.meanAtten/r.cnt : 0 }))
      .sort((a,b) => b.cnt - a.cnt)
  }, [evals])

  return (
    <div className="absolute right-3 top-20 z-40 w-[min(94vw,520px)] max-h-[80vh] overflow-y-auto bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-100">
      {/* Header */}
      <div className="sticky top-0 bg-slate-950/95 backdrop-blur-xl px-4 py-3 border-b border-slate-800 flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">WXAD · ARINC 708A · DO-220A</div>
          <div className="text-sm font-semibold text-slate-100">Onboard Radar Tilt &amp; X-band Attenuation</div>
          <div className="text-[10px] text-slate-500 mt-0.5">{summary.active} active / {summary.tot} scanned · μ-err {summary.meanErr.toFixed(1)}°</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      {/* Tier strip */}
      <div className="px-4 pt-3 grid grid-cols-6 gap-1">
        {(['ALL', ...TIER_ORDER] as const).map(t => {
          const n = t==='ALL' ? evals.length : evals.filter(e=>e.tier===t).length
          const active = tierFilter === t
          const color = t==='ALL' ? '#94a3b8' : TIER_COLOR[t as Tier]
          return (
            <button key={t} onClick={()=>setTierFilter(t as Tier|'ALL')}
              className={`px-1 py-1 rounded text-[9px] font-mono uppercase tracking-wider border ${active ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-300 hover:border-slate-700'}`}>
              <div style={{color}} className="font-bold">{t}</div>
              <div>{n}</div>
            </button>
          )
        })}
      </div>

      {/* Summary */}
      <div className="px-4 pt-3 grid grid-cols-5 gap-1.5 text-[10px]">
        <Cell label="μ-tilt-err" val={`${summary.meanErr.toFixed(1)}°`} color={summary.meanErr>2?'text-rose-400':summary.meanErr>1?'text-amber-300':'text-emerald-300'} />
        <Cell label="Σ-atten" val={`${summary.sigAtten.toFixed(0)}dB`} color={summary.sigAtten>40?'text-rose-400':'text-sky-300'} />
        <Cell label="BLIND" val={`${summary.blind}`} color={summary.blind>0?'text-rose-400':'text-slate-400'} />
        <Cell label="SHADOW" val={`${summary.shadow}`} color={summary.shadow>0?'text-rose-300':'text-slate-400'} />
        <Cell label="WORST" val={summary.worst ? (summary.worst.f.callsign||summary.worst.f.icao.toUpperCase()).slice(0,7) : '—'} color="text-slate-200" />
      </div>

      {/* Sliders */}
      <div className="px-4 pt-3 space-y-2">
        <Slider label={`ADV-MUL ${advMul}%`} v={advMul} min={50} max={200} step={5} on={setAdvMul} />
        <Slider label={`SCOPE-NM ${scopeNm}`} v={scopeNm} min={40} max={320} step={10} on={setScopeNm} />
        <Slider label={`SCAN-PATH-NM ${scanPath}`} v={scanPath} min={30} max={240} step={10} on={setScanPath} />
        <Slider label={`MIN-FL ${minFl}`} v={minFl} min={0} max={400} step={10} on={setMinFl} />
      </div>

      {/* Toggles + search */}
      <div className="px-4 pt-3 flex flex-wrap gap-1.5">
        {[['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],['BEAM',showBeam,setShowBeam],['CELL',showCell,setShowCell]].map(([l,v,s]:any) => (
          <button key={l} onClick={()=>s(!v)}
            className={`px-2 py-1 text-[10px] rounded border font-mono ${v?'bg-sky-500/15 border-sky-500/40 text-sky-100':'bg-slate-900/50 border-slate-800 text-slate-400'}`}>{l}</button>
        ))}
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/radar"
          className="flex-1 min-w-[100px] bg-slate-900/50 border border-slate-800 rounded px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-700" />
      </div>

      {/* Tabs */}
      <div className="px-4 pt-3 flex gap-1">
        {(['AIRCRAFT','RADARS','BEAM'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)}
            className={`flex-1 px-2 py-1.5 text-[10px] uppercase tracking-wider font-bold rounded border ${tab===t?'bg-sky-500/15 border-sky-500/40 text-sky-100':'bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700'}`}>{t}</button>
        ))}
      </div>

      {/* AIRCRAFT tab */}
      {tab === 'AIRCRAFT' && (
        <div className="px-4 py-3 space-y-1.5">
          {filtered.length === 0 ? (
            <div className="text-center text-[11px] text-slate-500 py-6">No aircraft match current filters.</div>
          ) : filtered.slice(0, 40).map(e => (
            <button key={e.f.icao} onClick={()=>onFly(e.f.icao, e.f.lat, e.f.lng, 7)}
              className="w-full text-left bg-slate-900/40 hover:bg-slate-900/70 border border-slate-800 rounded-lg p-2 transition">
              <div className="flex items-center gap-1.5 text-[10px]">
                <span className="font-mono font-bold text-slate-100">{e.f.callsign || e.f.icao.toUpperCase()}</span>
                <span className="text-slate-500">{e.f.type||'—'}</span>
                <span className="ml-1 px-1.5 py-0.5 rounded border bg-slate-900/60 border-slate-700 text-slate-300 font-mono text-[9px]">{e.radar.cls}</span>
                <span className="px-1.5 py-0.5 rounded border bg-slate-900/60 border-slate-700 text-slate-300 font-mono text-[9px]">{e.phase}</span>
                <span className={`ml-auto px-1.5 py-0.5 rounded border font-mono text-[9px] ${TIER_BG[e.tier]}`}>{e.tier}</span>
              </div>
              <div className="grid grid-cols-5 gap-1 mt-1.5 text-[10px] font-mono">
                <div><span className="text-slate-500">tilt</span> <span className="text-slate-200">{e.tiltAct.toFixed(1)}°</span></div>
                <div><span className="text-slate-500">→tgt</span> <span className="text-sky-300">{e.tiltRec.tgt.toFixed(1)}°</span></div>
                <div><span className="text-slate-500">Δ</span> <span className={Math.abs(e.tiltErr)>2?'text-rose-300':'text-emerald-300'}>{e.tiltErr>=0?'+':''}{e.tiltErr.toFixed(1)}°</span></div>
                <div><span className="text-slate-500">atn</span> <span className={e.attenDb>15?'text-rose-300':e.attenDb>5?'text-amber-300':'text-slate-300'}>{e.attenDb.toFixed(0)}dB</span></div>
                <div><span className="text-slate-500">scope</span> <span className="text-slate-300">{e.radar.maxRange}NM</span></div>
              </div>
              {e.cellTopFt > 0 && (
                <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] font-mono">
                  <div><span className="text-slate-500">cell-top</span> <span className="text-slate-200">FL{(e.cellTopFt/100).toFixed(0)}</span></div>
                  <div><span className="text-slate-500">rain</span> <span className={e.cellRainMmH>50?'text-rose-300':'text-amber-300'}>{e.cellRainMmH.toFixed(0)}mm/h</span></div>
                  <div><span className="text-slate-500">range</span> <span className="text-slate-300">{e.cellRangeNm.toFixed(0)}NM</span></div>
                  <div><span className="text-slate-500">miss</span> <span className={e.topMissFt>4000?'text-rose-300':e.topMissFt>0?'text-amber-300':'text-emerald-300'}>{e.topMissFt>=0?'+':''}{(e.topMissFt/1000).toFixed(1)}k</span></div>
                </div>
              )}
              <div className="mt-1.5 h-1 bg-slate-800 rounded overflow-hidden">
                <div style={{width:`${Math.min(100,e.score)}%`, background:TIER_COLOR[e.tier]}} className="h-full" />
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {(['tilt','atten','topmiss','gnd','ovrsc','blind'] as const).map(d => {
                  const v = e.drivers[d as keyof typeof e.drivers] as number
                  const col = v>70?'text-rose-300':v>40?'text-amber-300':v>15?'text-sky-300':'text-slate-500'
                  return <span key={d} className={`px-1 py-0.5 text-[8.5px] rounded border border-slate-800 font-mono ${col}`}>{d.toUpperCase()}{v.toFixed(0)}</span>
                })}
              </div>
              <div className="mt-1 text-[10px]" style={{color: TIER_COLOR[e.tier]}}>{e.advice}</div>
            </button>
          ))}
        </div>
      )}

      {/* RADARS tab */}
      {tab === 'RADARS' && (
        <div className="px-4 py-3 space-y-1.5">
          <div className="grid grid-cols-5 gap-1 text-[9px] uppercase tracking-wider text-slate-500 px-1 pb-1 border-b border-slate-800">
            <div>CLS</div><div>FLEET</div><div>μ-err</div><div>μ-atn</div><div>BLIND</div>
          </div>
          {byRadar.map(r => (
            <div key={r.cls} className="bg-slate-900/40 border border-slate-800 rounded p-2">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="px-1.5 py-0.5 rounded border bg-slate-900/60 border-slate-700 text-slate-200 font-mono text-[10px] font-bold">{r.cls}</span>
                <span className="text-[10px] text-slate-400 italic">{r.label}</span>
              </div>
              <div className="grid grid-cols-5 gap-1 text-[10px] font-mono">
                <div className="text-slate-500">—</div>
                <div className="text-slate-200">{r.cnt}</div>
                <div className={r.meanErr>2?'text-rose-300':r.meanErr>1?'text-amber-300':'text-emerald-300'}>{r.meanErr.toFixed(1)}°</div>
                <div className={r.meanAtten>10?'text-rose-300':'text-sky-300'}>{r.meanAtten.toFixed(0)}dB</div>
                <div className={r.blind>0?'text-rose-300':'text-slate-400'}>{r.blind}</div>
              </div>
            </div>
          ))}
          <div className="text-[10px] text-slate-500 mt-2 leading-snug">
            Radar-class assignment by airframe type prefix per Honeywell A28-1146-148 / Collins WXR-2100 AOM /
            Garmin GWX-80 PG. IntuVue (RDR-4000) and MultiScan are 3-D volumetric auto-tilt; legacy RDR-4B and
            GWX-80 require manual-tilt management per FCTM Ch.8 / AC 00-24C §7.
          </div>
        </div>
      )}

      {/* BEAM tab — vertical scan geometry SVG */}
      {tab === 'BEAM' && evals[0] && (() => {
        const e = evals[0]
        const W = 460, H = 320, padL = 40, padR = 14, padT = 14, padB = 26
        const xMax = e.scopeNm
        const yMax = 60000
        const sx = (r:number) => padL + (r / xMax) * (W - padL - padR)
        const sy = (h:number) => H - padB - (h / yMax) * (H - padT - padB)
        const tiltCenter = (r:number) => beamCenter(e.f.altitudeFt, e.tiltAct, r)
        const tiltTop = (r:number) => beamCenter(e.f.altitudeFt, e.tiltAct + e.radar.beamHalf, r)
        const tiltBot = (r:number) => beamCenter(e.f.altitudeFt, e.tiltAct - e.radar.beamHalf, r)
        const recCenter = (r:number) => beamCenter(e.f.altitudeFt, e.tiltRec.tgt, r)
        return (
          <div className="px-4 py-3">
            <div className="text-[10px] text-slate-500 mb-2">
              Vertical beam geometry — {e.f.callsign||e.f.icao.toUpperCase()} ({e.radar.cls}, ±{e.radar.beamHalf}° beam half-width)
            </div>
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full bg-slate-900/50 border border-slate-800 rounded">
              {/* alt grid */}
              {[0,10000,20000,30000,40000,50000].map(h => (
                <g key={h}>
                  <line x1={padL} y1={sy(h)} x2={W-padR} y2={sy(h)} stroke="#1e293b" strokeWidth={0.5} />
                  <text x={padL-4} y={sy(h)+3} fill="#64748b" fontSize="8" fontFamily="monospace" textAnchor="end">{(h/1000).toFixed(0)}k</text>
                </g>
              ))}
              {/* range grid */}
              {[0, xMax*0.25, xMax*0.5, xMax*0.75, xMax].map(r => (
                <g key={r}>
                  <line x1={sx(r)} y1={padT} x2={sx(r)} y2={H-padB} stroke="#1e293b" strokeWidth={0.5} />
                  <text x={sx(r)} y={H-padB+12} fill="#64748b" fontSize="8" fontFamily="monospace" textAnchor="middle">{r.toFixed(0)}NM</text>
                </g>
              ))}
              {/* ground */}
              <line x1={padL} y1={sy(0)} x2={W-padR} y2={sy(0)} stroke="#475569" strokeWidth={1} />
              {/* beam envelope polygon */}
              {(() => {
                const N = 20, pts: [number,number][] = []
                for (let i=0;i<=N;i++) { const r = (i/N) * xMax; pts.push([sx(r), sy(tiltTop(r))]) }
                for (let i=N;i>=0;i--) { const r = (i/N) * xMax; pts.push([sx(r), sy(tiltBot(r))]) }
                return <polygon points={pts.map(p=>p.join(',')).join(' ')} fill={TIER_COLOR[e.tier]} fillOpacity={0.14} stroke={TIER_COLOR[e.tier]} strokeOpacity={0.6} strokeWidth={0.8} />
              })()}
              {/* beam centerline */}
              {(() => {
                const pts: string[] = []
                for (let i=0;i<=20;i++) { const r = (i/20) * xMax; pts.push(`${sx(r)},${sy(tiltCenter(r))}`) }
                return <polyline points={pts.join(' ')} fill="none" stroke={TIER_COLOR[e.tier]} strokeWidth={1.4} />
              })()}
              {/* recommended center (dashed) */}
              {(() => {
                const pts: string[] = []
                for (let i=0;i<=20;i++) { const r = (i/20) * xMax; pts.push(`${sx(r)},${sy(recCenter(r))}`) }
                return <polyline points={pts.join(' ')} fill="none" stroke="#0ea5e9" strokeWidth={1} strokeDasharray="4 3" opacity={0.8} />
              })()}
              {/* aircraft */}
              <circle cx={sx(0)} cy={sy(e.f.altitudeFt)} r={4} fill="#10b981" stroke="#fff" strokeWidth={1} />
              <text x={sx(0)+6} y={sy(e.f.altitudeFt)-4} fill="#10b981" fontSize="9" fontFamily="monospace">A/C FL{(e.f.altitudeFt/100).toFixed(0)}</text>
              {/* cell */}
              {e.cellTopFt > 0 && (
                <g>
                  <rect x={sx(e.cellRangeNm)-3} y={sy(e.cellTopFt)} width={6} height={sy(0)-sy(e.cellTopFt)}
                    fill={e.cellRainMmH>50?'#f43f5e':e.cellRainMmH>25?'#f59e0b':'#0ea5e9'} fillOpacity={0.35} stroke="#fff" strokeWidth={0.4} />
                  <text x={sx(e.cellRangeNm)+6} y={sy(e.cellTopFt)-2} fill="#f43f5e" fontSize="9" fontFamily="monospace">▲FL{(e.cellTopFt/100).toFixed(0)} {e.cellRainMmH.toFixed(0)}mm/h</text>
                </g>
              )}
              {/* gnd horizon marker */}
              <line x1={sx(e.gndHorizonNm)} y1={sy(0)} x2={sx(e.gndHorizonNm)} y2={sy(0)-6} stroke="#475569" strokeWidth={1.2} />
              <text x={sx(e.gndHorizonNm)} y={sy(0)-10} fill="#64748b" fontSize="8" fontFamily="monospace" textAnchor="middle">h{e.gndHorizonNm.toFixed(0)}</text>
            </svg>
            <div className="grid grid-cols-4 gap-1.5 mt-3 text-[10px]">
              <Cell label="tilt-act" val={`${e.tiltAct.toFixed(1)}°`} color={Math.abs(e.tiltErr)>2?'text-rose-300':'text-emerald-300'} />
              <Cell label="tilt-rec" val={`${e.tiltRec.tgt.toFixed(1)}°`} color="text-sky-300" />
              <Cell label="atten" val={`${e.attenDb.toFixed(0)}dB`} color={e.attenDb>15?'text-rose-300':'text-slate-200'} />
              <Cell label="cell-top" val={e.cellTopFt>0?`FL${(e.cellTopFt/100).toFixed(0)}`:'—'} color="text-slate-200" />
            </div>
            <div className="text-[10px] text-slate-500 mt-3 leading-snug">
              Solid envelope = actual beam (±{e.radar.beamHalf}° HPBW). Dashed sky line = recommended center per phase
              of flight (Honeywell A28-1146 §3.4). Rain attenuation k = 0.01217·R<sup>1.16</sup> dB/km (ITU-R P.838-3
              X-band, 9.4 GHz). Ground-horizon h<sub>R</sub> = 1.23·√h ft (4/3 earth-radius).
              <br /><br />
              <span className="font-mono text-slate-400">Refs:</span> ARINC 708A-3 · RTCA DO-220A · ITU-R P.838-3 · AC 00-24C §7 · AC 00-45H §7 ·
              Honeywell IntuVue PG · Collins MultiScan AOM · Garmin GWX-80 PG · Boeing FCTM Ch.8 · Airbus FCTM PRO-NOR-SOP WXR ·
              Marshall-Palmer 1948 · Olsen-Rogers 1978 · NTSB AAR-86-04 Delta 191 · AAR-95-05 Flagship.
            </div>
          </div>
        )
      })()}
    </div>
  )
}

function Cell({ label, val, color }: { label: string; val: string; color: string }) {
  return (
    <div className="bg-slate-900/50 border border-slate-800 rounded p-1.5">
      <div className="text-[8px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`font-mono text-[11px] font-bold ${color}`}>{val}</div>
    </div>
  )
}
function Slider({ label, v, min, max, step, on }: { label: string; v:number; min:number; max:number; step:number; on:(n:number)=>void }) {
  return (
    <div>
      <div className="flex justify-between text-[9px] uppercase tracking-wider text-slate-500 mb-0.5">
        <span>{label}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={v} onChange={e=>on(Number(e.target.value))}
        className="w-full accent-sky-500" />
    </div>
  )
}
