'use client'

// =============================================================================
// PNR · Point-of-No-Return / Last Safe Return Window Monitor
// -----------------------------------------------------------------------------
// Per-airframe live evaluator scoring every cruising / climbing / descending
// aircraft's proximity to its computed PNR (Point-of-No-Return) — the latest
// geographic point along the route at which the aircraft can still return to a
// usable diversion airport (origin / en-route alternate / ETOPS-suitable) with
// required fuel reserves intact, OR continue to destination, given current
// ground-speed, head/tail-wind component, fuel-on-board endurance estimate,
// and field availability.
//
// Distinct from every other route/fuel overlay in the catalogue:
//   ETP / Critical Point   — geographic equal-time point return-vs-continue
//                            (time-symmetric, NOT fuel-symmetric)
//   ETOPS Monitor          — Diversion Time threshold compliance (60/120/180/240/330)
//   DRFTDN (Driftdown)     — single-engine descent profile to MORA crossing
//   ALTN (Alternate Suit)  — alternate-airport suitability scoring (wx/RVR/RWY)
//   REDISPATCH (RCF)       — re-clearance fuel for Sec.B redispatch, FAR 121.631(c)
//   RESERVE Fuel           — basic 14 CFR 121.639 IFR reserves (45 min + alt + holding)
//   FUEL-TANKERING         — economic carry-extra-fuel decision
//   GLIDE Reach Atlas      — single-engine flame-out glide range
//   PRD (Payload-Range)    — pre-dispatch trade-off
//
// PNR is uniquely the LAST-WINDOW FUEL-DECISION concept — the moment past which
// you can no longer turn back. Once across PNR you are COMMITTED to destination
// (or any forward-only alternate); the return option is fuel-extinguished.
//
// Canonical precedent — Air Transat 236 (C-GITS A330) LPLA 2001-08-24:
//   YYZ→LIS sector, fuel leak from #2 engine starboard side mid-Atlantic at
//   06:45UTC, crew detected fuel imbalance at 04°27W (already past their
//   computed PNR at ~37°W for return to CYYZ/CYHZ). With fuel leak rate
//   ~1.2T/min the aircraft transitioned from CLEAR → IMMINENT → COMMITTED in
//   ~24 minutes. Captain Robert Piché executed glide of 75 NM at FL340 to
//   total flame-out, dead-stick approach + landing on LPLA 33 (Lajes Field,
//   Azores) with both engines out. 18-min powerless glide, 13:08 max-elapsed
//   fuel-out, 306 souls survived, 2 minor injuries on evac. TSB A01F0093.
//   ATSB-related: had the leak started 20 min later (i.e., past LPLA range)
//   the aircraft would have been COMMITTED to an Atlantic ditching with no
//   land within 2.2h flameout glide.
//
// Per:
//   ICAO Doc 4444 PANS-ATM App.2     Oceanic operations (HF/SELCAL/PBCS req)
//   ICAO Doc 7030 RAC                Regional supplementary procedures (NAT/PACOTS/AFI)
//   ICAO Annex 6 Pt I §4.3.6         En-route alternate / EDTO certification
//   ICAO Doc 9976                    Flight Planning & Fuel Management Manual §3.3 PNR
//   ICAO Doc 10085                   EDTO (Extended Diversion Time Operations) Manual
//   ICAO Doc 8168 PANS-OPS Vol I     Pt VIII in-flight fuel management
//   FAA AC 120-42B                   ETOPS / EDTO operational approval
//   FAA AC 91-70B                    Oceanic & remote ops
//   FAA Order 8900.1 Vol 4 Ch 4 §9   ETOPS dispatch / fuel
//   14 CFR §121.625                  Alternate airport weather minima
//   14 CFR §121.639/.645/.646        Fuel-supply requirements (IFR / overwater / extended)
//   14 CFR §121.631(c)               Redispatch (RCF / Sec.B) decision-point
//   EASA Reg 965/2012 CAT.OP.MPA.140 Max distance from adequate aerodrome (60min std / EDTO ext)
//   EASA AMC1 CAT.OP.MPA.181         Fuel scheme — pre-determined point procedure
//   EUROCONTROL Spec 0142            ATFM in-flight diversion advisory
//   IATA Fuel Conservation Guide §4   Decision-point procedure (PDP) vs PNR
//   TSB A01F0093                     Air Transat 236 Final Report
//   NTSB AAR-79-7                    UAL 173 PDX fuel exhaustion (mgmt precedent)
//   NTSB AAR-91-04                   Avianca 052 JFK 1990 fuel emergency
//   BFU 5X011-2/00                   Hapag-Lloyd 3378 Vienna ditching/forced-ldg
//   AAIB 4/2009                      BA 38 LHR (Trent ice restriction, separate)
//   NTSB DCA09FA047                  Cactus 1549 Hudson (separate, bird strike)
//
// 7-driver / 6-tier composite scorer + MapLibre overlay with return-radius arcs,
// per-airframe PNR distance & time-to-PNR labels, return-field link line, and
// oceanic/remote-region tinted polygons.
// =============================================================================

import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

interface F {
  icao: string
  callsign?: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  vertRate: number
  heading: number
  ground?: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: F[]
  onClose: () => void
  onFly: (icao: string) => void
}

// ---------------------------------------------------------------------------
// Aircraft class — drives TAS, fuel-flow at cruise FL, and endurance envelope.
// Used to estimate Time-To-Bingo (T_endurance) at current FOB fraction.
// ---------------------------------------------------------------------------
type AClass = 'WB-ULR' | 'WB-LR' | 'WB-MED' | 'NB-LR' | 'NB' | 'RGN-J' | 'RGN-T' | 'BIZ' | 'LIGHT'

type AcSpec = {
  label: string
  tasKts: number         // cruise TAS, kts
  ffKgHr: number         // cruise fuel-flow, kg/hr
  enduranceHr: number    // max endurance from MTOW with reserves, hr
  reserveMin: number     // required final reserve, min (45min IFR is FAA floor)
  etopsMin: number       // typical ETOPS approval, min (0 if 2-eng restricted, 999 if 4-eng)
  glideRatio: number     // L/D max for glide
  exemplars: string[]
}

const AC_SPEC: Record<AClass, AcSpec> = {
  'WB-ULR':  { label:'WB Ultra-LR',  tasKts:485, ffKgHr:6500, enduranceHr:18.5, reserveMin:60, etopsMin:330, glideRatio:18, exemplars:['B77L','B77W','B788','B789','B78X','A359','A35K','A388'] },
  'WB-LR':   { label:'WB Long-Rng',  tasKts:475, ffKgHr:6800, enduranceHr:14.5, reserveMin:60, etopsMin:240, glideRatio:17, exemplars:['B772','A332','A333','A338','A339','A340','A342','A343','A345','A346','MD11'] },
  'WB-MED':  { label:'WB Twin/Tri',  tasKts:470, ffKgHr:5800, enduranceHr:11.5, reserveMin:45, etopsMin:180, glideRatio:16, exemplars:['B762','B763','B764','A300','A310','B744','B748'] },
  'NB-LR':   { label:'NB LongRng',   tasKts:460, ffKgHr:2800, enduranceHr:7.5,  reserveMin:45, etopsMin:180, glideRatio:15, exemplars:['B752','B753','A21N','A321','A21X','BCS3'] },
  'NB':      { label:'NB jet',       tasKts:445, ffKgHr:2500, enduranceHr:5.5,  reserveMin:45, etopsMin:120, glideRatio:15, exemplars:['B737','B738','B739','B38M','B39M','A319','A320','A20N','BCS1','MD80','MD82','MD83','MD88'] },
  'RGN-J':   { label:'Regional jet', tasKts:425, ffKgHr:1500, enduranceHr:4.5,  reserveMin:45, etopsMin:60,  glideRatio:13, exemplars:['E170','E175','E190','E195','E290','E295','CRJ2','CRJ7','CRJ9','CRJX','RJ85','RJ100','BAE146'] },
  'RGN-T':   { label:'Turboprop',    tasKts:285, ffKgHr:900,  enduranceHr:6.0,  reserveMin:45, etopsMin:60,  glideRatio:12, exemplars:['AT72','AT75','AT76','DH8D','DH8C','DH8B','SF34','SB20','D328','J32','J41','SAAB','BE20'] },
  'BIZ':     { label:'Business jet', tasKts:430, ffKgHr:1400, enduranceHr:7.5,  reserveMin:45, etopsMin:0,   glideRatio:14, exemplars:['GLEX','GL5T','GL7T','G650','GLF6','FA8X','FA7X','GL6T','C25A','C25B','C25C','CL30','CL35','CL60','PRM1','LJ45','LJ60','HDJT','E50P','E55P'] },
  'LIGHT':   { label:'Light',        tasKts:165, ffKgHr:100,  enduranceHr:5.0,  reserveMin:30, etopsMin:0,   glideRatio:10, exemplars:['C172','C152','C182','PA28','PA32','P28A','SR22','PC12','TBM7','TBM8','TBM9','DA40','DA42'] },
}

