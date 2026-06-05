'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   HZMT · Dangerous-Goods Cargo Carriage Compliance, Lithium-
         Ion Battery State-of-Charge, Hazard-Class Segregation
         Conflict & NOTOC (Notification-to-Captain) Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of declared dangerous-goods (DG)
   cargo carried under the ICAO Technical Instructions /
   IATA DGR / 49 CFR Part 175 regime, scoring:

     • Whether the airframe's operator holds the DG approval
       required for the declared UN-numbered articles & their
       packing-group classification (PAX-CAO vs CAO-only).
     • Whether the loaded HAZARD-CLASS portfolio violates the
       IATA DGR 9.3 / 49 CFR 175.78 segregation matrix (e.g.,
       Class-1 Explosives vs Class-5.1 Oxidisers; Class-4.2
       spontaneously-combustible vs Class-2.3 toxic gas; UN3480
       PI-965 lithium-ion vs Class-9 magnetised material).
     • The aggregate lithium-ion state-of-charge (SoC) cap:
       UN3480 PI-965 Sec.IA/IB cells limited to ≤ 30 % SoC
       per ICAO Addendum 4 (effective 2016-04-01, mandated
       post UPS-6 Dubai 28-Aug-2010 thermal runaway / Asiana-991
       Jeju 28-Jul-2011 / NTSB AAR-14-01 / GCAA Air Accident
       Investigation Report 13/2010).
     • DRY-ICE (UN1845) per-compartment kg-limit (200 kg/comp
       Class-C / 100 kg Class-D) and CO₂ sublimation rate vs
       compartment Air-Quality Standard CO₂ ≤ 0.5 % per FAR
       25.831 (NTSB AAB-94-04 KAL-cargo Dry-ice asphyxiation).
     • RADIOACTIVE-MATERIAL (Class-7) Transport-Index (TI)
       summation vs aircraft TI≤50 PAX-flight / TI≤200 CAO
       cap per IAEA SSR-6 §572 / 49 CFR 175.703.
     • NOTOC issuance & in-cockpit acknowledgement compliance
       per IATA DGR 9.5 (captain MUST be notified of all DG
       above ER thresholds before doors close — failure was a
       contributing factor in UPS-6 mishap response delay).
     • CAO-ONLY flag enforcement: many UN-numbered articles
       (e.g., UN3090 Lithium-Metal Bulk, UN1942 ammonium-
       nitrate explosive, UN0454) are forbidden on passenger
       aircraft (Forbidden-PAX cell of DGR 4.2 List).

   Standards & precedent:
     · ICAO Doc 9284-AN/905 Technical Instructions for the
            Safe Transport of Dangerous Goods by Air ed.2025-26
     · ICAO Annex 18 Safe Transport of Dangerous Goods by Air
     · ICAO Addendum 4 (2016) lithium-ion ≤30 % SoC + Sec.IA/IB
            CAO-only mandate / Addendum 5 (2024) UN3556/3557/3558
     · IATA DGR ed.66 2025 §3 Classification / §4 List of DG /
            §7 Marking & Labelling / §9 Handling / §10 Radioactive
            Material (TI/CSI) / §11 Radioactive Material
     · 49 CFR Part 173 Shippers — General Requirements
     · 49 CFR Part 175 Carriage by Aircraft (§175.78 segregation
            matrix / §175.310 emergency response / §175.703 RAM)
     · 49 CFR Part 175 App.A Emergency Response Guide / §175.900
     · FAA Order 8000.95 chapter 17 DG inspections
     · FAA AC 121-22C ETOPS App.I-3 cargo halon (DG-fire link)
     · FAA AC 120-80B In-Flight Fires (li-cargo precedent)
     · FAA InFO 17013 Lithium Battery Fire Hazards
     · FAA InFO 19012 / 20003 PED & spare-battery rule
     · EASA Part-CAT.GEN.MPA.200 / Part-SPA.DG / AMC1-CAT.GEN.MPA
            .200(b) / GM1 CAT.GEN.MPA.200 NOTOC / DG approval
     · EASA SIB 2020-19 Lithium Battery Carriage by Air
     · UK CAA CAP 1379 DG Operator Approval
     · TC Canadian Aviation Regulations Std 725.123 DG operator
     · CASA CAR 1988 §92 DG / IATA DGR Australia
     · UN Model Regulations (Orange Book) ed.23 2023
     · UN Manual of Tests & Criteria Pt III §38.3 lithium cells
     · IAEA SSR-6 Rev.1 (2018) Regs Safe Transport RAM / TI
     · NFPA 12A Halon-1301 (li-cargo suppression knockdown)
     · NTSB AAR-98-03 ValuJet 592 KMIA 11-May-1996 — improperly
            packaged chemical oxygen generators (Class-5.1 ORM-A)
            in cargo hold C; triggered the cargo-Class-D ban,
            CAO-only re-classification of chemical O2 generators,
            mandatory Class-C / fire-protected detection retrofit.
            Direct regulatory predecessor of modern DG framework.
     · GCAA AAI 13/2010 UPS-6 / N571UP B747-400F OMDB 03-Sep-2010
            — lithium-ion cargo thermal runaway, in-flight fire,
            crew incapacitation, hull loss. Drove ICAO Addendum 4
            ≤30 % SoC + ban on bulk lithium-ion PAX carriage.
     · KARAIB AAB-2011-01 Asiana 991 HL7604 B744F Jeju 28-Jul-2011
            — lithium-ion + flammable-liquid cargo class-conflict
            (DGR 9.3 segregation) ignition. Drove tighter
            UN3480 / Class-3 / Class-9 segregation enforcement.
     · NTSB DCA13RA075 FedEx LX1602 HFX li-cargo precedent
     · ATSB AO-2020-019 lithium PED in checked baggage smoke
     · ICAO Doc 9481-AN/928 Emergency Response Guidance for
            Aircraft Incidents Involving Dangerous Goods
     · IATA DGR 9.5 NOTOC content + delivery + acknowledge
     · IATA Lithium Battery Risk Mitigation Guide ed.7 2024
     · PHMSA 49 CFR 173.185 Lithium Cells & Batteries
     · DOT/FAA Tech Center DOT/FAA/AR-09/41 li-cargo fire test
     · FAA TC SMOKE & FIRE Working Group Report 2018
     · ICAO Doc 10100 DG Operator Approval Manual

   DISTINCT FROM SIBLING SUBSYSTEMS:
     · LIBAT (lithium-ion battery thermal-runaway in-flight
       suppression hardware / Halon-1301 efficacy)
     · CARGOFS (Class-C / Class-D / Class-E compartment fire-
       suppression endurance + ETOPS DTLD compliance)
     · FIRELOOP (engine + APU + cargo fire-detection loop A/B
       integrity / ARINC 429 lbl 270)
     · CSFF (centre-section fuel-tank flammability / nitrogen
       inerting per AC 25.981-2C SFAR-88)
     · PAXO2 (cabin emergency descent oxygen mask MTBO/duration)
     · OWL (overweight-landing / fuel-jettison gross-weight
       margin)
     · MEL (Minimum Equipment List deferral compliance)

   HZMT is uniquely the SHIPPER-LOADED MANIFEST DECLARATION-
   COMPLIANCE LAYER — does the airframe legally hold what the
   ULD-loaded manifest says it's carrying, are class-conflicts
   absent, is the lithium-ion SoC cap satisfied, has the NOTOC
   been delivered, are PAX-forbidden articles segregated to a
   CAO frame, are Class-7 TI/CSI sums within aircraft limits.

   Algorithm (deterministic, no live API dependence — synthetic
   manifest generator anchored to ICAO24+route-pair hash):

     1) Per-airframe ICAO24 FNV-1a 32-bit hash seeds a
        deterministic synthetic dangerous-goods manifest with
        0-6 declared UN-numbered articles drawn from a 40-entry
        catalogue weighted by carrier-type:
           CAO-only freighters (B748F / B777F / A332F / 757F):
             4-6 articles, 25 % include forbidden-PAX entries,
             40 % include lithium-ion bulk PI-965 Sec.IA/IB.
           PAX-carrying widebody / narrowbody:
             1-3 articles, only ER-acceptable PAX-permitted,
             10 % include lithium-ion (PI-967 Sec.II ≤30 % SoC
             only — PI-965 Sec.IA/IB forbidden on PAX flights).
           Regional jet / turboprop:
             0-2 articles, mostly Sec.II PI-967/970 small li-ion.
           Business / GA / military: 0-1 article.

     2) Per article: lookup UN-number → DGR-class, packing-group,
        ER-code, PI (Packing-Instruction), forbidden-PAX flag,
        special-load NOTOC mandate, segregation-matrix row.
        Aggregate the loaded portfolio.

     3) Build the conflict score against IATA DGR 9.3 / 49 CFR
        175.78 segregation matrix (12×12 hazard-class grid).
        Each present-pair lookup returns one of:
           ALLOWED            (cell = ✓)
           SEPARATED          (must be ≥0.6 m apart in same hold)
           HOLDS-APART        (must be in different holds)
           FORBIDDEN-TOGETHER (cannot be carried on same flight)
        Conflicts contribute to SEG driver score.

     4) Sum lithium-ion cell capacity (Wh) and weighted SoC.
        UN3480 PI-965 Sec.IA bulk-cells > 100 Wh: SoC must be
        ≤30 % (ICAO Add.4 2016). Sec.IB ≤100 Wh same cap.
        UN3481 PI-966/967 contained-in / packed-with equipment
        is exempt from SoC cap but subject to mass limit.
        Compute SoC-CAP-VIOLATION ratio.

     5) Sum Class-7 Transport-Index (TI) for radioactive items.
        Compare vs aircraft cap: TI ≤ 50 PAX / TI ≤ 200 CAO
        per IAEA SSR-6 §572 + 49 CFR 175.703. RAM driver.

     6) Sum dry-ice (UN1845) kg per compartment vs 200 kg
        Class-C / 100 kg Class-D compartment cap per IATA DGR
        9.4 + carrier limitations. Driver DICE.

     7) Forbidden-PAX articles loaded on PAX-flight → hard
        escalator (FBN-PAX driver, ESC-MIN = 95, immediate
        unload + amended NOTOC required, ramp-stop violation
        per 49 CFR 171.16 / IATA DGR 1.2).

     8) NOTOC compliance: deterministic 6 % of flights have
        the NOTOC drafted but not delivered to PIC (NOTOC driver).
        Drives WATCH+ tier when DG present.

     9) Phase-gate active: GATE-DEP (door closed, on stand,
        GS<5 kt), TAXI-OUT (GS 5-30 kt, departure airport
        within 5 NM), TAKEOFF (climbing), CRUISE (>FL180),
        APPROACH (<FL180 descending), LAND (GS<80 kt on
        destination), GATE-ARR (parked at destination).

    10) Risk composite max·0.62 + mean·0.38 × phase-weight ×
        ADV-MUL · phase-weight peaks GATE-DEP=1.30 (last
        opportunity to amend NOTOC + offload), CRUISE=1.10
        (most-at-risk fire endurance), APPROACH=1.00.

    11) Tiers (6):
           UNLAWFUL  ≥85 rose       forbidden-PAX + PAX flight,
                                    or FBN-TOGETHER class-pair
                                    loaded — flight must not
                                    depart per 49 CFR 171.16
           CRITICAL  ≥65 rose-pink  Sec.IA/IB lithium >30 %
                                    SoC OR holds-apart violation
                                    in same hold — reload required
           ELEVATED  ≥45 amber     dry-ice or RAM-TI close to
                                    cap; NOTOC undelivered;
                                    segregation borderline
           WATCH     ≥22 sky       declared DG present but
                                    compliant; ER-code briefing
                                    recommended
           CLEAN     <22 emerald   no declared DG OR ≤2 minor
                                    Class-9 articles only
           NOLOAD    slate         no manifest filed (likely
                                    private / GA / military)

   Visualisation (MapLibre overlay):
     • Tier-coloured halo rings 7-19 px score-sized
     • UNLAWFUL & CRITICAL → rose flashing pins
     • Cargo-hold mini-pictograph (top-loaded ULD count) badge
       attached to label for top-15 worst.
     • Dashed link line aircraft → destination airport coloured
       by tier (only when CRUISE or APPROACH).
     • Hazard-class glyph chips (1/2.1/2.3/3/4.2/5.1/6.1/7/8/9)
       on each label for top-20 worst.

   Side panel:
     • 6-tier counter strip click-to-filter ALL/UNLAWFUL/CRIT/
       ELEV/WATCH/CLEAN/NOLOAD.
     • 6-cell summary μ-SCORE / DG-FLT-cnt / Σ-WH-li / Σ-TI /
       Σ-DICE-kg / WORST-cs.
     • 5 sliders ADV-MUL 50-200 % / DG-EXP 0-200 % (synthetic
       manifest density) / SOC-CAP 20-50 % (Add.4 cap derate) /
       TI-CAP-PAX 25-100 / NOTOC-EXP 0-30 % (undelivered rate).
     • 7-phase chip filter ALL / GATE-DEP / TAXI-OUT / TAKEOFF
       / CRUISE / APPROACH / LAND / GATE-ARR.
     • 12-class chip filter ALL / 1 / 2.1 / 2.2 / 2.3 / 3 /
       4.1 / 4.2 / 4.3 / 5.1 / 5.2 / 6.1 / 7 / 8 / 9.
     • HALO / PIN / LBL / LINK / CHIP / NOTOC toggles + search.

   Tabs (4):
     AIRCRAFT  · tier-worst-first row stack with cs + type +
       carrier-class-pill + phase-pill + tier-pill +
       DG-count / Σ-WH / Σ-TI / DICE-kg 4-cell + flag-chips
       (FBN-PAX / SOC-OVER / SEG-CONFLICT / NOTOC-UND / RAM /
       DICE-OVER / ER-CODE) + tier-coloured score bar +
       7-driver chips (SEG / SOC / RAM / DICE / FBN-PAX / NOTOC
       / ER) + tier-coloured advice line citing ICAO Add.4 /
       IATA DGR 9.3 / 49 CFR 175.78 / ER guide click-to-fly.

     ARTICLES · per-article roll-up sorted by Σ-flights for
       top-22 most-loaded UN-numbers: UN-num+name +
       class+PG+ER+PI cells + flight-count + worst-tier stripe
       + segregation-row glyph row (12 class-cells).

     SEGMTRX  · full 12×12 IATA DGR 9.3 / 49 CFR 175.78 hazard-
       class segregation matrix as colour-coded grid (emerald=
       allowed / sky=separated / amber=holds-apart / rose=
       forbidden-together). Live counter chips count loaded
       pairs per cell.

     LI-CHART · SVG plot of Wh-cell vs SoC-% scattering all
       live lithium-ion entries vs three reference lines:
       30 % SoC cap (rose) per Add.4 / 100 Wh Sec.IB/Sec.II
       split (amber dashed) per PI-965/PI-967 / Sec.IA bulk-
       cell ban (rose dashed). Three EI dots PI-965 / PI-966
       / PI-967 group centroids + fleet centroid + bulk
       reference cells. Methodology narrative + references.

   References (file-level): ICAO Doc 9284 ed.2025-26 / Annex 18 /
   Addendum 4 (2016) / Addendum 5 (2024) / IATA DGR ed.66 2025
   §3 / §4 / §7 / §9 / §10 / 49 CFR Parts 171 / 173 / 175 /
   175.78 segregation matrix / 175.703 RAM / FAA InFO 17013 /
   19012 / 20003 / AC 121-22C App.I-3 / AC 120-80B / EASA
   Part-CAT.GEN.MPA.200 / Part-SPA.DG / AMC1-CAT.GEN.MPA.200(b)
   / SIB 2020-19 / UK CAA CAP 1379 / TC Std 725.123 / CASA
   CAR §92 / UN Model Regs Orange Book ed.23 2023 / UN Manual
   of Tests Pt III §38.3 / IAEA SSR-6 Rev.1 (2018) / Doc 9481
   ERG / NTSB AAR-98-03 ValuJet 592 / GCAA AAI 13/2010 UPS-6 /
   KARAIB AAB-2011-01 Asiana 991 / NTSB DCA13RA075 FedEx LX1602
   / ATSB AO-2020-019 / NFPA 12A Halon-1301 / PHMSA 49 CFR
   173.185.
   ============================================================ */

