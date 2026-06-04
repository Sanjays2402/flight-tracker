'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   GUST · Vertical-Gust Loading & Turbulence-Penetration Speed
            (V_RA / V_B) Margin Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of the design vertical-gust load
   factor Δn induced on each airborne aircraft at its current
   speed/altitude/weight given a discrete (1-cosine) tuned-gust
   per 14 CFR §25.341(a) / EASA CS-25.341(a), and the resulting
   excess margin against V_RA (rough-air penetration speed) and
   V_B (design speed for max gust intensity) per §25.335(d).

   This is structurally distinct from:
     · VMO/MMO envelope (red-line speed compliance)
     · Flutter margin (aeroelastic eigen-mode)
     · Turbulence-EDR map (atmospheric energy dissipation rate)
   GUST measures STRUCTURAL response Δn vs aircraft mass+speed
   under the certified discrete-gust load case.

   Δn equation (Pratt-Walker discrete gust, 14 CFR §25.341(a)):
       Δn = (K_g · ρ_0 · V_e · U_de · a · S) / (2 · W)
   where
       K_g  = 0.88 μ_g / (5.3 + μ_g)         (gust alleviation)
       μ_g  = 2(W/S) / (ρ · c̄ · a · g)        (mass parameter)
       U_de = design gust velocity m/s EAS
              · 17.07 m/s @ SL → linearly to
              · 13.41 m/s @ FL150 → 6.36 m/s @ FL500
              per §25.341(a)(5) reference Table
       a    = wing CL_α slope ~ 2π·AR / (2+√(AR²+4))  (rad⁻¹)
       S, c̄ = wing area, mean aerodynamic chord
       V_e  = equivalent airspeed (= TAS · √σ)
   Reference: Pratt-Walker NACA TN-2964, Hoblit "Gust Loads on
   Aircraft" AIAA 1988 Ch.4-5, Lomax "Theoretical Aerodynamics"
   §6.4, Roskam Pt VI §3.

   V_RA model per §25.335(d) / FCOM CRZ-TURB:
       V_RA = min( V_B + 25 kt , 0.9 · V_MO , M_RA(h) )
   class catalogue carries V_RA_KIAS and M_RA per
   Boeing FCOM PI-5 / Airbus FCOM PRO-NOR-SOP-32-TURB / B777
   FCT 4.30 / B737 FCT 8.4 / A320 FCOM PRO-NOR-SUP-7.
   ------------------------------------------------------------
   Six drivers (max-driver composite):
     · DNLOAD   |Δn| vs design limit 2.5g — ramp 0→2.0
     · VSPEED   IAS over V_RA — ramp 0→+60 KIAS
     · GUSTHI   atmospheric gust band (jet/MCS/wave proxy)
     · MASSLO   light-weight amplifier (high Δn per gust)
     · ALTLO    low-alt high-density-air penalty (FL<200)
     · MARGIN   V_MO/M_MO crosshair (excess inversely scored)
   Composite max·0.66 + mean·0.34 × ADV-MUL.

   Six tiers:
     · LIMIT   ≥85 rose       |Δn|>1.5g OR IAS>V_RA+30 kt
                              ► REDUCE to V_RA / declare TURB
                              per §25.341(c) / FCOM CRZ-TURB
     · STRESS  ≥65 rose-pink  |Δn| 1.0-1.5g · brief crew
     · MOD     ≥40 amber      0.6-1.0g · slow toward V_RA
     · LIGHT   ≥18 sky        0.3-0.6g · monitor PIREPs
     · NIL     <18  emerald   <0.3g · normal cruise
     · OFF     slate          on-ground or below FL050
   Hard escalators per 14 CFR §25.337 limit load:
     · |Δn|+1 > 2.5g  ⇒ score-min 92 (limit-load bust)
     · IAS > V_RA+40  ⇒ score-min 82 (CS-25.335(d) breach)
     · IAS > V_MO     ⇒ score-min 96
   ------------------------------------------------------------
   References:
     · 14 CFR §25.341 discrete & continuous turbulence loads
     · 14 CFR §25.335(d) rough-air / V_B / V_RA
     · 14 CFR §25.337 limit-load factor envelope
     · 14 CFR §25.305(d) deformations / strength
     · EASA CS-25.341 / AMC 25.341 continuous turbulence PSD
     · FAA AC 25-7D §32 gust load test
     · AC 120-88A turbulence avoidance
     · ICAO Annex 3 §3.4 / Doc 4444 §4.12 turb reporting
     · ICAO Doc 8168 Vol I Pt VI Ch.3 turbulence
     · Boeing FCOM PI-5 / FCT 4.30 / 8.4 turbulent-air pen.
     · Airbus FCOM PRO-NOR-SOP-32 / PRO-ABN-MISC turbulence
     · Pratt-Walker NACA TN-2964 (1954) discrete gust K_g
     · Hoblit "Gust Loads on Aircraft" AIAA 1988
     · Roskam Airplane Design Pt VI §3 gust env
     · NTSB AAR-97-06 USAir 1455 turb upset
     · NTSB AAR-09-01 NWA 85 turb encounter
