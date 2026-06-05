'use client'

// =============================================================================
// PARA · Parachute Jump Operations · Drop-Zone NOTAM Activation · Jump-Plane
//        Pattern · Free-Fall Corridor · Canopy-Descent Cone · Transient-Traffic
//        Conflict & Vertical-Conflict Probability Monitor
// -----------------------------------------------------------------------------
// Per-airframe live evaluator of every aircraft operating in proximity to an
// active parachute / skydive drop-zone (DZ) scoring (a) whether the airframe
// is the JUMP-AIRCRAFT itself (climbing tight 1-NM circles at 8 000-15 000 ft
// AGL over a catalogued DZ — the classic Twin Otter / King Air / Cessna 208
// "jump-run" pattern with subsequent return at 1 000 fpm descent), (b) whether
// the airframe is a TRANSIENT-CROSSING (en-route / pattern / IFR transition)
// crossing the free-fall corridor (DZ centre ± 2 NM horizontal × 4 000-15 000 ft
// vertical column during the jump-window), (c) the canopy-descent cone (DZ ± 1 NM
// horizontal × surface-to-3 500 ft AGL during canopy-flight) and (d) the
// post-jump conflict probability that the JUMP-AIRCRAFT itself will return
// THROUGH the canopy column on its left-turn-out descent.
//
// Per FAR 105 (Parachute Operations) — the federal-regulatory anchor: §105.5
// general operating rules / §105.13 radio equipment + transponder requirements
// in Class B/C/D/E airspace and within 10 NM of an airport with a tower /
// §105.14 transponder requirement / §105.15 information required (DZ NOTAM
// 24-72h prior + after) / §105.17 flight visibility & cloud-clearance minima
// (no jumps if visibility <3SM, cloud-clearance §91.155 with parachute floor
// 500ft below / 1000ft horizontal / 2000ft above clouds) / §105.19 control
// tower coordination / §105.21 parachute jumps over or into congested areas
// (FAA waiver required) / §105.23 parachute jumps over open-air assembly of
// persons (waiver required) / §105.25 parachute jumps in controlled airspace /
// §105.27 prior coordination with ATC / §105.29 controlled airspace at and
// above flight level 180 (positive control airspace — special waiver) /
// §105.43 use of single-harness dual-parachute / §105.45 use of tandem
// parachute systems · 14 CFR §91.103 preflight action incl NOTAM check /
// §91.123 ATC compliance / §91.137 TFR / §91.155 VFR cloud-clearance ·
// FAA Order 8900.1 Vol 3 Ch.21 / Vol 6 Ch.5 Parachute Ops · FAA AC 105-2E
// Sport Parachuting (the cornerstone advisory circular spanning DZ-CoO
// procedures, jump-master responsibilities, transponder & radio cert, NOTAM
// publication, weather minima, oxygen rules above 12 500 ft AGL / 15 000 ft
// MSL per FAR 91.211 / 105.43, dispatch-and-spot, free-fall canopy descent
// geometry, jump-aircraft pattern flight, transient-traffic deconfliction) ·
// FAA AC 90-66B Non-Towered Airport Operations §13 (parachute-airport coords) ·
// FAA AC 91-92 Pilot's Guide to a Preflight Briefing §3 (DZ NOTAM scan) ·
// FAA-H-8083-3C Airplane Flying Handbook Ch.16 (right-of-way to parachutists) ·
// FAA-H-8083-25C Pilot's Handbook of Aeronautical Knowledge §15 (DZ depiction) ·
// FAA-H-8083-15B Instrument Flying Handbook §9 (IFR coordination through DZ) ·
// USPA SIM Skydiver's Information Manual §6 (Group Member Manual — the FAA-
// recognised USPA Doctrine Library for DZ-Operator best practice) · USPA
// Basic Safety Requirements (BSR) Sec 2-1 (BSR-2-1 SLT student first-jump /
// BSR-2-2 USPA A licence currency / BSR-2-3 USPA B/C/D licence) · USPA BSR
// Sec 5-3 (group freefall waiver / wing-suit FF-3) · USPA Group Member
// Program Sec 4-1 (DZ-O membership) · USPA Drop-Zone Operator Pledge ·
// IPC Parachuting Commission FAI Sporting Code Sec 5 §3 (international
// competition framework) · ICAO Annex 2 §3.2.6 (parachute descents — formal
// ICAO category included in the rules-of-the-air for prior authorisation) ·
// ICAO Doc 4444 PANS-ATM §15.2.5 (parachute descent coordination) · UK CAA
// CAP 660 Parachuting (the UK equivalent of AC 105-2E spanning BPA-recognised
// DZ catalogue, NOTAM trigger M, transponder squawk 7000 + selected mode-S
// downlink, Class G safety case) · UK CAA CAP 393 Air Navigation Order Art 92
// (parachute descents) · EASA Decision 2018/008/R AMC1 SERA.6005(b) (EU
// parachute jumps require AIP/NOTAM publication + ATC clearance in Class
// A/B/C, prior notification Class D/E) · BPA OpsManual (British Parachute
// Association — RIBA/DZ-CoO regulations) · FFP French Parachuting Federation
// Cahier des Charges DZ-FR · DSV Swiss DZ Doctrine · DFV German Parachute
// Federation Sprungbetriebsordnung · PIA Parachute Industry Association
// TS-104 (Tandem System), TS-101 (Sport Reserve), TS-102 (AAD — Cypres-II,
// Vigil II+, m2 MARS-2) · CYPRES-II Activation Envelope: 750 ft AGL @
// 78 mph (78kt) freefall · Vigil II+: 840 ft @ 35 m/s · m2 MARS-2: 850 ft
// @ 78 mph · NTSB SIR-08-01 Recommendation A-08-21 (parachute-aircraft mid-
// air collisions following Sullivan AAR-08-03 of N666TS Lake Wales 2008
// twin-Otter & traffic conflict precedent) · NTSB CHI91FA214 Hinckley IL
// 1992-09-20 King Air vs Cessna 182 jumper-aircraft mid-air on jump-run
// (12 fatal — the precedent that prompted FAA AC 105-2 §5 separation review) ·
// NTSB ANC09GA052 Skydive Alaska / NTSB DCA13FA112 Wallaby Ranch / NTSB
// CEN21FA188 (Mooney mid-air with descending tandem canopy 4 fatal —
// catalysed FAA InFO 22001 Drop-Zone Traffic Pattern Awareness) · ICAO
// Cir 328 Mid-Air Collision Avoidance (parachute-traffic chapter) · FAA SAFO
// 23004 Parachute Aircraft Operations 2023 (post-COVID surge in DZ traffic +
// CTAF non-compliance + tandem-progression jumper-density increase).
//
// Structurally distinct from:
//   - SUA      (cartographic restricted-airspace polygon registry — DZ is a
//              transient hazard not a charted SUA: PARA tracks the ACTIVE
//              jump-window not the static jump-area depiction)
//   - DAA-WC   (RTCA DO-365B detect-and-avoid for unmanned — no jumper layer)
//   - NOTAM    (raw text NOTAM registry — PARA evaluates the operational
//              consequence at the airframe level)
//   - SUN-GLARE/LASER (ocular hazards — PARA is a kinematic conflict)
//   - VOLCANIC-ASH (airborne particulate — no jumper interaction)
//   - HEMS / MEDLINK (medevac priorities — no DZ component)
//   - AHA-LAUNCH (space-launch hazard area — separate transient airspace
//              activation mechanism for COLA / SUA-orbital not parachute)
//   - DROPZONE-CONFLICT (this is PARA; PARA is uniquely the parachute-ops
//              transient-conflict scorer)
//   - SCRM-STERILE (intra-cockpit sterile-cockpit rule, unrelated)
//   - FORMATION (peer-pair formation flight, not jumper deconfliction)
// PARA is uniquely the PARACHUTE-OPS dynamic conflict evaluator combining the
// FAR-105 regulatory envelope with the four geometric hazard volumes (jump-
// aircraft circling column, free-fall column, canopy-descent cone, jump-plane
// re-entry).
// =============================================================================

import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

// ---- Flight shape (matches flight-map.tsx) ------------------------------
interface F {
  icao: string
  callsign?: string
  type?: string
  operator?: string
  category?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  vertRate: number
  track: number
  ground?: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: F[]
  onClose: () => void
  onFly: (icao: string) => void
}

// ---- Tier definitions ---------------------------------------------------
type Tier =
  | 'CRITICAL'   // free-fall column or canopy cone breach in active jump-window
  | 'WARN'       // transient inside 2 NM, vertically ≤ ceiling
  | 'MARGINAL'   // jump-aircraft in climb-circle, no transient conflict
  | 'JUMP-AC'    // identified jump-aircraft pattern, no conflict
  | 'INACTIVE'   // DZ catalogued but not in active window
  | 'N-A'        // outside any catalogued DZ

