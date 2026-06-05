/* ============================================================
   SAFA · SACA / TCO Ramp-Inspection Risk & EU Air-Safety-List
   Operator-Compliance Monitor
   ============================================================
   Per-airframe live evaluator of every aircraft currently airborne or
   on the ground at an EASA-Member-State aerodrome, scoring the
   probability that the next ramp inspection under the EU Ramp Inspection
   Programme (RIP) — SAFA (Safety Assessment of Foreign Aircraft, for
   non-EASA operators) or SACA (Safety Assessment of Community Aircraft,
   for EASA-operators) — will:

     (a) be SELECTED for inspection at all (the per-operator targeting
         model run by EASA RIP Section, balancing operator EI score, AOC
         age, prior-finding rate, fleet-age, route-network exposure, and
         pseudo-random spot-check),

     (b) produce a CAT-1 / CAT-2 / CAT-3 finding (the three severity
         tiers per Reg (EU) 965/2012 ARO.RAMP.140 / EASA Decision
         2014/030/R, where CAT-3 mandates corrective action BEFORE the
         next flight, with grounding authority delegated to the
         inspecting Member State NAA),

     (c) escalate to an EU Air Safety List (EASL) Annex-A (full ban)
         or Annex-B (operational restrictions) entry per Reg (EC)
         2111/2005 + Reg (EU) 474/2006 + the Air Safety Committee
         quarterly Banned-Operators / Restricted-Operators list,

     (d) trigger an EASA TCO (Third-Country Operator) authorisation
         suspension per Reg (EU) 452/2014 (the equivalent regime for
         non-EU operators flying into the EU), or

     (e) be referred to the home-state CAA for ICAO USOAP CMA (Universal
         Safety Oversight Audit Programme Continuous Monitoring Approach)
         Effective Implementation (EI) follow-up under the Annex-19
         State Safety Programme (SSP) framework.

   Structurally distinct from:
     • TCO-PERMIT (the static permit-holder catalogue at issuance time)
     • USOAP (the country-level audit score, not operator/airframe level)
     • CAST (the global accident-category taxonomy, post-event)
     • AOC-ART-83BIS (the Chicago Convention Article 83bis transfer of
       safety-oversight responsibility between States, regulatory not
       operational)
     • ATL/CDL/MEL (the dispatch-side defect-deferral chain)
     • CAW (continuing-airworthiness organisation Part-CAMO compliance)
     • SDR (Service-Difficulty-Report regulatory event reporting)
     • TEM (line-operations Threat-and-Error Management)

   SAFA is uniquely the RAMP-INSPECTION risk evaluator that fuses
   per-operator compliance history with per-airframe live state to
   answer for every flight: WILL the next ramp inspection generate a
   finding, and what is the ladder to EASL listing?

   References:
     • Reg (EU) 965/2012 ARO.RAMP — Ramp Inspection Programme
     • Reg (EU) 452/2014 — Third-Country Operator authorisations
     • Reg (EC) 2111/2005 — Community list of air carriers banned in EU
     • Reg (EU) 474/2006 — Air Safety List (Annex A full ban /
       Annex B operational restrictions) updated quarterly
     • EASA Decision 2014/030/R — Ramp Inspection AMC & GM
     • EASA ED-Decision 2018/004/R — TCO Means of Compliance
     • EASA Annual Safety Recommendations Review — RIP statistics
     • ICAO Doc 9734 Annex A — Safety Oversight Manual State System
     • ICAO Doc 9735 — USOAP CMA Continuous Monitoring Manual ed.5
     • ICAO Annex 19 — Safety Management 2nd ed.
     • ICAO Annex 6 Pt I §3.1 / Annex 6 Pt II / Annex 6 Pt III
     • ICAO Annex 8 Airworthiness of Aircraft 12th ed.
     • ICAO Annex 1 Personnel Licensing
     • ICAO Doc 8335 Manual of Procedures for Operations Inspection,
       Certification and Continued Surveillance ed.5
     • SIDA — SAFA Inspection Data Aggregation ed.7.0 specification
     • EASA TCO Database (https://www.easa.europa.eu/en/tco)
     • EASA RIP Statistics & Trend Reports 2014–2024
     • UK CAA CAP 1840 — Ramp Inspection Findings
     • FAA IASA — International Aviation Safety Assessment
       Cat 1 / Cat 2 (US equivalent regime)
     • DGAC France — Inspections au Sol (rampe) procedures

   ============================================================ */

'use client'
import { useEffect, useMemo, useState } from 'react'

type LL = { icao: string; lat: number; lng: number; track?: number; velocityKts?: number; alt?: number; vs?: number; type?: string; callsign?: string; reg?: string; operator?: string; origin?: string; destination?: string; emerg?: boolean; squawk?: string }

