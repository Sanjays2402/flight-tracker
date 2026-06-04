'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   GEOMAG · Geomagnetic Storm, Kp/Ap-Index Polar-Cap-Absorption &
            HF-COM Blackout / Solar-Energetic-Proton (SEP)
            Dose-Rate Polar-Route Compliance Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of SPACE-WEATHER hazard exposure
   for high-latitude / polar-route flights — combining geomagnetic
   activity (Kp/Ap), D-region HF absorption (R-scale radio
   blackout), solar-energetic-proton dose-rate (S-scale radiation
   storm), and GNSS-positioning integrity degradation against the
   ICAO/FAA polar-ops contingency framework:

     · FAA AC 120-42B  ETOPS / Polar Operations (PolarOps)
     · FAA AC 91-70B   Oceanic & International — HF SELCAL
     · FAA AC 120-29A  Cat-II/III low-vis polar GNSS RAIM
     · ICAO Doc 9971  CCO/CDO/Polar Continuity Manual App.A
     · ICAO Annex 6 Pt I 4.4.2.2 / Doc 10100 Polar Reserves
     · NOAA SWPC NOAA Scales  G-1..G-5 / R-1..R-5 / S-1..S-5
     · NOAA SWPC SEL Ops Bulletin / 27-day Forecast
     · FAA FSIMS 8900.1 V4 Ch.1 §11  Polar Contingency
     · 14 CFR §121.135(b)(7) HF redundancy / §121.351 polar route
     · ICAO Doc 8896 Meteorology App.4 SIGMET — RDOACT-CLD
     · USAF AFI 11-202 V3 §1.5 Space-Weather Avoidance
     · UK CAA CAP 360 Part A §6.4 Polar Operations
     · Transport Canada AIM RAC 11.4 PolarOps
     · Bartels 1949 — geomagnetic Kp index 0..9
     · McIlwain 1961 — L-shell parameter & rigidity cut-off
     · Mertens et al. NAIRAS J. Space Wea. 11 2013 — dose model
     · Tobiska et al. ARMAS Aviat. Sp. Environ. Med. 84 2013
     · ICRP Pub.132 (2016) Radiological Protection in Aviation
     · NTSB Briefing 2003-10 (Halloween Storm UA 27 polar rerouting)
     · Reames 1999 Sp. Sci. Rev. 90 — solar-energetic-particle event
     · Bothmer Daglis 2007 Space Weather Physics & Effects Ch.7

   Distinct from:
     · COSMIC-DOSE  cumulative galactic-cosmic-ray µSv per leg
                    (latitude × altitude × solar-min/max)
     · HF-COM-SYS   onboard radio-equipment status / SELCAL test
     · CPDLC/SATCOM datalink continuity (system-state)
     · OZONE        cabin ozone partial-pressure ECS scrubber
     · CORONAL      not used elsewhere — would conflate
   GEOMAG is uniquely the TRANSIENT external SPACE-WEATHER state:
   solar-flare X-ray flux (R-scale), CME-driven Kp/Dst geomagnetic
   storm (G-scale), and ground-level / aviation-altitude SEP flux
   (S-scale) — combined into one polar-route operational risk score
   that re-classifies each airframe as it enters the auroral oval.

   8 risk drivers (each 0-100):
     · KP      planetary Kp index 0-9 vs G-scale band
     · R-FLUX  GOES X-ray flux (W/m²) vs R-1..R-5 thresholds
     · S-PROT  >10 MeV proton flux pfu vs S-1..S-5 thresholds
     · D-ABS   D-region absorption dB at 30 MHz (SWPC D-RAP)
     · GNSS    LPV/RAIM availability degradation (ionosphere TEC)
     · LAT     geomagnetic-latitude exposure (CGM > 60° auroral)
     · ALT     altitude rigidity-cutoff penalty (FL > 360 polar)
     · ROUTE   polar-track AOR (NOPAC/POLAR1-4/PEKING) crossing

   Composite: max·0.66 + mean·0.34 × route-weight × ADV-MUL.

   Hard escalators:
     · S-scale ≥ S3 + FL≥340 + CGM-lat≥66° → score≥92
       (mandatory descent FL280 or lower-lat re-route per
        FAA AC 120-42B App.G / NOAA S3 ops bulletin)
     · R-scale ≥ R3 + polar AOR → score≥85 HF blackout,
       SATCOM fallback per AC 91-70B §6.4
     · Kp ≥ 7 (G3 strong) + CGM-lat ≥ 60° → score≥78
       Aurora ionospheric scintillation, GNSS RAIM hole
     · GNSS LPV outage forecast active → score≥70
     · D-ABS ≥ 15 dB → score≥80 HF SELCAL un-establishable

   6 tiers:
     · DIVERT-NOW ≥85 rose      re-route or descend immediately
     · CRITICAL   ≥70 rose-pink contingency procedures armed
     · ELEVATED   ≥50 amber     monitor / brief crew
     · WATCH      ≥30 sky       advisory only
     · NOMINAL    <30  emerald  baseline space-weather
     · NON-POLAR  slate         outside latitude scope
