export default function Loading() {
  return (
    <div className="fixed inset-0 grid place-items-center bg-slate-950 text-slate-200">
      <div className="text-center space-y-4">
        <div className="mx-auto size-16 rounded-2xl bg-gradient-to-br from-sky-500 to-indigo-500 grid place-items-center shadow-2xl shadow-sky-900/40 animate-pulse">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 16 L19 9 L18 12 L13 13 L14 18 L12 19 L11 14 L6 17 Z" fill="white" />
          </svg>
        </div>
        <div className="space-y-1">
          <div className="text-lg font-bold tracking-tight">Flight Tracker</div>
          <div className="text-xs uppercase tracking-widest text-slate-500">Picking up aircraft signals…</div>
        </div>
        <div className="mx-auto w-40 h-0.5 bg-slate-800 rounded overflow-hidden">
          <div className="h-full w-1/3 bg-sky-400 animate-[loading_1.2s_ease-in-out_infinite]" />
        </div>
      </div>
      <style>{`@keyframes loading{0%{transform:translateX(-100%)}100%{transform:translateX(400%)}}`}</style>
    </div>
  )
}
