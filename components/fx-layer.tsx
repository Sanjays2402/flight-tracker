'use client'
// [BATCH-C] Confetti / sparkle / Konami visual effects (DOM overlay, no canvas deps).
import { useEffect, useRef, useState } from 'react'

interface Burst { id: number; x: number; y: number; t: number; kind: 'confetti' | 'sparkle' }

export function EffectLayer({ bursts }: { bursts: Burst[] }) {
  return (
    <div className="pointer-events-none fixed inset-0 z-[90] overflow-hidden">
      {bursts.map(b => (
        <div key={b.id} className="absolute" style={{ left: b.x, top: b.y }}>
          {Array.from({ length: b.kind === 'confetti' ? 28 : 14 }).map((_, i) => {
            const ang = (Math.PI * 2 * i) / (b.kind === 'confetti' ? 28 : 14)
            const dist = 60 + Math.random() * 90
            const dx = Math.cos(ang) * dist
            const dy = Math.sin(ang) * dist - 30
            const colors = b.kind === 'confetti'
              ? ['#f43f5e','#38bdf8','#facc15','#a78bfa','#22d3ee','#fb923c']
              : ['#fbbf24','#fde68a','#fffbeb']
            const c = colors[i % colors.length]
            return (
              <span key={i}
                className="absolute block rounded-sm"
                style={{
                  width: b.kind === 'confetti' ? 7 : 4,
                  height: b.kind === 'confetti' ? 11 : 4,
                  background: c,
                  animation: `ft-burst-${b.kind} 1.1s cubic-bezier(.2,.6,.4,1) forwards`,
                  // @ts-ignore
                  '--dx': `${dx}px`,
                  '--dy': `${dy}px`,
                  transform: 'translate(-50%,-50%)',
                }}
              />
            )
          })}
        </div>
      ))}
      <style>{`
        @keyframes ft-burst-confetti {
          0% { transform: translate(-50%,-50%) rotate(0); opacity: 1 }
          100% { transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy) + 80px)) rotate(540deg); opacity: 0 }
        }
        @keyframes ft-burst-sparkle {
          0% { transform: translate(-50%,-50%) scale(0.4); opacity: 1 }
          100% { transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) scale(1.6); opacity: 0 }
        }
      `}</style>
    </div>
  )
}

export function useBursts() {
  const idRef = useRef(0)
  const [bursts, setBursts] = useState<Burst[]>([])
  const fire = (kind: Burst['kind'], x?: number, y?: number) => {
    const id = ++idRef.current
    const b: Burst = {
      id,
      x: x ?? (typeof window !== 'undefined' ? window.innerWidth / 2 : 400),
      y: y ?? (typeof window !== 'undefined' ? window.innerHeight / 2 : 300),
      t: Date.now(),
      kind,
    }
    setBursts(prev => [...prev, b])
    setTimeout(() => setBursts(prev => prev.filter(x => x.id !== id)), 1300)
  }
  return { bursts, fire }
}

export function useKonami(onTrigger: () => void) {
  useEffect(() => {
    const KONAMI = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a']
    let idx = 0
    const onKey = (e: KeyboardEvent) => {
      const k = e.key
      const want = KONAMI[idx]
      if (k === want || k.toLowerCase() === want.toLowerCase()) {
        idx++
        if (idx === KONAMI.length) { idx = 0; onTrigger() }
      } else {
        idx = (k === KONAMI[0]) ? 1 : 0
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onTrigger])
}
