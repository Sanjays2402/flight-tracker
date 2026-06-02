'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Contrail Forecaster
   -----------------------------------------------------------
   Applies a simplified Schmidt–Appleman criterion to every
   airborne aircraft:
     - Ambient OAT (from DAP, fallback to ISA from altitude).
     - Pressure level from altitude (ISA hydrostatic).
     - Persistence proxy from altitude band + assumed RHi.
   Classifies each into 4 buckets:
     NONE       — too warm or low, contrail unlikely
     SHORT      — forms but evaporates in seconds (no ISSR)
     PERSISTENT — lasts minutes to hours (climate-relevant)
     SPREADING  — long-lived, likely seeds cirrus
   For every forming aircraft we paint a tapered, fading
   trailing plume polygon on MapLibre behind the jet, sized
   by airframe + persistence. Side panel ranks the top
   producers by a "climate forcing score" combining radiative
   contribution proxy (length × width × persistence weight)
   and emissions-class proxy.
   ============================================================ */

export interface CTFlight {
  icao: string
  callsign: string
  type: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  vertRate: number
  ground: boolean
  oat: number
}

interface Props {
  map: maplibregl.Map | null
  flights: CTFlight[]
  onClose: () => void
  onFly?: (icao: string) => void
}

type CT = 'NONE' | 'SHORT' | 'PERS' | 'SPRD'
const ORDER: CT[] = ['SPRD','PERS','SHORT','NONE']
const COLOR: Record<CT,string> = { NONE:'#475569', SHORT:'#22d3ee', PERS:'#a78bfa', SPRD:'#f43f5e' }
const LABEL: Record<CT,string> = { NONE:'NONE', SHORT:'SHORT-LIVED', PERS:'PERSISTENT', SPRD:'SPREADING' }
const TIER_W: Record<CT,number> = { NONE:0, SHORT:0.3, PERS:1.0, SPRD:1.8 }

// crude airframe class for plume width and emissions factor
const HEAVY = new Set(['A332','A333','A338','A339','A342','A343','A345','A346','A359','A35K','A388','B742','B743','B744','B748','B752','B753','B762','B763','B764','B772','B77L','B773','B77W','B788','B789','B78X','DC10','MD11','IL62','IL76','IL86','IL96'])
const NB = new Set(['A318','A319','A320','A321','A20N','A21N','A19N','B732','B733','B734','B735','B736','B737','B738','B739','B73G','B73H','E190','E195','E290','E295','BCS1','BCS3','A220','B712','B717','MD80','MD81','MD82','MD83','MD87','MD88','MD90'])
const REG = new Set(['CRJ1','CRJ2','CRJ7','CRJ9','CRJX','E135','E140','E145','E170','E175','AT43','AT45','AT72','AT75','AT76','DH8A','DH8B','DH8C','DH8D','SF34'])
function airClass(t: string): 'H'|'NB'|'R'|'BIZ'|'X' {
  if (!t) return 'X'
  const k = t.toUpperCase()
  if (HEAVY.has(k)) return 'H'
  if (NB.has(k)) return 'NB'
  if (REG.has(k)) return 'R'
  if (k.startsWith('B74')||k.startsWith('B77')||k.startsWith('B78')||k.startsWith('A33')||k.startsWith('A34')||k.startsWith('A35')||k.startsWith('A38')) return 'H'
  if (k.startsWith('A32')||k.startsWith('B73')||k.startsWith('E19')||k.startsWith('BCS')) return 'NB'
  if (k.startsWith('CRJ')||k.startsWith('E1')||k.startsWith('AT')||k.startsWith('DH')) return 'R'
  if (k.startsWith('GLF')||k.startsWith('GL5')||k.startsWith('GL7')||k.startsWith('C5')||k.startsWith('C68')||k.startsWith('C75')||k.startsWith('LJ')) return 'BIZ'
  return 'X'
}
const PLUME_HW: Record<string, number> = { H: 0.35, NB: 0.22, R: 0.14, BIZ: 0.12, X: 0.18 }
const EMIT_FAC: Record<string, number> = { H: 3.2, NB: 1.4, R: 0.9, BIZ: 0.7, X: 1.0 }

