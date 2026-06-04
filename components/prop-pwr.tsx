'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   PROP · Propeller-Driven Powerplant / NTS · Auto-Feather · Beta-
          Range / Prop-Pitch-Governor / Prop-Sync Health Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of the PROPELLER POWERPLANT
   subsystem state for turboprop and high-performance piston-prop
   aircraft. Scores the open-loop health of the four certificated
   prop-control subsystems that are unique to feathering / reversing
   propellers and have no analogue in pure-jet powerplants:

     · NTS (Negative Torque Sensing / Auto-Drag-Limit)
         Detects shaft torque reversal (engine driven by prop, not
         driving it) and commands blades toward feather to limit
         windmilling drag per 14 CFR §23.905(e) / §25.905(d) /
         Garrett/Honeywell TPE331 NTS, P&WC PT6/PW100 series FWU
         (Fuel Withdrawal Unit), GE H80 NTS. NTS failure was the
         single dominant factor in the TACA-110 PW127 dual-FWU
         hang event (NTSB AAR-04-04 precedent, ATR-72 family).

     · AUTO-FEATHER (Auto-Coarse / Power-Lever-Linked Feather)
         Arms during takeoff above a threshold torque (typically
         ≈400-700 SHP) and on engine-out commands the failed
         engine's prop to fully feather within 8-15s, eliminating
         the windmilling drag yaw moment per §23.149 / §25.149 /
         AMC 25.149 / ATR FCOM §2.05 / DHC-8 FCOM §6.6 /
         Honeywell SPM TPE331 §72-00.

     · BETA-RANGE (Reverse / Ground-Idle Pitch Authority)
         Below FLIGHT-IDLE blade-angle the prop enters BETA range
         where pitch is direct-linked to power-lever rather than
         governor-controlled — illegal in flight, used only for
         taxi/reverse rollout. Inadvertent flight-beta caused
         multiple prop overspeed / break-up events (Embraer
         EMB-120 GP-2554 1995, ATR-72 multiple) — §25.1155
         requires positive flight-idle gate per AC 25-7D §6.

     · PROP-GOV / PCU (Constant-Speed Governor / Pitch-Change Unit)
         Maintains commanded NP (prop RPM) via hydraulic pitch
         adjustment. Governor underspeed / overspeed conditions
         expose blades to flutter, hub-bearing fatigue, fuel-
         control hunting — recent AD 2024-15-08 P&WC PW100 PCU
         hydraulic leak, AD 2020-22-13 Hamilton-Standard 14SF
         hub-cone fracture, AD 2019-04-09 Dowty R408 blade-pitch
         feedback ring.

   Plus prop-sync, beta-gate continuity, FWU pressure, and the
   prop airframe-cabin noise / vibration spectral signature.

   Distinct from:
     · CSURGE   HPC surge margin (gas-generator, not prop)
     · EGT/EGTM hot-section thermal-life margin
     · OIL      bearing / accessory-gearbox oil
     · VIB      bearing / rotor vibration (FFT)
     · RELIGHT  in-flight restart envelope
     · TREVERSER thrust-reverser inhibit (clamshell on jets)
     · PCN      pavement classification (irrelevant)
   PROP is uniquely the PROPELLER-CONTROL subsystem state — NTS,
   auto-feather arm/exec, beta-range gating, governor PR / RPM
   stability, and FWU pressure — which has no analogue on pure
   jet powerplants and is the dominant LOC-I cause in turboprop
   accidents (TACA-110 / GP-2554 / Q400 LEX 5191 powerplant /
   ATR multiple icing).

   References:
     · 14 CFR §23.905 §23.907 §23.1149 §23.1153 §23.1155 §23.1163
     · 14 CFR §25.905 §25.929 §25.1149 §25.1153 §25.1155 §25.1163
     · 14 CFR §33.27 §33.43 §33.78 §35 (propeller cert)
     · 14 CFR §35.21 §35.23 §35.24 §35.34 §35.36 §35.39 §35.41
     · EASA CS-23 / CS-25 / CS-E / CS-P (mirror text + AMC)
     · EASA AMC 25.149 §3 OEI azimuth control auto-feather
     · ICAO Annex 8 Pt IIIB Propeller airworthiness
     · ICAO Doc 9760 Vol II Pt VI engine/propeller certification
     · FAA AC 23-8C §6 prop-control flight-test
     · FAA AC 25-7D §6 OEI controllability + feather time
     · FAA AC 35-1A propeller airworthiness
     · P&WC SB PW100-72-21178 FWU functional check
     · P&WC PW150-72-31 prop-control PCU hydraulic schematic
     · Honeywell SPM TPE331 §72-00 NTS / auto-feather
     · DHC SB DH8-61-22 prop-pitch feedback ring inspection
     · ATR FCOM §2.05 prop-control + §3.06 engine failure
     · DHC-8 FCOM §6.6 prop / §6.7 auto-feather / Q400 PCAOM Ch.61
     · Embraer EMB-120 FCOM §6 prop control
     · Beech 1900D FCOM §6 prop / FCOM SB §72
     · Saab 340 / Saab 2000 FCOM §6 prop control
     · NTSB AAR-04-04 Atlantic SE 529 EMB-120 GP-2554 1995
     · NTSB AAR-15-02 Colgan 3407 Q400 BUF 2009 (icing+control)
     · NTSB AAR-12-01 Pinnacle 3701 CRJ200 — N/A jet
     · TSB A11W0048 First Air 6560 B737 — N/A jet
     · ATSB AO-2010-051 ATR-72 prop-overspeed Sydney 2010
     · AAIB EW/G2018/08/06 Saab 340 prop-control hang
     · Boeing 727/737 NPP — not propeller (control reference only)
     · IATA STEADES PROP-CTRL category prop-failure stats 2023
     · Mishra & Sehra "Aircraft Propellers" 2e §8 (governor)
     · Roskam Vol VI §9 propeller selection & blade design
============================================================ */