============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'LIMIT' | 'STRESS' | 'MOD' | 'LIGHT' | 'NIL' | 'OFF'
const TIER_COLOR: Record<Tier, string> = {
  LIMIT:'#ef4444', STRESS:'#f43f5e', MOD:'#f59e0b',
  LIGHT:'#0ea5e9', NIL:'#10b981', OFF:'#475569',
}
const TIER_ORDER: Tier[] = ['LIMIT','STRESS','MOD','LIGHT','NIL','OFF']
const TIER_RANK: Record<Tier, number> = { LIMIT:0, STRESS:1, MOD:2, LIGHT:3, NIL:4, OFF:5 }
const TIER_LABEL: Record<Tier,string> = {
  LIMIT:'LIMIT-LOAD', STRESS:'STRESS', MOD:'MODERATE', LIGHT:'LIGHT', NIL:'NIL', OFF:'OFF',
}

type Klass = 'HVY' | 'WB-M' | 'NB' | 'RGN-J' | 'RGN-T' | 'BIZ' | 'LIGHT'
const KLASS_COLOR: Record<Klass, string> = {
  HVY:'#a855f7', 'WB-M':'#8b5cf6', NB:'#10b981',
  'RGN-J':'#f59e0b', 'RGN-T':'#eab308', BIZ:'#ec4899', LIGHT:'#22d3ee',
}
const KLASS_LIST: Klass[] = ['HVY','WB-M','NB','RGN-J','RGN-T','BIZ','LIGHT']

/* per-class structural parameters compiled from Boeing 737/747/
   777/787 Airport Planning Documents §3, Airbus ACAP §3.5,
   ICAO Doc 8643 Aircraft Type Designators ed.52 and BADA 3.15
   OPF/APF coefficient sets.
     · MTOW kg
     · OEW  kg          (zero-fuel baseline)
     · S    m² (wing area)
     · cbar m  (mean aerodynamic chord)
     · AR   wing aspect ratio
     · VMO  KIAS  max operating IAS
     · MMO  Mach  max operating Mach
     · VRA  KIAS  rough-air penetration
     · MRA  Mach  rough-air Mach
*/
interface KParam { mtow:number; oew:number; S:number; cbar:number; AR:number; VMO:number; MMO:number; VRA:number; MRA:number }
const KP: Record<Klass, KParam> = {
  HVY:    { mtow:351000, oew:175000, S:436.8, cbar:7.79, AR:9.0,  VMO:350, MMO:0.89, VRA:290, MRA:0.82 },
  'WB-M': { mtow:242000, oew:120000, S:361.6, cbar:7.27, AR:9.3,  VMO:340, MMO:0.86, VRA:280, MRA:0.80 },
  NB:     { mtow: 79000, oew: 42500, S:124.6, cbar:4.17, AR:9.5,  VMO:340, MMO:0.82, VRA:280, MRA:0.78 },
  'RGN-J':{ mtow: 51800, oew: 28000, S: 92.5, cbar:3.30, AR:9.4,  VMO:320, MMO:0.82, VRA:270, MRA:0.76 },
  'RGN-T':{ mtow: 23000, oew: 12950, S: 61.0, cbar:2.30, AR:12.0, VMO:250, MMO:0.55, VRA:200, MRA:0.50 },
  BIZ:    { mtow: 45000, oew: 23500, S: 94.0, cbar:3.50, AR:7.7,  VMO:340, MMO:0.85, VRA:270, MRA:0.78 },
  LIGHT:  { mtow:  2400, oew:  1450, S: 16.2, cbar:1.50, AR:7.4,  VMO:170, MMO:0.30, VRA:135, MRA:0.28 },
}

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
function ramp(x:number, lo:number, hi:number) { return clamp((x-lo)/(hi-lo), 0, 1) * 100 }
function hash(s:string){ let h=0; for (let i=0;i<s.length;i++) h=((h<<5)-h+s.charCodeAt(i))|0; return Math.abs(h) }

/* ISA atmosphere (troposphere only, sufficient up to FL360) — rho ratio σ */
function sigmaISA(altFt:number) {
  const h_m = altFt * 0.3048
  // up to 11000 m: T = 288.15 - 0.0065 h ; ρ = ρ0 (T/T0)^4.2561
  if (h_m <= 11000) {
    const T = 288.15 - 0.0065 * h_m
    return Math.pow(T / 288.15, 4.2561)
  }
  // stratosphere: ρ11 ratio · exp(-(h-11000)/6341.6)
  const ratio11 = Math.pow((288.15 - 0.0065 * 11000) / 288.15, 4.2561)
  return ratio11 * Math.exp(-(h_m - 11000) / 6341.6)
}
const RHO0 = 1.225   /* kg/m³ */
const G    = 9.80665

/* design gust velocity U_de m/s EAS per §25.341(a)(5) table */
function U_de(altFt:number) {
  if (altFt <= 0) return 17.07
  if (altFt >= 50000) return 6.36
  if (altFt <= 15000) return 17.07 + (13.41 - 17.07) * (altFt / 15000)
  return 13.41 + (6.36 - 13.41) * ((altFt - 15000) / 35000)
}

/* CL_α via lifting-line for finite AR (rad⁻¹) */
function cLa(AR:number) {
  return 2 * Math.PI * AR / (2 + Math.sqrt(AR*AR + 4))
}

/* Pratt-Walker K_g and μ_g */
function Kg(W_N:number, S:number, cbar:number, rho:number, a:number) {
  // μ_g = 2(W/S) / (ρ · g · c̄ · a)  (W in N, ρ in kg/m³, a in rad⁻¹)
  const WS = W_N / S
  const mu = 2 * WS / (rho * G * cbar * a)
  return { mu, Kg: 0.88 * mu / (5.3 + mu) }
}

