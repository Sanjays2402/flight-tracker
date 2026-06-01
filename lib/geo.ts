// [BATCH-B] Geo helpers — haversine distance, bearings, point-in-polygon,
// destination, sunrise/sunset, projection forecast.

const R_NM = 3440.065 // Earth radius in nautical miles
const R_KM = 6371.0088

export function haversineNm(a: [number, number], b: [number, number]): number {
  const [lng1, lat1] = a, [lng2, lat2] = b
  const toRad = Math.PI / 180
  const dLat = (lat2 - lat1) * toRad
  const dLng = (lng2 - lng1) * toRad
  const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLng / 2)
  const c = s1 * s1 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * s2 * s2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(c)))
}

export function haversineKm(a: [number, number], b: [number, number]): number {
  return haversineNm(a, b) * 1.852
}

export function bearingDeg(a: [number, number], b: [number, number]): number {
  const [lng1, lat1] = a, [lng2, lat2] = b
  const toRad = Math.PI / 180
  const φ1 = lat1 * toRad, φ2 = lat2 * toRad
  const Δλ = (lng2 - lng1) * toRad
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

export function destinationPoint(
  start: [number, number],
  bearing: number,
  distanceNm: number,
): [number, number] {
  const δ = distanceNm / R_NM
  const θ = bearing * Math.PI / 180
  const [lng, lat] = start
  const φ1 = lat * Math.PI / 180
  const λ1 = lng * Math.PI / 180
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
  )
  return [((λ2 * 180 / Math.PI + 540) % 360) - 180, φ2 * 180 / Math.PI]
}

export function circlePolygon(
  center: [number, number],
  radiusNm: number,
  segments = 64,
): Array<[number, number]> {
  const pts: Array<[number, number]> = []
  for (let i = 0; i <= segments; i++) {
    pts.push(destinationPoint(center, (i / segments) * 360, radiusNm))
  }
  return pts
}

// Ray-casting point-in-polygon (lng/lat pairs, polygon as [[lng,lat], ...])
export function pointInPolygon(pt: [number, number], poly: Array<[number, number]>): boolean {
  if (poly.length < 3) return false
  const [x, y] = pt
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    const intersect = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi)
    if (intersect) inside = !inside
  }
  return inside
}

// Solar position (returns altitude+azimuth in degrees) at given lat/lng.
export function sunPosition(date: Date, lat: number, lng: number): { altitude: number; azimuth: number } {
  const rad = Math.PI / 180
  const lw = -lng * rad
  const phi = lat * rad
  const d = date.valueOf() / 86400000 - 0.5 + 2440588 - 2451545
  const M = rad * (357.5291 + 0.98560028 * d)
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M))
  const L = M + C + rad * (102.9372 + 180)
  const e = rad * 23.4397
  const dec = Math.asin(Math.sin(0) * Math.cos(e) + Math.cos(0) * Math.sin(e) * Math.sin(L))
  const ra = Math.atan2(Math.sin(L) * Math.cos(e) - Math.tan(0) * Math.sin(e), Math.cos(L))
  const θ = rad * (280.16 + 360.9856235 * d) - lw
  const H = θ - ra
  const altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H))
  const azimuth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi))
  return { altitude: altitude * 180 / Math.PI, azimuth: ((azimuth * 180 / Math.PI) + 180) % 360 }
}

// Approximate sunrise/sunset (UTC) using NOAA simplified algorithm.
export function sunTimes(date: Date, lat: number, lng: number): { sunrise: Date | null; sunset: Date | null } {
  const rad = Math.PI / 180
  const dayMs = 86400000
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const N = (start.valueOf() - Date.UTC(start.getUTCFullYear(), 0, 0)) / dayMs
  const lngHour = lng / 15
  function calc(isRise: boolean): Date | null {
    const t = N + ((isRise ? 6 : 18) - lngHour) / 24
    const M = (0.9856 * t) - 3.289
    let L = M + (1.916 * Math.sin(M * rad)) + (0.020 * Math.sin(2 * M * rad)) + 282.634
    L = ((L % 360) + 360) % 360
    let RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad
    RA = ((RA % 360) + 360) % 360
    const Lq = Math.floor(L / 90) * 90
    const RAq = Math.floor(RA / 90) * 90
    RA = (RA + (Lq - RAq)) / 15
    const sinDec = 0.39782 * Math.sin(L * rad)
    const cosDec = Math.cos(Math.asin(sinDec))
    const cosH = (Math.cos(90.833 * rad) - (sinDec * Math.sin(lat * rad))) / (cosDec * Math.cos(lat * rad))
    if (cosH > 1 || cosH < -1) return null
    let H = isRise ? 360 - (Math.acos(cosH) / rad) : Math.acos(cosH) / rad
    H = H / 15
    const T = H + RA - (0.06571 * t) - 6.622
    const UT = ((T - lngHour) % 24 + 24) % 24
    const ms = start.valueOf() + UT * 3600 * 1000
    return new Date(ms)
  }
  return { sunrise: calc(true), sunset: calc(false) }
}

export function formatNm(nm: number): string {
  if (nm < 1) return `${(nm * 6076).toFixed(0)} ft`
  return `${nm.toFixed(1)} nm`
}

export function formatBearing(deg: number): string {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']
  const i = Math.round(((deg % 360) / 22.5)) % 16
  return `${deg.toFixed(0)}° ${dirs[i]}`
}

export { R_NM, R_KM }
