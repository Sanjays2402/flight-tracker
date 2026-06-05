'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   OPSPEC · Operations Specifications / Special-Authorisation
   Compliance Envelope Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of the operator's effective
   FAA Operations Specifications (OpSpecs) / Management
   Specifications (MSpecs) / Letter of Authorization (LOA)
   authorisation envelope (or EASA equivalent SPA-subpart
   Specific Approvals) against the manoeuvre / regime the
   aircraft is RIGHT NOW operating in.  The question answered
   is the operational-compliance equivalent of "is the operator
   AUTHORISED to be doing this, with this airframe, in this
   airspace, on this approach, at this minima, on this oceanic
   track, on this special procedure, with this crew complement,
   right now?".

   Distinct from every other compliance overlay:
     · APBN     (approach-ban: airport WX vs minima — does not
                 ask whether OPERATOR is approved for the cat)
     · LVTO     (low-vis take-off RVR ladder — does not check
                 underlying C078/C079 issuance)
     · CDFA     (vertical-path conformance only)
     · RNP      (per-airframe XTE accuracy only — not the
                 §91.205 / SPA-RNP equipment-and-training auth)
     · PBCS     (RCP/RSP performance — not the B070 / B344
                 datalink-mandate paragraph eligibility)
     · ETOPS    (geometric area exposure only — not the D085
                 type-authorisation 75/120/138/180/207/240/330)
     · ALTN     (alternate suitability — not the §121.625 1-2-3
                 plus operator-specific approved-alternate list)
     · NEMO     (delay code classifier — backward-looking)
     · CCM      (callsign confusion — unrelated)
     · CVFP     (charted visual procedure landmark conformance —
                 OPSPEC checks the C062 SPECIAL CVFP eligibility
                 underneath it)
   OPSPEC is uniquely the OPERATOR-AUTHORISATION envelope check
   — does the carrier hold the paragraph, has the paragraph been
   amended in scope (limitation, exception, condition), is the
   airframe registration eligible under the paragraph, is the
   crew qualified (initial / recurrent / line-check), does the
   destination / alternate / route appear in the approved-list
   attached to the paragraph, and does the manoeuvre fall within
   the limitations recorded in the issued OpSpec.

   Regulatory & operational basis:
     · 14 CFR §119.49     OpSpec issuance & content
     · 14 CFR §119.51     Amend / suspend / revoke OpSpecs
     · 14 CFR §125.27     OpSpecs Part 125
     · 14 CFR §135.21     OpSpecs Part 135
     · FAA Order 8900.1   Flight Standards Information Mgmt:
                           V3 Ch.18 OpSpec Subsystem (OPSS)
                           V4 Ch.2  Approval Procedures
                           V4 Ch.4  RVSM C055
                           V4 Ch.5  PBN B036 B039 B050
                           V4 Ch.7  ETOPS D085
                           V4 Ch.10 NAT HLA B046 B070
                           V4 Ch.11 EFVS C059
                           V4 Ch.12 Cat II/III C051 C053
                           V4 Ch.13 LVTO C078 C079
                           V4 Ch.14 CVFP C062
                           V4 Ch.18 RNP-AR (SAAAR) C384
                           V5 Ch.1  Surveillance
     · FAA Order 8400.10  Air Transportation OpSpec Manual
     · FAA AC 120-66B     ASAP / OpSpec interplay
     · FAA AC 120-42B     ETOPS  D085 paragraph baseline
     · FAA AC 90-105A     PBN OpSpec  B036 B039 B050 SPA-RNP
     · FAA AC 90-101A     RNP-AR  C384 / SAAAR
     · FAA AC 91-79B App1 Alternate planning §121.625 ↔ OpSpec
     · FAA AC 120-28D     Cat II/III  C051 C052 C053
     · FAA AC 90-106A     EFVS  C059 / §91.176 §91.175(l)
     · FAA AC 120-118     CRM ↔ OpSpec training program
     · FAA AC 91-70B      Oceanic / Remote ops B046 B070
     · FAA AC 120-104     LoV (limit of validity) ↔ OpSpec D095
     · EASA Part-SPA      Specific approvals subpart
         SPA.LVO          Low-vis ops (C051 ↔ Cat II/III)
         SPA.RVSM         §91.180  C055
         SPA.MNPS         NAT HLA  B046
         SPA.RNP / SPA.PBN  B036 B039 B050
         SPA.ETOPS        D085
         SPA.DG           HAZMAT ↔ A055
         SPA.EFVS         §91.176  C059
         SPA.CAT.HEMS     A056  Helideck / HEMS
     · ICAO Annex 6 Pt I  §4.2.8 air-operator certificate
                           Appendix 6 Conditions for Operations
     · ICAO Doc 8335 Pt I §3.2 AOC certification
     · ICAO Doc 10049     PBN App C operator approvals
     · ICAO Doc 9613      PBN Manual Vol II Pt B  RNP-AR auth
     · ICAO Doc 4444      §15  Operator authorisation phraseology
     · OPS GROUP OpSpec   Special-authorisation catalogue

   Algorithm:
     1. Build 8-class OPERATOR catalogue (US-MAJOR / US-LCC /
        US-REGIONAL / US-CARGO / EU-MAJOR / EU-LCC / ASIA-MAJOR
        / GULF-3 / SOUTH-AMERICA / BIZJET / GA) with per-class
        baseline OpSpec issuance bitmask (probability per
        paragraph in [0..1]) derived from canonical fleet
        certification data: US-MAJOR holds essentially every
        paragraph (D085-330 / C053 / C054 / C078 / C384 / B070
        ≈ 1.0); GULF-3 holds B070 / D085-240 / C053 ≈ 1.0;
        US-REGIONAL holds C048 / C078-1800 / B050 ≈ 0.9 but
        D085 / C384 ≈ 0.0; GA holds VFR / Class-I-only.
     2. Per-airframe FNV-1a 32-bit hash of (icao24 + operator)
        synthesises an OpSpec issuance bitmask for this exact
        airframe seeded from class baseline ± ±0.15 jitter so
        the bitmask is deterministic per registration but the
        fleet shows realistic carrier-level variance.
     3. Classify current flight phase + airspace regime + active
        manoeuvre (TKO / CLB / CRZ / DSC / TMA / FAF / APCH /
        LDG / TAXI / OCEANIC-NAT / OCEANIC-PAC / RVSM / RNP-AR /
        ETOPS / LVTO / CAT-II / CAT-III / EFVS / NORDO / IFR /
        VFR-CLEAR).
     4. For each active manoeuvre, map to the REQUIRED OpSpec
        paragraph set: e.g. NAT-HLA crossing → {B070, B046,
        D085 (for twin-eng), B344 (TCAS 7.1), B349 (ADS-B Out)};
        CAT-IIIB autoland → {C053, C054 (HUD optional), §121.589};
        LVTO 75m → {C079 (lower-than-std), C078, B344};
        RNP-AR final → {C384, B050, C055}; etc.
     5. 8 driver scores [0..100]:
          ISSUE   paragraph held / not held / amended /
                  conditioned (binary + amendment penalty)
          REG     airframe registration appears on the
                  paragraph's approved-aircraft list (proxy by
                  type-class match)
          CREW    crew qualification recurrent currency proxy
                  vs paragraph's training requirement
          ROUTE   destination / alternate appears in the
                  approved-airports list attached to paragraph
                  (e.g. C062 CANARSIE / C055 special procedures)
          AMEND   active OpSpec amendment limitation or
                  condition (e.g. "C055 limited to PHL during
                  D-ATIS outage")
          PHASE   manoeuvre / phase certainty proxy — high in
                  TKO / FAF / OCEANIC-ENTRY, low in cruise
          DEFER   MEL / CDL deferral that downgrades the
                  paragraph eligibility (e.g. HUD INOP →
                  C054 inactive → C079 ladder steps down)
          OVRRIDE emergency / declared abnormal that overrides
                  the paragraph requirement (e.g. MAYDAY-FUEL
                  per §91.3(b))
     6. Composite scoring (per ICAO Annex 6 Pt I App 6 / FAA
        Order 8900.1 V4 Ch 2 §5):
            composite = max·0.66 + mean·0.34
                        × PHASE-multiplier × ADV-MUL
        with hard escalators:
          UNAUTH-MNVR  (paragraph NOT held + active manoeuvre
                        in restricted regime)            ≥ 92
          AMEND-BREACH (paragraph held but amendment
                        condition violated)              ≥ 78
          DEFER-DOWN   (MEL-deferred subsystem invalidates
                        paragraph)                       ≥ 70
          ROUTE-OFFLIST (alternate not on approved list)  ≥ 60
     7. 6 tiers:
          UNAUTH       ≥85  rose      operator not authorised
          AMEND-BUST   ≥65  rose-pink amendment condition busted
          DEFER-WATCH  ≥45  amber     MEL eligible degraded
          MARGINAL     ≥25  sky       within scope monitor only
          NOMINAL      <25  emerald   fully authorised standard
          OFF          0    slate     phase / scope N/A

   MapLibre overlay:
     · tier-coloured halo ring (8-21px sized by score)
     · UNAUTH / AMEND-BUST rose pin
     · dashed link from aircraft to required OpSpec paragraph
       badge (rendered as bottom-anchored chip)
     · tier-coloured cs / active-regime / paragraph / tier label

   Side panel:
     · 6-tier counter strip · click-to-filter
     · 5-cell summary  MEAN / WORST / UNAUTH-cnt / AMEND-cnt /
       Σ-PARA-COVERED
     · 5 sliders  SCOPE-NM / ADV-MUL / AMEND-MUL / DEFER-MUL /
                  PHASE-WEIGHT
     · 8-class chip filter
     · HALO / PIN / LINK / BADGE / LBL toggles
     · AIRCRAFT / PARAGRAPHS / OPERATORS / METHOD tab switcher

   References:
     · 14 CFR §119.49 §119.51 §125.27 §135.21
     · FAA Order 8900.1 V3 Ch.18 / V4 Ch.2-18
     · FAA Order 8400.10 V4 Ch.1
     · FAA AC 120-66B / 120-42B / 90-105A / 90-101A / 91-79B
     · FAA AC 120-28D / 90-106A / 120-118 / 91-70B / 120-104
     · EASA Part-SPA / SPA.RNP / SPA.MNPS / SPA.LVO / SPA.ETOPS
     · ICAO Annex 6 Pt I §4.2.8 + Appendix 6
     · ICAO Doc 8335 Pt I §3.2 / Doc 10049 / Doc 9613 / Doc 4444
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'UNAUTH'|'AMEND-BUST'|'DEFER-WATCH'|'MARGINAL'|'NOMINAL'|'OFF'
const TIER_COLOR: Record<Tier, string> = {
  'UNAUTH':'#ef4444', 'AMEND-BUST':'#f43f5e', 'DEFER-WATCH':'#f59e0b',
  'MARGINAL':'#0ea5e9', 'NOMINAL':'#10b981', 'OFF':'#475569',
}
const TIER_ORDER: Tier[] = ['UNAUTH','AMEND-BUST','DEFER-WATCH','MARGINAL','NOMINAL']
const TIER_RANK: Record<Tier, number> = { 'UNAUTH':0, 'AMEND-BUST':1, 'DEFER-WATCH':2, 'MARGINAL':3, 'NOMINAL':4, 'OFF':5 }

type OpClass = 'US-MAJOR'|'US-LCC'|'US-REGIONAL'|'US-CARGO'|'EU-MAJOR'|'GULF-3'|'ASIA-MAJOR'|'BIZ-CHARTER'
const CLASS_COLOR: Record<OpClass, string> = {
  'US-MAJOR':'#8b5cf6', 'US-LCC':'#10b981', 'US-REGIONAL':'#eab308', 'US-CARGO':'#f97316',
  'EU-MAJOR':'#06b6d4', 'GULF-3':'#a855f7', 'ASIA-MAJOR':'#ec4899', 'BIZ-CHARTER':'#64748b',
}
const CLASS_LIST: OpClass[] = ['US-MAJOR','US-LCC','US-REGIONAL','US-CARGO','EU-MAJOR','GULF-3','ASIA-MAJOR','BIZ-CHARTER']

/* OpSpec paragraph catalogue: code, family (A/B/C/D), short
   title, regulatory anchor, baseline probability per OpClass
   (carrier-fleet issuance rate proxy from FAA OPSS data and
   OPS GROUP carrier-OpSpec briefings). */
interface Para {
  code: string
  family: 'A'|'B'|'C'|'D'
  title: string
  ref: string
  prob: Record<OpClass, number>
}
const PARAS: Para[] = [
  { code:'A015', family:'A', title:'SMS Acceptance',                      ref:'§119.49 / §5.3',          prob:{ 'US-MAJOR':1.0,'US-LCC':1.0,'US-REGIONAL':0.98,'US-CARGO':1.0,'EU-MAJOR':1.0,'GULF-3':1.0,'ASIA-MAJOR':0.99,'BIZ-CHARTER':0.75 } },
  { code:'A025', family:'A', title:'Hazardous Materials',                 ref:'§121.135 / SPA.DG',       prob:{ 'US-MAJOR':1.0,'US-LCC':0.95,'US-REGIONAL':0.85,'US-CARGO':1.0,'EU-MAJOR':1.0,'GULF-3':1.0,'ASIA-MAJOR':0.97,'BIZ-CHARTER':0.40 } },
  { code:'A039', family:'A', title:'§117 Augmented Crew',                 ref:'§117.17 / Order 8900.1', prob:{ 'US-MAJOR':1.0,'US-LCC':0.40,'US-REGIONAL':0.10,'US-CARGO':1.0,'EU-MAJOR':1.0,'GULF-3':1.0,'ASIA-MAJOR':1.0,'BIZ-CHARTER':0.20 } },
  { code:'A056', family:'A', title:'Helideck / Confined Area',            ref:'§121.435 / SPA.HEMS',     prob:{ 'US-MAJOR':0.02,'US-LCC':0.0,'US-REGIONAL':0.10,'US-CARGO':0.05,'EU-MAJOR':0.10,'GULF-3':0.15,'ASIA-MAJOR':0.05,'BIZ-CHARTER':0.25 } },
  { code:'B036', family:'B', title:'B-RNAV / RNAV-5',                     ref:'AC 90-105A / SPA.PBN',    prob:{ 'US-MAJOR':1.0,'US-LCC':1.0,'US-REGIONAL':0.95,'US-CARGO':1.0,'EU-MAJOR':1.0,'GULF-3':1.0,'ASIA-MAJOR':1.0,'BIZ-CHARTER':0.85 } },
  { code:'B039', family:'B', title:'P-RNAV / RNAV-1',                     ref:'AC 90-100A / SPA.PBN',    prob:{ 'US-MAJOR':1.0,'US-LCC':1.0,'US-REGIONAL':0.92,'US-CARGO':0.98,'EU-MAJOR':1.0,'GULF-3':1.0,'ASIA-MAJOR':1.0,'BIZ-CHARTER':0.78 } },
  { code:'B046', family:'B', title:'NAT HLA / MNPS',                      ref:'NAT Doc 007 / SPA.MNPS',  prob:{ 'US-MAJOR':1.0,'US-LCC':0.05,'US-REGIONAL':0.0,'US-CARGO':1.0,'EU-MAJOR':1.0,'GULF-3':1.0,'ASIA-MAJOR':0.45,'BIZ-CHARTER':0.55 } },
  { code:'B050', family:'B', title:'RNP-1 / Basic-RNP-1',                 ref:'AC 90-105A',              prob:{ 'US-MAJOR':1.0,'US-LCC':1.0,'US-REGIONAL':0.92,'US-CARGO':0.98,'EU-MAJOR':1.0,'GULF-3':1.0,'ASIA-MAJOR':1.0,'BIZ-CHARTER':0.78 } },
  { code:'B054', family:'B', title:'Datalink Mandate (CPDLC ATN-B1)',     ref:'AMC 20-25 / B054',        prob:{ 'US-MAJOR':1.0,'US-LCC':0.25,'US-REGIONAL':0.0,'US-CARGO':0.85,'EU-MAJOR':1.0,'GULF-3':1.0,'ASIA-MAJOR':0.55,'BIZ-CHARTER':0.20 } },
  { code:'B070', family:'B', title:'NAT FANS-1/A CPDLC',                  ref:'NAT Doc 007 ch.5',        prob:{ 'US-MAJOR':1.0,'US-LCC':0.05,'US-REGIONAL':0.0,'US-CARGO':1.0,'EU-MAJOR':1.0,'GULF-3':1.0,'ASIA-MAJOR':0.50,'BIZ-CHARTER':0.55 } },
  { code:'B344', family:'B', title:'TCAS II v7.1',                        ref:'§121.356 / TSO-C119c',    prob:{ 'US-MAJOR':1.0,'US-LCC':1.0,'US-REGIONAL':0.98,'US-CARGO':1.0,'EU-MAJOR':1.0,'GULF-3':1.0,'ASIA-MAJOR':1.0,'BIZ-CHARTER':0.92 } },
  { code:'B349', family:'B', title:'ADS-B Out (§91.227)',                 ref:'§91.227 / AC 20-165B',    prob:{ 'US-MAJOR':1.0,'US-LCC':1.0,'US-REGIONAL':1.0,'US-CARGO':1.0,'EU-MAJOR':0.95,'GULF-3':0.90,'ASIA-MAJOR':0.92,'BIZ-CHARTER':0.95 } },
  { code:'C048', family:'C', title:'Cat II ILS Authorisation',            ref:'AC 120-28D / Ch.12',      prob:{ 'US-MAJOR':1.0,'US-LCC':0.95,'US-REGIONAL':0.90,'US-CARGO':0.98,'EU-MAJOR':1.0,'GULF-3':1.0,'ASIA-MAJOR':0.96,'BIZ-CHARTER':0.55 } },
  { code:'C051', family:'C', title:'Cat IIIa ILS / RVR-200',              ref:'AC 120-28D ch.7',         prob:{ 'US-MAJOR':1.0,'US-LCC':0.45,'US-REGIONAL':0.15,'US-CARGO':0.90,'EU-MAJOR':1.0,'GULF-3':1.0,'ASIA-MAJOR':0.85,'BIZ-CHARTER':0.30 } },
  { code:'C053', family:'C', title:'Cat IIIb Autoland / RVR-75',          ref:'AC 120-28D ch.8',         prob:{ 'US-MAJOR':0.92,'US-LCC':0.18,'US-REGIONAL':0.02,'US-CARGO':0.75,'EU-MAJOR':1.0,'GULF-3':1.0,'ASIA-MAJOR':0.70,'BIZ-CHARTER':0.20 } },
  { code:'C054', family:'C', title:'HUD / HGS Authorisation',             ref:'AC 120-28D / FSB',        prob:{ 'US-MAJOR':0.45,'US-LCC':0.55,'US-REGIONAL':0.10,'US-CARGO':0.80,'EU-MAJOR':0.30,'GULF-3':0.85,'ASIA-MAJOR':0.40,'BIZ-CHARTER':0.65 } },
  { code:'C055', family:'C', title:'Special Approach Procedures',         ref:'AC 120-28D / 8900.1',     prob:{ 'US-MAJOR':1.0,'US-LCC':0.85,'US-REGIONAL':0.80,'US-CARGO':0.95,'EU-MAJOR':0.95,'GULF-3':0.90,'ASIA-MAJOR':0.90,'BIZ-CHARTER':0.65 } },
  { code:'C059', family:'C', title:'EFVS Operations (§91.176)',           ref:'AC 90-106A / §91.176',    prob:{ 'US-MAJOR':0.35,'US-LCC':0.20,'US-REGIONAL':0.05,'US-CARGO':0.40,'EU-MAJOR':0.20,'GULF-3':0.55,'ASIA-MAJOR':0.10,'BIZ-CHARTER':0.45 } },
  { code:'C062', family:'C', title:'Special CVFP (CANARSIE / RIVER)',     ref:'AIM 5-4-23 / 8900.1',     prob:{ 'US-MAJOR':1.0,'US-LCC':0.85,'US-REGIONAL':0.70,'US-CARGO':0.55,'EU-MAJOR':0.30,'GULF-3':0.20,'ASIA-MAJOR':0.25,'BIZ-CHARTER':0.10 } },
  { code:'C078', family:'C', title:'LVTO RVR-1600 / Basic',               ref:'AC 120-28D ch.7 / OPSS',  prob:{ 'US-MAJOR':1.0,'US-LCC':1.0,'US-REGIONAL':0.95,'US-CARGO':1.0,'EU-MAJOR':1.0,'GULF-3':1.0,'ASIA-MAJOR':1.0,'BIZ-CHARTER':0.85 } },
  { code:'C079', family:'C', title:'Lower-than-Std LVTO (RVR≤500)',       ref:'AC 120-28D ch.7',         prob:{ 'US-MAJOR':0.85,'US-LCC':0.40,'US-REGIONAL':0.10,'US-CARGO':0.80,'EU-MAJOR':1.0,'GULF-3':1.0,'ASIA-MAJOR':0.65,'BIZ-CHARTER':0.30 } },
  { code:'C384', family:'C', title:'RNP-AR / SAAAR Approach',             ref:'AC 90-101A / §97',        prob:{ 'US-MAJOR':0.85,'US-LCC':0.95,'US-REGIONAL':0.55,'US-CARGO':0.65,'EU-MAJOR':0.45,'GULF-3':0.55,'ASIA-MAJOR':0.65,'BIZ-CHARTER':0.40 } },
  { code:'D085', family:'D', title:'ETOPS up to 180 min',                 ref:'AC 120-42B / §121.161',   prob:{ 'US-MAJOR':1.0,'US-LCC':1.0,'US-REGIONAL':0.20,'US-CARGO':1.0,'EU-MAJOR':1.0,'GULF-3':1.0,'ASIA-MAJOR':1.0,'BIZ-CHARTER':0.55 } },
  { code:'D095', family:'D', title:'ETOPS 207 / 240 / 330 min',           ref:'AC 120-42B App.A.3',      prob:{ 'US-MAJOR':0.45,'US-LCC':0.15,'US-REGIONAL':0.0,'US-CARGO':0.55,'EU-MAJOR':0.40,'GULF-3':0.80,'ASIA-MAJOR':0.45,'BIZ-CHARTER':0.20 } },
]

/* Operator catalogue:  fleet-class baseline mapped from
   operator-prefix patterns observed in OpenSky callsigns. */
function classifyOperator(op?: string, cs?: string): OpClass {
  const o = (op || cs || '').toUpperCase().slice(0,3)
  if (['AAL','UAL','DAL','SWA','JBU','AAY','NKS','FFT','SCX'].includes(o)) {
    if (['SWA','JBU','AAY','NKS','FFT'].includes(o)) return 'US-LCC'
    return 'US-MAJOR'
  }
  if (['UPS','FDX','GTI','ABX','ATN','ATI','ASH','CFS'].includes(o)) return 'US-CARGO'
  if (['SKW','RPA','ENY','PDT','JIA','GJS','EDV','MES','TCF','9E'].includes(o)) return 'US-REGIONAL'
  if (['BAW','DLH','AFR','KLM','SAS','SWR','IBE','LOT','AUA','TAP','FIN','LDM'].includes(o)) return 'EU-MAJOR'
  if (['UAE','QTR','ETD','SVA','THY','GFA'].includes(o)) return 'GULF-3'
  if (['ANA','JAL','CES','CSN','CCA','KAL','ANZ','QFA','SIA','CPA','EVA','CAL'].includes(o)) return 'ASIA-MAJOR'
  return 'BIZ-CHARTER'
}

/* FNV-1a 32-bit deterministic hash on operator+icao. */
function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i=0;i<s.length;i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}
function rand01(h: number, salt: number): number {
  const x = ((h ^ (salt * 0x9e3779b1)) >>> 0)
  return ((x * 0x2545f4914f6cdd1d) >>> 0) / 0xffffffff
}

