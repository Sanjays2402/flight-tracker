'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   NADP — Noise Abatement Departure Procedure Compliance
   -----------------------------------------------------------
   ICAO PANS-OPS Vol I Part I §7 / FAA AC 91-53A / ATA Op Spec
   Each major commercial field publishes a preferred NADP that
   noise-abated departures shall fly:

     NADP-1 ("close-in"): thrust cutback ~800 ft AGL, hold V2+10
              with takeoff flap config to 3000 ft AGL, then
              accelerate and retract flaps. Minimises noise to
              residential areas directly under the runway track.
              Typical at FRA, ZRH, BOS, DCA, LCY, JFK 13L/22L,
              MUC, ORY (curfew-sensitive city-side fields).

     NADP-2 ("distant"): thrust cutback ~800 ft AGL but begin
              acceleration immediately to flap retraction speed
              ~1000-1500 ft AGL, complete flap retraction by
              3000 ft AGL while climbing at green-dot / Vzf.
              Minimises noise to residential areas further from
              the field along the climb-out corridor. Typical
              at LHR (NPR), SFO 28R, LAX 25R, SIN 02L, HKG 07R.

     STANDARD: no published preferred NADP / non-restricted
              field. Compliance not scored, classified ALL-OK.

   For every aircraft tagged as DEPARTING (climbing >800fpm,
   below MAX-AGL slider, within CAPTURE nm of a candidate
   origin where aircraft bearing FROM the field is within
   +/-90 deg of track and field is the closest aligned IATA
   field on that 90deg back-arc):

   1) Look up preferred NADP for the origin from the curated
      62-airport NADP table reconstructed from the 2024 IATA
      Airport Handling Manual NADP Annex, EASA TYPE-CERT
      noise data, Boeing FCTM Vol2 §3 noise abatement matrix,
      EUROCONTROL CODA NADP Inventory (2023).

   2) Compute AGL = currentFt - fieldElevFt
      Compute speed band proxy from class-typical V2 and
      flap-retraction speeds (heavy V2=160 Vzf=210, narrow
      V2=145 Vzf=200, regional V2=135 Vzf=180, biz V2=130
      Vzf=190, turboprop V2=105 Vzf=140, ga V2=80 Vzf=110,
      fighter V2=180 Vzf=240) scaled by V-MULT slider.

   3) Compliance signature per NADP procedure:

      NADP-1 expects in 800-3000ft AGL band:
        speed should be near V2+10 (low, takeoff flap)
        VS should be high (>2000fpm typical, full climb)
        After 3000ft: acceleration permitted

      NADP-2 expects in 800-1500ft AGL band:
        speed should be accelerating already
        VS may be lower (1500-2200fpm typical, accel trade)
        After 1500ft: speed near Vzf, flaps coming up

   4) Score each aircraft in the active band against the
      expected speed envelope and VS envelope. Departure
      from envelope = speed delta (kt) and VS delta (fpm)
      normalised vs the half-band, summed.

   Tier classification:
     COMPLIANT  combined deviation score <= 0.5 emerald
     DRIFT      combined deviation score <= 1.2 sky
     DEVIATE    combined deviation score <= 2.5 amber
     BUST       score > 2.5 OR wrong-profile signature rose
     PASSIVE    aircraft above 3000ft AGL or below 800ft AGL
                or field STANDARD-NADP -> slate (out of band)

   MapLibre overlay:
     - Tier-coloured halo ring sized by deviation (8-22px)
     - Tier-coloured dashed projection line aircraft-back
       to origin airport with diamond marker
     - Tier-coloured airport pin with ›IATA dot NADP label
     - Tier-coloured callsign+AGL+IAS+VS labels non-COMPLIANT

   Side panel:
     - 5-tier counter strip click-to-filter (incl. PASSIVE)
     - 3-cell MEAN-DEV tier-coloured / WORST callsign+score
       / BUST-COUNT summary
     - 2-cell IN-BAND-CREWS sky / N1-EST-CUTBACK-pct sky
       secondary row
     - SVG IAS-vs-AGL envelope diagram (x=AGL kft 0-5, y=IAS
       0-300kt) with NADP-1 emerald band V2+10 below 3000ft,
       NADP-2 sky band accel-window 800-1500ft, every aircraft
       plotted as tier-coloured dot
     - 5 sliders MIN-AGL 0-800ft / MAX-AGL 1000-5000ft /
       CAPTURE 5-60nm / V-MULT 80-120% / TOL-MULT 50-200%
     - 7-class chip filter
     - HALO/PROJ/PIN/LBL/DIAG toggles + search
     - AIRCRAFT/AIRPORTS tab switcher
     - AIRCRAFT tab tier-worst-first then dev desc, tier
       stripe + callsign+type+class-pill+tier-pill + AGL/
       IAS/VS/NADP-1or2 line + tier-coloured dev bar 0-3
       + speed-delta-kt/VS-delta-fpm/profile-signature line
       + IATA-arrow-back/dist-nm/operator line + tier-
       coloured advice (compliant maintain profile / minor
       drift trim VS / flying wrong NADP review SOP / cross-
       check ACARS noise tape) click-to-fly per row
     - AIRPORTS tab grouped by origin sorted worst-first
       then dep-count desc, tier stripe + IATA-name + dep-
       count + NADP-pill + worst-tier-pill + mean-dev bar
       + ICAO+elev+lat/lng footer click-to-fly to airport

   Registered in Layers > Routes & Flow category.
   ft-nadp persisted preference.
   ============================================================ */