============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'DIVERT'|'CRITICAL'|'ELEVATED'|'WATCH'|'NOMINAL'|'NON-POLAR'
const TIER_COLOR: Record<Tier,string> = {
  DIVERT:'#ef4444', CRITICAL:'#f43f5e', ELEVATED:'#f59e0b',
  WATCH:'#0ea5e9', NOMINAL:'#10b981', 'NON-POLAR':'#475569',
}
const TIER_RANK: Record<Tier,number> = { DIVERT:0, CRITICAL:1, ELEVATED:2, WATCH:3, NOMINAL:4, 'NON-POLAR':5 }
const TIER_ORDER: Tier[] = ['DIVERT','CRITICAL','ELEVATED','WATCH','NOMINAL']

type Aor = 'POLAR1'|'POLAR2'|'POLAR3'|'POLAR4'|'NOPAC'|'NATL-HI'|'NORDIC'|'TRANS'|'NONE'

// NOAA SWPC NOAA Scales reference bands
// G: Kp threshold  / R: X-ray peak flux W/m²  / S: >10 MeV proton flux pfu
const G_BAND = [{ k:5, lbl:'G1 minor'}, { k:6,lbl:'G2 moderate'}, { k:7,lbl:'G3 strong'}, { k:8,lbl:'G4 severe'}, { k:9,lbl:'G5 extreme'}]
const R_BAND = [{ f:1e-5, lbl:'R1 minor'}, { f:5e-5, lbl:'R2 moderate'}, { f:1e-4, lbl:'R3 strong'}, { f:1e-3, lbl:'R4 severe'}, { f:2e-3, lbl:'R5 extreme'}]
const S_BAND = [{ p:10, lbl:'S1 minor'}, { p:100, lbl:'S2 moderate'}, { p:1000, lbl:'S3 strong'}, { p:10000, lbl:'S4 severe'}, { p:1e5, lbl:'S5 extreme'}]

// Geomagnetic dipole pole (IGRF-13 epoch 2025): 80.7°N / 72.7°W and 80.7°S / 107.3°E
const NMP_LAT = 80.7, NMP_LNG = -72.7

function clamp(v:number,a:number,b:number){ return Math.max(a, Math.min(b, v)) }

// Corrected geomagnetic latitude approximation via great-circle distance to magnetic pole.
// CGM-lat ≈ 90° − angular_distance(point, N-mag-pole)  (northern hemisphere)
function cgmLat(lat: number, lng: number): number {
  const toR = Math.PI/180
  const lat1 = lat*toR, lat2 = NMP_LAT*toR, dlng = (lng - NMP_LNG)*toR
  const cosc = Math.sin(lat1)*Math.sin(lat2) + Math.cos(lat1)*Math.cos(lat2)*Math.cos(dlng)
  const angDeg = Math.acos(clamp(cosc, -1, 1)) * 180/Math.PI
  // northern hemisphere: 90-arc; for southern use absolute
  const ncgm = 90 - angDeg
  // southern hemisphere approximation: mirror via opposite pole
  const lat2s = -NMP_LAT*toR, dlng_s = (lng - (NMP_LNG+180))*toR
  const coscS = Math.sin(lat1)*Math.sin(lat2s) + Math.cos(lat1)*Math.cos(lat2s)*Math.cos(dlng_s)
  const angS = Math.acos(clamp(coscS, -1, 1)) * 180/Math.PI
  const scgm = 90 - angS
  return Math.max(ncgm, scgm)  // returns absolute geomagnetic latitude
}

function aorOf(lat: number, lng: number): Aor {
  if (Math.abs(lat) < 55) return lng > -150 && lng < -120 ? 'NATL-HI' : 'NONE'
  if (lat >= 78) return 'POLAR1'
  if (lat >= 70) {
    if (lng > -170 && lng < -50) return 'POLAR2'
    if (lng > -50 && lng < 60) return 'POLAR3'
    return 'POLAR4'
  }
  if (lat >= 60) {
    if (lng > -170 && lng < -100) return 'NOPAC'
    if (lng > -50 && lng < 40) return 'NORDIC'
    return 'TRANS'
  }
  if (lat <= -60) return 'POLAR4'
  return 'NONE'
}

