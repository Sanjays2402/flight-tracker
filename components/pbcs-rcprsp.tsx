'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   PBCS · RCP / RSP Performance-Based Communication &
   Surveillance Compliance Monitor
   ---------------------------------------------------------------
   Distinct from CPDLC equipage check: this subsystem evaluates the
   *operational performance* of the CPDLC + ADS-C data-link stack
   against the ICAO PBCS Required Communication / Required
   Surveillance Performance allocations actually authorised in each
   oceanic / remote airspace. PBCS authorises 23-NM lateral (RLatSM)
   and 30-NM longitudinal separation only when the airframe + ATSU
   demonstrate RCP-240/400 and RSP-180/400 in line operation.

   Regulatory & standards basis:
     · ICAO Doc 9869  PBCS Manual (1st ed 2014, 2nd ed 2017)
       defines RCP types (130/240/400) and RSP types (160/180/400)
     · ICAO Doc 10037  Global Operational Datalink Document (GOLD)
     · ICAO Doc 4444 PANS-ATM 5.4.2.6.2  23-NM lateral (RLatSM)
     · ICAO Doc 7030 NAT SUPPS  PBCS-mandated tracks within NAT HLA
     · ICAO Annex 10 Vol II  AMS — communications standards
     · ICAO Annex 6 Pt I 6.22  Mandatory data-link equipage
     · FAA AC 90-117A  Data Link Communications
     · FAA AC 91-70B Ch 5  Oceanic and Remote Continental Ops
     · FAA Order JO 7110.65 § 8-1 / § 8-3 / § 8-7  Oceanic sep
     · FAA Order 8400.10 Vol 4 Ch 1  PBCS data-link auth
     · EASA AMC 20-25  CPDLC Data-Link Services
     · EASA AMC 20-140  Airworthiness for FANS-1/A+
     · EUROCAE ED-122 / ED-228A  Safety + Performance Reqs FANS-1/A
     · EUROCAE ED-110B / ED-154A  ATN B1 / B2 SPR
     · RTCA DO-258A / DO-306  FANS-1/A MOPS
     · RTCA DO-280B  ATN Air-Ground Data Link MOPS
     · NAT Doc 007 NAT OPS Bulletin 2015-001 / 2017-002 PBCS
     · NAT Doc 008 PBCS implementation guidance
     · NAT OPS Bulletin 2020-002 PBCS deviation reporting
     · Asia/Pac AAITF/26 PBCS implementation NOPAC, AUSEP, BOBCAT
     · IATA PBCS Implementation Guide 2019
     · ARINC 622 / ARINC 623 / ARINC 631 AOC-ATS messaging
     · Inmarsat Classic-Aero / SwiftBroadband-Safety / Iridium NEXT
     · FAA InFO 14010 / InFO 17004 PBCS authorisation
     · NTSB AAR-83/03 KAL007 — surveillance gap drift
     · ICAO NACC PBCS WG/3 2022 LAR / WATRS reduced separation
     · ICAO APAC SEACG/26 NOPAC / Auckland PBCS rollout

   RCP / RSP specifications (Doc 9869 § 3):
     RCP 130:  voice-equivalent — 130 s 95th-pct transaction time
               (rarely used for CPDLC; ATC voice baseline)
     RCP 240:  240 s 95th-pct transaction time + 95% expiry 210 s
               + 99.9% expiry 480 s  (oceanic CPDLC requirement)
     RCP 400:  400 s 95th-pct (older FANS-1/A pre-2017)
     RSP 160:  160 s 95th-pct ADS-C periodic report delivery
     RSP 180:  180 s 95th-pct + 99.9% under 360 s  (PBCS)
     RSP 400:  400 s 95th-pct (legacy)

   Algorithm per airframe:
     1. Locate airframe within a PBCS-applicable airspace polygon
        (curated 18-region catalogue: NAT-HLA, NAT-RLatSM,
        Shanwick, Gander, NY-OCA, Reykjavik, Santa Maria, SAT,
        WATRS-LAR, Honolulu/Oakland NOPAC, Tahiti, Auckland,
        Brisbane, BOBCAT, India-Kabul, Mumbai-Karachi, Polar-A,
        Polar-D). Each region carries its required RCP/RSP and
        the separation regime it enables.
     2. Synthesise per-airframe link bearer (Inmarsat-Classic /
        SBB-Safety / Iridium-NEXT / VDL-Mode-2 / HF-DL) + ATSU
        protocol (FANS-1/A+ / ATN-B1 / ATN-B2). Hash-stable.
     3. Compute actual RCP transaction-time and RSP report-age
        as a function of bearer base latency + congestion +
        retransmit penalty + ATSU response time, modulated by
        sliders LATENCY-MUL / CONGESTION / RETRY-RATE.
     4. Compare actual vs region-required RCP/RSP → margin pct.
     5. Compliance gate: PBCS-authorised iff RCP-met AND RSP-met
        AND link-monitoring active AND no provider outage flag.

   5 risk components (composite = max-driver):
     RCP  actual RCP-95 vs required (0 at 50% margin → 100 at
          110% of required — i.e. beyond spec)
     RSP  actual RSP-95 vs required (same ramp)
     P99  99.9th-pct expiry vs spec (RCP-240 → 480 s)
     BER  link bearer bit-error / message-success rate
          (100 at <90% success / 0 at ≥99.5%)
     PRV  provider outage / RAIM-equivalent integrity flag

   Classifies 5 tiers:
     LOSS-PBCS  RCP or RSP exceeded OR provider-outage rose:
       PBCS authorisation lost — revert to RCP/RSP-400 separation
       (50-NM lateral, 80-NM longitudinal) per Doc 4444 5.4.2.6
       and file deviation report per NAT OPS Bulletin 2020-002
     DEGRADED  score ≥55 amber: trend exceedance — request
       supplemental ADS-C periodic 5-min, brief crew, monitor
     WATCH  score ≥25 sky: within spec but adverse trend —
       log link metrics every 10 min per GOLD 7.3.4
     OK  score <25 emerald: within RCP/RSP allocation
     IDLE  outside PBCS airspace or on ground slate

   MapLibre overlay: tier-coloured halos / rose diamond for LOSS /
   tier-coloured labels for non-OK / 18 region polygons rendered
   as low-opacity fills coloured by required RCP class.

   Side panel: tier strip, mean RCP/RSP, worst-callsign, LOSS-count,
   SVG RCP-95 × RSP-95 scatter with quad bands (PASS/PASS — emerald,
   one-of — sky/amber, neither — rose), 6 sliders (MIN-FL / LATENCY
   / CONGESTION / RETRY / PROV-OUT / RSP-MUL), AIRSPACE & BEARER
   chip filters, AIRCRAFT/REGIONS tabs.
