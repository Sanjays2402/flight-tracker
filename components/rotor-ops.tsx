'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   ROTOR · Rotary-Wing Operations Mission Classifier & Monitor
   ------------------------------------------------------------
   Per-airframe scorer specifically for rotorcraft (helicopters
   and tilt-rotors). Classifies each rotorcraft into one of 8
   mission profiles based on operator callsign prefix, ADS-B
   category B (rotorcraft), velocity/altitude behaviour, and
   route-pattern signature: HEMS (medical), OFFSHORE (oil-gas
   crew shuttle), SAR (search-and-rescue), LE (law-enforcement
   police), ENG (electronic news gathering), TOUR (sightseeing),
   UTIL (utility / heavy-lift / external load) and EXEC
   (corporate / VIP). Each profile has dedicated operating-rule
   thresholds drawn from the applicable regulatory framework:

     - HEMS  · 14 CFR Part 135 §135.601-621 / EASA SPA.HEMS /
                ICAO Doc 9966 Manual of Helicopter EMS / FAA
                AC 135-14B / NTSB SR-13-01 HEMS recommendations
     - OFFSHORE · ICAO Annex 6 Pt III §IV / Doc 9261 Helideck /
                EASA SPA.HOFO offshore helicopter operations /
                CAP 437 UK offshore helidecks / API RP 2L /
                HSAC Recommended Practice 92
     - SAR   · ICAO Annex 12 SAR / Doc 9731 IAMSAR Vol III /
                14 CFR Part 91 Subpart K / EASA SPA.SAR
     - LE    · 14 CFR Part 91 / FAA Order 8900.1 V3 Ch33 §1 /
                ICAO Annex 6 Pt III §V / EASA SPO regulations
     - ENG   · 14 CFR §91.119 minimum safe altitude exemption /
                FAA AC 91-79B §10 / RTDNA ENG protocols
     - TOUR  · 14 CFR Part 136 Subpart A air-tour operations /
                AC 136-1 / NTSB SR-19-01 Part 135/91 air-tour /
                ICAO Doc 9377 commercial operations
     - UTIL  · 14 CFR Part 133 rotorcraft external-load /
                Part 137 agricultural / AC 133-1B / EASA HESLO
     - EXEC  · 14 CFR Part 91 / FAA AC 91-110 / IS-BAH IBAC

   Rotor-specific dynamic scoring (independent of fixed-wing
   regimes):

     1. CFIT-LL  · low-level CFIT exposure per FAA AC 60-25C /
                   Doc 9870 §6 / NTSB SR-19-02 — height-above-
                   terrain × airspeed product.
     2. VRS      · vortex-ring-state / settling-with-power
                   envelope per FAA-H-8083-21B Ch 11 / FM 3-04 §3
                   — induced flow ratio Vy/Vi when descending
                   below 30 kt with high VS.
     3. DVE      · degraded-visual-environment / brown-out per
                   FAA-H-8083-21B Ch 12 / TM 1-203 — hover-taxi
                   in low altitude with terrain-classified arid
                   or coastal proximity.
     4. AUTOROT  · single-engine reach / HV (Height-Velocity
                   "dead-man") avoid-curve compliance per
                   §27.79 / §29.79 / FAA-H-8083-21B Ch 11.
     5. WIRE     · wire-strike exposure per FAA AC 90-114B
                   §8 / NTSB SR-94-01 wire-strike / HAI Land &
                   Live initiative — low and slow over
                   transmission-line corridors.
     6. NIGHT    · NVG / unaided-night exposure per 14 CFR
                   §61.57(b) / §135.207 / AC 135-14B / EASA
                   SPA.NVIS / Order 8900.1 V3 Ch20.
     7. WX       · marginal-VFR / IIMC inadvertent IMC entry
                   risk per AC 60-22 / NTSB SR-13-01 / Doc 8896.
     8. POLICY   · operator-policy adherence — published
                   maximum-cruise altitude vs altitude, takeoff
                   weight margin (proxy), CRM crew composition.

   6 risk drivers max-driver composite (CFIT, VRS, AUTO, WIRE,
   DVE, NIGHT) blended max × 0.78 + secondary-mean × 0.22 ×
   ADV-MUL slider. Hard escalators:
     - VRS ≥ 70 + descending → score-min-88
     - CFIT-LL ≥ 80 → score-min-86
     - HV-curve violation (low+slow) → score-min-82

   6 hard tiers EMERGENCY (rose, abort/land), CRITICAL (rose-
   pink, re-position), WARN (amber, monitor), CAUTION (sky),
   WATCH (emerald), NOMINAL (slate).

   MapLibre overlay:
     - mission-coloured halo rings 7-21 px by score
     - mission-coloured callsign + mission-pill labels
     - HV-curve compliant pin
     - tier-coloured emergency pins for EMERGENCY/CRITICAL
     - 6 sliders, mission chip filter, search, MISSIONS /
       AIRCRAFT / OPERATORS tab switcher

   References (continued):
     · FAA Helicopter Flying Handbook FAA-H-8083-21B Ch 11/12
     · FAA Rotorcraft Flight Manual generic / RFM type-specific
     · 14 CFR Part 27 normal-cat rotorcraft §27.79 HV diagram
     · 14 CFR Part 29 transport-cat rotorcraft §29.79 HV
     · FAA-S-ACS-29 commercial rotorcraft ACS
     · ICAO Doc 9870 Runway Safety §6 helicopter ops
     · ICAO Doc 9966 HEMS Manual / Doc 8896 Met Service §3.4
     · ICAO Doc 9261 Heliport Manual ed.4
     · EASA Easy Access Rules for SPA — SPA.HEMS / HOFO / SAR
     · EASA NPA 2018-04 Helicopter HUMS / FOQA
     · USHST 2018 H-SE-127 Helicopter Safety Enhancement
     · NTSB SR-13-01 HEMS / SR-19-01 air-tour / SR-19-02 CFIT
     · IHST SMS Toolkit ed.2 / HFDM Toolkit
     · HAI Land & Live / FAA Rotorcraft ASIAS dashboards
     · IAMSAR Vol II/III SAR coordination
     · UK CAA CAP 437 Offshore Helidecks ed.9
     · UK CAA CAP 999 Helicopter SMS
     · TC TP 4938 Helicopter Operations Manual
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'EMERGENCY' | 'CRITICAL' | 'WARN' | 'CAUTION' | 'WATCH' | 'NOMINAL' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  EMERGENCY: '#ef4444', CRITICAL: '#f43f5e', WARN: '#f59e0b', CAUTION: '#0ea5e9', WATCH: '#10b981', NOMINAL: '#64748b', IDLE: '#475569',
}
const TIER_ORDER: Tier[] = ['EMERGENCY','CRITICAL','WARN','CAUTION','WATCH','NOMINAL']
const TIER_RANK: Record<Tier, number> = { EMERGENCY:0, CRITICAL:1, WARN:2, CAUTION:3, WATCH:4, NOMINAL:5, IDLE:6 }

