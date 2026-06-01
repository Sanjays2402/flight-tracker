'use client'
// [BATCH-C] Splash screen with animated SVG plane.
import { useEffect, useState } from 'react'

export function Splash() {
  const [show, setShow] = useState(true)
  useEffect(() => {
    const t = setTimeout(() => setShow(false), 800)
    return () => clearTimeout(t)
  }, [])
  if (!show) return null
  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-slate-950 transition-opacity duration-300 pointer-events-none" style={{ animation: 'ft-fadeout 0.4s ease-in 0.45s forwards' }}>
      <div className="relative w-24 h-24">
        <svg viewBox="0 0 100 100" className="w-full h-full">
          <circle cx="50" cy="50" r="40" stroke="#1e293b" strokeWidth="2" fill="none" />
          <circle cx="50" cy="50" r="40" stroke="#38bdf8" strokeWidth="2" fill="none"
            strokeDasharray="40 220" strokeLinecap="round"
            style={{ transformOrigin: '50% 50%', animation: 'ft-spin 1.2s linear infinite' }} />
          <g style={{ transformOrigin: '50% 50%', animation: 'ft-spin 4s linear infinite' }}>
            <path d="M50 28 L54 50 L70 56 L70 60 L54 58 L52 70 L56 73 L56 76 L50 74 L44 76 L44 73 L48 70 L46 58 L30 60 L30 56 L46 50 Z" fill="#38bdf8" />
          </g>
        </svg>
      </div>
      <div className="mt-4 text-[10px] uppercase tracking-[0.3em] text-slate-500 font-mono">acquiring signals…</div>
      <style>{`
        @keyframes ft-spin { to { transform: rotate(360deg) } }
        @keyframes ft-fadeout { to { opacity: 0; visibility: hidden } }
      `}</style>
    </div>
  )
}
