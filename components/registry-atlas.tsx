'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Registry Atlas Panel
   -----------------------------------------------------------
   Decodes every live aircraft's ICAO 24-bit hex address into
   its country of registration via the official ITU/ICAO block
   allocations, then builds a ranked leaderboard of countries
   with counts (airborne/ground), military split, average FL,
   average speed, top operators and top types. Click a country
   row to highlight all of its aircraft on the map with a glow
   halo layer; the panel doubles as a quick "where is this fleet
   right now" geography lens. Includes search, region grouping
   (continent), airborne-only toggle, top-N selector and a
   click-to-fly aircraft drilldown for the selected country.
   ============================================================ */

export interface AtlasPlane {
  icao: string
  callsign: string
  type: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  ground: boolean
  military?: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: AtlasPlane[]
  onClose: () => void
  onFly?: (icao: string) => void
}

// ICAO 24-bit hex prefix -> ISO2 country code.
// Sourced from ICAO Annex 10 Vol III appendix. Each entry: [hexStart, hexEnd, ISO2].
// Ranges are inclusive on a 24-bit numeric basis.
const RANGES: Array<[number, number, string]> = [
  [0x004000, 0x0043FF, 'ZW'],
  [0x006000, 0x006FFF, 'MZ'],
  [0x008000, 0x00FFFF, 'ZA'],
  [0x010000, 0x017FFF, 'EG'],
  [0x018000, 0x01FFFF, 'LY'],
  [0x020000, 0x027FFF, 'MA'],
  [0x028000, 0x02FFFF, 'TN'],
  [0x030000, 0x0303FF, 'BW'],
  [0x032000, 0x032FFF, 'BI'],
  [0x034000, 0x034FFF, 'CM'],
  [0x036000, 0x036FFF, 'KM'],
  [0x038000, 0x038FFF, 'CG'],
  [0x03E000, 0x03EFFF, 'CI'],
  [0x040000, 0x040FFF, 'DJ'],
  [0x042000, 0x042FFF, 'ER'],
  [0x044000, 0x044FFF, 'ET'],
  [0x046000, 0x046FFF, 'GQ'],
  [0x048000, 0x048FFF, 'GH'],
  [0x04A000, 0x04AFFF, 'GN'],
  [0x04C000, 0x04CFFF, 'GW'],
  [0x050000, 0x050FFF, 'KE'],
  [0x054000, 0x054FFF, 'LR'],
  [0x058000, 0x058FFF, 'MG'],
  [0x05A000, 0x05AFFF, 'MW'],
  [0x05C000, 0x05CFFF, 'ML'],
  [0x05E000, 0x05EFFF, 'MR'],
  [0x060000, 0x060FFF, 'MU'],
  [0x062000, 0x062FFF, 'NE'],
  [0x064000, 0x064FFF, 'NG'],
  [0x068000, 0x068FFF, 'UG'],
  [0x06A000, 0x06AFFF, 'QA'],
  [0x06C000, 0x06CFFF, 'CF'],
  [0x06E000, 0x06EFFF, 'RW'],
  [0x070000, 0x070FFF, 'SN'],
  [0x074000, 0x074FFF, 'SC'],
  [0x076000, 0x076FFF, 'SL'],
  [0x078000, 0x078FFF, 'SO'],
  [0x07A000, 0x07AFFF, 'SZ'],
  [0x07C000, 0x07CFFF, 'SD'],
  [0x080000, 0x080FFF, 'TZ'],
  [0x084000, 0x084FFF, 'TD'],
  [0x088000, 0x088FFF, 'TG'],
  [0x08A000, 0x08AFFF, 'ZM'],
  [0x08C000, 0x08CFFF, 'CD'],
  [0x090000, 0x090FFF, 'AO'],
  [0x094000, 0x0943FF, 'BJ'],
  [0x096000, 0x0963FF, 'CV'],
  [0x098000, 0x0983FF, 'DJ'],
  [0x09A000, 0x09A3FF, 'GM'],
  [0x09C000, 0x09C3FF, 'BF'],
  [0x09E000, 0x09E3FF, 'ST'],
  [0x0A0000, 0x0A7FFF, 'DZ'],
  [0x0A8000, 0x0A8FFF, 'BS'],
  [0x0AA000, 0x0AAFFF, 'BB'],
  [0x0AB000, 0x0ABFFF, 'BZ'],
  [0x0AC000, 0x0ACFFF, 'CO'],
  [0x0AE000, 0x0AEFFF, 'CR'],
  [0x0B0000, 0x0B0FFF, 'CU'],
  [0x0B2000, 0x0B2FFF, 'SV'],
  [0x0B4000, 0x0B4FFF, 'GT'],
  [0x0B6000, 0x0B6FFF, 'GY'],
  [0x0B8000, 0x0B8FFF, 'HT'],
  [0x0BA000, 0x0BAFFF, 'HN'],
  [0x0BC000, 0x0BCFFF, 'VC'],
  [0x0BE000, 0x0BEFFF, 'JM'],
  [0x0C0000, 0x0C0FFF, 'NI'],
  [0x0C2000, 0x0C2FFF, 'PA'],
  [0x0C4000, 0x0C4FFF, 'DO'],
  [0x0C6000, 0x0C6FFF, 'TT'],
  [0x0C8000, 0x0C8FFF, 'SR'],
  [0x0CA000, 0x0CAFFF, 'AG'],
  [0x0CC000, 0x0CCFFF, 'GD'],
  [0x0D0000, 0x0D7FFF, 'MX'],
  [0x0D8000, 0x0DFFFF, 'VE'],
  [0x100000, 0x1FFFFF, 'RU'],
  [0x201000, 0x2013FF, 'NA'],
  [0x202000, 0x2023FF, 'ER'],
  [0x300000, 0x33FFFF, 'IT'],
  [0x340000, 0x37FFFF, 'ES'],
  [0x380000, 0x3BFFFF, 'FR'],
  [0x3C0000, 0x3FFFFF, 'DE'],
  [0x400000, 0x43FFFF, 'GB'],
  [0x440000, 0x447FFF, 'AT'],
  [0x448000, 0x44FFFF, 'BE'],
  [0x450000, 0x457FFF, 'BG'],
  [0x458000, 0x45FFFF, 'DK'],
  [0x460000, 0x467FFF, 'FI'],
  [0x468000, 0x46FFFF, 'GR'],
  [0x470000, 0x477FFF, 'HU'],
  [0x478000, 0x47FFFF, 'NO'],
  [0x480000, 0x487FFF, 'NL'],
  [0x488000, 0x48FFFF, 'PL'],
  [0x490000, 0x497FFF, 'PT'],
  [0x498000, 0x49FFFF, 'CZ'],
  [0x4A0000, 0x4A7FFF, 'RO'],
  [0x4A8000, 0x4AFFFF, 'SE'],
  [0x4B0000, 0x4B7FFF, 'CH'],
  [0x4B8000, 0x4BFFFF, 'TR'],
  [0x4C0000, 0x4C7FFF, 'RS'],
  [0x4C8000, 0x4C83FF, 'CY'],
  [0x4CA000, 0x4CAFFF, 'IE'],
  [0x4CC000, 0x4CCFFF, 'IS'],
  [0x4D0000, 0x4D03FF, 'LU'],
  [0x4D2000, 0x4D23FF, 'MT'],
  [0x4D4000, 0x4D43FF, 'MC'],
  [0x500000, 0x5003FF, 'SM'],
  [0x501000, 0x5013FF, 'AL'],
  [0x501C00, 0x501FFF, 'HR'],
  [0x502C00, 0x502FFF, 'LV'],
  [0x503C00, 0x503FFF, 'LT'],
  [0x504C00, 0x504FFF, 'MD'],
  [0x505C00, 0x505FFF, 'SK'],
  [0x506C00, 0x506FFF, 'SI'],
  [0x507C00, 0x507FFF, 'UZ'],
  [0x508000, 0x50FFFF, 'UA'],
  [0x510000, 0x5103FF, 'BY'],
  [0x511000, 0x5113FF, 'EE'],
  [0x512000, 0x5123FF, 'MK'],
  [0x513000, 0x5133FF, 'BA'],
  [0x514000, 0x5143FF, 'GE'],
  [0x515000, 0x5153FF, 'TJ'],
  [0x516000, 0x5163FF, 'ME'],
  [0x600000, 0x6003FF, 'AM'],
  [0x600800, 0x600BFF, 'AZ'],
  [0x601000, 0x6013FF, 'KG'],
  [0x601800, 0x601BFF, 'TM'],
  [0x680000, 0x6803FF, 'BT'],
  [0x681000, 0x6813FF, 'FM'],
  [0x682000, 0x6823FF, 'MN'],
  [0x683000, 0x6833FF, 'KZ'],
  [0x684000, 0x6843FF, 'PW'],
  [0x700000, 0x700FFF, 'AF'],
  [0x702000, 0x702FFF, 'BD'],
  [0x704000, 0x704FFF, 'MM'],
  [0x706000, 0x706FFF, 'KW'],
  [0x708000, 0x708FFF, 'LA'],
  [0x70A000, 0x70AFFF, 'NP'],
  [0x70C000, 0x70CFFF, 'OM'],
  [0x70E000, 0x70EFFF, 'KH'],
  [0x710000, 0x717FFF, 'SA'],
  [0x718000, 0x71FFFF, 'KR'],
  [0x720000, 0x727FFF, 'KP'],
  [0x728000, 0x72FFFF, 'IQ'],
  [0x730000, 0x737FFF, 'IR'],
  [0x738000, 0x73FFFF, 'IL'],
  [0x740000, 0x747FFF, 'JO'],
  [0x748000, 0x74FFFF, 'LB'],
  [0x750000, 0x757FFF, 'MY'],
  [0x758000, 0x75FFFF, 'PH'],
  [0x760000, 0x767FFF, 'PK'],
  [0x768000, 0x76FFFF, 'SG'],
  [0x770000, 0x777FFF, 'LK'],
  [0x778000, 0x77FFFF, 'SY'],
  [0x780000, 0x7BFFFF, 'CN'],
  [0x7C0000, 0x7FFFFF, 'AU'],
  [0x800000, 0x83FFFF, 'IN'],
  [0x840000, 0x87FFFF, 'JP'],
  [0x880000, 0x887FFF, 'TH'],
  [0x888000, 0x88FFFF, 'VN'],
  [0x890000, 0x890FFF, 'YE'],
  [0x894000, 0x894FFF, 'BH'],
  [0x895000, 0x8953FF, 'BN'],
  [0x896000, 0x896FFF, 'AE'],
  [0x897000, 0x8973FF, 'SB'],
  [0x898000, 0x898FFF, 'PG'],
  [0x899000, 0x8993FF, 'TW'],
  [0x8A0000, 0x8A7FFF, 'ID'],
  [0x900000, 0x9003FF, 'MH'],
  [0x901000, 0x9013FF, 'CK'],
  [0x902000, 0x9023FF, 'WS'],
  [0xA00000, 0xAFFFFF, 'US'],
  [0xC00000, 0xC3FFFF, 'CA'],
  [0xC80000, 0xC87FFF, 'NZ'],
  [0xC88000, 0xC88FFF, 'FJ'],
  [0xC8A000, 0xC8A3FF, 'NR'],
  [0xC8C000, 0xC8C3FF, 'LA'],
  [0xC8D000, 0xC8D3FF, 'TO'],
  [0xC8E000, 0xC8E3FF, 'KI'],
  [0xC90000, 0xC903FF, 'VU'],
  [0xE00000, 0xE3FFFF, 'AR'],
  [0xE40000, 0xE7FFFF, 'BR'],
  [0xE80000, 0xE80FFF, 'CL'],
  [0xE84000, 0xE84FFF, 'EC'],
  [0xE88000, 0xE88FFF, 'PY'],
  [0xE8C000, 0xE8CFFF, 'PE'],
  [0xE90000, 0xE90FFF, 'UY'],
  [0xE94000, 0xE94FFF, 'BO'],
]

