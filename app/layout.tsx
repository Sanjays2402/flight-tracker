import './globals.css'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Flight Tracker — Live aircraft positions',
  description: 'Real-time global flight tracker. Live aircraft positions from adsb.lol, refreshed every 10 seconds.',
  openGraph: {
    title: 'Flight Tracker',
    description: 'Real-time global flight tracker powered by adsb.lol.',
    type: 'website',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://api.adsb.lol" />
        <link rel="preconnect" href="https://corsproxy.io" />
        <link rel="preconnect" href="https://a.basemaps.cartocdn.com" />
      </head>
      <body>{children}</body>
    </html>
  )
}
