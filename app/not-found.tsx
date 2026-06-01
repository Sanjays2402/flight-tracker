import Link from 'next/link'

export const metadata = { title: 'Off course — 404' }

export default function NotFound() {
  return (
    <div className="fixed inset-0 grid place-items-center bg-slate-950 text-slate-200 p-6">
      <div className="text-center space-y-6 max-w-md">
        <div className="text-7xl md:text-8xl font-black tracking-tighter bg-gradient-to-br from-sky-400 to-indigo-400 bg-clip-text text-transparent">404</div>
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">Off course</h1>
          <p className="text-slate-400 text-sm">This flight plan doesn&apos;t exist. Maybe it&apos;s already landed, or never took off.</p>
        </div>
        <Link href="/" className="inline-flex items-center gap-2 bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold px-5 py-2.5 rounded-xl transition shadow-lg shadow-sky-900/40">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          Back to the map
        </Link>
      </div>
    </div>
  )
}