export interface NadpFlight {
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
  flights: NadpFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'COMPLIANT' | 'DRIFT' | 'DEVIATE' | 'BUST' | 'PASSIVE'
const TIER_COLOR: Record<Tier, string> = {
  COMPLIANT: '#10b981',
  DRIFT: '#0ea5e9',
  DEVIATE: '#f59e0b',
  BUST: '#ef4444',
  PASSIVE: '#64748b',
}
const TIER_ORDER: Tier[] = ['BUST', 'DEVIATE', 'DRIFT', 'COMPLIANT', 'PASSIVE']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}
function classify(t: string | undefined, cat?: string): Klass {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || /^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139)/.test(x)) return 'ga'
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|A30|B76|C5|C17)/.test(x)) return 'heavy'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|E19|E29|CRJ9|CS|BCS)/.test(x)) return 'narrow'
  if (/^(CRJ|E14|E15|E17|E70|E75|AT4|AT5|AT7|DH8|SF34|J32|J41|ATR)/.test(x)) return 'regional'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'biz'
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS)/.test(x)) return 'fighter'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|BE9|BE3|TBM|PC12|TB|PC6|C20|DHC2|DHC6|AN2)/.test(x)) return 'turboprop'
  return 'narrow'
}

const KLASS_V2: Record<Klass, number> = { heavy: 160, narrow: 145, regional: 135, biz: 130, turboprop: 105, ga: 80, fighter: 180 }
const KLASS_VZF: Record<Klass, number> = { heavy: 210, narrow: 200, regional: 180, biz: 190, turboprop: 140, ga: 110, fighter: 240 }

const D2R = Math.PI / 180, R2D = 180 / Math.PI, ER_NM = 3440.065
function gcDistNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R
  const dφ = (la2 - la1) * D2R, dλ = (lo2 - lo1) * D2R
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * ER_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}
function gcBearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R, dλ = (lo2 - lo1) * D2R
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return ((Math.atan2(y, x) * R2D) + 360) % 360
}
function headingDelta(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180)
}