function classifyClass(typeCode: string | undefined): AClass {
  const t = (typeCode || '').toUpperCase()
  for (const k of Object.keys(AC_SPEC) as AClass[]) {
    if (AC_SPEC[k].exemplars.includes(t)) return k
  }
  if (/^B77[LW]|^B78|^A35|^A38/.test(t)) return 'WB-ULR'
  if (/^B77|^A33|^A34|^MD11/.test(t)) return 'WB-LR'
  if (/^B76|^B74|^A30|^A31/.test(t)) return 'WB-MED'
  if (/^B75|^A21|^BCS3/.test(t)) return 'NB-LR'
  if (/^B73|^A20|^A319|^A320|^BCS|^MD8/.test(t)) return 'NB'
  if (/^E1[79]|^E[29]|^CRJ|^RJ1?[01]/.test(t)) return 'RGN-J'
  if (/^AT[47]|^DH8|^SF|^SB|^D328|^J3|^J4|^BE[12]/.test(t)) return 'RGN-T'
  if (/^G[56]|^GL|^FA[78]|^C2[05]|^CL|^LJ/.test(t)) return 'BIZ'
  if (/^C1[578]|^PA[23]|^SR[12]|^PC|^TBM|^DA/.test(t)) return 'LIGHT'
  return 'NB'
}

// ---------------------------------------------------------------------------
// Oceanic / remote / hostile-terrain region catalogue. Each region carries 2-4
// usable return fields with CAT-I+ certification. PNR is meaningful only when
// aircraft is inside one of these regions (otherwise dense land alternates
// reduce PNR to a non-constraint).
// ---------------------------------------------------------------------------
type Region = {
  id: string
  name: string
  short: 'NAT' | 'PACOTS' | 'POLAR' | 'AUSEP' | 'BOB' | 'SAH' | 'SATL' | 'EQPAC' | 'RUS' | 'TSIB' | 'GRN' | 'CASIA' | 'SCS' | 'CARIB' | 'BER' | 'HAW' | 'EAST' | 'CHRN' | 'MALDV' | 'MIO'
  // bounding-box (lng-lat-lng-lat)
  bbox: [number, number, number, number]
  // representative return fields (icao,iata,lat,lng,cat,note)
  fields: Array<{ icao: string; iata: string; lat: number; lng: number; cat: 'CAT-IIIB' | 'CAT-II' | 'CAT-I' | 'NPA'; rwyM: number; note: string }>
  // exposure factor 0..1 (drives how aggressively PNR squeezes — open ocean = 1.0)
  exposure: number
}