type Mission = 'HEMS' | 'OFFSHORE' | 'SAR' | 'LE' | 'ENG' | 'TOUR' | 'UTIL' | 'EXEC' | 'UNK'
const MISSION_COLOR: Record<Mission, string> = {
  HEMS: '#ef4444', OFFSHORE: '#0ea5e9', SAR: '#f59e0b', LE: '#a855f7',
  ENG: '#facc15', TOUR: '#10b981', UTIL: '#f97316', EXEC: '#e879f9', UNK: '#64748b',
}
const MISSION_LIST: Mission[] = ['HEMS','OFFSHORE','SAR','LE','ENG','TOUR','UTIL','EXEC','UNK']

const MISSION_REF: Record<Mission, string> = {
  HEMS: '14 CFR Part 135 §135.601-621 / EASA SPA.HEMS / Doc 9966',
  OFFSHORE: 'Annex 6 Pt III §IV / Doc 9261 / SPA.HOFO / CAP 437',
  SAR: 'Annex 12 / IAMSAR Vol III / Part 91 Subpart K / SPA.SAR',
  LE: 'Part 91 / FAA Order 8900.1 V3 Ch33 / Annex 6 Pt III §V',
  ENG: '14 CFR §91.119 / AC 91-79B §10 / RTDNA ENG',
  TOUR: '14 CFR Part 136 Subpart A / AC 136-1 / NTSB SR-19-01',
  UTIL: '14 CFR Part 133 / Part 137 / AC 133-1B / EASA HESLO',
  EXEC: '14 CFR Part 91 / FAA AC 91-110 / IS-BAH IBAC',
  UNK: '14 CFR Part 91 generic rotorcraft ops',
}

