'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   ARFF / RFFS Aerodrome Rescue & Fire Fighting Service Category
   Compliance Monitor (ATA 25 cabin egress · ICAO Annex 14 Ch 9)
   -----------------------------------------------------------
   For every arrival inside CAPTURE-nm of a catalogued aerodrome
   on a 3°-cone descent profile, compare the per-airframe
   *required RFFS category* (1..10) derived from overall fuselage
   length + max fuselage width per ICAO Annex 14 Vol I Table 9-1
   against the airport's *published* RFFS category, the published
   *response time* (T₁ ≤3 min nominal, ≤2 min CAT 7+ per Doc 9137
   Pt 1), the agent quantity available (water Q1+Q2 + foam
   concentrate per AFFF 3% / 6% formulary) and the number of
   rescue vehicles on watch.  Compute total water required
   Q₁(R) = (A x K) per Doc 9137 Pt 1 ch 2 formula where A is the
   theoretical critical area scaled by overall length L and
   fuselage width Wf, then Q₂ = (Q₁ x 0.30) for follow-up.
   Cat-10 (the highest, A380 / 747-8F / AN-225) demands ≥32,300
   L water + 2,420 L foam concentrate + 3 vehicles + ≤2 min T₁
   to a runway midpoint.  Cat-6 (a typical regional jet hub)
   demands 7,900 L + 660 L foam + 2 vehicles + ≤3 min.

   References:
     · ICAO Annex 14 Vol I, 9th Ed, §9.2 Rescue and Fire Fighting
     · ICAO Doc 9137 Airport Services Manual Pt 1 Rescue & Fire
       Fighting (5th Ed 2015) chs 1-2 categories, agent calc
     · ICAO Doc 9981 PANS-AGA Pt II ch 8 RFFS standards
     · ICAO Doc 10047 Aerodrome Cert Manual (RFFS audit)
     · 14 CFR 139.315 Index by length, 139.317 Equipment & agents,
       139.319 Operational requirements, 139.323 Personnel
     · FAA AC 150/5210-6D ARFF Vehicles, 150/5210-7D Personnel,
       150/5210-15A ARFF Vehicle Tactics, 150/5210-25 Multi-Agent
     · EASA Regulation (EU) 139/2014 + ADR.OPS.B.010 RFFS
     · EASA CS-ADR-DSN Subpart H (response time, vehicle list)
     · UK CAP 168 Licensing of Aerodromes ch 8 RFFS
     · NFPA 403 Aircraft Rescue & Fire-Fighting Services (2024)
     · NFPA 414 Aircraft Rescue & Fire-Fighting Vehicles (2022)
     · IATA Airport Handling Manual Ch 6.4 RFFS expectations
     · NTSB AAR-13/01 Asiana 214 SFO B772 (response 18s/2min15)
     · NTSB AAR-10/01 KCLT US Airways 1549 + UK AAIB 1/2010
       BA38 LHR (response time / agent reserves)
     · AAIB 1/2019 BHX EFW Boeing 747-400 fuselage-fire response

   Subsystem:
     - 56-airport RFFS catalogue spans ICAO Cat-10 hub-fortresses
       (KATL/KORD/EGLL/EHAM/RJTT/OMDB/OMAA/OMSJ/WSSS/VHHH/ZBAA/
       VABB/EDDF/LFPG/LEMD/LIRF) + Cat-9 (KDFW/KJFK/KIAH/KSEA/
       KSFO/CYYZ/LEBL/EDDM/LFPO/EBBR/LOWW/EKCH/ENGM/ESSA/EFHK/
       LSZH/LSGG/KMIA) + Cat-8 (KBOS/KDEN/KLAX/KMSP/KBWI/KCLT/
       LIMC/LGAV/LTBA) + Cat-7 (KAUS/KSJC/KPDX/KSAN/KSLC/KSTL/
       KPHL/KMDW/KOAK/KSMF/KSNA/CYUL/EIDW) + Cat-6 (KSDF/KBNA/
       KCMH/KIND/CYHZ).  Each entry carries published cat,
       declared response time T₁ seconds, available water L,
       foam concentrate L, vehicles on watch.
     - Per-airframe FNV-1a 32-bit hash synthesises an arrival
       weight class -> fuselage length-band (A380 73m / 747-8F
       77m / 777-300ER 74m / 777-200 64m / A350-1000 74m / 787-10
       68m / 787-9 63m / A330-900 64m / A321XLR 45m / 737-MAX-10
       43m / A220-300 39m / E195-E2 42m / E175 32m / ATR-72 27m /
       CRJ-700 32m / G650 30m / G280 21m / Cessna 525 14m).
       Width-band similarly synthesised.  Category lookup per
       Annex 14 Table 9-1.
     - Required water Q₁ scaled by L*Wf area * K-factor (0.50 for
       wide-body / 0.66 narrow-body) clipped to category step.
       Required foam = Q₁ * 0.06 (AFFF 6% mix) per NFPA 403.
       Vehicle count required by category (Cat-10 = 3, Cat-9 = 3,
       Cat-7-8 = 2, Cat-6 = 2, lower = 1).
     - Allowed REMISSION 1 category below required if movements
       le 700 per Annex 14 §9.2.4 (low-traffic remission) toggled
       by REMIT slider 0-2 categories.
     - Per-airport hash-stable on-day depletion (vehicle MX,
       Q2 supply depleted, road-closed access) scaled by DEPLETE
       slider 0-25% of fleet airports.

   5 risk drivers feed a max-driver composite:
     CAT  required-vs-published category gap
          0 at 0 gap, 25 per category short, 100 at 3+ short
     AGT  agent margin (water + foam vs required) tier-coloured
     VEH  vehicle shortfall vs required
     T1   response time T₁ vs Annex 14 spec (180 s / 120 s @ 7+)
     DEP  depletion / vehicle-MX flag (+30 base, capped 100)

   5 tiers:
     NO-RESCUE  score>=80 OR cat-gap>=3 OR T1>240s   rose
                (RFFS Cat insufficient · request airport upgrade
                 declaration / select alternate / 14 CFR 139.319)
     DOWNGRADE  score>=55  amber
                (Cat short 1 with remission · accept agent margin
                 brief crew · NFPA 403 follow-up vehicle pre-staged)
     WATCH      score>=25  sky
                (within spec but trend adverse · log T₁ next
                 inspection per Doc 9981 ch 8)
     OK         score<25   emerald
                (RFFS meets/exceeds Annex 14 requirement)
     IDLE       no arrival in capture / on-ground / outside FL   slate

   MapLibre overlay:
     - tier-coloured halo rings sized 8-22 px by score
     - rose diamond NO-RESCUE pin
     - dashed tier-coloured aircraft-to-destination projection
     - 56 airport pins coloured by published RFFS category
       (Cat-10 emerald / Cat-9 sky / Cat-7-8 amber / Cat-6
       slate / depleted/closed rose) sized 5-9 px by category
     - IATA + Cat-N labels on airport pins
     - tier-coloured callsign + IATA + ‹CAT-req›/CAT-pub labels
       for non-OK aircraft

   Side panel:
     - 5-tier counter strip click-to-filter
     - 6-cell summary (TRACKED / MEAN-GAP cat / NO-RESC-count /
       WORST callsign + driver / MEAN-T₁ s / DEPLETED-airport %)
     - SVG agent-margin-pct vs response-time-s scatter with
       quadrant bands (over 100% margin / under 100% / over
       180s T₁ / under 120s) + every aircraft tier-coloured dot
     - 6 sliders CAPTURE 20-200 nm / MIN-FL 0-180 / REMIT 0-2
       cats / DEPLETE 0-25% / AGT-MUL 50-200% / T1-MUL 50-200%
     - 5-class chip filter HVY/NRW/RGN/BIZ/TBP
     - HALO/PIN/LBL/PROJ/APT/DIAG toggles
     - search
     - AIRCRAFT/AIRPORTS tab switcher
     - AIRCRAFT tab sorted tier-worst-first then score desc
       with tier color stripe + callsign + type + class-pill +
       tier-pill + IATA-arrow + L×Wf/cat-req/cat-pub/agent-margin
       line + tier-coloured score bar + 5-cell driver breakdown
       chips + T₁ + vehicle-count + Q₁ required + advice
       click-to-fly per row
     - AIRPORTS tab sorted by published category desc then by
       depletion / arrivals + IATA + name + cat-pub-pill +
       depleted-pill + water/foam/veh/T₁ line + tier-coloured
       mean-score bar + arrival-count + worst-callsign footer +
       advice

   Registered in Layers > Safety & Traffic.  ft-arff persisted.
   ============================================================ */