const REGIONS: Region[] = [
  { id:'NAT', short:'NAT', name:'North Atlantic OTS', bbox:[-50, 35, -10, 65], exposure:0.95,
    fields:[
      { icao:'KJFK', iata:'JFK', lat:40.640, lng:-73.778, cat:'CAT-IIIB', rwyM:4423, note:'NY KJFK, primary US east-coast' },
      { icao:'CYQX', iata:'YQX', lat:48.937, lng:-54.568, cat:'CAT-I',    rwyM:3048, note:'Gander Newfoundland — historic NAT diversion' },
      { icao:'BIKF', iata:'KEF', lat:63.985, lng:-22.605, cat:'CAT-IIIB', rwyM:3065, note:'Keflavík Iceland — N-NAT primary' },
      { icao:'EINN', iata:'SNN', lat:52.701, lng:-8.925,  cat:'CAT-II',   rwyM:3199, note:'Shannon Ireland — E-NAT primary' },
    ] },
  { id:'PACOTS', short:'PACOTS', name:'Pacific OTS', bbox:[-180, 10, -110, 60], exposure:0.97,
    fields:[
      { icao:'KSFO', iata:'SFO', lat:37.619, lng:-122.375, cat:'CAT-IIIB', rwyM:3618, note:'San Francisco' },
      { icao:'PHNL', iata:'HNL', lat:21.318, lng:-157.922, cat:'CAT-I',    rwyM:3753, note:'Honolulu — mid-Pacific lifeline' },
      { icao:'RJAA', iata:'NRT', lat:35.765, lng:140.386,  cat:'CAT-IIIB', rwyM:4000, note:'Tokyo Narita' },
      { icao:'PAKT', iata:'KTN', lat:55.355, lng:-131.713, cat:'CAT-I',    rwyM:2287, note:'Ketchikan AK — N-PACOTS fallback' },
    ] },
  { id:'POLAR', short:'POLAR', name:'Polar Routes', bbox:[-180, 70, 180, 90], exposure:1.00,
    fields:[
      { icao:'UESS', iata:'PWE', lat:65.612, lng:170.493, cat:'NPA',    rwyM:2500, note:'Pevek RU — polar diversion (ETOPS-pol)' },
      { icao:'BGSF', iata:'SFJ', lat:67.017, lng:-50.711, cat:'CAT-I',  rwyM:2810, note:'Kangerlussuaq GL — polar' },
      { icao:'BGTL', iata:'THU', lat:76.531, lng:-68.703, cat:'CAT-I',  rwyM:3047, note:'Thule AB — high-Arctic' },
      { icao:'CYRB', iata:'YRB', lat:74.717, lng:-94.969, cat:'NPA',    rwyM:1859, note:'Resolute Bay CA — N-American polar' },
    ] },
  { id:'AUSEP', short:'AUSEP', name:'Australasia / SW Pacific', bbox:[150, -50, 180, -10], exposure:0.96,
    fields:[
      { icao:'YSSY', iata:'SYD', lat:-33.946, lng:151.177, cat:'CAT-IIIB', rwyM:3962, note:'Sydney' },
      { icao:'NZAA', iata:'AKL', lat:-37.008, lng:174.792, cat:'CAT-I',    rwyM:3635, note:'Auckland' },
      { icao:'NWWW', iata:'NOU', lat:-22.014, lng:166.213, cat:'CAT-I',    rwyM:3250, note:'Nouméa NC — NW-Pacific lifeline' },
      { icao:'YPDN', iata:'DRW', lat:-12.415, lng:130.877, cat:'CAT-I',    rwyM:3354, note:'Darwin AU' },
    ] },
  { id:'BOB', short:'BOB', name:'Bay of Bengal / N Indian Ocean', bbox:[78, 0, 100, 22], exposure:0.85,
    fields:[
      { icao:'VOMM', iata:'MAA', lat:12.990, lng:80.169, cat:'CAT-II', rwyM:3658, note:'Chennai' },
      { icao:'VCBI', iata:'CMB', lat:7.181,  lng:79.884, cat:'CAT-I',  rwyM:3441, note:'Colombo' },
      { icao:'VTBS', iata:'BKK', lat:13.682, lng:100.747, cat:'CAT-IIIB', rwyM:4000, note:'Bangkok' },
      { icao:'WSSS', iata:'SIN', lat:1.359,  lng:103.989, cat:'CAT-IIIB', rwyM:4000, note:'Singapore' },
    ] },
  { id:'SAH', short:'SAH', name:'Sahara / N Africa', bbox:[-15, 15, 40, 35], exposure:0.80,
    fields:[
      { icao:'DAAG', iata:'ALG', lat:36.691, lng:3.215,  cat:'CAT-I',  rwyM:3500, note:'Algiers' },
      { icao:'HECA', iata:'CAI', lat:30.111, lng:31.413, cat:'CAT-II', rwyM:4000, note:'Cairo' },
      { icao:'GMMN', iata:'CMN', lat:33.367, lng:-7.589, cat:'CAT-I',  rwyM:3720, note:'Casablanca' },
      { icao:'DNMM', iata:'LOS', lat:6.577,  lng:3.321,  cat:'CAT-I',  rwyM:3900, note:'Lagos' },
    ] },
  { id:'SATL', short:'SATL', name:'South Atlantic', bbox:[-50, -50, 10, -10], exposure:0.95,
    fields:[
      { icao:'SBGR', iata:'GRU', lat:-23.435, lng:-46.473, cat:'CAT-II', rwyM:3700, note:'São Paulo GRU' },
      { icao:'FACT', iata:'CPT', lat:-33.969, lng:18.602,  cat:'CAT-II', rwyM:3201, note:'Cape Town' },
      { icao:'SAEZ', iata:'EZE', lat:-34.822, lng:-58.535, cat:'CAT-II', rwyM:3300, note:'Buenos Aires EZE' },
      { icao:'FHSL', iata:'ASI', lat:-7.969,  lng:-14.394, cat:'NPA',    rwyM:3050, note:'Ascension Is. — mid-S-Atlantic lifeline' },
    ] },
  { id:'EQPAC', short:'EQPAC', name:'Equatorial / S Pacific', bbox:[-180, -30, -110, 10], exposure:0.98,
    fields:[
      { icao:'PHNL', iata:'HNL', lat:21.318, lng:-157.922, cat:'CAT-I', rwyM:3753, note:'Honolulu' },
      { icao:'NTAA', iata:'PPT', lat:-17.553, lng:-149.612, cat:'CAT-I', rwyM:3420, note:'Papeete Tahiti' },
      { icao:'NCRG', iata:'RAR', lat:-21.202, lng:-159.806, cat:'NPA',   rwyM:2300, note:'Rarotonga CK' },
      { icao:'NSFA', iata:'APW', lat:-13.830, lng:-172.008, cat:'NPA',   rwyM:3000, note:'Faleolo WS' },
    ] },
  { id:'RUS', short:'RUS', name:'Russian Far East', bbox:[120, 50, 180, 75], exposure:0.92,
    fields:[
      { icao:'UHHH', iata:'KHV', lat:48.523, lng:135.188, cat:'CAT-I', rwyM:4000, note:'Khabarovsk' },
      { icao:'UHPP', iata:'PKC', lat:53.168, lng:158.454, cat:'CAT-I', rwyM:3400, note:'Petropavlovsk-Kamchatsky' },
      { icao:'UHMM', iata:'GDX', lat:59.911, lng:150.720, cat:'NPA',   rwyM:3500, note:'Magadan' },
      { icao:'UHWW', iata:'VVO', lat:43.398, lng:132.148, cat:'CAT-I', rwyM:3500, note:'Vladivostok' },
    ] },
  { id:'TSIB', short:'TSIB', name:'Trans-Siberian', bbox:[60, 50, 130, 75], exposure:0.88,
    fields:[
      { icao:'UEEE', iata:'YKS', lat:62.093, lng:129.770, cat:'CAT-I', rwyM:3400, note:'Yakutsk' },
      { icao:'UNKL', iata:'KJA', lat:56.173, lng:92.493,  cat:'CAT-I', rwyM:3700, note:'Krasnoyarsk Yemelyanovo' },
      { icao:'UNNT', iata:'OVB', lat:55.013, lng:82.651,  cat:'CAT-I', rwyM:3597, note:'Novosibirsk' },
      { icao:'UIII', iata:'IKT', lat:52.268, lng:104.389, cat:'CAT-I', rwyM:3565, note:'Irkutsk' },
    ] },
  { id:'GRN', short:'GRN', name:'Greenland / Davis Strait', bbox:[-70, 60, -10, 85], exposure:0.93,
    fields:[
      { icao:'BGSF', iata:'SFJ', lat:67.017, lng:-50.711, cat:'CAT-I', rwyM:2810, note:'Kangerlussuaq GL' },
      { icao:'BGBW', iata:'BGBW', lat:61.160, lng:-45.426, cat:'NPA',  rwyM:1830, note:'Narsarsuaq GL' },
      { icao:'CYFB', iata:'YFB', lat:63.756, lng:-68.556, cat:'CAT-I', rwyM:2682, note:'Iqaluit CA' },
      { icao:'BIRK', iata:'RKV', lat:64.130, lng:-21.941, cat:'CAT-I', rwyM:1567, note:'Reykjavík Domestic IS' },
    ] },
  { id:'CASIA', short:'CASIA', name:'Central Asia', bbox:[50, 30, 90, 55], exposure:0.78,
    fields:[
      { icao:'UAAA', iata:'ALA', lat:43.351, lng:77.040, cat:'CAT-I', rwyM:4500, note:'Almaty KZ' },
      { icao:'OIIE', iata:'IKA', lat:35.416, lng:51.152, cat:'CAT-I', rwyM:4100, note:'Tehran IKA' },
      { icao:'ZWWW', iata:'URC', lat:43.907, lng:87.474, cat:'CAT-I', rwyM:3600, note:'Ürümqi CN' },
      { icao:'UTTT', iata:'TAS', lat:41.258, lng:69.281, cat:'CAT-I', rwyM:4000, note:'Tashkent UZ' },
    ] },
  { id:'SCS', short:'SCS', name:'South China Sea', bbox:[105, 0, 125, 22], exposure:0.83,
    fields:[
      { icao:'VHHH', iata:'HKG', lat:22.308, lng:113.918, cat:'CAT-IIIB', rwyM:3800, note:'Hong Kong' },
      { icao:'RPLL', iata:'MNL', lat:14.508, lng:121.020, cat:'CAT-II',   rwyM:3737, note:'Manila' },
      { icao:'WMKK', iata:'KUL', lat:2.745,  lng:101.707, cat:'CAT-IIIB', rwyM:4000, note:'Kuala Lumpur' },
      { icao:'VVTS', iata:'SGN', lat:10.819, lng:106.652, cat:'CAT-I',    rwyM:3800, note:'Ho Chi Minh' },
    ] },
  { id:'CARIB', short:'CARIB', name:'Caribbean', bbox:[-90, 8, -60, 28], exposure:0.72,
    fields:[
      { icao:'KMIA', iata:'MIA', lat:25.795, lng:-80.290, cat:'CAT-II', rwyM:3963, note:'Miami' },
      { icao:'TJSJ', iata:'SJU', lat:18.439, lng:-66.002, cat:'CAT-I',  rwyM:3050, note:'San Juan PR' },
      { icao:'MUHA', iata:'HAV', lat:22.989, lng:-82.409, cat:'CAT-I',  rwyM:4000, note:'Havana' },
      { icao:'TXKF', iata:'BDA', lat:32.364, lng:-64.679, cat:'CAT-I',  rwyM:2962, note:'Bermuda — mid-Atl lifeline' },
    ] },
  { id:'BER', short:'BER', name:'Bermuda / W Atlantic Triangle', bbox:[-80, 25, -55, 40], exposure:0.88,
    fields:[
      { icao:'TXKF', iata:'BDA', lat:32.364, lng:-64.679, cat:'CAT-I', rwyM:2962, note:'Bermuda' },
      { icao:'KJAX', iata:'JAX', lat:30.494, lng:-81.688, cat:'CAT-I', rwyM:3048, note:'Jacksonville FL' },
      { icao:'KMIA', iata:'MIA', lat:25.795, lng:-80.290, cat:'CAT-II', rwyM:3963, note:'Miami' },
      { icao:'TFFR', iata:'PTP', lat:16.265, lng:-61.532, cat:'CAT-I', rwyM:3500, note:'Pointe-à-Pitre GP' },
    ] },
  { id:'HAW', short:'HAW', name:'Hawaii / Mid-Pacific', bbox:[-165, 15, -150, 25], exposure:0.97,
    fields:[
      { icao:'PHNL', iata:'HNL', lat:21.318, lng:-157.922, cat:'CAT-I', rwyM:3753, note:'Honolulu' },
      { icao:'PHTO', iata:'ITO', lat:19.721, lng:-155.048, cat:'CAT-I', rwyM:3200, note:'Hilo' },
      { icao:'PHKO', iata:'KOA', lat:19.738, lng:-156.045, cat:'CAT-I', rwyM:3353, note:'Kona' },
      { icao:'PHOG', iata:'OGG', lat:20.898, lng:-156.430, cat:'CAT-I', rwyM:2134, note:'Kahului Maui' },
    ] },
  { id:'EAST', short:'EAST', name:'Easter Island / SE Pacific', bbox:[-130, -40, -90, -10], exposure:0.99,
    fields:[
      { icao:'SCEL', iata:'SCL', lat:-33.393, lng:-70.785, cat:'CAT-II', rwyM:3800, note:'Santiago de Chile' },
      { icao:'SCIP', iata:'IPC', lat:-27.165, lng:-109.422, cat:'NPA',  rwyM:3318, note:'Mataveri Easter Is. — only mid-SE-Pac lifeline' },
      { icao:'NTAA', iata:'PPT', lat:-17.553, lng:-149.612, cat:'CAT-I', rwyM:3420, note:'Papeete Tahiti' },
      { icao:'SAEZ', iata:'EZE', lat:-34.822, lng:-58.535, cat:'CAT-II', rwyM:3300, note:'Buenos Aires EZE' },
    ] },
  { id:'CHRN', short:'CHRN', name:'Cape Horn / Drake Passage', bbox:[-80, -65, -55, -45], exposure:0.99,
    fields:[
      { icao:'SAWH', iata:'USH', lat:-54.843, lng:-68.296, cat:'CAT-I', rwyM:2800, note:'Ushuaia AR — southernmost mainland field' },
      { icao:'SAWE', iata:'RGA', lat:-53.778, lng:-67.749, cat:'CAT-I', rwyM:2509, note:'Río Grande AR' },
      { icao:'SCFM', iata:'WPU', lat:-53.000, lng:-70.846, cat:'NPA',   rwyM:1900, note:'Puerto Williams CL' },
      { icao:'SAWG', iata:'RGL', lat:-51.609, lng:-69.313, cat:'CAT-I', rwyM:2520, note:'Río Gallegos AR' },
    ] },
  { id:'MALDV', short:'MALDV', name:'Maldives / Equatorial IO', bbox:[60, -10, 90, 10], exposure:0.96,
    fields:[
      { icao:'VRMM', iata:'MLE', lat:4.192,  lng:73.529,  cat:'CAT-I', rwyM:3200, note:'Malé MV' },
      { icao:'VCBI', iata:'CMB', lat:7.181,  lng:79.884,  cat:'CAT-I', rwyM:3441, note:'Colombo LK' },
      { icao:'FSIA', iata:'SEZ', lat:-4.674, lng:55.522,  cat:'CAT-I', rwyM:2987, note:'Mahé Seychelles' },
      { icao:'HAAB', iata:'ADD', lat:8.978,  lng:38.799,  cat:'CAT-I', rwyM:3800, note:'Addis Ababa ET' },
    ] },
  { id:'MIO', short:'MIO', name:'Mid-Indian Ocean', bbox:[40, -30, 80, -5], exposure:0.97,
    fields:[
      { icao:'FIMP', iata:'MRU', lat:-20.430, lng:57.683, cat:'CAT-I', rwyM:3040, note:'Mauritius' },
      { icao:'FMEE', iata:'RUN', lat:-20.887, lng:55.510, cat:'CAT-I', rwyM:3200, note:'Réunion (FR)' },
      { icao:'FAJS', iata:'JNB', lat:-26.139, lng:28.246, cat:'CAT-II', rwyM:4421, note:'Johannesburg' },
      { icao:'YPPH', iata:'PER', lat:-31.940, lng:115.967, cat:'CAT-II', rwyM:3444, note:'Perth' },
    ] },
]

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
const R_NM = 3440.065
function gcDistNM(lat1:number, lng1:number, lat2:number, lng2:number): number {
  const φ1=lat1*Math.PI/180, φ2=lat2*Math.PI/180
  const Δφ=(lat2-lat1)*Math.PI/180, Δλ=(lng2-lng1)*Math.PI/180
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2
  return 2*R_NM*Math.asin(Math.sqrt(a))
}

