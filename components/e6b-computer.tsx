'use client'
import { useEffect, useMemo, useState } from 'react'

/* ============================================================
   E6B Flight Computer
   -----------------------------------------------------------
   A digital recreation of the classic E6B "whiz wheel" used
   by pilots for flight planning. Five integrated solvers:

     1. WIND TRIANGLE
        Inputs: true course (TC), true airspeed (TAS),
        wind direction (from), wind speed.
        Outputs: wind correction angle (WCA), heading (TH),
        ground speed (GS), headwind & crosswind components.

        Math: wind triangle. Let wind angle θ = WD - TC.
        Crosswind = WS·sin(θ); Headwind = WS·cos(θ).
        WCA = asin( WS·sin(θ) / TAS ).
        GS  = TAS·cos(WCA) - WS·cos(θ).

     2. TAS / DENSITY-ALTITUDE
        Inputs: IAS (≈CAS), pressure altitude, OAT °C, QNH.
        ISA temp at PA = 15 - 1.98·(PA/1000) °C.
        Density altitude DA = PA + 120·(OAT - ISA).
        TAS ≈ CAS · (1 + 0.02·alt_thousands) — classic rule;
        precise: TAS = CAS / sqrt(σ), σ from std atm.
        Mach = TAS / a, a = 38.967854·sqrt(T_K) kt.

     3. TIME · SPEED · DISTANCE
        Given any two, solve the third. Also computes ETE
        and ETA stamp.

     4. FUEL PLANNER
        Inputs: fuel on board (gal), burn rate (gph), GS.
        Outputs: endurance (hh:mm), range (nm), reserve at
        a target distance (min and gal remaining).

     5. CROSSWIND COMPONENT
        Runway heading (mag) vs wind. Outputs head/tail and
        crosswind components plus a compass diagram.

   UI: single floating panel (right side), five tab strip,
   live computations on every keystroke, copy-summary button
   that places a plain-text snapshot on the clipboard, and a
   reset-all action. All styling adheres to the sky-500 chrome
   palette with slate hierarchy; no emoji in chrome.
   ============================================================ */

type Tab = 'wind' | 'tas' | 'tsd' | 'fuel' | 'xwind'

export default function E6bComputer({ onClose, initialTab = 'wind' }: { onClose: () => void; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab)
  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center sm:items-center bg-slate-950/60 backdrop-blur-[2px] p-3 sm:p-6" onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-[640px] max-h-[90vh] overflow-y-auto bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl"
      >
        <Header tab={tab} onClose={onClose} />
        <Tabs tab={tab} onChange={setTab} />
        <div className="p-4 sm:p-5">
          {tab === 'wind' && <WindTriangle />}
          {tab === 'tas' && <TasDa />}
          {tab === 'tsd' && <TimeSpeedDistance />}
          {tab === 'fuel' && <FuelPlanner />}
          {tab === 'xwind' && <CrosswindBlock />}
        </div>
        <Footer />
      </div>
    </div>
  )
}

function Header({ tab, onClose }: { tab: Tab; onClose: () => void }) {
  const title = TAB_TITLE[tab]
  return (
    <div className="sticky top-0 bg-slate-950/95 backdrop-blur-xl px-4 py-3 border-b border-slate-800 flex items-center justify-between">
      <div>
        <div className="text-[10px] uppercase tracking-widest text-slate-500">E6B Flight Computer</div>
        <div className="text-sm font-semibold text-slate-100">{title}</div>
      </div>
      <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1" aria-label="Close">×</button>
    </div>
  )
}

const TAB_TITLE: Record<Tab, string> = {
  wind: 'Wind Triangle',
  tas: 'TAS / Density Altitude',
  tsd: 'Time · Speed · Distance',
  fuel: 'Fuel Planner',
  xwind: 'Crosswind Component',
}