// ISA OAT in °C at altitude_ft
function isaOatC(altFt: number) {
  if (altFt < 36089) return 15 - 1.98 * (altFt / 1000)
  return -56.5
}

// Schmidt-Appleman simplified: T_crit depends on ambient RH; we
// approximate T_crit at cruise altitudes as ~-39 to -41°C for kerosene jets.
// We then approximate persistence from altitude band where the
// ice-supersaturated region statistically lives (FL300–FL400 most likely).
function classify(altFt: number, oatC: number, ground: boolean, klass: string): CT {
  if (ground || altFt < 18000) return 'NONE'
  const T = (oatC && Math.abs(oatC) < 100 && oatC !== 0) ? oatC : isaOatC(altFt)
  const Tcrit = -39 // °C, simplified threshold for jet engine contrail formation
  if (T > Tcrit) return 'NONE'
  // persistence band: probability proxy
  const margin = Tcrit - T // °C colder than threshold
  // altitude weight peaks around FL340 (ISSR band)
  const fl = altFt / 100
  const altWt =
    fl < 240 ? 0.05 :
    fl < 280 ? 0.25 :
    fl < 320 ? 0.7 :
    fl < 380 ? 1.0 :
    fl < 420 ? 0.75 :
                0.4
  const persistScore = margin * 0.4 + altWt * 4 + (klass === 'H' ? 1.5 : klass === 'NB' ? 0.6 : 0)
  if (persistScore < 1.2) return 'SHORT'
  if (persistScore < 3.4) return 'PERS'
  return 'SPRD'
}

const R_NM = 3440.065
const RAD = Math.PI / 180

function destPoint(lat: number, lng: number, brgDeg: number, distNmIn: number): [number, number] {
  const δ = distNmIn / R_NM
  const θ = brgDeg * RAD
  const φ1 = lat * RAD, λ1 = lng * RAD
  const sinφ1 = Math.sin(φ1), cosφ1 = Math.cos(φ1)
  const sinδ = Math.sin(δ), cosδ = Math.cos(δ)
  const sinφ2 = sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(θ)
  const φ2 = Math.asin(sinφ2)
  const y = Math.sin(θ) * sinδ * cosφ1
  const x = cosδ - sinφ1 * sinφ2
  const λ2 = λ1 + Math.atan2(y, x)
  return [((λ2 * 180 / Math.PI) + 540) % 360 - 180, φ2 * 180 / Math.PI]
}

const SRC_PLUME = 'ctf-plume-src'
const LYR_PLUME = 'ctf-plume-lyr'
const SRC_LBL = 'ctf-lbl-src'
const LYR_LBL = 'ctf-lbl-lyr'

// plume length in nm by tier
const TIER_LEN: Record<CT, number> = { NONE:0, SHORT:3, PERS:18, SPRD:45 }