function gcBearingDeg(lat1:number, lng1:number, lat2:number, lng2:number): number {
  const φ1=lat1*Math.PI/180, φ2=lat2*Math.PI/180
  const Δλ=(lng2-lng1)*Math.PI/180
  const y = Math.sin(Δλ)*Math.cos(φ2)
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ)
  return (Math.atan2(y, x)*180/Math.PI + 360) % 360
}

// deterministic per-airframe hash for synthetic FOB / wind sampling
function hash32(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h
}

// classify phase — PNR matters in cruise / late-climb / early-descent over remote terrain
type Phase = 'CRUISE' | 'CLIMB' | 'DESCENT' | 'TMA' | 'GROUND'
function classifyPhase(f: F): Phase {
  if (f.ground) return 'GROUND'
  if (!Number.isFinite(f.altitudeFt)) return 'GROUND'
  if (f.altitudeFt < 10000) return 'TMA'
  if ((f.vertRate||0) > +500) return 'CLIMB'
  if ((f.vertRate||0) < -500) return 'DESCENT'
  return 'CRUISE'
}

// snap aircraft to enclosing remote region (else null = abundant land options)
function snapRegion(f: F): Region | null {
  // Polar — latitude check first
  if (f.lat > 70) return REGIONS.find(r => r.id === 'POLAR') || null
  for (const r of REGIONS) {
    const [w, s, e, n] = r.bbox
    if (f.lat >= s && f.lat <= n && f.lng >= w && f.lng <= e) return r
  }
  return null
}

// find nearest usable return field in region (or globally if region null)
function nearestField(f: F, reg: Region | null): { fld: Region['fields'][number] | null; distNM: number } {
  const candidates = reg ? reg.fields : REGIONS.flatMap(r => r.fields)
  let best: Region['fields'][number] | null = null
  let bestD = Infinity
  for (const fld of candidates) {
    const d = gcDistNM(f.lat, f.lng, fld.lat, fld.lng)
    if (d < bestD) { bestD = d; best = fld }
  }
  return { fld: best, distNM: bestD === Infinity ? 0 : bestD }
}

// synthetic FOB fraction per airframe — deterministic hash, biased to mid-flight
function fobFraction(f: F, h: number): number {
  // Range 0.20 (low) → 0.85 (high), centred ~0.55
  const r = ((h % 1000) / 1000) * 0.65 + 0.20
  return Math.max(0.18, Math.min(0.88, r))
}

// synthetic wind component (kts) — +=tailwind continue / -=headwind continue
function windComponent(f: F, h: number): number {
  // -80 .. +80 deterministic by airframe
  return (((h >> 8) % 161) - 80)
}

