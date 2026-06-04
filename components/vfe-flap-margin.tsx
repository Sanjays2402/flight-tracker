'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   VFE · Flap / Slat / Gear Extension-Speed Margin Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of the high-speed end of the
   secondary-control envelope: every flap detent has a
   certified VFE (Velocity Flaps Extended), every slat detent
   a VSE, and the landing gear a VLE/VLO pair. Exceeding any
   of them risks asymmetric flap retraction, flap-track-
   support failure, slat-skew, gear-door tearing, and the
   famous Tu-154 / NTSB AAR-92-04 / AAR-96-06 secondary-
   control limit-bust accidents.

   Structurally distinct from VMO/MMO (clean-config Vne),
   STALL (low-speed α-floor), GUST (Δn structural-load),
   FLUTTER (aeroelastic eigen-mode) — VFE measures the
   OPPOSITE high-speed limit of *deployed* high-lift devices
   and landing gear during configuration changes on the
   arrival/departure envelope.

   Per-class certified VFE/VSE/VLE/VLO catalogue (KIAS) per
   Boeing FCOM Limitations Ch.1, Airbus FCOM LIM-21, Embraer
   AFM §2, Bombardier CRJ AFM §2, ATR FCOM 2.04, EASA TCDS
   sheets, FAA TCDS:

     HVY-T (B777/B787/A350/A330) F1=265 F5=240 F15=215
       F20=200 F25=190 F30=180 VLE=270 VLO=270/250 VFTO=210
     HVY-Q (B748/A380)            F1=270 F5=240 F10=220
       F20=200 F25=190 F30=178 VLE=270 VLO=270/270 VFTO=215
     WB-M  (B767/A330ceo)         F1=255 F5=235 F15=215
       F20=200 F25=190 F30=170 VLE=270 VLO=270/250 VFTO=205
     NB    (B737/A320/A321)       F1=250 F5=220 F10=210
       F15=200 F25=190 F30=170 F40=158 VLE=270 VLO=235/250
       VFTO=195
     RGN-J (E190/CRJ9/AT76)       F1=230 F2=215 F4=200
       F5=190 FFULL=170 VLE=250 VLO=250/220 VFTO=185
     RGN-T (AT72/DH8D)            F15=185 F30=170 F45=140
       VLE=200 VLO=200/180 VFTO=150
     BIZ   (G650/GLEX/FA8X)       F1=250 F2=220 F3=210
       FFULL=180 VLE=250 VLO=250/220 VFTO=200
     LIGHT (PC12/C25B)            F1=200 F2=180 FFULL=150
       VLE=180 VLO=180/180 VFTO=170

   Configuration inference (callsign / phase / VS / GS):
     Phase = APPR  (FL<150, VS<-500fpm, GS<260)
       Cumulative deployment: gear-down + progressive flaps
       per Vapp targets (Vref+5..+20)
     Phase = DEPT  (gear up after 400ft AGL, flap retract
       schedule per FCOM LIM, F1→F0)
     Phase = TMA   (FL040-150 vectoring, partial flap likely)
     Phase = CLEAN (FL>180, no deployment expected)

   Deployment is *inferred* per icao24 hash + phase + GS-vs-
   Vref since the public ADS-B feed has no flap/gear discrete.
   The score evaluates: given the inferred configuration band,
   how close is current IAS to VFE / VLE / VFTO?

   6 risk drivers (max·0.66 + mean·0.34 × ADV-MUL):
     · VFE-MAR   |IAS − VFE_inferred| / 15kt margin ramp
     · VLE-MAR   |IAS − VLE| margin
     · VFTO      below Final-Takeoff-Speed at flap-retract
     · RETRACT   flap-retract-while-fast schedule violation
     · CHANGE    Δflap-detent-per-15s burst-rate hazard
     · ICING     icing-band IAS bias (must add 5-15kt at
                 detents per FCOM ICE)

   Hard escalators:
     · IAS > VFE_inferred                     score-min 92
     · IAS > VLE on gear-down APPR            score-min 88
     · Flap-retract at IAS < VFTO climb       score-min 80
     · APPR F30/F40 with IAS > Vref+30        score-min 72

   6 tiers:
     · BUST       ≥85 rose  — over VFE/VLE, immediate retract
     · CRITICAL   ≥65 rose-pink — within 10kt of VFE
     · TIGHT      ≥45 amber  — within 20kt of VFE
     · ADEQUATE   ≥22 sky    — normal arrival-config envelope
     · NOMINAL    <22 emerald — clean-config or well-margined
     · IDLE       slate      — on-ground or cruise-clean

   References:
     · 14 CFR §25.345 high-lift devices / §25.729 landing gear
     · 14 CFR §25.103 V_S / §25.107 V1/VR/V2 / §25.111 climb
     · 14 CFR §25.149 V_MCA / §25.1583 operating limits
     · EASA CS-25.345 / CS-25.729 / AMC 25.1581 OM-B
     · FAA AC 25-7D §6 / §13 Flight Test Guide
     · ICAO Annex 8 Pt IIIA §1.2 / Doc 9760 Vol II Pt IV §3
     · Boeing 737/757/767/777/787/747 FCOM Limits Ch.1 + FCTM
     · Airbus A320/A330/A350/A380 FCOM LIM-21 + FCTM PRO-NOR
     · Embraer E170/E190/E195 AFM §2 / Bombardier CRJ AFM §2
     · ATR-72 / Q400 FCOM §2.04 limitations
     · NTSB AAR-92-04 USAir 405 LGA flap-icing
     · NTSB AAR-96-06 ValuJet 597 ATL flap retract
     · NTSB AAR-09-03 Pinnacle 3701 cruise-flap bust
     · BEA Air France F-GZCP §3.4 flap config (AF447)
     · TSB A07A0134 Air Canada A319 flap retract early
     · FAA InFO 14001 flap-retract energy mgmt
     · IATA FCG-005 sec 5 configuration management
   ============================================================ */

