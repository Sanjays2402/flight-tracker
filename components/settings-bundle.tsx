'use client'
// [BATCH-A] Bundled UI: settings cog, panels, toasts, offline banner, skip link, a11y live region
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { lsGet, lsSet, clearAllFtPrefs, storageUsageKB } from '../lib/storage'
import { pushToast, subscribeToast, ToastMsg } from '../lib/toast'
import { LOCALES, Locale, getLocale, setLocale, t } from '../lib/i18n'

type Theme = 'light' | 'dark' | 'system'
type FontSize = 'S' | 'M' | 'L'

export interface SettingsBridge {
  // expose getters/setters so flight-map can read live values when needed
  refreshMs: number
  setRefreshMs: (n: number) => void
}

const REFRESH_OPTS = [4000, 8000, 15000, 30000]

function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const resolved: 'light' | 'dark' =
    theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : theme
  root.setAttribute('data-theme', resolved)
}
function applyContrast(on: boolean) {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-contrast', on ? 'high' : 'normal')
}
function applyFontSize(size: FontSize) {
  if (typeof document === 'undefined') return
  const px = size === 'S' ? '12px' : size === 'L' ? '16px' : '14px'
  document.documentElement.style.setProperty('--ft-font-size', px)
  document.documentElement.setAttribute('data-fontsize', size)
}