function Tabs({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: 'wind', label: 'Wind' },
    { id: 'tas', label: 'TAS·DA' },
    { id: 'tsd', label: 'TSD' },
    { id: 'fuel', label: 'Fuel' },
    { id: 'xwind', label: 'X-Wind' },
  ]
  return (
    <div className="px-3 pt-3 flex gap-1.5 overflow-x-auto">
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`px-3 py-1.5 rounded-lg text-[11px] font-medium tracking-wide border transition shrink-0 ${
            tab === t.id
              ? 'bg-sky-500/15 text-sky-100 border-sky-500/40'
              : 'bg-slate-900/50 text-slate-300 border-slate-800 hover:bg-slate-800/70 hover:border-slate-700'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

function Footer() {
  return (
    <div className="px-4 py-2.5 border-t border-slate-800 text-[10px] uppercase tracking-widest text-slate-500 flex items-center justify-between">
      <span>Whiz wheel · digital</span>
      <span>ISA · °C · kt · nm</span>
    </div>
  )
}

/* -------------------- shared field primitives -------------------- */

function Input({ label, value, onChange, unit, step, min, max, hint }: {
  label: string; value: string; onChange: (v: string) => void;
  unit?: string; step?: number; min?: number; max?: number; hint?: string
}) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">{label}</div>
      <div className="flex items-center gap-2 bg-slate-900/60 border border-slate-800 rounded-lg px-2.5 py-1.5 focus-within:border-sky-500/40">
        <input
          type="number"
          inputMode="decimal"
          step={step ?? 1}
          min={min}
          max={max}
          value={value}
          onChange={e => onChange(e.target.value)}
          className="flex-1 bg-transparent text-sm font-mono text-slate-100 outline-none w-full min-w-0"
        />
        {unit && <span className="text-[10px] text-slate-500 uppercase tracking-wider">{unit}</span>}
      </div>
      {hint && <div className="text-[10px] text-slate-600 mt-1">{hint}</div>}
    </label>
  )
}

function Stat({ label, value, unit, accent }: { label: string; value: string; unit?: string; accent?: string }) {
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-2.5">
      <div className="text-[9px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className={`text-base font-bold tabular-nums leading-tight ${accent || 'text-slate-100'}`}>
        {value}
        {unit && <span className="text-[10px] font-normal text-slate-500 ml-1 uppercase">{unit}</span>}
      </div>
    </div>
  )
}

function Tier({ label, tone }: { label: string; tone: 'good' | 'warn' | 'bad' | 'mute' }) {
  const cls = {
    good: 'bg-sky-500/15 text-sky-100 border-sky-500/40',
    warn: 'bg-amber-500/10 text-amber-200 border-amber-500/40',
    bad:  'bg-rose-500/10 text-rose-200 border-rose-500/40',
    mute: 'bg-slate-800/60 text-slate-400 border-slate-700',
  }[tone]
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-widest border ${cls}`}>{label}</span>
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={() => {
        try { navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500) } catch {}
      }}
      className="px-2.5 py-1 rounded-md text-[10px] font-medium uppercase tracking-widest border bg-slate-900/60 text-slate-300 border-slate-800 hover:bg-slate-800/70 hover:border-sky-500/40 hover:text-sky-100"
    >
      {done ? 'Copied ›' : 'Copy summary'}
    </button>
  )
}

/* -------------------- math helpers -------------------- */
const D2R = Math.PI / 180
const R2D = 180 / Math.PI
const num = (s: string, fb = 0) => {
  const v = parseFloat(s)
  return Number.isFinite(v) ? v : fb
}
const fmt = (n: number, d = 0) => Number.isFinite(n) ? n.toFixed(d) : '—'
const fmtBrg = (n: number) => {
  const v = ((n % 360) + 360) % 360
  return v.toFixed(0).padStart(3, '0')
}
const hhmm = (mins: number) => {
  if (!Number.isFinite(mins) || mins < 0) return '—'
  const h = Math.floor(mins / 60)
  const m = Math.round(mins - h * 60)
  return `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}`
}

