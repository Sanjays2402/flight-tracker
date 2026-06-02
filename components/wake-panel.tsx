'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Wake Turbulence Panel
   -----------------------------------------------------------
   Classifies every airborne aircraft by ICAO RECAT-EU / wake
   category (Super / Heavy / Upper-Medium / Lower-Medium / Light)
   from the ICAO type designator, draws a trailing wake corridor
   polygon (decaying width + opacity behind the generator) for
   every Heavy and Super, and computes "at-risk" followers:
   any aircraft within the wake cone of a larger generator, at
   lower altitude, on a similar track, within ~6 nm.
   ============================================================ */

export interface WakePlane {
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
}

interface Props {
  map: maplibregl.Map | null
  flights: WakePlane[]
  onClose: () => void
  onFly?: (icao: string) => void
}

type WakeCat = 'J' | 'H' | 'M+' | 'M-' | 'L' | '?'
// J=Super(A380/An225) H=Heavy M+=Upper Medium M-=Lower Medium L=Light

const HEAVY = new Set(['A30B','A306','A310','A332','A333','A337','A338','A339','A342','A343','A345','A346','A359','A35K','A35X','A337','B742','B743','B744','B748','B752','B753','B762','B763','B764','B772','B77L','B773','B77W','B778','B779','B788','B789','B78X','DC10','MD11','IL62','IL76','IL86','IL96','A30F','A33F','B74F','B74S','B77F','B77X','MD1F','C5','C5M','C17','C141','KC10','KC46','KC35','E767','E3CF','E3TF','E4','VC25','RJ85','BLCF'])
const SUPER = new Set(['A388','A38F','A124','A225','AN22'])
const UPPER_MED = new Set(['B752','B753','B757','B763','B762','TU54','TU34','B722','B721','B720','MD80','MD81','MD82','MD83','MD87','MD88','MD90','B712','B717','A318','A319','A320','A321','A20N','A21N','A19N','B732','B733','B734','B735','B736','B737','B738','B739','B73G','B73H','E190','E195','E290','E295','BCS1','BCS3','A220','CRJ9','CRJX'])
const LOWER_MED = new Set(['CRJ1','CRJ2','CRJ7','E135','E140','E145','E170','E175','AT43','AT45','AT72','AT75','AT76','DH8A','DH8B','DH8C','DH8D','SF34','SF50','J328','F100','F70','F50','F28','BE40','HDJN','C525','C550','C560','C56X','C680','C700','C750','GLF4','GLF5','GLF6','GL5T','GL7T','LJ35','LJ40','LJ45','LJ60','LJ75','E55P','E50P','PC24','EA50'])
const LIGHT = new Set(['C172','C152','C182','C206','C208','PA28','PA32','SR20','SR22','DA40','DA42','DA62','BE36','BE58','BE76','BE9L','BE20','PC12','TBM7','TBM8','TBM9','TBMA','M20P','M20T'])

function classify(type: string): WakeCat {
  if (!type) return '?'
  const t = type.toUpperCase()
  if (SUPER.has(t)) return 'J'
  if (HEAVY.has(t)) return 'H'
  if (UPPER_MED.has(t)) return 'M+'
  if (LOWER_MED.has(t)) return 'M-'
  if (LIGHT.has(t)) return 'L'
  // crude prefix fallback
  if (t.startsWith('B74') || t.startsWith('B77') || t.startsWith('B78') || t.startsWith('A33') || t.startsWith('A34') || t.startsWith('A35') || t.startsWith('B76') || t.startsWith('B75')) return 'H'
  if (t.startsWith('A38')) return 'J'
  if (t.startsWith('A32') || t.startsWith('A21') || t.startsWith('A22') || t.startsWith('B73') || t.startsWith('E19') || t.startsWith('E29') || t.startsWith('BCS')) return 'M+'
  if (t.startsWith('E1') || t.startsWith('CRJ') || t.startsWith('DH') || t.startsWith('AT')) return 'M-'
  if (t.startsWith('C1') || t.startsWith('C2') || t.startsWith('PA') || t.startsWith('SR') || t.startsWith('DA')) return 'L'
  return '?'
}