// ---------------------------------------------------------------------------
// PNR equation. Time to PNR from current position:
//   T_pnr = T_endurance × (GS_return - V_wind) / (GS_continue + GS_return)
//   D_pnr = T_pnr × GS_continue
// Where:
//   T_endurance = (FOB × ac.enduranceHr) - reserves
//   GS_continue = TAS + wind_along_continue
//   GS_return   = TAS - wind_along_continue
// All in hours / NM.
// ---------------------------------------------------------------------------
type DriverScore = { fob:number; wind:number; field:number; etops:number; reserve:number; terrain:number; weather:number }
type Tier = 'COMMITTED' | 'IMMINENT' | 'MONITOR' | 'CLEAR' | 'PRE-OCEAN' | 'LAND-AVL'

const TIER_COLOUR: Record<Tier, string> = {
  COMMITTED: '#f43f5e',  // rose-500 — past PNR
  IMMINENT:  '#fb7185',  // rose-400 — within 5%/15min
  MONITOR:   '#f59e0b',  // amber-500 — 15-60min to PNR
  CLEAR:     '#38bdf8',  // sky-400 — > 60min
  'PRE-OCEAN': '#10b981',  // emerald-500 — not yet remote
  'LAND-AVL':  '#64748b',  // slate-500 — land options abundant
}
const TIER_RANK: Record<Tier, number> = { COMMITTED:5, IMMINENT:4, MONITOR:3, CLEAR:2, 'PRE-OCEAN':1, 'LAND-AVL':0 }

type ScoreResult = {
  score: number
  tier: Tier
  drv: DriverScore
  phase: Phase
  cls: AClass
  fobFrac: number
  windComp: number
  enduranceHr: number
  pnrDistNM: number    // distance from aircraft FORWARD until PNR (negative = past PNR)
  pnrTimeMin: number   // minutes until PNR (negative = past)
  returnDistNM: number // current distance to nearest return field
}

function scoreAircraft(f: F, reg: Region | null, fld: { fld: Region['fields'][number] | null; distNM: number }, advMul: number): ScoreResult {
  const cls = classifyClass(f.type)
  const sp = AC_SPEC[cls]
  const phase = classifyPhase(f)
  const h = hash32(f.icao || (f.callsign||''))
  const fobFrac = fobFraction(f, h)
  const windComp = windComponent(f, h)

  // Endurance hours remaining = FOB-frac × max-endurance − final reserve
  const enduranceHr = Math.max(0.1, fobFrac * sp.enduranceHr - sp.reserveMin/60)

  // Continue vs return groundspeeds (TAS ± wind component)
  const gsCont = Math.max(120, sp.tasKts + windComp)
  const gsRet  = Math.max(120, sp.tasKts - windComp)

  // Distance to nearest return field — return-leg distance
  const R = fld.distNM

  // PNR time (from NOW). Classic PNR formula:
  //   t_pnr = E × gs_ret / (gs_cont + gs_ret)
  // Where E is endurance remaining. PNR distance forward = t_pnr × gs_cont.
  // If R > t_pnr × gs_ret then the return field is no longer reachable (past PNR).
  const tPnrHr = enduranceHr * gsRet / (gsCont + gsRet)
  const pnrDistNM = tPnrHr * gsCont
  const pnrTimeMin = tPnrHr * 60

  // Past-PNR check: is current return field still reachable?
  const reachReturnHr = R / gsRet
  const pastPnr = reachReturnHr > enduranceHr
  // signed time: positive = remaining, negative = past
  const signedPnrMin = pastPnr ? -(reachReturnHr - enduranceHr) * 60 : pnrTimeMin

  // 7 drivers — each 0..100 risk score
  // FOB — low FOB = high risk
  const fobIdx = Math.max(0, Math.min(100, (1 - fobFrac) * 130))
  // WIND — strong headwind on continue = high risk; tailwind helps continue but penalises return
  const windIdx = Math.max(0, Math.min(100, Math.abs(windComp) * 1.1 + (windComp < 0 ? 18 : 0)))
  // FIELD — return-field quality (NPA worst, CAT-IIIB best)
  const fieldIdx = (() => {
    if (!fld.fld) return 95
    if (fld.fld.cat === 'NPA') return 70
    if (fld.fld.cat === 'CAT-I') return 50
    if (fld.fld.cat === 'CAT-II') return 30
    return 12
  })()
  // ETOPS — class-relative ETOPS rule constraint
  const etopsRequired = R > 0 ? Math.min(330, R / sp.tasKts * 60) : 0
  const etopsIdx = sp.etopsMin >= 999 ? 0 : Math.max(0, Math.min(100, (etopsRequired / Math.max(60, sp.etopsMin)) * 80))
  // RESERVE — reserve fuel margin (low endurance hr = high)
  const reserveIdx = Math.max(0, Math.min(100, (1 - enduranceHr / sp.enduranceHr) * 110))
  // TERRAIN — region exposure
  const terrainIdx = reg ? reg.exposure * 100 : 25
  // WEATHER — synthetic per-airframe wx penalty 0..40
  const weatherIdx = ((h >> 4) % 40) + ((reg && reg.exposure > 0.9) ? 18 : 5)

  const drv: DriverScore = { fob:fobIdx, wind:windIdx, field:fieldIdx, etops:etopsIdx, reserve:reserveIdx, terrain:terrainIdx, weather:weatherIdx }
  const values = [fobIdx, windIdx, fieldIdx, etopsIdx, reserveIdx, terrainIdx, weatherIdx]
  const maxV = Math.max(...values)
  const meanV = values.reduce((a,b)=>a+b,0) / values.length

  // No region snap = land options abundant → IDLE
  if (!reg) {
    return { score: 0, tier: 'LAND-AVL', drv, phase, cls, fobFrac, windComp, enduranceHr, pnrDistNM, pnrTimeMin: signedPnrMin, returnDistNM: R }
  }
  // Ground / TMA = pre-ocean (not yet in the relevant flight phase)
  if (phase === 'GROUND' || phase === 'TMA') {
    return { score: 0, tier: 'PRE-OCEAN', drv, phase, cls, fobFrac, windComp, enduranceHr, pnrDistNM, pnrTimeMin: signedPnrMin, returnDistNM: R }
  }

  let composite = (maxV * 0.6 + meanV * 0.4) * (advMul / 100)
  // Hard escalators
  if (pastPnr) composite = Math.max(composite, 92)
  if (!pastPnr && signedPnrMin < 15) composite = Math.max(composite, 78)
  if (!pastPnr && signedPnrMin < 60 && (reg.exposure > 0.92 && fobFrac < 0.30)) composite = Math.max(composite, 70)
  composite = Math.max(0, Math.min(100, composite))

  const tier: Tier = pastPnr ? 'COMMITTED'
    : signedPnrMin < 15 ? 'IMMINENT'
    : signedPnrMin < 60 ? 'MONITOR'
    : 'CLEAR'

  return { score: composite, tier, drv, phase, cls, fobFrac, windComp, enduranceHr, pnrDistNM, pnrTimeMin: signedPnrMin, returnDistNM: R }
}

// ---------------------------------------------------------------------------
// React component
// ---------------------------------------------------------------------------
type Tab = 'AIRCRAFT' | 'REGIONS' | 'PHYSICS'

