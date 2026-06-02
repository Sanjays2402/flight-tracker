'use client'
import { useEffect, useMemo, useRef, useState } from 'react'

export type EventKind =
  | 'takeoff'
  | 'landing'
  | 'emergency'
  | 'watch'
  | 'climb'
  | 'descend'
  | 'fast'
  | 'enter'
  | 'leave'

export interface LogEvent {
  id: string
  t: number
  kind: EventKind
  icao: string
  callsign: string
  text: string
  lat?: number
  lng?: number
}

const KIND_META: Record<EventKind, { label: string; color: string; bg: string; icon: string }> = {
  takeoff:   { label: 'Takeoff',   color: '#86efac', bg: 'rgba(34,197,94,0.12)',  icon: '↗' },
  landing:   { label: 'Landing',   color: '#fdba74', bg: 'rgba(249,115,22,0.12)', icon: '↘' },
  emergency: { label: 'Emergency', color: '#fda4af', bg: 'rgba(244,63,94,0.18)',  icon: '!' },
  watch:     { label: 'Watch hit', color: '#67e8f9', bg: 'rgba(34,211,238,0.12)', icon: '★' },
  climb:     { label: 'Climb',     color: '#bef264', bg: 'rgba(132,204,22,0.10)', icon: '⤴' },
  descend:   { label: 'Descend',   color: '#fde047', bg: 'rgba(234,179,8,0.10)',  icon: '⤵' },
  fast:      { label: 'High-Mach', color: '#c4b5fd', bg: 'rgba(167,139,250,0.12)',icon: '»' },
  enter:     { label: 'Entered',   color: '#94a3b8', bg: 'rgba(148,163,184,0.10)',icon: '+' },
  leave:     { label: 'Left',      color: '#64748b', bg: 'rgba(100,116,139,0.10)',icon: '−' },
}

const ALL_KINDS = Object.keys(KIND_META) as EventKind[]
const DEFAULT_ENABLED: EventKind[] = ['takeoff','landing','emergency','watch','climb','descend','fast']

