# Flight Tracker

Real-time global aircraft tracking. Free, open, no signup. Built to compete with Flightradar24 — and beat them on the features they paywall.

**Live → https://sanjays2402.github.io/flight-tracker/**

## What it does

- **Live aircraft positions** worldwide via [adsb.lol](https://adsb.lol) (community ADS-B feed)
- **8-second refresh** — fresh feed every cycle, smooth animations between updates
- **Trails** — last 60 fixes per aircraft, fading by age
- **Click any plane** → full detail panel with photo, route, EHS broadcast data

## Features (vs. FR24)

| Capability | This tracker | FR24 Free | FR24 Premium |
|---|---|---|---|
| Live positions | ✓ | ✓ | ✓ |
| Aircraft trails | ✓ | partial | ✓ |
| Photos (planespotters/adsbdb) | ✓ | ✓ | ✓ |
| Route origin → destination | ✓ | ✓ | ✓ |
| **Vertical speed (color-coded)** | ✓ | — | ✓ |
| **ETA + animated progress bar** | ✓ | — | ✓ |
| **IAS / Mach** | ✓ | — | ✓ |
| **Wind direction + speed (derived)** | ✓ | — | ✓ |
| **Outside air temp** | ✓ | — | ✓ |
| **Autopilot target altitude** | ✓ | — | ✓ |
| **Heading projection (10-min)** | ✓ | — | ✓ |
| **Airport overlays (1,167 airports)** | ✓ | partial | ✓ |
| **Derived arrivals / departures** | ✓ | — | ✓ |
| **Emergency squawk alerts (7500/7600/7700)** | ✓ + audio | — | ✓ |
| **Callsign watchlist + audio ping** | ✓ | — | ✓ |
| **Density heatmap (altitude-coded)** | ✓ | — | partial |
| **MLAT / ADS-B / TIS-B source badge** | ✓ | — | — |
| **KML export** | ✓ | — | ✓ |
| **JSON export** | ✓ | — | — |
| **Deep-link share** | ✓ | partial | ✓ |
| Weather radar | ✓ (RainViewer) | — | ✓ |
| Day/night terminator | ✓ | — | ✓ |
| Filters (altitude, military, emergency) | ✓ | — | ✓ |
| **Cost** | $0 | $0 + ads | $4-$50/mo |

## Stack

- Next.js 14 (static export, GitHub Pages)
- Leaflet + Carto dark basemap
- Pure TypeScript, no extra map libraries
- Bundle: **~104 KB first-load**

## Data sources

- **[adsb.lol](https://adsb.lol)** — positions, EHS data, airport bounds, route resolution
- **[adsbdb.com](https://adsbdb.com)** — route fallback, photos
- **[planespotters.net](https://planespotters.net)** — aircraft photos
- **[RainViewer](https://rainviewer.com)** — global weather radar tiles
- **[OpenStreetMap](https://openstreetmap.org)** + **CARTO** — basemap

## Keyboard shortcuts

| Key | Action |
|---|---|
| `/` | Focus search |
| `T` | Toggle trails |
| `W` | Toggle weather |
| `N` | Toggle night terminator |
| `H` | Toggle heat overlay |
| `L` | Toggle aircraft list |
| `F` | Follow selected aircraft |
| `Esc` | Close panels |

## Run locally

```bash
git clone https://github.com/Sanjays2402/flight-tracker
cd flight-tracker
npm install
npm run dev
```

Open http://localhost:3000

## Deploy

GitHub Actions auto-deploys to GitHub Pages on push to `main`. See `.github/workflows/`.

## Privacy

No accounts, no tracking, no cookies, no analytics. All data calls go straight from your browser to the source APIs — nothing routed through any server I control.

## License

MIT — fork it, improve it, ship it.
