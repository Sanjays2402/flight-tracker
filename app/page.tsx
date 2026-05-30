'use client'
import dynamic from 'next/dynamic'

const FlightMap = dynamic(() => import('@/components/flight-map'), {
  ssr: false,
  loading: () => (
    <div className="h-screen w-screen flex items-center justify-center bg-[#07090d]">
      <div className="text-center">
        <div className="inline-flex items-center gap-2 text-sm tracking-widest uppercase text-slate-400">
          <span className="size-2 rounded-full bg-emerald-400 live-dot" />
          Loading flight data
        </div>
      </div>
    </div>
  ),
})

export default function Page() {
  return <FlightMap />
}