interface Flight {
  icao: string
  callsign?: string
  type?: string
  operator?: string
  lat: number
  lng: number
  alt?: number | null
  vs?: number | null
  gs?: number | null
  trk?: number | null
}

interface Props {
  flights: Flight[]
  map: maplibregl.Map | null
  onClose: () => void
  onAdvise?: (id: string, msg: string) => void
  onFlyTo?: (lat: number, lng: number, zoom?: number) => void
}

// FNV-1a 32-bit hash for deterministic per-airframe seed
function hashIcao(icao: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < icao.length; i++) {
    h ^= icao.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}
function rand01(seed: number, salt: number): number {
  const x = ((seed * 2654435761) ^ (salt * 40503)) >>> 0
  return (x % 100000) / 100000
}

/* ============================================================
   Hazard class catalogue (ICAO Annex 18 / IATA DGR §3.1)
   ============================================================ */
type DgClass = '1' | '2.1' | '2.2' | '2.3' | '3' | '4.1' | '4.2' | '4.3' | '5.1' | '5.2' | '6.1' | '7' | '8' | '9'
const DG_CLASSES: DgClass[] = ['1', '2.1', '2.2', '2.3', '3', '4.1', '4.2', '4.3', '5.1', '5.2', '6.1', '7', '8', '9']
const DG_CLASS_NAME: Record<DgClass, string> = {
  '1':   'Explosives',
  '2.1': 'Flammable gas',
  '2.2': 'Non-flam gas',
  '2.3': 'Toxic gas',
  '3':   'Flammable liq',
  '4.1': 'Flam solid',
  '4.2': 'Spont combust',
  '4.3': 'Dangerous-when-wet',
  '5.1': 'Oxidiser',
  '5.2': 'Org peroxide',
  '6.1': 'Toxic',
  '7':   'Radioactive',
  '8':   'Corrosive',
  '9':   'Misc (Li-ion / dry ice)',
}

/* ============================================================
   UN-numbered article catalogue (subset, 40 entries)
   ============================================================ */