/* -------------------- 1. WIND TRIANGLE -------------------- */
function WindTriangle() {
  const [tc, setTc] = useState('090')
  const [tas, setTas] = useState('120')
  const [wd, setWd] = useState('240')
  const [ws, setWs] = useState('20')

  const r = useMemo(() => {
    const TC = num(tc), TAS = num(tas, 1), WD = num(wd), WS = num(ws)
    // wind blows FROM WD; the "from" angle relative to course
    const theta = (WD - TC) * D2R
    const cross = WS * Math.sin(theta)   // +right
    const head  = WS * Math.cos(theta)   // +headwind
    const sinWca = TAS > 0 ? cross / TAS : 0
    if (Math.abs(sinWca) > 1) {
      return { invalid: true, cross, head, WCA: NaN, TH: NaN, GS: NaN }
    }
    const WCA = Math.asin(sinWca) * R2D   // + = right correction
    const TH = TC + WCA
    const GS = TAS * Math.cos(WCA * D2R) - head
    return { invalid: false, cross, head, WCA, TH, GS }
  }, [tc, tas, wd, ws])

  const summary = r.invalid
    ? 'Wind exceeds TAS — un-flyable.'
    : `Wind triangle: TC ${fmtBrg(num(tc))}° / TAS ${fmt(num(tas))} kt · wind ${fmtBrg(num(wd))}°@${fmt(num(ws))} → TH ${fmtBrg(r.TH)}° (WCA ${r.WCA>=0?'+':''}${fmt(r.WCA,1)}°) · GS ${fmt(r.GS)} kt · ${r.head>=0?'HW':'TW'} ${fmt(Math.abs(r.head),1)} · XW ${fmt(Math.abs(r.cross),1)} (${r.cross>=0?'R':'L'})`

  const tier: 'good'|'warn'|'bad'|'mute' = r.invalid ? 'bad' : Math.abs(r.WCA) > 20 ? 'warn' : 'good'

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5">
        <Input label="True course"  value={tc}  onChange={setTc}  unit="°"  min={0} max={360} hint="direction of intended track" />
        <Input label="True airspeed" value={tas} onChange={setTas} unit="kt" min={0} />
        <Input label="Wind from"    value={wd}  onChange={setWd}  unit="°"  min={0} max={360} hint="meteorological 'from' direction" />
        <Input label="Wind speed"   value={ws}  onChange={setWs}  unit="kt" min={0} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="True heading" value={r.invalid ? '—' : fmtBrg(r.TH)} unit="°" accent="text-sky-100" />
        <Stat label="WCA" value={r.invalid ? '—' : `${r.WCA>=0?'+':''}${fmt(r.WCA,1)}`} unit="°" />
        <Stat label="Ground speed" value={r.invalid ? '—' : fmt(r.GS)} unit="kt" accent="text-sky-100" />
        <Stat label={r.head>=0?'Headwind':'Tailwind'} value={fmt(Math.abs(r.head),1)} unit="kt" />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Stat label={`Crosswind (${r.cross>=0?'right':'left'})`} value={fmt(Math.abs(r.cross),1)} unit="kt" />
        <div className="flex items-center justify-end gap-2">
          <Tier label={r.invalid?'over-wind':Math.abs(r.WCA)>20?'high WCA':'in envelope'} tone={tier} />
        </div>
      </div>

      <WindDiagram tc={num(tc)} th={r.TH} wd={num(wd)} ws={num(ws)} tas={num(tas)} gs={r.GS} valid={!r.invalid} />

      <div className="flex justify-end pt-1">
        <CopyButton text={summary} />
      </div>
    </div>
  )
}

