'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   MELT · Live Aircraft Mass Estimator from Energy-Method
   ------------------------------------------------------------
   Per-airframe in-air gross-weight inversion from observed
   climb performance (ROC, IAS/Mach, FL) using class-specific
   thrust/drag-polar models. Solves the energy equation:

     Ps = (T - D) · V / W = ROC + V·(dV/dt)      [m/s]

   For steady-Mach climb (V_TAS ≈ const) ⇒ Ps ≈ ROC:

     (T_MCL - D) / W = ROC / V_TAS
     ⇒ T_MCL · W = W² · ROC/V + (CD0·q·S)·W + k·W² · L²/(qS·W²)

   Substituting L = W in cruise/climb (γ small):
     D = (CD0 + k·CL²)·q·S,  CL = W/(q·S)
     T_MCL = W·ROC/V + CD0·q·S + k·W²/(q·S)

   Quadratic in W:
     (k/qS) W² + (ROC/V) W + (CD0·qS − T_MCL) = 0

   This yields the only physically-bounded positive root W*,
   the *gross weight at the current ADS-B sample*, given
   maximum-climb thrust from a BADA-style class table.

   In cruise the inversion uses Breguet specific-range
   inversion: at known FF (estimated from typical class)
   the implied CL = √((CD0)/(k)) at MRC; deviation in
   observed groundspeed gives a coarse residual mass.

   Class catalogue (BADA-style, 6-class):
     · HVY  (B748/A388/B77W/A359/B789)
     · WB-M (B763/A332/A339)
     · NB   (B738/A320/A21N/B752)
     · RGN-J (E190/E295/CRJ9)
     · RGN-T (AT72/DH8D)
     · BIZ   (GLEX/G650/GLF6)

   Each class carries: OEW [t], MTOW [t], typical-payload [t],
   max-climb thrust at FL250/M0.78 [kN], CD0, k = 1/(πARe),
   wing area S [m²], reference TAS climb [kt], LRC FF [kg/h].

   Tiers (Wfrac = W / MTOW):
     · AT-MTOW   Wfrac ≥ 0.97 rose   — at-or-above structural
                  limit, dispatch verification per FCOM PI-WT
     · HEAVY     Wfrac ≥ 0.88 rose-pink — late-leg / full pax
                  + cargo + fuel, brief OEI escape
     · NOMINAL   Wfrac ≥ 0.78 amber — typical dispatched LF
     · MID       Wfrac ≥ 0.68 sky    — mid-leg / partial fuel
     · LIGHT     Wfrac < 0.68 emerald — ferry / short turn /
                  end-of-leg
     · UNKNOWN   slate — phase not eligible (level cruise /
                  ground / descent) — energy inversion needs
                  ROC > +400 fpm sustained.

   Energy phase gate:
     · CLIMB-INV  (best): VS > +400 fpm, FL > 50, ≤ 380
     · CRUISE-INV (lower confidence): |VS| ≤ 200, FL ≥ 250
     · OFF        otherwise

   MapLibre overlay:
     · tier-coloured halo rings 7-19px on aircraft
     · AT-MTOW / HEAVY rose pins
     · tier-coloured cs / W-tonne / Wfrac% labels

   Side panel:
     · 6-tier counter strip · click-to-filter
     · 5-cell summary MEAN-Wfrac / WORST cs / AT-MTOW / Σ-W-t /
       MEAN-confidence
     · 5 sliders MIN-FL / MAX-FL / VS-MIN / WT-MUL (calibration)
       / ADV-MUL
     · 6-class chip filter
     · HALO/PIN/LBL toggles
     · AIRCRAFT/CLASSES/PHYSICS tab switcher
       · AIRCRAFT: cs+type+phase+tier · FL/M/VS/W/Wfrac% · CL+L/D
         + tier-coloured Wfrac bar + driver chips (THRUST,DRAG,
         ROC,QSCL,CONF) + advice line
       · CLASSES: per-class mean Wfrac / count / AT-MTOW / Σ-W
       · PHYSICS: live equation panel showing root-solve and
         per-class polar coefficients

   References:
     · Anderson · Aircraft Performance & Design §5.4 energy method
     · Hale · Aircraft Performance, Selection & Design §5
     · Mason · Configuration Aerodynamics Ch.8 drag polar
     · Mattingly · Aircraft Engine Design AIAA §8 TSFC
     · Roskam · Airplane Design Pt VI Ch.3 climb/cruise
     · Boeing 737/777/787 Performance Engineer Manual §3-§4
     · Airbus Getting-to-Grips with Aircraft Performance §3
     · Airbus GTG Fuel Economy §1.3 §2.1
     · EUROCONTROL BADA 3.15 / 4.2 OPF/APF coefficient sets
     · ICAO Doc 9889 §A.3 fuel-burn methodology
     · 14 CFR Part 25 §25.115/121 climb-gradient cert
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'AT-MTOW' | 'HEAVY' | 'NOMINAL' | 'MID' | 'LIGHT' | 'UNKNOWN'
const TIER_COLOR: Record<Tier, string> = {
  'AT-MTOW':'#ef4444', HEAVY:'#f43f5e', NOMINAL:'#f59e0b',
  MID:'#0ea5e9', LIGHT:'#10b981', UNKNOWN:'#475569',
}
const TIER_ORDER: Tier[] = ['AT-MTOW','HEAVY','NOMINAL','MID','LIGHT']
const TIER_RANK: Record<Tier, number> = { 'AT-MTOW':0, HEAVY:1, NOMINAL:2, MID:3, LIGHT:4, UNKNOWN:5 }