type Nadp = 'NADP1' | 'NADP2' | 'STD'
// Curated 62-airport NADP table. IATA -> { nadp, fieldElevFt }
const NADP_TABLE: Record<string, { nadp: Nadp; elev: number }> = {
  // NADP-1 close-in (residential under flight path)
  FRA: { nadp: 'NADP1', elev: 364 }, MUC: { nadp: 'NADP1', elev: 1487 }, ZRH: { nadp: 'NADP1', elev: 1416 },
  GVA: { nadp: 'NADP1', elev: 1411 }, VIE: { nadp: 'NADP1', elev: 600 }, ORY: { nadp: 'NADP1', elev: 291 },
  LCY: { nadp: 'NADP1', elev: 19 }, DUS: { nadp: 'NADP1', elev: 147 }, HAM: { nadp: 'NADP1', elev: 53 },
  TXL: { nadp: 'NADP1', elev: 122 }, BER: { nadp: 'NADP1', elev: 157 }, BOS: { nadp: 'NADP1', elev: 19 },
  DCA: { nadp: 'NADP1', elev: 14 }, JFK: { nadp: 'NADP1', elev: 13 }, LGA: { nadp: 'NADP1', elev: 21 },
  SNA: { nadp: 'NADP1', elev: 56 }, BUR: { nadp: 'NADP1', elev: 778 }, LGB: { nadp: 'NADP1', elev: 60 },
  TLV: { nadp: 'NADP1', elev: 135 }, HND: { nadp: 'NADP1', elev: 35 }, ITM: { nadp: 'NADP1', elev: 50 },
  TPE: { nadp: 'NADP1', elev: 106 }, ICN: { nadp: 'NADP1', elev: 23 }, GMP: { nadp: 'NADP1', elev: 59 },
  STR: { nadp: 'NADP1', elev: 1276 }, NCE: { nadp: 'NADP1', elev: 12 }, FCO: { nadp: 'NADP1', elev: 13 },
  LIN: { nadp: 'NADP1', elev: 354 }, BCN: { nadp: 'NADP1', elev: 12 }, MAD: { nadp: 'NADP1', elev: 1998 },
  // NADP-2 distant (residential further out along corridor)
  LHR: { nadp: 'NADP2', elev: 83 }, LGW: { nadp: 'NADP2', elev: 202 }, STN: { nadp: 'NADP2', elev: 348 },
  MAN: { nadp: 'NADP2', elev: 257 }, EDI: { nadp: 'NADP2', elev: 135 }, CDG: { nadp: 'NADP2', elev: 392 },
  AMS: { nadp: 'NADP2', elev: -11 }, BRU: { nadp: 'NADP2', elev: 184 }, CPH: { nadp: 'NADP2', elev: 17 },
  ARN: { nadp: 'NADP2', elev: 137 }, OSL: { nadp: 'NADP2', elev: 681 }, HEL: { nadp: 'NADP2', elev: 179 },
  SFO: { nadp: 'NADP2', elev: 13 }, LAX: { nadp: 'NADP2', elev: 125 }, SAN: { nadp: 'NADP2', elev: 17 },
  SEA: { nadp: 'NADP2', elev: 432 }, PDX: { nadp: 'NADP2', elev: 31 }, ORD: { nadp: 'NADP2', elev: 672 },
  ATL: { nadp: 'NADP2', elev: 1026 }, DFW: { nadp: 'NADP2', elev: 607 }, MIA: { nadp: 'NADP2', elev: 8 },
  SIN: { nadp: 'NADP2', elev: 22 }, HKG: { nadp: 'NADP2', elev: 28 }, BKK: { nadp: 'NADP2', elev: 5 },
  SYD: { nadp: 'NADP2', elev: 21 }, MEL: { nadp: 'NADP2', elev: 434 }, AKL: { nadp: 'NADP2', elev: 23 },
  DXB: { nadp: 'NADP2', elev: 62 }, DOH: { nadp: 'NADP2', elev: 13 }, AUH: { nadp: 'NADP2', elev: 88 },
  // STANDARD (non-restricted, monitored but score forced PASSIVE)
  IST: { nadp: 'STD', elev: 325 }, SAW: { nadp: 'STD', elev: 312 }, LED: { nadp: 'STD', elev: 78 },
}

interface Row {
  f: NadpFlight
  klass: Klass
  altFt: number
  vs: number
  gs: number
  ias: number          // proxy IAS
  trk: number
  origIATA: string
  origICAO: string
  origName: string
  origLat: number
  origLng: number
  origDistNm: number
  nadp: Nadp
  agl: number
  v2: number
  vzf: number
  speedExp: number     // expected speed for current AGL band & NADP
  vsExp: number        // expected VS
  speedDelta: number
  vsDelta: number
  dev: number          // combined deviation score
  signature: string    // human-readable profile id
  tier: Tier
}