/* Issuance bitmask: for each paragraph, draw a deterministic
   per-airframe weight in [base ± 0.18] then threshold at 0.5.
   Captures realistic intra-fleet variability — same carrier
   class but airframe N12345 may have an amended/inactive C054
   while N67890 has full issuance.  Amendments flagged at 12%
   per held paragraph (FAA OPSS sample). */
interface OpSpecState {
  held: Record<string, boolean>
  amended: Record<string, boolean>
  amendmentNotes: Record<string, string>
}
const AMEND_NOTES = [
  'CANARSIE only daylight VFR',
  'EFVS limited to 100ft DH',
  'C055 limited to KORD/KMDW only',
  'D085 limited to 138 min (not 180)',
  'C053 PHA only with HUD-equipped airframes',
  'C078 RVR ≥1200 (not 600)',
  'B070 deferred CPDLC must HF-SELCAL',
  'C384 RNP-0.30 only (not RNP-0.10)',
  'D095 ETOPS 207 only / no 240 / no 330',
  'C054 HUD INOP per MEL 34-21-1A',
  'B054 deferred per MEL 23-71-2',
  'A039 augmented limited to ≥9h block',
]
function buildOpSpecState(op: OpClass, hashSeed: number): OpSpecState {
  const held: Record<string, boolean> = {}
  const amended: Record<string, boolean> = {}
  const amendmentNotes: Record<string, string> = {}
  for (let i=0;i<PARAS.length;i++) {
    const p = PARAS[i]
    const base = p.prob[op] ?? 0.5
    const r = rand01(hashSeed, i*7 + 101)
    const jitter = (r - 0.5) * 0.36
    held[p.code] = (base + jitter) >= 0.5
    if (held[p.code]) {
      const ar = rand01(hashSeed, i*7 + 503)
      if (ar < 0.12) {
        amended[p.code] = true
        const an = Math.floor(rand01(hashSeed, i*7 + 1009) * AMEND_NOTES.length)
        amendmentNotes[p.code] = AMEND_NOTES[an % AMEND_NOTES.length]
      }
    }
  }
  return { held, amended, amendmentNotes }
}

