'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   APBN · Approach Ban / Approach Continuation Rule
          Compliance Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator scoring whether each aircraft
   currently inbound to a catalogued instrument-approach runway
   may LAWFULLY CONTINUE the approach past the FAF / OM / 1000ft
   AGL gate, given (a) the currently reported RVR / visibility
   at the destination, (b) the per-approach-type minima for the
   procedure being flown (CAT-I 550m / CAT-II 300m / CAT-IIIA 175m
   / CAT-IIIB 50m / LNAV-VNAV / RNP-AR / NPA), and (c) the
   regulatory regime applicable to the operator (FAA Part 121
   §121.651(c) / EASA Part-CAT.OP.MPA.305 / ICAO Annex 6 Pt I
   §4.4.1.3 / UK CAP 670 / TCCA CARs 602.129).

   Structurally distinct from sibling layers:
     · APCH-CAT (the ILS CAT-I/II/III EQUIPMENT-vs-WEATHER
       eligibility evaluator — checks AHEAD of the approach
       whether the airframe equipment + crew currency + ground
       fit + reported WX allow the LV approach to be ATTEMPTED;
       APBN is the regulatory STOP-GATE at the OM/FAF crossing
       that says "WX deteriorated since approach was authorised —
       you may not continue past this point")
     · APR-MINS (the static DA/MDA lookup table for published
       procedures — a reference catalogue, not a continuation
       compliance evaluator)
     · CDFA / VDP (the VERTICAL-PATH conformance evaluator
       during the NPA descent — about geometry, not the OM-gate
       rule)
     · STABLE-APPROACH (the 1000ft / 500ft energy / config
       gate criteria — about whether the approach IS STABLE,
       not whether it is LEGAL)
     · GASA (the actively-in-progress GO-AROUND event monitor
       AFTER the GA is initiated)
     · LVTO (the LOW-VIS TAKE-OFF compliance evaluator on the
       departure side — opposite phase)
     · APCH-MIN / MA-OEI (the MISSED-APPROACH OEI net-climb-
       gradient CAPABILITY evaluator — what happens AFTER the
       GA, not the OM-gate continuation rule)

   APBN is uniquely the §121.651(c) / Part-CAT.OP.MPA.305
   "Commencement and Continuation" rule evaluator:

     "An IFR flight may continue toward the destination
      aerodrome to commence an instrument approach unless,
      at the latest before commencing the final approach
      segment (OM / FAP / 1000ft AGL whichever is reached
      first), the reported RVR / visibility is below the
      applicable minima for the approach being flown."

   Eight regulatory regimes catalogued:
     FAA-121   14 CFR §121.651(c) — controlling RVR at OM
               or 1000ft AGL whichever first; mid-marker /
               touchdown / rollout RVR per CAT-II/III ground
               equipment.  Approach ban tested AT THE OM.
     FAA-91-K  14 CFR §91.175(l) lower-than-standard takeoff/
               landing alt for Part 91-K fractional.
     EASA-CAT  EU Reg 965/2012 Part-CAT.OP.MPA.305 — same OM/
               1000ft test; commander has final discretion
               only if visual reference acquired at DH/MDA.
     EASA-NCC  Part-NCC.OP.110 — non-commercial complex; same
               test, lower required ground fit.
     UK-CAP670 CAA CAP 670 SUR — UK-specific RVR observer rules
               at non-AWS aerodromes; OM-gate identical.
     TCCA-CAR  Transport Canada CARs 602.128/602.129 — RVR
               controlling, OM-gate identical, T-RVR/M-RVR/R-RVR
               per CAT-II/III.
     CASA-AU   CASA Part 91 MOS 7.16 / CAR Part 121 — Australian
               variant; observed visibility may substitute for
               RVR where AWS-RVR unavailable.
     CAAC-PRC  CCAR-121.R5 §121.563 — China; identical OM-gate
               structure under bilateral with FAA / EASA.
     ICAO-A6   Annex 6 Pt I §4.4.1.3 — the global baseline
               whose text every regional regulator transcribes.

   Seven driver scores [0..100] aggregated per flight:
     RVR-DEF   RVR deficit vs applicable minimum (controlling
               sensor: TDZ-RVR for CAT-I/II; MID-RVR + TDZ for
               CAT-IIIA; TDZ + MID + RLO for CAT-IIIB).
     VIS-DEF   General-vis deficit vs converted minimum (per
               Annex 3 App.3 RVR-VIS conversion tables when
               RVR sensor unavailable).
     CLG       Ceiling vs HAT margin (ceiling below HAT = no
               visual ref expected at DH; some regimes treat
               as advisory only, not a hard ban).
     EQUIP     Ground equipment partial-failure (LLZ-degraded,
               GP-NOTAM-OUT, RVR-sensor-INOP) raises applicable
               minimum to next-higher CAT — APBN re-evaluates.
     OPS-AUTH  Operator-specific authorisation gap (OpSpec C059
               / C061 / C062 / C078 for CAT-II/III missing or
               expired in carrier MEL).
     GATE      Distance-to-FAF or distance-to-OM proxy — the
               compliance gate becomes BINDING within 1NM of
               the FAF or below 1000ft AGL whichever first.
     TREND     RVR / vis trend over last ~10 min — improving
               trend reduces composite score, deteriorating
               trend boosts it (per ICAO Annex 3 App.3 SPECI
               trigger thresholds).

   Six hard tiers (per ICAO Doc 9859 SMS risk-tolerability
   matrix mapped to operational continuation decisions):
     BAN     ≥ 85   rose       ban-mandatory; expect GA call
     CRIT    ≥ 65   rose-pink  RVR/VIS deficit at OM; PIC
                                 must abort unless EFVS credit
     MARGIN  ≥ 45   amber      within ±10% of minima; watch
     WATCH   ≥ 25   sky        comfortable margin; monitor
     CLEAR   ≥ 10   emerald    ample margin
     OFF     <  10  slate      not in approach gate / VFR /
                                 cruise / departure

   Per-flight aggregate = max(0.65 * worst-driver,
                              0.35 * weighted-mean) gated by
   GATE-distance multiplier (1.0 inside OM, 0.55 outside).

   References:
     14 CFR §121.651(a)(b)(c) — Takeoff & landing weather
       minimums: IFR: All certificate holders
     14 CFR §121.652 — Lower-than-standard takeoff/landing
     14 CFR §91.175(a)(b) — Takeoff and landing under IFR
     14 CFR §91.189 — Category II and III: Vis-only restriction
     EASA Part-CAT.OP.MPA.300/305/310 — Commencement &
       continuation of approach
     EASA Part-CAT.OP.MPA.246 — In-flight fuel management
     EASA AMC1 CAT.OP.MPA.305 ed.7 (2024) — Commander discretion
     ICAO Annex 6 Pt I §4.4.1.3 — Operating minima
     ICAO Annex 3 App.3 §4 — RVR vs MET visibility conversion
     ICAO Doc 9365 All-Weather Operations Manual ed.3
     ICAO Doc 9476 SMGCS  ·  Doc 9830 A-SMGCS
     ICAO Doc 8168 PANS-OPS Vol I §1.4 — CAT-I/II/III minima
     ICAO Doc 9859 Safety Management Manual ed.4 §2 risk matrix
     FAA Order JO 7110.65 §3-1-7 LVPs RVR ≤ 1200ft
     FAA Order 8400.13D — CAT-II/III operations approval
     FAA AC 120-28D — CAT-IIIb FailOp no-DH
     FAA AC 120-29A — CAT-I / CAT-II approval
     FAA AC 90-106A — EFVS-to-landing operations
     CAA CAP 670 SUR §5 — UK approach ban / RVR observer
     TCCA CARs 602.128/129 — Canadian RVR / commencement rule
     CASA Part 91 MOS Chap 7.16 — Australian commencement
     CCAR-121.R5 §121.563 — China commencement
     IATA STEADES 2024 §6 — RVR-deficit at FAF case statistics
     FSF ALAR Briefing 5.3 — Approach-and-landing accidents
     EUROCONTROL EVAIR Bulletin 27 §6 — RVR-below-mins events
     NTSB AAR-08/03 (Comair 5191 / KLEX) — RVR check & briefing
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}

interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Regime = 'FAA-121' | 'FAA-91-K' | 'EASA-CAT' | 'EASA-NCC' | 'UK-CAP670' | 'TCCA-CAR' | 'CASA-AU' | 'CAAC-PRC' | 'ICAO-A6'
type ApchType = 'CAT-IIIB' | 'CAT-IIIA' | 'CAT-II' | 'CAT-I' | 'LNAV-VNAV' | 'LNAV' | 'RNP-AR' | 'CIRCLING'
type Driver = 'RVR-DEF' | 'VIS-DEF' | 'CLG' | 'EQUIP' | 'OPS-AUTH' | 'GATE' | 'TREND'
type Tier = 'BAN' | 'CRIT' | 'MARGIN' | 'WATCH' | 'CLEAR' | 'OFF'

const REGIMES: Regime[] = ['FAA-121','FAA-91-K','EASA-CAT','EASA-NCC','UK-CAP670','TCCA-CAR','CASA-AU','CAAC-PRC','ICAO-A6']
const APCH_TYPES: ApchType[] = ['CAT-IIIB','CAT-IIIA','CAT-II','CAT-I','LNAV-VNAV','LNAV','RNP-AR','CIRCLING']
const DRIVERS: Driver[] = ['RVR-DEF','VIS-DEF','CLG','EQUIP','OPS-AUTH','GATE','TREND']
const TIERS: Tier[] = ['BAN','CRIT','MARGIN','WATCH','CLEAR','OFF']

const TIER_COLOR: Record<Tier, string> = {
  BAN: '#ef4444', CRIT: '#f43f5e', MARGIN: '#f59e0b',
  WATCH: '#0ea5e9', CLEAR: '#10b981', OFF: '#64748b',
}
const TIER_RANK: Record<Tier, number> = { BAN:0, CRIT:1, MARGIN:2, WATCH:3, CLEAR:4, OFF:5 }
function tierFromScore(s: number): Tier {
  if (s >= 85) return 'BAN'
  if (s >= 65) return 'CRIT'
  if (s >= 45) return 'MARGIN'
  if (s >= 25) return 'WATCH'
  if (s >= 10) return 'CLEAR'
  return 'OFF'
}

const APCH_COLOR: Record<ApchType, string> = {
  'CAT-IIIB':'#0ea5e9', 'CAT-IIIA':'#22d3ee', 'CAT-II':'#a78bfa',
  'CAT-I':'#f59e0b', 'LNAV-VNAV':'#10b981', 'LNAV':'#84cc16',
  'RNP-AR':'#ec4899', 'CIRCLING':'#fb923c',
}

// Per-approach-type minima (RVR in metres / VIS in metres / HAT in feet)
// Sources: ICAO Doc 8168 Vol I §1.4 / FAA AC 120-29A / EASA CS-AWO
const APCH_MIN: Record<ApchType, { rvrM: number; visM: number; hatFt: number; dh: number | null }> = {
  'CAT-IIIB':  { rvrM:  50, visM:  50, hatFt:   0, dh: null },
  'CAT-IIIA':  { rvrM: 175, visM: 175, hatFt: 100, dh:  100 },
  'CAT-II':    { rvrM: 300, visM: 300, hatFt: 100, dh:  100 },
  'CAT-I':     { rvrM: 550, visM: 800, hatFt: 200, dh:  200 },
  'LNAV-VNAV': { rvrM: 900, visM:1600, hatFt: 250, dh:  250 },
  'LNAV':      { rvrM:1200, visM:2000, hatFt: 400, dh:  400 },
  'RNP-AR':    { rvrM: 800, visM:1600, hatFt: 250, dh:  250 },
  'CIRCLING':  { rvrM:1600, visM:2400, hatFt: 600, dh:  600 },
}

const REGIME_NAME: Record<Regime, string> = {
  'FAA-121':   '14 CFR §121.651(c)',
  'FAA-91-K':  '14 CFR §91.175(l)',
  'EASA-CAT':  'Part-CAT.OP.MPA.305',
  'EASA-NCC':  'Part-NCC.OP.110',
  'UK-CAP670': 'CAA CAP 670 SUR §5',
  'TCCA-CAR':  'CARs 602.128/129',
  'CASA-AU':   'Part 91 MOS Ch.7.16',
  'CAAC-PRC':  'CCAR-121.R5 §121.563',
  'ICAO-A6':   'Annex 6 Pt I §4.4.1.3',
}
const REGIME_DESC: Record<Regime, string> = {
  'FAA-121':   'US air carrier — controlling RVR at OM / 1000ft AGL',
  'FAA-91-K':  'US Part 91-K fractional — lower-than-standard credit',
  'EASA-CAT':  'EU commercial — OM/FAP test; PIC discretion at DH only',
  'EASA-NCC':  'EU non-commercial complex — same test, lower ground fit',
  'UK-CAP670': 'UK CAA — RVR observer rules at non-AWS fields',
  'TCCA-CAR':  'Canada — RVR controlling; T-RVR/M-RVR/R-RVR per CAT',
  'CASA-AU':   'Australia — observed vis substitutes for absent RVR',
  'CAAC-PRC':  'China — bilateral OM-gate identical to FAA/EASA',
  'ICAO-A6':   'Global baseline — Annex 6 §4.4.1.3 commencement',
}

const DRIVER_WEIGHT: Record<Driver, number> = {
  'RVR-DEF': 0.30, 'VIS-DEF': 0.18, 'CLG': 0.10,
  'EQUIP':   0.10, 'OPS-AUTH': 0.08, 'GATE': 0.16, 'TREND': 0.08,
}

const DRIVER_DESC: Record<Driver, string> = {
  'RVR-DEF':  'Controlling RVR deficit vs minima (TDZ/MID/RLO).',
  'VIS-DEF':  'General-vis deficit when no RVR sensor (Annex 3 App.3 conv).',
  'CLG':      'Ceiling vs HAT — visual reference expectation at DH/MDA.',
  'EQUIP':    'Ground equipment partial failure raising applicable cat.',
  'OPS-AUTH': 'OpSpec C059/C061/C062/C078 authorisation gap.',
  'GATE':     'Distance to FAF / 1000ft AGL gate (rule binds inside).',
  'TREND':    'RVR / vis trend last ~10min vs SPECI thresholds.',
}

interface ApSlot {
  icao: string; iata: string; name: string; city: string; lat: number; lng: number
  rvrM: number; visM: number; clgFt: number; tempC: number
  trend: 'IMPROVING' | 'STEADY' | 'DETERIORATING' | 'VARIABLE'
  // Per-airport equipment fit modifier (0=full, 1=LLZ-only, 2=NPA-only)
  equipFit: 0 | 1 | 2
}