/* ---------------- Settings panel ---------------- */
export function SettingsCluster() {
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<'display' | 'audio' | 'data' | 'privacy' | 'about'>('display')

  // persisted state
  const [theme, setTheme] = useState<Theme>(() => (lsGet<Theme>('ft-theme', 'dark') as Theme))
  const [contrast, setContrast] = useState<boolean>(() => lsGet<boolean>('ft-contrast', false))
  const [fontSize, setFontSize] = useState<FontSize>(() => (lsGet<FontSize>('ft-fontsize', 'M') as FontSize))
  const [mute, setMute] = useState<boolean>(() => lsGet<boolean>('ft-mute', false))
  const [volume, setVolume] = useState<number>(() => lsGet<number>('ft-volume', 0.5))
  const [chime, setChime] = useState<boolean>(() => lsGet<boolean>('ft-chime', true))
  const [refreshMs, setRefreshMs] = useState<number>(() => lsGet<number>('ft-refresh-ms', 8000))
  const [locale, setLocaleState] = useState<Locale>(() => getLocale())
  const [storageKB, setStorageKB] = useState<number>(0)

  // PWA install
  const installEvtRef = useRef<any>(null)
  const [canInstall, setCanInstall] = useState(false)

  // apply on mount
  useEffect(() => { applyTheme(theme); lsSet('ft-theme', theme) }, [theme])
  useEffect(() => { applyContrast(contrast); lsSet('ft-contrast', contrast) }, [contrast])
  useEffect(() => { applyFontSize(fontSize); lsSet('ft-fontsize', fontSize) }, [fontSize])
  useEffect(() => { lsSet('ft-mute', mute) }, [mute])
  useEffect(() => { lsSet('ft-volume', volume) }, [volume])
  useEffect(() => { lsSet('ft-chime', chime) }, [chime])
  useEffect(() => { lsSet('ft-refresh-ms', refreshMs) }, [refreshMs])
  useEffect(() => { setLocale(locale) }, [locale])

  useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const h = () => applyTheme('system')
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [theme])

  useEffect(() => {
    const onBip = (e: any) => { e.preventDefault(); installEvtRef.current = e; setCanInstall(true) }
    window.addEventListener('beforeinstallprompt', onBip)
    return () => window.removeEventListener('beforeinstallprompt', onBip)
  }, [])

  useEffect(() => { if (open) setStorageKB(storageUsageKB()) }, [open, section])

  const cacheStats = useMemo(() => {
    let routes = 0, photos = 0, metars = 0
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i) || ''
        if (k.startsWith('ft-route-')) routes++
        else if (k.startsWith('ft-photo-')) photos++
        else if (k.startsWith('ft-metar-')) metars++
      }
    } catch {}
    return { routes, photos, metars }
  }, [open, section])

  const installApp = async () => {
    const e = installEvtRef.current; if (!e) return
    e.prompt()
    try { await e.userChoice } catch {}
    installEvtRef.current = null; setCanInstall(false)
  }

  const doClearPrefs = () => {
    if (!confirm('Clear all preferences? This cannot be undone.')) return
    clearAllFtPrefs()
    pushToast('Preferences cleared. Reloading…', 'success')
    setTimeout(() => location.reload(), 700)
  }

  return (
    <>
      <button
        aria-label={t('settings')}
        onClick={() => setOpen(true)}
        title={t('settings')}
        className="ft-focus w-9 h-9 rounded-lg bg-slate-900/90 backdrop-blur border border-slate-800 text-slate-300 hover:text-sky-400 hover:border-sky-700 text-sm font-bold shadow-xl focus:outline-none focus:ring-2 focus:ring-sky-500"
      >⚙</button>

      {open && (
        <div role="dialog" aria-modal="true" aria-label={t('settings')}
          className="fixed inset-0 z-[80] bg-slate-950/70 backdrop-blur-sm grid place-items-center p-4"
          onClick={() => setOpen(false)}>
          <div onClick={e => e.stopPropagation()}
            className="w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
              <h2 className="text-sm font-bold tracking-widest uppercase text-slate-200">{t('settings')}</h2>
              <button onClick={() => setOpen(false)} aria-label={t('close')}
                className="ft-focus text-slate-500 hover:text-slate-200 text-xl leading-none focus:outline-none focus:ring-2 focus:ring-sky-500 rounded">×</button>
            </div>
            <div className="flex">
              <nav aria-label="Settings sections" className="w-32 border-r border-slate-800 py-2 flex flex-col">
                {([
                  ['display', t('display')], ['audio', t('audio')], ['data', t('data')],
                  ['privacy', t('privacy')], ['about', 'About'],
                ] as const).map(([k, lbl]) => (
                  <button key={k} onClick={() => setSection(k)}
                    className={`ft-focus text-left px-3 py-2 text-xs uppercase tracking-wider focus:outline-none focus:ring-2 focus:ring-sky-500 ${section === k ? 'text-sky-400 bg-slate-800/60' : 'text-slate-400 hover:text-slate-200'}`}>
                    {lbl}
                  </button>
                ))}
              </nav>
              <div className="flex-1 p-4 max-h-[70vh] overflow-y-auto text-sm text-slate-200 space-y-4">
                {section === 'display' && (
                  <>
                    <Row label={t('theme')}>
                      <Seg value={theme} onChange={v => setTheme(v as Theme)} options={[
                        ['light', t('light')], ['dark', t('dark')], ['system', t('system')],
                      ]} />
                    </Row>
                    <Row label={t('contrast')}>
                      <ToggleSw on={contrast} onChange={setContrast} />
                    </Row>
                    <Row label={t('fontSize')}>
                      <Seg value={fontSize} onChange={v => setFontSize(v as FontSize)} options={[
                        ['S', 'S'], ['M', 'M'], ['L', 'L'],
                      ]} />
                    </Row>
                    <Row label={t('locale')}>
                      <select value={locale} onChange={e => setLocaleState(e.target.value as Locale)}
                        className="ft-focus bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-sky-500">
                        {LOCALES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
                      </select>
                    </Row>
                  </>
                )}
                {section === 'audio' && (
                  <>
                    <Row label={t('mute')}><ToggleSw on={mute} onChange={setMute} /></Row>
                    <Row label={t('volume')}>
                      <input type="range" min={0} max={1} step={0.05} value={volume}
                        onChange={e => setVolume(parseFloat(e.target.value))}
                        className="ft-focus w-40 accent-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500 rounded"
                        aria-label={t('volume')} />
                      <span className="text-xs text-slate-500 ml-2 font-mono">{Math.round(volume * 100)}%</span>
                    </Row>
                    <Row label={t('chime')}><ToggleSw on={chime} onChange={setChime} /></Row>
                  </>
                )}
                {section === 'data' && (
                  <>
                    <Row label={t('refresh')}>
                      <Seg value={String(refreshMs)} onChange={v => setRefreshMs(parseInt(v, 10))} options={
                        REFRESH_OPTS.map(ms => [String(ms), `${ms/1000}s`] as [string, string])
                      } />
                    </Row>
                    <div className="text-xs text-slate-400">
                      Refresh pauses automatically when the tab is hidden.
                    </div>
                  </>
                )}
                {section === 'privacy' && (
                  <>
                    <Row label={t('storageUsed')}>
                      <span className="font-mono text-xs text-slate-300">{storageKB} KB</span>
                    </Row>
                    <button onClick={doClearPrefs}
                      className="ft-focus px-3 py-1.5 rounded bg-rose-900/40 border border-rose-800 text-rose-200 text-xs hover:bg-rose-900/70 focus:outline-none focus:ring-2 focus:ring-rose-400">
                      {t('clearPrefs')}
                    </button>
                  </>
                )}
                {section === 'about' && (
                  <div className="space-y-2 text-xs text-slate-300">
                    <div>Routes cached: <span className="font-mono text-slate-100">{cacheStats.routes}</span></div>
                    <div>Photos cached: <span className="font-mono text-slate-100">{cacheStats.photos}</span></div>
                    <div>METARs cached: <span className="font-mono text-slate-100">{cacheStats.metars}</span></div>
                    {canInstall && (
                      <button onClick={installApp}
                        className="ft-focus mt-3 px-3 py-1.5 rounded bg-sky-900/40 border border-sky-800 text-sky-200 hover:bg-sky-900/70 focus:outline-none focus:ring-2 focus:ring-sky-500">
                        {t('install')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-xs uppercase tracking-wider text-slate-400">{label}</span>
      <div className="flex items-center">{children}</div>
    </div>
  )
}
function Seg<T extends string>({ value, onChange, options }:
  { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div role="radiogroup" className="inline-flex bg-slate-800 rounded overflow-hidden border border-slate-700">
      {options.map(([v, lbl]) => (
        <button key={v} role="radio" aria-checked={value === v}
          onClick={() => onChange(v)}
          className={`ft-focus px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-sky-500 ${value === v ? 'bg-sky-700 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>
          {lbl}
        </button>
      ))}
    </div>
  )
}
function ToggleSw({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} onClick={() => onChange(!on)}
      className={`ft-focus w-10 h-5 rounded-full relative transition-colors focus:outline-none focus:ring-2 focus:ring-sky-500 ${on ? 'bg-sky-600' : 'bg-slate-700'}`}>
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${on ? 'translate-x-5' : ''}`} />
    </button>
  )
}

/* ---------------- Toasts ---------------- */
export function ToastHost() {
  const [list, setList] = useState<ToastMsg[]>([])
  useEffect(() => subscribeToast(setList), [])
  return (
    <div aria-live="polite" aria-atomic="false"
      className="pointer-events-none fixed bottom-4 left-1/2 -translate-x-1/2 z-[90] flex flex-col gap-2 items-center">
      {list.map(m => (
        <div key={m.id}
          className={`pointer-events-auto px-3 py-1.5 rounded-md text-xs font-medium shadow-lg backdrop-blur border ${
            m.kind === 'error' ? 'bg-rose-900/80 border-rose-700 text-rose-100' :
            m.kind === 'warn' ? 'bg-amber-900/80 border-amber-700 text-amber-100' :
            m.kind === 'success' ? 'bg-emerald-900/80 border-emerald-700 text-emerald-100' :
            'bg-slate-800/90 border-slate-700 text-slate-100'
          }`}>{m.text}</div>
      ))}
    </div>
  )
}

/* ---------------- Offline banner ---------------- */
export function OfflineBanner() {
  const [off, setOff] = useState<boolean>(typeof navigator !== 'undefined' && !navigator.onLine)
  useEffect(() => {
    const on = () => setOff(false), down = () => setOff(true)
    window.addEventListener('online', on); window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', down) }
  }, [])
  if (!off) return null
  return (
    <div role="status" className="fixed top-0 inset-x-0 z-[95] bg-amber-700 text-amber-50 text-xs text-center py-1 font-medium">
      {t('offline')} — data updates paused
    </div>
  )
}

/* ---------------- Skip link + a11y live region ---------------- */
export function SkipToMap() {
  return (
    <a href="#map-main" className="ft-focus sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:bg-sky-700 focus:text-white focus:px-3 focus:py-1.5 focus:rounded focus:outline-none focus:ring-2 focus:ring-sky-300">
      Skip to map
    </a>
  )
}

export function EmergencyLive({ text }: { text: string }) {
  return (
    <div aria-live="assertive" role="alert" className="sr-only">{text}</div>
  )
}

/* ---------------- Hook: refresh-ms + page-visibility pause ---------------- */
export function useRefreshControl() {
  const [ms, setMs] = useState<number>(() => lsGet<number>('ft-refresh-ms', 8000))
  const [visible, setVisible] = useState<boolean>(typeof document === 'undefined' ? true : !document.hidden)
  useEffect(() => {
    const sync = () => setMs(lsGet<number>('ft-refresh-ms', 8000))
    window.addEventListener('storage', sync)
    const iv = setInterval(sync, 1500)
    return () => { window.removeEventListener('storage', sync); clearInterval(iv) }
  }, [])
  useEffect(() => {
    const onVis = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  return { refreshMs: ms, paused: !visible }
}
