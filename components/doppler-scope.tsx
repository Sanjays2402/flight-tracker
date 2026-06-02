'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Doppler Scope
   -----------------------------------------------------------
   Treats the observer (map center or browser geolocation) as a
   stationary radar site and resolves every airborne aircraft's
   ground vector into a *radial velocity* component along the
   observer->aircraft line. Positive Vr = receding (red-shift),
   negative Vr = approaching (blue-shift). Also computes the
   tangential component (perpendicular drift speed) and the
   instantaneous range-rate / range fraction.

   Math (all in great-circle nm + true bearings):
     bearing  = compass bearing from observer to aircraft
     range    = great-circle nm between them
     trk      = aircraft true track (deg)
     gs       = ground speed (kts)
     theta    = trk - (bearing+180)  // angle between velocity
                                     //  and the line FROM the
                                     //  aircraft TO observer
     Vr_app   = gs * cos(theta)      // approach component (kts)
     Vr       = -Vr_app              // recede positive
     Vt       = gs * sin(theta)      // tangential (kts)
     dopplerHz = (Vr * 1852/3600) / c * f0
       (illustrative, picks an L-band 1090MHz reference)

   Classification (5 tiers, 4 active + neutral):
     INBOUND-FAST   approach >=  200 kt
     INBOUND        approach >=   50 kt
     CROSSING       |approach| <   50 kt and |Vt| >= 50
     OUTBOUND       recede   >=   50 kt
     OUTBOUND-FAST  recede   >=  200 kt

   Map overlay:
     * Per-aircraft halo circle, color = tier.
     * Geodesic line observer->aircraft, color = tier.
     * Arrow marker on the line at 60% from observer toward
       aircraft, rotated to show the radial direction.
     * Cyan observer pin with halo + 8-bearing reticle ring.
     * Optional callsign + signed Vr labels.

   Side panel:
     * Big animated SVG polar scope (azimuth around, range
       outward, color = approach/recede). N at top, range
       rings drawn at 25/50/75/100% of selected MAX-RNG.
     * 5-cell counter strip (tier filter).
     * MAX-RNG slider (10-300nm), MIN-VR slider (0-400kt),
       OBSERVER toggle (CENTER vs GEO), OVL/LABELS toggles.
     * Sum of approach kts and median range readouts.
     * Search + sorted list (default by |Vr| desc) with
       per-row tier stripe, callsign/type/operator,
       Vr/Vt/RNG/BRG readout, click-to-fly.
   ============================================================ */

export interface DopFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: DopFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'INBOUND-FAST' | 'INBOUND' | 'CROSSING' | 'OUTBOUND' | 'OUTBOUND-FAST'

const TIER_COLOR: Record<Tier, string> = {
  'INBOUND-FAST': '#22d3ee',
  INBOUND: '#38bdf8',
  CROSSING: '#a78bfa',
  OUTBOUND: '#fb7185',
  'OUTBOUND-FAST': '#f43f5e',
}
const TIERS: Tier[] = ['INBOUND-FAST', 'INBOUND', 'CROSSING', 'OUTBOUND', 'OUTBOUND-FAST']

const R_NM = 3440.065
function rad(d: number) { return d * Math.PI / 180 }
function deg(r: number) { return r * 180 / Math.PI }
function gcNm(a: [number, number], b: [number, number]) {
  const [la1, lo1] = [rad(a[1]), rad(a[0])]
  const [la2, lo2] = [rad(b[1]), rad(b[0])]
  const dla = la2 - la1, dlo = lo2 - lo1
  const h = Math.sin(dla/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dlo/2)**2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)))
}
function bearingDeg(a: [number, number], b: [number, number]) {
  const la1 = rad(a[1]), la2 = rad(b[1])
  const dlo = rad(b[0] - a[0])
  const y = Math.sin(dlo) * Math.cos(la2)
  const x = Math.cos(la1)*Math.sin(la2) - Math.sin(la1)*Math.cos(la2)*Math.cos(dlo)
  return (deg(Math.atan2(y, x)) + 360) % 360
}
function destPoint(a: [number, number], brgDeg: number, nm: number): [number, number] {
  const br = rad(brgDeg), d = nm / R_NM
  const la1 = rad(a[1]), lo1 = rad(a[0])
  const la2 = Math.asin(Math.sin(la1)*Math.cos(d) + Math.cos(la1)*Math.sin(d)*Math.cos(br))
  const lo2 = lo1 + Math.atan2(Math.sin(br)*Math.sin(d)*Math.cos(la1), Math.cos(d)-Math.sin(la1)*Math.sin(la2))
  return [((deg(lo2)+540)%360)-180, deg(la2)]
}
function geodesicLine(a: [number, number], b: [number, number], n=24): [number, number][] {
  const la1=rad(a[1]), lo1=rad(a[0]), la2=rad(b[1]), lo2=rad(b[0])
  const dla=la2-la1, dlo=lo2-lo1
  const h=Math.sin(dla/2)**2+Math.cos(la1)*Math.cos(la2)*Math.sin(dlo/2)**2
  const d=2*Math.asin(Math.min(1,Math.sqrt(h)))
  if (d < 1e-7) return [a,b]
  const pts: [number,number][] = []
  for (let i=0;i<=n;i++) {
    const f=i/n
    const A=Math.sin((1-f)*d)/Math.sin(d), B=Math.sin(f*d)/Math.sin(d)
    const x=A*Math.cos(la1)*Math.cos(lo1)+B*Math.cos(la2)*Math.cos(lo2)
    const y=A*Math.cos(la1)*Math.sin(lo1)+B*Math.cos(la2)*Math.sin(lo2)
    const z=A*Math.sin(la1)+B*Math.sin(la2)
    pts.push([deg(Math.atan2(y,x)), deg(Math.atan2(z, Math.sqrt(x*x+y*y)))])
  }
  return pts
}