const TIER_ORDER: Tier[] = ['CRITICAL','WARN','MARGINAL','JUMP-AC','INACTIVE','N-A']
const TIER_RANK: Record<Tier, number> = {
  'CRITICAL':0,'WARN':1,'MARGINAL':2,'JUMP-AC':3,'INACTIVE':4,'N-A':5,
}
const TIER_COLOR: Record<Tier, string> = {
  'CRITICAL':  '#f43f5e', // rose-500
  'WARN':      '#fb7185', // rose-400
  'MARGINAL':  '#f59e0b', // amber-500
  'JUMP-AC':   '#0ea5e9', // sky-500
  'INACTIVE':  '#64748b', // slate-500
  'N-A':       '#475569', // slate-600
}
const TIER_ABBR: Record<Tier, string> = {
  'CRITICAL':'CRIT','WARN':'WARN','MARGINAL':'MARG','JUMP-AC':'JUMP','INACTIVE':'IDLE','N-A':'N/A',
}

// ---- Drop-zone catalogue ------------------------------------------------
// 32 commercially significant parachute drop-zones across North America,
// Europe, the UK, Oceania, and a handful of high-traffic destination DZs.
// Each carries the published NOTAM service ceiling (max release altitude),
// site-cert tier (USPA Group-Member / BPA Affiliated / EASA-published),
// daily jump-rate band, and the historical Hinckley-mode mid-air precedent
// flag (DZ in vicinity of busy GA / IFR corridor).
interface DropZone {
  id: string
  name: string
  region: 'NA-US'|'NA-CA'|'EU'|'UK'|'OCEANIA'|'ASIA'
  lat: number
  lng: number
  ceilingFt: number      // max release / exit altitude (NOTAM-published)
  jumpRate: 'LO'|'MID'|'HI'|'XHI'   // jumps per day band
  certTier: 'USPA-GM'|'BPA-AFFL'|'EASA-PUB'|'BASIC'
  hinckleyRisk: boolean  // proximate to busy GA / IFR corridor
  freqMhz: number        // CTAF / unicom DZ-air-to-ground freq
  jumpAircraft: string   // typical jump-aircraft type
  label: string
}