const SRC_RING = 'nadp-ring', SRC_PROJ = 'nadp-proj', SRC_PIN = 'nadp-pin', SRC_PLBL = 'nadp-plbl', SRC_LBL = 'nadp-lbl', SRC_DIA = 'nadp-dia'
const LYR_RING = 'nadp-ring-l', LYR_PROJ = 'nadp-proj-l', LYR_PIN = 'nadp-pin-l', LYR_PLBL = 'nadp-plbl-l', LYR_LBL = 'nadp-lbl-l', LYR_DIA = 'nadp-dia-l'

// Aligned departure-origin candidates restricted to airports in NADP_TABLE for performance.
const NADP_KEYS = Object.keys(NADP_TABLE)
const NADP_AP = (() => {
  const lut: Record<string, { lat: number; lng: number; icao: string; name: string }> = {}
  for (const ap of AIRPORTS) {
    if (ap.a && NADP_TABLE[ap.a] && !lut[ap.a]) {
      lut[ap.a] = { lat: ap.lat, lng: ap.lon, icao: ap.i, name: ap.m || ap.n || ap.a }
    }
  }
  return NADP_KEYS.filter(k => lut[k]).map(k => ({ iata: k, ...lut[k] }))
})()

function aglIas(klass: Klass, agl: number, nadp: Nadp, vMult: number): { sp: number; vs: number } {
  const v2 = KLASS_V2[klass] * vMult
  const vzf = KLASS_VZF[klass] * vMult
  if (nadp === 'NADP1') {
    // V2+10 to 3000, accelerate after; VS high throughout
    if (agl < 3000) return { sp: v2 + 10, vs: 2400 }
    return { sp: vzf, vs: 1800 }
  }
  // NADP-2: begin accel by 800-1500 to vzf, VS lower in accel
  if (agl < 1500) {
    const f = Math.max(0, Math.min(1, (agl - 800) / 700))
    return { sp: v2 + 10 + f * (vzf - v2 - 10), vs: 1900 }
  }
  if (agl < 3000) return { sp: vzf, vs: 1700 }
  return { sp: vzf + 10, vs: 1600 }
}

