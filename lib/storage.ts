// [BATCH-A] localStorage helpers + key registry
export const FT_KEYS = [
  'ft-prefs-v1', 'ft-watchlist-v1', 'ft-units-v1', 'ft-colorby-v1',
  'ft-mapstyle-v1', 'ft-audio-v1', 'ft-onboarded',
  'ft-volume', 'ft-mute', 'ft-chime', 'ft-theme', 'ft-contrast',
  'ft-fontsize', 'ft-locale', 'ft-last-icao', 'ft-follow',
  'ft-refresh-ms', 'ft-filters-v1',
] as const

export function lsGet<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    if (v == null) return fallback
    try { return JSON.parse(v) as T } catch { return v as unknown as T }
  } catch { return fallback }
}
export function lsSet(key: string, val: unknown) {
  try { localStorage.setItem(key, typeof val === 'string' ? val : JSON.stringify(val)) } catch {}
}
export function lsRemove(key: string) { try { localStorage.removeItem(key) } catch {} }

export function storageUsageKB(): number {
  let bytes = 0
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!
      const v = localStorage.getItem(k) || ''
      bytes += k.length + v.length
    }
  } catch {}
  return Math.round((bytes / 1024) * 10) / 10
}

export function clearAllFtPrefs() {
  try {
    const all: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('ft-')) all.push(k)
    }
    all.forEach(k => localStorage.removeItem(k))
  } catch {}
}