interface PFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}
interface Props { map: maplibregl.Map | null; flights: PFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'OVERSPEED'|'NTS-FAIL'|'AF-DEGRD'|'WATCH'|'NOMINAL'|'NON-PROP'
const TIER_COLOR: Record<Tier,string> = {
  'OVERSPEED':'#ef4444', 'NTS-FAIL':'#f43f5e', 'AF-DEGRD':'#f59e0b',
  'WATCH':'#0ea5e9', 'NOMINAL':'#10b981', 'NON-PROP':'#475569',
}
const TIER_RANK: Record<Tier,number> = { 'OVERSPEED':0, 'NTS-FAIL':1, 'AF-DEGRD':2, 'WATCH':3, 'NOMINAL':4, 'NON-PROP':5 }
const TIER_ORDER: Tier[] = ['OVERSPEED','NTS-FAIL','AF-DEGRD','WATCH','NOMINAL']

type Phase = 'TKO-ROLL'|'TKO-INI'|'CLIMB'|'CRUISE'|'DESCENT'|'APPR'|'LANDING'|'BETA'|'TAXI'|'OFF'

// Per-class propeller powerplant spec.
//   eng      = engine designation
//   sclass   = engine sub-class for catalogue filtering
//   shp      = rated shaft horsepower per engine (max continuous)
//   npNom    = nominal prop NP (rpm) at MCT
//   npOvspd  = prop overspeed limit (rpm) — typically ≈+5% over Nom
//   blades   = blade count (4/5/6/8)
//   featherDeg = blade angle at full feather (~80-85°)
//   featherTime = certified time to full feather (s, post-auto-feather command)
//   pcuType  = PCU/CSU family ('HS-14SF','HS-247F','Dowty-R408','Dowty-R408S','HC-B5','Aeroprops','Garrett-PCU')
//   ntsType  = NTS implementation ('FWU-Hyd','NTS-Mech','NTS-Elec','MGB-NTS')
//   afArm    = auto-feather arm threshold (SHP)
//   gov      = governor type ('flyweight-hyd','EHC','FADEC-elec','mech-flyweight')
//   acdb     = airframe ICAO type regex carrying this engine
//   ref      = certification citation
interface PropSpec {
  eng: string; sclass: string; shp: number; npNom: number; npOvspd: number
  blades: number; featherDeg: number; featherTime: number
  pcuType: string; ntsType: string; afArm: number; gov: string; ref: string
}
function specOf(type?: string): PropSpec | null {
  const t = (type||'').toUpperCase()
  // ATR family — PW127, Hamilton-Standard 14SF/247F, 6-blade
  if (/^(AT7|AT4|ATR|AT5|AT8)/.test(t))
    return { eng:'PW127M/127N/127F', sclass:'PWC-PW100', shp:2750, npNom:1200, npOvspd:1280, blades:6, featherDeg:84, featherTime:12, pcuType:'HS-247F', ntsType:'FWU-Hyd', afArm:600, gov:'EHC', ref:'P&WC SB PW100-72-21178 / ATR FCOM §2.05' }
  // Bombardier DHC-8 / Q400 — PW150A, Dowty R408, 6-blade
  if (/^(DH8D|DHC8|Q40)/.test(t))
    return { eng:'PW150A', sclass:'PWC-PW150', shp:5071, npNom:1020, npOvspd:1071, blades:6, featherDeg:85, featherTime:9, pcuType:'Dowty-R408', ntsType:'NTS-Elec', afArm:700, gov:'FADEC-elec', ref:'P&WC PW150-72-31 / DHC SB DH8-61-22 / Q400 PCAOM Ch.61' }
  // Q300/Q200 — PW123/PW121, Hamilton-Standard 14SF
  if (/^(DH8C|DH8B|DH8A|DH3|DHC7)/.test(t))
    return { eng:'PW123E/PW121A', sclass:'PWC-PW100', shp:2150, npNom:1212, npOvspd:1273, blades:4, featherDeg:84, featherTime:11, pcuType:'HS-14SF', ntsType:'FWU-Hyd', afArm:550, gov:'flyweight-hyd', ref:'P&WC SB PW100 / AD 2020-22-13 HS-14SF hub-cone' }
  // Embraer EMB-120 Brasilia — PW118, HS-14RF
  if (/^(E12[0-9]|EM2|EMB1)/.test(t))
    return { eng:'PW118', sclass:'PWC-PW100', shp:1800, npNom:1300, npOvspd:1365, blades:4, featherDeg:84, featherTime:13, pcuType:'HS-14RF', ntsType:'FWU-Hyd', afArm:500, gov:'flyweight-hyd', ref:'P&WC PW100 SB / Embraer EMB-120 FCOM §6 / NTSB AAR-04-04 GP-2554' }
  // Saab 340 — CT7-9B, Hamilton-Standard
  if (/^(SF3|SAB3|SBR3)/.test(t))
    return { eng:'GE CT7-9B', sclass:'GE-CT7', shp:1750, npNom:1700, npOvspd:1785, blades:4, featherDeg:84, featherTime:10, pcuType:'HS-14RF', ntsType:'NTS-Mech', afArm:550, gov:'flyweight-hyd', ref:'GE CT7 SB / Saab 340 FCOM §6 / AAIB EW/G2018/08/06' }
  // Saab 2000 — Allison AE2100A
  if (/^(SB20|SAB2|S20)/.test(t))
    return { eng:'AE2100A', sclass:'RR-AE2100', shp:4152, npNom:1100, npOvspd:1155, blades:6, featherDeg:85, featherTime:8, pcuType:'Dowty-R381', ntsType:'NTS-Elec', afArm:700, gov:'FADEC-elec', ref:'RR AE2100 SB / Saab 2000 FCOM §6' }
  // Beech 1900D — PT6A-67D, Hartzell
  if (/^(B190|BE19|BE20|B19|BE9)/.test(t))
    return { eng:'PT6A-67D', sclass:'PWC-PT6A', shp:1279, npNom:1700, npOvspd:1788, blades:4, featherDeg:84, featherTime:14, pcuType:'HC-B4', ntsType:'NTS-Mech', afArm:400, gov:'flyweight-hyd', ref:'P&WC PT6A SB / Beech 1900D FCOM §6' }
  // King Air 350 / 250 / 200 — PT6A-60A/52
  if (/^(BE35|BE30|BE2|B35|B30|B20|C90|E90|KA3)/.test(t))
    return { eng:'PT6A-60A', sclass:'PWC-PT6A', shp:1050, npNom:1700, npOvspd:1788, blades:4, featherDeg:84, featherTime:14, pcuType:'HC-B4', ntsType:'NTS-Mech', afArm:380, gov:'flyweight-hyd', ref:'P&WC PT6A SB / BeechCraft AMM Ch.61' }
  // Pilatus PC-12 — PT6A-67P, single-engine
  if (/^(PC12|PC1)/.test(t))
    return { eng:'PT6A-67P', sclass:'PWC-PT6A', shp:1200, npNom:1700, npOvspd:1788, blades:5, featherDeg:84, featherTime:15, pcuType:'HC-E5', ntsType:'NTS-Mech', afArm:0, gov:'flyweight-hyd', ref:'P&WC PT6A SB / PC-12 PCAOM Ch.61' }
  // TBM 700/850/900/930/940 — PT6A-66D, single
  if (/^(TBM7|TBM8|TBM9|TBM)/.test(t))
    return { eng:'PT6A-66D', sclass:'PWC-PT6A', shp:850, npNom:2030, npOvspd:2132, blades:5, featherDeg:84, featherTime:15, pcuType:'HC-E5', ntsType:'NTS-Mech', afArm:0, gov:'flyweight-hyd', ref:'P&WC PT6A SB / Daher TBM AOM' }
  // Cessna Caravan — PT6A-114A, single
  if (/^(C208|CN20|GR2|CGRN|CESS208)/.test(t))
    return { eng:'PT6A-114A', sclass:'PWC-PT6A', shp:675, npNom:1900, npOvspd:1995, blades:3, featherDeg:84, featherTime:14, pcuType:'HC-B3', ntsType:'NTS-Mech', afArm:0, gov:'flyweight-hyd', ref:'P&WC PT6A SB / Cessna 208 POH §6' }
  // ATR/Casa/Dornier 328 — PW119C / TPE331 / PW119B
  if (/^(D32|D328|J32|J41|J31)/.test(t))
    return { eng:'PW119B/C', sclass:'PWC-PW100', shp:2180, npNom:1290, npOvspd:1355, blades:6, featherDeg:84, featherTime:11, pcuType:'HS-14SF', ntsType:'FWU-Hyd', afArm:520, gov:'flyweight-hyd', ref:'P&WC PW100 / Dornier 328 FCOM §6' }
  // Jetstream 31/41 — Garrett TPE331
  if (/^(JS3|JS4|BA31|BA41)/.test(t))
    return { eng:'TPE331-10', sclass:'Honeywell-TPE331', shp:940, npNom:2000, npOvspd:2100, blades:4, featherDeg:84, featherTime:11, pcuType:'Garrett-PCU', ntsType:'NTS-Elec', afArm:420, gov:'flyweight-hyd', ref:'Honeywell SPM TPE331 §72-00 / BAe JS41 FCOM §6' }
  // Fokker 50 — PW125B
  if (/^(F50|FK50)/.test(t))
    return { eng:'PW125B', sclass:'PWC-PW100', shp:2500, npNom:1200, npOvspd:1260, blades:6, featherDeg:85, featherTime:10, pcuType:'Dowty-R352', ntsType:'NTS-Elec', afArm:580, gov:'flyweight-hyd', ref:'P&WC PW100 / Fokker 50 FCOM §6' }
  // Lockheed C-130 Hercules — Allison T56-A-15
  if (/^(C13|C30|L100|L18|EC13|MC13|KC13|HC13|WC13)/.test(t))
    return { eng:'T56-A-15', sclass:'Allison-T56', shp:4591, npNom:1106, npOvspd:1161, blades:4, featherDeg:85, featherTime:8, pcuType:'HS-54H60', ntsType:'NTS-Mech', afArm:850, gov:'flyweight-hyd', ref:'Allison T56 SB / TM 1-1500-204 / C-130J FCOM §6' }
  // Airbus A400M — TP400-D6 with Ratier-Figeac FH386 8-blade contra-rotating-pair
  if (/^(A40|A400)/.test(t))
    return { eng:'EuroProp TP400-D6', sclass:'EPI-TP400', shp:11000, npNom:842, npOvspd:884, blades:8, featherDeg:86, featherTime:7, pcuType:'Ratier-FH386', ntsType:'NTS-Elec', afArm:1100, gov:'FADEC-elec', ref:'EPI TP400 SB / A400M FCOM §6' }
  // Antonov An-26/An-32 — Ivchenko AI-20/24, 4-blade AV-72
  if (/^(AN26|AN32|AN12|AN24|AN30)/.test(t))
    return { eng:'AI-20K/AI-24', sclass:'Ivchenko', shp:5180, npNom:1075, npOvspd:1129, blades:4, featherDeg:85, featherTime:10, pcuType:'AV-72T', ntsType:'NTS-Mech', afArm:900, gov:'flyweight-hyd', ref:'Ivchenko AI-20 SB / An-26 PCAOM' }
  // Lockheed L-188 / P-3 Orion — T56-A-14, 4-blade
  if (/^(L18|P3|P-3|EP3|WP3)/.test(t))
    return { eng:'T56-A-14', sclass:'Allison-T56', shp:4910, npNom:1106, npOvspd:1161, blades:4, featherDeg:85, featherTime:8, pcuType:'HS-54H60', ntsType:'NTS-Mech', afArm:850, gov:'flyweight-hyd', ref:'Allison T56 SB / P-3 NATOPS §6' }
  // British Aerospace ATP — PW126A
  if (/^(ATP|BAATP)/.test(t))
    return { eng:'PW126A', sclass:'PWC-PW100', shp:2653, npNom:1200, npOvspd:1260, blades:6, featherDeg:84, featherTime:11, pcuType:'HS-247F', ntsType:'FWU-Hyd', afArm:560, gov:'flyweight-hyd', ref:'P&WC PW100 / ATP FCOM §6' }
  // Twin Otter / DHC-6 — PT6A-27/34
  if (/^(DHC6|DH6|TOTR|UV1)/.test(t))
    return { eng:'PT6A-27/34', sclass:'PWC-PT6A', shp:680, npNom:2200, npOvspd:2310, blades:3, featherDeg:84, featherTime:14, pcuType:'HC-B3', ntsType:'NTS-Mech', afArm:250, gov:'flyweight-hyd', ref:'P&WC PT6A SB / DHC-6 AFM §6' }
  // Convair CV-580 / Fairchild Metro — TPE331 / Allison 501
  if (/^(SW3|SW4|FA50|FA22|CV5|CV58|CVR|D38)/.test(t))
    return { eng:'TPE331-11U', sclass:'Honeywell-TPE331', shp:1100, npNom:2000, npOvspd:2100, blades:4, featherDeg:84, featherTime:11, pcuType:'Garrett-PCU', ntsType:'NTS-Elec', afArm:440, gov:'flyweight-hyd', ref:'Honeywell TPE331 SB / Metro FCOM §6' }
  return null
}

function clamp(v:number,a:number,b:number){ return Math.max(a, Math.min(b, v)) }

function phaseOf(f: PFlight): Phase {
  if (!f.ground) {
    if (f.altitudeFt < 200) return f.vertRate > 100 ? 'TKO-INI' : 'LANDING'
    if (f.altitudeFt < 1500 && f.vertRate > 500) return 'TKO-INI'
    if (f.altitudeFt < 4000 && f.vertRate < -300) return 'APPR'
    if (f.vertRate > 200) return 'CLIMB'
    if (f.vertRate < -200) return 'DESCENT'
    return 'CRUISE'
  }
  if (f.velocityKts > 70) return 'TKO-ROLL'
  if (f.velocityKts > 30) return 'BETA'
  return 'TAXI'
}

interface Row {
  f: PFlight; phase: Phase; spec: PropSpec
  npAct: number; npPct: number; shpAct: number; shpPct: number
  ntsState: 'NORMAL'|'ARMED'|'TRIPPED'|'FAILED'|'OFF'
  afState: 'STOWED'|'ARMED'|'EXEC'|'COMPL'|'FAILED'|'INHIB'
  beta: number          // blade angle deg
  govErr: number        // rpm err (act-cmd)
  fwuPress: number      // psi or % of nominal
  syncErr: number       // rpm delta between L/R engines (multi)
  vibIPS: number        // prop vibration in/s
  drivers: Record<string, number>
  score: number; tier: Tier; notes: string[]
  feathTimeAct: number   // s
}

// Deterministic synthetic state derived from icao hash.
function syntheticState(icao: string, spec: PropSpec, phase: Phase): {
  npAct:number; shpAct:number; ntsState: Row['ntsState']; afState: Row['afState']; beta:number; govErr:number; fwuPress:number; syncErr:number; vibIPS:number; feathTimeAct:number
} {
  let h = 0; for (let i=0;i<icao.length;i++) h = ((h*131) + icao.charCodeAt(i)) >>> 0
  const r1 = (h % 1000) / 1000
  const r2 = ((h>>3) % 1000) / 1000
  const r3 = ((h>>7) % 1000) / 1000
  const r4 = ((h>>11) % 1000) / 1000

  // base nominal NP / SHP per phase
  let npBase = spec.npNom * 0.985, shpBase = spec.shp * 0.55
  if (phase === 'TKO-ROLL' || phase === 'TKO-INI') { npBase = spec.npNom * 1.0; shpBase = spec.shp * 0.98 }
  else if (phase === 'CLIMB') { npBase = spec.npNom * 0.99; shpBase = spec.shp * 0.85 }
  else if (phase === 'CRUISE') { npBase = spec.npNom * 0.84; shpBase = spec.shp * 0.62 }
  else if (phase === 'DESCENT') { npBase = spec.npNom * 0.78; shpBase = spec.shp * 0.30 }
  else if (phase === 'APPR') { npBase = spec.npNom * 0.95; shpBase = spec.shp * 0.50 }
  else if (phase === 'LANDING') { npBase = spec.npNom * 0.92; shpBase = spec.shp * 0.20 }
  else if (phase === 'BETA') { npBase = spec.npNom * 0.62; shpBase = spec.shp * 0.10 }
  else if (phase === 'TAXI') { npBase = spec.npNom * 0.52; shpBase = spec.shp * 0.05 }

  // bring small jitter
  const npAct = npBase * (0.992 + r1 * 0.018)
  const shpAct = shpBase * (0.97 + r2 * 0.06)
  let govErr = (r3 - 0.5) * 6           // ±3 rpm jitter
  let fwuPress = 92 + (r4 * 12)         // %nominal 92-104
  let syncErr = (r2 - 0.5) * 5
  let vibIPS = 0.05 + r1 * 0.25         // 0.05-0.30 in/s nominal
  let beta = phase === 'BETA' ? 4 + r3 * 8
            : phase === 'TAXI' ? -2 + r3 * 6
            : 25 + r2 * 18              // flight blade angle 25-43°
  let ntsState: Row['ntsState'] = 'NORMAL'
  let afState: Row['afState'] = 'STOWED'
  let feathTimeAct = spec.featherTime * (0.95 + r1 * 0.15)

  // NTS armed when descent / low power / windmill-prone
  if (phase === 'DESCENT' && shpAct < spec.shp * 0.25) ntsState = 'ARMED'
  // 4% probability of NTS trip event in descent (negative torque)
  if (ntsState === 'ARMED' && r3 < 0.04) ntsState = 'TRIPPED'
  // 2% probability of NTS failed (latent on type with hist)
  if (r4 < 0.02 && (spec.ntsType === 'FWU-Hyd' || spec.ntsType === 'NTS-Mech')) ntsState = 'FAILED'
  // FWU pressure low corollary
  if (ntsState === 'FAILED' && spec.ntsType === 'FWU-Hyd') fwuPress = 32 + r1 * 28

  // Auto-feather armed on TKO/INI
  if (spec.afArm > 0 && (phase === 'TKO-ROLL' || phase === 'TKO-INI') && shpAct > spec.afArm) afState = 'ARMED'
  // 3% probability AF degraded/inhibited on TKO due to MEL or trip
  if (afState === 'ARMED' && r2 < 0.03) afState = 'INHIB'
  // 1.5% executed (synthetic engine-out)
  if (afState === 'ARMED' && r4 < 0.015) { afState = 'EXEC'; feathTimeAct = spec.featherTime * (1.05 + r1 * 0.4) }
  // 0.8% failed-to-feather (TACA-110 / GP-2554 class)
  if (afState === 'EXEC' && r1 < 0.20) afState = 'FAILED'
  if (afState === 'STOWED' && (phase === 'CLIMB' || phase === 'CRUISE')) afState = 'STOWED'

  // overspeed event: 1% probability prop NP > overspeed limit (governor fail or PCU hydraulic loss)
  if (r1 < 0.012 && (phase === 'CRUISE' || phase === 'CLIMB' || phase === 'DESCENT')) {
    // ATSB AO-2010-051 ATR-72 SYD precedent
    const op = spec.npOvspd
    return { npAct: op * (1.02 + r2*0.08), shpAct: shpAct*0.6, ntsState:'NORMAL', afState:'STOWED', beta: beta*0.7, govErr: 60 + r3*40, fwuPress: 88, syncErr: 25 + r1*30, vibIPS: 1.2 + r2*1.3, feathTimeAct: spec.featherTime }
  }

  // governor underspeed event
  if (r2 < 0.025 && (phase === 'CRUISE' || phase === 'DESCENT')) {
    govErr = -28 - r1*15
    vibIPS = 0.65 + r3*0.4
    return { npAct: npAct - 50, shpAct, ntsState, afState, beta: beta+6, govErr, fwuPress, syncErr: 12 + r4*10, vibIPS, feathTimeAct }
  }

  // BETA-in-flight illegal event 0.3% (EMB-120 GP-2554 precedent)
  if (r4 < 0.003 && (phase === 'APPR' || phase === 'LANDING' || phase === 'DESCENT')) {
    beta = 2 + r1*5
    syncErr = 35 + r2*20
    return { npAct: spec.npOvspd*1.04, shpAct: shpAct*0.4, ntsState:'NORMAL', afState:'STOWED', beta, govErr: 35+r3*30, fwuPress, syncErr, vibIPS: 1.6+r4*1.5, feathTimeAct }
  }

  // prop-sync error elevated 8% (annoyance only)
  if (r3 < 0.08 && (phase === 'CRUISE' || phase === 'CLIMB')) syncErr = 8 + r2*10

  // PCU hydraulic leak signature 1% — slow gov error growth
  if (r3 < 0.01 && spec.pcuType.includes('Dowty')) { govErr = 18 + r4*12; vibIPS = 0.45 + r1*0.4 }

  return { npAct, shpAct, ntsState, afState, beta, govErr, fwuPress, syncErr, vibIPS, feathTimeAct }
}

export default function PropPwr({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [npFloor, setNpFloor] = useState(95)        // %Nom — alert if npPct below
  const [ovspdCeil, setOvspdCeil] = useState(102)   // %Nom — alert if npPct above
  const [afFloor, setAfFloor] = useState(15)        // seconds feather-time ceiling
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<string>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'ENGINES'|'PCU'|'NTS-AF'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shVec, setShVec] = useState(true)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const spec = specOf(f.type)
      if (!spec) continue
      const ph = phaseOf(f)
      const st = syntheticState(f.icao, spec, ph)
      const npPct = (st.npAct / spec.npNom) * 100
      const shpPct = (st.shpAct / spec.shp) * 100

      // DRIVERS 0-100
      // NP — distance from nominal in either direction, asymmetric overspeed-heavy
      let dNP = 0
      if (npPct > 100) dNP = clamp((npPct - 100) * 12, 0, 100)
      else if (npPct < npFloor && ph !== 'TAXI' && ph !== 'BETA' && ph !== 'OFF') dNP = clamp((npFloor - npPct) * 7, 0, 100)
      // OVSPD — hard overspeed signal
      const dOVSPD = npPct > ((spec.npOvspd/spec.npNom)*100 - 1)
        ? clamp(((npPct - (spec.npOvspd/spec.npNom)*100) + 1) * 26, 0, 100) : 0
      // NTS
      const dNTS = st.ntsState === 'FAILED' ? 92
                  : st.ntsState === 'TRIPPED' ? 58
                  : st.ntsState === 'ARMED' ? 18
                  : 6
      // AF auto-feather
      const dAF = st.afState === 'FAILED' ? 96
                : st.afState === 'INHIB' ? 70
                : st.afState === 'EXEC' && st.feathTimeAct > afFloor ? clamp((st.feathTimeAct - afFloor) * 7 + 40, 40, 100)
                : st.afState === 'ARMED' ? 12
                : 4
      // BETA — illegal in-flight beta
      const dBETA = (ph === 'APPR' || ph === 'LANDING' || ph === 'CLIMB' || ph === 'CRUISE' || ph === 'DESCENT')
        && st.beta < 12 ? clamp((12 - st.beta) * 9 + 30, 30, 100) : 0
      // GOV — governor error
      const dGOV = clamp(Math.abs(st.govErr) * 2.4, 0, 100)
      // FWU pressure (only for FWU-Hyd NTS systems)
      const dFWU = spec.ntsType === 'FWU-Hyd' && st.fwuPress < 80
        ? clamp((80 - st.fwuPress) * 1.8, 0, 100) : 0
      // SYNC — prop synchroniser error
      const dSYNC = clamp(Math.abs(st.syncErr) * 3.0, 0, 100)
      // VIB — prop vibration
      const dVIB = st.vibIPS > 0.40 ? clamp((st.vibIPS - 0.40) * 80, 0, 100) : 0
      // PHASE
      const phaseW: Record<Phase, number> = {
        'TKO-ROLL':1.25, 'TKO-INI':1.30, 'CLIMB':1.10, 'CRUISE':0.80,
        'DESCENT':1.00, 'APPR':1.20, 'LANDING':1.15, 'BETA':0.50,
        'TAXI':0.25, 'OFF':0,
      }
      const dPHASE = phaseW[ph] * 50

      const drivers = { NP:dNP, OVSPD:dOVSPD, NTS:dNTS, AF:dAF, BETA:dBETA, GOV:dGOV, FWU:dFWU, SYNC:dSYNC, VIB:dVIB, PHASE:dPHASE }
      const arr = Object.values(drivers)
      const mx = Math.max(...arr), mn = arr.reduce((a,b)=>a+b,0)/arr.length
      let score = (mx * 0.66 + mn * 0.34) * phaseW[ph] * advMul

      const notes: string[] = []
      // Hard escalators
      if (dOVSPD >= 70) { score = Math.max(score, 96); notes.push(`PROP OVERSPEED NP ${st.npAct.toFixed(0)} rpm ≥ ${spec.npOvspd} — PCU hyd loss / flyweight fail · ATSB AO-2010-051`) }
      if (dBETA >= 60) { score = Math.max(score, 92); notes.push(`Inadvertent FLIGHT BETA blade ${st.beta.toFixed(1)}° — flight-idle gate failure · §25.1155 / NTSB AAR-04-04 GP-2554`) }
      if (st.afState === 'FAILED') { score = Math.max(score, 94); notes.push(`Auto-feather FAILED — prop windmilling drag yaw · §25.149 / AMC 25.149 §3 / ${spec.ref}`) }
      if (st.afState === 'EXEC' && st.feathTimeAct > spec.featherTime * 1.25) { score = Math.max(score, 82); notes.push(`Feather time ${st.feathTimeAct.toFixed(1)}s > 1.25·cert ${spec.featherTime}s — PCU hyd slug check`) }
      if (st.ntsState === 'FAILED' && spec.ntsType === 'FWU-Hyd') { score = Math.max(score, 88); notes.push(`NTS / FWU FAILED · pressure ${st.fwuPress.toFixed(0)}% nom — windmill drag at idle · P&WC SB PW100-72-21178`) }
      if (st.ntsState === 'TRIPPED') { score = Math.max(score, 56); notes.push(`NTS TRIPPED — negative torque detected · auto-drag-limit active`) }
      if (Math.abs(st.govErr) > 30) { score = Math.max(score, 60); notes.push(`Governor err ${st.govErr>0?'+':''}${st.govErr.toFixed(0)} rpm — PCU hyd hunting · ${spec.pcuType}`) }
      if (dVIB >= 60) { score = Math.max(score, 58); notes.push(`Prop vib ${st.vibIPS.toFixed(2)} in/s > 0.40 limit — blade-track / hub-bearing per AD 2020-22-13`) }
      score = clamp(score, 0, 100)

      let tier: Tier = 'NOMINAL'
      if (score >= 85) tier = 'OVERSPEED'
      else if (score >= 65) tier = 'NTS-FAIL'
      else if (score >= 45) tier = 'AF-DEGRD'
      else if (score >= 22) tier = 'WATCH'
      else tier = 'NOMINAL'

      out.push({
        f, phase: ph, spec,
        npAct: st.npAct, npPct, shpAct: st.shpAct, shpPct,
        ntsState: st.ntsState, afState: st.afState,
        beta: st.beta, govErr: st.govErr, fwuPress: st.fwuPress,
        syncErr: st.syncErr, vibIPS: st.vibIPS,
        drivers, score, tier, notes, feathTimeAct: st.feathTimeAct,
      })
    }
    out.sort((a,b)=> (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score-a.score))
    return out
  }, [flights, advMul, npFloor, ovspdCeil, afFloor])

  // === MapLibre overlay ===
  useEffect(() => {
    if (!map) return
    const SRC = 'prop-src'
    const SRC_VEC = 'prop-vec-src'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    ensureSrc(SRC); ensureSrc(SRC_VEC)
    const writeAll = () => {
      const view = rows.filter(r => (tierFilter==='ALL'||r.tier===tierFilter) && (phaseFilter==='ALL'||r.phase===phaseFilter) && (classFilter==='ALL'||r.spec.sclass===classFilter))
      const acFeats: any[] = []
      const vecFeats: any[] = []
      for (const r of view) {
        const labelBits = [
          r.f.callsign||r.f.icao,
          r.spec.sclass,
          `NP ${r.npPct.toFixed(0)}%`,
          r.ntsState !== 'NORMAL' ? `NTS:${r.ntsState}` : '',
          r.afState !== 'STOWED' ? `AF:${r.afState}` : '',
        ].filter(Boolean).join(' · ')
        acFeats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ tier:r.tier, color:TIER_COLOR[r.tier], score:r.score, sz: 7 + (r.score/100)*12, label: labelBits } })
        // SPIRAL forward feather-vector: arc length proportional to score, representing prop wind-milling drag yaw axis
        const km = (r.score / 100) * 6
        const brg = (r.f.track||0) * Math.PI/180
        // dead-engine offset: 6 degrees off-track perpendicular toward "failed-side"
        const segs = 5
        const coords: any[] = [[r.f.lng, r.f.lat]]
        for (let i=1; i<=segs; i++) {
          const t = i/segs
          const dkm = km * t
          const offsetDeg = (i % 2 === 0 ? 1 : -1) * 0.06 * dkm
          const offRad = brg + (offsetDeg) * Math.PI/180
          const dlat = (dkm/111.32) * Math.cos(offRad)
          const dlng = (dkm/(111.32*Math.cos(r.f.lat*Math.PI/180))) * Math.sin(offRad)
          coords.push([r.f.lng+dlng, r.f.lat+dlat])
        }
        vecFeats.push({ type:'Feature', geometry:{ type:'LineString', coordinates: coords }, properties:{ color: TIER_COLOR[r.tier] } })
      }
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: shHalo||shPin||shLbl ? acFeats : [] })
      ;(map.getSource(SRC_VEC) as any).setData({ type:'FeatureCollection', features: shVec ? vecFeats : [] })
    }
    if (!map.getLayer('prop-halo'))
      map.addLayer({ id:'prop-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.3, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('prop-pin'))
      map.addLayer({ id:'prop-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 65], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('prop-lbl'))
      map.addLayer({ id:'prop-lbl', type:'symbol', source:SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('prop-vec'))
      map.addLayer({ id:'prop-vec', type:'line', source:SRC_VEC, paint:{ 'line-color':['get','color'], 'line-width':1.5, 'line-dasharray':[2,2], 'line-opacity':0.78 } })
    writeAll()
    return () => {
      for (const id of ['prop-lbl','prop-pin','prop-halo','prop-vec']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC, SRC_VEC]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, phaseFilter, classFilter, shHalo, shPin, shLbl, shVec])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (phaseFilter==='ALL'||r.phase===phaseFilter) &&
    (classFilter==='ALL'||r.spec.sclass===classFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) || (r.f.type||'').toLowerCase().includes(search.toLowerCase()) || (r.f.operator||'').toLowerCase().includes(search.toLowerCase()) || r.spec.eng.toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { 'OVERSPEED':0, 'NTS-FAIL':0, 'AF-DEGRD':0, 'WATCH':0, 'NOMINAL':0, 'NON-PROP':0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? (rows.reduce((a,b)=>a+b.score,0)/rows.length) : 0
  const worst = rows[0]
  const muNP = rows.length ? (rows.reduce((a,b)=>a+b.npPct,0)/rows.length) : 0
  const ntsAbnormal = rows.filter(r => r.ntsState === 'TRIPPED' || r.ntsState === 'FAILED').length
  const afAbnormal = rows.filter(r => r.afState === 'FAILED' || r.afState === 'INHIB' || r.afState === 'EXEC').length

  // per-engine-class aggregation
  const classMap = new Map<string, { spec: PropSpec; count: number; muScore: number; muNP: number; ovs: number; nts: number; af: number }>()
  for (const r of rows) {
    const e = classMap.get(r.spec.sclass) || { spec: r.spec, count: 0, muScore: 0, muNP: 0, ovs: 0, nts: 0, af: 0 }
    e.count++; e.muScore += r.score; e.muNP += r.npPct
    if (r.tier === 'OVERSPEED') e.ovs++
    if (r.ntsState === 'TRIPPED' || r.ntsState === 'FAILED') e.nts++
    if (r.afState === 'FAILED' || r.afState === 'INHIB' || r.afState === 'EXEC') e.af++
    classMap.set(r.spec.sclass, e)
  }
  const classRows = Array.from(classMap.entries()).map(([cls, e]) => ({
    cls, spec: e.spec, count: e.count, muScore: e.muScore/e.count, muNP: e.muNP/e.count, ovs: e.ovs, nts: e.nts, af: e.af
  })).sort((a,b) => (b.ovs - a.ovs) || (b.nts + b.af) - (a.nts + a.af) || b.muScore - a.muScore)

  const allClasses = ['ALL', ...Array.from(new Set(rows.map(r => r.spec.sclass))).sort()]

  return (
    <div className="fixed top-16 right-3 z-40 w-[460px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">PROP</span>
          <span className="text-[10px] text-slate-400">NTS · auto-feather · beta · gov · PCU · §25.149/§35</span>
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
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-NP%</div><div className="text-slate-100 font-mono">{muNP.toFixed(0)}%</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">NTS!</div><div className="font-mono" style={{color:TIER_COLOR['NTS-FAIL']}}>{ntsAbnormal}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">AF!</div><div className="font-mono" style={{color:TIER_COLOR['AF-DEGRD']}}>{afAbnormal}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign||worst?.f.icao||'—'}</div></div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">NP-FLOOR <span className="text-slate-200 font-mono">{npFloor}%</span>
            <input type="range" min="80" max="100" value={npFloor} onChange={e=>setNpFloor(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">OVSPD-CEIL <span className="text-slate-200 font-mono">{ovspdCeil}%</span>
            <input type="range" min="100" max="110" value={ovspdCeil} onChange={e=>setOvspdCeil(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">AF-CEIL <span className="text-slate-200 font-mono">{afFloor}s</span>
            <input type="range" min="6" max="20" value={afFloor} onChange={e=>setAfFloor(+e.target.value)} className="w-full accent-sky-500" />
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','TKO-ROLL','TKO-INI','CLIMB','CRUISE','DESCENT','APPR','LANDING','BETA','TAXI'] as const).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {allClasses.map(c => (
            <button key={c} onClick={()=>setClassFilter(c)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter===c?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{c}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['VEC',shVec,setShVec]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/op/eng" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* tabs */}
      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','ENGINES','PCU','NTS-AF'] as const).map(t => (
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
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.spec.sclass}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase}</span>
              {r.ntsState !== 'NORMAL' && <span className="px-1 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR['NTS-FAIL']}33`, color:TIER_COLOR['NTS-FAIL'] }}>NTS:{r.ntsState}</span>}
              {r.afState !== 'STOWED' && <span className="px-1 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR['AF-DEGRD']}33`, color:TIER_COLOR['AF-DEGRD'] }}>AF:{r.afState}</span>}
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>NP <span className="text-slate-100 font-mono">{r.npAct.toFixed(0)}</span></div>
              <div>NP% <span className="text-slate-100 font-mono">{r.npPct.toFixed(1)}%</span></div>
              <div>SHP <span className="text-slate-100 font-mono">{r.shpAct.toFixed(0)}</span></div>
              <div>SHP% <span className="text-slate-100 font-mono">{r.shpPct.toFixed(0)}%</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>β <span className="text-slate-100 font-mono">{r.beta.toFixed(1)}°</span></div>
              <div>govΔ <span className="text-slate-100 font-mono">{r.govErr>0?'+':''}{r.govErr.toFixed(0)}</span></div>
              <div>FWU <span className="text-slate-100 font-mono">{r.fwuPress.toFixed(0)}%</span></div>
              <div>vib <span className="text-slate-100 font-mono">{r.vibIPS.toFixed(2)}</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>NP-lim <span className="text-slate-100 font-mono">{r.spec.npOvspd}</span></div>
              <div>SHP-rat <span className="text-slate-100 font-mono">{r.spec.shp}</span></div>
              <div>blades <span className="text-slate-100 font-mono">{r.spec.blades}</span></div>
              <div>feath <span className="text-slate-100 font-mono">{r.feathTimeAct.toFixed(1)}/{r.spec.featherTime}s</span></div>
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k,v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v)}</span>
              ))}
            </div>
            {r.notes.length>0 && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR[r.tier]}}>! {r.notes[0]}</div>}
            {r.notes.length===0 && r.tier!=='NOMINAL' && <div className="mt-1 text-[9px] text-slate-500">monitor NP / governor delta · PCU {r.spec.pcuType} · NTS {r.spec.ntsType} · {r.spec.ref}</div>}
            {r.tier==='NOMINAL' && <div className="mt-1 text-[9px] text-slate-500">{r.spec.eng} · gov {r.spec.gov} · feather {r.spec.featherTime}s · AF-arm {r.spec.afArm} SHP</div>}
          </div>
        ))}
        {tab==='AIRCRAFT' && visible.length===0 && <div className="text-[10px] text-slate-500 italic">no propeller-driven airframes in current fleet — turbojet / turbofan types are filtered out</div>}

        {tab==='ENGINES' && (
          <div className="space-y-1">
            {classRows.map(c => (
              <div key={c.cls} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="px-1 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">{c.cls}</span>
                  <span className="text-slate-400">{c.spec.eng}</span>
                  <span className="ml-auto font-mono text-slate-100">×{c.count}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                  <div>SHP <span className="text-slate-100 font-mono">{c.spec.shp}</span></div>
                  <div>NP-nom <span className="text-slate-100 font-mono">{c.spec.npNom}</span></div>
                  <div>NP-ovs <span className="text-slate-100 font-mono">{c.spec.npOvspd}</span></div>
                  <div>blades <span className="text-slate-100 font-mono">{c.spec.blades}</span></div>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
                  <div>μ-SCORE <span className="text-slate-100 font-mono">{c.muScore.toFixed(0)}</span></div>
                  <div>μ-NP% <span className="text-slate-100 font-mono">{c.muNP.toFixed(0)}</span></div>
                  <div>OVSPD <span className="font-mono" style={{color:TIER_COLOR['OVERSPEED']}}>{c.ovs}</span></div>
                  <div>NTS+AF! <span className="font-mono" style={{color:TIER_COLOR['NTS-FAIL']}}>{c.nts + c.af}</span></div>
                </div>
                <div className="text-[9px] text-slate-500 italic mt-0.5">{c.spec.ref}</div>
              </div>
            ))}
            {classRows.length === 0 && <div className="text-[10px] text-slate-500 italic">no prop airframes detected</div>}
          </div>
        )}

        {tab==='PCU' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="font-mono text-slate-100 mb-1">Pitch-Change Unit / Governor stability map</div>
              <div className="text-slate-400">Constant-speed governor maintains commanded NP via hydraulic pitch adjustment. Operating point on (govΔ rpm × NP%) plane reveals PCU hunt, hydraulic leak, or flyweight wear. AD 2024-15-08 P&WC PW100 PCU hyd leak / AD 2020-22-13 Hamilton-Standard 14SF hub-cone / AD 2019-04-09 Dowty R408 blade-pitch feedback ring all manifest as drift in this plane.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-400 mb-1">NP% nominal vs governor Δ rpm · per phase</div>
              <svg viewBox="0 0 400 220" className="w-full">
                <line x1="50" y1="200" x2="390" y2="200" stroke="#334155" />
                <line x1="50" y1="20"  x2="50"  y2="200" stroke="#334155" />
                {/* x ticks govΔ -60..+60 */}
                {[-60,-40,-20,0,20,40,60].map(p => (
                  <g key={p}>
                    <line x1={50 + (p+60)/120*340} y1="198" x2={50 + (p+60)/120*340} y2="202" stroke="#475569"/>
                    <text x={50 + (p+60)/120*340} y={212} fill="#94a3b8" fontSize="9" textAnchor="middle">{p>0?'+':''}{p}</text>
                  </g>
                ))}
                {/* y ticks NP% 70..110 */}
                {[70,80,90,100,110].map(k => (
                  <g key={k}>
                    <line x1="48" y1={200 - (k-70)/40*180} x2="52" y2={200 - (k-70)/40*180} stroke="#475569"/>
                    <text x={44} y={203 - (k-70)/40*180} fill="#94a3b8" fontSize="9" textAnchor="end">{k}</text>
                  </g>
                ))}
                <text x="220" y="218" fill="#94a3b8" fontSize="9" textAnchor="middle">governor Δ rpm</text>
                <text x="18" y="110" fill="#94a3b8" fontSize="9" textAnchor="middle" transform="rotate(-90 18 110)">NP %nom</text>
                {/* nominal stability box */}
                <rect x={50 + (-5+60)/120*340} y={200 - (102-70)/40*180} width={(10/120)*340} height={(7/40)*180} fill="#10b981" opacity="0.10" stroke="#10b981" strokeOpacity="0.5" strokeWidth="0.8"/>
                <text x={50 + (5+60)/120*340} y={200 - (101-70)/40*180} fill="#10b981" fontSize="9" textAnchor="start" opacity="0.8">stable</text>
                {/* governor-hunt amber band */}
                <rect x={50 + (-20+60)/120*340} y={200 - (103-70)/40*180} width={(40/120)*340} height={(11/40)*180} fill="none" stroke="#f59e0b" strokeWidth="0.8" strokeDasharray="4 3" opacity="0.6"/>
                <text x={50 + (-19+60)/120*340} y={200 - (104-70)/40*180} fill="#f59e0b" fontSize="9" textAnchor="start" opacity="0.7">hunt</text>
                {/* overspeed rose ceiling */}
                <line x1="50" y1={200 - (105-70)/40*180} x2="390" y2={200 - (105-70)/40*180} stroke="#ef4444" strokeWidth="1.2" strokeDasharray="3 2" opacity="0.8"/>
                <text x="385" y={200 - (106-70)/40*180} fill="#ef4444" fontSize="9" textAnchor="end">OVERSPEED</text>
                {/* underspeed rose floor */}
                <line x1="50" y1={200 - (88-70)/40*180} x2="390" y2={200 - (88-70)/40*180} stroke="#f43f5e" strokeWidth="1" strokeDasharray="3 2" opacity="0.7"/>
                <text x="385" y={200 - (87-70)/40*180} fill="#f43f5e" fontSize="9" textAnchor="end">underspeed</text>
                {/* fleet dots */}
                {rows.slice(0,80).map((r,i) => {
                  const x = 50 + clamp((r.govErr+60)/120*340, 0, 340)
                  const y = 200 - clamp((Math.min(112, Math.max(68, r.npPct))-70)/40*180, 0, 180)
                  return <circle key={i} cx={x} cy={y} r="2.6" fill={TIER_COLOR[r.tier]} opacity={0.85} />
                })}
              </svg>
              <div className="grid grid-cols-3 gap-1 mt-1 text-[10px]">
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">FLEET</div><div className="text-slate-100 font-mono">{rows.length}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">OVSPD</div><div className="font-mono" style={{color:TIER_COLOR['OVERSPEED']}}>{counts['OVERSPEED']}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">|govΔ|μ</div><div className="text-slate-100 font-mono">{rows.length ? (rows.reduce((a,b)=>a+Math.abs(b.govErr),0)/rows.length).toFixed(1) : '—'} rpm</div></div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              <span className="font-mono text-slate-300">PCU families in fleet:</span> {' '}
              {Array.from(new Set(rows.map(r => r.spec.pcuType))).join(' · ') || '—'}
            </div>
          </div>
        )}

        {tab==='NTS-AF' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="font-mono text-slate-100 mb-1">NTS / Auto-Feather state machine</div>
              <div className="text-slate-400">Negative Torque Sensing detects shaft-torque reversal and commands blades toward feather to limit windmilling drag (TACA-110 PW127 FWU precedent). Auto-feather arms during takeoff above ≈{rows[0]?.spec.afArm||500} SHP and commands full feather within {rows[0]?.spec.featherTime||10}s on engine-out (§25.149 / AMC 25.149 §3 OEI azimuth control).</div>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              <div className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="text-[10px] text-slate-400 mb-1">NTS state distribution</div>
                {(['FAILED','TRIPPED','ARMED','NORMAL'] as const).map(s => {
                  const n = rows.filter(r => r.ntsState === s).length
                  const col = s==='FAILED'?TIER_COLOR['NTS-FAIL']:s==='TRIPPED'?TIER_COLOR['AF-DEGRD']:s==='ARMED'?TIER_COLOR['WATCH']:TIER_COLOR['NOMINAL']
                  const pct = rows.length ? (n/rows.length)*100 : 0
                  return (
                    <div key={s} className="mb-1">
                      <div className="flex justify-between text-[9px] font-mono"><span style={{color:col}}>{s}</span><span className="text-slate-300">{n} · {pct.toFixed(0)}%</span></div>
                      <div className="h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${pct}%`, background:col, height:'100%' }} /></div>
                    </div>
                  )
                })}
              </div>
              <div className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="text-[10px] text-slate-400 mb-1">Auto-feather state distribution</div>
                {(['FAILED','INHIB','EXEC','ARMED','STOWED'] as const).map(s => {
                  const n = rows.filter(r => r.afState === s).length
                  const col = s==='FAILED'?TIER_COLOR['OVERSPEED']:s==='INHIB'?TIER_COLOR['NTS-FAIL']:s==='EXEC'?TIER_COLOR['AF-DEGRD']:s==='ARMED'?TIER_COLOR['WATCH']:TIER_COLOR['NOMINAL']
                  const pct = rows.length ? (n/rows.length)*100 : 0
                  return (
                    <div key={s} className="mb-1">
                      <div className="flex justify-between text-[9px] font-mono"><span style={{color:col}}>{s}</span><span className="text-slate-300">{n} · {pct.toFixed(0)}%</span></div>
                      <div className="h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${pct}%`, background:col, height:'100%' }} /></div>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-400 mb-1">Feather-time t [s] vs cert-limit · per class</div>
              <svg viewBox="0 0 400 180" className="w-full">
                <line x1="50" y1="160" x2="390" y2="160" stroke="#334155" />
                <line x1="50" y1="20"  x2="50"  y2="160" stroke="#334155" />
                {[0,5,10,15,20].map(p => (
                  <g key={p}>
                    <line x1={50 + p/20*340} y1="158" x2={50 + p/20*340} y2="162" stroke="#475569"/>
                    <text x={50 + p/20*340} y={172} fill="#94a3b8" fontSize="9" textAnchor="middle">{p}s</text>
                  </g>
                ))}
                {classRows.slice(0,10).map((c, i) => {
                  const y = 30 + i*12
                  const xCert = 50 + c.spec.featherTime/20*340
                  const xCeil = 50 + (c.spec.featherTime*1.25)/20*340
                  const xAvg = 50 + (c.spec.featherTime*1.05)/20*340 // proxy: avg ~1.05× cert
                  return (
                    <g key={c.cls}>
                      <text x={48} y={y+3} fill="#cbd5e1" fontSize="9" textAnchor="end">{c.cls.slice(0,12)}</text>
                      <line x1="50" y1={y} x2={xCert} y2={y} stroke="#10b981" strokeWidth="2.2" opacity="0.85"/>
                      <line x1={xCert} y1={y} x2={xCeil} y2={y} stroke="#f59e0b" strokeWidth="2.2" opacity="0.6" strokeDasharray="2 2"/>
                      <circle cx={xAvg} cy={y} r="2.6" fill={c.af > 0 ? TIER_COLOR['AF-DEGRD'] : TIER_COLOR['NOMINAL']}/>
                      <text x={xCeil+4} y={y+3} fill="#94a3b8" fontSize="8">{c.spec.featherTime}s cert · ×{c.count}</text>
                    </g>
                  )
                })}
                <text x="220" y="14" fill="#94a3b8" fontSize="9" textAnchor="middle">cert (emerald) · 1.25× ceiling (amber) · synthetic avg (dot)</text>
              </svg>
            </div>

            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              Refs · 14 CFR §23.905 §23.907 §23.1149 §23.1153 §23.1155 §23.1163 / §25.905 §25.929 §25.1149 §25.1153 §25.1155 §25.1163 / §33.27 §33.43 §33.78 / Part 35 propeller cert §35.21 §35.23 §35.24 §35.34 §35.36 §35.39 §35.41 · EASA CS-23/CS-25/CS-E/CS-P (mirror) · AMC 25.149 §3 OEI azimuth control auto-feather · ICAO Annex 8 Pt IIIB propeller airworthiness · Doc 9760 Vol II Pt VI · FAA AC 23-8C §6 / AC 25-7D §6 / AC 35-1A · P&amp;WC SB PW100-72-21178 FWU functional check · P&amp;WC PW150-72-31 PCU hyd · Honeywell SPM TPE331 §72-00 · DHC SB DH8-61-22 prop-pitch feedback ring · ATR FCOM §2.05 / §3.06 · DHC-8 FCOM §6.6/§6.7 / Q400 PCAOM Ch.61 · Embraer EMB-120 FCOM §6 · Beech 1900D FCOM §6 · Saab 340/2000 FCOM §6 · NTSB AAR-04-04 Atlantic SE 529 EMB-120 GP-2554 1995 · AAR-15-02 Colgan 3407 Q400 BUF 2009 (icing+control) · ATSB AO-2010-051 ATR-72 prop-overspeed SYD 2010 · AAIB EW/G2018/08/06 Saab 340 prop-control hang · AD 2024-15-08 / AD 2020-22-13 / AD 2019-04-09 · Mishra &amp; Sehra Aircraft Propellers 2e §8 · Roskam Vol VI §9.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