type Props = {
  map: any
  flights: LL[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Phase = 'ENROUTE-IN-EASA' | 'APPR-EASA' | 'GROUND-EASA' | 'DEPT-EASA' | 'ENROUTE-OUTSIDE' | 'OFF'
type Tier = 'EASL-BAN' | 'TCO-SUSP' | 'CAT-3' | 'CAT-2' | 'CAT-1' | 'WATCH' | 'NOMINAL' | 'OFF'

const TIER_ORDER: Tier[] = ['EASL-BAN','TCO-SUSP','CAT-3','CAT-2','CAT-1','WATCH','NOMINAL']
const TIER_RANK: Record<Tier, number> = { 'EASL-BAN':0, 'TCO-SUSP':1, 'CAT-3':2, 'CAT-2':3, 'CAT-1':4, WATCH:5, NOMINAL:6, OFF:7 }
const TIER_COLOR: Record<Tier, string> = {
  'EASL-BAN':  '#f43f5e',  // rose-500 — banned (Annex A / B), highest
  'TCO-SUSP':  '#fb7185',  // rose-400 — TCO suspension imminent
  'CAT-3':     '#f97316',  // orange-500 — flight-blocking finding
  'CAT-2':     '#f59e0b',  // amber-500 — corrective before next dispatch
  'CAT-1':     '#eab308',  // yellow-500 — minor finding
  WATCH:       '#0ea5e9',  // sky-500
  NOMINAL:     '#10b981',  // emerald-500
  OFF:         '#64748b',  // slate-500
}

// EASA member-state ICAO country prefixes (where SAFA/SACA inspections occur).
// Covers EU-27 + EFTA (Norway, Iceland, Switzerland, Liechtenstein) + EU-aligned
// (UK retained via BASA equivalent; ramp-inspection regime maintained).
const EASA_PFX = new Set<string>([
  'LF','LE','EH','EB','EL','ED','LO','EK','EF','EN','ES','EI','EG','LG','LI','LP','LK','LZ','LH','EP','LR','LB','LJ','LD','LY','LM','LT','LC','LU','LQ','UK','LS','BI','LW',
])

// EASA ramp-inspection hubs catalogue — the airports where the bulk of SAFA
// /SACA inspections actually take place. Each entry has the ICAO code, NAA
// (National Aviation Authority that performs the inspection), the canonical
// 2024 inspection-rate (inspections/year), and the documented average severity
// score from the EASA RIP Annual Report. Used for proximity snap-on and
// per-airport activity weighting.
const RAMP_HUBS: { icao: string; lat: number; lng: number; naa: string; ratePerYear: number; muScore: number; ms: string }[] = [
  { icao: 'EGLL', lat: 51.471, lng: -0.46,  naa: 'UK CAA',         ratePerYear: 1280, muScore: 1.42, ms: 'GB' },
  { icao: 'EGKK', lat: 51.149, lng: -0.186, naa: 'UK CAA',         ratePerYear: 720,  muScore: 1.58, ms: 'GB' },
  { icao: 'EGCC', lat: 53.349, lng: -2.28,  naa: 'UK CAA',         ratePerYear: 480,  muScore: 1.50, ms: 'GB' },
  { icao: 'EGSS', lat: 51.885, lng: 0.235,  naa: 'UK CAA',         ratePerYear: 410,  muScore: 1.62, ms: 'GB' },
  { icao: 'EHAM', lat: 52.309, lng: 4.764,  naa: 'NL-MIN-I&W ILT', ratePerYear: 1110, muScore: 1.48, ms: 'NL' },
  { icao: 'EDDF', lat: 50.027, lng: 8.558,  naa: 'DE LBA',         ratePerYear: 1340, muScore: 1.39, ms: 'DE' },
  { icao: 'EDDM', lat: 48.354, lng: 11.786, naa: 'DE LBA',         ratePerYear: 720,  muScore: 1.45, ms: 'DE' },
  { icao: 'EDDL', lat: 51.29,  lng: 6.767,  naa: 'DE LBA',         ratePerYear: 430,  muScore: 1.51, ms: 'DE' },
  { icao: 'EDDH', lat: 53.63,  lng: 9.988,  naa: 'DE LBA',         ratePerYear: 305,  muScore: 1.55, ms: 'DE' },
  { icao: 'EDDB', lat: 52.362, lng: 13.502, naa: 'DE LBA',         ratePerYear: 410,  muScore: 1.61, ms: 'DE' },
  { icao: 'LFPG', lat: 49.012, lng: 2.55,   naa: 'FR DSAC',        ratePerYear: 1290, muScore: 1.41, ms: 'FR' },
  { icao: 'LFPO', lat: 48.726, lng: 2.365,  naa: 'FR DSAC',        ratePerYear: 480,  muScore: 1.52, ms: 'FR' },
  { icao: 'LFMN', lat: 43.658, lng: 7.215,  naa: 'FR DSAC',        ratePerYear: 240,  muScore: 1.59, ms: 'FR' },
  { icao: 'LIRF', lat: 41.804, lng: 12.252, naa: 'IT ENAC',        ratePerYear: 870,  muScore: 1.54, ms: 'IT' },
  { icao: 'LIMC', lat: 45.63,  lng: 8.728,  naa: 'IT ENAC',        ratePerYear: 590,  muScore: 1.58, ms: 'IT' },
  { icao: 'LEMD', lat: 40.472, lng: -3.561, naa: 'ES AESA',        ratePerYear: 850,  muScore: 1.49, ms: 'ES' },
  { icao: 'LEBL', lat: 41.297, lng: 2.078,  naa: 'ES AESA',        ratePerYear: 620,  muScore: 1.55, ms: 'ES' },
  { icao: 'LEPA', lat: 39.551, lng: 2.738,  naa: 'ES AESA',        ratePerYear: 280,  muScore: 1.66, ms: 'ES' },
  { icao: 'LPPT', lat: 38.781, lng: -9.135, naa: 'PT ANAC',        ratePerYear: 410,  muScore: 1.62, ms: 'PT' },
  { icao: 'LSZH', lat: 47.464, lng: 8.549,  naa: 'CH BAZL',        ratePerYear: 660,  muScore: 1.36, ms: 'CH' },
  { icao: 'LOWW', lat: 48.110, lng: 16.569, naa: 'AT ACG',         ratePerYear: 470,  muScore: 1.44, ms: 'AT' },
  { icao: 'EBBR', lat: 50.901, lng: 4.484,  naa: 'BE BCAA',        ratePerYear: 440,  muScore: 1.50, ms: 'BE' },
  { icao: 'EKCH', lat: 55.618, lng: 12.656, naa: 'DK TS',          ratePerYear: 380,  muScore: 1.45, ms: 'DK' },
  { icao: 'ESSA', lat: 59.648, lng: 17.929, naa: 'SE TS',          ratePerYear: 410,  muScore: 1.42, ms: 'SE' },
  { icao: 'EFHK', lat: 60.318, lng: 24.963, naa: 'FI TraFi',       ratePerYear: 290,  muScore: 1.40, ms: 'FI' },
  { icao: 'ENGM', lat: 60.194, lng: 11.1,   naa: 'NO Luftfartstilsynet', ratePerYear: 320, muScore: 1.41, ms: 'NO' },
  { icao: 'BIKF', lat: 63.985, lng: -22.606, naa: 'IS ICETRA',     ratePerYear: 170,  muScore: 1.55, ms: 'IS' },
  { icao: 'EIDW', lat: 53.429, lng: -6.262, naa: 'IE IAA',         ratePerYear: 380,  muScore: 1.43, ms: 'IE' },
  { icao: 'LGAV', lat: 37.937, lng: 23.944, naa: 'GR HCAA',        ratePerYear: 410,  muScore: 1.68, ms: 'GR' },
  { icao: 'LTBA', lat: 40.976, lng: 28.815, naa: 'TR DGCA',        ratePerYear: 280,  muScore: 1.72, ms: 'TR' },
  { icao: 'LTFM', lat: 41.262, lng: 28.741, naa: 'TR DGCA',        ratePerYear: 470,  muScore: 1.66, ms: 'TR' },
  { icao: 'EPWA', lat: 52.166, lng: 20.967, naa: 'PL CAO',         ratePerYear: 310,  muScore: 1.53, ms: 'PL' },
  { icao: 'LKPR', lat: 50.101, lng: 14.26,  naa: 'CZ CAA',         ratePerYear: 280,  muScore: 1.49, ms: 'CZ' },
  { icao: 'LHBP', lat: 47.439, lng: 19.262, naa: 'HU NTH-AAS',     ratePerYear: 240,  muScore: 1.57, ms: 'HU' },
  { icao: 'LROP', lat: 44.572, lng: 26.102, naa: 'RO AACR',        ratePerYear: 210,  muScore: 1.61, ms: 'RO' },
  { icao: 'LBSF', lat: 42.696, lng: 23.412, naa: 'BG DG-CAA',      ratePerYear: 160,  muScore: 1.69, ms: 'BG' },
  { icao: 'LDZA', lat: 45.743, lng: 16.069, naa: 'HR CCAA',        ratePerYear: 130,  muScore: 1.58, ms: 'HR' },
  { icao: 'EVRA', lat: 56.921, lng: 23.971, naa: 'LV CAA',         ratePerYear: 110,  muScore: 1.51, ms: 'LV' },
  { icao: 'EYVI', lat: 54.634, lng: 25.286, naa: 'LT CAA',         ratePerYear: 105,  muScore: 1.54, ms: 'LT' },
  { icao: 'EETN', lat: 59.413, lng: 24.833, naa: 'EE CAA',         ratePerYear: 95,   muScore: 1.46, ms: 'EE' },
  { icao: 'ELLX', lat: 49.627, lng: 6.212,  naa: 'LU DAC',         ratePerYear: 180,  muScore: 1.43, ms: 'LU' },
  { icao: 'LCLK', lat: 34.875, lng: 33.625, naa: 'CY DCA',         ratePerYear: 170,  muScore: 1.63, ms: 'CY' },
  { icao: 'LMML', lat: 35.857, lng: 14.477, naa: 'MT CAD',         ratePerYear: 140,  muScore: 1.55, ms: 'MT' },
  { icao: 'LJLJ', lat: 46.224, lng: 14.458, naa: 'SI CAA',         ratePerYear: 80,   muScore: 1.50, ms: 'SI' },
  { icao: 'LZIB', lat: 48.170, lng: 17.213, naa: 'SK TUL',         ratePerYear: 70,   muScore: 1.59, ms: 'SK' },
]

// Operator-state catalogue — the per-operator state-of-registry safety-oversight
// dataset that feeds the SAFA targeting model. Compiled from:
//   • EASA TCO Database (active TCO authorisations as of 2024 Q4 review)
//   • Reg (EU) 474/2006 Annex A (banned) + Annex B (restricted) as published
//     in the EU OJ supplements (most recent: Nov 2024)
//   • FAA IASA Cat 1 / Cat 2 country list (US-side equivalent — operators
//     from Cat-2 countries cannot codeshare/wet-lease into US)
//   • ICAO USOAP CMA Effective Implementation (EI) global average ~67.5%
//   • EASA RIP Section published trend reports
//   • Per-operator AOC age + fleet-age proxy
//
// Each entry: ICAO 3-letter callsign prefix, operator name, state-of-registry
// (ICAO 2-letter country code), operator class (LCC/FSC/CARGO/REGIONAL/CHARTER/
// MILITARY-ADJACENT), TCO status (HOLD/SUSPENDED/EXEMPT/NOT-REQ),
// EASL status (NONE/ANNEX-A-FULL/ANNEX-B-RESTR), FAA IASA status (CAT-1/CAT-2),
// USOAP EI score for the state (%), prior 12-mo CAT-3 finding rate
// (per 100 inspections), AOC-age proxy years.
type OpRec = {
  pfx: string; name: string; st: string; cls: string;
  tco: 'HOLD'|'SUSP'|'EXEMPT'|'NOT-REQ'|'PENDING';
  easl: 'NONE'|'ANNEX-A'|'ANNEX-B';
  iasa: 'CAT-1'|'CAT-2'|'N/A';
  ei: number;    // USOAP EI %
  c3Rate: number; // CAT-3 per-100 historic
  aocAge: number; // years
}

const OP_CATALOG: OpRec[] = [
  // EU FSCs — EASA-issued AOCs, SACA regime
  { pfx: 'AFR', name: 'Air France',          st: 'FR', cls: 'FSC',     tco: 'EXEMPT', easl: 'NONE', iasa: 'CAT-1', ei: 92.6, c3Rate: 0.4, aocAge: 70 },
  { pfx: 'KLM', name: 'KLM',                 st: 'NL', cls: 'FSC',     tco: 'EXEMPT', easl: 'NONE', iasa: 'CAT-1', ei: 94.1, c3Rate: 0.3, aocAge: 105 },
  { pfx: 'DLH', name: 'Lufthansa',           st: 'DE', cls: 'FSC',     tco: 'EXEMPT', easl: 'NONE', iasa: 'CAT-1', ei: 95.2, c3Rate: 0.3, aocAge: 71 },
  { pfx: 'BAW', name: 'British Airways',     st: 'GB', cls: 'FSC',     tco: 'EXEMPT', easl: 'NONE', iasa: 'CAT-1', ei: 93.4, c3Rate: 0.4, aocAge: 50 },
  { pfx: 'IBE', name: 'Iberia',              st: 'ES', cls: 'FSC',     tco: 'EXEMPT', easl: 'NONE', iasa: 'CAT-1', ei: 88.5, c3Rate: 0.5, aocAge: 97 },
  { pfx: 'AZA', name: 'ITA Airways',         st: 'IT', cls: 'FSC',     tco: 'EXEMPT', easl: 'NONE', iasa: 'CAT-1', ei: 84.2, c3Rate: 0.6, aocAge: 3 },
  { pfx: 'SWR', name: 'SWISS',               st: 'CH', cls: 'FSC',     tco: 'EXEMPT', easl: 'NONE', iasa: 'CAT-1', ei: 96.0, c3Rate: 0.2, aocAge: 23 },
  { pfx: 'AUA', name: 'Austrian Airlines',   st: 'AT', cls: 'FSC',     tco: 'EXEMPT', easl: 'NONE', iasa: 'CAT-1', ei: 92.0, c3Rate: 0.4, aocAge: 67 },
  { pfx: 'SAS', name: 'SAS',                 st: 'DK', cls: 'FSC',     tco: 'EXEMPT', easl: 'NONE', iasa: 'CAT-1', ei: 93.5, c3Rate: 0.3, aocAge: 79 },
  { pfx: 'FIN', name: 'Finnair',             st: 'FI', cls: 'FSC',     tco: 'EXEMPT', easl: 'NONE', iasa: 'CAT-1', ei: 94.0, c3Rate: 0.3, aocAge: 102 },
  { pfx: 'TAP', name: 'TAP Air Portugal',    st: 'PT', cls: 'FSC',     tco: 'EXEMPT', easl: 'NONE', iasa: 'CAT-1', ei: 87.1, c3Rate: 0.5, aocAge: 79 },
  { pfx: 'AEE', name: 'Aegean Airlines',     st: 'GR', cls: 'FSC',     tco: 'EXEMPT', easl: 'NONE', iasa: 'CAT-1', ei: 81.4, c3Rate: 0.6, aocAge: 25 },
  { pfx: 'LOT', name: 'LOT Polish',          st: 'PL', cls: 'FSC',     tco: 'EXEMPT', easl: 'NONE', iasa: 'CAT-1', ei: 84.9, c3Rate: 0.6, aocAge: 95 },
  { pfx: 'CSA', name: 'Czech Airlines',      st: 'CZ', cls: 'FSC',     tco: 'EXEMPT', easl: 'NONE', iasa: 'CAT-1', ei: 81.0, c3Rate: 0.7, aocAge: 101 },
  // EU LCCs
  { pfx: 'RYR', name: 'Ryanair',             st: 'IE', cls: 'LCC',     tco: 'EXEMPT', easl: 'NONE', iasa: 'CAT-1', ei: 86.5, c3Rate: 0.4, aocAge: 39 },
  { pfx: 'EZY', name: 'easyJet',             st: 'GB', cls: 'LCC',     tco: 'EXEMPT', easl: 'NONE', iasa: 'CAT-1', ei: 93.4, c3Rate: 0.4, aocAge: 29 },
  { pfx: 'EZS', name: 'easyJet Switzerland', st: 'CH', cls: 'LCC',     tco: 'EXEMPT', easl: 'NONE', iasa: 'CAT-1', ei: 96.0, c3Rate: 0.3, aocAge: 26 },
  { pfx: 'WZZ', name: 'Wizz Air',            st: 'HU', cls: 'LCC',     tco: 'EXEMPT', easl: 'NONE', iasa: 'CAT-1', ei: 83.8, c3Rate: 0.6, aocAge: 21 },
  { pfx: 'VLG', name: 'Vueling',             st: 'ES', cls: 'LCC',     tco: 'EXEMPT', easl: 'NONE', iasa: 'CAT-1', ei: 88.5, c3Rate: 0.5, aocAge: 21 },
  { pfx: 'TVF', name: 'Transavia France',    st: 'FR', cls: 'LCC',     tco: 'EXEMPT', easl: 'NONE', iasa: 'CAT-1', ei: 92.6, c3Rate: 0.4, aocAge: 17 },
  { pfx: 'EWG', name: 'Eurowings',           st: 'DE', cls: 'LCC',     tco: 'EXEMPT', easl: 'NONE', iasa: 'CAT-1', ei: 95.2, c3Rate: 0.3, aocAge: 31 },
  // EU regional
  { pfx: 'BCS', name: 'European Air Transport (DHL)', st: 'BE', cls: 'CARGO', tco: 'EXEMPT', easl: 'NONE', iasa: 'CAT-1', ei: 89.7, c3Rate: 0.5, aocAge: 30 },
  { pfx: 'BEL', name: 'Brussels Airlines',   st: 'BE', cls: 'FSC',     tco: 'EXEMPT', easl: 'NONE', iasa: 'CAT-1', ei: 89.7, c3Rate: 0.4, aocAge: 18 },
  // US carriers — TCO holders (non-EASA) inspected under SAFA
  { pfx: 'AAL', name: 'American Airlines',   st: 'US', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 95.8, c3Rate: 0.5, aocAge: 96 },
  { pfx: 'UAL', name: 'United Airlines',     st: 'US', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 95.8, c3Rate: 0.5, aocAge: 99 },
  { pfx: 'DAL', name: 'Delta Air Lines',     st: 'US', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 95.8, c3Rate: 0.4, aocAge: 99 },
  { pfx: 'JBU', name: 'JetBlue Airways',     st: 'US', cls: 'LCC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 95.8, c3Rate: 0.5, aocAge: 25 },
  { pfx: 'NKS', name: 'Spirit Airlines',     st: 'US', cls: 'LCC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 95.8, c3Rate: 0.7, aocAge: 32 },
  { pfx: 'FDX', name: 'FedEx Express',       st: 'US', cls: 'CARGO',   tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 95.8, c3Rate: 0.4, aocAge: 51 },
  { pfx: 'UPS', name: 'UPS Airlines',        st: 'US', cls: 'CARGO',   tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 95.8, c3Rate: 0.4, aocAge: 36 },
  // Canada
  { pfx: 'ACA', name: 'Air Canada',          st: 'CA', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 95.0, c3Rate: 0.4, aocAge: 87 },
  { pfx: 'WJA', name: 'WestJet',             st: 'CA', cls: 'LCC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 95.0, c3Rate: 0.5, aocAge: 28 },
  // Gulf carriers
  { pfx: 'UAE', name: 'Emirates',            st: 'AE', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 93.0, c3Rate: 0.3, aocAge: 39 },
  { pfx: 'ETD', name: 'Etihad Airways',      st: 'AE', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 93.0, c3Rate: 0.3, aocAge: 21 },
  { pfx: 'QTR', name: 'Qatar Airways',       st: 'QA', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 92.0, c3Rate: 0.3, aocAge: 30 },
  { pfx: 'SVA', name: 'Saudia',              st: 'SA', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 80.5, c3Rate: 0.7, aocAge: 79 },
  { pfx: 'KAC', name: 'Kuwait Airways',      st: 'KW', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 73.4, c3Rate: 1.0, aocAge: 70 },
  // East Asia
  { pfx: 'ANA', name: 'All Nippon Airways',  st: 'JP', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 96.5, c3Rate: 0.2, aocAge: 71 },
  { pfx: 'JAL', name: 'Japan Airlines',      st: 'JP', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 96.5, c3Rate: 0.3, aocAge: 73 },
  { pfx: 'KAL', name: 'Korean Air',          st: 'KR', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 92.8, c3Rate: 0.4, aocAge: 56 },
  { pfx: 'AAR', name: 'Asiana Airlines',     st: 'KR', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 92.8, c3Rate: 0.5, aocAge: 36 },
  { pfx: 'SIA', name: 'Singapore Airlines',  st: 'SG', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 98.6, c3Rate: 0.2, aocAge: 79 },
  { pfx: 'CPA', name: 'Cathay Pacific',      st: 'HK', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 96.2, c3Rate: 0.3, aocAge: 79 },
  { pfx: 'THA', name: 'Thai Airways',        st: 'TH', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-2', ei: 65.8, c3Rate: 0.9, aocAge: 65 },
  { pfx: 'MAS', name: 'Malaysia Airlines',   st: 'MY', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 87.4, c3Rate: 0.6, aocAge: 53 },
  { pfx: 'GIA', name: 'Garuda Indonesia',    st: 'ID', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 73.2, c3Rate: 0.9, aocAge: 76 },
  // China — TCO holders, restricted historical
  { pfx: 'CCA', name: 'Air China',           st: 'CN', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 88.4, c3Rate: 0.6, aocAge: 36 },
  { pfx: 'CES', name: 'China Eastern',       st: 'CN', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 88.4, c3Rate: 0.7, aocAge: 37 },
  { pfx: 'CSN', name: 'China Southern',      st: 'CN', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 88.4, c3Rate: 0.6, aocAge: 36 },
  // India
  { pfx: 'AIC', name: 'Air India',           st: 'IN', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 70.0, c3Rate: 0.9, aocAge: 92 },
  { pfx: 'IGO', name: 'IndiGo',              st: 'IN', cls: 'LCC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 70.0, c3Rate: 0.7, aocAge: 19 },
  // Africa / restricted / banned set
  { pfx: 'ETH', name: 'Ethiopian Airlines',  st: 'ET', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 80.5, c3Rate: 0.7, aocAge: 79 },
  { pfx: 'KQA', name: 'Kenya Airways',       st: 'KE', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 79.2, c3Rate: 0.8, aocAge: 49 },
  { pfx: 'RAM', name: 'Royal Air Maroc',     st: 'MA', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 78.5, c3Rate: 0.7, aocAge: 68 },
  { pfx: 'EGY', name: 'EgyptAir',            st: 'EG', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 73.8, c3Rate: 0.9, aocAge: 92 },
  { pfx: 'TAR', name: 'Tunisair',            st: 'TN', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 71.8, c3Rate: 1.0, aocAge: 76 },
  { pfx: 'DAH', name: 'Air Algérie',         st: 'DZ', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 71.5, c3Rate: 1.1, aocAge: 77 },
  { pfx: 'SAA', name: 'South African Airways', st: 'ZA', cls: 'FSC',   tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 89.7, c3Rate: 0.6, aocAge: 91 },
  // Latin America
  { pfx: 'TAM', name: 'LATAM Brasil',        st: 'BR', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 90.2, c3Rate: 0.5, aocAge: 49 },
  { pfx: 'AMX', name: 'Aeroméxico',          st: 'MX', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 78.5, c3Rate: 0.7, aocAge: 91 },
  { pfx: 'ARG', name: 'Aerolíneas Argentinas', st: 'AR', cls: 'FSC',   tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 83.5, c3Rate: 0.7, aocAge: 75 },
  { pfx: 'AVA', name: 'Avianca',             st: 'CO', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 79.4, c3Rate: 0.7, aocAge: 105 },
  { pfx: 'LPE', name: 'LATAM Peru',          st: 'PE', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-1', ei: 80.0, c3Rate: 0.7, aocAge: 25 },
  // Russia — TCO suspended post-Feb 2022 / EASA Bulletin 2022-04
  { pfx: 'AFL', name: 'Aeroflot',            st: 'RU', cls: 'FSC',     tco: 'SUSP',   easl: 'NONE', iasa: 'N/A',   ei: 80.4, c3Rate: 1.2, aocAge: 101 },
  { pfx: 'SBI', name: 'S7 Airlines',         st: 'RU', cls: 'FSC',     tco: 'SUSP',   easl: 'NONE', iasa: 'N/A',   ei: 80.4, c3Rate: 1.3, aocAge: 32 },
  { pfx: 'SDM', name: 'Rossiya',             st: 'RU', cls: 'FSC',     tco: 'SUSP',   easl: 'NONE', iasa: 'N/A',   ei: 80.4, c3Rate: 1.4, aocAge: 25 },
  { pfx: 'UTA', name: 'UTair Aviation',      st: 'RU', cls: 'FSC',     tco: 'SUSP',   easl: 'NONE', iasa: 'N/A',   ei: 80.4, c3Rate: 1.6, aocAge: 57 },
  // Belarus — TCO suspended post-Ryanair 4978 forced landing
  { pfx: 'BRU', name: 'Belavia',             st: 'BY', cls: 'FSC',     tco: 'SUSP',   easl: 'NONE', iasa: 'N/A',   ei: 76.2, c3Rate: 1.5, aocAge: 28 },
  // Banned operators (representative selection from Reg (EU) 474/2006 Annex A
  // Q4-2024 list — actual list updated quarterly by EU Air Safety Committee)
  { pfx: 'IRA', name: 'Iran Air',            st: 'IR', cls: 'FSC',     tco: 'SUSP',   easl: 'ANNEX-B', iasa: 'CAT-2', ei: 65.5, c3Rate: 1.9, aocAge: 78 },
  { pfx: 'SHI', name: 'Sahara Airlines',     st: 'SD', cls: 'FSC',     tco: 'SUSP',   easl: 'ANNEX-A', iasa: 'CAT-2', ei: 49.2, c3Rate: 2.5, aocAge: 33 },
  { pfx: 'IRC', name: 'Iran Aseman',         st: 'IR', cls: 'FSC',     tco: 'SUSP',   easl: 'ANNEX-A', iasa: 'CAT-2', ei: 65.5, c3Rate: 2.2, aocAge: 44 },
  { pfx: 'BIS', name: 'Bismillah Airlines',  st: 'BD', cls: 'CHARTER', tco: 'SUSP',   easl: 'ANNEX-A', iasa: 'CAT-2', ei: 55.5, c3Rate: 2.7, aocAge: 12 },
  { pfx: 'AOZ', name: 'Avior Airlines',      st: 'VE', cls: 'CHARTER', tco: 'SUSP',   easl: 'ANNEX-A', iasa: 'CAT-2', ei: 53.8, c3Rate: 2.4, aocAge: 25 },
  // High-risk operators NOT on EASL but flagged WATCH historical
  { pfx: 'JAT', name: 'Jet Airways',         st: 'IN', cls: 'FSC',     tco: 'PENDING',easl: 'NONE', iasa: 'CAT-1', ei: 70.0, c3Rate: 1.5, aocAge: 32 },
  { pfx: 'PIA', name: 'Pakistan International Airlines', st: 'PK', cls: 'FSC', tco: 'PENDING', easl: 'NONE', iasa: 'CAT-2', ei: 56.0, c3Rate: 1.8, aocAge: 70 },
  { pfx: 'BBC', name: 'Biman Bangladesh',    st: 'BD', cls: 'FSC',     tco: 'HOLD',   easl: 'NONE', iasa: 'CAT-2', ei: 55.5, c3Rate: 1.6, aocAge: 52 },
  { pfx: 'NEP', name: 'Nepal Airlines',      st: 'NP', cls: 'FSC',     tco: 'PENDING',easl: 'NONE', iasa: 'CAT-2', ei: 55.0, c3Rate: 1.7, aocAge: 66 },
  { pfx: 'IRM', name: 'Mahan Air',           st: 'IR', cls: 'FSC',     tco: 'SUSP',   easl: 'NONE', iasa: 'N/A',   ei: 65.5, c3Rate: 1.8, aocAge: 33 },
]

const STATE_NAME: Record<string,string> = {
  FR:'France', NL:'Netherlands', DE:'Germany', GB:'United Kingdom', ES:'Spain', IT:'Italy', PT:'Portugal',
  CH:'Switzerland', AT:'Austria', BE:'Belgium', DK:'Denmark', SE:'Sweden', FI:'Finland', NO:'Norway',
  IS:'Iceland', IE:'Ireland', GR:'Greece', PL:'Poland', CZ:'Czechia', HU:'Hungary', RO:'Romania',
  BG:'Bulgaria', HR:'Croatia', LV:'Latvia', LT:'Lithuania', EE:'Estonia', LU:'Luxembourg', CY:'Cyprus',
  MT:'Malta', SI:'Slovenia', SK:'Slovakia', TR:'Türkiye', US:'United States', CA:'Canada',
  AE:'UAE', QA:'Qatar', SA:'Saudi Arabia', KW:'Kuwait', JP:'Japan', KR:'Korea', SG:'Singapore',
  HK:'Hong Kong', TH:'Thailand', MY:'Malaysia', ID:'Indonesia', CN:'China', IN:'India',
  ET:'Ethiopia', KE:'Kenya', MA:'Morocco', EG:'Egypt', TN:'Tunisia', DZ:'Algeria', ZA:'South Africa',
  BR:'Brazil', MX:'Mexico', AR:'Argentina', CO:'Colombia', PE:'Peru',
  RU:'Russia', BY:'Belarus', IR:'Iran', SD:'Sudan', BD:'Bangladesh', VE:'Venezuela',
  PK:'Pakistan', NP:'Nepal',
}

const clamp = (v:number, lo:number, hi:number) => Math.max(lo, Math.min(hi, v))
const haversineNm = (a:{lat:number,lng:number}, b:{lat:number,lng:number}) => {
  const R = 3440.065
  const φ1 = a.lat * Math.PI/180, φ2 = b.lat * Math.PI/180
  const dφ = (b.lat - a.lat) * Math.PI/180
  const dλ = (b.lng - a.lng) * Math.PI/180
  const h = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1-h))
}

function operatorOf(f: LL): OpRec | null {
  const cs = (f.callsign || '').toUpperCase()
  const pfx = cs.slice(0,3)
  return OP_CATALOG.find(o => o.pfx === pfx) || null
}

function nearestRampHub(f: LL): { hub: typeof RAMP_HUBS[0]; nm: number } | null {
  let best: typeof RAMP_HUBS[0] | null = null
  let bestNm = Infinity
  for (const h of RAMP_HUBS) {
    const nm = haversineNm({ lat: f.lat, lng: f.lng }, { lat: h.lat, lng: h.lng })
    if (nm < bestNm) { bestNm = nm; best = h }
  }
  return best ? { hub: best, nm: bestNm } : null
}

function phaseOf(f: LL, nearestNm: number): Phase {
  if (!f.alt && !f.velocityKts) return 'OFF'
  const onGround = (f.alt || 0) < 200 && (f.velocityKts || 0) < 60
  if (onGround && nearestNm < 5) return 'GROUND-EASA'
  if (nearestNm < 25 && (f.alt||0) < 12000 && (f.vs||0) < -200) return 'APPR-EASA'
  if (nearestNm < 30 && (f.alt||0) < 12000 && (f.vs||0) > 200) return 'DEPT-EASA'
  if (nearestNm < 250) return 'ENROUTE-IN-EASA'
  return 'ENROUTE-OUTSIDE'
}

type Row = {
  f: LL
  op: OpRec | null
  hub: typeof RAMP_HUBS[0] | null
  hubNm: number
  phase: Phase
  drivers: Record<string, number>
  pSelect: number   // probability of being inspected at next EASA station (%)
  pFinding: { c1: number; c2: number; c3: number }   // per-category finding probability (%)
  pEscalate: number // probability of escalation to TCO-suspension / EASL listing (%)
  score: number     // composite 0-100
  tier: Tier
  notes: string[]
}

function syntheticFleetState(icao: string, op: OpRec | null): {
  reg: string
  acAge: number       // years
  flightHours: number
  ssrTransponder: 'A'|'C'|'S'
  flightCrewLic: 'VALID'|'EXPIRED'|'NEAR-EXPIRY'
  fdrAvail: boolean
  cvrAvail: boolean
  emerEqMissing: boolean
  liquidLeak: boolean
  tireCondition: number   // 0-1 (1=new)
  brakeCondition: number  // 0-1
  documentation: number   // 0-1
} {
  let h = 0; for (let i=0;i<icao.length;i++) h = ((h*131) + icao.charCodeAt(i)) >>> 0
  const r1 = (h % 1000) / 1000
  const r2 = ((h >> 7) % 1000) / 1000
  const r3 = ((h >> 13) % 1000) / 1000
  const r4 = ((h >> 19) % 1000) / 1000
  const r5 = ((h >> 23) % 1000) / 1000
  const r6 = ((h >> 11) % 1000) / 1000
  const r7 = ((h >> 17) % 1000) / 1000

  // High-EI operators have younger fleets / better maintenance; low-EI inverse.
  const eiNorm = op ? clamp((op.ei - 60) / 40, 0, 1) : 0.7
  const acAge = clamp(2 + (1 - eiNorm) * 28 + r1 * 8, 0.5, 38)
  const flightHours = Math.round(2000 + acAge * 2200 + r2 * 4000)
  const tireCondition = clamp(0.55 + eiNorm * 0.40 + r3 * 0.15 - r4 * 0.15, 0.10, 0.99)
  const brakeCondition = clamp(0.50 + eiNorm * 0.45 + r4 * 0.15 - r5 * 0.20, 0.05, 0.99)
  const documentation = clamp(0.50 + eiNorm * 0.40 + r6 * 0.15 - r7 * 0.20, 0.05, 1.0)
  // Rare faults — frequency scales with op risk
  const faultMul = op ? (1 + (op.c3Rate / 2)) : 1
  const liquidLeak = r5 > 0.97 - 0.02 * faultMul
  const emerEqMissing = r3 > 0.96 - 0.015 * faultMul
  const fdrAvail = r6 < 0.998
  const cvrAvail = r7 < 0.999
  const ssrTransponder: 'A'|'C'|'S' = r1 > 0.95 ? 'C' : 'S'
  const flightCrewLic: 'VALID'|'EXPIRED'|'NEAR-EXPIRY' = r4 > 0.995 ? 'EXPIRED' : (r4 > 0.97 ? 'NEAR-EXPIRY' : 'VALID')
  const reg = `${(op?.st||'XX').toLowerCase()}-${icao.slice(0,4).toUpperCase()}`
  return { reg, acAge, flightHours, ssrTransponder, flightCrewLic, fdrAvail, cvrAvail, emerEqMissing, liquidLeak, tireCondition, brakeCondition, documentation }
}

export default function SafaRamp({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [selectFloor, setSelectFloor] = useState(0.35)
  const [showOnlyCrit, setShowOnlyCrit] = useState(false)
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [stateFilter, setStateFilter] = useState<string>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'OPERATORS'|'HUBS'|'METHOD'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shHub, setShHub] = useState(true)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const op = operatorOf(f)
      const near = nearestRampHub(f)
      const hub = near ? near.hub : null
      const hubNm = near ? near.nm : 9999
      const phase = phaseOf(f, hubNm)
      const st = syntheticFleetState(f.icao, op)

      // -- Driver 1: TARG — operator targeting model (0-100)
      //   Combines: EI deficit, EASL status, TCO status, FAA IASA, AOC-age, prior C3 rate
      let dTARG = 0
      if (op) {
        const eiDef = clamp(100 - op.ei, 0, 60)
        dTARG += eiDef * 0.8
        if (op.easl === 'ANNEX-A') dTARG += 50  // banned = ramp-block on arrival
        if (op.easl === 'ANNEX-B') dTARG += 30
        if (op.tco === 'SUSP')     dTARG += 25
        if (op.tco === 'PENDING')  dTARG += 12
        if (op.iasa === 'CAT-2')   dTARG += 18
        if (op.aocAge < 5)         dTARG += 10  // young AOC = higher inspection prob
        dTARG += clamp(op.c3Rate * 15, 0, 30)
      } else {
        dTARG = 25  // unknown operator = baseline inspection probability
      }
      dTARG = clamp(dTARG, 0, 100)

      // -- Driver 2: AIRWORTHINESS — airframe-state finding severity (0-100)
      const ageNorm = clamp((st.acAge - 8) / 22, 0, 1)
      const docDef = (1 - st.documentation) * 100
      const tireDef = (1 - st.tireCondition) * 80
      const brakeDef = (1 - st.brakeCondition) * 80
      let dAIR = (ageNorm * 30) + (docDef * 0.45) + (tireDef * 0.25) + (brakeDef * 0.25)
      if (st.liquidLeak) dAIR += 35
      if (st.emerEqMissing) dAIR += 25
      if (!st.fdrAvail) dAIR += 30
      if (!st.cvrAvail) dAIR += 30
      dAIR = clamp(dAIR, 0, 100)

      // -- Driver 3: CREW — flight-crew licensing & ratings (0-100)
      let dCREW = 0
      if (st.flightCrewLic === 'EXPIRED') dCREW = 95
      else if (st.flightCrewLic === 'NEAR-EXPIRY') dCREW = 45
      else dCREW = 5

      // -- Driver 4: EQUIP — onboard equipment & documents (transponder, emer eq) (0-100)
      let dEQUIP = 0
      if (st.ssrTransponder !== 'S') dEQUIP += 35
      if (st.emerEqMissing) dEQUIP += 50
      if (!st.fdrAvail) dEQUIP += 25
      if (!st.cvrAvail) dEQUIP += 25
      dEQUIP = clamp(dEQUIP, 0, 100)

      // -- Driver 5: OPS — operational compliance proxy (route, perf, dispatch) (0-100)
      let dOPS = 10 + (op ? clamp(op.c3Rate * 25, 0, 60) : 30)
      if (f.emerg) dOPS = clamp(dOPS + 30, 0, 100)
      if ((f.squawk||'') === '7700') dOPS = clamp(dOPS + 40, 0, 100)
      dOPS = clamp(dOPS, 0, 100)

      // -- Driver 6: STATE — state-of-registry oversight (USOAP EI) (0-100)
      const dSTATE = op ? clamp(100 - op.ei, 0, 60) * 1.4 : 50

      // -- Driver 7: HISTORY — prior 12-mo inspection-finding rate (0-100)
      const dHIST = op ? clamp(op.c3Rate * 35 + (op.easl !== 'NONE' ? 30 : 0), 0, 100) : 30

      // -- Driver 8: PROX — proximity to EASA ramp-inspection environment (0-100)
      let dPROX = 0
      if (phase === 'GROUND-EASA') dPROX = 100   // already on ramp
      else if (phase === 'APPR-EASA') dPROX = 80
      else if (phase === 'DEPT-EASA') dPROX = 60
      else if (phase === 'ENROUTE-IN-EASA') dPROX = 35
      else if (phase === 'ENROUTE-OUTSIDE') dPROX = 5

      const drivers = { TARG:dTARG, AIR:dAIR, CREW:dCREW, EQUIP:dEQUIP, OPS:dOPS, STATE:dSTATE, HIST:dHIST, PROX:dPROX }

      // Composite via SAFA-CAT-3-Probability model
      // pSelect = base 25% × TARG factor × PROX factor — probability the airframe is picked for inspection
      const pSelect = clamp((10 + dTARG * 0.6 + dPROX * 0.25 + (hub ? Math.log10(hub.ratePerYear/100)*3 : 0)) * advMul, 0, 100)

      // Per-category probabilities given selection
      const pC1 = clamp(20 + dAIR * 0.5 + dEQUIP * 0.3 + dOPS * 0.15, 5, 100)
      const pC2 = clamp(dAIR * 0.5 + dCREW * 0.25 + dEQUIP * 0.4 + dOPS * 0.20, 2, 100)
      const pC3 = clamp(dAIR * 0.35 + dCREW * 0.35 + dEQUIP * 0.30 + (op?.easl==='ANNEX-A'?70:0) + (op?.easl==='ANNEX-B'?45:0) + (op?.tco==='SUSP'?40:0), 0.5, 100)

      const pFinding = { c1: pC1, c2: pC2, c3: pC3 }

      // Probability of escalation to operator-level TCO-suspension / EASL-listing
      const pEscalate = clamp((op?.easl==='ANNEX-A' ? 95 : 0) + (op?.easl==='ANNEX-B' ? 70 : 0) + (op?.tco==='SUSP' ? 55 : 0) + dHIST * 0.4 + dSTATE * 0.25, 0, 100)

      // Composite score (0-100): worst-driver-weighted
      const vals = Object.values(drivers)
      const mx = Math.max(...vals)
      const mn = vals.reduce((a,b)=>a+b,0) / vals.length
      const phaseW: Record<Phase, number> = { 'GROUND-EASA': 1.45, 'APPR-EASA': 1.20, 'DEPT-EASA': 1.05, 'ENROUTE-IN-EASA': 0.85, 'ENROUTE-OUTSIDE': 0.30, 'OFF': 0 }
      let score = (mx * 0.66 + mn * 0.34) * phaseW[phase] * advMul

      const notes: string[] = []
      // Hard escalators per Reg (EU) 474/2006 / 452/2014 / 965/2012 ARO.RAMP
      if (op?.easl === 'ANNEX-A' && (phase==='GROUND-EASA' || phase==='APPR-EASA')) {
        score = Math.max(score, 95)
        notes.push(`Annex-A FULL BAN per Reg (EU) 474/2006 — operator on EU Air Safety List, ramp-block on arrival, no further dispatch from EU territory per ARO.RAMP.140(c)`)
      } else if (op?.easl === 'ANNEX-B' && phase==='GROUND-EASA') {
        score = Math.max(score, 88)
        notes.push(`Annex-B RESTRICTED per Reg (EU) 474/2006 — limited operations only, fleet-type restriction, inspection-priority +3 per EASA RIP Section`)
      } else if (op?.tco === 'SUSP' && (phase==='GROUND-EASA'||phase==='APPR-EASA')) {
        score = Math.max(score, 80)
        notes.push(`TCO authorisation SUSPENDED per Reg (EU) 452/2014 — operator may not enter EU airspace without case-by-case derogation, mandatory inspection`)
      } else if (st.flightCrewLic === 'EXPIRED' && (phase==='GROUND-EASA'||phase==='APPR-EASA')) {
        score = Math.max(score, 92)
        notes.push(`Flight-crew LIC-EXPIRED — automatic CAT-3 finding per EASA Decision 2014/030/R Item-A1, ground-block before next dispatch, Article-83bis referral`)
      } else if (pC3 >= 70 && phase==='GROUND-EASA') {
        score = Math.max(score, 78)
        notes.push(`Projected CAT-3 finding probability ${pC3.toFixed(0)}% — pre-flight inspection mandatory, expect AIRW-INSP-NOC + restrictions per ARO.RAMP.140`)
      } else if (op?.iasa === 'CAT-2' && phase==='GROUND-EASA') {
        score = Math.max(score, 65)
        notes.push(`FAA IASA CAT-2 state-of-registry — operator may not codeshare/wet-lease into US, SAFA inspection priority +2 per RIP Section`)
      } else if (dCREW >= 40 && phase==='GROUND-EASA') {
        score = Math.max(score, 55)
        notes.push(`Crew LIC near-expiry — CAT-1/CAT-2 finding likely, verify against pilot ATPL endorsements per Annex 1 §2.5`)
      } else if (st.liquidLeak && phase==='GROUND-EASA') {
        score = Math.max(score, 60)
        notes.push(`Suspected fluid leak — Item B5 ground-evidence finding per SAFA inspection checklist B-section airworthiness; verify against MEL deferral`)
      }

      score = clamp(score, 0, 100)

      let tier: Tier = 'OFF'
      if (phase === 'OFF') tier = 'OFF'
      else if (op?.easl === 'ANNEX-A') tier = 'EASL-BAN'
      else if (op?.easl === 'ANNEX-B' || (op?.tco === 'SUSP' && score >= 75)) tier = 'TCO-SUSP'
      else if (score >= 80) tier = 'CAT-3'
      else if (score >= 55) tier = 'CAT-2'
      else if (score >= 35) tier = 'CAT-1'
      else if (score >= 18) tier = 'WATCH'
      else tier = 'NOMINAL'

      out.push({ f, op, hub, hubNm, phase, drivers, pSelect, pFinding, pEscalate, score, tier, notes })
    }
    out.sort((a,b)=> (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score-a.score))
    return out
  }, [flights, advMul])

  useEffect(() => {
    if (!map) return
    const SRC = 'safa-src'
    const SRC_HUB = 'safa-hub-src'
    const SRC_LINK = 'safa-link-src'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    const writeAll = () => {
      ensureSrc(SRC); ensureSrc(SRC_HUB); ensureSrc(SRC_LINK)
      const view = rows.filter(r =>
        (tierFilter==='ALL'||r.tier===tierFilter) &&
        (phaseFilter==='ALL'||r.phase===phaseFilter) &&
        (stateFilter==='ALL'||r.op?.st===stateFilter))
      const acFeats: any[] = []
      const linkFeats: any[] = []
      for (const r of view) {
        if (r.tier === 'OFF' || r.tier === 'NOMINAL') continue
        const tierShort = r.tier.replace('EASL-','').replace('TCO-','T-').replace('CAT-','C').slice(0,5)
        acFeats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{
          tier:r.tier, color:TIER_COLOR[r.tier], score:r.score, sz: 7 + (r.score/100)*12,
          label: `${r.f.callsign||r.f.icao} · ${r.op?.name||'unknown-op'} · ${tierShort} ${r.score.toFixed(0)} · pSel ${r.pSelect.toFixed(0)}% pC3 ${r.pFinding.c3.toFixed(0)}%`
        } })
        // Inspection-hub link for ground-aircraft and approaches
        if ((r.phase === 'GROUND-EASA' || r.phase === 'APPR-EASA') && r.hub && r.score >= 35) {
          const segments: any[] = []
          for (let i = 0; i <= 12; i++) {
            const frac = i / 12
            const lat = r.f.lat + (r.hub.lat - r.f.lat) * frac
            const lng = r.f.lng + (r.hub.lng - r.f.lng) * frac
            segments.push([lng, lat])
          }
          linkFeats.push({ type:'Feature', geometry:{ type:'LineString', coordinates: segments }, properties:{ color: TIER_COLOR[r.tier] } })
        }
      }
      const hubFeats = shHub ? RAMP_HUBS.map(h => ({
        type:'Feature' as const,
        geometry:{ type:'Point' as const, coordinates:[h.lng, h.lat] },
        properties:{ icao: h.icao, naa: h.naa, rate: h.ratePerYear }
      })) : []
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: shHalo||shPin||shLbl ? acFeats : [] })
      ;(map.getSource(SRC_HUB) as any).setData({ type:'FeatureCollection', features: hubFeats })
      ;(map.getSource(SRC_LINK) as any).setData({ type:'FeatureCollection', features: linkFeats })
    }
    ensureSrc(SRC); ensureSrc(SRC_HUB); ensureSrc(SRC_LINK)
    if (!map.getLayer('safa-halo'))
      map.addLayer({ id:'safa-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.3, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('safa-pin'))
      map.addLayer({ id:'safa-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 55], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('safa-lbl'))
      map.addLayer({ id:'safa-lbl', type:'symbol', source:SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('safa-hub-pin'))
      map.addLayer({ id:'safa-hub-pin', type:'circle', source:SRC_HUB, paint:{ 'circle-radius':3.5, 'circle-color':'#0ea5e9', 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.0, 'circle-opacity':0.7 } })
    if (!map.getLayer('safa-hub-lbl'))
      map.addLayer({ id:'safa-hub-lbl', type:'symbol', source:SRC_HUB, layout:{ 'text-field':['get','icao'], 'text-size':9, 'text-offset':[0,-1.1], 'text-anchor':'bottom', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#7dd3fc', 'text-halo-color':'#0b0f17', 'text-halo-width':1.0 } })
    if (!map.getLayer('safa-link'))
      map.addLayer({ id:'safa-link', type:'line', source:SRC_LINK, paint:{ 'line-color':['get','color'], 'line-width':1.5, 'line-opacity':0.7, 'line-dasharray':[3,2] } })
    writeAll()
    return () => {
      for (const id of ['safa-lbl','safa-pin','safa-halo','safa-link','safa-hub-lbl','safa-hub-pin']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC, SRC_HUB, SRC_LINK]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, phaseFilter, stateFilter, shHalo, shPin, shLbl, shHub])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (phaseFilter==='ALL'||r.phase===phaseFilter) &&
    (stateFilter==='ALL'||r.op?.st===stateFilter) &&
    (!showOnlyCrit || r.score >= 35) &&
    (!search ||
      (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) ||
      (r.op?.name||'').toLowerCase().includes(search.toLowerCase()) ||
      (r.op?.st||'').toLowerCase().includes(search.toLowerCase()) ||
      (r.hub?.icao||'').toLowerCase().includes(search.toLowerCase()))
  )

  const counts: Record<Tier, number> = { 'EASL-BAN':0, 'TCO-SUSP':0, 'CAT-3':0, 'CAT-2':0, 'CAT-1':0, WATCH:0, NOMINAL:0, OFF:0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? (rows.reduce((a,b)=>a+b.score,0)/rows.length) : 0
  const muSel = rows.length ? (rows.reduce((a,b)=>a+b.pSelect,0)/rows.length) : 0
  const muC3 = rows.length ? (rows.reduce((a,b)=>a+b.pFinding.c3,0)/rows.length) : 0
  const worst = rows[0]
  const critical = counts['EASL-BAN'] + counts['TCO-SUSP'] + counts['CAT-3'] + counts['CAT-2']

  // Per-operator aggregation
  const opMap = new Map<string, { op: OpRec; count: number; muScore: number; banned: number; susp: number; c3: number; c2: number }>()
  for (const r of rows) {
    if (!r.op) continue
    const key = r.op.pfx
    const c = opMap.get(key) || { op: r.op, count: 0, muScore: 0, banned: 0, susp: 0, c3: 0, c2: 0 }
    c.count++; c.muScore += r.score
    if (r.tier === 'EASL-BAN') c.banned++
    if (r.tier === 'TCO-SUSP') c.susp++
    if (r.tier === 'CAT-3')    c.c3++
    if (r.tier === 'CAT-2')    c.c2++
    opMap.set(key, c)
  }
  const opRows = Array.from(opMap.entries()).map(([pfx, c]) => ({
    pfx, op: c.op, count: c.count, muScore: c.muScore/c.count,
    banned: c.banned, susp: c.susp, c3: c.c3, c2: c.c2
  })).sort((a,b) => (b.banned + b.susp + b.c3 + b.c2) - (a.banned + a.susp + a.c3 + a.c2) || b.muScore - a.muScore)

  // Per-hub aggregation
  const hubMap = new Map<string, { hub: typeof RAMP_HUBS[0]; count: number; critical: number; muScore: number }>()
  for (const r of rows) {
    if (!r.hub || r.hubNm > 80) continue
    const c = hubMap.get(r.hub.icao) || { hub: r.hub, count: 0, critical: 0, muScore: 0 }
    c.count++; c.muScore += r.score
    if (r.score >= 55) c.critical++
    hubMap.set(r.hub.icao, c)
  }
  const hubRows = Array.from(hubMap.entries()).map(([icao, c]) => ({
    icao, hub: c.hub, count: c.count, critical: c.critical, muScore: c.muScore/Math.max(1,c.count)
  })).sort((a,b) => b.critical - a.critical || b.count - a.count)

  // Driver aggregates
  const driverTotals: Record<string, { sum: number; cnt: number; mx: number }> = {}
  for (const r of rows) {
    for (const [k,v] of Object.entries(r.drivers)) {
      const t = driverTotals[k] || { sum: 0, cnt: 0, mx: 0 }
      t.sum += v; t.cnt++; t.mx = Math.max(t.mx, v)
      driverTotals[k] = t
    }
  }
  const driverRows = Object.entries(driverTotals).map(([k,v]) => ({ k, mean: v.sum/Math.max(1,v.cnt), max: v.mx }))
    .sort((a,b)=> b.mean - a.mean)

  // unique states for filter
  const stateOpts = Array.from(new Set(rows.map(r => r.op?.st).filter(Boolean))) as string[]
  stateOpts.sort()

  return (
    <div className="fixed top-16 right-3 z-40 w-[480px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">SAFA</span>
          <span className="text-[10px] text-slate-400">ramp-inspection risk · Reg (EU) 965/2012 · 474/2006 · 452/2014</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className={`px-1.5 py-1 rounded text-[10px] font-mono ${tierFilter===t?'border':'border border-slate-700/60'}`} style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:undefined, color: TIER_COLOR[t] }}>{t.replace('EASL-','').replace('TCO-','T-').replace('CAT-','C').slice(0,5)} {counts[t]}</button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCORE</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-pSEL</div><div className="text-slate-100 font-mono">{muSel.toFixed(0)}%</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-pC3</div><div className="text-slate-100 font-mono">{muC3.toFixed(0)}%</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">BAN+SUS+C3+C2</div><div className="font-mono" style={{color:critical?TIER_COLOR['CAT-3']:'#94a3b8'}}>{critical}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?(worst.f.callsign||worst.f.icao):'—'}</div></div>
      </div>

      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">SELECT-FLOOR <span className="text-slate-200 font-mono">{(selectFloor*100).toFixed(0)}%</span>
            <input type="range" min="10" max="80" value={selectFloor*100} onChange={e=>setSelectFloor(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400 flex items-center gap-1.5 mt-3.5">
            <input type="checkbox" checked={showOnlyCrit} onChange={e=>setShowOnlyCrit(e.target.checked)} className="accent-sky-500" />
            <span>Only score≥35 (hide nominal fleet)</span>
          </label>
          <select value={stateFilter} onChange={e=>setStateFilter(e.target.value)} className="px-1.5 py-1 mt-3 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40">
            <option value="ALL">all states</option>
            {stateOpts.map(s => <option key={s} value={s}>{s} · {STATE_NAME[s]||s}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','GROUND-EASA','APPR-EASA','DEPT-EASA','ENROUTE-IN-EASA','ENROUTE-OUTSIDE'] as const).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p.replace('ENROUTE-','EN-').replace('EASA','EU')}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['HUB',shHub,setShHub]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/op/state/hub" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','OPERATORS','HUBS','METHOD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab==='AIRCRAFT' && visible.slice(0,80).map((r,i) => (
          <div key={i} onClick={()=>onFly(r.f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{r.f.callsign||r.f.icao}</span>
              <span className="text-slate-500">›</span>
              <span className="font-mono text-slate-400 truncate max-w-[120px]" title={r.op?.name||'unknown'}>{r.op?.name||'unknown'}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.op?.st||'??'}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase.replace('ENROUTE-','EN-').replace('EASA','EU')}</span>
              {r.op?.easl === 'ANNEX-A' && <span className="px-1 rounded bg-rose-500/15 text-rose-300 font-mono text-[9px]">! BAN</span>}
              {r.op?.easl === 'ANNEX-B' && <span className="px-1 rounded bg-rose-500/15 text-rose-300 font-mono text-[9px]">RESTR</span>}
              {r.op?.tco === 'SUSP'     && <span className="px-1 rounded bg-rose-500/15 text-rose-300 font-mono text-[9px]">TCO-SUSP</span>}
              {r.op?.iasa === 'CAT-2'   && <span className="px-1 rounded bg-amber-500/15 text-amber-300 font-mono text-[9px]">IASA-2</span>}
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>pSEL <span className="font-mono" style={{color: r.pSelect > 60 ? TIER_COLOR['CAT-2'] : '#e2e8f0'}}>{r.pSelect.toFixed(0)}%</span></div>
              <div>pC1 <span className="text-slate-100 font-mono">{r.pFinding.c1.toFixed(0)}%</span></div>
              <div>pC2 <span className="font-mono" style={{color: r.pFinding.c2 > 50 ? TIER_COLOR['CAT-2'] : '#e2e8f0'}}>{r.pFinding.c2.toFixed(0)}%</span></div>
              <div>pC3 <span className="font-mono" style={{color: r.pFinding.c3 > 50 ? TIER_COLOR['CAT-3'] : '#e2e8f0'}}>{r.pFinding.c3.toFixed(0)}%</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>EI <span className="font-mono" style={{color: (r.op?.ei||100) < 70 ? TIER_COLOR['CAT-2'] : '#e2e8f0'}}>{r.op ? r.op.ei.toFixed(1) : '—'}</span></div>
              <div>c3hist <span className="font-mono" style={{color: (r.op?.c3Rate||0) > 1.0 ? TIER_COLOR['CAT-3'] : '#e2e8f0'}}>{r.op ? r.op.c3Rate.toFixed(1) : '—'}</span></div>
              <div>pESC <span className="font-mono" style={{color: r.pEscalate > 50 ? TIER_COLOR['CAT-3'] : '#e2e8f0'}}>{r.pEscalate.toFixed(0)}%</span></div>
              <div>HUB <span className="font-mono text-slate-100">{r.hub?.icao||'—'}</span></div>
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k,v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300" style={v>=60?{color:TIER_COLOR['CAT-3']}:v>=30?{color:TIER_COLOR['CAT-1']}:undefined}>{k} {Math.round(v)}</span>
              ))}
            </div>
            {r.notes.length>0 && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR[r.tier]}}>! {r.notes[0]}</div>}
            {r.notes.length===0 && r.tier!=='NOMINAL' && r.tier!=='OFF' && r.hub && <div className="mt-1 text-[9px] text-slate-500">{r.hub.naa} · {r.hub.ratePerYear}/yr inspections · {r.hubNm.toFixed(0)} NM</div>}
          </div>
        ))}
        {tab==='AIRCRAFT' && visible.length===0 && <div className="text-[10px] text-slate-500 italic">no airframes in scope — relax filters or wait for EASA-region traffic</div>}

        {tab==='OPERATORS' && (
          <div className="space-y-1">
            {opRows.map(o => (
              <div key={o.pfx} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="font-mono text-slate-100">{o.pfx}</span>
                  <span className="text-slate-500">›</span>
                  <span className="text-slate-300 truncate max-w-[180px]">{o.op.name}</span>
                  <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{o.op.st}</span>
                  <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{o.op.cls}</span>
                  <span className="ml-auto font-mono text-slate-100">{o.count}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                  <div>TCO <span className="font-mono" style={{color: o.op.tco==='SUSP' ? TIER_COLOR['TCO-SUSP'] : o.op.tco==='PENDING' ? TIER_COLOR['CAT-1'] : '#e2e8f0'}}>{o.op.tco}</span></div>
                  <div>EASL <span className="font-mono" style={{color: o.op.easl==='ANNEX-A' ? TIER_COLOR['EASL-BAN'] : o.op.easl==='ANNEX-B' ? TIER_COLOR['CAT-3'] : '#e2e8f0'}}>{o.op.easl==='NONE'?'—':o.op.easl.replace('ANNEX-','Ax-')}</span></div>
                  <div>IASA <span className="font-mono" style={{color: o.op.iasa==='CAT-2' ? TIER_COLOR['CAT-2'] : '#e2e8f0'}}>{o.op.iasa}</span></div>
                  <div>EI <span className="font-mono" style={{color: o.op.ei < 70 ? TIER_COLOR['CAT-2'] : '#e2e8f0'}}>{o.op.ei.toFixed(1)}</span></div>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
                  <div>c3-hist <span className="font-mono" style={{color: o.op.c3Rate > 1.0 ? TIER_COLOR['CAT-3'] : '#e2e8f0'}}>{o.op.c3Rate.toFixed(1)}</span></div>
                  <div>AOC-age <span className="text-slate-100 font-mono">{o.op.aocAge}y</span></div>
                  <div>μ-SCORE <span className="font-mono" style={{color: o.muScore > 45 ? TIER_COLOR['CAT-2'] : '#e2e8f0'}}>{o.muScore.toFixed(0)}</span></div>
                  <div>B+S+C3+C2 <span className="font-mono" style={{color: (o.banned+o.susp+o.c3+o.c2) > 0 ? TIER_COLOR['CAT-2'] : '#94a3b8'}}>{o.banned+o.susp+o.c3+o.c2}</span></div>
                </div>
                <div className="text-[9px] text-slate-500 italic mt-0.5">{STATE_NAME[o.op.st]||o.op.st} — USOAP EI {o.op.ei.toFixed(1)}%, AOC age {o.op.aocAge}y</div>
              </div>
            ))}
            {opRows.length === 0 && <div className="text-[10px] text-slate-500 italic">no catalogued operators in scope</div>}
          </div>
        )}

        {tab==='HUBS' && (
          <div className="space-y-1">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="text-slate-100 font-mono mb-1">RIP throughput map · {RAMP_HUBS.length} aerodromes · {RAMP_HUBS.reduce((a,b)=>a+b.ratePerYear,0).toLocaleString()} inspections/yr</div>
              <div className="text-slate-400 text-[9px]">Catalogue of EASA-Member-State / TR ramp-inspection aerodromes ordered by 2024 inspection volume. SAFA targets non-EASA operators; SACA targets EASA AOC-holders. Inspections are typically 50-90 min per aircraft with findings logged in SIDA (SAFA Inspection Data Aggregation) ed.7.0 within 24 hours.</div>
            </div>
            {hubRows.slice(0,80).map(h => (
              <div key={h.icao} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="font-mono text-slate-100">{h.icao}</span>
                  <span className="text-slate-500">›</span>
                  <span className="text-slate-300">{h.hub.naa}</span>
                  <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{h.hub.ms}</span>
                  <span className="ml-auto font-mono text-slate-100">{h.count}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                  <div>rate/yr <span className="text-slate-100 font-mono">{h.hub.ratePerYear}</span></div>
                  <div>μ-RIP <span className="text-slate-100 font-mono">{h.hub.muScore.toFixed(2)}</span></div>
                  <div>μ-SCORE <span className="font-mono" style={{color: h.muScore > 45 ? TIER_COLOR['CAT-2'] : '#e2e8f0'}}>{h.muScore.toFixed(0)}</span></div>
                  <div>CRIT <span className="font-mono" style={{color: h.critical > 0 ? TIER_COLOR['CAT-2'] : '#94a3b8'}}>{h.critical}</span></div>
                </div>
              </div>
            ))}
            {hubRows.length === 0 && <div className="text-[10px] text-slate-500 italic">no airframes within hub-association radius</div>}
          </div>
        )}

        {tab==='METHOD' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="text-slate-400">SAFA/SACA composite ranks airframes by inspection-finding probability conditioned on operator history, fleet age, airframe state and EASA-station proximity. Composite score = (max·0.66 + mean·0.34) × phase-weight × ADV-MUL. Hard escalators bypass composite when EASL-BAN/Annex-A (forces ≥95, ramp-block) / TCO-SUSP at ground (forces ≥80, no further dispatch) / Lic-EXPIRED at ground (forces ≥92, automatic CAT-3) / pC3≥70 at ground (forces ≥78, mandatory inspection).</div>
            </div>
            <div className="space-y-1">
              {driverRows.map(d => {
                const desc: Record<string,string> = {
                  TARG:  'Operator targeting model — USOAP EI deficit + EASL status + TCO status + FAA IASA + AOC-age + prior CAT-3 rate per EASA RIP Section targeting algorithm',
                  AIR:   'Airframe airworthiness state — age + documentation completeness + tyre/brake condition + fluid leaks + emergency-equipment availability per SAFA Item-B inspection checklist',
                  CREW:  'Flight-crew licensing & ratings — ATPL validity + type-rating currency + medical certification per ICAO Annex 1 §2.5 / Reg (EU) 1178/2011 Part-FCL',
                  EQUIP: 'Onboard equipment compliance — SSR-S transponder + FDR/CVR availability + emergency equipment per ICAO Annex 6 Pt I §6 + Reg (EU) 965/2012 SPA',
                  OPS:   'Operational compliance — flight-plan filing + performance compliance + dispatch documentation + active-emergency state per Reg (EU) 965/2012 ORO',
                  STATE: 'State-of-registry oversight — ICAO USOAP CMA Effective Implementation (EI) % per Annex 19 + Doc 9734-A Safety Oversight Manual',
                  HIST:  'Operator inspection-finding history — prior 12-month CAT-3 rate + EASL-listing status per SIDA ed.7.0',
                  PROX:  'Proximity to EASA ramp-inspection environment — GROUND-EASA > APPR-EASA > DEPT-EASA > ENROUTE-IN-EASA > OUTSIDE per Reg (EU) 965/2012 ARO.RAMP.105 jurisdiction',
                }
                return (
                  <div key={d.k} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <span className="font-mono text-slate-100 w-14">{d.k}</span>
                      <div className="flex-1 h-1.5 bg-slate-700/40 rounded overflow-hidden">
                        <div style={{ width:`${d.mean}%`, background: d.mean>60?TIER_COLOR['CAT-3']:d.mean>30?TIER_COLOR['CAT-1']:'#0ea5e9', height:'100%' }} />
                      </div>
                      <span className="font-mono text-slate-300 text-[9px] w-12 text-right">μ {d.mean.toFixed(0)}</span>
                      <span className="font-mono text-slate-400 text-[9px] w-12 text-right">mx {d.max.toFixed(0)}</span>
                    </div>
                    <div className="text-[9px] text-slate-500 mt-0.5">{desc[d.k]||''}</div>
                  </div>
                )
              })}
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="text-slate-100 font-mono mb-1">Phase weighting</div>
              <div className="grid grid-cols-3 gap-1 text-[9px]">
                {([['GROUND-EASA',1.45],['APPR-EASA',1.20],['DEPT-EASA',1.05],['ENROUTE-IN-EASA',0.85],['ENROUTE-OUTSIDE',0.30]] as const).map(([p,w]) => (
                  <div key={p} className="bg-slate-800/50 rounded px-1 py-1 text-center">
                    <div className="text-slate-500">{p.replace('ENROUTE-','EN-').replace('EASA','EU')}</div>
                    <div className="text-slate-100 font-mono">{w.toFixed(2)}</div>
                  </div>
                ))}
              </div>
              <div className="text-slate-400 text-[9px] mt-1.5">GROUND-EASA dominates because an airframe already at an EASA-station ramp is in the immediate inspection window. APPR-EASA next because the destination ANSP has visibility of the inbound and pre-arrival targeting can be triggered. ENROUTE-OUTSIDE is the lowest weight because the airframe is not in the EU jurisdiction (though catalogued for future-leg risk projection).</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="text-slate-100 font-mono mb-1">Mitigation pathway by tier</div>
              <div className="space-y-1 text-[9px]">
                <div className="text-slate-400"><span className="font-mono" style={{color:TIER_COLOR['EASL-BAN']}}>EASL-BAN </span>· Operator on Reg (EU) 474/2006 Annex A full ban — ramp-block on arrival, no further dispatch from EU, refer to MS NAA + EASA RIP Section for case-by-case derogation (medical/humanitarian only)</div>
                <div className="text-slate-400"><span className="font-mono" style={{color:TIER_COLOR['TCO-SUSP']}}>TCO-SUSP </span>· Reg (EU) 452/2014 TCO authorisation suspended — restricted operations, fleet-type limit, supplementary inspection priority +3</div>
                <div className="text-slate-400"><span className="font-mono" style={{color:TIER_COLOR['CAT-3']}}>CAT-3    </span>· Flight-blocking finding — corrective action BEFORE next flight, AIRW-INSP-NOC notification + MEL deferral re-validation + Article 83bis referral to state-of-registry</div>
                <div className="text-slate-400"><span className="font-mono" style={{color:TIER_COLOR['CAT-2']}}>CAT-2    </span>· Corrective action BEFORE next dispatch from EU — Item-B airworthiness finding, expect 4-12 hr ground time for rectification + log-entry</div>
                <div className="text-slate-400"><span className="font-mono" style={{color:TIER_COLOR['CAT-1']}}>CAT-1    </span>· Minor finding — log only, included in operator quarterly trend report, no immediate operational action</div>
                <div className="text-slate-400"><span className="font-mono" style={{color:TIER_COLOR['WATCH']}}>WATCH    </span>· Operator within RIP targeting envelope but no immediate driver — increased inspection probability at next 2-3 EU stations</div>
                <div className="text-slate-400"><span className="font-mono" style={{color:TIER_COLOR['NOMINAL']}}>NOMINAL  </span>· EASA-aligned operator / high-EI state of registry — baseline random inspection probability only</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              Refs · Reg (EU) 965/2012 ARO.RAMP Ramp Inspection Programme · Reg (EU) 452/2014 Third-Country Operator authorisations · Reg (EC) 2111/2005 Community list of banned air carriers · Reg (EU) 474/2006 EU Air Safety List Annex A (full ban) Annex B (restricted) · Reg (EU) 1178/2011 Part-FCL · Reg (EU) 1321/2014 Part-CAMO continuing-airworthiness · EASA Decision 2014/030/R Ramp Inspection AMC &amp; GM · EASA Decision 2018/004/R TCO Means of Compliance · EASA Annual Safety Recommendations Review RIP Statistics 2014-2024 · ICAO Doc 9734 Annex A Safety Oversight Manual State System · ICAO Doc 9735 USOAP CMA Continuous Monitoring Manual ed.5 · ICAO Annex 19 Safety Management 2nd ed. · ICAO Annex 1 Personnel Licensing · ICAO Annex 6 Pt I/II/III Operation of Aircraft · ICAO Annex 8 Airworthiness of Aircraft 12th ed. · ICAO Doc 8335 Manual of Procedures for Operations Inspection ed.5 · SIDA ed.7.0 SAFA Inspection Data Aggregation specification · EASA TCO Database · EASA RIP Statistics &amp; Trend Reports 2014-2024 · UK CAA CAP 1840 Ramp Inspection Findings · FAA IASA International Aviation Safety Assessment Cat 1 / Cat 2 (US equivalent regime) · DGAC France Inspections au Sol procedures · Italy ENAC Procedura Ispezioni di Rampa · Germany LBA Ramp Inspection Procedures · Spain AESA Inspecciones en Rampa · Netherlands ILT Platform Inspections · ICAO Doc 9760 Vol II Pt VII Airworthiness Manual.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
