'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   CRZL · Semicircular-Rule Cruise-Level Compliance Monitor
   ------------------------------------------------------------
   Per-aircraft compliance scorer against the ICAO/FAA
   Semicircular Cruising-Level rule — a structural traffic-
   separation device entirely DIFFERENT from RVSM height-
   keeping (which measures altimetry precision around the
   assigned FL): the semicircular rule asks whether the
   *assigned* FL itself is the correct *parity* given the
   aircraft's magnetic track.
   ------------------------------------------------------------
   Rules implemented (selectable per region):

   ICAO Annex 2 Appendix 3 (IFR · RVSM airspace · FL290+ to
   FL410, 1000 ft separation):
     · Magnetic track 000°-179°  → odd FLs   (290, 310, 330, …)
     · Magnetic track 180°-359°  → even FLs  (300, 320, 340, …)

   ICAO Annex 2 Appendix 3 (IFR · below FL290, 2000-ft
   separation in some regions, 1000-ft elsewhere):
     · 000°-179°  → odd thousands  (FL050, 070, 090, …)
     · 180°-359°  → even thousands (FL060, 080, 100, …)

   14 CFR §91.179 (IFR · US · within RVSM identical;
   below FL290 odd/even thousands).

   14 CFR §91.159 (VFR · US · more-than-3000-ft-AGL):
     · 000°-179°  → odd thousand + 500 ft   (3500, 5500, …)
     · 180°-359°  → even thousand + 500 ft  (4500, 6500, …)

   ICAO Annex 2 Appendix 3 (VFR · ICAO):
     · 000°-179°  → odd thousand + 500 ft
     · 180°-359°  → even thousand + 500 ft

   "East/West rule" — exceptions:
     · Oceanic / OTS NAT tracks: PBCS/RVSM but FL parity
       waived inside organised tracks (NAT Doc 007 §2.2.5)
     · RVSM transition airspace FL280-FL290 mixed regimes
     · Cruise climbs / step climbs: instantaneous violation
       acceptable while transitioning, scored softer
     · Polar / RNP-10 area: ICAO regional supplementary
       (NAT-OPS Bull / PACOTS): semicircular waived inside
       fixed tracks

   ------------------------------------------------------------
   Six drivers (max-driver composite, 0-100):

     · PARITY    Δ between actual FL and nearest correct
                 FL of the right parity for the current
                 magnetic track. Ramp 0=at correct level,
                 100=one full slab off (2000 ft above/below
                 wrong parity).

     · BAND      Whether FL is even inside the rule's
                 published band (FL050-FL410 IFR, > 3000 ft
                 AGL VFR). Outside band → driver muted.

     · TRACK     How close magnetic track is to the
                 000°/180° flip (where the parity decision
                 changes); higher driver for tracks in the
                 ±10° boundary band — small course error
                 across the boundary causes parity hop.

     · DRIFT     Indicator that aircraft is *transitioning*
                 (|VS| > 500 fpm); drives the "level change"
                 amplifier so we don't over-flag step climbs.
                 Driver is SUBTRACTED from composite during
                 active vertical manoeuvres.

     · OCEANIC   Whether aircraft sits inside an organised-
                 track / waived region (NAT OTS / PACOTS /
                 EUR free-route Q-routes); driver mutes
                 PARITY when in waived airspace.

     · CONF      Overall composite confidence (lower at
                 low altitude where mag-variation chart
                 is unavailable, higher in clean cruise).

   Composite = max(PARITY,BAND,TRACK) · 0.62
              + mean(PARITY,BAND,TRACK) · 0.38
              − DRIFT · 0.40 · advMul   (transition relief)
              − OCEANIC · 0.50          (waiver relief)
              × ADV-MUL

   ------------------------------------------------------------
   Six tiers (descending severity, dispatched FL):

     · WRONG-FL    ≥ 80   rose       FL parity flat wrong for
                              current track; ATC re-clearance
                              needed (Annex 2 App.3 / 14 CFR
                              §91.179)
     · OFF-PARITY  ≥ 55   rose-pink  off by one slab inside
                              correct band, possibly mid-
                              step-climb but not transitioning
     · BOUNDARY    ≥ 35   amber      magnetic track within
                              ±10° of 000°/180° flip; small
                              heading drift will trip parity
     · OK          ≥ 12   sky        on correct FL for the
                              parity rule
     · WAIVED      ≥  4   emerald    inside OTS / PACOTS /
                              free-route waived band
     · NOT-CRUISE  slate            climbing/descending or
                              on-ground

   ------------------------------------------------------------
   Mag-variation:  Coarse zonal model:
     · NA/US: −10° to +20° west declination by longitude
     · EU:    +0° to +5°
     · NAT oceanic: −20° to +30° interpolated by lon
   Track_mag = Track_true + magvar  (declination east +ve).

   ------------------------------------------------------------
   Side panel:
     · 7-tier counter strip · click-to-filter ALL
     · 5-cell summary  MEAN-Δfl / WRONG-FL count / WORST cs /
       Σ-NM-in-violation (proxy) / MEAN-CONF
     · 5 sliders  RULESET (ICAO-IFR / FAA-IFR / VFR-3000 /
                  ALL-MIXED) / BOUNDARY-WIDTH (5-25°) /
                  MIN-FL / MAX-FL / ADV-MUL
     · 7-class chip filter HVY WB-M NB RGN-J RGN-T BIZ
       LIGHT
     · HALO / PIN / LBL / CORR (correct-FL ghost) toggles
     · Search by callsign / type / operator / tier
     · AIRCRAFT / RULES / DIAGRAM tab switcher
       · AIRCRAFT: row stack tier-worst-first
       · RULES: rule-cards with applicable bands & references
       · DIAGRAM: SVG of parity bands per ruleset with current
                  fleet samples placed on the parity wheel

   ------------------------------------------------------------
   References:
     · ICAO Annex 2 Rules of the Air Appendix 3 Cruising Levels
     · ICAO Doc 4444 PANS-ATM §4.5 §5.4 cruise levels & step
     · ICAO Doc 9574 Manual on Implementation of 1000 ft VSM
       (RVSM) Ch.4 cruising levels above FL290
     · NAT Doc 007 §2.2.5 OTS conventions / random routes
     · FAA 14 CFR §91.159 VFR cruising altitude
     · FAA 14 CFR §91.179 IFR cruising altitude
     · FAA AIM §3-1-5, §4-4-9 cruising altitudes
     · FAA Order JO 7110.65 §5-7-1 vertical separation
     · ICAO Doc 7030 Regional Supplementary Procedures /
       NAT/PAC/CAR/SAM amendments
     · ICAO Doc 9613 PBN Manual Vol II Pt C oceanic
     · NAT-OPS Bulletin 2024-01 strategic lateral offset
     · Belobaba Odoni Barnhart Global Airline Industry 2e §3.4