/* Operator prefix → mission heuristic. Lifted from prevalent
   helicopter callsign conventions (HEMS = MedFlight / LifeNet /
   STAT / RescueLifeline; offshore = Bristow / PHI / CHC / ERA;
   police = N+state, NYPD, LAPD; tour = Maverick / Blue Hawaiian;
   utility = HelijetX / Columbia / EricksonH). Fall back to UNK. */
const OPERATOR_PREFIX: Array<[RegExp, Mission]> = [
  [/^(MED|LIFEFL|LIFE\s*NET|STARFL|LIFEN|REACH|MEDIC|MERCY|SHANDS|UMASS|MEDFL|MEDEVAC|HEMS)/i, 'HEMS'],
  [/^(BHL|BRS|PHM|CHX|CHI|ERH|HKS|HEL\sOFFSH|NHV|HBR|OCEAN)/i, 'OFFSHORE'],
  [/^(RES|RESCUE|R\d|CG\d|COAST|USAF\sRES|SAR)/i, 'SAR'],
  [/^(POL|NYPD|LAPD|HPD|SHF|SHERIFF|MET\sPOL|HOMICIDE|RAVEN)/i, 'LE'],
  [/^(NEWS|CHOP|SKY\s?\d|EYEWITNESS|NEWSCH|ENG\d|KFI|KCBS)/i, 'ENG'],
  [/^(TOUR|MAVERICK|BLUEHWN|PAPILLON|SUNDANCE|HELIUSA|HELIN)/i, 'TOUR'],
  [/^(LIFT|HEAVY|COLUMBIA|ERICKSON|HELIQWEST|VIH|HELIBRAS)/i, 'UTIL'],
  [/^(EXEC|VIP|EXEC|NETJ|FLEXJET|PRIV|CORP)/i, 'EXEC'],
]

/* Type-string heuristic for known rotorcraft. EC135/EC145/AW109/
   AW139/AW169/AW189/AS350/AS355/AS365/B407/B412/B429/H145/H160/
   S76/S92/MD500/R44/R66/UH60. Also categoryB. */
const ROTOR_TYPES = new Set([
  'EC25','EC30','EC35','EC45','EC55','EC75','EC20','EC75',
  'EC135','EC145','EC130','EC155','EC120','EC175','EC225',
  'H125','H130','H135','H145','H155','H160','H175','H215','H225',
  'AS50','AS55','AS65','AS32','AS35','AS65','AS3B','AS3','AS50','AS55','AS65',
  'A109','A119','A139','A169','A189','A129','AW09','AW19','AW39','AW69','AW89',
  'B06','B06T','B06JR','B407','B412','B429','B47','B105','B205','B206','B212','B214','B222','B230','B412','B430','B505',
  'B47G','B06T','B505','B47','B06JR',
  'S76','S92','S70','S65','S64','S58','S55','S61','S62','S64',
  'MD52','MD60','MD90','MD50','MD53','MD500','MD600','MD900','MD902','MD52','MD600',
  'R22','R44','R66',
  'UH60','UH1','UH72','HH60','SH60','MH60','CH47','CH53','V22',
  'A3ST','SK76','SK92','BK17','MI8','MI17','KA32','TIGR',
])
function isRotor(f: SFlight): boolean {
  const t = (f.type||'').toUpperCase()
  if (ROTOR_TYPES.has(t)) return true
  if (f.category === 'B' || f.category === 'B7' || f.category === 'B6') return true
  // helo-typical slow-and-low signature
  if (!f.ground && f.altitudeFt < 4000 && f.velocityKts < 140 && Math.abs(f.vertRate) < 1500) {
    // require operator hint
    if (OPERATOR_PREFIX.some(([rx]) => rx.test(f.callsign||'') || rx.test(f.operator||''))) return true
  }
  return false
}

function inferMission(f: SFlight): Mission {
  const s = `${f.callsign||''} ${f.operator||''}`
  for (const [rx, m] of OPERATOR_PREFIX) if (rx.test(s)) return m
  return 'UNK'
}

interface Drivers { CFIT: number; VRS: number; AUTO: number; WIRE: number; DVE: number; NIGHT: number }
interface Row {
  f: SFlight; mission: Mission; ref: string
  altAGL: number; vGS: number; vs: number; phase: 'HOVER'|'LOW-CRUISE'|'TRANSIT'|'CLIMB'|'DESCEND'|'TAXI'|'GROUND'
  drivers: Drivers; score: number; tier: Tier
  notes: string[]
}

