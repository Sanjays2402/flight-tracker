'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { AIRPORTS, AirportPin } from './airports'
// [BATCH-C] imports
import { BatchCOverlay, useBatchCPrefs, StatsExtended, FlightDetailCharts } from './batch-c-overlay'
// [BATCH-B] overlays bundle
import BatchBOverlays from './overlays/batch-b-overlays'
// [BATCH-A] new imports
import { SettingsCluster, ToastHost, OfflineBanner, SkipToMap, EmergencyLive, useRefreshControl } from './settings-bundle'
import { pushToast } from '../lib/toast'
import { playEmergencyChime, playRadioChirp } from '../lib/audio'
import { lsGet, lsSet } from '../lib/storage'
import { t as i18nT } from '../lib/i18n'
import CommandPalette, { CPAction } from './command-palette'
import TrafficRadar from './traffic-radar'
import EmissionsPanel from './emissions-panel'
import ConflictPanel, { detectConflicts, type ConflictPair } from './conflict-panel'
import OverheadPanel from './overhead-panel'
import { SunPanel, solarPosition, installTerminator, updateTerminator, removeTerminator } from './terminator-layer'
import HoldingPanel, { detectHolding, type HoldingHit } from './holding-panel'
import FormationPanel, { detectFormations, type Formation } from './formation-panel'
import EventLog, { detectEvents, type LogEvent, type EventKind, type SnapshotEntry } from './event-log'
import AltitudeLadder from './altitude-ladder'
import PhasePanel from './phase-panel'
import CockpitHUD from './cockpit-hud'
import RulerTool from './ruler-tool'
import E6bComputer from './e6b-computer'
import PipMinimap from './pip-minimap'
import BullseyeTool from './bullseye-tool'
import VerticalProfilePanel from './vertical-profile-panel'
import TcasPanel from './tcas-panel'
import WakePanel from './wake-panel'
import SidClimb from './sid-climb'
import ContrailForecast from './contrail-forecast'
import RegistryAtlas from './registry-atlas'
import WindsAloft from './winds-aloft'
import AirportBoard from './airport-board'
import SpeedAltScatter from './speed-alt-scatter'
import SquawkMonitor from './squawk-monitor'
import OperatorRace from './operator-race'
import DensityHeatPanel, { installHeat, updateHeat, setHeatVisibility, setHeatRadius, setHeatIntensity, type HeatMode } from './density-heat'
import CpaPanel, { detectCpa, type CpaHit } from './cpa-panel'
import DiversionPanel from './diversion-panel'
import VipHunter from './vip-hunter'
import FlowRose from './flow-rose'
import PassPredictor from './pass-predictor'
import NoiseMonitor from './noise-monitor'
import TodPredictor from './tod-predictor'
import Tripwire from './tripwire'
import GeofenceStudio from './geofence-studio'
import VoronoiTerritory from './voronoi-territory'
import SunGlarePanel from './sun-glare'
import GlideAtlasPanel from './glide-atlas'
import CoffinCornerPanel from './coffin-corner'
import AnomalyRadar from './anomaly-radar'
import ComparePanel from './compare-panel'
import SkySymphony from './sky-symphony'
import TimeMachine from './time-machine'
import ReachAtlas from './reach-atlas'
import TripPlanner from './trip-planner'
import RecordsHall from './records-hall'
import ShadowCaster from './shadow-caster'
import DopplerScope from './doppler-scope'
import ApproachSequencer from './approach-sequencer'
import RoutePlanner from './route-planner'
import SuaMonitor from './sua-monitor'
import ShearAtlas from './shear-atlas'
import CosmicDose from './cosmic-dose'
import HypoxiaMonitor from './hypoxia-monitor'
import CostIndex from './cost-index'
import StepClimb from './step-climb'
import EtopsMonitor from './etops-monitor'
import JetStreamFinder from './jetstream-finder'
import HoldingStackDesigner from './holding-stack'
import IcingMonitor from './icing-monitor'
import CurfewMonitor from './curfew-monitor'
import MountainWave from './mountain-wave'
import BirdStrikeMonitor from './birdstrike-monitor'
import VolcanicAshMonitor from './volcanic-ash-monitor'
import FirLoadMonitor from './fir-load-monitor'
import EnergyMonitor from './energy-monitor'
import TurbulenceEdr from './turbulence-edr'
import NordoMonitor from './nordo-monitor'
import TerrainClearance from './terrain-clearance'
import MassBalance from './mass-balance'
import MagneticVariation from './magnetic-variation'
import RaimMonitor from './raim-monitor'
import DepartureSequencer from './departure-sequencer'
import CrosswindCompass from './crosswind-compass'
import OceanicTracks from './oceanic-tracks'
import MetarMonitor from './metar-monitor'
import TafForecast from './taf-forecast'
import TocPredictor from './toc-predictor'
import CabinPressure from './cabin-pressure'
import FuelTemp from './fuel-temp'
import NavaidCoverage from './navaid-coverage'
import DriftDown from './drift-down'
import ReserveFuel from './reserve-fuel'
import EtpAtlas from './etp-atlas'
import CdaCompliance from './cda-compliance'
import BrakeEnergy from './brake-energy'
import MissedApproach from './missed-approach'
import VhfCongestion from './vhf-congestion'
import FoqaExceedance from './foqa-exceedance'
import EgtMargin from './egt-margin'
import PolarOps from './polar-ops'
import LiBattery from './li-battery'
import RexHyd from './rex-hyd'
import CgTrim from './cg-trim'
import OwlJettison from './owl-jettison'
import ToldBfl from './told-bfl'
import UasPitot from './uas-pitot'
import FlutterMargin from './flutter-margin'
import StallMargin from './stall-margin'
import TailStrike from './tail-strike'
import RunwayExcursion from './runway-excursion'
import TawsModes from './taws-modes'
import CtotSlot from './ctot-slot'
import BleedFume from './bleed-fume'
import DeiceHot from './deice-hot'
import PStaticMonitor from './pstatic-monitor'
import RelightEnvelope from './relight-envelope'
import Egress90Sec from './egress-90sec'
import NotamTfr from './notam-tfr'
import Radalt5g from './radalt-5g'
import CtAltMonitor from './ctalt-monitor'
import HotSectionLcf from './hotsection-lcf'
import LightningHirf from './lightning-hirf'
import RecatWake from './recat-wake'
import EaiPenalty from './eai-penalty'
import AdizMonitor from './adiz-monitor'
import SpaceWeatherMonitor from './space-weather'
import RvsmMonitor from './rvsm-monitor'
import SpeedLimit from './speed-limit'
import SonicBoom from './sonic-boom'
import RnpMonitor from './rnp-monitor'
import RtaConformance from './rta-conformance'
import SatcomCoverage from './satcom-coverage'
import NadpMonitor from './nadp-monitor'
import FuelTankering from './fuel-tankering'
import WorkloadIndex from './workload-index'
import GnssIntegrity from './gnss-integrity'
import CpdlcMonitor from './cpdlc-monitor'
import LevelBustPredictor from './level-bust'
import AdsbQualityMonitor from './adsb-quality'
import RtaCompliance from './rta-compliance'
import OzoneMonitor from './ozone-monitor'
import CrewDuty from './crew-duty'
import ApproachMinimums from './approach-minimums'
import ConvectiveCells from './convective-cells'
import SarPlanner from './sar-planner'
import StableApproach from './stable-approach'
import FirCrossings from './fir-crossings'
import RunwayConfig from './runway-config'

/* ============================================================
   Flight Tracker — MapLibre GL v5 edition (3D-capable).
   Data: adsb.lol (positions, routes, airports), planespotters.net (photos),
         RainViewer (weather radar), built-in day/night terminator.
   ============================================================ */

interface AcRaw {
  hex: string
  type?: string
  flight?: string
  r?: string
  t?: string
  desc?: string
  ownOp?: string
  alt_baro?: number | 'ground'
  alt_geom?: number
  gs?: number
  ias?: number
  tas?: number
  mach?: number
  track?: number
  baro_rate?: number
  geom_rate?: number
  nav_altitude_mcp?: number
  wd?: number
  ws?: number
  oat?: number
  squawk?: string
  category?: string
  lat: number
  lon: number
  emergency?: string
  dbFlags?: number
}
interface Flight {
  icao: string
  callsign: string
  registration: string
  type: string
  operator: string
  lng: number
  lat: number
  altitudeFt: number
  ground: boolean
  velocityKts: number
  ias: number
  mach: number
  vertRate: number
  navAlt: number
  windDir: number
  windKts: number
  oat: number
  track: number
  squawk: string
  category: string
  emergency: boolean
  dataSource: string
  military: boolean
}
interface Airport {
  icao: string; iata: string; name: string; location: string; lat: number; lon: number; countryiso2: string
}
interface Route {
  airports?: Airport[]
  airline?: string
}

const REFRESH_MS = 8_000
const TRAIL_MAX = 60

/* category codes from ADS-B */
const CAT_LABEL: Record<string, string> = {
  A1: 'Light', A2: 'Small', A3: 'Large', A4: 'High-vortex', A5: 'Heavy',
  A6: 'High-perf', A7: 'Rotorcraft', B1: 'Glider', B2: 'Balloon', B4: 'UAV',
  B6: 'UAV', B7: 'Spacecraft',
}

/* ---------- Plane icon palette (drawn into canvas, addImage'd) ---------- */
const ICON_COLORS = [
  // ground / neutral
  '#64748b','#94a3b8',
  // alt ramp (low→high): magenta→red→orange→amber→yellow→lime→emerald→teal→cyan→sky→indigo→violet→fuchsia
  '#ec4899','#f43f5e','#fb7185','#f97316','#fb923c','#f59e0b','#facc15','#fde047','#bef264','#a3e635','#84cc16','#10b981','#34d399','#14b8a6','#2dd4bf','#22d3ee','#67e8f9','#38bdf8','#0ea5e9','#6366f1','#818cf8','#a78bfa','#c084fc','#d946ef',
  // category accents
  '#fbbf24','#e11d48','#7c3aed','#06b6d4','#22c55e',
]
const PLANE_PATH = 'M21 16v-2l-8-5V3.5a1.5 1.5 0 1 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z'
function iconKey(color: string, heli: boolean, selected: boolean) {
  return `pl-${heli ? 'h' : 'p'}-${selected ? 's' : 'n'}-${color.replace('#', '')}`
}
function drawIcon(color: string, heli: boolean, selected: boolean): ImageData {
  const pixelRatio = 2
  const sizeCss = selected ? 32 : 26
  const size = sizeCss * pixelRatio
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, size, size)
  if (heli) {
    ctx.translate(size / 2, size / 2)
    ctx.fillStyle = color
    ctx.strokeStyle = '#0f172a'
    ctx.lineWidth = 1.4 * pixelRatio
    ctx.beginPath(); ctx.arc(0, 0, size * 0.16, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    ctx.strokeStyle = color
    ctx.lineWidth = 1.8 * pixelRatio
    ctx.beginPath(); ctx.moveTo(-size * 0.42, 0); ctx.lineTo(size * 0.42, 0); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(0, -size * 0.42); ctx.lineTo(0, size * 0.42); ctx.stroke()
  } else {
    const k = size / 24
    ctx.translate(size / 2, size / 2)
    ctx.scale(k, k)
    ctx.translate(-12, -12)
    const p = new Path2D(PLANE_PATH)
    ctx.fillStyle = color
    ctx.strokeStyle = '#0f172a'
    ctx.lineWidth = 0.8
    ctx.lineJoin = 'round'
    ctx.fill(p); ctx.stroke(p)
  }
  return ctx.getImageData(0, 0, size, size)
}