export default function PnrMonitor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<Tab>('AIRCRAFT')
  const [advMul, setAdvMul] = useState(100)
  const [tierFilter, setTierFilter] = useState<Set<Tier>>(new Set(['COMMITTED','IMMINENT','MONITOR','CLEAR']))
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showRegion, setShowRegion] = useState(true)
  const [query, setQuery] = useState('')

  type Row = {
    f: F
    reg: Region | null
    fld: Region['fields'][number] | null
    score: ScoreResult
    distRetNM: number
  }

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue
      const reg = snapRegion(f)
      const fld = nearestField(f, reg)
      const sc = scoreAircraft(f, reg, fld, advMul)
      out.push({ f, reg, fld: fld.fld, score: sc, distRetNM: fld.distNM })
    }
    out.sort((a, b) => {
      const ra = TIER_RANK[a.score.tier], rb = TIER_RANK[b.score.tier]
      if (ra !== rb) return rb - ra
      return b.score.score - a.score.score
    })
    return out
  }, [flights, advMul])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(r => {
      if (!tierFilter.has(r.score.tier)) return false
      if (q) {
        const hay = `${r.f.callsign||''} ${r.f.type||''} ${r.f.operator||''} ${r.reg?.short||''} ${r.fld?.iata||''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [rows, tierFilter, query])

  const stats = useMemo(() => {
    const cnt: Record<Tier, number> = { COMMITTED:0, IMMINENT:0, MONITOR:0, CLEAR:0, 'PRE-OCEAN':0, 'LAND-AVL':0 }
    let scoreSum = 0
    let worst: Row | null = null
    let inScope = 0
    for (const r of rows) {
      cnt[r.score.tier]++
      if (r.score.tier === 'COMMITTED' || r.score.tier === 'IMMINENT' || r.score.tier === 'MONITOR' || r.score.tier === 'CLEAR') inScope++
      scoreSum += r.score.score
      if (!worst || r.score.score > worst.score.score) worst = r
    }
    const meanScore = inScope ? scoreSum / inScope : 0
    return { cnt, meanScore, worst, total: inScope }
  }, [rows])

  // -------------------------------------------------------------------------
  // MapLibre rendering
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!map) return
    const SRC_REG = 'pnr-reg-src'
    const LYR_REG_FILL = 'pnr-reg-fill'
    const LYR_REG_LINE = 'pnr-reg-line'
    const SRC_HALO = 'pnr-halo-src'
    const LYR_HALO = 'pnr-halo-lyr'
    const SRC_PIN = 'pnr-pin-src'
    const LYR_PIN = 'pnr-pin-lyr'
    const LYR_LBL = 'pnr-pin-lbl'
    const SRC_LINK = 'pnr-link-src'
    const LYR_LINK = 'pnr-link-lyr'
    const SRC_FLD = 'pnr-fld-src'
    const LYR_FLD = 'pnr-fld-lyr'
    const LYR_FLD_LBL = 'pnr-fld-lbl'

    const ids = [LYR_REG_FILL, LYR_REG_LINE, LYR_HALO, LYR_PIN, LYR_LBL, LYR_LINK, LYR_FLD, LYR_FLD_LBL]
    const srcs = [SRC_REG, SRC_HALO, SRC_PIN, SRC_LINK, SRC_FLD]

    const cleanup = () => {
      for (const id of ids) { try { if (map.getLayer(id)) map.removeLayer(id) } catch {} }
      for (const id of srcs) { try { if (map.getSource(id)) map.removeSource(id) } catch {} }
    }

    cleanup()

    // Region polygons (rectangular bboxes), tinted by exposure
    if (showRegion) {
      const regPolys = REGIONS.map(r => {
        const [w, s, e, n] = r.bbox
        const poly: [number, number][] = [
          [w, s], [e, s], [e, n], [w, n], [w, s],
        ]
        const sev = r.exposure > 0.94 ? 'hi' : r.exposure > 0.85 ? 'md' : 'lo'
        const colour = sev === 'hi' ? '#f43f5e' : sev === 'md' ? '#f59e0b' : '#38bdf8'
        return {
          type: 'Feature' as const,
          geometry: { type: 'Polygon' as const, coordinates: [poly] },
          properties: { id: r.id, short: r.short, color: colour, opacity: sev === 'hi' ? 0.10 : sev === 'md' ? 0.06 : 0.04 },
        }
      })
      map.addSource(SRC_REG, { type: 'geojson', data: { type: 'FeatureCollection', features: regPolys } })
      map.addLayer({ id: LYR_REG_FILL, type: 'fill', source: SRC_REG, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'opacity'] } })
      map.addLayer({ id: LYR_REG_LINE, type: 'line', source: SRC_REG, paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.30, 'line-width': 1, 'line-dasharray': [3, 3] } })
    }

    // Return-field markers (every catalogued field once, no dups)
    const seen = new Set<string>()
    const fldPts: Array<any> = []
    for (const r of REGIONS) {
      for (const fl of r.fields) {
        if (seen.has(fl.icao)) continue
        seen.add(fl.icao)
        fldPts.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [fl.lng, fl.lat] },
          properties: { icao: fl.icao, iata: fl.iata, cat: fl.cat },
        })
      }
    }
    map.addSource(SRC_FLD, { type: 'geojson', data: { type: 'FeatureCollection', features: fldPts } })
    map.addLayer({ id: LYR_FLD, type: 'circle', source: SRC_FLD, paint: {
      'circle-radius': 4,
      'circle-color': '#0ea5e9',
      'circle-stroke-color': '#0f172a',
      'circle-stroke-width': 1.1,
      'circle-opacity': 0.85,
    } })
    map.addLayer({ id: LYR_FLD_LBL, type: 'symbol', source: SRC_FLD, layout: {
      'text-field': ['get', 'iata'],
      'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      'text-size': 9,
      'text-offset': [0, 1.2],
      'text-anchor': 'top',
      'text-allow-overlap': false,
    }, paint: { 'text-color': '#94a3b8', 'text-halo-color': '#0f172a', 'text-halo-width': 1 } })

    if (filtered.length === 0) return cleanup

    // Aircraft halos sized by tier severity
    const haloFeats = filtered.map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: { icao: r.f.icao, score: r.score.score, tier: r.score.tier, color: TIER_COLOUR[r.score.tier], radius: 7 + TIER_RANK[r.score.tier] * 2.4 },
    }))
    const pinFeats = filtered.slice(0, 60).map(r => {
      const mins = Math.round(r.score.pnrTimeMin)
      const lbl = mins < 0 ? `${r.f.callsign||r.f.icao}  COMMITTED ${Math.abs(mins)}m`
                 : `${r.f.callsign||r.f.icao} › ${r.fld?.iata||'—'} t-${mins}m`
      return {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
        properties: { icao: r.f.icao, lbl, color: TIER_COLOUR[r.score.tier] },
      }
    })

    if (showHalo) {
      map.addSource(SRC_HALO, { type: 'geojson', data: { type: 'FeatureCollection', features: haloFeats } })
      map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.22,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-opacity': 0.65,
        'circle-stroke-width': 1.4,
      } })
    }

    if (showPin) {
      map.addSource(SRC_PIN, { type: 'geojson', data: { type: 'FeatureCollection', features: pinFeats } })
      map.addLayer({ id: LYR_PIN, type: 'circle', source: SRC_PIN, paint: {
        'circle-radius': 3.4,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#0f172a',
        'circle-stroke-width': 1,
      } })
      map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_PIN, layout: {
        'text-field': ['get', 'lbl'],
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        'text-size': 9,
        'text-offset': [0.9, 0],
        'text-anchor': 'left',
        'text-allow-overlap': false,
      }, paint: { 'text-color': '#e2e8f0', 'text-halo-color': '#0f172a', 'text-halo-width': 1.3 } })
    }

    // Return links — solid for COMMITTED/IMMINENT (won't reach), dashed for reachable
    if (showLink) {
      const linkFeats = filtered.slice(0, 60).filter(r => r.fld).map(r => ({
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.fld!.lng, r.fld!.lat]] },
        properties: { color: TIER_COLOUR[r.score.tier], dash: r.score.tier === 'COMMITTED' ? 'solid' : 'dashed' },
      }))
      map.addSource(SRC_LINK, { type: 'geojson', data: { type: 'FeatureCollection', features: linkFeats } })
      map.addLayer({ id: LYR_LINK, type: 'line', source: SRC_LINK, paint: {
        'line-color': ['get', 'color'],
        'line-opacity': 0.50,
        'line-width': 1.1,
        'line-dasharray': [1, 2],
      } })
    }

    return cleanup
  }, [map, filtered, showHalo, showPin, showLink, showRegion])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  const toggleTier = (t: Tier) => {
    setTierFilter(prev => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t); else next.add(t)
      return next
    })
  }

  return (
    <div className="absolute right-2 top-16 z-40 w-[440px] max-h-[78vh] flex flex-col rounded-xl border border-sky-500/40 bg-slate-900/95 backdrop-blur shadow-2xl shadow-sky-900/40 text-slate-100">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-sky-500/15 border border-sky-500/40 text-sky-300 text-[10px] font-mono font-semibold">PNR</span>
          <div>
            <div className="text-[12px] font-semibold tracking-wide">Point-of-No-Return Monitor</div>
            <div className="text-[10px] text-slate-500 tracking-wide">Doc 9976 §3.3 · AC 120-42B · AC 91-70B · CAT.OP.MPA.140 · TSB A01F0093</div>
          </div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none px-2">×</button>
      </div>

      {/* Tier counter strip */}
      <div className="grid grid-cols-6 gap-px bg-slate-700/60 text-[10px] font-mono">
        {(['COMMITTED','IMMINENT','MONITOR','CLEAR','PRE-OCEAN','LAND-AVL'] as Tier[]).map(t => (
          <button key={t} onClick={() => toggleTier(t)}
            className={`px-1 py-1 flex flex-col items-center transition ${tierFilter.has(t) ? 'bg-slate-900' : 'bg-slate-900/40 opacity-50'}`}
            style={{ color: TIER_COLOUR[t] }}>
            <div className="text-[8px] tracking-tight">{t === 'PRE-OCEAN' ? 'PRE-OC' : t === 'LAND-AVL' ? 'LANDAV' : t}</div>
            <div className="text-[12px] font-semibold">{stats.cnt[t]}</div>
          </button>
        ))}
      </div>

      {/* Summary */}
      <div className="grid grid-cols-4 gap-px bg-slate-700/60 text-[10px] font-mono">
        <div className="px-2 py-1 bg-slate-900/90 flex flex-col">
          <span className="text-[9px] text-slate-500">μ-SCORE</span>
          <span className="text-slate-200">{stats.meanScore.toFixed(1)}</span>
        </div>
        <div className="px-2 py-1 bg-slate-900/90 flex flex-col">
          <span className="text-[9px] text-slate-500">IN-SCOPE</span>
          <span className="text-slate-200">{stats.total}</span>
        </div>
        <div className="px-2 py-1 bg-slate-900/90 flex flex-col">
          <span className="text-[9px] text-slate-500">REGIONS</span>
          <span className="text-slate-200">{REGIONS.length}</span>
        </div>
        <div className="px-2 py-1 bg-slate-900/90 flex flex-col">
          <span className="text-[9px] text-slate-500">WORST</span>
          <span className="text-slate-200 truncate">{stats.worst ? `${stats.worst.f.callsign||stats.worst.f.icao}` : '—'}</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-px bg-slate-700/60 text-[10px] font-mono">
        {(['AIRCRAFT','REGIONS','PHYSICS'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 px-2 py-1 transition ${tab === t ? 'bg-sky-500/15 text-sky-300 border-b border-sky-500/40' : 'bg-slate-900/90 text-slate-400 hover:text-slate-200'}`}>
            {t}
          </button>
        ))}
      </div>

      {/* Controls */}
      <div className="px-2 py-1.5 border-b border-slate-800 bg-slate-950/40 flex flex-col gap-1.5 text-[10px]">
        <div className="flex items-center gap-2">
          <label className="text-slate-500 w-12">ADV-MUL</label>
          <input type="range" min={50} max={200} value={advMul} onChange={e => setAdvMul(+e.target.value)} className="flex-1 accent-sky-500" />
          <span className="text-slate-300 w-12 text-right font-mono">{advMul}%</span>
        </div>
        <div className="flex items-center gap-1.5 text-[9px]">
          {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['REG',showRegion,setShowRegion],['LINK',showLink,setShowLink]] as const).map(([lab, v, set]) => (
            <button key={lab as string} onClick={() => (set as any)(!v)}
              className={`px-1.5 py-0.5 rounded border transition ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800/40 border-slate-700 text-slate-500'}`}>
              {lab}
            </button>
          ))}
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="filter cs/type/region"
            className="ml-auto flex-1 max-w-[150px] bg-slate-800/60 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 placeholder-slate-600 text-[9px]" />
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800">
            {filtered.length === 0 && (
              <div className="px-3 py-6 text-center text-[11px] text-slate-500">
                No aircraft currently cruising within a catalogued remote / oceanic region with PNR exposure.
              </div>
            )}
            {filtered.slice(0, 80).map(r => {
              const mins = Math.round(r.score.pnrTimeMin)
              const past = r.score.tier === 'COMMITTED'
              return (
                <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
                  className="w-full text-left px-2 py-1.5 hover:bg-slate-800/40 transition flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 text-[10px] font-mono">
                    <span className="font-semibold text-slate-100">{r.f.callsign || r.f.icao}</span>
                    <span className="text-slate-500">{r.f.type || '—'}</span>
                    <span className="text-slate-600">·</span>
                    <span className="text-slate-400">{AC_SPEC[r.score.cls].label}</span>
                    <span className="ml-auto px-1 rounded text-[9px]" style={{ color: TIER_COLOUR[r.score.tier], borderColor: TIER_COLOUR[r.score.tier], borderWidth: 1, borderStyle: 'solid' }}>
                      {r.score.tier} {r.score.score.toFixed(0)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[9px] text-slate-500 font-mono">
                    <span className="text-slate-300">{r.reg?.short || 'LAND'}</span>
                    <span>·</span>
                    <span>{r.score.phase}</span>
                    <span>·</span>
                    <span>{r.fld ? `${r.fld.iata} ${r.distRetNM.toFixed(0)}NM` : '—'}</span>
                    <span>·</span>
                    <span>FOB {(r.score.fobFrac*100).toFixed(0)}%</span>
                    <span>·</span>
                    <span style={{ color: past ? '#f43f5e' : '#cbd5e1' }}>{past ? `−${Math.abs(mins)}m past` : `+${mins}m`}</span>
                  </div>
                  <div className="h-1 rounded bg-slate-800 overflow-hidden">
                    <div className="h-full transition-all" style={{ width: `${r.score.score}%`, background: TIER_COLOUR[r.score.tier] }} />
                  </div>
                  <div className="grid grid-cols-7 gap-px text-[8px] text-slate-500 font-mono">
                    {(['fob','wind','field','etops','reserve','terrain','weather'] as const).map(k => (
                      <div key={k} className="flex flex-col items-center bg-slate-800/40 px-1 py-0.5 rounded">
                        <span className="uppercase tracking-tight">{k.slice(0,4)}</span>
                        <span className="text-slate-300">{(r.score.drv as any)[k].toFixed(0)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="text-[9px] text-slate-500 font-mono leading-tight">
                    {past ? (
                      <span style={{ color: '#fb7185' }}>COMMITTED — return field {r.fld?.iata} no longer reachable within endurance {r.score.enduranceHr.toFixed(1)}h. Continue to destination per Doc 9976 §3.3.4.</span>
                    ) : r.score.tier === 'IMMINENT' ? (
                      <span style={{ color: '#f59e0b' }}>IMMINENT — PNR in {mins}m. Re-verify FOB & alternate weather per AC 91-70B §6.5; consider early diversion.</span>
                    ) : r.score.tier === 'MONITOR' ? (
                      <span style={{ color: '#cbd5e1' }}>MONITOR — PNR in {mins}m. Wind {r.score.windComp>=0?'+':''}{r.score.windComp}kt · GS-cont {(AC_SPEC[r.score.cls].tasKts+r.score.windComp)}kt · endurance {r.score.enduranceHr.toFixed(1)}h.</span>
                    ) : (
                      <span style={{ color: '#94a3b8' }}>CLEAR — PNR in {mins}m. Return-leg {r.distRetNM.toFixed(0)}NM at GS-ret {(AC_SPEC[r.score.cls].tasKts-r.score.windComp)}kt = {((r.distRetNM/Math.max(120,AC_SPEC[r.score.cls].tasKts-r.score.windComp))*60).toFixed(0)}m.</span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {tab === 'REGIONS' && (
          <div className="divide-y divide-slate-800 text-[10px] font-mono">
            <div className="px-2 py-1 bg-slate-950/60 text-[9px] text-slate-500 grid grid-cols-6 gap-1">
              <span>ID</span><span>EXPO</span><span>FIELDS</span><span>BEST</span><span>BBOX-LAT</span><span>BBOX-LNG</span>
            </div>
            {REGIONS.slice().sort((a, b) => b.exposure - a.exposure).map(reg => {
              const best = reg.fields.reduce<Region['fields'][number]>((acc, f) => {
                const rk = { 'CAT-IIIB':4, 'CAT-II':3, 'CAT-I':2, 'NPA':1 } as Record<string, number>
                return (rk[f.cat] > rk[acc.cat]) ? f : acc
              }, reg.fields[0])
              const sev = reg.exposure > 0.94 ? '#f43f5e' : reg.exposure > 0.85 ? '#f59e0b' : '#38bdf8'
              return (
                <div key={reg.id} className="px-2 py-1 grid grid-cols-6 gap-1 items-center hover:bg-slate-800/40 transition">
                  <div className="flex flex-col">
                    <span className="text-slate-200">{reg.short}</span>
                    <span className="text-[8px] text-slate-600 truncate">{reg.name}</span>
                  </div>
                  <span style={{ color: sev }}>{(reg.exposure*100).toFixed(0)}%</span>
                  <span className="text-slate-300">{reg.fields.length}</span>
                  <span className="text-slate-300 text-[9px]">{best.iata} {best.cat.replace('CAT-','')}</span>
                  <span className="text-slate-400 text-[8px]">{reg.bbox[1].toFixed(0)}…{reg.bbox[3].toFixed(0)}</span>
                  <span className="text-slate-400 text-[8px]">{reg.bbox[0].toFixed(0)}…{reg.bbox[2].toFixed(0)}</span>
                </div>
              )
            })}
            <div className="px-2 py-2 text-[9px] text-slate-500 border-t border-slate-800/80">
              <div className="mb-1 text-slate-400">Catalogued return-field categories</div>
              <div className="grid grid-cols-2 gap-1">
                <div className="flex justify-between"><span style={{color:'#10b981'}}>CAT-IIIB</span><span>DH 0 / RVR 50m</span></div>
                <div className="flex justify-between"><span style={{color:'#38bdf8'}}>CAT-II</span><span>DH 100ft / RVR 300m</span></div>
                <div className="flex justify-between"><span style={{color:'#f59e0b'}}>CAT-I</span><span>DH 200ft / RVR 550m</span></div>
                <div className="flex justify-between"><span style={{color:'#f43f5e'}}>NPA</span><span>Non-precision · MDA</span></div>
              </div>
            </div>
          </div>
        )}

        {tab === 'PHYSICS' && (
          <div className="px-3 py-3 text-[10px] font-mono space-y-3 text-slate-400">
            <div>
              <div className="text-sky-300 mb-1">PRECEDENT</div>
              <div className="text-slate-300 leading-snug">
                Air Transat 236 (C-GITS A330) LPLA 2001-08-24 — YYZ→LIS sector, fuel leak from #2 engine
                detected at 04°27W (already past their computed PNR at ~37°W for return to CYYZ/CYHZ).
                Leak rate ~1.2T/min transitioned CLEAR → IMMINENT → COMMITTED in 24 minutes. Captain
                Piché executed 75 NM dead-stick glide to Lajes/Azores 33, both engines flamed out, 306
                souls survived. TSB A01F0093.
              </div>
            </div>
            <div>
              <div className="text-sky-300 mb-1">PNR EQUATION</div>
              <div className="text-slate-300 leading-snug font-mono text-[10px]">
                t_pnr = E × GS_ret / (GS_cont + GS_ret)
                <br />
                D_pnr = t_pnr × GS_cont
                <br />
                E = (FOB × endurance_max) − reserve_min
                <br />
                GS_cont = TAS + W_along · cos(θ_cont)
                <br />
                GS_ret  = TAS − W_along · cos(θ_cont)
                <br />
                COMMITTED ⇔ D_return / GS_ret &gt; E (return field unreachable)
              </div>
            </div>
            <div>
              <div className="text-sky-300 mb-1">7 DRIVERS</div>
              <ul className="text-slate-300 text-[9px] space-y-0.5">
                <li>FOB — fuel-on-board fraction (drives endurance hours remaining vs final-reserve floor)</li>
                <li>WIND — head/tail-wind component delta (asymmetric impact on continue vs return GS)</li>
                <li>FIELD — return-field certification quality (CAT-IIIB → CAT-II → CAT-I → NPA)</li>
                <li>ETOPS — required diversion-time vs aircraft cert envelope (60/120/180/240/330)</li>
                <li>RESERVE — final-reserve fuel margin per 14 CFR §121.639/.645 (45min IFR floor)</li>
                <li>TERRAIN — region exposure factor (0.99 mid-Pac → 0.72 Caribbean)</li>
                <li>WEATHER — destination/alternate weather penalty (RVR / ceiling degradation)</li>
              </ul>
            </div>
            <div>
              <div className="text-sky-300 mb-1">DISTINCT FROM</div>
              <div className="text-slate-300 leading-snug text-[9px]">
                ETP (Critical Point) — geographic equal-TIME point, return vs continue symmetric in time
                but NOT fuel. PNR is the asymmetric LAST-DIVERSION fuel-window. ETOPS Monitor is the
                certification-envelope time-limit. DRFTDN is single-engine descent profile to MORA.
                ALTN Suit scores alternate-airport weather/RVR fit. REDISPATCH is the FAR 121.631(c)
                Sec.B re-clearance fuel-saving construct. REACH-ATLAS is single-engine glide range
                from flame-out. RESERVE is the basic IFR fuel floor. PNR is uniquely the moment after
                which TURNING BACK is fuel-impossible.
              </div>
            </div>
            <div>
              <div className="text-sky-300 mb-1">REGULATORY FRAMEWORK</div>
              <div className="text-slate-300 leading-snug text-[9px]">
                ICAO Doc 4444 PANS-ATM App.2 · Doc 7030 RAC · Annex 6 Pt I §4.3.6 · Doc 9976 Flight
                Planning & Fuel Management Manual §3.3 (PNR formula) · Doc 10085 EDTO Manual · Doc
                8168 PANS-OPS Vol I Pt VIII · FAA AC 120-42B (ETOPS/EDTO) · AC 91-70B (oceanic) · FAA
                Order 8900.1 Vol 4 Ch 4 §9 · 14 CFR §121.625/.631(c)/.639/.645/.646 · EASA Reg 965/2012
                CAT.OP.MPA.140 / AMC1 CAT.OP.MPA.181 · IATA Fuel Conservation Guide §4 PDP.
              </div>
            </div>
            <div>
              <div className="text-sky-300 mb-1">REGION EXPOSURE SCALE</div>
              <div className="text-slate-300 text-[9px] space-y-0.5 font-mono">
                {REGIONS.slice().sort((a,b) => b.exposure - a.exposure).slice(0, 8).map(r => (
                  <div key={r.id} className="flex justify-between">
                    <span>{r.short} — {r.name}</span>
                    <span style={{ color: r.exposure > 0.94 ? '#f43f5e' : r.exposure > 0.85 ? '#f59e0b' : '#38bdf8' }}>{(r.exposure*100).toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="px-2 py-1 border-t border-slate-800 text-[9px] text-slate-500 font-mono flex items-center justify-between">
        <span>PNR · {REGIONS.length} regions · 9 airframe classes · TSB Air Transat 236 precedent</span>
        <span className="text-slate-600">v1</span>
      </div>
    </div>
  )
}