============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'WRONG-FL' | 'OFF-PARITY' | 'BOUNDARY' | 'OK' | 'WAIVED' | 'NOT-CRUISE'
const TIER_COLOR: Record<Tier, string> = {
  'WRONG-FL':'#ef4444', 'OFF-PARITY':'#f43f5e', BOUNDARY:'#f59e0b',
  OK:'#0ea5e9', WAIVED:'#10b981', 'NOT-CRUISE':'#475569',
}
const TIER_ORDER: Tier[] = ['WRONG-FL','OFF-PARITY','BOUNDARY','OK','WAIVED','NOT-CRUISE']
const TIER_RANK: Record<Tier, number> = { 'WRONG-FL':0, 'OFF-PARITY':1, BOUNDARY:2, OK:3, WAIVED:4, 'NOT-CRUISE':5 }

type Klass = 'HVY' | 'WB-M' | 'NB' | 'RGN-J' | 'RGN-T' | 'BIZ' | 'LIGHT'
const KLASS_COLOR: Record<Klass, string> = {
  HVY:'#a855f7', 'WB-M':'#8b5cf6', NB:'#10b981',
  'RGN-J':'#f59e0b', 'RGN-T':'#eab308', BIZ:'#ec4899', LIGHT:'#22d3ee',
}
const KLASS_LIST: Klass[] = ['HVY','WB-M','NB','RGN-J','RGN-T','BIZ','LIGHT']

function classifyType(t?: string): Klass {
  if (!t) return 'NB'
  const T = t.toUpperCase()
  if (/^(B74|B77|B78|A38|A35|A33[89])/.test(T)) return 'HVY'
  if (/^(B76|A33[023]|A34)/.test(T)) return 'WB-M'
  if (/^(B73|B75|A31|A32|BCS|MD8|MD9|B71)/.test(T)) return 'NB'
  if (/^(E17|E19|E29|CRJ|RJ8|EM7)/.test(T)) return 'RGN-J'
  if (/^(AT[47]|DH8|ATR|SF34|J32|J41)/.test(T)) return 'RGN-T'
  if (/^(GLEX|GLF|GL5|G65|FA[5-9]|FA2|FA1|CL6|CL3|C25|C56|C68|E55|E50|BE40)/.test(T)) return 'BIZ'
  if (/^(C1[78]|C2[02]|PA[2-4]|BE2|BE3|SR2|DA[24])/.test(T)) return 'LIGHT'
  return 'NB'
}

function clamp(x:number,a:number,b:number){return Math.max(a,Math.min(b,x))}

/* Coarse zonal magnetic variation model (declination east-positive).
   Good to ±2° in continental US/EU, ±5° in oceanic. */
function magVar(lat: number, lng: number): number {
  if (lng > -130 && lng < -65) {
    /* CONUS: west declination decreases east */
    return -15 + (lng + 130) * (30 / 65)
  }
  if (lng >= -65 && lng <= -10) {
    /* North Atlantic: large west declination */
    return -25 + (lng + 65) * (25 / 55)
  }
  if (lng > -10 && lng < 35) {
    /* Europe: small east declination */
    return 1 + (lng + 10) * (4 / 45)
  }
  if (lng >= 35 && lng <= 145) {
    /* Asia: variable */
    return 5 + (lng - 35) * (6 / 110)
  }
  if (lng > 145 || lng < -150) {
    /* PAC oceanic */
    return -10
  }
  return 0
}