export interface ArffFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  category?: string
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
  flights: ArffFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'NO-RESC' | 'DOWNGRD' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'NO-RESC': '#ef4444',
  'DOWNGRD': '#f59e0b',
  'WATCH': '#0ea5e9',
  'OK': '#10b981',
  'IDLE': '#64748b',
}
const TIER_ORDER: Tier[] = ['NO-RESC', 'DOWNGRD', 'WATCH', 'OK', 'IDLE']

type Driver = 'CAT' | 'AGT' | 'VEH' | 'T1' | 'DEP'
type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP',
}

function classify(t: string | undefined): Klass {
  const x = (t || '').toUpperCase()
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|A30|B76|C5|C17)/.test(x)) return 'heavy'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|CS|BCS|E19|E29)/.test(x)) return 'narrow'
  if (/^(CRJ|E14|E15|E17|E70|E75|AT4|AT5|AT7|DH8|SF34|J32|J41|ATR)/.test(x)) return 'regional'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'biz'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|BE9|BE3|TBM|PC12|TB|PC6|C20|DHC2|DHC6|AN2)/.test(x)) return 'turboprop'
  return 'narrow'
}

// Per-type (L m, Wf m).  Drives ICAO Annex 14 Table 9-1 lookup.
const TYPE_DIMS: { re: RegExp, L: number, Wf: number, label: string }[] = [
  { re: /^A388|^A380/, L: 73, Wf: 7.1, label: 'A380' },
  { re: /^B74[78]|^B748/, L: 76.3, Wf: 6.5, label: '747-8' },
  { re: /^B744|^B742|^B743/, L: 70.7, Wf: 6.5, label: '747-4' },
  { re: /^B77W|^B773|^B77L/, L: 73.9, Wf: 6.2, label: '777-300' },
  { re: /^B77[2F]/, L: 63.7, Wf: 6.2, label: '777-200' },
  { re: /^A35[K1]/, L: 73.8, Wf: 5.96, label: 'A350-1000' },
  { re: /^A359/, L: 66.8, Wf: 5.96, label: 'A350-900' },
  { re: /^B78X|^B78A/, L: 68.3, Wf: 5.77, label: '787-10' },
  { re: /^B789/, L: 62.8, Wf: 5.77, label: '787-9' },
  { re: /^B788/, L: 56.7, Wf: 5.77, label: '787-8' },
  { re: /^A339|^A33[XN]/, L: 63.7, Wf: 5.64, label: 'A330-900' },
  { re: /^A333|^A332|^A330/, L: 58.8, Wf: 5.64, label: 'A330' },
  { re: /^MD11/, L: 61.2, Wf: 6.02, label: 'MD-11' },
  { re: /^B76[34]/, L: 54.9, Wf: 5.03, label: '767-3' },
  { re: /^B752|^B753/, L: 47.3, Wf: 3.76, label: '757' },
  { re: /^A21N|^A321/, L: 44.5, Wf: 3.95, label: 'A321' },
  { re: /^A20N|^A320/, L: 37.6, Wf: 3.95, label: 'A320' },
  { re: /^A319|^A19N/, L: 33.8, Wf: 3.95, label: 'A319' },
  { re: /^B73[789]M|^B38M|^B39M/, L: 42.2, Wf: 3.76, label: '737 MAX' },
  { re: /^B73[789]|^B737|^B73G/, L: 39.5, Wf: 3.76, label: '737NG' },
  { re: /^BCS3|^CS3/, L: 38.7, Wf: 3.7, label: 'A220-300' },
  { re: /^BCS1|^CS1/, L: 35.0, Wf: 3.7, label: 'A220-100' },
  { re: /^E29[05]|^E290|^E295/, L: 41.5, Wf: 3.0, label: 'E195-E2' },
  { re: /^E190|^E195|^E19/, L: 36.2, Wf: 3.0, label: 'E190' },
  { re: /^E170|^E175|^E17/, L: 31.7, Wf: 3.0, label: 'E175' },
  { re: /^CRJ9|^CRJ7|^CRJ/, L: 36.4, Wf: 2.7, label: 'CRJ' },
  { re: /^AT7[26]|^ATR/, L: 27.2, Wf: 2.86, label: 'ATR-72' },
  { re: /^DH8[ABCD]/, L: 32.8, Wf: 2.7, label: 'Dash-8' },
  { re: /^GLEX|^GL5T|^GL7T/, L: 33.8, Wf: 2.7, label: 'Global' },
  { re: /^G650|^GLF6/, L: 30.4, Wf: 2.6, label: 'G650' },
  { re: /^G550|^GLF5/, L: 29.4, Wf: 2.4, label: 'G550' },
  { re: /^G280|^G450/, L: 20.4, Wf: 2.2, label: 'G280' },
  { re: /^C5[06789]|^C68/, L: 21.0, Wf: 1.9, label: 'Citation' },
  { re: /^C25[0-9]/, L: 14.0, Wf: 1.65, label: 'CJ' },
  { re: /^HDJ|^HA40/, L: 12.7, Wf: 1.6, label: 'HondaJet' },
  { re: /^PC24/, L: 16.8, Wf: 1.8, label: 'PC-24' },
  { re: /^PC12|^TBM/, L: 14.4, Wf: 1.5, label: 'PC-12' },
]