function timeAgo(t: number, now: number) {
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

export default function EventLog({
  events,
  onSelect,
  onClose,
  onClear,
  enabled,
  setEnabled,
}: {
  events: LogEvent[]
  onSelect: (e: LogEvent) => void
  onClose: () => void
  onClear: () => void
  enabled: Set<EventKind>
  setEnabled: (s: Set<EventKind>) => void
}) {
  const [tick, setTick] = useState(0)
  const [paused, setPaused] = useState(false)
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    const id = setInterval(() => setTick(x => x + 1), 5000)
    return () => clearInterval(id)
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let out = events.filter(e => enabled.has(e.kind))
    if (q) out = out.filter(e =>
      e.callsign.toLowerCase().includes(q) ||
      e.icao.toLowerCase().includes(q) ||
      e.text.toLowerCase().includes(q) ||
      KIND_META[e.kind].label.toLowerCase().includes(q)
    )
    return out
  }, [events, enabled, query])

  // Auto-scroll to newest unless user scrolled away
  useEffect(() => {
    if (paused || !stickRef.current) return
    const el = listRef.current
    if (el) el.scrollTop = 0
  }, [filtered.length, paused])

  function onScroll() {
    const el = listRef.current
    if (!el) return
    stickRef.current = el.scrollTop < 24
  }

  function toggle(k: EventKind) {
    const ns = new Set(enabled)
    if (ns.has(k)) ns.delete(k); else ns.add(k)
    setEnabled(ns)
  }

  const now = Date.now()
  const shown = paused ? filtered : filtered

  const counts = useMemo(() => {
    const m: Partial<Record<EventKind, number>> = {}
    for (const e of events) m[e.kind] = (m[e.kind] || 0) + 1
    return m
  }, [events])

  return (
    <div
      style={{
        position: 'absolute',
        right: 16,
        top: 84,
        width: 360,
        maxHeight: 'calc(100vh - 120px)',
        display: 'flex',
        flexDirection: 'column',
        background: 'rgba(8,11,20,0.94)',
        backdropFilter: 'blur(16px)',
        border: '1px solid rgba(148,163,184,0.18)',
        borderRadius: 14,
        boxShadow: '0 24px 60px -20px rgba(0,0,0,0.7)',
        color: '#e2e8f0',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system',
        zIndex: 40,
        overflow: 'hidden',
      }}
    >
      {/* header */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,0.15)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 8, height: 8, borderRadius: 8, background: paused ? '#fbbf24' : '#22c55e', boxShadow: paused ? 'none' : '0 0 8px #22c55e' }} />
        <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: 0.5 }}>EVENT LOG</div>
        <div style={{ fontSize: 10, color: '#64748b', marginLeft: 4 }}>{filtered.length}/{events.length}</div>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => setPaused(p => !p)}
          style={btn(paused ? '#fbbf24' : '#94a3b8')}
          title={paused ? 'Resume' : 'Pause'}
        >{paused ? '▶' : '❚❚'}</button>
        <button onClick={onClear} style={btn('#94a3b8')} title="Clear">⟲</button>
        <button onClick={onClose} style={btn('#94a3b8')} title="Close">✕</button>
      </div>

      {/* filter chips */}
      <div style={{ padding: '8px 10px', display: 'flex', flexWrap: 'wrap', gap: 4, borderBottom: '1px solid rgba(148,163,184,0.10)' }}>
        {ALL_KINDS.map(k => {
          const m = KIND_META[k]
          const on = enabled.has(k)
          const c = counts[k] || 0
          return (
            <button
              key={k}
              onClick={() => toggle(k)}
              style={{
                fontSize: 10,
                padding: '3px 7px',
                borderRadius: 999,
                border: `1px solid ${on ? m.color : 'rgba(100,116,139,0.4)'}`,
                background: on ? m.bg : 'transparent',
                color: on ? m.color : '#64748b',
                cursor: 'pointer',
                fontWeight: 600,
                letterSpacing: 0.3,
              }}
            >{m.icon} {m.label}{c ? ` ${c}` : ''}</button>
          )
        })}
      </div>

      {/* search */}
      <div style={{ padding: '6px 10px', borderBottom: '1px solid rgba(148,163,184,0.10)' }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Filter callsign / kind…"
          style={{
            width: '100%',
            background: 'rgba(15,23,42,0.7)',
            border: '1px solid rgba(148,163,184,0.18)',
            borderRadius: 8,
            padding: '5px 9px',
            color: '#e2e8f0',
            fontSize: 11,
            outline: 'none',
          }}
        />
      </div>

      {/* list */}
      <div ref={listRef} onScroll={onScroll} style={{ overflowY: 'auto', flex: 1, padding: 6 }}>
        {shown.length === 0 && (
          <div style={{ padding: 20, textAlign: 'center', color: '#64748b', fontSize: 11 }}>
            Listening for events…<br/>
            <span style={{ fontSize: 10, opacity: 0.7 }}>Takeoffs, landings, emergencies, climbs, descents and high-Mach flights will appear here.</span>
          </div>
        )}
        {shown.map(e => {
          const m = KIND_META[e.kind]
          return (
            <button
              key={e.id}
              onClick={() => onSelect(e)}
              style={{
                width: '100%',
                textAlign: 'left',
                background: m.bg,
                border: `1px solid ${m.color}33`,
                borderLeft: `3px solid ${m.color}`,
                borderRadius: 8,
                padding: '6px 9px',
                margin: '3px 0',
                color: '#e2e8f0',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span style={{ color: m.color, fontWeight: 700, fontSize: 13, width: 14, textAlign: 'center' }}>{m.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 600, display: 'flex', gap: 6 }}>
                  <span style={{ color: m.color }}>{e.callsign || e.icao}</span>
                  <span style={{ color: '#94a3b8', fontWeight: 400 }}>{e.text}</span>
                </div>
                <div style={{ fontSize: 9, color: '#64748b', letterSpacing: 0.3, marginTop: 1 }}>
                  {m.label.toUpperCase()} · {timeAgo(e.t, now + tick * 0)}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function btn(color: string): React.CSSProperties {
  return {
    background: 'transparent',
    border: `1px solid rgba(148,163,184,0.20)`,
    borderRadius: 6,
    color,
    padding: '2px 7px',
    fontSize: 10,
    cursor: 'pointer',
    lineHeight: 1.2,
  }
}

/* ---- detection helper used by parent ---- */
export interface SnapshotEntry {
  icao: string
  callsign: string
  altitudeFt: number
  ground: boolean
  mach: number
  squawk: string
  lat: number
  lng: number
}

const MILESTONES = [10000, 18000, 25000, 35000, 40000]

export function detectEvents(
  prev: Map<string, SnapshotEntry>,
  next: SnapshotEntry[],
  isWatched: (icao: string, callsign: string) => boolean,
): LogEvent[] {
  const out: LogEvent[] = []
  const now = Date.now()
  const nextIcaos = new Set<string>()
  for (const f of next) {
    nextIcaos.add(f.icao)
    const p = prev.get(f.icao)
    const cs = f.callsign || f.icao
    const baseId = `${f.icao}-${now}`
    if (!p) {
      // first sight — only if airborne notable
      continue
    }
    // takeoff
    if (p.ground && !f.ground && f.altitudeFt > 50) {
      out.push({ id: `${baseId}-to`, t: now, kind: 'takeoff', icao: f.icao, callsign: cs, text: 'lifted off', lat: f.lat, lng: f.lng })
    }
    // landing
    if (!p.ground && f.ground) {
      out.push({ id: `${baseId}-ld`, t: now, kind: 'landing', icao: f.icao, callsign: cs, text: 'touched down', lat: f.lat, lng: f.lng })
    }
    // emergency squawk transition
    const EM = new Set(['7500','7600','7700'])
    if (EM.has(f.squawk) && f.squawk !== p.squawk) {
      out.push({ id: `${baseId}-em`, t: now, kind: 'emergency', icao: f.icao, callsign: cs, text: `squawk ${f.squawk}`, lat: f.lat, lng: f.lng })
    }
    // altitude milestones (only if climbing through or descending through)
    if (!f.ground && !p.ground) {
      for (const ms of MILESTONES) {
        if (p.altitudeFt < ms && f.altitudeFt >= ms) {
          out.push({ id: `${baseId}-up${ms}`, t: now, kind: 'climb', icao: f.icao, callsign: cs, text: `passing FL${(ms/100).toFixed(0).padStart(3,'0')}`, lat: f.lat, lng: f.lng })
        } else if (p.altitudeFt >= ms && f.altitudeFt < ms) {
          out.push({ id: `${baseId}-dn${ms}`, t: now, kind: 'descend', icao: f.icao, callsign: cs, text: `descending FL${(ms/100).toFixed(0).padStart(3,'0')}`, lat: f.lat, lng: f.lng })
        }
      }
    }
    // high mach
    if (f.mach >= 0.85 && (p.mach < 0.85 || !p.mach)) {
      out.push({ id: `${baseId}-mc`, t: now, kind: 'fast', icao: f.icao, callsign: cs, text: `M${f.mach.toFixed(2)}`, lat: f.lat, lng: f.lng })
    }
  }
  // watch hits (entries new this tick)
  for (const f of next) {
    if (!prev.has(f.icao) && isWatched(f.icao, f.callsign)) {
      out.push({ id: `${f.icao}-${now}-w`, t: now, kind: 'watch', icao: f.icao, callsign: f.callsign || f.icao, text: 'on radar', lat: f.lat, lng: f.lng })
    }
  }
  return out
}