function WindDiagram({ tc, th, wd, ws, tas, gs, valid }: {
  tc: number; th: number; wd: number; ws: number; tas: number; gs: number; valid: boolean
}) {
  const size = 220, cx = size/2, cy = size/2
  // scale: longest vector fits 80px
  const maxV = Math.max(tas, gs, ws, 1)
  const k = 80 / maxV
  // bearing-to-screen: 0°=up
  const vec = (deg: number, mag: number) => {
    const a = (deg - 90) * D2R
    return { x: cx + Math.cos(a) * mag * k, y: cy + Math.sin(a) * mag * k }
  }
  const tcEnd = vec(tc, gs > 0 ? gs : tas) // track shown at GS length (course line)
  const thEnd = vec(th, tas)
  // wind vector drawn from TAS endpoint TO track endpoint (vector triangle closure: TAS + Wind = GS along course)
  // Display wind as arrow from origin showing direction wind is BLOWING (wd+180)
  const windBlowTo = wd + 180
  const windEnd = vec(windBlowTo, ws)

  return (
    <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-2 flex items-center justify-between">
        <span>Vector diagram</span>
        <span className="text-slate-600 normal-case tracking-normal">cyan = heading · sky = track · slate = wind</span>
      </div>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="mx-auto block">
        {/* compass ring */}
        <circle cx={cx} cy={cy} r={90} fill="none" stroke="#1e293b" strokeWidth={1} />
        {[0,45,90,135,180,225,270,315].map(d => {
          const p1 = vec(d, 0), p2 = vec(d, (1/k)*90)
          return <line key={d} x1={cx} y1={cy} x2={p2.x} y2={p2.y} stroke="#1e293b" strokeWidth={0.5} />
        })}
        {[['N',0],['E',90],['S',180],['W',270]].map(([l,d]) => {
          const p = vec(d as number, (1/k)*100)
          return <text key={l as string} x={p.x} y={p.y} textAnchor="middle" dominantBaseline="middle" fontSize={10} fill="#475569">{l}</text>
        })}
        {valid && (<>
          {/* heading vector (TAS length, along TH) */}
          <line x1={cx} y1={cy} x2={thEnd.x} y2={thEnd.y} stroke="#22d3ee" strokeWidth={2} />
          <circle cx={thEnd.x} cy={thEnd.y} r={3} fill="#22d3ee" />
          {/* track vector (GS length, along TC) */}
          <line x1={cx} y1={cy} x2={tcEnd.x} y2={tcEnd.y} stroke="#0ea5e9" strokeWidth={2.5} />
          <polygon points={`${tcEnd.x},${tcEnd.y} ${tcEnd.x-4},${tcEnd.y-4} ${tcEnd.x+4},${tcEnd.y-4}`} fill="#0ea5e9" opacity={0.001} />
          {/* wind vector */}
          <line x1={cx} y1={cy} x2={windEnd.x} y2={windEnd.y} stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="3 3" />
        </>)}
        <circle cx={cx} cy={cy} r={2.5} fill="#e2e8f0" />
      </svg>
    </div>
  )
}

/* -------------------- 2. TAS / DENSITY ALTITUDE -------------------- */
function TasDa() {
  const [ias, setIas] = useState('110')
  const [pa, setPa]   = useState('6500')
  const [oat, setOat] = useState('12')

  const r = useMemo(() => {
    const IAS = num(ias), PA = num(pa), OAT = num(oat)
    const isaC = 15 - 1.98 * (PA / 1000)
    const DA = PA + 120 * (OAT - isaC)
    // density ratio sigma from density altitude using standard ISA
    // sigma ≈ (1 - 6.8755856e-6 * DA)^4.2561
    const sigma = Math.pow(Math.max(1 - 6.8755856e-6 * DA, 0.0001), 4.2561)
    const TAS = IAS / Math.sqrt(sigma)
    // OAT in Kelvin for speed of sound
    const T_K = OAT + 273.15
    const a = 38.967854 * Math.sqrt(T_K)   // kt
    const mach = TAS / a
    return { isaC, DA, sigma, TAS, a, mach }
  }, [ias, pa, oat])

  const tier: 'good'|'warn'|'bad'|'mute' =
    r.DA > 10000 ? 'bad' : r.DA > 7000 ? 'warn' : 'good'

  const summary = `TAS/DA: IAS ${fmt(num(ias))} kt @ PA ${fmt(num(pa))} ft, OAT ${fmt(num(oat))}°C (ISA ${r.isaC>=0?'+':''}${fmt(num(oat)-r.isaC,1)}) → DA ${fmt(r.DA,0)} ft · TAS ${fmt(r.TAS,1)} kt · M${fmt(r.mach,2)}`

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2.5">
        <Input label="IAS / CAS" value={ias} onChange={setIas} unit="kt" />
        <Input label="Pressure alt" value={pa} onChange={setPa} unit="ft" step={100} />
        <Input label="OAT" value={oat} onChange={setOat} unit="°C" />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="ISA at PA" value={`${r.isaC>=0?'+':''}${fmt(r.isaC,1)}`} unit="°C" />
        <Stat label="ISA dev"   value={`${num(oat)-r.isaC>=0?'+':''}${fmt(num(oat)-r.isaC,1)}`} unit="°C" />
        <Stat label="Density alt" value={fmt(r.DA,0)} unit="ft" accent="text-sky-100" />
        <Stat label="Density σ"  value={fmt(r.sigma,3)} />
        <Stat label="True airspeed" value={fmt(r.TAS,1)} unit="kt" accent="text-sky-100" />
        <Stat label="Speed of sound" value={fmt(r.a,0)} unit="kt" />
        <Stat label="Mach" value={`M${fmt(r.mach,3)}`} />
        <div className="flex items-center justify-end gap-2 pr-1">
          <Tier label={r.DA>10000?'high DA':r.DA>7000?'elevated':'normal'} tone={tier} />
        </div>
      </div>

      <div className="text-[10px] text-slate-500 leading-relaxed bg-slate-900/40 border border-slate-800 rounded-lg p-2.5">
        DA = PA + 120·(OAT − ISA). σ from standard atmosphere ≈ (1 − 6.876e-6·DA)<sup>4.256</sup>.
        TAS = CAS / √σ. Speed of sound a = 38.97·√T<sub>K</sub> kt.
      </div>

      <div className="flex justify-end">
        <CopyButton text={summary} />
      </div>
    </div>
  )
}