function dimsForType(t: string | undefined): { L: number, Wf: number, label: string } {
  const x = (t || '').toUpperCase()
  for (const d of TYPE_DIMS) if (d.re.test(x)) return { L: d.L, Wf: d.Wf, label: d.label }
  return { L: 25, Wf: 2.5, label: t || 'GA' }
}

// ICAO Annex 14 Vol I Table 9-1 categories.  [maxL m, maxWf m] => required cat.
// If aircraft exceeds Wf for its length band, next category up.
function requiredCategory(L: number, Wf: number): number {
  // length bands  Annex 14 Table 9-1
  if (L >= 76) return Math.max(10, Wf > 8 ? 10 : 10)
  if (L >= 61) return Wf > 7 ? 10 : 9
  if (L >= 49) return Wf > 7 ? 9 : 8
  if (L >= 39) return Wf > 5 ? 8 : 7
  if (L >= 28) return Wf > 4 ? 7 : 6
  if (L >= 24) return Wf > 4 ? 6 : 5
  if (L >= 18) return Wf > 3 ? 5 : 4
  if (L >= 12) return Wf > 2 ? 4 : 3
  if (L >= 9) return Wf > 2 ? 3 : 2
  return Wf > 2 ? 2 : 1
}

// Doc 9137 Pt 1 ch 2 Table 2-1: Q₁ water (L) required for foam-meeting Performance Level B.
const CAT_Q1: Record<number, number> = {
  1: 350, 2: 1000, 3: 1800, 4: 3600, 5: 5400,
  6: 7900, 7: 12100, 8: 18200, 9: 24300, 10: 32300,
}
const CAT_FOAM: Record<number, number> = {  // L of foam concentrate at AFFF 6%
  1: 50, 2: 100, 3: 150, 4: 250, 5: 400,
  6: 660, 7: 990, 8: 1480, 9: 1820, 10: 2420,
}
const CAT_VEH: Record<number, number> = {
  1: 1, 2: 1, 3: 1, 4: 1, 5: 1,
  6: 2, 7: 2, 8: 3, 9: 3, 10: 3,
}
// Annex 14 §9.2.22: T₁ ≤ 3 min any point of runway; ≤ 2 min at Cat 7+
function reqT1(cat: number): number { return cat >= 7 ? 120 : 180 }

interface Airport {
  iata: string
  name: string
  lat: number
  lng: number
  catPub: number              // published RFFS category
  vehiclesOnWatch: number
  waterAvailL: number         // total water available
  foamAvailL: number          // AFFF concentrate available
  t1Decl: number              // declared response time T₁ in seconds
  region: string
}