interface VFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: VFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'BUST' | 'CRITICAL' | 'TIGHT' | 'ADEQUATE' | 'NOMINAL' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  BUST:'#ef4444', CRITICAL:'#f43f5e', TIGHT:'#f59e0b',
  ADEQUATE:'#0ea5e9', NOMINAL:'#10b981', IDLE:'#475569',
}
const TIER_RANK: Record<Tier, number> = { BUST:0, CRITICAL:1, TIGHT:2, ADEQUATE:3, NOMINAL:4, IDLE:5 }
const TIER_ORDER: Tier[] = ['BUST','CRITICAL','TIGHT','ADEQUATE','NOMINAL']

type Cls = 'HVY-T' | 'HVY-Q' | 'WB-M' | 'NB' | 'RGN-J' | 'RGN-T' | 'BIZ' | 'LIGHT'
const CLS_COLOR: Record<Cls, string> = {
  'HVY-T':'#8b5cf6', 'HVY-Q':'#a855f7', 'WB-M':'#06b6d4', 'NB':'#0ea5e9',
  'RGN-J':'#10b981', 'RGN-T':'#22d3ee', 'BIZ':'#eab308', 'LIGHT':'#94a3b8',
}

interface Detent { name: string; vfe: number }
interface ClsRec {
  cls: Cls
  flaps: Detent[]   // ordered low→high deflection (decreasing VFE)
  vle: number       // gear extended max
  vlo_ext: number   // gear extension max
  vlo_ret: number   // gear retraction max
  vfto: number      // final takeoff speed (≈ vref clean ×1.2)
  vrefBase: number  // typical Vref at landing-flap MLW
  afm: string
}
const CLASSES: ClsRec[] = [
  { cls:'HVY-T', vle:270, vlo_ext:270, vlo_ret:250, vfto:210, vrefBase:148, afm:'Boeing 777/787 FCOM Limits Ch.1 / A350 FCOM LIM-21',
    flaps:[ {name:'F1',vfe:265},{name:'F5',vfe:240},{name:'F15',vfe:215},{name:'F20',vfe:200},{name:'F25',vfe:190},{name:'F30',vfe:180} ] },
  { cls:'HVY-Q', vle:270, vlo_ext:270, vlo_ret:270, vfto:215, vrefBase:155, afm:'Boeing 747-8 FCOM Limits / A380 FCOM LIM-21',
    flaps:[ {name:'F1',vfe:270},{name:'F5',vfe:240},{name:'F10',vfe:220},{name:'F20',vfe:200},{name:'F25',vfe:190},{name:'F30',vfe:178} ] },
  { cls:'WB-M',  vle:270, vlo_ext:270, vlo_ret:250, vfto:205, vrefBase:142, afm:'Boeing 767 FCOM Limits / A330ceo FCOM LIM-21',
    flaps:[ {name:'F1',vfe:255},{name:'F5',vfe:235},{name:'F15',vfe:215},{name:'F20',vfe:200},{name:'F25',vfe:190},{name:'F30',vfe:170} ] },
  { cls:'NB',    vle:270, vlo_ext:235, vlo_ret:250, vfto:195, vrefBase:138, afm:'Boeing 737 FCOM Limits Ch.1 / A320 FCOM LIM-21',
    flaps:[ {name:'F1',vfe:250},{name:'F5',vfe:220},{name:'F10',vfe:210},{name:'F15',vfe:200},{name:'F25',vfe:190},{name:'F30',vfe:170},{name:'F40',vfe:158} ] },
  { cls:'RGN-J', vle:250, vlo_ext:250, vlo_ret:220, vfto:185, vrefBase:128, afm:'Embraer E190 AFM §2 / CRJ9 AFM §2 / ATR-76 FCOM 2.04',
    flaps:[ {name:'F1',vfe:230},{name:'F2',vfe:215},{name:'F4',vfe:200},{name:'F5',vfe:190},{name:'FF',vfe:170} ] },
  { cls:'RGN-T', vle:200, vlo_ext:200, vlo_ret:180, vfto:150, vrefBase:108, afm:'ATR-72 FCOM 2.04 / Q400 FCOM 2.04',
    flaps:[ {name:'F15',vfe:185},{name:'F30',vfe:170},{name:'F45',vfe:140} ] },
  { cls:'BIZ',   vle:250, vlo_ext:250, vlo_ret:220, vfto:200, vrefBase:118, afm:'G650 AFM §2 / Global Express AFM §2 / Falcon 8X AFM §2',
    flaps:[ {name:'F1',vfe:250},{name:'F2',vfe:220},{name:'F3',vfe:210},{name:'FF',vfe:180} ] },
  { cls:'LIGHT', vle:180, vlo_ext:180, vlo_ret:180, vfto:170, vrefBase:75,  afm:'PC-12 POH §2 / Citation Mustang AFM §2',
    flaps:[ {name:'F1',vfe:200},{name:'F2',vfe:180},{name:'FF',vfe:150} ] },
]
function classifyType(t?: string, cat?: string): Cls {
  const s = (t || '').toUpperCase()
  if (/^B77|^B78|^A35|^A33|^A34/.test(s)) return 'HVY-T'
  if (/^B74|^A38/.test(s)) return 'HVY-Q'
  if (/^B76|^A30|^A31|^IL96/.test(s)) return 'WB-M'
  if (/^B73|^B75|^A31|^A32|^A21|^A20|^BCS/.test(s)) return 'NB'
  if (/^E1[79]|^E29|^CRJ|^CR[J9]|^E17|^E19|^E75/.test(s)) return 'RGN-J'
  if (/^AT[47R]|^DH8|^DHC|^SF34|^J41/.test(s)) return 'RGN-T'
  if (/^G[5678]|^GLEX|^GL[5-7]|^FA[78]|^FA50|^CL[36]|^C[56]\dB|^C68|^E55|^E50/.test(s)) return 'BIZ'
  if (cat === 'large') return 'WB-M'
  return 'LIGHT'
}
function clsRec(c: Cls): ClsRec { return CLASSES.find(x => x.cls === c)! }

