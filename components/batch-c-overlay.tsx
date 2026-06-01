'use client'
// [BATCH-C] Top-level integration overlay: hover tooltip, fx layer, splash, about button,
// konami code, AF1 confetti, galaxy view at extreme zoom, density/style selectors.
import { useEffect, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { HoverTooltip } from './hover-tooltip'
import { EffectLayer, useBursts, useKonami } from './fx-layer'
import { Splash } from './splash'
import { AboutPanel } from './about-panel'
import { StatsExtended } from './stats-extended'
import { FlightDetailCharts } from './flight-detail-charts'

export interface BatchCOptions {
  trailStyle: 'solid' | 'dashed' | 'gradient' | 'glow'
  setTrailStyle: (v: 'solid' | 'dashed' | 'gradient' | 'glow') => void
  trailMinutes: 5 | 15 | 30 | 60
  setTrailMinutes: (v: 5 | 15 | 30 | 60) => void
  labelDensity: 'low' | 'med' | 'high'
  setLabelDensity: (v: 'low' | 'med' | 'high') => void
  showAirportNames: boolean
  setShowAirportNames: (v: boolean) => void
  showAirportIata: boolean
  setShowAirportIata: (v: boolean) => void
  colorByAirline: boolean
  setColorByAirline: (v: boolean) => void
}

export function useBatchCPrefs(): BatchCOptions {
  const KEY = 'ft-batchc-prefs-v1'
  const load = () => {
    if (typeof window === 'undefined') return {}
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') } catch { return {} }
  }
  const initial = load()
  const [trailStyle, setTrailStyle] = useState<BatchCOptions['trailStyle']>(initial.trailStyle ?? 'solid')
  const [trailMinutes, setTrailMinutes] = useState<BatchCOptions['trailMinutes']>(initial.trailMinutes ?? 15)
  const [labelDensity, setLabelDensity] = useState<BatchCOptions['labelDensity']>(initial.labelDensity ?? 'med')
  const [showAirportNames, setShowAirportNames] = useState<boolean>(initial.showAirportNames ?? false)
  const [showAirportIata, setShowAirportIata] = useState<boolean>(initial.showAirportIata ?? true)
  const [colorByAirline, setColorByAirline] = useState<boolean>(initial.colorByAirline ?? false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      localStorage.setItem(KEY, JSON.stringify({ trailStyle, trailMinutes, labelDensity, showAirportNames, showAirportIata, colorByAirline }))
    } catch {}
  }, [trailStyle, trailMinutes, labelDensity, showAirportNames, showAirportIata, colorByAirline])
  return {
    trailStyle, setTrailStyle, trailMinutes, setTrailMinutes,
    labelDensity, setLabelDensity, showAirportNames, setShowAirportNames,
    showAirportIata, setShowAirportIata, colorByAirline, setColorByAirline,
  }
}

interface Props {
  mapRef: React.MutableRefObject<maplibregl.Map | null>
  flightsRef: React.MutableRefObject<any[]>
  selected: any | null
  mapZoom: number
  prefs: BatchCOptions
}

export function BatchCOverlay({ mapRef, flightsRef, selected, mapZoom, prefs }: Props) {
  const { bursts, fire } = useBursts()
  const [about, setAbout] = useState(false)
  const [rainbow, setRainbow] = useState(false)

  // Konami toggles rainbow trails (hue-rotate animation on canvas)
  useKonami(() => {
    setRainbow(v => !v)
    fire('confetti')
  })

  useEffect(() => {
    if (typeof document === 'undefined') return
    document.documentElement.classList.toggle('ft-rainbow', rainbow)
  }, [rainbow])

  // AF1 / SAM / VENUS confetti
  const lastConfettiIcaoRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selected) { lastConfettiIcaoRef.current = null; return }
    if (selected.icao === lastConfettiIcaoRef.current) return
    const cs = (selected.callsign || '').replace(/\s+/g, '').toUpperCase()
    if (/^(AF1|AIRFORCE1|SAM\d+|VENUS\d+|FORCE0?1)$/.test(cs)) {
      fire('confetti')
      lastConfettiIcaoRef.current = selected.icao
    }
  }, [selected, fire])

  // Emergency squawk sparkle: fire when new emergency planes appear
  const knownEmergRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const id = setInterval(() => {
      const m = mapRef.current; if (!m) return
      const cur = new Set<string>()
      for (const f of flightsRef.current) {
        if (f.emergency && f.squawk && /^(7500|7600|7700)$/.test(f.squawk)) {
          cur.add(f.icao)
          if (!knownEmergRef.current.has(f.icao)) {
            try {
              const p = m.project([f.lng, f.lat])
              fire('sparkle', p.x, p.y)
            } catch {}
          }
        }
      }
      knownEmergRef.current = cur
    }, 1500)
    return () => clearInterval(id)
  }, [mapRef, flightsRef, fire])

  // Galaxy view at extreme zoom out
  const galaxy = mapZoom < 2.8

  return (
    <>
      <Splash />
      {galaxy && <div className="absolute inset-0 z-[1] ft-galaxy" />}
      <HoverTooltip map={mapRef.current} flightsRef={flightsRef} />
      <EffectLayer bursts={bursts} />

      {/* About button bottom-right above existing utility col */}
      <button
        onClick={() => setAbout(true)}
        title="About"
        className="absolute bottom-44 right-4 z-30 w-9 h-9 rounded-lg bg-slate-900/90 backdrop-blur border border-slate-800 text-slate-300 hover:text-sky-400 hover:border-sky-700 text-xs font-bold shadow-xl"
      >
        i
      </button>

      {about && <AboutPanel onClose={() => setAbout(false)} />}
    </>
  )
}

// Re-export for use in detail/stats integrations.
export { StatsExtended, FlightDetailCharts }