/* atmospheric-gust band proxy — jet stream, mid-lat convective, ITCZ MCS,
   mountain-wave bands. Returns scalar 0-1.6 multiplier on U_de. */
function gustBand(lat:number, lng:number, altFt:number, vs:number) {
  const aLat = Math.abs(lat)
  let m = 1.0
  /* jet stream corridor 28-52° both hemispheres at FL280-FL410 */
  if (aLat >= 28 && aLat <= 52 && altFt >= 28000 && altFt <= 41000) m *= 1.25
  /* ITCZ ±12° */
  if (aLat <= 12) m *= 1.15
  /* mid-lat MCS / convective corridor 30-45° at FL250-380 over US continental + EU */
  if (aLat >= 30 && aLat <= 45 && altFt >= 25000 && altFt <= 38000) {
    if ((lng > -125 && lng < -65) || (lng > -10 && lng < 30)) m *= 1.12
  }
  /* mountain-wave proxy: Rockies / Andes / Alps lon-bands, FL150-FL340 */
  if (altFt >= 15000 && altFt <= 34000) {
    if ((lng > -120 && lng < -100 && lat > 30 && lat < 55) ||  // Rockies
        (lng > -75 && lng < -65 && lat < -15 && lat > -45) ||  // Andes
        (lng > 5 && lng < 15 && lat > 44 && lat < 48)) {       // Alps
      m *= 1.18
    }
  }
  /* current encounter signature: rapid VS swing indicates active turbulence */
  m *= 1 + Math.min(0.25, Math.abs(vs) / 4000)
  return clamp(m, 0.8, 1.6)
}

interface Phys {
  W_kg: number      /* current estimated weight */
  rho: number
  sigma: number
  V_eas: number     /* m/s EAS */
  V_kt_ias: number  /* KIAS (~KEAS for low Mach band; we treat as EAS here) */
  Ude_eff: number
  dn: number        /* Δn in g */
  vra: number       /* effective V_RA in KIAS  */
  vmo: number
  mu: number
  kg: number
  vraExcess: number /* KIAS over V_RA, signed */
  vmoExcess: number
  bandMul: number
}

function computePhys(f: SFlight, kp: KParam): Phys {
  /* weight model: OEW + deterministic 30-100 % of (MTOW-OEW) per icao24 hash */
  const wf = 0.30 + (hash(f.icao) % 700) / 1000   // 0.30 - 0.99
  const W_kg = kp.oew + wf * (kp.mtow - kp.oew)
  const W_N = W_kg * G
  const sigma = sigmaISA(f.altitudeFt)
  const rho = RHO0 * sigma
  /* convert ADS-B groundspeed (kt) to TAS m/s — at cruise GS ≈ TAS w/o wind;
     then V_eas = TAS · √σ */
  const TAS_ms = f.velocityKts * 0.5144
  const V_eas = TAS_ms * Math.sqrt(sigma)
  const V_kt_ias = V_eas / 0.5144
  const a = cLa(kp.AR)
  const { mu, Kg: kg } = Kg(W_N, kp.S, kp.cbar, rho, a)
  const Ude0 = U_de(f.altitudeFt)
  const bandMul = gustBand(f.lat, f.lng, f.altitudeFt, f.vertRate)
  const Ude_eff = Ude0 * bandMul
  /* Δn in g, per Pratt-Walker §25.341(a) */
  const dn = (kg * RHO0 * V_eas * Ude_eff * a * kp.S) / (2 * W_N)
  /* V_RA effective: min(VRA_class, 0.9·VMO, MRA·a_local in KIAS)
     a_local = √(γ R T_local) ≈ √(401.87 T) m/s ; KIAS = M·a·√σ / 0.5144 */
  const T_local = Math.max(216.65, 288.15 - 0.0065 * f.altitudeFt * 0.3048)
  const a_local_ms = Math.sqrt(1.4 * 287.05 * T_local)
  const mraKt = kp.MRA * a_local_ms * Math.sqrt(sigma) / 0.5144
  const vra = Math.min(kp.VRA, 0.9 * kp.VMO, mraKt)
  const vmo = Math.min(kp.VMO, kp.MMO * a_local_ms * Math.sqrt(sigma) / 0.5144)
  return {
    W_kg, rho, sigma, V_eas, V_kt_ias, Ude_eff,
    dn, vra, vmo, mu, kg,
    vraExcess: V_kt_ias - vra,
    vmoExcess: V_kt_ias - vmo,
    bandMul,
  }
}

interface Drivers { DNLOAD:number; VSPEED:number; GUSTHI:number; MASSLO:number; ALTLO:number; MARGIN:number }
function score(f: SFlight, kp: KParam, p: Phys, advMul:number) {
  const dn_abs = Math.abs(p.dn)
  const wf = (p.W_kg - kp.oew) / (kp.mtow - kp.oew)
  const drivers: Drivers = {
    DNLOAD: ramp(dn_abs, 0, 2.0),
    VSPEED: ramp(p.vraExcess, 0, 60),
    GUSTHI: ramp(p.bandMul, 1.0, 1.6),
    MASSLO: ramp(1 - wf, 0.0, 0.7),  /* lighter = more responsive */
    ALTLO:  f.altitudeFt < 20000 ? ramp(20000 - f.altitudeFt, 0, 15000) * 0.7 : 0,
    MARGIN: ramp(-p.vmoExcess, -40, 40) === 0 ? 100 : (p.vmoExcess > 0 ? 95 : ramp(20 - (p.vmo - p.V_kt_ias), 0, 30) * 0.6),
  }
  const ds = [drivers.DNLOAD, drivers.VSPEED, drivers.GUSTHI, drivers.MASSLO, drivers.ALTLO, drivers.MARGIN]
  const maxD = Math.max(...ds)
  const meanD = ds.reduce((a,b)=>a+b,0) / ds.length
  let composite = (maxD * 0.66 + meanD * 0.34) * (advMul / 100)
  /* hard escalators per §25.337 / §25.335(d) */
  if (1 + dn_abs > 2.5) composite = Math.max(composite, 92)
  if (p.vraExcess > 40) composite = Math.max(composite, 82)
  if (p.vmoExcess > 0)  composite = Math.max(composite, 96)
  composite = clamp(composite, 0, 100)
  let tier: Tier
  if (composite >= 85) tier = 'LIMIT'
  else if (composite >= 65) tier = 'STRESS'
  else if (composite >= 40) tier = 'MOD'
  else if (composite >= 18) tier = 'LIGHT'
  else tier = 'NIL'
  return { drivers, composite, tier }
}