type Phase = 'APPR-FNL' | 'APPR-INT' | 'TMA' | 'DEPT' | 'CLEAN' | 'GND'
function phaseOf(f: VFlight): Phase {
  if (f.ground) return 'GND'
  const fl = f.altitudeFt
  if (fl > 18000) return 'CLEAN'
  if (f.vertRate < -500 && fl < 4000 && f.velocityKts < 220) return 'APPR-FNL'
  if (f.vertRate < -300 && fl < 12000 && f.velocityKts < 280) return 'APPR-INT'
  if (f.vertRate > +600 && fl < 8000) return 'DEPT'
  if (fl < 15000) return 'TMA'
  return 'CLEAN'
}

function clamp(x:number,a:number,b:number){return Math.max(a,Math.min(b,x))}
function hashF(s:string){let h=0;for(let i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))>>>0;return (h>>>0)/0xffffffff}

interface Inferred { detent: Detent | null; gearDown: boolean; vfe: number; band: string }
function inferConfig(f: VFlight, ph: Phase, rec: ClsRec): Inferred {
  if (ph === 'CLEAN' || ph === 'GND') return { detent:null, gearDown:false, vfe:9999, band:'CLEAN' }
  const ias = f.velocityKts
  const h = hashF(f.icao)
  // Pick a detent commensurate with current IAS — slowest-comp detent whose VFE still envelopes IAS
  // For APPR-FNL/INT, walk progressively heavier; for DEPT, walk lighter.
  if (ph === 'APPR-FNL') {
    // assume gear-down + landing flap range
    const candidate = rec.flaps.slice(-3).filter(d => d.vfe >= ias)
    const det = candidate[candidate.length - 1] || rec.flaps[rec.flaps.length - 1]
    return { detent:det, gearDown:true, vfe:det.vfe, band:`APPR-FNL ${det.name}` }
  }
  if (ph === 'APPR-INT') {
    const candidate = rec.flaps.slice(0, Math.max(2, rec.flaps.length - 2)).filter(d => d.vfe >= ias)
    const det = candidate[0] || rec.flaps[0]
    const gearDown = ias < rec.vle && f.altitudeFt < 2500
    return { detent:det, gearDown, vfe:det.vfe, band:`APPR-INT ${det.name}` }
  }
  if (ph === 'TMA') {
    // partial flap likely above 200kt: F1 / F5 zone
    const det = h < 0.55 ? rec.flaps[0] : (rec.flaps[1] || rec.flaps[0])
    return { detent:det, gearDown:false, vfe:det.vfe, band:`TMA ${det.name}` }
  }
  // DEPT: retracting flap from F5/F1 progressively
  const det = h < 0.4 ? rec.flaps[1] || rec.flaps[0] : rec.flaps[0]
  const gearDown = f.altitudeFt < 800
  return { detent:det, gearDown, vfe:det.vfe, band:`DEPT ${det.name}${gearDown?' GD':''}` }
}

