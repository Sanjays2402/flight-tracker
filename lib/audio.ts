// [BATCH-A] WebAudio helpers — emergency chime + ATC-style radio chirp
import { lsGet } from './storage'

let ctx: AudioContext | null = null
function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    try { ctx = new (window.AudioContext || (window as any).webkitAudioContext)() } catch { ctx = null }
  }
  return ctx
}

function effectiveVolume(): number {
  const muted = lsGet<boolean>('ft-mute', false)
  if (muted) return 0
  const v = lsGet<number>('ft-volume', 0.5)
  return Math.max(0, Math.min(1, typeof v === 'number' ? v : 0.5))
}

export function playEmergencyChime() {
  const c = getCtx(); if (!c) return
  const vol = effectiveVolume(); if (vol <= 0) return
  const now = c.currentTime
  ;[880, 660, 880].forEach((freq, i) => {
    const o = c.createOscillator(); const g = c.createGain()
    o.type = 'sine'; o.frequency.value = freq
    g.gain.setValueAtTime(0, now + i * 0.18)
    g.gain.linearRampToValueAtTime(vol * 0.5, now + i * 0.18 + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.15)
    o.connect(g).connect(c.destination)
    o.start(now + i * 0.18); o.stop(now + i * 0.18 + 0.16)
  })
}

export function playRadioChirp() {
  const c = getCtx(); if (!c) return
  const chimeOn = lsGet<boolean>('ft-chime', true)
  if (!chimeOn) return
  const vol = effectiveVolume(); if (vol <= 0) return
  const now = c.currentTime
  const o = c.createOscillator(); const g = c.createGain()
  o.type = 'square'; o.frequency.value = 1200
  o.frequency.exponentialRampToValueAtTime(800, now + 0.08)
  g.gain.setValueAtTime(0, now)
  g.gain.linearRampToValueAtTime(vol * 0.18, now + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12)
  o.connect(g).connect(c.destination)
  o.start(now); o.stop(now + 0.13)
}