const META: Record<string, { name: string; flag: string; region: string }> = {
  US: { name: 'United States', flag: '🇺🇸', region: 'N.America' },
  CA: { name: 'Canada', flag: '🇨🇦', region: 'N.America' },
  MX: { name: 'Mexico', flag: '🇲🇽', region: 'N.America' },
  GB: { name: 'United Kingdom', flag: '🇬🇧', region: 'Europe' },
  DE: { name: 'Germany', flag: '🇩🇪', region: 'Europe' },
  FR: { name: 'France', flag: '🇫🇷', region: 'Europe' },
  IT: { name: 'Italy', flag: '🇮🇹', region: 'Europe' },
  ES: { name: 'Spain', flag: '🇪🇸', region: 'Europe' },
  NL: { name: 'Netherlands', flag: '🇳🇱', region: 'Europe' },
  BE: { name: 'Belgium', flag: '🇧🇪', region: 'Europe' },
  CH: { name: 'Switzerland', flag: '🇨🇭', region: 'Europe' },
  AT: { name: 'Austria', flag: '🇦🇹', region: 'Europe' },
  SE: { name: 'Sweden', flag: '🇸🇪', region: 'Europe' },
  NO: { name: 'Norway', flag: '🇳🇴', region: 'Europe' },
  DK: { name: 'Denmark', flag: '🇩🇰', region: 'Europe' },
  FI: { name: 'Finland', flag: '🇫🇮', region: 'Europe' },
  IE: { name: 'Ireland', flag: '🇮🇪', region: 'Europe' },
  PT: { name: 'Portugal', flag: '🇵🇹', region: 'Europe' },
  GR: { name: 'Greece', flag: '🇬🇷', region: 'Europe' },
  PL: { name: 'Poland', flag: '🇵🇱', region: 'Europe' },
  CZ: { name: 'Czechia', flag: '🇨🇿', region: 'Europe' },
  HU: { name: 'Hungary', flag: '🇭🇺', region: 'Europe' },
  RO: { name: 'Romania', flag: '🇷🇴', region: 'Europe' },
  TR: { name: 'Türkiye', flag: '🇹🇷', region: 'Europe' },
  RU: { name: 'Russia', flag: '🇷🇺', region: 'Europe' },
  UA: { name: 'Ukraine', flag: '🇺🇦', region: 'Europe' },
  IS: { name: 'Iceland', flag: '🇮🇸', region: 'Europe' },
  LU: { name: 'Luxembourg', flag: '🇱🇺', region: 'Europe' },
  CN: { name: 'China', flag: '🇨🇳', region: 'Asia' },
  JP: { name: 'Japan', flag: '🇯🇵', region: 'Asia' },
  KR: { name: 'South Korea', flag: '🇰🇷', region: 'Asia' },
  IN: { name: 'India', flag: '🇮🇳', region: 'Asia' },
  ID: { name: 'Indonesia', flag: '🇮🇩', region: 'Asia' },
  TH: { name: 'Thailand', flag: '🇹🇭', region: 'Asia' },
  VN: { name: 'Vietnam', flag: '🇻🇳', region: 'Asia' },
  PH: { name: 'Philippines', flag: '🇵🇭', region: 'Asia' },
  MY: { name: 'Malaysia', flag: '🇲🇾', region: 'Asia' },
  SG: { name: 'Singapore', flag: '🇸🇬', region: 'Asia' },
  TW: { name: 'Taiwan', flag: '🇹🇼', region: 'Asia' },
  PK: { name: 'Pakistan', flag: '🇵🇰', region: 'Asia' },
  BD: { name: 'Bangladesh', flag: '🇧🇩', region: 'Asia' },
  LK: { name: 'Sri Lanka', flag: '🇱🇰', region: 'Asia' },
  KZ: { name: 'Kazakhstan', flag: '🇰🇿', region: 'Asia' },
  AE: { name: 'UAE', flag: '🇦🇪', region: 'M.East' },
  SA: { name: 'Saudi Arabia', flag: '🇸🇦', region: 'M.East' },
  QA: { name: 'Qatar', flag: '🇶🇦', region: 'M.East' },
  IL: { name: 'Israel', flag: '🇮🇱', region: 'M.East' },
  IR: { name: 'Iran', flag: '🇮🇷', region: 'M.East' },
  IQ: { name: 'Iraq', flag: '🇮🇶', region: 'M.East' },
  JO: { name: 'Jordan', flag: '🇯🇴', region: 'M.East' },
  LB: { name: 'Lebanon', flag: '🇱🇧', region: 'M.East' },
  KW: { name: 'Kuwait', flag: '🇰🇼', region: 'M.East' },
  OM: { name: 'Oman', flag: '🇴🇲', region: 'M.East' },
  BH: { name: 'Bahrain', flag: '🇧🇭', region: 'M.East' },
  AU: { name: 'Australia', flag: '🇦🇺', region: 'Oceania' },
  NZ: { name: 'New Zealand', flag: '🇳🇿', region: 'Oceania' },
  BR: { name: 'Brazil', flag: '🇧🇷', region: 'S.America' },
  AR: { name: 'Argentina', flag: '🇦🇷', region: 'S.America' },
  CL: { name: 'Chile', flag: '🇨🇱', region: 'S.America' },
  CO: { name: 'Colombia', flag: '🇨🇴', region: 'S.America' },
  PE: { name: 'Peru', flag: '🇵🇪', region: 'S.America' },
  EC: { name: 'Ecuador', flag: '🇪🇨', region: 'S.America' },
  VE: { name: 'Venezuela', flag: '🇻🇪', region: 'S.America' },
  UY: { name: 'Uruguay', flag: '🇺🇾', region: 'S.America' },
  ZA: { name: 'South Africa', flag: '🇿🇦', region: 'Africa' },
  EG: { name: 'Egypt', flag: '🇪🇬', region: 'Africa' },
  MA: { name: 'Morocco', flag: '🇲🇦', region: 'Africa' },
  NG: { name: 'Nigeria', flag: '🇳🇬', region: 'Africa' },
  KE: { name: 'Kenya', flag: '🇰🇪', region: 'Africa' },
  ET: { name: 'Ethiopia', flag: '🇪🇹', region: 'Africa' },
  DZ: { name: 'Algeria', flag: '🇩🇿', region: 'Africa' },
  TN: { name: 'Tunisia', flag: '🇹🇳', region: 'Africa' },
  LY: { name: 'Libya', flag: '🇱🇾', region: 'Africa' },
}