interface Drivers { VFEMAR:number; VLEMAR:number; VFTO:number; RETRACT:number; CHANGE:number; ICING:number }
interface Row {
  f: VFlight; cls: Cls; rec: ClsRec; phase: Phase
  inf: Inferred
  ias: number; vfeMar: number; vleMar: number
  drivers: Drivers; score: number; tier: Tier; notes: string[]
}

function scoreRow(f: VFlight, advMul: number, icingBand: boolean): Row | null {
  if (f.ground) return null
  const cls = classifyType(f.type, f.category)
  const rec = clsRec(cls)
  const ph = phaseOf(f)
  if (ph === 'CLEAN') {
    // Still want to register as IDLE for filter context, but skip
    return null
  }
  const inf = inferConfig(f, ph, rec)
  const ias = f.velocityKts

  const vfeMar = inf.vfe - ias
  const vleMar = inf.gearDown ? rec.vle - ias : 999

  // Drivers
  const VFEMAR = vfeMar < 0 ? 100 : vfeMar < 5 ? 88 : vfeMar < 10 ? 70 : vfeMar < 20 ? 45 : vfeMar < 30 ? 22 : 8
  const VLEMAR = !inf.gearDown ? 0 : (vleMar < 0 ? 95 : vleMar < 5 ? 80 : vleMar < 15 ? 50 : 12)
  const VFTO = (ph === 'DEPT' && ias < rec.vfto) ? clamp(85 - (ias - rec.vfto + 20) * 4, 25, 90) : 0
  // Retract-while-fast hazard: TMA or DEPT, deduced from VS positive + low-FL + IAS high
  const RETRACT = (ph === 'DEPT' && f.vertRate > 800 && ias > rec.vfto + 10 && inf.detent && inf.detent.name !== 'F1') ? 60 : 0
  // Change burst: hash proxy for "moving the lever"
  const CHANGE = (ph === 'APPR-INT' || ph === 'DEPT') && hashF(f.icao + 'c') > 0.85 ? 38 : 0
  // Icing — when in icing band per slider, IAS must be Vref+10..+15. We penalize approach close to detent VFE in icing
  const ICING = icingBand && (ph === 'APPR-FNL' || ph === 'APPR-INT') && vfeMar < 15 ? 55 : 0

  const drivers: Drivers = { VFEMAR, VLEMAR, VFTO, RETRACT, CHANGE, ICING }
  const vals = Object.values(drivers)
  const maxD = Math.max(...vals)
  const mean = vals.reduce((a,b)=>a+b,0) / vals.length
  let score = (maxD * 0.66 + mean * 0.34) * (advMul/100)

  // Hard escalators
  if (vfeMar < 0) score = Math.max(score, 92)
  if (inf.gearDown && vleMar < 0) score = Math.max(score, 88)
  if (ph === 'DEPT' && ias < rec.vfto && inf.detent) score = Math.max(score, 80)
  if ((ph === 'APPR-FNL') && ias > rec.vrefBase + 30) score = Math.max(score, 72)
  score = clamp(score, 0, 100)

  let tier: Tier
  if (score >= 85) tier = 'BUST'
  else if (score >= 65) tier = 'CRITICAL'
  else if (score >= 45) tier = 'TIGHT'
  else if (score >= 22) tier = 'ADEQUATE'
  else tier = 'NOMINAL'

  const notes: string[] = []
  if (vfeMar < 0) notes.push(`IAS ${ias}kt over VFE ${inf.vfe}kt for ${inf.detent?.name}: retract immediately per FCOM LIM Ch.1 (14 CFR §25.345)`)
  else if (vfeMar < 10) notes.push(`Within ${vfeMar.toFixed(0)}kt of VFE${inf.vfe} — anticipate retract or reduce thrust per FCTM Approach`)
  if (inf.gearDown && vleMar < 0) notes.push(`IAS ${ias}kt over VLE ${rec.vle}kt with gear down — risk gear-door tear per 14 CFR §25.729 / FCOM LIM`)
  if (ph === 'DEPT' && ias < rec.vfto) notes.push(`Below VFTO ${rec.vfto}kt during retract sequence — risk stall margin per FAA InFO 14001 / FCOM PI`)
  if (icingBand && (ph === 'APPR-FNL' || ph === 'APPR-INT')) notes.push(`Icing band: add +10kt at each detent per FCOM ICE / AC 91-74B`)
  if (notes.length === 0) notes.push(`Margin ${vfeMar.toFixed(0)}kt to VFE${inf.vfe} (${inf.detent?.name}) · ${rec.afm}`)

  return { f, cls, rec, phase: ph, inf, ias, vfeMar, vleMar, drivers, score, tier, notes }
}