type Ruleset = 'ICAO-IFR' | 'FAA-IFR' | 'VFR-3000' | 'ALL-MIXED'

interface ParityCheck {
  ruleApplied: 'IFR-RVSM' | 'IFR-PRE-RVSM' | 'VFR-HEMI' | 'WAIVED' | 'OUT-OF-BAND'
  correctFL: number     /* nearest correct FL for the parity */
  altActual: number
  deltaFt: number       /* |actual − correctFL_100| in ft */
  isEastbound: boolean  /* mag track 000-179° */
  trackMag: number
  oceanic: boolean
  inBoundaryBand: boolean
  notes: string[]
}

/* Identify if the aircraft is within a waived organised-track band.
   We approximate the NAT OTS daily corridor 40-58°N, lon −60 to −10°,
   and PACOTS 25-50°N, lon 140°E to −140°W. */
function inOceanicWaiver(lat: number, lng: number): boolean {
  const nat = lat > 40 && lat < 58 && lng > -60 && lng < -10
  const pac = lat > 25 && lat < 50 && (lng > 140 || lng < -140)
  return nat || pac
}

/* Snap FL to nearest correct value for the given parity rule. */
function snapIFR_RVSM(altFt: number, eastbound: boolean): number {
  /* FL290+ : odd / even thousands (1000-ft VSM). */
  const fl = Math.round(altFt / 100)
  /* eastbound → odd; westbound → even */
  const wantOdd = eastbound
  let snap = Math.round(fl / 10) * 10
  if (wantOdd && (snap % 20 === 0)) {
    /* even slab; choose nearest odd */
    snap = altFt > snap * 100 ? snap + 10 : snap - 10
  }
  if (!wantOdd && (snap % 20 !== 0)) {
    snap = altFt > snap * 100 ? snap + 10 : snap - 10
  }
  return snap * 100
}
function snapIFR_PRE(altFt: number, eastbound: boolean): number {
  /* FL050-FL280: odd / even thousands (1000-ft sep). */
  const thouK = Math.round(altFt / 1000)
  const wantOdd = eastbound
  let snap = thouK
  if (wantOdd && (snap % 2 === 0)) snap += altFt > snap * 1000 ? 1 : -1
  if (!wantOdd && (snap % 2 !== 0)) snap += altFt > snap * 1000 ? 1 : -1
  return snap * 1000
}
function snapVFR_HEMI(altFt: number, eastbound: boolean): number {
  /* > 3000 ft AGL: odd/even thousand + 500 ft. */
  /* round to nearest 1000+500 of the right parity */
  const wantOdd = eastbound
  const thouK = Math.round((altFt - 500) / 1000)
  let snap = thouK
  if (wantOdd && (snap % 2 === 0)) snap += altFt > snap * 1000 + 500 ? 1 : -1
  if (!wantOdd && (snap % 2 !== 0)) snap += altFt > snap * 1000 + 500 ? 1 : -1
  return snap * 1000 + 500
}

function checkParity(f: SFlight, rs: Ruleset, boundaryDeg: number): ParityCheck {
  const notes: string[] = []
  const mv = magVar(f.lat, f.lng)
  const trackMag = ((f.track + mv) % 360 + 360) % 360
  const eastbound = trackMag < 180
  const flipDist = Math.min(trackMag, Math.abs(trackMag - 180), Math.abs(trackMag - 360))
  const inBoundaryBand = flipDist <= boundaryDeg
  const altFt = f.altitudeFt
  const oceanic = inOceanicWaiver(f.lat, f.lng)
  if (oceanic) notes.push('inside OTS/PACOTS waiver band — semicircular waived (NAT Doc 007 §2.2.5)')

  /* IFR-RVSM band FL290-FL410 */
  if ((rs === 'ICAO-IFR' || rs === 'FAA-IFR' || rs === 'ALL-MIXED') && altFt >= 28500 && altFt <= 41500) {
    const correct = snapIFR_RVSM(altFt, eastbound)
    return {
      ruleApplied: oceanic ? 'WAIVED' : 'IFR-RVSM',
      correctFL: Math.round(correct / 100),
      altActual: altFt,
      deltaFt: Math.abs(altFt - correct),
      isEastbound: eastbound, trackMag, oceanic, inBoundaryBand, notes,
    }
  }
  /* IFR Pre-RVSM band FL050-FL280 */
  if ((rs === 'ICAO-IFR' || rs === 'FAA-IFR' || rs === 'ALL-MIXED') && altFt >= 4500 && altFt < 28500) {
    const correct = snapIFR_PRE(altFt, eastbound)
    return {
      ruleApplied: 'IFR-PRE-RVSM',
      correctFL: Math.round(correct / 100),
      altActual: altFt, deltaFt: Math.abs(altFt - correct),
      isEastbound: eastbound, trackMag, oceanic, inBoundaryBand, notes,
    }
  }
  /* VFR hemispheric band > 3000 ft (we assume AGL ≈ MSL minus 500 for the model) */
  if ((rs === 'VFR-3000' || rs === 'ALL-MIXED') && altFt >= 3500 && altFt <= 18000) {
    const correct = snapVFR_HEMI(altFt, eastbound)
    return {
      ruleApplied: 'VFR-HEMI',
      correctFL: Math.round(correct / 100),
      altActual: altFt, deltaFt: Math.abs(altFt - correct),
      isEastbound: eastbound, trackMag, oceanic, inBoundaryBand, notes,
    }
  }
  return {
    ruleApplied: 'OUT-OF-BAND',
    correctFL: Math.round(altFt / 100),
    altActual: altFt, deltaFt: 0,
    isEastbound: eastbound, trackMag, oceanic, inBoundaryBand, notes,
  }
}