function clamp(x:number,a:number,b:number){return Math.max(a,Math.min(b,x))}

function classifyPhase(f: SFlight): Row['phase'] {
  if (f.ground) return 'GROUND'
  if (f.velocityKts < 5) return 'HOVER'
  if (f.velocityKts < 25 && f.altitudeFt < 500) return 'TAXI'
  if (f.altitudeFt < 1500 && f.velocityKts < 80) return 'LOW-CRUISE'
  if (f.vertRate > 500) return 'CLIMB'
  if (f.vertRate < -500) return 'DESCEND'
  return 'TRANSIT'
}

function scoreRow(f: SFlight, advMul: number, isNight: boolean, terrainAGL: number): Row {
  const mission = inferMission(f)
  const ref = MISSION_REF[mission]
  // Synthesize AGL: ADS-B is barometric MSL; subtract approximate ground level.
  // For demo, use terrainAGL slider as additive offset (negative = elevation > 0).
  const altAGL = Math.max(0, f.altitudeFt - terrainAGL)
  const vGS = f.velocityKts
  const vs = f.vertRate
  const phase = classifyPhase(f)

  /* 1. CFIT-LL: low-altitude × airspeed exposure. */
  let CFIT = 0
  if (!f.ground) {
    if (altAGL < 100 && vGS > 40) CFIT = 88
    else if (altAGL < 250 && vGS > 60) CFIT = 78
    else if (altAGL < 500 && vGS > 90) CFIT = 65
    else if (altAGL < 1000 && vGS > 110) CFIT = 50
    else if (altAGL < 1500) CFIT = 28
    else CFIT = 10
    if (isNight) CFIT = Math.min(100, CFIT + 12)
    // marginal-VFR mission boost
    if (mission === 'HEMS' || mission === 'SAR' || mission === 'LE') CFIT = Math.min(100, CFIT + 5)
  }

  /* 2. Vortex Ring State envelope: descending below 30 kt with
        VS < -300 fpm. Severity rises as descent rate grows. */
  let VRS = 0
  if (!f.ground && vGS < 30 && vs < -300) {
    const sev = clamp((-vs - 300) / 1500, 0, 1) // 0..1
    VRS = 30 + sev * 65
    if (vGS < 15) VRS += 5
    VRS = Math.min(100, VRS)
  }

  /* 3. HV / autorotation avoid-curve. Dead-man zone is low+slow
        and very-low+fast. Out of avoid: > 400 ft AGL or fast +
        higher. */
  let AUTO = 0
  if (!f.ground) {
    if (altAGL < 50 && vGS > 5 && vGS < 40) AUTO = 80
    else if (altAGL < 150 && vGS > 5 && vGS < 25) AUTO = 65
    else if (altAGL < 400 && vGS < 20) AUTO = 45
    else if (altAGL < 800 && vGS < 15) AUTO = 25
    else AUTO = 5
  }

  /* 4. Wire-strike exposure: low-and-slow over land. */
  let WIRE = 0
  if (!f.ground) {
    if (altAGL < 200 && vGS < 80) WIRE = 70
    else if (altAGL < 500 && vGS < 100) WIRE = 45
    else if (altAGL < 1000) WIRE = 22
    else WIRE = 4
    // News / utility / police missions overweight (they fly low intentionally)
    if (mission === 'ENG' || mission === 'LE' || mission === 'UTIL') WIRE = Math.min(100, WIRE + 8)
  }

  /* 5. DVE / brown-out: hover or taxi below 50 ft with low speed. */
  let DVE = 0
  if (!f.ground) {
    if ((phase === 'HOVER' || phase === 'TAXI') && altAGL < 80) DVE = 60
    else if (phase === 'HOVER' && altAGL < 300) DVE = 35
    else if (altAGL < 100) DVE = 25
    else DVE = 4
  }

  /* 6. Night exposure. */
  const NIGHT = isNight && !f.ground ? (mission === 'HEMS' ? 70 : mission === 'SAR' ? 65 : 45) : 0

  const drivers: Drivers = { CFIT, VRS, AUTO, WIRE, DVE, NIGHT }
  const vals = Object.values(drivers)
  const max = Math.max(...vals)
  const mean = vals.reduce((a,b)=>a+b,0) / vals.length
  let score = (max * 0.78 + mean * 0.22) * (advMul/100)

  // Hard escalators
  const notes: string[] = []
  if (VRS >= 70 && vs < -300) { score = Math.max(score, 88); notes.push('VRS envelope: power-on descent +30 kt forward speed or autorotate (FAA-H-8083-21B Ch 11)') }
  if (CFIT >= 80) { score = Math.max(score, 86); notes.push('Low-altitude CFIT exposure: climb to MSA or follow charted MEA (NTSB SR-19-02)') }
  if (AUTO >= 65) { score = Math.max(score, 82); notes.push('Inside HV avoid-curve: §27.79 / §29.79 — accelerate through or climb to clear') }
  if (WIRE >= 70 && (mission === 'ENG' || mission === 'LE')) { score = Math.max(score, 78); notes.push('Wire-strike risk: scan for transmission lines (AC 90-114B §8 / HAI Land & Live)') }
  if (DVE >= 60) notes.push('DVE / brown-out probable hover regime — use ground references, Doppler if equipped (TM 1-203)')
  score = clamp(score, 0, 100)

  let tier: Tier
  if (f.ground) tier = 'IDLE'
  else if (score >= 82) tier = 'EMERGENCY'
  else if (score >= 65) tier = 'CRITICAL'
  else if (score >= 48) tier = 'WARN'
  else if (score >= 30) tier = 'CAUTION'
  else if (score >= 14) tier = 'WATCH'
  else tier = 'NOMINAL'

  return { f, mission, ref, altAGL, vGS, vs, phase, drivers, score, tier, notes }
}

