'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

type Flight = {
  icao: string; callsign?: string | null; type?: string | null; operator?: string | null
  lat?: number | null; lng?: number | null
  altitudeFt?: number | null; velocityKts?: number | null; track?: number | null
  ground?: boolean | null
}

type Mode = 'altitude' | 'speed' | 'heading' | 'pentatonic'
type Scale = 'pentatonic' | 'major' | 'minor' | 'whole' | 'chromatic'

const SCALES: Record<Scale, number[]> = {
  pentatonic: [0, 2, 4, 7, 9],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  whole: [0, 2, 4, 6, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
}

const WAVES: OscillatorType[] = ['sine', 'triangle', 'square', 'sawtooth']

function midiToFreq(n: number) { return 440 * Math.pow(2, (n - 69) / 12) }

function quantize(midi: number, scale: number[]) {
  const oct = Math.floor(midi / 12)
  const pc = ((midi % 12) + 12) % 12
  let best = scale[0], bd = 99
  for (const s of scale) { const d = Math.min(Math.abs(s - pc), 12 - Math.abs(s - pc)); if (d < bd) { bd = d; best = s } }
  return oct * 12 + best
}

type Voice = {
  icao: string
  osc: OscillatorNode
  gain: GainNode
  pan: StereoPannerNode
  filter: BiquadFilterNode
  lastTrigger: number
  freq: number
}

export default function SkySymphony({ flights, mapCenter, onClose, onFly }: {
  flights: Flight[]
  mapCenter: { lat: number, lng: number } | null
  onClose: () => void
  onFly: (icao: string) => void
}) {
  const [enabled, setEnabled] = useState(false)
  const [mode, setMode] = useState<Mode>('altitude')
  const [scale, setScale] = useState<Scale>('pentatonic')
  const [wave, setWave] = useState<OscillatorType>('sine')
  const [maxVoices, setMaxVoices] = useState(8)
  const [masterVol, setMasterVol] = useState(0.25)
  const [radiusNm, setRadiusNm] = useState(80)
  const [rootMidi, setRootMidi] = useState(48) // C3
  const [reverb, setReverb] = useState(true)
  const [airborneOnly, setAirborneOnly] = useState(true)

  const ctxRef = useRef<AudioContext | null>(null)
  const masterRef = useRef<GainNode | null>(null)
  const convRef = useRef<ConvolverNode | null>(null)
  const dryRef = useRef<GainNode | null>(null)
  const wetRef = useRef<GainNode | null>(null)
  const voicesRef = useRef<Map<string, Voice>>(new Map())

  // Score: distance-weighted scoring to pick most-audible aircraft
  const cl = mapCenter
  const scored = useMemo(() => {
    if (!cl) return [] as { f: Flight, dNm: number, midi: number, pan: number, gain: number }[]
    const arr: { f: Flight, dNm: number, midi: number, pan: number, gain: number }[] = []
    const sc = SCALES[scale]
    for (const f of flights) {
      if (f.lat == null || f.lng == null) continue
      if (airborneOnly && f.ground) continue
      const dLat = (f.lat - cl.lat) * 60
      const dLng = (f.lng - cl.lng) * 60 * Math.cos(cl.lat * Math.PI / 180)
      const dNm = Math.hypot(dLat, dLng)
      if (dNm > radiusNm) continue
      let raw = 0
      const alt = f.altitudeFt ?? 0
      const spd = f.velocityKts ?? 0
      const trk = ((f.track ?? 0) % 360 + 360) % 360
      if (mode === 'altitude') raw = (alt / 45000) * 36 // up to 3 oct
      else if (mode === 'speed') raw = (spd / 600) * 36
      else if (mode === 'heading') raw = (trk / 360) * 24
      else raw = ((f.icao.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % 36)
      const midi = quantize(rootMidi + Math.round(raw), sc)
      const ang = Math.atan2(dLng, dLat) // 0=N
      const pan = Math.max(-1, Math.min(1, Math.sin(ang)))
      const gain = Math.max(0.05, 1 - dNm / radiusNm)
      arr.push({ f, dNm, midi, pan, gain })
    }
    arr.sort((a, b) => a.dNm - b.dNm)
    return arr.slice(0, maxVoices)
  }, [flights, cl?.lat, cl?.lng, mode, scale, radiusNm, rootMidi, maxVoices, airborneOnly])

  // Audio context lifecycle
  useEffect(() => {
    if (!enabled) {
      // teardown
      const ctx = ctxRef.current
      if (ctx) {
        voicesRef.current.forEach(v => { try { v.osc.stop() } catch {} ; try { v.osc.disconnect() } catch {} })
        voicesRef.current.clear()
        try { ctx.close() } catch {}
        ctxRef.current = null
      }
      return
    }
    const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext
    const ctx = new AC()
    ctxRef.current = ctx
    const master = ctx.createGain(); master.gain.value = masterVol; master.connect(ctx.destination)
    masterRef.current = master
    const dry = ctx.createGain(); dry.gain.value = reverb ? 0.55 : 1; dry.connect(master)
    const wet = ctx.createGain(); wet.gain.value = reverb ? 0.45 : 0; wet.connect(master)
    dryRef.current = dry; wetRef.current = wet
    // Build simple impulse response reverb
    const len = Math.floor(ctx.sampleRate * 2.6)
    const ir = ctx.createBuffer(2, len, ctx.sampleRate)
    for (let c = 0; c < 2; c++) {
      const data = ir.getChannelData(c)
      for (let i = 0; i < len; i++) {
        const t = i / len
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.8)
      }
    }
    const conv = ctx.createConvolver(); conv.buffer = ir; conv.connect(wet)
    convRef.current = conv
    return () => {
      voicesRef.current.forEach(v => { try { v.osc.stop() } catch {} ; try { v.osc.disconnect() } catch {} })
      voicesRef.current.clear()
      try { ctx.close() } catch {}
      ctxRef.current = null
    }
  }, [enabled])

  useEffect(() => { if (masterRef.current) masterRef.current.gain.value = masterVol }, [masterVol])
  useEffect(() => {
    if (dryRef.current) dryRef.current.gain.value = reverb ? 0.55 : 1
    if (wetRef.current) wetRef.current.gain.value = reverb ? 0.45 : 0
  }, [reverb])

  // Update voices to track scored flights
  useEffect(() => {
    const ctx = ctxRef.current; const dry = dryRef.current; const conv = convRef.current
    if (!enabled || !ctx || !dry || !conv) return
    const now = ctx.currentTime
    const wantIds = new Set(scored.map(s => s.f.icao))
    // Drop voices no longer wanted
    voicesRef.current.forEach((v, id) => {
      if (!wantIds.has(id)) {
        v.gain.gain.cancelScheduledValues(now)
        v.gain.gain.setValueAtTime(v.gain.gain.value, now)
        v.gain.gain.linearRampToValueAtTime(0, now + 0.25)
        setTimeout(() => { try { v.osc.stop() } catch {} ; try { v.osc.disconnect() } catch {} }, 320)
        voicesRef.current.delete(id)
      }
    })
    // Add or update voices
    for (const s of scored) {
      const freq = midiToFreq(s.midi)
      let v = voicesRef.current.get(s.f.icao)
      if (!v) {
        const osc = ctx.createOscillator(); osc.type = wave; osc.frequency.value = freq
        const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'
        filter.frequency.value = 800 + (s.f.altitudeFt ?? 0) * 0.15
        const pan = ctx.createStereoPanner(); pan.pan.value = s.pan
        const gain = ctx.createGain(); gain.gain.value = 0
        osc.connect(filter); filter.connect(pan); pan.connect(gain)
        gain.connect(dry); gain.connect(conv)
        osc.start()
        const target = s.gain * 0.32
        gain.gain.linearRampToValueAtTime(target, now + 0.6)
        v = { icao: s.f.icao, osc, gain, pan, filter, lastTrigger: now, freq }
        voicesRef.current.set(s.f.icao, v)
      } else {
        v.osc.type = wave
        v.osc.frequency.cancelScheduledValues(now)
        v.osc.frequency.linearRampToValueAtTime(freq, now + 0.25)
        v.pan.pan.linearRampToValueAtTime(s.pan, now + 0.25)
        v.filter.frequency.linearRampToValueAtTime(800 + (s.f.altitudeFt ?? 0) * 0.15, now + 0.25)
        v.gain.gain.cancelScheduledValues(now)
        v.gain.gain.linearRampToValueAtTime(s.gain * 0.32, now + 0.25)
        v.freq = freq
      }
    }
  }, [enabled, scored, wave])

  const noteNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
  const fmtMidi = (m: number) => `${noteNames[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`

  return (
    <div className="absolute top-16 right-3 z-30 w-[360px] bg-slate-950/95 border border-slate-700 rounded-lg shadow-2xl backdrop-blur text-slate-100 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background: enabled ? '#10b981' : '#475569', boxShadow: enabled ? '0 0 8px #10b981' : 'none' }} />
          <div className="font-semibold tracking-wide">SKY SYMPHONY</div>
          <div className="text-[10px] text-slate-500">{scored.length} voices</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white">✕</button>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <button
          onClick={() => setEnabled(v => !v)}
          className={`w-full py-1.5 rounded font-mono text-[11px] tracking-wider border ${enabled ? 'bg-emerald-600/30 border-emerald-500 text-emerald-200' : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'}`}
        >
          {enabled ? '◼ STOP AUDIO' : '▶ START AUDIO'}
        </button>

        <div>
          <div className="text-[10px] text-slate-500 mb-1">MAPPING MODE</div>
          <div className="grid grid-cols-4 gap-1">
            {(['altitude','speed','heading','pentatonic'] as Mode[]).map(m => (
              <button key={m} onClick={() => setMode(m)} className={`px-1.5 py-1 rounded text-[10px] font-mono ${mode===m?'bg-cyan-600/40 text-cyan-100 border border-cyan-500':'bg-slate-800 border border-slate-700 text-slate-400 hover:text-slate-200'}`}>{m.toUpperCase().slice(0,4)}</button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-[10px] text-slate-500 mb-1">SCALE</div>
          <div className="grid grid-cols-5 gap-1">
            {(Object.keys(SCALES) as Scale[]).map(s => (
              <button key={s} onClick={() => setScale(s)} className={`px-1 py-1 rounded text-[10px] font-mono ${scale===s?'bg-violet-600/40 text-violet-100 border border-violet-500':'bg-slate-800 border border-slate-700 text-slate-400'}`}>{s.slice(0,4).toUpperCase()}</button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-[10px] text-slate-500 mb-1">WAVE</div>
          <div className="grid grid-cols-4 gap-1">
            {WAVES.map(w => (
              <button key={w} onClick={() => setWave(w)} className={`px-1 py-1 rounded text-[10px] font-mono ${wave===w?'bg-amber-600/40 text-amber-100 border border-amber-500':'bg-slate-800 border border-slate-700 text-slate-400'}`}>{w.slice(0,4).toUpperCase()}</button>
            ))}
          </div>
        </div>

        <label className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-slate-500">VOICES</span>
          <input type="range" min={1} max={16} value={maxVoices} onChange={e => setMaxVoices(+e.target.value)} className="flex-1 accent-cyan-500" />
          <span className="w-6 text-right tabular-nums">{maxVoices}</span>
        </label>
        <label className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-slate-500">VOLUME</span>
          <input type="range" min={0} max={1} step={0.01} value={masterVol} onChange={e => setMasterVol(+e.target.value)} className="flex-1 accent-emerald-500" />
          <span className="w-6 text-right tabular-nums">{Math.round(masterVol*100)}</span>
        </label>
        <label className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-slate-500">RADIUS nm</span>
          <input type="range" min={10} max={300} value={radiusNm} onChange={e => setRadiusNm(+e.target.value)} className="flex-1 accent-rose-500" />
          <span className="w-8 text-right tabular-nums">{radiusNm}</span>
        </label>
        <label className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-slate-500">ROOT</span>
          <input type="range" min={24} max={72} value={rootMidi} onChange={e => setRootMidi(+e.target.value)} className="flex-1 accent-violet-500" />
          <span className="w-8 text-right tabular-nums">{fmtMidi(rootMidi)}</span>
        </label>

        <div className="flex items-center gap-3 pt-1">
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={reverb} onChange={e => setReverb(e.target.checked)} />
            <span className="text-[10px] text-slate-400">REVERB</span>
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={airborneOnly} onChange={e => setAirborneOnly(e.target.checked)} />
            <span className="text-[10px] text-slate-400">AIRBORNE ONLY</span>
          </label>
        </div>
      </div>

      <div className="px-3 py-2 max-h-[260px] overflow-y-auto">
        <div className="text-[10px] text-slate-500 mb-1.5 flex justify-between">
          <span>ACTIVE VOICES</span>
          <span>{scored.length} / {maxVoices}</span>
        </div>
        {scored.length === 0 && (
          <div className="text-[11px] text-slate-600 italic py-4 text-center">No aircraft in range</div>
        )}
        <div className="space-y-1">
          {scored.map((s, i) => {
            const hue = ((s.midi - rootMidi) * 18) % 360
            return (
              <button
                key={s.f.icao}
                onClick={() => onFly(s.f.icao)}
                className="w-full flex items-center gap-2 px-2 py-1 rounded bg-slate-900/60 hover:bg-slate-800 border border-slate-800 text-left"
              >
                <div className="w-1 self-stretch rounded" style={{ background: `hsl(${hue},70%,55%)`, boxShadow: enabled ? `0 0 6px hsl(${hue},80%,55%)` : 'none' }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] text-slate-100 truncate">{s.f.callsign || s.f.icao.toUpperCase()}</span>
                    <span className="font-mono text-[10px] text-slate-400 tabular-nums">{fmtMidi(s.midi)}</span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono tabular-nums">
                    <span>{s.f.type || '—'}</span>
                    <span>{(s.f.altitudeFt ? `FL${Math.round(s.f.altitudeFt/100).toString().padStart(3,'0')}` : 'GND')} · {s.dNm.toFixed(0)}nm</span>
                  </div>
                  <div className="mt-0.5 h-0.5 bg-slate-800 rounded overflow-hidden">
                    <div className="h-full" style={{ width: `${Math.round(s.gain*100)}%`, background: `hsl(${hue},70%,55%)` }} />
                  </div>
                </div>
                <div className="w-6 text-center text-[10px] font-mono text-slate-500" title="stereo pan">
                  {s.pan < -0.2 ? '◀' : s.pan > 0.2 ? '▶' : '●'}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        Altitude/speed/heading mapped to pitch; stereo pan = compass bearing from map center; volume = proximity. Quantized to selected scale.
      </div>
    </div>
  )
}