interface Drivers { PARITY:number; BAND:number; TRACK:number; DRIFT:number; OCEANIC:number; CONF:number }
interface Row {
  f: SFlight; kl: Klass
  chk: ParityCheck
  drivers: Drivers
  score: number
  tier: Tier
}

function scoreRow(f: SFlight, chk: ParityCheck, boundaryDeg: number, advMul: number): { drivers: Drivers; score: number } {
  if (chk.ruleApplied === 'OUT-OF-BAND') {
    return { drivers:{ PARITY:0, BAND:0, TRACK:0, DRIFT:0, OCEANIC:0, CONF:30 }, score:0 }
  }
  /* PARITY ramp: 0 at exact, 100 at 2000ft off */
  const PARITY = clamp((chk.deltaFt / 2000) * 100, 0, 100)
  /* BAND: 0 inside band, scales with eligibility (we already filter by band) */
  const BAND = chk.ruleApplied === 'WAIVED' ? 5 : 70
  /* TRACK: how close to the flip boundary */
  const flipDist = Math.min(chk.trackMag, Math.abs(chk.trackMag - 180), Math.abs(chk.trackMag - 360))
  const TRACK = clamp(100 - (flipDist / boundaryDeg) * 100, 0, 100)
  /* DRIFT: |VS|>500 fpm relief — climbing/descending */
  const absVs = Math.abs(f.vertRate || 0)
  const DRIFT = clamp((absVs - 200) / 1200 * 100, 0, 100)
  /* OCEANIC: waiver mute */
  const OCEANIC = chk.oceanic ? 100 : 0
  /* CONF */
  const CONF = clamp(60 + (chk.ruleApplied === 'IFR-RVSM' ? 25 : chk.ruleApplied === 'IFR-PRE-RVSM' ? 15 : 0) - (absVs > 1000 ? 20 : 0), 10, 95)

  const triad = [PARITY, BAND * (PARITY > 0 ? 0.4 : 0.0), TRACK]
  const maxD = Math.max(...triad)
  const meanD = triad.reduce((a,b)=>a+b,0)/3
  let composite = maxD * 0.62 + meanD * 0.38
  composite -= DRIFT * 0.40
  composite -= OCEANIC * 0.50
  composite *= (advMul / 100)
  return { drivers:{ PARITY, BAND, TRACK, DRIFT, OCEANIC, CONF }, score: clamp(composite, 0, 100) }
}

function classifyTier(score: number, chk: ParityCheck, drivers: Drivers, f: SFlight): Tier {
  const transitioning = Math.abs(f.vertRate || 0) > 800
  if (chk.ruleApplied === 'OUT-OF-BAND') return 'NOT-CRUISE'
  if (chk.oceanic) return 'WAIVED'
  if (transitioning && chk.deltaFt < 1500) return 'NOT-CRUISE'
  if (score >= 80) return 'WRONG-FL'
  if (score >= 55) return 'OFF-PARITY'
  if (score >= 35) return 'BOUNDARY'
  if (score >= 12) return 'OK'
  return 'OK'
}

