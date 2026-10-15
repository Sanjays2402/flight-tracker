/* Minimal CORS proxy for Flight Tracker, deployable as a Cloudflare Worker.

   GET /?url=<encoded upstream URL>

   Only forwards to the feed hosts the app uses and only answers the origins
   in ALLOWED_ORIGINS, so it can't be used as an open proxy. Responses are
   edge-cached briefly to soften bursts when many viewers watch one area. */

const ALLOWED_HOSTS = new Set([
  'api.adsb.lol',
  'aviationweather.gov',
])

const DEFAULT_ORIGINS = 'https://sanjays2402.github.io,http://localhost:3000'

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  }
}

export default {
  async fetch(request, env, ctx) {
    const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map(s => s.trim())
    const origin = request.headers.get('Origin') || ''
    if (!allowed.includes(origin)) return new Response('Origin not allowed', { status: 403 })
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) })
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors(origin) })

    let target
    try { target = new URL(new URL(request.url).searchParams.get('url') || '') }
    catch { return new Response('Missing or invalid ?url=', { status: 400, headers: cors(origin) }) }
    if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
      return new Response('Upstream not allowed', { status: 403, headers: cors(origin) })
    }

    // short edge cache: positions refresh every few seconds, METARs far less often
    const ttl = target.hostname === 'aviationweather.gov' ? 300 : 4
    const cache = caches.default
    const key = new Request(target.toString())
    let res = await cache.match(key)
    if (!res) {
      const upstream = await fetch(target.toString(), {
        headers: { 'User-Agent': 'flight-tracker-proxy (+https://github.com/Sanjays2402/flight-tracker)' },
      })
      res = new Response(upstream.body, upstream)
      res.headers.set('Cache-Control', `public, max-age=${ttl}`)
      if (upstream.ok) ctx.waitUntil(cache.put(key, res.clone()))
    }

    const out = new Response(res.body, res)
    for (const [k, v] of Object.entries(cors(origin))) out.headers.set(k, v)
    return out
  },
}