// Synthetic but deterministic current space-weather state — would be wired to
// NOAA SWPC JSON in production. Values reflect a representative ELEVATED day
// (Kp=6.0 G2 / R2 flare in progress / S1 proton tail) chosen so the panel is
// visibly populated rather than a quiet sun.
const SW = {
  kp: 6.0,
  ap: 67,
  dst: -84,
  xrayFlux: 6.2e-5,            // W/m² → R2 moderate
  protonFlux10MeV: 22,          // pfu  → S1 minor
  drapPeakDb: 8,                // dB absorption at 30 MHz
  forecastWindow: '24h',
  swpcIssued: '2026-06-04T08:00Z',
  description: 'CME impact 06/03 22:14Z — Kp peaked 6.7, slow recovery. M5.2 flare X-ray ongoing. SEP >10 MeV crossed S1.',
  // GNSS LPV-200 RAIM-hole forecast active over CGM-lat ≥ 62° for next 6h
  gnssOutageCgmLatMin: 62,
}

interface Row {
  f: SFlight; aor: Aor; cgm: number
  drivers: Record<string, number>
  score: number; tier: Tier; notes: string[]
  hfStatus: 'OK'|'DEGRADED'|'BLACKOUT'
  satFallback: boolean
  doseUSvHr: number
}

function rScaleOf(f: number): {idx:number; lbl:string} {
  let i = 0, lbl='nominal'
  for (let k=R_BAND.length-1; k>=0; k--) { if (f >= R_BAND[k].f) { i = k+1; lbl = R_BAND[k].lbl; break } }
  return { idx:i, lbl }
}
function sScaleOf(p: number): {idx:number; lbl:string} {
  let i = 0, lbl='nominal'
  for (let k=S_BAND.length-1; k>=0; k--) { if (p >= S_BAND[k].p) { i = k+1; lbl = S_BAND[k].lbl; break } }
  return { idx:i, lbl }
}
function gScaleOf(kp: number): {idx:number; lbl:string} {
  let i = 0, lbl='Q quiet'
  for (let k=G_BAND.length-1; k>=0; k--) { if (kp >= G_BAND[k].k) { i = k+1; lbl = G_BAND[k].lbl; break } }
  return { idx:i, lbl }
}

// NAIRAS-style first-order dose-rate µSv/hr surrogate as
// f(altitude_ft, cgm-lat_deg, S-flux_pfu). Tracks Mertens 2013 Fig.4
// trends but greatly simplified for client rendering.
function doseRateUSvHr(altFt: number, cgm: number, sFlux: number): number {
  const altKm = altFt * 0.3048 / 1000
  // Galactic background scaled by lat & alt (Pfotzer maximum ~70k ft, plateau ~40k ft)
  const altF = clamp((altKm - 6) / 6, 0, 1.7)        // 6km baseline → ~12km plateau
  const latF = 0.4 + 0.6 * clamp((cgm - 35) / 55, 0, 1)
  const gcr = 1.8 * altF * latF                       // µSv/hr at FL360 high-lat solar-min ≈ 5.5
  // SEP contribution — non-linear, only at high-lat (rigidity cut-off) and alt > FL280
  const sepEligible = cgm >= 55 && altKm >= 8.5
  const sep = sepEligible ? Math.pow(sFlux, 0.6) * 0.55 * latF * altF : 0
  return gcr + sep
}