export default function ContrailForecast({ map, flights, onClose, onFly }: Props) {
  const [showPlume, setShowPlume] = useState(true)
  const [showLabels, setShowLabels] = useState(false)
  const [minTier, setMinTier] = useState<CT>('SHORT')
  const [search, setSearch] = useState('')
  const [topN, setTopN] = useState(30)
  const installed = useRef(false)

  const classified = useMemo(() => flights.map(f => {
    const klass = airClass(f.type)
    const oatUsed = (f.oat && Math.abs(f.oat) < 100 && f.oat !== 0) ? f.oat : isaOatC(f.altitudeFt)
    const tier = classify(f.altitudeFt, f.oat, f.ground, klass)
    // climate forcing proxy score
    const len = TIER_LEN[tier]
    const hw = PLUME_HW[klass] || 0.18
    const score = len * hw * 100 * TIER_W[tier] * EMIT_FAC[klass]
    return { ...f, klass, oatUsed, tier, score, plumeLen: len, plumeHW: hw }
  }), [flights])

  const counts = useMemo(() => {
    const o: Record<CT, number> = { NONE:0, SHORT:0, PERS:0, SPRD:0 }
    for (const f of classified) o[f.tier]++
    return o
  }, [classified])

  const rank: Record<CT, number> = { NONE:0, SHORT:1, PERS:2, SPRD:3 }
  const visible = useMemo(
    () => classified.filter(f => rank[f.tier] >= rank[minTier]),
    [classified, minTier]
  )

  // Build trailing plume polygons (tapered, fading aft)
  const plumeGJ = useMemo(() => {
    const feats: any[] = []
    for (const f of visible) {
      if (f.tier === 'NONE') continue
      const len = f.plumeLen
      const hw = f.plumeHW
      const recip = (f.track + 180) % 360
      const seg = 6
      const ring: [number, number][] = []
      // left edge nose -> tail (taper out then back in)
      for (let i = 0; i <= seg; i++) {
        const t = i / seg
        const wScale = i === 0 ? 0.1 : 1 - t * 0.55
        const along = len * t
        const center = destPoint(f.lat, f.lng, recip, along)
        const left = destPoint(center[1], center[0], (recip - 90 + 360) % 360, hw * wScale)
        ring.push(left)
      }
      for (let i = seg; i >= 0; i--) {
        const t = i / seg
        const wScale = i === 0 ? 0.1 : 1 - t * 0.55
        const along = len * t
        const center = destPoint(f.lat, f.lng, recip, along)
        const right = destPoint(center[1], center[0], (recip + 90) % 360, hw * wScale)
        ring.push(right)
      }
      ring.push(ring[0])
      feats.push({
        type: 'Feature',
        properties: {
          color: COLOR[f.tier],
          tier: f.tier,
          opacity: f.tier === 'SPRD' ? 0.42 : f.tier === 'PERS' ? 0.32 : 0.18,
        },
        geometry: { type: 'Polygon', coordinates: [ring] },
      })
    }
    return { type: 'FeatureCollection', features: feats } as any
  }, [visible])

  const labelGJ = useMemo(() => ({
    type: 'FeatureCollection',
    features: visible.filter(f => f.tier !== 'NONE').map(f => ({
      type: 'Feature',
      properties: { label: `${f.callsign || f.icao} ${LABEL[f.tier]}`, color: COLOR[f.tier] },
      geometry: { type: 'Point', coordinates: [f.lng, f.lat] },
    })),
  } as any), [visible])

  useEffect(() => {
    if (!map) return
    const m = map
    const install = () => {
      try {
        if (!m.getSource(SRC_PLUME)) m.addSource(SRC_PLUME, { type: 'geojson', data: plumeGJ })
        if (!m.getLayer(LYR_PLUME)) m.addLayer({
          id: LYR_PLUME, type: 'fill', source: SRC_PLUME,
          paint: {
            'fill-color': ['get', 'color'],
            'fill-opacity': ['get', 'opacity'],
            'fill-outline-color': ['get', 'color'],
          },
        })
        if (!m.getSource(SRC_LBL)) m.addSource(SRC_LBL, { type: 'geojson', data: labelGJ })
        if (!m.getLayer(LYR_LBL)) m.addLayer({
          id: LYR_LBL, type: 'symbol', source: SRC_LBL,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 10,
            'text-offset': [0, -1.6],
            'text-anchor': 'bottom',
            'text-allow-overlap': false,
          },
          paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.4 },
        })
        installed.current = true
      } catch {}
    }
    if (m.isStyleLoaded()) install()
    else m.once('load', install)
    return () => {
      try {
        for (const l of [LYR_LBL, LYR_PLUME]) if (m.getLayer(l)) m.removeLayer(l)
        for (const s of [SRC_LBL, SRC_PLUME]) if (m.getSource(s)) m.removeSource(s)
      } catch {}
      installed.current = false
    }
  }, [map])

  useEffect(() => {
    if (!map || !installed.current) return
    try {
      ;(map.getSource(SRC_PLUME) as any)?.setData(showPlume ? plumeGJ : { type:'FeatureCollection', features:[] })
      ;(map.getSource(SRC_LBL) as any)?.setData(showLabels ? labelGJ : { type:'FeatureCollection', features:[] })
    } catch {}
  }, [map, plumeGJ, labelGJ, showPlume, showLabels])

  const q = search.trim().toLowerCase()
  const list = useMemo(() => {
    const filtered = q
      ? visible.filter(f => f.callsign?.toLowerCase().includes(q) || f.icao.toLowerCase().includes(q) || f.type?.toLowerCase().includes(q) || f.operator?.toLowerCase().includes(q))
      : visible
    return [...filtered].sort((a, b) => b.score - a.score).slice(0, topN)
  }, [visible, q, topN])

  const totalScore = useMemo(() => visible.reduce((s, f) => s + f.score, 0), [visible])

  return (
    <div className="absolute top-20 right-3 z-30 w-[360px] max-h-[calc(100vh-120px)] overflow-hidden rounded-xl border border-white/10 bg-slate-950/90 backdrop-blur shadow-2xl text-slate-200 flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <div>
          <div className="text-xs font-semibold tracking-wider text-slate-100">CONTRAIL FORECAST</div>
          <div className="text-[10px] text-slate-400">Schmidt–Appleman · {visible.filter(f=>f.tier!=='NONE').length} forming · ΣCFS {Math.round(totalScore)}</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white text-lg leading-none px-2">×</button>
      </div>

      <div className="grid grid-cols-4 gap-1 px-3 py-2 border-b border-white/10">
        {ORDER.map(c => (
          <button
            key={c}
            onClick={() => setMinTier(c)}
            className={`rounded px-1 py-1 text-center border transition ${minTier===c ? 'border-white/40 bg-white/10' : 'border-white/5 bg-white/5 hover:bg-white/10'}`}
          >
            <div className="text-[9px] text-slate-400">{LABEL[c]}</div>
            <div className="text-xs font-bold tabular-nums" style={{ color: COLOR[c] }}>{counts[c]}</div>
          </button>
        ))}
      </div>

      <div className="px-3 py-2 border-b border-white/10 space-y-2">
        <div className="flex gap-1 text-[10px]">
          <button onClick={()=>setShowPlume(v=>!v)} className={`flex-1 px-2 py-1 rounded border ${showPlume ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200' : 'border-white/10 text-slate-400'}`}>PLUME</button>
          <button onClick={()=>setShowLabels(v=>!v)} className={`flex-1 px-2 py-1 rounded border ${showLabels ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200' : 'border-white/10 text-slate-400'}`}>LABELS</button>
        </div>
        <div className="flex gap-1 items-center text-[10px] text-slate-400">
          <span className="w-12">TOP</span>
          <input type="range" min={10} max={100} step={5} value={topN} onChange={e=>setTopN(Number(e.target.value))} className="flex-1" />
          <span className="w-8 text-right tabular-nums text-slate-200">{topN}</span>
        </div>
        <input
          value={search}
          onChange={e=>setSearch(e.target.value)}
          placeholder="search callsign / type / operator"
          className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-[11px] placeholder:text-slate-500 focus:outline-none focus:border-white/30"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-3 py-1 text-[10px] tracking-wider text-slate-400 sticky top-0 bg-slate-950/90 flex justify-between">
          <span>TOP PRODUCERS</span>
          <span className="text-slate-500">CFS</span>
        </div>
        {list.length === 0 && <div className="px-3 py-6 text-center text-[11px] text-slate-500">No aircraft match the filter.</div>}
        {list.map(f => (
          <button
            key={f.icao}
            onClick={() => onFly?.(f.icao)}
            className="w-full text-left px-3 py-2 hover:bg-white/5 flex items-center gap-2 border-t border-white/5"
          >
            <div className="w-2 h-9 rounded" style={{ background: COLOR[f.tier] }} />
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-mono truncate">
                {f.callsign || f.icao}
                <span className="text-slate-500"> · </span>
                <span className="text-slate-300">{f.type || '—'}</span>
              </div>
              <div className="text-[10px] text-slate-400 truncate">
                {LABEL[f.tier]} · FL{Math.round(f.altitudeFt/100).toString().padStart(3,'0')} · OAT {f.oatUsed.toFixed(0)}°C · {f.klass}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11px] font-bold tabular-nums" style={{ color: COLOR[f.tier] }}>{Math.round(f.score)}</div>
              <div className="text-[9px] text-slate-500 tabular-nums">{f.plumeLen}nm</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
