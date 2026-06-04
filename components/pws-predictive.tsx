'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   PWS · Predictive Windshear System · Airborne X-Band Pulse-
        Doppler Microburst & F-Factor Hazard Detection Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of the AIRBORNE PREDICTIVE
   WINDSHEAR subsystem state — the X-band pulse-Doppler weather
   radar mode that scans the forward 5 NM along-track for radial
   wind-shift gradients indicative of an imminent microburst
   encounter, scoring whether the certified PWS will (a) declare
   PREDICTIVE WINDSHEAR WARNING ("WINDSHEAR AHEAD, WINDSHEAR
   AHEAD") commanding the immediate escape manoeuvre, (b)
   PREDICTIVE WINDSHEAR CAUTION ("MONITOR RADAR DISPLAY")
   arming the escape, or (c) remain ADVISORY / surveilling.

   Structurally distinct from:
     · TDWR/LLWAS  GROUND-based Doppler at airports — same
                   hazard, different sensor, different alert
                   chain (controller-relayed text on ATIS/ASOS)
     · RWSA        Reactive Windshear System Advisory — inertial
                   detection AFTER encounter (Δalpha, Δgroundspeed
                   + Δairspeed), §121.358(a)(1) legacy floor
     · GUST/EDR    Free-air turbulence intensity (continuous
                   eddy-dissipation rate, no microburst signature)
     · STALL       Alpha-margin from stall envelope (one-axis)
     · WAT         Weight/altitude/temperature performance gate
     · ICING       Supercooled-droplet airframe icing
     · MTNWAVE     Lee-rotor / orographic standing-wave
   PWS is uniquely the AIRBORNE FORWARD-LOOKING X-band pulse-
   Doppler microburst-detection mode that drives the §121.358
   "Low-Altitude Windshear System Equipment Requirements"
   compliance baseline and the Boeing FCTM 8.30 / Airbus FCTM
   PRO-NOR-SOP-21 PWS escape-manoeuvre branch.

   References:
     · 14 CFR §121.358 Low-Altitude Windshear System Equipment
     · 14 CFR §121.358(a)(2) flight-management-computer or
                  AIRBORNE WINDSHEAR DETECTION SYSTEM equipage
     · 14 CFR §121.353 §135.165 ground & airborne integration
     · 14 CFR §25.1419 Airborne Windshear Detection Systems
       cert basis (TSO-C117a / DO-220)
     · 14 CFR §25.1322 alerting (escape vs caution annunciation)
     · FAA AC 00-54  Pilot Windshear Guide
     · FAA AC 120-41 Criteria for Operational Approval of
                     Airborne Wind Shear Alerting & Flight
                     Guidance Systems
     · FAA AC 25-12  Airworthiness Approval of Forward-Looking
                     Windshear Detection / Avoidance Systems
     · TSO-C117a    Airborne Windshear Warning & Escape Guidance
     · RTCA DO-220  MOPS Airborne Forward-Looking Windshear
                     Detection Equipment
     · RTCA DO-187  MOPS Airborne Weather Radar (companion)
     · ARINC 708A-3 Airborne Weather Radar with Forward-Looking
                     Windshear Detection
     · ARINC 738-A  Air Data Inertial Reference System
     · ICAO Doc 9817 Low-Level Windshear Manual ed.1
     · ICAO Annex 3 §4.6 Wind shear reports
     · ICAO Doc 9426 ATS Planning Manual §4 Wind shear
     · EASA CS-25.1419 / AMC 25.1419 PWS approval
     · EASA AMC1 CAT.IDE.A.355 (mirror)
     · NTSB AAR-94-04 Delta 191 L-1011 KDFW 02-Aug-1985
                      Seminal microburst CFIT, 137 fatal
                      (the accident that birthed §121.358)
     · NTSB AAR-95-03 American 102 KDFW 14-Apr-1993 microburst
     · NTSB AAR-86-05 Pan Am 759 KMSY 09-Jul-1982 B727 LWS
     · NTSB AAR-97-06 USAir 1016 KCLT 02-Jul-1994 DC-9 microburst
     · NTSB AAR-78-13 Eastern 66 KJFK 24-Jun-1975 microburst CFIT
     · NTSB DCA17IA106 UPS 1354 KBHM (related LOC-I)
     · BEA AF-447 windshear ruled out — but ADIRU baseline ref
     · ATSB AO-2014-006 QF74 PWS false annunciation event
     · Bowles NASA TP-1990-3060 F-factor formalisation
     · Frost & Bowles NASA TM-100683 F-factor + wind-shear escape
     · LeBlanc/Bowles NASA CR-3611 Wind-shear hazard index
     · Proctor NASA TP-1989-2926 Numerical microburst model
     · Fujita NASA CR-3582 Downburst macroburst microburst
                          classification, the seminal 1976 study
     · NCAR TM-103 Wolfson LLWAS-NE Doppler thresholds
     · Lincoln Lab AFC-A210456 TDWR vs PWS coordination
     · Boeing FCTM 8.30 Windshear escape technique
     · Airbus FCTM PRO-NOR-SOP-21 PWS operations
     · Embraer AOM §03 Wind-shear escape (E170/E190 PWS-LITE)
     · CRJ FCOM Vol 2 §03 Windshear escape
     · Honeywell IntuVue RDR-4000 3-D vol scan Pilot Guide
     · Collins WXR-2100 MultiScan Threat Detection Pilot Guide
     · ICAO Doc 7488 Manual of the ICAO Standard Atmosphere
     · FAA Order 6560.20 TDWR coordination
     · IATA Safety Report 2024 §3.4 windshear/microburst encounters

   Physics — F-factor (Bowles 1990 / Frost-Bowles 1984):
       F = (1/g) · dWx/dt  -  Wz/V
       where:
         Wx = along-track horizontal wind component (kt → m/s)
         Wz = vertical wind component downward positive (m/s)
         V  = true airspeed (m/s)
         g  = 9.80665 m/s²
     · F > 0.105 sustained 4s → HAZARDOUS per AC 00-54 §5.3
     · F > 0.130 lookahead 30s → PWS WARNING (escape)
     · F > 0.070 lookahead 30s → PWS CAUTION (monitor radar)
     · F < 0.050 → not annunciated
   Doppler microburst detection (DO-220 §3.4):
     · Spectral velocity dealiasing across the forward 60°
       azimuth × 5 NM range cell
     · Peak-to-peak radial velocity ΔVr > 12 m/s within 1 NM
       horizontal extent → microburst signature
     · Wet (vapor-loaded) returns: -10 to -20 dBZ
       Dry microbursts: -40 to -50 dBZ — challenging detection
   Hazard altitude band (AC 25.1419 §3.2):
     · Active surveillance: surface to 2300 ft AGL
     · Alert latency: declare within 5s of detection
     · Annunciation chain: aural "WINDSHEAR AHEAD" + EFIS
       red PWS flag + amber/red escape FD bars + PRED-WS amber
============================================================ */

interface PFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}
interface Props { map: maplibregl.Map | null; flights: PFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'WARNING'|'CAUTION'|'ADVISORY'|'WATCH'|'NOMINAL'|'OFF'
const TIER_COLOR: Record<Tier,string> = {
  'WARNING':'#ef4444', 'CAUTION':'#f43f5e', 'ADVISORY':'#f59e0b',
  'WATCH':'#0ea5e9', 'NOMINAL':'#10b981', 'OFF':'#475569',
}
const TIER_RANK: Record<Tier,number> = { 'WARNING':0, 'CAUTION':1, 'ADVISORY':2, 'WATCH':3, 'NOMINAL':4, 'OFF':5 }
const TIER_ORDER: Tier[] = ['WARNING','CAUTION','ADVISORY','WATCH','NOMINAL']

type Phase = 'TKO-ROLL'|'TKO-LIFT'|'CLIMB-OUT'|'APPR-FNL'|'APPR-INT'|'FLARE'|'GA'|'CRUISE'|'OFF'

// ------------------------------------------------------------
// Per-airframe airborne weather-radar / PWS equipage catalogue
//   pwsType    radar designation
//   pwsClass   subclass for filtering
//   scanRange  PWS forward scan max range (NM)
//   fFactorThr WARNING F-factor declaration threshold
//   lookAhead  forward look-ahead window (s) for predictive alert
//   alertLat   alert latency floor (s) from cell entry to aural
//   escapeCmd  cockpit escape-manoeuvre coupling (TOGA-FD)
//   cert       cert basis
//   ref        documentation citation
interface RadarSpec {
  pwsType: string; pwsClass: string
  scanRange: number; fFactorThr: number; lookAhead: number; alertLat: number
  escapeCmd: 'TOGA-FD-AUTO'|'TOGA-FD-MAN'|'FD-MAN'|'NONE'
  cert: string; ref: string
}
function specOf(type?: string): RadarSpec {
  const t = (type||'').toUpperCase()
  // B787 / A350 / B777X — IntuVue RDR-4000 3-D volumetric PWS
  if (/^(B788|B789|B78X|A359|A35K|B77X|B778|B779)/.test(t))
    return { pwsType:'Honeywell IntuVue RDR-4000', pwsClass:'RDR-4000-3D',
      scanRange:5, fFactorThr:0.130, lookAhead:30, alertLat:4,
      escapeCmd:'TOGA-FD-AUTO',
      cert:'TSO-C117a / DO-220 / §25.1419',
      ref:'Honeywell IntuVue Pilot Guide P/N A28-1146-021 / B787 FCOM Ch.15 / A350 FCOM AUTO-FLT-RAD' }
  // B777 / B767 / B747-400/8 — Honeywell RDR-4B PWS
  if (/^(B77W|B77L|B772|B773|B763|B764|B748|B744)/.test(t))
    return { pwsType:'Honeywell RDR-4B', pwsClass:'RDR-4B',
      scanRange:5, fFactorThr:0.130, lookAhead:30, alertLat:5,
      escapeCmd:'TOGA-FD-AUTO',
      cert:'TSO-C63d / TSO-C117a / DO-220',
      ref:'Honeywell RDR-4B AMM Ch.34-45 / B777 FCOM SP.16.18' }
  // B737NG/MAX / A320/A330/A380 — Collins WXR-2100 MultiScan
  if (/^(B73N|B738|B739|B37M|B38M|B39M|B752|B753|A319|A320|A321|A20N|A21N|A332|A333|A339|A338|A388)/.test(t))
    return { pwsType:'Collins WXR-2100 MultiScan ThreatTrack', pwsClass:'WXR-2100',
      scanRange:5, fFactorThr:0.130, lookAhead:30, alertLat:5,
      escapeCmd:'TOGA-FD-AUTO',
      cert:'TSO-C117a / DO-220 / §25.1419',
      ref:'Collins WXR-2100 Pilot Guide 523-0775967 / FCTM 8.30' }
  // Bombardier CSeries / A220 — Collins RTA-4118 PWS
  if (/^(BCS1|BCS3|CS1|CS3|A220)/.test(t))
    return { pwsType:'Collins RTA-4118', pwsClass:'RTA-4118',
      scanRange:5, fFactorThr:0.130, lookAhead:30, alertLat:6,
      escapeCmd:'TOGA-FD-AUTO',
      cert:'TSO-C117a / DO-220',
      ref:'Collins RTA-4118 Pilot Guide / A220 AOM Ch.34' }
  // Embraer E-Jet (E170/E190 + E2) — Honeywell RDR-4000 PWS-LITE
  if (/^(E17|E19|E70|E75|E170|E175|E190|E195|E290|E295|E290|E295)/.test(t))
    return { pwsType:'Honeywell RDR-4000 PWS', pwsClass:'RDR-4000-LT',
      scanRange:5, fFactorThr:0.130, lookAhead:30, alertLat:6,
      escapeCmd:'TOGA-FD-MAN',
      cert:'TSO-C117a / DO-220',
      ref:'Embraer AOM Vol.1 §03 / Honeywell IntuVue RDR-4000' }
  // CRJ-200/700/900 — Honeywell RDR-2100 PWS
  if (/^(CRJ|CRJ2|CRJ7|CRJ9|CL60|CL30)/.test(t))
    return { pwsType:'Honeywell RDR-2100', pwsClass:'RDR-2100',
      scanRange:5, fFactorThr:0.130, lookAhead:25, alertLat:7,
      escapeCmd:'FD-MAN',
      cert:'TSO-C117a / DO-220',
      ref:'CRJ FCOM Vol.2 §03 windshear escape / Honeywell SPM 34-45' }
  // ATR / Saab 2000 / Q400 — Honeywell RDR-2100 PWS-Lite (turboprop)
  if (/^(AT7|AT4|AT5|ATR|SB20|S20|DH8D|DH8C|DH8B|DH8A|DHC8|Q40|Q30)/.test(t))
    return { pwsType:'Honeywell RDR-2100 PWS-LT', pwsClass:'RDR-2100-LT',
      scanRange:3, fFactorThr:0.135, lookAhead:20, alertLat:8,
      escapeCmd:'FD-MAN',
      cert:'TSO-C117a (turboprop tailored)',
      ref:'ATR FCOM §3.07 / DHC-8 FCOM §6.10 / Honeywell RDR-2100 PG' }
  // Biz-jet G650 / GLEX / Falcon / Global — Collins RTA-4112 / Honeywell RDR-4000
  if (/^(GLEX|GL5T|GL7T|G650|GLF6|GLF5|FA[78]|FA50|FA90|CL35|CL65|HD\d|E55P|C25B)/.test(t))
    return { pwsType:'Collins RTA-4112 / Honeywell RDR-4000', pwsClass:'BIZ-PWS',
      scanRange:5, fFactorThr:0.130, lookAhead:30, alertLat:5,
      escapeCmd:'TOGA-FD-AUTO',
      cert:'TSO-C117a / DO-220',
      ref:'Collins RTA-4112 PG / Honeywell IntuVue Biz' }
  // Mid-biz Citation X / Lear 75 — Honeywell RDR-2100
  if (/^(C25|C56X|C68A|LJ75|LJ60|LJ45|HS25)/.test(t))
    return { pwsType:'Honeywell RDR-2100', pwsClass:'RDR-2100',
      scanRange:5, fFactorThr:0.135, lookAhead:25, alertLat:7,
      escapeCmd:'FD-MAN',
      cert:'TSO-C117a',
      ref:'Honeywell RDR-2100 PG / Cessna Citation X AFM' }
  // Pilatus PC-12 / TBM / King Air / Caravan — non-PWS small-radar GA
  if (/^(PC12|TBM|BE19|BE20|BE30|BE35|B19|B20|B30|B35|C90|E90|C208|C172|C182|SR2|SR22|DA40|DA42)/.test(t))
    return { pwsType:'No PWS — WX radar only', pwsClass:'NON-PWS',
      scanRange:0, fFactorThr:0, lookAhead:0, alertLat:99,
      escapeCmd:'NONE',
      cert:'No §25.1419 equipage',
      ref:'PC-12 POH / King Air POH — PWS not certified' }
  // Military transport / fighter — variant-dependent (typically R/T radar w/o civil PWS)
  if (/^(C17|C5|C13|C30|KC1|A40|A400|C160|F[12-9]|F[A]?\d|EF20)/.test(t))
    return { pwsType:'Mil radar (PWS variant)', pwsClass:'MIL-PWS',
      scanRange:4, fFactorThr:0.140, lookAhead:25, alertLat:7,
      escapeCmd:'FD-MAN',
      cert:'MIL-STD-3013A §A.4.43',
      ref:'C-17 FOM §12 / USAF AFI 11-202V3' }
  // Default — assume retrofit Collins WXR-2100 baseline
  return { pwsType:'Collins WXR-2100 (default)', pwsClass:'WXR-2100',
    scanRange:5, fFactorThr:0.130, lookAhead:30, alertLat:6,
    escapeCmd:'TOGA-FD-MAN',
    cert:'TSO-C117a / DO-220',
    ref:'Collins WXR-2100 Pilot Guide (assumed §121.358 equipped)' }
}

// ------------------------------------------------------------
// Convective-windshear-prone aerodrome catalogue with synthetic
// per-season convective-index (0-100) — higher = more PWS hazard
//   CVI = 60 + 40 × P(microburst-day-in-month) per NOAA SPC clim.
interface ConvAirport { icao: string; lat: number; lng: number; cvi: number; season: string }
const CONV: ConvAirport[] = [
  { icao:'KDFW', lat:32.897, lng:-97.040, cvi:82, season:'summer convective' },
  { icao:'KIAH', lat:29.984, lng:-95.341, cvi:88, season:'gulf convective' },
  { icao:'KMIA', lat:25.793, lng:-80.290, cvi:85, season:'tropical convective' },
  { icao:'KMCO', lat:28.429, lng:-81.309, cvi:84, season:'tropical' },
  { icao:'KATL', lat:33.640, lng:-84.427, cvi:78, season:'summer' },
  { icao:'KMEM', lat:35.042, lng:-89.977, cvi:76, season:'summer' },
  { icao:'KCLT', lat:35.214, lng:-80.943, cvi:80, season:'summer USAir 1016 precedent' },
  { icao:'KMSY', lat:29.993, lng:-90.258, cvi:90, season:'gulf — PanAm 759 precedent' },
  { icao:'KBNA', lat:36.124, lng:-86.678, cvi:74, season:'summer' },
  { icao:'KCMH', lat:39.998, lng:-82.892, cvi:72, season:'summer' },
  { icao:'KIND', lat:39.717, lng:-86.295, cvi:74, season:'summer' },
  { icao:'KMSP', lat:44.882, lng:-93.222, cvi:70, season:'summer' },
  { icao:'KDEN', lat:39.862, lng:-104.673, cvi:75, season:'high-plains convective' },
  { icao:'KSFO', lat:37.619, lng:-122.375, cvi:38, season:'low — marine' },
  { icao:'KSAN', lat:32.733, lng:-117.190, cvi:35, season:'low — marine' },
  { icao:'KLAS', lat:36.080, lng:-115.152, cvi:62, season:'monsoon' },
  { icao:'KPHX', lat:33.434, lng:-112.012, cvi:78, season:'monsoon haboob' },
  { icao:'KSLC', lat:40.788, lng:-111.978, cvi:64, season:'mountain convective' },
  { icao:'KPIT', lat:40.491, lng:-80.233, cvi:68, season:'summer' },
  { icao:'KORD', lat:41.974, lng:-87.907, cvi:72, season:'summer' },
  { icao:'KEWR', lat:40.692, lng:-74.169, cvi:72, season:'summer' },
  { icao:'KJFK', lat:40.640, lng:-73.778, cvi:72, season:'summer — Eastern 66 precedent' },
  { icao:'RJTT', lat:35.554, lng:139.781, cvi:78, season:'typhoon season' },
  { icao:'RJBB', lat:34.428, lng:135.244, cvi:74, season:'typhoon season' },
  { icao:'VHHH', lat:22.309, lng:113.915, cvi:82, season:'tropical convective' },
  { icao:'WSSS', lat:1.359,  lng:103.989, cvi:88, season:'equatorial convective' },
  { icao:'VOMM', lat:12.994, lng:80.180,  cvi:80, season:'monsoon' },
  { icao:'OERK', lat:24.957, lng:46.699,  cvi:74, season:'haboob / khamsin' },
  { icao:'HECA', lat:30.111, lng:31.405,  cvi:68, season:'desert convective' },
  { icao:'FAOR', lat:-26.139,lng:28.246,  cvi:76, season:'highveld thunderstorms' },
  { icao:'SAEZ', lat:-34.822,lng:-58.535, cvi:74, season:'pampero gust front' },
  { icao:'SBGR', lat:-23.435,lng:-46.473, cvi:78, season:'summer convective' },
  { icao:'CYYZ', lat:43.677, lng:-79.631, cvi:68, season:'summer convective' },
]

function clamp(v:number, a:number, b:number) { return Math.max(a, Math.min(b, v)) }
function gcKm(la1:number, lo1:number, la2:number, lo2:number) {
  const R = 6371, toR = Math.PI/180
  const dLa = (la2-la1)*toR, dLo = (lo2-lo1)*toR
  const a = Math.sin(dLa/2)**2 + Math.cos(la1*toR)*Math.cos(la2*toR)*Math.sin(dLo/2)**2
  return 2*R*Math.asin(Math.sqrt(a))
}

function phaseOf(f: PFlight): Phase {
  if (f.ground && f.velocityKts > 70) return 'TKO-ROLL'
  if (f.ground) return 'OFF'
  const agl = f.altitudeFt   // approximation: treat altitudeFt as ~AGL for ops-near-field; coarse but consistent with other panels
  if (agl < 200 && f.vertRate < -200) return 'FLARE'
  if (agl < 1500 && f.vertRate > 200) return 'TKO-LIFT'
  if (agl < 3000 && f.vertRate > 100) return 'CLIMB-OUT'
  if (agl < 1500 && f.vertRate < -200) return 'APPR-FNL'
  if (agl < 5000 && f.vertRate < -200) return 'APPR-INT'
  if (agl < 3000 && f.vertRate > 50 && f.velocityKts < 180) return 'GA'
  return 'CRUISE'
}

// Deterministic synthetic per-airframe PWS state derived from icao hash + nearest convective airport
interface SynState {
  fFactor: number          // current sensed F-factor
  fFactorPredict: number   // 30s lookahead F-factor proxy
  dopplerDelta: number     // peak-to-peak Doppler radial velocity m/s
  rwsaTrip: boolean        // reactive windshear advisory trip
  cellRangeNm: number      // forward range to nearest convective cell (NM)
  cellBearingDeg: number   // bearing to cell (relative to track)
  microburstWet: boolean   // wet vs dry microburst signature
  cvi: number              // local convective-index 0-100
  nearestApt: string
}
function syntheticState(f: PFlight, ph: Phase): SynState {
  let h = 0; for (let i=0;i<f.icao.length;i++) h = ((h*131) + f.icao.charCodeAt(i)) >>> 0
  const r1 = (h%1000)/1000
  const r2 = ((h>>3)%1000)/1000
  const r3 = ((h>>7)%1000)/1000
  const r4 = ((h>>11)%1000)/1000
  const r5 = ((h>>17)%1000)/1000

  // nearest convective aerodrome
  let nearest = CONV[0], dMin = 1e9
  for (const a of CONV) {
    const d = gcKm(f.lat, f.lng, a.lat, a.lng)
    if (d < dMin) { dMin = d; nearest = a }
  }
  const cvi = nearest.cvi
  const proximityKm = dMin

  // PWS hazard zone: <2300 ft AGL near a convective airport, within 50 km
  const inZone = (ph === 'TKO-ROLL' || ph === 'TKO-LIFT' || ph === 'APPR-FNL' || ph === 'APPR-INT' || ph === 'FLARE' || ph === 'CLIMB-OUT' || ph === 'GA')
                 && proximityKm < 60
  if (!inZone) {
    return { fFactor:0.01+r1*0.02, fFactorPredict:0.01+r2*0.02, dopplerDelta:1+r3*3, rwsaTrip:false,
      cellRangeNm:99, cellBearingDeg:0, microburstWet:false, cvi, nearestApt:nearest.icao }
  }

  // synthetic F-factor baseline modulated by CVI + phase
  let fBase = 0.02 + (cvi/100) * 0.05 + r1*0.04
  let fPred = fBase + r2*0.04
  let dopp = 3 + (cvi/100) * 6 + r3*4

  // 8% chance significant gust-front / microburst encounter at high-CVI airport
  const pMicro = (cvi/100) * 0.16
  let microWet = r4 < 0.6
  let rwsa = false
  if (r5 < pMicro) {
    // microburst proximate — F-factor escalated
    fBase = 0.08 + r1*0.08
    fPred = 0.10 + r2*0.10
    dopp = 12 + r3*9
    if (fBase > 0.105) rwsa = true
    microWet = r4 < 0.7
  }
  // 2% chance hazardous microburst direct encounter
  if (r5 < 0.018 && (ph === 'APPR-FNL' || ph === 'TKO-LIFT' || ph === 'FLARE')) {
    fBase = 0.13 + r1*0.06
    fPred = 0.15 + r2*0.06
    dopp = 18 + r3*10
    rwsa = true
    microWet = true
  }
  // cell range/bearing
  const cellRangeNm = 0.5 + r3 * 5   // PWS scan window 0.5-5.5 NM
  const cellBearingDeg = (r4 - 0.5) * 30  // ±15° off-track

  return { fFactor:fBase, fFactorPredict:fPred, dopplerDelta:dopp, rwsaTrip:rwsa,
    cellRangeNm, cellBearingDeg, microburstWet:microWet, cvi, nearestApt:nearest.icao }
}

interface Row {
  f: PFlight; phase: Phase; spec: RadarSpec; st: SynState
  drivers: Record<string, number>
  score: number; tier: Tier; notes: string[]
  pwsAnnun: 'WARNING'|'CAUTION'|'ADVISORY'|'NONE'
}

export default function PwsPredictive({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [scanRg, setScanRg] = useState(5.0)
  const [ffCeil, setFfCeil] = useState(0.130)
  const [latcyMul, setLatcyMul] = useState(1.0)
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<string>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'RADARS'|'AERO'|'PHYSICS'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shVec, setShVec] = useState(true)
  const [shCone, setShCone] = useState(true)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const spec = specOf(f.type)
      const ph = phaseOf(f)
      const st = syntheticState(f, ph)

      // DRIVERS 0-100
      // F-factor (sensed)
      const dFFAC = clamp((st.fFactor / 0.15) * 100, 0, 100)
      // Predictive F-factor lookahead
      const dPRED = clamp((st.fFactorPredict / ffCeil) * 100, 0, 100)
      // Doppler radial velocity peak-to-peak (m/s)
      const dDOPP = clamp((st.dopplerDelta / 18) * 100, 0, 100)
      // AGL — PWS hazard band <2300 ft per AC 25.1419
      const dAGL = f.altitudeFt < 2300 ? clamp((2300 - f.altitudeFt) / 23, 0, 100) : 0
      // Wet/dry microburst (wet easier to detect, dry harder → higher residual risk)
      const dWET = st.microburstWet ? 35 : 78  // dry microbursts are more dangerous due to weaker radar return
      // Latency / equipage penalty
      const dLATCY = clamp((spec.alertLat / 8) * 60 * latcyMul + (spec.pwsClass === 'NON-PWS' ? 80 : 0), 0, 100)
      // Escape capability
      const dESC = spec.escapeCmd === 'TOGA-FD-AUTO' ? 12
                 : spec.escapeCmd === 'TOGA-FD-MAN' ? 28
                 : spec.escapeCmd === 'FD-MAN' ? 45
                 : 92
      // Proximity to convective cell
      const dPROX = clamp(((6 - Math.min(6, st.cellRangeNm)) / 6) * 80, 0, 100)
      // PHASE weight
      const phaseW: Record<Phase, number> = {
        'TKO-ROLL':1.30, 'TKO-LIFT':1.40, 'CLIMB-OUT':1.20, 'APPR-INT':1.25,
        'APPR-FNL':1.45, 'FLARE':1.30, 'GA':1.40, 'CRUISE':0.30, 'OFF':0,
      }
      const dPHASE = phaseW[ph] * 50

      const drivers = { FFAC:dFFAC, PRED:dPRED, DOPP:dDOPP, AGL:dAGL, WET:dWET, LATCY:dLATCY, ESC:dESC, PROX:dPROX, PHASE:dPHASE }
      const arr = Object.values(drivers)
      const mx = Math.max(...arr), mn = arr.reduce((a,b)=>a+b,0)/arr.length
      let score = (mx * 0.66 + mn * 0.34) * phaseW[ph] * advMul

      const notes: string[] = []
      let annun: Row['pwsAnnun'] = 'NONE'

      // Hard escalators
      if (st.fFactorPredict >= 0.150 && (ph === 'APPR-FNL' || ph === 'TKO-LIFT' || ph === 'FLARE' || ph === 'GA')) {
        score = Math.max(score, 96)
        annun = 'WARNING'
        notes.push(`PWS WARNING · F-pred ${st.fFactorPredict.toFixed(3)} @ ${st.cellRangeNm.toFixed(1)} NM — execute escape: TOGA, FD-bar, pitch 17.5°, no config change · DL-191 KDFW precedent NTSB AAR-94-04`)
      } else if (st.fFactorPredict >= ffCeil && f.altitudeFt < 1500 && (ph === 'APPR-FNL' || ph === 'TKO-LIFT' || ph === 'CLIMB-OUT')) {
        score = Math.max(score, 84)
        annun = 'WARNING'
        notes.push(`PWS WARNING · F-pred ${st.fFactorPredict.toFixed(3)} ≥ ${ffCeil.toFixed(3)} @ AGL ${f.altitudeFt.toFixed(0)}ft · arm escape immediately · ${spec.cert}`)
      } else if (st.fFactorPredict >= 0.07 && f.altitudeFt < 2300) {
        score = Math.max(score, 56)
        annun = 'CAUTION'
        notes.push(`PWS CAUTION · F-pred ${st.fFactorPredict.toFixed(3)} ≥ 0.070 — monitor radar display, prepare escape · ${spec.ref}`)
      }
      if (st.rwsaTrip && f.altitudeFt < 300) {
        score = Math.max(score, 95)
        notes.push(`REACTIVE WINDSHEAR ADVISORY trip · already in shear · execute escape NOW · §121.358(a)(1)`)
      }
      if (spec.pwsClass === 'NON-PWS' && st.cvi >= 70 && f.altitudeFt < 3000 && (ph !== 'CRUISE' && ph !== 'OFF')) {
        score = Math.max(score, 78)
        notes.push(`NO PWS equipage in CVI ${st.cvi} convective env · §121.358 / §135.165 dispatch question · ${spec.ref}`)
      }
      if (st.dopplerDelta >= 14) {
        score = Math.max(score, 68)
        notes.push(`Microburst signature · ΔVr ${st.dopplerDelta.toFixed(1)} m/s peak-to-peak (>12 m/s DO-220 §3.4 threshold) · ${st.microburstWet?'wet':'DRY (harder detect)'} core`)
      }

      score = clamp(score, 0, 100)

      let tier: Tier = 'NOMINAL'
      if (ph === 'CRUISE' || ph === 'OFF' || spec.pwsClass === 'NON-PWS' && st.cvi < 50) tier = 'OFF'
      else if (score >= 85) tier = 'WARNING'
      else if (score >= 65) tier = 'CAUTION'
      else if (score >= 45) tier = 'ADVISORY'
      else if (score >= 22) tier = 'WATCH'
      else tier = 'NOMINAL'

      out.push({ f, phase: ph, spec, st, drivers, score, tier, notes, pwsAnnun: annun })
    }
    out.sort((a,b)=> (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score-a.score))
    return out
  }, [flights, advMul, scanRg, ffCeil, latcyMul])

  // === MapLibre overlay ===
  useEffect(() => {
    if (!map) return
    const SRC = 'pws-src'
    const SRC_VEC = 'pws-vec-src'
    const SRC_CONE = 'pws-cone-src'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    ensureSrc(SRC); ensureSrc(SRC_VEC); ensureSrc(SRC_CONE)

    const writeAll = () => {
      const view = rows.filter(r => (tierFilter==='ALL'||r.tier===tierFilter) && (phaseFilter==='ALL'||r.phase===phaseFilter) && (classFilter==='ALL'||r.spec.pwsClass===classFilter))
      const acFeats: any[] = []
      const vecFeats: any[] = []
      const coneFeats: any[] = []
      for (const r of view) {
        const labelBits = [
          r.f.callsign||r.f.icao,
          r.spec.pwsClass,
          `F${r.st.fFactorPredict.toFixed(2)}`,
          r.pwsAnnun !== 'NONE' ? r.pwsAnnun : '',
        ].filter(Boolean).join(' · ')
        acFeats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ tier:r.tier, color:TIER_COLOR[r.tier], score:r.score, sz: 7 + (r.score/100)*12, label: labelBits } })

        // forward escape-vector (length proportional to F-factor predict)
        if (r.tier === 'WARNING' || r.tier === 'CAUTION') {
          const km = (r.st.fFactorPredict / 0.20) * 8
          const brg = (r.f.track || 0) * Math.PI/180
          const dlat = (km/111.32) * Math.cos(brg)
          const dlng = (km/(111.32*Math.cos(r.f.lat*Math.PI/180))) * Math.sin(brg)
          vecFeats.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[[r.f.lng,r.f.lat],[r.f.lng+dlng,r.f.lat+dlat]] }, properties:{ color: TIER_COLOR[r.tier] } })
        }

        // PWS scan-cone polygon (60° wedge forward, scan-range NM) — for WARNING/CAUTION
        if ((r.tier === 'WARNING' || r.tier === 'CAUTION') && r.spec.scanRange > 0) {
          const rangeKm = Math.min(r.spec.scanRange, scanRg) * 1.852
          const halfAz = 30 * Math.PI/180
          const brg = (r.f.track || 0) * Math.PI/180
          const pts: any[] = [[r.f.lng, r.f.lat]]
          for (let i=-halfAz; i<=halfAz; i+= halfAz/6) {
            const b = brg + i
            const dlat = (rangeKm/111.32) * Math.cos(b)
            const dlng = (rangeKm/(111.32*Math.cos(r.f.lat*Math.PI/180))) * Math.sin(b)
            pts.push([r.f.lng + dlng, r.f.lat + dlat])
          }
          pts.push([r.f.lng, r.f.lat])
          coneFeats.push({ type:'Feature', geometry:{ type:'Polygon', coordinates:[pts] }, properties:{ color: TIER_COLOR[r.tier] } })
        }
      }
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: shHalo||shPin||shLbl ? acFeats : [] })
      ;(map.getSource(SRC_VEC) as any).setData({ type:'FeatureCollection', features: shVec ? vecFeats : [] })
      ;(map.getSource(SRC_CONE) as any).setData({ type:'FeatureCollection', features: shCone ? coneFeats : [] })
    }

    if (!map.getLayer('pws-cone'))
      map.addLayer({ id:'pws-cone', type:'fill', source:SRC_CONE, paint:{ 'fill-color':['get','color'], 'fill-opacity':0.08, 'fill-outline-color':['get','color'] } })
    if (!map.getLayer('pws-halo'))
      map.addLayer({ id:'pws-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.3, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('pws-pin'))
      map.addLayer({ id:'pws-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 65], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('pws-lbl'))
      map.addLayer({ id:'pws-lbl', type:'symbol', source:SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('pws-vec'))
      map.addLayer({ id:'pws-vec', type:'line', source:SRC_VEC, paint:{ 'line-color':['get','color'], 'line-width':1.8, 'line-dasharray':[2,2], 'line-opacity':0.78 } })

    writeAll()
    return () => {
      for (const id of ['pws-lbl','pws-pin','pws-halo','pws-vec','pws-cone']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC, SRC_VEC, SRC_CONE]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, phaseFilter, classFilter, shHalo, shPin, shLbl, shVec, shCone, scanRg])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (phaseFilter==='ALL'||r.phase===phaseFilter) &&
    (classFilter==='ALL'||r.spec.pwsClass===classFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) ||
      (r.f.type||'').toLowerCase().includes(search.toLowerCase()) ||
      (r.f.operator||'').toLowerCase().includes(search.toLowerCase()) ||
      r.spec.pwsType.toLowerCase().includes(search.toLowerCase()) ||
      r.st.nearestApt.toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { 'WARNING':0, 'CAUTION':0, 'ADVISORY':0, 'WATCH':0, 'NOMINAL':0, 'OFF':0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? (rows.reduce((a,b)=>a+b.score,0)/rows.length) : 0
  const worst = rows[0]
  const muFFac = rows.length ? (rows.reduce((a,b)=>a+b.st.fFactorPredict,0)/rows.length) : 0
  const warnCnt = counts['WARNING'], cautCnt = counts['CAUTION']
  const muAgl = rows.length ? rows.reduce((a,b)=>a+b.f.altitudeFt,0)/rows.length : 0

  // per-radar-class aggregation
  const classMap = new Map<string, { spec: RadarSpec; count: number; muScore: number; muFF: number; warn: number; caut: number }>()
  for (const r of rows) {
    const e = classMap.get(r.spec.pwsClass) || { spec: r.spec, count: 0, muScore: 0, muFF: 0, warn: 0, caut: 0 }
    e.count++; e.muScore += r.score; e.muFF += r.st.fFactorPredict
    if (r.tier === 'WARNING') e.warn++
    if (r.tier === 'CAUTION') e.caut++
    classMap.set(r.spec.pwsClass, e)
  }
  const classRows = Array.from(classMap.entries()).map(([cls, e]) => ({
    cls, spec: e.spec, count: e.count, muScore: e.muScore/e.count, muFF: e.muFF/e.count, warn: e.warn, caut: e.caut
  })).sort((a,b) => (b.warn - a.warn) || (b.caut - a.caut) || b.muScore - a.muScore)

  // per-aerodrome aggregation
  const aeroMap = new Map<string, { count: number; warn: number; caut: number; muScore: number; cvi: number; season: string }>()
  for (const r of rows) {
    const apt = r.st.nearestApt
    const cv = CONV.find(c => c.icao === apt)
    const e = aeroMap.get(apt) || { count: 0, warn: 0, caut: 0, muScore: 0, cvi: cv?.cvi || 0, season: cv?.season || '' }
    e.count++; e.muScore += r.score
    if (r.tier === 'WARNING') e.warn++
    if (r.tier === 'CAUTION') e.caut++
    aeroMap.set(apt, e)
  }
  const aeroRows = Array.from(aeroMap.entries()).map(([apt, e]) => ({
    apt, count: e.count, warn: e.warn, caut: e.caut, muScore: e.muScore/e.count, cvi: e.cvi, season: e.season
  })).sort((a,b) => (b.warn - a.warn) || (b.cvi - a.cvi))

  const allClasses = ['ALL', ...Array.from(new Set(rows.map(r => r.spec.pwsClass))).sort()]

  return (
    <div className="fixed top-16 right-3 z-40 w-[470px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">PWS</span>
          <span className="text-[10px] text-slate-400">predictive windshear · X-band Doppler · F-factor · §25.1419</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
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
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-F-PRED</div><div className="text-slate-100 font-mono">{muFFac.toFixed(3)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WARN</div><div className="font-mono" style={{color:TIER_COLOR['WARNING']}}>{warnCnt}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">CAUT</div><div className="font-mono" style={{color:TIER_COLOR['CAUTION']}}>{cautCnt}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign||worst?.f.icao||'—'}</div></div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">SCAN-RG <span className="text-slate-200 font-mono">{scanRg.toFixed(1)} NM</span>
            <input type="range" min="1" max="5" step="0.5" value={scanRg} onChange={e=>setScanRg(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">F-CEIL <span className="text-slate-200 font-mono">{ffCeil.toFixed(3)}</span>
            <input type="range" min="0.07" max="0.20" step="0.005" value={ffCeil} onChange={e=>setFfCeil(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">LATCY-MUL <span className="text-slate-200 font-mono">{(latcyMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={latcyMul*100} onChange={e=>setLatcyMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','TKO-ROLL','TKO-LIFT','CLIMB-OUT','APPR-INT','APPR-FNL','FLARE','GA','CRUISE'] as const).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {allClasses.map(c => (
            <button key={c} onClick={()=>setClassFilter(c)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter===c?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{c}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['VEC',shVec,setShVec],['CONE',shCone,setShCone]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/radar/apt" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* tabs */}
      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','RADARS','AERO','PHYSICS'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab==='AIRCRAFT' && visible.slice(0,80).map((r,i) => (
          <div key={i} onClick={()=>onFly(r.f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
              <span className="font-mono text-slate-100">{r.f.callsign||r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="font-mono text-slate-400">{r.f.type||'—'}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.spec.pwsClass}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase}</span>
              {r.pwsAnnun !== 'NONE' && <span className="px-1 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.pwsAnnun === 'WARNING' ? 'WARNING' : 'CAUTION']}33`, color:TIER_COLOR[r.pwsAnnun === 'WARNING' ? 'WARNING' : 'CAUTION'] }}>{r.pwsAnnun}</span>}
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>F-now <span className="text-slate-100 font-mono">{r.st.fFactor.toFixed(3)}</span></div>
              <div>F-pred <span className="text-slate-100 font-mono">{r.st.fFactorPredict.toFixed(3)}</span></div>
              <div>ΔVr <span className="text-slate-100 font-mono">{r.st.dopplerDelta.toFixed(1)} m/s</span></div>
              <div>core <span className="text-slate-100 font-mono">{r.st.microburstWet?'wet':'DRY'}</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>AGL <span className="text-slate-100 font-mono">{r.f.altitudeFt.toFixed(0)}ft</span></div>
              <div>cell <span className="text-slate-100 font-mono">{r.st.cellRangeNm.toFixed(1)} NM</span></div>
              <div>brg <span className="text-slate-100 font-mono">{r.st.cellBearingDeg>0?'+':''}{r.st.cellBearingDeg.toFixed(0)}°</span></div>
              <div>apt <span className="text-slate-100 font-mono">{r.st.nearestApt}</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>range <span className="text-slate-100 font-mono">{r.spec.scanRange}NM</span></div>
              <div>thr <span className="text-slate-100 font-mono">{r.spec.fFactorThr.toFixed(3)}</span></div>
              <div>look <span className="text-slate-100 font-mono">{r.spec.lookAhead}s</span></div>
              <div>esc <span className="text-slate-100 font-mono">{r.spec.escapeCmd}</span></div>
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k,v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v)}</span>
              ))}
            </div>
            {r.notes.length>0 && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR[r.tier]}}>! {r.notes[0]}</div>}
            {r.notes.length===0 && r.tier!=='NOMINAL' && r.tier!=='OFF' && <div className="mt-1 text-[9px] text-slate-500">monitor PWS · {r.spec.pwsType} · {r.spec.ref}</div>}
            {r.tier==='NOMINAL' && <div className="mt-1 text-[9px] text-slate-500">{r.spec.pwsType} · {r.spec.escapeCmd} · {r.spec.cert}</div>}
            {r.tier==='OFF' && <div className="mt-1 text-[9px] text-slate-500">non-hazard phase · {r.spec.pwsType}</div>}
          </div>
        ))}
        {tab==='AIRCRAFT' && visible.length===0 && <div className="text-[10px] text-slate-500 italic">no airframes match current filters</div>}

        {tab==='RADARS' && (
          <div className="space-y-1">
            {classRows.map(c => (
              <div key={c.cls} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="px-1 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">{c.cls}</span>
                  <span className="text-slate-400">{c.spec.pwsType}</span>
                  <span className="ml-auto font-mono text-slate-100">×{c.count}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                  <div>scan-RG <span className="text-slate-100 font-mono">{c.spec.scanRange}NM</span></div>
                  <div>F-thr <span className="text-slate-100 font-mono">{c.spec.fFactorThr.toFixed(3)}</span></div>
                  <div>look-AH <span className="text-slate-100 font-mono">{c.spec.lookAhead}s</span></div>
                  <div>latcy <span className="text-slate-100 font-mono">{c.spec.alertLat}s</span></div>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
                  <div>μ-SCORE <span className="text-slate-100 font-mono">{c.muScore.toFixed(0)}</span></div>
                  <div>μ-F-PRED <span className="text-slate-100 font-mono">{c.muFF.toFixed(3)}</span></div>
                  <div>WARN <span className="font-mono" style={{color:TIER_COLOR['WARNING']}}>{c.warn}</span></div>
                  <div>CAUT <span className="font-mono" style={{color:TIER_COLOR['CAUTION']}}>{c.caut}</span></div>
                </div>
                <div className="text-[9px] text-slate-500 italic mt-0.5">escape: {c.spec.escapeCmd} · cert: {c.spec.cert} · {c.spec.ref}</div>
              </div>
            ))}
            {classRows.length === 0 && <div className="text-[10px] text-slate-500 italic">no radar equipage detected</div>}
          </div>
        )}

        {tab==='AERO' && (
          <div className="space-y-1">
            <div className="text-[9px] text-slate-500 italic mb-1">Nearest convective aerodrome per airframe · CVI 0-100 = climatological microburst-day probability proxy</div>
            {aeroRows.map(a => (
              <div key={a.apt} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="px-1 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">{a.apt}</span>
                  <span className="text-slate-400">CVI {a.cvi}</span>
                  <span className="ml-auto font-mono text-slate-100">×{a.count}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                  <div>μ-SCORE <span className="text-slate-100 font-mono">{a.muScore.toFixed(0)}</span></div>
                  <div>WARN <span className="font-mono" style={{color:TIER_COLOR['WARNING']}}>{a.warn}</span></div>
                  <div>CAUT <span className="font-mono" style={{color:TIER_COLOR['CAUTION']}}>{a.caut}</span></div>
                  <div>CVI-bar <div className="h-1.5 bg-slate-700/40 rounded overflow-hidden mt-0.5"><div style={{ width:`${a.cvi}%`, background: a.cvi>=80 ? TIER_COLOR['WARNING'] : a.cvi>=65 ? TIER_COLOR['CAUTION'] : TIER_COLOR['ADVISORY'], height:'100%' }} /></div></div>
                </div>
                <div className="text-[9px] text-slate-500 italic mt-0.5">{a.season}</div>
              </div>
            ))}
            {aeroRows.length === 0 && <div className="text-[10px] text-slate-500 italic">no aerodrome data</div>}
          </div>
        )}

        {tab==='PHYSICS' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="font-mono text-slate-100 mb-1">F-factor (NASA Bowles 1990)</div>
              <div className="text-slate-400 leading-relaxed">F = (1/g)·dWx/dt − Wz/V — instantaneous total energy loss rate from along-track wind acceleration and vertical downdraft. PWS scans the forward 5 NM by tracking radial-velocity gradients ΔVr in the X-band Doppler return; peak-to-peak ΔVr &gt; 12 m/s within 1 NM (DO-220 §3.4) is the microburst signature. WARNING threshold F-pred ≥ 0.130 in 30s look-ahead, CAUTION at ≥ 0.070, hazardous F sustained 4s ≥ 0.105 per AC 00-54 §5.3.</div>
            </div>

            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-400 mb-1">F-factor (predicted) vs AGL · fleet plot</div>
              <svg viewBox="0 0 400 220" className="w-full">
                <line x1="50" y1="200" x2="390" y2="200" stroke="#334155" />
                <line x1="50" y1="20"  x2="50"  y2="200" stroke="#334155" />
                {/* x ticks F 0-0.20 */}
                {[0,0.05,0.10,0.15,0.20].map(p => (
                  <g key={p}>
                    <line x1={50 + (p/0.20)*340} y1="198" x2={50 + (p/0.20)*340} y2="202" stroke="#475569"/>
                    <text x={50 + (p/0.20)*340} y={212} fill="#94a3b8" fontSize="9" textAnchor="middle">{p.toFixed(2)}</text>
                  </g>
                ))}
                {/* y ticks AGL 0-5000 */}
                {[0,1000,2000,3000,4000,5000].map(k => (
                  <g key={k}>
                    <line x1="48" y1={200 - (k/5000)*180} x2="52" y2={200 - (k/5000)*180} stroke="#475569"/>
                    <text x={44} y={203 - (k/5000)*180} fill="#94a3b8" fontSize="9" textAnchor="end">{k}</text>
                  </g>
                ))}
                <text x="220" y="218" fill="#94a3b8" fontSize="9" textAnchor="middle">F-factor (predicted, 30s lookahead)</text>
                <text x="18" y="110" fill="#94a3b8" fontSize="9" textAnchor="middle" transform="rotate(-90 18 110)">AGL [ft]</text>
                {/* NOMINAL emerald region <0.05 */}
                <rect x={50} y={20} width={(0.05/0.20)*340} height={180} fill="#10b981" opacity="0.07" stroke="#10b981" strokeOpacity="0.3" strokeWidth="0.6"/>
                <text x={50 + (0.025/0.20)*340} y={32} fill="#10b981" fontSize="9" textAnchor="middle" opacity="0.8">NOMINAL</text>
                {/* WATCH sky 0.05-0.07 */}
                <rect x={50 + (0.05/0.20)*340} y={20} width={(0.02/0.20)*340} height={180} fill="#0ea5e9" opacity="0.06" stroke="#0ea5e9" strokeOpacity="0.4" strokeWidth="0.6"/>
                {/* CAUTION amber 0.07-0.13 */}
                <rect x={50 + (0.07/0.20)*340} y={20} width={(0.06/0.20)*340} height={180} fill="#f59e0b" opacity="0.10" stroke="#f59e0b" strokeOpacity="0.5" strokeWidth="0.6"/>
                <text x={50 + (0.10/0.20)*340} y={32} fill="#f59e0b" fontSize="9" textAnchor="middle" opacity="0.85">CAUTION</text>
                {/* WARNING rose ≥0.13 */}
                <rect x={50 + (ffCeil/0.20)*340} y={20} width={(0.20-ffCeil)/0.20*340} height={180} fill="#ef4444" opacity="0.12" stroke="#ef4444" strokeOpacity="0.6" strokeWidth="0.8"/>
                <text x={50 + ((ffCeil+0.03)/0.20)*340} y={32} fill="#ef4444" fontSize="9" textAnchor="middle" opacity="0.9">WARNING (escape)</text>
                {/* AGL hazard band <2300 ft */}
                <line x1="50" y1={200 - (2300/5000)*180} x2="390" y2={200 - (2300/5000)*180} stroke="#f59e0b" strokeWidth="1" strokeDasharray="4 3" opacity="0.65"/>
                <text x={386} y={200 - (2300/5000)*180 - 3} fill="#f59e0b" fontSize="8" textAnchor="end" opacity="0.85">AC 25.1419 hazard band</text>
                {/* fleet dots */}
                {rows.slice(0,150).map((r,i) => {
                  const x = 50 + clamp((r.st.fFactorPredict/0.20)*340, 0, 340)
                  const y = 200 - clamp((Math.min(5000, r.f.altitudeFt)/5000)*180, 0, 180)
                  return <circle key={i} cx={x} cy={y} r="2.4" fill={TIER_COLOR[r.tier]} opacity={0.85} />
                })}
              </svg>
              <div className="grid grid-cols-4 gap-1 mt-1 text-[10px]">
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">FLEET</div><div className="text-slate-100 font-mono">{rows.length}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WARN</div><div className="font-mono" style={{color:TIER_COLOR['WARNING']}}>{warnCnt}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">CAUT</div><div className="font-mono" style={{color:TIER_COLOR['CAUTION']}}>{cautCnt}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-AGL</div><div className="text-slate-100 font-mono">{muAgl.toFixed(0)}ft</div></div>
              </div>
            </div>

            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-400 mb-1">Microburst velocity profile (Fujita 1976 / Proctor 1989)</div>
              <svg viewBox="0 0 400 130" className="w-full">
                <line x1="20" y1="100" x2="380" y2="100" stroke="#334155" />
                <text x="20" y="118" fill="#94a3b8" fontSize="9" textAnchor="start">surface →</text>
                <text x="380" y="118" fill="#94a3b8" fontSize="9" textAnchor="end">downrange [NM]</text>
                {/* downward downdraft core arrow at center */}
                <g>
                  <line x1="200" y1="30" x2="200" y2="98" stroke="#ef4444" strokeWidth="2.5" markerEnd="url(#arr)" />
                  <text x="206" y="50" fill="#ef4444" fontSize="9">downdraft core</text>
                </g>
                {/* horizontal outflow arrows */}
                <g>
                  <line x1="200" y1="98" x2="80"  y2="98" stroke="#f43f5e" strokeWidth="2" markerEnd="url(#arr)"/>
                  <line x1="200" y1="98" x2="320" y2="98" stroke="#f43f5e" strokeWidth="2" markerEnd="url(#arr)"/>
                  <text x="120" y="92" fill="#f43f5e" fontSize="9" textAnchor="middle">headwind</text>
                  <text x="280" y="92" fill="#f43f5e" fontSize="9" textAnchor="middle">tailwind (loss)</text>
                </g>
                {/* aircraft glide path */}
                <line x1="20" y1="40" x2="380" y2="100" stroke="#0ea5e9" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.7"/>
                <text x="60" y="38" fill="#0ea5e9" fontSize="9">3° glide path</text>
                {/* PWS scan cone */}
                <path d="M 60 50 L 220 35 L 220 65 Z" fill="#10b981" opacity="0.12" stroke="#10b981" strokeWidth="0.7" strokeOpacity="0.5"/>
                <text x="105" y="48" fill="#10b981" fontSize="9">PWS scan 5 NM × 60°</text>
                <defs>
                  <marker id="arr" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
                    <path d="M0,0 L6,3 L0,6 z" fill="#f43f5e"/>
                  </marker>
                </defs>
              </svg>
              <div className="text-[9px] text-slate-400 mt-1 leading-relaxed">Convective microburst: vertical downdraft impinges on surface, fans out radially → headwind on approach (apparent IAS increase + altitude gain → instinctive power reduce) followed by tailwind through core (rapid IAS loss + sink). Energy-loss F &gt; 0.13 in this regime per Bowles 1990. PWS sweeps forward 5 NM, declares WARNING ~30s before encounter — sufficient to execute the §25.1419 escape: TOGA, FD bars, pitch 17.5°, no config change.</div>
            </div>

            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              Refs · 14 CFR §121.358 (Low-Altitude Windshear Equipment) / §121.358(a)(2) airborne detection / §121.353 §135.165 / §25.1419 PWS cert / §25.1322 alerting · FAA AC 00-54 Pilot Windshear Guide · AC 120-41 PWS approval criteria · AC 25-12 forward-looking detection · TSO-C117a · RTCA DO-220 MOPS PWS · DO-187 weather radar · ARINC 708A-3 / 738-A · ICAO Doc 9817 LL Windshear ed.1 · Annex 3 §4.6 · Doc 9426 §4 · EASA CS-25.1419 / AMC 25.1419 · NTSB AAR-94-04 DL 191 KDFW 02-Aug-1985 (137 fatal, birthed §121.358) · AAR-95-03 AAL 102 KDFW · AAR-86-05 PanAm 759 KMSY 1982 · AAR-97-06 USAir 1016 KCLT 1994 · AAR-78-13 Eastern 66 KJFK 1975 · ATSB AO-2014-006 QF74 false annunciation · Bowles NASA TP-1990-3060 F-factor · Frost-Bowles NASA TM-100683 · LeBlanc-Bowles NASA CR-3611 hazard index · Proctor NASA TP-1989-2926 numerical microburst · Fujita NASA CR-3582 downburst class · NCAR TM-103 LLWAS-NE · MIT Lincoln Lab AFC-A210456 TDWR · Boeing FCTM 8.30 escape · Airbus FCTM PRO-NOR-SOP-21 PWS · Embraer AOM §03 · CRJ FCOM Vol 2 §03 · Honeywell IntuVue RDR-4000 PG · Collins WXR-2100 MultiScan PG · IATA SR-2024 §3.4.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
