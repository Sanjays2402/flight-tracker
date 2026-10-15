/* CORS proxy routing for third-party feeds (adsb.lol, aviationweather.gov).

   Neither upstream sends CORS headers, so the static Pages build can't call
   them directly. corsproxy.io used to fill that gap anonymously but now
   rejects keyless requests, so the proxy is configured at build time:

     NEXT_PUBLIC_PROXY_URL      our own Worker (proxy/worker.js), preferred.
                                Target URL is appended URL-encoded, e.g.
                                https://ft-proxy.example.workers.dev/?url=
     NEXT_PUBLIC_CORSPROXY_KEY  a corsproxy.io key (domain-restricted in the
                                corsproxy console, so safe to ship to clients)

   With neither set we fall back to a direct request, which works in dev
   tools/extensions that relax CORS but not in a normal browser. */

const PROXY_URL = process.env.NEXT_PUBLIC_PROXY_URL || ''
const CORSPROXY_KEY = process.env.NEXT_PUBLIC_CORSPROXY_KEY || ''

export const proxyConfigured = Boolean(PROXY_URL || CORSPROXY_KEY)

export const proxyOrigin = PROXY_URL
  ? new URL(PROXY_URL).origin
  : CORSPROXY_KEY ? 'https://corsproxy.io' : null

export function proxied(target: string): string {
  if (PROXY_URL) return PROXY_URL + encodeURIComponent(target)
  if (CORSPROXY_KEY) {
    return `https://corsproxy.io/?key=${encodeURIComponent(CORSPROXY_KEY)}&url=${encodeURIComponent(target)}`
  }
  return target
}