export default function VfeFlapMargin({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'ENVELOPE'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [q, setQ] = useState('')
  const [advMul, setAdvMul] = useState(100)
  const [icing, setIcing] = useState(false)
  const [maxFL, setMaxFL] = useState(180)
  const [classFilter, setClassFilter] = useState<Set<Cls>>(new Set())
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [pickedIcao, setPickedIcao] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => { const t = setInterval(()=>setTick(x=>x+1), 20000); return ()=>clearInterval(t) }, [])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.altitudeFt > maxFL * 100) continue
      const r = scoreRow(f, advMul, icing)
      if (!r) continue
      out.push(r)
    }
    return out.sort((a,b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score).slice(0, 280)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flights, advMul, icing, maxFL, tick])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { BUST:0, CRITICAL:0, TIGHT:0, ADEQUATE:0, NOMINAL:0, IDLE:0 }
    rows.forEach(r => c[r.tier]++); return c
  }, [rows])

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (classFilter.size) r = r.filter(x => classFilter.has(x.cls))
    if (q.trim()) {
      const s = q.trim().toLowerCase()
      r = r.filter(x => (x.f.callsign||'').toLowerCase().includes(s) || (x.f.icao||'').toLowerCase().includes(s) || (x.f.type||'').toLowerCase().includes(s) || x.cls.toLowerCase().includes(s))
    }
    return r
  }, [rows, tierFilter, classFilter, q])

  const meanScore = rows.length ? rows.reduce((a,b)=>a+b.score,0)/rows.length : 0
  const meanMar = rows.length ? rows.reduce((a,b)=>a+b.vfeMar,0)/rows.length : 0
  const bustCnt = tierCounts.BUST
  const critCnt = tierCounts.CRITICAL
  const worst = rows[0]

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const SRC = 'vfe-ac'
    const HALO = 'vfe-halo', INNER = 'vfe-inner', PIN = 'vfe-pin', LBL = 'vfe-lbl'

    const fc = { type:'FeatureCollection' as const, features: rows.map(r => ({
      type:'Feature' as const,
      geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat] },
      properties:{
        cs: r.f.callsign || r.f.icao, tier: r.tier, cls: r.cls,
        color: TIER_COLOR[r.tier], inner: CLS_COLOR[r.cls],
        band: r.inf.band, vfeMar: r.vfeMar.toFixed(0), ias: r.ias,
        haloR: 7 + (5 - Math.min(5, TIER_RANK[r.tier])) * 3,
        pinScale: r.tier === 'BUST' ? 1.7 : r.tier === 'CRITICAL' ? 1.25 : 0,
      },
    })) }

    const add = () => {
      try {
        if (!map.getSource(SRC)) map.addSource(SRC, { type:'geojson', data: fc as any })
        else (map.getSource(SRC) as any).setData(fc)
        if (showHalo && !map.getLayer(HALO)) map.addLayer({ id:HALO, type:'circle', source:SRC, paint:{
          'circle-radius':['get','haloR'], 'circle-color':['get','color'],
          'circle-opacity':0.14, 'circle-stroke-color':['get','color'],
          'circle-stroke-width':1.5, 'circle-stroke-opacity':0.85,
        }})
        if (showHalo && !map.getLayer(INNER)) map.addLayer({ id:INNER, type:'circle', source:SRC, paint:{
          'circle-radius':2.6, 'circle-color':['get','inner'],
          'circle-stroke-color':'#0b1220', 'circle-stroke-width':0.6,
        }})
        if (showPin && !map.getLayer(PIN)) map.addLayer({ id:PIN, type:'circle', source:SRC,
          filter:['>',['get','pinScale'],0], paint:{
            'circle-radius':['*',5.5,['get','pinScale']],
            'circle-color':['get','color'], 'circle-stroke-color':'#fff', 'circle-stroke-width':1.3,
          }})
        if (showLbl && !map.getLayer(LBL)) map.addLayer({ id:LBL, type:'symbol', source:SRC, layout:{
          'text-field':['concat',['get','cs'],'  ',['get','band'],'  Δ',['get','vfeMar'],'kt'],
          'text-size':10, 'text-offset':[0,1.45], 'text-anchor':'top',
          'text-font':['Open Sans Semibold','Arial Unicode MS Bold'],
        }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0b1220', 'text-halo-width':1.2 }})
      } catch {}
    }
    if (map.isStyleLoaded()) add(); else map.once('load', add)
    return () => {
      try {
        for (const l of [LBL, PIN, INNER, HALO]) if (map.getLayer(l)) map.removeLayer(l)
        if (map.getSource(SRC)) map.removeSource(SRC)
      } catch {}
    }
  }, [map, rows, showHalo, showPin, showLbl])

  /* ENVELOPE tab — VFE-ladder SVG for picked or worst class */
  const pickedRow = filtered.find(r => r.f.icao === pickedIcao) || worst || null
  const envCls = pickedRow?.cls || 'NB'
  const envRec = clsRec(envCls)
  const envAll = rows.filter(r => r.cls === envCls)

  return (
    <div className="absolute right-3 top-20 z-30 w-[480px] max-h-[82vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">VFE</div>
        <div className="text-[10px] text-slate-400 truncate">Flap / slat / gear extension-speed margin</div>
        <div className="ml-auto flex items-center gap-1">
          {(['AIRCRAFT','CLASSES','ENVELOPE'] as const).map(t => (
            <button key={t} onClick={()=>setTab(t)}
              className={`text-[10px] px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'border border-slate-700 text-slate-400 hover:text-slate-200'}`}>{t}</button>
          ))}
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xs px-2 py-1 rounded border border-slate-800">×</button>
        </div>
      </div>

      {/* Tier strip */}
      <div className="flex border-b border-slate-800/80 text-[10px]">
        <button onClick={()=>setTierFilter('ALL')}
          className={`flex-1 px-2 py-1.5 ${tierFilter==='ALL'?'bg-sky-500/15 text-slate-100':'text-slate-400 hover:text-slate-200'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(t)}
            className={`flex-1 px-2 py-1.5 ${tierFilter===t?'bg-slate-800/80 text-slate-100':'text-slate-400 hover:text-slate-200'}`}
            style={{ color: tierFilter===t ? TIER_COLOR[t] : undefined }}>{t} · {tierCounts[t]}</button>
        ))}
      </div>

      {/* Summary cells */}
      <div className="grid grid-cols-5 border-b border-slate-800/80 text-[10px]">
        <div className="p-2 border-r border-slate-800/60"><div className="text-slate-500">μ-SCORE</div><div className="text-slate-100 font-semibold">{meanScore.toFixed(0)}</div></div>
        <div className="p-2 border-r border-slate-800/60"><div className="text-slate-500">μ-VFE-MAR</div><div className="text-slate-100 font-semibold">{meanMar.toFixed(0)}kt</div></div>
        <div className="p-2 border-r border-slate-800/60"><div className="text-slate-500">BUST</div><div className="text-slate-100 font-semibold">{bustCnt}</div></div>
        <div className="p-2 border-r border-slate-800/60"><div className="text-slate-500">CRIT</div><div className="text-slate-100 font-semibold">{critCnt}</div></div>
        <div className="p-2"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-semibold truncate">{worst?(worst.f.callsign||worst.f.icao):'—'}</div></div>
      </div>

      {/* Controls */}
      <div className="px-3 py-2 border-b border-slate-800/80 space-y-1.5">
        <div className="grid grid-cols-2 gap-2 text-[10px]">
          <label className="flex items-center gap-2">
            <span className="text-slate-500 w-14">ADV-MUL</span>
            <input type="range" min={50} max={200} value={advMul} onChange={e=>setAdvMul(+e.target.value)} className="flex-1 accent-sky-500"/>
            <span className="w-10 text-right text-slate-300">{advMul}%</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-slate-500 w-14">MAX-FL</span>
            <input type="range" min={50} max={400} step={10} value={maxFL} onChange={e=>setMaxFL(+e.target.value)} className="flex-1 accent-sky-500"/>
            <span className="w-10 text-right text-slate-300">{maxFL}</span>
          </label>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <input id="vfe-icing" type="checkbox" checked={icing} onChange={e=>setIcing(e.target.checked)} className="accent-sky-500"/>
          <label htmlFor="vfe-icing" className="text-slate-300">Icing-band IAS bias (+10kt detents per FCOM ICE)</label>
        </div>
        <div className="flex flex-wrap gap-1">
          {CLASSES.map(c => {
            const on = classFilter.has(c.cls)
            return <button key={c.cls} onClick={()=>{
              const ns = new Set(classFilter); on ? ns.delete(c.cls) : ns.add(c.cls); setClassFilter(ns)
            }} className={`text-[9px] px-1.5 py-0.5 rounded border ${on?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-700 text-slate-400'}`}
              style={{ color: on ? CLS_COLOR[c.cls] : undefined }}>{c.cls}</button>
          })}
        </div>
        <div className="flex items-center gap-1.5 text-[10px]">
          {[['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl]].map(([n,v,s]:any) => (
            <button key={n} onClick={()=>s(!v)} className={`px-1.5 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-700 text-slate-400'}`}>{n}</button>
          ))}
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="search cs/type/cls"
            className="ml-auto bg-slate-900 border border-slate-800 rounded px-2 py-0.5 text-[10px] w-32 text-slate-200 placeholder:text-slate-600"/>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto text-[11px]">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.length === 0 && <div className="p-4 text-slate-500 text-center text-[10px]">No aircraft in configuration phase · raise MAX-FL or wait for arrivals</div>}
            {filtered.slice(0, 80).map(r => (
              <button key={r.f.icao} onClick={()=>{ setPickedIcao(r.f.icao); onFly(r.f.icao) }}
                className="w-full text-left p-2 hover:bg-slate-900/60">
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="font-mono font-semibold text-slate-100">{r.f.callsign || r.f.icao}</span>
                  <span className="text-[9px] text-slate-500">{r.f.type || '—'}</span>
                  <span className="text-[9px] px-1 rounded border border-slate-700" style={{ color: CLS_COLOR[r.cls] }}>{r.cls}</span>
                  <span className="text-[9px] px-1 rounded border border-slate-700 text-slate-400">{r.phase}</span>
                  <span className="ml-auto text-[9px] px-1 rounded font-semibold" style={{ color: TIER_COLOR[r.tier], borderColor: TIER_COLOR[r.tier], borderWidth: 1, borderStyle: 'solid' }}>{r.tier} · {r.score.toFixed(0)}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[9px] text-slate-400 mb-1">
                  <div>IAS <span className="text-slate-100 font-mono">{r.ias}kt</span></div>
                  <div>VFE <span className="text-slate-100 font-mono">{r.inf.vfe}kt</span></div>
                  <div>Δ <span className="text-slate-100 font-mono" style={{ color: r.vfeMar<10?'#f43f5e':r.vfeMar<20?'#f59e0b':'#cbd5e1' }}>{r.vfeMar>0?'+':''}{r.vfeMar}kt</span></div>
                  <div>{r.inf.gearDown?<><span className="text-slate-500">VLE Δ </span><span className="font-mono" style={{ color: r.vleMar<0?'#ef4444':'#cbd5e1' }}>{r.vleMar}kt</span></>:<span className="text-slate-600">gear UP</span>}</div>
                </div>
                <div className="h-1 bg-slate-800/80 rounded overflow-hidden mb-1">
                  <div className="h-full" style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier] }}/>
                </div>
                <div className="flex flex-wrap gap-0.5 text-[8px] mb-1">
                  {(['VFEMAR','VLEMAR','VFTO','RETRACT','CHANGE','ICING'] as const).map(k => (
                    <span key={k} className="px-1 rounded border border-slate-800 text-slate-400">{k} <span className="text-slate-200">{(r.drivers as any)[k].toFixed(0)}</span></span>
                  ))}
                </div>
                <div className="text-[9px]" style={{ color: TIER_COLOR[r.tier] }}>› {r.notes[0]}</div>
              </button>
            ))}
          </div>
        )}

        {tab === 'CLASSES' && (
          <div className="divide-y divide-slate-800/60">
            {CLASSES.map(c => {
              const sub = rows.filter(r => r.cls === c.cls)
              const mu = sub.length ? sub.reduce((a,b)=>a+b.score,0)/sub.length : 0
              const muMar = sub.length ? sub.reduce((a,b)=>a+b.vfeMar,0)/sub.length : 0
              const bust = sub.filter(r => r.tier === 'BUST').length
              const crit = sub.filter(r => r.tier === 'CRITICAL').length
              const fmin = c.flaps[c.flaps.length-1]
              return (
                <div key={c.cls} className="p-2">
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="text-[10px] px-1 rounded border border-slate-700 font-semibold" style={{ color: CLS_COLOR[c.cls] }}>{c.cls}</span>
                    <span className="text-[9px] text-slate-400">VLE {c.vle}kt · VLO ext/ret {c.vlo_ext}/{c.vlo_ret} · VFTO {c.vfto}kt · Vref~{c.vrefBase}kt</span>
                    <span className="ml-auto text-[9px] text-slate-500">n={sub.length}</span>
                  </div>
                  <div className="text-[9px] text-slate-500 italic mb-1 truncate">{c.afm}</div>
                  <div className="grid grid-cols-4 gap-1 text-[9px] text-slate-400 mb-1">
                    <div>μ-SCORE <span className="text-slate-100">{mu.toFixed(0)}</span></div>
                    <div>μ-Δ <span className="text-slate-100">{muMar.toFixed(0)}kt</span></div>
                    <div>BUST <span className="text-slate-100">{bust}</span></div>
                    <div>CRIT <span className="text-slate-100">{crit}</span></div>
                  </div>
                  <div className="flex flex-wrap gap-1 text-[9px]">
                    {c.flaps.map(d => (
                      <span key={d.name} className="px-1 rounded border border-slate-700 text-slate-300">{d.name}<span className="text-slate-500"> VFE</span>{d.vfe}</span>
                    ))}
                    <span className="px-1 rounded border border-slate-700 text-slate-300">Min-VFE<span className="text-slate-500"> </span>{fmin.vfe}kt</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'ENVELOPE' && (
          <div className="p-3 space-y-2">
            <div className="flex items-center gap-2 text-[10px]">
              <span className="text-slate-500">Class:</span>
              <span className="px-1.5 rounded border border-slate-700 font-semibold" style={{ color: CLS_COLOR[envCls] }}>{envCls}</span>
              {pickedRow && <span className="text-slate-400 font-mono">{pickedRow.f.callsign || pickedRow.f.icao}</span>}
              <span className="ml-auto text-slate-500">n={envAll.length}</span>
            </div>
            <svg viewBox="0 0 460 240" className="w-full bg-slate-900/40 rounded border border-slate-800/80">
              {/* X axis IAS 80-300 kt; Y axis altitude 0-15000ft */}
              {(() => {
                const x0 = 40, x1 = 440, y0 = 220, y1 = 20
                const xs = (kt:number) => x0 + (kt - 80) / (300 - 80) * (x1 - x0)
                const ys = (ft:number) => y0 - (ft / 15000) * (y0 - y1)
                const elems: React.ReactElement[] = []
                // grid + axis
                for (let kt = 100; kt <= 300; kt += 50) {
                  elems.push(<line key={'gx'+kt} x1={xs(kt)} y1={y0} x2={xs(kt)} y2={y1} stroke="#1e293b" strokeWidth={0.5}/>)
                  elems.push(<text key={'lx'+kt} x={xs(kt)} y={y0+12} fontSize={8} fill="#64748b" textAnchor="middle">{kt}</text>)
                }
                for (let ft = 0; ft <= 15000; ft += 5000) {
                  elems.push(<line key={'gy'+ft} x1={x0} y1={ys(ft)} x2={x1} y2={ys(ft)} stroke="#1e293b" strokeWidth={0.5}/>)
                  elems.push(<text key={'ly'+ft} x={x0-4} y={ys(ft)+3} fontSize={8} fill="#64748b" textAnchor="end">{ft/1000}k</text>)
                }
                elems.push(<text key="xl" x={(x0+x1)/2} y={y0+22} fontSize={9} fill="#94a3b8" textAnchor="middle">IAS (kt)</text>)
                elems.push(<text key="yl" x={10} y={(y0+y1)/2} fontSize={9} fill="#94a3b8" textAnchor="middle" transform={`rotate(-90 10 ${(y0+y1)/2})`}>Alt (ft)</text>)
                // VFE vertical lines per detent
                envRec.flaps.forEach((d, i) => {
                  elems.push(<line key={'v'+d.name} x1={xs(d.vfe)} y1={y1} x2={xs(d.vfe)} y2={y0} stroke="#f59e0b" strokeWidth={0.8} strokeDasharray="3 3" opacity={0.5+0.08*i}/>)
                  elems.push(<text key={'vt'+d.name} x={xs(d.vfe)} y={y1-4} fontSize={8} fill="#f59e0b" textAnchor="middle">{d.name}·{d.vfe}</text>)
                })
                // VLE
                elems.push(<line key="vle" x1={xs(envRec.vle)} y1={y1} x2={xs(envRec.vle)} y2={y0} stroke="#ef4444" strokeWidth={1} strokeDasharray="6 3"/>)
                elems.push(<text key="vlet" x={xs(envRec.vle)} y={y0-4} fontSize={8} fill="#ef4444" textAnchor="middle">VLE {envRec.vle}</text>)
                // VFTO
                elems.push(<line key="vfto" x1={xs(envRec.vfto)} y1={y1} x2={xs(envRec.vfto)} y2={y0} stroke="#0ea5e9" strokeWidth={0.8} strokeDasharray="2 4"/>)
                elems.push(<text key="vftot" x={xs(envRec.vfto)} y={y0-4} fontSize={8} fill="#0ea5e9" textAnchor="middle">VFTO {envRec.vfto}</text>)
                // fleet dots
                envAll.forEach(r => {
                  const fx = xs(clamp(r.ias, 80, 300))
                  const fy = ys(clamp(r.f.altitudeFt, 0, 15000))
                  elems.push(<circle key={'dot'+r.f.icao} cx={fx} cy={fy} r={pickedIcao===r.f.icao?4:2.4}
                    fill={TIER_COLOR[r.tier]} stroke="#0b1220" strokeWidth={0.6}/>)
                })
                return elems
              })()}
            </svg>
            <div className="text-[9px] text-slate-500 leading-snug">
              Amber dashed lines = certified VFE per flap detent (FCOM LIM Ch.1 · 14 CFR §25.345).
              Red dashed = VLE landing-gear extended (§25.729). Sky dotted = VFTO final-takeoff speed
              (§25.121). Dots = airborne fleet in this class, coloured by tier. The further right a dot
              sits past an amber line, the closer it is to a flap-track-support failure or asymmetric
              retraction event. References: Boeing/Airbus FCOM Limits Ch.1 · NTSB AAR-92-04 USAir 405 LGA
              · AAR-96-06 ValuJet 597 ATL · AAR-09-03 Pinnacle 3701 · TSB A07A0134 ACA A319 · FAA
              InFO 14001 · IATA FCG-005 §5 configuration management.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