// Build per-airport WX state deterministically by airport ICAO hash so the
// scene is consistent across tab switches but varied across airports.
function h32(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0) / 4294967295
}
function h32b(s: string, salt: string): number { return h32(s + salt) }

// Catalogue of 56 major hubs known for low-vis ops / where the §121.651(c)
// gate is most often exercised.  Each gets simulated reported RVR/VIS/CLG
// derived deterministically from a hash so the scene is reproducible.
const HUBS: string[] = [
  'EGLL','EGKK','EGCC','EHAM','EDDF','EDDM','EDDL','EDDH','LFPG','LFPO','LSZH','LIRF','LIMC','LEMD','LEBL',
  'EKCH','ENGM','ESSA','EFHK','LOWW','LKPR','EPWA','LHBP',
  'CYYZ','CYUL','CYVR','CYYC',
  'KJFK','KEWR','KLGA','KBOS','KIAD','KDCA','KATL','KMIA','KMCO','KORD','KDFW','KIAH','KDEN','KSFO','KSEA','KLAX','KPHX','KMSP','KCLT','KDTW','KPHL','KSAN','KLAS','KSLC',
  'OMDB','OTHH','OMAA','OEJN','OERK','VHHH','VTBS','WSSS','RJTT','RJAA','RJBB','RKSI','VABB','VIDP','ZBAA','ZSPD','ZGGG','YSSY','YMML','YBBN','FAOR','GMMN','HECA',
]

function buildSlots(): ApSlot[] {
  const out: ApSlot[] = []
  const byI = new Map(AIRPORTS.map(a => [a.i, a]))
  for (const i of HUBS) {
    const a = byI.get(i)
    if (!a) continue
    // Deterministic WX
    const wh = h32(i)
    const wh2 = h32b(i, 'b')
    const wh3 = h32b(i, 'c')
    // Bias airport latitudes near the polar / temperate transition to be more
    // often low-vis (winter fog band) — pure simulation, not a forecast.
    const polarBias = Math.max(0, (Math.abs(a.lat) - 35) / 35) // 0 at equator, 1 at 70deg
    const fogProb = 0.18 + polarBias * 0.42 + wh3 * 0.18  // 0.18..0.78
    let rvrM: number, visM: number, clgFt: number
    if (wh < fogProb) {
      // Low-vis event — distribute below 2000m
      rvrM = Math.round(40 + wh2 * wh2 * 1900)
      visM = Math.round(rvrM * (0.95 + wh3 * 0.4))
      clgFt = Math.round(50 + wh2 * 600)
    } else {
      // Normal/clear
      rvrM = Math.round(2400 + wh2 * 5600)
      visM = Math.round(rvrM * (1.05 + wh3 * 0.6))
      clgFt = Math.round(1500 + wh2 * 6500)
    }
    const tempC = Math.round((20 - Math.abs(a.lat) * 0.45 + wh3 * 12) * 10) / 10
    const tr = wh2
    const trend: ApSlot['trend'] = tr < 0.25 ? 'IMPROVING' : tr < 0.55 ? 'STEADY' : tr < 0.85 ? 'DETERIORATING' : 'VARIABLE'
    const equipFit: 0 | 1 | 2 = (wh3 > 0.92 ? 2 : wh3 > 0.78 ? 1 : 0)
    out.push({
      icao: a.i, iata: a.a, name: a.n || a.i, city: a.m,
      lat: a.lat, lng: a.lon,
      rvrM, visM, clgFt, tempC, trend, equipFit,
    })
  }
  return out
}

// Pick the highest-CAT approach an airframe is likely flying, based on
// equipment-fit class proxy from category code and operator hash.
function airframeMaxCat(f: SFlight): ApchType {
  const t = (f.type || '').toUpperCase()
  const c = f.category || 'A3'
  // Heavy modern WB → CAT-IIIB
  if (/^(B77|B78|A35|A33N|A38)/.test(t)) return 'CAT-IIIB'
  if (/^(B74|B76|A33|A34)/.test(t)) return 'CAT-IIIA'
  if (/^(B73|A32|A31|A21|E19|E29|E17)/.test(t)) return c === 'A3' || c === 'A4' ? 'CAT-IIIA' : 'CAT-II'
  if (/^(CRJ|E14|E13|E50|E55|AT7|DH8)/.test(t)) return 'CAT-II'
  if (/^(BE|C5|C2|PA|TBM|PC|SR2|SR22|M20|GA|DA|DR)/.test(t)) return 'CAT-I'
  // Default by category
  if (c === 'A5') return 'CAT-IIIB'
  if (c === 'A4') return 'CAT-IIIA'
  if (c === 'A3' || c === 'A2') return 'CAT-II'
  return 'CAT-I'
}

function pickRegime(f: SFlight): Regime {
  const op = (f.operator || '').toUpperCase()
  const cs = (f.callsign || f.icao).toUpperCase()
  // Operator name match first
  if (/(AMERICAN|UNITED|DELTA|SOUTHWEST|JETBLUE|ALASKA|HAWAIIAN|SPIRIT|FRONTIER|FEDEX|UPS|ATLAS)/.test(op)) return 'FAA-121'
  if (/(LUFTHANSA|AIR FRANCE|BRITISH|KLM|RYAN|EASYJET|TUI|VUELING|IBERIA|TAP |SAS|FINNAIR|ALITALIA|ITA |WIZZ|EUROWINGS|BREZA|AUSTRIAN|SWISS|BRUSSELS|AEGEAN|TURKISH|PEGASUS)/.test(op)) return 'EASA-CAT'
  if (/(BRITISH|VIRGIN ATLANTIC|JET2|BA |TUI UK)/.test(op)) return 'UK-CAP670'
  if (/(AIR CANADA|WESTJET|PORTER|TRANSAT|JAZZ)/.test(op)) return 'TCCA-CAR'
  if (/(QANTAS|VIRGIN AUSTRALIA|JETSTAR|REX |REGIONAL EXPRESS)/.test(op)) return 'CASA-AU'
  if (/(AIR CHINA|CHINA EASTERN|CHINA SOUTHERN|HAINAN|XIAMEN|JUNEYAO|SPRING|SHENZHEN)/.test(op)) return 'CAAC-PRC'
  // Callsign-prefix heuristics
  if (/^(AAL|UAL|DAL|SWA|JBU|ASA|HAL|NKS|FFT|FDX|UPS|GTI)/.test(cs)) return 'FAA-121'
  if (/^(BAW|VIR|EZY|BEE|TOM|JZA|EXS)/.test(cs)) return 'UK-CAP670'
  if (/^(ACA|WJA|POE|TSC|JZA)/.test(cs)) return 'TCCA-CAR'
  if (/^(QFA|VOZ|JST|QLK|REX)/.test(cs)) return 'CASA-AU'
  if (/^(CCA|CES|CSN|CHH|CXA|DKH|CQH|CSZ)/.test(cs)) return 'CAAC-PRC'
  if (/^(DLH|AFR|KLM|RYR|EZY|TVF|EWG|SWR|AUA|BAW|IBE|TAP|SAS|FIN|WZZ|ETD|UAE|VLG|AEE|THY|PGT)/.test(cs)) return 'EASA-CAT'
  // Light aircraft / private bias
  const j = h32(cs)
  if (j > 0.85) return 'FAA-91-K'
  if (j > 0.55) return 'EASA-CAT'
  return 'ICAO-A6'
}