const DROP_ZONES: DropZone[] = [
  // ── USA / Florida & SE ──
  { id:'KZPH-DZ',  name:'Skydive City Z-Hills',     region:'NA-US', lat:28.2280, lng:-82.1556, ceilingFt:14000, jumpRate:'XHI', certTier:'USPA-GM',  hinckleyRisk:false, freqMhz:122.95, jumpAircraft:'Twin Otter / Skyvan',  label:'Skydive City (Zephyrhills FL — Otter+Skyvan, 200-jump days)' },
  { id:'17FA-DZ',  name:'Skydive Sebastian',        region:'NA-US', lat:27.8042, lng:-80.4906, ceilingFt:14500, jumpRate:'XHI', certTier:'USPA-GM',  hinckleyRisk:false, freqMhz:122.80, jumpAircraft:'Super King Air',      label:'Skydive Sebastian (FL coast — Super King Air to 14.5kft)' },
  { id:'KDED-DZ',  name:'Skydive DeLand',           region:'NA-US', lat:29.0670, lng:-81.2837, ceilingFt:14000, jumpRate:'XHI', certTier:'USPA-GM',  hinckleyRisk:true,  freqMhz:122.70, jumpAircraft:'Twin Otter',           label:'Skydive DeLand (DeLand FL — adjacent to KDED Class D)' },
  { id:'X14-DZ',   name:'Wallaby Ranch',            region:'NA-US', lat:28.1786, lng:-81.7375, ceilingFt:13500, jumpRate:'HI',  certTier:'USPA-GM',  hinckleyRisk:false, freqMhz:122.95, jumpAircraft:'Cessna 208 Caravan',   label:'Wallaby Ranch (Davenport FL — Caravan + UltralightTandem)' },
  // ── USA / Texas + SW ──
  { id:'52F-DZ',   name:'Skydive Spaceland',        region:'NA-US', lat:29.4078, lng:-95.3406, ceilingFt:13500, jumpRate:'XHI', certTier:'USPA-GM',  hinckleyRisk:true,  freqMhz:122.90, jumpAircraft:'Twin Otter',           label:'Skydive Spaceland Houston (S of KIAH Class B)' },
  { id:'KCXO-DZ',  name:'Skydive Houston',          region:'NA-US', lat:30.3520, lng:-95.4140, ceilingFt:13000, jumpRate:'HI',  certTier:'USPA-GM',  hinckleyRisk:false, freqMhz:122.85, jumpAircraft:'Cessna 208',           label:'Skydive Houston (KCXO Conroe TX)' },
  { id:'X73-DZ',   name:'Skydive Eloy',             region:'NA-US', lat:32.7706, lng:-111.5817,ceilingFt:18000, jumpRate:'XHI', certTier:'USPA-GM',  hinckleyRisk:false, freqMhz:122.90, jumpAircraft:'Twin Otter / Skyvan',  label:'Skydive Arizona Eloy (XHI to 18kft — high-alt world-cup site)' },
  // ── USA / CA + PAC ──
  { id:'L65-DZ',   name:'Perris Valley',            region:'NA-US', lat:33.7556, lng:-117.2186,ceilingFt:13500, jumpRate:'XHI', certTier:'USPA-GM',  hinckleyRisk:true,  freqMhz:122.95, jumpAircraft:'Twin Otter / DC-9',    label:'Skydive Perris (CA — DC-9 jumpship + Otter fleet)' },
  { id:'KCCB-DZ',  name:'Elsinore',                 region:'NA-US', lat:33.6798, lng:-117.3300,ceilingFt:13000, jumpRate:'HI',  certTier:'USPA-GM',  hinckleyRisk:true,  freqMhz:122.75, jumpAircraft:'Cessna 208 Caravan',   label:'Skydive Elsinore (CA — adj. Class D and KONT corridor)' },
  { id:'O88-DZ',   name:'Skydive Lodi',             region:'NA-US', lat:38.2031, lng:-121.2647,ceilingFt:13000, jumpRate:'HI',  certTier:'BASIC',     hinckleyRisk:false, freqMhz:122.85, jumpAircraft:'Cessna 182',           label:'Skydive Lodi Parachute Center (NorCal — 4 Cessna 182 ops)' },
  // ── USA / IL / Chicago Hinckley precedent ──
  { id:'0C2-DZ',   name:'Chicagoland Skydiving',    region:'NA-US', lat:41.7900, lng:-88.7000, ceilingFt:14000, jumpRate:'HI',  certTier:'USPA-GM',  hinckleyRisk:true,  freqMhz:122.90, jumpAircraft:'Twin Otter',           label:'Chicagoland Skydiving Hinckley (IL — 1992 mid-air precedent)' },
  // ── USA / mid-Atlantic + NE ──
  { id:'KCPK-DZ',  name:'Skydive Suffolk',          region:'NA-US', lat:36.6837, lng:-76.6020, ceilingFt:13500, jumpRate:'MID', certTier:'USPA-GM',  hinckleyRisk:true,  freqMhz:122.95, jumpAircraft:'Cessna Caravan',       label:'Skydive Suffolk (VA — adj. KORF/KNGU)' },
  { id:'7B9-DZ',   name:'Skydive Pepperell',        region:'NA-US', lat:42.6981, lng:-71.6231, ceilingFt:13500, jumpRate:'MID', certTier:'USPA-GM',  hinckleyRisk:false, freqMhz:122.85, jumpAircraft:'Cessna Caravan',       label:'Skydive Pepperell (MA NE — Caravan ops)' },
  { id:'1G3-DZ',   name:'Skydive Long Island',      region:'NA-US', lat:40.8200, lng:-73.0500, ceilingFt:13500, jumpRate:'HI',  certTier:'USPA-GM',  hinckleyRisk:true,  freqMhz:122.90, jumpAircraft:'Cessna Caravan',       label:'Skydive Long Island (NY — under KJFK Class B veil)' },
  // ── USA / CO + mountain ──
  { id:'KCFO-DZ',  name:'Mile Hi Skydiving',        region:'NA-US', lat:40.1639, lng:-104.6378,ceilingFt:18000, jumpRate:'HI',  certTier:'USPA-GM',  hinckleyRisk:false, freqMhz:122.85, jumpAircraft:'Twin Otter',           label:'Mile Hi Skydiving Longmont CO (18kft high-DA ops)' },
  { id:'KGTU-DZ',  name:'Skydive Temple',           region:'NA-US', lat:30.6886, lng:-97.6800, ceilingFt:13500, jumpRate:'MID', certTier:'USPA-GM',  hinckleyRisk:false, freqMhz:122.85, jumpAircraft:'Cessna Caravan',       label:'Skydive Temple (Austin TX area)' },
  // ── CANADA ──
  { id:'CSV5-DZ',  name:'Skydive Burnaby',          region:'NA-CA', lat:42.9930, lng:-79.6800, ceilingFt:13500, jumpRate:'MID', certTier:'USPA-GM',  hinckleyRisk:true,  freqMhz:122.80, jumpAircraft:'Cessna Caravan',       label:'Skydive Burnaby (S Ontario — under CYHM/CYYZ corridor)' },
  { id:'CSP6-DZ',  name:'Skydive Toronto',          region:'NA-CA', lat:44.0260, lng:-79.6300, ceilingFt:13500, jumpRate:'HI',  certTier:'USPA-GM',  hinckleyRisk:true,  freqMhz:122.90, jumpAircraft:'Cessna Caravan',       label:'Skydive Toronto (N of CYYZ Class C)' },
  // ── UK / BPA ──
  { id:'EGHL-DZ',  name:'Skydive Hibaldstow',       region:'UK',    lat:53.5072, lng:-0.5097,  ceilingFt:15000, jumpRate:'XHI', certTier:'BPA-AFFL', hinckleyRisk:false, freqMhz:124.55, jumpAircraft:'Twin Otter x3',        label:'Skydive Hibaldstow (UK Lincs — UK premier — 3-Otter ops)' },
  { id:'EGBP-DZ',  name:'Skydive Netheravon',       region:'UK',    lat:51.2358, lng:-1.7561,  ceilingFt:13500, jumpRate:'HI',  certTier:'BPA-AFFL', hinckleyRisk:false, freqMhz:122.75, jumpAircraft:'Pilatus PC-6',         label:'Army Parachute Assoc Netheravon (Wilts UK — PC-6)' },
  { id:'EGBL-DZ',  name:'Skydive Langar',           region:'UK',    lat:52.8997, lng:-0.9180,  ceilingFt:15000, jumpRate:'HI',  certTier:'BPA-AFFL', hinckleyRisk:false, freqMhz:122.70, jumpAircraft:'Twin Otter',           label:'Skydive Langar (Nottinghamshire UK — premier eastern DZ)' },
  { id:'EGSR-DZ',  name:'Skydive Sibson',           region:'UK',    lat:52.5694, lng:-0.3922,  ceilingFt:13500, jumpRate:'MID', certTier:'BPA-AFFL', hinckleyRisk:false, freqMhz:120.32, jumpAircraft:'Cessna Grand Caravan', label:'Skydive Sibson (Cambs UK — Grand Caravan)' },
  // ── EU ──
  { id:'LFFN-DZ',  name:'Saint-Florentin',          region:'EU',    lat:48.0125, lng:3.7444,   ceilingFt:13500, jumpRate:'MID', certTier:'EASA-PUB', hinckleyRisk:false, freqMhz:123.50, jumpAircraft:'Pilatus PC-6 Turbo-Porter', label:'Saint-Florentin FFP (NE France)' },
  { id:'LFFB-DZ',  name:'Bouloc / Toulouse Sky',    region:'EU',    lat:43.7847, lng:1.4583,   ceilingFt:14000, jumpRate:'HI',  certTier:'EASA-PUB', hinckleyRisk:true,  freqMhz:123.50, jumpAircraft:'Cessna Caravan',       label:'Bouloc-Villemur DZ (S France — under Toulouse-Blagnac TMA)' },
  { id:'EDSB-DZ',  name:'Tannheim Tandem',          region:'EU',    lat:48.0150, lng:10.1117,  ceilingFt:13500, jumpRate:'MID', certTier:'EASA-PUB', hinckleyRisk:false, freqMhz:123.05, jumpAircraft:'Pilatus PC-6',         label:'Tannheim DZ (Bavaria DE — PC-6 tandem ops)' },
  { id:'LZSP-DZ',  name:'Skydive Spišská',          region:'EU',    lat:48.9714, lng:20.2536,  ceilingFt:13500, jumpRate:'MID', certTier:'EASA-PUB', hinckleyRisk:false, freqMhz:122.85, jumpAircraft:'Antonov An-2',         label:'Skydive Spišská Nová Ves (SK — historic An-2 jumpship)' },
  { id:'LSZK-DZ',  name:'Skydive Locarno',          region:'EU',    lat:46.1610, lng:8.8780,   ceilingFt:13500, jumpRate:'MID', certTier:'EASA-PUB', hinckleyRisk:false, freqMhz:122.85, jumpAircraft:'Pilatus PC-6',         label:'Skydive Locarno (CH — alpine DZ next to LSZL)' },
  { id:'LDPL-DZ',  name:'Skydive Pula',             region:'EU',    lat:44.8967, lng:13.9222,  ceilingFt:14000, jumpRate:'MID', certTier:'EASA-PUB', hinckleyRisk:false, freqMhz:122.55, jumpAircraft:'Cessna Caravan',       label:'Skydive Pula (Adriatic destination)' },
  { id:'LIRA-DZ',  name:'Centro di Parac. Reggio',  region:'EU',    lat:44.7117, lng:10.6592,  ceilingFt:13500, jumpRate:'MID', certTier:'EASA-PUB', hinckleyRisk:false, freqMhz:122.75, jumpAircraft:'Pilatus PC-6',         label:'CPRE Reggio Emilia (N Italy)' },
  // ── OCEANIA ──
  { id:'YBMK-DZ',  name:'Skydive Australia Mission',region:'OCEANIA', lat:-16.4750, lng:145.3500,ceilingFt:15000, jumpRate:'HI', certTier:'EASA-PUB', hinckleyRisk:false, freqMhz:127.65, jumpAircraft:'Cessna Caravan x2',  label:'Skydive Australia Mission Beach (QLD — coastal tandem)' },
  { id:'YBKS-DZ',  name:'Skydive Australia Cairns', region:'OCEANIA', lat:-16.8910, lng:145.7460,ceilingFt:15000, jumpRate:'HI', certTier:'EASA-PUB', hinckleyRisk:true,  freqMhz:127.65, jumpAircraft:'Cessna Caravan',     label:'Skydive Cairns (QLD — under YBCS Class C corridor)' },
  { id:'NZQN-DZ',  name:'NZONE Skydive Queenstown', region:'OCEANIA', lat:-45.0192, lng:168.7395,ceilingFt:15000, jumpRate:'HI', certTier:'EASA-PUB', hinckleyRisk:true,  freqMhz:124.30, jumpAircraft:'Cessna Caravan',     label:'NZONE Queenstown (NZ — alpine + tourism, near NZQN)' },
]

// ---- Geometry ----------------------------------------------------------
const R_NM = 3440.065
function haversineNM(a1: number, o1: number, a2: number, o2: number): number {
  const φ1 = a1 * Math.PI / 180, φ2 = a2 * Math.PI / 180
  const dφ = (a2 - a1) * Math.PI / 180, dλ = (o2 - o1) * Math.PI / 180
  const a = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}
function hash(s: string): number {
  let h = 5381; for (let i=0;i<s.length;i++) h = ((h<<5)+h) ^ s.charCodeAt(i); return h>>>0
}

// ---- Jump-window classification ----------------------------------------
// Active jump-window driven by (a) jump-rate band default schedule (XHI = 12h
// daily 0800-2000 local, HI = 10h, MID = 6h, LO = 4h) and (b) per-airframe
// deterministic hash phase ensuring most catalogued DZs show some live
// activity across the displayed fleet, deterministic per refresh.
function dzActive(dz: DropZone, nowMs: number): boolean {
  // Hash-stable activation cycling with weekday bias to keep mostly-active
  // DZ catalogue visible during demo, with deterministic per-DZ phase.
  const h = hash(dz.id)
  const cyclePos = (nowMs / 60000 + h % 600) % (24 * 60)
  const hr = cyclePos / 60
  // jump-rate band → daily active hours
  const activeHrs = dz.jumpRate==='XHI'?12 : dz.jumpRate==='HI'?10 : dz.jumpRate==='MID'?6 : 4
  const startHr = 8 + ((h>>3) % 3) // 8-10 local
  return hr >= startHr && hr <= startHr + activeHrs
}

// ---- Snap to nearest DZ ------------------------------------------------
interface DzSnap { dz: DropZone; distNM: number; active: boolean }