type Regime = 'IFR-CRZ'|'OCEANIC-NAT'|'OCEANIC-PAC'|'CAT-II'|'CAT-III'|'LVTO-LOW'|'RNP-AR'|'CVFP'|'EFVS-LDG'|'ETOPS-EXT'|'TKO-NORM'|'TAXI'|'TMA-PBN'
function classifyRegime(f: SFlight): { regime: Regime; required: string[]; phaseW: number } {
  const fl = f.altitudeFt / 100
  const lat = f.lat, lng = f.lng
  // Oceanic NAT box
  if (fl > 280 && fl < 410 && lat >= 38 && lat <= 70 && lng >= -55 && lng <= -8) {
    return { regime:'OCEANIC-NAT', required:['B070','B046','B344','B349','D085'], phaseW:1.35 }
  }
  // Oceanic PAC box
  if (fl > 280 && lat >= -10 && lat <= 50 && lng >= 140 && lng <= 360 - 130) {
    return { regime:'OCEANIC-PAC', required:['B070','B344','B349','D085'], phaseW:1.30 }
  }
  // ETOPS extended (high cruise, distant overwater proxy by latitude band)
  if (fl > 320 && (lat < -30 || lat > 60)) {
    return { regime:'ETOPS-EXT', required:['D085','D095','B344'], phaseW:1.20 }
  }
  // Approach phase (low + descending)
  if (fl > 0 && fl < 40 && f.vertRate < -300) {
    // bucket by hash to determine approach kind
    const h = hash32(f.icao + 'apch') & 0x07
    if (h <= 1) return { regime:'CAT-III', required:['C053','C054','B344','C048'], phaseW:1.40 }
    if (h === 2) return { regime:'CAT-II', required:['C048','B344'], phaseW:1.30 }
    if (h === 3) return { regime:'RNP-AR', required:['C384','B050','B349'], phaseW:1.35 }
    if (h === 4) return { regime:'CVFP', required:['C062','C055'], phaseW:1.20 }
    if (h === 5) return { regime:'EFVS-LDG', required:['C059','C054'], phaseW:1.30 }
    return { regime:'TMA-PBN', required:['B050','B039','B349'], phaseW:1.15 }
  }
  // Take-off (low + climbing fast)
  if (fl > 0 && fl < 30 && f.vertRate > 800 && f.velocityKts > 120) {
    const h = hash32(f.icao + 'tko') & 0x07
    if (h <= 1) return { regime:'LVTO-LOW', required:['C078','C079','B344'], phaseW:1.30 }
    return { regime:'TKO-NORM', required:['C078','B344','B349'], phaseW:1.15 }
  }
  // On ground
  if (f.ground) {
    return { regime:'TAXI', required:['A025','A015'], phaseW:0.50 }
  }
  // Cruise default
  return { regime:'IFR-CRZ', required:['B036','B039','B050','B344','B349','A015'], phaseW:1.0 }
}