const CAT_ORDER: WakeCat[] = ['J','H','M+','M-','L','?']
const CAT_COLOR: Record<WakeCat,string> = { J:'#a855f7', H:'#ef4444', 'M+':'#f59e0b', 'M-':'#22d3ee', L:'#10b981', '?':'#94a3b8' }
const CAT_LABEL: Record<WakeCat,string> = { J:'SUPER', H:'HEAVY', 'M+':'UPPER MED', 'M-':'LOWER MED', L:'LIGHT', '?':'UNKNOWN' }
// initial wake half-width (nm) by generator category
const WAKE_WIDTH: Record<WakeCat,number> = { J:0.6, H:0.45, 'M+':0.25, 'M-':0.15, L:0.08, '?':0.2 }
// wake persistence in nm behind generator
const WAKE_LEN: Record<WakeCat,number> = { J:14, H:10, 'M+':5, 'M-':3, L:1.5, '?':4 }

const R_NM = 3440.065
const RAD = Math.PI / 180

function distNm(a: {lat:number,lng:number}, b:{lat:number,lng:number}) {
  const dLat = (b.lat-a.lat)*RAD, dLng=(b.lng-a.lng)*RAD
  const la1 = a.lat*RAD, la2 = b.lat*RAD
  const x = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2
  return 2*R_NM*Math.asin(Math.min(1,Math.sqrt(x)))
}

function destPoint(lat: number, lng: number, brgDeg: number, distNmIn: number): [number, number] {
  const δ = distNmIn / R_NM
  const θ = brgDeg * RAD
  const φ1 = lat * RAD, λ1 = lng * RAD
  const sinφ1 = Math.sin(φ1), cosφ1 = Math.cos(φ1)
  const sinδ = Math.sin(δ), cosδ = Math.cos(δ)
  const sinφ2 = sinφ1*cosδ + cosφ1*sinδ*Math.cos(θ)
  const φ2 = Math.asin(sinφ2)
  const y = Math.sin(θ)*sinδ*cosφ1
  const x = cosδ - sinφ1*sinφ2
  const λ2 = λ1 + Math.atan2(y, x)
  return [((λ2*180/Math.PI)+540)%360 - 180, φ2*180/Math.PI]
}

function bearing(a:{lat:number,lng:number}, b:{lat:number,lng:number}): number {
  const φ1 = a.lat*RAD, φ2 = b.lat*RAD, Δλ = (b.lng-a.lng)*RAD
  const y = Math.sin(Δλ)*Math.cos(φ2)
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ)
  return (Math.atan2(y,x)*180/Math.PI + 360) % 360
}

const SRC_CORR = 'wake-corridors-src'
const LYR_CORR = 'wake-corridors-lyr'
const SRC_LBL = 'wake-labels-src'
const LYR_LBL = 'wake-labels-lyr'
const SRC_RISK = 'wake-risk-src'
const LYR_RISK = 'wake-risk-lyr'

