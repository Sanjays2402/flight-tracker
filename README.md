# Flight Tracker ✈️

Real-time global flight tracker built to compete with FlightRadar24. Live aircraft positions from [adsb.lol](https://adsb.lol), refreshed every 8 seconds, rendered on a Leaflet/CARTO dark map.

**Live:** https://sanjays2402.github.io/flight-tracker/

## Features

### Live tracking
- 1,000+ live aircraft in view, refreshed every 8s
- Bounding-box queries — only fetches planes you can actually see
- Smart re-fetch on map pan/zoom (debounced)
- Aircraft markers oriented by heading, sized by selection
- Helicopter-specific glyph for rotorcraft (ADS-B category A7)
- **Altitude-coded colors** (FR24-style ramp: rose → orange → yellow → cyan → sky → violet)
- **Position trails** (last 60 fixes per aircraft, GC'd after 5 min)
- **Day/Night terminator** overlay (solar-position computed)
- **Live weather radar** overlay (RainViewer, latest frame)

### Per-flight intel
Click any plane and you get:
- **Aircraft photo** (planespotters.net, with adsbdb fallback)
- **Origin → destination route** with airport codes (adsbdb.com)
- **Route line drawn on the map** — dashed from origin to current pos, solid to destination
- Callsign, registration, type, operator, ADS-B category
- Altitude (ft), speed (kt), heading (deg + compass), squawk, ICAO24, position
- **Follow mode** — camera tracks the plane as it moves
- Deep link via URL hash (shareable)

### Filters & search
- Search by callsign, registration, type, operator, ICAO, or squawk
- Altitude range slider (0–50,000 ft)
- Toggles: hide on-ground, only military, only emergency squawks
- **Emergency banner** when squawks 7500/7600/7700 are in view
- Live sortable flight list (by callsign, altitude, or speed)

### UX
- Keyboard shortcuts: `/` search · `Esc` deselect · `T` trails · `W` weather · `N` night · `L` list · `F` follow
- URL state — share your map view with `#lat=…&lng=…&z=…&icao=…`
- Fully responsive (works on phones)
- Dark-mode native, FR24-grade visual polish

## Stack
- Next.js 15 (app router, static export)
- React 19
- Leaflet 1.9 (canvas renderer for perf)
- Tailwind v3
- TypeScript
- Deployed to GitHub Pages

## Data sources
- **Positions:** [adsb.lol](https://adsb.lol) — public, free, no auth, CORS via corsproxy.io
- **Routes & aircraft metadata:** [adsbdb.com](https://api.adsbdb.com) — free public API
- **Photos:** [planespotters.net](https://www.planespotters.net) public photo API
- **Weather radar:** [RainViewer](https://rainviewer.com) free tile API

## Local dev
```bash
npm install
npm run dev
```

## License
MIT
