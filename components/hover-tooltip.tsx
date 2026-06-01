'use client'
// [BATCH-C] Hover tooltip — listens to maplibre hover events on planes-layer.
import { useEffect, useState } from 'react'
import type maplibregl from 'maplibre-gl'

interface Tip { cs: string; alt: number; spd: number; x: number; y: number }

export function HoverTooltip({ map, flightsRef }: { map: maplibregl.Map | null; flightsRef: React.MutableRefObject<any[]> }) {
  const [tip, setTip] = useState<Tip | null>(null)

  useEffect(() => {
    if (!map) return
    const onMove = (e: maplibregl.MapLayerMouseEvent) => {
      const f0 = e.features?.[0]; if (!f0) { setTip(null); return }
      const icao = (f0.properties as any).icao as string
      const flt = flightsRef.current.find((x: any) => x.icao === icao)
      if (!flt) return
      setTip({
        cs: flt.callsign || flt.icao.toUpperCase(),
        alt: flt.altitudeFt,
        spd: flt.velocityKts,
        x: e.point.x,
        y: e.point.y,
      })
    }
    const onLeave = () => setTip(null)
    try {
      map.on('mousemove', 'planes-layer', onMove)
      map.on('mouseleave', 'planes-layer', onLeave)
    } catch {}
    return () => {
      try {
        map.off('mousemove', 'planes-layer', onMove)
        map.off('mouseleave', 'planes-layer', onLeave)
      } catch {}
    }
  }, [map, flightsRef])

  if (!tip) return null
  return (
    <div className="absolute z-30 pointer-events-none bg-slate-900/95 border border-slate-700 rounded-md px-2 py-1 shadow-xl"
      style={{ left: tip.x + 14, top: tip.y - 8, transform: 'translateY(-100%)' }}>
      <div className="text-[11px] font-mono font-bold text-slate-100">{tip.cs}</div>
      <div className="text-[10px] font-mono text-slate-400 flex gap-2">
        <span>FL{Math.round(tip.alt / 100)}</span>
        <span>{Math.round(tip.spd)}kt</span>
      </div>
    </div>
  )
}