/* -------------------- 3. TIME / SPEED / DISTANCE -------------------- */
function TimeSpeedDistance() {
  const [solve, setSolve] = useState<'time'|'speed'|'dist'>('time')
  const [time, setTime] = useState('45')    // minutes
  const [speed, setSpeed] = useState('120') // kt
  const [dist, setDist] = useState('90')    // nm

  const r = useMemo(() => {
    const T = num(time), S = num(speed), D = num(dist)
    if (solve === 'time')  return { T: S > 0 ? (D / S) * 60 : 0, S, D }
    if (solve === 'speed') return { T, S: T > 0 ? (D / (T/60)) : 0, D }
    return { T, S, D: S * (T / 60) }
  }, [solve, time, speed, dist])

  const eta = useMemo(() => {
    const mins = solve === 'time' ? r.T : num(time)
    if (!Number.isFinite(mins) || mins < 0) return '—'
    const now = new Date(Date.now() + mins * 60000)
    return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }, [solve, r.T, time])

  const summary = `TSD: dist ${fmt(solve==='dist'?r.D:num(dist),1)} nm · speed ${fmt(solve==='speed'?r.S:num(speed),1)} kt · time ${hhmm(solve==='time'?r.T:num(time))} · ETA ${eta}`

  return (
    <div className="space-y-4">
      <div className="flex gap-1.5">
        {[['time','Solve time'],['speed','Solve speed'],['dist','Solve distance']].map(([id, l]) => (
          <button key={id} onClick={() => setSolve(id as any)}
            className={`flex-1 px-2.5 py-1.5 rounded-lg text-[10px] font-medium uppercase tracking-widest border ${
              solve === id ? 'bg-sky-500/15 text-sky-100 border-sky-500/40' : 'bg-slate-900/50 text-slate-400 border-slate-800 hover:bg-slate-800/70'
            }`}>{l}</button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2.5">
        <Input label="Time" value={solve==='time' ? fmt(r.T,1) : time} onChange={setTime} unit="min" />
        <Input label="Ground speed" value={solve==='speed' ? fmt(r.S,1) : speed} onChange={setSpeed} unit="kt" />
        <Input label="Distance" value={solve==='dist' ? fmt(r.D,1) : dist} onChange={setDist} unit="nm" />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Stat label="Elapsed" value={hhmm(solve==='time' ? r.T : num(time))} accent="text-sky-100" />
        <Stat label="Ground speed" value={fmt(solve==='speed' ? r.S : num(speed),1)} unit="kt" />
        <Stat label="ETA (local)" value={eta} accent="text-sky-100" />
      </div>

      <div className="flex justify-end">
        <CopyButton text={summary} />
      </div>
    </div>
  )
}

/* -------------------- 4. FUEL PLANNER -------------------- */
function FuelPlanner() {
  const [fob, setFob] = useState('40')      // gal on board
  const [burn, setBurn] = useState('9.5')   // gph
  const [gs, setGs] = useState('120')       // kt
  const [reserveMin, setReserveMin] = useState('45')
  const [target, setTarget] = useState('250') // nm

  const r = useMemo(() => {
    const FOB = num(fob), BURN = num(burn,1), GS = num(gs), RES = num(reserveMin), TGT = num(target)
    const endMin = BURN > 0 ? (FOB / BURN) * 60 : 0
    const range  = (endMin / 60) * GS
    const reserveGal = (RES / 60) * BURN
    const usableGal  = Math.max(FOB - reserveGal, 0)
    const usableRange = BURN > 0 ? (usableGal / BURN) * GS : 0
    const fuelForTgt = GS > 0 ? (TGT / GS) * BURN : 0
    const remainAtTgt = FOB - fuelForTgt
    const remainMin   = BURN > 0 ? (remainAtTgt / BURN) * 60 : 0
    return { endMin, range, reserveGal, usableGal, usableRange, fuelForTgt, remainAtTgt, remainMin }
  }, [fob, burn, gs, reserveMin, target])

  const tier: 'good'|'warn'|'bad' =
    r.remainMin < num(reserveMin) ? 'bad'
    : r.remainMin < num(reserveMin) + 15 ? 'warn'
    : 'good'

  const summary = `Fuel: ${fmt(num(fob),1)} gal @ ${fmt(num(burn),1)} gph · endurance ${hhmm(r.endMin)} · range ${fmt(r.range,0)} nm (usable ${fmt(r.usableRange,0)} nm after ${num(reserveMin)} min reserve) · at ${fmt(num(target),0)} nm: ${fmt(r.remainAtTgt,1)} gal / ${hhmm(r.remainMin)} remain`

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
        <Input label="Fuel on board"    value={fob}  onChange={setFob}  unit="gal" step={0.1} />
        <Input label="Burn rate"        value={burn} onChange={setBurn} unit="gph" step={0.1} />
        <Input label="Ground speed"     value={gs}   onChange={setGs}   unit="kt" />
        <Input label="Required reserve" value={reserveMin} onChange={setReserveMin} unit="min" />
        <Input label="Leg distance"     value={target} onChange={setTarget} unit="nm" hint="check fuel-over-target" />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Endurance" value={hhmm(r.endMin)} accent="text-sky-100" />
        <Stat label="Still-air range" value={fmt(r.range,0)} unit="nm" />
        <Stat label="Reserve fuel" value={fmt(r.reserveGal,1)} unit="gal" />
        <Stat label="Usable range" value={fmt(r.usableRange,0)} unit="nm" accent="text-sky-100" />
        <Stat label="Burn over leg" value={fmt(r.fuelForTgt,1)} unit="gal" />
        <Stat label="At dest: fuel" value={fmt(r.remainAtTgt,1)} unit="gal" accent={r.remainAtTgt<r.reserveGal?'text-rose-300':'text-sky-100'} />
        <Stat label="At dest: time" value={hhmm(Math.max(r.remainMin,0))} />
        <div className="flex items-center justify-end pr-1">
          <Tier label={tier==='bad'?'below reserve':tier==='warn'?'tight':'legal'} tone={tier} />
        </div>
      </div>

      <div className="flex justify-end">
        <CopyButton text={summary} />
      </div>
    </div>
  )
}

/* -------------------- 5. CROSSWIND COMPONENT -------------------- */
function CrosswindBlock() {
  const [rwy, setRwy] = useState('27')     // runway number (e.g., 27 -> 270°)
  const [wd, setWd] = useState('300')
  const [ws, setWs] = useState('18')
  const [gust, setGust] = useState('0')
  const [limit, setLimit] = useState('20') // demonstrated crosswind

  const r = useMemo(() => {
    let RWY = num(rwy)
    // accept either runway number (1-36) or degrees
    if (RWY <= 36) RWY = RWY * 10
    const WD = num(wd), WS = num(ws), G = num(gust), LIM = num(limit, 1)
    const theta = ((WD - RWY) * D2R)
    const cross = Math.abs(WS * Math.sin(theta))
    const along = WS * Math.cos(theta)
    const headwind = along                // +ve = headwind
    const gustCross = G > 0 ? Math.abs(G * Math.sin(theta)) : cross
    const pctOfLimit = LIM > 0 ? (cross / LIM) * 100 : 0
    return { RWY, cross, along, headwind, gustCross, pctOfLimit, theta }
  }, [rwy, wd, ws, gust, limit])

  const tier: 'good'|'warn'|'bad' =
    r.pctOfLimit > 100 ? 'bad' : r.pctOfLimit > 80 ? 'warn' : 'good'

  const side = (((num(wd) - r.RWY) + 540) % 360) - 180  // -180..180
  const sideLabel = side > 0 ? 'right' : side < 0 ? 'left' : 'center'

  const summary = `Crosswind: RWY ${fmtBrg(r.RWY)}° vs wind ${fmtBrg(num(wd))}°@${fmt(num(ws))} (gust ${fmt(num(gust))}) → ${r.headwind>=0?'HW':'TW'} ${fmt(Math.abs(r.headwind),1)} kt · XW ${fmt(r.cross,1)} kt ${sideLabel} (gust XW ${fmt(r.gustCross,1)}) · ${fmt(r.pctOfLimit,0)}% of ${fmt(num(limit),0)} kt limit`

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
        <Input label="Runway" value={rwy} onChange={setRwy} unit="°/no" hint="e.g. 27 or 270" />
        <Input label="Wind from" value={wd} onChange={setWd} unit="°" />
        <Input label="Wind speed" value={ws} onChange={setWs} unit="kt" />
        <Input label="Gust" value={gust} onChange={setGust} unit="kt" />
        <Input label="Demonstrated X-wind" value={limit} onChange={setLimit} unit="kt" hint="AFM/POH limit" />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label={r.headwind>=0?'Headwind':'Tailwind'} value={fmt(Math.abs(r.headwind),1)} unit="kt" accent={r.headwind<0?'text-amber-200':'text-sky-100'} />
        <Stat label={`Crosswind (${sideLabel})`} value={fmt(r.cross,1)} unit="kt" accent="text-sky-100" />
        <Stat label="Gust crosswind" value={fmt(r.gustCross,1)} unit="kt" />
        <Stat label="% of limit" value={fmt(r.pctOfLimit,0)} unit="%" accent={tier==='bad'?'text-rose-300':tier==='warn'?'text-amber-200':'text-sky-100'} />
      </div>

      <RunwayDiagram rwy={r.RWY} wd={num(wd)} ws={num(ws)} cross={r.cross} headwind={r.headwind} />

      <div className="flex items-center justify-between">
        <Tier label={tier==='bad'?'over limit':tier==='warn'?'caution':'within limit'} tone={tier} />
        <CopyButton text={summary} />
      </div>
    </div>
  )
}

function RunwayDiagram({ rwy, wd, ws, cross, headwind }: {
  rwy: number; wd: number; ws: number; cross: number; headwind: number
}) {
  const size = 220, cx = size/2, cy = size/2
  // Rotate so runway points up
  const rotate = -rwy
  const windRelTo = (wd + 180 + rotate)  // blowing-TO direction in runway frame
  const a = (windRelTo - 90) * D2R
  const wlen = Math.min(ws, 60) * 1.4
  const wx = cx + Math.cos(a) * wlen
  const wy = cy + Math.sin(a) * wlen
  return (
    <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-2 flex items-center justify-between">
        <span>Runway diagram</span>
        <span className="text-slate-600 normal-case tracking-normal">runway aligned vertical · arrow = wind blow-to</span>
      </div>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="mx-auto block">
        {/* runway strip */}
        <rect x={cx-14} y={cy-90} width={28} height={180} fill="#0f172a" stroke="#1e293b" />
        {/* center dashes */}
        {Array.from({length: 9}).map((_,i) => (
          <rect key={i} x={cx-1} y={cy-85+i*20} width={2} height={10} fill="#475569" />
        ))}
        {/* runway label */}
        <text x={cx} y={cy-95} textAnchor="middle" fontSize={10} fill="#94a3b8" fontFamily="ui-monospace,monospace">{(rwy/10).toFixed(0).padStart(2,'0')}</text>
        <text x={cx} y={cy+105} textAnchor="middle" fontSize={10} fill="#475569" fontFamily="ui-monospace,monospace">{(((rwy+180)%360)/10).toFixed(0).padStart(2,'0')}</text>

        {/* wind arrow */}
        <defs>
          <marker id="wa" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#0ea5e9" />
          </marker>
        </defs>
        <line x1={cx} y1={cy} x2={wx} y2={wy} stroke="#0ea5e9" strokeWidth={2.5} markerEnd="url(#wa)" />

        {/* component labels */}
        <text x={6} y={size-8} fontSize={10} fill="#94a3b8" fontFamily="ui-monospace,monospace">XW {fmt(cross,1)} kt</text>
        <text x={size-6} y={size-8} fontSize={10} fill="#94a3b8" fontFamily="ui-monospace,monospace" textAnchor="end">{headwind>=0?'HW':'TW'} {fmt(Math.abs(headwind),1)} kt</text>
      </svg>
    </div>
  )
}