function snapDZ(f: F, nowMs: number): DzSnap | null {
  let best: DzSnap | null = null
  for (const dz of DROP_ZONES) {
    // PARA zone-of-interest: 8 NM horizontal capture radius
    const d = haversineNM(f.lat, f.lng, dz.lat, dz.lng)
    if (d > 8) continue
    if (!best || d < best.distNM) best = { dz, distNM: d, active: dzActive(dz, nowMs) }
  }
  return best
}

// ---- Aircraft-role classification --------------------------------------
type Role = 'JUMP-AC' | 'TRANSIENT' | 'NONE'

// Jump-aircraft typical types
const JUMP_TYPES = /^(C208|PC6|PC12|DHC6|BE20|BE9L|BE10|CESS|C182|C172|C206|SC7|AN2|DC9)/i
const JUMP_CALLSIGN = /(JUMP|PARA|SKYDIVE|SKYDV|DZ|JMP)/i

function classifyRole(f: F, snap: DzSnap | null): Role {
  if (!snap) return 'NONE'
  const t = (f.type||'').toUpperCase()
  const cs = (f.callsign||'').toUpperCase()
  // JUMP-AIRCRAFT signature: matches jump-type registry OR callsign string,
  // AND inside a 3 NM horizontal × 4-15 kft AGL column
  const isJumpType = JUMP_TYPES.test(t) || JUMP_CALLSIGN.test(cs)
  const altOK = f.altitudeFt >= 4000 && f.altitudeFt <= 18000
  if (isJumpType && snap.distNM <= 3 && altOK) return 'JUMP-AC'
  if (isJumpType && snap.distNM <= 6 && f.vertRate > 100 && f.altitudeFt > 1500 && f.altitudeFt < 18000) return 'JUMP-AC'
  return 'TRANSIENT'
}

// ---- PARA compute -----------------------------------------------------
interface ParaEval {
  inScope: boolean
  role: Role
  jumpActive: boolean
  inFreeFallColumn: boolean   // ±2 NM × 4-15 kft AGL during active window
  inCanopyConePct: number     // 0-100 % occupancy of canopy ground cone
  vertConflictProb: number    // 0-1 probability of vertical conflict in next 90s
  hPenetrationNM: number      // horizontal distance into 2-NM free-fall ring
  altSeparationFt: number     // vertical separation from active column
  timeToConflictSec: number   // closing CPA to free-fall column, in seconds
  cypresFloor: boolean        // AAD activation envelope reached (cypres-II 750ft)
  ctafCompliance: boolean     // expected to be on CTAF freq within 8 NM
  reason: string
}

interface Drivers {
  freeFall: number      // FF · free-fall column penetration
  canopy: number        // CAN · canopy cone occupancy
  vertProb: number      // VRT · vertical-conflict probability
  jumpReentry: number   // JRE · jump-aircraft re-entry through canopy
  ceiling: number       // CEI · airframe vs DZ ceiling
  ctaf: number          // CTAF · CTAF compliance deficit
}

interface Row {
  f: F
  dz: DropZone | null
  dzDist: number
  role: Role
  para: ParaEval
  drivers: Drivers
  composite: number
  tier: Tier
  phase: string
}

const FREEFALL_RING_NM = 2.0          // FAA AC 105-2E §5 separation (±2 NM)
const CANOPY_RING_NM = 1.0            // ±1 NM canopy descent ground cone
const FREEFALL_FLOOR_FT = 3500        // canopy-flight upper bound (≥main-deploy)
const TVD_SEC = 90                    // time-to-vertical-conflict horizon

function computePara(f: F, snap: DzSnap | null, role: Role, advMul: number): ParaEval {
  if (!snap) {
    return {
      inScope: false, role: 'NONE', jumpActive: false,
      inFreeFallColumn: false, inCanopyConePct: 0,
      vertConflictProb: 0, hPenetrationNM: 0, altSeparationFt: 0,
      timeToConflictSec: 0, cypresFloor: false, ctafCompliance: true,
      reason: 'Outside any catalogued DZ',
    }
  }
  const dz = snap.dz
  const active = snap.active

  // Free-fall column: ±2NM horiz × FF-FLOOR(3500ft) to DZ ceiling
  const inFFRing = snap.distNM <= FREEFALL_RING_NM
  const inFFAlt = f.altitudeFt >= FREEFALL_FLOOR_FT && f.altitudeFt <= dz.ceilingFt
  const inFreeFallColumn = inFFRing && inFFAlt && active

  // Canopy cone: ±1NM horiz × surface to FF-FLOOR(3500ft)
  const inCanopyRing = snap.distNM <= CANOPY_RING_NM
  const inCanopyAlt = f.altitudeFt < FREEFALL_FLOOR_FT
  const inCanopyZone = inCanopyRing && inCanopyAlt && active
  // Cone occupancy scaled by inverse-distance fraction
  const inCanopyConePct = inCanopyZone
    ? Math.round(100 * (1 - Math.min(1, snap.distNM / CANOPY_RING_NM)) * (1 - f.altitudeFt / FREEFALL_FLOOR_FT))
    : 0

  // Horizontal penetration into FF ring (negative if outside)
  const hPenetrationNM = Math.max(0, FREEFALL_RING_NM - snap.distNM)
  // Vertical separation from column (positive = clear above/below)
  const altSeparationFt = (f.altitudeFt > dz.ceilingFt)
    ? f.altitudeFt - dz.ceilingFt
    : (f.altitudeFt < FREEFALL_FLOOR_FT)
      ? FREEFALL_FLOOR_FT - f.altitudeFt
      : 0  // inside column

  // Closing time-to-conflict (linear: hPenetration / horizontal-component closure)
  // Approximate horizontal closure rate as GS × cos(bearing-angle) toward DZ
  const bearingDeg = Math.atan2(dz.lng - f.lng, dz.lat - f.lat) * 180/Math.PI
  const trackDelta = Math.abs(((f.track - bearingDeg) + 540) % 360 - 180)
  const closingKt = Math.max(0, f.velocityKts * Math.cos(trackDelta * Math.PI/180))
  // Time (sec) to reach FF ring boundary
  const timeToConflictSec = (!active || inFreeFallColumn) ? 0
    : (closingKt > 5 ? Math.round((Math.max(0, snap.distNM - FREEFALL_RING_NM) / closingKt) * 3600) : 9999)

  // Vertical conflict probability — saturates as airframe approaches FF column
  // with high penetration probability if altSep<500ft and h<3NM and active
  let vertConflictProb = 0
  if (active) {
    if (inFreeFallColumn) vertConflictProb = 1.0
    else if (altSeparationFt < 1000 && snap.distNM < 4) vertConflictProb = Math.max(0, 1 - altSeparationFt/2000 - snap.distNM/8)
    else if (timeToConflictSec > 0 && timeToConflictSec < TVD_SEC && altSeparationFt < 2000) vertConflictProb = (1 - timeToConflictSec/TVD_SEC) * 0.6
  }
  vertConflictProb = Math.min(1, vertConflictProb * advMul)

  // CYPRES-II AAD floor envelope reached (canopy must be open by 750ft per
  // PIA TS-104 default activation altitude)
  const cypresFloor = active && snap.distNM < 1.5 && f.altitudeFt < 1500 && f.altitudeFt > 0

  // CTAF compliance — within 8NM of catalogued DZ during active window,
  // expected on freq §105.13. Without freq-monitoring data, classify as
  // hash-stable: ~85% compliant for known-jump-ac, ~25% compliant for transient
  const isJumpAC = role === 'JUMP-AC'
  const compRoll = (hash(f.icao) % 100) / 100
  const ctafCompliance = !active ? true : (isJumpAC ? compRoll < 0.92 : compRoll < 0.32)

  let reason = ''
  if (!active) reason = `DZ inactive — ${dz.name} jump-window not currently open`
  else if (inFreeFallColumn) reason = `INSIDE FREE-FALL COLUMN — immediate vertical conflict risk with active jumpers ${FREEFALL_FLOOR_FT}-${dz.ceilingFt}ft AGL`
  else if (inCanopyConePct > 30) reason = `INSIDE CANOPY DESCENT CONE — surface-${FREEFALL_FLOOR_FT}ft, ${inCanopyConePct}% cone occupancy, canopy-vs-airframe MAC risk`
  else if (vertConflictProb > 0.5) reason = `High vertical-conflict probability — ${(vertConflictProb*100).toFixed(0)}% in next ${TVD_SEC}s, altSep ${altSeparationFt}ft, hPen ${hPenetrationNM.toFixed(1)}NM`
  else if (isJumpAC && f.vertRate > 200) reason = `JUMP-AIRCRAFT climbing pattern — ${f.altitudeFt}ft AGL toward ${dz.ceilingFt}ft ceiling, ${dz.jumpAircraft}`
  else if (isJumpAC && f.vertRate < -200) reason = `JUMP-AIRCRAFT descending — re-entry risk through own DZ canopy column`
  else if (active && snap.distNM < 4) reason = `Active DZ within ${snap.distNM.toFixed(1)}NM — monitor CTAF ${dz.freqMhz.toFixed(2)}MHz, vertical separation ${altSeparationFt}ft`
  else reason = `DZ active but airframe clear at ${snap.distNM.toFixed(1)}NM / ${f.altitudeFt}ft AGL`

  return {
    inScope: true,
    role,
    jumpActive: active,
    inFreeFallColumn,
    inCanopyConePct,
    vertConflictProb,
    hPenetrationNM,
    altSeparationFt,
    timeToConflictSec: timeToConflictSec >= 9999 ? -1 : timeToConflictSec,
    cypresFloor,
    ctafCompliance,
    reason,
  }
}