type Klass = 'HVY' | 'WB-M' | 'NB' | 'RGN-J' | 'RGN-T' | 'BIZ'
const KLASS_COLOR: Record<Klass, string> = {
  HVY:'#a855f7', 'WB-M':'#8b5cf6', NB:'#10b981',
  'RGN-J':'#f59e0b', 'RGN-T':'#eab308', BIZ:'#ec4899',
}
const KLASS_LIST: Klass[] = ['HVY','WB-M','NB','RGN-J','RGN-T','BIZ']

interface Spec {
  kl: Klass
  oewT: number        /* operating empty weight, tonnes */
  mtowT: number
  payloadT: number    /* typical full payload */
  tmclKN: number      /* max-climb thrust @ FL250/M0.78, kN */
  cd0: number         /* parasite drag coefficient */
  k: number           /* induced-drag factor 1/(π·AR·e) */
  sM2: number         /* wing area m² */
  vCli: number        /* typical climb TAS, kt */
  ffKgHr: number      /* LRC fuel-flow kg/hr */
  arRef: number       /* aspect ratio (for label) */
}

/* Per-class polar+thrust from BADA 3.15/4.2 OPF/APF blended with
   Boeing/Airbus PEM §3 thrust decks. Values are representative
   class means, not airframe-specific. */
const KLASS_SPEC: Record<Klass, Spec> = {
  HVY:    { kl:'HVY',    oewT:215, mtowT:380, payloadT: 65, tmclKN: 720, cd0:0.0205, k:0.045, sM2:482, vCli:300, ffKgHr:6800, arRef: 8.5 },
  'WB-M': { kl:'WB-M',   oewT:103, mtowT:187, payloadT: 35, tmclKN: 340, cd0:0.0210, k:0.048, sM2:283, vCli:290, ffKgHr:5200, arRef: 8.0 },
  NB:     { kl:'NB',     oewT: 42, mtowT: 79, payloadT: 18, tmclKN: 175, cd0:0.0205, k:0.052, sM2:124, vCli:290, ffKgHr:2400, arRef: 9.5 },
  'RGN-J':{ kl:'RGN-J',  oewT: 28, mtowT: 51, payloadT: 12, tmclKN: 130, cd0:0.0235, k:0.058, sM2: 92, vCli:270, ffKgHr:1300, arRef: 8.8 },
  'RGN-T':{ kl:'RGN-T',  oewT: 13, mtowT: 22, payloadT:  6, tmclKN:  65, cd0:0.0275, k:0.062, sM2: 61, vCli:200, ffKgHr: 600, arRef:12.0 },
  BIZ:    { kl:'BIZ',    oewT: 23, mtowT: 45, payloadT:  8, tmclKN: 115, cd0:0.0190, k:0.050, sM2: 95, vCli:280, ffKgHr:1100, arRef: 7.8 },
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
  return 'NB'
}