interface Row {
  f: DopFlight
  range: number
  bearing: number
  vr: number      // +recede / -approach (kts)
  vt: number      // tangential drift kts
  approach: number // -vr (kts, positive=closing)
  tier: Tier
  dopplerHz: number
}

export default function DopplerScope({ map, flights, onClose, onFly }: Props) {
  const [maxRng, setMaxRng] = useState(120)
  const [minVr, setMinVr] = useState(0)
  const [useGeo, setUseGeo] = useState(false)
  const [overlay, setOverlay] = useState(true)
  const [labels, setLabels] = useState(true)
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [query, setQuery] = useState('')
  const [geo, setGeo] = useState<[number,number] | null>(null)
  const [center, setCenter] = useState<[number,number]>(() => {
    try { const c = map?.getCenter(); return c ? [c.lng, c.lat] : [-122.4,37.6] } catch { return [-122.4,37.6] }
  })
  const [tick, setTick] = useState(0)

  // observer
  useEffect(() => {
    if (!useGeo) return
    if (!('geolocation' in navigator)) return
    const id = navigator.geolocation.watchPosition(
      p => setGeo([p.coords.longitude, p.coords.latitude]),
      () => setGeo(null), { enableHighAccuracy: false, maximumAge: 30000 }
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [useGeo])

  // follow map center
  useEffect(() => {
    if (!map) return
    const upd = () => { const c = map.getCenter(); setCenter([c.lng, c.lat]) }
    map.on('moveend', upd); upd()
    return () => { map.off('moveend', upd) }
  }, [map])

  // animated scope tick
  useEffect(() => { const id = setInterval(() => setTick(t=>t+1), 1000); return () => clearInterval(id) }, [])

  const observer: [number,number] = useMemo(() => useGeo && geo ? geo : center, [useGeo, geo, center])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.lat) || !isFinite(f.lng)) continue
      if (!isFinite(f.velocityKts) || f.velocityKts < 10) continue
      const range = gcNm(observer, [f.lng, f.lat])
      if (range > maxRng) continue
      const brg = bearingDeg(observer, [f.lng, f.lat])
      const reverse = (brg + 180) % 360            // bearing FROM aircraft TO observer
      const theta = rad(((f.track - reverse + 540) % 360) - 180)  // signed
      const approach = f.velocityKts * Math.cos(theta)
      const vr = -approach
      const vt = f.velocityKts * Math.sin(theta)
      let tier: Tier
      if (approach >= 200) tier = 'INBOUND-FAST'
      else if (approach >= 50) tier = 'INBOUND'
      else if (approach <= -200) tier = 'OUTBOUND-FAST'
      else if (approach <= -50) tier = 'OUTBOUND'
      else tier = 'CROSSING'
      if (Math.abs(vr) < minVr) continue
      // illustrative Doppler shift at 1090 MHz
      const c = 299792458
      const f0 = 1.09e9
      const dopplerHz = (vr * 1852/3600) / c * f0
      out.push({ f, range, bearing: brg, vr, vt, approach, tier, dopplerHz })
    }
    return out
  }, [flights, observer, maxRng, minVr])

  const counts = useMemo(() => {
    const r: Record<Tier, number> = { 'INBOUND-FAST':0, INBOUND:0, CROSSING:0, OUTBOUND:0, 'OUTBOUND-FAST':0 }
    for (const x of rows) r[x.tier]++
    return r
  }, [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows
      .filter(r => tierFilter === 'ALL' || r.tier === tierFilter)
      .filter(r => !q || r.f.callsign.toLowerCase().includes(q) || r.f.icao.toLowerCase().includes(q) || (r.f.type||'').toLowerCase().includes(q) || (r.f.operator||'').toLowerCase().includes(q))
      .sort((a,b) => Math.abs(b.vr) - Math.abs(a.vr))
  }, [rows, tierFilter, query])

  const sumApproach = useMemo(() => rows.reduce((s,r) => s + Math.max(0, r.approach), 0), [rows])
  const sumRecede = useMemo(() => rows.reduce((s,r) => s + Math.max(0, -r.approach), 0), [rows])
  const medianRange = useMemo(() => {
    if (!rows.length) return 0
    const s = rows.map(r => r.range).sort((a,b)=>a-b)
    return s[Math.floor(s.length/2)]
  }, [rows])

  // MapLibre overlay
  useEffect(() => {
    if (!map) return
    const SRC = 'doppler-src', LINK = 'doppler-link', OBS = 'doppler-obs-src'
    const ARROW = 'doppler-arrow'
    const ensure = () => {
      if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: { type:'FeatureCollection', features: [] } })
      if (!map.getSource(LINK)) map.addSource(LINK, { type: 'geojson', data: { type:'FeatureCollection', features: [] } })
      if (!map.getSource(OBS)) map.addSource(OBS, { type: 'geojson', data: { type:'FeatureCollection', features: [] } })
      if (!map.getLayer(LINK+'-line')) map.addLayer({
        id: LINK+'-line', type: 'line', source: LINK,
        paint: { 'line-color': ['get','color'], 'line-width': 1.4, 'line-opacity': 0.7, 'line-dasharray': [2,2] }
      })
      if (!map.getLayer(SRC+'-halo')) map.addLayer({
        id: SRC+'-halo', type: 'circle', source: SRC,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 6, 8, 14],
          'circle-color': ['get','color'],
          'circle-opacity': 0.18,
          'circle-stroke-color': ['get','color'],
          'circle-stroke-width': 1.4,
          'circle-stroke-opacity': 0.85,
        }
      })
      if (!map.getLayer(SRC+'-label')) map.addLayer({
        id: SRC+'-label', type: 'symbol', source: SRC,
        filter: ['==', ['geometry-type'], 'Point'],
        layout: {
          'text-field': ['get','label'],
          'text-size': 10, 'text-offset': [0,-1.4], 'text-anchor': 'bottom',
          'text-font': ['Open Sans Regular','Arial Unicode MS Regular'],
          'text-allow-overlap': false,
        },
        paint: { 'text-color': '#e2e8f0', 'text-halo-color': '#0a0f1a', 'text-halo-width': 1.4 }
      })
      if (!map.getLayer(ARROW)) map.addLayer({
        id: ARROW, type: 'symbol', source: LINK,
        filter: ['==', ['geometry-type'], 'Point'],
        layout: {
          'text-field': '▶',
          'text-size': 14,
          'text-rotate': ['get','rot'],
          'text-rotation-alignment': 'map',
          'text-allow-overlap': true,
          'text-font': ['Open Sans Regular','Arial Unicode MS Regular'],
        },
        paint: { 'text-color': ['get','color'], 'text-halo-color': '#0a0f1a', 'text-halo-width': 1.2 }
      })
      if (!map.getLayer(OBS+'-halo')) map.addLayer({
        id: OBS+'-halo', type: 'circle', source: OBS,
        paint: {
          'circle-radius': 10, 'circle-color': '#22d3ee', 'circle-opacity': 0.18,
          'circle-stroke-color': '#22d3ee', 'circle-stroke-width': 2,
        }
      })
    }
    try { ensure() } catch {}

    if (!overlay) {
      try {
        (map.getSource(SRC) as any)?.setData({ type:'FeatureCollection', features: [] })
        ;(map.getSource(LINK) as any)?.setData({ type:'FeatureCollection', features: [] })
        ;(map.getSource(OBS) as any)?.setData({ type:'FeatureCollection', features: [] })
      } catch {}
      return
    }

    const pts: any[] = []
    const links: any[] = []
    for (const r of rows) {
      const col = TIER_COLOR[r.tier]
      pts.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
        properties: {
          color: col,
          label: labels ? `${r.f.callsign}  ${r.vr>=0?'+':''}${r.vr.toFixed(0)}kt` : '',
        }
      })
      const line = geodesicLine(observer, [r.f.lng, r.f.lat], 18)
      links.push({ type:'Feature', geometry:{ type:'LineString', coordinates: line }, properties:{ color: col } })
      // arrow at 60% along great circle, rotated along radial (approach inward = brg+180)
      const arrPt = destPoint(observer, r.bearing, r.range * 0.6)
      const rot = r.approach >= 0 ? r.bearing : (r.bearing + 180) % 360
      links.push({ type:'Feature', geometry:{ type:'Point', coordinates: arrPt }, properties:{ color: col, rot } })
    }
    try {
      (map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: pts })
      ;(map.getSource(LINK) as any).setData({ type:'FeatureCollection', features: links })
      ;(map.getSource(OBS) as any).setData({ type:'FeatureCollection', features: [{
        type:'Feature', geometry:{ type:'Point', coordinates: observer }, properties:{}
      }] })
    } catch {}

    return () => {
      try {
        for (const lid of [SRC+'-halo', SRC+'-label', LINK+'-line', ARROW, OBS+'-halo']) {
          if (map.getLayer(lid)) map.removeLayer(lid)
        }
        for (const sid of [SRC, LINK, OBS]) { if (map.getSource(sid)) map.removeSource(sid) }
      } catch {}
    }
  }, [map, rows, overlay, labels, observer])

  // SVG polar scope geometry
  const SCOPE = 240
  const cx = SCOPE/2, cy = SCOPE/2
  const radius = SCOPE/2 - 14
  const sweepAngle = (tick * 12) % 360 // visual sweep
  const sweepRad = rad(sweepAngle - 90)

  return (
    <div className="absolute top-4 right-4 z-30 w-[380px] max-h-[88vh] flex flex-col rounded-2xl bg-slate-950/95 backdrop-blur border border-slate-800/80 shadow-2xl text-slate-200 font-sans">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800/70">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.18em] text-cyan-400 font-semibold">Doppler Scope</span>
          <span className="text-[10px] text-slate-500">{rows.length} contacts</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-sm leading-none">✕</button>
      </div>

      <div className="px-4 py-3 border-b border-slate-800/70 flex justify-center bg-gradient-to-b from-slate-950 to-slate-900/60">
        <svg width={SCOPE} height={SCOPE} className="block">
          <defs>
            <radialGradient id="dop-scope-bg" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#0e1a2e" />
              <stop offset="100%" stopColor="#020617" />
            </radialGradient>
          </defs>
          <circle cx={cx} cy={cy} r={radius+2} fill="url(#dop-scope-bg)" stroke="#1e293b" />
          {[0.25,0.5,0.75,1].map(f => (
            <circle key={f} cx={cx} cy={cy} r={radius*f} fill="none" stroke="#1e293b" strokeDasharray="2 3" />
          ))}
          {[0,45,90,135,180,225,270,315].map(a => {
            const ar = rad(a-90)
            return <line key={a} x1={cx} y1={cy} x2={cx+Math.cos(ar)*radius} y2={cy+Math.sin(ar)*radius} stroke="#1e293b" />
          })}
          {[['N',0],['E',90],['S',180],['W',270]].map(([l,a]) => {
            const ar = rad((a as number)-90)
            return <text key={l as string} x={cx+Math.cos(ar)*(radius+8)} y={cy+Math.sin(ar)*(radius+8)+3} textAnchor="middle" fontSize="9" fill="#64748b">{l}</text>
          })}
          {/* sweep beam */}
          <line x1={cx} y1={cy} x2={cx+Math.cos(sweepRad)*radius} y2={cy+Math.sin(sweepRad)*radius}
                stroke="#22d3ee" strokeOpacity="0.45" strokeWidth="1.5" />
          {/* contacts */}
          {rows.map(r => {
            const ar = rad(r.bearing - 90)
            const rr = (r.range / maxRng) * radius
            const x = cx + Math.cos(ar)*rr
            const y = cy + Math.sin(ar)*rr
            const col = TIER_COLOR[r.tier]
            const persist = ((sweepAngle - r.bearing + 360) % 360) / 360 // 0=just swept
            const opacity = 0.35 + 0.65 * (1 - persist)
            return <circle key={r.f.icao} cx={x} cy={y} r={3} fill={col} opacity={opacity}>
              <title>{r.f.callsign} {r.vr.toFixed(0)}kt @ {r.range.toFixed(0)}nm</title>
            </circle>
          })}
          <circle cx={cx} cy={cy} r={3} fill="#22d3ee" />
          <text x={cx} y={SCOPE-3} textAnchor="middle" fontSize="8" fill="#475569">MAX {maxRng}nm</text>
        </svg>
      </div>

      <div className="px-4 py-2 border-b border-slate-800/70 grid grid-cols-5 gap-1 text-[10px]">
        {TIERS.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter===t?'ALL':t)}
            className={`rounded px-1.5 py-1 border ${tierFilter===t?'border-cyan-400 bg-cyan-500/15':'border-slate-800 bg-slate-900/60 hover:border-slate-700'}`}>
            <div className="font-semibold tabular-nums" style={{color: TIER_COLOR[t]}}>{counts[t]}</div>
            <div className="text-[8px] text-slate-500 leading-tight mt-0.5">{t.replace('-',' ')}</div>
          </button>
        ))}
      </div>

      <div className="px-4 py-2 border-b border-slate-800/70 grid grid-cols-3 gap-2 text-[10px]">
        <div className="rounded bg-slate-900/60 border border-slate-800 px-2 py-1.5">
          <div className="text-[8px] text-slate-500 uppercase">Σ Approach</div>
          <div className="font-semibold text-cyan-300 tabular-nums">{sumApproach.toFixed(0)} kt</div>
        </div>
        <div className="rounded bg-slate-900/60 border border-slate-800 px-2 py-1.5">
          <div className="text-[8px] text-slate-500 uppercase">Σ Recede</div>
          <div className="font-semibold text-rose-300 tabular-nums">{sumRecede.toFixed(0)} kt</div>
        </div>
        <div className="rounded bg-slate-900/60 border border-slate-800 px-2 py-1.5">
          <div className="text-[8px] text-slate-500 uppercase">Med Rng</div>
          <div className="font-semibold text-slate-200 tabular-nums">{medianRange.toFixed(0)} nm</div>
        </div>
      </div>

      <div className="px-4 py-2 border-b border-slate-800/70 space-y-2 text-[10px]">
        <div className="flex items-center gap-2">
          <span className="text-slate-500 w-14">MAX RNG</span>
          <input type="range" min={10} max={300} step={5} value={maxRng} onChange={e=>setMaxRng(+e.target.value)} className="flex-1 accent-cyan-500" />
          <span className="w-12 text-right tabular-nums">{maxRng}nm</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-500 w-14">MIN |Vr|</span>
          <input type="range" min={0} max={400} step={5} value={minVr} onChange={e=>setMinVr(+e.target.value)} className="flex-1 accent-cyan-500" />
          <span className="w-12 text-right tabular-nums">{minVr}kt</span>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <Btn on={!useGeo} onClick={()=>setUseGeo(false)}>CENTER</Btn>
          <Btn on={useGeo} onClick={()=>setUseGeo(true)}>GEO</Btn>
          <span className="w-1" />
          <Btn on={overlay} onClick={()=>setOverlay(!overlay)}>OVL</Btn>
          <Btn on={labels} onClick={()=>setLabels(!labels)}>LBL</Btn>
        </div>
        <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="callsign / type / op / icao"
          className="w-full bg-slate-900/70 border border-slate-800 rounded px-2 py-1 text-[11px] placeholder:text-slate-600 focus:outline-none focus:border-cyan-600" />
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="text-center text-[10px] text-slate-500 py-8">No contacts in range.</div>
        ) : filtered.map(r => (
          <button key={r.f.icao} onClick={()=>onFly(r.f.icao)}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex gap-2 items-center">
            <div className="w-1 self-stretch rounded-sm" style={{background: TIER_COLOR[r.tier]}} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-slate-100">{r.f.callsign}</span>
                <span className="text-[9px] text-slate-500 truncate">{r.f.type||''} {r.f.operator?'·':''} {r.f.operator||''}</span>
              </div>
              <div className="text-[9px] text-slate-400 tabular-nums mt-0.5 flex gap-3">
                <span style={{color: TIER_COLOR[r.tier]}}>Vr {r.vr>=0?'+':''}{r.vr.toFixed(0)}kt</span>
                <span>Vt {r.vt>=0?'+':''}{r.vt.toFixed(0)}</span>
                <span>{r.range.toFixed(1)}nm</span>
                <span>{r.bearing.toFixed(0)}°</span>
              </div>
              <div className="text-[8px] text-slate-600 tabular-nums mt-0.5">
                Δf {r.dopplerHz>=0?'+':''}{r.dopplerHz.toFixed(0)} Hz @ 1.09GHz · FL{Math.round(r.f.altitudeFt/100)}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function Btn({ on, onClick, children }: { on?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick}
    className={`px-2 py-1 rounded border text-[10px] ${on?'border-cyan-400 bg-cyan-500/15 text-cyan-200':'border-slate-800 bg-slate-900/60 text-slate-400 hover:border-slate-700'}`}>{children}</button>
}
