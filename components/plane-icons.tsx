// [BATCH-C] SVG-canvas drawn plane icons keyed by category.
// Returns ImageData suitable for maplibre map.addImage.
// Categories: jet, prop, heli, glider, mil, balloon. Plus variants for size/altitude scale.

export type IconCategory = 'jet' | 'prop' | 'heli' | 'glider' | 'mil' | 'balloon'

export function categoryFromFlight(cat: string, military: boolean, type: string): IconCategory {
  if (military) return 'mil'
  if (cat === 'A7') return 'heli'
  if (cat === 'B1') return 'glider'
  if (cat === 'B2') return 'balloon'
  // light/small with propeller hint
  if (cat === 'A1' || cat === 'A2') {
    const t = (type || '').toUpperCase()
    if (/^(C1|C2|C3|PA|BE|DA|DH|SR|TBM|P28|PC|M20|AT|AC)/.test(t)) return 'prop'
  }
  return 'jet'
}

// Altitude bucket -> size multiplier (1..1.5)
export function altSizeMultiplier(altFt: number): number {
  if (altFt <= 0) return 0.85
  if (altFt < 10000) return 1.0
  if (altFt < 25000) return 1.15
  if (altFt < 38000) return 1.3
  return 1.45
}

export function iconKey(category: IconCategory, color: string, selected: boolean, sizeBucket: number): string {
  return `pl2-${category}-${selected ? 's' : 'n'}-${sizeBucket}-${color.replace('#','')}`
}

function shadow(ctx: CanvasRenderingContext2D, blur: number) {
  ctx.shadowColor = 'rgba(0,0,0,0.4)'
  ctx.shadowBlur = blur
  ctx.shadowOffsetY = 1
}