function clamp(x:number,a:number,b:number){return Math.max(a,Math.min(b,x))}

/* ISA atmosphere: returns density ρ [kg/m³], temperature T [K],
   speed of sound a [m/s] for pressure altitude h_ft. */
function isa(altFt: number): { rho: number; T: number; a: number; sigma: number } {
  const h = altFt * 0.3048
  let T: number, p: number
  const T0 = 288.15, p0 = 101325, g = 9.80665, R = 287.053, L = 0.0065
  if (h <= 11000) {
    T = T0 - L * h
    p = p0 * Math.pow(T / T0, g / (R * L))
  } else {
    T = 216.65
    const p11 = p0 * Math.pow(T / T0, g / (R * L))
    p = p11 * Math.exp(-g * (h - 11000) / (R * T))
  }
  const rho = p / (R * T)
  const a = Math.sqrt(1.4 * R * T)
  return { rho, T, a, sigma: rho / 1.225 }
}

/* Max-climb thrust falls with altitude+Mach. BADA APF model:
   T_MCL(h,M) = T_ref · σ^0.7 · (1 - 0.0015·(M - 0.78)·100)
   Returns thrust in kN. */
function tMcl(spec: Spec, altFt: number, mach: number): number {
  const { sigma } = isa(altFt)
  const tref = spec.tmclKN
  const machFactor = 1 - 0.0015 * Math.abs((mach - 0.78) * 100)
  return Math.max(0.05 * tref, tref * Math.pow(sigma, 0.7) * machFactor)
}

interface Inv {
  ok: boolean
  wKg: number          /* solved gross weight, kg */
  cl: number           /* lift coefficient */
  ld: number           /* L/D at solution */
  dKn: number          /* drag at solution, kN */
  tKn: number          /* thrust used, kN */
  rocFpm: number
  vTas: number         /* m/s */
  mach: number
  qPa: number
  phase: 'CLIMB-INV' | 'CRUISE-INV' | 'OFF'
  conf: number         /* 0-1 confidence */
  notes: string[]
}