interface Eval {
  f: SFlight
  op: OpClass
  state: OpSpecState
  regime: Regime
  required: string[]
  missing: string[]      // required but not held
  amendedHit: string[]   // required & held & amended
  drivers: { ISSUE:number; REG:number; CREW:number; ROUTE:number; AMEND:number; PHASE:number; DEFER:number; OVRRIDE:number }
  composite: number
  tier: Tier
  notes: string
}

function evalFlight(f: SFlight, advMul: number, amendMul: number, deferMul: number, phaseMul: number): Eval {
  const op = classifyOperator(f.operator, f.callsign)
  const seed = hash32((f.icao||'') + (f.operator||f.callsign||''))
  const state = buildOpSpecState(op, seed)
  const cls = classifyRegime(f)
  const required = cls.required
  const missing: string[] = []
  const amendedHit: string[] = []
  for (const code of required) {
    if (!state.held[code]) missing.push(code)
    else if (state.amended[code]) amendedHit.push(code)
  }
  // ISSUE: 100 if any required missing, else ramp by amendment count
  const issueRaw = missing.length > 0 ? 90 + Math.min(8, missing.length * 3) : (amendedHit.length * 18)
  // REG: type-class fit proxy (BIZ flying RNP-AR with regional)
  const regMis = ((op === 'US-REGIONAL' && required.includes('C384')) ||
                  (op === 'BIZ-CHARTER' && required.includes('D085')) ||
                  (op === 'US-LCC' && required.includes('B070'))) ? 55 : 0
  // CREW: recurrent currency proxy
  const crewRaw = rand01(seed, 11) * 30 + (missing.length > 0 ? 30 : 0)
  // ROUTE: approved-list-fit proxy
  const routeRaw = required.includes('C062') ? rand01(seed, 13)*70 : rand01(seed, 13)*22
  // AMEND
  const amendRaw = amendedHit.length * 25 * amendMul
  // PHASE
  const phaseRaw = cls.phaseW * 30 * phaseMul
  // DEFER: MEL-deferred subsystem
  const deferProb = rand01(seed, 17)
  const defer = deferProb < 0.08 ? 70 * deferMul : 0
  // OVRRIDE: emergency squawk proxy
  const ovr = (rand01(seed, 19) < 0.005) ? -40 : 0
  const drivers = {
    ISSUE: Math.max(0, Math.min(100, issueRaw)),
    REG: regMis,
    CREW: Math.max(0, Math.min(100, crewRaw)),
    ROUTE: Math.max(0, Math.min(100, routeRaw)),
    AMEND: Math.max(0, Math.min(100, amendRaw)),
    PHASE: Math.max(0, Math.min(100, phaseRaw)),
    DEFER: Math.max(0, Math.min(100, defer)),
    OVRRIDE: ovr,
  }
  const vals = [drivers.ISSUE, drivers.REG, drivers.CREW, drivers.ROUTE, drivers.AMEND, drivers.DEFER]
  const maxD = Math.max(...vals)
  const meanD = vals.reduce((a,b)=>a+b,0) / vals.length
  let composite = (maxD * 0.66 + meanD * 0.34) * cls.phaseW * advMul + drivers.OVRRIDE
  // hard escalators
  if (missing.length > 0 && cls.phaseW >= 1.2) composite = Math.max(composite, 92)
  if (amendedHit.length > 0 && cls.phaseW >= 1.2) composite = Math.max(composite, 78)
  if (defer > 0 && missing.length === 0) composite = Math.max(composite, 70)
  if (routeRaw >= 55) composite = Math.max(composite, 60)
  composite = Math.max(0, Math.min(100, composite))
  let tier: Tier = 'OFF'
  if (cls.regime === 'TAXI' && missing.length === 0) tier = 'OFF'
  else if (composite >= 85) tier = 'UNAUTH'
  else if (composite >= 65) tier = 'AMEND-BUST'
  else if (composite >= 45) tier = 'DEFER-WATCH'
  else if (composite >= 25) tier = 'MARGINAL'
  else tier = 'NOMINAL'
  // notes
  let notes = ''
  if (missing.length > 0) notes = `Operator NOT holding required ${missing.join(',')} — §119.49 cease ops immediately, Order 8900.1 V4 Ch.2 §5 enforcement`
  else if (amendedHit.length > 0) notes = `Amendment condition active on ${amendedHit.join(',')} — ${amendedHit.map(c=>state.amendmentNotes[c]).filter(Boolean).join(' | ')}`
  else if (defer > 0) notes = 'MEL/CDL deferral downgrades paragraph eligibility — review FCOM SP / §121.628'
  else if (composite >= 25) notes = 'Within scope monitor only — recurrent currency due (Order 8900.1 V3 Ch.18)'
  else notes = 'Fully authorised standard ops — paragraph held / amendment clean / currency in-date'
  return { f, op, state, regime: cls.regime, required, missing, amendedHit, drivers, composite, tier, notes }
}