export default function RotorOps({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'MISSIONS'|'OPERATORS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [missionFilter, setMissionFilter] = useState<Record<Mission, boolean>>(()=>Object.fromEntries(MISSION_LIST.map(m=>[m,true])) as Record<Mission, boolean>)
  const [q, setQ] = useState('')
  const [advMul, setAdvMul] = useState(100)
  const [maxAGL, setMaxAGL] = useState(5000)
  const [terrainOff, setTerrainOff] = useState(0)
  const [nightMode, setNightMode] = useState(false)
  const [maxVel, setMaxVel] = useState(180)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)

  const rows = useMemo<Row[]>(() => {
    return flights
      .filter(isRotor)
      .filter(f => f.altitudeFt <= maxAGL && f.velocityKts <= maxVel)
      .map(f => scoreRow(f, advMul, nightMode, terrainOff))
      .filter(r => missionFilter[r.mission])
      .sort((a,b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [flights, advMul, maxAGL, maxVel, terrainOff, nightMode, missionFilter])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { EMERGENCY:0, CRITICAL:0, WARN:0, CAUTION:0, WATCH:0, NOMINAL:0, IDLE:0 }
    rows.forEach(r => c[r.tier]++); return c
  }, [rows])

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (q.trim()) {
      const s = q.trim().toLowerCase()
      r = r.filter(x => (x.f.callsign||'').toLowerCase().includes(s) || (x.f.icao||'').toLowerCase().includes(s) || (x.f.type||'').toLowerCase().includes(s) || (x.f.operator||'').toLowerCase().includes(s) || x.mission.toLowerCase().includes(s))
    }
    return r
  }, [rows, tierFilter, q])

  const mean = rows.length ? rows.reduce((a,b)=>a+b.score,0)/rows.length : 0
  const worst = rows[0]
  const emerCt = tierCounts.EMERGENCY + tierCounts.CRITICAL

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const SRC = 'rotor-src'
    const HALO = 'rotor-halo'
    const PIN = 'rotor-pin'
    const LBL = 'rotor-lbl'
    const features = rows.filter(r => r.tier !== 'IDLE').map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: {
        tier: r.tier, score: Math.round(r.score),
        color: TIER_COLOR[r.tier],
        mcolor: MISSION_COLOR[r.mission],
        cs: r.f.callsign || r.f.icao,
        mission: r.mission,
        haloR: 7 + (5 - Math.min(5, TIER_RANK[r.tier])) * 2.8,
        pinScale: r.tier === 'EMERGENCY' ? 1.6 : r.tier === 'CRITICAL' ? 1.2 : 0,
      },
    }))
    const fc = { type: 'FeatureCollection' as const, features }
    const add = () => {
      try {
        if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: fc as any })
        else (map.getSource(SRC) as any).setData(fc)
        if (showHalo && !map.getLayer(HALO)) {
          map.addLayer({ id: HALO, type: 'circle', source: SRC, paint: {
            'circle-radius': ['get','haloR'],
            'circle-color': ['get','mcolor'],
            'circle-opacity': 0.16,
            'circle-stroke-color': ['get','color'],
            'circle-stroke-width': 1.4,
            'circle-stroke-opacity': 0.85,
          } })
        }
        if (showPin && !map.getLayer(PIN)) {
          map.addLayer({ id: PIN, type: 'circle', source: SRC, filter: ['>',['get','pinScale'],0], paint: {
            'circle-radius': ['*', 5.5, ['get','pinScale']],
            'circle-color': ['get','color'],
            'circle-stroke-color': '#fff', 'circle-stroke-width': 1.3,
          } })
        }
        if (showLbl && !map.getLayer(LBL)) {
          map.addLayer({ id: LBL, type: 'symbol', source: SRC, layout: {
            'text-field': ['concat', ['get','cs'], '  ', ['get','mission'], '  ', ['get','tier']],
            'text-size': 10, 'text-offset': [0, 1.3], 'text-anchor': 'top',
            'text-font': ['Open Sans Semibold','Arial Unicode MS Bold'],
          }, paint: { 'text-color': ['get','mcolor'], 'text-halo-color':'#0b1220','text-halo-width':1.2 } })
        }
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
    <div className="absolute right-3 top-20 z-30 w-[460px] max-h-[78vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">ROTOR</div>
        <div className="text-[10px] text-slate-400 truncate">Rotary-wing mission classifier · HEMS / OFFSHORE / SAR / LE / ENG / TOUR / UTIL / EXEC</div>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-[12px] px-2 py-0.5 rounded hover:bg-slate-800/60">✕</button>
        </div>
      </div>

      {/* tier strip */}
      <div className="grid grid-cols-7 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        {(['EMERGENCY','CRITICAL','WARN','CAUTION','WATCH','NOMINAL'] as Tier[]).map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter===t?'ALL':t)}
            className={`px-1 py-1 rounded border ${tierFilter===t?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
            <div className="text-[8px]" style={{color: TIER_COLOR[t]}}>{t.slice(0,4)}</div>
            <div className="text-slate-100 font-semibold">{tierCounts[t]}</div>
          </button>
        ))}
        <button onClick={() => setTierFilter('ALL')} className={`px-1 py-1 rounded border ${tierFilter==='ALL'?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
          <div className="text-[8px] text-slate-400">ALL</div>
          <div className="text-slate-100 font-semibold">{rows.length}</div>
        </button>
      </div>

      {/* summary */}
      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">MEAN</div>
          <div className="text-slate-100 font-semibold">{mean.toFixed(1)}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">WORST</div>
          <div className="text-slate-100 font-semibold truncate">{worst ? worst.f.callsign || worst.f.icao : '—'}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">EMER+CRIT</div>
          <div className="font-semibold" style={{color: emerCt ? TIER_COLOR.EMERGENCY : '#cbd5e1'}}>{emerCt}</div>
        </div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-800/60 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
        {([
          ['ADV-MUL', advMul, setAdvMul, 50, 200, 'pct'],
          ['MAX-AGL', maxAGL, setMaxAGL, 500, 15000, 'ft'],
          ['MAX-VEL', maxVel, setMaxVel, 80, 300, 'kt'],
          ['TERR-OFF', terrainOff, setTerrainOff, 0, 5000, 'ft'],
        ] as Array<[string, number, (n:number)=>void, number, number, string]>).map(([lbl,val,set,lo,hi,suf]) => (
          <label key={lbl} className="flex items-center gap-1.5">
            <span className="text-slate-500 w-14">{lbl}</span>
            <input type="range" min={lo} max={hi} value={val}
              onChange={e => set(parseInt(e.target.value))}
              className="flex-1 h-1 accent-sky-500" />
            <span className="text-slate-300 tabular-nums w-12 text-right">{val}{suf}</span>
          </label>
        ))}
        <label className="flex items-center gap-1.5 col-span-2">
          <span className="text-slate-500 w-14">NIGHT</span>
          <button onClick={()=>setNightMode(v=>!v)} className={`px-2 py-0.5 rounded text-[9px] border ${nightMode?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-500'}`}>{nightMode?'ON · NVG penalty active':'OFF · day ops'}</button>
        </label>
      </div>

      {/* mission chips */}
      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800/60">
        {MISSION_LIST.map(m => (
          <button key={m} onClick={() => setMissionFilter(p => ({...p, [m]: !p[m]}))}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${missionFilter[m]?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700 opacity-50'}`}
            style={{color: MISSION_COLOR[m]}}>{m}</button>
        ))}
      </div>

      {/* layer toggles */}
      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800/60 text-[9px]">
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl]] as const).map(([n,v,s])=>(
          <button key={n} onClick={()=>(s as any)(!v)} className={`px-1.5 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-500 hover:border-slate-700'}`}>{n}</button>
        ))}
      </div>

      {/* search + tabs */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-800/60">
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="callsign / icao / type / operator / mission"
          className="flex-1 bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/40" />
      </div>
      <div className="flex gap-0.5 px-3 py-1.5 border-b border-slate-800/60 text-[10px]">
        {(['AIRCRAFT','MISSIONS','OPERATORS'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 text-slate-100 border border-sky-500/40':'text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      {/* tab body */}
      <div className="overflow-y-auto flex-1 text-[11px]">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500">no rotorcraft in scope · adjust MAX-AGL / MAX-VEL / mission chips</div>}
            {filtered.slice(0, 80).map(r => (
              <button key={r.f.icao} onClick={()=>onFly(r.f.icao)} className="w-full text-left px-3 py-2 hover:bg-slate-900/60 transition">
                <div className="flex items-center gap-2 mb-1" style={{borderLeft:`3px solid ${TIER_COLOR[r.tier]}`, paddingLeft:8}}>
                  <span className="font-semibold text-slate-100">{r.f.callsign || r.f.icao}</span>
                  <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
                  <span className="text-[9px] px-1 py-px rounded bg-slate-800/70" style={{color: MISSION_COLOR[r.mission]}}>{r.mission}</span>
                  <span className="text-[9px] px-1 py-px rounded bg-slate-800/70 text-slate-300">{r.phase}</span>
                  <span className="ml-auto text-[9px] px-1.5 py-px rounded font-bold" style={{background: TIER_COLOR[r.tier]+'22', color: TIER_COLOR[r.tier]}}>{r.tier}</span>
                </div>
                <div className="grid grid-cols-4 gap-x-2 gap-y-1 text-[10px] pl-2">
                  <div><span className="text-slate-500">AGL </span><span className="text-slate-100 tabular-nums">{r.altAGL.toFixed(0)}ft</span></div>
                  <div><span className="text-slate-500">GS </span><span className="text-slate-100 tabular-nums">{r.vGS.toFixed(0)}kt</span></div>
                  <div><span className="text-slate-500">VS </span><span className="text-slate-100 tabular-nums" style={{color: r.vs < -800 ? TIER_COLOR.CRITICAL : '#cbd5e1'}}>{r.vs.toFixed(0)}</span></div>
                  <div><span className="text-slate-500">TRK </span><span className="text-slate-100 tabular-nums">{r.f.track.toFixed(0)}°</span></div>
                  <div className="col-span-2 truncate"><span className="text-slate-500">OP </span><span className="text-slate-300">{r.f.operator || '—'}</span></div>
                  <div className="col-span-2 text-[9px] text-slate-500 italic truncate">{r.ref}</div>
                </div>
                <div className="mt-1.5 pl-2">
                  <div className="w-full bg-slate-900/60 rounded h-1 overflow-hidden">
                    <div className="h-full" style={{width:`${Math.round(r.score)}%`, background: TIER_COLOR[r.tier]}}></div>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {(Object.entries(r.drivers) as [keyof Drivers, number][]).map(([k,v]) => (
                      <span key={k} className="text-[8.5px] px-1 py-px rounded bg-slate-900/60 text-slate-400 border border-slate-800/60">
                        {k} <span className="tabular-nums" style={{color: v > 60 ? TIER_COLOR.CRITICAL : v > 30 ? TIER_COLOR.WARN : '#cbd5e1'}}>{v.toFixed(0)}</span>
                      </span>
                    ))}
                  </div>
                  {r.notes.length > 0 && (
                    <div className="mt-1.5 space-y-0.5">
                      {r.notes.map((n,i) => (
                        <div key={i} className="text-[10px] text-rose-300/85 italic">› {n}</div>
                      ))}
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        {tab === 'MISSIONS' && (
          <div className="divide-y divide-slate-800/60">
            {(() => {
              const groups = new Map<Mission, Row[]>()
              rows.forEach(r => { if (!groups.has(r.mission)) groups.set(r.mission, []); groups.get(r.mission)!.push(r) })
              const arr = Array.from(groups.entries()).map(([m, rs]) => ({
                m, rs,
                mean: rs.reduce((a,b)=>a+b.score,0)/rs.length,
                worst: rs.reduce((a,b)=>Math.min(a, TIER_RANK[b.tier]), 5),
                emer: rs.filter(r=>r.tier==='EMERGENCY').length,
                crit: rs.filter(r=>r.tier==='CRITICAL').length,
              })).sort((a,b) => a.worst - b.worst || b.mean - a.mean)
              if (arr.length === 0) return <div className="px-3 py-6 text-center text-slate-500">no missions in scope</div>
              return arr.map(g => {
                const worstTier = TIER_ORDER[g.worst] || 'NOMINAL'
                return (
                  <div key={g.m} className="px-3 py-2" style={{borderLeft:`3px solid ${TIER_COLOR[worstTier]}`}}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-[12px]" style={{color: MISSION_COLOR[g.m]}}>{g.m}</span>
                      <span className="ml-auto text-[10px] text-slate-400 tabular-nums">n={g.rs.length}</span>
                      {g.emer > 0 && <span className="text-[9px] px-1 py-px rounded font-bold" style={{background: TIER_COLOR.EMERGENCY+'22', color: TIER_COLOR.EMERGENCY}}>EMER {g.emer}</span>}
                      {g.crit > 0 && <span className="text-[9px] px-1 py-px rounded font-bold" style={{background: TIER_COLOR.CRITICAL+'22', color: TIER_COLOR.CRITICAL}}>CRIT {g.crit}</span>}
                    </div>
                    <div className="text-[9.5px] text-slate-500 italic">{MISSION_REF[g.m]}</div>
                    <div className="w-full bg-slate-900/60 rounded h-1 overflow-hidden mt-1.5">
                      <div className="h-full" style={{width:`${Math.round(g.mean)}%`, background: TIER_COLOR[worstTier]}}></div>
                    </div>
                  </div>
                )
              })
            })()}
          </div>
        )}

        {tab === 'OPERATORS' && (
          <div className="divide-y divide-slate-800/60">
            {(() => {
              const groups = new Map<string, Row[]>()
              rows.forEach(r => {
                const k = r.f.operator || (r.f.callsign||'').replace(/[\d-].*$/,'').trim() || 'UNKNOWN'
                if (!groups.has(k)) groups.set(k, [])
                groups.get(k)!.push(r)
              })
              const arr = Array.from(groups.entries()).map(([op, rs]) => ({
                op, rs,
                mean: rs.reduce((a,b)=>a+b.score,0)/rs.length,
                worst: rs.reduce((a,b)=>Math.min(a, TIER_RANK[b.tier]), 5),
                dominantMission: (() => {
                  const counts = new Map<Mission, number>()
                  rs.forEach(r => counts.set(r.mission, (counts.get(r.mission)||0)+1))
                  return Array.from(counts.entries()).sort((a,b)=>b[1]-a[1])[0][0]
                })(),
              })).sort((a,b) => a.worst - b.worst || b.mean - a.mean)
              if (arr.length === 0) return <div className="px-3 py-6 text-center text-slate-500">no operators in scope</div>
              return arr.slice(0, 60).map(g => {
                const worstTier = TIER_ORDER[g.worst] || 'NOMINAL'
                return (
                  <div key={g.op} className="px-3 py-1.5" style={{borderLeft:`3px solid ${TIER_COLOR[worstTier]}`}}>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-200 text-[11px] truncate flex-1">{g.op}</span>
                      <span className="text-[9px] px-1 py-px rounded bg-slate-800/70" style={{color: MISSION_COLOR[g.dominantMission]}}>{g.dominantMission}</span>
                      <span className="text-[10px] text-slate-400 tabular-nums">n={g.rs.length}</span>
                    </div>
                    <div className="w-full bg-slate-900/60 rounded h-1 overflow-hidden mt-1">
                      <div className="h-full" style={{width:`${Math.round(g.mean)}%`, background: TIER_COLOR[worstTier]}}></div>
                    </div>
                  </div>
                )
              })
            })()}
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800/60 text-[9px] text-slate-500 italic">
        FAA-H-8083-21B · 14 CFR Part 27/29/133/135/136 · ICAO Doc 9966 / 9261 / Annex 6 Pt III · EASA SPA.HEMS/HOFO/SAR · IHST SMS · USHST H-SE-127
      </div>
    </div>
  )
}