export default function FlightMap() {
  const mapEl = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const mapReadyRef = useRef(false)
  const [mapReady, setMapReady] = useState(false)

  const trailsRef = useRef<Map<string, Array<[number, number, number]>>>(new Map())
  const routeCacheRef = useRef<Map<string, Route | null>>(new Map())
  const photoCacheRef = useRef<Map<string, string | null>>(new Map())

  const [flights, setFlights] = useState<Flight[]>([])
  const [selected, setSelected] = useState<Flight | null>(null)
  const [showRadar, setShowRadar] = useState<boolean>(() => lsGet('ft-radar', false))
  const [showEmissions, setShowEmissions] = useState<boolean>(() => lsGet('ft-em', false))
  const [showConflict, setShowConflict] = useState<boolean>(() => lsGet('ft-cflx', false))
  const [showOverhead, setShowOverhead] = useState<boolean>(() => lsGet('ft-overhead', false))
  const [showSun, setShowSun] = useState<boolean>(() => lsGet('ft-sun', false))
  const [showHolding, setShowHolding] = useState<boolean>(() => lsGet('ft-hold', false))
  const [showFormation, setShowFormation] = useState<boolean>(() => lsGet('ft-form', false))
  const [showCpa, setShowCpa] = useState<boolean>(() => lsGet('ft-cpa', false))
  const [showDiversion, setShowDiversion] = useState<boolean>(() => lsGet('ft-div', false))
  const [showVProfile, setShowVProfile] = useState<boolean>(() => lsGet('ft-vp', false))
  const [showTcas, setShowTcas] = useState<boolean>(() => lsGet('ft-tcas', false))
  const [showWake, setShowWake] = useState<boolean>(() => lsGet('ft-wake', false))
  const [showContrail, setShowContrail] = useState<boolean>(() => lsGet('ft-contrail', false))
  const [showAtlas, setShowAtlas] = useState<boolean>(() => lsGet('ft-atlas', false))
  const [showVip, setShowVip] = useState<boolean>(() => lsGet('ft-vip', false))
  const [showFlow, setShowFlow] = useState<boolean>(() => lsGet('ft-flow', false))
  const [showRecords, setShowRecords] = useState<boolean>(() => lsGet('ft-records', false))
  const [showShadow, setShowShadow] = useState<boolean>(() => lsGet('ft-shadow', false))
  const [showDoppler, setShowDoppler] = useState<boolean>(() => lsGet('ft-doppler', false))
  const [showAprSeq, setShowAprSeq] = useState<boolean>(() => lsGet('ft-aprseq', false))
  const [showPass, setShowPass] = useState<boolean>(() => lsGet('ft-pass', false))
  const [showNoise, setShowNoise] = useState<boolean>(() => lsGet('ft-noise', false))
  const [showTod, setShowTod] = useState<boolean>(() => lsGet('ft-tod', false))
  const [showTripwire, setShowTripwire] = useState<boolean>(() => lsGet('ft-tripwire', false))
  const [showGeofence, setShowGeofence] = useState<boolean>(() => lsGet('ft-geofence', false))
  const [showVoronoi, setShowVoronoi] = useState<boolean>(() => lsGet('ft-voronoi', false))
  const [showSunGlare, setShowSunGlare] = useState<boolean>(() => lsGet('ft-sunglare', false))
  const [showGlide, setShowGlide] = useState<boolean>(() => lsGet('ft-glide', false))
  const [showCoffin, setShowCoffin] = useState<boolean>(() => lsGet('ft-coffin', false))
  const [showRoute, setShowRoute] = useState<boolean>(() => lsGet('ft-route', false))
  const [showSua, setShowSua] = useState<boolean>(() => lsGet('ft-sua', false))
  const [showShear, setShowShear] = useState<boolean>(() => lsGet('ft-shear', false))
  const [showCosmic, setShowCosmic] = useState<boolean>(() => lsGet('ft-cosmic', false))
  const [showHypoxia, setShowHypoxia] = useState<boolean>(() => lsGet('ft-hypoxia', false))
  const [showCostIdx, setShowCostIdx] = useState<boolean>(() => lsGet('ft-costidx', false))
  const [showStepClimb, setShowStepClimb] = useState<boolean>(() => lsGet('ft-stepclimb', false))
  const [showEtops, setShowEtops] = useState<boolean>(() => lsGet('ft-etops', false))
  const [showDepSeq, setShowDepSeq] = useState<boolean>(() => lsGet('ft-depseq', false))
  const [showXwind, setShowXwind] = useState<boolean>(() => lsGet('ft-xwind', false))
  const [showJet, setShowJet] = useState<boolean>(() => lsGet('ft-jet', false))
  const [showHstack, setShowHstack] = useState<boolean>(() => lsGet('ft-hstack', false))
  const [showIcing, setShowIcing] = useState<boolean>(() => lsGet('ft-icing', false))
  const [showCurfew, setShowCurfew] = useState<boolean>(() => lsGet('ft-curfew', false))
  const [showMtnWave, setShowMtnWave] = useState<boolean>(() => lsGet('ft-mwave', false))
  const [showBird, setShowBird] = useState<boolean>(() => lsGet('ft-bird', false))
  const [showAsh, setShowAsh] = useState<boolean>(() => lsGet('ft-ash', false))
  const [showFir, setShowFir] = useState<boolean>(() => lsGet('ft-fir', false))
  const [showEnergy, setShowEnergy] = useState<boolean>(() => lsGet('ft-energy', false))
  const [showTurb, setShowTurb] = useState<boolean>(() => lsGet('ft-turb', false))
  const [showNordo, setShowNordo] = useState<boolean>(() => lsGet('ft-nordo', false))
  const [showTerrain, setShowTerrain] = useState<boolean>(() => lsGet('ft-terrain', false))
  const [showMass, setShowMass] = useState<boolean>(() => lsGet('ft-mass', false))
  const [showMagVar, setShowMagVar] = useState<boolean>(() => lsGet('ft-magvar', false))
  const [showRaim, setShowRaim] = useState<boolean>(() => lsGet('ft-raim', false))
  const [showOcean, setShowOcean] = useState<boolean>(() => lsGet('ft-ocean', false))
  const [showMetar, setShowMetar] = useState<boolean>(() => lsGet('ft-metar', false))
  const [showCells, setShowCells] = useState<boolean>(() => lsGet('ft-cells', false))
  const [showSar, setShowSar] = useState<boolean>(() => lsGet('ft-sar', false))
  const [showStable, setShowStable] = useState<boolean>(() => lsGet('ft-stable', false))
  const [showFirX, setShowFirX] = useState<boolean>(() => lsGet('ft-firx', false))
  const [showRwyCfg, setShowRwyCfg] = useState<boolean>(() => lsGet('ft-rwycfg', false))
  const [showTaf, setShowTaf] = useState<boolean>(() => lsGet('ft-taf', false))
  const [showToc, setShowToc] = useState<boolean>(() => lsGet('ft-toc', false))
  const [showCabin, setShowCabin] = useState<boolean>(() => lsGet('ft-cabin', false))
  const [showApMin, setShowApMin] = useState<boolean>(() => lsGet('ft-apmin', false))
  const [showFuelTemp, setShowFuelTemp] = useState<boolean>(() => lsGet('ft-fueltemp', false))
  const [showNavaid, setShowNavaid] = useState<boolean>(() => lsGet('ft-navaid', false))
  const [showDrift, setShowDrift] = useState<boolean>(() => lsGet('ft-drift', false))
  const [showReserve, setShowReserve] = useState<boolean>(() => lsGet('ft-reserve', false))
  const [showEtp, setShowEtp] = useState<boolean>(() => lsGet('ft-etp', false))
  const [showCda, setShowCda] = useState<boolean>(() => lsGet('ft-cda', false))
  const [showBrake, setShowBrake] = useState<boolean>(() => lsGet('ft-brake', false))
  const [showMapp, setShowMapp] = useState<boolean>(() => lsGet('ft-mapp', false))
  const [showVhf, setShowVhf] = useState<boolean>(() => lsGet('ft-vhf', false))
  const [showSpwx, setShowSpwx] = useState<boolean>(() => lsGet('ft-spwx', false))
  const [showFoqa, setShowFoqa] = useState<boolean>(() => lsGet('ft-foqa', false))
  const [showEgt, setShowEgt] = useState<boolean>(() => lsGet('ft-egt', false))
  const [showPolar, setShowPolar] = useState<boolean>(() => lsGet('ft-polar', false))
  const [showLibat, setShowLibat] = useState<boolean>(() => lsGet('ft-libat', false))
  const [showRexhyd, setShowRexhyd] = useState<boolean>(() => lsGet('ft-rexhyd', false))
  const [showCgTrim, setShowCgTrim] = useState<boolean>(() => lsGet('ft-cgtrim', false))
  const [showOwl, setShowOwl] = useState<boolean>(() => lsGet('ft-owl', false))
  const [showTold, setShowTold] = useState<boolean>(() => lsGet('ft-told', false))
  const [showUas, setShowUas] = useState<boolean>(() => lsGet('ft-uas', false))
  const [showBleed, setShowBleed] = useState<boolean>(() => lsGet('ft-bleed', false))
  const [showDeice, setShowDeice] = useState<boolean>(() => lsGet('ft-deice', false))
  const [showPstatic, setShowPstatic] = useState<boolean>(() => lsGet('ft-pstatic', false))
  const [showFlutter, setShowFlutter] = useState<boolean>(() => lsGet('ft-flutter', false))
  const [showStall, setShowStall] = useState<boolean>(() => lsGet('ft-stall', false))
  const [showTailStrike, setShowTailStrike] = useState<boolean>(() => lsGet('ft-tailstrike', false))
  const [showRera, setShowRera] = useState<boolean>(() => lsGet('ft-rera', false))
  const [showRelight, setShowRelight] = useState<boolean>(() => lsGet('ft-relight', false))
  const [showEgress, setShowEgress] = useState<boolean>(() => lsGet('ft-egress', false))
  const [showNotam, setShowNotam] = useState<boolean>(() => lsGet('ft-notam', false))
  const [showRadalt5g, setShowRadalt5g] = useState<boolean>(() => lsGet('ft-radalt5g', false))
  const [showCtAlt, setShowCtAlt] = useState<boolean>(() => lsGet('ft-ctalt', false))
  const [showHotsec, setShowHotsec] = useState<boolean>(() => lsGet('ft-hotsec', false))
  const [showLhirf, setShowLhirf] = useState<boolean>(() => lsGet('ft-lhirf', false))
  const [showTaws, setShowTaws] = useState<boolean>(() => lsGet('ft-taws', false))
  const [showCtot, setShowCtot] = useState<boolean>(() => lsGet('ft-ctot', false))
  const [showRecat, setShowRecat] = useState<boolean>(() => lsGet('ft-recat', false))
  const [showEai, setShowEai] = useState<boolean>(() => lsGet('ft-eai', false))
  const [showAdiz, setShowAdiz] = useState<boolean>(() => lsGet('ft-adiz', false))
  const [showSidc, setShowSidc] = useState<boolean>(() => lsGet('ft-sidc', false))
  const [showRvsm, setShowRvsm] = useState<boolean>(() => lsGet('ft-rvsm', false))
  const [showSpdLim, setShowSpdLim] = useState<boolean>(() => lsGet('ft-spdlim', false))
  const [showBoom, setShowBoom] = useState<boolean>(() => lsGet('ft-boom', false))
  const [showRnp, setShowRnp] = useState<boolean>(() => lsGet('ft-rnp', false))
  const [showRta, setShowRta] = useState<boolean>(() => lsGet('ft-rta', false))
  const [showSatcom, setShowSatcom] = useState<boolean>(() => lsGet('ft-satcom', false))
  const [showTank, setShowTank] = useState<boolean>(() => lsGet('ft-tank', false))
  const [showWkld, setShowWkld] = useState<boolean>(() => lsGet('ft-wkld', false))
  const [showGnss, setShowGnss] = useState<boolean>(() => lsGet('ft-gnss', false))
  const [showCpdlc, setShowCpdlc] = useState<boolean>(() => lsGet('ft-cpdlc', false))
  const [showLbust, setShowLbust] = useState<boolean>(() => lsGet('ft-lbust', false))
  const [showAdsbq, setShowAdsbq] = useState<boolean>(() => lsGet('ft-adsbq', false))
  const [showOzone, setShowOzone] = useState<boolean>(() => lsGet('ft-ozone', false))
  const [showNadp, setShowNadp] = useState<boolean>(() => lsGet('ft-nadp', false))
  const [showCrew, setShowCrew] = useState<boolean>(() => lsGet('ft-crewduty', false))
  const [showAnomaly, setShowAnomaly] = useState<boolean>(() => lsGet('ft-anomaly', false))
  const [showCompareStudio, setShowCompareStudio] = useState<boolean>(() => lsGet('ft-compare-studio', false))
  const [compareStudioIcaos, setCompareStudioIcaos] = useState<string[]>(() => lsGet<string[]>('ft-compare-studio-icaos', []))
  const [showSymphony, setShowSymphony] = useState<boolean>(() => lsGet('ft-symphony', false))
  const [showTimeMachine, setShowTimeMachine] = useState<boolean>(() => lsGet('ft-timemachine', false))
  const [showReach, setShowReach] = useState<boolean>(() => lsGet('ft-reach', false))
  const [showTrip, setShowTrip] = useState<boolean>(() => lsGet('ft-trip', false))
  const [cpaHorizon, setCpaHorizon] = useState<number>(() => lsGet('ft-cpa-hor', 300))
  const [cpaMaxMissNm, setCpaMaxMissNm] = useState<number>(() => lsGet('ft-cpa-mnm', 5))
  const [cpaMaxMissFt, setCpaMaxMissFt] = useState<number>(() => lsGet('ft-cpa-mft', 1500))
  const [cpaGround, setCpaGround] = useState<boolean>(() => lsGet('ft-cpa-grd', false))
  const [cpaSameOp, setCpaSameOp] = useState<boolean>(() => lsGet('ft-cpa-sop', false))
  const [formMaxRadius, setFormMaxRadius] = useState<number>(() => lsGet('ft-form-rad', 2))
  const [formMaxAlt, setFormMaxAlt] = useState<number>(() => lsGet('ft-form-alt', 500))
  const [formMaxTrack, setFormMaxTrack] = useState<number>(() => lsGet('ft-form-trk', 15))
  const [formMaxSpeed, setFormMaxSpeed] = useState<number>(() => lsGet('ft-form-spd', 30))
  const [formMinMembers, setFormMinMembers] = useState<number>(() => lsGet('ft-form-min', 2))
  const [formGround, setFormGround] = useState<boolean>(() => lsGet('ft-form-grd', false))
  const [showLadder, setShowLadder] = useState<boolean>(() => lsGet('ft-ladder', false))
  const [showPhase, setShowPhase] = useState<boolean>(() => lsGet('ft-phase', false))
  const [showCockpit, setShowCockpit] = useState<boolean>(() => lsGet('ft-pfd', false))
  const [showRuler, setShowRuler] = useState<boolean>(false)
  const [showE6b, setShowE6b] = useState<boolean>(false)
  const [showBullseye, setShowBullseye] = useState<boolean>(false)
  const [showWinds, setShowWinds] = useState<boolean>(() => lsGet('ft-winds', false))
  const [showBoard, setShowBoard] = useState<boolean>(() => lsGet('ft-board', false))
  const [showScatter, setShowScatter] = useState<boolean>(() => lsGet('ft-scatter', false))
  const [showSquawk, setShowSquawk] = useState<boolean>(() => lsGet('ft-squawk', false))
  const [showRace, setShowRace] = useState<boolean>(() => lsGet('ft-race', false))
  const [showDensity, setShowDensity] = useState<boolean>(() => lsGet('ft-dens', false))
  const [heatMode, setHeatMode] = useState<HeatMode>(() => (lsGet('ft-heat-mode', 'count') as HeatMode))
  const [heatGround, setHeatGround] = useState<boolean>(() => lsGet('ft-heat-grd', false))
  const [heatRadius, setHeatRadiusState] = useState<number>(() => lsGet('ft-heat-r', 1))
  const [heatIntensity, setHeatIntensityState] = useState<number>(() => lsGet('ft-heat-i', 1))
  const [heatCell, setHeatCell] = useState<number>(() => lsGet('ft-heat-cell', 1))
  const [showPip, setShowPip] = useState<boolean>(() => { try { return localStorage.getItem('ft-pip') === '1' } catch { return false } })
  const [pipRadius, setPipRadius] = useState<number>(() => { try { const n = Number(localStorage.getItem('ft-pip-r') || '80'); return Number.isFinite(n) && n > 5 ? n : 80 } catch { return 80 } })
  const [holdMinTurn, setHoldMinTurn] = useState<number>(() => lsGet('ft-hold-turn', 360))
  const [holdMaxRadius, setHoldMaxRadius] = useState<number>(() => lsGet('ft-hold-rad', 10))
  const [holdMinSpan, setHoldMinSpan] = useState<number>(() => lsGet('ft-hold-span', 120))
  const [showEventLog, setShowEventLog] = useState<boolean>(() => lsGet('ft-evlog', false))
  const [events, setEvents] = useState<LogEvent[]>([])
  const [evEnabled, setEvEnabled] = useState<Set<EventKind>>(() => {
    try {
      const raw = localStorage.getItem('ft-evlog-kinds')
      if (raw) return new Set(JSON.parse(raw) as EventKind[])
    } catch {}
    return new Set<EventKind>(['takeoff','landing','emergency','watch','climb','descend','fast'])
  })
  const evSnapshotRef = useRef<Map<string, SnapshotEntry>>(new Map())
  const [conflictLat, setConflictLat] = useState<number>(() => lsGet('ft-cflx-lat', 5))
  const [conflictVert, setConflictVert] = useState<number>(() => lsGet('ft-cflx-vert', 1000))
  const [conflictGround, setConflictGround] = useState<boolean>(() => lsGet('ft-cflx-grd', false))
  const [selectedAirport, setSelectedAirport] = useState<AirportPin | null>(null)
  const [airportMetar, setAirportMetar] = useState<{rawOb:string; temp:number; dewp:number; wdir:number; wspd:number; visib:string; altim:number; fltCat:string; clouds?:{cover:string;base:number}[]} | null>(null)
  const [mapZoom, setMapZoom] = useState(4)
  const [mapCenter, setMapCenter] = useState<{lng:number; lat:number}>({lng: 0, lat: 20})
  const [mapBounds, setMapBounds] = useState<{n:number,s:number,e:number,w:number} | null>(null)
  const [toasts, setToasts] = useState<{id:string; icao:string; cs:string; sq:string; lat:number; lng:number; t:number}[]>([])
  const knownEmergRef = useRef<Set<string>>(new Set())
  const [route, setRoute] = useState<Route | null>(null)
  const [photo, setPhoto] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading'|'live'|'error'>('loading')
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [query, setQuery] = useState('')
  const PREFS_KEY = 'ft-prefs-v1'
  const WATCH_KEY = 'ft-watch-v1'
  const loadPrefs = (): Record<string, boolean> => {
    if (typeof window === 'undefined') return {}
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') } catch { return {} }
  }
  const prefs = loadPrefs()
  const [showWeather, setShowWeather] = useState(prefs.showWeather ?? false)
  const [showTrails, setShowTrails] = useState(prefs.showTrails ?? true)
  const [showNight, setShowNight] = useState(prefs.showNight ?? true)
  const [showList, setShowList] = useState(prefs.showList ?? false)
  const [showHeat, setShowHeat] = useState(prefs.showHeat ?? false)
  const [show3D, setShow3D] = useState<boolean>((prefs as any).show3D ?? false)
  const [chase, setChase] = useState<boolean>(false)
  const chaseRef = useRef(false)
  useEffect(() => { chaseRef.current = chase && !!selectedIcaoRef.current }, [chase])
  const [watchlist, setWatchlist] = useState<string[]>(() => {
    if (typeof window === 'undefined') return []
    try { return JSON.parse(localStorage.getItem(WATCH_KEY) || '[]') } catch { return [] }
  })
  const [showWatch, setShowWatch] = useState(false)
  const [watchInput, setWatchInput] = useState('')
  const [shareCopied, setShareCopied] = useState(false)
  const [compareList, setCompareList] = useState<Flight[]>([])
  const [showCompare, setShowCompare] = useState(false)
  const knownWatchRef = useRef<Set<string>>(new Set())
  const [showFilters, setShowFilters] = useState(false)
  const [showStats, setShowStats] = useState(false)
  const [showLayers, setShowLayers] = useState(false)
  const activeLayerCount = [showHeat,chase,showWatch,showStats,showRadar,showEmissions,showConflict,showOverhead,showSun,showHolding,showFormation,showCpa,showDiversion,showVProfile,showTcas,showWake,showContrail,showAtlas,showVip,showFlow,showRecords,showShadow,showDoppler,showAprSeq,showPass,showNoise,showTod,showTripwire,showGeofence,showVoronoi,showSunGlare,showAnomaly,showGlide,showCoffin,showCompareStudio,showSymphony,showTimeMachine,showReach,showTrip,showEventLog,showLadder,showPhase,showCockpit,showRuler,showBullseye,showWinds,showBoard,showScatter,showSquawk,showRace,showDensity,showRoute,showSua,showShear,showCosmic,showHypoxia,showStepClimb,showEtops,showDepSeq,showXwind,showJet,showHstack,showIcing,showCurfew,showMtnWave,showBird,showAsh,showRaim,showOcean,showE6b,showMetar,showCells,showSar,showStable,showFir,showFirX,showRwyCfg,showEnergy].filter(Boolean).length + (showCostIdx?1:0) + (showTaf?1:0) + (showToc?1:0) + (showCabin?1:0) + (showApMin?1:0) + (showFuelTemp?1:0) + (showNavaid?1:0) + (showDrift?1:0) + (showReserve?1:0) + (showTurb?1:0) + (showCrew?1:0) + (showNordo?1:0) + (showTerrain?1:0) + (showMass?1:0) + (showMagVar?1:0) + (showCda?1:0) + (showSidc?1:0) + (showRvsm?1:0) + (showSpdLim?1:0) + (showBoom?1:0) + (showRnp?1:0) + (showTank?1:0) + (showWkld?1:0) + (showGnss?1:0) + (showCpdlc?1:0) + (showLbust?1:0) + (showOzone?1:0) + (showAdsbq?1:0) + (showEtp?1:0) + (showRta?1:0) + (showSatcom?1:0) + (showBrake?1:0) + (showMapp?1:0) + (showVhf?1:0) + (showSpwx?1:0) + (showFoqa?1:0) + (showEgt?1:0) + (showPolar?1:0) + (showLibat?1:0) + (showRexhyd?1:0) + (showCgTrim?1:0) + (showOwl?1:0) + (showNadp?1:0) + (showRecat?1:0) + (showUas?1:0) + (showBleed?1:0) + (showDeice?1:0) + (showPstatic?1:0) + (showFlutter?1:0) + (showStall?1:0) + (showTailStrike?1:0) + (showTaws?1:0) + (showCtot?1:0) + (showRera?1:0) + (showEai?1:0) + (showTold?1:0) + (showRelight?1:0) + (showHotsec?1:0) + (showLhirf?1:0) + (showAdiz?1:0) + (showEgress?1:0) + (showNotam?1:0) + (showRadalt5g?1:0) + (showCtAlt?1:0)
  const [mobileMenu, setMobileMenu] = useState(false)
  const [mobileSearch, setMobileSearch] = useState(false)
  const [fabOpen, setFabOpen] = useState(false)
  const [welcome, setWelcome] = useState(false)
  const [about, setAbout] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!localStorage.getItem('ft-onboarded')) setWelcome(true)
  }, [])
  const [follow, setFollow] = useState(false)
  const [altMin, setAltMin] = useState(0)
  const [altMax, setAltMax] = useState(50000)
  const [spdMin, setSpdMin] = useState(0)
  const [onlyMil, setOnlyMil] = useState(false)
  const [onlyEmerg, setOnlyEmerg] = useState(false)
  const [hideGround, setHideGround] = useState(false)
  const [airlinePrefix, setAirlinePrefix] = useState('')
  const [listSort, setListSort] = useState<'callsign'|'alt'|'spd'>('alt')
  type Units = { alt: 'ft'|'m'; spd: 'kt'|'mph'|'kmh' }
  const [units, setUnits] = useState<Units>(() => {
    if (typeof window === 'undefined') return { alt: 'ft', spd: 'kt' }
    try { return JSON.parse(localStorage.getItem('ft-units-v1') || '') as Units } catch { return { alt: 'ft', spd: 'kt' } }
  })
  useEffect(() => { try { localStorage.setItem('ft-units-v1', JSON.stringify(units)) } catch {} }, [units])
  // Keep map scale bar in sync with speed unit choice
  useEffect(() => {
    const ctl = (mapRef as any).__scaleCtl as maplibregl.ScaleControl | undefined
    if (!ctl) return
    const u: 'nautical'|'metric'|'imperial' = units.spd==='kt'?'nautical':units.spd==='mph'?'imperial':'metric'
    try { ctl.setUnit(u) } catch {}
  }, [units.spd])
  const [colorBy, setColorBy] = useState<'alt'|'spd'|'cat'|'mil'>(() => {
    if (typeof window === 'undefined') return 'alt'
    return (localStorage.getItem('ft-colorby-v1') as any) || 'alt'
  })
  useEffect(() => { try { localStorage.setItem('ft-colorby-v1', colorBy) } catch {} }, [colorBy])
  const [mapStyle, setMapStyle] = useState<'dark'|'light'|'sat'>(() => {
    if (typeof window === 'undefined') return 'dark'
    return (localStorage.getItem('ft-mapstyle-v1') as any) || 'dark'
  })
  const [showHelp, setShowHelp] = useState(false)
  const [showStyles, setShowStyles] = useState(false)
  const [audioOn, setAudioOn] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('ft-audio-v1') === '1'
  })
  useEffect(() => { try { localStorage.setItem('ft-audio-v1', audioOn ? '1' : '0') } catch {} }, [audioOn])
  const audioOnRef = useRef(audioOn); useEffect(() => { audioOnRef.current = audioOn }, [audioOn])
  const [userLoc, setUserLoc] = useState<{lat:number; lng:number} | null>(null)
  const [emergLog, setEmergLog] = useState<{icao:string; cs:string; sq:string; lat:number; lng:number; t:number}[]>([])
  const [showEmergLog, setShowEmergLog] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  // [BATCH-C] preference hook
  const batchCPrefs = useBatchCPrefs()

  // [BATCH-A] persist last selected icao + restore on mount, full URL state, watchlist chime, page-vis pause hint
  const lastIcaoLoadedRef = useRef(false)
  useEffect(() => {
    if (selected) { try { localStorage.setItem('ft-last-icao', selected.icao) } catch {} }
  }, [selected])
  useEffect(() => {
    if (lastIcaoLoadedRef.current) return
    if (flights.length === 0) return
    lastIcaoLoadedRef.current = true
    try {
      const last = localStorage.getItem('ft-last-icao')
      const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('icao')
      const icao = (fromHash || last || '').toLowerCase()
      if (!icao || selectedIcaoRef.current) return
      const f = flights.find(x => x.icao === icao)
      if (f) setSelected(f)
    } catch {}
  }, [flights])

  // chime on watchlist hit (debounced per icao, 60s)
  const watchHitsRef = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    // Event log detection — runs on every flights update
    if (!flights.length) return
    const snap: SnapshotEntry[] = flights.map(f => ({
      icao: f.icao, callsign: f.callsign, altitudeFt: f.altitudeFt, ground: f.ground,
      mach: f.mach || 0, squawk: f.squawk || '', lat: f.lat, lng: f.lng,
    }))
    const wlSet = new Set(watchlist.map(w => w.toUpperCase()))
    const isW = (icao: string, cs: string) => {
      const I = icao.toUpperCase(), C = (cs || '').toUpperCase()
      if (wlSet.has(I) || wlSet.has(C)) return true
      for (const w of wlSet) if (C.startsWith(w) && w.length >= 3) return true
      return false
    }
    const newEvts = detectEvents(evSnapshotRef.current, snap, isW)
    if (newEvts.length) {
      setEvents(prev => {
        const merged = [...newEvts.reverse(), ...prev]
        return merged.slice(0, 500)
      })
    }
    const m = new Map<string, SnapshotEntry>()
    for (const s of snap) m.set(s.icao, s)
    evSnapshotRef.current = m
  }, [flights, watchlist])

  useEffect(() => {
    if (!flights.length || !watchlist.length) return
    const now = Date.now()
    const wl = new Set(watchlist.map(w => w.toLowerCase()))
    for (const f of flights) {
      const cs = (f.callsign || '').toLowerCase()
      const ic = f.icao.toLowerCase()
      if (wl.has(cs) || wl.has(ic)) {
        const last = watchHitsRef.current.get(ic) || 0
        if (now - last > 60000) {
          watchHitsRef.current.set(ic, now)
          playRadioChirp()
        }
      }
    }
  }, [flights, watchlist])

  // emergency audio: integrate new audio module (gated by ft-mute/ft-volume)
  const emergChimedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const e of emergLog) {
      if (!emergChimedRef.current.has(e.icao)) {
        emergChimedRef.current.add(e.icao)
        playEmergencyChime()
      }
    }
  }, [emergLog])

  // expand URL hash to include zoom/lat/lng/style/follow/units (read by Share, kept fresh)
  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    const sync = () => {
      try {
        const c = m.getCenter(), z = m.getZoom()
        const q = new URLSearchParams(window.location.hash.replace(/^#/, ''))
        q.set('lat', c.lat.toFixed(3)); q.set('lng', c.lng.toFixed(3)); q.set('z', String(Math.round(z)))
        q.set('style', mapStyle); q.set('follow', follow ? '1' : '0')
        q.set('au', units.alt); q.set('su', units.spd)
        if (selected) q.set('icao', selected.icao); else q.delete('icao')
        window.history.replaceState(null, '', `#${q.toString()}`)
      } catch {}
    }
    let raf = 0
    const onMove = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(sync) }
    m.on('moveend', onMove); sync()
    return () => { m.off('moveend', onMove); cancelAnimationFrame(raf) }
  }, [mapReady, mapStyle, follow, units, selected])

  // persist filters + follow + style audit
  useEffect(() => {
    try {
      localStorage.setItem('ft-filters-v1', JSON.stringify({
        altMin, altMax, spdMin, onlyMil, onlyEmerg, hideGround, airlinePrefix, listSort,
      }))
    } catch {}
  }, [altMin, altMax, spdMin, onlyMil, onlyEmerg, hideGround, airlinePrefix, listSort])
  useEffect(() => {
    if (!lastIcaoLoadedRef.current) return
    try {
      const raw = localStorage.getItem('ft-filters-v1')
      if (!raw) return
      const f = JSON.parse(raw)
      if (typeof f.altMin === 'number') setAltMin(f.altMin)
      if (typeof f.altMax === 'number') setAltMax(f.altMax)
      if (typeof f.spdMin === 'number') setSpdMin(f.spdMin)
      if (typeof f.onlyMil === 'boolean') setOnlyMil(f.onlyMil)
      if (typeof f.onlyEmerg === 'boolean') setOnlyEmerg(f.onlyEmerg)
      if (typeof f.hideGround === 'boolean') setHideGround(f.hideGround)
      if (typeof f.airlinePrefix === 'string') setAirlinePrefix(f.airlinePrefix)
      if (typeof f.listSort === 'string') setListSort(f.listSort)
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastIcaoLoadedRef.current])
  useEffect(() => { try { localStorage.setItem('ft-follow', follow ? '1' : '0') } catch {} }, [follow])
  useEffect(() => {
    try { if (localStorage.getItem('ft-follow') === '1') setFollow(true) } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // reduced motion + high contrast CSS injection (idempotent)
  useEffect(() => {
    if (typeof document === 'undefined') return
    if (document.getElementById('ft-batch-a-style')) return
    const s = document.createElement('style')
    s.id = 'ft-batch-a-style'
    s.textContent = `
      :root { --ft-font-size: 14px; }
      /* FONT SIZE — actually scale the whole UI */
      html[data-fontsize="S"] { font-size: 13px; }
      html[data-fontsize="M"] { font-size: 15px; }
      html[data-fontsize="L"] { font-size: 17px; }
      html[data-fontsize="S"] .ft-scale { font-size: 12px; }
      html[data-fontsize="L"] .ft-scale { font-size: 16px; }
      /* HIGH CONTRAST — punch up borders + text */
      html[data-contrast="high"] body { filter: contrast(1.25) saturate(1.2); }
      html[data-contrast="high"] *, html[data-contrast="high"] *::before, html[data-contrast="high"] *::after {
        border-color: currentColor !important;
      }
      html[data-contrast="high"] .text-slate-400, html[data-contrast="high"] .text-slate-500 { color: #e2e8f0 !important; }
      /* LIGHT THEME — repaint chrome (header, panels, cards) */
      html[data-theme="light"] body { background: #f1f5f9; color: #0f172a; }
      html[data-theme="light"] .bg-\\[\\#07090d\\],
      html[data-theme="light"] .bg-slate-950,
      html[data-theme="light"] .bg-slate-900,
      html[data-theme="light"] .bg-slate-900\\/95,
      html[data-theme="light"] .bg-slate-900\\/90,
      html[data-theme="light"] .bg-slate-900\\/80,
      html[data-theme="light"] .bg-slate-800,
      html[data-theme="light"] .bg-slate-800\\/90,
      html[data-theme="light"] .bg-slate-800\\/80 { background-color: rgba(248,250,252,0.95) !important; color: #0f172a !important; }
      html[data-theme="light"] .text-white, html[data-theme="light"] .text-slate-100, html[data-theme="light"] .text-slate-200, html[data-theme="light"] .text-slate-300 { color: #0f172a !important; }
      html[data-theme="light"] .text-slate-400 { color: #475569 !important; }
      html[data-theme="light"] .border-slate-800, html[data-theme="light"] .border-slate-700 { border-color: #cbd5e1 !important; }
      .ft-focus:focus-visible { outline: 2px solid rgb(14 165 233) !important; outline-offset: 2px; }
      @media (prefers-reduced-motion: reduce) {
        .animate-pulse, .animate-spin, .transition-transform, .transition-colors { animation: none !important; transition: none !important; }
      }
    `
    document.head.appendChild(s)
  }, [])


  const selectedIcaoRef = useRef<string | null>(null)
  const initialFocusRef = useRef<string | null>(null)
  const flightsRef = useRef<Flight[]>([])
  useEffect(() => { flightsRef.current = flights }, [flights])

  /* ---- Airport markers cache (MapLibre Markers for tooltip+click ergonomics) ---- */
  const airportMarkersRef = useRef<Map<string, maplibregl.Marker>>(new Map())

  /* ---- Helper: pan/fly using MapLibre semantics ---- */
  const flyToLatLng = useCallback((lat: number, lng: number, zoom?: number) => {
    const m = mapRef.current; if (!m) return
    if (zoom != null) m.flyTo({ center: [lng, lat], zoom })
    else m.flyTo({ center: [lng, lat] })
  }, [])

  /* ---- Init map ---- */
  useEffect(() => {
    if (!mapEl.current || mapRef.current) return

    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const lat = parseFloat(params.get('lat') || '40.7')
    const lng = parseFloat(params.get('lng') || '-74')
    const zoom = parseInt(params.get('z') || '6', 10)
    const focusIcao = params.get('icao')
    if (focusIcao) initialFocusRef.current = focusIcao.toLowerCase()

    const map = new maplibregl.Map({
      container: mapEl.current,
      center: [lng, lat],
      zoom,
      minZoom: 2,
      maxZoom: 16,
      pitch: prefs.show3D ? 60 : 0,
      maxPitch: 75,
      attributionControl: false,
      style: {
        version: 8,
        sources: {
          'carto-dark': {
            type: 'raster',
            tiles: [
              'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
              'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
              'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
              'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
            ],
            tileSize: 256,
            attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> · <a href="https://carto.com/attributions">CARTO</a> · <a href="https://adsb.lol">adsb.lol</a> · <a href="https://www.planespotters.net">planespotters</a> · <a href="https://rainviewer.com">RainViewer</a> · <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain</a>',
          },
          'terrain-dem': {
            type: 'raster-dem',
            tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
            tileSize: 256,
            encoding: 'terrarium',
            maxzoom: 14,
          },
        },
        layers: [
          { id: 'basemap', type: 'raster', source: 'carto-dark' },
          { id: 'hillshade', type: 'hillshade', source: 'terrain-dem',
            paint: { 'hillshade-shadow-color': '#000010', 'hillshade-highlight-color': '#3b4f7a', 'hillshade-exaggeration': 0.5 },
            layout: { visibility: 'none' } },
        ],
      },
    })

    map.addControl(new maplibregl.AttributionControl({ compact: true }))
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true }), 'bottom-right')
    const scaleUnit: 'nautical'|'metric'|'imperial' = units.spd==='kt'?'nautical':units.spd==='mph'?'imperial':'metric'
    const scaleCtl = new maplibregl.ScaleControl({ maxWidth: 120, unit: scaleUnit })
    map.addControl(scaleCtl, 'bottom-left')
    ;(mapRef as any).__scaleCtl = scaleCtl
    map.dragRotate.enable()
    map.touchZoomRotate.enableRotation()

    mapRef.current = map

    map.on('load', () => {
      // Pre-generate plane icons
      for (const color of ICON_COLORS) {
        for (const heli of [false, true]) {
          for (const sel of [false, true]) {
            const id = iconKey(color, heli, sel)
            if (!map.hasImage(id)) {
              map.addImage(id, drawIcon(color, heli, sel), { pixelRatio: 2 })
            }
          }
        }
      }

      // Sources
      map.addSource('terminator', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addSource('weather', { type: 'raster', tiles: [], tileSize: 256 } as any)
      map.addSource('trails', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addSource('routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addSource('route-points', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addSource('planes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addSource('alt-columns', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addSource('conflicts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addSource('holding', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addSource('formations', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addSource('cpa', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })

      // Sky / atmosphere (only renders when pitched)
      try {
        map.setSky({
          'sky-color': '#0b1424',
          'horizon-color': '#1e3a5f',
          'fog-color': '#0b1424',
          'sky-horizon-blend': 0.6,
          'horizon-fog-blend': 0.6,
          'fog-ground-blend': 0.5,
          'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 12, 0],
        } as any)
      } catch {}

      // Day/night fill (above basemap, below everything else)
      map.addLayer({
        id: 'terminator-layer',
        type: 'fill',
        source: 'terminator',
        paint: { 'fill-color': '#000010', 'fill-opacity': 0.35 },
      })

      // Weather raster (initially hidden)
      map.addLayer({
        id: 'weather-layer',
        type: 'raster',
        source: 'weather',
        paint: { 'raster-opacity': 0.55 },
        layout: { visibility: 'none' },
      })

      // Heatmap (driven by planes source, ground filtered out)
      map.addLayer({
        id: 'heat-layer',
        type: 'heatmap',
        source: 'planes',
        filter: ['!=', ['get', 'ground'], true],
        layout: { visibility: 'none' },
        paint: {
          'heatmap-weight': 1,
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 1, 9, 3],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 12, 9, 30],
          'heatmap-opacity': 0.7,
          'heatmap-color': [
            'interpolate', ['linear'], ['heatmap-density'],
            0, 'rgba(0,0,0,0)',
            0.2, 'rgba(255,80,40,0.4)',
            0.5, 'rgba(255,180,40,0.6)',
            0.75, 'rgba(120,220,80,0.75)',
            1, 'rgba(80,180,255,0.9)',
          ],
        },
      })

      // Trails
      map.addLayer({
        id: 'trails-layer',
        type: 'line',
        source: 'trails',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['case', ['==', ['get', 'sel'], true], 3, 1.2],
          'line-opacity': ['case', ['==', ['get', 'sel'], true], 0.95, 0.55],
        },
      })

      // Routes
      map.addLayer({
        id: 'routes-layer',
        type: 'line',
        source: 'routes',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['get', 'width'],
          'line-opacity': ['get', 'opacity'],
          'line-dasharray': ['case',
            ['==', ['get', 'dashed'], true], ['literal', [2, 2]],
            ['literal', [1]],
          ],
        },
      })
      map.addLayer({
        id: 'route-points-layer',
        type: 'circle',
        source: 'route-points',
        paint: {
          'circle-radius': 5,
          'circle-color': ['get', 'color'],
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-width': 2,
          'circle-opacity': 0.45,
        },
      })

      // Conflict pair lines (rendered beneath planes, above routes)
      map.addLayer({
        id: 'conflicts-line',
        type: 'line',
        source: 'conflicts',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['case', ['==', ['get', 'sev'], 'critical'], 3, ['==', ['get', 'sev'], 'warning'], 2.2, 1.4],
          'line-opacity': 0.9,
          'line-dasharray': ['case', ['==', ['get', 'sev'], 'advisory'], ['literal', [2, 2]], ['literal', [1]]],
        },
      })
      map.addLayer({
        id: 'conflicts-mid',
        type: 'circle',
        source: 'conflicts',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': ['case', ['==', ['get', 'sev'], 'critical'], 7, ['==', ['get', 'sev'], 'warning'], 5, 3.5],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#0b1220',
          'circle-stroke-width': 1.5,
          'circle-opacity': 0.85,
        },
      })

      // Holding pattern footprints
      map.addLayer({
        id: 'holding-fill',
        type: 'fill',
        source: 'holding',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': 0.10,
        },
      })
      map.addLayer({
        id: 'holding-outline',
        type: 'line',
        source: 'holding',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 1.5,
          'line-dasharray': [3, 2],
          'line-opacity': 0.85,
        },
      })
      map.addLayer({
        id: 'holding-center',
        type: 'circle',
        source: 'holding',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 4,
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#0b1220',
          'circle-stroke-width': 1.5,
        },
      })

      // Formation overlays (convex hull fill + edges + leader pin + label)
      map.addLayer({
        id: 'formations-fill',
        type: 'fill',
        source: 'formations',
        filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', 'kind'], 'hull']],
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': 0.14,
        },
      })
      map.addLayer({
        id: 'formations-outline',
        type: 'line',
        source: 'formations',
        filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', 'kind'], 'hull']],
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 1.4,
          'line-opacity': 0.85,
        },
      })
      map.addLayer({
        id: 'formations-edges',
        type: 'line',
        source: 'formations',
        filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'kind'], 'edge']],
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 1.2,
          'line-opacity': 0.7,
          'line-dasharray': [2, 2],
        },
      })
      map.addLayer({
        id: 'formations-leader',
        type: 'circle',
        source: 'formations',
        filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'kind'], 'leader']],
        paint: {
          'circle-radius': 7,
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#0b1220',
          'circle-stroke-width': 2,
          'circle-opacity': 0.95,
        },
      })
      map.addLayer({
        id: 'formations-label',
        type: 'symbol',
        source: 'formations',
        filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'kind'], 'label']],
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 11,
          'text-font': ['Noto Sans Bold'],
          'text-offset': [0, -1.4],
          'text-allow-overlap': false,
        } as any,
        paint: {
          'text-color': ['get', 'color'],
          'text-halo-color': '#0b1220',
          'text-halo-width': 1.5,
        },
      })

      // CPA predictor overlays (predicted tracks, CPA midpoint, miss line)
      map.addLayer({
        id: 'cpa-track',
        type: 'line',
        source: 'cpa',
        filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'kind'], 'track']],
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 1.4,
          'line-opacity': 0.75,
          'line-dasharray': [3, 2],
        },
      })
      map.addLayer({
        id: 'cpa-miss',
        type: 'line',
        source: 'cpa',
        filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'kind'], 'miss']],
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 2.2,
          'line-opacity': 0.9,
        },
      })
      map.addLayer({
        id: 'cpa-mid',
        type: 'circle',
        source: 'cpa',
        filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'kind'], 'mid']],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'sev'], 0, 9, 3, 4],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#0b1220',
          'circle-stroke-width': 2,
          'circle-opacity': 0.9,
        },
      })
      map.addLayer({
        id: 'cpa-label',
        type: 'symbol',
        source: 'cpa',
        filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'kind'], 'mid']],
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 10,
          'text-font': ['Noto Sans Bold'],
          'text-offset': [0, 1.2],
          'text-allow-overlap': false,
        } as any,
        paint: {
          'text-color': ['get', 'color'],
          'text-halo-color': '#0b1220',
          'text-halo-width': 1.5,
        },
      })
      map.addLayer({
        id: 'planes-layer',
        type: 'symbol',
        source: 'planes',
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-rotate': ['get', 'track'],
          'icon-rotation-alignment': 'map',
          'icon-pitch-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-size': 1,
          'symbol-z-elevate': true,
        } as any,
      })

      // Altitude columns (3D fill-extrusion ground→aircraft, shown only when 3D pitched)
      map.addLayer({
        id: 'alt-columns-layer',
        type: 'fill-extrusion',
        source: 'alt-columns',
        layout: { visibility: 'none' },
        paint: {
          'fill-extrusion-color': ['get', 'color'],
          'fill-extrusion-base': 0,
          'fill-extrusion-height': ['get', 'h'],
          'fill-extrusion-opacity': 0.35,
        },
      })

      // Click handler
      map.on('click', 'planes-layer', (e) => {
        const f0 = e.features?.[0]; if (!f0) return
        const icao = (f0.properties as any).icao as string
        const flt = flightsRef.current.find((x) => x.icao === icao)
        if (flt) { setSelected(flt); setSelectedAirport(null) }
      })
      map.on('mouseenter', 'planes-layer', () => { map.getCanvas().style.cursor = 'pointer' })
      map.on('mouseleave', 'planes-layer', () => { map.getCanvas().style.cursor = '' })

      mapReadyRef.current = true
      setMapReady(true)
    })

    // URL + bounds sync
    const saveUrl = () => {
      const c = map.getCenter()
      const b = map.getBounds()
      const q = new URLSearchParams()
      q.set('lat', c.lat.toFixed(3))
      q.set('lng', c.lng.toFixed(3))
      q.set('z', String(Math.round(map.getZoom())))
      if (selectedIcaoRef.current) q.set('icao', selectedIcaoRef.current)
      window.history.replaceState(null, '', `#${q.toString()}`)
      setMapZoom(map.getZoom())
      setMapCenter({ lng: c.lng, lat: c.lat })
      setMapBounds({ n: b.getNorth(), s: b.getSouth(), e: b.getEast(), w: b.getWest() })
    }
    map.on('moveend', saveUrl)
    map.on('zoomend', saveUrl)
    map.once('load', saveUrl)

    const fixSize = () => map.resize()
    const t1 = setTimeout(fixSize, 250)
    const t2 = setTimeout(fixSize, 800)
    window.addEventListener('resize', fixSize)
    return () => {
      clearTimeout(t1); clearTimeout(t2)
      window.removeEventListener('resize', fixSize)
      map.remove(); mapRef.current = null
      mapReadyRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    selectedIcaoRef.current = selected?.icao ?? null
    const q = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    if (selected) q.set('icao', selected.icao); else q.delete('icao')
    window.history.replaceState(null, '', `#${q.toString()}`)
    if (typeof document !== 'undefined') {
      document.title = selected ? `${selected.callsign} · ${selected.type} · Flight Tracker` : 'Flight Tracker'
    }
  }, [selected])

  /* ---- 3D pitch + terrain + extrusions toggle ---- */
  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    if (show3D) {
      try { m.setTerrain({ source: 'terrain-dem', exaggeration: 1.4 } as any) } catch {}
      if (m.getLayer('hillshade')) m.setLayoutProperty('hillshade', 'visibility', 'visible')
      if (m.getLayer('alt-columns-layer')) m.setLayoutProperty('alt-columns-layer', 'visibility', 'visible')
      m.easeTo({ pitch: 70, bearing: m.getBearing(), duration: 800 })
    } else {
      try { m.setTerrain(null as any) } catch {}
      if (m.getLayer('hillshade')) m.setLayoutProperty('hillshade', 'visibility', 'none')
      if (m.getLayer('alt-columns-layer')) m.setLayoutProperty('alt-columns-layer', 'visibility', 'none')
      m.easeTo({ pitch: 0, duration: 600 })
    }
  }, [show3D, mapReady])

  /* ---- Weather radar (RainViewer) ---- */
  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    if (showWeather) {
      ;(async () => {
        try {
          const r = await fetch('https://api.rainviewer.com/public/weather-maps.json')
          const j = await r.json() as { host: string; radar: { past: Array<{ time: number; path: string }> } }
          const past = j.radar.past
          const latest = past[past.length - 1]
          const url = `${j.host}${latest.path}/256/{z}/{x}/{y}/2/1_1.png`
          const src = m.getSource('weather') as any
          // Recreate the source to swap tile URL
          if (m.getLayer('weather-layer')) m.removeLayer('weather-layer')
          if (m.getSource('weather')) m.removeSource('weather')
          m.addSource('weather', { type: 'raster', tiles: [url], tileSize: 256 } as any)
          const before = m.getLayer('terminator-layer') ? 'terminator-layer' : undefined
          m.addLayer({
            id: 'weather-layer', type: 'raster', source: 'weather',
            paint: { 'raster-opacity': 0.55 },
          }, before)
          void src
        } catch (e) { console.error('weather fail', e) }
      })()
    } else {
      if (m.getLayer('weather-layer')) m.setLayoutProperty('weather-layer', 'visibility', 'none')
    }
  }, [showWeather, mapReady])

  /* ---- Day/Night terminator ---- */
  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    const apply = () => {
      const src = m.getSource('terminator') as maplibregl.GeoJSONSource | undefined
      if (!src) return
      if (!showNight) { src.setData({ type: 'FeatureCollection', features: [] } as any); return }
      const pts = terminatorPolygon(new Date()).map(([lat, lng]) => [lng, lat])
      const geo: any = {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature', properties: {},
          geometry: { type: 'Polygon', coordinates: [pts] },
        }],
      }
      src.setData(geo)
    }
    apply()
    const id = setInterval(apply, 5 * 60_000)
    return () => clearInterval(id)
  }, [showNight, mapReady])

  /* ---- Airport METAR weather fetch ---- */
  useEffect(() => {
    if (!selectedAirport) { setAirportMetar(null); return }
    const ap = selectedAirport
    setAirportMetar(null)
    let cancelled = false
    ;(async () => {
      try {
        const target = `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(ap.i)}&format=json`
        const res = await fetch(`https://corsproxy.io/?${encodeURIComponent(target)}`, { cache: 'no-store' })
        if (!res.ok) return
        const arr = await res.json() as Array<{rawOb:string; temp:number; dewp:number; wdir:number; wspd:number; visib:string; altim:number; fltCat:string; clouds?:{cover:string;base:number}[]}>
        if (cancelled || !arr?.length) return
        setAirportMetar(arr[0])
      } catch { /* swallow */ }
    })()
    return () => { cancelled = true }
  }, [selectedAirport])

  /* ---- Fetch loop ---- */
  const fetchOnce = useCallback(async () => {
    try {
      const m = mapRef.current
      let lat = 40.7, lon = -74, distNm = 250
      const tiles: Array<{lat:number; lon:number; dist:number}> = []
      if (m) {
        const c = m.getCenter()
        lat = c.lat; lon = c.lng
        const b = m.getBounds()
        const halfH = (b.getNorth() - b.getSouth()) / 2 * 60
        const halfW = (b.getEast() - b.getWest()) / 2 * 60 * Math.cos(lat * Math.PI / 180)
        const maxHalf = Math.max(halfH, halfW)
        // adsb.lol caps payload at ~dist=2000nm. If viewport demands more, tile it.
        const CAP = 1800
        if (maxHalf * 1.15 <= CAP) {
          distNm = Math.max(50, Math.ceil(maxHalf * 1.15))
        } else {
          // tile the visible bounds into a grid of ~CAP-sized chunks
          const dLat = (CAP * 2) / 60                         // nm -> deg lat
          const south = b.getSouth(), north = b.getNorth()
          const west  = b.getWest(),  east  = b.getEast()
          for (let la = south; la < north; la += dLat) {
            const midLa = Math.min(north, la + dLat/2)
            const dLon = (CAP * 2) / (60 * Math.cos(midLa * Math.PI / 180))
            for (let lo = west; lo < east; lo += dLon) {
              tiles.push({
                lat: Math.min(north, la + dLat/2),
                lon: Math.min(east, lo + dLon/2),
                dist: CAP,
              })
            }
          }
          // safety: cap to 12 parallel calls
          if (tiles.length > 12) tiles.length = 12
        }
      }

      let raw: AcRaw[] = []
      if (tiles.length) {
        const results = await Promise.all(tiles.map(async t => {
          try {
            const target = `https://api.adsb.lol/v2/lat/${t.lat.toFixed(4)}/lon/${t.lon.toFixed(4)}/dist/${t.dist}`
            const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(target)}`, { cache: 'no-store' })
            if (!r.ok) return [] as AcRaw[]
            const j = await r.json() as { ac?: AcRaw[] }
            return j.ac ?? []
          } catch { return [] as AcRaw[] }
        }))
        const seen = new Set<string>()
        for (const arr of results) for (const a of arr) {
          if (a.hex && !seen.has(a.hex)) { seen.add(a.hex); raw.push(a) }
        }
      } else {
        const target = `https://api.adsb.lol/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${distNm}`
        const res = await fetch(`https://corsproxy.io/?${encodeURIComponent(target)}`, { cache: 'no-store' })
        if (!res.ok) throw new Error(`adsb.lol HTTP ${res.status}`)
        const json = await res.json() as { ac?: AcRaw[] }
        raw = json.ac ?? []
      }
      const parsed: Flight[] = raw
        .filter(a => typeof a.lat === 'number' && typeof a.lon === 'number')
        .map(a => {
          const ground = a.alt_baro === 'ground'
          const altFt = ground ? 0 : (typeof a.alt_geom === 'number' ? a.alt_geom : (typeof a.alt_baro === 'number' ? a.alt_baro : 0))
          const sq = a.squawk || ''
          const emergency = !!a.emergency && a.emergency !== 'none' || sq === '7500' || sq === '7600' || sq === '7700'
          const military = !!(a.desc && /\b(USAF|NAVY|ARMY|MARINE|FORCE|MIL|RAF|JASDF)\b/i.test(a.desc)) ||
                           !!(a.r && /^\d+-\d+/.test(a.r))
          return {
            icao: a.hex,
            callsign: (a.flight || '').trim() || a.r || a.hex.toUpperCase(),
            registration: a.r || '—',
            type: a.t || a.desc || '—',
            dataSource: a.type || 'unknown',
            operator: a.ownOp || '—',
            lng: a.lon, lat: a.lat,
            altitudeFt: altFt, ground,
            velocityKts: a.gs ?? 0,
            ias: a.ias ?? 0,
            mach: a.mach ?? 0,
            vertRate: a.geom_rate ?? a.baro_rate ?? 0,
            navAlt: a.nav_altitude_mcp ?? 0,
            windDir: a.wd ?? 0,
            windKts: a.ws ?? 0,
            oat: typeof a.oat === 'number' ? a.oat : NaN,
            track: a.track ?? 0,
            squawk: sq, category: a.category || '',
            emergency, military: military || !!(a.dbFlags && (a.dbFlags & 1)),
          }
        })
      const now = Date.now()
      for (const f of parsed) {
        const t = trailsRef.current.get(f.icao) || []
        const last = t[t.length - 1]
        if (!last || last[0] !== f.lat || last[1] !== f.lng) {
          t.push([f.lat, f.lng, now])
          if (t.length > TRAIL_MAX) t.shift()
          trailsRef.current.set(f.icao, t)
        }
      }
      const seen = new Set(parsed.map(f => f.icao))
      for (const [k, t] of trailsRef.current) {
        const lastTs = t[t.length - 1]?.[2] || 0
        if (!seen.has(k) && now - lastTs > 5 * 60_000) trailsRef.current.delete(k)
      }
      setFlights(parsed)
      setStatus('live')
      setLastUpdate(new Date())

      if (initialFocusRef.current) {
        const f = parsed.find(x => x.icao.toLowerCase() === initialFocusRef.current)
        if (f) setSelected(f)
        initialFocusRef.current = null
      }
    } catch (e) {
      setStatus('error')
      console.error('adsb fetch failed:', e)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      if (cancelled) return
      await fetchOnce()
      if (!cancelled) timer = setTimeout(tick, REFRESH_MS)
    }
    tick()
    const m = mapRef.current
    let moveTimer: ReturnType<typeof setTimeout>
    const onMove = () => {
      clearTimeout(moveTimer)
      moveTimer = setTimeout(fetchOnce, 500)
    }
    m?.on('moveend', onMove)
    return () => { cancelled = true; clearTimeout(timer); clearTimeout(moveTimer); m?.off('moveend', onMove) }
  }, [fetchOnce])

  /* ---- Filtered list ---- */
  const watchSet = useMemo(() => new Set(watchlist.map(w => w.toUpperCase())), [watchlist])
  const isWatched = useCallback((f: Flight) => {
    const cs = f.callsign.replace(/\s+/g,'').toUpperCase()
    const reg = f.registration.replace(/\s+/g,'').toUpperCase()
    if (watchSet.has(cs) || watchSet.has(reg) || watchSet.has(f.icao.toUpperCase())) return true
    for (const w of watchSet) if (cs.startsWith(w) && w.length >= 3) return true
    return false
  }, [watchSet])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const ap = airlinePrefix.trim().toUpperCase()
    return flights.filter(f => {
      if (hideGround && f.ground) return false
      if (onlyMil && !f.military) return false
      if (onlyEmerg && !f.emergency) return false
      if (!f.ground && (f.altitudeFt < altMin || f.altitudeFt > altMax)) return false
      if (spdMin > 0 && f.velocityKts < spdMin) return false
      if (ap && !f.callsign.toUpperCase().startsWith(ap)) return false
      if (!q) return true
      return f.callsign.toLowerCase().includes(q) || f.registration.toLowerCase().includes(q) ||
             f.type.toLowerCase().includes(q) || f.operator.toLowerCase().includes(q) ||
             f.icao.includes(q) || f.squawk.includes(q)
    })
  }, [flights, query, hideGround, onlyMil, onlyEmerg, altMin, altMax, spdMin, airlinePrefix])

  /* ---- Conflict detection (pairs of aircraft within proximity thresholds) ---- */
  const conflicts = useMemo<ConflictPair[]>(() => {
    if (!showConflict) return []
    return detectConflicts(
      filtered.map(f => ({
        icao: f.icao, callsign: f.callsign, operator: f.operator, type: f.type,
        lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts,
        track: f.track, vertRate: f.vertRate, ground: f.ground,
      })),
      conflictLat, conflictVert, conflictGround,
    )
  }, [filtered, showConflict, conflictLat, conflictVert, conflictGround])

  /* push conflict pair lines + midpoints into map source */
  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    const src = m.getSource('conflicts') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    const SEV_HEX = { critical: '#f43f5e', warning: '#f59e0b', advisory: '#38bdf8' } as const
    const feats: any[] = []
    for (const p of conflicts) {
      const color = SEV_HEX[p.severity]
      feats.push({
        type: 'Feature',
        properties: { sev: p.severity, color, pair: `${p.a.icao}-${p.b.icao}` },
        geometry: { type: 'LineString', coordinates: [[p.a.lng, p.a.lat], [p.b.lng, p.b.lat]] },
      })
      feats.push({
        type: 'Feature',
        properties: { sev: p.severity, color, pair: `${p.a.icao}-${p.b.icao}` },
        geometry: { type: 'Point', coordinates: [p.midLng, p.midLat] },
      })
    }
    src.setData({ type: 'FeatureCollection', features: feats } as any)
  }, [conflicts, mapReady])

  /* ---- Holding pattern detection ---- */
  const holdingHits = useMemo<HoldingHit[]>(() => {
    if (!showHolding) return []
    return detectHolding(
      filtered.map(f => ({
        icao: f.icao, callsign: f.callsign, registration: f.registration,
        type: f.type, operator: f.operator,
        lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt,
        track: f.track, velocityKts: f.velocityKts,
      })),
      trailsRef.current,
      { minTurnDeg: holdMinTurn, maxRadiusNm: holdMaxRadius, minSpanSec: holdMinSpan },
    )
  }, [filtered, showHolding, holdMinTurn, holdMaxRadius, holdMinSpan, flights])

  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    const src = m.getSource('holding') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    const feats: any[] = []
    for (const h of holdingHits) {
      const color = h.loops >= 2 ? '#f59e0b' : h.loops >= 1.2 ? '#fbbf24' : '#fcd34d'
      // approximate circle polygon
      const N = 48
      const coords: [number, number][] = []
      const latRad = (h.centerLat * Math.PI) / 180
      const dLat = h.radiusNm / 60
      const dLng = h.radiusNm / (60 * Math.max(Math.cos(latRad), 0.0001))
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2
        coords.push([h.centerLng + dLng * Math.cos(a), h.centerLat + dLat * Math.sin(a)])
      }
      feats.push({
        type: 'Feature',
        properties: { color, icao: h.icao, callsign: h.callsign },
        geometry: { type: 'Polygon', coordinates: [coords] },
      })
      feats.push({
        type: 'Feature',
        properties: { color, icao: h.icao, callsign: h.callsign },
        geometry: { type: 'Point', coordinates: [h.centerLng, h.centerLat] },
      })
    }
    src.setData({ type: 'FeatureCollection', features: feats } as any)
  }, [holdingHits, mapReady])

  /* ---- Formation flight detection ---- */
  const formations = useMemo<Formation[]>(() => {
    if (!showFormation) return []
    return detectFormations(
      filtered.map(f => ({
        icao: f.icao, callsign: f.callsign, registration: f.registration,
        type: f.type, operator: f.operator,
        lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt,
        track: f.track, velocityKts: f.velocityKts, ground: f.ground,
      })),
      {
        maxRadiusNm: formMaxRadius, maxAltDiffFt: formMaxAlt,
        maxTrackDiffDeg: formMaxTrack, maxSpeedDiffKts: formMaxSpeed,
        minMembers: formMinMembers, includeGround: formGround,
      },
    )
  }, [filtered, showFormation, formMaxRadius, formMaxAlt, formMaxTrack, formMaxSpeed, formMinMembers, formGround])

  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    const src = m.getSource('formations') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    const CLASS_HEX: Record<Formation['classification'], string> = {
      tight: '#f43f5e', echelon: '#a78bfa', trail: '#22d3ee', loose: '#34d399',
    }
    const feats: any[] = []
    // 2D convex hull (monotonic chain)
    const hull = (pts: Array<[number, number]>): Array<[number, number]> => {
      if (pts.length <= 1) return pts.slice()
      const sorted = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
      const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
        (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
      const lower: Array<[number, number]> = []
      for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
        lower.push(p)
      }
      const upper: Array<[number, number]> = []
      for (let i = sorted.length - 1; i >= 0; i--) {
        const p = sorted[i]
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
        upper.push(p)
      }
      lower.pop(); upper.pop()
      return lower.concat(upper)
    }
    for (const f of formations) {
      const color = f.militaryHint ? '#fbbf24' : CLASS_HEX[f.classification]
      const pts: Array<[number, number]> = f.members.map(m => [m.lng, m.lat])
      // Edges from leader to each member (star)
      for (const m of f.members) {
        if (m.icao === f.leader.icao) continue
        feats.push({
          type: 'Feature',
          properties: { kind: 'edge', color, id: f.id },
          geometry: { type: 'LineString', coordinates: [[f.leader.lng, f.leader.lat], [m.lng, m.lat]] },
        })
      }
      // Hull polygon (only if 3+ points; otherwise fall back to small buffer around midpoint)
      if (pts.length >= 3) {
        const h = hull(pts)
        if (h.length >= 3) {
          h.push(h[0])
          feats.push({
            type: 'Feature',
            properties: { kind: 'hull', color, id: f.id },
            geometry: { type: 'Polygon', coordinates: [h] },
          })
        }
      } else if (pts.length === 2) {
        // small pill: buffer around midpoint
        const latRad = (f.centerLat * Math.PI) / 180
        const r = 0.3 // nm
        const dLat = r / 60
        const dLng = r / (60 * Math.max(Math.cos(latRad), 0.0001))
        const ring: Array<[number, number]> = []
        for (let i = 0; i <= 24; i++) {
          const a = (i / 24) * Math.PI * 2
          ring.push([f.centerLng + dLng * Math.cos(a), f.centerLat + dLat * Math.sin(a)])
        }
        feats.push({
          type: 'Feature',
          properties: { kind: 'hull', color, id: f.id },
          geometry: { type: 'Polygon', coordinates: [ring] },
        })
      }
      // Leader pin
      feats.push({
        type: 'Feature',
        properties: { kind: 'leader', color, id: f.id, icao: f.leader.icao },
        geometry: { type: 'Point', coordinates: [f.leader.lng, f.leader.lat] },
      })
      // Label at group centroid
      feats.push({
        type: 'Feature',
        properties: {
          kind: 'label', color, id: f.id,
          label: `${f.members.length}-SHIP${f.militaryHint ? ' MIL' : ''} · ${f.classification.toUpperCase()}`,
        },
        geometry: { type: 'Point', coordinates: [f.centerLng, f.centerLat] },
      })
    }
    src.setData({ type: 'FeatureCollection', features: feats } as any)
  }, [formations, mapReady])

  /* ---- CPA Predictor detection + overlay ---- */
  const cpaHits = useMemo<CpaHit[]>(() => {
    if (!showCpa) return []
    return detectCpa(
      filtered.map(f => ({
        icao: f.icao, callsign: f.callsign, operator: f.operator, type: f.type,
        lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt,
        velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground,
      })),
      {
        horizonSec: cpaHorizon,
        maxMissNm: cpaMaxMissNm,
        maxMissFt: cpaMaxMissFt,
        includeGround: cpaGround,
        ignoreSameOperator: cpaSameOp,
      },
    )
  }, [filtered, showCpa, cpaHorizon, cpaMaxMissNm, cpaMaxMissFt, cpaGround, cpaSameOp])

  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    const src = m.getSource('cpa') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    const SEV_HEX: Record<CpaHit['severity'], string> = {
      imminent: '#fb7185', critical: '#fb923c', warning: '#fbbf24', advisory: '#38bdf8',
    }
    const SEV_N: Record<CpaHit['severity'], number> = { imminent: 0, critical: 1, warning: 2, advisory: 3 }
    const feats: any[] = []
    // Cap rendered overlays to avoid flooding the map when filters loosen.
    const shown = cpaHits.slice(0, 40)
    for (const h of shown) {
      const color = SEV_HEX[h.severity]
      // Predicted track for each aircraft (current -> CPA position)
      feats.push({
        type: 'Feature',
        properties: { kind: 'track', color, id: h.id, icao: h.a.icao },
        geometry: { type: 'LineString', coordinates: [[h.a.lng, h.a.lat], [h.aLng, h.aLat]] },
      })
      feats.push({
        type: 'Feature',
        properties: { kind: 'track', color, id: h.id, icao: h.b.icao },
        geometry: { type: 'LineString', coordinates: [[h.b.lng, h.b.lat], [h.bLng, h.bLat]] },
      })
      // Solid CPA miss line between predicted positions
      feats.push({
        type: 'Feature',
        properties: { kind: 'miss', color, id: h.id },
        geometry: { type: 'LineString', coordinates: [[h.aLng, h.aLat], [h.bLng, h.bLat]] },
      })
      // Midpoint marker + label with miss distance and time
      const min = Math.floor(h.ttcSec / 60)
      const sec = Math.round(h.ttcSec - min * 60)
      const tLabel = min > 0 ? `${min}m${sec.toString().padStart(2, '0')}s` : `${sec}s`
      feats.push({
        type: 'Feature',
        properties: {
          kind: 'mid', color, id: h.id, sev: SEV_N[h.severity],
          label: `${h.missNm.toFixed(1)}nm / ${Math.round(h.missFt)}ft · T-${tLabel}`,
        },
        geometry: { type: 'Point', coordinates: [h.midLng, h.midLat] },
      })
    }
    src.setData({ type: 'FeatureCollection', features: feats } as any)
  }, [cpaHits, mapReady])

  // Day/night terminator overlay + sun position; tick every 60s when active
  useEffect(() => {
    const m = mapRef.current
    if (!m || !mapReady) return
    if (!showSun) {
      try { removeTerminator(m) } catch {}
      return
    }
    const apply = () => { try { updateTerminator(m, solarPosition()) } catch {} }
    try { installTerminator(m, solarPosition()) } catch {}
    const t = setInterval(apply, 60_000)
    return () => { clearInterval(t); try { removeTerminator(m) } catch {} }
  }, [showSun, mapReady])

  /* ---- Density Heatmap install + live sync ---- */
  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    try { installHeat(m) } catch {}
    try { setHeatVisibility(m, showDensity) } catch {}
    try { setHeatRadius(m, heatRadius) } catch {}
    try { setHeatIntensity(m, heatIntensity) } catch {}
  }, [mapReady])

  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    try { setHeatVisibility(m, showDensity) } catch {}
  }, [showDensity, mapReady])

  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    try { setHeatRadius(m, heatRadius) } catch {}
  }, [heatRadius, mapReady])

  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    try { setHeatIntensity(m, heatIntensity) } catch {}
  }, [heatIntensity, mapReady])

  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    if (!showDensity) return
    try {
      updateHeat(m, flights.map(f => ({
        icao: f.icao, callsign: f.callsign,
        lat: f.lat, lng: f.lng,
        altitudeFt: f.altitudeFt, velocityKts: f.velocityKts,
        ground: f.ground, emergency: f.emergency, military: f.military,
      })), heatMode, heatGround)
    } catch {}
  }, [flights, heatMode, heatGround, showDensity, mapReady])


  // Snapshot of last-known authoritative positions per icao
  const lastPosRef = useRef<Map<string, { lng:number; lat:number; t:number; track:number; gs:number; ground:boolean; altFt:number; emergency:boolean; isSel:boolean; heli:boolean; color:string }>>(new Map())

  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    const now = performance.now()
    const next = new Map<string, any>()
    for (const f of filtered) {
      const isSel = selected?.icao === f.icao
      const heli = f.category === 'A7'
      const watched = isWatched(f)
      let baseColor: string
      if (colorBy === 'spd') baseColor = speedColor(f.velocityKts)
      else if (colorBy === 'cat') baseColor = catColor(f.category)
      else if (colorBy === 'mil') baseColor = f.military ? '#fb923c' : altColor(f.altitudeFt)
      else baseColor = altColor(f.altitudeFt)
      const color = f.emergency ? '#f43f5e' : f.ground ? '#64748b' : isSel ? '#fbbf24' : watched ? '#22d3ee' : isNotable(f.callsign) ? '#a78bfa' : baseColor
      next.set(f.icao, {
        lng: f.lng, lat: f.lat, t: now,
        track: f.track || 0, gs: f.velocityKts || 0,
        ground: f.ground, altFt: f.altitudeFt, emergency: f.emergency,
        isSel, heli, color,
      })
    }
    lastPosRef.current = next
  }, [filtered, selected, mapReady, colorBy, isWatched])

  // RAF loop: dead-reckon current position from last + velocity*elapsed
  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    let raf = 0
    let pulse = 0
    const step = () => {
      pulse += 0.06
      const now = performance.now()
      const src = m.getSource('planes') as maplibregl.GeoJSONSource | undefined
      const colSrc = m.getSource('alt-columns') as maplibregl.GeoJSONSource | undefined
      if (!src) { raf = requestAnimationFrame(step); return }

      const planeFeats: any[] = []
      const colFeats: any[] = []
      lastPosRef.current.forEach((p, icao) => {
        const dt = Math.min((now - p.t) / 1000, 12) // seconds, clamp 12
        // forward project along track at gs knots → degrees
        let lat = p.lat, lng = p.lng
        if (!p.ground && p.gs > 5) {
          const distNm = p.gs * dt / 3600
          const distDeg = distNm / 60
          const rad = (p.track * Math.PI) / 180
          lat = p.lat + Math.cos(rad) * distDeg
          lng = p.lng + (Math.sin(rad) * distDeg) / Math.max(Math.cos(p.lat*Math.PI/180), 0.0001)
        }
        // Pulse emergency icons via icon-size? simpler: bump color brightness via separate layer would be heavy.
        // Keep icon, but for emergency we'll oscillate via altitude column height visualisation instead.
        const altM = (!p.ground && p.altFt > 0) ? p.altFt * 0.3048 : 0
        planeFeats.push({
          type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat, altM] },
          properties: { icao, track: p.track, icon: iconKey(p.color, p.heli, p.isSel), ground: p.ground, altM },
        })
        if (!p.ground && p.altFt > 0) {
          const d = 0.003
          const ring = [
            [lng - d, lat - d], [lng + d, lat - d],
            [lng + d, lat + d], [lng - d, lat + d],
            [lng - d, lat - d],
          ]
          let h = p.altFt * 0.3048
          if (p.emergency) h *= 1 + 0.4 * Math.sin(pulse * 4)
          colFeats.push({
            type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] },
            properties: { icao, color: p.color, h },
          })
        }
      })
      src.setData({ type: 'FeatureCollection', features: planeFeats } as any)
      if (colSrc) colSrc.setData({ type: 'FeatureCollection', features: colFeats } as any)

      // Chase camera: if chaseRef on, fly to selected plane current interpolated pos
      if (chaseRef.current && selectedIcaoRef.current) {
        const p = lastPosRef.current.get(selectedIcaoRef.current)
        if (p) {
          const dt = Math.min((now - p.t) / 1000, 12)
          let lat = p.lat, lng = p.lng
          if (!p.ground && p.gs > 5) {
            const distNm = p.gs * dt / 3600
            const distDeg = distNm / 60
            const rad = (p.track * Math.PI) / 180
            lat = p.lat + Math.cos(rad) * distDeg
            lng = p.lng + (Math.sin(rad) * distDeg) / Math.max(Math.cos(p.lat*Math.PI/180), 0.0001)
          }
          m.jumpTo({ center: [lng, lat], bearing: p.track, pitch: 70, zoom: Math.max(m.getZoom(), 10.5) })
        }
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [mapReady])

  /* ---- Render trails ---- */
  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    const src = m.getSource('trails') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    if (!showTrails) { src.setData({ type: 'FeatureCollection', features: [] } as any); return }
    const features: any[] = []
    for (const f of filtered) {
      const t = trailsRef.current.get(f.icao)
      if (!t || t.length < 2) continue
      const color = altColor(f.altitudeFt)
      const isSel = selected?.icao === f.icao
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: t.map(p => [p[1], p[0]]) },
        properties: { color, sel: isSel },
      })
    }
    src.setData({ type: 'FeatureCollection', features } as any)
  }, [filtered, selected, showTrails, flights, mapReady])

  /* ---- Heatmap toggle ---- */
  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    if (m.getLayer('heat-layer')) {
      m.setLayoutProperty('heat-layer', 'visibility', showHeat ? 'visible' : 'none')
    }
  }, [showHeat, mapReady])

  /* ---- Visible airports ---- */
  const visibleAirports = useMemo(() => {
    if (!mapBounds || mapZoom < 5) return []
    const { n, s, e, w } = mapBounds
    const wrapW = w < -180 ? w + 360 : w
    const wrapE = e > 180 ? e - 360 : e
    return AIRPORTS.filter(ap =>
      ap.lat >= s && ap.lat <= n &&
      (w <= e ? (ap.lon >= wrapW && ap.lon <= wrapE) : (ap.lon >= wrapW || ap.lon <= wrapE))
    )
  }, [mapBounds, mapZoom])

  /* ---- Airport markers ---- */
  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    const live = new Set<string>()
    const size = mapZoom < 7 ? 14 : mapZoom < 9 ? 18 : 22
    const fontSize = mapZoom < 7 ? 7 : mapZoom < 9 ? 9 : 11
    if (mapZoom < 5) {
      for (const [, mk] of airportMarkersRef.current) mk.remove()
      airportMarkersRef.current.clear()
      return
    }
    for (const ap of visibleAirports) {
      live.add(ap.i)
      let mk = airportMarkersRef.current.get(ap.i)
      if (!mk) {
        const el = document.createElement('div')
        el.style.cssText = `width:${size}px;height:${size}px;border-radius:3px;background:rgba(15,23,42,0.85);border:1.5px solid #38bdf8;display:flex;align-items:center;justify-content:center;font-family:monospace;font-weight:700;font-size:${fontSize}px;color:#7dd3fc;line-height:1;cursor:pointer;box-shadow:0 0 6px rgba(56,189,248,0.4);user-select:none;`
        el.textContent = '✈'
        el.title = `${ap.a} · ${ap.n}\n${ap.m}`
        el.addEventListener('click', (ev) => {
          ev.stopPropagation()
          setSelectedAirport(ap); setSelected(null)
        })
        mk = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([ap.lon, ap.lat]).addTo(m)
        airportMarkersRef.current.set(ap.i, mk)
      } else {
        // resize existing element if zoom changed
        const el = mk.getElement()
        el.style.width = `${size}px`; el.style.height = `${size}px`; el.style.fontSize = `${fontSize}px`
      }
    }
    for (const [k, mk] of airportMarkersRef.current) {
      if (!live.has(k)) { mk.remove(); airportMarkersRef.current.delete(k) }
    }
  }, [visibleAirports, mapZoom, mapReady])

  /* ---- Emergency squawk alerting ---- */
  useEffect(() => {
    const fresh: typeof toasts = []
    for (const f of flights) {
      if (!f.emergency || !f.squawk) continue
      if (!['7500','7600','7700'].includes(f.squawk)) continue
      const key = f.icao + ':' + f.squawk
      if (knownEmergRef.current.has(key)) continue
      knownEmergRef.current.add(key)
      fresh.push({ id: key, icao: f.icao, cs: f.callsign || f.icao.toUpperCase(), sq: f.squawk, lat: f.lat, lng: f.lng, t: Date.now() })
    }
    if (fresh.length) {
      setToasts(prev => [...fresh, ...prev].slice(0, 5))
      setEmergLog(prev => [...fresh, ...prev].slice(0, 20))
      if (audioOnRef.current) {
        try {
          const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext
          if (Ctx) {
            const ctx = new Ctx()
            const o = ctx.createOscillator(); const g = ctx.createGain()
            o.connect(g); g.connect(ctx.destination)
            o.frequency.value = 880; o.type = 'sine'
            g.gain.setValueAtTime(0.18, ctx.currentTime)
            g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45)
            o.start(); o.stop(ctx.currentTime + 0.5)
          }
        } catch {}
      }
      setTimeout(() => {
        setToasts(prev => prev.filter(t => !fresh.find(f => f.id === t.id)))
      }, 12000)
    }
  }, [flights])

  /* ---- Persist watchlist ---- */
  useEffect(() => {
    try { localStorage.setItem(WATCH_KEY, JSON.stringify(watchlist)) } catch {}
  }, [watchlist])

  /* ---- Watchlist detection ---- */
  useEffect(() => {
    if (!watchlist.length) return
    const fresh: typeof toasts = []
    for (const f of flights) {
      const cs = f.callsign.replace(/\s+/g, '').toUpperCase()
      const reg = f.registration.replace(/\s+/g, '').toUpperCase()
      const matched = watchlist.find(w => {
        const ww = w.toUpperCase()
        return cs === ww || reg === ww || cs.startsWith(ww) || f.icao.toLowerCase() === w.toLowerCase()
      })
      if (!matched) continue
      const key = 'watch:' + f.icao
      if (knownWatchRef.current.has(key)) continue
      knownWatchRef.current.add(key)
      fresh.push({ id: key, icao: f.icao, cs: f.callsign || matched, sq: matched, lat: f.lat, lng: f.lng, t: Date.now() })
    }
    if (fresh.length) {
      setToasts(prev => [...fresh, ...prev].slice(0, 5))
      if (audioOnRef.current) {
        try {
          const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext
          if (Ctx) {
            const ctx = new Ctx()
            const o = ctx.createOscillator(); const g = ctx.createGain()
            o.connect(g); g.connect(ctx.destination)
            o.frequency.value = 660; o.type = 'sine'
            g.gain.setValueAtTime(0.12, ctx.currentTime)
            g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
            o.start(); o.stop(ctx.currentTime + 0.35)
          }
        } catch {}
      }
      setTimeout(() => setToasts(prev => prev.filter(t => !fresh.find(f => f.id === t.id))), 15000)
    }
    const visibleIcaos = new Set(flights.map(f => 'watch:' + f.icao))
    for (const k of Array.from(knownWatchRef.current)) {
      if (k.startsWith('watch:') && !visibleIcaos.has(k)) knownWatchRef.current.delete(k)
    }
  }, [flights, watchlist])

  /* ---- Refresh compare list ---- */
  useEffect(() => {
    if (!compareList.length) return
    setCompareList(prev => prev.map(p => flights.find(f => f.icao === p.icao) || p))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flights])

  /* ---- Follow mode ---- */
  useEffect(() => {
    if (!follow || !selected) return
    const f = flights.find(x => x.icao === selected.icao)
    if (f) mapRef.current?.easeTo({ center: [f.lng, f.lat], duration: 400 })
  }, [follow, selected, flights])

  /* ---- Persist UI prefs ---- */
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ showWeather, showTrails, showNight, showList, showHeat, show3D }))
    } catch {}
  }, [showWeather, showTrails, showNight, showList, showHeat, show3D])

  /* ---- Route + photo on selection ---- */
  useEffect(() => {
    setRoute(null); setPhoto(null)
    clearRouteLayer()
    if (!selected) return
    const flight = selected
    drawRoute(null, flight)
    const cs = flight.callsign.replace(/\s+/g, '')
    if (cs && cs.length >= 3 && cs !== flight.registration && cs !== flight.icao.toUpperCase()) {
      const cached = routeCacheRef.current.get(cs)
      if (cached !== undefined) {
        setRoute(cached); drawRoute(cached, flight)
      } else {
        ;(async () => {
          try {
            const r = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`)
            if (!r.ok) throw new Error(`route HTTP ${r.status}`)
            const j = await r.json() as { response?: { flightroute?: { airline?: { name: string }; origin?: any; destination?: any } } }
            const fr = j?.response?.flightroute
            let route: Route | null = null
            if (fr?.origin && fr?.destination) {
              const toAp = (a: any): Airport => ({
                icao: a.icao_code, iata: a.iata_code, name: a.name,
                location: a.municipality || a.country_name, lat: a.latitude, lon: a.longitude,
                countryiso2: a.country_iso_name,
              })
              route = { airports: [toAp(fr.origin), toAp(fr.destination)], airline: fr.airline?.name }
            }
            routeCacheRef.current.set(cs, route)
            if (selectedIcaoRef.current === flight.icao) { setRoute(route); drawRoute(route, flight) }
          } catch (e) {
            routeCacheRef.current.set(cs, null)
            console.warn('route fail', e)
          }
        })()
      }
    }
    const ph = photoCacheRef.current.get(flight.icao)
    if (ph !== undefined) setPhoto(ph)
    else {
      ;(async () => {
        try {
          const r = await fetch(`https://api.planespotters.net/pub/photos/hex/${flight.icao}`)
          const j = await r.json() as { photos?: Array<{ thumbnail_large?: { src: string } }> }
          let src = j.photos?.[0]?.thumbnail_large?.src || null
          if (!src) {
            try {
              const r2 = await fetch(`https://api.adsbdb.com/v0/aircraft/${flight.icao}`)
              const j2 = await r2.json() as { response?: { aircraft?: { url_photo_thumbnail?: string | null } } }
              src = j2?.response?.aircraft?.url_photo_thumbnail || null
            } catch {}
          }
          photoCacheRef.current.set(flight.icao, src)
          if (selectedIcaoRef.current === flight.icao) setPhoto(src)
        } catch {
          photoCacheRef.current.set(flight.icao, null)
        }
      })()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  const clearRouteLayer = () => {
    const m = mapRef.current; if (!m) return
    const rs = m.getSource('routes') as maplibregl.GeoJSONSource | undefined
    const ps = m.getSource('route-points') as maplibregl.GeoJSONSource | undefined
    rs?.setData({ type: 'FeatureCollection', features: [] } as any)
    ps?.setData({ type: 'FeatureCollection', features: [] } as any)
  }

  const drawRoute = (r: Route | null, flight: Flight) => {
    const m = mapRef.current; if (!m) return
    const rs = m.getSource('routes') as maplibregl.GeoJSONSource | undefined
    const ps = m.getSource('route-points') as maplibregl.GeoJSONSource | undefined
    if (!rs || !ps) return
    const lines: any[] = []
    const points: any[] = []
    if (!r?.airports?.length) {
      if (!flight.ground && flight.velocityKts > 30) {
        const distNm = (flight.velocityKts / 60) * 10
        const R = 3440.065
        const brg = flight.track * Math.PI/180
        const lat1 = flight.lat * Math.PI/180, lon1 = flight.lng * Math.PI/180
        const dR = distNm / R
        const lat2 = Math.asin(Math.sin(lat1)*Math.cos(dR) + Math.cos(lat1)*Math.sin(dR)*Math.cos(brg))
        const lon2 = lon1 + Math.atan2(Math.sin(brg)*Math.sin(dR)*Math.cos(lat1), Math.cos(dR) - Math.sin(lat1)*Math.sin(lat2))
        lines.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[flight.lng, flight.lat], [lon2*180/Math.PI, lat2*180/Math.PI]] },
          properties: { color: '#fbbf24', width: 1.5, opacity: 0.7, dashed: true },
        })
      }
      rs.setData({ type: 'FeatureCollection', features: lines } as any)
      ps.setData({ type: 'FeatureCollection', features: points } as any)
      return
    }
    const aps = r.airports
    const planePos: [number, number] = [flight.lng, flight.lat]
    if (aps.length >= 1) {
      const orig = aps[0]
      lines.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[orig.lon, orig.lat], planePos] },
        properties: { color: '#64748b', width: 1.5, opacity: 0.6, dashed: true },
      })
      points.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [orig.lon, orig.lat] },
        properties: { color: '#10b981' },
      })
    }
    if (aps.length >= 2) {
      const dest = aps[aps.length - 1]
      lines.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [planePos, [dest.lon, dest.lat]] },
        properties: { color: '#38bdf8', width: 2, opacity: 0.85, dashed: false },
      })
      points.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [dest.lon, dest.lat] },
        properties: { color: '#38bdf8' },
      })
    }
    rs.setData({ type: 'FeatureCollection', features: lines } as any)
    ps.setData({ type: 'FeatureCollection', features: points } as any)
  }

  /* ---- Stats ---- */
  const stats = useMemo(() => {
    const total = filtered.length
    const airborne = filtered.filter(f => !f.ground).length
    const air = filtered.filter(f => !f.ground)
    const avgAlt = airborne ? Math.round(air.reduce((s,f)=>s+f.altitudeFt,0) / airborne) : 0
    const avgVel = airborne ? Math.round(air.reduce((s,f)=>s+f.velocityKts,0) / airborne) : 0
    const emerg = filtered.filter(f => f.emergency).length
    return { total, airborne, avgAlt, avgVel, emerg }
  }, [filtered])

  /* ---- Fullscreen ---- */
  const [isFullscreen, setIsFullscreen] = useState(false)
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  const toggleFullscreen = useCallback(() => {
    try {
      if (!document.fullscreenElement) {
        (document.documentElement as any).requestFullscreen?.()
      } else {
        document.exitFullscreen?.()
      }
    } catch {}
  }, [])

  /* ---- Keyboard shortcuts ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === '/') { e.preventDefault(); (document.getElementById('search-input') as HTMLInputElement)?.focus() }
      else if (e.key === 'Escape') { setSelected(null); setSelectedAirport(null); setShowFilters(false) }
      else if (e.key.toLowerCase() === 'w') setShowWeather(v => !v)
      else if (e.key.toLowerCase() === 't') setShowTrails(v => !v)
      else if (e.key.toLowerCase() === 'n') setShowNight(v => !v)
      else if (e.key.toLowerCase() === 'h') setShowHeat(v => !v)
      else if (e.key.toLowerCase() === 'l') setShowList(v => !v)
      else if (e.key.toLowerCase() === 'f' && selected) setFollow(v => !v)
      else if (e.key === '?' || (e.shiftKey && e.key === '/')) { e.preventDefault(); setShowHelp(v => !v) }
      else if (e.key.toLowerCase() === 'm') setShowStyles(v => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  /* ---- Map style switcher ---- */
  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    const tileSets: Record<string, string[]> = {
      dark: [
        'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
        'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
        'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
      ],
      light: [
        'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      ],
      sat: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
    }
    try {
      if (m.getLayer('basemap')) m.removeLayer('basemap')
      if (m.getSource('carto-dark')) m.removeSource('carto-dark')
      m.addSource('carto-dark', { type: 'raster', tiles: tileSets[mapStyle], tileSize: 256 } as any)
      m.addLayer({ id: 'basemap', type: 'raster', source: 'carto-dark' }, m.getLayer('hillshade') ? 'hillshade' : undefined)
      try { localStorage.setItem('ft-mapstyle-v1', mapStyle) } catch {}
    } catch {}
  }, [mapStyle, mapReady])

  /* ---- Sorted list ---- */
  const sortedList = useMemo(() => {
    const copy = [...filtered]
    if (listSort === 'callsign') copy.sort((a, b) => a.callsign.localeCompare(b.callsign))
    else if (listSort === 'alt') copy.sort((a, b) => b.altitudeFt - a.altitudeFt)
    else copy.sort((a, b) => b.velocityKts - a.velocityKts)
    return copy.slice(0, 200)
  }, [filtered, listSort])

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#07090d]">
      {/* [BATCH-A] */}
      <SkipToMap />
      <CommandPalette
        flights={flights as any}
        onSelectFlight={(icao) => {
          const f = flights.find(ff => ff.icao === icao)
          if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 9), duration: 800 }) } catch {} }
        }}
        onSelectAirport={(ap) => {
          setSelectedAirport(ap); setSelected(null)
          try { mapRef.current?.flyTo({ center: [ap.lon, ap.lat], zoom: 10, duration: 800 }) } catch {}
        }}
        actions={useMemo<CPAction[]>(() => ([
          { id: 'toggle-trails', group: 'Layers', label: showTrails ? 'Hide trails' : 'Show trails', hint: 'T', run: () => setShowTrails(v => !v) },
          { id: 'toggle-weather', group: 'Layers', label: showWeather ? 'Hide weather radar' : 'Show weather radar', hint: 'W', run: () => setShowWeather(v => !v) },
          { id: 'toggle-night', group: 'Layers', label: showNight ? 'Hide day/night terminator' : 'Show day/night terminator', hint: 'N', run: () => setShowNight(v => !v) },
          { id: 'toggle-heat', group: 'Layers', label: showHeat ? 'Hide density heatmap' : 'Show density heatmap', hint: 'H', run: () => setShowHeat(v => !v) },
          { id: 'toggle-list', group: 'View', label: showList ? 'Hide flight list' : 'Show flight list', hint: 'L', run: () => setShowList(v => !v) },
          { id: 'toggle-radar', group: 'View', label: showRadar ? 'Hide traffic radar' : 'Show traffic radar', run: () => { const nv = !showRadar; setShowRadar(nv); lsSet('ft-radar', nv) }, keywords: ['scope', 'tcas', 'ppi'] },
          { id: 'toggle-ruler', group: 'View', label: showRuler ? 'Close great-circle ruler' : 'Great-circle ruler (measure distance)', run: () => setShowRuler(v => !v), keywords: ['measure', 'distance', 'ruler', 'geodesic'] },
          { id: 'toggle-bullseye', group: 'View', label: showBullseye ? 'Close bullseye (BRA reference)' : 'Bullseye / BRA tactical reference', run: () => setShowBullseye(v => !v), keywords: ['bullseye', 'bra', 'tactical', 'bearing', 'range', 'compass', 'rose', 'radial'] },
          { id: 'toggle-formation', group: 'View', label: showFormation ? 'Close formation flight detector' : 'Formation flight detector', run: () => { const nv = !showFormation; setShowFormation(nv); lsSet('ft-form', nv) }, keywords: ['formation', 'flight', 'group', 'flock', 'wingman', 'echelon', 'trail', 'tight', 'mil', 'military', 'pack', 'cluster'] },
          { id: 'toggle-cpa', group: 'View', label: showCpa ? 'Close CPA predictor' : 'CPA predictor (predicted near-miss)', run: () => { const nv = !showCpa; setShowCpa(nv); lsSet('ft-cpa', nv) }, keywords: ['cpa', 'closest', 'point', 'approach', 'tcas', 'conflict', 'predict', 'forecast', 'near miss', 'separation', 'collision'] },
          { id: 'toggle-div', group: 'View', label: showDiversion ? 'Close diversion finder' : 'Diversion finder (nearest airports)', run: () => { const nv = !showDiversion; setShowDiversion(nv); lsSet('ft-div', nv) }, keywords: ['divert', 'diversion', 'alternate', 'airport', 'nearest', 'glide', 'emergency', 'land'] },
          { id: 'toggle-vp', group: 'View', label: showVProfile ? 'Close vertical profile' : 'Vertical profile (side view from center)', run: () => { const nv = !showVProfile; setShowVProfile(nv); lsSet('ft-vp', nv) }, keywords: ['vertical', 'profile', 'side', 'view', 'altitude', 'range', 'cross', 'section', 'arrival', 'descent', 'climb'] },
          { id: 'toggle-tcas', group: 'View', label: showTcas ? 'Close TCAS scope' : 'TCAS traffic display (head-up scope)', run: () => { const nv = !showTcas; setShowTcas(nv); lsSet('ft-tcas', nv) }, keywords: ['tcas', 'traffic', 'collision', 'avoidance', 'scope', 'ra', 'ta', 'proximate', 'cockpit'] },
          { id: 'toggle-wake', group: 'View', label: showWake ? 'Close wake turbulence' : 'Wake turbulence (corridors + risk)', run: () => { const nv = !showWake; setShowWake(nv); lsSet('ft-wake', nv) }, keywords: ['wake', 'turbulence', 'heavy', 'super', 'separation', 'recat', 'vortex', 'corridor'] },
          { id: 'toggle-contrail', group: 'View', label: showContrail ? 'Close contrail forecast' : 'Contrail forecast (Schmidt-Appleman)', run: () => { const nv = !showContrail; setShowContrail(nv); lsSet('ft-contrail', nv) }, keywords: ['contrail', 'climate', 'schmidt', 'appleman', 'ISSR', 'cirrus', 'plume', 'forcing'] },
          { id: 'toggle-flow', group: 'View', label: showFlow ? 'Close flow rose' : 'Flow rose (heading wind-rose)', run: () => { const nv = !showFlow; setShowFlow(nv); lsSet('ft-flow', nv) }, keywords: ['flow', 'rose', 'wind rose', 'heading', 'direction', 'track', 'sector', 'compass'] },
          { id: 'toggle-records', group: 'View', label: showRecords ? 'Close records hall of fame' : 'Records hall of fame (top-3 podiums)', run: () => { const nv = !showRecords; setShowRecords(nv); lsSet('ft-records', nv) }, keywords: ['records', 'hall', 'fame', 'podium', 'leaderboard', 'best', 'fastest', 'highest', 'mach', 'gold', 'silver', 'bronze', 'trophy'] },
          { id: 'toggle-shadow', group: 'View', label: showShadow ? 'Close shadow caster' : 'Shadow caster (sun-cast ground shadows)', run: () => { const nv = !showShadow; setShowShadow(nv); lsSet('ft-shadow', nv) }, keywords: ['shadow', 'caster', 'sun', 'ground', 'cast', 'anti', 'solar', 'projection'] },
          { id: 'toggle-doppler', group: 'View', label: showDoppler ? 'Close Doppler scope' : 'Doppler scope (radial velocity radar)', run: () => { const nv = !showDoppler; setShowDoppler(nv); lsSet('ft-doppler', nv) }, keywords: ['doppler', 'radar', 'scope', 'radial', 'velocity', 'approach', 'recede', 'closing'] },
          { id: 'toggle-aprseq', group: 'View', label: showAprSeq ? 'Close approach sequencer' : 'Approach sequencer (arrival queue)', run: () => { const nv = !showAprSeq; setShowAprSeq(nv); lsSet('ft-aprseq', nv) }, keywords: ['approach', 'sequence', 'sequencer', 'arrival', 'queue', 'in-trail', 'spacing', 'final', 'land', 'apr'] },
          { id: 'toggle-pass', group: 'View', label: showPass ? 'Close pass predictor' : 'Pass predictor (overhead photo windows)', run: () => { const nv = !showPass; setShowPass(nv); lsSet('ft-pass', nv) }, keywords: ['pass', 'overhead', 'photo', 'spotter', 'predict', 'cpa', 'sun', 'light', 'elevation'] },
          { id: 'toggle-noise', group: 'View', label: showNoise ? 'Close noise monitor' : 'Noise footprint monitor (ground dBA)', run: () => { const nv = !showNoise; setShowNoise(nv); lsSet('ft-noise', nv) }, keywords: ['noise', 'sound', 'db', 'dba', 'decibel', 'footprint', 'loud', 'quiet', 'community', 'annoyance'] },
          { id: 'toggle-tod', group: 'View', label: showTod ? 'Close TOD predictor' : 'Top-of-Descent predictor (3° profile)', run: () => { const nv = !showTod; setShowTod(nv); lsSet('ft-tod', nv) }, keywords: ['tod', 'top of descent', 'descent', 'profile', 'arrival', 'destination', 'glide', '3 degree'] },
          { id: 'toggle-tripwire', group: 'View', label: showTripwire ? 'Close tripwire' : 'Tripwire / virtual gate (line crossing predictor)', run: () => { const nv = !showTripwire; setShowTripwire(nv); lsSet('ft-tripwire', nv) }, keywords: ['tripwire', 'gate', 'line', 'cross', 'crossing', 'fence', 'wire', 'threshold', 'border', 'spotter line'] },
          { id: 'toggle-geofence', group: 'View', label: showGeofence ? 'Close geofence studio' : 'Geofence studio (polygon zone monitor)', run: () => { const nv = !showGeofence; setShowGeofence(nv); lsSet('ft-geofence', nv) }, keywords: ['geofence', 'zone', 'polygon', 'area', 'fence', 'studio', 'dwell', 'entry', 'exit', 'monitor', 'intrusion'] },
          { id: 'toggle-voronoi', group: 'View', label: showVoronoi ? 'Close Voronoi territory' : 'Voronoi territory (airspace partition)', run: () => { const nv = !showVoronoi; setShowVoronoi(nv); lsSet('ft-voronoi', nv) }, keywords: ['voronoi', 'territory', 'partition', 'cell', 'isolated', 'crowded', 'nearest', 'neighbor', 'tessellation'] },
          { id: 'toggle-sunglare', group: 'View', label: showSunGlare ? 'Close sun glare predictor' : 'Sun glare predictor (cockpit clock + elevation)', run: () => { const nv = !showSunGlare; setShowSunGlare(nv); lsSet('ft-sunglare', nv) }, keywords: ['sun', 'glare', 'cockpit', 'clock', 'azimuth', 'elevation', 'blinding', 'visibility', 'solar'] },
          { id: 'toggle-glide', group: 'View', label: showGlide ? 'Close Glide Atlas' : 'Glide Atlas (engine-out reach + reachable airports)', run: () => { const nv = !showGlide; setShowGlide(nv); lsSet('ft-glide', nv) }, keywords: ['glide', 'engine out', 'emergency', 'reach', 'footprint', 'airport', 'safety', 'ditch', 'divert'] },
          { id: 'toggle-coffin', group: 'View', label: showCoffin ? 'Close Coffin Corner' : 'Coffin Corner (flight envelope: stall vs Mmo at altitude)', run: () => { const nv = !showCoffin; setShowCoffin(nv); lsSet('ft-coffin', nv) }, keywords: ['coffin', 'corner', 'envelope', 'stall', 'mmo', 'mach', 'buffet', 'high altitude', 'margin'] },
          { id: 'toggle-route', group: 'View', label: showRoute ? 'Close Route Planner' : 'Route Planner (great-circle, ETP/PNR, live winds, alternates)', run: () => { const nv = !showRoute; setShowRoute(nv); lsSet('ft-route', nv) }, keywords: ['route', 'planner', 'great circle', 'etp', 'pnr', 'flight plan', 'wind', 'alternate', 'fuel'] },
          { id: 'toggle-sua', group: 'View', label: showSua ? 'Close SUA Monitor' : 'SUA Monitor (prohibited / restricted / warning / MOA / Class-B intrusion + forecast)', run: () => { const nv = !showSua; setShowSua(nv); lsSet('ft-sua', nv) }, keywords: ['sua', 'special use', 'airspace', 'prohibited', 'restricted', 'warning', 'moa', 'class b', 'intrusion', 'tfr'] },
          { id: 'toggle-shear', group: 'View', label: showShear ? 'Close Shear Atlas' : 'Shear Atlas (vertical + horizontal wind shear hotspots / turbulence probability grid)', run: () => { const nv = !showShear; setShowShear(nv); lsSet('ft-shear', nv) }, keywords: ['shear', 'turbulence', 'wind', 'cat', 'bumps', 'gradient', 'hotspot'] },
          { id: 'toggle-cosmic', group: 'View', label: showCosmic ? 'Close Cosmic Dose' : 'Cosmic Dose Monitor (GCR radiation exposure uSv/h by altitude and geomagnetic latitude)', run: () => { const nv = !showCosmic; setShowCosmic(nv); lsSet('ft-cosmic', nv) }, keywords: ['cosmic', 'radiation', 'gcr', 'dose', 'usv', 'msv', 'crew', 'polar', 'rigidity', 'solar', 'shielding'] },
          { id: 'toggle-hypoxia', group: 'View', label: showHypoxia ? 'Close Hypoxia Monitor' : 'Hypoxia Monitor (decompression TUC + emergency descent survivability)', run: () => { const nv = !showHypoxia; setShowHypoxia(nv); lsSet('ft-hypoxia', nv) }, keywords: ['hypoxia', 'decompression', 'tuc', 'oxygen', 'cabin', 'descent', 'emergency', 'pressurization', 'rapid', 'fl100'] },
          { id: 'toggle-costidx', group: 'View', label: showCostIdx ? 'Close Cost Index' : 'Cost Index (Mach vs LRC/MMO economic estimator)', run: () => { const nv = !showCostIdx; setShowCostIdx(nv); lsSet('ft-costidx', nv) }, keywords: ['cost index', 'ci', 'mach', 'lrc', 'mmo', 'fuel', 'economy', 'sfc', 'time value', 'block time'] },
          { id: 'toggle-stepclimb', group: 'View', label: showStepClimb ? 'Close Step Climb Advisor' : 'Step Climb Advisor (fuel-efficiency optimum FL recommender)', run: () => { const nv = !showStepClimb; setShowStepClimb(nv); lsSet('ft-stepclimb', nv) }, keywords: ['step', 'climb', 'sar', 'fuel', 'efficient', 'cruise', 'optimum', 'flight level', 'cost', 'tailwind', 'savings'] },
          { id: 'toggle-etops', group: 'View', label: showEtops ? 'Close ETOPS Monitor' : 'ETOPS Monitor (single-engine diversion alternates)', run: () => { const nv = !showEtops; setShowEtops(nv); lsSet('ft-etops', nv) }, keywords: ['etops', 'diversion', 'alternate', 'single', 'engine', 'oei', 'rating', 'twin', 'oceanic', 'overwater'] },
          { id: 'toggle-depseq', group: 'View', label: showDepSeq ? 'Close Departure Sequencer' : 'Departure Sequencer (initial-climb wake & order)', run: () => { const nv = !showDepSeq; setShowDepSeq(nv); lsSet('ft-depseq', nv) }, keywords: ['departure', 'depart', 'takeoff', 'climb', 'wake', 'sequence', 'sid', 'initial', 'sequencer'] },
          { id: 'toggle-xwind', group: 'View', label: showXwind ? 'Close Crosswind Compass' : 'Crosswind Compass (runway picker from live wind)', run: () => { const nv = !showXwind; setShowXwind(nv); lsSet('ft-xwind', nv) }, keywords: ['crosswind', 'wind', 'runway', 'rwy', 'headwind', 'tailwind', 'compass', 'rose', 'vxw'] },
          { id: 'toggle-jet', group: 'View', label: showJet ? 'Close Jet Stream Finder' : 'Jet Stream Finder (detect cores, rank riders)', run: () => { const nv = !showJet; setShowJet(nv); lsSet('ft-jet', nv) }, keywords: ['jet', 'stream', 'wind', 'tailwind', 'core', 'ride', 'surf', 'aloft'] },
          { id: 'toggle-hstack', group: 'View', label: showHstack ? 'Close Holding Stack Designer' : 'Holding Stack Designer (auto-assign racetrack levels)', run: () => { const nv = !showHstack; setShowHstack(nv); lsSet('ft-hstack', nv) }, keywords: ['holding', 'stack', 'racetrack', 'hold', 'eth', 'aar', 'level', 'fl'] },
          { id: 'toggle-icing', group: 'View', label: showIcing ? 'Close Icing Monitor' : 'Icing Monitor (SAT / SLD airframe ice risk)', run: () => { const nv = !showIcing; setShowIcing(nv); lsSet('ft-icing', nv) }, keywords: ['icing', 'ice', 'sat', 'tat', 'sld', 'supercooled', 'anti-ice', 'boots', 'bleed', 'airframe'] },
          { id: 'toggle-curfew', group: 'View', label: showCurfew ? 'Close Curfew Monitor' : 'Curfew Monitor (night-flight ban watch)', run: () => { const nv = !showCurfew; setShowCurfew(nv); lsSet('ft-curfew', nv) }, keywords: ['curfew', 'night', 'noise', 'quota', 'lhr', 'fra', 'syd', 'ban', 'slot'] },
          { id: 'toggle-mwave', group: 'View', label: showMtnWave ? 'Close Mountain Wave' : 'Mountain Wave (lee wave / rotor turbulence)', run: () => { const nv = !showMtnWave; setShowMtnWave(nv); lsSet('ft-mwave', nv) }, keywords: ['mountain', 'wave', 'lee', 'rotor', 'turbulence', 'ridge', 'sierra', 'alps', 'andes', 'crest'] },
          { id: 'toggle-bird', group: 'View', label: showBird ? 'Close Bird Strike' : 'Bird Strike (flyway / wildlife hazard)', run: () => { const nv = !showBird; setShowBird(nv); lsSet('ft-bird', nv) }, keywords: ['bird', 'strike', 'wildlife', 'flyway', 'migration', 'hazard', 'goose', 'duck', 'hudson'] },
          { id: 'toggle-ash', group: 'View', label: showAsh ? 'Close Volcanic Ash' : 'Volcanic Ash (VAAC plume drift)', run: () => { const nv = !showAsh; setShowAsh(nv); lsSet('ft-ash', nv) }, keywords: ['ash', 'volcano', 'volcanic', 'vaac', 'plume', 'eyjafjallajokull', 'eruption', 'so2', 'sigmet'] },
          { id: 'toggle-fir', group: 'View', label: showFir ? 'Close FIR Load Monitor' : 'FIR / Sector Load Monitor (ATFM capacity)', run: () => { const nv = !showFir; setShowFir(nv); lsSet('ft-fir', nv) }, keywords: ['fir', 'sector', 'load', 'capacity', 'atfm', 'acc', 'controller', 'workload', 'atc', 'eurocontrol', 'artcc', 'overload', 'nmoc'] },
          { id: 'toggle-energy', group: 'View', label: showEnergy ? 'Close Energy Profile Monitor' : 'Energy Profile Monitor (Es / Ps / hot-high / low-energy)', run: () => { const nv = !showEnergy; setShowEnergy(nv); lsSet('ft-energy', nv) }, keywords: ['energy', 'es', 'ps', 'total', 'specific', 'kinetic', 'potential', 'climb', 'descent', 'gradient', 'hot', 'high', 'low', 'speed', 'trade'] },
          { id: 'toggle-turb', group: 'View', label: showTurb ? 'Close Turbulence EDR Estimator' : 'Turbulence EDR Estimator (Eddy Dissipation Rate from VS scatter)', run: () => { const nv = !showTurb; setShowTurb(nv); lsSet('ft-turb', nv) }, keywords: ['turbulence', 'edr', 'eddy', 'dissipation', 'chop', 'bumpy', 'cat', 'shear', 'rough', 'severe', 'moderate', 'light', 'forecast'] },
          { id: 'toggle-nordo', group: 'View', label: showNordo ? 'Close NORDO / Lost-Comm Monitor' : 'NORDO / Lost-Comm Monitor (FAR 91.185 radio-failure detector)', run: () => { const nv = !showNordo; setShowNordo(nv); lsSet('ft-nordo', nv) }, keywords: ['nordo', 'lost', 'comm', 'communication', 'radio', 'failure', '7600', 'squawk', 'far', '91.185', 'icao', '4444', 'silent', 'efc', 'mea'] },
          { id: 'toggle-terrain', group: 'View', label: showTerrain ? 'Close Terrain Clearance (TAWS)' : 'Terrain Clearance / TAWS (GPWS Mode 2 surrogate, HAT + closure rate)', run: () => { const nv = !showTerrain; setShowTerrain(nv); lsSet('ft-terrain', nv) }, keywords: ['terrain', 'taws', 'gpws', 'cfit', 'pull', 'up', 'msa', 'mea', 'hat', 'height', 'above', 'clearance', 'mountain', 'rockies', 'andes', 'himalaya', 'alps'] },
          { id: 'toggle-mass', group: 'View', label: showMass ? 'Close Mass & Balance Estimator' : 'Mass & Balance / Gross Weight Estimator (climb-perf inversion, LF, Vs1g, TODR)', run: () => { const nv = !showMass; setShowMass(nv); lsSet('ft-mass', nv) }, keywords: ['mass', 'balance', 'weight', 'gw', 'gross', 'load', 'factor', 'lf', 'mtow', 'oew', 'stall', 'vs1g', 'todr', 'takeoff', 'distance', 'thrust', 'drag', 'performance'] },
          { id: 'toggle-magvar', group: 'View', label: showMagVar ? 'Close Magnetic Variation Atlas' : 'Magnetic Variation / Isogonic Atlas (declination, grid-nav, auroral oval)', run: () => { const nv = !showMagVar; setShowMagVar(nv); lsSet('ft-magvar', nv) }, keywords: ['magnetic', 'variation', 'declination', 'isogonic', 'compass', 'grid', 'nav', 'polar', 'aurora', 'hf', 'wmm', 'igrf', 'pole', 'true', 'heading'] },
          { id: 'toggle-raim', group: 'View', label: showRaim ? 'Close GPS / RAIM' : 'GPS / RAIM (scintillation + jamming)', run: () => { const nv = !showRaim; setShowRaim(nv); lsSet('ft-raim', nv) }, keywords: ['gps', 'raim', 'gnss', 'jamming', 'spoofing', 'ionosphere', 'scintillation', 's4', 'kp', 'auroral', 'lpv', 'rnp'] },
          { id: 'toggle-ocean', group: 'View', label: showOcean ? 'Close Oceanic Tracks' : 'Oceanic Tracks (NAT-OTS / PACOTS)', run: () => { const nv = !showOcean; setShowOcean(nv); lsSet('ft-ocean', nv) }, keywords: ['oceanic', 'nat', 'ots', 'pacots', 'track', 'xtk', 'slop', 'mnt', 'in-trail', 'random'] },
          { id: 'toggle-metar', group: 'View', label: showMetar ? 'Close METAR Monitor' : 'METAR Monitor (surface obs)', run: () => { const nv = !showMetar; setShowMetar(nv); lsSet('ft-metar', nv) }, keywords: ['metar', 'taf', 'weather', 'wind', 'visibility', 'ceiling', 'vfr', 'mvfr', 'ifr', 'lifr', 'altimeter', 'qnh'] },
          { id: 'toggle-cells', group: 'View', label: showCells ? 'Close Convective Cells' : 'Convective Cells (CB/TCU penetration)', run: () => { const nv = !showCells; setShowCells(nv); lsSet('ft-cells', nv) }, keywords: ['convective', 'cells', 'thunderstorm', 'cb', 'tcu', 'storm', 'lightning', 'penetration', 'deviation', 'turbulence'] },
          { id: 'toggle-sar', group: 'View', label: showSar ? 'Close SAR Planner' : 'SAR Planner (search & rescue patterns)', run: () => { const nv = !showSar; setShowSar(nv); lsSet('ft-sar', nv) }, keywords: ['sar', 'search', 'rescue', 'pattern', 'expanding', 'square', 'sector', 'parallel', 'creeping', 'koopman', 'pod', 'datum', 'drift', 'leeway'] },
          { id: 'toggle-stable', group: 'View', label: showStable ? 'Close Stable Approach Monitor' : 'Stable Approach Monitor (FSF ALAR gates)', run: () => { const nv = !showStable; setShowStable(nv); lsSet('ft-stable', nv) }, keywords: ['stable', 'approach', 'unstable', 'go-around', 'fsf', 'alar', 'glideslope', 'glidepath', 'centerline', 'vref', 'sink', 'gate', '1000', '500'] },
          { id: 'toggle-fir', group: 'View', label: showFirX ? 'Close FIR Crossings Monitor' : 'FIR / ARTCC Crossings Monitor', run: () => { const nv = !showFirX; setShowFirX(nv); lsSet('ft-firx', nv) }, keywords: ['fir', 'artcc', 'crossing', 'boundary', 'handoff', 'sector', 'controller', 'workload', 'oceanic', 'flow', 'centre', 'center'] },
          { id: 'toggle-rwycfg', group: 'View', label: showRwyCfg ? 'Close Runway Config Atlas' : 'Runway Configuration Atlas', run: () => { const nv = !showRwyCfg; setShowRwyCfg(nv); lsSet('ft-rwycfg', nv) }, keywords: ['runway', 'config', 'wind', 'crosswind', 'tailwind', 'active', 'approach', 'departure', 'hub', 'airport', 'rwy'] },
          { id: 'toggle-taf', group: 'View', label: showTaf ? 'Close TAF Forecast' : 'TAF Forecast (24h lagrangian terminal forecast)', run: () => { const nv = !showTaf; setShowTaf(nv); lsSet('ft-taf', nv) }, keywords: ['taf', 'forecast', 'terminal', 'aerodrome', 'metar', 'becmg', 'tempo', 'prob30', 'lagrangian', 'upwind', 'fm', 'weather'] },
          { id: 'toggle-toc', group: 'View', label: showToc ? 'Close Top of Climb Predictor' : 'Top of Climb Predictor (climb performance vs class)', run: () => { const nv = !showToc; setShowToc(nv); lsSet('ft-toc', nv) }, keywords: ['toc', 'top of climb', 'climb', 'gradient', 'fpm', 'level off', 'cruise', 'rvsm', 'step climb', 'performance'] },
          { id: 'toggle-cabin', group: 'View', label: showCabin ? 'Close Cabin Pressure Monitor' : 'Cabin Pressure Monitor (ΔP / TUC / emergency descent)', run: () => { const nv = !showCabin; setShowCabin(nv); lsSet('ft-cabin', nv) }, keywords: ['cabin', 'pressurization', 'pressure', 'differential', 'delta p', 'tuc', 'time of useful consciousness', 'hypoxia', 'oxygen', 'o2', 'depressurization', 'emergency descent', 'far 121.333', 'rapid decompression'] },
          { id: 'toggle-apmin', group: 'View', label: showApMin ? 'Close Approach Minimums Monitor' : 'Approach Minimums Monitor (CAT I/II/IIIa/IIIb legality)', run: () => { const nv = !showApMin; setShowApMin(nv); lsSet('ft-apmin', nv) }, keywords: ['approach', 'minimums', 'mins', 'cat i', 'cat ii', 'cat iii', 'catiiia', 'catiiib', 'autoland', 'dh', 'decision height', 'rvr', 'ceiling', 'low vis', 'lvto', 'opspec', 'icao annex 14'] },
          { id: 'toggle-fueltemp', group: 'View', label: showFuelTemp ? 'Close Fuel Temperature Monitor' : 'Fuel Temperature Monitor (cold-soak, freeze margin, BA38)', run: () => { const nv = !showFuelTemp; setShowFuelTemp(nv); lsSet('ft-fueltemp', nv) }, keywords: ['fuel', 'temperature', 'temp', 'cold soak', 'freeze', 'wax', 'jet a', 'jet a-1', 'ts-1', 'jp-8', 'sat', 'tat', 'ba38', 'polar', 'cold', 'crystals'] },
          { id: 'toggle-navaid', group: 'View', label: showNavaid ? 'Close Navaid Coverage Atlas' : 'Navaid Coverage Atlas (DME/DME RNP, VOR backup, GPS-degraded)', run: () => { const nv = !showNavaid; setShowNavaid(nv); lsSet('ft-navaid', nv) }, keywords: ['navaid', 'vor', 'dme', 'vortac', 'rnp', 'rnav', 'pbn', 'positioning', 'gps backup', 'gnss degraded', 'coverage', 'line of sight', 'slant range', 'ssv'] },
          { id: 'toggle-drift', group: 'View', label: showDrift ? 'Close Drift-Down OEI Atlas' : 'Drift-Down OEI Atlas (engine-out ceiling, divert reach)', run: () => { const nv = !showDrift; setShowDrift(nv); lsSet('ft-drift', nv) }, keywords: ['drift', 'drift down', 'oei', 'one engine inoperative', 'engine out', 'divert', 'service ceiling', 'etops', 'single engine', 'driftdown', 'failure'] },
          { id: 'toggle-reserve', group: 'View', label: showReserve ? 'Close Reserve Fuel Monitor' : 'Reserve Fuel Monitor (FAR 91.167 / 121.639 bingo fuel)', run: () => { const nv = !showReserve; setShowReserve(nv); lsSet('ft-reserve', nv) }, keywords: ['reserve', 'reserve fuel', 'bingo', 'min fuel', 'mayday fuel', 'far 91.167', 'far 121.639', 'endurance', 'fuel remaining', 'divert'] },
          { id: 'toggle-etp', group: 'View', label: showEtp ? 'Close ETP / Critical Point Atlas' : 'ETP / Critical Point Atlas (equal-time point return vs continue)', run: () => { const nv = !showEtp; setShowEtp(nv); lsSet('ft-etp', nv) }, keywords: ['etp', 'equal time', 'critical point', 'cp', 'point of no return', 'ponr', 'oceanic', 'nat ops', 'return', 'committed', 'divert', 'ac 120-42b', 'dispatch'] },
          { id: 'toggle-cda', group: 'View', label: showCda ? 'Close CDA Compliance Monitor' : 'CDA Compliance Monitor (continuous descent approach grading)', run: () => { const nv = !showCda; setShowCda(nv); lsSet('ft-cda', nv) }, keywords: ['cda', 'cdo', 'continuous descent', 'idle descent', 'level-off', 'noise', 'fuel penalty', 'glide path', 'three degree', 'ac 91-86', 'icao doc 9931'] },
          { id: 'toggle-brake', group: 'View', label: showBrake ? 'Close Brake Energy Monitor' : 'Brake Energy & Tire-Speed Landing Monitor (AC 25-32 / CS-25)', run: () => { const nv = !showBrake; setShowBrake(nv); lsSet('ft-brake', nv) }, keywords: ['brake', 'energy', 'tire', 'lsr', 'fuse plug', 'rto', 'landing weight', 'vapp', 'vref', 'cool down', 'turnaround', 'ac 25-32', 'cs-25'] },
          { id: 'toggle-mapp', group: 'View', label: showMapp ? 'Close OEI Missed-Approach Monitor' : 'OEI Missed-Approach Climb-Gradient Monitor (PANS-OPS 2.5%)', run: () => { const nv = !showMapp; setShowMapp(nv); lsSet('ft-mapp', nv) }, keywords: ['missed approach', 'oei', 'one engine inoperative', 'climb gradient', 'pans-ops', 'go around', 'density altitude', 'koch chart', 'hot and high', 'mountain airport', 'cs-25.121'] },
          { id: 'toggle-vhf', group: 'View', label: showVhf ? 'Close VHF Voice Congestion Monitor' : 'VHF Voice Channel Congestion Monitor (Erlang-B per ACC)', run: () => { const nv = !showVhf; setShowVhf(nv); lsSet('ft-vhf', nv) }, keywords: ['vhf', 'voice', 'frequency', 'channel', 'congestion', 'erlang', 'blocking', 'ptt', 'cpdlc', 'datalink', 'acc', 'sector', 'comms', 'icao annex 10', 'doc 9863', 'controller workload'] },
          { id: 'toggle-spwx', group: 'View', label: showSpwx ? 'Close Space Weather Impact Monitor' : 'Space Weather Impact Monitor (Kp / SEP / dose, polar HF + GNSS scintillation)', run: () => { const nv = !showSpwx; setShowSpwx(nv); lsSet('ft-spwx', nv) }, keywords: ['space', 'weather', 'kp', 'geomagnetic', 'storm', 'g-scale', 'sep', 'solar', 'particle', 'aurora', 'polar', 'hf', 'blackout', 'gnss', 'scintillation', 'cosmic', 'radiation', 'dose', 'cari', 'icao annex 3', 'noaa swpc'] },
          { id: 'toggle-foqa', group: 'View', label: showFoqa ? 'Close FOQA / FDM Exceedance Monitor' : 'FOQA / FDM Exceedance Monitor (Level-1/2/3 parameter breaches)', run: () => { const nv = !showFoqa; setShowFoqa(nv); lsSet('ft-foqa', nv) }, keywords: ['foqa', 'fdm', 'flight data monitoring', 'exceedance', 'qar', 'overspeed', 'rod', 'roll', 'mach bust', 'cefa', 'icao annex 6', 'faa ac 120-82', 'easa', 'iata', 'level 1', 'level 2', 'level 3', 'fda', 'fdx'] },
          { id: 'toggle-egt', group: 'View', label: showEgt ? 'Close EGT Margin Monitor' : 'EGT Margin Monitor (engine red-line / on-wing wear / derate)', run: () => { const nv = !showEgt; setShowEgt(nv); lsSet('ft-egt', nv) }, keywords: ['egt', 'exhaust gas temperature', 'engine', 'margin', 'red line', 'derate', 'flex', 'on wing', 'wear', 'trend monitoring', 'oem', 'cfm', 'pratt', 'rolls royce', 'trent', 'genx', 'faa ac 33', 'easa cs-e', 'iata iosa'] },
          { id: 'toggle-polar', group: 'View', label: showPolar ? 'Close Cross-Polar Ops Monitor' : 'Cross-Polar Ops Monitor (arctic fuel-freeze / HF / grid-nav / NEC diverts)', run: () => { const nv = !showPolar; setShowPolar(nv); lsSet('ft-polar', nv) }, keywords: ['polar', 'arctic', 'antarctic', 'cross polar', 'pao', 'fuel freeze', 'jet a-1', 'hf', 'satcom', 'iridium', 'inmarsat', 'grid nav', 'true track', 'nec', 'emergency diversion', 'thule', 'iqaluit', 'svalbard', 'mcmurdo', 'faa ac 120-42b', 'transport canada', 'easa amc 20-12'] },
          { id: 'toggle-libat', group: 'View', label: showLibat ? 'Close Li-Battery Cargo Monitor' : 'Li-Battery Cargo Monitor (IATA DGR / Halon / Class-C/E / runaway)', run: () => { const nv = !showLibat; setShowLibat(nv); lsSet('ft-libat', nv) }, keywords: ['lithium', 'battery', 'cargo', 'dangerous goods', 'dgr', 'iata', 'icao doc 9284', 'sfar 26', 'halon', 'class-c', 'class-e', 'thermal runaway', 'fcc', 'fire containment cover', 'etops', 'diversion'] },
          { id: 'toggle-rexhyd', group: 'View', label: showRexhyd ? 'Close Runway Excursion / Hydroplaning Monitor' : 'Runway Excursion / Hydroplaning Monitor (NASA Vp=9√P / TALPA RCAM / LDR vs LDA)', run: () => { const nv = !showRexhyd; setShowRexhyd(nv); lsSet('ft-rexhyd', nv) }, keywords: ['runway', 'excursion', 'overrun', 'hydroplane', 'hydroplaning', 'horne', 'nasa td-2056', 'vp', 'tire pressure', 'talpa', 'rcam', 'wet runway', 'contaminated', 'ldr', 'lda', 'landing distance', 'crosswind', 'tailwind', 'reverted rubber', 'ac 91-79b', 'doc 9981', 'rex-hyd'] },
          { id: 'toggle-cgtrim', group: 'View', label: showCgTrim ? 'Close CG / Stab Trim Envelope Monitor' : 'CG / Stab Trim Envelope Monitor (W&B %MAC / stab-trim units / fuel-burn shift)', run: () => { const nv = !showCgTrim; setShowCgTrim(nv); lsSet('ft-cgtrim', nv) }, keywords: ['cg', 'center of gravity', 'centre of gravity', 'mac', 'stab trim', 'stabilizer', 'stabiliser', 'trim', 'weight and balance', 'wandb', 'w&b', 'envelope', 'fwd limit', 'aft limit', 'loadsheet', 'ac 120-27', 'oro.mlr.110', '14 cfr 25.27', 'fcom', 'aom-1.27', 'anu'] },
          { id: 'toggle-owl', group: 'View', label: showOwl ? 'Close Overweight Landing / Fuel Jettison Monitor' : 'Overweight Landing / Fuel Jettison Decision Monitor (GW vs MLW / dump rate / burn-down time)', run: () => { const nv = !showOwl; setShowOwl(nv); lsSet('ft-owl', nv) }, keywords: ['overweight', 'overweight landing', 'owl', 'fuel jettison', 'fuel dump', 'jettison', 'mlw', 'mtow', 'mzfw', 'gross weight', 'landing weight', 'qrh', 'burn down', 'hold', 'ac 25-7c', '14 cfr 25.1001', 'doc 9376', 'cs-25.473', 'pro-abn-misc'] },
          { id: 'toggle-told', group: 'View', label: showTold ? 'Close TOLD / V-Speeds / Balanced Field Length Monitor' : 'TOLD Card · V1/Vr/V2/BFL · Balanced Field Length Monitor (14 CFR 25.105/107/109/121 · TALPA RCAM)', run: () => { const nv = !showTold; setShowTold(nv); lsSet('ft-told', nv) }, keywords: ['told', 'takeoff', 'departure', 'v1', 'vr', 'v2', 'vfto', 'v-speeds', 'bfl', 'balanced field length', 'rtow', 'tlr', 'accelerate-go', 'accelerate-stop', 'asda', 'tora', 'toda', 'oei', 'second segment', '14 cfr 25.105', '14 cfr 25.107', '14 cfr 25.109', '14 cfr 25.121', 'ac 25-7c', 'cs-25', 'talpa', 'rcam', 'flex', 'derate', 'fcom per-tof'] },
          { id: 'toggle-uas', group: 'View', label: showUas ? 'Close UAS / Pitot-Icing Risk Monitor' : 'Unreliable Airspeed / Pitot-Icing Risk Monitor (TAT freeze / HIWC corridor / probe wear / AoA fault / redundancy gap)', run: () => { const nv = !showUas; setShowUas(nv); lsSet('ft-uas', nv) }, keywords: ['uas', 'unreliable airspeed', 'pitot', 'pitot icing', 'pitot-icing', 'tat', 'total air temp', 'hiwc', 'high ice water content', 'af447', 'safo 11003', 'ac 25-11b', 'probe heater', 'aoa', 'angle of attack', 'thales', 'goodrich', 'do-160', 'cs-25.1323', 'in-flight icing', 'ice crystal'] },
          { id: 'toggle-bleed', group: 'View', label: showBleed ? 'Close Bleed-Air Fume Event Risk Monitor' : 'Bleed-Air Fume Event Risk Monitor (oil seal / TCP / ASHRAE 161 / SAFO 18003)', run: () => { const nv = !showBleed; setShowBleed(nv); lsSet('ft-bleed', nv) }, keywords: ['bleed', 'bleed air', 'fume', 'fume event', 'cabin air', 'safo 18003', 'ashrae 161', 'tcp', 'tricresyl', 'organophosphate', 'oil seal', 'idg', 'apu', 'pack', 'recirc', 'cabin air quality', 'caq', 'raes', 'wet dog', 'dirty sock', 'pyrolysate'] },
          { id: 'toggle-deice', group: 'View', label: showDeice ? 'Close De-Icing Holdover Time (HOT) Compliance Monitor' : 'De-Icing Holdover Time (HOT) Compliance Monitor (AMS 1424/1428 Type I/II/III/IV vs OAT / precip / LOUT)', run: () => { const nv = !showDeice; setShowDeice(nv); lsSet('ft-deice', nv) }, keywords: ['deice', 'de-ice', 'de-icing', 'anti-ice', 'anti-icing', 'hot', 'holdover', 'holdover time', 'ams 1424', 'ams 1428', 'type i', 'type ii', 'type iii', 'type iv', 'fluid', 'glycol', 'propylene', 'ethylene', 'lout', 'faa hot', 'icao 9640', 'tc tp 14052', 'cold weather', 'winter ops', 'snow', 'freezing rain', 'ice pellets', 'frost'] },
          { id: 'toggle-pstatic', group: 'View', label: showPstatic ? 'Close P-Static / Comm-Link Degradation Monitor' : 'P-Static / Precipitation-Static Comms-Degradation Monitor (DO-160G / AC 25.1316-1A / ARP 5577)', run: () => { const nv = !showPstatic; setShowPstatic(nv); lsSet('ft-pstatic', nv) }, keywords: ['p-static', 'pstatic', 'precipitation static', 'static discharger', 'sda', 'wick', 'corona', 'st elmo', 'st elmos fire', 'do-160', 'do-160g', 'ac 25.1316', 'arp 5577', 'vhf dropout', 'adf wander', 'comm loss', 'tribelectric', 'triboelectric', 'cirrus', 'ice crystal', 'bonding', 'esd', 'hirf', 'satcom', 'hf'] },
          { id: 'toggle-flutter', group: 'View', label: showFlutter ? 'Close Mmo/Vmo Flutter Margin Monitor' : 'Mmo/Vmo Barber-Pole & Aeroelastic Flutter Margin Monitor (FAR 25.335 / 25.629 / CS-25.629)', run: () => { const nv = !showFlutter; setShowFlutter(nv); lsSet('ft-flutter', nv) }, keywords: ['flutter', 'mmo', 'vmo', 'barber pole', 'barber-pole', 'mach tuck', 'mach-tuck', 'overspeed', 'aeroelastic', 'far 25.335', 'far 25.629', 'cs-25.629', 'flutter margin', 'casb', 'high speed warning', 'china airlines 006', 'damper', 'free play', 'control surface'] },
          { id: 'toggle-stall', group: 'View', label: showStall ? 'Close Stall Margin / Alpha-Floor Monitor' : 'Stall Margin / Alpha-Floor / Stick-Shaker Monitor (FAR 25.103 / 25.207 / FCOM 5.25 / alpha-prot)', run: () => { const nv = !showStall; setShowStall(nv); lsSet('ft-stall', nv) }, keywords: ['stall', 'vs1g', 'alpha', 'alpha floor', 'alpha-floor', 'alpha prot', 'alpha-prot', 'stick shaker', 'stick-shaker', 'stick pusher', 'far 25.103', 'far 25.207', 'cs-25.103', 'cs-25.207', 'buffet', 'coffin corner', 'colgan 3407', 'af447', 'icing stall', 'upset recovery', 'fcom 5.25'] },
          { id: 'toggle-tailstrike', group: 'View', label: showTailStrike ? 'Close Tail Strike / Rotation Geometry Monitor' : 'Tail Strike / Rotation Geometry Risk Monitor (FCTM 3.20 / AC 25-7C / long-body pitch clearance)', run: () => { const nv = !showTailStrike; setShowTailStrike(nv); lsSet('ft-tailstrike', nv) }, keywords: ['tail strike', 'tailstrike', 'tail-strike', 'rotation', 'pitch attitude', 'long body', 'long-body', 'b777-300', 'a330-300', 'a340-600', 'a350-1000', 'b737-900', 'b737 max 10', 'fctm 3.20', 'fctm', 'pitch clearance', 'liftoff', 'rotation rate', 'over-rotation', 'over rotation', 'sq286', 'singapore airlines tail strike', 'derate', 'flare'] },
          { id: 'toggle-rera', group: 'View', label: showRera ? 'Close Runway Excursion Risk Monitor' : 'Runway Excursion Risk Monitor (TALPA RCAM / LDA margin / contamination / xwind)', run: () => { const nv = !showRera; setShowRera(nv); lsSet('ft-rera', nv) }, keywords: ['runway excursion', 'rera', 'overrun', 'talpa', 'rcam', 'landing distance', 'lda', 'ldr', 'contamination', 'crosswind', 'tailwind', 'wet runway', 'snow runway', 'go-around', 'go around', 'ac 25-32', 'ac 91-79b', 'unstable approach', 'aquaplaning', 'hydroplane', 'short runway', 'lcy', 'mdw', 'burbank', 'teterboro', 'lga', 'dca'] },
          { id: 'toggle-relight', group: 'View', label: showRelight ? 'Close Engine Relight / Windmill Restart Envelope Monitor' : 'Engine Relight Envelope · Windmill / Starter-Assist · TTR / APU / Fuel-Temp / ITT (FCOM 5.30 / PRO-ABN-70 / AC 25-22)', run: () => { const nv = !showRelight; setShowRelight(nv); lsSet('ft-relight', nv) }, keywords: ['relight', 'restart', 'windmill', 'ifsd', 'in-flight shutdown', 'engine out', 'starter', 'apu', 'fcom 5.30', 'pro-abn-70', 'ac 25-22', 'cs-25.903', 'ttr', 'time to relight', 'fuel temp', 'cold soak', 'itt', 'hot start', 'jet-a freeze', 'driftdown', 'envelope'] },
          { id: 'toggle-egress', group: 'View', label: showEgress ? 'Close Cabin Egress / 90-Sec Evacuation Compliance Monitor' : 'Cabin Egress · 90-Sec Evacuation Compliance · Exits / Load / Crew / ELS (14 CFR 25.803 / AC 25.803-1A / ARP 4101)', run: () => { const nv = !showEgress; setShowEgress(nv); lsSet('ft-egress', nv) }, keywords: ['egress', 'evacuation', '90 second', '90s', 'cabin safety', 'far 25.803', 'ac 25.803-1a', 'cs-25.803', '25.807', '121.391', 'emergency exit', 'type-a', 'type-iii', 'overwing', 'flight attendant', 'cabin crew', 'els', 'emergency lighting', 'arp 4101', 'slide raft', 'survivable', 'pax load', 'mel', 'cabin'] },
          { id: 'toggle-notam', group: 'View', label: showNotam ? 'Close NOTAM / TFR Compliance Monitor' : 'NOTAM / TFR Active-Restriction Compliance · Presidential / Stadium / Space-launch / GPS-test / VIP / Prohibited / MOA / Warning / Disaster (ICAO Annex 15 · FAA JO 7930.2R · 14 CFR 91.137/138/141/143/145 · 14 CFR 99 · 14 CFR 73 · AC 91-63D)', run: () => { const nv = !showNotam; setShowNotam(nv); lsSet('ft-notam', nv) }, keywords: ['notam', 'tfr', 'temporary flight restriction', 'presidential', 'stadium', 'space launch', 'spacex', 'starbase', 'gps test', 'gps jamming', 'vip', 'prohibited', 'p-40', 'p-56', 'moa', 'military operating area', 'warning area', 'disaster', 'wildfire', '91.137', '91.141', '91.143', '91.145', '14 cfr 99', '14 cfr 73', 'icao annex 15', 'jo 7930', 'ac 91-63d', 'waiver', 'fdc', 'incursion'] },
          { id: 'toggle-radalt5g', group: 'View', label: showRadalt5g ? 'Close 5G C-Band / Radio-Altimeter Interference Monitor' : '5G C-Band / Radio-Altimeter Interference & AMOC Compliance · Verizon / AT&T / T-Mobile / DT / KDDI / SK · 3.45-4.0 GHz vs 4.2-4.4 GHz radalt (FAA AD 2021-23-12 · AD 2023-10-02 · SAIB AIR-21-18 · RTCA DO-401 · ITU-R M.2059 · EASA SIB 2022-02R3)', run: () => { const nv = !showRadalt5g; setShowRadalt5g(nv); lsSet('ft-radalt5g', nv) }, keywords: ['5g', 'c-band', 'c band', 'radalt', 'radio altimeter', 'radar altimeter', 'amoc', 'verizon', 'att', 'at&t', 't-mobile', 'tmobile', 'kddi', 'sk telecom', 'deutsche telekom', 'autoland', 'cat ii', 'cat iii', 'autoland category', 'ad 2021-23-12', 'ad 2023-10-02', 'saib air-21-18', 'rtca do-401', 'itu-r m.2059', 'easa sib 2022-02', 'fcc auction 107', '3.7 ghz', '3.98 ghz', '4.2 ghz', 'guard band', 'psd', 'interference', 'safo 21007', 'safo 22002'] },
          { id: 'toggle-ctalt', group: 'View', label: showCtAlt ? 'Close Cold-Temp Altimetry Correction Monitor' : 'Cold-Temperature Altimetry (CTA) Correction Monitor · ΔH cold-temp altitude error at restricted airports (ICAO Doc 8168 §III.4.1.1 · FAA AC 91-79B App 1 · FAA Order 7900.5C · TC AIM RAC 9.17 · NTSB AAR-79-7 Cranbrook YXC)', run: () => { const nv = !showCtAlt; setShowCtAlt(nv); lsSet('ft-ctalt', nv) }, keywords: ['cold temperature', 'cold temp', 'altimetry', 'altimeter', 'correction', 'cta', 'restricted airport', 'icao doc 8168', 'pans ops', 'isa deviation', 'doc 7488', 'ac 91-79b', 'faa order 7900', '14 cfr 97.20', 'tc aim rac 9.17', 'cranbrook', 'yxc', 'cfit', 'mda', 'da', 'minimums', 'segment minimum altitude', 'qnh', 'true height', 'eagle', 'aspen', 'jackson hole', 'innsbruck', 'edmonton', 'calgary', 'iqaluit', 'fairbanks', 'sapporo', 'pressure altitude', 'temperature error', 'cold soaked'] },
          { id: 'toggle-hotsec', group: 'View', label: showHotsec ? 'Close Hot-Section LCF / Engine Shop-Visit Predictor' : 'Hot-Section LCF · EGT Margin Erosion · LCF Cycles · Shop-Visit Predictor (14 CFR 33.70 / AC 33.70-1 / CS-E 515)', run: () => { const nv = !showHotsec; setShowHotsec(nv); lsSet('ft-hotsec', nv) }, keywords: ['hot section', 'lcf', 'low cycle fatigue', 'ellp', 'shop visit', 'tbsv', 'egt margin', 'engine life', 'derate', 'severity', 'genx', 'cfm56', 'leap', 'trent', 'cf6', 'pw1100g', 'borescope', '33.70', 'ac 33.70-1', 'cs-e 515', 'msg-3', 'arp 5757'] },
          { id: 'toggle-lhirf', group: 'View', label: showLhirf ? 'Close Lightning Strike Zone / HIRF Monitor' : 'Lightning Strike Zone · HIRF Compliance (SAE ARP 5414B / DO-160G §22-23 / AC 20-136B / 25.954)', run: () => { const nv = !showLhirf; setShowLhirf(nv); lsSet('ft-lhirf', nv) }, keywords: ['lightning', 'strike', 'zone', 'arp 5414', 'arp 5412', 'hirf', 'high intensity radiated fields', 'ac 20-136b', 'do-160', 'do-160g', 'lit', 'lightning induced transient', '25.954', 'fuel system', 'bonding', 'cmr', 'static discharger', 'plumer'] },
          { id: 'toggle-taws', group: 'View', label: showTaws ? 'Close EGPWS / TAWS Mode 1-7 Predictor' : 'EGPWS / TAWS Mode 1-7 Alert Predictor (DO-161A / DO-367 / TSO-C151d / Honeywell MK-V/VII/VIII)', run: () => { const nv = !showTaws; setShowTaws(nv); lsSet('ft-taws', nv) }, keywords: ['taws', 'egpws', 'gpws', 'terrain', 'pull up', 'pullup', 'sink rate', 'mode 1', 'mode 2', 'mode 3', 'mode 4', 'mode 5', 'mode 6', 'mode 7', 'windshear', 'glideslope', 'too low terrain', 'too low gear', 'too low flaps', "don't sink", 'dont sink', 'bank angle', 'minimums', 'rad alt', 'radalt', 'cfit', 'controlled flight into terrain', 'honeywell', 'mk-v', 'mk-vii', 'mk-viii', 'do-161a', 'do-367', 'tso-c151', 'tcf', 'terrain clearance floor', 'look-ahead', 'forward looking windshear'] },
          { id: 'toggle-ctot', group: 'View', label: showCtot ? 'Close CTOT / ATFM Slot Monitor' : 'CTOT / ATFM Slot Compliance (EUROCONTROL CFMU / FAA EDCT / slot adherence)', run: () => { const nv = !showCtot; setShowCtot(nv); lsSet('ft-ctot', nv) }, keywords: ['ctot', 'atfm', 'cfmu', 'eurocontrol', 'edct', 'slot', 'departure slot', 'flow management', 'regulation', 'ground stop', 'expect departure clearance', 'sip slot', 'atfcm', 'network manager', 'nm', 'slot adherence'] },
          { id: 'toggle-recat', group: 'View', label: showRecat ? 'Close RECAT-EU Wake Separation Monitor' : 'RECAT-EU Pairwise Wake Vortex Separation Monitor (ICAO Doc 9426 / EUROCONTROL RECAT 6-cat matrix)', run: () => { const nv = !showRecat; setShowRecat(nv); lsSet('ft-recat', nv) }, keywords: ['recat', 'wake', 'vortex', 'separation', 'eurocontrol', 'icao doc 9426', 'faa jo 7110.659', 'pairwise', 'leader follower', 'cat-a', 'cat-b', 'cat-c', 'cat-d', 'cat-e', 'cat-f', 'super heavy', 'a380', 'b777'] },
          { id: 'toggle-eai', group: 'View', label: showEai ? 'Close Engine Anti-Ice Penalty Monitor' : 'Engine Anti-Ice (EAI) / Cowl Heat Penalty Monitor (FAA AC 20-73A / AC 91-74B / 14 CFR 25 App C+O bleed-extraction N1/SFC/climb-gradient/EGT-rise stack)', run: () => { const nv = !showEai; setShowEai(nv); lsSet('ft-eai', nv) }, keywords: ['eai', 'anti-ice', 'cowl heat', 'engine anti-ice', 'bleed', 'app c', 'app o', 'sld', 'supercooled', 'tat', 'sat', 'ac 20-73a', 'ac 91-74b', 'cs-25.1419', 'n1 penalty', 'climb gradient', 'sfc'] },
          { id: 'toggle-adiz', group: 'View', label: showAdiz ? 'Close ADIZ Penetration Monitor' : 'ADIZ Penetration & Intercept-Risk Monitor (ICAO Annex 15 / FAA JO 7610.4 / 14 CFR 99 / NORAD CONR-CANR / JADIZ / KADIZ / ECS-ADIZ 24-zone QRA-risk scoring)', run: () => { const nv = !showAdiz; setShowAdiz(nv); lsSet('ft-adiz', nv) }, keywords: ['adiz', 'air defense', 'intercept', 'qra', 'norad', 'jadiz', 'kadiz', 'ecs', 'taiwan', 'cadiz', 'fir security', '14 cfr 99', 'icao annex 15', 'dvfr', 'transponder', 'mode 3a', 'incursion'] },
          { id: 'toggle-sidc', group: 'View', label: showSidc ? 'Close SID Climb Gradient Monitor' : 'SID Climb Gradient Monitor (departure PDG compliance)', run: () => { const nv = !showSidc; setShowSidc(nv); lsSet('ft-sidc', nv) }, keywords: ['sid', 'pdg', 'climb gradient', 'departure', 'obstacle clearance', 'pans-ops', 'terps', '8260.3', '8168', 'innsbruck', 'aspen', 'der'] },
          { id: 'toggle-rvsm', group: 'View', label: showRvsm ? 'Close RVSM Compliance Monitor' : 'RVSM Compliance Monitor (altitude-keeping / TVE / prox)', run: () => { const nv = !showRvsm; setShowRvsm(nv); lsSet('ft-rvsm', nv) }, keywords: ['rvsm', 'reduced vertical separation', 'altitude keeping', 'tve', 'total vertical error', 'ase', 'altimetry', 'icao 9574', 'ac 91-85', 'amc 20-13', 'aad', 'assigned altitude deviation', 'altitude bust', 'separation loss'] },
          { id: 'toggle-spdlim', group: 'View', label: showSpdLim ? 'Close Speed Limit Compliance' : 'Speed Limit Compliance (FAR 91.117 / Vmo / MMO)', run: () => { const nv = !showSpdLim; setShowSpdLim(nv); lsSet('ft-spdlim', nv) }, keywords: ['speed', 'limit', 'compliance', 'far 91.117', '250 knots', '200 knots', 'vmo', 'mmo', 'kias', 'mach', 'overspeed', 'speed bust', 'cruise ceiling', 'icao annex 2', 'restriction'] },
          { id: 'toggle-boom', group: 'View', label: showBoom ? 'Close Sonic Boom Footprint' : 'Sonic Boom Footprint Predictor (Mach cone / N-wave)', run: () => { const nv = !showBoom; setShowBoom(nv); lsSet('ft-boom', nv) }, keywords: ['sonic', 'boom', 'supersonic', 'mach', 'cone', 'n-wave', 'overpressure', 'carpet', 'whitham', 'carlson', 'concorde', 'boom supersonic', 'shockwave', 'primary boom', 'secondary boom'] },
          { id: 'toggle-rnp', group: 'View', label: showRnp ? 'Close RNP / PBN Lateral Monitor' : 'RNP / PBN Lateral Performance Monitor (cross-track error vs RNP band)', run: () => { const nv = !showRnp; setShowRnp(nv); lsSet('ft-rnp', nv) }, keywords: ['rnp', 'pbn', 'lateral', 'cross-track', 'xte', 'navigation performance', 'tse', 'fte', 'nse', 'containment', 'lnav', 'lpv', 'rnav', 'icao doc 9613', 'ac 90-105', 'great circle', 'leg deviation'] },
          { id: 'toggle-rta', group: 'View', label: showRta ? 'Close RTA / 4D Trajectory Conformance' : 'RTA / 4D Trajectory Conformance (CTA tolerance + required Mach/IAS)', run: () => { const nv = !showRta; setShowRta(nv); lsSet('ft-rta', nv) }, keywords: ['rta', 'cta', '4d', 'trajectory', 'tbo', 'sesar', 'pcp', 'time conformance', 'meter fix', 'eta', 'metering', 'arrival slot', 'mach number', 'speed adjust', 'absorb', 'eurocontrol'] },
          { id: 'toggle-satcom', group: 'View', label: showSatcom ? 'Close SATCOM / HF Coverage' : 'SATCOM / HF Voice Coverage Monitor (VHF horizon, Inmarsat, Iridium, HF SSB redundancy)', run: () => { const nv = !showSatcom; setShowSatcom(nv); lsSet('ft-satcom', nv) }, keywords: ['satcom', 'hf', 'vhf', 'inmarsat', 'iridium', 'coverage', 'comm', 'voice', 'link', 'redundancy', 'ssb', 'selcal', 'polar', 'nordo', 'lost comms', 'horizon', 'icao annex 10', 'arinc 741'] },
          { id: 'toggle-nadp', group: 'View', label: showNadp ? 'Close NADP Noise Abatement Monitor' : 'NADP Noise Abatement Departure Procedure Monitor (NADP-1 vs NADP-2 envelope)', run: () => { const nv = !showNadp; setShowNadp(nv); lsSet('ft-nadp', nv) }, keywords: ['nadp', 'noise', 'abatement', 'departure', 'icao pans-ops', 'ac 91-53a', 'cutback', 'thrust reduction', 'v2', 'vzf', 'flap retraction', 'lhr', 'fra', 'jfk', 'lcy', 'sfo', 'climb profile'] },
          { id: 'toggle-tank', group: 'View', label: showTank ? 'Close Fuel Tankering Advisor' : 'Fuel Tankering Advisor (Jet-A price arbitrage vs cost-of-weight burn penalty)', run: () => { const nv = !showTank; setShowTank(nv); lsSet('ft-tank', nv) }, keywords: ['tanker', 'tankering', 'fuel', 'jet-a', 'price', 'arbitrage', 'cost of weight', 'cow', 'uplift', 'iata', 'eurocontrol', 'savings', 'burn penalty', 'co2', 'refuel', 'usg', 'kerosene'] },
          { id: 'toggle-wkld', group: 'View', label: showWkld ? 'Close Pilot Workload Index Monitor' : 'Pilot Workload Index Monitor (NASA TLX composite cockpit workload score)', run: () => { const nv = !showWkld; setShowWkld(nv); lsSet('ft-wkld', nv) }, keywords: ['workload', 'pilot', 'tlx', 'nasa tlx', 'fatigue', 'wocl', 'circadian', 'saturation', 'cognitive', 'hf', 'human factors', 'phase', 'traffic', 'demand'] },
          { id: 'toggle-gnss', group: 'View', label: showGnss ? 'Close GNSS Integrity Monitor' : 'GNSS Integrity Monitor (GPS jamming / spoofing hotspots, RAIM HPL, IRS drift)', run: () => { const nv = !showGnss; setShowGnss(nv); lsSet('ft-gnss', nv) }, keywords: ['gnss', 'gps', 'jam', 'jamming', 'spoof', 'spoofing', 'raim', 'hpl', 'irs', 'ins drift', 'opsgroup', 'easa sib', 'integrity', 'interference', 'rfi'] },
          { id: 'toggle-cpdlc', group: 'View', label: showCpdlc ? 'Close CPDLC / Datalink Mandate Monitor' : 'CPDLC / Datalink Mandate Monitor (FANS-1/A + ATN B1 oceanic equipage & logon)', run: () => { const nv = !showCpdlc; setShowCpdlc(nv); lsSet('ft-cpdlc', nv) }, keywords: ['cpdlc', 'datalink', 'dls', 'fans', 'atn', 'ads-c', 'oceanic', 'nat', 'shanwick', 'gander', 'reykjavik', 'pacific', 'link 2000', 'mandate', 'icao doc 4444', 'ac 90-117', 'amc 20-25'] },
          { id: 'toggle-lbust', group: 'View', label: showLbust ? 'Close Level Bust Predictor' : 'Level Bust Predictor (ALoFT envelope / EUROCONTROL LBAP overshoot watch)', run: () => { const nv = !showLbust; setShowLbust(nv); lsSet('ft-lbust', nv) }, keywords: ['level bust', 'aloft', 'lbap', 'cleared flight level', 'cfl', 'altitude', 'capture', 'overshoot', 'vertical rate', 'ac 91-79a', 'eurocontrol', 'rvsm bust', 'altitude deviation'] },
          { id: 'toggle-adsbq', group: 'View', label: showAdsbq ? 'Close ADS-B Quality Monitor' : 'ADS-B Quality Monitor (DO-260B NIC/NACp/SIL / 14 CFR 91.227 compliance)', run: () => { const nv = !showAdsbq; setShowAdsbq(nv); lsSet('ft-adsbq', nv) }, keywords: ['adsb', 'ads-b', 'do-260b', 'nic', 'nacp', 'sil', 'sda', '91.227', 'gps integrity', 'epu', 'containment', 'mode s', 'transponder', 'easa amc 20-24'] },
          { id: 'toggle-ozone', group: 'View', label: showOzone ? 'Close Cabin Ozone Monitor' : 'Cabin Ozone Monitor (FAR 121.578 / CS-25.832 peak 0.25 / 3h-avg 0.10 ppmv)', run: () => { const nv = !showOzone; setShowOzone(nv); lsSet('ft-ozone', nv) }, keywords: ['ozone', 'o3', 'cabin', 'far 121.578', 'cs-25.832', 'ppmv', 'converter', 'catalytic', 'tropopause', 'polar spring', 'mls', 'climatology', 'irritation'] },
          { id: 'toggle-crewduty', group: 'View', label: showCrew ? 'Close Crew Duty Monitor' : 'Crew Duty Monitor (FAR 117 FDP / Samn-Perelli fatigue)', run: () => { const nv = !showCrew; setShowCrew(nv); lsSet('ft-crewduty', nv) }, keywords: ['crew', 'duty', 'fdp', 'far 117', 'fatigue', 'samn perelli', 'wocl', 'circadian', 'augment', 'rest'] },
          { id: 'toggle-anomaly', group: 'View', label: showAnomaly ? 'Close anomaly radar' : 'Anomaly radar (tick-to-tick state deltas)', run: () => { const nv = !showAnomaly; setShowAnomaly(nv); lsSet('ft-anomaly', nv) }, keywords: ['anomaly', 'radar', 'jump', 'swerve', 'spike', 'squawk', 'flip', 'glitch', 'delta', 'detect', 'alert'] },
          { id: 'toggle-compare', group: 'View', label: showCompareStudio ? 'Close compare studio' : 'Compare studio (side-by-side spec + spider)', run: () => { const nv = !showCompareStudio; setShowCompareStudio(nv); lsSet('ft-compare-studio', nv); if (nv && selected && !compareStudioIcaos.includes(selected.icao)) { const next = [...compareStudioIcaos, selected.icao].slice(0, 4); setCompareStudioIcaos(next); lsSet('ft-compare-studio-icaos', next) } }, keywords: ['compare', 'comparison', 'side by side', 'spec', 'radar chart', 'spider', 'vs', 'diff', 'studio'] },
          { id: 'toggle-symphony', group: 'View', label: showSymphony ? 'Close Sky Symphony' : 'Sky Symphony (sonify live traffic)', run: () => { const nv = !showSymphony; setShowSymphony(nv); lsSet('ft-symphony', nv) }, keywords: ['symphony', 'synth', 'audio', 'sound', 'music', 'sonify', 'sonification', 'tone', 'ambient', 'sound design'] },
          { id: 'toggle-timemachine', group: 'View', label: showTimeMachine ? 'Close Time Machine' : 'Time Machine (playback / scrub history)', run: () => { const nv = !showTimeMachine; setShowTimeMachine(nv); lsSet('ft-timemachine', nv) }, keywords: ['time', 'machine', 'playback', 'scrub', 'history', 'replay', 'rewind', 'past', 'ghost'] },
          { id: 'toggle-reach', group: 'View', label: showReach ? 'Close reachability atlas' : 'Reachability atlas (kinematic divert footprint)', run: () => { const nv = !showReach; setShowReach(nv); lsSet('ft-reach', nv) }, keywords: ['reach', 'reachability', 'divert', 'range', 'footprint', 'atlas', 'dubins', 'turn'] },
          { id: 'toggle-trip', group: 'View', label: showTrip ? 'Close trip planner' : 'Trip planner (great-circle route + winds + fuel)', run: () => { const nv = !showTrip; setShowTrip(nv); lsSet('ft-trip', nv) }, keywords: ['trip', 'planner', 'route', 'flight plan', 'great circle', 'fuel', 'eta', 'wind', 'destination', 'origin'] },
          { id: 'toggle-atlas', group: 'View', label: showAtlas ? 'Close registry atlas' : 'Registry atlas (country leaderboard)', run: () => { const nv = !showAtlas; setShowAtlas(nv); lsSet('ft-atlas', nv) }, keywords: ['atlas', 'country', 'registry', 'flag', 'nationality', 'iso', 'icao', 'origin'] },
          { id: 'toggle-vip', group: 'View', label: showVip ? 'Close VIP hunter' : 'VIP hunter (notable aircraft)', run: () => { const nv = !showVip; setShowVip(nv); lsSet('ft-vip', nv) }, keywords: ['vip', 'notable', 'interesting', 'hunter', 'celebrity', 'royal', 'state', 'military', 'rare', 'b2', 'a380', 'air force one'] },
          { id: 'toggle-pip', group: 'View', label: showPip ? 'Hide picture-in-picture mini-map' : 'Show picture-in-picture mini-map', run: () => { setShowPip(v => { const nv = !v; try { localStorage.setItem('ft-pip', nv ? '1' : '0') } catch {}; return nv }) }, keywords: ['pip', 'minimap', 'mini', 'inset', 'follow'] },
          { id: 'toggle-3d', group: 'Mode', label: show3D ? 'Exit 3D view' : 'Enter 3D view', run: () => setShow3D(v => !v) },
          { id: 'toggle-chase', group: 'Mode', label: chase ? 'Stop chase camera' : 'Start chase camera (select a plane first)', run: () => { if (!selected) return; setChase(v => { const nv = !v; chaseRef.current = nv; if (nv) setShow3D(true); return nv }) } },
          { id: 'toggle-follow', group: 'Mode', label: follow ? 'Stop follow' : 'Follow selected plane', hint: 'F', run: () => { if (selected) setFollow(v => !v) } },
          { id: 'toggle-audio', group: 'Mode', label: audioOn ? 'Mute alerts' : 'Enable audio alerts', run: () => setAudioOn(v => !v) },
          { id: 'style-dark', group: 'View', label: 'Map style: Dark', run: () => setMapStyle('dark') },
          { id: 'style-light', group: 'View', label: 'Map style: Light', run: () => setMapStyle('light') },
          { id: 'style-sat', group: 'View', label: 'Map style: Satellite', run: () => setMapStyle('sat'), keywords: ['imagery', 'aerial'] },
          { id: 'color-alt', group: 'Color', label: 'Color by altitude', run: () => setColorBy('alt') },
          { id: 'color-spd', group: 'Color', label: 'Color by speed', run: () => setColorBy('spd') },
          { id: 'color-cat', group: 'Color', label: 'Color by category', run: () => setColorBy('cat') },
          { id: 'color-mil', group: 'Color', label: 'Highlight military', run: () => setColorBy('mil') },
          { id: 'clear-sel', group: 'Nav', label: 'Clear selection', hint: 'ESC', run: () => { setSelected(null); setSelectedAirport(null) } },
          { id: 'help', group: 'Nav', label: 'Keyboard shortcuts', hint: '?', run: () => setShowHelp(v => !v) },
          { id: 'styles-panel', group: 'View', label: 'Open map styles panel', hint: 'M', run: () => setShowStyles(v => !v) },
          { id: 'goto-world', group: 'Nav', label: 'Go to world view', run: () => { try { mapRef.current?.flyTo({ center: [0, 20], zoom: 2, duration: 900 }) } catch {} } },
          { id: 'locate', group: 'Nav', label: 'Locate me', run: () => {
            if (!navigator.geolocation) return
            navigator.geolocation.getCurrentPosition(p => {
              setUserLoc({ lat: p.coords.latitude, lng: p.coords.longitude })
              try { mapRef.current?.flyTo({ center: [p.coords.longitude, p.coords.latitude], zoom: 9, duration: 900 }) } catch {}
            })
          } },
        ]), [showTrails, showWeather, showNight, showHeat, showList, show3D, chase, follow, audioOn, selected, showRadar, showRuler])}
      />
      <OfflineBanner />
      <ToastHost />
      <EmergencyLive text={emergLog[0] ? `Emergency squawk ${emergLog[0].sq} from ${emergLog[0].cs || emergLog[0].icao}` : ''} />
      <div id="map-main" ref={mapEl} className="absolute inset-0 z-0" style={{ width: '100%', height: '100%' }} />

      {/* Emergency banner */}
      {stats.emerg > 0 && (
        <div className="absolute top-0 inset-x-0 z-30 flex justify-center pointer-events-none pt-2">
          <div className="pointer-events-auto bg-rose-600/95 border border-rose-400 rounded-full px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-white shadow-2xl animate-pulse">
            ⚠ {stats.emerg} emergency squawk{stats.emerg > 1 ? 's' : ''} in view
          </div>
        </div>
      )}

      {/* Top bar */}
      <header className="absolute top-0 inset-x-0 z-20 flex items-start justify-between gap-2 sm:gap-3 p-2 sm:p-3 md:p-4 pointer-events-none">
        <div className="pointer-events-auto bg-slate-950/85 backdrop-blur-xl border border-slate-800 rounded-2xl px-2.5 sm:px-3 md:px-4 py-2 sm:py-2.5 shadow-2xl flex items-center gap-2 sm:gap-3 min-w-0">
          <PlaneLogo />
          <div className="min-w-0">
            <div className="hidden xs:block text-sm md:text-base font-bold tracking-tight leading-none">Flight Tracker</div>
            <div className="flex items-center gap-1.5 mt-0.5 sm:mt-1 text-[10px] uppercase tracking-widest">
              <span className={`size-1.5 rounded-full ${status==='live'?'bg-emerald-400 live-dot':status==='error'?'bg-rose-500':'bg-amber-400 live-dot'}`} />
              <span className="text-slate-400 truncate max-w-[40vw] sm:max-w-none">
                {status === 'live' ? `Live · ${flights.length} ac` : status === 'error' ? 'Conn. error' : 'Loading'}
                {lastUpdate && status==='live' && <span className="hidden sm:inline"> · {lastUpdate.toLocaleTimeString()}</span>}
              </span>
            </div>
          </div>
        </div>

        <div className="pointer-events-auto flex items-center gap-2">
          <div className="hidden sm:flex bg-slate-950/85 backdrop-blur-xl border border-slate-800 rounded-2xl px-2 py-1.5 shadow-2xl items-center gap-1">
            <Toggle on={showTrails} onClick={()=>setShowTrails(v=>!v)} label="Trails" hint="T" />
            <Toggle on={showWeather} onClick={()=>setShowWeather(v=>!v)} label="Weather" hint="W" />
            <Toggle on={showNight} onClick={()=>setShowNight(v=>!v)} label="Night" hint="N" />
            <Toggle on={show3D} onClick={()=>setShow3D(v=>!v)} label="3D" />
            <Toggle on={showList} onClick={()=>setShowList(v=>!v)} label="List" hint="L" />
            <Toggle on={showFilters} onClick={()=>setShowFilters(v=>!v)} label="Filter" />
            <Toggle on={showLayers} onClick={()=>setShowLayers(v=>!v)} label={`Layers${activeLayerCount?` ${activeLayerCount}`:''}`} />
          </div>
          <div className="relative hidden sm:block">
          <div className="bg-slate-950/85 backdrop-blur-xl border border-slate-800 rounded-2xl px-3 py-2 shadow-2xl items-center gap-2 w-44 sm:w-60 flex">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-slate-400 shrink-0"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/><path d="m20 20-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            <input id="search-input" value={query} onChange={e=>{setQuery(e.target.value); setSearchOpen(true)}}
                   onFocus={()=>setSearchOpen(true)} onBlur={()=>setTimeout(()=>setSearchOpen(false), 200)}
                   placeholder="Search (press /)"
                   className="bg-transparent text-sm placeholder:text-slate-500 outline-none flex-1 text-slate-100" />
            {query && <button onClick={()=>setQuery('')} className="text-slate-500 hover:text-slate-200 text-xs">✕</button>}
          </div>
          {searchOpen && query.trim().length >= 1 && (
            <div className="absolute top-full mt-1 right-0 w-[min(80vw,16rem)] max-h-72 overflow-y-auto bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-xl shadow-2xl z-30">
              {filtered.slice(0, 12).map(f => (
                <button key={f.icao} onMouseDown={()=>{ setSelected(f); flyToLatLng(f.lat, f.lng, Math.max(mapRef.current?.getZoom() ?? 0, 8)); setSearchOpen(false) }}
                  className="w-full text-left px-3 py-2 hover:bg-slate-800/60 border-b border-slate-900 last:border-0 flex items-center gap-2">
                  <span className="text-xs">{regFlag(f.registration)?.flag || '\u2708'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs font-bold text-slate-100 truncate">{f.callsign}</div>
                    <div className="text-[10px] text-slate-500 truncate">{f.registration} · {f.type}</div>
                  </div>
                  <div className="text-[10px] font-mono" style={{color: altColor(f.altitudeFt)}}>{f.ground?'GND':(f.altitudeFt/1000).toFixed(0)+'k'}</div>
                </button>
              ))}
              {filtered.length === 0 && <div className="px-3 py-4 text-xs text-slate-500 text-center">No matches</div>}
            </div>
          )}
          </div>
          {/* Mobile: search icon */}
          <button onClick={()=>setMobileSearch(v=>!v)} aria-label="Search"
            className="sm:hidden bg-slate-950/85 backdrop-blur-xl border border-slate-800 rounded-xl size-11 flex items-center justify-center text-slate-300 active:bg-slate-800 shadow-2xl">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/><path d="m20 20-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          </button>
          {/* Mobile: hamburger */}
          <button onClick={()=>setMobileMenu(v=>!v)} aria-label="Menu"
            className="sm:hidden bg-slate-950/85 backdrop-blur-xl border border-slate-800 rounded-xl size-11 flex items-center justify-center text-slate-300 active:bg-slate-800 shadow-2xl">
            {mobileMenu ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            )}
          </button>
        </div>
      </header>

      {/* Mobile search bar (slides under header) */}
      {mobileSearch && (
        <div className="sm:hidden absolute top-[64px] left-3 right-3 z-30 pointer-events-auto">
          <div className="bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl px-3 py-2.5 shadow-2xl flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-slate-400 shrink-0"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/><path d="m20 20-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            <input autoFocus value={query} onChange={e=>setQuery(e.target.value)} placeholder="Callsign, type, op…"
              className="bg-transparent text-sm placeholder:text-slate-500 outline-none flex-1 text-slate-100" />
            <button onClick={()=>{setQuery(''); setMobileSearch(false)}} className="text-slate-500 text-sm">✕</button>
          </div>
        </div>
      )}

      {/* Mobile menu sheet */}
      {mobileMenu && (
        <div className="sm:hidden absolute inset-x-3 top-[64px] z-30 pointer-events-auto bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl p-3 grid grid-cols-3 xs:grid-cols-3 gap-2 max-h-[60vh] overflow-y-auto">
          {([
            ['Trails', showTrails, ()=>setShowTrails(v=>!v)],
            ['Weather', showWeather, ()=>setShowWeather(v=>!v)],
            ['Night', showNight, ()=>setShowNight(v=>!v)],
            ['Heat', showHeat, ()=>setShowHeat(v=>!v)],
            ['3D', show3D, ()=>setShow3D(v=>!v)],
            ['Chase', chase, ()=>{ if(!selected) return; setChase(v=>{ const nv=!v; chaseRef.current=nv; if(nv){setShow3D(true)} return nv })}],
            ['List', showList, ()=>setShowList(v=>!v)],
            [`Watch${watchlist.length?` ${watchlist.length}`:''}`, showWatch, ()=>setShowWatch(v=>!v)],
            ['Filter', showFilters, ()=>setShowFilters(v=>!v)],
            ['Stats', showStats, ()=>setShowStats(v=>!v)],
            ...(compareList.length>0 ? [[`⇄ ${compareList.length}`, showCompare, ()=>setShowCompare(v=>!v)] as [string,boolean,()=>void]] : []),
          ] as [string, boolean, ()=>void][]).map(([label,on,fn]) => (
            <button key={label} onClick={()=>{ fn(); }}
              className={`min-h-11 px-2 py-3 rounded-xl text-xs font-semibold border transition active:scale-95 ${on?'bg-sky-500 text-slate-950 border-sky-400':'bg-slate-900/80 text-slate-300 border-slate-800'}`}>{label}</button>
          ))}
        </div>
      )}

      {/* Stats strip */}
      <div className="absolute top-[56px] md:top-[68px] left-2 sm:left-3 md:left-4 right-2 sm:right-auto z-20 pointer-events-none">
        <div className="pointer-events-auto bg-slate-950/85 backdrop-blur-xl border border-slate-800 rounded-2xl px-3 md:px-4 py-2 md:py-3 shadow-2xl grid grid-cols-2 sm:grid-cols-4 gap-x-4 sm:gap-x-6 gap-y-2 sm:gap-y-2.5 w-full sm:w-[min(96vw,600px)]">
          <Stat label="Shown" value={stats.total.toLocaleString()} color="text-slate-100" />
          <Stat label="Airborne" value={stats.airborne.toLocaleString()} color="text-slate-100" />
          <Stat label="Avg alt" value={`${(stats.avgAlt/1000).toFixed(1)}k ft`} color="text-slate-100" />
          <Stat label="Avg speed" value={`${Math.round(stats.avgVel)} kt`} color="text-slate-100" />
        </div>
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div className="absolute z-20 shadow-2xl bg-slate-950/95 backdrop-blur-xl border border-slate-800
          sm:top-[140px] md:top-[150px] sm:left-3 md:left-4 sm:w-[min(94vw,360px)] sm:rounded-2xl sm:bottom-auto sm:inset-x-auto
          inset-x-0 bottom-0 rounded-t-2xl max-h-[75vh] overflow-y-auto p-4 ft-sheet ft-safe-pb">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs uppercase tracking-widest text-slate-400 font-semibold">Filters</div>
            <button onClick={()=>setShowFilters(false)} className="size-6 rounded-md hover:bg-slate-800 flex items-center justify-center text-slate-400">✕</button>
          </div>
          <div className="space-y-3 text-sm">
            <div>
              <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-500 mb-1">
                <span>Altitude (ft)</span><span className="font-mono text-slate-300">{altMin.toLocaleString()} – {altMax.toLocaleString()}</span>
              </div>
              <div className="flex gap-2 items-center">
                <input type="range" min={0} max={50000} step={1000} value={altMin} onChange={e=>setAltMin(Math.min(+e.target.value, altMax-1000))} className="flex-1 accent-sky-500" />
                <input type="range" min={0} max={50000} step={1000} value={altMax} onChange={e=>setAltMax(Math.max(+e.target.value, altMin+1000))} className="flex-1 accent-sky-500" />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-500 mb-1">
                <span>Min ground speed (kt)</span><span className="font-mono text-slate-300">{spdMin}</span>
              </div>
              <input type="range" min={0} max={600} step={10} value={spdMin} onChange={e=>setSpdMin(+e.target.value)} className="w-full accent-sky-500" />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">Airline / callsign prefix</div>
              <input value={airlinePrefix} onChange={e=>setAirlinePrefix(e.target.value)} placeholder="e.g. UAL, BAW, SWA"
                className="w-full bg-slate-900/70 border border-slate-800 rounded-lg px-2 py-1 text-xs font-mono uppercase placeholder-slate-600 focus:outline-none focus:border-sky-600" />
            </div>
            <CheckRow label="Hide on-ground" checked={hideGround} onChange={setHideGround} />
            <CheckRow label="Only military" checked={onlyMil} onChange={setOnlyMil} />
            <CheckRow label="Only emergency squawks (7500/7600/7700)" checked={onlyEmerg} onChange={setOnlyEmerg} />
            <div className="pt-2 border-t border-slate-800">
              <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5">Color planes by</div>
              <div className="flex gap-1">
                {([['alt','Altitude'],['spd','Speed'],['cat','Category'],['mil','Military']] as const).map(([k,l]) => (
                  <button key={k} onClick={()=>setColorBy(k)}
                    className={`flex-1 px-2 py-1.5 rounded-md text-[10px] uppercase tracking-wider font-semibold border ${colorBy===k?'bg-sky-500 text-slate-950 border-sky-400':'bg-slate-900/70 text-slate-300 border-slate-800'}`}>{l}</button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5">Units</div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <div className="text-[9px] text-slate-600 mb-0.5">Altitude</div>
                  <div className="flex gap-1">
                    {(['ft','m'] as const).map(u => (
                      <button key={u} onClick={()=>setUnits(prev=>({...prev, alt:u}))}
                        className={`flex-1 px-2 py-1 rounded text-[10px] font-mono ${units.alt===u?'bg-sky-500 text-slate-950':'bg-slate-900/70 text-slate-300 border border-slate-800'}`}>{u}</button>
                    ))}
                  </div>
                </div>
                <div className="flex-1">
                  <div className="text-[9px] text-slate-600 mb-0.5">Speed</div>
                  <div className="flex gap-1">
                    {(['kt','mph','kmh'] as const).map(u => (
                      <button key={u} onClick={()=>setUnits(prev=>({...prev, spd:u}))}
                        className={`flex-1 px-2 py-1 rounded text-[10px] font-mono ${units.spd===u?'bg-sky-500 text-slate-950':'bg-slate-900/70 text-slate-300 border border-slate-800'}`}>{u}</button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <CheckRow label="Audio chime on emergency / watch alerts" checked={audioOn} onChange={setAudioOn} />
            <div className="pt-2 border-t border-slate-800 flex gap-2">
              <button onClick={()=>{
                if (!navigator.geolocation) return
                navigator.geolocation.getCurrentPosition(p => {
                  const loc = { lat: p.coords.latitude, lng: p.coords.longitude }
                  setUserLoc(loc); flyToLatLng(loc.lat, loc.lng, 9)
                }, () => {}, { enableHighAccuracy: false, timeout: 8000 })
              }} className="flex-1 text-[10px] uppercase tracking-widest bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold rounded-lg py-2">
                {userLoc ? '✓ Located' : 'Use my location'}
              </button>
              <button onClick={()=>{
                const rows = [['callsign','registration','type','operator','icao','lat','lng','alt_ft','speed_kt','track','squawk','ground','emergency']]
                for (const f of filtered) rows.push([f.callsign, f.registration, f.type, f.operator, f.icao, String(f.lat), String(f.lng), String(Math.round(f.altitudeFt)), String(Math.round(f.velocityKts)), String(Math.round(f.track)), f.squawk, String(f.ground), String(f.emergency)])
                const csv = rows.map(r => r.map(c => /[",\n]/.test(c)?`"${c.replace(/"/g,'""')}"`:c).join(',')).join('\n')
                const blob = new Blob([csv], { type: 'text/csv' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a'); a.href = url; a.download = `flights-${Date.now()}.csv`; a.click(); URL.revokeObjectURL(url)
              }} className="flex-1 text-[10px] uppercase tracking-widest bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold rounded-lg py-2">↓ CSV</button>
            </div>
          </div>
        </div>
      )}

      {/* Live list panel */}
      {showList && (
        <aside className="absolute z-20 bg-slate-950/90 backdrop-blur-xl border border-slate-800 shadow-2xl flex flex-col
          sm:right-3 md:right-4 sm:top-[68px] md:top-[80px] sm:bottom-3 md:bottom-4 sm:w-[min(94vw,340px)] sm:rounded-2xl sm:inset-x-auto
          inset-x-0 bottom-0 max-h-[70vh] rounded-t-2xl ft-sheet ft-safe-pb">
          <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
            <div className="text-xs uppercase tracking-widest text-slate-400 font-semibold">Live ({sortedList.length})</div>
            <div className="flex gap-1">
              {(['callsign','alt','spd'] as const).map(s => (
                <button key={s} onClick={()=>setListSort(s)}
                  className={`px-2 py-1 rounded text-[10px] uppercase tracking-widest ${listSort===s?'bg-sky-500 text-slate-950':'text-slate-400 hover:bg-slate-800'}`}>{s}</button>
              ))}
              <button onClick={()=>setShowList(false)} className="size-6 ml-1 rounded-md hover:bg-slate-800 flex items-center justify-center text-slate-400">✕</button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {sortedList.map(f => (
              <button key={f.icao}
                      onClick={()=>{ setSelected(f); flyToLatLng(f.lat, f.lng) }}
                      className={`w-full text-left px-4 py-2 border-b border-slate-800/60 hover:bg-slate-800/50 transition flex items-center gap-3 ${selected?.icao===f.icao?'bg-sky-500/10':''}`}>
                <div className={`size-2 rounded-full shrink-0 ${f.emergency?'bg-rose-500':f.ground?'bg-slate-500':'bg-emerald-400'}`} />
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-sm font-bold truncate">{f.callsign}</div>
                  <div className="text-[10px] text-slate-500 truncate">{f.type} · {f.registration}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs font-mono tabular-nums" style={{ color: altColor(f.altitudeFt) }}>{f.ground ? 'GND' : `${(f.altitudeFt/1000).toFixed(1)}k`}</div>
                  <div className="text-[10px] text-slate-500 font-mono">{Math.round(f.velocityKts)} kt</div>
                </div>
              </button>
            ))}
            {sortedList.length === 0 && (
              <div className="p-6 text-center text-xs text-slate-500">No aircraft match current filters.</div>
            )}
          </div>
        </aside>
      )}

      {/* Selected flight panel */}
      {selected && (
        <aside className={`absolute z-20 bg-slate-950/95 backdrop-blur-xl border border-slate-800 shadow-2xl
          sm:rounded-2xl ${showList ? 'sm:left-3 md:sm:left-4' : 'sm:right-3 md:right-4'} sm:bottom-3 md:bottom-4 sm:w-[min(94vw,380px)] sm:max-h-[70vh] sm:overflow-y-auto sm:inset-x-auto
          inset-x-0 bottom-0 max-h-[70vh] overflow-y-auto rounded-t-2xl ft-sheet ft-safe-pb`}>
          <button onClick={()=>setSelected(null)} className="absolute top-3 right-3 size-7 rounded-lg bg-slate-900/70 hover:bg-slate-800 flex items-center justify-center text-slate-400 hover:text-slate-100 transition z-10">✕</button>
          {photo && (
            <div className="relative h-40 bg-slate-900">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photo} alt={selected.callsign} className="w-full h-full object-cover" />
              <div className="absolute inset-0 bg-gradient-to-t from-slate-950 to-transparent" />
            </div>
          )}
          <div className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-slate-500">
                  {selected.emergency ? <span className="text-rose-400 font-bold">⚠ Emergency · {selected.squawk}</span> :
                   selected.ground ? 'On ground' : 'In flight'}
                </div>
                <div className="text-2xl font-bold tracking-tight mt-0.5 font-mono flex items-center gap-2">
                  {(() => { const fl = regFlag(selected.registration); return fl ? <span className="text-xl leading-none" title={fl.code}>{fl.flag}</span> : null })()}
                  <span>{selected.callsign}</span>
                  {isNotable(selected.callsign) && <span className="text-[9px] bg-violet-500/20 text-violet-300 border border-violet-500/40 rounded px-1.5 py-0.5 uppercase tracking-wider">Notable</span>}
                  {isWatched(selected) && <span className="text-[9px] bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 rounded px-1.5 py-0.5 uppercase tracking-wider">Watched</span>}
                </div>
                <div className="text-xs text-slate-400 mt-1">{selected.registration} · {selected.type}</div>
                {selected.operator !== '—' && <div className="text-xs text-slate-500 mt-0.5">{selected.operator}</div>}
                {(() => {
                  const ds = selected.dataSource
                  const map: Record<string,{l:string,c:string,t:string}> = {
                    adsb_icao:   {l:'ADS-B',  c:'bg-emerald-500/20 text-emerald-300 border-emerald-500/40', t:'Direct ADS-B w/ ICAO addr (most accurate)'},
                    adsb_other:  {l:'ADS-B?', c:'bg-emerald-500/15 text-emerald-300/80 border-emerald-500/30', t:'ADS-B w/ non-ICAO addr'},
                    adsr_icao:   {l:'ADS-R',  c:'bg-teal-500/20 text-teal-300 border-teal-500/40', t:'ADS-R rebroadcast'},
                    tisb_icao:   {l:'TIS-B',  c:'bg-sky-500/20 text-sky-300 border-sky-500/40', t:'TIS-B (FAA radar relay)'},
                    tisb_other:  {l:'TIS-B?', c:'bg-sky-500/15 text-sky-300/80 border-sky-500/30', t:'TIS-B non-ICAO'},
                    tisb_trackfile: {l:'TIS-B', c:'bg-sky-500/15 text-sky-300/80 border-sky-500/30', t:'TIS-B trackfile'},
                    mlat:        {l:'MLAT',   c:'bg-amber-500/20 text-amber-300 border-amber-500/40', t:'Multilateration (no ADS-B, position triangulated)'},
                    mode_s:      {l:'Mode-S', c:'bg-slate-600/30 text-slate-300 border-slate-500/40', t:'Mode-S only (no position broadcast, limited data)'},
                  }
                  const info = map[ds] || {l: ds.toUpperCase(), c:'bg-slate-700/30 text-slate-300 border-slate-600/40', t: ds}
                  return (
                    <div className="mt-1.5 inline-flex items-center gap-1">
                      <span title={info.t} className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${info.c} uppercase tracking-wider font-mono`}>
                        {info.l}
                      </span>
                    </div>
                  )
                })()}
                {selected.category && CAT_LABEL[selected.category] && (
                  <div className="text-[10px] text-slate-500 mt-0.5 uppercase tracking-widest">{CAT_LABEL[selected.category]}</div>
                )}
              </div>
            </div>

            {route?.airports && route.airports.length >= 2 && (() => {
              const orig = route.airports[0], dest = route.airports[route.airports.length-1]
              const hav = (a:number,b:number,c:number,d:number) => {
                const R=3440.065, toRad=(x:number)=>x*Math.PI/180
                const dLat=toRad(c-a), dLon=toRad(d-b)
                const s=Math.sin(dLat/2)**2 + Math.cos(toRad(a))*Math.cos(toRad(c))*Math.sin(dLon/2)**2
                return 2*R*Math.asin(Math.sqrt(s))
              }
              const total = hav(orig.lat,orig.lon,dest.lat,dest.lon)
              const remain = hav(selected.lat,selected.lng,dest.lat,dest.lon)
              const flown = Math.max(0, total - remain)
              const progress = total > 0 ? Math.min(1, flown/total) : 0
              const etaMin = selected.velocityKts > 50 ? Math.round(remain / selected.velocityKts * 60) : 0
              const etaText = etaMin > 0 ? (etaMin >= 60 ? `${Math.floor(etaMin/60)}h ${etaMin%60}m` : `${etaMin}m`) : '—'
              return (
                <div className="mt-4 bg-slate-900/60 border border-slate-800 rounded-xl p-3">
                  <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">Route {route.airline && <span className="text-slate-400 normal-case ml-1">· {route.airline}</span>}</div>
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <div className="text-center flex-1 min-w-0">
                      <div className="text-xl font-bold font-mono text-emerald-400">{orig.iata || orig.icao}</div>
                      <div className="text-[10px] text-slate-500 truncate">{orig.location}</div>
                    </div>
                    <div className="flex-[2] min-w-0">
                      <div className="relative h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-emerald-500 to-sky-400 rounded-full" style={{width:`${progress*100}%`}} />
                        <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 text-base" style={{left:`${progress*100}%`}}>✈</div>
                      </div>
                      <div className="flex justify-between text-[10px] text-slate-500 mt-1 font-mono">
                        <span>{Math.round(flown).toLocaleString()} nm</span>
                        <span className="text-amber-400">ETA {etaText}</span>
                        <span>{Math.round(remain).toLocaleString()} nm</span>
                      </div>
                    </div>
                    <div className="text-center flex-1 min-w-0">
                      <div className="text-xl font-bold font-mono text-sky-400">{dest.iata || dest.icao}</div>
                      <div className="text-[10px] text-slate-500 truncate">{dest.location}</div>
                    </div>
                  </div>
                </div>
              )
            })()}

            <div className="mt-4 grid grid-cols-2 gap-2.5 text-sm">
              <Field k="Altitude"   v={selected.ground ? 'Ground' : fmtAlt(selected.altitudeFt, units.alt)} />
              <Field k="V/Speed"    v={selected.vertRate ? `${selected.vertRate>0?'▲':'▼'} ${Math.abs(Math.round(selected.vertRate)).toLocaleString()} fpm` : '—'}
                     accent={selected.vertRate>200?'text-emerald-400':selected.vertRate<-200?'text-rose-400':undefined} />
              <Field k="Ground Spd" v={fmtSpd(selected.velocityKts, units.spd)} />
              <Field k="IAS / Mach" v={selected.ias || selected.mach ? `${selected.ias?fmtSpd(selected.ias, units.spd):'—'} / ${selected.mach?selected.mach.toFixed(2):'—'}` : '—'} />
              <Field k="Heading"    v={`${Math.round(selected.track)}° ${compass(selected.track)}`} />
              <Field k="Squawk"     v={selected.squawk || '—'} accent={selected.emergency ? 'text-rose-400' : undefined} />
              <Field k="Wind"       v={selected.windKts ? `${Math.round(selected.windDir)}° @ ${fmtSpd(selected.windKts, units.spd)}` : '—'} />
              <Field k="OAT"        v={Number.isFinite(selected.oat) ? `${Math.round(selected.oat)}°C` : '—'} />
              <Field k="A/P Target" v={selected.navAlt ? fmtAlt(selected.navAlt, units.alt) : '—'} />
              <Field k="ICAO"       v={selected.icao.toUpperCase()} />
              {userLoc && (() => {
                const R = 3440.065, toRad = (x:number)=>x*Math.PI/180
                const dLat = toRad(selected.lat - userLoc.lat), dLon = toRad(selected.lng - userLoc.lng)
                const s = Math.sin(dLat/2)**2 + Math.cos(toRad(userLoc.lat))*Math.cos(toRad(selected.lat))*Math.sin(dLon/2)**2
                const distNm = 2*R*Math.asin(Math.sqrt(s))
                const y = Math.sin(toRad(selected.lng-userLoc.lng))*Math.cos(toRad(selected.lat))
                const x = Math.cos(toRad(userLoc.lat))*Math.sin(toRad(selected.lat)) - Math.sin(toRad(userLoc.lat))*Math.cos(toRad(selected.lat))*Math.cos(toRad(selected.lng-userLoc.lng))
                const bearing = (Math.atan2(y,x)*180/Math.PI + 360) % 360
                return <Field k="From you" v={`${Math.round(distNm).toLocaleString()} nm · ${Math.round(bearing)}° ${compass(bearing)}`} wide />
              })()}
              <Field k="Position"   v={`${selected.lat.toFixed(3)}, ${selected.lng.toFixed(3)}`} wide />
            </div>

            <div className="mt-4 flex gap-2">
              <button onClick={()=>setFollow(v=>!v)}
                      className={`flex-1 text-center text-xs uppercase tracking-widest font-bold rounded-xl py-2.5 transition ${follow?'bg-amber-500 text-slate-950 hover:bg-amber-400':'bg-slate-800 text-slate-200 hover:bg-slate-700'}`}>
                {follow ? '● Following' : 'Follow (F)'}
              </button>
              <a href={`https://globe.adsb.lol/?icao=${selected.icao}`} target="_blank" rel="noreferrer"
                 className="flex-1 text-center text-xs uppercase tracking-widest bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold rounded-xl py-2.5 transition">
                Globe ↗
              </a>
            </div>

            {!photo && (
              <div className="mt-3 text-[10px] text-slate-600 text-center">Photo via planespotters.net — none on file for this aircraft</div>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => {
                  if (compareList.find(c => c.icao === selected.icao)) {
                    setCompareList(prev => prev.filter(c => c.icao !== selected.icao))
                  } else if (compareList.length < 4) {
                    setCompareList(prev => [...prev, selected])
                    setShowCompare(true)
                  }
                }}
                className={`flex-1 min-w-[60px] text-center text-[10px] uppercase tracking-widest font-bold rounded-xl py-2 transition ${compareList.find(c=>c.icao===selected.icao)?'bg-violet-600 text-white hover:bg-violet-500':'bg-slate-800 text-slate-200 hover:bg-slate-700'}`}>
                {compareList.find(c=>c.icao===selected.icao) ? '✓ COMPARE' : '⇄ COMPARE'}
              </button>
              <button
                onClick={() => {
                  const trail = trailsRef.current.get(selected.icao) || []
                  const coords = trail.map(([la,ln]) => `${ln},${la},${0}`).join(' ')
                  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
<name>${selected.callsign} (${selected.icao.toUpperCase()})</name>
<description>Tracked via sanjays2402.github.io/flight-tracker · ${new Date().toISOString()}</description>
<Style id="t"><LineStyle><color>ff00d4ff</color><width>3</width></LineStyle></Style>
<Placemark><name>Trail</name><styleUrl>#t</styleUrl><LineString><coordinates>${coords}</coordinates></LineString></Placemark>
<Placemark><name>Current</name><Point><coordinates>${selected.lng},${selected.lat},${selected.altitudeFt*0.3048}</coordinates></Point></Placemark>
</Document></kml>`
                  const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url; a.download = `${selected.callsign || selected.icao}.kml`
                  a.click(); URL.revokeObjectURL(url)
                }}
                className="flex-1 text-center text-[10px] uppercase tracking-widest bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold rounded-xl py-2 transition">
                ↓ KML
              </button>
              <button
                onClick={() => {
                  const json = {
                    captured: new Date().toISOString(),
                    aircraft: selected,
                    trail: trailsRef.current.get(selected.icao) || [],
                    route: routeCacheRef.current.get(selected.callsign?.toUpperCase()) || null,
                  }
                  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url; a.download = `${selected.callsign || selected.icao}.json`
                  a.click(); URL.revokeObjectURL(url)
                }}
                className="flex-1 text-center text-[10px] uppercase tracking-widest bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold rounded-xl py-2 transition">
                ↓ JSON
              </button>
              <button
                onClick={async () => {
                  const url = `${location.origin}${location.pathname}#lat=${selected.lat.toFixed(3)}&lng=${selected.lng.toFixed(3)}&z=8&icao=${selected.icao}`
                  try {
                    await navigator.clipboard.writeText(url)
                    setShareCopied(true)
                    setTimeout(()=>setShareCopied(false), 1800)
                  } catch {}
                }}
                className="flex-1 text-center text-[10px] uppercase tracking-widest bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold rounded-xl py-2 transition">
                {shareCopied ? '✓ COPIED' : '↗ SHARE'}
              </button>
            </div>
          </div>
        </aside>
      )}

      {selectedAirport && (() => {
        const ap = selectedAirport
        const hav = (a:number,b:number,c:number,d:number) => {
          const R=3440.065, toRad=(x:number)=>x*Math.PI/180
          const dLat=toRad(c-a), dLon=toRad(d-b)
          const s=Math.sin(dLat/2)**2 + Math.cos(toRad(a))*Math.cos(toRad(c))*Math.sin(dLon/2)**2
          return 2*R*Math.asin(Math.sqrt(s))
        }
        const bear = (lat1:number,lon1:number,lat2:number,lon2:number) => {
          const toRad=(x:number)=>x*Math.PI/180
          const dLon = toRad(lon2-lon1)
          const y = Math.sin(dLon)*Math.cos(toRad(lat2))
          const x = Math.cos(toRad(lat1))*Math.sin(toRad(lat2)) - Math.sin(toRad(lat1))*Math.cos(toRad(lat2))*Math.cos(dLon)
          return (Math.atan2(y,x)*180/Math.PI + 360) % 360
        }
        const angDiff = (a:number,b:number) => { const d=Math.abs(a-b)%360; return d>180?360-d:d }

        const arrivals: {f: Flight; distNm: number; etaMin: number; tag: string}[] = []
        const departures: {f: Flight; distNm: number; tag: string}[] = []
        for (const f of flights) {
          const cs = f.callsign.replace(/\s+/g, '')
          const cached = routeCacheRef.current.get(cs)
          if (cached?.airports?.length) {
            const orig = cached.airports[0], dest = cached.airports[cached.airports.length-1]
            if (dest.icao === ap.i || dest.iata === ap.a) {
              const d = hav(f.lat,f.lng,ap.lat,ap.lon)
              const eta = f.velocityKts > 50 ? Math.round(d/f.velocityKts*60) : 0
              arrivals.push({f, distNm: d, etaMin: eta, tag: orig.iata || orig.icao})
              continue
            }
            if (orig.icao === ap.i || orig.iata === ap.a) {
              const d = hav(f.lat,f.lng,ap.lat,ap.lon)
              departures.push({f, distNm: d, tag: dest.iata || dest.icao})
              continue
            }
          }
          const d = hav(f.lat,f.lng,ap.lat,ap.lon)
          if (d > 80 || f.ground) continue
          const bFromAp = bear(ap.lat, ap.lon, f.lat, f.lng)
          const inbound = angDiff(f.track, (bFromAp+180)%360) < 50
          const outbound = angDiff(f.track, bFromAp) < 50
          if (inbound && f.vertRate < 200 && f.altitudeFt < 15000) {
            const eta = f.velocityKts > 50 ? Math.round(d/f.velocityKts*60) : 0
            arrivals.push({f, distNm: d, etaMin: eta, tag: '?'})
          } else if (outbound && f.vertRate > 200 && f.altitudeFt < 20000) {
            departures.push({f, distNm: d, tag: '?'})
          }
        }
        arrivals.sort((a,b)=> a.distNm - b.distNm)
        departures.sort((a,b)=> a.distNm - b.distNm)

        return (
          <aside className="absolute top-3 right-3 z-20 w-[95vw] max-w-[340px] max-h-[calc(100vh-100px)] overflow-hidden flex flex-col bg-slate-950/95 backdrop-blur-xl border border-sky-700/60 rounded-2xl shadow-2xl shadow-sky-900/50">
            <button onClick={()=>setSelectedAirport(null)} className="absolute top-3 right-3 size-7 rounded-lg bg-slate-900/70 hover:bg-slate-800 flex items-center justify-center text-slate-400 hover:text-slate-100 transition z-10">✕</button>
            <div className="p-4 pb-2 border-b border-slate-800">
              <div className="text-[10px] uppercase tracking-widest text-sky-400 mb-1">Airport</div>
              <div className="text-2xl font-bold font-mono text-sky-300">{ap.a}</div>
              <div className="text-sm text-slate-300 truncate">{ap.n}</div>
              <div className="text-[11px] text-slate-500 truncate">{ap.m} · {ap.i}</div>
              {airportMetar && (
                <div className="mt-3 pt-3 border-t border-slate-800/80">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[10px] uppercase tracking-widest text-amber-400">METAR · Live wx</div>
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                      airportMetar.fltCat === 'VFR' ? 'bg-emerald-500/15 text-emerald-300' :
                      airportMetar.fltCat === 'MVFR' ? 'bg-sky-500/15 text-sky-300' :
                      airportMetar.fltCat === 'IFR' ? 'bg-amber-500/15 text-amber-300' :
                      'bg-rose-500/15 text-rose-300'
                    }`}>{airportMetar.fltCat || '—'}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                    <div><span className="text-slate-500">Temp</span> <span className="text-slate-200 font-mono">{airportMetar.temp?.toFixed?.(0) ?? '—'}°C</span></div>
                    <div><span className="text-slate-500">Dew</span> <span className="text-slate-200 font-mono">{airportMetar.dewp?.toFixed?.(0) ?? '—'}°C</span></div>
                    <div><span className="text-slate-500">Wind</span> <span className="text-slate-200 font-mono">{airportMetar.wdir ?? '—'}° / {airportMetar.wspd ?? '—'}kt</span></div>
                    <div><span className="text-slate-500">Vis</span> <span className="text-slate-200 font-mono">{airportMetar.visib ?? '—'} sm</span></div>
                    <div className="col-span-2"><span className="text-slate-500">Altim</span> <span className="text-slate-200 font-mono">{airportMetar.altim?.toFixed?.(1) ?? '—'} hPa</span></div>
                  </div>
                  <div className="mt-2 text-[10px] font-mono text-slate-500 break-all leading-relaxed">{airportMetar.rawOb}</div>
                </div>
              )}
            </div>
            <div className="flex border-b border-slate-800 text-[10px] uppercase tracking-widest">
              <div className="flex-1 py-2 text-center text-emerald-400 font-bold border-r border-slate-800">
                ↓ Arrivals <span className="text-slate-500 ml-1">{arrivals.length}</span>
              </div>
              <div className="flex-1 py-2 text-center text-amber-400 font-bold">
                ↑ Departures <span className="text-slate-500 ml-1">{departures.length}</span>
              </div>
            </div>
            <div className="flex flex-1 overflow-hidden">
              <div className="flex-1 overflow-y-auto border-r border-slate-800">
                {arrivals.length === 0 && <div className="p-3 text-[11px] text-slate-500 text-center">None inbound</div>}
                {arrivals.slice(0, 30).map(({f, distNm, etaMin, tag}) => (
                  <button key={f.icao} onClick={()=>{ setSelected(f); flyToLatLng(f.lat,f.lng) }}
                          className="w-full text-left px-2.5 py-1.5 hover:bg-slate-900 border-b border-slate-900 transition">
                    <div className="flex items-baseline justify-between gap-1">
                      <span className="font-mono font-bold text-emerald-300 text-[11px]">{f.callsign}</span>
                      <span className="text-[9px] text-amber-400 font-mono">{etaMin>0?`${etaMin}m`:'—'}</span>
                    </div>
                    <div className="flex items-baseline justify-between text-[9px] text-slate-500 font-mono">
                      <span>{tag!=='?'? `from ${tag}` : 'inbound'}</span>
                      <span>{Math.round(distNm)}nm · {Math.round(f.altitudeFt/1000)}k</span>
                    </div>
                  </button>
                ))}
              </div>
              <div className="flex-1 overflow-y-auto">
                {departures.length === 0 && <div className="p-3 text-[11px] text-slate-500 text-center">None outbound</div>}
                {departures.slice(0, 30).map(({f, distNm, tag}) => (
                  <button key={f.icao} onClick={()=>{ setSelected(f); flyToLatLng(f.lat,f.lng) }}
                          className="w-full text-left px-2.5 py-1.5 hover:bg-slate-900 border-b border-slate-900 transition">
                    <div className="flex items-baseline justify-between gap-1">
                      <span className="font-mono font-bold text-amber-300 text-[11px]">{f.callsign}</span>
                      <span className="text-[9px] text-sky-400 font-mono">▲ {Math.round(f.vertRate)}fpm</span>
                    </div>
                    <div className="flex items-baseline justify-between text-[9px] text-slate-500 font-mono">
                      <span>{tag!=='?'? `to ${tag}` : 'outbound'}</span>
                      <span>{Math.round(distNm)}nm · {Math.round(f.altitudeFt/1000)}k</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
            <div className="text-[9px] text-slate-600 text-center py-1.5 border-t border-slate-800">
              Derived from live ADS-B + cached routes
            </div>
          </aside>
        )
      })()}

      {/* Watchlist panel */}
      {showWatch && (
        <aside className="absolute z-20 bg-slate-950/95 backdrop-blur-xl border border-sky-700/60 shadow-2xl shadow-sky-900/40 flex flex-col
          sm:top-16 sm:right-3 sm:w-[95vw] sm:max-w-[300px] sm:max-h-[60vh] sm:rounded-2xl sm:inset-x-auto sm:bottom-auto
          inset-x-0 bottom-0 max-h-[70vh] rounded-t-2xl ft-sheet ft-safe-pb">
          <div className="p-3 border-b border-slate-800 flex items-baseline justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-sky-400">Watchlist</div>
              <div className="text-xs text-slate-400 mt-0.5">{watchlist.length} entries · ping on contact</div>
            </div>
            <button onClick={()=>setShowWatch(false)} className="text-slate-400 hover:text-slate-100 text-sm">✕</button>
          </div>
          <form onSubmit={e=>{
            e.preventDefault()
            const v = watchInput.trim().toUpperCase()
            if (!v || watchlist.includes(v)) return
            setWatchlist([...watchlist, v])
            setWatchInput('')
          }} className="p-2 border-b border-slate-800">
            <div className="flex gap-2">
              <input value={watchInput} onChange={e=>setWatchInput(e.target.value)}
                     placeholder="Callsign or registration"
                     className="flex-1 bg-slate-900/70 border border-slate-700 rounded-lg px-2 py-1 text-xs font-mono placeholder-slate-600 focus:outline-none focus:border-sky-600" />
              <button type="submit" className="bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold px-3 rounded-lg">+</button>
            </div>
            <div className="text-[9px] text-slate-500 mt-1.5">e.g. UAL123, AAL2401, BAW283, N628TS</div>
          </form>
          <div className="flex-1 overflow-y-auto">
            {watchlist.length === 0 && (
              <div className="p-4 text-center text-[11px] text-slate-500">
                Empty. Add a callsign — you&apos;ll get audio + visual alert next time it broadcasts.
              </div>
            )}
            {watchlist.map(w => {
              const live = flights.find(f => {
                const cs = f.callsign.replace(/\s+/g,'').toUpperCase()
                const reg = f.registration.replace(/\s+/g,'').toUpperCase()
                return cs===w || reg===w || cs.startsWith(w)
              })
              return (
                <div key={w} className="px-3 py-2 border-b border-slate-900 flex items-center justify-between gap-2 hover:bg-slate-900/50">
                  <button onClick={()=>{
                    if (live) { setSelected(live); flyToLatLng(live.lat, live.lng, Math.max(mapRef.current?.getZoom() ?? 0, 7)) }
                  }} className="flex-1 text-left">
                    <div className="font-mono text-sm text-sky-300 font-bold">{w}</div>
                    <div className="text-[10px] text-slate-500 mt-0.5">
                      {live ? <span className="text-emerald-400">● LIVE · {Math.round(live.altitudeFt/100)/10}k ft · {Math.round(live.velocityKts)}kt</span> : <span className="text-slate-600">offline</span>}
                    </div>
                  </button>
                  <button onClick={()=>setWatchlist(watchlist.filter(x=>x!==w))}
                          className="text-slate-600 hover:text-rose-400 text-xs">✕</button>
                </div>
              )
            })}
          </div>
        </aside>
      )}

      {/* Compare panel */}
      {showCompare && compareList.length > 0 && (
        <aside className="absolute z-30 bg-slate-950/95 backdrop-blur-xl border border-violet-700/50 shadow-2xl shadow-violet-900/30
          sm:left-1/2 sm:-translate-x-1/2 sm:bottom-12 sm:w-[95vw] sm:max-w-[820px] sm:rounded-2xl
          inset-x-0 bottom-0 rounded-t-2xl ft-sheet ft-safe-pb max-h-[70vh] overflow-y-auto">
          <div className="px-4 py-2 border-b border-slate-800 flex items-baseline justify-between">
            <div className="text-[10px] uppercase tracking-widest text-violet-400">Compare · {compareList.length} aircraft</div>
            <div className="flex items-center gap-3">
              <button onClick={()=>setCompareList([])} className="text-[10px] text-slate-500 hover:text-rose-400 uppercase tracking-wider">Clear</button>
              <button onClick={()=>setShowCompare(false)} className="text-slate-400 hover:text-slate-100 text-sm">✕</button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[9px] uppercase tracking-wider text-slate-500 bg-slate-900/40">
                  <th className="text-left px-3 py-2 font-medium">Metric</th>
                  {compareList.map(f => (
                    <th key={f.icao} className="text-left px-3 py-2 font-medium">
                      <button onClick={()=>{setSelected(f); flyToLatLng(f.lat,f.lng,Math.max(mapRef.current?.getZoom() ?? 0, 7))}}
                              className="hover:text-violet-300">
                        <span className="font-mono text-violet-300 font-bold normal-case tracking-normal text-xs">{f.callsign}</span>
                      </button>
                      <button onClick={()=>setCompareList(prev=>prev.filter(c=>c.icao!==f.icao))}
                              className="ml-1.5 text-slate-600 hover:text-rose-400">✕</button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="font-mono">
                {([
                  ['Type',        (f: Flight) => f.type],
                  ['Registration',(f: Flight) => f.registration],
                  ['Operator',    (f: Flight) => f.operator],
                  ['Altitude',    (f: Flight) => f.ground ? 'Ground' : `${Math.round(f.altitudeFt).toLocaleString()} ft`],
                  ['Speed',       (f: Flight) => `${Math.round(f.velocityKts)} kt`],
                  ['Heading',     (f: Flight) => `${Math.round(f.track)}°`],
                  ['V/Speed',     (f: Flight) => f.vertRate != null ? `${f.vertRate>0?'▲':f.vertRate<0?'▼':'–'} ${Math.abs(Math.round(f.vertRate))} fpm` : '—'],
                  ['IAS',         (f: Flight) => f.ias ? `${Math.round(f.ias)} kt` : '—'],
                  ['Mach',        (f: Flight) => f.mach ? f.mach.toFixed(2) : '—'],
                  ['Wind',        (f: Flight) => (f.windKts && f.windDir!=null && !isNaN(f.windDir)) ? `${Math.round(f.windDir)}° @ ${Math.round(f.windKts)} kt` : '—'],
                  ['OAT',         (f: Flight) => (f.oat!=null && !isNaN(f.oat)) ? `${f.oat}°C` : '—'],
                  ['A/P Target',  (f: Flight) => f.navAlt ? `${Math.round(f.navAlt).toLocaleString()} ft` : '—'],
                  ['Squawk',      (f: Flight) => f.squawk || '—'],
                  ['Source',      (f: Flight) => f.dataSource],
                ] as Array<[string, (f: Flight) => any]>).map(([label, getter]) => (
                  <tr key={label} className="border-t border-slate-900 hover:bg-slate-900/30">
                    <td className="text-[10px] uppercase tracking-widest text-slate-500 px-3 py-1.5 font-sans">{label}</td>
                    {compareList.map(f => (
                      <td key={f.icao} className="px-3 py-1.5 text-slate-200">{String(getter(f))}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </aside>
      )}

      {/* Stats Dashboard */}
      {showStats && (() => {
        // Top operators
        const opCounts = new Map<string, number>()
        for (const f of filtered) { const k = (f.operator||'—').trim(); if(!k||k==='—') continue; opCounts.set(k,(opCounts.get(k)||0)+1) }
        const topOps = [...opCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6)
        // Aircraft type
        const typeCounts = new Map<string, number>()
        for (const f of filtered) { const k = (f.type||'').trim(); if(!k) continue; typeCounts.set(k,(typeCounts.get(k)||0)+1) }
        const topTypes = [...typeCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6)
        // Country (first 3 chars of icao24 hex → country, complex; fallback: registration prefix)
        const countryCounts = new Map<string, number>()
        for (const f of filtered) {
          const r = (f.registration||'').toUpperCase()
          let cc = '—'
          if (r.startsWith('N')) cc='🇺🇸 US'
          else if (r.startsWith('G-')) cc='🇬🇧 UK'
          else if (r.startsWith('D-')) cc='🇩🇪 DE'
          else if (r.startsWith('F-')) cc='🇫🇷 FR'
          else if (r.startsWith('C-')) cc='🇨🇦 CA'
          else if (r.startsWith('JA')) cc='🇯🇵 JP'
          else if (r.startsWith('VH-')) cc='🇦🇺 AU'
          else if (r.startsWith('VT-')) cc='🇮🇳 IN'
          else if (r.startsWith('EC-')) cc='🇪🇸 ES'
          else if (r.startsWith('EI-')) cc='🇮🇪 IE'
          else if (r.startsWith('OO-')) cc='🇧🇪 BE'
          else if (r.startsWith('PH-')) cc='🇳🇱 NL'
          else if (r.startsWith('LN-')) cc='🇳🇴 NO'
          else if (r.startsWith('SE-')) cc='🇸🇪 SE'
          else if (r.startsWith('A6-')) cc='🇦🇪 AE'
          else if (r.startsWith('B-')) cc='🇨🇳 CN'
          else if (r.startsWith('HL')) cc='🇰🇷 KR'
          else if (r.startsWith('PR-')||r.startsWith('PT-')||r.startsWith('PP-')) cc='🇧🇷 BR'
          else if (r.startsWith('XA-')||r.startsWith('XB-')) cc='🇲🇽 MX'
          if (cc!=='—') countryCounts.set(cc,(countryCounts.get(cc)||0)+1)
        }
        const topCountries = [...countryCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6)
        // Altitude buckets
        const bands = [
          { l: 'GND', min:-1, max:1 },
          { l: '<10k', min:1, max:10000 },
          { l: '10-20k', min:10000, max:20000 },
          { l: '20-30k', min:20000, max:30000 },
          { l: '30-40k', min:30000, max:40000 },
          { l: '40k+', min:40000, max:99999 },
        ].map(b=>{
          const n = filtered.filter(f=> b.l==='GND'? f.ground : (!f.ground && f.altitudeFt>=b.min && f.altitudeFt<b.max)).length
          return { ...b, n }
        })
        const maxBand = Math.max(1, ...bands.map(b=>b.n))
        // Busiest airport in view (by proximity to flights within 25 nm)
        const apCounts = new Map<string, {ap: typeof visibleAirports[0], n:number}>()
        for (const f of filtered.filter(x=>!x.ground)) {
          let best: typeof visibleAirports[0] | null = null
          let bestD = 25 // nm
          for (const ap of visibleAirports) {
            const dLat=(f.lat-ap.lat)*60, dLon=(f.lng-ap.lon)*60*Math.cos(ap.lat*Math.PI/180)
            const d = Math.sqrt(dLat*dLat+dLon*dLon)
            if (d<bestD) { bestD=d; best=ap }
          }
          if (best) {
            const k = best.i
            const cur = apCounts.get(k)||{ap:best,n:0}; cur.n++; apCounts.set(k,cur)
          }
        }
        const topAirports = [...apCounts.values()].sort((a,b)=>b.n-a.n).slice(0,5)
        // Avg speed/alt
        const air = filtered.filter(f=>!f.ground)
        const avgAlt = air.length? Math.round(air.reduce((s,f)=>s+f.altitudeFt,0)/air.length):0
        const avgSpd = air.length? Math.round(air.reduce((s,f)=>s+f.velocityKts,0)/air.length):0
        const heavy = filtered.filter(f=>['A5','A6'].includes(f.category||'')).length
        const heli = filtered.filter(f=>f.category==='A7').length
        const mil = filtered.filter(f=>f.military).length

        const Bar = ({label, n, max, color='bg-sky-500'}:{label:string;n:number;max:number;color?:string}) => (
          <div className="flex items-center gap-2 text-[11px]">
            <span className="w-16 shrink-0 text-slate-400 font-mono">{label}</span>
            <div className="flex-1 h-4 bg-slate-900 rounded overflow-hidden relative">
              <div className={`h-full ${color} transition-all`} style={{width:`${Math.max(2,(n/max)*100)}%`}}/>
              <span className="absolute inset-0 flex items-center justify-end pr-1.5 font-mono text-[10px] text-white drop-shadow">{n}</span>
            </div>
          </div>
        )

        return (
          <aside className="absolute z-20 bg-slate-950/95 backdrop-blur-xl border border-slate-800 shadow-2xl
            sm:left-3 md:left-4 sm:top-24 md:top-32 sm:w-[min(94vw,360px)] sm:max-h-[calc(100vh-200px)] sm:rounded-2xl sm:inset-x-auto sm:bottom-auto
            inset-x-0 bottom-0 max-h-[75vh] rounded-t-2xl ft-sheet ft-safe-pb overflow-y-auto">
            <header className="sticky top-0 bg-slate-950/95 backdrop-blur-xl border-b border-slate-800 px-3 py-2 flex items-center justify-between">
              <h3 className="text-xs uppercase tracking-widest text-slate-300 font-semibold">Live Statistics</h3>
              <button onClick={()=>setShowStats(false)} className="text-slate-500 hover:text-slate-300 text-sm">✕</button>
            </header>
            <div className="p-3 space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-slate-900/60 rounded-lg p-2"><div className="text-[9px] text-slate-500 uppercase tracking-wider">Heavy</div><div className="text-lg font-bold text-violet-400 font-mono">{heavy}</div></div>
                <div className="bg-slate-900/60 rounded-lg p-2"><div className="text-[9px] text-slate-500 uppercase tracking-wider">Heli</div><div className="text-lg font-bold text-emerald-400 font-mono">{heli}</div></div>
                <div className="bg-slate-900/60 rounded-lg p-2"><div className="text-[9px] text-slate-500 uppercase tracking-wider">Military</div><div className="text-lg font-bold text-orange-400 font-mono">{mil}</div></div>
                <div className="bg-slate-900/60 rounded-lg p-2 col-span-1"><div className="text-[9px] text-slate-500 uppercase tracking-wider">Avg Alt</div><div className="text-base font-bold text-sky-400 font-mono">{(avgAlt/1000).toFixed(1)}k</div></div>
                <div className="bg-slate-900/60 rounded-lg p-2 col-span-2"><div className="text-[9px] text-slate-500 uppercase tracking-wider">Avg Speed</div><div className="text-base font-bold text-amber-400 font-mono">{avgSpd} kt</div></div>
              </div>

              <div>
                <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5 font-semibold">Altitude Distribution</div>
                <div className="space-y-1">{bands.map(b=> <Bar key={b.l} label={b.l} n={b.n} max={maxBand} color={b.l==='GND'?'bg-slate-600':b.l.includes('40')?'bg-violet-500':b.l.includes('30')?'bg-fuchsia-500':b.l.includes('20')?'bg-amber-500':b.l.includes('10')?'bg-emerald-500':'bg-sky-500'} />)}</div>
              </div>

              {topOps.length>0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5 font-semibold">Top Operators</div>
                  <div className="space-y-1">{topOps.map(([op,n])=> <Bar key={op} label={op.slice(0,12)} n={n} max={topOps[0][1]} color="bg-cyan-500" />)}</div>
                </div>
              )}

              {topTypes.length>0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5 font-semibold">Top Aircraft Types</div>
                  <div className="space-y-1">{topTypes.map(([t,n])=> <Bar key={t} label={t} n={n} max={topTypes[0][1]} color="bg-rose-500" />)}</div>
                </div>
              )}

              {topAirports.length>0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5 font-semibold">Busiest Airports (≤25 nm)</div>
                  <div className="space-y-1">
                    {topAirports.map(({ap,n})=>(
                      <button key={ap.i} onClick={()=>mapRef.current?.flyTo({center:[ap.lon,ap.lat],zoom:11,duration:1200})}
                        className="w-full flex items-center gap-2 text-[11px] bg-slate-900/60 hover:bg-slate-800 rounded px-2 py-1.5 transition text-left">
                        <span className="font-mono text-amber-400 font-bold w-12 shrink-0">{ap.a||ap.i}</span>
                        <span className="text-slate-400 flex-1 truncate">{ap.m}</span>
                        <span className="font-mono text-white font-bold">{n}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {topCountries.length>0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5 font-semibold">Country (by registration)</div>
                  <div className="flex flex-wrap gap-1">
                    {topCountries.map(([c,n])=>(
                      <span key={c} className="text-[11px] bg-slate-900/80 border border-slate-800 rounded-full px-2 py-0.5 font-mono">{c} <span className="text-slate-400">{n}</span></span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </aside>
        )
      })()}

      {/* Welcome modal (first visit) */}
      {welcome && (
        <div className="fixed inset-0 z-[60] bg-slate-950/80 backdrop-blur-md grid place-items-center p-4 pointer-events-auto" onClick={() => { localStorage.setItem('ft-onboarded','1'); setWelcome(false) }}>
          <div onClick={(e)=>e.stopPropagation()} className="w-full max-w-md bg-gradient-to-b from-slate-900 to-slate-950 border border-slate-800 rounded-3xl shadow-2xl shadow-sky-900/30 overflow-hidden">
            <div className="relative h-32 bg-gradient-to-br from-sky-500 via-indigo-500 to-violet-600 overflow-hidden">
              <div className="absolute inset-0 opacity-30" style={{backgroundImage:'radial-gradient(circle at 20% 30%, rgba(255,255,255,0.4), transparent 40%), radial-gradient(circle at 80% 70%, rgba(255,255,255,0.3), transparent 40%)'}}/>
              <div className="absolute inset-0 grid place-items-center">
                <div className="size-16 rounded-2xl bg-white/15 backdrop-blur-lg grid place-items-center shadow-2xl">
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="white"><path d="M5 16 L19 9 L18 12 L13 13 L14 18 L12 19 L11 14 L6 17 Z"/></svg>
                </div>
              </div>
            </div>
            <div className="p-5 space-y-4">
              <div className="text-center space-y-1">
                <h2 className="text-xl font-bold tracking-tight">Welcome to Flight Tracker</h2>
                <p className="text-sm text-slate-400">25,000+ aircraft. Live, free, no signup.</p>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                {[
                  ['Tap a plane', 'Route, altitude, photo'],
                  ['Drag to rotate', 'Tilt the world in 3D'],
                  ['Search', 'Callsign, type, operator'],
                  ['Watchlist', 'Notify on return'],
                ].map(([t, d]) => (
                  <div key={t} className="bg-slate-900/60 border border-slate-800 rounded-xl p-2.5">
                    <div className="font-semibold text-slate-200">{t}</div>
                    <div className="text-slate-500 mt-0.5 leading-tight">{d}</div>
                  </div>
                ))}
              </div>
              <button onClick={()=>{ localStorage.setItem('ft-onboarded','1'); setWelcome(false) }}
                className="w-full bg-sky-500 hover:bg-sky-400 active:scale-[0.98] text-slate-950 font-bold py-3 rounded-xl transition shadow-lg shadow-sky-900/40">
                Start tracking →
              </button>
              <button onClick={()=>{ localStorage.setItem('ft-onboarded','1'); setWelcome(false); setAbout(true) }}
                className="w-full text-xs text-slate-500 hover:text-slate-300 transition py-1">
                Data sources & privacy
              </button>
            </div>
          </div>
        </div>
      )}

      {/* About / Data / Privacy panel */}
      {about && (
        <div className="fixed inset-0 z-[60] bg-slate-950/80 backdrop-blur-md grid place-items-center p-4 pointer-events-auto" onClick={()=>setAbout(false)}>
          <div onClick={(e)=>e.stopPropagation()} className="w-full max-w-lg max-h-[85vh] overflow-y-auto bg-slate-950 border border-slate-800 rounded-3xl shadow-2xl">
            <header className="sticky top-0 bg-slate-950/95 backdrop-blur border-b border-slate-800 px-5 py-3.5 flex items-center justify-between">
              <h3 className="text-base font-bold">About Flight Tracker</h3>
              <button onClick={()=>setAbout(false)} className="size-7 rounded-lg hover:bg-slate-800 grid place-items-center text-slate-400 text-sm">✕</button>
            </header>
            <div className="p-5 space-y-5 text-sm text-slate-300">
              <p>A free, open, real-time view of every aircraft transmitting ADS-B or Mode-S. No accounts, no ads, no tracking, no paid tier.</p>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2">Data sources</div>
                <ul className="space-y-1.5 text-[13px]">
                  <li>• <a className="text-sky-400 hover:underline" href="https://adsb.lol" target="_blank" rel="noopener">adsb.lol</a> — aircraft positions, routes, airport DB (community feed, no API key)</li>
                  <li>• <a className="text-sky-400 hover:underline" href="https://aviationweather.gov" target="_blank" rel="noopener">aviationweather.gov</a> — METAR airport weather (NOAA/AWC, no key)</li>
                  <li>• <a className="text-sky-400 hover:underline" href="https://www.planespotters.net" target="_blank" rel="noopener">planespotters.net</a> — aircraft photos</li>
                  <li>• <a className="text-sky-400 hover:underline" href="https://www.rainviewer.com" target="_blank" rel="noopener">RainViewer</a> — weather radar overlay</li>
                  <li>• <a className="text-sky-400 hover:underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> + <a className="text-sky-400 hover:underline" href="https://carto.com/attribution" target="_blank" rel="noopener">CARTO</a> — basemap</li>
                  <li>• <a className="text-sky-400 hover:underline" href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">AWS Terrain Tiles</a> — 3D elevation</li>
                </ul>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2">Privacy</div>
                <p className="text-[13px] leading-relaxed">No servers, no logs, no analytics. Your map preferences and watchlist live only in your browser&apos;s local storage. Aircraft data is fetched directly from public ADS-B feeds — nothing flows through us.</p>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2">Limitations</div>
                <p className="text-[13px] leading-relaxed">Coverage depends on community ADS-B receivers. Sparse areas (oceans, polar regions, military airspace) may show fewer aircraft. Position data is delayed 5–30 seconds and should never be used for navigation or safety-critical purposes.</p>
              </div>
              <div className="text-[11px] text-slate-500 pt-3 border-t border-slate-800 flex items-center justify-between flex-wrap gap-2">
                <span>Open source · MIT-licensed</span>
                <a href="https://github.com/Sanjays2402/flight-tracker" target="_blank" rel="noopener" className="text-sky-400 hover:underline">View on GitHub →</a>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Traffic Radar overlay */}
      {showRadar && (
        <TrafficRadar
          flights={filtered as any}
          centerLat={selected ? selected.lat : mapCenter.lat}
          centerLng={selected ? selected.lng : mapCenter.lng}
          centerLabel={selected ? `${selected.callsign || selected.icao.toUpperCase()} (own ship)` : 'Map center'}
          selectedIcao={selected?.icao || null}
          onSelect={(f) => {
            const full = flights.find(ff => ff.icao === f.icao)
            if (full) { setSelected(full); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [full.lng, full.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {} }
          }}
          onClose={() => { setShowRadar(false); lsSet('ft-radar', false) }}
        />
      )}

      {showEmissions && (
        <EmissionsPanel
          flights={filtered as any}
          onSelect={(icao) => {
            const f = flights.find(ff => ff.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {} }
          }}
          onClose={() => { setShowEmissions(false); lsSet('ft-em', false) }}
        />
      )}

      {showOverhead && (
        <OverheadPanel
          flights={flights}
          onClose={() => { setShowOverhead(false); lsSet('ft-overhead', false) }}
          onSelect={(icao) => {
            const f = flights.find(ff => ff.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 9), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showSun && (
        <SunPanel
          onClose={() => { setShowSun(false); lsSet('ft-sun', false) }}
          onFlyToSun={(lng, lat) => { try { mapRef.current?.flyTo({ center: [lng, lat], zoom: Math.max(mapRef.current.getZoom(), 3), duration: 900 }) } catch {} }}
        />
      )}

      {showHolding && (
        <HoldingPanel
          hits={holdingHits}
          minTurnDeg={holdMinTurn}
          maxRadiusNm={holdMaxRadius}
          minSpanSec={holdMinSpan}
          onChangeTurn={(v) => { setHoldMinTurn(v); lsSet('ft-hold-turn', v) }}
          onChangeRadius={(v) => { setHoldMaxRadius(v); lsSet('ft-hold-rad', v) }}
          onChangeSpan={(v) => { setHoldMinSpan(v); lsSet('ft-hold-span', v) }}
          onSelect={(icao) => {
            const f = flights.find(ff => ff.icao === icao)
            const hit = holdingHits.find(h => h.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null) }
            if (hit) { try { mapRef.current?.flyTo({ center: [hit.centerLng, hit.centerLat], zoom: Math.max(mapRef.current.getZoom(), 9), duration: 700 }) } catch {} }
          }}
          onClose={() => { setShowHolding(false); lsSet('ft-hold', false) }}
        />
      )}

      {showFormation && (
        <FormationPanel
          formations={formations}
          maxRadiusNm={formMaxRadius}
          maxAltDiffFt={formMaxAlt}
          maxTrackDiffDeg={formMaxTrack}
          maxSpeedDiffKts={formMaxSpeed}
          minMembers={formMinMembers}
          includeGround={formGround}
          onChangeRadius={(v) => { setFormMaxRadius(v); lsSet('ft-form-rad', v) }}
          onChangeAlt={(v) => { setFormMaxAlt(v); lsSet('ft-form-alt', v) }}
          onChangeTrack={(v) => { setFormMaxTrack(v); lsSet('ft-form-trk', v) }}
          onChangeSpeed={(v) => { setFormMaxSpeed(v); lsSet('ft-form-spd', v) }}
          onChangeMin={(v) => { setFormMinMembers(v); lsSet('ft-form-min', v) }}
          onChangeGround={(v) => { setFormGround(v); lsSet('ft-form-grd', v) }}
          onSelectFormation={(id) => {
            const f = formations.find(ff => ff.id === id)
            if (f) { try { mapRef.current?.flyTo({ center: [f.centerLng, f.centerLat], zoom: Math.max(mapRef.current.getZoom(), 10), duration: 700 }) } catch {} }
          }}
          onSelectMember={(icao) => {
            const f = flights.find(ff => ff.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 10), duration: 700 }) } catch {} }
          }}
          onClose={() => { setShowFormation(false); lsSet('ft-form', false) }}
        />
      )}

      {showCpa && (
        <CpaPanel
          hits={cpaHits}
          horizonSec={cpaHorizon}
          maxMissNm={cpaMaxMissNm}
          maxMissFt={cpaMaxMissFt}
          includeGround={cpaGround}
          ignoreSameOperator={cpaSameOp}
          onChangeHorizon={(v) => { setCpaHorizon(v); lsSet('ft-cpa-hor', v) }}
          onChangeMissNm={(v) => { setCpaMaxMissNm(v); lsSet('ft-cpa-mnm', v) }}
          onChangeMissFt={(v) => { setCpaMaxMissFt(v); lsSet('ft-cpa-mft', v) }}
          onChangeGround={(v) => { setCpaGround(v); lsSet('ft-cpa-grd', v) }}
          onChangeSameOp={(v) => { setCpaSameOp(v); lsSet('ft-cpa-sop', v) }}
          onSelectPair={(h) => {
            try {
              const minLat = Math.min(h.a.lat, h.b.lat, h.aLat, h.bLat)
              const maxLat = Math.max(h.a.lat, h.b.lat, h.aLat, h.bLat)
              const minLng = Math.min(h.a.lng, h.b.lng, h.aLng, h.bLng)
              const maxLng = Math.max(h.a.lng, h.b.lng, h.aLng, h.bLng)
              mapRef.current?.fitBounds(
                [[minLng - 0.2, minLat - 0.2], [maxLng + 0.2, maxLat + 0.2]],
                { padding: 80, duration: 700, maxZoom: 10 },
              )
            } catch {}
          }}
          onSelectIcao={(icao) => {
            const f = flights.find(ff => ff.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 9), duration: 700 }) } catch {} }
          }}
          onClose={() => { setShowCpa(false); lsSet('ft-cpa', false) }}
        />
      )}

      {showDiversion && (
        <DiversionPanel
          map={mapRef.current}
          plane={selected ? {
            icao: selected.icao,
            callsign: selected.callsign,
            lat: selected.lat,
            lng: selected.lng,
            altitudeFt: selected.altitudeFt,
            velocityKts: selected.velocityKts,
            track: selected.track,
            vertRate: selected.vertRate,
            ground: selected.ground,
          } : null}
          airports={AIRPORTS as any}
          onFlyAirport={(icao) => {
            const ap = AIRPORTS.find(a => a.i === icao)
            if (ap) { try { mapRef.current?.flyTo({ center: [ap.lon, ap.lat], zoom: Math.max(mapRef.current.getZoom(), 9), duration: 700 }) } catch {} }
          }}
          onClose={() => { setShowDiversion(false); lsSet('ft-div', false) }}
        />
      )}

      {showEventLog && (
        <EventLog
          events={events}
          enabled={evEnabled}
          setEnabled={(s) => {
            setEvEnabled(s)
            try { localStorage.setItem('ft-evlog-kinds', JSON.stringify(Array.from(s))) } catch {}
          }}
          onClear={() => setEvents([])}
          onClose={() => { setShowEventLog(false); lsSet('ft-evlog', false) }}
          onSelect={(e) => {
            const f = flights.find(ff => ff.icao === e.icao)
            if (f) {
              setSelected(f); setSelectedAirport(null)
              try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 9), duration: 700 }) } catch {}
            } else if (e.lat != null && e.lng != null) {
              try { mapRef.current?.flyTo({ center: [e.lng, e.lat], zoom: 8, duration: 700 }) } catch {}
            }
          }}
        />
      )}

      {showLadder && (
        <AltitudeLadder
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, altitudeFt: f.altitudeFt, ground: f.ground, vertRate: f.vertRate, velocityKts: f.velocityKts, category: f.category, emergency: f.emergency }))}
          selectedIcao={selected?.icao}
          onSelect={(icao) => {
            const f = flights.find(ff => ff.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 9), duration: 700 }) } catch {} }
          }}
          onClose={() => { setShowLadder(false); lsSet('ft-ladder', false) }}
        />
      )}

      {showPhase && (
        <PhasePanel
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, altitudeFt: f.altitudeFt, ground: f.ground, vertRate: f.vertRate, velocityKts: f.velocityKts, category: f.category, emergency: f.emergency }))}
          selectedIcao={selected?.icao}
          onSelect={(icao) => {
            const f = flights.find(ff => ff.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 9), duration: 700 }) } catch {} }
          }}
          onClose={() => { setShowPhase(false); lsSet('ft-phase', false) }}
        />
      )}

      {showConflict && (
        <ConflictPanel
          pairs={conflicts}
          latNm={conflictLat}
          vertFt={conflictVert}
          includeGround={conflictGround}
          onChange={(n) => {
            if (n.latNm !== undefined) { setConflictLat(n.latNm); lsSet('ft-cflx-lat', n.latNm) }
            if (n.vertFt !== undefined) { setConflictVert(n.vertFt); lsSet('ft-cflx-vert', n.vertFt) }
            if (n.includeGround !== undefined) { setConflictGround(n.includeGround); lsSet('ft-cflx-grd', n.includeGround) }
          }}
          onSelect={(icao) => {
            const f = flights.find(ff => ff.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {} }
          }}
          onZoomPair={(p) => {
            try {
              const m = mapRef.current; if (!m) return
              const b = new maplibregl.LngLatBounds([p.a.lng, p.a.lat], [p.a.lng, p.a.lat])
              b.extend([p.b.lng, p.b.lat])
              m.fitBounds(b, { padding: 120, maxZoom: 11, duration: 700 })
            } catch {}
          }}
          onClose={() => { setShowConflict(false); lsSet('ft-cflx', false) }}
        />
      )}

      {showCockpit && selected && (
        <CockpitHUD
          flight={selected as any}
          onClose={() => { setShowCockpit(false); lsSet('ft-pfd', false) }}
        />
      )}

      {showRuler && (
        <RulerTool map={mapRef.current} onClose={() => setShowRuler(false)} />
      )}

      {showE6b && (
        <E6bComputer onClose={() => setShowE6b(false)} />
      )}

      {showBullseye && (
        <BullseyeTool
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, ground: f.ground, track: f.track, velocityKts: f.velocityKts, emergency: f.emergency }))}
          onClose={() => setShowBullseye(false)}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f && mapRef.current) {
              try { mapRef.current.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {}
              setSelected(f)
            }
          }}
        />
      )}

      {showVProfile && (
        <VerticalProfilePanel
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, ground: f.ground, velocityKts: f.velocityKts, vertRate: f.vertRate, track: f.track, emergency: f.emergency, military: f.military }))}
          center={selected ? { lat: selected.lat, lng: selected.lng } : { lat: mapCenter.lat, lng: mapCenter.lng }}
          onClose={() => { setShowVProfile(false); lsSet('ft-vp', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showTcas && (
        <TcasPanel
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, ground: f.ground, velocityKts: f.velocityKts, vertRate: f.vertRate, track: f.track }))}
          ownship={selected ? { icao: selected.icao, callsign: selected.callsign, type: selected.type, lat: selected.lat, lng: selected.lng, altitudeFt: selected.altitudeFt, ground: selected.ground, velocityKts: selected.velocityKts, vertRate: selected.vertRate, track: selected.track } : null}
          ownshipFallback={{ lat: mapCenter.lat, lng: mapCenter.lng, altitudeFt: 0, track: 0 }}
          onClose={() => { setShowTcas(false); lsSet('ft-tcas', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showWake && (
        <WakePanel
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowWake(false); lsSet('ft-wake', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showContrail && (
        <ContrailForecast
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground, oat: f.oat }))}
          onClose={() => { setShowContrail(false); lsSet('ft-contrail', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showAtlas && (
        <RegistryAtlas
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, ground: f.ground, military: f.military }))}
          onClose={() => { setShowAtlas(false); lsSet('ft-atlas', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showVip && (
        <VipHunter
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, registration: f.registration, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, mach: f.mach, ground: f.ground, squawk: f.squawk, emergency: f.emergency, military: f.military }))}
          onClose={() => { setShowVip(false); lsSet('ft-vip', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showPass && (
        <PassPredictor
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          centerLat={selected ? selected.lat : mapCenter.lat}
          centerLng={selected ? selected.lng : mapCenter.lng}
          onClose={() => { setShowPass(false); lsSet('ft-pass', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showNoise && (
        <NoiseMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, vertRate: f.vertRate, ground: f.ground, military: f.military, category: f.category }))}
          onClose={() => { setShowNoise(false); lsSet('ft-noise', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 9), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showTod && (
        <TodPredictor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowTod(false); lsSet('ft-tod', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 7), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showTripwire && (
        <Tripwire
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowTripwire(false); lsSet('ft-tripwire', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showGeofence && (
        <GeofenceStudio
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowGeofence(false); lsSet('ft-geofence', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showVoronoi && (
        <VoronoiTerritory
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, ground: f.ground }))}
          onClose={() => { setShowVoronoi(false); lsSet('ft-voronoi', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showSunGlare && (
        <SunGlarePanel
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, ground: f.ground }))}
          onClose={() => { setShowSunGlare(false); lsSet('ft-sunglare', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showGlide && (
        <GlideAtlasPanel
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, ground: f.ground, windDir: f.windDir, windKts: f.windKts }))}
          onClose={() => { setShowGlide(false); lsSet('ft-glide', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showCoffin && (
        <CoffinCornerPanel
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, ground: f.ground, windDir: f.windDir, windKts: f.windKts, mach: f.mach }))}
          onClose={() => { setShowCoffin(false); lsSet('ft-coffin', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showRoute && (
        <RoutePlanner
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, ground: f.ground, windDir: f.windDir, windKts: f.windKts }))}
          onClose={() => { setShowRoute(false); lsSet('ft-route', false) }}
          onFlyLatLng={(lat, lng, zoom) => flyToLatLng(lat, lng, zoom)}
        />
      )}

      {showShear && (
        <ShearAtlas
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, ground: f.ground, windDir: f.windDir, windKts: f.windKts }))}
          onClose={() => { setShowShear(false); lsSet('ft-shear', false) }}
        />
      )}

      {showCosmic && (
        <CosmicDose
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, ground: f.ground }))}
          onClose={() => { setShowCosmic(false); lsSet('ft-cosmic', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 6), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showHypoxia && (
        <HypoxiaMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, ground: f.ground }))}
          onClose={() => { setShowHypoxia(false); lsSet('ft-hypoxia', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 6), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showCostIdx && (
        <CostIndex
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, vertRate: f.vertRate, track: f.track, mach: f.mach, ground: f.ground }))}
          onClose={() => { setShowCostIdx(false); lsSet('ft-costidx', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 6), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showStepClimb && (
        <StepClimb
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, windDir: f.windDir, windKts: f.windKts, ground: f.ground }))}
          onClose={() => { setShowStepClimb(false); lsSet('ft-stepclimb', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 6), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showEtops && (
        <EtopsMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, ground: f.ground }))}
          onClose={() => { setShowEtops(false); lsSet('ft-etops', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 6), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showDepSeq && (
        <DepartureSequencer
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowDepSeq(false); lsSet('ft-depseq', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 9), duration: 700 }) } catch {} }
          }}
          onFlyLatLng={(lat, lng, zoom) => flyToLatLng(lat, lng, zoom)}
        />
      )}

      {showXwind && (
        <CrosswindCompass
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, windDir: f.windDir, windKts: f.windKts, ground: f.ground }))}
          onClose={() => { setShowXwind(false); lsSet('ft-xwind', false) }}
          onFlyLatLng={(lat, lng, zoom) => flyToLatLng(lat, lng, zoom)}
        />
      )}

      {showJet && (
        <JetStreamFinder
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, windDir: f.windDir, windKts: f.windKts, ground: f.ground }))}
          onClose={() => { setShowJet(false); lsSet('ft-jet', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showHstack && (
        <HoldingStackDesigner
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, category: f.category, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          mapCenterLat={mapCenter.lat}
          mapCenterLng={mapCenter.lng}
          onClose={() => { setShowHstack(false); lsSet('ft-hstack', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 9) } }}
          onFlyLatLng={(lat, lng, zoom) => flyToLatLng(lat, lng, zoom)}
        />
      )}

      {showIcing && (
        <IcingMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, mach: f.mach, ground: f.ground }))}
          onClose={() => { setShowIcing(false); lsSet('ft-icing', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showCurfew && (
        <CurfewMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, ground: f.ground }))}
          onClose={() => { setShowCurfew(false); lsSet('ft-curfew', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
          onFlyLatLng={(lat, lng, zoom) => flyToLatLng(lat, lng, zoom)}
        />
      )}

      {showMtnWave && (
        <MountainWave
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, windDir: f.windDir, windKts: f.windKts, ground: f.ground }))}
          onClose={() => { setShowMtnWave(false); lsSet('ft-mwave', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
          onFlyLatLng={(lat, lng, zoom) => flyToLatLng(lat, lng, zoom)}
        />
      )}

      {showBird && (
        <BirdStrikeMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          airports={AIRPORTS.map(a => ({ iata: a.a, icao: a.i, name: a.n || a.m, city: a.m, lat: a.lat, lng: a.lon, cat: 'large' as const }))}
          onClose={() => { setShowBird(false); lsSet('ft-bird', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
          onFlyLatLng={(lat, lng, zoom) => flyToLatLng(lat, lng, zoom)}
        />
      )}

      {showAsh && (
        <VolcanicAshMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, windDir: f.windDir, windKts: f.windKts, ground: f.ground }))}
          onClose={() => { setShowAsh(false); lsSet('ft-ash', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
          onFlyLatLng={(lat, lng, zoom) => flyToLatLng(lat, lng, zoom)}
        />
      )}

      {showFir && (
        <FirLoadMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, ground: f.ground }))}
          onClose={() => { setShowFir(false); lsSet('ft-fir', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 6) } }}
          onFlyLatLng={(lat, lng, zoom) => flyToLatLng(lat, lng, zoom)}
        />
      )}

      {showEnergy && (
        <EnergyMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, mach: f.mach, ground: f.ground }))}
          onClose={() => { setShowEnergy(false); lsSet('ft-energy', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 7) } }}
        />
      )}

      {showTurb && (
        <TurbulenceEdr
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowTurb(false); lsSet('ft-turb', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 7) } }}
          onFlyLatLng={(lat, lng, zoom) => flyToLatLng(lat, lng, zoom)}
        />
      )}

      {showNordo && (
        <NordoMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, squawk: f.squawk, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground, emergency: f.emergency }))}
          onClose={() => { setShowNordo(false); lsSet('ft-nordo', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 7) } }}
        />
      )}

      {showTerrain && (
        <TerrainClearance
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowTerrain(false); lsSet('ft-terrain', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 7) } }}
        />
      )}

      {showMass && (
        <MassBalance
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowMass(false); lsSet('ft-mass', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 7) } }}
        />
      )}

      {showMagVar && (
        <MagneticVariation
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowMagVar(false); lsSet('ft-magvar', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 7) } }}
        />
      )}

      {showRaim && (
        <RaimMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, ground: f.ground }))}
          onClose={() => { setShowRaim(false); lsSet('ft-raim', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 7) } }}
          onFlyLatLng={(lat, lng, zoom) => flyToLatLng(lat, lng, zoom)}
        />
      )}

      {showNavaid && (
        <NavaidCoverage
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, ground: f.ground }))}
          onClose={() => { setShowNavaid(false); lsSet('ft-navaid', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 7) } }}
          onFlyLatLng={(lat, lng, zoom) => flyToLatLng(lat, lng, zoom)}
        />
      )}

      {showOcean && (
        <OceanicTracks
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, mach: f.mach, track: f.track, ground: f.ground }))}
          onClose={() => { setShowOcean(false); lsSet('ft-ocean', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 5) } }}
          onFlyLatLng={(lat, lng, zoom) => flyToLatLng(lat, lng, zoom)}
        />
      )}

      {showMetar && (
        <MetarMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, windDir: f.windDir, windKts: f.windKts, ground: f.ground }))}
          onClose={() => { setShowMetar(false); lsSet('ft-metar', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
          onFlyLatLng={(lat, lng, zoom) => flyToLatLng(lat, lng, zoom ?? 8)}
        />
      )}

      {showCells && (
        <ConvectiveCells
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowCells(false); lsSet('ft-cells', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
          onFlyLatLng={(lat, lng, zoom) => flyToLatLng(lat, lng, zoom ?? 7)}
        />
      )}

      {showSar && (
        <SarPlanner
          map={mapRef.current}
          flights={flights.map(f => ({ lat: f.lat, lng: f.lng, windDir: f.windDir, windKts: f.windKts, ground: f.ground }))}
          lkp={selected ? { lat: selected.lat, lng: selected.lng } : null}
          onClose={() => { setShowSar(false); lsSet('ft-sar', false) }}
          onFlyLatLng={(lat, lng, zoom) => flyToLatLng(lat, lng, zoom ?? 8)}
        />
      )}

      {showStable && (
        <StableApproach
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowStable(false); lsSet('ft-stable', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {} }
          }}
          onFlyLatLng={(lat, lng, zoom) => flyToLatLng(lat, lng, zoom ?? 10)}
        />
      )}

      {showFirX && (
        <FirCrossings
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, ground: f.ground }))}
          onClose={() => { setShowFirX(false); lsSet('ft-firx', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 7), duration: 700 }) } catch {} }
          }}
          onFlyLatLng={(lat, lng, zoom) => flyToLatLng(lat, lng, zoom ?? 5)}
        />
      )}

      {showRwyCfg && (
        <RunwayConfig
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, vertRate: f.vertRate, track: f.track, windDir: f.windDir, windKts: f.windKts, ground: f.ground }))}
          onClose={() => { setShowRwyCfg(false); lsSet('ft-rwycfg', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 9), duration: 700 }) } catch {} }
          }}
          onFlyLatLng={(lat, lng, zoom) => flyToLatLng(lat, lng, zoom ?? 10)}
        />
      )}

      {showTaf && (
        <TafForecast
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, windDir: f.windDir, windKts: f.windKts, ground: f.ground }))}
          onClose={() => { setShowTaf(false); lsSet('ft-taf', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
          onFlyLatLng={(lat, lng, zoom) => flyToLatLng(lat, lng, zoom ?? 8)}
        />
      )}

      {showToc && (
        <TocPredictor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowToc(false); lsSet('ft-toc', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showCabin && (
        <CabinPressure
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowCabin(false); lsSet('ft-cabin', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showApMin && (
        <ApproachMinimums
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowApMin(false); lsSet('ft-apmin', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showFuelTemp && (
        <FuelTemp
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowFuelTemp(false); lsSet('ft-fueltemp', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showDrift && (
        <DriftDown
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowDrift(false); lsSet('ft-drift', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showReserve && (
        <ReserveFuel
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowReserve(false); lsSet('ft-reserve', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showEtp && (
        <EtpAtlas
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowEtp(false); lsSet('ft-etp', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showCda && (
        <CdaCompliance
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowCda(false); lsSet('ft-cda', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showBrake && (
        <BrakeEnergy
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowBrake(false); lsSet('ft-brake', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showMapp && (
        <MissedApproach
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowMapp(false); lsSet('ft-mapp', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showVhf && (
        <VhfCongestion
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowVhf(false); lsSet('ft-vhf', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showSpwx && (
        <SpaceWeatherMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowSpwx(false); lsSet('ft-spwx', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showFoqa && (
        <FoqaExceedance
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowFoqa(false); lsSet('ft-foqa', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showEgt && (
        <EgtMargin
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowEgt(false); lsSet('ft-egt', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showPolar && (
        <PolarOps
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowPolar(false); lsSet('ft-polar', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showLibat && (
        <LiBattery
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowLibat(false); lsSet('ft-libat', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showRexhyd && (
        <RexHyd
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowRexhyd(false); lsSet('ft-rexhyd', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showCgTrim && (
        <CgTrim
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowCgTrim(false); lsSet('ft-cgtrim', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showOwl && (
        <OwlJettison
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowOwl(false); lsSet('ft-owl', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showTold && (
        <ToldBfl
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowTold(false); lsSet('ft-told', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showUas && (
        <UasPitot
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowUas(false); lsSet('ft-uas', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showFlutter && (
        <FlutterMargin
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowFlutter(false); lsSet('ft-flutter', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showStall && (
        <StallMargin
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowStall(false); lsSet('ft-stall', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showTailStrike && (
        <TailStrike
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowTailStrike(false); lsSet('ft-tailstrike', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showRera && (
        <RunwayExcursion
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowRera(false); lsSet('ft-rera', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showTaws && (
        <TawsModes
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowTaws(false); lsSet('ft-taws', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showCtot && (
        <CtotSlot
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowCtot(false); lsSet('ft-ctot', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showBleed && (
        <BleedFume
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowBleed(false); lsSet('ft-bleed', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showDeice && (
        <DeiceHot
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowDeice(false); lsSet('ft-deice', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showPstatic && (
        <PStaticMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowPstatic(false); lsSet('ft-pstatic', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showRelight && (
        <RelightEnvelope
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowRelight(false); lsSet('ft-relight', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showEgress && (
        <Egress90Sec
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowEgress(false); lsSet('ft-egress', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showNotam && (
        <NotamTfr
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowNotam(false); lsSet('ft-notam', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showRadalt5g && (
        <Radalt5g
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowRadalt5g(false); lsSet('ft-radalt5g', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showCtAlt && (
        <CtAltMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowCtAlt(false); lsSet('ft-ctalt', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showHotsec && (
        <HotSectionLcf
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowHotsec(false); lsSet('ft-hotsec', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showLhirf && (
        <LightningHirf
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowLhirf(false); lsSet('ft-lhirf', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showRecat && (
        <RecatWake
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowRecat(false); lsSet('ft-recat', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showEai && (
        <EaiPenalty
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowEai(false); lsSet('ft-eai', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showAdiz && (
        <AdizMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, squawk: f.squawk, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowAdiz(false); lsSet('ft-adiz', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showSidc && (
        <SidClimb
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowSidc(false); lsSet('ft-sidc', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showRvsm && (
        <RvsmMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowRvsm(false); lsSet('ft-rvsm', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showSpdLim && (
        <SpeedLimit
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, ias: f.ias, mach: f.mach, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowSpdLim(false); lsSet('ft-spdlim', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showBoom && (
        <SonicBoom
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, mach: f.mach, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowBoom(false); lsSet('ft-boom', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showRnp && (
        <RnpMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowRnp(false); lsSet('ft-rnp', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showRta && (
        <RtaConformance
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowRta(false); lsSet('ft-rta', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showSatcom && (
        <SatcomCoverage
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowSatcom(false); lsSet('ft-satcom', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showTank && (
        <FuelTankering
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowTank(false); lsSet('ft-tank', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showWkld && (
        <WorkloadIndex
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowWkld(false); lsSet('ft-wkld', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showGnss && (
        <GnssIntegrity
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowGnss(false); lsSet('ft-gnss', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showCpdlc && (
        <CpdlcMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowCpdlc(false); lsSet('ft-cpdlc', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showLbust && (
        <LevelBustPredictor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowLbust(false); lsSet('ft-lbust', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showAdsbq && (
        <AdsbQualityMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowAdsbq(false); lsSet('ft-adsbq', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showRta && (
        <RtaCompliance
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowRta(false); lsSet('ft-rta', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showNadp && (
        <NadpMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowNadp(false); lsSet('ft-nadp', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 10) } }}
        />
      )}

      {showOzone && (
        <OzoneMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowOzone(false); lsSet('ft-ozone', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showCrew && (
        <CrewDuty
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowCrew(false); lsSet('ft-crewduty', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showSua && (
        <SuaMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, ground: f.ground }))}
          onClose={() => { setShowSua(false); lsSet('ft-sua', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {} }
          }}
          onFlyLatLng={(lat, lng, zoom) => flyToLatLng(lat, lng, zoom)}
        />
      )}

      {showAnomaly && (
        <AnomalyRadar
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, squawk: f.squawk, ground: f.ground, emergency: f.emergency, military: f.military }))}
          onClose={() => { setShowAnomaly(false); lsSet('ft-anomaly', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showCompareStudio && (
        <ComparePanel
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, registration: f.registration, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, ias: f.ias, mach: f.mach, vertRate: f.vertRate, windDir: f.windDir, windKts: f.windKts, oat: f.oat, track: f.track, squawk: f.squawk, category: f.category, emergency: f.emergency, military: f.military, ground: f.ground }))}
          anchorLat={mapCenter.lat}
          anchorLng={mapCenter.lng}
          initialIcaos={compareStudioIcaos}
          onClose={() => { setShowCompareStudio(false); lsSet('ft-compare-studio', false) }}
          onSelectionChange={(ics) => { setCompareStudioIcaos(ics); lsSet('ft-compare-studio-icaos', ics) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showSymphony && (
        <SkySymphony
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, ground: f.ground }))}
          mapCenter={selected ? { lat: selected.lat, lng: selected.lng } : { lat: mapCenter.lat, lng: mapCenter.lng }}
          onClose={() => { setShowSymphony(false); lsSet('ft-symphony', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showTimeMachine && (
        <TimeMachine
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, ground: f.ground }))}
          trails={trailsRef.current}
          onClose={() => { setShowTimeMachine(false); lsSet('ft-timemachine', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showReach && (
        <ReachAtlas
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, ground: f.ground }))}
          selectedIcao={selected?.icao ?? null}
          onClose={() => { setShowReach(false); lsSet('ft-reach', false) }}
          onFlyAirport={(lat, lng) => { try { mapRef.current?.flyTo({ center: [lng, lat], zoom: 10, duration: 800 }) } catch {} }}
        />
      )}

      {showTrip && (
        <TripPlanner
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, ground: f.ground, windDir: f.windDir, windKts: f.windKts }))}
          onClose={() => { setShowTrip(false); lsSet('ft-trip', false) }}
        />
      )}

      {showFlow && (
        <FlowRose
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, ground: f.ground }))}
          onClose={() => { setShowFlow(false); lsSet('ft-flow', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 7), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showRecords && (
        <RecordsHall
          flights={flights.map(f => ({
            icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator,
            lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, ground: f.ground,
            velocityKts: f.velocityKts, mach: f.mach, vertRate: f.vertRate,
            windDir: f.windDir, windKts: f.windKts, oat: f.oat, track: f.track,
          }))}
          onClose={() => { setShowRecords(false); lsSet('ft-records', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 7), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showShadow && (
        <ShadowCaster
          map={mapRef.current}
          flights={flights.map(f => ({
            icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator,
            lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, track: f.track, ground: f.ground,
          }))}
          onClose={() => { setShowShadow(false); lsSet('ft-shadow', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 7), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showDoppler && (
        <DopplerScope
          map={mapRef.current}
          flights={flights.map(f => ({
            icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator,
            lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts,
            track: f.track, ground: f.ground,
          }))}
          onClose={() => { setShowDoppler(false); lsSet('ft-doppler', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 7), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showAprSeq && (
        <ApproachSequencer
          map={mapRef.current}
          flights={flights.map(f => ({
            icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator,
            lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts,
            track: f.track, vertRate: f.vertRate, ground: f.ground,
          }))}
          onClose={() => { setShowAprSeq(false); lsSet('ft-aprseq', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f) { setSelected(f); setSelectedAirport(null); try { mapRef.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 7), duration: 700 }) } catch {} }
          }}
        />
      )}

      {showWinds && (
        <WindsAloft
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, altitudeFt: f.altitudeFt, ground: f.ground, windDir: f.windDir, windKts: f.windKts, oat: f.oat, lat: f.lat, lng: f.lng }))}
          onClose={() => { setShowWinds(false); lsSet('ft-winds', false) }}
          onFly={(icao) => {
            const f = flights.find(x => x.icao === icao)
            if (f && mapRef.current) {
              try { mapRef.current.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 7), duration: 700 }) } catch {}
              setSelected(f)
            }
          }}
        />
      )}

      {showBoard && (() => {
        const c = (() => { try { const ctr = mapRef.current?.getCenter(); return ctr ? { lat: ctr.lat, lng: ctr.lng } : { lat: 40, lng: -95 } } catch { return { lat: 40, lng: -95 } } })()
        return (
          <AirportBoard
            flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, registration: f.registration, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, vertRate: f.vertRate, track: f.track, ground: f.ground, emergency: f.emergency }))}
            centerLat={c.lat}
            centerLng={c.lng}
            onClose={() => { setShowBoard(false); lsSet('ft-board', false) }}
            onFly={(icao) => {
              const f = flights.find(x => x.icao === icao)
              if (f && mapRef.current) {
                try { mapRef.current.flyTo({ center: [f.lng, f.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {}
                setSelected(f)
              }
            }}
            onFlyAirport={(a) => {
              try { mapRef.current?.flyTo({ center: [a.lon, a.lat], zoom: 11, duration: 800 }) } catch {}
            }}
          />
        )
      })()}

      {showScatter && (
        <SpeedAltScatter
          flights={flights.map(f => ({
            icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator,
            altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, mach: f.mach || 0,
            vsFpm: 0, lat: f.lat, lng: f.lng, ground: f.ground,
            emergency: f.emergency, category: f.category || '',
          }))}
          onClose={() => { setShowScatter(false); lsSet('ft-scatter', false) }}
          onSelect={(sf) => {
            const full = flights.find(x => x.icao === sf.icao)
            if (full) { setSelected(full); flyToLatLng(full.lat, full.lng, Math.max(mapRef.current?.getZoom() ?? 0, 7)) }
          }}
        />
      )}

      {showSquawk && (
        <SquawkMonitor
          flights={flights.map(f => ({
            icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator,
            squawk: f.squawk || '', altitudeFt: f.altitudeFt, velocityKts: f.velocityKts,
            lat: f.lat, lng: f.lng, ground: f.ground, emergency: f.emergency, military: f.military,
          }))}
          onClose={() => { setShowSquawk(false); lsSet('ft-squawk', false) }}
          onFly={(icao) => {
            const full = flights.find(x => x.icao === icao)
            if (full && mapRef.current) {
              try { mapRef.current.flyTo({ center: [full.lng, full.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 }) } catch {}
              setSelected(full)
            }
          }}
        />
      )}

      {showRace && (
        <OperatorRace
          flights={flights.map(f => ({
            icao: f.icao, callsign: f.callsign, operator: f.operator, type: f.type,
            altitudeFt: f.altitudeFt, velocityKts: f.velocityKts,
            ground: f.ground, military: f.military, emergency: f.emergency,
          }))}
          onSelectOperator={(g, key) => {
            if (g === 'operator') {
              setAirlinePrefix(key.length <= 4 ? key : key.slice(0, 3))
              setShowFilters(true)
            } else {
              setQuery(key)
            }
          }}
          onClose={() => { setShowRace(false); lsSet('ft-race', false) }}
        />
      )}

      {showDensity && (
        <DensityHeatPanel
          flights={flights.map(f => ({
            icao: f.icao, callsign: f.callsign,
            lat: f.lat, lng: f.lng,
            altitudeFt: f.altitudeFt, velocityKts: f.velocityKts,
            ground: f.ground, emergency: f.emergency, military: f.military,
          }))}
          mode={heatMode}
          setMode={(m) => { setHeatMode(m); lsSet('ft-heat-mode', m) }}
          includeGround={heatGround}
          setIncludeGround={(b) => { setHeatGround(b); lsSet('ft-heat-grd', b) }}
          radiusScale={heatRadius}
          setRadiusScale={(n) => { setHeatRadiusState(n); lsSet('ft-heat-r', n) }}
          intensityScale={heatIntensity}
          setIntensityScale={(n) => { setHeatIntensityState(n); lsSet('ft-heat-i', n) }}
          cellDeg={heatCell}
          setCellDeg={(n) => { setHeatCell(n); lsSet('ft-heat-cell', n) }}
          onFly={(lat, lng) => {
            try { mapRef.current?.flyTo({ center: [lng, lat], zoom: Math.max(mapRef.current.getZoom(), 6), duration: 700 }) } catch {}
          }}
          onClose={() => { setShowDensity(false); lsSet('ft-dens', false) }}
        />
      )}

      {showPip && (
        <PipMinimap
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, lat: f.lat, lng: f.lng, track: f.track, altitudeFt: f.altitudeFt, ground: f.ground, emergency: f.emergency }))}
          selected={selected ? { icao: selected.icao, callsign: selected.callsign, lat: selected.lat, lng: selected.lng, track: selected.track, altitudeFt: selected.altitudeFt, ground: selected.ground, emergency: selected.emergency } : null}
          radiusNm={pipRadius}
          onClose={() => { setShowPip(false); try { localStorage.setItem('ft-pip', '0') } catch {} }}
          onZoom={() => { if (selected && mapRef.current) { try { mapRef.current.flyTo({ center: [selected.lng, selected.lat], zoom: Math.max(mapRef.current.getZoom(), 10), duration: 700 }) } catch {} } }}
        />
      )}

      {/* About link in bottom-left, only when nothing selected */}
      {!selected && !about && !welcome && (
        <button onClick={()=>setAbout(true)}
          className="absolute bottom-12 right-3 md:right-4 z-10 text-[10px] uppercase tracking-widest text-slate-500 hover:text-slate-300 bg-slate-950/70 backdrop-blur border border-slate-800 rounded-lg px-2 py-1 transition">
          About · Privacy
        </button>
      )}

      {/* Footer keybind hints — only when nothing selected (avoids ticker collision) */}
      {!selected && (
        <footer className="hidden md:block absolute bottom-12 left-3 md:left-4 z-10 pointer-events-none">
          <div className="pointer-events-auto bg-slate-950/85 backdrop-blur-xl border border-slate-800 rounded-xl px-3 py-2 text-[11px] text-slate-400 shadow-2xl flex items-center gap-3 flex-wrap">
            <span className="flex items-center gap-1.5"><kbd className="font-mono bg-slate-800 text-slate-200 px-1.5 py-0.5 rounded text-[10px] border border-slate-700">/</kbd><span>Search</span></span>
            <span className="text-slate-700">·</span>
            <span className="flex items-center gap-1.5"><kbd className="font-mono bg-slate-800 text-slate-200 px-1.5 py-0.5 rounded text-[10px] border border-slate-700">L</kbd><span>List</span></span>
            <span className="flex items-center gap-1.5"><kbd className="font-mono bg-slate-800 text-slate-200 px-1.5 py-0.5 rounded text-[10px] border border-slate-700">F</kbd><span>Filter</span></span>
            <span className="flex items-center gap-1.5"><kbd className="font-mono bg-slate-800 text-slate-200 px-1.5 py-0.5 rounded text-[10px] border border-slate-700">3</kbd><span>3D</span></span>
            <span className="flex items-center gap-1.5"><kbd className="font-mono bg-slate-800 text-slate-200 px-1.5 py-0.5 rounded text-[10px] border border-slate-700">?</kbd><span>All shortcuts</span></span>
          </div>
        </footer>
      )}

      {/* Live Leaderboard Ticker — scrolling bottom bar */}
      {(() => {
        const air = filtered.filter(f => !f.ground)
        if (air.length === 0) return null
        const fastest = [...air].sort((a,b)=>b.velocityKts-a.velocityKts)[0]
        const highest = [...air].sort((a,b)=>b.altitudeFt-a.altitudeFt)[0]
        const climbing = [...air].filter(f=>f.vertRate>0).sort((a,b)=>b.vertRate-a.vertRate)[0]
        const descending = [...air].filter(f=>f.vertRate<0).sort((a,b)=>a.vertRate-b.vertRate)[0]
        const emerg = filtered.filter(f=>f.emergency)[0]
        const mil = filtered.filter(f=>f.military)[0]
        const items: Array<{icon:string;label:string;value:string;color:string;flight:any}> = []
        if (emerg) items.push({icon:'!', label:'EMERGENCY', value:`${emerg.callsign||emerg.icao} sq${emerg.squawk}`, color:'text-rose-300', flight:emerg})
        items.push({icon:'›', label:'FASTEST', value:`${fastest.callsign||fastest.icao} ${Math.round(fastest.velocityKts)}kt`, color:'text-slate-100', flight:fastest})
        items.push({icon:'↑', label:'HIGHEST', value:`${highest.callsign||highest.icao} FL${Math.round(highest.altitudeFt/100)}`, color:'text-slate-100', flight:highest})
        if (climbing) items.push({icon:'↗', label:'CLIMB', value:`${climbing.callsign||climbing.icao} +${Math.round(climbing.vertRate)}fpm`, color:'text-slate-100', flight:climbing})
        if (descending) items.push({icon:'↘', label:'DESCEND', value:`${descending.callsign||descending.icao} ${Math.round(descending.vertRate)}fpm`, color:'text-slate-100', flight:descending})
        if (mil) items.push({icon:'★', label:'MIL', value:`${mil.callsign||mil.icao} ${mil.type||''}`, color:'text-slate-100', flight:mil})
        return (
          <div className="absolute bottom-0 left-0 right-0 z-10 pointer-events-none overflow-hidden">
            <div className="bg-gradient-to-t from-slate-950/95 via-slate-950/80 to-transparent pt-2 pb-2 pl-16 pr-3">
              <div className="pointer-events-auto flex items-center gap-1 overflow-x-auto scrollbar-hide">
                <span className="text-[9px] uppercase tracking-widest text-slate-500 font-mono shrink-0 pr-2">LIVE</span>
                {items.map((it, i) => (
                  <button key={i} onClick={()=>{ setSelected(it.flight); setSelectedAirport(null); mapRef.current?.flyTo({center:[it.flight.lng, it.flight.lat], zoom:9, duration:1200}) }}
                    className="shrink-0 flex items-center gap-1.5 bg-slate-900/90 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 rounded-full px-2.5 py-1 text-[10px] font-mono transition group">
                    <span className="text-sm leading-none">{it.icon}</span>
                    <span className="text-slate-500 uppercase tracking-wider">{it.label}</span>
                    <span className={`${it.color} font-bold`}>{it.value}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )
      })()}

      {/* Emergency squawk toasts */}
      {toasts.length > 0 && (
        <div className="absolute bottom-12 left-3 md:left-4 z-40 flex flex-col-reverse gap-2 max-w-[320px]">
          {toasts.map(t => {
            const isWatch = t.id.startsWith('watch:')
            const label = isWatch ? 'WATCH' : t.sq === '7500' ? 'HIJACK' : t.sq === '7600' ? 'COMMS LOST' : 'EMERGENCY'
            const cls = isWatch
              ? 'bg-sky-950/95 border-sky-500 shadow-sky-900/60 hover:bg-sky-900 text-sky-100 border-2'
              : 'bg-rose-950/95 border-rose-500 shadow-rose-900/60 hover:bg-rose-900 animate-pulse border-2'
            const accent = isWatch ? 'text-sky-300' : 'text-rose-300'
            const sub = isWatch ? 'text-sky-200' : 'text-rose-200'
            const dim = isWatch ? 'text-sky-400/70' : 'text-rose-400/70'
            return (
              <button key={t.id}
                onClick={() => {
                  const f = flights.find(x => x.icao === t.icao)
                  if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, Math.max(mapRef.current?.getZoom() ?? 0, 8)) }
                  setToasts(prev => prev.filter(x => x.id !== t.id))
                }}
                className={`text-left backdrop-blur-xl rounded-xl px-3 py-2 shadow-2xl ${cls}`}
                style={isWatch ? {} : { animationDuration: '1.5s' }}>
                <div className="flex items-baseline gap-2">
                  <span className={`${accent} font-bold text-sm`}>{isWatch ? '★' : '⚠'} {label}</span>
                  {!isWatch && <span className={`${sub} font-mono text-xs`}>SQ {t.sq}</span>}
                </div>
                <div className="font-mono text-xs mt-0.5">{t.cs} · {t.icao.toUpperCase()}</div>
                <div className={`text-[9px] mt-0.5 ${dim}`}>Click to track →</div>
              </button>
            )
          })}
        </div>
      )}

      {/* Layers panel — categorized hub for all overlay toggles */}
      {showLayers && (
        <div className="absolute inset-0 z-50 flex items-start justify-end bg-slate-950/40 backdrop-blur-[2px]" onClick={()=>setShowLayers(false)}>
          <div className="mt-16 mr-4 w-[min(92vw,420px)] max-h-[78vh] overflow-y-auto bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl" onClick={e=>e.stopPropagation()}>
            <div className="sticky top-0 bg-slate-950/95 backdrop-blur-xl px-4 py-3 border-b border-slate-800 flex items-center justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-slate-500">Overlays</div>
                <div className="text-sm font-semibold text-slate-100">Layers <span className="text-slate-500 font-normal">· {activeLayerCount} active</span></div>
              </div>
              <button onClick={()=>setShowLayers(false)} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
            </div>
            {[
              {group:'View', items:[
                ['Heat', showHeat, ()=>setShowHeat(v=>!v)],
                ['Stats', showStats, ()=>setShowStats(v=>!v)],
                ['Watch', showWatch, ()=>setShowWatch(v=>!v)],
                ['Chase', chase, ()=>{ if(!selected){return} setChase(v=>{ const nv=!v; chaseRef.current=nv; if(nv){setShow3D(true)} return nv }) }],
                ['Fullscreen', isFullscreen, toggleFullscreen],
              ]},
              {group:'Safety & Traffic', items:[
                ['Radar', showRadar, ()=>{ const nv=!showRadar; setShowRadar(nv); lsSet('ft-radar', nv) }],
                ['Conflict', showConflict, ()=>{ const nv=!showConflict; setShowConflict(nv); lsSet('ft-cflx', nv) }],
                ['TCAS', showTcas, ()=>{ const nv=!showTcas; setShowTcas(nv); lsSet('ft-tcas', nv) }],
                ['CPA', showCpa, ()=>{ const nv=!showCpa; setShowCpa(nv); lsSet('ft-cpa', nv) }],
                ['Diversion', showDiversion, ()=>{ const nv=!showDiversion; setShowDiversion(nv); lsSet('ft-div', nv) }],
                ['Holding', showHolding, ()=>{ const nv=!showHolding; setShowHolding(nv); lsSet('ft-hold', nv) }],
                ['Formation', showFormation, ()=>{ const nv=!showFormation; setShowFormation(nv); lsSet('ft-form', nv) }],
                ['Anomaly', showAnomaly, ()=>{ const nv=!showAnomaly; setShowAnomaly(nv); lsSet('ft-anomaly', nv) }],
                ['Glide atlas', showGlide, ()=>{ const nv=!showGlide; setShowGlide(nv); lsSet('ft-glide', nv) }],
                ['Coffin corner', showCoffin, ()=>{ const nv=!showCoffin; setShowCoffin(nv); lsSet('ft-coffin', nv) }],
                ['Hypoxia', showHypoxia, ()=>{ const nv=!showHypoxia; setShowHypoxia(nv); lsSet('ft-hypoxia', nv) }],
                ['Cabin pressure', showCabin, ()=>{ const nv=!showCabin; setShowCabin(nv); lsSet('ft-cabin', nv) }],
                ['Squawk', showSquawk, ()=>{ const nv=!showSquawk; setShowSquawk(nv); lsSet('ft-squawk', nv) }],
                ['SUA monitor', showSua, ()=>{ const nv=!showSua; setShowSua(nv); lsSet('ft-sua', nv) }],
                ['Bird strike', showBird, ()=>{ const nv=!showBird; setShowBird(nv); lsSet('ft-bird', nv) }],
                ['Volcanic ash', showAsh, ()=>{ const nv=!showAsh; setShowAsh(nv); lsSet('ft-ash', nv) }],
                ['GPS / RAIM', showRaim, ()=>{ const nv=!showRaim; setShowRaim(nv); lsSet('ft-raim', nv) }],
                ['GNSS integrity', showGnss, ()=>{ const nv=!showGnss; setShowGnss(nv); lsSet('ft-gnss', nv) }],
                ['CPDLC datalink', showCpdlc, ()=>{ const nv=!showCpdlc; setShowCpdlc(nv); lsSet('ft-cpdlc', nv) }],
                ['Level bust', showLbust, ()=>{ const nv=!showLbust; setShowLbust(nv); lsSet('ft-lbust', nv) }],
                ['ADS-B quality', showAdsbq, ()=>{ const nv=!showAdsbq; setShowAdsbq(nv); lsSet('ft-adsbq', nv) }],
                ['Navaid coverage', showNavaid, ()=>{ const nv=!showNavaid; setShowNavaid(nv); lsSet('ft-navaid', nv) }],
                ['Drift-down OEI', showDrift, ()=>{ const nv=!showDrift; setShowDrift(nv); lsSet('ft-drift', nv) }],
                ['Reserve fuel', showReserve, ()=>{ const nv=!showReserve; setShowReserve(nv); lsSet('ft-reserve', nv) }],
                ['NORDO', showNordo, ()=>{ const nv=!showNordo; setShowNordo(nv); lsSet('ft-nordo', nv) }],
                ['Terrain TAWS', showTerrain, ()=>{ const nv=!showTerrain; setShowTerrain(nv); lsSet('ft-terrain', nv) }],
                ['RVSM compliance', showRvsm, ()=>{ const nv=!showRvsm; setShowRvsm(nv); lsSet('ft-rvsm', nv) }],
                ['Speed limit', showSpdLim, ()=>{ const nv=!showSpdLim; setShowSpdLim(nv); lsSet('ft-spdlim', nv) }],
                ['Sonic boom', showBoom, ()=>{ const nv=!showBoom; setShowBoom(nv); lsSet('ft-boom', nv) }],
                ['Brake energy', showBrake, ()=>{ const nv=!showBrake; setShowBrake(nv); lsSet('ft-brake', nv) }],
                ['OEI missed-approach', showMapp, ()=>{ const nv=!showMapp; setShowMapp(nv); lsSet('ft-mapp', nv) }],
                ['VHF congestion', showVhf, ()=>{ const nv=!showVhf; setShowVhf(nv); lsSet('ft-vhf', nv) }],
                ['Cross-polar ops', showPolar, ()=>{ const nv=!showPolar; setShowPolar(nv); lsSet('ft-polar', nv) }],
                ['Li-battery cargo', showLibat, ()=>{ const nv=!showLibat; setShowLibat(nv); lsSet('ft-libat', nv) }],
                ['CG / stab trim', showCgTrim, ()=>{ const nv=!showCgTrim; setShowCgTrim(nv); lsSet('ft-cgtrim', nv) }],
                ['Overweight ldg / jettison', showOwl, ()=>{ const nv=!showOwl; setShowOwl(nv); lsSet('ft-owl', nv) }],
                ['UAS / pitot-icing', showUas, ()=>{ const nv=!showUas; setShowUas(nv); lsSet('ft-uas', nv) }],
                ['Bleed-air fume', showBleed, ()=>{ const nv=!showBleed; setShowBleed(nv); lsSet('ft-bleed', nv) }],
                ['De-ice HOT', showDeice, ()=>{ const nv=!showDeice; setShowDeice(nv); lsSet('ft-deice', nv) }],
                ['P-Static comm', showPstatic, ()=>{ const nv=!showPstatic; setShowPstatic(nv); lsSet('ft-pstatic', nv) }],
                ['RECAT-EU wake', showRecat, ()=>{ const nv=!showRecat; setShowRecat(nv); lsSet('ft-recat', nv) }],
                ['EAI anti-ice', showEai, ()=>{ const nv=!showEai; setShowEai(nv); lsSet('ft-eai', nv) }],
                ['Relight envelope', showRelight, ()=>{ const nv=!showRelight; setShowRelight(nv); lsSet('ft-relight', nv) }],
                ['Cabin egress 90s', showEgress, ()=>{ const nv=!showEgress; setShowEgress(nv); lsSet('ft-egress', nv) }],
                ['NOTAM / TFR', showNotam, ()=>{ const nv=!showNotam; setShowNotam(nv); lsSet('ft-notam', nv) }],
                ['5G C-Band / Radalt', showRadalt5g, ()=>{ const nv=!showRadalt5g; setShowRadalt5g(nv); lsSet('ft-radalt5g', nv) }],
                ['CT-Alt (cold-temp)', showCtAlt, ()=>{ const nv=!showCtAlt; setShowCtAlt(nv); lsSet('ft-ctalt', nv) }],
              ]},
              {group:'Environment', items:[
                ['Wake', showWake, ()=>{ const nv=!showWake; setShowWake(nv); lsSet('ft-wake', nv) }],
                ['Contrail', showContrail, ()=>{ const nv=!showContrail; setShowContrail(nv); lsSet('ft-contrail', nv) }],
                ['CO₂', showEmissions, ()=>{ const nv=!showEmissions; setShowEmissions(nv); lsSet('ft-em', nv) }],
                ['Winds', showWinds, ()=>{ const nv=!showWinds; setShowWinds(nv); lsSet('ft-winds', nv) }],
                ['Sun', showSun, ()=>{ const nv=!showSun; setShowSun(nv); lsSet('ft-sun', nv) }],
                ['Sun glare', showSunGlare, ()=>{ const nv=!showSunGlare; setShowSunGlare(nv); lsSet('ft-sunglare', nv) }],
                ['Shadow', showShadow, ()=>{ const nv=!showShadow; setShowShadow(nv); lsSet('ft-shadow', nv) }],
                ['Doppler', showDoppler, ()=>{ const nv=!showDoppler; setShowDoppler(nv); lsSet('ft-doppler', nv) }],
                ['Noise', showNoise, ()=>{ const nv=!showNoise; setShowNoise(nv); lsSet('ft-noise', nv) }],
                ['Shear atlas', showShear, ()=>{ const nv=!showShear; setShowShear(nv); lsSet('ft-shear', nv) }],
                ['Cosmic dose', showCosmic, ()=>{ const nv=!showCosmic; setShowCosmic(nv); lsSet('ft-cosmic', nv) }],
                ['Icing', showIcing, ()=>{ const nv=!showIcing; setShowIcing(nv); lsSet('ft-icing', nv) }],
                ['Mountain wave', showMtnWave, ()=>{ const nv=!showMtnWave; setShowMtnWave(nv); lsSet('ft-mwave', nv) }],
                ['METAR', showMetar, ()=>{ const nv=!showMetar; setShowMetar(nv); lsSet('ft-metar', nv) }],
                ['Convective cells', showCells, ()=>{ const nv=!showCells; setShowCells(nv); lsSet('ft-cells', nv) }],
                ['Turbulence EDR', showTurb, ()=>{ const nv=!showTurb; setShowTurb(nv); lsSet('ft-turb', nv) }],
                ['TAF forecast', showTaf, ()=>{ const nv=!showTaf; setShowTaf(nv); lsSet('ft-taf', nv) }],
                ['Fuel temp', showFuelTemp, ()=>{ const nv=!showFuelTemp; setShowFuelTemp(nv); lsSet('ft-fueltemp', nv) }],
                ['Cabin ozone', showOzone, ()=>{ const nv=!showOzone; setShowOzone(nv); lsSet('ft-ozone', nv) }],
                ['Space weather', showSpwx, ()=>{ const nv=!showSpwx; setShowSpwx(nv); lsSet('ft-spwx', nv) }],
                ['Mag variation', showMagVar, ()=>{ const nv=!showMagVar; setShowMagVar(nv); lsSet('ft-magvar', nv) }],
              ]},
              {group:'Analysis', items:[
                ['Top of climb', showToc, ()=>{ const nv=!showToc; setShowToc(nv); lsSet('ft-toc', nv) }],
                ['Vertical profile', showVProfile, ()=>{ const nv=!showVProfile; setShowVProfile(nv); lsSet('ft-vp', nv) }],
                ['Flight level', showLadder, ()=>{ const nv=!showLadder; setShowLadder(nv); lsSet('ft-ladder', nv) }],
                ['Phase', showPhase, ()=>{ const nv=!showPhase; setShowPhase(nv); lsSet('ft-phase', nv) }],
                ['Cockpit (PFD)', showCockpit, ()=>{ const nv=!showCockpit; setShowCockpit(nv); lsSet('ft-pfd', nv) }],
                ['Scatter S×A', showScatter, ()=>{ const nv=!showScatter; setShowScatter(nv); lsSet('ft-scatter', nv) }],
                ['Density', showDensity, ()=>{ const nv=!showDensity; setShowDensity(nv); lsSet('ft-dens', nv) }],
                ['Voronoi', showVoronoi, ()=>{ const nv=!showVoronoi; setShowVoronoi(nv); lsSet('ft-voronoi', nv) }],
                ['Energy profile', showEnergy, ()=>{ const nv=!showEnergy; setShowEnergy(nv); lsSet('ft-energy', nv) }],
                ['Records', showRecords, ()=>{ const nv=!showRecords; setShowRecords(nv); lsSet('ft-records', nv) }],
                ['Cost index', showCostIdx, ()=>{ const nv=!showCostIdx; setShowCostIdx(nv); lsSet('ft-costidx', nv) }],
                ['Crew duty', showCrew, ()=>{ const nv=!showCrew; setShowCrew(nv); lsSet('ft-crewduty', nv) }],
                ['Mass & Balance', showMass, ()=>{ const nv=!showMass; setShowMass(nv); lsSet('ft-mass', nv) }],
                ['Workload TLX', showWkld, ()=>{ const nv=!showWkld; setShowWkld(nv); lsSet('ft-wkld', nv) }],
                ['FOQA exceedance', showFoqa, ()=>{ const nv=!showFoqa; setShowFoqa(nv); lsSet('ft-foqa', nv) }],
                ['EGT margin', showEgt, ()=>{ const nv=!showEgt; setShowEgt(nv); lsSet('ft-egt', nv) }],
                ['Hot-section LCF', showHotsec, ()=>{ const nv=!showHotsec; setShowHotsec(nv); lsSet('ft-hotsec', nv) }],
                ['Mmo/Vmo flutter', showFlutter, ()=>{ const nv=!showFlutter; setShowFlutter(nv); lsSet('ft-flutter', nv) }],
                ['Stall margin / α-floor', showStall, ()=>{ const nv=!showStall; setShowStall(nv); lsSet('ft-stall', nv) }],
                ['Tail strike rotation', showTailStrike, ()=>{ const nv=!showTailStrike; setShowTailStrike(nv); lsSet('ft-tailstrike', nv) }],
                ['Runway excursion RCAM', showRera, ()=>{ const nv=!showRera; setShowRera(nv); lsSet('ft-rera', nv) }],
                ['EGPWS / TAWS modes', showTaws, ()=>{ const nv=!showTaws; setShowTaws(nv); lsSet('ft-taws', nv) }],
                ['Lightning / HIRF', showLhirf, ()=>{ const nv=!showLhirf; setShowLhirf(nv); lsSet('ft-lhirf', nv) }],
              ]},
              {group:'Routes & Flow', items:[
                ['Overhead', showOverhead, ()=>{ const nv=!showOverhead; setShowOverhead(nv); lsSet('ft-overhead', nv) }],
                ['Route planner', showRoute, ()=>{ const nv=!showRoute; setShowRoute(nv); lsSet('ft-route', nv) }],
                ['Step climb', showStepClimb, ()=>{ const nv=!showStepClimb; setShowStepClimb(nv); lsSet('ft-stepclimb', nv) }],
                ['ETOPS', showEtops, ()=>{ const nv=!showEtops; setShowEtops(nv); lsSet('ft-etops', nv) }],
                ['Departure seq', showDepSeq, ()=>{ const nv=!showDepSeq; setShowDepSeq(nv); lsSet('ft-depseq', nv) }],
                ['Crosswind', showXwind, ()=>{ const nv=!showXwind; setShowXwind(nv); lsSet('ft-xwind', nv) }],
                ['Jet stream', showJet, ()=>{ const nv=!showJet; setShowJet(nv); lsSet('ft-jet', nv) }],
                ['Holding stack', showHstack, ()=>{ const nv=!showHstack; setShowHstack(nv); lsSet('ft-hstack', nv) }],
                ['Curfew', showCurfew, ()=>{ const nv=!showCurfew; setShowCurfew(nv); lsSet('ft-curfew', nv) }],
                ['Approach seq', showAprSeq, ()=>{ const nv=!showAprSeq; setShowAprSeq(nv); lsSet('ft-aprseq', nv) }],
                ['Oceanic tracks', showOcean, ()=>{ const nv=!showOcean; setShowOcean(nv); lsSet('ft-ocean', nv) }],
                ['FIR load', showFir, ()=>{ const nv=!showFir; setShowFir(nv); lsSet('ft-fir', nv) }],
                ['SAR planner', showSar, ()=>{ const nv=!showSar; setShowSar(nv); lsSet('ft-sar', nv) }],
                ['Stable approach', showStable, ()=>{ const nv=!showStable; setShowStable(nv); lsSet('ft-stable', nv) }],
                ['Approach mins', showApMin, ()=>{ const nv=!showApMin; setShowApMin(nv); lsSet('ft-apmin', nv) }],
                ['CDA compliance', showCda, ()=>{ const nv=!showCda; setShowCda(nv); lsSet('ft-cda', nv) }],
                ['SID climb', showSidc, ()=>{ const nv=!showSidc; setShowSidc(nv); lsSet('ft-sidc', nv) }],
                ['ETP / CP', showEtp, ()=>{ const nv=!showEtp; setShowEtp(nv); lsSet('ft-etp', nv) }],
                ['RNP / PBN', showRnp, ()=>{ const nv=!showRnp; setShowRnp(nv); lsSet('ft-rnp', nv) }],
                ['SATCOM/HF', showSatcom, ()=>{ const nv=!showSatcom; setShowSatcom(nv); lsSet('ft-satcom', nv) }],
                ['RTA / 4D', showRta, ()=>{ const nv=!showRta; setShowRta(nv); lsSet('ft-rta', nv) }],
                ['NADP Noise', showNadp, ()=>{ const nv=!showNadp; setShowNadp(nv); lsSet('ft-nadp', nv) }],
                ['Fuel tankering', showTank, ()=>{ const nv=!showTank; setShowTank(nv); lsSet('ft-tank', nv) }],
                ['FIR crossings', showFirX, ()=>{ const nv=!showFirX; setShowFirX(nv); lsSet('ft-firx', nv) }],
                ['Runway config', showRwyCfg, ()=>{ const nv=!showRwyCfg; setShowRwyCfg(nv); lsSet('ft-rwycfg', nv) }],
                ['Pass-by', showPass, ()=>{ const nv=!showPass; setShowPass(nv); lsSet('ft-pass', nv) }],
                ['Flow', showFlow, ()=>{ const nv=!showFlow; setShowFlow(nv); lsSet('ft-flow', nv) }],
                ['Reach', showReach, ()=>{ const nv=!showReach; setShowReach(nv); lsSet('ft-reach', nv) }],
                ['Trip', showTrip, ()=>{ const nv=!showTrip; setShowTrip(nv); lsSet('ft-trip', nv) }],
                ['Race', showRace, ()=>{ const nv=!showRace; setShowRace(nv); lsSet('ft-race', nv) }],
                ['Time machine', showTimeMachine, ()=>{ const nv=!showTimeMachine; setShowTimeMachine(nv); lsSet('ft-timemachine', nv) }],
                ['Rwy excursion / hydroplane', showRexhyd, ()=>{ const nv=!showRexhyd; setShowRexhyd(nv); lsSet('ft-rexhyd', nv) }],
                ['CTOT / ATFM slot', showCtot, ()=>{ const nv=!showCtot; setShowCtot(nv); lsSet('ft-ctot', nv) }],
                ['TOLD / V-speeds / BFL', showTold, ()=>{ const nv=!showTold; setShowTold(nv); lsSet('ft-told', nv) }],
              ]},
              {group:'Tools', items:[
                ['Ruler', showRuler, ()=>setShowRuler(v=>!v)],
                ['E6B computer', showE6b, ()=>setShowE6b(v=>!v)],
                ['Bullseye', showBullseye, ()=>setShowBullseye(v=>!v)],
                ['Tripwire', showTripwire, ()=>{ const nv=!showTripwire; setShowTripwire(nv); lsSet('ft-tripwire', nv) }],
                ['Geofence', showGeofence, ()=>{ const nv=!showGeofence; setShowGeofence(nv); lsSet('ft-geofence', nv) }],
                ['Event log', showEventLog, ()=>{ const nv=!showEventLog; setShowEventLog(nv); lsSet('ft-evlog', nv) }],
                ['Compare studio', showCompareStudio, ()=>{ const nv=!showCompareStudio; setShowCompareStudio(nv); lsSet('ft-compare-studio', nv) }],
                ['Symphony', showSymphony, ()=>{ const nv=!showSymphony; setShowSymphony(nv); lsSet('ft-symphony', nv) }],
              ]},
              {group:'Reference', items:[
                ['Airports board', showBoard, ()=>{ const nv=!showBoard; setShowBoard(nv); lsSet('ft-board', nv) }],
                ['Atlas', showAtlas, ()=>{ const nv=!showAtlas; setShowAtlas(nv); lsSet('ft-atlas', nv) }],
                ['VIP', showVip, ()=>{ const nv=!showVip; setShowVip(nv); lsSet('ft-vip', nv) }],
                ['Time of day', showTod, ()=>{ const nv=!showTod; setShowTod(nv); lsSet('ft-tod', nv) }],
              ]},
            ].map(section => (
              <div key={section.group} className="px-4 py-3 border-b border-slate-900 last:border-0">
                <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">{section.group}</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {(section.items as Array<[string, boolean, ()=>void]>).map(([label, on, onClick]) => (
                    <button key={label} onClick={onClick}
                      className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs text-left transition border ${on ? 'bg-sky-500/15 border-sky-500/50 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-300 hover:bg-slate-800/70 hover:border-slate-700'}`}>
                      <span className="truncate">{label}</span>
                      <span className={`size-1.5 rounded-full shrink-0 ${on ? 'bg-sky-400' : 'bg-slate-700'}`} />
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Help / shortcuts modal */}
      {showHelp && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4" onClick={()=>setShowHelp(false)}>
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 max-w-md w-full shadow-2xl" onClick={e=>e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold tracking-widest uppercase text-sky-400">Keyboard Shortcuts</h3>
              <button onClick={()=>setShowHelp(false)} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              {[['/', 'Focus search'],['Esc','Close panel / search'],['L','Toggle list'],['F','Toggle filters'],['W','Watchlist'],['S','Stats'],['T','Trails'],['H','Heat'],['N','Night'],['3','3D view'],['C','Chase cam'],['M','Map style'],['?','This help']].map(([k,d]) => (
                <div key={k} className="contents">
                  <kbd className="font-mono text-slate-300 bg-slate-800 px-1.5 py-0.5 rounded text-[10px] justify-self-start">{k}</kbd>
                  <span className="text-slate-400">{d}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Map style chooser */}
      {showStyles && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4" onClick={()=>setShowStyles(false)}>
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 max-w-sm w-full shadow-2xl" onClick={e=>e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold tracking-widest uppercase text-sky-400">Map Style</h3>
              <button onClick={()=>setShowStyles(false)} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {([['dark','Dark','#0f172a'],['light','Light','#e2e8f0'],['sat','Satellite','#1e3a2b']] as const).map(([k,l,bg]) => (
                <button key={k} onClick={()=>{ setMapStyle(k); setShowStyles(false) }}
                  className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border ${mapStyle===k?'border-sky-400 ring-2 ring-sky-400/30':'border-slate-800'} hover:border-slate-600`}>
                  <div className="w-full h-12 rounded-md" style={{background:bg}} />
                  <span className={`text-[10px] font-bold uppercase tracking-wider ${mapStyle===k?'text-sky-400':'text-slate-300'}`}>{l}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Emergency log drawer */}
      {showEmergLog && (
        <div className="absolute right-3 top-20 z-40 w-72 bg-slate-900/95 backdrop-blur-xl border border-rose-900/60 rounded-xl shadow-2xl">
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
            <span className="text-[10px] font-bold tracking-widest uppercase text-rose-400">Recent Emergencies</span>
            <button onClick={()=>setShowEmergLog(false)} className="text-slate-500 hover:text-slate-200 text-sm leading-none">×</button>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {emergLog.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11px] text-slate-500">No emergencies this session.</div>
            ) : emergLog.map((e,i) => (
              <button key={`${e.icao}-${e.t}-${i}`} onClick={()=>{
                const f = flightsRef.current.find(x => x.icao === e.icao)
                if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 9) } else { flyToLatLng(e.lat, e.lng, 9) }
                setShowEmergLog(false)
              }} className="w-full text-left px-3 py-2 border-b border-slate-800/60 hover:bg-rose-950/30">
                <div className="flex items-baseline justify-between">
                  <span className="font-mono text-xs text-rose-300 font-bold">{e.cs || e.icao.toUpperCase()}</span>
                  <span className="font-mono text-[10px] text-slate-500">SQ {e.sq}</span>
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">{new Date(e.t).toLocaleTimeString()}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Floating utility buttons (bottom-right) — collapsible FAB on mobile */}
      <div className="ft-fab absolute bottom-4 right-3 sm:right-4 z-30 flex flex-col gap-1.5 items-end ft-safe-mb">
        {/* FAB toggle (mobile only) */}
        <button onClick={()=>setFabOpen(v=>!v)} aria-label="More tools"
          className="sm:hidden w-12 h-12 rounded-full bg-sky-600/95 backdrop-blur border border-sky-400 text-white text-xl font-bold shadow-2xl active:scale-95 transition order-last">
          {fabOpen ? '×' : '⋯'}
        </button>
        <div className={`flex flex-col gap-1.5 items-end ${fabOpen ? 'flex' : 'hidden'} sm:flex`}>
        <button onClick={()=>setShowStyles(true)} title="Map style (m)"
          className="w-11 h-11 sm:w-9 sm:h-9 rounded-lg bg-slate-900/90 backdrop-blur border border-slate-800 text-slate-300 hover:text-sky-400 hover:border-sky-700 text-sm font-bold shadow-xl">◐</button>
        <button onClick={()=>setShowEmergLog(v=>!v)} title="Recent emergencies"
          className={`relative w-11 h-11 sm:w-9 sm:h-9 rounded-lg bg-slate-900/90 backdrop-blur border text-sm font-bold shadow-xl ${emergLog.length?'border-rose-700 text-rose-400':'border-slate-800 text-slate-500'}`}>
          ⚠{emergLog.length>0 && <span className="absolute -top-1 -right-1 bg-rose-500 text-slate-950 text-[9px] font-mono rounded-full w-4 h-4 flex items-center justify-center">{emergLog.length}</span>}
        </button>
        <button onClick={()=>setShowHelp(true)} title="Help (?)"
          className="w-11 h-11 sm:w-9 sm:h-9 rounded-lg bg-slate-900/90 backdrop-blur border border-slate-800 text-slate-300 hover:text-sky-400 hover:border-sky-700 text-sm font-bold shadow-xl">?</button>
        {/* [BATCH-A] screenshot + settings */}
        <button onClick={()=>{
          try {
            const canvas = mapRef.current?.getCanvas()
            if (!canvas) { pushToast('Map not ready', 'warn'); return }
            const url = canvas.toDataURL('image/png')
            const a = document.createElement('a')
            a.href = url; a.download = `flight-map-${Date.now()}.png`; a.click()
            pushToast('Screenshot saved', 'success')
          } catch (e) { pushToast('Screenshot failed', 'error') }
        }} title={i18nT('screenshot')} aria-label={i18nT('screenshot')}
          className="ft-focus w-11 h-11 sm:w-9 sm:h-9 rounded-lg bg-slate-900/90 backdrop-blur border border-slate-800 text-slate-300 hover:text-sky-400 hover:border-sky-700 text-sm font-bold shadow-xl focus:outline-none focus:ring-2 focus:ring-sky-500">📷</button>
        <button onClick={()=>{
          try {
            const log = (emergLog || []).map(e => ({ icao: e.icao, callsign: e.cs, squawk: e.sq, lat: e.lat, lng: e.lng, t: new Date(e.t).toISOString() }))
            const sel = selected ? { icao: selected.icao, callsign: selected.callsign, lat: selected.lat, lng: selected.lng, t: new Date().toISOString() } : null
            const blob = new Blob([JSON.stringify({ emergencies: log, selected: sel }, null, 2)], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a'); a.href = url; a.download = `flight-log-${Date.now()}.json`; a.click()
            setTimeout(() => URL.revokeObjectURL(url), 2000)
            pushToast('Log exported', 'success')
          } catch { pushToast('Export failed', 'error') }
        }} title={i18nT('exportLog')} aria-label={i18nT('exportLog')}
          className="ft-focus w-11 h-11 sm:w-9 sm:h-9 rounded-lg bg-slate-900/90 backdrop-blur border border-slate-800 text-slate-300 hover:text-sky-400 hover:border-sky-700 text-sm font-bold shadow-xl focus:outline-none focus:ring-2 focus:ring-sky-500">⤓</button>
        <SettingsCluster />
        </div>
      </div>
      {/* [BATCH-B] overlays + tools + context menu + measure + pins + bookmarks */}
      <BatchBOverlays
        map={mapRef.current}
        mapReady={mapReady}
        flights={flights as any}
        selectedIcao={selected?.icao || null}
        watchHexes={new Set(watchlist.map(w => w.toLowerCase()))}
        airports={AIRPORTS as any}
        onSelectFlight={(hex) => {
          const f = flightsRef.current.find(x => x.icao === hex)
          if (f) setSelected(f)
        }}
        onDeselect={() => setSelected(null)}
        onFlyTo={(lat, lng, zoom) => flyToLatLng(lat, lng, zoom)}
      />
      {/* [BATCH-C] overlay: hover tooltip, splash, about, fx, konami, galaxy */}
      <BatchCOverlay
        mapRef={mapRef}
        flightsRef={flightsRef}
        selected={selected}
        mapZoom={mapZoom}
        prefs={batchCPrefs}
      />
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] uppercase tracking-widest text-slate-500 whitespace-nowrap">{label}</div>
      <div className={`text-base md:text-lg font-bold tabular-nums leading-tight whitespace-nowrap ${color}`}>{value}</div>
    </div>
  )
}
function Field({ k, v, wide, accent }: { k: string; v: string; wide?: boolean; accent?: string }) {
  return (
    <div className={`bg-slate-900/60 border border-slate-800 rounded-lg p-2 ${wide?'col-span-2':''}`}>
      <div className="text-[9px] uppercase tracking-widest text-slate-500">{k}</div>
      <div className={`text-sm font-mono mt-0.5 ${accent || 'text-slate-100'}`}>{v}</div>
    </div>
  )
}
function Toggle({ on, onClick, label, hint }: { on: boolean; onClick: () => void; label: string; hint?: string }) {
  return (
    <button onClick={onClick} title={hint ? `Press ${hint}` : undefined}
      className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium tracking-wide transition border ${on?'bg-sky-500/15 text-sky-100 border-sky-500/40':'text-slate-300 hover:bg-slate-800 border-transparent'}`}>
      {label}
    </button>
  )
}
function CheckRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2.5 cursor-pointer text-slate-300 text-sm">
      <input type="checkbox" checked={checked} onChange={e=>onChange(e.target.checked)} className="accent-sky-500 size-4" />
      {label}
    </label>
  )
}

function compass(deg: number) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']
  return dirs[Math.round(((deg % 360) / 22.5)) % 16]
}
function altColor(ft: number): string {
  if (ft <= 0)      return '#64748b'
  if (ft < 1000)    return '#ec4899'
  if (ft < 3000)    return '#f43f5e'
  if (ft < 6000)    return '#fb7185'
  if (ft < 10000)   return '#f97316'
  if (ft < 15000)   return '#fb923c'
  if (ft < 20000)   return '#f59e0b'
  if (ft < 25000)   return '#facc15'
  if (ft < 28000)   return '#fde047'
  if (ft < 31000)   return '#bef264'
  if (ft < 34000)   return '#a3e635'
  if (ft < 36000)   return '#22d3ee'
  if (ft < 38000)   return '#67e8f9'
  if (ft < 40000)   return '#38bdf8'
  if (ft < 43000)   return '#0ea5e9'
  if (ft < 46000)   return '#818cf8'
  if (ft < 50000)   return '#a78bfa'
  if (ft < 55000)   return '#c084fc'
  return '#d946ef'
}
function speedColor(kt: number): string {
  if (kt < 30)   return '#64748b'
  if (kt < 80)   return '#ec4899'
  if (kt < 150)  return '#f43f5e'
  if (kt < 220)  return '#f97316'
  if (kt < 300)  return '#facc15'
  if (kt < 380)  return '#bef264'
  if (kt < 450)  return '#10b981'
  if (kt < 500)  return '#22d3ee'
  if (kt < 560)  return '#38bdf8'
  if (kt < 620)  return '#6366f1'
  return '#a78bfa'
}
function catColor(cat: string): string {
  if (cat === 'A7') return '#10b981'              // helicopter
  if (cat === 'B1') return '#a78bfa'              // glider
  if (cat === 'B2') return '#c084fc'              // balloon
  if (cat === 'B4') return '#d946ef'              // ultralight
  if (cat === 'B6') return '#06b6d4'              // UAV
  if (cat === 'B7') return '#818cf8'              // spacecraft
  if (cat === 'A1') return '#fde047'              // light (<15.5k lb)
  if (cat === 'A2') return '#facc15'              // small (15.5–75k)
  if (cat === 'A3') return '#fb923c'              // large (75–300k)
  if (cat === 'A4') return '#f97316'              // high-vortex large (B757)
  if (cat === 'A5') return '#e11d48'              // heavy (>300k)
  if (cat === 'A6') return '#7c3aed'              // high-performance
  return '#94a3b8'
}
const REG_FLAG: Array<[RegExp, string, string]> = [
  [/^N/, 'US', '\u{1F1FA}\u{1F1F8}'],
  [/^G-/, 'GB', '\u{1F1EC}\u{1F1E7}'],
  [/^D-/, 'DE', '\u{1F1E9}\u{1F1EA}'],
  [/^F-/, 'FR', '\u{1F1EB}\u{1F1F7}'],
  [/^C-/, 'CA', '\u{1F1E8}\u{1F1E6}'],
  [/^JA/, 'JP', '\u{1F1EF}\u{1F1F5}'],
  [/^VH-/, 'AU', '\u{1F1E6}\u{1F1FA}'],
  [/^VT-/, 'IN', '\u{1F1EE}\u{1F1F3}'],
  [/^EC-/, 'ES', '\u{1F1EA}\u{1F1F8}'],
  [/^EI-/, 'IE', '\u{1F1EE}\u{1F1EA}'],
  [/^OO-/, 'BE', '\u{1F1E7}\u{1F1EA}'],
  [/^PH-/, 'NL', '\u{1F1F3}\u{1F1F1}'],
  [/^LN-/, 'NO', '\u{1F1F3}\u{1F1F4}'],
  [/^SE-/, 'SE', '\u{1F1F8}\u{1F1EA}'],
  [/^A6-/, 'AE', '\u{1F1E6}\u{1F1EA}'],
  [/^A7-/, 'QA', '\u{1F1F6}\u{1F1E6}'],
  [/^B-/, 'CN', '\u{1F1E8}\u{1F1F3}'],
  [/^HL/, 'KR', '\u{1F1F0}\u{1F1F7}'],
  [/^(PR-|PT-|PP-)/, 'BR', '\u{1F1E7}\u{1F1F7}'],
  [/^(XA-|XB-|XC-)/, 'MX', '\u{1F1F2}\u{1F1FD}'],
  [/^(I-|I)/, 'IT', '\u{1F1EE}\u{1F1F9}'],
  [/^(OE-)/, 'AT', '\u{1F1E6}\u{1F1F9}'],
  [/^(HB-)/, 'CH', '\u{1F1E8}\u{1F1ED}'],
  [/^(CC-)/, 'CL', '\u{1F1E8}\u{1F1F1}'],
  [/^(LV-)/, 'AR', '\u{1F1E6}\u{1F1F7}'],
  [/^(ZK-)/, 'NZ', '\u{1F1F3}\u{1F1FF}'],
  [/^(ZS-)/, 'ZA', '\u{1F1FF}\u{1F1E6}'],
]
function regFlag(reg: string): { flag: string; code: string } | null {
  const r = (reg || '').toUpperCase()
  for (const [re, code, flag] of REG_FLAG) if (re.test(r)) return { flag, code }
  return null
}
function fmtAlt(ft: number, u: 'ft'|'m'): string {
  if (u === 'm') return `${Math.round(ft * 0.3048).toLocaleString()} m`
  return `${Math.round(ft).toLocaleString()} ft`
}
function fmtSpd(kt: number, u: 'kt'|'mph'|'kmh'): string {
  if (u === 'mph') return `${Math.round(kt * 1.15078)} mph`
  if (u === 'kmh') return `${Math.round(kt * 1.852)} km/h`
  return `${Math.round(kt)} kt`
}
const NOTABLE_RE = /^(AF1|AIRFORCE1|FORCE0?1|SAM\d+|SPAR\d+|RCH\d+|JANET\d*|VENUS\d+|GAF\d+|BLKHWK\d*|MUSTER\d*)$/i
function isNotable(cs: string): boolean { return NOTABLE_RE.test((cs || '').replace(/\s+/g, '')) }

function PlaneLogo() {
  const [theme, setTheme] = useState<string>('sky')
  const [open, setOpen] = useState(false)
  useEffect(() => {
    try { const v = localStorage.getItem('ft-accent'); if (v) setTheme(v) } catch {}
  }, [])
  useEffect(() => {
    try { document.documentElement.dataset.ftAccent = theme } catch {}
  }, [theme])

  const choose = (k: string) => { setTheme(k); try { localStorage.setItem('ft-accent', k) } catch {}; setOpen(false) }
  const cls = ({
    sky:     'from-sky-400 to-sky-600 shadow-sky-500/30',
    emerald: 'from-emerald-400 to-emerald-600 shadow-emerald-500/30',
    violet:  'from-violet-400 to-violet-600 shadow-violet-500/30',
    rose:    'from-rose-400 to-rose-600 shadow-rose-500/30',
    amber:   'from-amber-400 to-amber-600 shadow-amber-500/30',
    fuchsia: 'from-fuchsia-400 to-fuchsia-600 shadow-fuchsia-500/30',
    teal:    'from-teal-400 to-teal-600 shadow-teal-500/30',
    orange:  'from-orange-400 to-orange-600 shadow-orange-500/30',
  } as Record<string,string>)[theme] || 'from-sky-400 to-sky-600 shadow-sky-500/30'

  const swatches = [
    ['sky','#0ea5e9'], ['emerald','#10b981'], ['violet','#8b5cf6'], ['rose','#f43f5e'],
    ['amber','#f59e0b'], ['fuchsia','#d946ef'], ['teal','#14b8a6'], ['orange','#f97316'],
  ] as const
  return (
    <div className="relative">
      <button onClick={()=>setOpen(v=>!v)} title="Change accent color"
        className={`size-9 rounded-xl bg-gradient-to-br ${cls} flex items-center justify-center shadow-lg transition-transform hover:scale-105 active:scale-95`}>
        <svg viewBox="0 0 24 24" width="22" height="22" className="-rotate-12">
          <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 1 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" fill="#0f172a"/>
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={()=>setOpen(false)} />
          <div className="absolute top-full left-0 mt-2 z-50 bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-xl p-2 shadow-2xl">
            <div className="text-[9px] uppercase tracking-widest text-slate-500 px-1 pb-1.5">Accent</div>
            <div className="grid grid-cols-4 gap-1.5">
              {swatches.map(([k,hex])=>(
                <button key={k} onClick={()=>choose(k)} title={k}
                  className={`size-6 rounded-md border-2 transition-transform hover:scale-110 ${theme===k?'border-white':'border-slate-700'}`}
                  style={{background:`linear-gradient(135deg, ${hex}cc, ${hex})`}} />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/* Day/night terminator polygon (simple Spencer formula). Returns [lat,lng]. */
function terminatorPolygon(date: Date): Array<[number, number]> {
  const julian = date.getTime() / 86400000 + 2440587.5
  const T = (julian - 2451545.0) / 36525
  const epsilon = (23.439 - 0.0000004 * (julian - 2451545.0)) * Math.PI / 180
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360
  const M = (357.52911 + T * (35999.05029 - 0.0001537 * T)) * Math.PI / 180
  const C = (1.914602 - T * (0.004817 + 0.000014 * T)) * Math.sin(M)
            + (0.019993 - 0.000101 * T) * Math.sin(2 * M)
            + 0.000289 * Math.sin(3 * M)
  const lambda = (L0 + C) * Math.PI / 180
  const dec = Math.asin(Math.sin(epsilon) * Math.sin(lambda))
  const utHours = date.getUTCHours() + date.getUTCMinutes()/60 + date.getUTCSeconds()/3600
  const gha = (utHours * 15 - 180) * Math.PI / 180
  const pts: Array<[number, number]> = []
  for (let lng = -180; lng <= 180; lng += 2) {
    const H = (lng * Math.PI / 180) + gha
    const lat = Math.atan(-Math.cos(H) / Math.tan(dec)) * 180 / Math.PI
    pts.push([lat, lng])
  }
  const decDeg = dec * 180 / Math.PI
  if (decDeg > 0) {
    pts.push([-90, 180]); pts.push([-90, -180])
  } else {
    pts.push([90, 180]); pts.push([90, -180])
  }
  return pts
}