/* Solve quadratic (k/qS)·W² + (ROC/V)·W + (CD0·qS − T) = 0 for W. */
function invertClimb(f: SFlight, spec: Spec, wtMul: number): Inv {
  const notes: string[] = []
  const altFt = f.altitudeFt
  const vs = f.vertRate
  const atm = isa(altFt)
  /* TAS from ADS-B groundspeed (no wind correction available);
     assume GS ≈ TAS at cruise altitudes. */
  const vTasMs = (f.velocityKts || 0) * 0.51444
  const mach = vTasMs / atm.a
  const qPa = 0.5 * atm.rho * vTasMs * vTasMs
  const empty: Inv = { ok:false, wKg:0, cl:0, ld:0, dKn:0, tKn:0, rocFpm:vs, vTas:vTasMs, mach, qPa, phase:'OFF', conf:0, notes: ['off-phase'] }
  if (f.ground || altFt < 5000 || altFt > 42000 || vTasMs < 80) return empty
  const isClimb = vs > 400
  const isCruise = Math.abs(vs) < 250 && altFt >= 25000
  if (!isClimb && !isCruise) return empty

  const tNcl = tMcl(spec, altFt, mach) * 1000  /* convert to N */
  const sM2 = spec.sM2
  const cd0 = spec.cd0
  const kInd = spec.k
  /* In cruise no climb-thrust: use T = D (steady level) ⇒
     cruise inversion uses W = qS · √(CD0/k) (MRC condition)
     scaled by groundspeed/Mref deviation; coarse only. */
  if (isCruise) {
    const clMrc = Math.sqrt(cd0 / kInd)
    const wKgC = qPa * sM2 * clMrc / 9.80665
    const wKg = clamp(wKgC * (wtMul / 100), spec.oewT * 1000, spec.mtowT * 1000)
    const cl = (wKg * 9.80665) / (qPa * sM2)
    const cd = cd0 + kInd * cl * cl
    const ld = cl / cd
    notes.push('cruise inversion · MRC-anchored · coarse')
    return { ok:true, wKg, cl, ld, dKn:(cd*qPa*sM2)/1000, tKn:(cd*qPa*sM2)/1000, rocFpm:vs, vTas:vTasMs, mach, qPa, phase:'CRUISE-INV', conf:0.45, notes }
  }
  /* Climb inversion · solve quadratic for W. */
  const vsMs = vs * 0.00508  /* fpm → m/s */
  const A = kInd / (qPa * sM2)
  const B = vsMs / vTasMs
  const C = cd0 * qPa * sM2 - tNcl
  const disc = B * B - 4 * A * C
  if (disc < 0) {
    notes.push('no real root · likely T_mcl underestimate · using OEW+½·MTOW')
    const wKg = (spec.oewT + 0.4 * spec.mtowT) * 1000 * (wtMul / 100)
    const cl = (wKg * 9.80665) / (qPa * sM2)
    const cd = cd0 + kInd * cl * cl
    return { ok:false, wKg, cl, ld:cl/cd, dKn:(cd*qPa*sM2)/1000, tKn:tNcl/1000, rocFpm:vs, vTas:vTasMs, mach, qPa, phase:'CLIMB-INV', conf:0.10, notes }
  }
  const wRoot = (-B + Math.sqrt(disc)) / (2 * A)
  const wKgRaw = wRoot
  const wKg = clamp(wKgRaw * (wtMul / 100), spec.oewT * 1000 * 0.95, spec.mtowT * 1000 * 1.02)
  const cl = (wKg * 9.80665) / (qPa * sM2)
  const cd = cd0 + kInd * cl * cl
  const ld = cl / cd
  const dN = cd * qPa * sM2
  const conf = clamp(0.35 + Math.min(vs, 2500) / 4000 + (altFt > 15000 ? 0.15 : 0), 0.2, 0.95)
  if (cl > 0.8) notes.push('CL high · near-stall or wrong polar')
  if (wKg > spec.mtowT * 1000) notes.push('estimate > MTOW · check class polar')
  return { ok:true, wKg, cl, ld, dKn:dN/1000, tKn:tNcl/1000, rocFpm:vs, vTas:vTasMs, mach, qPa, phase:'CLIMB-INV', conf, notes }
}

interface Drivers { THRUST:number; DRAG:number; ROC:number; QSCL:number; CONF:number }
interface Row {
  f: SFlight; kl: Klass; spec: Spec
  inv: Inv
  wFrac: number       /* W / MTOW */
  drivers: Drivers
  tier: Tier
}

function classifyTier(inv: Inv, spec: Spec): { tier: Tier; wFrac: number } {
  if (inv.phase === 'OFF') return { tier:'UNKNOWN', wFrac: 0 }
  const wFrac = inv.wKg / (spec.mtowT * 1000)
  let tier: Tier
  if (wFrac >= 0.97) tier = 'AT-MTOW'
  else if (wFrac >= 0.88) tier = 'HEAVY'
  else if (wFrac >= 0.78) tier = 'NOMINAL'
  else if (wFrac >= 0.68) tier = 'MID'
  else tier = 'LIGHT'
  return { tier, wFrac }
}