// ------ Geometry helpers ------
function distNM(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 3440.065 // NM
  const ph1 = (la1 * Math.PI) / 180, ph2 = (la2 * Math.PI) / 180
  const dph = ph2 - ph1, dl = ((lo2 - lo1) * Math.PI) / 180
  const a = Math.sin(dph/2)**2 + Math.cos(ph1)*Math.cos(ph2)*Math.sin(dl/2)**2
  return 2 * R * Math.asin(Math.sqrt(a))
}
function bearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const ph1 = (la1*Math.PI)/180, ph2 = (la2*Math.PI)/180
  const dl = ((lo2-lo1)*Math.PI)/180
  const y = Math.sin(dl)*Math.cos(ph2)
  const x = Math.cos(ph1)*Math.sin(ph2) - Math.sin(ph1)*Math.cos(ph2)*Math.cos(dl)
  return (Math.atan2(y,x) * 180/Math.PI + 360) % 360
}
function angDiff(a: number, b: number): number {
  let d = ((a - b + 540) % 360) - 180
  return Math.abs(d)
}

// Phase classification for approach gating
type Phase = 'GND' | 'TXO' | 'TOF' | 'ICL' | 'ENR' | 'DST' | 'INI-APP' | 'OM-GATE' | 'FNL' | 'LDG'
function classifyPhase(f: SFlight, dToAptNM: number | null, trackToApt: number, agl: number): Phase {
  if (f.ground) return f.velocityKts > 25 ? 'TXO' : 'GND'
  const fl = f.altitudeFt / 100
  if (fl < 15 && f.vertRate > 500) return 'TOF'
  if (fl < 15 && f.vertRate < -200) return 'LDG'
  if (dToAptNM == null || dToAptNM > 50) {
    if (fl < 180 && f.vertRate > 600) return 'ICL'
    if (f.vertRate < -800) return 'DST'
    return 'ENR'
  }
  // Within 50 NM of an airport
  const alignedBeam = angDiff(f.track, trackToApt) < 40
  if (!alignedBeam) {
    if (f.vertRate < -800) return 'DST'
    return 'ENR'
  }
  if (agl < 1100 && dToAptNM < 6) return 'FNL'
  if ((agl < 1300 && dToAptNM < 7) || (agl < 2100 && dToAptNM < 10)) return 'OM-GATE'
  if (agl < 5500 && dToAptNM < 25) return 'INI-APP'
  return 'ENR'
}

interface Assess {
  f: SFlight; phase: Phase
  apt: ApSlot | null; apch: ApchType; regime: Regime
  dNM: number; agl: number
  appliedRvrM: number; appliedVisM: number; appliedHatFt: number
  drivers: Record<Driver, number>
  score: number; tier: Tier
  rationale: string
  weightedMean: number; worst: Driver
}

// Find nearest hub aligned with current track within ~50 NM
function findInboundAirport(f: SFlight, slots: ApSlot[]): { apt: ApSlot; dNM: number; bearing: number } | null {
  let best: { apt: ApSlot; dNM: number; bearing: number } | null = null
  for (const a of slots) {
    const d = distNM(f.lat, f.lng, a.lat, a.lng)
    if (d > 60) continue
    const brg = bearingDeg(f.lat, f.lng, a.lat, a.lng)
    const align = angDiff(f.track, brg)
    if (align > 50) continue
    if (!best || d < best.dNM) best = { apt: a, dNM: d, bearing: brg }
  }
  return best
}

function scoreFlight(f: SFlight, slots: ApSlot[], advMul: number, fieldElevDefault = 100): Assess {
  const inbound = findInboundAirport(f, slots)
  const apt = inbound?.apt || null
  const dNM = inbound?.dNM ?? 999
  const brg = inbound?.bearing ?? f.track
  const aglDefault = fieldElevDefault
  const agl = apt ? Math.max(0, f.altitudeFt - aglDefault) : f.altitudeFt
  const phase = classifyPhase(f, apt ? dNM : null, brg, agl)
  const maxCat = airframeMaxCat(f)
  const regime = pickRegime(f)

  // Pick approach being flown — the most capable the airframe supports,
  // subject to per-airport ground equipment fit downgrade.
  let apch: ApchType = maxCat
  if (apt) {
    if (apt.equipFit === 2) {
      // NPA only
      apch = (maxCat === 'CAT-I' || maxCat === 'CAT-II' || maxCat === 'CAT-IIIA' || maxCat === 'CAT-IIIB') ? 'LNAV-VNAV' : maxCat
    } else if (apt.equipFit === 1) {
      // LLZ-only / LOC-only → CAT-I best
      const o: Record<ApchType, ApchType> = {
        'CAT-IIIB':'CAT-I', 'CAT-IIIA':'CAT-I', 'CAT-II':'CAT-I',
        'CAT-I':'CAT-I', 'LNAV-VNAV':'LNAV-VNAV', 'LNAV':'LNAV',
        'RNP-AR':'RNP-AR', 'CIRCLING':'CIRCLING',
      }
      apch = o[apch]
    }
  }

  const mins = APCH_MIN[apch]

  // ------ Driver scoring [0..100] ------
  const drivers: Record<Driver, number> = { 'RVR-DEF':0, 'VIS-DEF':0, 'CLG':0, 'EQUIP':0, 'OPS-AUTH':0, 'GATE':0, 'TREND':0 }

  if (apt && (phase === 'OM-GATE' || phase === 'FNL' || phase === 'INI-APP' || phase === 'LDG')) {
    // RVR-DEF: deficit % vs minima → 0 if at minima, +100 at 50% below
    const rvrDef = mins.rvrM > 0 ? Math.max(0, (mins.rvrM - apt.rvrM) / mins.rvrM) * 200 : 0
    drivers['RVR-DEF'] = Math.min(100, rvrDef)
    const visDef = mins.visM > 0 ? Math.max(0, (mins.visM - apt.visM) / mins.visM) * 150 : 0
    drivers['VIS-DEF'] = Math.min(100, visDef)
    // CLG vs HAT (advisory under FAA, hard under EASA legacy non-precision)
    const clgDef = mins.hatFt > 0 ? Math.max(0, (mins.hatFt - apt.clgFt) / mins.hatFt) * 80 : 0
    drivers['CLG'] = Math.min(100, clgDef)
    drivers['EQUIP'] = apt.equipFit === 2 ? 38 : apt.equipFit === 1 ? 22 : 6
    // OPS-AUTH: low for FAA-121 (mature), higher for FAA-91-K / private if going to CAT-II/III
    const isLV = apch === 'CAT-II' || apch === 'CAT-IIIA' || apch === 'CAT-IIIB' || apch === 'RNP-AR'
    drivers['OPS-AUTH'] = isLV ? (regime === 'FAA-121' ? 6 : regime === 'EASA-CAT' ? 8 : regime === 'FAA-91-K' ? 28 : 18) : 4
    // GATE: 100 at OM/1000ft, ramping out
    const gateBound = phase === 'OM-GATE' || phase === 'FNL' || phase === 'LDG'
    drivers['GATE'] = gateBound ? 92 : (phase === 'INI-APP' ? 48 : 14)
    // TREND
    const t = apt.trend === 'DETERIORATING' ? 78 : apt.trend === 'VARIABLE' ? 56 : apt.trend === 'STEADY' ? 22 : 8
    drivers['TREND'] = t
  } else {
    // Outside approach phase: lightly populate just GATE = 0 etc.
    drivers['GATE'] = 0
  }

  // ------ Aggregate ------
  const mul = advMul / 100
  for (const d of DRIVERS) drivers[d] = Math.min(100, drivers[d] * mul)
  // Weighted mean of all drivers
  let wm = 0, wsum = 0
  for (const d of DRIVERS) { wm += drivers[d] * DRIVER_WEIGHT[d]; wsum += DRIVER_WEIGHT[d] }
  const weightedMean = wsum > 0 ? wm / wsum : 0
  // Worst driver
  let worst: Driver = 'RVR-DEF'; let bestV = -1
  for (const d of DRIVERS) if (drivers[d] > bestV) { bestV = drivers[d]; worst = d }
  // Composite: max(0.65 * worst, 0.35 * mean) then gate-multiplier
  const composite = Math.max(0.65 * bestV, 0.35 * weightedMean) + 0.35 * weightedMean
  let score = composite
  // Gate distance multiplier
  if (phase === 'OM-GATE' || phase === 'FNL' || phase === 'LDG') score *= 1.0
  else if (phase === 'INI-APP') score *= 0.55
  else score *= 0.05
  score = Math.min(100, Math.max(0, score))

  let tier: Tier = tierFromScore(score)
  if (phase === 'GND' || phase === 'TXO' || phase === 'TOF' || phase === 'ICL' || phase === 'ENR' || phase === 'DST') {
    if (score < 8) tier = 'OFF'
  }

  // Rationale
  const aptStr = apt ? `${apt.iata} (${apt.icao})` : 'no aligned aerodrome'
  const wxStr = apt ? `RVR ${apt.rvrM}m / VIS ${apt.visM}m / CLG ${apt.clgFt}ft` : '—'
  const minStr = `min ${apch} ${mins.rvrM}m / HAT ${mins.hatFt}ft`
  let rationale = ''
  if (tier === 'BAN') rationale = `BAN MANDATORY — ${apch} ${minStr} not met at ${aptStr}; ${wxStr}; ${REGIME_NAME[regime]} prohibits continuation past OM/1000ft.`
  else if (tier === 'CRIT') rationale = `CRITICAL — ${apch} ${minStr} marginal at ${aptStr}; ${wxStr}; expect commander discretion call at DH/MDA under ${REGIME_NAME[regime]}.`
  else if (tier === 'MARGIN') rationale = `MARGIN — within 10% of ${apch} minima at ${aptStr}; ${wxStr}; monitor SPECI thresholds.`
  else if (tier === 'WATCH') rationale = `WATCH — comfortable above ${apch} minima at ${aptStr}; ${wxStr}.`
  else if (tier === 'CLEAR') rationale = `CLEAR — ample margin above ${apch} minima at ${aptStr}; ${wxStr}.`
  else rationale = `Not in approach gate (${phase}); ${REGIME_NAME[regime]} rule not yet binding.`

  return {
    f, phase, apt, apch, regime, dNM, agl,
    appliedRvrM: mins.rvrM, appliedVisM: mins.visM, appliedHatFt: mins.hatFt,
    drivers, score, tier, rationale, weightedMean, worst,
  }
}

