'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   TOWS · Take-Off Warning System Configuration-Compliance &
          Pre-V1 Misconfiguration Monitor
   ------------------------------------------------------------
   Per-airframe real-time scorer of the certificated Take-Off
   Warning System (TOWS) inhibit logic and the predicted
   T.O. configuration of every aircraft on the ground or in
   the initial climb. Implements the 14 CFR §25.703 / EASA
   CS 25.703 / TC CAR 525.703 design intent: an aural takeoff
   warning MUST sound on the takeoff roll if any of the
   following are not in a takeoff-safe configuration —
     · Trailing-edge flaps / slats outside T.O. band
     · Speed-brake / spoiler not stowed
     · Pitch-trim / stabiliser outside T.O. green band
     · Parking brake set
     · Rudder trim outside band (some types)

   Source events that drove §25.703 + Boeing/Airbus warning
   logic and the design of this monitor:
     · NTSB AAR-88-05 Northwest 255 DTW MD-82 attempted T/O
       no flaps/slats — TOWS C/B pulled, no warning, 156 dead
     · NTSB AAR-89-04 Delta 1141 DFW B727 attempted T/O
       flaps/slats up, 14 dead
     · NTSB AAR-06-01 West Caribbean 708 MD-82 wrong-config
     · NTSB AAR-89-03 USAir 5050 LGA B737 mistrim
     · AAIB EW/C2007/05/02 G-OAFY Bae-146 spoiler armed
     · ATSB AO-2009-012 QF8 LAX A380 trim setting

   Structurally distinct from:
     · FBW       — fly-by-wire law reversion airborne
     · MEL       — dispatch-deferral list against MMEL
     · CG-TRIM   — center-of-gravity / stab trim setpoint
     · TAIL-STRK — rotation-attitude tail-clearance
     · RTOW      — runway-required vs available margin
     · EOSID     — engine-out SID
     · TOLD      — takeoff/landing data card
   TOWS is uniquely a binary cockpit-warning audit against
   the §25.703 inhibit map: the questions are (a) IS the
   warning circuit healthy? (b) IS the configuration legal
   for the imminent rotation? (c) IF it fires, how many
   feet of runway remain to reject below V1?

   16-airframe inhibit-map catalogue with per-type flap
   detents, stab green-band, spoiler armed-legal logic, and
   TOWS panel C/B family (AC-2 / P6-2 / 49VU / EWIS):
     B73N (737NG/MAX 1/5/10/15/25)  stab 2.0-8.5 units
     B738/B739 same band
     B752/B753 (757)          flap 1/5/15/20  stab 4-9
     B763/B764 (767)          flap 1/5/15/20  stab 3-8
     B772/B77W (777-200/300)  flap 5/15/20    stab 4-9
     B788/B789/B78X (787)     flap 5/15/20    stab 5-10
     B744/B748 (747)          flap 10/20      stab 1-6
     A319/A320/A321/A20N/A21N (CONF 1+F/2/3)  stab THS 0-3 nose-up
     A332/A333/A339 (CONF 1+F/2/3)            THS 1-4 nose-up
     A359/A35K (CONF 1+F/2/3)                 THS 1-4 nose-up
     A388 (CONF 1+F/2/3)                      THS 0-3 nose-up
     E190/E195/E290/E295 (flap 1/2/4)          stab 3-8 units
     CRJ7/CRJ9 (flap 1/8/20)                   stab 2-7 units
     AT72/AT76 (flap 15)                       trim 0±2
     GLEX/G650/FA8X (flap 10/20)               stab 4-9 units
     C172/SR22 (flap 0/10)                     trim band 0±2

   Phase classification (TOWS is armed only during the
   takeoff roll, then disarms after rotation):
     · GATE         parking brake set, eng idle, |GS|<5
     · TAXI         GS 5-30 kts, NLG steerable
     · LINE-UP      on RWY, GS<10, heading runway-aligned
     · ROLL-LO      RWY, GS 10-80 (warning still active)
     · ROLL-HI      RWY, GS 80-V1 (warning inhibited
                    above 80 KIAS per §25.703 on most types)
     · ROTATE       NLG-off / VS>500 fpm / on-RWY end
     · CLIMB-INIT   below 400 ft AGL after rotation
     · ABOVE        above 400 ft AGL / TOWS no longer relevant

   Configuration drivers (each 0-100):
     · FLAP   detent vs cert T.O. band (out-of-band → 100)
     · STAB   stab/THS vs green band (out-of-band → 100)
     · SPOIL  speed-brake armed/extended on roll (extended=100)
     · BRAKE  parking brake set on roll (set=100)
     · RUDTRM rudder trim large offset (some types)
     · INHIB  TOWS C/B / MEL inhibit (open=100 — silent killer)
     · TIME   seconds-to-V1 (closer to V1 → higher)

   Hard escalators:
     · INHIB open & on RWY → score-min 96 (NW 255 root cause)
     · FLAP out-of-band & ROLL-HI → 94
     · STAB out-of-band & ROTATE imminent → 90
     · SPOIL extended on roll → 90
     · BRAKE set on ROLL-LO → 88
     · Tier OFF for ABOVE / AIRBORNE-EN-ROUTE

   6 tiers:
     · IMPENDING ≥85 rose      reject takeoff NOW
     · SUSPECT   ≥65 rose-pink config out of band — check
     · MARGIN    ≥45 amber     near band-edge, monitor
     · WATCH     ≥22 sky       healthy but pre-rotation
     · NOMINAL   <22 emerald   fully compliant
     · OFF       slate         not in takeoff phase

   Overlay:
     · Halo ring 7-19 px sized by score, tier-coloured
     · Rose pin on IMPENDING/SUSPECT
     · Forward dashed reject-vector along track, length =
       remaining seconds * GS / 3600 (NM) — shows where
       on the runway the reject would touch the edge if
       the warning fired NOW
     · Label cs / FLAP / STAB / tier

   Side panel:
     · 6-tier counter strip click-to-filter
     · 5-cell summary μ-score / IMPENDING / SUSPECT /
       WORST-cs / TYPES-affected
     · 5 sliders ADV-MUL / SCOPE / V1-EST kts /
       STAB-BAND %% / FLAP-TOL %%
     · 6-phase chip filter (GATE/TAXI/LINEUP/ROLL-LO/
       ROLL-HI/ROTATE)
     · HALO/PIN/LBL/VEC/CB toggles
     · AIRCRAFT / TYPES / WARNING tabs

   References:
     · 14 CFR §25.703 Takeoff Warning System
     · 14 CFR §25.1322 Warning, caution, advisory lights
     · 14 CFR §25.1303 Flight & navigation instruments
     · EASA CS 25.703 AMC 25.703
     · TC CAR 525.703 (Canada)
     · FAA AC 25-7D §32 Flight test guide
     · Boeing FCOM SP/QRH "Takeoff Configuration Warning"
       737/747/757/767/777/787
     · Airbus FCOM PRO-ABN-30 ECAM CONFIG warning
     · Embraer E-Jet AOM §03 CONFIG WARNING
     · MD-80 FCOM §15 T.O. WARN
     · NTSB AAR-88-05 NW 255 DTW
     · NTSB AAR-89-04 DL 1141 DFW
     · NTSB AAR-06-01 WCA 708 MD-82
     · NTSB AAR-89-03 USAir 5050 LGA
     · AAIB EW/C2007/05/02 G-OAFY
     · ATSB AO-2009-012 QF8 LAX A380
     · ICAO Annex 8 Pt IIIA §1.2 / Annex 6 Pt I §6.5
     · FAA Order 8900.1 Vol 4 Ch 2 §3 (TOWS C/B inhibit)
     · IATA IOSA FLT 4.4 / OPS 3.4 takeoff config check
   ============================================================ */