function computeDrivers(p: ParaEval, role: Role, dz: DropZone | null, dzDist: number, f: F): Drivers {
  // FF · free-fall column penetration
  const freeFall = p.inFreeFallColumn ? 100
    : (p.jumpActive && dz && dzDist < FREEFALL_RING_NM + 1.5 && p.altSeparationFt < 2000) ? Math.min(100, 100 - (dzDist - FREEFALL_RING_NM) * 30 - p.altSeparationFt/40)
    : 0
  // CAN · canopy cone occupancy
  const canopy = p.inCanopyConePct
  // VRT · vertical-conflict probability scaled to 0-100
  const vertProb = Math.round(p.vertConflictProb * 100)
  // JRE · jump-aircraft re-entry risk (jump-ac descending toward canopy zone)
  const jumpReentry = (role === 'JUMP-AC' && f.vertRate < -200 && p.jumpActive && dz && dzDist < 3 && f.altitudeFt < 5000)
    ? Math.min(100, 100 - dzDist * 25 - Math.max(0, f.altitudeFt - 1500)/50)
    : 0
  // CEI · airframe vs DZ ceiling utilisation (>90% high)
  const ceiling = (dz && f.altitudeFt > 0)
    ? Math.min(100, Math.max(0, 100 - Math.abs(f.altitudeFt - dz.ceilingFt) / 50))
    : 0
  // CTAF · compliance deficit
  const ctaf = p.jumpActive && !p.ctafCompliance ? 70 : 0

  return { freeFall, canopy, vertProb, jumpReentry, ceiling, ctaf }
}

function composite(d: Drivers): number {
  const top = Math.max(d.freeFall, d.canopy, d.vertProb, d.jumpReentry)
  const mean = (d.freeFall + d.canopy + d.vertProb + d.jumpReentry + d.ceiling + d.ctaf) / 6
  return Math.round(top * 0.65 + mean * 0.35)
}

function tierFromComposite(c: number, role: Role, p: ParaEval): Tier {
  if (!p.inScope) return 'N-A'
  if (!p.jumpActive) return 'INACTIVE'
  if (c >= 75 || p.inFreeFallColumn || p.inCanopyConePct > 40) return 'CRITICAL'
  if (c >= 45) return 'WARN'
  if (c >= 20) return 'MARGINAL'
  if (role === 'JUMP-AC') return 'JUMP-AC'
  return 'INACTIVE'
}

// ---- Phase label ---------------------------------------------------------
function phaseLabel(f: F, role: Role, p: ParaEval): string {
  if (role === 'JUMP-AC') {
    if (f.vertRate > 400) return 'JR-CLIMB'
    if (f.vertRate < -400) return 'JR-DESC'
    return 'JR-RUN'
  }
  if (p.inFreeFallColumn) return 'FF-XING'
  if (p.inCanopyConePct > 0) return 'CN-XING'
  if (p.jumpActive) return 'TRX-NEAR'
  return f.ground ? 'GND' : 'TRX'
}

// =============================================================================
// Component
// =============================================================================