export default function WakePanel({ map, flights, onClose, onFly }: Props) {
  const [showCorridor, setShowCorridor] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showRisk, setShowRisk] = useState(true)
  const [minCat, setMinCat] = useState<WakeCat>('H') // draw corridors for this and bigger
  const [search, setSearch] = useState('')
  const [riskOnly, setRiskOnly] = useState(false)
  const installedRef = useRef(false)

  // classify all
  const classified = useMemo(() => flights.map(f => ({ ...f, cat: classify(f.type) })), [flights])

  const counts = useMemo(() => {
    const o: Record<WakeCat, number> = { J:0, H:0, 'M+':0, 'M-':0, L:0, '?':0 }
    for (const f of classified) o[f.cat]++
    return o
  }, [classified])

  // wake generators
  const generators = useMemo(() => {
    const rank: Record<WakeCat, number> = { J:5, H:4, 'M+':3, 'M-':2, L:1, '?':0 }
    return classified.filter(f => !f.ground && f.altitudeFt > 100 && rank[f.cat] >= rank[minCat])
  }, [classified, minCat])

  // at-risk followers: smaller cat, behind a larger generator, within wake corridor
  const risks = useMemo(() => {
    const rank: Record<WakeCat, number> = { J:5, H:4, 'M+':3, 'M-':2, L:1, '?':0 }
    const out: Array<{ gen: typeof classified[0], rcv: typeof classified[0], range: number, sev: 'high'|'med'|'low' }> = []
    for (const gen of generators) {
      const len = WAKE_LEN[gen.cat]
      const halfW = WAKE_WIDTH[gen.cat]
      for (const rcv of classified) {
        if (rcv.icao === gen.icao) continue
        if (rcv.ground) continue
        if (rank[rcv.cat] >= rank[gen.cat]) continue // only smaller at risk
        // must be below or near same alt (wake sinks ~500ft/min)
        const altDiff = gen.altitudeFt - rcv.altitudeFt
        if (altDiff < -200 || altDiff > 1500) continue
        const r = distNm(gen, rcv)
        if (r > len) continue
        // bearing from gen to rcv vs generator's reciprocal track (behind)
        const brgGenToRcv = bearing(gen, rcv)
        const recip = (gen.track + 180) % 360
        let off = Math.abs(((brgGenToRcv - recip + 540) % 360) - 180)
        if (off > 90) continue
        // cross-track distance
        const xtrack = r * Math.sin(off * RAD)
        if (xtrack > halfW) continue
        const sev: 'high'|'med'|'low' = r < len*0.33 ? 'high' : r < len*0.66 ? 'med' : 'low'
        out.push({ gen, rcv, range: r, sev })
      }
    }
    out.sort((a,b) => (a.sev === b.sev ? a.range - b.range : (a.sev === 'high' ? -1 : b.sev === 'high' ? 1 : a.sev === 'med' ? -1 : 1)))
    return out
  }, [generators, classified])

  // build corridors GeoJSON
  const corridorsGJ = useMemo(() => {
    const feats: any[] = []
    for (const g of generators) {
      const halfW = WAKE_WIDTH[g.cat]
      const len = WAKE_LEN[g.cat]
      const recip = (g.track + 180) % 360
      // taper: build 6 segments with decaying width
      const seg = 6
      const ring: [number,number][] = []
      // left side from nose to tail
      for (let i = 0; i <= seg; i++) {
        const f = i / seg
        const w = halfW * (1 - f*0.7) // taper
        const along = len * f
        const center = destPoint(g.lat, g.lng, recip, along)
        const left = destPoint(center[1], center[0], (recip - 90 + 360) % 360, w)
        ring.push(left)
      }
      // right side tail to nose
      for (let i = seg; i >= 0; i--) {
        const f = i / seg
        const w = halfW * (1 - f*0.7)
        const along = len * f
        const center = destPoint(g.lat, g.lng, recip, along)
        const right = destPoint(center[1], center[0], (recip + 90) % 360, w)
        ring.push(right)
      }
      ring.push(ring[0])
      feats.push({
        type: 'Feature',
        properties: { color: CAT_COLOR[g.cat], cat: g.cat, callsign: g.callsign, icao: g.icao },
        geometry: { type: 'Polygon', coordinates: [ring] },
      })
    }
    return { type: 'FeatureCollection', features: feats } as any
  }, [generators])

  const labelsGJ = useMemo(() => ({
    type: 'FeatureCollection',
    features: generators.map(g => ({
      type: 'Feature',
      properties: { label: `${g.callsign || g.icao} ${CAT_LABEL[g.cat]}`, color: CAT_COLOR[g.cat] },
      geometry: { type: 'Point', coordinates: [g.lng, g.lat] },
    })),
  } as any), [generators])

  const riskGJ = useMemo(() => ({
    type: 'FeatureCollection',
    features: risks.map(r => ({
      type: 'Feature',
      properties: { color: r.sev === 'high' ? '#ef4444' : r.sev === 'med' ? '#f59e0b' : '#22d3ee' },
      geometry: { type: 'LineString', coordinates: [[r.gen.lng, r.gen.lat], [r.rcv.lng, r.rcv.lat]] },
    })),
  } as any), [risks])

  // install / update layers
  useEffect(() => {
    if (!map) return
    const m = map
    const install = () => {
      try {
        if (!m.getSource(SRC_CORR)) m.addSource(SRC_CORR, { type: 'geojson', data: corridorsGJ })
        if (!m.getLayer(LYR_CORR)) m.addLayer({
          id: LYR_CORR, type: 'fill', source: SRC_CORR,
          paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.18, 'fill-outline-color': ['get', 'color'] },
        })
        if (!m.getSource(SRC_LBL)) m.addSource(SRC_LBL, { type: 'geojson', data: labelsGJ })
        if (!m.getLayer(LYR_LBL)) m.addLayer({
          id: LYR_LBL, type: 'symbol', source: SRC_LBL,
          layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-allow-overlap': false },
          paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.4 },
        })
        if (!m.getSource(SRC_RISK)) m.addSource(SRC_RISK, { type: 'geojson', data: riskGJ })
        if (!m.getLayer(LYR_RISK)) m.addLayer({
          id: LYR_RISK, type: 'line', source: SRC_RISK,
          paint: { 'line-color': ['get','color'], 'line-width': 2, 'line-dasharray': [2,2], 'line-opacity': 0.9 },
        })
        installedRef.current = true
      } catch {}
    }
    if (m.isStyleLoaded()) install()
    else m.once('load', install)
    return () => {
      try {
        for (const l of [LYR_RISK, LYR_LBL, LYR_CORR]) if (m.getLayer(l)) m.removeLayer(l)
        for (const s of [SRC_RISK, SRC_LBL, SRC_CORR]) if (m.getSource(s)) m.removeSource(s)
      } catch {}
      installedRef.current = false
    }
  }, [map])

  useEffect(() => {
    if (!map || !installedRef.current) return
    try {
      ;(map.getSource(SRC_CORR) as any)?.setData(showCorridor ? corridorsGJ : { type:'FeatureCollection', features:[] })
      ;(map.getSource(SRC_LBL) as any)?.setData(showLabels ? labelsGJ : { type:'FeatureCollection', features:[] })
      ;(map.getSource(SRC_RISK) as any)?.setData(showRisk ? riskGJ : { type:'FeatureCollection', features:[] })
    } catch {}
  }, [map, corridorsGJ, labelsGJ, riskGJ, showCorridor, showLabels, showRisk])

  const q = search.trim().toLowerCase()
  const listGenerators = useMemo(() => {
    if (riskOnly) {
      const riskyIcao = new Set(risks.map(r => r.gen.icao))
      return generators.filter(g => riskyIcao.has(g.icao))
    }
    if (!q) return generators
    return generators.filter(g => g.callsign?.toLowerCase().includes(q) || g.icao.toLowerCase().includes(q) || g.type?.toLowerCase().includes(q))
  }, [generators, q, riskOnly, risks])

  const highRiskCount = risks.filter(r => r.sev === 'high').length
  const medRiskCount = risks.filter(r => r.sev === 'med').length

  return (
    <div className="absolute top-20 right-3 z-30 w-[360px] max-h-[calc(100vh-120px)] overflow-hidden rounded-xl border border-white/10 bg-slate-950/90 backdrop-blur shadow-2xl text-slate-200 flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <div>
          <div className="text-xs font-semibold tracking-wider text-slate-100">WAKE TURBULENCE</div>
          <div className="text-[10px] text-slate-400">{generators.length} generators · {risks.length} at-risk</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white text-lg leading-none px-2">×</button>
      </div>

      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-white/10">
        {CAT_ORDER.map(c => (
          <div key={c} className="rounded bg-white/5 px-1 py-1 text-center">
            <div className="text-[9px] text-slate-400">{c}</div>
            <div className="text-xs font-bold tabular-nums" style={{ color: CAT_COLOR[c] }}>{counts[c]}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-white/10 text-[10px]">
        <div className="rounded bg-rose-500/15 border border-rose-500/30 px-2 py-1 text-rose-300">
          <div className="text-[9px] opacity-70">HIGH</div>
          <div className="font-bold tabular-nums">{highRiskCount}</div>
        </div>
        <div className="rounded bg-amber-500/15 border border-amber-500/30 px-2 py-1 text-amber-300">
          <div className="text-[9px] opacity-70">MED</div>
          <div className="font-bold tabular-nums">{medRiskCount}</div>
        </div>
        <div className="rounded bg-cyan-500/15 border border-cyan-500/30 px-2 py-1 text-cyan-300">
          <div className="text-[9px] opacity-70">LOW</div>
          <div className="font-bold tabular-nums">{risks.length - highRiskCount - medRiskCount}</div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-white/10 space-y-2">
        <div className="flex gap-1">
          {(['J','H','M+','M-','L'] as WakeCat[]).map(c => (
            <button key={c} onClick={() => setMinCat(c)}
              className={`flex-1 text-[10px] px-1 py-1 rounded border transition ${minCat===c ? 'border-white/40 bg-white/10 text-white' : 'border-white/10 text-slate-400 hover:bg-white/5'}`}>
              ≥{c}
            </button>
          ))}
        </div>
        <div className="flex gap-1 text-[10px]">
          <button onClick={()=>setShowCorridor(v=>!v)} className={`flex-1 px-2 py-1 rounded border ${showCorridor ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200' : 'border-white/10 text-slate-400'}`}>CORRIDOR</button>
          <button onClick={()=>setShowLabels(v=>!v)} className={`flex-1 px-2 py-1 rounded border ${showLabels ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200' : 'border-white/10 text-slate-400'}`}>LABEL</button>
          <button onClick={()=>setShowRisk(v=>!v)} className={`flex-1 px-2 py-1 rounded border ${showRisk ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200' : 'border-white/10 text-slate-400'}`}>RISK</button>
        </div>
        <div className="flex gap-1">
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search callsign / type"
            className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-[11px] placeholder:text-slate-500 focus:outline-none focus:border-white/30" />
          <button onClick={()=>setRiskOnly(v=>!v)} className={`px-2 text-[10px] rounded border ${riskOnly ? 'border-rose-500/50 bg-rose-500/15 text-rose-200' : 'border-white/10 text-slate-400'}`}>!RISK</button>
        </div>
      </div>

      {risks.length > 0 && (
        <div className="border-b border-white/10">
          <div className="px-3 py-1 text-[10px] tracking-wider text-slate-400">AT-RISK FOLLOWERS</div>
          <div className="max-h-[140px] overflow-y-auto">
            {risks.slice(0, 30).map((r, i) => (
              <button key={i} onClick={() => onFly?.(r.rcv.icao)}
                className="w-full text-left px-3 py-1.5 hover:bg-white/5 flex items-center gap-2 border-t border-white/5">
                <div className={`w-1.5 h-6 rounded ${r.sev==='high'?'bg-rose-500':r.sev==='med'?'bg-amber-500':'bg-cyan-500'}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-mono truncate">{r.rcv.callsign || r.rcv.icao} <span className="text-slate-500">←</span> {r.gen.callsign || r.gen.icao}</div>
                  <div className="text-[9px] text-slate-400">{CAT_LABEL[r.rcv.cat]} behind {CAT_LABEL[r.gen.cat]} · {r.range.toFixed(1)}nm · Δ{(r.gen.altitudeFt - r.rcv.altitudeFt).toFixed(0)}ft</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="px-3 py-1 text-[10px] tracking-wider text-slate-400 sticky top-0 bg-slate-950/90">GENERATORS</div>
        {listGenerators.length === 0 && <div className="px-3 py-6 text-center text-[11px] text-slate-500">No matching wake generators.</div>}
        {listGenerators.map(g => (
          <button key={g.icao} onClick={() => onFly?.(g.icao)}
            className="w-full text-left px-3 py-2 hover:bg-white/5 flex items-center gap-2 border-t border-white/5">
            <div className="w-2 h-8 rounded" style={{ background: CAT_COLOR[g.cat] }} />
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-mono truncate">{g.callsign || g.icao} <span className="text-slate-500">·</span> <span className="text-slate-300">{g.type}</span></div>
              <div className="text-[10px] text-slate-400">{CAT_LABEL[g.cat]} · FL{Math.round(g.altitudeFt/100).toString().padStart(3,'0')} · {Math.round(g.velocityKts)}kt · trk {Math.round(g.track)}°</div>
            </div>
            <div className="text-[9px] text-slate-500 font-mono">{g.icao}</div>
          </button>
        ))}
      </div>
    </div>
  )
}