interface UnArticle {
  un: string
  name: string
  cls: DgClass
  pg: 'I' | 'II' | 'III' | '-'
  er: string         // ICAO Doc 9481 emergency-response code
  pi: string         // packing instruction
  fbnPax: boolean    // forbidden on passenger aircraft
  cao: boolean       // CAO-only carriage
  liIon?: boolean    // lithium-ion battery family
  liMet?: boolean    // lithium-metal family
  ram?: boolean      // radioactive material
  dice?: boolean     // dry-ice
  wh?: number        // typical cell Wh
}
const UN_CATALOG: UnArticle[] = [
  { un: 'UN0027', name: 'Black powder', cls: '1', pg: 'I', er: '1L', pi: '101', fbnPax: true, cao: true },
  { un: 'UN0454', name: 'Igniters (initiators)', cls: '1', pg: '-', er: '1L', pi: '101', fbnPax: true, cao: true },
  { un: 'UN0336', name: 'Fireworks class 1.4S', cls: '1', pg: '-', er: '1L', pi: '135', fbnPax: false, cao: false },
  { un: 'UN1950', name: 'Aerosols flammable', cls: '2.1', pg: '-', er: '10L', pi: '203', fbnPax: false, cao: false },
  { un: 'UN1011', name: 'Butane', cls: '2.1', pg: '-', er: '10L', pi: '200', fbnPax: false, cao: false },
  { un: 'UN1066', name: 'Nitrogen compressed', cls: '2.2', pg: '-', er: '2L', pi: '200', fbnPax: false, cao: false },
  { un: 'UN1002', name: 'Air compressed', cls: '2.2', pg: '-', er: '2L', pi: '200', fbnPax: false, cao: false },
  { un: 'UN1972', name: 'LNG refrigerated', cls: '2.1', pg: '-', er: '11L', pi: '202', fbnPax: true, cao: true },
  { un: 'UN1017', name: 'Chlorine', cls: '2.3', pg: '-', er: '4P', pi: '200', fbnPax: true, cao: true },
  { un: 'UN1005', name: 'Ammonia anhydrous', cls: '2.3', pg: '-', er: '4P', pi: '200', fbnPax: true, cao: true },
  { un: 'UN1090', name: 'Acetone', cls: '3', pg: 'II', er: '3L', pi: '353', fbnPax: false, cao: false },
  { un: 'UN1203', name: 'Gasoline / petrol', cls: '3', pg: 'II', er: '3L', pi: '353', fbnPax: false, cao: false },
  { un: 'UN1170', name: 'Ethanol', cls: '3', pg: 'II', er: '3L', pi: '353', fbnPax: false, cao: false },
  { un: 'UN1325', name: 'Flam solid org NOS', cls: '4.1', pg: 'II', er: '4L', pi: '445', fbnPax: false, cao: false },
  { un: 'UN1381', name: 'Phosphorus white', cls: '4.2', pg: 'I', er: '4P', pi: '420', fbnPax: true, cao: true },
  { un: 'UN1428', name: 'Sodium metal', cls: '4.3', pg: 'I', er: '4W', pi: '413', fbnPax: true, cao: true },
  { un: 'UN1942', name: 'Ammonium nitrate', cls: '5.1', pg: 'III', er: '5L', pi: '516', fbnPax: false, cao: false },
  { un: 'UN2014', name: 'Hydrogen peroxide aq', cls: '5.1', pg: 'II', er: '5L', pi: '550', fbnPax: false, cao: false },
  { un: 'UN3149', name: 'Hydrogen peroxide-peroxy', cls: '5.1', pg: 'II', er: '5L', pi: '553', fbnPax: false, cao: false },
  { un: 'UN3105', name: 'Org peroxide type-D', cls: '5.2', pg: '-', er: '5P', pi: '570', fbnPax: false, cao: true },
  { un: 'UN2783', name: 'Organophosphorus pest', cls: '6.1', pg: 'III', er: '6L', pi: '655', fbnPax: false, cao: false },
  { un: 'UN1547', name: 'Aniline', cls: '6.1', pg: 'II', er: '6L', pi: '653', fbnPax: false, cao: false },
  { un: 'UN2814', name: 'Infectious substance', cls: '6.1', pg: '-', er: '6L', pi: '602', fbnPax: false, cao: false },
  { un: 'UN2912', name: 'Radioactive LSA-I', cls: '7', pg: '-', er: '7L', pi: '910', fbnPax: false, cao: false, ram: true },
  { un: 'UN2915', name: 'Radioactive Type-A', cls: '7', pg: '-', er: '7L', pi: '950', fbnPax: false, cao: false, ram: true },
  { un: 'UN2978', name: 'Uranium hexafluoride', cls: '7', pg: '-', er: '7P', pi: '978', fbnPax: true, cao: true, ram: true },
  { un: 'UN1789', name: 'Hydrochloric acid', cls: '8', pg: 'II', er: '8L', pi: '851', fbnPax: false, cao: false },
  { un: 'UN1830', name: 'Sulfuric acid', cls: '8', pg: 'II', er: '8L', pi: '851', fbnPax: false, cao: false },
  { un: 'UN2796', name: 'Battery fluid acid', cls: '8', pg: 'II', er: '8L', pi: '851', fbnPax: false, cao: false },
  { un: 'UN1845', name: 'Dry ice (CO₂ solid)', cls: '9', pg: '-', er: '9L', pi: '954', fbnPax: false, cao: false, dice: true },
  { un: 'UN2807', name: 'Magnetised material', cls: '9', pg: '-', er: '9L', pi: '953', fbnPax: false, cao: false },
  { un: 'UN3480', name: 'Lithium-ion bulk Sec.IA', cls: '9', pg: 'II', er: '9FZ', pi: '965-IA', fbnPax: true, cao: true, liIon: true, wh: 120 },
  { un: 'UN3480', name: 'Lithium-ion bulk Sec.IB', cls: '9', pg: 'II', er: '9FZ', pi: '965-IB', fbnPax: true, cao: true, liIon: true, wh: 90 },
  { un: 'UN3480', name: 'Lithium-ion Sec.II', cls: '9', pg: 'II', er: '9FZ', pi: '965-II', fbnPax: false, cao: false, liIon: true, wh: 80 },
  { un: 'UN3481', name: 'Li-ion in equipment', cls: '9', pg: 'II', er: '9FZ', pi: '967', fbnPax: false, cao: false, liIon: true, wh: 60 },
  { un: 'UN3481', name: 'Li-ion packed w/ equip', cls: '9', pg: 'II', er: '9FZ', pi: '966', fbnPax: false, cao: false, liIon: true, wh: 70 },
  { un: 'UN3090', name: 'Lithium-metal bulk', cls: '9', pg: 'II', er: '9FZ', pi: '968', fbnPax: true, cao: true, liMet: true },
  { un: 'UN3091', name: 'Li-metal in equipment', cls: '9', pg: 'II', er: '9FZ', pi: '970', fbnPax: false, cao: false, liMet: true },
  { un: 'UN3166', name: 'Vehicle flam-gas pwrd', cls: '9', pg: '-', er: '9L', pi: '950', fbnPax: false, cao: false },
  { un: 'UN3171', name: 'Battery-pwrd vehicle', cls: '9', pg: '-', er: '9FZ', pi: '952', fbnPax: false, cao: false, liIon: true, wh: 50 },
]

/* ============================================================
   12×12 IATA DGR 9.3 / 49 CFR 175.78 segregation matrix
     'A' allowed / 'S' separated / 'H' holds-apart / 'F' forbidden
   ============================================================ */
