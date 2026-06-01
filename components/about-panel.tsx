'use client'
// [BATCH-C] About panel — tech stack + credits.

export function AboutPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 max-w-md w-full shadow-2xl max-h-[85vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold tracking-widest uppercase text-sky-400">About</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
        </div>
        <div className="text-xs text-slate-300 space-y-3">
          <p>
            Real-time global flight tracker — no signup, no ads, no tracking. Built as an open-source weekend project.
          </p>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">Tech stack</div>
            <ul className="space-y-0.5 font-mono text-[11px] text-slate-300">
              <li>• Next.js 15 (App Router, static export)</li>
              <li>• React 19</li>
              <li>• MapLibre GL JS v5 (3D terrain, hillshade, raster-dem)</li>
              <li>• Tailwind CSS</li>
              <li>• TypeScript 5</li>
            </ul>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">Data sources</div>
            <ul className="space-y-0.5 font-mono text-[11px] text-slate-300">
              <li>• <a className="text-sky-400 hover:underline" href="https://adsb.lol" target="_blank" rel="noreferrer">adsb.lol</a> — live ADS-B positions, routes</li>
              <li>• <a className="text-sky-400 hover:underline" href="https://www.planespotters.net" target="_blank" rel="noreferrer">planespotters.net</a> — aircraft photos</li>
              <li>• <a className="text-sky-400 hover:underline" href="https://hexdb.io" target="_blank" rel="noreferrer">hexdb.io</a> — aircraft enrichment</li>
              <li>• <a className="text-sky-400 hover:underline" href="https://aviationweather.gov" target="_blank" rel="noreferrer">aviationweather.gov</a> — METAR</li>
              <li>• <a className="text-sky-400 hover:underline" href="https://rainviewer.com" target="_blank" rel="noreferrer">RainViewer</a> — weather radar</li>
              <li>• <a className="text-sky-400 hover:underline" href="https://carto.com" target="_blank" rel="noreferrer">CARTO</a> + OSM — basemap tiles</li>
              <li>• AWS Terrain Tiles — elevation DEM</li>
            </ul>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">Credits</div>
            <p className="text-[11px] text-slate-400">
              Built by <a className="text-sky-400 hover:underline" href="https://github.com/Sanjays2402" target="_blank" rel="noreferrer">Sanjay Santhanam</a>.
              All data © respective providers.
            </p>
          </div>
          <div className="text-[10px] text-slate-600 pt-2 border-t border-slate-800">
            <span>tip: try the </span><span className="font-mono text-slate-400">↑↑↓↓←→←→ba</span><span> konami code</span>
          </div>
        </div>
      </div>
    </div>
  )
}