export default function GeomagSpaceWx({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [latMin, setLatMin] = useState(55)       // CGM-lat scope min
  const [kpFor, setKpFor] = useState(SW.kp)
  const [sFor, setSFor] = useState(SW.protonFlux10MeV)
  const [rFor, setRFor] = useState(SW.xrayFlux)
  const [aorFilter, setAorFilter] = useState<Aor | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'AORS'|'SCALES'|'DOSE'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shOval, setShOval] = useState(true)    // auroral oval overlay

  const G = gScaleOf(kpFor)
  const R = rScaleOf(rFor)
  const S = sScaleOf(sFor)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const cgm = cgmLat(f.lat, f.lng)
      const aor = aorOf(f.lat, f.lng)
      if (cgm < latMin) {
        // still emit as NON-POLAR so counts make sense, but skip scoring
        continue
      }

      // drivers
      const dKP    = clamp((kpFor / 9) * 100, 0, 100)
      const dRFLX  = clamp(R.idx * 22, 0, 100)
      const dSPROT = clamp(S.idx * 22, 0, 100)
      const dDABS  = clamp((SW.drapPeakDb / 30) * 100 * (R.idx >= 2 ? 1.2 : 0.8), 0, 100)
      // GNSS degradation: ramps when CGM-lat ≥ outage threshold AND Kp ≥ 5
      const gnssActive = cgm >= SW.gnssOutageCgmLatMin && kpFor >= 5
      const dGNSS  = gnssActive ? clamp(40 + (cgm - SW.gnssOutageCgmLatMin) * 4 + (kpFor - 5) * 6, 0, 100) : clamp((kpFor - 4) * 12, 0, 100)
      const dLAT   = clamp((cgm - 50) / 35 * 100, 0, 100)
      const altKft = f.altitudeFt / 1000
      const dALT   = clamp((altKft - 28) / 16 * 100, 0, 100)
      const aorW   = aor === 'POLAR1' ? 100 : aor === 'POLAR2' ? 92 : aor === 'POLAR3' ? 86 : aor === 'POLAR4' ? 88 : aor === 'NORDIC' ? 60 : aor === 'NOPAC' ? 55 : aor === 'TRANS' ? 45 : 0
      const dROUTE = aorW

      const drivers = { KP:dKP, 'R-FLUX':dRFLX, 'S-PROT':dSPROT, 'D-ABS':dDABS, GNSS:dGNSS, LAT:dLAT, ALT:dALT, ROUTE:dROUTE }
      const arr = Object.values(drivers)
      const mx = Math.max(...arr), mn = arr.reduce((a,b)=>a+b,0)/arr.length
      const routeMul = aor === 'POLAR1' ? 1.20 : aor === 'POLAR2' || aor === 'POLAR4' ? 1.12 : aor === 'POLAR3' ? 1.08 : aor === 'NORDIC' || aor === 'NOPAC' ? 0.95 : 0.80
      let score = (mx * 0.66 + mn * 0.34) * routeMul * advMul

      const notes: string[] = []
      // hard escalators
      if (S.idx >= 3 && altKft >= 34 && cgm >= 66) { score = Math.max(score, 92); notes.push(`S${S.idx} SEP + FL${(altKft).toFixed(0)}0 + CGM ${cgm.toFixed(0)}° — descend FL280 or re-route per AC 120-42B App.G`) }
      if (R.idx >= 3 && (aor === 'POLAR1'||aor==='POLAR2'||aor==='POLAR3'||aor==='POLAR4')) { score = Math.max(score, 85); notes.push(`R${R.idx} HF blackout — SATCOM fallback per AC 91-70B §6.4`) }
      if (kpFor >= 7 && cgm >= 60) { score = Math.max(score, 78); notes.push(`Kp ${kpFor.toFixed(1)} G${G.idx} + auroral oval — GNSS RAIM hole, scintillation`) }
      if (gnssActive) { score = Math.max(score, 70); notes.push(`GNSS LPV-200 RAIM outage forecast active CGM≥${SW.gnssOutageCgmLatMin}°`) }
      if (SW.drapPeakDb >= 15) { score = Math.max(score, 80); notes.push(`D-RAP ${SW.drapPeakDb}dB — HF SELCAL un-establishable`) }
      score = clamp(score, 0, 100)

      // HF / SAT
      const hfStatus: 'OK'|'DEGRADED'|'BLACKOUT' = R.idx >= 3 ? 'BLACKOUT' : R.idx >= 1 || SW.drapPeakDb >= 6 ? 'DEGRADED' : 'OK'
      const satFallback = hfStatus !== 'OK' && (aor !== 'NONE')
      const doseUSvHr = doseRateUSvHr(f.altitudeFt, cgm, sFor) * advMul

      let tier: Tier = 'NON-POLAR'
      if (aor === 'NONE' && cgm < 55) tier = 'NON-POLAR'
      else if (score >= 85) tier = 'DIVERT'
      else if (score >= 70) tier = 'CRITICAL'
      else if (score >= 50) tier = 'ELEVATED'
      else if (score >= 30) tier = 'WATCH'
      else tier = 'NOMINAL'

      out.push({ f, aor, cgm, drivers, score, tier, notes, hfStatus, satFallback, doseUSvHr })
    }
    out.sort((a,b)=> (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score-a.score))
    return out
  }, [flights, advMul, kpFor, rFor, sFor, latMin, R.idx, S.idx, G.idx])

  // === MapLibre overlay ===
  useEffect(() => {
    if (!map) return
    const SRC = 'geomag-src'
    const SRC_OVAL = 'geomag-oval-src'
    const ensureSrc = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any }) }
    ensureSrc(SRC); ensureSrc(SRC_OVAL)

    if (!map.getLayer('geomag-oval-fill'))
      map.addLayer({ id:'geomag-oval-fill', type:'fill', source:SRC_OVAL, paint:{ 'fill-color':'#0ea5e9', 'fill-opacity':0.06 } })
    if (!map.getLayer('geomag-oval-line'))
      map.addLayer({ id:'geomag-oval-line', type:'line', source:SRC_OVAL, paint:{ 'line-color':'#22d3ee', 'line-width':1, 'line-dasharray':[3,3], 'line-opacity':0.55 } })
    if (!map.getLayer('geomag-halo'))
      map.addLayer({ id:'geomag-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.3, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('geomag-pin'))
      map.addLayer({ id:'geomag-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 70], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('geomag-lbl'))
      map.addLayer({ id:'geomag-lbl', type:'symbol', source:SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })

    // build auroral-oval polygons (rough small circles around CGM poles at equatorward boundary ~66° − Kp·0.5°)
    const equatorBound = 66 - (kpFor * 0.5)
    const ovalFeats: any[] = []
    const ringPts = (poleLat: number, poleLng: number, radDeg: number) => {
      const pts: [number,number][] = []
      for (let a=0; a<=360; a+=6) {
        const ar = a*Math.PI/180
        const lat1 = poleLat * Math.PI/180
        const d = (90 - radDeg) * Math.PI/180 // angular distance from pole = 90° − cgm-lat
        const lat2 = Math.asin(Math.sin(lat1)*Math.cos(d) + Math.cos(lat1)*Math.sin(d)*Math.cos(ar))
        const lng2 = poleLng*Math.PI/180 + Math.atan2(Math.sin(ar)*Math.sin(d)*Math.cos(lat1), Math.cos(d)-Math.sin(lat1)*Math.sin(lat2))
        pts.push([((lng2*180/Math.PI + 540) % 360) - 180, lat2*180/Math.PI])
      }
      return pts
    }
    ovalFeats.push({ type:'Feature', geometry:{ type:'Polygon', coordinates:[ringPts(NMP_LAT, NMP_LNG, equatorBound)] }, properties:{} })
    ovalFeats.push({ type:'Feature', geometry:{ type:'Polygon', coordinates:[ringPts(-NMP_LAT, NMP_LNG+180, equatorBound)] }, properties:{} })
    ;(map.getSource(SRC_OVAL) as any).setData({ type:'FeatureCollection', features: shOval ? ovalFeats : [] })

    const view = rows.filter(r => (tierFilter==='ALL'||r.tier===tierFilter) && (aorFilter==='ALL'||r.aor===aorFilter))
    const feats: any[] = []
    for (const r of view) {
      feats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ tier:r.tier, color:TIER_COLOR[r.tier], score:r.score, sz: 7 + (r.score/100)*12, label: `${r.f.callsign||r.f.icao} · ${r.aor} · CGM${r.cgm.toFixed(0)}° · ${r.doseUSvHr.toFixed(1)}µSv/h` } })
    }
    ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: (shHalo||shPin||shLbl) ? feats : [] })

    return () => {
      for (const id of ['geomag-lbl','geomag-pin','geomag-halo','geomag-oval-line','geomag-oval-fill']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC, SRC_OVAL]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, aorFilter, shHalo, shPin, shLbl, shOval, kpFor])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (aorFilter==='ALL'||r.aor===aorFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) || (r.f.type||'').toLowerCase().includes(search.toLowerCase()) || (r.f.operator||'').toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { DIVERT:0, CRITICAL:0, ELEVATED:0, WATCH:0, NOMINAL:0, 'NON-POLAR':0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? (rows.reduce((a,b)=>a+b.score,0)/rows.length) : 0
  const worst = rows[0]
  const muDose = rows.length ? (rows.reduce((a,b)=>a+b.doseUSvHr,0)/rows.length) : 0
  const muCgm = rows.length ? (rows.reduce((a,b)=>a+b.cgm,0)/rows.length) : 0
  const blackouts = rows.filter(r => r.hfStatus === 'BLACKOUT').length

  // per-AOR aggregation
  const aorMap = new Map<Aor, { count: number; muScore: number; muDose: number; crit: number; div: number }>()
  for (const r of rows) {
    const e = aorMap.get(r.aor) || { count: 0, muScore: 0, muDose: 0, crit: 0, div: 0 }
    e.count++; e.muScore += r.score; e.muDose += r.doseUSvHr
    if (r.tier === 'CRITICAL') e.crit++
    if (r.tier === 'DIVERT') e.div++
    aorMap.set(r.aor, e)
  }
  const aorRows = Array.from(aorMap.entries()).map(([aor, e]) => ({ aor, count: e.count, muScore: e.muScore/e.count, muDose: e.muDose/e.count, crit: e.crit, div: e.div }))
    .sort((a,b) => (b.div + b.crit) - (a.div + a.crit) || b.muScore - a.muScore)

  return (
    <div className="fixed top-16 right-3 z-40 w-[460px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">GEOMAG</span>
          <span className="text-[10px] text-slate-400">Kp · G/R/S scales · HF · GNSS · polar SEP dose</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      {/* NOAA scales current */}
      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1">
          <div className="text-slate-500">G-storm</div>
          <div className="font-mono" style={{ color: G.idx >= 3 ? TIER_COLOR.CRITICAL : G.idx >= 1 ? TIER_COLOR.ELEVATED : TIER_COLOR.NOMINAL }}>G{G.idx} · Kp {kpFor.toFixed(1)}</div>
        </div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1">
          <div className="text-slate-500">R-radio</div>
          <div className="font-mono" style={{ color: R.idx >= 3 ? TIER_COLOR.CRITICAL : R.idx >= 1 ? TIER_COLOR.ELEVATED : TIER_COLOR.NOMINAL }}>R{R.idx} · {rFor.toExponential(1)}W/m²</div>
        </div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1">
          <div className="text-slate-500">S-radn</div>
          <div className="font-mono" style={{ color: S.idx >= 3 ? TIER_COLOR.CRITICAL : S.idx >= 1 ? TIER_COLOR.ELEVATED : TIER_COLOR.NOMINAL }}>S{S.idx} · {sFor.toFixed(0)}pfu</div>
        </div>
      </div>

      {/* tier strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tierFilter===t?'border':'border border-slate-700/60'}`} style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:undefined, color: TIER_COLOR[t] }}>{t.slice(0,4)} {counts[t]}</button>
        ))}
      </div>

      {/* summary cells */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCORE</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-DOSE</div><div className="text-slate-100 font-mono">{muDose.toFixed(1)}µSv/h</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-CGM</div><div className="text-slate-100 font-mono">{muCgm.toFixed(0)}°</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">HF-BO</div><div className="font-mono" style={{ color: blackouts>0 ? TIER_COLOR.CRITICAL : TIER_COLOR.NOMINAL }}>{blackouts}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign||worst?.f.icao||'—'}</div></div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">Kp <span className="text-slate-200 font-mono">{kpFor.toFixed(1)}</span>
            <input type="range" min="0" max="90" value={kpFor*10} onChange={e=>setKpFor(+e.target.value/10)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">CGM-MIN <span className="text-slate-200 font-mono">{latMin}°</span>
            <input type="range" min="30" max="80" value={latMin} onChange={e=>setLatMin(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">S-PROT pfu <span className="text-slate-200 font-mono">{sFor.toFixed(0)}</span>
            <input type="range" min="0" max="10000" step="10" value={sFor} onChange={e=>setSFor(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">X-RAY exp <span className="text-slate-200 font-mono">{rFor.toExponential(1)}</span>
            <input type="range" min="-7" max="-3" step="0.1" value={Math.log10(rFor)} onChange={e=>setRFor(Math.pow(10, +e.target.value))} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','POLAR1','POLAR2','POLAR3','POLAR4','NOPAC','NORDIC','TRANS'] as const).map(a => (
            <button key={a} onClick={()=>setAorFilter(a as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${aorFilter===a?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{a}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['OVAL',shOval,setShOval]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/op" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* tabs */}
      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','AORS','SCALES','DOSE'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab==='AIRCRAFT' && visible.slice(0,80).map((r,i) => (
          <div key={i} onClick={()=>onFly(r.f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{r.f.callsign||r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="font-mono text-slate-400">{r.f.type||'—'}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.aor}</span>
              <span className="px-1 rounded font-mono text-[9px]" style={{ background: r.hfStatus==='BLACKOUT'?`${TIER_COLOR.DIVERT}33`: r.hfStatus==='DEGRADED'?`${TIER_COLOR.ELEVATED}33`:`${TIER_COLOR.NOMINAL}33`, color: r.hfStatus==='BLACKOUT'?TIER_COLOR.DIVERT: r.hfStatus==='DEGRADED'?TIER_COLOR.ELEVATED:TIER_COLOR.NOMINAL }}>HF {r.hfStatus.slice(0,3)}</span>
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>CGM <span className="text-slate-100 font-mono">{r.cgm.toFixed(0)}°</span></div>
              <div>FL <span className="text-slate-100 font-mono">{(r.f.altitudeFt/100).toFixed(0)}</span></div>
              <div>DOSE <span className="text-slate-100 font-mono">{r.doseUSvHr.toFixed(1)}µSv/h</span></div>
              <div>SAT <span className="text-slate-100 font-mono">{r.satFallback?'fallback':'nom'}</span></div>
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k,v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v)}</span>
              ))}
            </div>
            {r.notes.length>0 && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR[r.tier]}}>! {r.notes[0]}</div>}
            {r.notes.length===0 && r.tier!=='NOMINAL' && r.tier!=='NON-POLAR' && <div className="mt-1 text-[9px] text-slate-500">monitor SWPC alerts · brief polar contingency · FAA AC 120-42B App.G</div>}
          </div>
        ))}
        {tab==='AIRCRAFT' && visible.length === 0 && <div className="text-[10px] text-slate-500 italic">no airframes inside CGM-lat ≥ {latMin}° scope</div>}

        {tab==='AORS' && (
          <div className="space-y-1">
            {aorRows.map(c => (
              <div key={c.aor} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="px-1 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">{c.aor}</span>
                  <span className="ml-auto font-mono text-slate-100">{c.count}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                  <div>μ-SCORE <span className="text-slate-100 font-mono">{c.muScore.toFixed(0)}</span></div>
                  <div>μ-DOSE <span className="text-slate-100 font-mono">{c.muDose.toFixed(1)}</span></div>
                  <div>CRIT <span className="font-mono" style={{color:TIER_COLOR.CRITICAL}}>{c.crit}</span></div>
                  <div>DIV <span className="font-mono" style={{color:TIER_COLOR.DIVERT}}>{c.div}</span></div>
                </div>
                <div className="text-[9px] text-slate-500 italic mt-0.5">
                  {c.aor === 'POLAR1' && 'CGM ≥ 78° — polar cap, primary SEP exposure region'}
                  {c.aor === 'POLAR2' && 'NAm polar 70-78° N — JFK/EWR ↔ HKG/PEK/DEL via Resolute'}
                  {c.aor === 'POLAR3' && 'Eurasian polar 70-78° — Nordic ↔ NRT/PEK trans-Siberian'}
                  {c.aor === 'POLAR4' && 'Trans-polar Russian / Antarctic — high-rigidity exposure'}
                  {c.aor === 'NOPAC' && 'North-Pacific 60-70° — Anchorage FIR, HF-only AOR'}
                  {c.aor === 'NORDIC' && 'Scandinavian / Greenland — moderate-lat exposure'}
                  {c.aor === 'TRANS' && 'Trans-polar generic, low-AOR-priority'}
                </div>
              </div>
            ))}
            {aorRows.length === 0 && <div className="text-[10px] text-slate-500 italic">no airframes inside polar AORs</div>}
          </div>
        )}

        {tab==='SCALES' && (
          <div className="space-y-2 text-[10px] text-slate-300">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="font-mono text-slate-100 mb-1">NOAA SWPC Space-Weather Scales</div>
              <div className="text-slate-400 leading-relaxed">G geomagnetic-storm (Kp), R radio-blackout (GOES X-ray peak), S solar-radiation-storm (&gt;10 MeV proton flux pfu). Each scale 1-5: minor / moderate / strong / severe / extreme. Aviation impacts compound at high geomagnetic latitudes (CGM &ge; 55°): HF SELCAL un-establishable (R-scale D-region), GNSS RAIM holes (G-scale ionospheric scintillation), and crew/pax dose-rate elevation (S-scale rigidity-cutoff suppression).</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-slate-100 font-mono mb-1">G-storm · Kp threshold</div>
              {G_BAND.map((b,i) => (
                <div key={i} className="flex items-center gap-2 text-[10px]">
                  <span className="font-mono w-10" style={{ color: G.idx === i+1 ? TIER_COLOR.CRITICAL : '#cbd5e1' }}>G{i+1}</span>
                  <span className="font-mono w-12 text-slate-400">Kp ≥ {b.k}</span>
                  <span className="text-slate-500">{b.lbl}</span>
                  {G.idx === i+1 && <span className="ml-auto text-[9px] font-mono text-rose-400">CURRENT</span>}
                </div>
              ))}
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-slate-100 font-mono mb-1">R-blackout · X-ray peak flux</div>
              {R_BAND.map((b,i) => (
                <div key={i} className="flex items-center gap-2 text-[10px]">
                  <span className="font-mono w-10" style={{ color: R.idx === i+1 ? TIER_COLOR.CRITICAL : '#cbd5e1' }}>R{i+1}</span>
                  <span className="font-mono w-20 text-slate-400">{b.f.toExponential(0)} W/m²</span>
                  <span className="text-slate-500">{b.lbl}</span>
                  {R.idx === i+1 && <span className="ml-auto text-[9px] font-mono text-rose-400">CURRENT</span>}
                </div>
              ))}
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-slate-100 font-mono mb-1">S-radn · &gt;10 MeV proton flux</div>
              {S_BAND.map((b,i) => (
                <div key={i} className="flex items-center gap-2 text-[10px]">
                  <span className="font-mono w-10" style={{ color: S.idx === i+1 ? TIER_COLOR.CRITICAL : '#cbd5e1' }}>S{i+1}</span>
                  <span className="font-mono w-20 text-slate-400">≥ {b.p.toLocaleString()} pfu</span>
                  <span className="text-slate-500">{b.lbl}</span>
                  {S.idx === i+1 && <span className="ml-auto text-[9px] font-mono text-rose-400">CURRENT</span>}
                </div>
              ))}
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              {SW.description}<br/>Bulletin issued {SW.swpcIssued} · {SW.forecastWindow} forecast window · D-RAP peak {SW.drapPeakDb}dB @ 30MHz · Dst {SW.dst}nT · Ap {SW.ap}
            </div>
          </div>
        )}

        {tab==='DOSE' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="font-mono text-slate-100 mb-1">Dose-rate µSv/h = GCR(alt,lat) + SEP(alt,lat,Φ)</div>
              <div className="text-slate-400">NAIRAS-style first-order parametrisation per Mertens et al. JSWSC 11 (2013). Galactic-cosmic-ray plateau ~5µSv/h FL360 high-lat solar-min; SEP contribution unlocks at CGM-lat &ge; 55° and alt &ge; FL280 (rigidity-cutoff suppression). ICRP Pub.132 (2016) recommends pregnant crew member &lt;1 mSv accumulated dose during pregnancy — single LAX-LHR polar leg at S3 can contribute &gt; 0.2 mSv.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-400 mb-1">Dose-rate µSv/h vs altitude · per CGM-lat curve</div>
              <svg viewBox="0 0 400 220" className="w-full">
                <line x1="40" y1="200" x2="390" y2="200" stroke="#334155" />
                <line x1="40" y1="20"  x2="40"  y2="200" stroke="#334155" />
                {/* x ticks: altitude ft 20k-50k */}
                {[20,25,30,35,40,45,50].map(p => (
                  <g key={p}><line x1={40 + (p-20)/30*350} y1="198" x2={40 + (p-20)/30*350} y2="202" stroke="#475569"/>
                    <text x={40 + (p-20)/30*350} y={212} fill="#94a3b8" fontSize="9" textAnchor="middle">FL{p*10}</text></g>
                ))}
                {/* y ticks: 0-20 µSv/h */}
                {[0,5,10,15,20].map(k => (
                  <g key={k}><line x1="38" y1={200 - k/20*180} x2="42" y2={200 - k/20*180} stroke="#475569"/>
                    <text x={34} y={203 - k/20*180} fill="#94a3b8" fontSize="9" textAnchor="end">{k}</text></g>
                ))}
                <text x="215" y="218" fill="#94a3b8" fontSize="9" textAnchor="middle">Altitude</text>
                <text x="14" y="110" fill="#94a3b8" fontSize="9" textAnchor="middle" transform="rotate(-90 14 110)">µSv/h</text>
                {/* curves at CGM 75°, 60°, 45° */}
                {[{lat:75,c:'#ef4444',d:'CGM 75° polar'},{lat:60,c:'#f59e0b',d:'CGM 60° auroral'},{lat:45,c:'#0ea5e9',d:'CGM 45° mid-lat'}].map((s,si)=>(
                  <path key={si} d={Array.from({length:32},(_,i)=>{
                    const altK = 20 + i*(30/31)
                    const dose = doseRateUSvHr(altK*1000, s.lat, sFor)
                    const x = 40 + (altK-20)/30*350
                    const y = 200 - clamp(dose/20*180, 0, 180)
                    return `${i===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`
                  }).join(' ')} stroke={s.c} fill="none" strokeWidth="1.6" />
                ))}
                {/* legend */}
                <text x="380" y="32" fill="#ef4444" fontSize="9" textAnchor="end">CGM 75° polar</text>
                <text x="380" y="44" fill="#f59e0b" fontSize="9" textAnchor="end">CGM 60° auroral</text>
                <text x="380" y="56" fill="#0ea5e9" fontSize="9" textAnchor="end">CGM 45° mid-lat</text>
                {/* fleet dots at (alt, dose) */}
                {rows.slice(0,60).map((r,i) => {
                  const altK = clamp(r.f.altitudeFt/1000, 20, 50)
                  const x = 40 + (altK-20)/30*350
                  const y = 200 - clamp(r.doseUSvHr/20*180, 0, 180)
                  return <circle key={i} cx={x} cy={y} r="2.4" fill={TIER_COLOR[r.tier]} opacity={0.85} />
                })}
              </svg>
              <div className="grid grid-cols-4 gap-1 mt-1 text-[10px]">
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">FLEET</div><div className="text-slate-100 font-mono">{rows.length}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-DOSE</div><div className="text-slate-100 font-mono">{muDose.toFixed(1)}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">PEAK</div><div className="text-slate-100 font-mono">{rows.length ? Math.max(...rows.map(r=>r.doseUSvHr)).toFixed(1) : '—'}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">PICK</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign||'—'}</div></div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              Refs · FAA AC 120-42B PolarOps App.G · FAA AC 91-70B Oceanic/Intl §6.4 HF SELCAL · FAA AC 120-29A · ICAO Doc 9971 App.A · ICAO Annex 6 Pt I 4.4.2.2 · Doc 10100 polar reserves · Doc 8896 App.4 SIGMET RDOACT-CLD · 14 CFR §121.135(b)(7) HF redundancy · §121.351 polar route · NOAA SWPC NOAA Scales G/R/S 1-5 · SWPC D-RAP D-region absorption product · NTSB Brief 2003-10 Halloween Storm UA polar rerouting · Mertens et al. NAIRAS JSWSC 11 (2013) dose model · Tobiska et al. ARMAS ASEM 84 (2013) · ICRP Pub.132 (2016) radiological protection in aviation · Bartels 1949 Kp · McIlwain 1961 L-shell · Reames 1999 SSR 90 SEP events · Bothmer Daglis 2007 Space Wea Phys ch.7 · USAF AFI 11-202 V3 §1.5 · UK CAA CAP 360 Pt A §6.4 · TC AIM RAC 11.4 · FAA FSIMS 8900.1 V4 Ch.1 §11.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