export function drawCategoryIcon(category: IconCategory, color: string, selected: boolean, sizeBucket: number): ImageData {
  const pixelRatio = 2
  const mult = 1 + sizeBucket * 0.12   // 0..4 buckets -> 1..1.48
  const baseCss = selected ? 32 : 26
  const sizeCss = Math.round(baseCss * mult)
  const size = sizeCss * pixelRatio
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, size, size)
  ctx.translate(size / 2, size / 2)
  const s = size * 0.45
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#0f172a'
  ctx.lineWidth = Math.max(1, size * 0.04)
  ctx.fillStyle = color

  if (category === 'heli') {
    shadow(ctx, 3)
    ctx.beginPath(); ctx.arc(0, 0, s * 0.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    ctx.shadowColor = 'transparent'
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(1.4, size * 0.06)
    ctx.beginPath(); ctx.moveTo(-s, 0); ctx.lineTo(s, 0); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(0, -s); ctx.lineTo(0, s); ctx.stroke()
  } else if (category === 'glider') {
    // long thin wings, slender fuselage
    shadow(ctx, 2)
    ctx.beginPath()
    ctx.moveTo(0, -s)
    ctx.lineTo(s * 1.2, s * 0.15)
    ctx.lineTo(s * 0.18, s * 0.15)
    ctx.lineTo(s * 0.32, s)
    ctx.lineTo(-s * 0.32, s)
    ctx.lineTo(-s * 0.18, s * 0.15)
    ctx.lineTo(-s * 1.2, s * 0.15)
    ctx.closePath()
    ctx.fill(); ctx.stroke()
  } else if (category === 'balloon') {
    shadow(ctx, 3)
    ctx.beginPath(); ctx.arc(0, -s * 0.2, s * 0.55, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    ctx.fillStyle = '#0f172a'
    ctx.fillRect(-s * 0.2, s * 0.35, s * 0.4, s * 0.25)
    ctx.strokeRect(-s * 0.2, s * 0.35, s * 0.4, s * 0.25)
  } else if (category === 'prop') {
    // chunky body + nose dot + wider wings
    shadow(ctx, 2)
    ctx.beginPath()
    ctx.moveTo(0, -s)
    ctx.lineTo(s * 0.18, -s * 0.2)
    ctx.lineTo(s, s * 0.1)
    ctx.lineTo(s, s * 0.3)
    ctx.lineTo(s * 0.18, s * 0.1)
    ctx.lineTo(s * 0.18, s * 0.55)
    ctx.lineTo(s * 0.5, s * 0.8)
    ctx.lineTo(s * 0.5, s * 0.95)
    ctx.lineTo(0, s * 0.75)
    ctx.lineTo(-s * 0.5, s * 0.95)
    ctx.lineTo(-s * 0.5, s * 0.8)
    ctx.lineTo(-s * 0.18, s * 0.55)
    ctx.lineTo(-s * 0.18, s * 0.1)
    ctx.lineTo(-s, s * 0.3)
    ctx.lineTo(-s, s * 0.1)
    ctx.lineTo(-s * 0.18, -s * 0.2)
    ctx.closePath()
    ctx.fill(); ctx.stroke()
    ctx.shadowColor = 'transparent'
    ctx.fillStyle = '#0f172a'
    ctx.beginPath(); ctx.arc(0, -s, s * 0.12, 0, Math.PI * 2); ctx.fill()
  } else if (category === 'mil') {
    // arrowhead / delta with sharper nose
    shadow(ctx, 3)
    ctx.beginPath()
    ctx.moveTo(0, -s)
    ctx.lineTo(s * 0.8, s * 0.85)
    ctx.lineTo(s * 0.18, s * 0.45)
    ctx.lineTo(0, s)
    ctx.lineTo(-s * 0.18, s * 0.45)
    ctx.lineTo(-s * 0.8, s * 0.85)
    ctx.closePath()
    ctx.fill(); ctx.stroke()
  } else {
    // jet (default)
    shadow(ctx, 2)
    ctx.beginPath()
    ctx.moveTo(0, -s)
    ctx.lineTo(s * 0.14, -s * 0.1)
    ctx.lineTo(s, s * 0.18)
    ctx.lineTo(s, s * 0.36)
    ctx.lineTo(s * 0.14, s * 0.18)
    ctx.lineTo(s * 0.14, s * 0.6)
    ctx.lineTo(s * 0.4, s * 0.85)
    ctx.lineTo(s * 0.4, s * 0.95)
    ctx.lineTo(0, s * 0.78)
    ctx.lineTo(-s * 0.4, s * 0.95)
    ctx.lineTo(-s * 0.4, s * 0.85)
    ctx.lineTo(-s * 0.14, s * 0.6)
    ctx.lineTo(-s * 0.14, s * 0.18)
    ctx.lineTo(-s, s * 0.36)
    ctx.lineTo(-s, s * 0.18)
    ctx.lineTo(-s * 0.14, -s * 0.1)
    ctx.closePath()
    ctx.fill(); ctx.stroke()
  }

  if (selected) {
    ctx.shadowColor = 'transparent'
    ctx.strokeStyle = '#fde047'
    ctx.lineWidth = Math.max(1.5, size * 0.05)
    ctx.beginPath(); ctx.arc(0, 0, s * 1.05, 0, Math.PI * 2); ctx.stroke()
  }

  return ctx.getImageData(0, 0, size, size)
}

// Generate halo (selected pulsing) / ring (watched) / shadow-dot images.
export function drawHaloImage(color: string, kind: 'pulse' | 'ring' | 'shadow'): ImageData {
  const size = 64
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, size, size)
  ctx.translate(size/2, size/2)
  if (kind === 'shadow') {
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 0.35)
    grad.addColorStop(0, 'rgba(0,0,0,0.55)')
    grad.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = grad
    ctx.fillRect(-size/2, -size/2, size, size)
  } else if (kind === 'ring') {
    ctx.strokeStyle = color
    ctx.lineWidth = 2.5
    ctx.beginPath(); ctx.arc(0, 0, size * 0.36, 0, Math.PI * 2); ctx.stroke()
  } else {
    const g = ctx.createRadialGradient(0, 0, size * 0.15, 0, 0, size * 0.45)
    g.addColorStop(0, color + 'cc')
    g.addColorStop(1, color + '00')
    ctx.fillStyle = g
    ctx.fillRect(-size/2, -size/2, size, size)
  }
  return ctx.getImageData(0, 0, size, size)
}

// Airline-code -> stable color (for color-by-airline).
const AIRLINE_PALETTE = ['#f43f5e','#fb923c','#facc15','#84cc16','#22d3ee','#38bdf8','#a78bfa','#f472b6','#34d399','#fbbf24','#60a5fa','#c084fc']
export function airlineColor(callsign: string): string {
  const m = (callsign || '').match(/^([A-Z]{2,3})/i)
  const code = (m ? m[1] : 'ZZZ').toUpperCase()
  let h = 0
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) >>> 0
  return AIRLINE_PALETTE[h % AIRLINE_PALETTE.length]
}

// Country flag tint (used as tail strip color).
const COUNTRY_TINT: Record<string, string> = {
  US: '#3b82f6', GB: '#dc2626', DE: '#f59e0b', FR: '#2563eb', CA: '#ef4444',
  JP: '#dc2626', AU: '#0ea5e9', IN: '#f97316', ES: '#facc15', IE: '#22c55e',
  NL: '#fb923c', NO: '#1d4ed8', SE: '#fbbf24', AE: '#10b981', QA: '#7c2d12',
  CN: '#dc2626', KR: '#0ea5e9', BR: '#16a34a', MX: '#16a34a', IT: '#22c55e',
  AT: '#dc2626', CH: '#dc2626', CL: '#dc2626', AR: '#0ea5e9', NZ: '#000000',
  ZA: '#facc15', BE: '#000000',
}
export function countryTint(code?: string): string {
  if (!code) return '#475569'
  return COUNTRY_TINT[code] || '#475569'
}