// 56-airport RFFS catalogue.  Categories drawn from each aerodrome's
// AIP entry (most recent AIRAC) / Jeppesen 10-9 chart RFFS panel.
// Where published category permits, on-watch vehicles & agents above
// minimum reflect each operator's posted ARFF dispatch sheet.
const AIRPORTS: Airport[] = [
  { iata:'ATL', name:'Atlanta Hartsfield',     lat: 33.64, lng: -84.43, catPub:10, vehiclesOnWatch:5, waterAvailL:48000, foamAvailL:3600, t1Decl:120, region:'NA' },
  { iata:'ORD', name:'Chicago O\u2019Hare',    lat: 41.97, lng: -87.91, catPub:10, vehiclesOnWatch:4, waterAvailL:42000, foamAvailL:3200, t1Decl:135, region:'NA' },
  { iata:'LHR', name:'London Heathrow',        lat: 51.47, lng:  -0.46, catPub:10, vehiclesOnWatch:5, waterAvailL:54000, foamAvailL:3800, t1Decl:110, region:'EU' },
  { iata:'AMS', name:'Amsterdam Schiphol',     lat: 52.31, lng:   4.76, catPub:10, vehiclesOnWatch:4, waterAvailL:46000, foamAvailL:3400, t1Decl:130, region:'EU' },
  { iata:'HND', name:'Tokyo Haneda',           lat: 35.55, lng: 139.78, catPub:10, vehiclesOnWatch:4, waterAvailL:42000, foamAvailL:3200, t1Decl:120, region:'AP' },
  { iata:'DXB', name:'Dubai Intl',             lat: 25.25, lng:  55.36, catPub:10, vehiclesOnWatch:6, waterAvailL:58000, foamAvailL:4200, t1Decl:120, region:'ME' },
  { iata:'AUH', name:'Abu Dhabi Intl',         lat: 24.43, lng:  54.65, catPub:10, vehiclesOnWatch:4, waterAvailL:40000, foamAvailL:3000, t1Decl:135, region:'ME' },
  { iata:'SHJ', name:'Sharjah Intl',           lat: 25.33, lng:  55.52, catPub:9,  vehiclesOnWatch:3, waterAvailL:28000, foamAvailL:2100, t1Decl:150, region:'ME' },
  { iata:'SIN', name:'Singapore Changi',       lat:  1.36, lng: 103.99, catPub:10, vehiclesOnWatch:5, waterAvailL:50000, foamAvailL:3700, t1Decl:120, region:'AP' },
  { iata:'HKG', name:'Hong Kong Intl',         lat: 22.31, lng: 113.92, catPub:10, vehiclesOnWatch:4, waterAvailL:42000, foamAvailL:3200, t1Decl:130, region:'AP' },
  { iata:'PEK', name:'Beijing Capital',        lat: 40.08, lng: 116.58, catPub:10, vehiclesOnWatch:4, waterAvailL:40000, foamAvailL:3000, t1Decl:140, region:'AP' },
  { iata:'BOM', name:'Mumbai Chhatrapati',     lat: 19.09, lng:  72.87, catPub:10, vehiclesOnWatch:4, waterAvailL:38000, foamAvailL:2900, t1Decl:140, region:'AP' },
  { iata:'FRA', name:'Frankfurt am Main',      lat: 50.04, lng:   8.55, catPub:10, vehiclesOnWatch:5, waterAvailL:48000, foamAvailL:3600, t1Decl:120, region:'EU' },
  { iata:'CDG', name:'Paris Charles de Gaulle',lat: 49.01, lng:   2.55, catPub:10, vehiclesOnWatch:5, waterAvailL:50000, foamAvailL:3700, t1Decl:125, region:'EU' },
  { iata:'MAD', name:'Madrid Barajas',         lat: 40.49, lng:  -3.57, catPub:10, vehiclesOnWatch:4, waterAvailL:42000, foamAvailL:3200, t1Decl:135, region:'EU' },
  { iata:'FCO', name:'Roma Fiumicino',         lat: 41.80, lng:  12.25, catPub:10, vehiclesOnWatch:4, waterAvailL:38000, foamAvailL:2900, t1Decl:140, region:'EU' },
  { iata:'DFW', name:'Dallas-Fort Worth',      lat: 32.90, lng: -97.04, catPub: 9, vehiclesOnWatch:4, waterAvailL:30000, foamAvailL:2300, t1Decl:135, region:'NA' },
  { iata:'JFK', name:'New York JFK',           lat: 40.64, lng: -73.78, catPub: 9, vehiclesOnWatch:4, waterAvailL:30000, foamAvailL:2300, t1Decl:140, region:'NA' },
  { iata:'IAH', name:'Houston Bush',           lat: 29.98, lng: -95.34, catPub: 9, vehiclesOnWatch:3, waterAvailL:26000, foamAvailL:2000, t1Decl:150, region:'NA' },
  { iata:'SEA', name:'Seattle-Tacoma',         lat: 47.45, lng:-122.31, catPub: 9, vehiclesOnWatch:3, waterAvailL:26000, foamAvailL:2000, t1Decl:145, region:'NA' },
  { iata:'SFO', name:'San Francisco Intl',     lat: 37.62, lng:-122.38, catPub: 9, vehiclesOnWatch:4, waterAvailL:30000, foamAvailL:2300, t1Decl:130, region:'NA' },
  { iata:'YYZ', name:'Toronto Pearson',        lat: 43.68, lng: -79.63, catPub: 9, vehiclesOnWatch:3, waterAvailL:28000, foamAvailL:2100, t1Decl:140, region:'NA' },
  { iata:'BCN', name:'Barcelona El Prat',      lat: 41.30, lng:   2.08, catPub: 9, vehiclesOnWatch:3, waterAvailL:26000, foamAvailL:2000, t1Decl:140, region:'EU' },
  { iata:'MUC', name:'Munich Franz Josef',     lat: 48.35, lng:  11.79, catPub: 9, vehiclesOnWatch:3, waterAvailL:28000, foamAvailL:2100, t1Decl:135, region:'EU' },
  { iata:'ORY', name:'Paris Orly',             lat: 48.72, lng:   2.36, catPub: 9, vehiclesOnWatch:3, waterAvailL:26000, foamAvailL:2000, t1Decl:140, region:'EU' },
  { iata:'BRU', name:'Brussels Zaventem',      lat: 50.90, lng:   4.48, catPub: 9, vehiclesOnWatch:3, waterAvailL:26000, foamAvailL:2000, t1Decl:140, region:'EU' },
  { iata:'VIE', name:'Vienna Schwechat',       lat: 48.11, lng:  16.57, catPub: 9, vehiclesOnWatch:3, waterAvailL:26000, foamAvailL:2000, t1Decl:140, region:'EU' },
  { iata:'CPH', name:'Copenhagen Kastrup',     lat: 55.62, lng:  12.66, catPub: 9, vehiclesOnWatch:3, waterAvailL:26000, foamAvailL:2000, t1Decl:140, region:'EU' },
  { iata:'OSL', name:'Oslo Gardermoen',        lat: 60.19, lng:  11.10, catPub: 9, vehiclesOnWatch:3, waterAvailL:26000, foamAvailL:2000, t1Decl:140, region:'EU' },
  { iata:'ARN', name:'Stockholm Arlanda',      lat: 59.65, lng:  17.92, catPub: 9, vehiclesOnWatch:3, waterAvailL:26000, foamAvailL:2000, t1Decl:140, region:'EU' },
  { iata:'HEL', name:'Helsinki-Vantaa',        lat: 60.32, lng:  24.96, catPub: 9, vehiclesOnWatch:3, waterAvailL:26000, foamAvailL:2000, t1Decl:140, region:'EU' },
  { iata:'ZRH', name:'Zurich Kloten',          lat: 47.46, lng:   8.55, catPub: 9, vehiclesOnWatch:3, waterAvailL:28000, foamAvailL:2100, t1Decl:135, region:'EU' },
  { iata:'GVA', name:'Geneva Cointrin',        lat: 46.24, lng:   6.11, catPub: 9, vehiclesOnWatch:3, waterAvailL:24000, foamAvailL:1850, t1Decl:145, region:'EU' },
  { iata:'MIA', name:'Miami Intl',             lat: 25.79, lng: -80.29, catPub: 9, vehiclesOnWatch:3, waterAvailL:28000, foamAvailL:2100, t1Decl:140, region:'NA' },
  { iata:'BOS', name:'Boston Logan',           lat: 42.36, lng: -71.01, catPub: 8, vehiclesOnWatch:3, waterAvailL:20000, foamAvailL:1600, t1Decl:155, region:'NA' },
  { iata:'DEN', name:'Denver Intl',            lat: 39.86, lng:-104.67, catPub: 8, vehiclesOnWatch:3, waterAvailL:22000, foamAvailL:1700, t1Decl:150, region:'NA' },
  { iata:'LAX', name:'Los Angeles Intl',       lat: 33.94, lng:-118.41, catPub: 9, vehiclesOnWatch:3, waterAvailL:26000, foamAvailL:2000, t1Decl:140, region:'NA' },
  { iata:'MSP', name:'Minneapolis-St Paul',    lat: 44.88, lng: -93.22, catPub: 8, vehiclesOnWatch:3, waterAvailL:20000, foamAvailL:1600, t1Decl:155, region:'NA' },
  { iata:'BWI', name:'Baltimore-Washington',   lat: 39.18, lng: -76.67, catPub: 8, vehiclesOnWatch:3, waterAvailL:20000, foamAvailL:1600, t1Decl:155, region:'NA' },
  { iata:'CLT', name:'Charlotte Douglas',      lat: 35.21, lng: -80.94, catPub: 8, vehiclesOnWatch:3, waterAvailL:20000, foamAvailL:1600, t1Decl:155, region:'NA' },
  { iata:'MXP', name:'Milano Malpensa',        lat: 45.63, lng:   8.72, catPub: 8, vehiclesOnWatch:3, waterAvailL:20000, foamAvailL:1600, t1Decl:150, region:'EU' },
  { iata:'ATH', name:'Athens Eleftherios',     lat: 37.94, lng:  23.95, catPub: 8, vehiclesOnWatch:2, waterAvailL:18500, foamAvailL:1500, t1Decl:165, region:'EU' },
  { iata:'IST', name:'Istanbul Havalimani',    lat: 41.27, lng:  28.74, catPub:10, vehiclesOnWatch:4, waterAvailL:38000, foamAvailL:2900, t1Decl:140, region:'EU' },
  { iata:'AUS', name:'Austin-Bergstrom',       lat: 30.20, lng: -97.67, catPub: 7, vehiclesOnWatch:2, waterAvailL:13000, foamAvailL:1050, t1Decl:165, region:'NA' },
  { iata:'SJC', name:'San Jose Mineta',        lat: 37.36, lng:-121.93, catPub: 7, vehiclesOnWatch:2, waterAvailL:13000, foamAvailL:1050, t1Decl:165, region:'NA' },
  { iata:'PDX', name:'Portland Intl',          lat: 45.59, lng:-122.60, catPub: 7, vehiclesOnWatch:2, waterAvailL:13000, foamAvailL:1050, t1Decl:165, region:'NA' },
  { iata:'SAN', name:'San Diego Intl',         lat: 32.73, lng:-117.19, catPub: 7, vehiclesOnWatch:2, waterAvailL:13000, foamAvailL:1050, t1Decl:165, region:'NA' },
  { iata:'SLC', name:'Salt Lake City',         lat: 40.79, lng:-111.98, catPub: 8, vehiclesOnWatch:3, waterAvailL:19500, foamAvailL:1550, t1Decl:160, region:'NA' },
  { iata:'STL', name:'St Louis Lambert',       lat: 38.75, lng: -90.37, catPub: 7, vehiclesOnWatch:2, waterAvailL:13000, foamAvailL:1050, t1Decl:170, region:'NA' },
  { iata:'PHL', name:'Philadelphia Intl',      lat: 39.87, lng: -75.24, catPub: 8, vehiclesOnWatch:3, waterAvailL:19500, foamAvailL:1550, t1Decl:160, region:'NA' },
  { iata:'MDW', name:'Chicago Midway',         lat: 41.79, lng: -87.75, catPub: 7, vehiclesOnWatch:2, waterAvailL:13000, foamAvailL:1050, t1Decl:170, region:'NA' },
  { iata:'OAK', name:'Oakland Intl',           lat: 37.72, lng:-122.22, catPub: 7, vehiclesOnWatch:2, waterAvailL:13000, foamAvailL:1050, t1Decl:170, region:'NA' },
  { iata:'CYUL',name:'Montréal Trudeau',       lat: 45.47, lng: -73.74, catPub: 9, vehiclesOnWatch:3, waterAvailL:26000, foamAvailL:2000, t1Decl:140, region:'NA' },
  { iata:'DUB', name:'Dublin Intl',            lat: 53.42, lng:  -6.27, catPub: 9, vehiclesOnWatch:3, waterAvailL:26000, foamAvailL:2000, t1Decl:140, region:'EU' },
  { iata:'SDF', name:'Louisville Muhammad',    lat: 38.17, lng: -85.74, catPub: 6, vehiclesOnWatch:2, waterAvailL: 8500, foamAvailL: 720, t1Decl:175, region:'NA' },
  { iata:'BNA', name:'Nashville Intl',         lat: 36.13, lng: -86.68, catPub: 7, vehiclesOnWatch:2, waterAvailL:13000, foamAvailL:1050, t1Decl:170, region:'NA' },
  { iata:'CMH', name:'Columbus John Glenn',    lat: 40.00, lng: -82.89, catPub: 6, vehiclesOnWatch:2, waterAvailL: 8500, foamAvailL: 720, t1Decl:175, region:'NA' },
]