const SRC = 'apbn-src'
const LNK = 'apbn-lnk'
const LBL = 'apbn-lbl'
const APT = 'apbn-apt'

export default function ApbnApproachBan({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState<number>(100)
  const [proxNM, setProxNM] = useState<number>(50)
  const [minFL, setMinFL] = useState<number>(0)
  const [maxFL, setMaxFL] = useState<number>(150)
  const [regimeFilter, setRegimeFilter] = useState<'ALL' | Regime>('ALL')
  const [apchFilter, setApchFilter] = useState<'ALL' | ApchType>('ALL')
  const [tierFilter, setTierFilter] = useState<'ALL' | Tier>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'AERODROMES' | 'REGIMES' | 'METHOD'>('AIRCRAFT')
  const [search, setSearch] = useState<string>('')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLnk, setShowLnk] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showApt, setShowApt] = useState(true)

  const slots = useMemo(() => buildSlots(), [])

  const assessments = useMemo<Assess[]>(() => {
    const out: Assess[] = []
    for (const f of flights) {
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue
      const fl = f.altitudeFt / 100
      if (!f.ground && (fl < minFL || fl > maxFL)) continue
      const a = scoreFlight(f, slots, advMul)
      // Apply proximity filter to airport
      if (a.apt && a.dNM > proxNM) {
        // Keep but downgrade — still useful in lists; but suppress map noise
      }
      out.push(a)
    }
    out.sort((a, b) => {
      const r = TIER_RANK[a.tier] - TIER_RANK[b.tier]
      if (r !== 0) return r
      return b.score - a.score
    })
    return out
  }, [flights, slots, advMul, minFL, maxFL, proxNM])

  const filtered = useMemo(() => {
    let xs = assessments
    if (tierFilter !== 'ALL') xs = xs.filter(a => a.tier === tierFilter)
    if (apchFilter !== 'ALL') xs = xs.filter(a => a.apch === apchFilter)
    if (regimeFilter !== 'ALL') xs = xs.filter(a => a.regime === regimeFilter)
    if (search) {
      const s = search.toLowerCase()
      xs = xs.filter(a =>
        (a.f.callsign || a.f.icao).toLowerCase().includes(s) ||
        (a.apt?.iata || '').toLowerCase().includes(s) ||
        (a.apt?.icao || '').toLowerCase().includes(s) ||
        (a.apt?.city || '').toLowerCase().includes(s) ||
        a.apch.toLowerCase().includes(s) ||
        a.regime.toLowerCase().includes(s) ||
        (a.f.operator || '').toLowerCase().includes(s) ||
        (a.f.type || '').toLowerCase().includes(s))
    }
    return xs
  }, [assessments, tierFilter, apchFilter, regimeFilter, search])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { BAN:0, CRIT:0, MARGIN:0, WATCH:0, CLEAR:0, OFF:0 }
    for (const a of assessments) c[a.tier]++
    return c
  }, [assessments])

  const regimeCounts = useMemo(() => {
    const c: Record<Regime, { ac: number; ban: number; mean: number }> = {} as any
    for (const r of REGIMES) c[r] = { ac: 0, ban: 0, mean: 0 }
    const sums: Record<Regime, number> = {} as any
    for (const r of REGIMES) sums[r] = 0
    for (const a of assessments) {
      if (a.tier === 'OFF') continue
      c[a.regime].ac++
      sums[a.regime] += a.score
      if (a.tier === 'BAN' || a.tier === 'CRIT') c[a.regime].ban++
    }
    for (const r of REGIMES) c[r].mean = c[r].ac ? sums[r] / c[r].ac : 0
    return c
  }, [assessments])

  const apchCounts = useMemo(() => {
    const c: Record<ApchType, { ac: number; ban: number }> = {} as any
    for (const k of APCH_TYPES) c[k] = { ac: 0, ban: 0 }
    for (const a of assessments) {
      if (a.tier === 'OFF') continue
      c[a.apch].ac++
      if (a.tier === 'BAN' || a.tier === 'CRIT') c[a.apch].ban++
    }
    return c
  }, [assessments])

  const aptBreakdown = useMemo(() => {
    type Row = { apt: ApSlot; ac: number; ban: number; worstCat?: ApchType }
    const m = new Map<string, Row>()
    for (const a of assessments) {
      if (!a.apt) continue
      if (a.tier === 'OFF') continue
      const r = m.get(a.apt.icao) || { apt: a.apt, ac: 0, ban: 0 }
      r.ac++
      if (a.tier === 'BAN' || a.tier === 'CRIT') {
        r.ban++
        if (!r.worstCat) r.worstCat = a.apch
      }
      m.set(a.apt.icao, r)
    }
    return Array.from(m.values()).sort((a, b) => b.ban - a.ban || b.ac - a.ac)
  }, [assessments])

  const meanScore = assessments.length ? (assessments.reduce((s, a) => s + a.score, 0) / assessments.length) : 0
  const worst = assessments[0]
  const banCrit = counts.BAN + counts.CRIT

  // ------ Map overlay ------
  useEffect(() => {
    const m = map
    if (!m) return
    const features: GeoJSON.Feature[] = []
    const links: GeoJSON.Feature[] = []
    const labels: GeoJSON.Feature[] = []
    const aptFeats: GeoJSON.Feature[] = []
    // Airports — colour by worst tier observed
    if (showApt) {
      const aptWorst = new Map<string, Tier>()
      for (const a of assessments) {
        if (!a.apt) continue
        const cur = aptWorst.get(a.apt.icao)
        if (!cur || TIER_RANK[a.tier] < TIER_RANK[cur]) aptWorst.set(a.apt.icao, a.tier)
      }
      for (const apt of slots) {
        const tier: Tier = aptWorst.get(apt.icao) || (apt.rvrM < 600 ? 'MARGIN' : 'CLEAR')
        const col = TIER_COLOR[tier]
        aptFeats.push({ type:'Feature', properties:{ kind:'apt', color: col, label: apt.iata, rvr: apt.rvrM }, geometry:{ type:'Point', coordinates:[apt.lng, apt.lat] } })
      }
    }
    for (const a of filtered) {
      if (a.tier === 'OFF') continue
      if (a.apt && a.dNM > proxNM) continue
      const col = TIER_COLOR[a.tier]
      if (showHalo) {
        const r = 6 + Math.min(16, a.score * 0.18)
        features.push({ type:'Feature', properties:{ kind:'halo', color: col, radius: r }, geometry:{ type:'Point', coordinates:[a.f.lng, a.f.lat] } })
      }
      if (showPin && (a.tier === 'BAN' || a.tier === 'CRIT' || a.tier === 'MARGIN')) {
        features.push({ type:'Feature', properties:{ kind:'pin', color: col }, geometry:{ type:'Point', coordinates:[a.f.lng, a.f.lat] } })
      }
      if (showLnk && a.apt && (a.tier === 'BAN' || a.tier === 'CRIT')) {
        links.push({
          type:'Feature',
          properties:{ kind:'lnk', color: col, dash: a.tier === 'BAN' ? 'solid' : 'dash' },
          geometry:{ type:'LineString', coordinates:[ [a.f.lng, a.f.lat], [a.apt.lng, a.apt.lat] ] },
        })
      }
      if (showLbl) {
        const cs = a.f.callsign || a.f.icao.toUpperCase()
        const apch = a.apch
        const text = a.apt ? `${cs} ${apch} ${a.tier}` : `${cs} ${a.tier}`
        labels.push({ type:'Feature', properties:{ kind:'lbl', text, color: APCH_COLOR[a.apch] }, geometry:{ type:'Point', coordinates:[a.f.lng, a.f.lat] } })
      }
    }
    try {
      for (const [id, fc] of [[SRC, features], [LNK, links], [LBL, labels], [APT, aptFeats]] as Array<[string, GeoJSON.Feature[]]>) {
        if (!m.getSource(id)) m.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features: fc } as GeoJSON.FeatureCollection })
        else (m.getSource(id) as maplibregl.GeoJSONSource).setData({ type:'FeatureCollection', features: fc } as GeoJSON.FeatureCollection)
      }
      if (!m.getLayer('apbn-apt-ring')) m.addLayer({ id:'apbn-apt-ring', type:'circle', source:APT, paint:{ 'circle-color':'transparent', 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.6, 'circle-radius':9, 'circle-opacity':0.85 } })
      if (!m.getLayer('apbn-apt-dot')) m.addLayer({ id:'apbn-apt-dot', type:'circle', source:APT, paint:{ 'circle-color':['get','color'], 'circle-radius':2.5, 'circle-opacity':0.9 } })
      if (!m.getLayer('apbn-apt-lbl')) m.addLayer({ id:'apbn-apt-lbl', type:'symbol', source:APT, layout:{ 'text-field':['get','label'], 'text-size':9, 'text-offset':[0, 1.2], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a', 'text-halo-width':1.2 } })
      if (!m.getLayer('apbn-link')) m.addLayer({ id:'apbn-link', type:'line', source:LNK, paint:{ 'line-color':['get','color'], 'line-width':1.4, 'line-opacity':0.8, 'line-dasharray':[3, 2] } })
      if (!m.getLayer('apbn-halo')) m.addLayer({ id:'apbn-halo', type:'circle', source:SRC, filter:['==',['get','kind'],'halo'], paint:{ 'circle-color':'transparent', 'circle-stroke-color':['get','color'], 'circle-stroke-width':2, 'circle-radius':['get','radius'], 'circle-opacity':0.8 } })
      if (!m.getLayer('apbn-pin')) m.addLayer({ id:'apbn-pin', type:'circle', source:SRC, filter:['==',['get','kind'],'pin'], paint:{ 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1.2, 'circle-radius':5 } })
      if (!m.getLayer('apbn-lbl')) m.addLayer({ id:'apbn-lbl', type:'symbol', source:LBL, layout:{ 'text-field':['get','text'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a', 'text-halo-width':1.3 } })
    } catch {}
    return () => {
      try {
        for (const id of ['apbn-apt-ring','apbn-apt-dot','apbn-apt-lbl','apbn-link','apbn-halo','apbn-pin','apbn-lbl'])
          if (m.getLayer(id)) m.removeLayer(id)
        for (const id of [SRC, LNK, LBL, APT]) if (m.getSource(id)) m.removeSource(id)
      } catch {}
    }
  }, [map, filtered, assessments, slots, proxNM, showHalo, showPin, showLnk, showLbl, showApt])

  return (
    <div className="absolute top-16 right-4 z-30 w-[500px] max-h-[84vh] flex flex-col rounded-lg border border-slate-700/70 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/70">
        <div className="flex items-center gap-2">
          <span className="text-sky-400 font-mono text-xs tracking-widest">APBN</span>
          <span className="text-[10px] text-slate-500">APPROACH-BAN / CONTINUATION RULE · §121.651(c)</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm px-1" aria-label="Close">✕</button>
      </div>

      {/* Tier strip */}
      <div className="grid grid-cols-7 gap-px bg-slate-800/70 border-b border-slate-700/70 text-[10px] font-mono">
        {TIERS.map(t => {
          const active = tierFilter === t
          return (
            <button key={t}
              onClick={() => setTierFilter(active ? 'ALL' : t)}
              className={`px-1 py-1.5 flex flex-col items-center ${active ? 'bg-sky-500/15 ring-1 ring-sky-500/40' : 'bg-slate-900 hover:bg-slate-800'}`}>
              <span style={{ color: TIER_COLOR[t] }} className="font-semibold">{counts[t]}</span>
              <span className="text-[9px] text-slate-500 mt-0.5">{t}</span>
            </button>
          )
        })}
        <button
          onClick={() => setTierFilter('ALL')}
          className={`px-1 py-1.5 flex flex-col items-center ${tierFilter === 'ALL' ? 'bg-sky-500/15 ring-1 ring-sky-500/40' : 'bg-slate-900 hover:bg-slate-800'}`}>
          <span className="text-slate-200 font-semibold">{assessments.length}</span>
          <span className="text-[9px] text-slate-500 mt-0.5">ALL</span>
        </button>
      </div>

      {/* Summary cells */}
      <div className="grid grid-cols-4 gap-px bg-slate-800/70 border-b border-slate-700/70 text-[10px] font-mono">
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">Mean</div>
          <div className="text-slate-100">{meanScore.toFixed(1)}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-slate-100 truncate">{worst ? (worst.f.callsign || worst.f.icao.toUpperCase()) : '—'}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">Ban+Crit</div>
          <div style={{ color: TIER_COLOR.BAN }}>{banCrit}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">LV-Fields</div>
          <div className="text-slate-100">{slots.filter(s => s.rvrM < 600).length}</div>
        </div>
      </div>

      {/* Sliders */}
      <div className="px-3 py-2 border-b border-slate-700/70 space-y-1.5">
        {([
          ['ADV-MUL', advMul, setAdvMul, 50, 200, '%'],
          ['PROX-NM', proxNM, setProxNM, 10, 120, 'NM'],
          ['MIN-FL', minFL, setMinFL, 0, 200, ''],
          ['MAX-FL', maxFL, setMaxFL, 10, 450, ''],
        ] as Array<[string, number, (n:number)=>void, number, number, string]>).map(([lbl, v, set, lo, hi, u]) => (
          <div key={lbl} className="flex items-center gap-2">
            <span className="text-[9px] text-slate-500 font-mono w-14">{lbl}</span>
            <input type="range" min={lo} max={hi} value={v} onChange={e => set(Number(e.target.value))} className="flex-1 accent-sky-500" />
            <span className="text-[10px] text-slate-300 font-mono w-14 text-right">{v}{u}</span>
          </div>
        ))}
      </div>

      {/* Approach filter chips */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center flex-wrap gap-1">
        <button onClick={() => setApchFilter('ALL')}
          className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${apchFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-400'}`}>ALL</button>
        {APCH_TYPES.map(c => {
          const active = apchFilter === c
          return (
            <button key={c} onClick={() => setApchFilter(active ? 'ALL' : c)}
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${active ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}>
              <span style={{ color: APCH_COLOR[c] }}>●</span> {c}
            </button>
          )
        })}
      </div>

      {/* Regime filter chips */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center flex-wrap gap-1">
        <button onClick={() => setRegimeFilter('ALL')}
          className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${regimeFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-400'}`}>ALL</button>
        {REGIMES.map(r => {
          const active = regimeFilter === r
          return (
            <button key={r} onClick={() => setRegimeFilter(active ? 'ALL' : r)}
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${active ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}
              title={REGIME_NAME[r]}>
              {r}
            </button>
          )
        })}
      </div>

      {/* Toggles + search */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center gap-1.5 flex-wrap">
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LNK',showLnk,setShowLnk],['LBL',showLbl,setShowLbl],['APT',showApt,setShowApt]] as Array<[string, boolean, (v:boolean)=>void]>).map(([n,v,s]) => (
          <button key={n} onClick={() => s(!v)} className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${v ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-500'}`}>{n}</button>
        ))}
        <div className="flex-1" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search cs/apch/apt"
          className="w-44 text-[11px] font-mono bg-slate-950/70 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 placeholder-slate-600 outline-none focus:border-sky-500/60" />
      </div>

      {/* Tabs */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center gap-1.5">
        {(['AIRCRAFT','AERODROMES','REGIMES','METHOD'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${tab === t ? 'bg-sky-500/15 ring-1 ring-sky-500/40 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/70">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-[11px] text-slate-500">No flights match filters.</div>}
            {filtered.slice(0, 250).map(a => {
              const col = TIER_COLOR[a.tier]
              const aCol = APCH_COLOR[a.apch]
              return (
                <button key={a.f.icao}
                  onClick={() => onFly(a.f.icao)}
                  className="w-full text-left px-2 py-1.5 hover:bg-slate-800/40">
                  <div className="flex items-stretch gap-1.5">
                    <div className="w-0.5 self-stretch rounded" style={{ background: col }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-mono">
                        <span className="text-slate-100 font-semibold">{a.f.callsign || a.f.icao.toUpperCase()}</span>
                        <span className="text-slate-500">{a.f.type || '—'}</span>
                        <span className="text-[9px] px-1 py-0 rounded" style={{ background: aCol + '25', color: aCol }}>{a.apch}</span>
                        <span className="text-[9px] px-1 py-0 rounded text-slate-300 bg-slate-800">{a.phase}</span>
                        <span className="text-[9px] px-1 py-0 rounded ml-auto" style={{ background: col + '25', color: col }}>{a.tier}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-400">
                        <span>FL{String(Math.round(a.f.altitudeFt / 100)).padStart(3,'0')}</span>
                        <span>{Math.round(a.f.velocityKts)}kt</span>
                        <span style={{ color: a.f.vertRate > 200 ? '#10b981' : a.f.vertRate < -200 ? '#f59e0b' : '#94a3b8' }}>{a.f.vertRate > 0 ? '↑' : a.f.vertRate < 0 ? '↓' : '→'}{Math.abs(Math.round(a.f.vertRate))}fpm</span>
                        <span className="text-slate-500 truncate">{a.f.operator || ''}</span>
                      </div>
                      {a.apt && (
                        <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-400">
                          <span className="text-slate-300">{a.apt.iata}</span>
                          <span>{a.dNM.toFixed(1)}NM</span>
                          <span>RVR {a.apt.rvrM}m</span>
                          <span>vs min {a.appliedRvrM}m</span>
                          <span className="text-slate-500">{a.apt.trend}</span>
                          <span className="text-slate-500 ml-auto">{REGIME_NAME[a.regime]}</span>
                        </div>
                      )}
                      <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden">
                        <div className="h-full" style={{ width: `${Math.min(100, a.score)}%`, background: col }} />
                      </div>
                      <div className="grid grid-cols-7 gap-0.5 mt-1 text-[9px] font-mono">
                        {DRIVERS.map(k => {
                          const s = a.drivers[k]
                          const muted = s < 6
                          return (
                            <div key={k} className="bg-slate-950/60 rounded px-1 py-0.5 flex flex-col items-center" title={DRIVER_DESC[k]}>
                              <span className={muted ? 'text-slate-700' : 'text-slate-300'}>{k.replace('-DEF','').replace('OPS-AUTH','OPS').replace('TREND','TRD')}</span>
                              <span className={muted ? 'text-slate-700' : 'text-slate-300'}>{Math.round(s)}</span>
                            </div>
                          )
                        })}
                      </div>
                      <div className="mt-1 text-[10px] text-slate-400 leading-snug">{a.rationale}</div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {tab === 'AERODROMES' && (
          <div className="divide-y divide-slate-800/70">
            {aptBreakdown.length === 0 && <div className="px-3 py-6 text-center text-[11px] text-slate-500">No inbound aerodromes with active assessments.</div>}
            {aptBreakdown.map(r => {
              const apt = r.apt
              const wxTier: Tier = apt.rvrM < 80 ? 'BAN' : apt.rvrM < 200 ? 'CRIT' : apt.rvrM < 600 ? 'MARGIN' : apt.rvrM < 2400 ? 'WATCH' : 'CLEAR'
              const col = TIER_COLOR[wxTier]
              return (
                <div key={apt.icao} className="px-2 py-1.5">
                  <div className="flex items-stretch gap-1.5">
                    <div className="w-0.5 self-stretch rounded" style={{ background: col }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-mono">
                        <span className="text-slate-100 font-semibold">{apt.iata}</span>
                        <span className="text-slate-500">{apt.icao}</span>
                        <span className="text-slate-300 truncate">{apt.city}</span>
                        <span className="text-[9px] px-1 py-0 rounded ml-auto" style={{ background: col + '25', color: col }}>{wxTier}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-400">
                        <span>RVR <span className="text-slate-200">{apt.rvrM}m</span></span>
                        <span>VIS {apt.visM}m</span>
                        <span>CLG {apt.clgFt}ft</span>
                        <span>{apt.tempC}°C</span>
                        <span className="text-slate-500">{apt.trend}</span>
                        <span className="text-slate-500 ml-auto">EQ-{['FULL','LLZ','NPA'][apt.equipFit]}</span>
                      </div>
                      <div className="mt-0.5 text-[10px] font-mono text-slate-400">
                        <span className="text-slate-500">inbound </span>
                        <span className="text-slate-300">{r.ac}</span>
                        {r.ban > 0 && (<><span className="text-slate-500"> · ban+crit </span><span style={{ color: TIER_COLOR.BAN }}>{r.ban}</span></>)}
                        {r.worstCat && (<><span className="text-slate-500"> · worst </span><span style={{ color: APCH_COLOR[r.worstCat] }}>{r.worstCat}</span></>)}
                      </div>
                      <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden">
                        <div className="h-full" style={{ width: `${Math.min(100, Math.max(0, 100 - apt.rvrM / 40))}%`, background: col }} />
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'REGIMES' && (
          <div className="divide-y divide-slate-800/70">
            {REGIMES.map(r => {
              const info = regimeCounts[r]
              const tier = tierFromScore(info.mean)
              const col = TIER_COLOR[tier]
              return (
                <div key={r} className="px-2 py-1.5">
                  <div className="flex items-stretch gap-1.5">
                    <div className="w-0.5 self-stretch rounded" style={{ background: col }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-mono">
                        <span className="text-slate-100 font-semibold">{r}</span>
                        <span className="text-slate-300 truncate">{REGIME_DESC[r]}</span>
                        <span className="text-[9px] px-1 py-0 rounded ml-auto" style={{ background: col + '25', color: col }}>{info.ac} ac</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-400">
                        <span>mean {info.mean.toFixed(1)}</span>
                        {info.ban > 0 && <span style={{ color: TIER_COLOR.BAN }}>· {info.ban} ban/crit</span>}
                        <span className="ml-auto text-slate-500 italic truncate">{REGIME_NAME[r]}</span>
                      </div>
                      <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden">
                        <div className="h-full" style={{ width: `${Math.min(100, info.mean)}%`, background: col }} />
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
            <div className="px-2 py-2 mt-1">
              <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">APPROACH-TYPE MINIMA</div>
              <div className="grid grid-cols-2 gap-1">
                {APCH_TYPES.map(c => {
                  const info = apchCounts[c]
                  const mins = APCH_MIN[c]
                  return (
                    <div key={c} className="bg-slate-950/60 rounded px-1.5 py-1 flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: APCH_COLOR[c] }} />
                      <span className="text-[10px] font-mono text-slate-200">{c}</span>
                      <span className="text-[9px] text-slate-500 ml-auto font-mono">RVR {mins.rvrM}m</span>
                      <span className="text-[9px] text-slate-300 font-mono">{info.ac}ac</span>
                      {info.ban > 0 && <span className="text-[9px] font-mono" style={{ color: TIER_COLOR.BAN }}>{info.ban}!</span>}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {tab === 'METHOD' && (
          <div className="px-3 py-2 text-[11px] text-slate-300 leading-snug space-y-2">
            <p>
              <span className="text-slate-100 font-semibold">APBN — Approach-Ban / Approach-Continuation Rule.</span>
              {' '}Per-airframe live evaluator of the regulatory STOP-GATE at the OM / FAF / 1000ft AGL crossing.
              For each inbound flight, the monitor identifies the aligned aerodrome within {proxNM} NM,
              the approach procedure the airframe is most likely flying (based on class + airport ground-fit),
              the applicable regulatory regime (per operator), and tests reported RVR / VIS / ceiling against
              the per-approach minima table in ICAO Doc 8168 PANS-OPS Vol I §1.4 / FAA AC 120-29A / EASA CS-AWO.
            </p>
            <p>
              <span className="text-slate-100 font-semibold">Driver scoring [0..100]:</span>
            </p>
            <ul className="text-[10px] font-mono space-y-0.5 ml-2 text-slate-400">
              {DRIVERS.map(d => (
                <li key={d}><span className="text-slate-200">{d}</span> · <span className="text-slate-500">w={Math.round(DRIVER_WEIGHT[d]*100)}%</span> · {DRIVER_DESC[d]}</li>
              ))}
            </ul>
            <p>
              <span className="text-slate-100 font-semibold">Composite</span>{' = '}
              <span className="font-mono">max(0.65·worst, 0.35·mean) + 0.35·mean</span>, then gated by approach-phase
              multiplier ({'OM-GATE/FNL/LDG = 1.0; INI-APP = 0.55; otherwise 0.05'}).
            </p>
            <p>
              <span className="text-slate-100 font-semibold">Tiers (Doc 9859 ed.4 risk-tolerability matrix):</span>
              {' '}BAN ≥ 85 · CRIT ≥ 65 · MARGIN ≥ 45 · WATCH ≥ 25 · CLEAR ≥ 10 · OFF.
            </p>
            <p className="text-slate-400">
              Regimes: nine jurisdictions are catalogued; the operator is matched by callsign / operator string
              with fallback to ICAO Annex 6 Pt I §4.4.1.3 baseline.  Aerodrome WX is deterministic-by-hash sim
              data, not METAR — for tuning visualisation, not operational use.
            </p>
            <p className="text-slate-400">
              <span className="text-slate-200">Distinct from</span> APCH-CAT (pre-approach equipment eligibility),
              APR-MINS (static DA/MDA lookup), CDFA/VDP (vertical-path geometry), STABLE-APPROACH (energy/config
              gate), GASA (active GA event), LVTO (departure side), MA-OEI (OEI net-climb capability).
            </p>
            <p className="text-slate-500 italic">
              References: 14 CFR §121.651(a)(b)(c) · 14 CFR §91.175 §91.189 · EU 965/2012 Part-CAT.OP.MPA.300/305/310
              · AMC1 CAT.OP.MPA.305 · ICAO Annex 6 Pt I §4.4.1.3 · ICAO Annex 3 App.3 §4 (RVR→VIS conv) · ICAO Doc 9365
              ed.3 AWO · ICAO Doc 8168 Vol I §1.4 · FAA Order 8400.13D · FAA AC 120-28D / 120-29A / 90-106A · CAA CAP 670
              SUR §5 · TCCA CARs 602.128/129 · CASA Part 91 MOS Ch.7.16 · CCAR-121.R5 §121.563 · IATA STEADES 2024 §6
              · FSF ALAR Briefing 5.3 · EUROCONTROL EVAIR Bulletin 27 §6 · NTSB AAR-08/03 (Comair 5191 KLEX).
            </p>
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-700/70 text-[9px] text-slate-500 leading-snug">
        §121.651(c) / Part-CAT.OP.MPA.305 / Annex 6 Pt I §4.4.1.3 · Continuation rule at OM / FAP / 1000ft AGL · WX sim by hash, not METAR · Planner-side visualisation, not a certified operational tool.
      </div>
    </div>
  )
}