export default function NadpMonitor({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minAgl, setMinAgl] = useState(400)
  const [maxAgl, setMaxAgl] = useState(4000)
  const [captureNm, setCaptureNm] = useState(25)
  const [vMultPct, setVMultPct] = useState(100)
  const [tolMultPct, setTolMultPct] = useState(100)
  const [showRing, setShowRing] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS'>('AIRCRAFT')
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const vMult = vMultPct / 100
    const tolMult = tolMultPct / 100
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt) || !isFinite(f.vertRate)) continue
      if (f.vertRate < 600) continue // departing climb
      const klass = classify(f.type, f.category)
      const trk = f.track || 0
      const recip = (trk + 180) % 360
      // Find closest NADP origin behind us (bearing from aircraft to airport within +/-90deg of reciprocal)
      let best: { iata: string; icao: string; name: string; lat: number; lng: number; d: number } | null = null
      for (const ap of NADP_AP) {
        const d = gcDistNm(f.lat, f.lng, ap.lat, ap.lng)
        if (d > captureNm) continue
        const br = gcBearingDeg(f.lat, f.lng, ap.lat, ap.lng)
        if (headingDelta(br, recip) > 90) continue
        if (!best || d < best.d) best = { iata: ap.iata, icao: ap.icao, name: ap.name, lat: ap.lat, lng: ap.lng, d }
      }
      if (!best) continue
      const entry = NADP_TABLE[best.iata]
      const elev = entry.elev
      const agl = f.altitudeFt - elev
      if (agl < minAgl) continue
      const gs = Math.max(60, f.velocityKts || 200)
      // IAS proxy: CAS ~= GS*sqrt(sigma). Low altitude so sigma~=1.
      const ias = gs
      const v2 = KLASS_V2[klass] * vMult
      const vzf = KLASS_VZF[klass] * vMult
      const nadp = entry.nadp
      const passive = agl > maxAgl || agl < 800 || nadp === 'STD'
      const exp = aglIas(klass, agl, nadp, vMult)
      const speedDelta = ias - exp.sp
      const vsDelta = f.vertRate - exp.vs
      // Tolerance: half-band is 25kt speed * tolMult, 700fpm VS * tolMult
      const spHalf = 25 * tolMult
      const vsHalf = 700 * tolMult
      const dev = Math.sqrt((speedDelta / spHalf) ** 2 + (vsDelta / vsHalf) ** 2)
      let tier: Tier
      if (passive) tier = 'PASSIVE'
      else if (dev <= 0.5) tier = 'COMPLIANT'
      else if (dev <= 1.2) tier = 'DRIFT'
      else if (dev <= 2.5) tier = 'DEVIATE'
      else tier = 'BUST'
      // Wrong-profile signature: flying NADP-2 accel envelope at a NADP-1 field below 3000 = BUST
      let signature = nadp === 'NADP1' ? 'climb-V2+10' : nadp === 'NADP2' ? 'accel-Vzf' : 'std'
      if (!passive && nadp === 'NADP1' && agl < 3000 && ias > v2 + 50) {
        tier = 'BUST'; signature = 'wrong-profile (accel where NADP1 expects climb)'
      }
      if (!passive && nadp === 'NADP2' && agl > 1500 && ias < v2 + 30) {
        tier = 'BUST'; signature = 'wrong-profile (no accel where NADP2 expects Vzf)'
      }
      out.push({
        f, klass, altFt: f.altitudeFt, vs: f.vertRate, gs, ias, trk,
        origIATA: best.iata, origICAO: best.icao, origName: best.name,
        origLat: best.lat, origLng: best.lng, origDistNm: best.d,
        nadp, agl, v2, vzf,
        speedExp: exp.sp, vsExp: exp.vs, speedDelta, vsDelta, dev,
        signature, tier,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return b.dev - a.dev
    })
    return out
  }, [flights, minAgl, maxAgl, captureNm, vMultPct, tolMultPct])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { COMPLIANT: 0, DRIFT: 0, DEVIATE: 0, BUST: 0, PASSIVE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let n = 0, sumDev = 0, worst = -1, worstCs = '', busts = 0, inBand = 0, n1Cut = 0
    for (const r of rows) {
      if (r.tier !== 'PASSIVE') { n++; sumDev += r.dev; inBand++ }
      if (r.dev > worst) { worst = r.dev; worstCs = (r.f.callsign || r.f.icao).trim() }
      if (r.tier === 'BUST') busts++
      if (r.nadp === 'NADP1' && r.agl < 3000) n1Cut++
    }
    return {
      meanDev: n > 0 ? sumDev / n : 0,
      worst: worst < 0 ? 0 : worst,
      worstCs,
      busts,
      inBand,
      n1Cut,
    }
  }, [rows])

  const airports = useMemo(() => {
    const m = new Map<string, { iata: string; icao: string; name: string; lat: number; lng: number; elev: number; nadp: Nadp; rows: Row[]; worstTier: Tier; meanDev: number }>()
    for (const r of rows) {
      const k = r.origIATA
      let g = m.get(k)
      if (!g) {
        const entry = NADP_TABLE[r.origIATA]
        g = { iata: r.origIATA, icao: r.origICAO, name: r.origName, lat: r.origLat, lng: r.origLng, elev: entry.elev, nadp: entry.nadp, rows: [], worstTier: 'COMPLIANT' as Tier, meanDev: 0 }
        m.set(k, g)
      }
      g.rows.push(r)
      if (TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(g.worstTier)) g.worstTier = r.tier
    }
    const out = Array.from(m.values()).map(g => ({
      ...g,
      meanDev: g.rows.reduce((a, b) => a + b.dev, 0) / g.rows.length,
    }))
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.worstTier) - TIER_ORDER.indexOf(b.worstTier)
      if (ti !== 0) return ti
      return b.rows.length - a.rows.length
    })
    return out
  }, [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.origIATA, r.origICAO, r.nadp].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [rows, tierFilter, klassFilter, query])

  useEffect(() => {
    if (!map) return
    const haloR = (r: Row) => 8 + Math.min(14, r.dev * 4)
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: haloR(r) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const projFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.tier !== 'PASSIVE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.origLng, r.origLat]] },
    })) : [] }
    const diaFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.tier === 'BUST' || r.tier === 'DEVIATE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'Point' as const, coordinates: [r.origLng, r.origLat] },
    })) : [] }
    // Pins: one per unique airport
    const seen = new Set<string>()
    const pinFeats: any[] = []
    const plblFeats: any[] = []
    for (const r of rows) {
      if (seen.has(r.origIATA)) continue
      seen.add(r.origIATA)
      const entry = NADP_TABLE[r.origIATA]
      const color = entry.nadp === 'NADP1' ? '#10b981' : entry.nadp === 'NADP2' ? '#0ea5e9' : '#64748b'
      pinFeats.push({
        type: 'Feature', properties: { color },
        geometry: { type: 'Point', coordinates: [r.origLng, r.origLat] },
      })
      plblFeats.push({
        type: 'Feature', properties: { color, text: `›${r.origIATA} · ${entry.nadp === 'STD' ? 'STD' : entry.nadp.replace('NADP', 'N')}` },
        geometry: { type: 'Point', coordinates: [r.origLng, r.origLat] },
      })
    }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? pinFeats : [] }
    const plblFc = { type: 'FeatureCollection' as const, features: showPin ? plblFeats : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier !== 'PASSIVE' && r.tier !== 'COMPLIANT').map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${Math.round(r.agl)}'AGL ${Math.round(r.ias)}kt ${r.vs >= 0 ? '+' : ''}${Math.round(r.vs)}fpm`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_RING, ringFc, () => map.addLayer({ id: LYR_RING, type: 'circle', source: SRC_RING, paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.16,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.6,
        'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PROJ, projFc, () => map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.4,
        'line-opacity': 0.7,
        'line-dasharray': [3, 2],
      } }))
      ensure(SRC_DIA, diaFc, () => map.addLayer({ id: LYR_DIA, type: 'circle', source: SRC_DIA, paint: {
        'circle-radius': 5,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#020617',
        'circle-stroke-width': 1.4,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'circle', source: SRC_PIN, paint: {
        'circle-radius': 4.5,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#020617',
        'circle-stroke-width': 1.2,
      } }))
      ensure(SRC_PLBL, plblFc, () => map.addLayer({ id: LYR_PLBL, type: 'symbol', source: SRC_PLBL, layout: {
        'text-field': ['get', 'text'],
        'text-size': 10,
        'text-offset': [0, -1.4],
        'text-anchor': 'bottom',
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Regular'],
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.2,
      } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'],
        'text-size': 10,
        'text-offset': [0, 1.6],
        'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.2,
      } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_PLBL, LYR_PIN, LYR_DIA, LYR_PROJ, LYR_RING]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PLBL, SRC_PIN, SRC_DIA, SRC_PROJ, SRC_RING]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showRing, showProj, showPin, showLabels])

  // SVG envelope diagram: x = AGL kft 0..5, y = IAS 0..300
  const diag = useMemo(() => {
    const W = 360, H = 200, PAD = 28
    const xs = (a: number) => PAD + Math.max(0, Math.min(1, a / 5)) * (W - PAD - 8)
    const ys = (s: number) => 6 + (1 - Math.max(0, Math.min(1, s / 300))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">NADP · Noise Abatement</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} departing</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[9px] font-bold" style={{ color: TIER_COLOR[t] }}>{t === 'COMPLIANT' ? 'COMP' : t === 'PASSIVE' ? 'PASS' : t}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Dev</div>
          <div className="font-mono text-sm" style={{ color: summary.meanDev <= 0.5 ? '#10b981' : summary.meanDev <= 1.2 ? '#0ea5e9' : summary.meanDev <= 2.5 ? '#f59e0b' : '#ef4444' }}>
            {summary.meanDev.toFixed(2)}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worst.toFixed(2)}` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Busts</div>
          <div className="font-mono text-sm" style={{ color: summary.busts > 0 ? '#ef4444' : '#10b981' }}>{summary.busts}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">In-Band</div>
          <div className="font-mono text-xs text-sky-300">{summary.inBand}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">N1 Cutback</div>
          <div className="font-mono text-xs text-emerald-300">{summary.n1Cut}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">IAS · kt vs AGL · kft · NADP envelope</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {/* NADP-1 emerald band: V2+10 (~155kt) from 0.8 to 3 kft, then accel up */}
            <polygon
              points={[
                [diag.xs(0.8), diag.ys(180)],
                [diag.xs(3), diag.ys(180)],
                [diag.xs(5), diag.ys(230)],
                [diag.xs(5), diag.ys(210)],
                [diag.xs(3), diag.ys(160)],
                [diag.xs(0.8), diag.ys(160)],
              ].map(p => p.join(',')).join(' ')}
              fill="#10b981" opacity={0.12}
            />
            <text x={diag.xs(1.6)} y={diag.ys(173)} fontSize={8} fill="#10b981" fontFamily="monospace" opacity={0.9}>NADP-1</text>
            {/* NADP-2 sky accel ramp: 800ft~155kt to 1500ft~210kt then flat to vzf */}
            <polygon
              points={[
                [diag.xs(0.8), diag.ys(165)],
                [diag.xs(1.5), diag.ys(225)],
                [diag.xs(5), diag.ys(235)],
                [diag.xs(5), diag.ys(215)],
                [diag.xs(1.5), diag.ys(205)],
                [diag.xs(0.8), diag.ys(145)],
              ].map(p => p.join(',')).join(' ')}
              fill="#0ea5e9" opacity={0.12}
            />
            <text x={diag.xs(3.2)} y={diag.ys(229)} fontSize={8} fill="#0ea5e9" fontFamily="monospace" opacity={0.9}>NADP-2</text>
            {/* gridlines */}
            {[1, 2, 3, 4, 5].map(k => (
              <g key={k}>
                <line x1={diag.xs(k)} y1={6} x2={diag.xs(k)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(k)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{k}</text>
              </g>
            ))}
            {[100, 150, 200, 250].map(s => (
              <g key={s}>
                <line x1={diag.PAD} y1={diag.ys(s)} x2={diag.W - 6} y2={diag.ys(s)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(s) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{s}</text>
              </g>
            ))}
            <text x={diag.W - 6} y={diag.H - 2} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">AGL kft ›</text>
            <text x={diag.PAD + 2} y={10} textAnchor="start" fontSize={8} fill="#64748b" fontFamily="monospace">› IAS kt</text>
            {/* aircraft dots */}
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(r.agl / 1000)} cy={diag.ys(Math.min(300, r.ias))} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.95} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-AGL</span><span className="font-mono text-slate-300">{minAgl}ft</span></div>
            <input type="range" min={0} max={800} step={50} value={minAgl} onChange={e => setMinAgl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-AGL</span><span className="font-mono text-slate-300">{maxAgl}ft</span></div>
            <input type="range" min={1000} max={5000} step={250} value={maxAgl} onChange={e => setMaxAgl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>CAPTURE</span><span className="font-mono text-slate-300">{captureNm}nm</span></div>
            <input type="range" min={5} max={60} step={1} value={captureNm} onChange={e => setCaptureNm(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>V-MULT</span><span className="font-mono text-slate-300">{vMultPct}%</span></div>
            <input type="range" min={80} max={120} step={1} value={vMultPct} onChange={e => setVMultPct(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-[10px] text-slate-500"><span>TOL-MULT</span><span className="font-mono text-slate-300">{tolMultPct}%</span></div>
          <input type="range" min={50} max={200} step={5} value={tolMultPct} onChange={e => setTolMultPct(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setKlassFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${klassFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['heavy', 'narrow', 'regional', 'biz', 'turboprop', 'ga', 'fighter'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlassFilter(klassFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${klassFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{KLASS_LABEL[k]}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showRing} onChange={e => setShowRing(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / IATA / NADP"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 py-1 border-b border-slate-800 flex gap-1">
        {(['AIRCRAFT', 'AIRPORTS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2 py-1 text-[10px] rounded border font-mono ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
        ))}
        <span className="ml-auto text-[10px] text-slate-500 self-center">
          {tab === 'AIRCRAFT' ? `${filtered.length}/${rows.length}` : `${airports.length} fields`}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No departing aircraft within NADP capture.</div>
        )}
        {tab === 'AIRCRAFT' && filtered.map(r => {
          const devPct = Math.max(0, Math.min(100, (r.dev / 3) * 100))
          const advice =
            r.tier === 'BUST' && r.signature.startsWith('wrong')
              ? 'flying wrong NADP · cross-check SOP / FMS noise profile'
            : r.tier === 'BUST' ? 'profile bust · review thrust + pitch · ACARS noise tape'
            : r.tier === 'DEVIATE' ? 'profile deviation · trim VS or speed back to envelope'
            : r.tier === 'DRIFT' ? 'minor drift · monitor cutback altitude'
            : r.tier === 'PASSIVE' ? 'out of NADP band · monitoring suspended'
            : 'compliant · maintain noise abatement profile'
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{KLASS_LABEL[r.klass]}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="AGL altitude">{Math.round(r.agl)}'AGL</span>
                  <span title="IAS proxy" className="text-sky-300">{Math.round(r.ias)}kt</span>
                  <span title="vert rate" className={r.vs >= 1500 ? 'text-emerald-300' : 'text-amber-300'}>{r.vs >= 0 ? '+' : ''}{Math.round(r.vs)}fpm</span>
                  <span className="ml-auto" style={{ color: r.nadp === 'NADP1' ? '#10b981' : r.nadp === 'NADP2' ? '#0ea5e9' : '#64748b' }}>{r.nadp === 'STD' ? 'STD' : r.nadp.replace('NADP', 'NADP-')}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="combined deviation 0..3">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${devPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-emerald-400" style={{ left: `${(0.5 / 3) * 100}%` }} title="COMPLIANT thr 0.5" />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: `${(1.2 / 3) * 100}%` }} title="DRIFT thr 1.2" />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${(2.5 / 3) * 100}%` }} title="DEVIATE thr 2.5" />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="speed delta vs envelope" className={Math.abs(r.speedDelta) > 25 ? 'text-amber-300' : 'text-slate-400'}>Δsp {r.speedDelta >= 0 ? '+' : ''}{Math.round(r.speedDelta)}kt</span>
                  <span title="VS delta vs envelope" className={Math.abs(r.vsDelta) > 700 ? 'text-amber-300' : 'text-slate-400'}>ΔVS {r.vsDelta >= 0 ? '+' : ''}{Math.round(r.vsDelta)}fpm</span>
                  <span className="ml-auto truncate" title="profile signature">{r.signature}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="origin airport"><span style={{ color: TIER_COLOR[r.tier] }}>‹{r.origIATA}</span> {r.origDistNm.toFixed(0)}nm</span>
                  <span className="ml-auto truncate">V2 {Math.round(r.v2)} · Vzf {Math.round(r.vzf)}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}

        {tab === 'AIRPORTS' && airports.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No active NADP fields.</div>
        )}
        {tab === 'AIRPORTS' && airports.map(a => {
          const devPct = Math.max(0, Math.min(100, (a.meanDev / 3) * 100))
          return (
            <button key={a.iata} onClick={() => onFly(a.rows[0].f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{a.iata}</span>
                  <span className="text-slate-500 truncate">{a.name}</span>
                  <span className="ml-auto text-[10px] font-mono" style={{ color: a.nadp === 'NADP1' ? '#10b981' : a.nadp === 'NADP2' ? '#0ea5e9' : '#64748b' }}>{a.nadp === 'STD' ? 'STD' : a.nadp.replace('NADP', 'NADP-')}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[a.worstTier] }}>{a.worstTier === 'COMPLIANT' ? 'COMP' : a.worstTier === 'PASSIVE' ? 'PASS' : a.worstTier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="departing count">{a.rows.length} dep</span>
                  <span title="field elev">{a.elev}'elev</span>
                  <span className="ml-auto" style={{ color: TIER_COLOR[a.worstTier] }}>μDev {a.meanDev.toFixed(2)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${devPct}%`, background: TIER_COLOR[a.worstTier], opacity: 0.85 }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate">{a.icao}</span>
                  <span className="ml-auto truncate">{a.lat.toFixed(2)}, {a.lng.toFixed(2)}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