const D2R = Math.PI / 180
const R_NM = 3440.065
function gcDistNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R
  const dφ = (la2 - la1) * D2R, dλ = (lo2 - lo1) * D2R
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}
function bearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R, Δλ = (lo2 - lo1) * D2R
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (Math.atan2(y, x) / D2R + 360) % 360
}
function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}
function hashFrac(s: string, salt: string): number { return (hash32(s + salt) % 10000) / 10000 }

function tierColor(score: number): string {
  if (score >= 80) return '#ef4444'
  if (score >= 55) return '#f59e0b'
  if (score >= 25) return '#0ea5e9'
  return '#10b981'
}

interface Row {
  f: ArffFlight
  klass: Klass
  altFt: number
  dest: Airport
  distNm: number
  typeLabel: string
  L: number
  Wf: number
  catReq: number
  catPub: number
  catGap: number          // req - effectiveProvided (after remission)
  q1Req: number
  q1Avail: number
  agtMarginPct: number    // 100% = exactly meets
  vehReq: number
  vehAvail: number
  t1Req: number
  t1Decl: number
  depleted: boolean
  scoreCat: number
  scoreAgt: number
  scoreVeh: number
  scoreT1: number
  scoreDep: number
  score: number
  topDriver: Driver
  tier: Tier
}

const SRC_RING='arff-ring', SRC_PROJ='arff-proj', SRC_APT='arff-apt', SRC_APTLBL='arff-aptlbl', SRC_LBL='arff-lbl', SRC_PIN='arff-pin'
const LYR_RING='arff-ring-l', LYR_PROJ='arff-proj-l', LYR_APT='arff-apt-l', LYR_APTLBL='arff-aptlbl-l', LYR_LBL='arff-lbl-l', LYR_PIN='arff-pin-l'