interface Row {
  f: SFlight; kl: Klass; kp: KParam; p: Phys; drivers: Drivers
  score: number; tier: Tier
}

export default function GustVraMargin({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klFilter, setKlFilter] = useState<Record<Klass, boolean>>({
    HVY:true,'WB-M':true,NB:true,'RGN-J':true,'RGN-T':true,BIZ:true,LIGHT:true,
  })
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showCone, setShowCone] = useState(true)
  const [q, setQ] = useState('')
  const [minFL, setMinFL] = useState(50)
  const [maxFL, setMaxFL] = useState(450)
  const [advMul, setAdvMul] = useState(100)
  const [gustMul, setGustMul] = useState(100)
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'PHYSICS'>('AIRCRAFT')
  const [sel, setSel] = useState<Row | null>(null)

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      const fl = f.altitudeFt / 100
      if (fl < minFL || fl > maxFL) continue
      const kl = classifyType(f.type)
      if (!klFilter[kl]) continue
      const kp = KP[kl]
      const p = computePhys(f, kp)
      /* user-tunable gust mul calibration */
      const pAdj: Phys = { ...p, dn: p.dn * (gustMul / 100), bandMul: p.bandMul * (gustMul / 100) }
      const { drivers, composite, tier } = score(f, kp, pAdj, advMul)
      out.push({ f, kl, kp, p: pAdj, drivers, score: composite, tier })
    }
    out.sort((a,b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, minFL, maxFL, klFilter, advMul, gustMul])

  useEffect(() => { if (!sel && rows.length) setSel(rows[0]); else if (sel && !rows.find(r => r.f.icao === sel.f.icao)) setSel(rows[0] || null) }, [rows, sel])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { LIMIT:0,STRESS:0,MOD:0,LIGHT:0,NIL:0,OFF:0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const filtered = useMemo(() => {
    const Q = q.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (!Q) return true
      const f = r.f
      return (f.callsign||'').toUpperCase().includes(Q) ||
             (f.type||'').toUpperCase().includes(Q) ||
             (f.operator||'').toUpperCase().includes(Q) ||
             r.tier.includes(Q)
    })
  }, [rows, tierFilter, q])

  const meanDn = rows.length ? rows.reduce((a,r)=>a+Math.abs(r.p.dn),0)/rows.length : 0
  const worst = rows[0]
  const limitCnt = tierCounts.LIMIT
  const stressCnt = tierCounts.STRESS
  const meanVraEx = rows.length ? rows.reduce((a,r)=>a+r.p.vraExcess,0)/rows.length : 0

  /* MapLibre rendering */
  useEffect(() => {
    if (!map) return
    const SRC='gust-src', HALO='gust-halo', PIN='gust-pin', LBL='gust-lbl'
    const CONE_SRC='gust-cone-src', CONE='gust-cone'
    const acFC = {
      type:'FeatureCollection',
      features: rows.map(r => ({
        type:'Feature' as const,
        geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat] },
        properties:{
          tier: r.tier, color: TIER_COLOR[r.tier],
          haloR: 7 + Math.min(12, r.score / 8),
          pinScale: r.tier==='LIMIT'?1.5 : r.tier==='STRESS'?1.15 : 0,
          lbl: `${r.f.callsign || r.f.icao}  Δn=${r.p.dn>=0?'+':''}${r.p.dn.toFixed(2)}g  ${r.p.vraExcess>0?'+':''}${r.p.vraExcess.toFixed(0)}kt`,
        },
      })),
    }
    /* heading cone: gust-band severity wedge ahead of each LIMIT/STRESS aircraft */
    const NM_DEG = 1/60
    function wedge(lat:number, lng:number, trk:number, lenNM:number, halfDeg:number): [number,number][] {
      const t = trk * Math.PI/180
      const pts: [number,number][] = [[lng, lat]]
      for (let a = -halfDeg; a <= halfDeg; a += halfDeg) {
        const ang = t + a * Math.PI/180
        const dLat = Math.cos(ang) * lenNM * NM_DEG
        const dLng = Math.sin(ang) * lenNM * NM_DEG / Math.max(0.1, Math.cos(lat*Math.PI/180))
        pts.push([lng + dLng, lat + dLat])
      }
      pts.push([lng, lat])
      return pts
    }
    const top = rows.filter(r => r.tier === 'LIMIT' || r.tier === 'STRESS').slice(0, 20)
    const coneFC = {
      type:'FeatureCollection',
      features: top.map(r => ({
        type:'Feature' as const,
        geometry:{ type:'Polygon' as const, coordinates:[wedge(r.f.lat, r.f.lng, r.f.track, 24 * r.p.bandMul, 18)] },
        properties:{ color: TIER_COLOR[r.tier], opacity: r.tier==='LIMIT' ? 0.22 : 0.14 },
      })),
    }
    const add = () => {
      try {
        if (!map.getSource(SRC)) map.addSource(SRC, { type:'geojson', data: acFC as any })
        else (map.getSource(SRC) as any).setData(acFC)
        if (!map.getSource(CONE_SRC)) map.addSource(CONE_SRC, { type:'geojson', data: coneFC as any })
        else (map.getSource(CONE_SRC) as any).setData(coneFC)

        if (showCone && !map.getLayer(CONE)) map.addLayer({ id:CONE, type:'fill', source:CONE_SRC, paint:{
          'fill-color':['get','color'], 'fill-opacity':['get','opacity'],
        }})
        if (showHalo && !map.getLayer(HALO)) map.addLayer({ id: HALO, type:'circle', source: SRC, paint:{
          'circle-radius':['get','haloR'], 'circle-color':['get','color'],
          'circle-opacity':0.13, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85,
        }})
        if (showPin && !map.getLayer(PIN)) map.addLayer({ id: PIN, type:'circle', source: SRC, filter:['>',['get','pinScale'],0], paint:{
          'circle-radius':['*', 5.5, ['get','pinScale']],
          'circle-color':['get','color'], 'circle-stroke-color':'#fff', 'circle-stroke-width':1.3,
        }})
        if (showLbl && !map.getLayer(LBL)) map.addLayer({ id: LBL, type:'symbol', source: SRC, layout:{
          'text-field':['get','lbl'],
          'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top',
          'text-font':['Open Sans Semibold','Arial Unicode MS Bold'],
        }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0b1220', 'text-halo-width':1.2 }})
      } catch {}
    }
    if (map.isStyleLoaded()) add(); else map.once('load', add)
    return () => {
      try {
        for (const l of [LBL, PIN, HALO, CONE]) if (map.getLayer(l)) map.removeLayer(l)
        if (map.getSource(SRC)) map.removeSource(SRC)
        if (map.getSource(CONE_SRC)) map.removeSource(CONE_SRC)
      } catch {}
    }
  }, [map, rows, showHalo, showPin, showLbl, showCone])

  /* per-class aggregation */
  const classAgg = useMemo(() => {
    const m = new Map<Klass, { cnt:number; sumDn:number; sumVraEx:number; limit:number; stress:number }>()
    for (const kl of KLASS_LIST) m.set(kl, { cnt:0, sumDn:0, sumVraEx:0, limit:0, stress:0 })
    for (const r of rows) {
      const x = m.get(r.kl)!
      x.cnt++; x.sumDn += Math.abs(r.p.dn); x.sumVraEx += r.p.vraExcess
      if (r.tier === 'LIMIT') x.limit++
      if (r.tier === 'STRESS') x.stress++
    }
    return KLASS_LIST.map(kl => ({ kl, ...m.get(kl)! })).filter(x => x.cnt > 0)
  }, [rows])

  return (
    <div className="absolute right-3 top-20 z-30 w-[470px] max-h-[80vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">GUST</div>
        <div className="text-[10px] text-slate-400 truncate">Vertical-Gust Δn · V_RA Margin · §25.341</div>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-[12px] px-2 py-0.5 rounded hover:bg-slate-800/60">✕</button>
        </div>
      </div>

      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        {(TIER_ORDER).map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter===t?'ALL':t)}
            className={`px-1 py-1 rounded border ${tierFilter===t?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
            <div className="text-[8px]" style={{color: TIER_COLOR[t]}}>{t}</div>
            <div className="text-slate-100 font-semibold">{tierCounts[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">μ-Δn</div>
          <div className="text-slate-100 font-semibold tabular-nums">{meanDn.toFixed(2)}<span className="text-[8px] text-slate-500"> g</span></div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">WORST</div>
          <div className="text-slate-100 font-semibold truncate text-[10px]">{worst ? worst.f.callsign || worst.f.icao : '—'}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">LIMIT</div>
          <div className="font-semibold tabular-nums" style={{color: limitCnt ? TIER_COLOR.LIMIT : '#cbd5e1'}}>{limitCnt}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">STRESS</div>
          <div className="font-semibold tabular-nums" style={{color: stressCnt ? TIER_COLOR.STRESS : '#cbd5e1'}}>{stressCnt}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">μ-V_RA Δ</div>
          <div className="font-semibold tabular-nums" style={{color: meanVraEx > 0 ? TIER_COLOR.STRESS : '#cbd5e1'}}>{meanVraEx>=0?'+':''}{meanVraEx.toFixed(0)}<span className="text-[8px] text-slate-500"> kt</span></div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800/60 text-[10px]">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          {([
            ['MIN-FL', minFL, setMinFL, 50, 400, '', 5],
            ['MAX-FL', maxFL, setMaxFL, 100, 500, '', 5],
            ['ADV-MUL', advMul, setAdvMul, 50, 200, '%', 1],
            ['GUST-MUL', gustMul, setGustMul, 50, 200, '%', 1],
          ] as Array<[string, number, (n:number)=>void, number, number, string, number]>).map(([lbl,val,set,lo,hi,suf,step]) => (
            <label key={lbl} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-16">{lbl}</span>
              <input type="range" min={lo} max={hi} step={step} value={val}
                onChange={e => set(parseFloat(e.target.value))}
                className="flex-1 h-1 accent-sky-500" />
              <span className="text-slate-300 tabular-nums w-14 text-right">{val}{suf}</span>
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
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],['CONE',showCone,setShowCone]] as const).map(([n,v,s])=>(
          <button key={n} onClick={()=>(s as any)(!v)} className={`px-1.5 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-500 hover:border-slate-700'}`}>{n}</button>
        ))}
      </div>

      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-800/60">
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="callsign / type / operator / tier"
          className="flex-1 bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/40" />
      </div>
      <div className="flex gap-0.5 px-3 py-1.5 border-b border-slate-800/60 text-[10px]">
        {(['AIRCRAFT','CLASSES','PHYSICS'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 text-slate-100 border border-sky-500/40':'text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1 text-[11px]">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500">no airborne aircraft above FL{minFL}</div>}
            {filtered.slice(0, 60).map(r => {
              const advice =
                r.tier === 'LIMIT'  ? `|Δn|=${Math.abs(r.p.dn).toFixed(2)}g · REDUCE to V_RA ${r.p.vra.toFixed(0)} kt · declare turbulence per §25.341(c) / FCOM CRZ-TURB` :
                r.tier === 'STRESS' ? `|Δn|=${Math.abs(r.p.dn).toFixed(2)}g · brief crew · slow to V_RA ${r.p.vra.toFixed(0)} kt · §25.335(d)` :
                r.tier === 'MOD'    ? `moderate gust loading · monitor PIREPs per AC 120-88A · V_RA ${r.p.vra.toFixed(0)} kt` :
                r.tier === 'LIGHT'  ? `light gust band · standard CRZ envelope · V_RA ${r.p.vra.toFixed(0)} kt margin +${(-r.p.vraExcess).toFixed(0)} kt` :
                                       `nominal · Δn negligible · V_RA margin +${(-r.p.vraExcess).toFixed(0)} kt`
              return (
                <div key={r.f.icao} onClick={()=>{ setSel(r); onFly(r.f.icao) }}
                  className="px-3 py-2 hover:bg-slate-900/50 cursor-pointer" style={{borderLeft:`2px solid ${TIER_COLOR[r.tier]}`}}>
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-slate-100 text-[11.5px]">{r.f.callsign || r.f.icao}</span>
                    <span className="text-[9px] text-slate-500">{r.f.type || '—'}</span>
                    <span className="text-[8.5px] px-1 rounded border" style={{color: KLASS_COLOR[r.kl], borderColor: KLASS_COLOR[r.kl]+'66'}}>{r.kl}</span>
                    <span className="text-[8.5px] px-1 rounded ml-auto font-semibold" style={{color: TIER_COLOR[r.tier], background: TIER_COLOR[r.tier]+'14', border:`1px solid ${TIER_COLOR[r.tier]}55`}}>{TIER_LABEL[r.tier]}</span>
                  </div>
                  <div className="grid grid-cols-5 gap-1 mt-1 text-[9.5px] tabular-nums">
                    <div><span className="text-slate-500">FL </span><span className="text-slate-200">{(r.f.altitudeFt/100).toFixed(0)}</span></div>
                    <div><span className="text-slate-500">IAS </span><span className="text-slate-200">{r.p.V_kt_ias.toFixed(0)}</span></div>
                    <div><span className="text-slate-500">V_RA </span><span className="text-slate-200">{r.p.vra.toFixed(0)}</span></div>
                    <div><span className="text-slate-500">Δ </span><span style={{color: r.p.vraExcess>0?TIER_COLOR.STRESS:'#cbd5e1'}}>{r.p.vraExcess>=0?'+':''}{r.p.vraExcess.toFixed(0)}</span></div>
                    <div><span className="text-slate-500">U_de </span><span className="text-slate-200">{r.p.Ude_eff.toFixed(1)}</span></div>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-0.5 text-[9.5px] tabular-nums">
                    <div><span className="text-slate-500">Δn </span><span style={{color: Math.abs(r.p.dn)>1?TIER_COLOR.STRESS:'#cbd5e1'}}>{r.p.dn>=0?'+':''}{r.p.dn.toFixed(2)}g</span></div>
                    <div><span className="text-slate-500">W </span><span className="text-slate-200">{(r.p.W_kg/1000).toFixed(0)}t</span></div>
                    <div><span className="text-slate-500">K_g </span><span className="text-slate-200">{r.p.kg.toFixed(2)}</span></div>
                    <div><span className="text-slate-500">μ_g </span><span className="text-slate-200">{r.p.mu.toFixed(1)}</span></div>
                  </div>
                  <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden">
                    <div className="h-full" style={{width: `${r.score}%`, background: TIER_COLOR[r.tier]}} />
                  </div>
                  <div className="grid grid-cols-6 gap-0.5 mt-1 text-[8.5px]">
                    {(['DNLOAD','VSPEED','GUSTHI','MASSLO','ALTLO','MARGIN'] as const).map(d => (
                      <div key={d} className="px-1 py-0.5 rounded border border-slate-800 text-center tabular-nums"
                        style={{background:`${TIER_COLOR[r.tier]}0d`, color: r.drivers[d]>=60?TIER_COLOR[r.tier]:'#94a3b8'}}>
                        <div className="text-[7.5px] opacity-70">{d}</div>
                        <div>{r.drivers[d].toFixed(0)}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-1 text-[9px]" style={{color: TIER_COLOR[r.tier]}}>{advice}</div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'CLASSES' && (
          <div className="divide-y divide-slate-800/60">
            {classAgg.length === 0 && <div className="px-3 py-6 text-center text-slate-500">no in-scope aircraft</div>}
            {classAgg.map(c => {
              const muDn = c.sumDn / c.cnt
              const muVra = c.sumVraEx / c.cnt
              const kp = KP[c.kl]
              return (
                <div key={c.kl} className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] px-1.5 py-0.5 rounded border font-semibold" style={{color: KLASS_COLOR[c.kl], borderColor: KLASS_COLOR[c.kl]+'66'}}>{c.kl}</span>
                    <span className="text-slate-300 text-[10px]">{c.cnt} ac</span>
                    <span className="ml-auto text-[9px] text-slate-500">V_MO {kp.VMO} · M_MO {kp.MMO} · V_RA {kp.VRA}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-1 text-[9.5px] tabular-nums">
                    <div><span className="text-slate-500">μ-Δn </span><span className="text-slate-200">{muDn.toFixed(2)}g</span></div>
                    <div><span className="text-slate-500">μ-Δ V_RA </span><span style={{color: muVra>0?TIER_COLOR.STRESS:'#cbd5e1'}}>{muVra>=0?'+':''}{muVra.toFixed(0)}kt</span></div>
                    <div><span className="text-slate-500">LIMIT </span><span style={{color: c.limit?TIER_COLOR.LIMIT:'#cbd5e1'}}>{c.limit}</span></div>
                    <div><span className="text-slate-500">STRESS </span><span style={{color: c.stress?TIER_COLOR.STRESS:'#cbd5e1'}}>{c.stress}</span></div>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-0.5 text-[9px] tabular-nums text-slate-500">
                    <div>S {kp.S.toFixed(0)}m²</div>
                    <div>c̄ {kp.cbar.toFixed(2)}m</div>
                    <div>AR {kp.AR.toFixed(1)}</div>
                    <div>MTOW {(kp.mtow/1000).toFixed(0)}t</div>
                  </div>
                  <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden">
                    <div className="h-full" style={{width: `${Math.min(100, muDn*60)}%`, background: KLASS_COLOR[c.kl]}} />
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'PHYSICS' && (
          <div className="px-3 py-3 text-[10px] space-y-3">
            <div className="rounded border border-slate-800 bg-slate-900/40 p-2">
              <div className="text-[9px] text-sky-300/80 tracking-[0.15em] uppercase font-semibold mb-1">Pratt-Walker discrete gust</div>
              <div className="font-mono text-[10.5px] text-slate-200">
                Δn = (K_g · ρ₀ · V_e · U_de · a · S) / (2 · W)
              </div>
              <div className="font-mono text-[9.5px] text-slate-400 mt-0.5">
                K_g = 0.88 μ_g / (5.3 + μ_g)
              </div>
              <div className="font-mono text-[9.5px] text-slate-400">
                μ_g = 2(W/S) / (ρ · g · c̄ · a)
              </div>
              <div className="font-mono text-[9.5px] text-slate-400">
                a   = 2π·AR / (2 + √(AR² + 4))     (CL_α, rad⁻¹)
              </div>
            </div>

            {sel && (() => {
              /* SVG: V-n diagram for selected aircraft */
              const r = sel
              const kp = r.kp
              const W = 380, H = 200, PL = 32, PR = 14, PT = 16, PB = 28
              const vMax = Math.max(kp.VMO + 60, r.p.V_kt_ias + 40)
              const x = (v:number) => PL + (v / vMax) * (W - PL - PR)
              const y = (n:number) => PT + ((4 - n) / 8) * (H - PT - PB)   // n from -4 to +4
              const limit_pos = 2.5, limit_neg = -1.0
              /* gust envelope upper/lower at varying Ude (cruise gust 17.07 m/s at SL) */
              const Ude0 = U_de(r.f.altitudeFt)
              const a_la = cLa(kp.AR)
              const sigma = r.p.sigma
              const W_N = r.p.W_kg * G
              function dnAtV(v_kt:number, U:number) {
                const V_eas = v_kt * 0.5144
                const { Kg: kg } = Kg(W_N, kp.S, kp.cbar, RHO0 * sigma, a_la)
                return (kg * RHO0 * V_eas * U * a_la * kp.S) / (2 * W_N)
              }
              const gustUp: string[] = []
              const gustDn: string[] = []
              for (let v=0; v<=vMax; v+=15) {
                const dn = dnAtV(v, Ude0)
                gustUp.push(`${v===0?'M':'L'}${x(v).toFixed(1)},${y(1+dn).toFixed(1)}`)
                gustDn.push(`${v===0?'M':'L'}${x(v).toFixed(1)},${y(1-dn).toFixed(1)}`)
              }
              return (
                <div className="rounded border border-slate-800 bg-slate-900/40 p-2">
                  <div className="text-[9px] text-sky-300/80 tracking-[0.15em] uppercase font-semibold mb-1">V-n GUST ENV · {r.f.callsign || r.f.icao} · {r.kl}</div>
                  <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-44">
                    {/* grid */}
                    <line x1={PL} y1={y(0)} x2={W-PR} y2={y(0)} stroke="#334155" strokeWidth={0.5}/>
                    <line x1={PL} y1={y(1)} x2={W-PR} y2={y(1)} stroke="#475569" strokeDasharray="2 3" strokeWidth={0.5}/>
                    <line x1={PL} y1={y(limit_pos)} x2={W-PR} y2={y(limit_pos)} stroke={TIER_COLOR.LIMIT} strokeDasharray="3 3" strokeWidth={0.7}/>
                    <line x1={PL} y1={y(limit_neg)} x2={W-PR} y2={y(limit_neg)} stroke={TIER_COLOR.LIMIT} strokeDasharray="3 3" strokeWidth={0.7}/>
                    {/* V_RA / V_MO */}
                    <line x1={x(r.p.vra)} y1={PT} x2={x(r.p.vra)} y2={H-PB} stroke={TIER_COLOR.LIGHT} strokeDasharray="3 2" strokeWidth={0.7}/>
                    <line x1={x(r.p.vmo)} y1={PT} x2={x(r.p.vmo)} y2={H-PB} stroke={TIER_COLOR.STRESS} strokeDasharray="3 2" strokeWidth={0.7}/>
                    {/* gust envelopes */}
                    <path d={gustUp.join(' ')} stroke={TIER_COLOR.MOD} strokeWidth={1.2} fill="none"/>
                    <path d={gustDn.join(' ')} stroke={TIER_COLOR.MOD} strokeWidth={1.2} fill="none"/>
                    {/* current state */}
                    <circle cx={x(r.p.V_kt_ias)} cy={y(1+r.p.dn)} r={4.5} fill={TIER_COLOR[r.tier]} stroke="#fff" strokeWidth={1.2}/>
                    {/* axes labels */}
                    {[0, kp.VRA, kp.VMO].map(v => (
                      <text key={v} x={x(v)} y={H-PB+10} fontSize={8} fill="#94a3b8" textAnchor="middle">{v.toFixed(0)}</text>
                    ))}
                    <text x={x(r.p.vra)} y={PT+8} fontSize={8} fill={TIER_COLOR.LIGHT} textAnchor="middle">V_RA</text>
                    <text x={x(r.p.vmo)} y={PT+8} fontSize={8} fill={TIER_COLOR.STRESS} textAnchor="middle">V_MO</text>
                    <text x={W-PR} y={y(limit_pos)-2} fontSize={7.5} fill={TIER_COLOR.LIMIT} textAnchor="end">+2.5g §25.337</text>
                    <text x={W-PR} y={y(limit_neg)+9} fontSize={7.5} fill={TIER_COLOR.LIMIT} textAnchor="end">−1.0g</text>
                    <text x={PL-4} y={y(0)+3} fontSize={8} fill="#94a3b8" textAnchor="end">0</text>
                    <text x={PL-4} y={y(1)+3} fontSize={8} fill="#94a3b8" textAnchor="end">1g</text>
                    <text x={PL-4} y={y(limit_pos)+3} fontSize={8} fill="#94a3b8" textAnchor="end">2.5</text>
                    <text x={W/2} y={H-4} fontSize={8.5} fill="#cbd5e1" textAnchor="middle">KIAS</text>
                  </svg>
                  <div className="grid grid-cols-4 gap-1 mt-1 text-[9px] tabular-nums">
                    <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800"><div className="text-[8px] text-slate-500">U_de eff</div><div className="text-slate-200">{r.p.Ude_eff.toFixed(2)} m/s</div></div>
                    <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800"><div className="text-[8px] text-slate-500">band×</div><div className="text-slate-200">{(r.p.bandMul).toFixed(2)}</div></div>
                    <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800"><div className="text-[8px] text-slate-500">σ</div><div className="text-slate-200">{r.p.sigma.toFixed(3)}</div></div>
                    <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800"><div className="text-[8px] text-slate-500">W</div><div className="text-slate-200">{(r.p.W_kg/1000).toFixed(0)} t</div></div>
                  </div>
                </div>
              )
            })()}

            <div className="rounded border border-slate-800 bg-slate-900/40 p-2 text-[9.5px] text-slate-400 leading-relaxed">
              <div className="text-[9px] text-sky-300/80 tracking-[0.15em] uppercase font-semibold mb-1">Caveats</div>
              · TAS approximated from ADS-B GS (no wind correction)<br/>
              · Weight estimated from deterministic icao24 hash 30-99 % of OEW→MTOW envelope<br/>
              · U_de scaled by atmospheric-band proxy (jet/ITCZ/MCS/wave); calibrate with GUST-MUL<br/>
              · K_g per Pratt-Walker NACA TN-2964 (1954) — replaced for CS-25 by continuous-PSD<br/>
              · Δn here is incremental — total load factor n = 1 + Δn; LIMIT compares 1+|Δn| to 2.5g
            </div>

            <div className="rounded border border-slate-800 bg-slate-900/40 p-2 text-[9px] text-slate-500 leading-relaxed">
              <div className="text-[9px] text-sky-300/80 tracking-[0.15em] uppercase font-semibold mb-1">References</div>
              14 CFR §25.341 / §25.335(d) / §25.337 · EASA CS-25.341 / AMC 25.341 · FAA AC 25-7D §32 · AC 120-88A · ICAO Annex 3 §3.4 · Doc 4444 §4.12 · Doc 8168 Vol I Pt VI · Boeing FCOM PI-5 / FCT 4.30 / 8.4 · Airbus FCOM PRO-NOR-SOP-32 · Pratt-Walker NACA TN-2964 (1954) · Hoblit "Gust Loads on Aircraft" AIAA 1988 · Roskam Pt VI §3 · NTSB AAR-97-06 · AAR-09-01
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