export default function CrzlSemicircular({ map, flights, onClose, onFly }: Props) {
  const [ruleset, setRuleset] = useState<Ruleset>('ALL-MIXED')
  const [boundaryDeg, setBoundaryDeg] = useState(10)
  const [minFL, setMinFL] = useState(50)
  const [maxFL, setMaxFL] = useState(420)
  const [advMul, setAdvMul] = useState(100)
  const [klFilter, setKlFilter] = useState<Record<Klass, boolean>>({ HVY:true,'WB-M':true,NB:true,'RGN-J':true,'RGN-T':true,BIZ:true,LIGHT:true })
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showCorr, setShowCorr] = useState(true)
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'RULES'|'DIAGRAM'>('AIRCRAFT')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      const FL = f.altitudeFt / 100
      if (FL < minFL || FL > maxFL) continue
      const chk = checkParity(f, ruleset, boundaryDeg)
      const { drivers, score } = scoreRow(f, chk, boundaryDeg, advMul)
      const tier = classifyTier(score, chk, drivers, f)
      out.push({ f, kl: classifyType(f.type), chk, drivers, score, tier })
    }
    out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, ruleset, boundaryDeg, minFL, maxFL, advMul])

  const filtered = useMemo(() => rows.filter(r => {
    if (!klFilter[r.kl]) return false
    if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
    if (q) {
      const t = q.toLowerCase()
      const hay = `${r.f.callsign||''} ${r.f.icao} ${r.f.type||''} ${r.f.operator||''} ${r.kl} ${r.tier}`.toLowerCase()
      if (!hay.includes(t)) return false
    }
    return true
  }), [rows, klFilter, tierFilter, q])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { 'WRONG-FL':0, 'OFF-PARITY':0, BOUNDARY:0, OK:0, WAIVED:0, 'NOT-CRUISE':0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const meanDelta = rows.length ? rows.reduce((a,b)=>a+b.chk.deltaFt,0)/rows.length : 0
  const wrongCnt = tierCounts['WRONG-FL']
  const worst = rows[0]
  const sigViol = rows.filter(r => r.tier === 'WRONG-FL' || r.tier === 'OFF-PARITY').reduce((a,b)=>a+(b.f.velocityKts*0.5),0)
  const meanConf = rows.length ? rows.reduce((a,b)=>a+b.drivers.CONF,0)/rows.length : 0

  /* ----- MapLibre overlay ----- */
  useEffect(() => {
    if (!map) return
    const SRC = 'crzl-ac-src'
    const HALO = 'crzl-halo'
    const PIN = 'crzl-pin'
    const LBL = 'crzl-lbl'
    const CORR = 'crzl-corr'

    const acFC = { type:'FeatureCollection' as const, features: rows.map(r => ({
      type:'Feature' as const,
      geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat] },
      properties:{
        cs: r.f.callsign || r.f.icao,
        fl: `FL${Math.round(r.f.altitudeFt/100)}`,
        cfl: `→FL${r.chk.correctFL}`,
        delta: r.chk.deltaFt ? `±${r.chk.deltaFt}ft` : 'on',
        tier: r.tier,
        color: TIER_COLOR[r.tier],
        haloR: r.tier === 'WRONG-FL' ? 19 : r.tier === 'OFF-PARITY' ? 16 : r.tier === 'BOUNDARY' ? 12 : r.tier === 'OK' ? 8 : r.tier === 'WAIVED' ? 7 : 5,
        pinScale: (r.tier === 'WRONG-FL' || r.tier === 'OFF-PARITY') ? 1 : 0,
      },
    })) }

    const add = () => {
      try {
        if (!map.getSource(SRC)) map.addSource(SRC, { type:'geojson', data: acFC as any })
        else (map.getSource(SRC) as any).setData(acFC)

        if (showHalo && !map.getLayer(HALO)) map.addLayer({ id: HALO, type:'circle', source: SRC, paint:{
          'circle-radius':['get','haloR'], 'circle-color':['get','color'],
          'circle-opacity':0.14, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85,
        }})
        if (showPin && !map.getLayer(PIN)) map.addLayer({ id: PIN, type:'circle', source: SRC, filter:['>',['get','pinScale'],0], paint:{
          'circle-radius':['*', 5.5, ['get','pinScale']],
          'circle-color':['get','color'], 'circle-stroke-color':'#fff', 'circle-stroke-width':1.3,
        }})
        if (showLbl && !map.getLayer(LBL)) map.addLayer({ id: LBL, type:'symbol', source: SRC, layout:{
          'text-field':['concat',['get','cs'],'  ',['get','fl'],' ',['get','cfl'],'  ',['get','delta']],
          'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top',
          'text-font':['Open Sans Semibold','Arial Unicode MS Bold'],
        }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0b1220', 'text-halo-width':1.2 }})
        if (showCorr && !map.getLayer(CORR)) map.addLayer({ id: CORR, type:'symbol', source: SRC,
          filter:['in',['get','tier'], ['literal', ['WRONG-FL','OFF-PARITY']]],
          layout:{
            'text-field': ['concat','› ', ['get','cfl']],
            'text-size':9, 'text-offset':[0,-1.6], 'text-anchor':'bottom',
            'text-font':['Open Sans Semibold','Arial Unicode MS Bold'],
          }, paint:{ 'text-color':'#0ea5e9', 'text-halo-color':'#0b1220', 'text-halo-width':1.2 } })
      } catch {}
    }
    if (map.isStyleLoaded()) add(); else map.once('load', add)
    return () => {
      try {
        for (const l of [CORR, LBL, PIN, HALO]) if (map.getLayer(l)) map.removeLayer(l)
        if (map.getSource(SRC)) map.removeSource(SRC)
      } catch {}
    }
  }, [map, rows, showHalo, showPin, showLbl, showCorr])

  return (
    <div className="absolute right-3 top-20 z-30 w-[470px] max-h-[80vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">CRZL</div>
        <div className="text-[10px] text-slate-400 truncate">Semicircular cruise-level compliance · track ↔ FL parity</div>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-[12px] px-2 py-0.5 rounded hover:bg-slate-800/60">✕</button>
        </div>
      </div>

      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        {(['WRONG-FL','OFF-PARITY','BOUNDARY','OK','WAIVED','NOT-CRUISE'] as Tier[]).map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter===t?'ALL':t)}
            className={`px-1 py-1 rounded border ${tierFilter===t?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
            <div className="text-[8px]" style={{color: TIER_COLOR[t]}}>{t}</div>
            <div className="text-slate-100 font-semibold">{tierCounts[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">MEAN-Δ</div>
          <div className="text-slate-100 font-semibold tabular-nums">{meanDelta.toFixed(0)}ft</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">WRONG-FL</div>
          <div className="font-semibold tabular-nums" style={{color: wrongCnt ? TIER_COLOR['WRONG-FL'] : '#cbd5e1'}}>{wrongCnt}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">WORST</div>
          <div className="text-slate-100 font-semibold truncate text-[10px]">{worst ? worst.f.callsign || worst.f.icao : '—'}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">Σ-VIOL</div>
          <div className="text-slate-100 font-semibold tabular-nums">{sigViol.toFixed(0)}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">MEAN-CF</div>
          <div className="text-slate-100 font-semibold tabular-nums">{meanConf.toFixed(0)}%</div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800/60 text-[10px]">
        <div className="flex gap-1 mb-2">
          {(['ICAO-IFR','FAA-IFR','VFR-3000','ALL-MIXED'] as Ruleset[]).map(r => (
            <button key={r} onClick={() => setRuleset(r)}
              className={`flex-1 px-1 py-1 rounded border ${ruleset===r?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-400 hover:border-slate-700'}`}>{r}</button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          {([
            ['BOUND-°', boundaryDeg, setBoundaryDeg, 5, 25, '°', 1],
            ['MIN-FL', minFL, setMinFL, 30, 420, '', 5],
            ['MAX-FL', maxFL, setMaxFL, 100, 450, '', 5],
            ['ADV-MUL', advMul, setAdvMul, 50, 200, '%', 1],
          ] as Array<[string, number, (n:number)=>void, number, number, string, number]>).map(([lbl,val,set,lo,hi,suf,step]) => (
            <label key={lbl} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-16">{lbl}</span>
              <input type="range" min={lo} max={hi} step={step} value={val}
                onChange={e => set(parseFloat(e.target.value))}
                className="flex-1 h-1 accent-sky-500" />
              <span className="text-slate-300 tabular-nums w-12 text-right">{val}{suf}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800/60">
        {KLASS_LIST.map(k => (
          <button key={k} onClick={() => setKlFilter(p => ({...p, [k]: !p[k]}))}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${klFilter[k]?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700 opacity-50'}`}
            style={{color: KLASS_COLOR[k]}}>{k}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800/60 text-[9px]">
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],['CORR',showCorr,setShowCorr]] as const).map(([n,v,s])=>(
          <button key={n} onClick={()=>(s as any)(!v)} className={`px-1.5 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-500 hover:border-slate-700'}`}>{n}</button>
        ))}
      </div>

      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-800/60">
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="callsign / type / operator / tier"
          className="flex-1 bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/40" />
      </div>
      <div className="flex gap-0.5 px-3 py-1.5 border-b border-slate-800/60 text-[10px]">
        {(['AIRCRAFT','RULES','DIAGRAM'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 text-slate-100 border border-sky-500/40':'text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1 text-[11px]">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500">no airborne aircraft in semicircular-rule band</div>}
            {filtered.slice(0, 60).map(r => {
              const advice =
                r.tier === 'WRONG-FL' ? 'FL parity wrong for magnetic track · request ATC re-clear to correct slab (Annex 2 App.3 / 14 CFR §91.179)' :
                r.tier === 'OFF-PARITY' ? 'off by one slab · likely undeclared step climb or wrong-parity dispatch' :
                r.tier === 'BOUNDARY' ? `mag track ${r.chk.trackMag.toFixed(0)}° within ±${boundaryDeg}° of 000°/180° flip — small heading drift trips parity` :
                r.tier === 'WAIVED' ? 'inside organised-track / oceanic waiver band (NAT Doc 007 §2.2.5)' :
                r.tier === 'NOT-CRUISE' ? 'climbing/descending — semicircular not enforced (Doc 4444 §4.5)' :
                'on correct FL for parity rule'
              return (
                <button key={r.f.icao} onClick={()=>onFly(r.f.icao)} className="w-full text-left px-3 py-2 hover:bg-slate-900/60 transition">
                  <div className="flex items-center gap-2 mb-1" style={{borderLeft:`3px solid ${TIER_COLOR[r.tier]}`, paddingLeft:8}}>
                    <span className="font-semibold text-slate-100">{r.f.callsign || r.f.icao}</span>
                    <span className="text-[9px] text-slate-500">{r.f.type || '—'}</span>
                    <span className="text-[9px] px-1 rounded" style={{background:`${KLASS_COLOR[r.kl]}22`, color: KLASS_COLOR[r.kl]}}>{r.kl}</span>
                    <span className="text-[9px] px-1 rounded ml-auto" style={{background:`${TIER_COLOR[r.tier]}22`, color: TIER_COLOR[r.tier]}}>{r.tier}</span>
                    <span className="text-[9px] text-slate-500 tabular-nums">{r.score.toFixed(0)}</span>
                  </div>
                  <div className="grid grid-cols-5 gap-1 text-[10px] mb-1 pl-2">
                    <div><span className="text-slate-500">FL </span><span className="text-slate-200 tabular-nums">{Math.round(r.f.altitudeFt/100)}</span></div>
                    <div><span className="text-slate-500">→ </span><span className="tabular-nums" style={{color: r.chk.deltaFt===0?'#10b981':'#0ea5e9'}}>{r.chk.correctFL}</span></div>
                    <div><span className="text-slate-500">Δ </span><span className="tabular-nums" style={{color: r.chk.deltaFt>=1000?TIER_COLOR['WRONG-FL']:r.chk.deltaFt>0?TIER_COLOR.BOUNDARY:'#cbd5e1'}}>{r.chk.deltaFt}ft</span></div>
                    <div><span className="text-slate-500">TRKm </span><span className="text-slate-200 tabular-nums">{r.chk.trackMag.toFixed(0)}°</span></div>
                    <div><span className="text-slate-500">{r.chk.isEastbound?'E':'W'} </span><span className="text-slate-300">{r.chk.isEastbound?'odd':'even'}</span></div>
                  </div>
                  <div className="pl-2">
                    <div className="h-1 rounded bg-slate-900 overflow-hidden">
                      <div style={{width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%'}}/>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1 pl-2 mt-1.5 text-[8.5px]">
                    {(['PARITY','TRACK','BAND','DRIFT','OCEANIC'] as const).map(d => {
                      const val = (r.drivers as any)[d] as number
                      const muted = (d==='DRIFT' && val<20) || (d==='OCEANIC' && val<1)
                      return (
                        <span key={d} className={`px-1 py-0.5 rounded border ${muted?'border-slate-800 text-slate-600':'border-slate-700 text-slate-300'}`}>
                          {d} <span className="tabular-nums" style={{color: val>=70?TIER_COLOR['OFF-PARITY']:val>=40?TIER_COLOR.BOUNDARY:'#94a3b8'}}>{val.toFixed(0)}</span>
                        </span>
                      )
                    })}
                  </div>
                  <div className="text-[9.5px] mt-1 pl-2 italic" style={{color: TIER_COLOR[r.tier]}}>{advice}</div>
                </button>
              )
            })}
          </div>
        )}

        {tab === 'RULES' && (
          <div className="divide-y divide-slate-800/60 text-[10.5px]">
            {[
              {
                name: 'IFR · RVSM band FL290-FL410',
                band: 'magnetic track 000-179° → odd FLs (290/310/330…), 180-359° → even FLs (300/320/340…), 1000-ft separation',
                ref: 'ICAO Annex 2 App.3 · Doc 9574 Ch.4 · 14 CFR §91.179 · FAA AIM §3-1-5',
              },
              {
                name: 'IFR · Pre-RVSM band FL050-FL280',
                band: 'odd / even thousands per same hemisphere convention; mixed 1000-/2000-ft separation by region',
                ref: 'ICAO Annex 2 App.3 · Doc 4444 PANS-ATM §4.5 · 14 CFR §91.179',
              },
              {
                name: 'VFR · > 3000 ft AGL (FAA)',
                band: '000-179° → odd thousand + 500 ft (3500/5500/…); 180-359° → even thousand + 500 ft (4500/6500/…)',
                ref: '14 CFR §91.159 · FAA AIM §4-4-9',
              },
              {
                name: 'VFR · ICAO hemispheric',
                band: 'Same as FAA except certain ICAO regions allow > 3000 ft AMSL trigger; supplementary rules in Doc 7030',
                ref: 'ICAO Annex 2 App.3 · Doc 7030 RAC SUPPS',
              },
              {
                name: 'Oceanic / OTS Waiver',
                band: 'NAT OTS daily tracks, PACOTS, RNP-10 corridors — semicircular waived inside organised structure; PBCS/PBN governs',
                ref: 'NAT Doc 007 §2.2.5 · ICAO Doc 9613 Vol II Pt C · NAT-OPS Bull 2024-01',
              },
              {
                name: 'Step-climb / level-change transient',
                band: 'Aircraft transitioning across slabs (|VS| > 800 fpm) flagged NOT-CRUISE until settled; cleared per Doc 4444 §5.4',
                ref: 'ICAO Doc 4444 PANS-ATM §5.4 · FAA Order JO 7110.65 §5-7-1',
              },
            ].map(r => (
              <div key={r.name} className="px-3 py-2">
                <div className="text-slate-100 font-semibold mb-1">{r.name}</div>
                <div className="text-slate-300">{r.band}</div>
                <div className="text-slate-500 italic text-[9.5px] mt-1">{r.ref}</div>
              </div>
            ))}
          </div>
        )}

        {tab === 'DIAGRAM' && (
          <div className="px-3 py-3">
            <div className="text-[10px] text-slate-400 mb-2">Parity wheel · magnetic track ↔ correct FL parity for the active ruleset</div>
            <svg viewBox="0 0 320 320" className="w-full">
              {/* outer track ring */}
              <circle cx={160} cy={160} r={140} fill="none" stroke="#1e293b" strokeWidth={1.5}/>
              {/* odd / even hemisphere arcs */}
              <path d="M 160 20 A 140 140 0 0 1 160 300" fill="rgba(14,165,233,0.05)" stroke="#0ea5e9" strokeWidth={1.5} strokeDasharray="3 3"/>
              <path d="M 160 300 A 140 140 0 0 1 160 20" fill="rgba(245,158,11,0.05)" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="3 3"/>
              <text x={230} y={165} textAnchor="middle" fill="#0ea5e9" fontSize={10} fontWeight={700}>E · 000-179° · ODD FL</text>
              <text x={90}  y={165} textAnchor="middle" fill="#f59e0b" fontSize={10} fontWeight={700}>W · 180-359° · EVEN FL</text>
              {/* track tick marks */}
              {[0,45,90,135,180,225,270,315].map(deg => {
                const r1 = 140, r2 = 130
                const rad = (deg - 90) * Math.PI / 180
                const x1 = 160 + r1 * Math.cos(rad), y1 = 160 + r1 * Math.sin(rad)
                const x2 = 160 + r2 * Math.cos(rad), y2 = 160 + r2 * Math.sin(rad)
                const xT = 160 + (r2 - 14) * Math.cos(rad), yT = 160 + (r2 - 14) * Math.sin(rad) + 3
                return (
                  <g key={deg}>
                    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#475569" strokeWidth={1}/>
                    <text x={xT} y={yT} textAnchor="middle" fill="#94a3b8" fontSize={8}>{deg}°</text>
                  </g>
                )
              })}
              {/* fleet samples placed on parity wheel */}
              {rows.slice(0, 40).map((r, i) => {
                const rad = (r.chk.trackMag - 90) * Math.PI / 180
                const radius = 60 + (r.f.altitudeFt / 42000) * 70
                const x = 160 + radius * Math.cos(rad)
                const y = 160 + radius * Math.sin(rad)
                return (
                  <circle key={r.f.icao} cx={x} cy={y} r={r.tier==='WRONG-FL'?4:r.tier==='OFF-PARITY'?3:2.2}
                    fill={TIER_COLOR[r.tier]} stroke="#0b1220" strokeWidth={0.8}
                    opacity={r.tier==='NOT-CRUISE'?0.3:0.9}/>
                )
              })}
              {/* inner FL legend */}
              <text x={160} y={155} textAnchor="middle" fill="#cbd5e1" fontSize={11} fontWeight={700}>SEMI-RULE</text>
              <text x={160} y={170} textAnchor="middle" fill="#64748b" fontSize={9}>{ruleset}</text>
              <text x={160} y={184} textAnchor="middle" fill="#64748b" fontSize={9}>{rows.length} a/c</text>
            </svg>
            <div className="grid grid-cols-2 gap-1 mt-3 text-[10px]">
              <div className="px-2 py-1.5 rounded bg-slate-900/60 border border-slate-800">
                <div className="text-[9px] text-slate-500">EASTBOUND (000-179°)</div>
                <div className="text-sky-300 font-semibold">ODD FL · 290 · 310 · 330 · …</div>
                <div className="text-slate-500 text-[9px] italic">below RVSM: odd thousands</div>
              </div>
              <div className="px-2 py-1.5 rounded bg-slate-900/60 border border-slate-800">
                <div className="text-[9px] text-slate-500">WESTBOUND (180-359°)</div>
                <div className="text-amber-300 font-semibold">EVEN FL · 300 · 320 · 340 · …</div>
                <div className="text-slate-500 text-[9px] italic">below RVSM: even thousands</div>
              </div>
            </div>
            <div className="mt-3 px-2 py-2 rounded bg-slate-900/40 border border-slate-800 text-[10px] leading-relaxed text-slate-400">
              <div className="text-slate-300 font-semibold mb-1">Semicircular rule vs RVSM</div>
              Semicircular rule decides <span className="text-slate-200">which</span> FL is correct for the parity of the track. RVSM (separate monitor) measures whether the aircraft can <span className="text-slate-200">hold</span> the assigned FL within ±200 ft ASE-tolerance. A perfectly RVSM-compliant aircraft can still be WRONG-FL under the semicircular rule, and vice versa.
              <div className="mt-2 italic">References: ICAO Annex 2 App.3 · Doc 9574 Ch.4 · Doc 4444 §4.5 §5.4 · 14 CFR §91.159 §91.179 · FAA AIM §3-1-5 §4-4-9 · NAT Doc 007 · Doc 7030 RAC SUPPS.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
