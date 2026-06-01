// [BATCH-C] Great-circle and trail math utilities.
const D2R = Math.PI / 180
const R2D = 180 / Math.PI

export function haversineNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065 // earth radius nm
  const dLat = (lat2 - lat1) * D2R
  const dLng = (lng2 - lng1) * D2R
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*D2R) * Math.cos(lat2*D2R) * Math.sin(dLng/2)**2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// Linear interpolation of position; good enough at high refresh rates.
export function lerpLatLng(a: [number, number], b: [number, number], t: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

// Shortest-arc angular lerp for headings.
export function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + 540) % 360) - 180
  return (a + d * t + 360) % 360
}