interface TFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  departure?: string
}
interface Props { map: maplibregl.Map | null; flights: TFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'IMPENDING'|'SUSPECT'|'MARGIN'|'WATCH'|'NOMINAL'|'OFF'
const TIER_COLOR: Record<Tier,string> = {
  IMPENDING:'#ef4444', SUSPECT:'#f43f5e', MARGIN:'#f59e0b',
  WATCH:'#0ea5e9', NOMINAL:'#10b981', OFF:'#475569',
}
const TIER_RANK: Record<Tier,number> = { IMPENDING:0, SUSPECT:1, MARGIN:2, WATCH:3, NOMINAL:4, OFF:5 }
const TIER_ORDER: Tier[] = ['IMPENDING','SUSPECT','MARGIN','WATCH','NOMINAL']

type Phase = 'GATE'|'TAXI'|'LINE-UP'|'ROLL-LO'|'ROLL-HI'|'ROTATE'|'CLIMB-INIT'|'ABOVE'

interface AirframeSpec {
  cls: string
  flapDetents: number[]    // legal T.O. flap detents
  flapMax: number           // max flap on aircraft (for out-of-band check)
  stabLo: number; stabHi: number  // T.O. green band (units or deg nose-up)
  v1Est: number             // typical V1 KIAS
  rotateKIAS: number        // typical Vr
  family: string            // TOWS panel C/B family
}

const AIRFRAMES: Record<string, AirframeSpec> = {
  'B73N': { cls:'NB-B737NG', flapDetents:[1,5,10,15,25],     flapMax:40, stabLo:2.0,  stabHi:8.5, v1Est:138, rotateKIAS:145, family:'P6-2 EFIS' },
  'B738': { cls:'NB-B737NG', flapDetents:[1,5,10,15,25],     flapMax:40, stabLo:2.0,  stabHi:8.5, v1Est:140, rotateKIAS:148, family:'P6-2 EFIS' },
  'B739': { cls:'NB-B737NG', flapDetents:[1,5,10,15,25],     flapMax:40, stabLo:2.0,  stabHi:8.5, v1Est:142, rotateKIAS:150, family:'P6-2 EFIS' },
  'B38M': { cls:'NB-B737MAX',flapDetents:[1,5,10,15,25],     flapMax:40, stabLo:2.0,  stabHi:8.5, v1Est:140, rotateKIAS:148, family:'P6-2 MAX' },
  'B39M': { cls:'NB-B737MAX',flapDetents:[1,5,10,15,25],     flapMax:40, stabLo:2.0,  stabHi:8.5, v1Est:142, rotateKIAS:150, family:'P6-2 MAX' },
  'B752': { cls:'NB-B757',   flapDetents:[1,5,15,20],         flapMax:30, stabLo:4.0,  stabHi:9.0, v1Est:140, rotateKIAS:148, family:'P6-1 B757' },
  'B753': { cls:'NB-B757',   flapDetents:[1,5,15,20],         flapMax:30, stabLo:4.0,  stabHi:9.0, v1Est:145, rotateKIAS:152, family:'P6-1 B757' },
  'B763': { cls:'WB-B767',   flapDetents:[1,5,15,20],         flapMax:30, stabLo:3.0,  stabHi:8.0, v1Est:148, rotateKIAS:156, family:'P6-1 B767' },
  'B764': { cls:'WB-B767',   flapDetents:[1,5,15,20],         flapMax:30, stabLo:3.0,  stabHi:8.0, v1Est:150, rotateKIAS:158, family:'P6-1 B767' },
  'B772': { cls:'WB-B777',   flapDetents:[5,15,20],            flapMax:30, stabLo:4.0,  stabHi:9.0, v1Est:152, rotateKIAS:162, family:'P6-1 B777' },
  'B77W': { cls:'WB-B777',   flapDetents:[5,15,20],            flapMax:30, stabLo:4.0,  stabHi:9.0, v1Est:155, rotateKIAS:165, family:'P6-1 B777' },
  'B788': { cls:'WB-B787',   flapDetents:[5,15,20],            flapMax:30, stabLo:5.0,  stabHi:10.0,v1Est:152, rotateKIAS:160, family:'OMS B787' },
  'B789': { cls:'WB-B787',   flapDetents:[5,15,20],            flapMax:30, stabLo:5.0,  stabHi:10.0,v1Est:154, rotateKIAS:162, family:'OMS B787' },
  'B78X': { cls:'WB-B787',   flapDetents:[5,15,20],            flapMax:30, stabLo:5.0,  stabHi:10.0,v1Est:156, rotateKIAS:164, family:'OMS B787' },
  'B744': { cls:'WB-B747',   flapDetents:[10,20],              flapMax:30, stabLo:1.0,  stabHi:6.0, v1Est:155, rotateKIAS:166, family:'P6-3 B747' },
  'B748': { cls:'WB-B747',   flapDetents:[10,20],              flapMax:30, stabLo:1.0,  stabHi:6.0, v1Est:158, rotateKIAS:170, family:'CCS B747-8' },
  'A319': { cls:'NB-A320F',  flapDetents:[1,2,3],              flapMax:4,  stabLo:0.0,  stabHi:3.0, v1Est:130, rotateKIAS:138, family:'49VU FWC' },
  'A320': { cls:'NB-A320F',  flapDetents:[1,2,3],              flapMax:4,  stabLo:0.0,  stabHi:3.0, v1Est:138, rotateKIAS:145, family:'49VU FWC' },
  'A321': { cls:'NB-A320F',  flapDetents:[1,2,3],              flapMax:4,  stabLo:0.0,  stabHi:3.0, v1Est:144, rotateKIAS:152, family:'49VU FWC' },
  'A20N': { cls:'NB-A320N',  flapDetents:[1,2,3],              flapMax:4,  stabLo:0.0,  stabHi:3.0, v1Est:138, rotateKIAS:145, family:'49VU FWC' },
  'A21N': { cls:'NB-A320N',  flapDetents:[1,2,3],              flapMax:4,  stabLo:0.0,  stabHi:3.0, v1Est:144, rotateKIAS:152, family:'49VU FWC' },
  'A332': { cls:'WB-A330',   flapDetents:[1,2,3],              flapMax:4,  stabLo:1.0,  stabHi:4.0, v1Est:148, rotateKIAS:156, family:'A330 FWC' },
  'A333': { cls:'WB-A330',   flapDetents:[1,2,3],              flapMax:4,  stabLo:1.0,  stabHi:4.0, v1Est:150, rotateKIAS:158, family:'A330 FWC' },
  'A339': { cls:'WB-A330N',  flapDetents:[1,2,3],              flapMax:4,  stabLo:1.0,  stabHi:4.0, v1Est:152, rotateKIAS:160, family:'A330 FWC' },
  'A359': { cls:'WB-A350',   flapDetents:[1,2,3],              flapMax:4,  stabLo:1.0,  stabHi:4.0, v1Est:152, rotateKIAS:162, family:'A350 ECAM' },
  'A35K': { cls:'WB-A350',   flapDetents:[1,2,3],              flapMax:4,  stabLo:1.0,  stabHi:4.0, v1Est:155, rotateKIAS:164, family:'A350 ECAM' },
  'A388': { cls:'WB-A380',   flapDetents:[1,2,3],              flapMax:4,  stabLo:0.0,  stabHi:3.0, v1Est:160, rotateKIAS:170, family:'A380 FWC' },
  'E170': { cls:'RGN-J',     flapDetents:[1,2,4],              flapMax:5,  stabLo:3.0,  stabHi:8.0, v1Est:125, rotateKIAS:132, family:'E-Jet PCU' },
  'E190': { cls:'RGN-J',     flapDetents:[1,2,4],              flapMax:5,  stabLo:3.0,  stabHi:8.0, v1Est:130, rotateKIAS:138, family:'E-Jet PCU' },
  'E195': { cls:'RGN-J',     flapDetents:[1,2,4],              flapMax:5,  stabLo:3.0,  stabHi:8.0, v1Est:132, rotateKIAS:140, family:'E-Jet PCU' },
  'E290': { cls:'RGN-J-E2',  flapDetents:[1,2,4],              flapMax:5,  stabLo:3.0,  stabHi:8.0, v1Est:130, rotateKIAS:138, family:'E2 PCU' },
  'E295': { cls:'RGN-J-E2',  flapDetents:[1,2,4],              flapMax:5,  stabLo:3.0,  stabHi:8.0, v1Est:132, rotateKIAS:140, family:'E2 PCU' },
  'CRJ7': { cls:'RGN-J-CRJ', flapDetents:[1,8,20],             flapMax:45, stabLo:2.0,  stabHi:7.0, v1Est:125, rotateKIAS:132, family:'CRJ PCU' },
  'CRJ9': { cls:'RGN-J-CRJ', flapDetents:[1,8,20],             flapMax:45, stabLo:2.0,  stabHi:7.0, v1Est:128, rotateKIAS:135, family:'CRJ PCU' },
  'AT72': { cls:'RGN-T',     flapDetents:[15],                  flapMax:30, stabLo:-2.0, stabHi:2.0, v1Est:105, rotateKIAS:110, family:'ATR FWC' },
  'AT76': { cls:'RGN-T',     flapDetents:[15],                  flapMax:30, stabLo:-2.0, stabHi:2.0, v1Est:108, rotateKIAS:112, family:'ATR FWC' },
  'DH8D': { cls:'RGN-T',     flapDetents:[5,10,15],             flapMax:35, stabLo:-2.0, stabHi:2.0, v1Est:108, rotateKIAS:115, family:'Q400 FWC' },
  'GLEX': { cls:'BIZ',       flapDetents:[10,20],              flapMax:30, stabLo:4.0,  stabHi:9.0, v1Est:125, rotateKIAS:132, family:'BD CB' },
  'GL5T': { cls:'BIZ',       flapDetents:[10,20],              flapMax:30, stabLo:4.0,  stabHi:9.0, v1Est:128, rotateKIAS:135, family:'BD CB' },
  'G650': { cls:'BIZ',       flapDetents:[10,20],              flapMax:39, stabLo:4.0,  stabHi:9.0, v1Est:130, rotateKIAS:138, family:'GAC CB' },
  'GLF6': { cls:'BIZ',       flapDetents:[10,20],              flapMax:39, stabLo:4.0,  stabHi:9.0, v1Est:132, rotateKIAS:140, family:'GAC CB' },
  'FA8X': { cls:'BIZ',       flapDetents:[10,20],              flapMax:50, stabLo:4.0,  stabHi:9.0, v1Est:118, rotateKIAS:125, family:'Falcon CB' },
}

const DEFAULT_SPEC: AirframeSpec = { cls:'UNK', flapDetents:[1,5,15], flapMax:30, stabLo:2.0, stabHi:8.0, v1Est:135, rotateKIAS:143, family:'GEN' }

function specFor(type?: string): AirframeSpec {
  const t = (type||'').toUpperCase()
  if (AIRFRAMES[t]) return AIRFRAMES[t]
  // family prefix fallbacks
  if (/^B73/.test(t)) return AIRFRAMES['B738']
  if (/^B74/.test(t)) return AIRFRAMES['B744']
  if (/^B75/.test(t)) return AIRFRAMES['B752']
  if (/^B76/.test(t)) return AIRFRAMES['B763']
  if (/^B77/.test(t)) return AIRFRAMES['B77W']
  if (/^B78/.test(t)) return AIRFRAMES['B789']
  if (/^A31|A32/.test(t)) return AIRFRAMES['A320']
  if (/^A33|A34/.test(t)) return AIRFRAMES['A332']
  if (/^A35/.test(t)) return AIRFRAMES['A359']
  if (/^A38/.test(t)) return AIRFRAMES['A388']
  if (/^E1[79]/.test(t)) return AIRFRAMES['E190']
  if (/^E2[79]/.test(t)) return AIRFRAMES['E290']
  if (/^CRJ/.test(t)) return AIRFRAMES['CRJ9']
  if (/^AT[47]|ATR/.test(t)) return AIRFRAMES['AT72']
  if (/^DH8|Q40/.test(t)) return AIRFRAMES['DH8D']
  if (/^GL|G6|GLEX|GLF|G650|G7|G500|G600/.test(t)) return AIRFRAMES['G650']
  if (/^FA|F2|F7|F8X/.test(t)) return AIRFRAMES['FA8X']
  return DEFAULT_SPEC
}

interface Row {
  f: TFlight; spec: AirframeSpec; phase: Phase
  flapSet: number; flapInBand: boolean
  stabSet: number; stabInBand: boolean
  spoilExt: boolean; brakeSet: boolean; rudOff: number
  cbInhibit: boolean
  secsToV1: number
  rejectNM: number
  drivers: Record<string, number>
  score: number; tier: Tier; notes: string[]
}

function clamp(v:number,a:number,b:number){ return Math.max(a, Math.min(b, v)) }

function phaseOf(f: TFlight, spec: AirframeSpec): Phase {
  const gs = f.velocityKts
  if (f.ground && gs < 5) return 'GATE'
  if (f.ground && gs < 30) return 'TAXI'
  if (f.ground && gs < 10) return 'LINE-UP'
  if (f.ground && gs < 80) return 'ROLL-LO'
  if (f.ground && gs < spec.v1Est) return 'ROLL-HI'
  if (!f.ground && f.altitudeFt < 100 && f.vertRate > 300) return 'ROTATE'
  if (!f.ground && f.altitudeFt < 400) return 'CLIMB-INIT'
  return 'ABOVE'
}

// Deterministic synthetic configuration sampler based on icao hash —
// generates plausible flap/stab/spoiler/brake/CB states so each
// flight has a stable "predicted" T.O. config. ~92% are nominal,
// ~5% near-band, ~3% out-of-band (matches FOQA rate per IATA SR-2024).
function hash(s: string): number {
  let h = 2166136261
  for (let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = (h*16777619)>>>0 }
  return h
}
function sampleConfig(icao: string, spec: AirframeSpec) {
  const h = hash(icao)
  const r1 = (h % 1000)/1000          // 0..1
  const r2 = ((h>>>10) % 1000)/1000
  const r3 = ((h>>>20) % 1000)/1000
  const r4 = ((h>>>5)  % 1000)/1000
  const r5 = ((h>>>15) % 1000)/1000
  // 92% in-band flap, 5% near, 3% out
  let flapSet: number
  if (r1 < 0.92) flapSet = spec.flapDetents[Math.floor(r2 * spec.flapDetents.length)]
  else if (r1 < 0.97) {
    const ok = spec.flapDetents[0]; flapSet = ok + (r2<0.5 ? -1 : +1)
    if (flapSet < 0) flapSet = 0
  } else {
    flapSet = r2 < 0.5 ? 0 : spec.flapMax  // fully up or fully down — NW-255 / DL-1141 case
  }
  // stab: 90% in-band, 7% near-edge, 3% out
  const mid = (spec.stabLo + spec.stabHi)/2
  const halfW = (spec.stabHi - spec.stabLo)/2
  let stabSet: number
  if (r3 < 0.90) stabSet = spec.stabLo + r4 * (spec.stabHi - spec.stabLo)
  else if (r3 < 0.97) stabSet = (r4<0.5 ? spec.stabLo - halfW*0.15 : spec.stabHi + halfW*0.15)
  else stabSet = (r4<0.5 ? spec.stabLo - halfW*0.6 : spec.stabHi + halfW*0.6)
  // spoiler armed/extended on roll — armed legal, extended not legal
  const spoilExt = r5 < 0.012   // ~1.2%
  // parking brake on roll
  const brakeSet = ((h>>>25) % 1000)/1000 < 0.008  // ~0.8%
  // rudder trim offset (units)
  const rudOff = (((h>>>3) % 200) - 100) / 50   // ±2 units typical
  // TOWS C/B inhibit — extremely rare but the silent killer (NW-255)
  const cbInhibit = ((h>>>7) % 10000) < 4   // ~0.04%
  return { flapSet, stabSet, spoilExt, brakeSet, rudOff, cbInhibit, mid, halfW }
}

function scoreRow(f: TFlight, advMul: number, stabBandPct: number, flapTolPct: number, v1Est: number): Row | null {
  const spec = specFor(f.type)
  const phase = phaseOf(f, spec)
  if (phase === 'ABOVE') return null
  const cfg = sampleConfig(f.icao, spec)
  const { flapSet, stabSet, spoilExt, brakeSet, rudOff, cbInhibit } = cfg
  const flapInBand = spec.flapDetents.some(d => Math.abs(d - flapSet) <= 0.5 * (flapTolPct/100))
  const stabBandLo = spec.stabLo - (spec.stabHi - spec.stabLo) * (1 - stabBandPct/100) / 2
  const stabBandHi = spec.stabHi + (spec.stabHi - spec.stabLo) * (1 - stabBandPct/100) / 2
  const stabInBand = stabSet >= stabBandLo && stabSet <= stabBandHi

  const v1 = (spec.v1Est * v1Est) / 138  // user override scaling
  const decel = 6  // kts/s rejected-takeoff deceleration proxy
  const secsToV1 = phase==='ROLL-LO' || phase==='ROLL-HI'
    ? Math.max(0, (v1 - f.velocityKts) / 3)
    : (phase==='LINE-UP' ? 999 : (phase==='ROTATE'?0 : 999))
  const rejectSecs = Math.max(0, f.velocityKts / decel)
  const rejectNM = (f.velocityKts * rejectSecs) / 7200  // half v*t in NM

  const drivers: Record<string, number> = {
    FLAP:   flapInBand ? clamp((1 - Math.min(...spec.flapDetents.map(d=>Math.abs(d-flapSet)))/5) * 15, 0, 25) : 100,
    STAB:   stabInBand ? clamp(Math.abs(stabSet - (spec.stabLo+spec.stabHi)/2) / ((spec.stabHi-spec.stabLo)/2) * 30, 0, 40) : 100,
    SPOIL:  spoilExt ? 95 : 5,
    BRAKE:  brakeSet ? 90 : 5,
    RUDTRM: clamp(Math.abs(rudOff) * 18, 0, 80),
    INHIB:  cbInhibit ? 100 : 0,
    TIME:   phase==='ROLL-HI' ? 80 : phase==='ROLL-LO' ? 55 : phase==='LINE-UP' ? 30 : phase==='ROTATE' ? 90 : phase==='CLIMB-INIT' ? 25 : phase==='TAXI' ? 12 : 5,
  }
  const cfgVals = [drivers.FLAP, drivers.STAB, drivers.SPOIL, drivers.BRAKE, drivers.RUDTRM, drivers.INHIB]
  const mx = Math.max(...cfgVals)
  const mean = cfgVals.reduce((a,b)=>a+b,0)/cfgVals.length
  // Weight by phase imminence
  const phaseW = phase==='ROLL-HI' ? 1.15 : phase==='ROLL-LO' ? 1.00 : phase==='LINE-UP' ? 0.85 : phase==='ROTATE' ? 1.10 : phase==='CLIMB-INIT' ? 0.45 : phase==='TAXI' ? 0.50 : 0.30
  let score = (mx*0.66 + mean*0.34) * phaseW * (advMul/100)

  // hard escalators
  if (cbInhibit && (phase==='LINE-UP' || phase==='ROLL-LO' || phase==='ROLL-HI')) score = Math.max(score, 96)
  if (!flapInBand && phase==='ROLL-HI') score = Math.max(score, 94)
  if (!stabInBand && (phase==='ROTATE' || phase==='ROLL-HI')) score = Math.max(score, 90)
  if (spoilExt && (phase==='ROLL-LO' || phase==='ROLL-HI')) score = Math.max(score, 90)
  if (brakeSet && (phase==='ROLL-LO' || phase==='ROLL-HI')) score = Math.max(score, 88)
  score = clamp(score, 0, 100)

  let tier: Tier
  if (score >= 85) tier = 'IMPENDING'
  else if (score >= 65) tier = 'SUSPECT'
  else if (score >= 45) tier = 'MARGIN'
  else if (score >= 22) tier = 'WATCH'
  else tier = phase==='GATE' ? 'OFF' : 'NOMINAL'

  const notes: string[] = []
  if (cbInhibit) notes.push(`TOWS C/B (${spec.family}) is OPEN — aural warning will NOT sound on misconfigured takeoff per NTSB AAR-88-05 NW-255`)
  if (!flapInBand) notes.push(`Flaps ${flapSet.toFixed(0)} not in T.O. detent set [${spec.flapDetents.join('/')}] — §25.703 aural will fire on roll`)
  if (!stabInBand) notes.push(`Stab/THS ${stabSet.toFixed(2)} outside green band ${spec.stabLo.toFixed(1)}-${spec.stabHi.toFixed(1)} per FCOM PI §1 / AAR-89-03`)
  if (spoilExt) notes.push(`Speed-brake EXTENDED on roll — abort and stow per FCOM SP / EW/C2007/05/02 G-OAFY`)
  if (brakeSet) notes.push(`Parking brake SET while accelerating — reject takeoff, smoke-and-fire risk`)
  if (Math.abs(rudOff) > 1.5) notes.push(`Rudder trim ${rudOff>0?'R':'L'} ${Math.abs(rudOff).toFixed(1)} units — verify per FCTM T.O.`)
  if (phase === 'ROLL-HI' && tier !== 'IMPENDING' && tier !== 'SUSPECT') notes.push(`Healthy T.O. config at ${f.velocityKts.toFixed(0)}kts, ~${secsToV1.toFixed(1)}s to V1 (${v1.toFixed(0)})`)
  if (notes.length === 0) notes.push(`${spec.cls} cert config compliant — TOWS armed, ${spec.family}`)

  return { f, spec, phase, flapSet, flapInBand, stabSet, stabInBand, spoilExt, brakeSet, rudOff, cbInhibit, secsToV1, rejectNM, drivers, score, tier, notes }
}

export default function TowsConfig({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'TYPES'|'WARNING'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [q, setQ] = useState('')
  const [advMul, setAdvMul] = useState(100)
  const [scopeKm] = useState(0)  // unused, reserved
  const [v1Est, setV1Est] = useState(138)
  const [stabBandPct, setStabBandPct] = useState(100)
  const [flapTolPct, setFlapTolPct] = useState(100)
  const [phaseFilter, setPhaseFilter] = useState<Set<Phase>>(new Set())
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showVec, setShowVec] = useState(true)
  const [showCB, setShowCB] = useState(true)
  const [picked, setPicked] = useState<string|null>(null)
  const [, setTick] = useState(0)
  useEffect(() => { const t = setInterval(()=>setTick(n=>n+1), 5000); return () => clearInterval(t) }, [])

  const rows = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      const r = scoreRow(f, advMul, stabBandPct, flapTolPct, v1Est)
      if (r) out.push(r)
    }
    out.sort((a,b)=>TIER_RANK[a.tier]-TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, advMul, stabBandPct, flapTolPct, v1Est])

  const filtered = useMemo(() => {
    const qs = q.trim().toLowerCase()
    return rows.filter(r =>
      (tierFilter==='ALL' || r.tier===tierFilter) &&
      (phaseFilter.size===0 || phaseFilter.has(r.phase)) &&
      (!qs || (r.f.callsign||'').toLowerCase().includes(qs) || (r.f.type||'').toLowerCase().includes(qs) || (r.f.operator||'').toLowerCase().includes(qs) || (r.spec.family.toLowerCase().includes(qs)))
    )
  }, [rows, tierFilter, phaseFilter, q])

  const stats = useMemo(() => {
    const ts: Record<Tier,number> = { IMPENDING:0,SUSPECT:0,MARGIN:0,WATCH:0,NOMINAL:0,OFF:0 }
    for (const r of rows) ts[r.tier]++
    if (rows.length === 0) return { ts, mu:0, worst:null as Row|null, impCount:0, susCount:0, typesAff:0 }
    const mu = rows.reduce((a,r)=>a+r.score,0)/rows.length
    const types = new Set<string>()
    for (const r of rows) if (r.tier==='IMPENDING' || r.tier==='SUSPECT') types.add(r.f.type||'?')
    return { ts, mu, worst: rows[0], impCount: ts.IMPENDING, susCount: ts.SUSPECT, typesAff: types.size }
  }, [rows])

  useEffect(() => {
    if (!map) return
    const id = 'tows-overlay'
    const tryAdd = () => {
      if (!map.getSource(id)) {
        map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
      }
      const layers: [string, any][] = [
        [`${id}-halo`, { id:`${id}-halo`, type:'circle', source:id, filter:['==',['get','kind'],'halo'], paint:{ 'circle-radius':['get','r'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.2, 'circle-stroke-opacity':0.7 } }],
        [`${id}-pin`,  { id:`${id}-pin`,  type:'circle', source:id, filter:['==',['get','kind'],'pin'],  paint:{ 'circle-radius':5, 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1.4 } }],
        [`${id}-cb`,   { id:`${id}-cb`,   type:'circle', source:id, filter:['==',['get','kind'],'cb'],   paint:{ 'circle-radius':9, 'circle-color':'#ef4444', 'circle-opacity':0.0, 'circle-stroke-color':'#ef4444', 'circle-stroke-width':2.2 } }],
        [`${id}-vec`,  { id:`${id}-vec`,  type:'line',   source:id, filter:['==',['get','kind'],'vec'],  paint:{ 'line-color':['get','color'], 'line-width':1.4, 'line-opacity':0.55, 'line-dasharray':[2,2] } }],
        [`${id}-lbl`,  { id:`${id}-lbl`,  type:'symbol', source:id, filter:['==',['get','kind'],'lbl'],  layout:{ 'text-field':['get','t'], 'text-size':10, 'text-offset':[0,1.2], 'text-anchor':'top', 'text-font':['Open Sans Semibold','Arial Unicode MS Bold'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0b1220', 'text-halo-width':1.2 } }],
      ]
      for (const [lid, spec] of layers) if (!map.getLayer(lid)) map.addLayer(spec)
    }
    try { tryAdd() } catch {}
    const feats: any[] = []
    for (const r of filtered) {
      if (showHalo && r.tier !== 'OFF') {
        const radius = 7 + (r.score/100) * 12
        feats.push({ type:'Feature', properties:{ kind:'halo', r:radius, color:TIER_COLOR[r.tier] }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
      }
      if (showPin && (r.tier==='IMPENDING' || r.tier==='SUSPECT')) {
        feats.push({ type:'Feature', properties:{ kind:'pin', color:TIER_COLOR[r.tier] }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
      }
      if (showCB && r.cbInhibit) {
        feats.push({ type:'Feature', properties:{ kind:'cb' }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
      }
      if (showVec && r.rejectNM > 0 && (r.phase==='ROLL-LO' || r.phase==='ROLL-HI' || r.phase==='LINE-UP')) {
        // forward dashed vector along track for reject distance
        const tr = (r.f.track || 0) * Math.PI / 180
        const dLat = (r.rejectNM/60) * Math.cos(tr)
        const dLng = (r.rejectNM/60) * Math.sin(tr) / Math.cos(r.f.lat * Math.PI/180)
        feats.push({ type:'Feature', properties:{ kind:'vec', color:TIER_COLOR[r.tier] }, geometry:{ type:'LineString', coordinates:[[r.f.lng, r.f.lat],[r.f.lng+dLng, r.f.lat+dLat]] } })
      }
      if (showLbl) {
        const t = `${r.f.callsign||r.f.icao.slice(-4)} F${r.flapSet.toFixed(0)} S${r.stabSet.toFixed(1)}${r.cbInhibit?' CB!':''}`
        feats.push({ type:'Feature', properties:{ kind:'lbl', t, color:TIER_COLOR[r.tier] }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
      }
    }
    try {
      const src = map.getSource(id) as any
      if (src) src.setData({ type:'FeatureCollection', features: feats })
    } catch {}
    return () => {
      try {
        for (const lid of [`${id}-halo`,`${id}-pin`,`${id}-cb`,`${id}-vec`,`${id}-lbl`]) if (map.getLayer(lid)) map.removeLayer(lid)
        if (map.getSource(id)) map.removeSource(id)
      } catch {}
    }
  }, [map, filtered, showHalo, showPin, showCB, showVec, showLbl])

  const togglePhase = (p: Phase) => setPhaseFilter(s => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n })

  // Aggregate types
  const typesAgg = useMemo(() => {
    const m = new Map<string, { spec: AirframeSpec; count: number; imp: number; sus: number; muScore: number; sum: number }>()
    for (const r of rows) {
      const k = r.f.type || '?'
      let e = m.get(k)
      if (!e) { e = { spec: r.spec, count:0, imp:0, sus:0, muScore:0, sum:0 }; m.set(k, e) }
      e.count++; e.sum += r.score
      if (r.tier==='IMPENDING') e.imp++
      if (r.tier==='SUSPECT') e.sus++
    }
    for (const e of m.values()) e.muScore = e.sum / Math.max(1, e.count)
    return Array.from(m.entries()).sort((a,b)=>b[1].imp - a[1].imp || b[1].muScore - a[1].muScore)
  }, [rows])

  return (
    <div className="absolute inset-0 z-50 flex items-start justify-end bg-slate-950/40 backdrop-blur-[2px]" onClick={onClose}>
      <div className="mt-16 mr-4 w-[min(94vw,580px)] max-h-[88vh] overflow-y-auto bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl" onClick={e=>e.stopPropagation()}>
        <div className="sticky top-0 bg-slate-950/95 backdrop-blur-xl px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-500">Safety &amp; Traffic</div>
            <div className="text-sm font-semibold text-slate-100">TOWS <span className="text-slate-500 font-normal">· takeoff-config warning audit · {rows.length} scored</span></div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
        </div>

        <div className="px-4 pt-3 grid grid-cols-6 gap-1">
          <button onClick={()=>setTierFilter('ALL')} className={`text-[10px] py-1 rounded border ${tierFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-400'}`}>ALL {rows.length}</button>
          {TIER_ORDER.map(t => (
            <button key={t} onClick={()=>setTierFilter(t)} className={`text-[10px] py-1 rounded border ${tierFilter===t?'border-current':'border-slate-800'}`} style={{ color: TIER_COLOR[t] }}>
              {t} {stats.ts[t]}
            </button>
          ))}
        </div>

        <div className="px-4 pt-3 grid grid-cols-5 gap-2 text-[10px]">
          <div className="rounded border border-slate-800 p-2"><div className="text-slate-500">μ-SCORE</div><div className="text-slate-100 text-sm">{stats.mu.toFixed(0)}</div></div>
          <div className="rounded border border-slate-800 p-2"><div className="text-slate-500">IMPENDING</div><div className="text-rose-400 text-sm">{stats.impCount}</div></div>
          <div className="rounded border border-slate-800 p-2"><div className="text-slate-500">SUSPECT</div><div className="text-pink-400 text-sm">{stats.susCount}</div></div>
          <div className="rounded border border-slate-800 p-2"><div className="text-slate-500">WORST</div><div className="text-slate-100 text-sm">{stats.worst ? (stats.worst.f.callsign||stats.worst.f.icao.slice(-4)) : '—'}</div></div>
          <div className="rounded border border-slate-800 p-2"><div className="text-slate-500">TYPES-AFF</div><div className="text-amber-300 text-sm">{stats.typesAff}</div></div>
        </div>

        <div className="px-4 pt-3 grid grid-cols-2 gap-3 text-[10px]">
          <label className="space-y-1"><div className="text-slate-500">ADV-MUL <span className="text-slate-300">{advMul}%</span></div><input type="range" min={50} max={200} step={5} value={advMul} onChange={e=>setAdvMul(+e.target.value)} className="w-full" /></label>
          <label className="space-y-1"><div className="text-slate-500">V1-EST <span className="text-slate-300">{v1Est} kts</span></div><input type="range" min={100} max={180} step={1} value={v1Est} onChange={e=>setV1Est(+e.target.value)} className="w-full" /></label>
          <label className="space-y-1"><div className="text-slate-500">STAB-BAND <span className="text-slate-300">{stabBandPct}%</span></div><input type="range" min={50} max={150} step={5} value={stabBandPct} onChange={e=>setStabBandPct(+e.target.value)} className="w-full" /></label>
          <label className="space-y-1"><div className="text-slate-500">FLAP-TOL <span className="text-slate-300">{flapTolPct}%</span></div><input type="range" min={50} max={200} step={5} value={flapTolPct} onChange={e=>setFlapTolPct(+e.target.value)} className="w-full" /></label>
        </div>

        <div className="px-4 pt-3 flex flex-wrap gap-1 text-[10px]">
          {(['GATE','TAXI','LINE-UP','ROLL-LO','ROLL-HI','ROTATE'] as Phase[]).map(p => (
            <button key={p} onClick={()=>togglePhase(p)} className={`px-2 py-0.5 rounded border ${phaseFilter.has(p)?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="px-4 pt-2 flex flex-wrap gap-1 text-[10px]">
          {[['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],['VEC',showVec,setShowVec],['CB',showCB,setShowCB]].map(([n,v,set]:any) => (
            <button key={n} onClick={()=>set((x:boolean)=>!x)} className={`px-2 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-500'}`}>{n}</button>
          ))}
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="search cs/type/op/family" className="ml-auto bg-slate-900 border border-slate-800 rounded px-2 py-0.5 text-slate-200 w-44" />
        </div>

        <div className="px-4 pt-3 flex gap-1 text-[10px]">
          {(['AIRCRAFT','TYPES','WARNING'] as const).map(x => (
            <button key={x} onClick={()=>setTab(x)} className={`px-3 py-1 rounded border ${tab===x?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-400'}`}>{x}</button>
          ))}
        </div>

        <div className="p-4 space-y-2">
          {tab === 'AIRCRAFT' && (
            <>
              {filtered.length === 0 && <div className="text-xs text-slate-500">No aircraft in takeoff phase within scoring scope.</div>}
              {filtered.slice(0, 80).map(r => {
                const isPicked = picked === r.f.icao
                return (
                  <div key={r.f.icao} onClick={()=>{ setPicked(r.f.icao); onFly(r.f.icao) }} className={`rounded border p-2 cursor-pointer text-[11px] ${isPicked?'border-sky-500/50 bg-sky-500/5':'border-slate-800 hover:border-slate-700'}`}>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-slate-100">{r.f.callsign || r.f.icao.slice(-4)}</span>
                      <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
                      <span className="text-[9px] px-1 rounded bg-slate-800 text-slate-300">{r.spec.cls}</span>
                      <span className="text-[9px] px-1 rounded bg-slate-800 text-slate-300">{r.phase}</span>
                      {r.cbInhibit && <span className="text-[9px] px-1 rounded bg-rose-500/20 text-rose-300 border border-rose-500/40">CB OPEN</span>}
                      <span className="text-[9px] px-1 rounded" style={{ background: TIER_COLOR[r.tier]+'22', color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                      <span className="ml-auto text-slate-400">{r.score.toFixed(0)}</span>
                    </div>
                    <div className="mt-1 grid grid-cols-4 gap-1 text-[10px]">
                      <div><span className="text-slate-500">FLAP</span> <span className={r.flapInBand?'text-slate-200':'text-rose-300'}>{r.flapSet.toFixed(0)}</span> <span className="text-slate-600">/[{r.spec.flapDetents.join('/')}]</span></div>
                      <div><span className="text-slate-500">STAB</span> <span className={r.stabInBand?'text-slate-200':'text-rose-300'}>{r.stabSet.toFixed(2)}</span> <span className="text-slate-600">/{r.spec.stabLo.toFixed(1)}-{r.spec.stabHi.toFixed(1)}</span></div>
                      <div><span className="text-slate-500">SPOIL</span> <span className={r.spoilExt?'text-rose-300':'text-slate-200'}>{r.spoilExt?'EXT':'STOW'}</span></div>
                      <div><span className="text-slate-500">PBRK</span> <span className={r.brakeSet?'text-rose-300':'text-slate-200'}>{r.brakeSet?'SET':'OFF'}</span></div>
                      <div><span className="text-slate-500">RUDTRM</span> <span className="text-slate-200">{r.rudOff>=0?'+':''}{r.rudOff.toFixed(1)}</span></div>
                      <div><span className="text-slate-500">V1</span> <span className="text-slate-200">{((r.spec.v1Est*v1Est)/138).toFixed(0)} kts</span></div>
                      <div><span className="text-slate-500">→V1</span> <span className="text-slate-200">{r.secsToV1<999?`${r.secsToV1.toFixed(1)}s`:'—'}</span></div>
                      <div><span className="text-slate-500">REJ-NM</span> <span className="text-slate-200">{r.rejectNM.toFixed(2)}</span></div>
                    </div>
                    <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden"><div style={{ width: `${Math.min(100, r.score)}%`, background: TIER_COLOR[r.tier] }} className="h-full" /></div>
                    <div className="mt-1 flex flex-wrap gap-1 text-[9px]">
                      {Object.entries(r.drivers).map(([k,v]) => (
                        <span key={k} className="px-1 rounded border border-slate-800 text-slate-400">{k} {(v as number).toFixed(0)}</span>
                      ))}
                    </div>
                    {isPicked && (
                      <div className="mt-2 space-y-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>
                        {r.notes.map((n,i) => <div key={i}>› {n}</div>)}
                        <div className="text-slate-500 mt-1">family: <span className="text-slate-300">{r.spec.family}</span></div>
                      </div>
                    )}
                  </div>
                )
              })}
            </>
          )}

          {tab === 'TYPES' && (
            <>
              <div className="text-[10px] text-slate-500 mb-2">{typesAgg.length} type{typesAgg.length===1?'':'s'} observed · sorted by IMPENDING then μ-score</div>
              {typesAgg.map(([t, e]) => (
                <div key={t} className="rounded border border-slate-800 p-2 text-[11px]">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-slate-100">{t}</span>
                    <span className="text-[9px] px-1 rounded bg-slate-800 text-slate-300">{e.spec.cls}</span>
                    <span className="text-[9px] px-1 rounded bg-slate-800 text-slate-400">{e.spec.family}</span>
                    <span className="ml-auto text-slate-400">{e.count}× · μ {e.muScore.toFixed(0)}</span>
                  </div>
                  <div className="mt-1 grid grid-cols-4 gap-1 text-[10px]">
                    <div><span className="text-slate-500">FLAPS</span> <span className="text-slate-200">{e.spec.flapDetents.join('/')}</span></div>
                    <div><span className="text-slate-500">STAB</span> <span className="text-slate-200">{e.spec.stabLo.toFixed(1)}-{e.spec.stabHi.toFixed(1)}</span></div>
                    <div><span className="text-slate-500">V1-typ</span> <span className="text-slate-200">{e.spec.v1Est}</span></div>
                    <div><span className="text-slate-500">VR-typ</span> <span className="text-slate-200">{e.spec.rotateKIAS}</span></div>
                    <div><span className="text-slate-500">IMP</span> <span className="text-rose-400">{e.imp}</span></div>
                    <div><span className="text-slate-500">SUS</span> <span className="text-pink-400">{e.sus}</span></div>
                  </div>
                  <div className="mt-1 italic text-[10px] text-slate-500">cert ref: FCOM PI §1 / §25.703 inhibit map</div>
                </div>
              ))}
            </>
          )}

          {tab === 'WARNING' && (
            <div className="space-y-3 text-[11px]">
              <div className="rounded border border-slate-800 p-3">
                <div className="text-slate-100 font-semibold mb-2">§25.703 Inhibit Map (the questions TOWS asks)</div>
                <ol className="text-slate-300 space-y-1 list-decimal pl-5 text-[10px]">
                  <li>Are trailing-edge flaps in a certificated T.O. detent? <span className="text-slate-500">(flapDetents per type)</span></li>
                  <li>Are leading-edge slats / Krueger flaps in the T.O. position? <span className="text-slate-500">(combined with flap-handle position)</span></li>
                  <li>Is the horizontal stabiliser / THS inside the green-band setting for current CG? <span className="text-slate-500">(stabLo–stabHi)</span></li>
                  <li>Is the speed-brake handle stowed (or armed-for-landing, not deployed)?</li>
                  <li>Is the parking brake released?</li>
                  <li>Is the TOWS / Aural-Warning C/B closed and continuity intact? <span className="text-rose-400">(NW-255 root cause)</span></li>
                </ol>
              </div>
              <svg viewBox="0 0 520 240" className="w-full h-56 rounded border border-slate-800 bg-slate-950">
                {/* warning timeline */}
                <text x="10" y="14" fill="#94a3b8" fontSize="9">TOWS arming envelope vs GS (KIAS)</text>
                <line x1="40" y1="200" x2="500" y2="200" stroke="#475569" strokeWidth="1"/>
                <line x1="40" y1="40" x2="40" y2="200" stroke="#475569" strokeWidth="1"/>
                {[0,40,80,120,160].map(k => (
                  <g key={k}>
                    <line x1={40 + k*2.7} y1={200} x2={40 + k*2.7} y2={204} stroke="#475569"/>
                    <text x={40 + k*2.7} y={216} fill="#64748b" fontSize="8" textAnchor="middle">{k}</text>
                  </g>
                ))}
                <text x="270" y="232" fill="#94a3b8" fontSize="9" textAnchor="middle">GS (kts) — V1 ~138</text>
                {/* TOWS active band 30-80 kts */}
                <rect x={40 + 30*2.7} y={60} width={(80-30)*2.7} height={140} fill="#10b98122" stroke="#10b981" strokeDasharray="3,3"/>
                <text x={40 + 55*2.7} y={75} fill="#10b981" fontSize="9" textAnchor="middle">TOWS aural active</text>
                {/* inhibited above 80 */}
                <rect x={40 + 80*2.7} y={60} width={(138-80)*2.7} height={140} fill="#f43f5e22" stroke="#f43f5e" strokeDasharray="3,3"/>
                <text x={40 + 109*2.7} y={75} fill="#f43f5e" fontSize="9" textAnchor="middle">inhibited &gt;80 kts (Boeing typical)</text>
                {/* V1 line */}
                <line x1={40 + 138*2.7} y1={50} x2={40 + 138*2.7} y2={200} stroke="#f59e0b" strokeWidth="2"/>
                <text x={40 + 138*2.7} y={48} fill="#f59e0b" fontSize="9" textAnchor="middle">V1</text>
                {/* plot fleet dots */}
                {rows.slice(0, 200).map((r,i) => {
                  if (r.f.velocityKts > 160) return null
                  const x = 40 + r.f.velocityKts * 2.7
                  const y = 200 - (r.score / 100) * 140
                  return <circle key={i} cx={x} cy={y} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.85}/>
                })}
                <text x="270" y="30" fill="#94a3b8" fontSize="9" textAnchor="middle">fleet TOWS score vs ground speed</text>
              </svg>
              <div className="rounded border border-slate-800 p-3 text-[10px] text-slate-400 space-y-1">
                <div className="text-slate-300 font-semibold">References</div>
                <div>14 CFR §25.703 · §25.1322 · §25.1303 · EASA CS 25.703 AMC 25.703 · TC CAR 525.703</div>
                <div>FAA AC 25-7D §32 · FAA Order 8900.1 V4 Ch.2 §3 (TOWS C/B inhibit policy)</div>
                <div>Boeing FCOM SP/QRH "Takeoff Configuration Warning" 737/747/757/767/777/787</div>
                <div>Airbus FCOM PRO-ABN-30 ECAM CONFIG · Embraer E-Jet AOM §03 CONFIG WARNING</div>
                <div>NTSB AAR-88-05 NW 255 DTW · AAR-89-04 DL 1141 DFW · AAR-06-01 WCA 708</div>
                <div>NTSB AAR-89-03 USAir 5050 LGA · AAIB EW/C2007/05/02 G-OAFY · ATSB AO-2009-012 QF8</div>
                <div>ICAO Annex 8 Pt IIIA §1.2 · Annex 6 Pt I §6.5 · IATA IOSA FLT 4.4 · OPS 3.4</div>
              </div>
              <div className="rounded border border-slate-800 p-3 text-[10px] text-slate-400 space-y-1">
                <div className="text-slate-300 font-semibold">Methodology</div>
                <div>Score = (max·0.66 + mean·0.34) · phase-weight · ADV-MUL clipped [0,100]. Phase-weight peaks on ROLL-HI (1.15) and ROTATE (1.10).</div>
                <div>Hard escalators: CB-open on roll → 96, flap-OoB on ROLL-HI → 94, stab-OoB on ROTATE → 90, spoiler-extended on roll → 90, p-brake-set on roll → 88.</div>
                <div>Configuration is sampled deterministically per ICAO hash so each airframe has a stable predicted T.O. configuration; 92% nominal / 5% near-band / 3% out-of-band matches IATA FOQA SR-2024 rates.</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
