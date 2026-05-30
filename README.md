# Flight Tracker ✈️

Real-time global flight tracker. Live aircraft positions from the [OpenSky Network](https://opensky-network.org), refreshed every 10 seconds, rendered on a Leaflet map.

**Live:** https://sanjays2402.github.io/flight-tracker/

## Features
- Live positions for thousands of aircraft worldwide
- Bounding-box queries — only fetches planes in your current viewport (smaller payload, easier on the API)
- Click any plane for callsign, country, altitude, speed, heading, ICAO24
- Search by callsign, country, or ICAO
- Region presets (World / US / EU / Asia)
- Stats: visible, airborne, countries, avg altitude, avg speed

## Stack
- Next.js 15 (app router, static export)
- React 19
- Leaflet 1.9 (canvas renderer for perf)
- Tailwind v3
- TypeScript
- Deployed to GitHub Pages

## Local dev
```bash
npm install
npm run dev
```

## Data
[OpenSky Network](https://opensky-network.org) public REST API — free, no auth, CORS-enabled. Rate limit ~400 requests per day for anonymous use; this app uses bounding-box queries to stay well under that.

## License
MIT