function lookupCountry(hex: string): string {
  const n = parseInt(hex, 16)
  if (!Number.isFinite(n)) return '?'
  // binary search since RANGES are sorted by start
  let lo = 0, hi = RANGES.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = RANGES[mid]
    if (n < r[0]) hi = mid - 1
    else if (n > r[1]) lo = mid + 1
    else return r[2]
  }
  return '?'
}

const LAYER_HALO = 'ft-atlas-halo'
const SRC_HALO = 'ft-atlas-halo-src'

export default function RegistryAtlas({ map, flights, onClose, onFly }: Props) {
  const [airborneOnly, setAirborneOnly] = useState(true)
  const [topN, setTopN] = useState(20)
  const [query, setQuery] = useState('')
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null)
  const [groupByRegion, setGroupByRegion] = useState(false)

  // tag every flight with country code
  const tagged = useMemo(() => flights.map(f => ({ ...f, country: lookupCountry(f.icao) })), [flights])

  const filtered = useMemo(() => {
    return tagged.filter(f => !airborneOnly || !f.ground)
  }, [tagged, airborneOnly])

  // build country rollup
  const rollup = useMemo(() => {
    const m = new Map<string, {
      cc: string; total: number; airborne: number; ground: number; mil: number;
      altSum: number; altN: number; spdSum: number; spdN: number;
      ops: Map<string, number>; types: Map<string, number>;
      planes: AtlasPlane[];
    }>()
    for (const f of filtered) {
      const cc = (f as any).country as string
      let r = m.get(cc)
      if (!r) {
        r = { cc, total: 0, airborne: 0, ground: 0, mil: 0, altSum: 0, altN: 0, spdSum: 0, spdN: 0, ops: new Map(), types: new Map(), planes: [] }
        m.set(cc, r)
      }
      r.total++
      if (f.ground) r.ground++; else r.airborne++
      if (f.military) r.mil++
      if (f.altitudeFt > 0) { r.altSum += f.altitudeFt; r.altN++ }
      if (f.velocityKts > 0) { r.spdSum += f.velocityKts; r.spdN++ }
      if (f.operator) r.ops.set(f.operator, (r.ops.get(f.operator) || 0) + 1)
      if (f.type) r.types.set(f.type, (r.types.get(f.type) || 0) + 1)
      r.planes.push(f)
    }
    const list = [...m.values()].map(r => ({
      cc: r.cc,
      meta: META[r.cc],
      total: r.total,
      airborne: r.airborne,
      ground: r.ground,
      mil: r.mil,
      avgFl: r.altN ? Math.round(r.altSum / r.altN / 100) : 0,
      avgKts: r.spdN ? Math.round(r.spdSum / r.spdN) : 0,
      topOp: [...r.ops.entries()].sort((a, b) => b[1] - a[1])[0],
      topType: [...r.types.entries()].sort((a, b) => b[1] - a[1])[0],
      planes: r.planes,
    }))
    list.sort((a, b) => b.total - a.total)
    return list
  }, [filtered])

  const grandTotal = filtered.length
  const totalCountries = rollup.length

  const q = query.trim().toLowerCase()
  const visible = useMemo(() => {
    let v = rollup
    if (q) v = v.filter(r => {
      const name = (r.meta?.name || '').toLowerCase()
      return r.cc.toLowerCase().includes(q) || name.includes(q) || (r.meta?.region || '').toLowerCase().includes(q)
    })
    return v.slice(0, topN)
  }, [rollup, q, topN])

  const regions = useMemo(() => {
    const m = new Map<string, { region: string; total: number; airborne: number; ccCount: number }>()
    for (const r of rollup) {
      const reg = r.meta?.region || 'Other'
      let e = m.get(reg)
      if (!e) { e = { region: reg, total: 0, airborne: 0, ccCount: 0 }; m.set(reg, e) }
      e.total += r.total; e.airborne += r.airborne; e.ccCount++
    }
    return [...m.values()].sort((a, b) => b.total - a.total)
  }, [rollup])

  const selectedRow = useMemo(() => rollup.find(r => r.cc === selectedCountry) || null, [rollup, selectedCountry])

  // draw halos for selected country's planes
  useEffect(() => {
    if (!map) return
    const tryDraw = () => {
      try {
        const feats = selectedRow ? selectedRow.planes.map(p => ({
          type: 'Feature' as const,
          properties: { icao: p.icao },
          geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
        })) : []
        const data = { type: 'FeatureCollection' as const, features: feats }
        const src = map.getSource(SRC_HALO) as any
        if (src && src.setData) {
          src.setData(data)
        } else {
          map.addSource(SRC_HALO, { type: 'geojson', data })
          map.addLayer({
            id: LAYER_HALO,
            type: 'circle',
            source: SRC_HALO,
            paint: {
              'circle-radius': 16,
              'circle-color': '#22d3ee',
              'circle-opacity': 0.18,
              'circle-stroke-color': '#22d3ee',
              'circle-stroke-width': 2,
              'circle-stroke-opacity': 0.85,
            },
          })
        }
      } catch {}
    }
    if (map.isStyleLoaded()) tryDraw()
    else map.once('load', tryDraw)
    return () => {
      try {
        if (map.getLayer(LAYER_HALO)) map.removeLayer(LAYER_HALO)
        if (map.getSource(SRC_HALO)) map.removeSource(SRC_HALO)
      } catch {}
    }
  }, [map, selectedRow])

  return (
    <div className="absolute top-20 right-4 z-30 w-[420px] max-h-[82vh] flex flex-col rounded-xl border border-white/10 bg-slate-950/95 backdrop-blur-md shadow-2xl text-slate-100 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 bg-gradient-to-r from-cyan-900/40 to-indigo-900/40">
        <div className="flex items-center gap-2">
          <span className="text-cyan-300 text-sm font-semibold tracking-wide">REGISTRY ATLAS</span>
          <span className="text-[10px] text-slate-400">{totalCountries} countries · {grandTotal} aircraft</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white text-sm px-2">✕</button>
      </div>

      <div className="px-3 py-2 border-b border-white/10 space-y-2">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search country (name / ISO / region)…"
          className="w-full px-2 py-1 text-xs rounded-md bg-slate-900 border border-white/10 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500"
        />
        <div className="flex items-center gap-2 text-[11px]">
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={airborneOnly} onChange={e => setAirborneOnly(e.target.checked)} className="accent-cyan-500" />
            <span>Airborne only</span>
          </label>
          <label className="flex items-center gap-1 cursor-pointer ml-2">
            <input type="checkbox" checked={groupByRegion} onChange={e => setGroupByRegion(e.target.checked)} className="accent-cyan-500" />
            <span>Region rollup</span>
          </label>
          <span className="ml-auto text-slate-400">Top</span>
          <select value={topN} onChange={e => setTopN(Number(e.target.value))} className="bg-slate-900 border border-white/10 rounded px-1 py-0.5 text-[11px]">
            {[10, 20, 30, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>

      {groupByRegion && (
        <div className="px-3 py-2 border-b border-white/10 grid grid-cols-2 gap-1.5">
          {regions.map(r => {
            const pct = grandTotal ? r.total / grandTotal : 0
            return (
              <div key={r.region} className="rounded-md bg-slate-900/70 border border-white/5 px-2 py-1.5">
                <div className="flex items-center justify-between text-[10px] text-slate-400">
                  <span>{r.region}</span><span>{r.ccCount} cc</span>
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-sm font-semibold text-cyan-300">{r.total}</span>
                  <span className="text-[10px] text-slate-500">{r.airborne} ab</span>
                </div>
                <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden">
                  <div className="h-full bg-cyan-500/70" style={{ width: `${Math.min(100, pct * 100).toFixed(1)}%` }} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {visible.length === 0 && (
          <div className="px-3 py-8 text-center text-xs text-slate-500">No aircraft match current filter.</div>
        )}
        {visible.map((r, i) => {
          const pct = grandTotal ? r.total / grandTotal : 0
          const isSel = r.cc === selectedCountry
          return (
            <button
              key={r.cc}
              onClick={() => setSelectedCountry(isSel ? null : r.cc)}
              className={`w-full text-left px-3 py-2 border-b border-white/5 transition-colors ${isSel ? 'bg-cyan-500/15 hover:bg-cyan-500/20' : 'hover:bg-white/5'}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-slate-500 w-5 text-right tabular-nums">{i + 1}</span>
                <span className="text-lg leading-none">{r.meta?.flag || '🏳️'}</span>
                <span className="text-xs font-semibold truncate flex-1">{r.meta?.name || `Reg ${r.cc}`}</span>
                <span className="text-[10px] text-slate-500">{r.cc}</span>
                <span className="text-sm font-semibold tabular-nums text-cyan-300 ml-2">{r.total}</span>
              </div>
              <div className="mt-1 ml-7 h-1 rounded bg-slate-800 overflow-hidden">
                <div className="h-full bg-gradient-to-r from-cyan-500 to-indigo-500" style={{ width: `${Math.min(100, pct * 100).toFixed(1)}%` }} />
              </div>
              <div className="mt-1 ml-7 flex items-center gap-2 flex-wrap text-[10px] text-slate-400">
                <span className="text-emerald-400">{r.airborne} airborne</span>
                {r.ground > 0 && <span className="text-amber-400">{r.ground} grnd</span>}
                {r.mil > 0 && <span className="text-rose-400">⚔ {r.mil} mil</span>}
                {r.avgFl > 0 && <span>avg FL{r.avgFl.toString().padStart(3, '0')}</span>}
                {r.avgKts > 0 && <span>{r.avgKts}kt</span>}
                {r.topOp && <span className="truncate max-w-[110px]">· {r.topOp[0]} ({r.topOp[1]})</span>}
                {r.topType && <span>· {r.topType[0]}×{r.topType[1]}</span>}
              </div>
            </button>
          )
        })}
      </div>

      {selectedRow && (
        <div className="border-t border-white/10 bg-slate-900/80 max-h-[28vh] overflow-y-auto">
          <div className="px-3 py-2 sticky top-0 bg-slate-900/95 border-b border-white/10 flex items-center gap-2">
            <span className="text-lg">{selectedRow.meta?.flag || '🏳️'}</span>
            <span className="text-xs font-semibold flex-1 truncate">{selectedRow.meta?.name || selectedRow.cc} — aircraft</span>
            <span className="text-[10px] text-slate-500">{selectedRow.planes.length}</span>
            <button onClick={() => setSelectedCountry(null)} className="text-[10px] text-slate-400 hover:text-white">clear</button>
          </div>
          {selectedRow.planes.slice(0, 60).map(p => (
            <button
              key={p.icao}
              onClick={() => onFly?.(p.icao)}
              className="w-full text-left px-3 py-1.5 hover:bg-white/5 border-b border-white/5 flex items-center gap-2"
            >
              <span className="text-[11px] font-mono text-cyan-300 w-16 truncate">{p.callsign || p.icao.toUpperCase()}</span>
              <span className="text-[10px] text-slate-400 w-12 truncate">{p.type || '—'}</span>
              <span className="text-[10px] text-slate-500 flex-1 truncate">{p.operator || ''}</span>
              <span className="text-[10px] tabular-nums text-slate-400">{p.altitudeFt > 0 ? `FL${Math.round(p.altitudeFt / 100).toString().padStart(3, '0')}` : (p.ground ? 'GND' : '—')}</span>
              <span className="text-[10px] tabular-nums text-slate-500 w-10 text-right">{p.velocityKts ? `${Math.round(p.velocityKts)}kt` : ''}</span>
            </button>
          ))}
          {selectedRow.planes.length > 60 && (
            <div className="px-3 py-2 text-[10px] text-slate-500 text-center">+{selectedRow.planes.length - 60} more…</div>
          )}
        </div>
      )}
    </div>
  )
}