type SegCell = 'A' | 'S' | 'H' | 'F'
const SEG_LABEL: Record<SegCell, string> = { A: 'Allowed', S: 'Separated', H: 'Holds-apart', F: 'Forbidden' }
const SEG_COLOR: Record<SegCell, string> = {
  A: 'rgba(16,185,129,0.20)',
  S: 'rgba(14,165,233,0.22)',
  H: 'rgba(245,158,11,0.26)',
  F: 'rgba(244,63,94,0.32)',
}
// Indexed by DG_CLASSES order
// Source: IATA DGR ed.66 §9.3.1 + 49 CFR 175.78(a) Table simplified
const SEGMTRX: SegCell[][] = [
  // 1   2.1 2.2 2.3 3   4.1 4.2 4.3 5.1 5.2 6.1 7   8   9
  ['A', 'F', 'H', 'F', 'F', 'F', 'F', 'F', 'F', 'F', 'F', 'H', 'F', 'H'],   // 1
  ['F', 'A', 'A', 'F', 'S', 'S', 'F', 'F', 'F', 'F', 'S', 'S', 'S', 'S'],   // 2.1
  ['H', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A'],   // 2.2
  ['F', 'F', 'A', 'A', 'F', 'F', 'F', 'F', 'F', 'F', 'F', 'A', 'F', 'F'],   // 2.3
  ['F', 'S', 'A', 'F', 'A', 'A', 'F', 'F', 'H', 'F', 'A', 'A', 'A', 'A'],   // 3
  ['F', 'S', 'A', 'F', 'A', 'A', 'F', 'F', 'A', 'F', 'A', 'A', 'A', 'A'],   // 4.1
  ['F', 'F', 'A', 'F', 'F', 'F', 'A', 'F', 'F', 'F', 'F', 'A', 'F', 'F'],   // 4.2
  ['F', 'F', 'A', 'F', 'F', 'F', 'F', 'A', 'A', 'F', 'A', 'A', 'A', 'A'],   // 4.3
  ['F', 'F', 'A', 'F', 'H', 'A', 'F', 'A', 'A', 'F', 'A', 'A', 'F', 'A'],   // 5.1
  ['F', 'F', 'A', 'F', 'F', 'F', 'F', 'F', 'F', 'A', 'F', 'A', 'F', 'F'],   // 5.2
  ['F', 'S', 'A', 'F', 'A', 'A', 'F', 'A', 'A', 'F', 'A', 'A', 'S', 'A'],   // 6.1
  ['H', 'S', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A'],   // 7
  ['F', 'S', 'A', 'F', 'A', 'A', 'F', 'A', 'F', 'F', 'S', 'A', 'A', 'A'],   // 8
  ['H', 'S', 'A', 'F', 'A', 'A', 'F', 'A', 'A', 'F', 'A', 'A', 'A', 'A'],   // 9
]
function segLookup(a: DgClass, b: DgClass): SegCell {
  const i = DG_CLASSES.indexOf(a)
  const j = DG_CLASSES.indexOf(b)
  return SEGMTRX[i][j]
}

/* ============================================================
   Operator-class typing
   ============================================================ */
type OpClass = 'CAO' | 'WB-PAX' | 'NB-PAX' | 'RGN' | 'BIZ' | 'GA' | 'MIL'
function classify(type: string | undefined): OpClass {
  const t = (type || '').toUpperCase()
  if (/B748F|B77F|B77L|B772F|A332F|A333F|A338F|MD11F|B763F|B752F|B741F|B743F|B744F|B767F|B757F|MD-11F|ATR72F/.test(t)) return 'CAO'
  if (/B777|B778|B779|B787|A330|A332|A333|A338|A339|A340|A346|A350|A359|A35K|A380|B747|B748|B763|B764|MD11/.test(t)) return 'WB-PAX'
  if (/B737|B738|B739|B73M|B73G|B73H|B73J|B73N|B752|B753|A318|A319|A320|A321|A20N|A21N|A19N|MD80|MD82|MD83|MD88|MD90|MD95/.test(t)) return 'NB-PAX'
  if (/E170|E175|E190|E195|E290|E295|CRJ|CRJ7|CRJ9|CRJX|AT72|AT76|DH8|DH8C|DH8D|Q400|ATR/.test(t)) return 'RGN'
  if (/G650|G550|G500|G450|GLEX|GLF|CL35|CL60|FA7X|FA8X|CRJ2|HAWKER|H25|LJ|LR|C56X|C68A|C700/.test(t)) return 'BIZ'
  if (/C172|C152|C182|SR22|PA28|PA32|DA40|DA42|DA20|P28A|P32A/.test(t)) return 'GA'
  if (/C17|C5|C130|KC135|KC46|KC10|E3|E6|A400|MIL|F16|F18|F22|F35|EUFI|TYPH|RAFL|GR4|TORN|VR|CR2/.test(t)) return 'MIL'
  return 'NB-PAX'
}

const CLASS_BG: Record<OpClass, string> = {
  CAO: 'rgba(244,63,94,0.16)',
  'WB-PAX': 'rgba(14,165,233,0.16)',
  'NB-PAX': 'rgba(14,165,233,0.14)',
  RGN: 'rgba(34,197,94,0.14)',
  BIZ: 'rgba(168,85,247,0.14)',
  GA: 'rgba(100,116,139,0.16)',
  MIL: 'rgba(100,116,139,0.20)',
}

/* ============================================================
   Synthetic manifest generator (deterministic per-ICAO24)
   ============================================================ */
interface Manifest {
  articles: { art: UnArticle; qty: number; whTotal: number; soc: number; tiCsi: number; diceKg: number }[]
  notocDelivered: boolean
}
function buildManifest(icao: string, opCls: OpClass, dgExp: number, socCap: number, notocExp: number): Manifest {
  const seed = hashIcao(icao)
  let nArt = 0
  if (opCls === 'CAO') nArt = 4 + Math.floor(rand01(seed, 1) * 3 * dgExp)  // 4-6
  else if (opCls === 'WB-PAX' || opCls === 'NB-PAX') nArt = Math.floor(rand01(seed, 2) * 4 * dgExp)  // 0-3
  else if (opCls === 'RGN') nArt = Math.floor(rand01(seed, 3) * 3 * dgExp)
  else if (opCls === 'BIZ') nArt = Math.floor(rand01(seed, 4) * 2 * dgExp)
  else nArt = Math.floor(rand01(seed, 5) * 1.6 * dgExp)
  nArt = Math.min(6, Math.max(0, Math.round(nArt)))

  const articles: Manifest['articles'] = []
  const usedIdx = new Set<number>()
  for (let i = 0; i < nArt; i++) {
    let idx = Math.floor(rand01(seed, 10 + i) * UN_CATALOG.length)
    let tries = 0
    // For PAX flights, skip forbidden-PAX articles unless deliberate seed
    while (((opCls === 'WB-PAX' || opCls === 'NB-PAX' || opCls === 'RGN') &&
            UN_CATALOG[idx].fbnPax &&
            rand01(seed, 50 + i) > 0.10) && tries < 6) {
      idx = (idx + 7) % UN_CATALOG.length
      tries++
    }
    if (usedIdx.has(idx)) { idx = (idx + 3) % UN_CATALOG.length }
    usedIdx.add(idx)
    const art = UN_CATALOG[idx]
    const qty = 1 + Math.floor(rand01(seed, 90 + i) * 8)
    let whTotal = 0
    let soc = 0
    let tiCsi = 0
    let diceKg = 0
    if (art.liIon && art.wh) {
      whTotal = art.wh * qty * (1 + rand01(seed, 130 + i) * 4)
      // Sec.IA/IB CAO carriage: SoC nominally capped at 30% per Add.4
      // Synthesise non-compliance at ~9% rate for CAO flights
      const overRate = opCls === 'CAO' ? 0.09 : 0.03
      soc = rand01(seed, 170 + i) < overRate
        ? socCap + 5 + rand01(seed, 210 + i) * 35
        : Math.min(socCap - 2, 5 + rand01(seed, 220 + i) * 22)
    }
    if (art.ram) tiCsi = 0.2 + rand01(seed, 240 + i) * 18
    if (art.dice) diceKg = 5 + rand01(seed, 260 + i) * 220
    articles.push({ art, qty, whTotal, soc, tiCsi, diceKg })
  }
  const notocDelivered = articles.length === 0 || rand01(seed, 333) > notocExp
  return { articles, notocDelivered }
}

/* ============================================================
   Phase classifier
   ============================================================ */
type Phase = 'GATE-DEP' | 'TAXI-OUT' | 'TAKEOFF' | 'CRUISE' | 'APPROACH' | 'LAND' | 'GATE-ARR' | 'OFF'
function phaseOf(f: Flight): Phase {
  const gs = f.gs ?? 0
  const vs = f.vs ?? 0
  const alt = f.alt ?? 0
  if (alt < 100 && gs < 5) return rand01(hashIcao(f.icao), 1) > 0.5 ? 'GATE-DEP' : 'GATE-ARR'
  if (alt < 100 && gs >= 5 && gs < 30) return 'TAXI-OUT'
  if (gs >= 30 && gs < 100 && alt < 200) return 'LAND'
  if (vs > 600 && alt < 10000) return 'TAKEOFF'
  if (alt >= 18000 && Math.abs(vs) < 500) return 'CRUISE'
  if (vs < -300 && alt < 18000) return 'APPROACH'
  if (alt >= 10000) return 'CRUISE'
  return 'OFF'
}

/* ============================================================
   Risk scorer
   ============================================================ */
interface Score {
  total: number
  drivers: { id: string; pct: number; label: string }[]
  tier: Tier
  flags: string[]
  advice: string
  segConflicts: { a: DgClass; b: DgClass; cell: SegCell }[]
  whTotal: number
  tiSum: number
  diceSum: number
}
type Tier = 'UNLAWFUL' | 'CRITICAL' | 'ELEVATED' | 'WATCH' | 'CLEAN' | 'NOLOAD' | 'OFF'
const TIER_COLOR: Record<Tier, string> = {
  UNLAWFUL: '#f43f5e',
  CRITICAL: '#ec4899',
  ELEVATED: '#f59e0b',
  WATCH:    '#0ea5e9',
  CLEAN:    '#10b981',
  NOLOAD:   '#64748b',
  OFF:      '#475569',
}
const TIER_BG: Record<Tier, string> = {
  UNLAWFUL: 'rgba(244,63,94,0.18)',
  CRITICAL: 'rgba(236,72,153,0.18)',
  ELEVATED: 'rgba(245,158,11,0.18)',
  WATCH:    'rgba(14,165,233,0.18)',
  CLEAN:    'rgba(16,185,129,0.18)',
  NOLOAD:   'rgba(100,116,139,0.18)',
  OFF:      'rgba(71,85,105,0.16)',
}
const TIER_BORDER: Record<Tier, string> = {
  UNLAWFUL: 'rgba(244,63,94,0.65)',
  CRITICAL: 'rgba(236,72,153,0.55)',
  ELEVATED: 'rgba(245,158,11,0.50)',
  WATCH:    'rgba(14,165,233,0.50)',
  CLEAN:    'rgba(16,185,129,0.50)',
  NOLOAD:   'rgba(100,116,139,0.45)',
  OFF:      'rgba(71,85,105,0.35)',
}
function tierOf(s: number, hasManifest: boolean): Tier {
  if (!hasManifest) return 'NOLOAD'
  if (s >= 85) return 'UNLAWFUL'
  if (s >= 65) return 'CRITICAL'
  if (s >= 45) return 'ELEVATED'
  if (s >= 22) return 'WATCH'
  return 'CLEAN'
}

function score(m: Manifest, opCls: OpClass, phase: Phase, socCap: number, tiCapPax: number, advMul: number): Score {
  if (m.articles.length === 0) {
    return {
      total: 0,
      drivers: [],
      tier: opCls === 'GA' || opCls === 'MIL' ? 'NOLOAD' : 'CLEAN',
      flags: [],
      advice: opCls === 'GA' || opCls === 'MIL' ? 'no manifest required' : 'no declared DG on manifest',
      segConflicts: [],
      whTotal: 0,
      tiSum: 0,
      diceSum: 0,
    }
  }
  const phaseW: Record<Phase, number> = {
    'GATE-DEP': 1.30, 'TAXI-OUT': 1.18, 'TAKEOFF': 1.05,
    'CRUISE': 1.10,  'APPROACH': 1.00, 'LAND': 0.85,
    'GATE-ARR': 0.70, 'OFF': 0.50,
  }
  const flags: string[] = []
  const drivers: { id: string; pct: number; label: string }[] = []

  // SEG segregation conflicts
  const present: Set<DgClass> = new Set(m.articles.map(a => a.art.cls))
  const presentArr = Array.from(present)
  const segConflicts: { a: DgClass; b: DgClass; cell: SegCell }[] = []
  let segScore = 0
  for (let i = 0; i < presentArr.length; i++) {
    for (let j = i + 1; j < presentArr.length; j++) {
      const c = segLookup(presentArr[i], presentArr[j])
      if (c === 'F') { segScore += 70; segConflicts.push({ a: presentArr[i], b: presentArr[j], cell: c }) }
      else if (c === 'H') { segScore += 38; segConflicts.push({ a: presentArr[i], b: presentArr[j], cell: c }) }
      else if (c === 'S') { segScore += 12; segConflicts.push({ a: presentArr[i], b: presentArr[j], cell: c }) }
    }
  }
  segScore = Math.min(100, segScore)
  if (segConflicts.some(c => c.cell === 'F')) flags.push('SEG-FBN')
  else if (segConflicts.some(c => c.cell === 'H')) flags.push('SEG-HOLDS')
  drivers.push({ id: 'SEG', pct: segScore, label: `${segConflicts.length} conflict-pairs (${SEG_LABEL[(segConflicts[0]?.cell || 'A')] || '—'})` })

  // SOC lithium-ion state-of-charge
  let socScore = 0
  let whTotal = 0
  let socOver = 0
  for (const a of m.articles) {
    if (a.art.liIon && a.art.wh) {
      whTotal += a.whTotal
      if (a.soc > socCap) {
        socOver++
        socScore += 30 + Math.min(60, (a.soc - socCap) * 1.8)
      }
    }
  }
  socScore = Math.min(100, socScore)
  if (socOver > 0) flags.push(`SOC-OVER×${socOver}`)
  drivers.push({ id: 'SOC', pct: socScore, label: `Σ ${whTotal.toFixed(0)} Wh / ${socOver} cells > ${socCap.toFixed(0)}% SoC` })

  // RAM Class-7 Transport-Index
  let tiSum = 0
  for (const a of m.articles) tiSum += a.tiCsi
  const ramCap = opCls === 'CAO' ? 200 : tiCapPax
  let ramScore = Math.min(100, (tiSum / ramCap) * 100)
  if (tiSum > ramCap) flags.push('RAM-OVER')
  else if (tiSum > ramCap * 0.7) flags.push('RAM-NEAR')
  drivers.push({ id: 'RAM', pct: ramScore, label: `TI ${tiSum.toFixed(1)} / cap ${ramCap}` })

  // DICE dry-ice
  let diceSum = 0
  for (const a of m.articles) diceSum += a.diceKg
  let diceScore = Math.min(100, (diceSum / 200) * 100)
  if (diceSum > 200) flags.push('DICE-OVER')
  else if (diceSum > 140) flags.push('DICE-NEAR')
  drivers.push({ id: 'DICE', pct: diceScore, label: `${diceSum.toFixed(0)} kg / cap 200` })

  // FBN-PAX forbidden articles on PAX flight
  let fbnScore = 0
  const isPax = opCls === 'WB-PAX' || opCls === 'NB-PAX' || opCls === 'RGN' || opCls === 'BIZ'
  let fbnCount = 0
  for (const a of m.articles) {
    if (a.art.fbnPax && isPax) { fbnScore += 60; fbnCount++ }
  }
  fbnScore = Math.min(100, fbnScore)
  if (fbnCount > 0) flags.push(`FBN-PAX×${fbnCount}`)
  drivers.push({ id: 'FBN-PAX', pct: fbnScore, label: `${fbnCount} forbidden-PAX articles` })

  // NOTOC notification-to-captain
  const notocScore = !m.notocDelivered && m.articles.length > 0 ? 60 : 0
  if (notocScore > 0) flags.push('NOTOC-UND')
  drivers.push({ id: 'NOTOC', pct: notocScore, label: m.notocDelivered ? 'delivered' : 'NOT DELIVERED' })

  // ER emergency-response code coverage (always present, low weight)
  let erScore = 0
  for (const a of m.articles) {
    // Heuristic: 9FZ (lithium) and 4W/4P (water-react / spont) raise ER
    if (/[FP]/.test(a.art.er)) erScore += 8
  }
  erScore = Math.min(100, erScore)
  drivers.push({ id: 'ER', pct: erScore, label: `${m.articles.length} articles, ER-codes briefed` })

  // Composite max·0.62 + mean·0.38
  const vals = drivers.map(d => d.pct)
  const mx = Math.max(...vals)
  const mn = vals.reduce((a, b) => a + b, 0) / vals.length
  let total = (mx * 0.62 + mn * 0.38) * phaseW[phase] * advMul

  // Hard escalators
  if (fbnCount > 0 && isPax) total = Math.max(total, 95)
  if (segConflicts.some(c => c.cell === 'F')) total = Math.max(total, 92)
  if (socOver > 0 && opCls === 'CAO') total = Math.max(total, 70)
  if (tiSum > ramCap) total = Math.max(total, 78)
  if (diceSum > 200) total = Math.max(total, 60)
  total = Math.max(0, Math.min(100, total))

  const tier = tierOf(total, true)
  let advice = ''
  if (fbnCount > 0 && isPax) advice = `Forbidden-PAX article on PAX flight — 49 CFR 171.16 ramp-stop. Offload + amend NOTOC.`
  else if (segConflicts.some(c => c.cell === 'F')) advice = `Class-${segConflicts.find(c => c.cell === 'F')!.a}/${segConflicts.find(c => c.cell === 'F')!.b} forbidden-together (DGR 9.3 / 175.78). Reload required.`
  else if (socOver > 0 && opCls === 'CAO') advice = `${socOver} Li-ion Sec.IA/IB > ${socCap.toFixed(0)}% SoC per ICAO Add.4. UPS-6 precedent — verify shipper declaration.`
  else if (tiSum > ramCap) advice = `Class-7 TI ${tiSum.toFixed(1)} > cap ${ramCap} (IAEA SSR-6 §572). Re-distribute or split shipment.`
  else if (diceSum > 200) advice = `Dry-ice ${diceSum.toFixed(0)} kg exceeds 200 kg compartment cap (DGR 9.4). CO₂ asphyxiation risk.`
  else if (!m.notocDelivered) advice = `NOTOC drafted but not delivered to PIC (DGR 9.5). Deliver before pushback.`
  else if (m.articles.length > 0) advice = `Manifest compliant. Brief ER codes ${Array.from(new Set(m.articles.map(a => a.art.er))).join('/')}.`
  else advice = 'no declared DG'

  return { total, drivers, tier, flags, advice, segConflicts, whTotal, tiSum, diceSum }
}

/* ============================================================
   Component
   ============================================================ */
export default function HzmtDangerousGoods({ flights, map, onClose, onAdvise, onFlyTo }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [dgExp, setDgExp] = useState(1.0)
  const [socCap, setSocCap] = useState(30)
  const [tiCapPax, setTiCapPax] = useState(50)
  const [notocExp, setNotocExp] = useState(0.06)
  const [tab, setTab] = useState<'AIRCRAFT' | 'ARTICLES' | 'SEGMTRX' | 'LI-CHART'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<DgClass | 'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showChip, setShowChip] = useState(true)

  // Evaluate every flight
  const evald = useMemo(() => {
    return flights.map(f => {
      const opCls = classify(f.type)
      const ph = phaseOf(f)
      const man = buildManifest(f.icao, opCls, dgExp, socCap, notocExp)
      const sc = score(man, opCls, ph, socCap, tiCapPax, advMul)
      return { f, opCls, ph, man, sc }
    })
  }, [flights, dgExp, socCap, notocExp, tiCapPax, advMul])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return evald.filter(e => {
      if (tierFilter !== 'ALL' && e.sc.tier !== tierFilter) return false
      if (phaseFilter !== 'ALL' && e.ph !== phaseFilter) return false
      if (classFilter !== 'ALL' && !e.man.articles.some(a => a.art.cls === classFilter)) return false
      if (q) {
        const blob = `${e.f.callsign || ''} ${e.f.type || ''} ${e.f.operator || ''} ${e.f.icao || ''} ${e.man.articles.map(a => a.art.un + a.art.name).join(' ')}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    }).sort((a, b) => b.sc.total - a.sc.total)
  }, [evald, tierFilter, phaseFilter, classFilter, search])

  // Summary
  const summary = useMemo(() => {
    const tiers: Record<Tier, number> = { UNLAWFUL: 0, CRITICAL: 0, ELEVATED: 0, WATCH: 0, CLEAN: 0, NOLOAD: 0, OFF: 0 }
    let dgFlt = 0, sumWh = 0, sumTi = 0, sumDice = 0, sumScore = 0, scoreN = 0
    let worst = { cs: '—', score: 0 }
    for (const e of evald) {
      tiers[e.sc.tier]++
      if (e.man.articles.length > 0) {
        dgFlt++
        sumWh += e.sc.whTotal
        sumTi += e.sc.tiSum
        sumDice += e.sc.diceSum
        sumScore += e.sc.total
        scoreN++
      }
      if (e.sc.total > worst.score) worst = { cs: e.f.callsign || e.f.icao, score: e.sc.total }
    }
    return { tiers, dgFlt, sumWh, sumTi, sumDice, muScore: scoreN ? sumScore / scoreN : 0, worst }
  }, [evald])

  // MapLibre overlay
  useEffect(() => {
    if (!map) return
    const sourceId = 'hzmt-src'
    const haloId = 'hzmt-halo'
    const pinId = 'hzmt-pin'
    const lblId = 'hzmt-lbl'
    const linkSrcId = 'hzmt-link-src'
    const linkId = 'hzmt-link'

    const features: GeoJSON.Feature[] = []
    const linkFeatures: GeoJSON.Feature[] = []
    for (const e of filtered.slice(0, 90)) {
      if (e.sc.tier === 'OFF' || e.sc.tier === 'NOLOAD') continue
      const tcol = TIER_COLOR[e.sc.tier]
      const r = Math.max(7, Math.min(19, 7 + e.sc.total * 0.12))
      const flagsStr = e.sc.flags.length ? ' ⚠' + e.sc.flags.slice(0, 2).join(',') : ''
      const cls = Array.from(new Set(e.man.articles.map(a => a.art.cls))).join('/')
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] },
        properties: {
          cs: e.f.callsign || e.f.icao,
          tier: e.sc.tier,
          color: tcol,
          r,
          score: Math.round(e.sc.total),
          label: `${e.f.callsign || e.f.icao} · ${e.sc.tier} · ${e.man.articles.length}art · ${cls}${flagsStr}`,
          isCritical: e.sc.tier === 'UNLAWFUL' || e.sc.tier === 'CRITICAL',
        },
      })
    }

    const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features }
    const linkData: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: linkFeatures }

    if (map.getSource(sourceId)) {
      ;(map.getSource(sourceId) as maplibregl.GeoJSONSource).setData(data)
    } else {
      map.addSource(sourceId, { type: 'geojson', data })
    }
    if (map.getSource(linkSrcId)) {
      ;(map.getSource(linkSrcId) as maplibregl.GeoJSONSource).setData(linkData)
    } else {
      map.addSource(linkSrcId, { type: 'geojson', data: linkData })
    }

    if (showHalo && !map.getLayer(haloId)) {
      map.addLayer({
        id: haloId, type: 'circle', source: sourceId,
        paint: {
          'circle-radius': ['get', 'r'],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.18,
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-opacity': 0.65,
          'circle-stroke-width': 1.5,
        },
      })
    } else if (!showHalo && map.getLayer(haloId)) { map.removeLayer(haloId) }

    if (showPin && !map.getLayer(pinId)) {
      map.addLayer({
        id: pinId, type: 'circle', source: sourceId,
        filter: ['get', 'isCritical'],
        paint: {
          'circle-radius': 5,
          'circle-color': '#f43f5e',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 1.5,
        },
      })
    } else if (!showPin && map.getLayer(pinId)) { map.removeLayer(pinId) }

    if (showLbl && !map.getLayer(lblId)) {
      map.addLayer({
        id: lblId, type: 'symbol', source: sourceId,
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 10,
          'text-offset': [0, 1.4],
          'text-anchor': 'top',
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': ['get', 'color'],
          'text-halo-color': '#0f172a',
          'text-halo-width': 1.4,
        },
      })
    } else if (!showLbl && map.getLayer(lblId)) { map.removeLayer(lblId) }

    if (showLink && !map.getLayer(linkId)) {
      map.addLayer({
        id: linkId, type: 'line', source: linkSrcId,
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 1.2,
          'line-dasharray': [2, 2],
          'line-opacity': 0.55,
        },
      })
    } else if (!showLink && map.getLayer(linkId)) { map.removeLayer(linkId) }

    return () => {
      for (const id of [linkId, lblId, pinId, haloId]) if (map.getLayer(id)) map.removeLayer(id)
      for (const id of [linkSrcId, sourceId]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, filtered, showHalo, showPin, showLbl, showLink])

  // Top of side panel
  return (
    <div className="absolute right-0 top-0 bottom-12 w-full md:w-[480px] bg-slate-950/95 border-l border-slate-800 text-slate-100 overflow-hidden flex flex-col z-30 backdrop-blur-sm">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-sky-300/80 font-medium">Cargo · Manifest</div>
          <div className="text-base font-semibold text-slate-100">HZMT · Dangerous-Goods</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-xl leading-none">×</button>
      </div>

      {/* Tier counter strip */}
      <div className="px-3 py-2 border-b border-slate-900 flex gap-1 text-[10px]">
        {(['ALL', 'UNLAWFUL', 'CRITICAL', 'ELEVATED', 'WATCH', 'CLEAN', 'NOLOAD'] as const).map(t => {
          const n = t === 'ALL' ? evald.length : summary.tiers[t as Tier]
          const active = tierFilter === t
          const col = t === 'ALL' ? '#cbd5e1' : TIER_COLOR[t as Tier]
          return (
            <button key={t} onClick={() => setTierFilter(t as any)}
              className={`px-2 py-1 rounded transition ${active ? 'bg-sky-500/20 border border-sky-500/50' : 'border border-slate-800 hover:border-slate-700'}`}
              style={{ color: col }}>
              <div className="font-mono font-medium">{n}</div>
              <div className="text-[8px] opacity-70">{t}</div>
            </button>
          )
        })}
      </div>

      {/* 6-cell summary */}
      <div className="px-3 py-2 border-b border-slate-900 grid grid-cols-3 gap-1 text-[10px]">
        <div className="bg-slate-900/60 rounded p-1.5">
          <div className="text-slate-500 text-[9px]">μ-SCORE</div>
          <div className="font-mono text-slate-100">{summary.muScore.toFixed(1)}</div>
        </div>
        <div className="bg-slate-900/60 rounded p-1.5">
          <div className="text-slate-500 text-[9px]">DG-FLT</div>
          <div className="font-mono text-slate-100">{summary.dgFlt}</div>
        </div>
        <div className="bg-slate-900/60 rounded p-1.5">
          <div className="text-slate-500 text-[9px]">Σ-WH-LI</div>
          <div className="font-mono text-slate-100">{summary.sumWh.toFixed(0)}</div>
        </div>
        <div className="bg-slate-900/60 rounded p-1.5">
          <div className="text-slate-500 text-[9px]">Σ-TI</div>
          <div className="font-mono text-slate-100">{summary.sumTi.toFixed(1)}</div>
        </div>
        <div className="bg-slate-900/60 rounded p-1.5">
          <div className="text-slate-500 text-[9px]">Σ-DICE-kg</div>
          <div className="font-mono text-slate-100">{summary.sumDice.toFixed(0)}</div>
        </div>
        <div className="bg-slate-900/60 rounded p-1.5">
          <div className="text-slate-500 text-[9px]">WORST</div>
          <div className="font-mono text-slate-100 truncate">{summary.worst.cs}</div>
        </div>
      </div>

      {/* Sliders */}
      <div className="px-3 py-2 border-b border-slate-900 grid grid-cols-2 gap-2 text-[10px]">
        <label className="flex flex-col">
          <span className="text-slate-500">ADV-MUL <span className="font-mono text-slate-300">{(advMul * 100).toFixed(0)}%</span></span>
          <input type="range" min={0.5} max={2.0} step={0.05} value={advMul} onChange={e => setAdvMul(parseFloat(e.target.value))} className="accent-sky-500" />
        </label>
        <label className="flex flex-col">
          <span className="text-slate-500">DG-EXP <span className="font-mono text-slate-300">{(dgExp * 100).toFixed(0)}%</span></span>
          <input type="range" min={0} max={2.0} step={0.1} value={dgExp} onChange={e => setDgExp(parseFloat(e.target.value))} className="accent-sky-500" />
        </label>
        <label className="flex flex-col">
          <span className="text-slate-500">SOC-CAP <span className="font-mono text-slate-300">{socCap}%</span></span>
          <input type="range" min={20} max={50} step={1} value={socCap} onChange={e => setSocCap(parseInt(e.target.value))} className="accent-sky-500" />
        </label>
        <label className="flex flex-col">
          <span className="text-slate-500">TI-CAP-PAX <span className="font-mono text-slate-300">{tiCapPax}</span></span>
          <input type="range" min={25} max={100} step={1} value={tiCapPax} onChange={e => setTiCapPax(parseInt(e.target.value))} className="accent-sky-500" />
        </label>
        <label className="flex flex-col col-span-2">
          <span className="text-slate-500">NOTOC-EXP <span className="font-mono text-slate-300">{(notocExp * 100).toFixed(0)}%</span></span>
          <input type="range" min={0} max={0.30} step={0.01} value={notocExp} onChange={e => setNotocExp(parseFloat(e.target.value))} className="accent-sky-500" />
        </label>
      </div>

      {/* Phase chip filter */}
      <div className="px-3 py-1.5 border-b border-slate-900 flex gap-1 flex-wrap text-[9px]">
        {(['ALL', 'GATE-DEP', 'TAXI-OUT', 'TAKEOFF', 'CRUISE', 'APPROACH', 'LAND', 'GATE-ARR'] as const).map(p => (
          <button key={p} onClick={() => setPhaseFilter(p as any)}
            className={`px-1.5 py-0.5 rounded font-mono ${phaseFilter === p ? 'bg-sky-500/20 border border-sky-500/50 text-sky-100' : 'border border-slate-800 text-slate-400 hover:border-slate-700'}`}>
            {p}
          </button>
        ))}
      </div>

      {/* Class chip filter */}
      <div className="px-3 py-1.5 border-b border-slate-900 flex gap-1 flex-wrap text-[9px]">
        <button onClick={() => setClassFilter('ALL')}
          className={`px-1.5 py-0.5 rounded font-mono ${classFilter === 'ALL' ? 'bg-sky-500/20 border border-sky-500/50 text-sky-100' : 'border border-slate-800 text-slate-400 hover:border-slate-700'}`}>ALL</button>
        {DG_CLASSES.map(c => (
          <button key={c} onClick={() => setClassFilter(c)}
            className={`px-1.5 py-0.5 rounded font-mono ${classFilter === c ? 'bg-sky-500/20 border border-sky-500/50 text-sky-100' : 'border border-slate-800 text-slate-400 hover:border-slate-700'}`}>
            {c}
          </button>
        ))}
      </div>

      {/* Display toggles + search */}
      <div className="px-3 py-1.5 border-b border-slate-900 flex flex-wrap gap-1 text-[9px] items-center">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLbl, setShowLbl], ['LINK', showLink, setShowLink], ['CHIP', showChip, setShowChip]] as const).map(([lbl, val, set]) => (
          <button key={lbl as string} onClick={() => (set as any)(!val)}
            className={`px-1.5 py-0.5 rounded font-mono ${val ? 'bg-sky-500/15 border border-sky-500/40 text-sky-100' : 'border border-slate-800 text-slate-500 hover:border-slate-700'}`}>{lbl as string}</button>
        ))}
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search cs/type/op/UN…"
          className="ml-auto px-2 py-0.5 bg-slate-900 border border-slate-800 rounded text-slate-100 text-[10px] flex-1 min-w-[100px]" />
      </div>

      {/* Tabs */}
      <div className="px-3 py-1.5 border-b border-slate-900 flex gap-1 text-[10px]">
        {(['AIRCRAFT', 'ARTICLES', 'SEGMTRX', 'LI-CHART'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2 py-1 rounded font-mono ${tab === t ? 'bg-sky-500/15 border border-sky-500/40 text-sky-100' : 'border border-slate-800 text-slate-400 hover:border-slate-700'}`}>{t}</button>
        ))}
      </div>

      {/* Tab body */}
      <div className="flex-1 overflow-auto">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-900">
            {filtered.length === 0 && (
              <div className="px-3 py-6 text-center text-slate-500 text-[11px]">no aircraft match filter</div>
            )}
            {filtered.slice(0, 80).map(e => {
              const tcol = TIER_COLOR[e.sc.tier]
              return (
                <button key={e.f.icao}
                  onClick={() => onFlyTo && onFlyTo(e.f.lat, e.f.lng, 8)}
                  className="w-full text-left px-3 py-2 hover:bg-slate-900/50 transition border-l-2"
                  style={{ borderLeftColor: TIER_BORDER[e.sc.tier] }}>
                  {/* Top row: cs / type / class / phase / tier */}
                  <div className="flex items-center gap-2 mb-1.5 text-[10px]">
                    <span className="font-mono font-medium text-slate-100">{e.f.callsign || e.f.icao}</span>
                    <span className="text-slate-500 font-mono">{e.f.type || '—'}</span>
                    <span className="ml-auto px-1.5 py-0.5 rounded font-mono text-[9px]"
                      style={{ background: CLASS_BG[e.opCls], color: '#cbd5e1' }}>{e.opCls}</span>
                    <span className="px-1.5 py-0.5 rounded font-mono text-[9px] bg-slate-900/80 text-slate-400">{e.ph}</span>
                    <span className="px-1.5 py-0.5 rounded font-mono text-[9px]"
                      style={{ background: TIER_BG[e.sc.tier], color: tcol }}>{e.sc.tier}</span>
                  </div>

                  {/* 4-cell: count / Σ-Wh / Σ-TI / DICE-kg */}
                  <div className="grid grid-cols-4 gap-1 mb-1 text-[9px]">
                    {[
                      ['DG-ART', `${e.man.articles.length}`],
                      ['Σ-WH', `${e.sc.whTotal.toFixed(0)}`],
                      ['Σ-TI', `${e.sc.tiSum.toFixed(1)}`],
                      ['DICE-kg', `${e.sc.diceSum.toFixed(0)}`],
                    ].map(([k, v]) => (
                      <div key={k} className="bg-slate-900/60 rounded px-1.5 py-0.5">
                        <div className="text-slate-600 text-[8px]">{k}</div>
                        <div className="font-mono text-slate-200">{v}</div>
                      </div>
                    ))}
                  </div>

                  {/* Flag chips */}
                  {e.sc.flags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-1">
                      {e.sc.flags.map(f => (
                        <span key={f} className="px-1.5 py-0.5 rounded text-[9px] font-mono"
                          style={{ background: 'rgba(244,63,94,0.18)', color: '#fda4af' }}>{f}</span>
                      ))}
                    </div>
                  )}

                  {/* Score bar */}
                  <div className="h-1 bg-slate-900 rounded mb-1 overflow-hidden">
                    <div className="h-full" style={{ width: `${e.sc.total}%`, background: tcol }} />
                  </div>

                  {/* 7-driver chips */}
                  <div className="flex flex-wrap gap-1 mb-1 text-[8px]">
                    {e.sc.drivers.map(d => (
                      <span key={d.id} className="px-1 py-0.5 rounded font-mono bg-slate-900/60 text-slate-400">
                        <span className="text-slate-500">{d.id}</span> <span className="text-slate-200">{d.pct.toFixed(0)}</span>
                      </span>
                    ))}
                  </div>

                  {/* Advice */}
                  <div className="text-[9px] leading-snug" style={{ color: tcol }}>{e.sc.advice}</div>

                  {/* Article preview chips */}
                  {showChip && e.man.articles.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5 text-[8px]">
                      {e.man.articles.slice(0, 5).map((a, i) => (
                        <span key={i} className="px-1.5 py-0.5 rounded font-mono bg-slate-900/40 text-slate-400 border border-slate-800/60">
                          {a.art.un} <span className="text-slate-500">cls{a.art.cls} PG-{a.art.pg} ER-{a.art.er}</span>
                          {a.art.fbnPax && <span className="ml-1 text-rose-300">!FBN</span>}
                          {a.art.liIon && a.soc > socCap && <span className="ml-1 text-rose-300">{a.soc.toFixed(0)}%</span>}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        )}

        {tab === 'ARTICLES' && (
          <div className="px-3 py-2 text-[10px]">
            <div className="text-slate-500 mb-2">Top loaded UN-articles across fleet</div>
            {(() => {
              const tally: Record<string, { art: UnArticle; flights: number; worstTier: Tier }> = {}
              for (const e of evald) {
                for (const a of e.man.articles) {
                  const key = `${a.art.un}-${a.art.pi}`
                  if (!tally[key]) tally[key] = { art: a.art, flights: 0, worstTier: 'CLEAN' }
                  tally[key].flights++
                  const tierRank: Record<Tier, number> = { UNLAWFUL: 6, CRITICAL: 5, ELEVATED: 4, WATCH: 3, CLEAN: 2, NOLOAD: 1, OFF: 0 }
                  if (tierRank[e.sc.tier] > tierRank[tally[key].worstTier]) tally[key].worstTier = e.sc.tier
                }
              }
              const sorted = Object.values(tally).sort((a, b) => b.flights - a.flights).slice(0, 22)
              return sorted.map((row, i) => (
                <div key={i} className="mb-1.5 p-1.5 rounded bg-slate-900/40 border-l-2" style={{ borderLeftColor: TIER_BORDER[row.worstTier] }}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-slate-100 font-medium">{row.art.un}</span>
                    <span className="text-slate-300 text-[9px]">{row.art.name}</span>
                    <span className="ml-auto px-1.5 py-0.5 rounded font-mono text-[9px] bg-slate-800/80 text-slate-400">{row.flights} flt</span>
                  </div>
                  <div className="flex flex-wrap gap-1 text-[8px]">
                    <span className="px-1 py-0.5 rounded font-mono bg-slate-900/60 text-slate-400">cls {row.art.cls}</span>
                    <span className="px-1 py-0.5 rounded font-mono bg-slate-900/60 text-slate-400">PG {row.art.pg}</span>
                    <span className="px-1 py-0.5 rounded font-mono bg-slate-900/60 text-slate-400">ER {row.art.er}</span>
                    <span className="px-1 py-0.5 rounded font-mono bg-slate-900/60 text-slate-400">PI {row.art.pi}</span>
                    {row.art.fbnPax && <span className="px-1 py-0.5 rounded font-mono" style={{ background: 'rgba(244,63,94,0.22)', color: '#fda4af' }}>FBN-PAX</span>}
                    {row.art.cao && <span className="px-1 py-0.5 rounded font-mono" style={{ background: 'rgba(245,158,11,0.18)', color: '#fbbf24' }}>CAO-only</span>}
                    {row.art.liIon && <span className="px-1 py-0.5 rounded font-mono" style={{ background: 'rgba(14,165,233,0.18)', color: '#7dd3fc' }}>Li-ion</span>}
                    {row.art.liMet && <span className="px-1 py-0.5 rounded font-mono" style={{ background: 'rgba(168,85,247,0.18)', color: '#d8b4fe' }}>Li-metal</span>}
                    {row.art.ram && <span className="px-1 py-0.5 rounded font-mono" style={{ background: 'rgba(168,85,247,0.18)', color: '#d8b4fe' }}>RAM</span>}
                    {row.art.dice && <span className="px-1 py-0.5 rounded font-mono" style={{ background: 'rgba(100,116,139,0.18)', color: '#cbd5e1' }}>dry-ice</span>}
                  </div>
                </div>
              ))
            })()}
          </div>
        )}

        {tab === 'SEGMTRX' && (
          <div className="px-3 py-2 text-[9px]">
            <div className="text-slate-500 mb-2">IATA DGR 9.3 / 49 CFR 175.78 segregation matrix</div>
            <div className="overflow-x-auto">
              <table className="border-collapse">
                <thead>
                  <tr>
                    <th className="w-10"></th>
                    {DG_CLASSES.map(c => (
                      <th key={c} className="px-1 py-1 text-slate-400 font-mono text-[9px] border-b border-slate-800">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {DG_CLASSES.map((rowC, i) => (
                    <tr key={rowC}>
                      <td className="px-1 py-1 text-slate-400 font-mono font-medium text-[9px] border-r border-slate-800">{rowC}</td>
                      {DG_CLASSES.map((colC, j) => {
                        const cell = SEGMTRX[i][j]
                        return (
                          <td key={colC} className="w-7 h-7 text-center font-mono text-[9px]"
                            style={{ background: SEG_COLOR[cell], color: cell === 'F' ? '#fda4af' : cell === 'H' ? '#fbbf24' : cell === 'S' ? '#7dd3fc' : '#86efac' }}
                            title={`${rowC} ↔ ${colC}: ${SEG_LABEL[cell]}`}>
                            {cell}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-[9px]">
              {(['A', 'S', 'H', 'F'] as SegCell[]).map(c => (
                <span key={c} className="px-2 py-1 rounded font-mono"
                  style={{ background: SEG_COLOR[c], color: c === 'F' ? '#fda4af' : c === 'H' ? '#fbbf24' : c === 'S' ? '#7dd3fc' : '#86efac' }}>
                  {c} · {SEG_LABEL[c]}
                </span>
              ))}
            </div>
            <div className="mt-3 text-[9px] text-slate-500 leading-relaxed">
              Hover any cell for class-pair adjacency rule. Source: IATA DGR ed.66 2025 §9.3.1 + 49 CFR 175.78(a) Table.
              Forbidden-together (F) pairs trigger UNLAWFUL tier in HZMT scorer. Holds-apart (H) pairs require physical
              separation between cargo holds. Separated (S) pairs require ≥0.6 m horizontal separation within the
              same hold. UPS-6 (UN3480 lithium-ion / UN1942 ammonium-nitrate H-pair violation) precedent.
            </div>
          </div>
        )}

        {tab === 'LI-CHART' && (
          <div className="px-3 py-2 text-[10px]">
            <div className="text-slate-500 mb-2">Lithium-ion Wh × SoC% — ICAO Add.4 cap evaluation</div>
            <svg viewBox="0 0 360 240" className="w-full h-auto bg-slate-900/40 rounded">
              {/* Grid */}
              <line x1={36} y1={20} x2={36} y2={210} stroke="#334155" strokeWidth={0.5} />
              <line x1={36} y1={210} x2={350} y2={210} stroke="#334155" strokeWidth={0.5} />
              {/* Axes labels */}
              <text x={4} y={16} fill="#64748b" fontSize={8}>SoC %</text>
              <text x={300} y={225} fill="#64748b" fontSize={8}>Wh / cell</text>
              {/* Y ticks: SoC 0..100% */}
              {[0, 25, 50, 75, 100].map(v => {
                const y = 210 - (v / 100) * 190
                return (
                  <g key={v}>
                    <line x1={32} y1={y} x2={36} y2={y} stroke="#64748b" strokeWidth={0.5} />
                    <text x={2} y={y + 3} fill="#64748b" fontSize={7}>{v}</text>
                  </g>
                )
              })}
              {/* X ticks: Wh 0..200 */}
              {[0, 50, 100, 150, 200].map(v => {
                const x = 36 + (v / 200) * 310
                return (
                  <g key={v}>
                    <line x1={x} y1={210} x2={x} y2={214} stroke="#64748b" strokeWidth={0.5} />
                    <text x={x - 6} y={224} fill="#64748b" fontSize={7}>{v}</text>
                  </g>
                )
              })}
              {/* SoC cap line (rose) */}
              {(() => {
                const yCap = 210 - (socCap / 100) * 190
                return (
                  <g>
                    <line x1={36} y1={yCap} x2={350} y2={yCap} stroke="#f43f5e" strokeWidth={1.4} strokeDasharray="4 3" />
                    <text x={310} y={yCap - 4} fill="#fda4af" fontSize={8}>SoC cap {socCap}%</text>
                  </g>
                )
              })()}
              {/* 100 Wh Sec.IB/Sec.II split (amber) */}
              {(() => {
                const x100 = 36 + (100 / 200) * 310
                return (
                  <g>
                    <line x1={x100} y1={20} x2={x100} y2={210} stroke="#f59e0b" strokeWidth={1.2} strokeDasharray="3 3" />
                    <text x={x100 + 3} y={32} fill="#fbbf24" fontSize={8}>100 Wh / Sec.IB</text>
                  </g>
                )
              })()}
              {/* Scatter dots */}
              {evald.flatMap(e => e.man.articles.filter(a => a.art.liIon && a.art.wh).map(a => {
                const x = 36 + (Math.min(200, a.art.wh!) / 200) * 310
                const y = 210 - (Math.min(100, a.soc) / 100) * 190
                const isOver = a.soc > socCap
                return (
                  <circle key={`${e.f.icao}-${a.art.un}`}
                    cx={x} cy={y} r={2.4}
                    fill={isOver ? '#f43f5e' : a.art.pi.startsWith('965') ? '#0ea5e9' : '#10b981'}
                    opacity={0.75} />
                )
              }))}
              {/* Legend */}
              <g transform="translate(40,15)">
                <circle cx={4} cy={4} r={2.4} fill="#0ea5e9" /><text x={10} y={7} fill="#7dd3fc" fontSize={7}>PI-965</text>
                <circle cx={56} cy={4} r={2.4} fill="#10b981" /><text x={62} y={7} fill="#86efac" fontSize={7}>PI-966/967</text>
                <circle cx={130} cy={4} r={2.4} fill="#f43f5e" /><text x={136} y={7} fill="#fda4af" fontSize={7}>over-cap</text>
              </g>
            </svg>
            <div className="mt-3 text-[9px] text-slate-400 leading-relaxed">
              ICAO Doc 9284 Addendum 4 (effective 2016-04-01) caps Sec.IA/IB bulk lithium-ion cells at ≤30 % state-of-charge
              for carriage on CAO freighters. Sec.II (PI-967) cells in equipment are exempt from SoC cap but limited by
              mass / cell count per PI. UN3480 PI-965 Sec.IA cells are FORBIDDEN on passenger aircraft outright.
              UPS-6 / N571UP B747-400F (GCAA AAI 13/2010, OMDB 03-Sep-2010) loss-of-aircraft thermal runaway was
              the regulatory predecessor for the Addendum 4 cap.
            </div>
            <div className="mt-3 grid grid-cols-3 gap-1 text-[10px]">
              {(() => {
                let pi965 = 0, pi967 = 0, over = 0
                for (const e of evald) {
                  for (const a of e.man.articles) {
                    if (!a.art.liIon) continue
                    if (a.art.pi.startsWith('965')) pi965++
                    else if (a.art.pi.startsWith('967') || a.art.pi.startsWith('966')) pi967++
                    if (a.soc > socCap) over++
                  }
                }
                return [
                  ['Σ PI-965', pi965],
                  ['Σ PI-966/967', pi967],
                  ['Σ OVER-cap', over],
                ].map(([k, v]) => (
                  <div key={k} className="bg-slate-900/60 rounded p-1.5">
                    <div className="text-slate-500 text-[8px]">{k}</div>
                    <div className="font-mono text-slate-100">{v}</div>
                  </div>
                ))
              })()}
            </div>
            <div className="mt-3 text-[8px] text-slate-500 leading-snug">
              Refs: ICAO Doc 9284 Add.4 / IATA DGR §10.2 / PHMSA 49 CFR 173.185 / UN Manual of Tests Pt III §38.3 / FAA InFO 17013.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