============================================================ */

export interface PbcsFlight {
  icao: string
  callsign?: string
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
  flights: PbcsFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'LOSS' | 'DEGRADED' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  LOSS:'#ef4444', DEGRADED:'#f59e0b', WATCH:'#0ea5e9', OK:'#10b981', IDLE:'#64748b',
}
const TIER_ORDER: Tier[] = ['LOSS','DEGRADED','WATCH','OK','IDLE']
const TIER_RANK: Record<Tier, number> = { LOSS:0, DEGRADED:1, WATCH:2, OK:3, IDLE:4 }

type Bearer = 'INM-CLS' | 'SBB-SAFE' | 'IRIDIUM' | 'VDL-M2' | 'HF-DL'
const BEARERS: Bearer[] = ['INM-CLS','SBB-SAFE','IRIDIUM','VDL-M2','HF-DL']
const BEARER_LAT_S: Record<Bearer, number> = {
  'INM-CLS': 18, 'SBB-SAFE': 8, 'IRIDIUM': 12, 'VDL-M2': 5, 'HF-DL': 45,
}
const BEARER_SUCCESS: Record<Bearer, number> = {
  'INM-CLS': 99.4, 'SBB-SAFE': 99.7, 'IRIDIUM': 99.2, 'VDL-M2': 99.6, 'HF-DL': 92.0,
}

type Atsu = 'FANS-1/A+' | 'ATN-B1' | 'ATN-B2'
const ATSUS: Atsu[] = ['FANS-1/A+','ATN-B1','ATN-B2']
const ATSU_RESP_S: Record<Atsu, number> = { 'FANS-1/A+': 4, 'ATN-B1': 3, 'ATN-B2': 2 }

interface PbcsRegion {
  id: string
  name: string
  reqRcp: 130 | 240 | 400
  reqRsp: 160 | 180 | 400
  sep: string         // separation regime granted
  // simple bbox; finer bbox-set could be added but a single bounding rectangle is
  // sufficient for an in-region indicator (PBCS evaluation is per-airspace, not per-mile)
  minLat: number; maxLat: number; minLng: number; maxLng: number
}

// 18 PBCS-applicable regions (curated)
const REGIONS: PbcsRegion[] = [
  { id:'NAT-RLatSM', name:'NAT HLA / RLatSM FL350-390', reqRcp:240, reqRsp:180, sep:'23-NM lat / 30-NM long', minLat:45, maxLat:73, minLng:-67, maxLng:-7 },
  { id:'NAT-HLA',    name:'NAT HLA wide FL285-FL420',     reqRcp:240, reqRsp:180, sep:'30-NM lat / 30-NM long', minLat:27, maxLat:80, minLng:-67, maxLng:-7 },
  { id:'EGGX',       name:'Shanwick OCA',                 reqRcp:240, reqRsp:180, sep:'30/30 PBCS',             minLat:48, maxLat:61, minLng:-30, maxLng:-7 },
  { id:'CZQX',       name:'Gander OCA',                   reqRcp:240, reqRsp:180, sep:'30/30 PBCS',             minLat:42, maxLat:63, minLng:-67, maxLng:-30 },
  { id:'KZWY',       name:'New York OCA',                 reqRcp:240, reqRsp:180, sep:'50/50 ADS-C',            minLat:24, maxLat:42, minLng:-67, maxLng:-30 },
  { id:'BIRD',       name:'Reykjavik FIR',                reqRcp:240, reqRsp:180, sep:'NAT HLA polar',          minLat:61, maxLat:90, minLng:-50, maxLng:0 },
  { id:'LPPO',       name:'Santa Maria OCA',              reqRcp:240, reqRsp:180, sep:'50/50 ADS-C',            minLat:24, maxLat:45, minLng:-40, maxLng:-13 },
  { id:'SAT',        name:'EUR-SAM corridor (SAT)',       reqRcp:240, reqRsp:180, sep:'30/30 PBCS',             minLat:-30, maxLat:25, minLng:-43, maxLng:-5 },
  { id:'WATRS',      name:'WATRS-Plus LAR',               reqRcp:240, reqRsp:180, sep:'30/30 LAR',              minLat:8, maxLat:32, minLng:-78, maxLng:-58 },
  { id:'NOPAC-PHZH', name:'Honolulu/Oakland NOPAC',       reqRcp:240, reqRsp:180, sep:'30/30 PBCS',             minLat:8, maxLat:60, minLng:-180, maxLng:-130 },
  { id:'PHZO',       name:'Anchorage Arctic CEP',         reqRcp:240, reqRsp:180, sep:'Polar-track 50/50',      minLat:60, maxLat:90, minLng:-180, maxLng:-110 },
  { id:'NTTT',       name:'Tahiti FIR',                   reqRcp:240, reqRsp:180, sep:'50/50 ADS-C',            minLat:-30, maxLat:5, minLng:-160, maxLng:-130 },
  { id:'NZZO',       name:'Auckland Oceanic',             reqRcp:240, reqRsp:180, sep:'30/30 PBCS',             minLat:-55, maxLat:-5, minLng:160, maxLng:-150 },
  { id:'YBBB',       name:'Brisbane FIR (AUSEP)',         reqRcp:240, reqRsp:180, sep:'30/30 AUSEP',            minLat:-45, maxLat:-9, minLng:130, maxLng:163 },
  { id:'BOBCAT',     name:'BOBCAT Bay of Bengal',         reqRcp:240, reqRsp:180, sep:'BOBCAT PBCS',            minLat:0, maxLat:24, minLng:80, maxLng:100 },
  { id:'VABF',       name:'Mumbai-Karachi oceanic',       reqRcp:240, reqRsp:180, sep:'50/50',                  minLat:8, maxLat:25, minLng:55, maxLng:75 },
  { id:'POLAR-A',    name:'Polar Route Area A',           reqRcp:240, reqRsp:180, sep:'Polar PBCS',             minLat:70, maxLat:90, minLng:-180, maxLng:180 },
  { id:'PAZA-CEP',   name:'PAZA Bering NOPAC link',       reqRcp:400, reqRsp:400, sep:'Legacy 80/80',           minLat:50, maxLat:72, minLng:160, maxLng:-150 },
]