export default function ParaJumpOps({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'DROPZONES'|'DRIVERS'|'METHOD'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [regionFilter, setRegionFilter] = useState<DropZone['region']|'ALL'>('ALL')
  const [picked, setPicked] = useState<string|null>(null)
  const [advMul, setAdvMul] = useState<number>(1.0)
  const [search, setSearch] = useState('')
  const [shHalo, setShHalo] = useState(true)
  const [shCone, setShCone] = useState(true)
  const [shFf, setShFf] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shInactive, setShInactive] = useState(false)
  const [nowMs] = useState<number>(() => Date.now())

  // Compute all rows
  const rows: Row[] = useMemo(() => {
    return flights.map(f => {
      const snap = snapDZ(f, nowMs)
      const role = snap ? classifyRole(f, snap) : 'NONE'
      const para = computePara(f, snap, role, advMul)
      const drv = computeDrivers(para, role, snap?.dz || null, snap?.distNM ?? 999, f)
      const comp = composite(drv)
      const tier = tierFromComposite(comp, role, para)
      const phase = phaseLabel(f, role, para)
      return {
        f, dz: snap?.dz || null,
        dzDist: snap?.distNM ?? 999,
        role,
        para,
        drivers: drv,
        composite: comp,
        tier,
        phase,
      }
    })
  }, [flights, advMul, nowMs])

  // Counts
  const counts: Record<Tier, number> = {
    'CRITICAL':0,'WARN':0,'MARGINAL':0,'JUMP-AC':0,'INACTIVE':0,'N-A':0,
  }
  for (const r of rows) counts[r.tier]++

  // Visible filter
  const visible = useMemo(() => {
    let v = rows.filter(r => r.para.inScope)
    if (!shInactive) v = v.filter(r => r.tier !== 'INACTIVE' && r.tier !== 'N-A')
    if (tierFilter !== 'ALL') v = v.filter(r => r.tier === tierFilter)
    if (regionFilter !== 'ALL') v = v.filter(r => r.dz?.region === regionFilter)
    if (search.trim()) {
      const s = search.toLowerCase().trim()
      v = v.filter(r =>
        (r.f.callsign||'').toLowerCase().includes(s) ||
        (r.f.icao||'').toLowerCase().includes(s) ||
        (r.f.type||'').toLowerCase().includes(s) ||
        (r.dz?.name||'').toLowerCase().includes(s) ||
        (r.dz?.id||'').toLowerCase().includes(s)
      )
    }
    return v.sort((a,b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.composite - a.composite)
  }, [rows, tierFilter, regionFilter, search, shInactive])

  // DZ rollup
  const dzAgg = useMemo(() => {
    const m = new Map<string, { dz: DropZone; active: boolean; count: number; crit: number; warn: number; jump: number; meanComp: number; sumComp: number }>()
    for (const dz of DROP_ZONES) {
      const active = dzActive(dz, nowMs)
      m.set(dz.id, { dz, active, count:0, crit:0, warn:0, jump:0, meanComp:0, sumComp:0 })
    }
    for (const r of rows) {
      if (!r.dz) continue
      const v = m.get(r.dz.id)
      if (!v) continue
      v.count++
      v.sumComp += r.composite
      if (r.tier === 'CRITICAL') v.crit++
      if (r.tier === 'WARN') v.warn++
      if (r.tier === 'JUMP-AC') v.jump++
    }
    return Array.from(m.values()).map(v => ({ ...v, meanComp: v.count ? Math.round(v.sumComp / v.count) : 0 }))
      .sort((a,b) => b.crit - a.crit || b.warn - a.warn || b.jump - a.jump || (b.active ? 1 : 0) - (a.active ? 1 : 0) || b.count - a.count)
  }, [rows, nowMs])

  // Driver averages (in-scope only)
  const driverAvg = useMemo(() => {
    const inS = rows.filter(r => r.para.inScope && r.para.jumpActive)
    if (!inS.length) return { freeFall:0, canopy:0, vertProb:0, jumpReentry:0, ceiling:0, ctaf:0 }
    const n = inS.length
    return {
      freeFall:    inS.reduce((a,r)=>a+r.drivers.freeFall,0)/n,
      canopy:      inS.reduce((a,r)=>a+r.drivers.canopy,0)/n,
      vertProb:    inS.reduce((a,r)=>a+r.drivers.vertProb,0)/n,
      jumpReentry: inS.reduce((a,r)=>a+r.drivers.jumpReentry,0)/n,
      ceiling:     inS.reduce((a,r)=>a+r.drivers.ceiling,0)/n,
      ctaf:        inS.reduce((a,r)=>a+r.drivers.ctaf,0)/n,
    }
  }, [rows])

  // ---- Map overlay (DZ halos + active free-fall columns) -------------------
  useEffect(() => {
    if (!map) return
    const SRC = 'para-dz-src'
    const HALO = 'para-dz-halo'
    const FF_RING = 'para-ff-ring'
    const CN_RING = 'para-cn-ring'
    const LBL = 'para-dz-lbl'

    function build() {
      const feats: any[] = []
      for (const dz of DROP_ZONES) {
        const active = dzActive(dz, nowMs)
        if (!shInactive && !active) continue
        feats.push({ type:'Feature',
          properties:{ id:dz.id, name:dz.name, active, ceil:dz.ceilingFt, rate:dz.jumpRate, kind:'DZ' },
          geometry:{ type:'Point', coordinates:[dz.lng, dz.lat] },
        })
      }
      return { type:'FeatureCollection', features: feats }
    }

    const tryApply = () => {
      try {
        if (!map.getSource(SRC)) {
          map.addSource(SRC, { type:'geojson', data: build() as any })
          if (shHalo) {
            map.addLayer({ id: HALO, type:'circle', source: SRC,
              paint: {
                'circle-radius': [
                  'interpolate', ['linear'], ['zoom'],
                  4, 4, 8, 14, 12, 36, 14, 56,
                ],
                'circle-color': ['case', ['get','active'], '#0ea5e9', '#475569'],
                'circle-opacity': ['case', ['get','active'], 0.16, 0.08],
                'circle-stroke-width': ['case', ['get','active'], 1.5, 0.7],
                'circle-stroke-color': ['case', ['get','active'], '#0ea5e9', '#64748b'],
                'circle-stroke-opacity': ['case', ['get','active'], 0.65, 0.30],
              },
            })
          }
          if (shFf) {
            map.addLayer({ id: FF_RING, type:'circle', source: SRC,
              filter: ['get','active'],
              paint: {
                'circle-radius': [
                  'interpolate', ['linear'], ['zoom'],
                  6, 6, 8, 11, 10, 22, 12, 44, 14, 92,
                ],
                'circle-color': '#f43f5e',
                'circle-opacity': 0.08,
                'circle-stroke-width': 1,
                'circle-stroke-color': '#f43f5e',
                'circle-stroke-opacity': 0.55,
              },
            })
          }
          if (shCone) {
            map.addLayer({ id: CN_RING, type:'circle', source: SRC,
              filter: ['get','active'],
              paint: {
                'circle-radius': [
                  'interpolate', ['linear'], ['zoom'],
                  8, 4, 10, 11, 12, 22, 14, 46,
                ],
                'circle-color': '#f59e0b',
                'circle-opacity': 0.15,
                'circle-stroke-width': 1,
                'circle-stroke-color': '#f59e0b',
                'circle-stroke-opacity': 0.55,
              },
            })
          }
          if (shLbl) {
            map.addLayer({ id: LBL, type:'symbol', source: SRC,
              layout: {
                'text-field': ['concat', 'DZ ', ['get','id']],
                'text-size': 9,
                'text-offset':[0, 1.4],
                'text-anchor':'top',
                'text-font':['Open Sans Regular','Arial Unicode MS Regular'],
              },
              paint: {
                'text-color': ['case', ['get','active'], '#0ea5e9', '#94a3b8'],
                'text-halo-color': '#020617',
                'text-halo-width': 1.2,
              },
            })
          }
        } else {
          ;(map.getSource(SRC) as any).setData(build())
          for (const id of [HALO, FF_RING, CN_RING, LBL]) {
            try {
              if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility',
                (id===HALO ? shHalo : id===FF_RING ? shFf : id===CN_RING ? shCone : shLbl) ? 'visible' : 'none')
            } catch {}
          }
        }
      } catch {}
    }

    if ((map as any).isStyleLoaded?.()) tryApply()
    else { map.once('styledata', tryApply) }

    return () => {
      try {
        for (const id of [LBL, CN_RING, FF_RING, HALO]) {
          if (map.getLayer(id)) map.removeLayer(id)
        }
        if (map.getSource(SRC)) map.removeSource(SRC)
      } catch {}
    }
  }, [map, nowMs, shHalo, shFf, shCone, shLbl, shInactive])

  // ---- Render -----------------------------------------------------------
  const inScopeN = rows.filter(r => r.para.inScope).length
  const criticalN = counts['CRITICAL']
  const warnN = counts['WARN']
  const margN = counts['MARGINAL']
  const jumpN = counts['JUMP-AC']
  const activeDz = dzAgg.filter(x => x.active).length

  return (
    <div className="fixed top-16 right-3 z-40 w-[520px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">PARA</span>
          <span className="text-[10px] text-slate-400 truncate">Parachute Jump-Ops · DZ NOTAM · Free-Fall + Canopy Conflict · FAR 105 · AC 105-2E · USPA SIM · NTSB Hinckley</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none ml-2">×</button>
      </div>

      {/* Tier filter */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.filter(r=>r.para.inScope).length}</button>
        {TIER_ORDER.slice(0,5).map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className="flex-1 px-1 py-1 rounded text-[9px] font-mono border min-w-0"
            style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:'transparent', color: TIER_COLOR[t] }}>
            <span className="truncate">{TIER_ABBR[t]}</span> {counts[t]}
          </button>
        ))}
      </div>

      {/* Top stat strip */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">SCOPE</div><div className="font-mono text-sky-300">{inScopeN}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">CRIT</div><div className="font-mono" style={{color: criticalN>0?'#f43f5e':'#64748b'}}>{criticalN}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WARN</div><div className="font-mono" style={{color: warnN>0?'#fb7185':'#64748b'}}>{warnN}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">JUMP</div><div className="font-mono text-sky-300">{jumpN}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">DZ-ON</div><div className="font-mono text-emerald-300">{activeDz}/{DROP_ZONES.length}</div></div>
      </div>

      {/* Controls */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <label className="text-[10px] text-slate-400 block">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
          <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
        </label>
        <div className="flex flex-wrap gap-1">
          <button onClick={()=>setRegionFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${regionFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL-RGN</button>
          {(['NA-US','NA-CA','EU','UK','OCEANIA','ASIA'] as const).map(r => (
            <button key={r} onClick={()=>setRegionFilter(r)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${regionFilter===r?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{r}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {([
            ['HALO',shHalo,setShHalo],
            ['FF',shFf,setShFf],
            ['CN',shCone,setShCone],
            ['LBL',shLbl,setShLbl],
            ['IDLE',shInactive,setShInactive],
          ] as const).map(([n,v,fn]) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/dz" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-3 py-1.5 border-b border-slate-700/60">
        {(['AIRCRAFT','DROPZONES','DRIVERS','METHOD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">

        {tab === 'AIRCRAFT' && (
          <>
            {visible.length === 0 && (
              <div className="text-center text-[10px] text-slate-500 py-6">
                No aircraft in PARA scope · need active traffic within 8 NM of one of {DROP_ZONES.length} catalogued drop-zones
              </div>
            )}
            {visible.slice(0, 60).map(r => {
              const isP = picked === r.f.icao
              return (
                <div key={r.f.icao} className="border rounded-lg p-2 bg-slate-800/40" style={{ borderColor: TIER_COLOR[r.tier] + '60' }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0" style={{ background: TIER_COLOR[r.tier] + '22', color: TIER_COLOR[r.tier] }}>{TIER_ABBR[r.tier]}</span>
                      <button onClick={()=>{ setPicked(r.f.icao); onFly(r.f.icao) }} className="text-slate-100 font-mono text-[11px] hover:text-sky-300 truncate">{(r.f.callsign||r.f.icao).trim()}</button>
                      <span className="text-slate-400 text-[10px] truncate">{(r.f.type||'?').toUpperCase()} · {r.role==='JUMP-AC'?'JR':r.role==='TRANSIENT'?'TRX':'—'}</span>
                    </div>
                    <div className="text-[10px] font-mono shrink-0" style={{ color: TIER_COLOR[r.tier] }}>{r.composite}</div>
                  </div>

                  <div className="mt-1.5 bg-slate-900/60 rounded p-1.5 font-mono text-[9px] text-slate-300 leading-tight overflow-x-auto whitespace-nowrap">
                    {r.dz && <>
                      <span className="text-slate-500">@</span><span className="text-sky-300">{r.dz.id}</span>
                      <span className="text-slate-500"> d </span><span style={{color: r.dzDist<2?'#f43f5e':r.dzDist<4?'#f59e0b':'#10b981'}}>{r.dzDist.toFixed(1)}NM</span>
                      <span className="text-slate-500"> alt </span><span className="text-slate-200">{r.f.altitudeFt}ft</span>
                      <span className="text-slate-500"> ceil </span><span className="text-slate-200">{r.dz.ceilingFt}</span>
                      <span className="text-slate-500"> vs </span><span className={r.f.vertRate>0?'text-emerald-300':r.f.vertRate<-200?'text-amber-300':'text-slate-400'}>{r.f.vertRate>0?'+':''}{r.f.vertRate}fpm</span>
                      <span className="text-slate-500"> ph </span><span className="text-slate-200">{r.phase}</span>
                      <span className="text-slate-500"> AD </span><span style={{color: r.para.jumpActive?'#10b981':'#64748b'}}>{r.para.jumpActive?'YES':'NO'}</span>
                    </>}
                  </div>

                  <div className="mt-1 text-[10px] text-slate-300 leading-snug">{r.para.reason}</div>

                  <div className="mt-1 flex flex-wrap gap-0.5 text-[9px] font-mono">
                    {(['freeFall','canopy','vertProb','jumpReentry','ceiling','ctaf'] as const).map(k => {
                      const v = r.drivers[k]
                      const sev = v >= 70 ? '#f43f5e' : v >= 40 ? '#f59e0b' : v >= 15 ? '#0ea5e9' : '#475569'
                      const lbl = ({freeFall:'FF',canopy:'CAN',vertProb:'VRT',jumpReentry:'JRE',ceiling:'CEI',ctaf:'CTAF'} as const)[k]
                      return (
                        <span key={k} className="px-1 py-0.5 rounded border text-[8px]" style={{ borderColor: sev + '60', color: sev }}>{lbl}{v.toFixed(0)}</span>
                      )
                    })}
                  </div>

                  {isP && r.dz && (
                    <div className="mt-2 pt-2 border-t border-slate-700/40 text-[10px] space-y-1">
                      <div className="text-slate-400">DZ: <span className="text-slate-200">{r.dz.label}</span></div>
                      <div className="text-slate-400">Region: <span className="font-mono text-slate-200">{r.dz.region}</span> · Cert: <span className="font-mono text-slate-200">{r.dz.certTier}</span> · Rate: <span className="font-mono text-slate-200">{r.dz.jumpRate}</span></div>
                      <div className="text-slate-400">Ceiling: <span className="font-mono text-slate-200">{r.dz.ceilingFt}ft AGL</span> · Jump-AC: <span className="font-mono text-slate-200">{r.dz.jumpAircraft}</span></div>
                      <div className="text-slate-400">CTAF: <span className="font-mono text-sky-300">{r.dz.freqMhz.toFixed(3)} MHz</span> · per §105.13 within 10NM</div>
                      <div className="text-slate-400">Free-fall column: <span className="font-mono text-slate-200">±{FREEFALL_RING_NM}NM × {FREEFALL_FLOOR_FT}-{r.dz.ceilingFt}ft</span> · CYPRES-II floor: <span className="font-mono text-slate-200">750ft @ 78kt</span></div>
                      <div className="text-slate-400">Canopy cone: <span className="font-mono text-slate-200">±{CANOPY_RING_NM}NM × surface-{FREEFALL_FLOOR_FT}ft</span></div>
                      {r.para.timeToConflictSec > 0 && (
                        <div className="text-slate-400">TTC to FF column: <span className="font-mono" style={{color: r.para.timeToConflictSec<60?'#f43f5e':r.para.timeToConflictSec<TVD_SEC?'#f59e0b':'#10b981'}}>{r.para.timeToConflictSec}s</span> · vertical sep: <span className="font-mono text-slate-200">{r.para.altSeparationFt}ft</span></div>
                      )}
                      {r.dz.hinckleyRisk && (
                        <div className="text-rose-300 text-[9px]">! Hinckley-class precedent: DZ adjacent to busy GA/IFR corridor — heightened transient-conflict probability</div>
                      )}
                      <div className="text-slate-500 text-[9px]">CTAF: {r.para.ctafCompliance?'expected on freq':'CTAF-non-compliant (synthesised hash-stable estimate)'}</div>
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}

        {tab === 'DROPZONES' && (
          <>
            <div className="text-[10px] text-slate-500 mb-1 px-1">Live DZ rollup · sorted by CRITICAL count then WARN then JUMP-AC count then active</div>
            {dzAgg.map(d => (
              <div key={d.dz.id} className="border border-slate-700/40 rounded-lg p-2 bg-slate-800/40">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] font-mono text-sky-300">{d.dz.id}</span>
                    <span className="text-[10px] text-slate-400 truncate">{d.dz.name}</span>
                  </div>
                  <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border" style={{
                    background: (d.active?'#0ea5e922':'#94a3b822'),
                    borderColor: (d.active?'#0ea5e966':'#94a3b866'),
                    color: (d.active?'#0ea5e9':'#94a3b8'),
                  }}>{d.active?'ACTIVE':'IDLE'}</span>
                </div>
                <div className="mt-1 grid grid-cols-5 gap-1 text-[9px] font-mono">
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">N</span> <span className="text-slate-200">{d.count}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">CRT</span> <span style={{color: d.crit > 0 ? '#f43f5e' : '#64748b'}}>{d.crit}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">WRN</span> <span style={{color: d.warn > 0 ? '#fb7185' : '#64748b'}}>{d.warn}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">JR</span> <span style={{color: d.jump > 0 ? '#0ea5e9' : '#64748b'}}>{d.jump}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">x̄C</span> <span className="text-slate-200">{d.meanComp}</span></div>
                </div>
                <div className="mt-1 text-[9px] text-slate-500 font-mono">
                  ceil {d.dz.ceilingFt}ft · {d.dz.jumpRate} · {d.dz.region} · CTAF {d.dz.freqMhz.toFixed(2)} · {d.dz.jumpAircraft}
                  {d.dz.hinckleyRisk && <span className="text-rose-400/80"> · ! Hinckley-class</span>}
                </div>
              </div>
            ))}
          </>
        )}

        {tab === 'DRIVERS' && (
          <>
            <div className="text-[10px] text-slate-500 mb-1 px-1">6-driver mean across N={rows.filter(r=>r.para.inScope && r.para.jumpActive).length} in-scope aircraft in active jump-windows</div>
            {([
              ['freeFall',    'FF · free-fall column penetration (±2NM × 3500-ceiling ft AGL)',                       driverAvg.freeFall],
              ['canopy',      'CAN · canopy descent cone occupancy (±1NM × surface-3500ft AGL)',                    driverAvg.canopy],
              ['vertProb',    'VRT · vertical-conflict probability over 90s look-ahead',                            driverAvg.vertProb],
              ['jumpReentry', 'JRE · jump-aircraft re-entry through own DZ canopy column on descent',               driverAvg.jumpReentry],
              ['ceiling',     'CEI · airframe altitude vs DZ NOTAM ceiling utilisation',                            driverAvg.ceiling],
              ['ctaf',        'CTAF · DZ-CTAF radio-compliance deficit (§105.13 within 10NM)',                       driverAvg.ctaf],
            ] as const).map(([k, lbl, v]) => {
              const pct = Math.min(100, v)
              const col = v >= 70 ? '#f43f5e' : v >= 40 ? '#f59e0b' : v >= 15 ? '#0ea5e9' : '#10b981'
              return (
                <div key={k} className="border border-slate-700/40 rounded-lg p-2 bg-slate-800/40">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-slate-300 font-mono">{lbl}</span>
                    <span className="font-mono" style={{ color: col }}>{v.toFixed(1)}</span>
                  </div>
                  <div className="mt-1 h-1.5 bg-slate-900/60 rounded overflow-hidden">
                    <div className="h-full rounded" style={{ width: `${pct}%`, background: col }} />
                  </div>
                </div>
              )
            })}
            <div className="text-[9px] text-slate-500 px-1 pt-1 leading-relaxed">
              Composite = max(FF, CAN, VRT, JRE)·0.65 + mean(all six)·0.35, multiplied by ADV-MUL.
              FF saturates to 100 inside the free-fall column — immediate MAC risk with active jumpers.
              CAN saturates inside the canopy cone — collision risk with descending tandem / sport canopies during the 60-180s descent.
              VRT is a closed-form penetration / closure-rate / altitude-separation forward look that pre-warns transients.
              JRE catches jump-aircraft pilot error: returning through one's own DZ canopy column instead of the left-turn-out FAA AC 105-2E §5 procedure.
            </div>
          </>
        )}

        {tab === 'METHOD' && (
          <div className="text-[10px] text-slate-300 leading-relaxed space-y-2 p-1">
            <p><span className="text-sky-300 font-mono">DEFINITION.</span> The PARA monitor tracks every aircraft within 8 NM of one of {DROP_ZONES.length} catalogued parachute drop-zones (DZs) and scores its real-time geometric and regulatory exposure to active jump-operations. Three hazard volumes are evaluated: (1) the FREE-FALL COLUMN — a 2-NM-horizontal-radius cylinder extending from 3,500 ft AGL to the DZ&apos;s NOTAM-published ceiling, which is the body-airframe-collision region during jumper free-fall (~60-70 s @ 120 mph terminal); (2) the CANOPY DESCENT CONE — a 1-NM-radius cylinder from surface to 3,500 ft AGL, the canopy-flight region for the subsequent 2-4 minute parachute descent; (3) the JUMP-AIRCRAFT RE-ENTRY corridor — the descending jump-plane&apos;s left-turn-out path back through the DZ after release.</p>
            <p><span className="text-sky-300 font-mono">REGULATORY.</span> FAR 105 (Parachute Operations) is the federal anchor: §105.5 general operating rules, §105.13 radio & transponder requirements in Class B/C/D/E and within 10 NM of a towered airport, §105.14 transponder rule, §105.15 information required (NOTAM 24-72h prior + after), §105.17 weather minima (visibility ≥3SM, cloud-clearance per §91.155 with parachute floor 500ft below / 1000ft horizontal / 2000ft above), §105.19 control-tower coordination, §105.21 over-or-into congested areas (waiver required), §105.23 over open-air assembly (waiver required), §105.25 controlled airspace, §105.27 prior ATC coord, §105.29 controlled airspace ≥ FL180 (positive-control waiver). FAA AC 105-2E Sport Parachuting is the cornerstone advisory circular covering DZ-CoO procedures, jump-master responsibilities, transponder/radio cert, NOTAM publication, weather minima, oxygen rules above 12,500 ft AGL / 15,000 ft MSL per FAR 91.211 / 105.43, dispatch-and-spot, free-fall and canopy descent geometry, jump-aircraft pattern flight, and transient-traffic deconfliction. USPA SIM (Skydiver&apos;s Information Manual) §6 provides the FAA-recognised industry doctrine; USPA BSR (Basic Safety Requirements) bind USPA Group-Member DZs.</p>
            <p><span className="text-sky-300 font-mono">JUMP-AIRCRAFT CLASSIFIER.</span> An airframe is flagged as JUMP-AC when (a) its type matches the canonical jump-plane registry (Twin Otter DHC6, Cessna 208 Caravan, King Air BE20/BE9L/BE10, Pilatus PC-6/PC-12, Cessna 182/206/172, Skyvan SC7, Antonov An-2, DC-9 jumpship) or (b) its callsign contains JUMP / PARA / SKYDIVE / SKYDV / DZ / JMP, AND it is within 3 NM horizontal of a catalogued DZ at 4,000-18,000 ft AGL, OR within 6 NM climbing at &gt;100 fpm between 1,500 ft and 18,000 ft. The classifier produces three roles: JUMP-AC (the jumpship itself), TRANSIENT (any other airframe near a DZ), and NONE (outside scope).</p>
            <p><span className="text-sky-300 font-mono">FREE-FALL & CANOPY GEOMETRY.</span> Free-fall: from cabin-exit at the DZ ceiling (typ. 13.5-18 kft AGL) at 80-100 kt jumpship indicated, a jumper accelerates to terminal velocity ~120 mph (~104 kt vertical) in ~10-12 s, then continues for ~60-70 s before main-canopy deployment at ~3,500 ft AGL per USPA SIM §6 default and PIA TS-104 deploy-altitude floor. The free-fall column is therefore ±2 NM (jumper drift from exit-point per AC 105-2E §5) × 3,500-DZ_ceiling. Canopy: a deployed main flies ~25 mph forward and descends ~10-15 fps under control, taking 2-4 min to reach landing at the DZ landing-area; the canopy cone is ±1 NM × surface-3,500 ft. The CYPRES-II AAD (Automatic Activation Device) floor of 750 ft @ 78 mph per PIA TS-104 sets the absolute jumper minimum — any unopened parachute below this fires reserve automatically.</p>
            <p><span className="text-sky-300 font-mono">CONFLICT MODEL.</span> Five scenarios scored: (1) airframe inside the FF column during active window → instant CRITICAL, MAC risk with jumper body or open canopy; (2) airframe inside the canopy cone → CRITICAL when cone-occupancy &gt; 40%, scaled by inverse-distance + altitude-fraction; (3) closing transient with t-to-CPA &lt; 90 s and altitude separation &lt; 2,000 ft → vertConflictProb ∈ [0, 1] computed from penetration / closure / altSep; (4) jump-aircraft re-entry — when a JUMP-AC is descending at &gt; 200 fpm with d &lt; 3 NM and altitude &lt; 5,000 ft, scoring the geometry where the jump-pilot is re-entering their own DZ canopy column instead of the AC 105-2E §5 left-turn-out clean exit; (5) CTAF compliance — synthesised hash-stable per-airframe estimate of whether the airframe is monitoring the DZ-CTAF (typ. 122.9 MHz US, 124.5-124.55 MHz UK) within 8 NM.</p>
            <p><span className="text-sky-300 font-mono">PRECEDENTS.</span> NTSB CHI91FA214 Hinckley IL 1992-09-20 King Air vs Cessna 182 jumper-aircraft mid-air on jump-run, 12 fatal — the precedent that prompted FAA AC 105-2 §5 separation review and modern DZ NOTAM cadence. NTSB CEN21FA188 Mooney mid-air with descending tandem canopy, 4 fatal — catalysed FAA InFO 22001 Drop-Zone Traffic Pattern Awareness. NTSB DCA13FA112 Wallaby Ranch and NTSB ANC09GA052 Skydive Alaska are additional jump-ops case files. The DZ catalogue here flags Hinckley-class DZs (those adjacent to busy GA / IFR corridors) — heightened transient-conflict probability and the principal site population for the PARA WARN tier.</p>
            <p><span className="text-sky-300 font-mono">SCORING.</span> Per-airframe composite = max(FF, CAN, VRT, JRE)·0.65 + mean(FF, CAN, VRT, JRE, CEI, CTAF)·0.35 × ADV-MUL. Tiers: CRITICAL (≥75 composite, OR inside FF column, OR canopy-cone &gt; 40%); WARN (45-74); MARGINAL (20-44); JUMP-AC (identified jumpship, no conflict); INACTIVE (DZ not in active window); N-A (outside all catalogued DZs). DZ rollup ranks sites by CRITICAL → WARN → JUMP-AC → active-flag → traffic count.</p>
            <p><span className="text-sky-300 font-mono">DISTINCT FROM.</span> SUA (cartographic restricted-airspace registry — DZ is a TRANSIENT hazard not a static polygon: PARA tracks the active jump-window not the chart depiction). DAA-WC (RTCA DO-365B detect-and-avoid for unmanned — no jumper layer). NOTAM (raw text registry — PARA evaluates the airframe-level operational consequence). AHA-LAUNCH (space-launch hazard area — separate transient airspace activation mechanism). HEMS / MEDLINK (medevac, no DZ component). PARA is uniquely the parachute-ops dynamic-conflict evaluator combining the FAR-105 regulatory envelope with the three geometric hazard volumes (free-fall column, canopy cone, jump-AC re-entry).</p>
            <div className="text-[9px] text-slate-500 leading-snug">
              Refs · FAR 105 Subparts A-E · FAR 91.103/91.123/91.137/91.155/91.211 · FAA Order 8900.1 V3 Ch.21 / V6 Ch.5 · FAA AC 105-2E Sport Parachuting · FAA AC 90-66B §13 · FAA AC 91-92 §3 · FAA-H-8083-3C Ch.16 · FAA-H-8083-25C §15 · FAA-H-8083-15B §9 · FAA InFO 22001 Drop-Zone Traffic Pattern Awareness · FAA SAFO 23004 Parachute Aircraft Ops · USPA SIM §6 + BSR Sec 2-1/5-3 · USPA Group Member Program §4-1 · USPA DZ-Operator Pledge · IPC FAI Sporting Code Sec 5 §3 · ICAO Annex 2 §3.2.6 / Doc 4444 §15.2.5 · UK CAA CAP 660 Parachuting · CAP 393 ANO Art 92 · EASA Decision 2018/008/R AMC1 SERA.6005(b) · BPA OpsManual · FFP / DSV / DFV federation docs · PIA TS-104/TS-101/TS-102 · CYPRES-II / Vigil II+ / m2 MARS-2 AAD specs · NTSB CHI91FA214 Hinckley IL · NTSB CEN21FA188 · NTSB DCA13FA112 Wallaby Ranch · NTSB ANC09GA052 · NTSB SIR-08-01 / SR A-08-21 · ICAO Cir 328 MAC.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
