// [BATCH-C] hexdb.io enrichment cache (manufacturer, year, owner) per ICAO.
// Cached in-memory + localStorage for the session.
export interface HexDbInfo {
  icao: string
  registration?: string
  manufacturer?: string
  type?: string
  owner?: string
  built?: string
  modeS?: string
}

const MEM: Map<string, HexDbInfo | null> = new Map()
const LS_KEY = 'ft-hexdb-cache-v1'
const PENDING: Map<string, Promise<HexDbInfo | null>> = new Map()

function loadLS(): Record<string, HexDbInfo | null> {
  if (typeof window === 'undefined') return {}
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') } catch { return {} }
}
function saveLS(map: Record<string, HexDbInfo | null>) {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(LS_KEY, JSON.stringify(map)) } catch {}
}

// Hydrate
let LSCACHE: Record<string, HexDbInfo | null> = {}
if (typeof window !== 'undefined') {
  LSCACHE = loadLS()
  for (const k in LSCACHE) MEM.set(k, LSCACHE[k])
}

export function getCachedAircraft(icao: string): HexDbInfo | null | undefined {
  return MEM.get(icao.toLowerCase())
}

export async function fetchAircraftInfo(icao: string): Promise<HexDbInfo | null> {
  const key = icao.toLowerCase()
  if (MEM.has(key)) return MEM.get(key) ?? null
  if (PENDING.has(key)) return PENDING.get(key)!
  const p = (async () => {
    try {
      const r = await fetch(`https://hexdb.io/api/v1/aircraft/${key}`)
      if (!r.ok) { MEM.set(key, null); return null }
      const j: any = await r.json()
      const info: HexDbInfo = {
        icao: key,
        registration: j.Registration,
        manufacturer: j.Manufacturer,
        type: j.Type,
        owner: j.RegisteredOwners,
        built: j.Built,
        modeS: j.ModeS,
      }
      MEM.set(key, info)
      LSCACHE[key] = info
      saveLS(LSCACHE)
      return info
    } catch {
      MEM.set(key, null)
      return null
    } finally {
      PENDING.delete(key)
    }
  })()
  PENDING.set(key, p)
  return p
}