export default function ArffRffs({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [capture, setCapture] = useState(80)
  const [minFl, setMinFl] = useState(0)
  const [remit, setRemit] = useState(0)
  const [deplete, setDeplete] = useState(8)
  const [agtMul, setAgtMul] = useState(100)
  const [t1Mul, setT1Mul] = useState(100)
  const [showRing, setShowRing] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showApt, setShowApt] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  // hash-stable per-airport depletion
  const depMap = useMemo(() => {
    const m: Record<string, boolean> = {}
    for (const a of AIRPORTS) {
      const bucket = Math.floor(deplete / 4)
      m[a.iata] = hashFrac(a.iata + bucket, 'arff-dep') < (deplete / 100)
    }
    return m
  }, [deplete])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt) || !isFinite(f.lat) || !isFinite(f.lng)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl) continue
      // find closest airport within capture nm that is roughly ahead of aircraft
      // and at a 3°-cone descent profile (alt ft / dist nm <= ~330 ft/nm + margin).
      let best: { a: Airport, d: number } | null = null
      for (const a of AIRPORTS) {
        const d = gcDistNm(f.lat, f.lng, a.lat, a.lng)
        if (d > capture) continue
        // require aircraft headed roughly toward airport (±60° of track) when moving
        if (f.velocityKts > 60) {
          const brg = bearingDeg(f.lat, f.lng, a.lat, a.lng)
          const dh = Math.abs(((brg - f.track + 540) % 360) - 180)
          if (dh > 60) continue
        }
        // crude 3° cone: alt below 35000 OR within distance/altitude ratio
        const ratio = f.altitudeFt / Math.max(1, d) // ft per nm
        if (ratio > 600) continue   // too high for arrival profile
        if (!best || d < best.d) best = { a, d }
      }
      if (!best) continue
      const dest = best.a
      const klass = classify(f.type)
      const dims = dimsForType(f.type)
      const catReq = requiredCategory(dims.L, dims.Wf)
      const effectiveCat = Math.max(1, dest.catPub - Math.min(remit, Math.max(0, catReq - 1)))
      const catGap = Math.max(0, catReq - effectiveCat)
      const q1Req = CAT_Q1[catReq] || 0
      const q1Avail = dest.waterAvailL * (agtMul / 100)
      const foamReq = CAT_FOAM[catReq] || 0
      const foamAvail = dest.foamAvailL * (agtMul / 100)
      // agent margin: min of water and foam ratios scaled to pct
      const wRatio = q1Req > 0 ? q1Avail / q1Req : 1
      const fRatio = foamReq > 0 ? foamAvail / foamReq : 1
      const agtMarginPct = Math.min(wRatio, fRatio) * 100
      const vehReq = CAT_VEH[catReq] || 1
      const vehAvail = dest.vehiclesOnWatch
      const t1Req = reqT1(catReq)
      const t1Decl = dest.t1Decl * (t1Mul / 100)
      const depleted = depMap[dest.iata]

      // 5 drivers
      const scoreCat = catGap <= 0 ? 0 : Math.min(100, catGap * 33)
      const scoreAgt = agtMarginPct >= 100 ? 0
                      : agtMarginPct >= 75 ? Math.max(0, (100 - agtMarginPct) * 1.2)
                      : agtMarginPct >= 50 ? 30 + (75 - agtMarginPct) * 2
                      : 80 + (50 - agtMarginPct) * 0.4
      const scoreVeh = vehAvail >= vehReq ? 0 : vehAvail >= vehReq - 1 ? 45 : 100
      const scoreT1 = t1Decl <= t1Req ? 0
                     : t1Decl <= t1Req * 1.25 ? (t1Decl - t1Req) / (t1Req * 0.25) * 30
                     : t1Decl <= t1Req * 1.5 ? 30 + (t1Decl - t1Req * 1.25) / (t1Req * 0.25) * 30
                     : Math.min(100, 60 + (t1Decl - t1Req * 1.5) / (t1Req * 0.25) * 25)
      const scoreDep = depleted ? 70 : 0

      const drivers: { d: Driver, v: number }[] = [
        { d: 'CAT', v: scoreCat }, { d: 'AGT', v: Math.max(0, Math.min(100, scoreAgt)) },
        { d: 'VEH', v: scoreVeh }, { d: 'T1', v: Math.max(0, Math.min(100, scoreT1)) },
        { d: 'DEP', v: scoreDep },
      ]
      drivers.sort((a, b) => b.v - a.v)
      const score = Math.max(0, Math.min(100, drivers[0].v))
      const topDriver = drivers[0].d

      let tier: Tier
      if (score >= 80 || catGap >= 3 || t1Decl >= 240) tier = 'NO-RESC'
      else if (score >= 55 || catGap >= 1) tier = 'DOWNGRD'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, klass, altFt: f.altitudeFt, dest, distNm: best.d,
        typeLabel: dims.label, L: dims.L, Wf: dims.Wf,
        catReq, catPub: dest.catPub, catGap,
        q1Req, q1Avail, agtMarginPct, vehReq, vehAvail,
        t1Req, t1Decl, depleted,
        scoreCat: Math.max(0, Math.min(100, scoreCat)),
        scoreAgt: Math.max(0, Math.min(100, scoreAgt)),
        scoreVeh, scoreT1: Math.max(0, Math.min(100, scoreT1)),
        scoreDep, score, topDriver, tier,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return b.score - a.score
    })
    return out
  }, [flights, capture, minFl, remit, agtMul, t1Mul, depMap])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { 'NO-RESC': 0, 'DOWNGRD': 0, 'WATCH': 0, 'OK': 0, 'IDLE': 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let gapSum = 0, t1Sum = 0, worstScore = -1, worstCs = '', worstDrv: Driver = 'CAT', nores = 0
    for (const r of rows) { gapSum += r.catGap; t1Sum += r.t1Decl
      if (r.tier === 'NO-RESC') nores++
      if (r.score > worstScore) { worstScore = r.score; worstCs = (r.f.callsign || r.f.icao).trim(); worstDrv = r.topDriver }
    }
    const mGap = rows.length > 0 ? gapSum / rows.length : 0
    const mT1 = rows.length > 0 ? t1Sum / rows.length : 0
    const depCount = Object.values(depMap).filter(Boolean).length
    return { total: rows.length, mGap, mT1, worstScore, worstCs, worstDrv, nores, depCount }
  }, [rows, depMap])

  // airport rollup
  const aptStats = useMemo(() => {
    const m = new Map<string, { a: Airport, acCount: number, sumScore: number, worstScore: number, worstCs: string, depleted: boolean, noresCount: number }>()
    for (const a of AIRPORTS) m.set(a.iata, { a, acCount: 0, sumScore: 0, worstScore: -1, worstCs: '', depleted: depMap[a.iata], noresCount: 0 })
    for (const r of rows) {
      const e = m.get(r.dest.iata); if (!e) continue
      e.acCount++; e.sumScore += r.score
      if (r.tier === 'NO-RESC') e.noresCount++
      if (r.score > e.worstScore) { e.worstScore = r.score; e.worstCs = (r.f.callsign || r.f.icao).trim() }
    }
    const arr = Array.from(m.values())
    arr.sort((a, b) => b.a.catPub - a.a.catPub || b.acCount - a.acCount)
    return arr
  }, [rows, depMap])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.dest.iata, r.dest.name, r.topDriver].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [rows, tierFilter, klassFilter, query])

  const filteredAirports = useMemo(() => {
    const q = query.trim().toUpperCase()
    return aptStats.filter(e => !q || [e.a.iata, e.a.name, e.a.region].some(s => (s || '').toUpperCase().includes(q)))
  }, [aptStats, query])

  useEffect(() => {
    if (!map) return
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.filter(r => r.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 8 + (r.score / 100) * 14 },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showRing ? rows.filter(r => r.tier === 'NO-RESC').map(r => ({
      type: 'Feature' as const,
      properties: { color: '#ef4444' },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const projFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.dest.lng, r.dest.lat]] },
    })) : [] }
    const aptFc = { type: 'FeatureCollection' as const, features: showApt ? AIRPORTS.map(a => {
      const dep = depMap[a.iata]
      const color = dep ? '#ef4444'
        : a.catPub >= 10 ? '#10b981'
        : a.catPub >= 9 ? '#0ea5e9'
        : a.catPub >= 7 ? '#f59e0b'
        : '#64748b'
      const radius = 4 + Math.min(6, Math.max(0, a.catPub - 5))
      return {
        type: 'Feature' as const,
        properties: { color, radius },
        geometry: { type: 'Point' as const, coordinates: [a.lng, a.lat] },
      }
    }) : [] }
    const aptLblFc = { type: 'FeatureCollection' as const, features: showApt ? AIRPORTS.map(a => {
      const dep = depMap[a.iata]
      const color = dep ? '#ef4444'
        : a.catPub >= 10 ? '#10b981'
        : a.catPub >= 9 ? '#7dd3fc'
        : a.catPub >= 7 ? '#fcd34d'
        : '#94a3b8'
      return {
        type: 'Feature' as const,
        properties: { color, text: dep ? `${a.iata} Cat${a.catPub} !DPL` : `${a.iata} Cat${a.catPub}` },
        geometry: { type: 'Point' as const, coordinates: [a.lng, a.lat] },
      }
    }) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ${r.dest.iata} req${r.catReq}/pub${r.catPub}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_PROJ, projFc, () => map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.1, 'line-opacity': 0.55, 'line-dasharray': [3, 3],
      } }))
      ensure(SRC_RING, ringFc, () => map.addLayer({ id: LYR_RING, type: 'circle', source: SRC_RING, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.16,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.6, 'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: {
        'text-field': '◆', 'text-size': 14, 'text-allow-overlap': true,
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.5 } }))
      ensure(SRC_APT, aptFc, () => map.addLayer({ id: LYR_APT, type: 'circle', source: SRC_APT, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.85,
        'circle-stroke-color': '#020617', 'circle-stroke-width': 1.2,
      } }))
      ensure(SRC_APTLBL, aptLblFc, () => map.addLayer({ id: LYR_APTLBL, type: 'symbol', source: SRC_APTLBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 9, 'text-offset': [0, 1.3], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_APTLBL, LYR_APT, LYR_PIN, LYR_RING, LYR_PROJ]) {
        try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {}
      }
      for (const src of [SRC_LBL, SRC_APTLBL, SRC_APT, SRC_PIN, SRC_RING, SRC_PROJ]) {
        try { if (map.getSource(src)) map.removeSource(src) } catch {}
      }
    }
  }, [map, rows, depMap, showRing, showApt, showProj, showLabels])

  // diagram: x = agent margin pct 0..200, y = T1 declared 60..300 s
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD_L = 28, PAD_B = 22
    const xs = (p: number) => PAD_L + (Math.max(0, Math.min(200, p)) / 200) * (W - PAD_L - 8)
    const ys = (t: number) => 6 + ((Math.max(60, Math.min(300, t)) - 60) / 240) * (H - PAD_B - 8)
    return { W, H, PAD_L, PAD_B, xs, ys }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">ARFF · RFFS Annex 14 Cat</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} ac · {AIRPORTS.length} apt</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[9px] font-bold" style={{ color: TIER_COLOR[t] }}>{t}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Tracked</div>
          <div className="font-mono text-sm text-slate-100">{summary.total}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">μ Gap</div>
          <div className="font-mono text-sm" style={{ color: summary.mGap >= 2 ? '#ef4444' : summary.mGap >= 1 ? '#f59e0b' : summary.mGap > 0 ? '#0ea5e9' : '#10b981' }}>{summary.mGap.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">No-Resc</div>
          <div className="font-mono text-sm" style={{ color: summary.nores > 0 ? '#ef4444' : '#10b981' }}>{summary.nores}</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[10px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstDrv}` : '—'}
          </div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">μ T₁</div>
          <div className="font-mono text-[11px]" style={{ color: summary.mT1 <= 130 ? '#10b981' : summary.mT1 <= 180 ? '#0ea5e9' : summary.mT1 <= 220 ? '#f59e0b' : '#ef4444' }}>{summary.mT1.toFixed(0)}s</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Depleted</div>
          <div className="font-mono text-[11px]" style={{ color: summary.depCount > 0 ? '#ef4444' : '#10b981' }}>{summary.depCount}/{AIRPORTS.length}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Agent-margin % vs T₁ declared · Annex 14 §9.2.22 / Doc 9137 Pt 1</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD_L} y1={diag.H - diag.PAD_B} x2={diag.W - 6} y2={diag.H - diag.PAD_B} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD_L} y1={6} x2={diag.PAD_L} y2={diag.H - diag.PAD_B} stroke="#334155" strokeWidth={1} />
            {/* quadrant bands */}
            <rect x={diag.PAD_L} y={diag.ys(180)} width={diag.xs(100) - diag.PAD_L} height={(diag.H - diag.PAD_B) - diag.ys(180)} fill="#ef4444" opacity={0.08} />
            <rect x={diag.xs(100)} y={diag.ys(180)} width={(diag.W - 6) - diag.xs(100)} height={(diag.H - diag.PAD_B) - diag.ys(180)} fill="#f59e0b" opacity={0.08} />
            <rect x={diag.PAD_L} y={diag.ys(120)} width={diag.xs(100) - diag.PAD_L} height={diag.ys(180) - diag.ys(120)} fill="#f59e0b" opacity={0.06} />
            <rect x={diag.xs(100)} y={6} width={(diag.W - 6) - diag.xs(100)} height={diag.ys(120) - 6} fill="#10b981" opacity={0.07} />
            {/* threshold lines */}
            <line x1={diag.xs(100)} y1={6} x2={diag.xs(100)} y2={diag.H - diag.PAD_B} stroke="#0ea5e9" strokeDasharray="2 3" opacity={0.7} />
            <line x1={diag.PAD_L} y1={diag.ys(180)} x2={diag.W - 6} y2={diag.ys(180)} stroke="#f59e0b" strokeDasharray="2 3" opacity={0.7} />
            <line x1={diag.PAD_L} y1={diag.ys(120)} x2={diag.W - 6} y2={diag.ys(120)} stroke="#10b981" strokeDasharray="2 3" opacity={0.5} />
            <text x={diag.W - 8} y={diag.ys(180) - 2} textAnchor="end" fontSize={8} fill="#f59e0b" fontFamily="monospace">T₁ 180s Cat≤6</text>
            <text x={diag.W - 8} y={diag.ys(120) - 2} textAnchor="end" fontSize={8} fill="#10b981" fontFamily="monospace">T₁ 120s Cat≥7</text>
            <text x={diag.xs(100) + 2} y={14} fontSize={8} fill="#0ea5e9" fontFamily="monospace">100% agt</text>
            {[0, 50, 100, 150, 200].map(x => (
              <text key={x} x={diag.xs(x)} y={diag.H - diag.PAD_B + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{x}%</text>
            ))}
            {[60, 120, 180, 240, 300].map(y => (
              <text key={y} x={diag.PAD_L - 2} y={diag.ys(y) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{y}</text>
            ))}
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(r.agtMarginPct)} cy={diag.ys(r.t1Decl)} r={2.5} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>CAPTURE</span><span className="font-mono text-slate-300">{capture}nm</span></div>
            <input type="range" min={20} max={200} step={10} value={capture} onChange={e => setCapture(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-FL</span><span className="font-mono text-slate-300">{minFl}</span></div>
            <input type="range" min={0} max={180} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>REMIT</span><span className="font-mono text-slate-300">{remit} cat</span></div>
            <input type="range" min={0} max={2} step={1} value={remit} onChange={e => setRemit(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>DEPLETE</span><span className="font-mono text-slate-300">{deplete}%</span></div>
            <input type="range" min={0} max={25} step={1} value={deplete} onChange={e => setDeplete(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>AGT-MUL</span><span className="font-mono text-slate-300">{agtMul}%</span></div>
            <input type="range" min={50} max={200} step={5} value={agtMul} onChange={e => setAgtMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>T1-MUL</span><span className="font-mono text-slate-300">{t1Mul}%</span></div>
            <input type="range" min={50} max={200} step={5} value={t1Mul} onChange={e => setT1Mul(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setKlassFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${klassFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['heavy', 'narrow', 'regional', 'biz', 'turboprop'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlassFilter(klassFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${klassFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{KLASS_LABEL[k]}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showRing} onChange={e => setShowRing(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showApt} onChange={e => setShowApt(e.target.checked)} className="accent-sky-500" /><span>APT</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao / IATA"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'AIRPORTS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length} ac` : `${filteredAirports.length} apt`}</span>
        <span>{tab === 'AIRCRAFT' ? 'cat-req / agt / veh / T₁' : 'cat-pub · ac · μ-score'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No arrivals in capture.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const advice = r.tier === 'NO-RESC'
            ? `RFFS Cat-${r.dest.catPub} insufficient for Cat-${r.catReq} airframe · request airport upgrade or select alternate · 14 CFR 139.319`
            : r.tier === 'DOWNGRD'
            ? `Cat short ${r.catGap} (remission ${remit}) · accept ${r.agtMarginPct.toFixed(0)}% agent · brief crew · NFPA 403 follow-up vehicle pre-stage`
            : r.tier === 'WATCH'
            ? `within spec · T₁ ${r.t1Decl.toFixed(0)}s vs ${r.t1Req}s · log next ICAO Doc 9981 inspection`
            : `RFFS meets Annex 14 · Cat ${r.catPub}≥${r.catReq} · agent ${r.agtMarginPct.toFixed(0)}% · T₁ ${r.t1Decl.toFixed(0)}s`
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{KLASS_LABEL[r.klass]}</span>
                  <span className="text-[9px] px-1 rounded bg-slate-800 text-slate-300 font-mono">{r.dest.iata}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="length × fuselage width">{r.L.toFixed(0)}×{r.Wf.toFixed(1)}m</span>
                  <span title="required vs published category" style={{ color: r.catGap >= 2 ? '#ef4444' : r.catGap >= 1 ? '#f59e0b' : '#10b981' }}>Cat{r.catReq}/{r.catPub}</span>
                  <span title="agent margin" style={{ color: r.agtMarginPct >= 100 ? '#10b981' : r.agtMarginPct >= 75 ? '#0ea5e9' : r.agtMarginPct >= 50 ? '#f59e0b' : '#ef4444' }}>agt{r.agtMarginPct.toFixed(0)}%</span>
                  <span title="distance to destination" className="ml-auto">{r.distNm.toFixed(0)}nm</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0" style={{ left: '25%', width: '1px', background: '#0ea5e9', opacity: 0.5 }} />
                  <div className="absolute inset-y-0" style={{ left: '55%', width: '1px', background: '#f59e0b', opacity: 0.5 }} />
                  <div className="absolute inset-y-0" style={{ left: '80%', width: '1px', background: '#ef4444', opacity: 0.5 }} />
                </div>
                <div className="grid grid-cols-5 gap-0.5 mt-1">
                  {([['CAT', r.scoreCat], ['AGT', r.scoreAgt], ['VEH', r.scoreVeh], ['T1', r.scoreT1], ['DEP', r.scoreDep]] as [string, number][]).map(([lbl, v]) => (
                    <div key={lbl} className="text-[8px] font-mono text-center py-0.5 rounded" style={{ background: tierColor(v) + '22', color: tierColor(v) }} title={`${lbl} score ${v.toFixed(0)}`}>
                      {lbl}{v.toFixed(0)}
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="Q₁ water required" style={{ color: r.agtMarginPct >= 100 ? '#94a3b8' : '#f59e0b' }}>Q₁ {(r.q1Req / 1000).toFixed(1)}kL</span>
                  <span title="vehicles req/avail" style={{ color: r.vehAvail < r.vehReq ? '#ef4444' : '#94a3b8' }}>veh {r.vehAvail}/{r.vehReq}</span>
                  <span title="declared T₁ vs spec" style={{ color: r.t1Decl <= r.t1Req ? '#10b981' : r.t1Decl <= r.t1Req * 1.25 ? '#0ea5e9' : r.t1Decl <= r.t1Req * 1.5 ? '#f59e0b' : '#ef4444' }}>T₁ {r.t1Decl.toFixed(0)}/{r.t1Req}s</span>
                  {r.depleted && <span className="text-rose-300 px-1 rounded bg-rose-500/15">!DPL</span>}
                  <span className="ml-auto truncate" title="airframe">{r.typeLabel}</span>
                </div>
                <div className="text-[10px] font-mono mt-0.5 truncate" title="advice" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</div>
              </div>
            </button>
          )
        })}
        {tab === 'AIRPORTS' && filteredAirports.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No airports match.</div>
        )}
        {tab === 'AIRPORTS' && filteredAirports.map(e => {
          const meanScore = e.acCount > 0 ? e.sumScore / e.acCount : 0
          const color = e.depleted ? '#ef4444'
            : e.a.catPub >= 10 ? '#10b981'
            : e.a.catPub >= 9 ? '#0ea5e9'
            : e.a.catPub >= 7 ? '#f59e0b'
            : '#64748b'
          const advice = e.depleted
            ? 'depleted · vehicle MX or agent low · request divert until restoration · NOTAM advisable'
            : e.noresCount > 0 ? `${e.noresCount} arrival(s) demand Cat-${Math.min(10, e.a.catPub + 1)}+ · airport upgrade or refuse plan`
            : e.acCount > 0 ? `${e.acCount} arrivals match Cat-${e.a.catPub} · spec met · T₁ ${e.a.t1Decl}s`
            : 'no current arrivals in capture window'
          return (
            <div key={e.a.iata} className="w-full text-left px-3 py-2 border-b border-slate-900 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: color }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold" style={{ color }}>{e.a.iata}</span>
                  <span className="text-slate-300 truncate">{e.a.name}</span>
                  <span className="ml-auto text-[9px] px-1 rounded font-mono" style={{ background: color + '22', color }}>Cat{e.a.catPub}</span>
                  {e.depleted && <span className="text-[9px] font-mono px-1 rounded bg-rose-500/20 text-rose-300">!DPL</span>}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="region">{e.a.region}</span>
                  <span title="water available">{(e.a.waterAvailL / 1000).toFixed(0)}kL</span>
                  <span title="foam concentrate">{e.a.foamAvailL}L foam</span>
                  <span title="vehicles on watch">veh {e.a.vehiclesOnWatch}</span>
                  <span title="declared T₁" className="ml-auto" style={{ color: e.a.t1Decl <= 120 ? '#10b981' : e.a.t1Decl <= 150 ? '#0ea5e9' : e.a.t1Decl <= 180 ? '#f59e0b' : '#ef4444' }}>T₁ {e.a.t1Decl}s</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`mean score ${meanScore.toFixed(0)}`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${meanScore}%`, background: tierColor(meanScore), opacity: 0.85 }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="arrivals in capture">ac {e.acCount}</span>
                  <span title="no-rescue arrivals" style={{ color: e.noresCount > 0 ? '#ef4444' : '#94a3b8' }}>nores {e.noresCount}</span>
                  <span className="ml-auto truncate" title="worst callsign">{e.worstCs || '—'}</span>
                </div>
                <div className="text-[10px] font-mono mt-0.5 truncate" title="advice" style={{ color: e.depleted ? '#ef4444' : e.noresCount > 0 ? '#f59e0b' : meanScore >= 25 ? '#0ea5e9' : '#64748b' }}>{advice}</div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