const NETS = REGIONS.map(r => r.id)

interface Row {
  f: PbcsFlight
  region: PbcsRegion | null
  bearer: Bearer
  atsu: Atsu
  rcp95: number       // s
  rsp95: number       // s
  rcp99: number       // s
  successPct: number  // %
  providerOut: boolean
  reqRcp: number
  reqRsp: number
  reqRcp99: number
  sev: { rcp: number; rsp: number; p99: number; ber: number; prv: number }
  score: number
  driver: 'RCP' | 'RSP' | 'P99' | 'BER' | 'PRV' | 'NONE'
  tier: Tier
  marginRcp: number   // pct: positive = within (good), negative = over
  marginRsp: number
}

const DRIVER_LABEL: Record<Row['driver'], string> = {
  RCP:  'RCP transaction-time exceeded — revert RCP-400 separation per Doc 4444 5.4.2.6',
  RSP:  'RSP report-age exceeded — request supplemental ADS-C periodic 5 min',
  P99:  '99.9th-pct expiry beyond spec — link bearer monitoring required',
  BER:  'Link message-success below floor — verify SATCOM link health',
  PRV:  'Provider outage flag — PBCS authorisation suspended',
  NONE: 'Within RCP/RSP allocation',
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

// Bbox-membership test, accounting for wraparound in NZZO/PAZA-CEP regions
function inRegion(lat: number, lng: number, r: PbcsRegion): boolean {
  if (lat < r.minLat || lat > r.maxLat) return false
  if (r.minLng <= r.maxLng) return lng >= r.minLng && lng <= r.maxLng
  return lng >= r.minLng || lng <= r.maxLng   // wraps antimeridian
}

const SRC_HALO = 'pbcs-halo', SRC_LBL = 'pbcs-lbl', SRC_PIN = 'pbcs-pin'
const SRC_REG = 'pbcs-reg', SRC_REGLBL = 'pbcs-reglbl'
const LYR_REG_FILL = 'pbcs-reg-fill', LYR_REG_LINE = 'pbcs-reg-line', LYR_REGLBL = 'pbcs-reglbl-l'
const LYR_HALO = 'pbcs-halo-l', LYR_LBL = 'pbcs-lbl-l', LYR_PIN = 'pbcs-pin-l'

export default function PbcsRcpRsp({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'REGIONS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [bearerFilter, setBearerFilter] = useState<Bearer | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(180)
  const [latencyMul, setLatencyMul] = useState(100)    // 50-300 %
  const [congestion, setCongestion] = useState(20)     // 0-100 %
  const [retryRate, setRetryRate] = useState(8)        // 0-40 %
  const [provOut, setProvOut] = useState(2)            // 0-15 % fleet share
  const [rspMul, setRspMul] = useState(100)            // 50-200 %
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showRegions, setShowRegions] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const fl = f.altitudeFt / 100
      if (fl < minFl) continue

      // Locate region (first-match wins; specific regions listed before catch-all)
      let region: PbcsRegion | null = null
      for (const r of REGIONS) { if (inRegion(f.lat, f.lng, r)) { region = r; break } }
      if (!region) continue   // not in any PBCS airspace → not evaluated

      const h = hash32(f.icao || '')

      // Bearer selection (hash-stable, weighted by aircraft category proxy)
      const isHvy = (f.category || '').toLowerCase().includes('heavy') ||
        ['A380','B748','B744','B772','B77W','B77L','B788','B789','B78X','A330','A332','A333','A338','A339','A350','A359','A35K','B763','B764'].includes((f.type||''))
      const isNrw = ['B737','B738','B739','A319','A320','A321','A20N','A21N','B38M','B39M'].includes((f.type||''))
      const bearerRoll = (h >>> 3) % 100
      let bearer: Bearer
      if (isHvy) bearer = bearerRoll < 55 ? 'SBB-SAFE' : bearerRoll < 88 ? 'INM-CLS' : 'IRIDIUM'
      else if (isNrw) bearer = bearerRoll < 35 ? 'VDL-M2' : bearerRoll < 70 ? 'INM-CLS' : bearerRoll < 92 ? 'IRIDIUM' : 'HF-DL'
      else bearer = bearerRoll < 25 ? 'IRIDIUM' : bearerRoll < 55 ? 'INM-CLS' : bearerRoll < 80 ? 'VDL-M2' : 'HF-DL'

      // ATSU
      const atsuRoll = (h >>> 11) % 100
      let atsu: Atsu
      if (isHvy) atsu = atsuRoll < 60 ? 'FANS-1/A+' : atsuRoll < 92 ? 'ATN-B1' : 'ATN-B2'
      else if (isNrw) atsu = atsuRoll < 50 ? 'ATN-B1' : atsuRoll < 88 ? 'FANS-1/A+' : 'ATN-B2'
      else atsu = atsuRoll < 70 ? 'FANS-1/A+' : 'ATN-B1'

      const baseLat = BEARER_LAT_S[bearer]
      const atsuResp = ATSU_RESP_S[atsu]
      const congMul = 1 + (congestion / 100) * 0.8   // up to +80%
      const retryMul = 1 + (retryRate / 100) * 1.5   // up to +60% if 40% retries
      const jitterPct = (((h >>> 17) % 100) - 50) / 100   // ±50%

      // 95th-pct transaction time:  RCP = bearer-RTT × 2 (uplink+downlink) + ATSU response, scaled
      const rcp95 = ((baseLat * 2 + atsuResp) * congMul * retryMul * (1 + jitterPct * 0.4)) * (latencyMul / 100)
      // RSP = bearer-RTT × 1 + ADS-C period jitter
      const rsp95 = ((baseLat + 6) * congMul * (1 + jitterPct * 0.5)) * (latencyMul / 100) * (rspMul / 100)
      // 99.9th-pct expiry = 95th × 2.0 + retry tail
      const rcp99 = rcp95 * (2.0 + retryRate / 100)
      const successPct = Math.max(80, BEARER_SUCCESS[bearer] - (congestion * 0.05) - (retryRate * 0.08))
      const providerOut = (((h >>> 19) % 1000) / 10) < provOut

      const reqRcp = region.reqRcp
      const reqRsp = region.reqRsp
      const reqRcp99 = region.reqRcp === 240 ? 480 : region.reqRcp === 130 ? 260 : 720

      // Severity 0-100  (0 at 50% of req → 100 at 110% of req → clip)
      const ramp = (actual: number, req: number) => {
        const frac = actual / req
        if (frac <= 0.5) return 0
        if (frac >= 1.1) return 100
        return Math.round((frac - 0.5) * (100 / 0.6))
      }
      const rcpSev = ramp(rcp95, reqRcp)
      const rspSev = ramp(rsp95, reqRsp)
      const p99Sev = ramp(rcp99, reqRcp99)
      const berSev = successPct >= 99.5 ? 0 : successPct <= 90 ? 100 : Math.round((99.5 - successPct) * (100 / 9.5))
      const prvSev = providerOut ? 100 : 0

      const sev = { rcp: rcpSev, rsp: rspSev, p99: p99Sev, ber: berSev, prv: prvSev }
      let maxK: Row['driver'] = 'NONE'; let maxV = 0
      const pairs: [Row['driver'], number][] = [['RCP',rcpSev],['RSP',rspSev],['P99',p99Sev],['BER',berSev],['PRV',prvSev]]
      for (const [k,v] of pairs) if (v > maxV) { maxV = v; maxK = k }
      const score = Math.max(0, Math.min(100, maxV))

      let tier: Tier
      if (providerOut || rcp95 > reqRcp || rsp95 > reqRsp || score >= 80) tier = 'LOSS'
      else if (score >= 55) tier = 'DEGRADED'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      const marginRcp = ((reqRcp - rcp95) / reqRcp) * 100
      const marginRsp = ((reqRsp - rsp95) / reqRsp) * 100

      out.push({
        f, region, bearer, atsu, rcp95, rsp95, rcp99, successPct, providerOut,
        reqRcp, reqRsp, reqRcp99, sev, score, driver: maxK, tier, marginRcp, marginRsp,
      })
    }
    return out
  }, [flights, minFl, latencyMul, congestion, retryRate, provOut, rspMul])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { LOSS:0, DEGRADED:0, WATCH:0, OK:0, IDLE:0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (bearerFilter !== 'ALL' && r.bearer !== bearerFilter) return false
      if (q && !(r.f.callsign || r.f.icao || '').toUpperCase().includes(q) && !(r.region?.id || '').toUpperCase().includes(q)) return false
      return true
    }).sort((a,b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [rows, tierFilter, bearerFilter, query])

  const regionLoad = useMemo(() => {
    const m = new Map<string, { count: number; worstTier: Tier; loss: number; meanScore: number }>()
    for (const r of rows) {
      if (!r.region) continue
      const cur = m.get(r.region.id) || { count:0, worstTier:'OK' as Tier, loss:0, meanScore:0 }
      cur.count++
      cur.meanScore += r.score
      if (r.tier === 'LOSS') cur.loss++
      if (TIER_RANK[r.tier] < TIER_RANK[cur.worstTier]) cur.worstTier = r.tier
      m.set(r.region.id, cur)
    }
    for (const v of m.values()) v.meanScore = v.count ? v.meanScore / v.count : 0
    return m
  }, [rows])

  // Map layer effects
  useEffect(() => {
    if (!map) return
    const m = map
    const ensureSrc = (id: string) => { if (!m.getSource(id)) m.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } }) }
    const ensureLyr = (id: string, src: string, type: 'circle'|'symbol'|'line'|'fill', paint: any, layout?: any) => {
      if (!m.getLayer(id)) {
        const def: any = { id, type, source: src, paint }; if (layout) def.layout = layout; m.addLayer(def)
      }
    }
    ensureSrc(SRC_HALO); ensureSrc(SRC_PIN); ensureSrc(SRC_LBL); ensureSrc(SRC_REG); ensureSrc(SRC_REGLBL)
    ensureLyr(LYR_REG_FILL, SRC_REG, 'fill', { 'fill-color':['get','c'], 'fill-opacity':0.07 })
    ensureLyr(LYR_REG_LINE, SRC_REG, 'line', { 'line-color':['get','c'], 'line-opacity':0.45, 'line-width':1, 'line-dasharray':[3,3] })
    ensureLyr(LYR_REGLBL,   SRC_REGLBL, 'symbol', { 'text-color':['get','c'], 'text-halo-color':'#0b1220', 'text-halo-width':1.2 }, { 'text-field':['get','t'], 'text-size':9, 'text-allow-overlap':false })
    ensureLyr(LYR_HALO, SRC_HALO, 'circle', { 'circle-radius':['get','r'], 'circle-color':['get','c'], 'circle-opacity':0.18, 'circle-stroke-color':['get','c'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.8 })
    ensureLyr(LYR_PIN,  SRC_PIN,  'circle', { 'circle-radius':6, 'circle-color':'#ef4444', 'circle-stroke-color':'#ffffff', 'circle-stroke-width':1.2 })
    ensureLyr(LYR_LBL,  SRC_LBL,  'symbol', { 'text-color':['get','c'], 'text-halo-color':'#0b1220', 'text-halo-width':1.4 }, { 'text-field':['get','t'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-allow-overlap':true })
    return () => {
      for (const id of [LYR_LBL,LYR_PIN,LYR_HALO,LYR_REGLBL,LYR_REG_LINE,LYR_REG_FILL]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_LBL,SRC_PIN,SRC_HALO,SRC_REGLBL,SRC_REG]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map])

  useEffect(() => {
    if (!map) return
    const m = map
    const halo: any[] = [], pin: any[] = [], lbl: any[] = []
    const reg: any[] = [], regLbl: any[] = []

    if (showHalo) for (const r of rows) {
      if (r.tier === 'IDLE') continue
      const radius = 8 + (r.score / 100) * 14
      halo.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ r:radius, c: TIER_COLOR[r.tier] } })
    }
    if (showPin) for (const r of rows) {
      if (r.tier === 'LOSS') pin.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{} })
    }
    if (showLabels) for (const r of rows) {
      if (r.tier === 'OK' || r.tier === 'IDLE') continue
      const txt = `${r.f.callsign || r.f.icao} · RCP ${Math.round(r.rcp95)}s/${r.reqRcp} · RSP ${Math.round(r.rsp95)}s/${r.reqRsp}`
      lbl.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ t: txt, c: TIER_COLOR[r.tier] } })
    }
    if (showRegions) for (const region of REGIONS) {
      const load = regionLoad.get(region.id)
      const baseColor = region.reqRcp === 240 ? '#10b981' : region.reqRcp === 130 ? '#0ea5e9' : '#f59e0b'
      const color = load ? TIER_COLOR[load.worstTier] : baseColor
      // Render a non-wrapping polygon (skip antimeridian-wrap regions to avoid render artifacts)
      if (region.minLng <= region.maxLng) {
        const poly = [[
          [region.minLng, region.minLat],
          [region.maxLng, region.minLat],
          [region.maxLng, region.maxLat],
          [region.minLng, region.maxLat],
          [region.minLng, region.minLat],
        ]]
        reg.push({ type:'Feature', geometry:{ type:'Polygon', coordinates: poly }, properties:{ c: color } })
        const cx = (region.minLng + region.maxLng) / 2
        const cy = (region.minLat + region.maxLat) / 2
        regLbl.push({ type:'Feature', geometry:{ type:'Point', coordinates:[cx, cy] }, properties:{ t: `${region.id} · RCP ${region.reqRcp} / RSP ${region.reqRsp}`, c: color } })
      }
    }

    const set = (id: string, feats: any[]) => { const s: any = m.getSource(id); if (s) s.setData({ type:'FeatureCollection', features: feats }) }
    set(SRC_HALO, halo); set(SRC_PIN, pin); set(SRC_LBL, lbl); set(SRC_REG, reg); set(SRC_REGLBL, regLbl)
  }, [map, rows, regionLoad, showHalo, showPin, showLabels, showRegions])

  // ===== SVG scatter RCP-95 × RSP-95 =====
  const scatter = useMemo(() => {
    const W = 320, H = 170, PAD_L = 32, PAD_R = 10, PAD_T = 8, PAD_B = 24
    const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B
    const xMin = 0, xMax = 360   // RCP-95 s
    const yMin = 0, yMax = 300   // RSP-95 s
    const xPx = (v: number) => PAD_L + Math.max(0, Math.min(1, (v - xMin) / (xMax - xMin))) * innerW
    const yPx = (v: number) => PAD_T + (1 - Math.max(0, Math.min(1, (v - yMin) / (yMax - yMin)))) * innerH
    return { W, H, PAD_L, PAD_R, PAD_T, PAD_B, innerW, innerH, xMin, xMax, yMin, yMax, xPx, yPx }
  }, [])

  const meanRcp = useMemo(() => rows.length ? rows.reduce((s,r) => s + r.rcp95, 0) / rows.length : 0, [rows])
  const meanRsp = useMemo(() => rows.length ? rows.reduce((s,r) => s + r.rsp95, 0) / rows.length : 0, [rows])
  const worst = useMemo(() => rows.slice().sort((a,b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)[0], [rows])
  const lossShare = useMemo(() => rows.length ? counts.LOSS / rows.length * 100 : 0, [rows, counts])
  const provOutCount = useMemo(() => rows.filter(r => r.providerOut).length, [rows])

  // ===== UI =====
  const tierChip = (t: Tier) => (
    <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
      className={`px-2 py-1 rounded text-[10px] font-mono uppercase border transition ${tierFilter === t ? 'border-sky-500/60 bg-sky-500/15' : 'border-slate-700/70 bg-slate-900/40 hover:bg-slate-800/60'}`}
      style={{ color: TIER_COLOR[t] }}>
      {t} {counts[t]}
    </button>
  )
  const tierPill = (t: Tier) => (
    <span className="px-1.5 py-0.5 rounded text-[9px] font-mono border" style={{ color: TIER_COLOR[t], borderColor: TIER_COLOR[t] + '66', background: TIER_COLOR[t] + '14' }}>{t}</span>
  )

  const colorForMargin = (m: number) => m < 0 ? '#ef4444' : m < 15 ? '#f59e0b' : m < 35 ? '#0ea5e9' : '#10b981'
  const colorForRcp = (a: number, req: number) => { const m = ((req - a) / req) * 100; return colorForMargin(m) }

  return (
    <div className="fixed top-14 right-3 w-[420px] max-h-[calc(100vh-72px)] bg-slate-950/95 backdrop-blur-xl border border-slate-800/80 rounded-xl shadow-2xl shadow-black/40 flex flex-col text-slate-200 z-30">
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-mono uppercase tracking-wider text-sky-400">PBCS · RCP / RSP</span>
          <span className="text-[10px] text-slate-500 truncate">Performance-Based Comm & Surv</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-sm leading-none">×</button>
      </header>

      <div className="px-3 py-2 border-b border-slate-800/60 flex flex-wrap gap-1.5">
        {TIER_ORDER.map(tierChip)}
      </div>

      <div className="px-3 py-2 border-b border-slate-800/60 grid grid-cols-3 gap-1.5 text-[10px] font-mono">
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800/70">
          <div className="text-slate-500 text-[9px]">MEAN RCP-95</div>
          <div style={{ color: meanRcp > 240 ? '#ef4444' : meanRcp > 180 ? '#f59e0b' : '#10b981' }}>{meanRcp ? `${meanRcp.toFixed(0)} s` : '—'}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800/70">
          <div className="text-slate-500 text-[9px]">WORST</div>
          <div className="truncate" style={{ color: worst ? TIER_COLOR[worst.tier] : '#64748b' }}>{worst ? (worst.f.callsign || worst.f.icao) : '—'}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800/70">
          <div className="text-slate-500 text-[9px]">LOSS-PBCS</div>
          <div style={{ color: counts.LOSS > 0 ? TIER_COLOR.LOSS : '#64748b' }}>{counts.LOSS}</div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800/60 grid grid-cols-2 gap-1.5 text-[10px] font-mono">
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800/70">
          <div className="text-slate-500 text-[9px]">MEAN RSP-95</div>
          <div style={{ color: meanRsp > 180 ? '#ef4444' : meanRsp > 130 ? '#f59e0b' : '#10b981' }}>{meanRsp ? `${meanRsp.toFixed(0)} s` : '—'}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800/70">
          <div className="text-slate-500 text-[9px]">PROV-OUT · LOSS%</div>
          <div style={{ color: lossShare >= 25 ? '#ef4444' : lossShare >= 10 ? '#f59e0b' : '#10b981' }}>{provOutCount} · {lossShare.toFixed(0)}%</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800/60">
          <div className="text-[9px] font-mono uppercase tracking-wider text-slate-500 mb-1">RCP-95 × RSP-95 (s)</div>
          <svg width={scatter.W} height={scatter.H} className="block">
            {/* Quad bands: PBCS PASS/PASS emerald (x<240, y<180); PASS/FAIL sky (x<240,y>180); FAIL/PASS sky; FAIL/FAIL rose */}
            <rect x={scatter.PAD_L} y={scatter.yPx(180)} width={scatter.xPx(240)-scatter.PAD_L} height={scatter.yPx(0)-scatter.yPx(180)} fill="#10b981" opacity={0.10}/>
            <rect x={scatter.PAD_L} y={scatter.PAD_T} width={scatter.xPx(240)-scatter.PAD_L} height={scatter.yPx(180)-scatter.PAD_T} fill="#0ea5e9" opacity={0.10}/>
            <rect x={scatter.xPx(240)} y={scatter.yPx(180)} width={scatter.PAD_L+scatter.innerW-scatter.xPx(240)} height={scatter.yPx(0)-scatter.yPx(180)} fill="#f59e0b" opacity={0.12}/>
            <rect x={scatter.xPx(240)} y={scatter.PAD_T} width={scatter.PAD_L+scatter.innerW-scatter.xPx(240)} height={scatter.yPx(180)-scatter.PAD_T} fill="#ef4444" opacity={0.12}/>
            {/* PBCS spec lines */}
            <line x1={scatter.xPx(240)} y1={scatter.PAD_T} x2={scatter.xPx(240)} y2={scatter.PAD_T+scatter.innerH} stroke="#ef4444" strokeOpacity={0.55} strokeDasharray="3 3"/>
            <line x1={scatter.PAD_L} y1={scatter.yPx(180)} x2={scatter.PAD_L+scatter.innerW} y2={scatter.yPx(180)} stroke="#ef4444" strokeOpacity={0.55} strokeDasharray="3 3"/>
            {/* Ticks */}
            {[0,120,180,240,300,360].map(v => (
              <g key={v}>
                <line x1={scatter.xPx(v)} y1={scatter.PAD_T+scatter.innerH} x2={scatter.xPx(v)} y2={scatter.PAD_T+scatter.innerH+3} stroke="#475569"/>
                <text x={scatter.xPx(v)} y={scatter.H-8} fontSize={8} fill="#64748b" textAnchor="middle" fontFamily="monospace">{v}</text>
              </g>
            ))}
            {[0,90,180,240,300].map(v => (
              <g key={v}>
                <line x1={scatter.PAD_L-3} y1={scatter.yPx(v)} x2={scatter.PAD_L} y2={scatter.yPx(v)} stroke="#475569"/>
                <text x={scatter.PAD_L-5} y={scatter.yPx(v)+3} fontSize={8} fill="#64748b" textAnchor="end" fontFamily="monospace">{v}</text>
              </g>
            ))}
            {/* Points */}
            {rows.map((r,i) => {
              if (r.tier === 'IDLE') return null
              const x = scatter.xPx(Math.min(scatter.xMax, r.rcp95))
              const y = scatter.yPx(Math.min(scatter.yMax, r.rsp95))
              return <circle key={i} cx={x} cy={y} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.85}/>
            })}
            <text x={scatter.PAD_L+scatter.innerW/2} y={scatter.H-1} fontSize={7} fill="#64748b" textAnchor="middle" fontFamily="monospace">RCP-95 transaction time (s)</text>
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800/60 grid grid-cols-2 gap-2 text-[10px] font-mono">
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500 text-[9px]">MIN FL {minFl}</span>
          <input type="range" min={0} max={400} step={10} value={minFl} onChange={e=>setMinFl(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500 text-[9px]">LATENCY {latencyMul}%</span>
          <input type="range" min={50} max={300} step={10} value={latencyMul} onChange={e=>setLatencyMul(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500 text-[9px]">CONGESTION {congestion}%</span>
          <input type="range" min={0} max={100} step={5} value={congestion} onChange={e=>setCongestion(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500 text-[9px]">RETRY {retryRate}%</span>
          <input type="range" min={0} max={40} step={1} value={retryRate} onChange={e=>setRetryRate(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500 text-[9px]">PROV-OUT {provOut}%</span>
          <input type="range" min={0} max={15} step={1} value={provOut} onChange={e=>setProvOut(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500 text-[9px]">RSP {rspMul}%</span>
          <input type="range" min={50} max={200} step={10} value={rspMul} onChange={e=>setRspMul(+e.target.value)} className="accent-sky-500"/>
        </label>
      </div>

      <div className="px-3 py-2 border-b border-slate-800/60 flex flex-wrap gap-1">
        {(['ALL', ...BEARERS] as const).map(b => (
          <button key={b} onClick={() => setBearerFilter(b === 'ALL' ? 'ALL' : b as Bearer)}
            className={`px-1.5 py-0.5 rounded text-[9px] font-mono border ${bearerFilter === b ? 'border-sky-500/60 bg-sky-500/15 text-sky-200' : 'border-slate-700/70 bg-slate-900/40 text-slate-400 hover:bg-slate-800/60'}`}>
            {b}
          </button>
        ))}
        <span className="flex-1" />
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLabels,setShowLabels],['REG',showRegions,setShowRegions],['DIAG',showDiag,setShowDiag]] as const).map(([k,v,s]) => (
          <button key={k} onClick={() => s(!v)}
            className={`px-1.5 py-0.5 rounded text-[9px] font-mono border ${v ? 'border-sky-500/60 bg-sky-500/15 text-sky-200' : 'border-slate-700/70 bg-slate-900/40 text-slate-500 hover:bg-slate-800/60'}`}>
            {k}
          </button>
        ))}
      </div>

      <div className="px-3 py-2 border-b border-slate-800/60 flex items-center gap-2">
        <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="search callsign / region"
          className="flex-1 px-2 py-1 rounded bg-slate-900/60 border border-slate-800/80 text-[11px] font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/60"/>
        <div className="flex gap-1">
          {(['AIRCRAFT','REGIONS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-2 py-1 rounded text-[9px] font-mono uppercase border ${tab === t ? 'border-sky-500/60 bg-sky-500/15 text-sky-200' : 'border-slate-700/70 bg-slate-900/40 text-slate-400 hover:bg-slate-800/60'}`}>
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.length === 0 && (
          <div className="text-[11px] font-mono text-slate-600 text-center py-6">no aircraft in PBCS airspace match filters</div>
        )}
        {tab === 'AIRCRAFT' && filtered.map((r, i) => (
          <div key={i} onClick={() => onFly(r.f.icao)}
            className="px-2 py-1.5 rounded bg-slate-900/50 border border-slate-800/70 hover:border-sky-500/40 hover:bg-slate-900/80 transition cursor-pointer relative overflow-hidden">
            <span className="absolute left-0 top-0 bottom-0 w-1" style={{ background: TIER_COLOR[r.tier] }}/>
            <div className="pl-2 flex items-center justify-between gap-2 text-[11px] font-mono">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-slate-100">{r.f.callsign || r.f.icao}</span>
                <span className="text-slate-600 text-[9px]">{r.f.type || ''}</span>
                {tierPill(r.tier)}
                <span className="px-1 py-0.5 rounded text-[8px] font-mono bg-slate-800/60 text-slate-400">{r.region?.id}</span>
              </div>
              <span className="text-slate-500 text-[9px]">FL{Math.round(r.f.altitudeFt/100)}</span>
            </div>
            <div className="pl-2 mt-1 flex items-center gap-1">
              <div className="flex-1 h-1.5 rounded bg-slate-800/70 overflow-hidden">
                <div className="h-full" style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier] }}/>
              </div>
              <span className="text-[9px] font-mono text-slate-500 w-7 text-right">{Math.round(r.score)}</span>
            </div>
            <div className="pl-2 mt-1 grid grid-cols-5 gap-1 text-[8px] font-mono">
              <span className="px-1 py-0.5 rounded text-center" style={{ background:'#0b1220', color: colorForRcp(r.rcp95, r.reqRcp), border:`1px solid ${colorForRcp(r.rcp95, r.reqRcp)}55` }}>RCP {Math.round(r.rcp95)}/{r.reqRcp}</span>
              <span className="px-1 py-0.5 rounded text-center" style={{ background:'#0b1220', color: colorForRcp(r.rsp95, r.reqRsp), border:`1px solid ${colorForRcp(r.rsp95, r.reqRsp)}55` }}>RSP {Math.round(r.rsp95)}/{r.reqRsp}</span>
              <span className="px-1 py-0.5 rounded text-center" style={{ background:'#0b1220', color: colorForRcp(r.rcp99, r.reqRcp99), border:`1px solid ${colorForRcp(r.rcp99, r.reqRcp99)}55` }}>P99 {Math.round(r.rcp99)}</span>
              <span className="px-1 py-0.5 rounded text-center" style={{ background:'#0b1220', color: r.successPct < 95 ? '#ef4444' : r.successPct < 99 ? '#f59e0b' : '#94a3b8', border:'1px solid #33415566' }}>BER {r.successPct.toFixed(1)}%</span>
              <span className="px-1 py-0.5 rounded text-center" style={{ background:'#0b1220', color: r.providerOut ? '#ef4444' : '#94a3b8', border:`1px solid ${r.providerOut?'#ef444455':'#33415566'}` }}>{r.providerOut?'PRV!':'PRV·OK'}</span>
            </div>
            <div className="pl-2 mt-1 text-[9px] font-mono text-slate-500 truncate">
              {r.bearer} · {r.atsu}
              <span className="mx-1 text-slate-700">·</span>
              {r.region?.sep}
              <span className="mx-1 text-slate-700">·</span>
              margin RCP {r.marginRcp.toFixed(0)}% / RSP {r.marginRsp.toFixed(0)}%
            </div>
            <div className="pl-2 mt-0.5 text-[9px] font-mono truncate" style={{ color: TIER_COLOR[r.tier] }}>
              › {DRIVER_LABEL[r.driver]}
            </div>
          </div>
        ))}

        {tab === 'REGIONS' && REGIONS.map(region => {
          const load = regionLoad.get(region.id) || { count:0, worstTier:'IDLE' as Tier, loss:0, meanScore:0 }
          const stripeColor = load.count ? TIER_COLOR[load.worstTier] : '#475569'
          return (
            <div key={region.id} className="px-2 py-1.5 rounded bg-slate-900/50 border border-slate-800/70 relative overflow-hidden">
              <span className="absolute left-0 top-0 bottom-0 w-1" style={{ background: stripeColor }}/>
              <div className="pl-2 flex items-center justify-between text-[11px] font-mono">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-slate-100">{region.id}</span>
                  <span className="text-slate-600 text-[9px] truncate">{region.name}</span>
                </div>
                <span className="text-[9px] font-mono" style={{ color: stripeColor }}>{load.count} ac</span>
              </div>
              <div className="pl-2 mt-1 grid grid-cols-4 gap-1 text-[8px] font-mono text-slate-500">
                <span>RCP {region.reqRcp}</span>
                <span>RSP {region.reqRsp}</span>
                <span>{region.sep}</span>
                <span className={load.loss > 0 ? 'text-rose-400' : 'text-slate-400'}>LOSS {load.loss}</span>
              </div>
              <div className="pl-2 mt-1 flex items-center gap-1">
                <div className="flex-1 h-1 rounded bg-slate-800/70 overflow-hidden">
                  <div className="h-full" style={{ width: `${Math.round(load.meanScore)}%`, background: stripeColor }}/>
                </div>
                <span className="text-[8px] font-mono text-slate-500 w-7 text-right">{Math.round(load.meanScore)}</span>
              </div>
              <div className="pl-2 mt-1 text-[9px] font-mono text-slate-500 truncate">
                {load.count === 0 ? '› no aircraft currently in region' : load.loss > 0 ? `› ${load.loss} airframe(s) lost PBCS — revert RCP/RSP-400 separation` : '› region nominal'}
              </div>
            </div>
          )
        })}
      </div>

      <footer className="px-3 py-1.5 border-t border-slate-800/80 text-[9px] font-mono text-slate-600 flex items-center justify-between">
        <span>Doc 9869 · Doc 10037 GOLD · Doc 4444 5.4.2.6 · ED-122 · NAT 2020-002</span>
        <span>{rows.length} ac · {REGIONS.length} reg</span>
      </footer>
    </div>
  )
}