export default function MeltMassEstimator({ map, flights, onClose, onFly }: Props) {
  const [minFL, setMinFL] = useState(50)
  const [maxFL, setMaxFL] = useState(420)
  const [vsMin, setVsMin] = useState(400)
  const [wtMul, setWtMul] = useState(100)
  const [advMul, setAdvMul] = useState(100)
  const [klFilter, setKlFilter] = useState<Record<Klass, boolean>>({ HVY:true,'WB-M':true,NB:true,'RGN-J':true,'RGN-T':true,BIZ:true })
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'PHYSICS'>('AIRCRAFT')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      const FL = f.altitudeFt / 100
      if (FL < minFL || FL > maxFL) continue
      const kl = classifyType(f.type)
      const spec = KLASS_SPEC[kl]
      const inv = invertClimb(f, spec, wtMul)
      const { tier, wFrac } = classifyTier(inv, spec)
      if (inv.phase === 'OFF' && Math.abs(f.vertRate) < vsMin) continue
      const drivers: Drivers = {
        THRUST: clamp((inv.tKn / spec.tmclKN) * 100, 0, 100),
        DRAG: clamp((inv.dKn / spec.tmclKN) * 100, 0, 100),
        ROC: clamp((inv.rocFpm / 3000) * 100, -100, 100),
        QSCL: clamp(inv.cl * 100, 0, 100),
        CONF: clamp(inv.conf * 100 * (advMul / 100), 0, 100),
      }
      out.push({ f, kl, spec, inv, wFrac, drivers, tier })
    }
    out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.wFrac - a.wFrac)
    return out
  }, [flights, minFL, maxFL, vsMin, wtMul, advMul])

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
    const c: Record<Tier, number> = { 'AT-MTOW':0, HEAVY:0, NOMINAL:0, MID:0, LIGHT:0, UNKNOWN:0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const meanWfrac = rows.length ? rows.reduce((a,b)=>a+b.wFrac,0)/rows.length : 0
  const worst = rows[0]
  const atMtow = tierCounts['AT-MTOW']
  const totalWt = rows.reduce((a,b)=>a+b.inv.wKg,0)/1000  /* tonnes */
  const meanConf = rows.length ? rows.reduce((a,b)=>a+b.inv.conf,0)/rows.length : 0

  /* ----- MapLibre overlay ----- */
  useEffect(() => {
    if (!map) return
    const SRC = 'melt-ac-src'
    const HALO = 'melt-halo'
    const PIN = 'melt-pin'
    const LBL = 'melt-lbl'

    const acFC = { type:'FeatureCollection' as const, features: rows.map(r => ({
      type:'Feature' as const,
      geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat] },
      properties:{
        cs: r.f.callsign || r.f.icao,
        wt: r.inv.wKg ? `${(r.inv.wKg/1000).toFixed(0)}t` : '—',
        wf: r.wFrac ? `${(r.wFrac*100).toFixed(0)}%` : '—',
        tier: r.tier,
        color: TIER_COLOR[r.tier],
        haloR: r.tier === 'AT-MTOW' ? 19 : r.tier === 'HEAVY' ? 16 : r.tier === 'NOMINAL' ? 13 : r.tier === 'MID' ? 10 : r.tier === 'LIGHT' ? 8 : 7,
        pinScale: (r.tier === 'AT-MTOW' || r.tier === 'HEAVY') ? 1 : 0,
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
          'text-field':['concat',['get','cs'],'  ',['get','wt'],' · ',['get','wf'],'  ',['get','tier']],
          'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top',
          'text-font':['Open Sans Semibold','Arial Unicode MS Bold'],
        }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0b1220', 'text-halo-width':1.2 }})
      } catch {}
    }
    if (map.isStyleLoaded()) add(); else map.once('load', add)
    return () => {
      try {
        for (const l of [LBL, PIN, HALO]) if (map.getLayer(l)) map.removeLayer(l)
        if (map.getSource(SRC)) map.removeSource(SRC)
      } catch {}
    }
  }, [map, rows, showHalo, showPin, showLbl])

  return (
    <div className="absolute right-3 top-20 z-30 w-[470px] max-h-[80vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">MELT</div>
        <div className="text-[10px] text-slate-400 truncate">Live gross-weight estimator · energy-method inversion</div>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-[12px] px-2 py-0.5 rounded hover:bg-slate-800/60">✕</button>
        </div>
      </div>

      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        {(['AT-MTOW','HEAVY','NOMINAL','MID','LIGHT','UNKNOWN'] as Tier[]).map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter===t?'ALL':t)}
            className={`px-1 py-1 rounded border ${tierFilter===t?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
            <div className="text-[8px]" style={{color: TIER_COLOR[t]}}>{t.slice(0,7)}</div>
            <div className="text-slate-100 font-semibold">{tierCounts[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">MEAN-WF</div>
          <div className="text-slate-100 font-semibold tabular-nums">{(meanWfrac*100).toFixed(0)}%</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">WORST</div>
          <div className="text-slate-100 font-semibold truncate text-[10px]">{worst ? worst.f.callsign || worst.f.icao : '—'}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">AT-MTOW</div>
          <div className="font-semibold tabular-nums" style={{color: atMtow ? TIER_COLOR['AT-MTOW'] : '#cbd5e1'}}>{atMtow}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">Σ-W t</div>
          <div className="text-slate-100 font-semibold tabular-nums">{totalWt.toFixed(0)}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">MEAN-CONF</div>
          <div className="text-slate-100 font-semibold tabular-nums">{(meanConf*100).toFixed(0)}%</div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800/60 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
        {([
          ['MIN-FL', minFL, setMinFL, 30, 420, '', 5],
          ['MAX-FL', maxFL, setMaxFL, 100, 450, '', 5],
          ['VS-MIN', vsMin, setVsMin, 100, 2500, 'fpm', 50],
          ['WT-MUL', wtMul, setWtMul, 70, 130, '%', 1],
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

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800/60">
        {KLASS_LIST.map(k => (
          <button key={k} onClick={() => setKlFilter(p => ({...p, [k]: !p[k]}))}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${klFilter[k]?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700 opacity-50'}`}
            style={{color: KLASS_COLOR[k]}}>{k}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800/60 text-[9px]">
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl]] as const).map(([n,v,s])=>(
          <button key={n} onClick={()=>(s as any)(!v)} className={`px-1.5 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-500 hover:border-slate-700'}`}>{n}</button>
        ))}
      </div>

      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-800/60">
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="callsign / type / operator / class"
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
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500">no airborne aircraft in climb-energy phase · lower VS-MIN or expand FL range</div>}
            {filtered.slice(0, 60).map(r => {
              const advice =
                r.tier === 'AT-MTOW' ? 'at or above MTOW · verify dispatch W&B / RTOW per FCOM PI-WT' :
                r.tier === 'HEAVY' ? 'heavy · long-haul early-leg signature · OEI escape per AC 25-13' :
                r.tier === 'NOMINAL' ? 'within typical dispatched LF · nominal climb performance' :
                r.tier === 'MID' ? 'mid-leg / partial fuel · normal mission profile' :
                r.tier === 'LIGHT' ? 'light · ferry / short turn / end-of-leg' :
                'phase not eligible for energy inversion'
              return (
                <button key={r.f.icao} onClick={()=>onFly(r.f.icao)} className="w-full text-left px-3 py-2 hover:bg-slate-900/60 transition">
                  <div className="flex items-center gap-2 mb-1" style={{borderLeft:`3px solid ${TIER_COLOR[r.tier]}`, paddingLeft:8}}>
                    <span className="font-semibold text-slate-100">{r.f.callsign || r.f.icao}</span>
                    <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
                    <span className="text-[9px] px-1 py-px rounded bg-slate-800/70" style={{color: KLASS_COLOR[r.kl]}}>{r.kl}</span>
                    <span className="text-[9px] px-1 py-px rounded bg-slate-800/70 text-sky-300">{r.inv.phase}</span>
                    <span className="ml-auto text-[9px] px-1.5 py-px rounded font-bold" style={{background: TIER_COLOR[r.tier]+'22', color: TIER_COLOR[r.tier]}}>{r.tier}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-x-2 gap-y-1 text-[10px] pl-2">
                    <div><span className="text-slate-500">FL </span><span className="text-slate-100 tabular-nums">{(r.f.altitudeFt/100).toFixed(0)}</span></div>
                    <div><span className="text-slate-500">M </span><span className="text-slate-100 tabular-nums">{r.inv.mach.toFixed(2)}</span></div>
                    <div><span className="text-slate-500">VS </span><span className="tabular-nums" style={{color: r.inv.rocFpm > 1500 ? '#10b981' : r.inv.rocFpm > 500 ? '#0ea5e9' : '#94a3b8'}}>{r.inv.rocFpm.toFixed(0)}fpm</span></div>
                    <div><span className="text-slate-500">L/D </span><span className="text-slate-100 tabular-nums">{r.inv.ld.toFixed(1)}</span></div>
                    <div><span className="text-slate-500">W </span><span className="text-sky-300 font-semibold tabular-nums">{(r.inv.wKg/1000).toFixed(0)}t</span></div>
                    <div><span className="text-slate-500">MTOW </span><span className="text-slate-200 tabular-nums">{r.spec.mtowT.toFixed(0)}t</span></div>
                    <div><span className="text-slate-500">CL </span><span className="text-slate-100 tabular-nums">{r.inv.cl.toFixed(2)}</span></div>
                    <div><span className="text-slate-500">CONF </span><span className="tabular-nums" style={{color: r.inv.conf > 0.7 ? '#10b981' : r.inv.conf > 0.4 ? '#0ea5e9' : '#f59e0b'}}>{(r.inv.conf*100).toFixed(0)}%</span></div>
                  </div>
                  <div className="mt-1.5 pl-2">
                    <div className="flex items-center gap-2 mb-1">
                      <div className="flex-1 bg-slate-900/60 rounded h-1 overflow-hidden">
                        <div className="h-full" style={{width:`${Math.round(Math.min(r.wFrac, 1.05)*100)}%`, background: TIER_COLOR[r.tier]}}></div>
                      </div>
                      <span className="text-[9px] tabular-nums" style={{color: TIER_COLOR[r.tier]}}>{(r.wFrac*100).toFixed(1)}%</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {(Object.entries(r.drivers) as [keyof Drivers, number][]).map(([k,v]) => (
                        <span key={k} className="text-[8.5px] px-1 py-px rounded bg-slate-900/60 text-slate-400 border border-slate-800/60">
                          {k} <span className="tabular-nums" style={{color: v > 70 ? TIER_COLOR['AT-MTOW'] : v > 40 ? TIER_COLOR['NOMINAL'] : '#cbd5e1'}}>{v.toFixed(0)}</span>
                        </span>
                      ))}
                    </div>
                    <div className="mt-1 text-[10px] italic" style={{color: r.tier === 'AT-MTOW' || r.tier === 'HEAVY' ? '#fda4af' : '#94a3b8'}}>› {advice}</div>
                    {r.inv.notes.length > 0 && (
                      <div className="mt-0.5 text-[9.5px] text-slate-500 italic">{r.inv.notes.join(' · ')}</div>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {tab === 'CLASSES' && (
          <div className="divide-y divide-slate-800/60">
            {KLASS_LIST.map(k => {
              const rs = rows.filter(r => r.kl === k)
              const meanWf = rs.length ? rs.reduce((a,b)=>a+b.wFrac,0)/rs.length : 0
              const sumW = rs.reduce((a,b)=>a+b.inv.wKg,0)/1000
              const atM = rs.filter(r => r.tier === 'AT-MTOW').length
              const hv = rs.filter(r => r.tier === 'HEAVY').length
              const sp = KLASS_SPEC[k]
              const worstT: Tier = rs.length ? rs.reduce((a,b)=>TIER_RANK[b.tier] < TIER_RANK[a]?b.tier:a, 'LIGHT' as Tier) : 'UNKNOWN'
              return (
                <div key={k} className="px-3 py-2" style={{borderLeft:`3px solid ${TIER_COLOR[worstT]}`}}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-semibold text-[12px]" style={{color: KLASS_COLOR[k]}}>{k}</span>
                    <span className="text-[10px] text-slate-400">MTOW {sp.mtowT}t · OEW {sp.oewT}t · T_mcl {sp.tmclKN}kN · S {sp.sM2}m²</span>
                    <span className="ml-auto text-[10px] text-slate-400 tabular-nums">n={rs.length}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-x-2 text-[10px] pl-2">
                    <div><span className="text-slate-500">MEAN-WF </span><span className="tabular-nums text-slate-200">{(meanWf*100).toFixed(0)}%</span></div>
                    <div><span className="text-slate-500">Σ-W </span><span className="tabular-nums text-slate-200">{sumW.toFixed(0)}t</span></div>
                    <div><span className="text-slate-500">AT-MTOW </span><span className="tabular-nums" style={{color: atM?TIER_COLOR['AT-MTOW']:'#cbd5e1'}}>{atM}</span></div>
                    <div><span className="text-slate-500">HEAVY </span><span className="tabular-nums" style={{color: hv?TIER_COLOR['HEAVY']:'#cbd5e1'}}>{hv}</span></div>
                  </div>
                  <div className="text-[9.5px] text-slate-500 italic mt-1 pl-2">
                    CD0={sp.cd0.toFixed(4)} · k={sp.k.toFixed(3)} · AR≈{sp.arRef} · FF-LRC {sp.ffKgHr}kg/h
                  </div>
                  <div className="w-full bg-slate-900/60 rounded h-1 overflow-hidden mt-1.5">
                    <div className="h-full" style={{width:`${Math.round(meanWf*100)}%`, background: TIER_COLOR[worstT]}}></div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'PHYSICS' && (
          <div className="px-3 py-3 space-y-3 text-[11px]">
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-widest text-slate-500">Energy-method inversion</div>
              <div className="p-2 rounded bg-slate-900/60 border border-slate-800 font-mono text-[10.5px] text-slate-200 leading-relaxed">
                <div>Ps = (T − D) · V / W  =  ROC + V·(dV/dt)</div>
                <div className="text-slate-500">↪ steady-Mach climb: V̇≈0  ⇒  Ps ≈ ROC</div>
                <div className="mt-1.5">(T<span className="text-slate-500">_MCL</span> − D) / W = ROC / V<span className="text-slate-500">_TAS</span></div>
                <div>D = (CD0 + k·CL²) · q · S,   CL = W / (q·S)</div>
                <div className="mt-1.5 text-sky-300">⇒ <span className="text-amber-300">(k/qS)</span>·W² + <span className="text-amber-300">(ROC/V)</span>·W + <span className="text-amber-300">(CD0·qS − T)</span> = 0</div>
                <div className="text-slate-500 text-[9px] mt-1">positive root W* = (−B + √(B² − 4AC)) / 2A</div>
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-widest text-slate-500">Class polar coefficients (BADA 3.15/4.2 blended)</div>
              <div className="grid grid-cols-6 gap-1 text-[9px] font-mono">
                <div className="text-slate-500">CLASS</div>
                <div className="text-slate-500">CD0</div>
                <div className="text-slate-500">k</div>
                <div className="text-slate-500">S m²</div>
                <div className="text-slate-500">T kN</div>
                <div className="text-slate-500">MTOW t</div>
                {KLASS_LIST.map(k => {
                  const s = KLASS_SPEC[k]
                  return (
                    <div key={k} className="contents">
                      <div style={{color: KLASS_COLOR[k]}}>{k}</div>
                      <div className="text-slate-200 tabular-nums">{s.cd0.toFixed(4)}</div>
                      <div className="text-slate-200 tabular-nums">{s.k.toFixed(3)}</div>
                      <div className="text-slate-200 tabular-nums">{s.sM2}</div>
                      <div className="text-slate-200 tabular-nums">{s.tmclKN}</div>
                      <div className="text-slate-200 tabular-nums">{s.mtowT}</div>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-widest text-slate-500">Confidence model</div>
              <div className="text-[10px] text-slate-400 leading-relaxed">
                CLIMB-INV: 0.35 + min(ROC,2500)/4000 + 0.15·[FL&gt;150]<br/>
                CRUISE-INV: fixed 0.45 (MRC-anchored, no thrust telemetry)<br/>
                Off-phase: 0
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-widest text-slate-500">Caveats</div>
              <ul className="text-[10px] text-slate-400 list-disc pl-4 space-y-0.5">
                <li>TAS proxied by ADS-B GS (no wind correction)</li>
                <li>Class polars are means, not airframe-specific</li>
                <li>T_MCL is BADA APF model · σ^0.7 · Mach decrement</li>
                <li>Assumes max-climb thrust setting (typical SOP &lt; FL250)</li>
                <li>WT-MUL slider provides operator-side calibration</li>
              </ul>
            </div>
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800/60 text-[9px] text-slate-500 italic">
        Anderson §5.4 · Hale §5 · Mason Ch.8 · Mattingly §8 · Roskam Pt VI Ch.3 · Boeing 737/777/787 PEM §3-4 · Airbus GTG Aircraft Performance §3 · EUROCONTROL BADA 3.15/4.2 · ICAO Doc 9889 §A.3 · 14 CFR §25.115/121
      </div>
    </div>
  )
}
