# ✈️ Flight Tracker

> Real-time global flight tracker. 25,000+ aircraft live. Free, no signup.

**Live:** https://sanjays2402.github.io/flight-tracker/

A single-page web app showing every aircraft transmitting ADS-B or Mode-S, anywhere on Earth, refreshed every 8 seconds. No servers, no accounts, no analytics, no ads — just a map and the planes in the sky.

![Flight Tracker preview](public/og.svg)

## Features

**Map**
- Live aircraft positions worldwide (adsb.lol community feed)
- 3D terrain with adjustable tilt + chase cam
- Dark Carto basemap, weather radar overlay, night-side shading
- Heatmap, contrail trails, motion smoothing (rAF dead-reckoning)
- Hidden tabs back off live polling and refetch instantly on return — kinder to the community feed and your battery

**Aircraft details**
- Routes (origin → destination with airport names)
- Aircraft photos (planespotters.net)
- Altitude / speed / heading / squawk
- Type, registration, operator
- Watchlist with browser notifications when a plane returns

**Discovery**
- Live filter: type, altitude band, military, helicopter, heavy
- Search: callsign / hex / type / operator / registration
- List view, compare two flights side-by-side
- Live stats panel: histograms, top operators, busiest airports, country breakdown
- Ticker: fastest / highest / steepest climber / descender / military

**Mobile**
- Installable as PWA (Add to Home Screen)
- Hamburger menu + slide-in search
- Touch-optimized zoom/pan/tilt

## Data sources

| Source | Purpose | Cost |
|---|---|---|
| [adsb.lol](https://adsb.lol) | Aircraft positions, routes, airport DB | Free, community-hosted |
| [planespotters.net](https://www.planespotters.net) | Aircraft photos | Free public API |
| [RainViewer](https://www.rainviewer.com) | Weather radar | Free |
| [OpenStreetMap](https://www.openstreetmap.org) + [CARTO](https://carto.com) | Basemap | Free |
| [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) | 3D elevation | Free public dataset |

No API keys required. adsb.lol and aviationweather.gov don't send CORS headers, though, so the browser reaches them through a small CORS proxy (see [Deploy](#deploy)).

## Privacy

- No backend, no servers, no logs.
- No analytics, no trackers, no cookies.
- Preferences and watchlist stored only in `localStorage`.
- Data fetched directly from public ADS-B endpoints — nothing flows through us.

## Stack

- Next.js 14 (app router, static export)
- React + TypeScript
- MapLibre GL JS
- Tailwind CSS
- Deployed via GitHub Pages

**Bundle size:** 1.44 kB route / 105 kB first-load shared.

## Develop

```bash
git clone https://github.com/Sanjays2402/flight-tracker
cd flight-tracker
npm install
npm run dev      # http://localhost:3000
npm run build    # static export → ./out
```

## Deploy

Pushes to `main` auto-deploy to GitHub Pages via `.github/workflows/deploy.yml`.

### CORS proxy (required for live data)

The static build calls the feeds through a proxy chosen at build time ([lib/proxy.ts](lib/proxy.ts)):

1. **Own Worker (recommended).** [proxy/worker.js](proxy/worker.js) is a ~60-line Cloudflare Worker that only forwards to the feed hosts and only answers this site's origin. Deploy it on the free plan:

   ```bash
   cd proxy && npx wrangler deploy
   ```

   Then set the repo variable `PROXY_URL` to `https://ft-proxy.<your-subdomain>.workers.dev/?url=` (Settings → Secrets and variables → Actions → Variables) and re-run the deploy workflow.

2. **corsproxy.io key.** Create a key at [console.corsproxy.io](https://console.corsproxy.io/), restrict it to your Pages domain, and save it as the repo secret `CORSPROXY_KEY`. The key ships in the client bundle, so the domain restriction is what protects it.

For local development, put either value in `.env.local` as `NEXT_PUBLIC_PROXY_URL` or `NEXT_PUBLIC_CORSPROXY_KEY`.

## Caveats

- Coverage depends on community ADS-B receivers. Oceans, polar regions, and military airspace may show fewer aircraft.
- Position data is delayed 5–30 seconds.
- **Never use this for navigation or safety-critical purposes.**

## License

MIT — see [LICENSE](LICENSE)

---

Built by [@Sanjays2402](https://github.com/Sanjays2402). Issues + PRs welcome.

## Terms & Disclaimer

By using this project you agree to the following.

- **No warranty.** This software is provided "as is", without warranty of any kind, express or implied, including merchantability, fitness for a particular purpose, and non-infringement.
- **No liability.** To the maximum extent permitted by law, the author and contributors are not liable for any claim, loss, or damage (direct, indirect, incidental, or consequential, including lost data or profits) arising from its use.
- **Your responsibility.** You use it at your own risk and are responsible for complying with the laws that apply to you.
- **Not for navigation or safety.** Flight positions come from third-party sources such as the OpenSky Network, may be delayed, incomplete, or wrong, and must never be used for aviation, navigation, safety, or emergency decisions. Use of that data is subject to its provider's terms.
- **Third parties.** Names, logos, APIs, and services of others belong to their owners and are used for identification only; no affiliation or endorsement is implied.
- **Your statutory rights.** Nothing here limits rights that cannot be waived by agreement, including under consumer-protection laws in the USA, Canada (including Quebec), and India (Consumer Protection Act, 2019).
- **License.** Use, copying, and distribution are governed by the [LICENSE](LICENSE) file; if anything here conflicts with it, the license controls.

## Content, Assets & Fair Use

- **Original work.** Unless noted otherwise (including below), the code, text, design, and images in this repository were created by the author.
- **Libraries, fonts, and icons.** Third-party libraries, fonts (for example Google Fonts), and icon sets belong to their creators and are used under their own licenses; see the dependency manifests and each source for terms.
- **Logos, brands, and screenshots.** Third-party names, logos, and screenshots appear only to identify or describe their products (nominative use). They remain the property of their owners and do not imply affiliation or endorsement.
- **Ideas and inspiration.** Where this project is inspired by another product, game, or idea, it is an independent implementation. It borrows only general ideas, mechanics, or styles, which are not anyone's exclusive property, and is meant to contain no third-party code or artwork used without permission.
- **Fair use and fair dealing.** Any third-party material is used in limited ways for purposes such as education, research, review, commentary, or identification, relying on fair use in the USA (17 U.S.C. § 107), fair dealing in Canada (Copyright Act, ss. 29–29.2), and fair dealing in India (Copyright Act, 1957, s. 52), where they apply.
- **Concerns and takedown requests.** If you own rights in something here and believe it is used improperly, [open an issue](https://github.com/Sanjays2402/flight-tracker/issues) or contact the author through their GitHub profile with a link to the material and your claim. It will be reviewed promptly and credited, changed, or removed as appropriate. You may also use GitHub's DMCA process.
- **Contributions.** By contributing, you confirm you have the right to submit your contribution and agree it is licensed under this repository's license.
- **Website.** The project site has its own [Terms](https://sanjays2402.github.io/flight-tracker/terms.html) and [Fair Use](https://sanjays2402.github.io/flight-tracker/fair-use.html) pages.