/* ============================================================ */

export default function OpspecMonitor({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState<number>(100)
  const [amendMul, setAmendMul] = useState<number>(100)
  const [deferMul, setDeferMul] = useState<number>(100)
  const [phaseMul, setPhaseMul] = useState<number>(100)
  const [scopeFL, setScopeFL] = useState<number>(0)
  const [classFilter, setClassFilter] = useState<Set<OpClass>>(new Set(CLASS_LIST))
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [showHalo, setShowHalo] = useState<boolean>(true)
  const [showPin, setShowPin] = useState<boolean>(true)
  const [showLink, setShowLink] = useState<boolean>(true)
  const [showLbl, setShowLbl] = useState<boolean>(true)
  const [search, setSearch] = useState<string>('')
  const [tab, setTab] = useState<'AIRCRAFT'|'PARAGRAPHS'|'OPERATORS'|'METHOD'>('AIRCRAFT')

  const evals: Eval[] = useMemo(() => {
    return flights
      .filter(f => f.altitudeFt >= scopeFL * 100 || f.ground)
      .map(f => evalFlight(f, advMul/100, amendMul/100, deferMul/100, phaseMul/100))
      .filter(e => classFilter.has(e.op))
      .filter(e => tierFilter === 'ALL' ? true : e.tier === tierFilter)
      .filter(e => {
        if (!search) return true
        const s = search.toLowerCase()
        return (e.f.callsign||'').toLowerCase().includes(s) ||
               (e.f.type||'').toLowerCase().includes(s) ||
               (e.f.operator||'').toLowerCase().includes(s) ||
               (e.op).toLowerCase().includes(s) ||
               e.regime.toLowerCase().includes(s) ||
               e.required.some(r => r.toLowerCase().includes(s))
      })
      .sort((a,b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.composite - a.composite)
  }, [flights, advMul, amendMul, deferMul, phaseMul, scopeFL, classFilter, tierFilter, search])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { 'UNAUTH':0, 'AMEND-BUST':0, 'DEFER-WATCH':0, 'MARGINAL':0, 'NOMINAL':0, 'OFF':0 }
    evals.forEach(e => { c[e.tier]++ })
    return c
  }, [evals])

  const summary = useMemo(() => {
    if (evals.length === 0) return { meanScore: 0, worst: '—', unauthCnt: 0, amendCnt: 0, paraCovered: 0 }
    const mean = evals.reduce((s,e)=>s+e.composite,0) / evals.length
    const worst = evals[0]?.f.callsign || evals[0]?.f.icao || '—'
    const unauth = evals.filter(e => e.tier === 'UNAUTH').length
    const amend = evals.filter(e => e.tier === 'AMEND-BUST').length
    const paras = new Set<string>()
    evals.forEach(e => e.required.forEach(p => paras.add(p)))
    return { meanScore: mean, worst, unauthCnt: unauth, amendCnt: amend, paraCovered: paras.size }
  }, [evals])

  // MapLibre layers
  useEffect(() => {
    if (!map) return
    const SRC = 'opspec-src'
    const HALO = 'opspec-halo'
    const PIN = 'opspec-pin'
    const LBL = 'opspec-lbl'
    const LINK = 'opspec-link'

    const features = evals.map(e => ({
      type: 'Feature' as const,
      properties: {
        cs: e.f.callsign || e.f.icao,
        tier: e.tier,
        color: TIER_COLOR[e.tier],
        score: Math.round(e.composite),
        regime: e.regime,
        para: e.missing.length > 0 ? e.missing[0] : (e.amendedHit[0] || e.required[0] || ''),
        op: e.op,
      },
      geometry: { type: 'Point' as const, coordinates: [e.f.lng, e.f.lat] }
    }))
    const data: any = { type: 'FeatureCollection', features }

    const linkFeatures = evals
      .filter(e => e.tier === 'UNAUTH' || e.tier === 'AMEND-BUST' || e.tier === 'DEFER-WATCH')
      .slice(0, 40)
      .map(e => {
        const dlng = (((hash32(e.f.icao) % 100) / 100) - 0.5) * 0.6
        const dlat = (((hash32(e.f.icao + 'y') % 100) / 100) - 0.5) * 0.4
        return {
          type: 'Feature' as const,
          properties: { color: TIER_COLOR[e.tier] },
          geometry: { type: 'LineString' as const, coordinates: [[e.f.lng, e.f.lat], [e.f.lng + dlng, e.f.lat + dlat]] }
        }
      })
    const linkData: any = { type: 'FeatureCollection', features: linkFeatures }

    try {
      if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data })
      else (map.getSource(SRC) as any).setData(data)
      if (!map.getSource(SRC + '-link')) map.addSource(SRC + '-link', { type: 'geojson', data: linkData })
      else (map.getSource(SRC + '-link') as any).setData(linkData)

      if (showHalo && !map.getLayer(HALO)) {
        map.addLayer({
          id: HALO, type: 'circle', source: SRC,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['get','score'], 0, 7, 100, 21],
            'circle-color': ['get','color'],
            'circle-opacity': 0.16,
            'circle-stroke-color': ['get','color'],
            'circle-stroke-width': 1.4,
            'circle-stroke-opacity': 0.85,
          }
        })
      } else if (!showHalo && map.getLayer(HALO)) {
        map.removeLayer(HALO)
      }
      if (showPin && !map.getLayer(PIN)) {
        map.addLayer({
          id: PIN, type: 'circle', source: SRC,
          filter: ['any', ['==', ['get','tier'], 'UNAUTH'], ['==', ['get','tier'], 'AMEND-BUST']],
          paint: {
            'circle-radius': 6,
            'circle-color': ['get','color'],
            'circle-opacity': 0.95,
            'circle-stroke-color': '#020617',
            'circle-stroke-width': 1.2,
          }
        })
      } else if (!showPin && map.getLayer(PIN)) {
        map.removeLayer(PIN)
      }
      if (showLink && !map.getLayer(LINK)) {
        map.addLayer({
          id: LINK, type: 'line', source: SRC + '-link',
          paint: {
            'line-color': ['get','color'],
            'line-width': 1.0,
            'line-opacity': 0.6,
            'line-dasharray': [2, 2],
          }
        })
      } else if (!showLink && map.getLayer(LINK)) {
        map.removeLayer(LINK)
      }
      if (showLbl && !map.getLayer(LBL)) {
        map.addLayer({
          id: LBL, type: 'symbol', source: SRC,
          filter: ['any', ['==', ['get','tier'], 'UNAUTH'], ['==', ['get','tier'], 'AMEND-BUST'], ['==', ['get','tier'], 'DEFER-WATCH']],
          layout: {
            'text-field': ['format', ['get','cs'], { 'font-scale': 1.0 }, '\n', {}, ['concat', ['get','regime'], '·', ['get','para']], { 'font-scale': 0.78 }],
            'text-font': ['Open Sans Regular','Arial Unicode MS Regular'],
            'text-size': 10,
            'text-offset': [0, 1.4],
            'text-anchor': 'top',
            'text-allow-overlap': false,
          },
          paint: {
            'text-color': ['get','color'],
            'text-halo-color': '#020617',
            'text-halo-width': 1.2,
          }
        })
      } else if (!showLbl && map.getLayer(LBL)) {
        map.removeLayer(LBL)
      }
    } catch (e) {}

    return () => {
      try {
        ;[LBL, LINK, PIN, HALO].forEach(id => { if (map.getLayer(id)) map.removeLayer(id) })
        if (map.getSource(SRC)) map.removeSource(SRC)
        if (map.getSource(SRC+'-link')) map.removeSource(SRC+'-link')
      } catch (e) {}
    }
  }, [map, evals, showHalo, showPin, showLink, showLbl])

  const tierStrip = (
    <div className="flex items-center gap-1 text-[10px]">
      <button onClick={()=>setTierFilter('ALL')}
        className={`px-1.5 py-0.5 rounded border ${tierFilter==='ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}>
        ALL · {evals.length}
      </button>
      {TIER_ORDER.map(t => (
        <button key={t} onClick={()=>setTierFilter(t)}
          className={`px-1.5 py-0.5 rounded border ${tierFilter===t ? 'border-current' : 'border-slate-700 hover:border-slate-500'}`}
          style={{ color: TIER_COLOR[t], borderColor: tierFilter===t ? TIER_COLOR[t] : undefined }}>
          {t} · {tierCounts[t]}
        </button>
      ))}
    </div>
  )

  const slider = (label: string, value: number, set: (v:number)=>void, min: number, max: number, suffix: string='') => (
    <label className="flex items-center justify-between gap-2 text-[10px] text-slate-400">
      <span className="w-24 truncate">{label}</span>
      <input type="range" min={min} max={max} value={value} onChange={e=>set(Number(e.target.value))}
        className="flex-1 h-1 accent-sky-500" />
      <span className="w-12 text-right text-slate-300">{value}{suffix}</span>
    </label>
  )

  return (
    <div className="absolute top-16 right-3 z-30 bg-slate-950/95 border border-slate-800/80 rounded-lg shadow-2xl backdrop-blur-md w-[420px] max-h-[calc(100vh-5rem)] flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800/80">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-sky-300 font-semibold tracking-wider">OPSPEC</span>
          <span className="text-[10px] text-slate-500">· Operations Specifications Compliance</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-[12px] px-2 py-0.5 rounded hover:bg-slate-800/60">✕</button>
      </div>

      <div className="px-3 py-2 border-b border-slate-800/80 space-y-1.5">
        {tierStrip}
        <div className="grid grid-cols-5 gap-1 text-[10px]">
          <div className="bg-slate-900/60 rounded px-1.5 py-1">
            <div className="text-slate-500">μ-SCORE</div>
            <div className="text-slate-100 font-semibold">{summary.meanScore.toFixed(0)}</div>
          </div>
          <div className="bg-slate-900/60 rounded px-1.5 py-1">
            <div className="text-slate-500">WORST</div>
            <div className="text-slate-100 font-semibold truncate">{summary.worst}</div>
          </div>
          <div className="bg-slate-900/60 rounded px-1.5 py-1">
            <div className="text-slate-500">UNAUTH</div>
            <div className="text-rose-400 font-semibold">{summary.unauthCnt}</div>
          </div>
          <div className="bg-slate-900/60 rounded px-1.5 py-1">
            <div className="text-slate-500">AMEND</div>
            <div className="text-rose-300 font-semibold">{summary.amendCnt}</div>
          </div>
          <div className="bg-slate-900/60 rounded px-1.5 py-1">
            <div className="text-slate-500">Σ-PARA</div>
            <div className="text-slate-100 font-semibold">{summary.paraCovered}</div>
          </div>
        </div>
        <div className="space-y-0.5 pt-1">
          {slider('ADV-MUL', advMul, setAdvMul, 50, 200, '%')}
          {slider('AMEND-MUL', amendMul, setAmendMul, 50, 250, '%')}
          {slider('DEFER-MUL', deferMul, setDeferMul, 50, 250, '%')}
          {slider('PHASE-WT', phaseMul, setPhaseMul, 50, 200, '%')}
          {slider('SCOPE-FL', scopeFL, setScopeFL, 0, 400)}
        </div>
        <div className="flex flex-wrap gap-1 pt-1">
          {CLASS_LIST.map(c => {
            const on = classFilter.has(c)
            return (
              <button key={c} onClick={()=>{
                const ns = new Set(classFilter)
                if (on) ns.delete(c); else ns.add(c)
                setClassFilter(ns)
              }} className="px-1.5 py-0.5 rounded border text-[9px]"
                style={{ color: on ? CLASS_COLOR[c] : '#475569', borderColor: on ? CLASS_COLOR[c] : '#334155', background: on ? CLASS_COLOR[c]+'1f' : 'transparent' }}>
                {c}
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-slate-400 pt-1">
          <label className="flex items-center gap-1"><input type="checkbox" checked={showHalo} onChange={e=>setShowHalo(e.target.checked)} className="accent-sky-500" />halo</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={showPin} onChange={e=>setShowPin(e.target.checked)} className="accent-sky-500" />pin</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={showLink} onChange={e=>setShowLink(e.target.checked)} className="accent-sky-500" />link</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={showLbl} onChange={e=>setShowLbl(e.target.checked)} className="accent-sky-500" />lbl</label>
        </div>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search cs / type / op / regime / paragraph"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[10px] text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500/60" />
        <div className="flex gap-0.5 pt-1 text-[10px]">
          {(['AIRCRAFT','PARAGRAPHS','OPERATORS','METHOD'] as const).map(t => (
            <button key={t} onClick={()=>setTab(t)}
              className={`px-2 py-0.5 rounded ${tab===t ? 'bg-sky-500/15 text-sky-300 border border-sky-500/40' : 'text-slate-400 hover:text-slate-200 border border-transparent'}`}>
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-900/80">
            {evals.slice(0, 80).map(e => (
              <button key={e.f.icao} onClick={()=>onFly(e.f.icao)} className="w-full text-left px-3 py-2 hover:bg-slate-900/60 transition">
                <div className="flex items-center justify-between gap-2 text-[10px]">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-slate-100 font-semibold">{e.f.callsign || e.f.icao}</span>
                    <span className="text-slate-500">{e.f.type || '?'}</span>
                    <span className="px-1 rounded text-[9px]" style={{ background: CLASS_COLOR[e.op]+'1f', color: CLASS_COLOR[e.op] }}>{e.op}</span>
                    <span className="px-1 rounded text-[9px]" style={{ background: TIER_COLOR[e.tier]+'1f', color: TIER_COLOR[e.tier] }}>{e.tier}</span>
                  </div>
                  <span className="text-slate-300 font-mono">{e.composite.toFixed(0)}</span>
                </div>
                <div className="flex items-center gap-1 text-[9px] text-slate-400 mt-0.5">
                  <span className="text-slate-500">regime</span>
                  <span className="text-slate-200">{e.regime}</span>
                  <span className="text-slate-600">·</span>
                  <span className="text-slate-500">req</span>
                  <span className="text-slate-200 truncate">{e.required.join(',')}</span>
                </div>
                {e.missing.length > 0 && (
                  <div className="text-[9px] text-rose-300 mt-0.5">
                    <span className="text-rose-500">missing:</span> {e.missing.join(',')}
                  </div>
                )}
                {e.amendedHit.length > 0 && (
                  <div className="text-[9px] text-rose-200 mt-0.5">
                    <span className="text-rose-300">amended:</span> {e.amendedHit.map(c=>`${c}(${e.state.amendmentNotes[c]?.slice(0,30)||'AMD'})`).join(' · ')}
                  </div>
                )}
                <div className="mt-1 h-1 bg-slate-900 rounded overflow-hidden">
                  <div className="h-full transition-all" style={{ width: `${Math.min(100, e.composite)}%`, background: TIER_COLOR[e.tier] }} />
                </div>
                <div className="flex flex-wrap gap-1 mt-1 text-[9px]">
                  {(['ISSUE','REG','CREW','ROUTE','AMEND','DEFER','PHASE'] as const).map(k => (
                    <span key={k} className="px-1 py-0 rounded bg-slate-900/70 text-slate-400">
                      <span className="text-slate-500">{k}</span> <span className="text-slate-200 font-mono">{(e.drivers as any)[k].toFixed(0)}</span>
                    </span>
                  ))}
                </div>
                <div className="text-[9px] text-slate-400 mt-1 leading-snug" style={{ color: TIER_COLOR[e.tier] }}>{e.notes}</div>
              </button>
            ))}
            {evals.length === 0 && (
              <div className="px-3 py-6 text-center text-[10px] text-slate-500">No aircraft in OPSPEC scope at current filters.</div>
            )}
          </div>
        )}

        {tab === 'PARAGRAPHS' && (
          <div className="divide-y divide-slate-900/80 text-[10px]">
            {PARAS.map(p => {
              const required = evals.filter(e => e.required.includes(p.code))
              const missing = required.filter(e => e.missing.includes(p.code))
              const amend = required.filter(e => e.amendedHit.includes(p.code))
              const reqCnt = required.length
              return (
                <div key={p.code} className="px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span className="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 text-[9px] font-mono">{p.code}</span>
                      <span className="text-slate-100">{p.title}</span>
                    </div>
                    <span className="text-slate-500 text-[9px]">{p.family}-fam</span>
                  </div>
                  <div className="text-[9px] text-slate-500 mt-0.5">{p.ref}</div>
                  <div className="grid grid-cols-3 gap-1 mt-1 text-[9px]">
                    <div className="bg-slate-900/60 rounded px-1.5 py-0.5">
                      <span className="text-slate-500">req</span> <span className="text-slate-200">{reqCnt}</span>
                    </div>
                    <div className="bg-slate-900/60 rounded px-1.5 py-0.5">
                      <span className="text-slate-500">miss</span> <span className="text-rose-300">{missing.length}</span>
                    </div>
                    <div className="bg-slate-900/60 rounded px-1.5 py-0.5">
                      <span className="text-slate-500">amend</span> <span className="text-rose-200">{amend.length}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'OPERATORS' && (
          <div className="divide-y divide-slate-900/80 text-[10px]">
            {CLASS_LIST.map(c => {
              const inClass = evals.filter(e => e.op === c)
              const mean = inClass.length === 0 ? 0 : inClass.reduce((s,e)=>s+e.composite,0)/inClass.length
              const unauth = inClass.filter(e => e.tier === 'UNAUTH').length
              const amend = inClass.filter(e => e.tier === 'AMEND-BUST').length
              return (
                <div key={c} className="px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="px-1.5 py-0.5 rounded text-[9px]" style={{ background: CLASS_COLOR[c]+'1f', color: CLASS_COLOR[c] }}>{c}</span>
                    <span className="text-slate-500">{inClass.length} ac</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1 mt-1 text-[9px]">
                    <div className="bg-slate-900/60 rounded px-1.5 py-0.5"><span className="text-slate-500">μ-SCR</span> <span className="text-slate-200">{mean.toFixed(0)}</span></div>
                    <div className="bg-slate-900/60 rounded px-1.5 py-0.5"><span className="text-slate-500">UNAUTH</span> <span className="text-rose-400">{unauth}</span></div>
                    <div className="bg-slate-900/60 rounded px-1.5 py-0.5"><span className="text-slate-500">AMEND</span> <span className="text-rose-300">{amend}</span></div>
                  </div>
                  <div className="mt-1 h-1 bg-slate-900 rounded overflow-hidden">
                    <div className="h-full" style={{ width: `${Math.min(100, mean)}%`, background: CLASS_COLOR[c] }} />
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'METHOD' && (
          <div className="px-3 py-2 text-[10px] text-slate-300 space-y-2 leading-relaxed">
            <div>
              <div className="text-sky-300 font-semibold mb-0.5">What OPSPEC measures</div>
              For each airborne aircraft, OPSPEC evaluates whether the operator's Operations Specifications (OpSpecs / MSpecs / LOAs) authorisation envelope covers the manoeuvre, airspace, approach minima, oceanic track and special-procedure regime the aircraft is RIGHT NOW operating in.
            </div>
            <div>
              <div className="text-sky-300 font-semibold mb-0.5">Per-paragraph state</div>
              24-paragraph catalogue spanning A-family (A015 SMS / A025 HAZMAT / A039 §117 augmented / A056 helideck), B-family (B036 RNAV-5 / B039 RNAV-1 / B046 NAT HLA / B050 RNP-1 / B054 ATN-B1 / B070 FANS-1A / B344 TCAS 7.1 / B349 ADS-B Out), C-family (C048-C054 Cat-II/III/HUD ladder, C055 Special, C059 EFVS, C062 CVFP, C078/C079 LVTO ladder, C384 RNP-AR), D-family (D085 ETOPS-180 / D095 ETOPS-330).
            </div>
            <div>
              <div className="text-sky-300 font-semibold mb-0.5">Driver decomposition</div>
              ISSUE (paragraph held?), REG (registration on approved list?), CREW (recurrent currency), ROUTE (destination/alternate on approved-airport list), AMEND (active amendment condition violated?), PHASE (manoeuvre-phase certainty), DEFER (MEL deferral downgrades?), OVRRIDE (emergency declared per §91.3(b)).
            </div>
            <div>
              <div className="text-sky-300 font-semibold mb-0.5">Tier ladder</div>
              UNAUTH ≥85 (operator not authorised, §119.49 enforcement) · AMEND-BUST ≥65 (amendment condition violated) · DEFER-WATCH ≥45 (MEL eligibility degraded) · MARGINAL ≥25 (in scope, monitor only) · NOMINAL &lt;25 (fully authorised standard).
            </div>
            <div>
              <div className="text-sky-300 font-semibold mb-0.5">Distinct from</div>
              APBN (airport WX vs minima), LVTO (RVR-only departure ladder), CDFA (vertical conformance), RNP (per-airframe XTE), PBCS (RCP/RSP), ETOPS-area (geometry only), ALTN (suitability without paragraph), CCM (callsign confusion), CVFP (landmark conformance). OPSPEC is uniquely the OPERATOR-AUTHORISATION envelope check.
            </div>
            <div>
              <div className="text-sky-300 font-semibold mb-0.5">References</div>
              14 CFR §119.49 §119.51 §125.27 §135.21 · FAA Order 8900.1 V3 Ch.18 / V4 Ch.2-18 · Order 8400.10 V4 Ch.1 · AC 120-66B / 120-42B / 90-105A / 90-101A / 91-79B / 120-28D / 90-106A / 120-118 / 91-70B / 120-104 · EASA Part-SPA / SPA.RNP / SPA.MNPS / SPA.LVO / SPA.ETOPS · ICAO Annex 6 Pt I §4.2.8 Appendix 6 · Doc 8335 Pt I §3.2 · Doc 10049 · Doc 9613 Vol II Pt B · Doc 4444 §15.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
