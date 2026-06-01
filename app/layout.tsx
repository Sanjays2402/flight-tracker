import './globals.css'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Metadata, Viewport } from 'next'

const SITE = 'https://sanjays2402.github.io/flight-tracker'

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: {
    default: 'Flight Tracker — Live aircraft positions, free, no signup',
    template: '%s · Flight Tracker',
  },
  description: 'Real-time global flight tracker. Watch 25,000+ aircraft live with routes, weather, photos, statistics, and chase-cam. Free, no signup, no ads.',
  applicationName: 'Flight Tracker',
  keywords: ['flight tracker', 'live flights', 'aircraft positions', 'adsb', 'ads-b', 'real-time flight map', 'flight radar', 'plane finder', 'free flight tracker'],
  authors: [{ name: 'Sanjay Santhanam', url: 'https://github.com/Sanjays2402' }],
  creator: 'Sanjay Santhanam',
  publisher: 'Sanjay Santhanam',
  alternates: { canonical: SITE + '/' },
  manifest: '/flight-tracker/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/flight-tracker/icon.svg', type: 'image/svg+xml' },
      { url: '/flight-tracker/favicon.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: [{ url: '/flight-tracker/apple-touch-icon.png', sizes: '180x180' }],
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: SITE + '/',
    siteName: 'Flight Tracker',
    title: 'Flight Tracker — Live aircraft positions worldwide',
    description: 'Watch 25,000+ aircraft live in real time. Routes, weather, photos, chase-cam, statistics. Free, no signup.',
    images: [{ url: '/flight-tracker/og.jpg', width: 1200, height: 630, alt: 'Flight Tracker — Real-time global flight map' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Flight Tracker — Live aircraft positions',
    description: 'Watch 25,000+ aircraft live in real time. Free, no signup.',
    images: ['/flight-tracker/og.jpg'],
    creator: '@Sanjays2402',
  },
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, 'max-image-preview': 'large' } },
  appleWebApp: {
    capable: true,
    title: 'Flight Tracker',
    statusBarStyle: 'black-translucent',
  },
  formatDetection: { telephone: false, email: false, address: false },
  category: 'travel',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#020617' },
    { media: '(prefers-color-scheme: light)', color: '#020617' },
  ],
  colorScheme: 'dark',
}

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  name: 'Flight Tracker',
  url: SITE + '/',
  applicationCategory: 'TravelApplication',
  operatingSystem: 'Any',
  description: 'Real-time global flight tracker. Watch aircraft live with routes, weather, photos, statistics, and chase-cam.',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  author: { '@type': 'Person', name: 'Sanjay Santhanam', url: 'https://github.com/Sanjays2402' },
  inLanguage: 'en',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://api.adsb.lol" />
        <link rel="preconnect" href="https://corsproxy.io" />
        <link rel="preconnect" href="https://a.basemaps.cartocdn.com" />
        <link rel="preconnect" href="https://b.basemaps.cartocdn.com" />
        <link rel="preconnect" href="https://c.basemaps.cartocdn.com" />
        <link rel="dns-prefetch" href="https://api.planespotters.net" />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
