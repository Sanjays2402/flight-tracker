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
import IlsCriticalArea from './ils-cs-area'
import PrmNtz from './prm-ntz'
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
import EosidMonitor from './eosid-monitor'
import SteepApproach from './steep-approach'
import RedispatchMonitor from './redispatch-monitor'
import OptAltCruise from './optalt-cruise'
import MsawController from './msaw-controller'
import PirepMonitor from './pirep-monitor'
import TdwrLlwas from './tdwr-llwas'
import MtcdMonitor from './mtcd-monitor'
import Vdl2Datalink from './vdl2-datalink'
import SigmetAirmet from './sigmet-airmet'
import TfmInitiatives from './tfm-initiatives'
import LahsoMonitor from './lahso-monitor'
import MoraGrid from './mora-grid'
import StarConstraints from './star-constraints'
import DeiceHot from './deice-hot'
import PStaticMonitor from './pstatic-monitor'
import RelightEnvelope from './relight-envelope'
import HydraulicMonitor from './hydraulic-monitor'
import Egress90Sec from './egress-90sec'
import NotamTfr from './notam-tfr'
import CargoFireSuppress from './cargo-fire-suppress'
import AutolandLvo from './autoland-lvo'
import Radalt5g from './radalt-5g'
import CtAltMonitor from './ctalt-monitor'
import TbsMonitor from './tbs-monitor'
import VtfIntercept from './vtf-intercept'
import RfiGnss from './rfi-gnss'
import MntMonitor from './mnt-monitor'
import CcoMonitor from './cco-monitor'
import WatMonitor from './wat-monitor'
import AcdmMonitor from './acdm-monitor'
import AmanMonitor from './aman-monitor'
import HiroMonitor from './hiro-monitor'
import HotspotIncursion from './hotspot-incursion'
import LrahMonitor from './lrah-monitor'
import RffsMonitor from './rffs-monitor'
import CwyWakeEncounter from './cwy-wake-encounter'
import JblastJetBlast from './jblast-jet-blast'
import MrvaMonitor from './mrva-monitor'
import AirproxRat from './airprox-rat'
import MedlinkDiversion from './medlink-diversion'
import CirclingApproach from './circling-approach'
import VmoMmoEnvelope from './vmo-mmo-envelope'
import NemoOtp from './nemo-otp'
import BregSpecificRange from './breg-specific-range'
import OldLandingDistance from './old-landing-distance'
import DocCostBreakeven from './doc-cost-breakeven'
import CircadFatigue from './circad-fatigue'
import VmcaMonitor from './vmca-monitor'
import TemEnergy from './tem-energy'
import RotorOps from './rotor-ops'
import CzneConflictZone from './czne-conflict-zone'
import CastAccidentCat from './cast-accident-cat'
import BlkHolIllusion from './blkhol-illusion'
import GldGlideReach from './gld-glide-reach'
import PrdPayloadRange from './prd-payload-range'
import AltnAlternateSuit from './altn-alternate-suit'
import FlexAtmThrust from './flex-atm-thrust'
import MeltMassEstimator from './melt-mass-estimator'
import CrzlSemicircular from './crzl-semicircular'
import DrftdnDriftdown from './drftdn-driftdown'
import VrpCorridor from './vrp-corridor'
import TurnMonitor from './turn-monitor'
import DgsDocking from './dgs-docking'
import TmiHfe from './tmi-hfe'
import FleetComparison from './fleet-comparison'
import GustVraMargin from './gust-vra-margin'
import EdrEmergDescent from './edr-emerg-descent'
import NvpmParticulate from './nvpm-particulate'
import SwellDitch from './swell-ditch'
import WxadRadarTilt from './wxad-radar-tilt'
import VfeFlapMargin from './vfe-flap-margin'
import DecrabSideload from './decrab-sideload'
import RtowRtoMargin from './rtow-rto-margin'
import TropoEncounter from './tropo-encounter'
import WafsWindFL from './wafs-wind-fl'
import AcasX from './acasx-collision'
import OlsObstacleSurface from './ols-obstacle-surface'
import PmsPointMerge from './pms-pointmerge'
import FraFreeRoute from './fra-free-route'
import CdrConditionalRoute from './cdr-conditional-route'
import StcaConflict from './stca-conflict'
import DcbSectorLoad from './dcb-sector-load'
import RwslStatusLights from './rwsl-status-lights'
import AltmSettingRegion from './altm-setting-region'
import HoldStack from './hold-stack'
import FimAspa from './fim-aspa'
import ClamRam from './clam-ram'
import CscCallsign from './csc-callsign'
import ApuMonitor from './apu-monitor'
import FuelTanker from './fuel-tanker'
import PcnPavement from './pcn-pavement'
import FuelImbalance from './fuel-imbalance'
import CsffFrost from './csff-frost'
import FbwReversion from './fbw-reversion'
import MelMonitor from './mel-monitor'
import OilConsumption from './oil-consumption'
import HfdlCoverage from './hfdl-coverage'
import EhsBds from './ehs-bds'
import ArffRffs from './arff-rffs'
import SbasLpv from './sbas-lpv'
import VibMonitor from './vib-monitor'
import ElectricalBus from './electrical-bus'
import TrimAuthority from './trim-authority'
import DmeDmeFom from './dme-dme-fom'
import TReverserMonitor from './treverser-monitor'
import VorMonReversion from './vor-mon'
import PaxOxygenMonitor from './pax-oxygen'
import StartEnvelope from './start-envelope'
import DAtisMonitor from './datis-monitor'
import UlbPingerMonitor from './ulb-pinger'
import SlopMonitor from './slop-monitor'
import RowRopMonitor from './row-rop'
import PapiVgsiMonitor from './papi-vgsi'
import SelcalMonitor from './selcal-monitor'
import AdscFans from './adsc-fans'
import AiracNavDb from './airac-nav-db'
import WowSquat from './wow-squat'
import TpisBtms from './tpis-btms'
import ItpAseps from './itp-aseps'
import AsdexSurface from './asdex-surface'
import PsrSsrCoverage from './psr-ssr-coverage'
import FireLoop from './fire-loop'
import VaacMonitor from './vaac-monitor'
import VolmetMonitor from './volmet-monitor'
import OxygenDuration from './oxygen-duration'
import ColdTempCorr from './cold-temp-corr'
import CcmCallsignConfusion from './ccm-callsign-confusion'
import TasarAdvisor from './tasar-advisor'
import TcamCyclone from './tcam-cyclone'
import DaaWellClear from './daa-wellclear'
import NgsInerting from './ngs-inerting'
import GadssEltDt from './gadss-eltdt'
import EfvsHud from './efvs-hud'
import IrsAdiru from './irs-adiru'
import RcamTalpa from './rcam-talpa'
import MlatWam from './mlat-wam'
import PbcsRcpRsp from './pbcs-rcprsp'
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
import SaarRnpAr from './saar-rnp-ar'
import RtaConformance from './rta-conformance'
import SatcomCoverage from './satcom-coverage'
import NadpMonitor from './nadp-monitor'
import FuelTankering from './fuel-tankering'
import VappAdvisor from './vapp-advisor'
import GlsGbas from './gls-gbas'
import SafCorsia from './saf-corsia'
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
  const [showIlsCs, setShowIlsCs] = useState<boolean>(() => lsGet('ft-ilscs', false))
  const [showPrm, setShowPrm] = useState<boolean>(() => lsGet('ft-prm', false))
  const [showDrift, setShowDrift] = useState<boolean>(() => lsGet('ft-drift', false))
  const [showReserve, setShowReserve] = useState<boolean>(() => lsGet('ft-reserve', false))
  const [showEtp, setShowEtp] = useState<boolean>(() => lsGet('ft-etp', false))
  const [showCda, setShowCda] = useState<boolean>(() => lsGet('ft-cda', false))
  const [showVapp, setShowVapp] = useState<boolean>(() => lsGet('ft-vapp', false))
  const [showGls, setShowGls] = useState<boolean>(() => lsGet('ft-gls', false))
  const [showSaf, setShowSaf] = useState<boolean>(() => lsGet('ft-saf', false))
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
  const [showHyd, setShowHyd] = useState<boolean>(() => lsGet('ft-hyd', false))
  const [showEgress, setShowEgress] = useState<boolean>(() => lsGet('ft-egress', false))
  const [showNotam, setShowNotam] = useState<boolean>(() => lsGet('ft-notam', false))
  const [showCargoFs, setShowCargoFs] = useState<boolean>(() => lsGet('ft-cargofs', false))
  const [showAutoland, setShowAutoland] = useState<boolean>(() => lsGet('ft-autoland', false))
  const [showRadalt5g, setShowRadalt5g] = useState<boolean>(() => lsGet('ft-radalt5g', false))
  const [showCtAlt, setShowCtAlt] = useState<boolean>(() => lsGet('ft-ctalt', false))
  const [showHotsec, setShowHotsec] = useState<boolean>(() => lsGet('ft-hotsec', false))
  const [showLhirf, setShowLhirf] = useState<boolean>(() => lsGet('ft-lhirf', false))
  const [showTaws, setShowTaws] = useState<boolean>(() => lsGet('ft-taws', false))
  const [showCtot, setShowCtot] = useState<boolean>(() => lsGet('ft-ctot', false))
  const [showRecat, setShowRecat] = useState<boolean>(() => lsGet('ft-recat', false))
  const [showEai, setShowEai] = useState<boolean>(() => lsGet('ft-eai', false))
  const [showAdiz, setShowAdiz] = useState<boolean>(() => lsGet('ft-adiz', false))
  const [showApu, setShowApu] = useState<boolean>(() => lsGet('ft-apu', false))
  const [showPcn, setShowPcn] = useState<boolean>(() => lsGet('ft-pcn', false))
  const [showFuelImb, setShowFuelImb] = useState<boolean>(() => lsGet('ft-fuelimb', false))
  const [showCsff, setShowCsff] = useState<boolean>(() => lsGet('ft-csff', false))
  const [showFbw, setShowFbw] = useState<boolean>(() => lsGet('ft-fbw', false))
  const [showMel, setShowMel] = useState<boolean>(() => lsGet('ft-mel', false))
  const [showOil, setShowOil] = useState<boolean>(() => lsGet('ft-oil', false))
  const [showHfdl, setShowHfdl] = useState<boolean>(() => lsGet('ft-hfdl', false))
  const [showEhs, setShowEhs] = useState<boolean>(() => lsGet('ft-ehs', false))
  const [showArff, setShowArff] = useState<boolean>(() => lsGet('ft-arff', false))
  const [showSbas, setShowSbas] = useState<boolean>(() => lsGet('ft-sbas', false))
  const [showVib, setShowVib] = useState<boolean>(() => lsGet('ft-vib', false))
  const [showTrim, setShowTrim] = useState<boolean>(() => lsGet('ft-trim', false))
  const [showDme, setShowDme] = useState<boolean>(() => lsGet('ft-dme', false))
  const [showTRev, setShowTRev] = useState<boolean>(() => lsGet('ft-trev', false))
  const [showVmon, setShowVmon] = useState<boolean>(() => lsGet('ft-vmon', false))
  const [showPaxO2, setShowPaxO2] = useState<boolean>(() => lsGet('ft-paxo2', false))
  const [showUlb, setShowUlb] = useState<boolean>(() => lsGet('ft-ulb', false))
  const [showSlop, setShowSlop] = useState<boolean>(() => lsGet('ft-slop', false))
  const [showSelcal, setShowSelcal] = useState<boolean>(() => lsGet('ft-selcal', false))
  const [showAdsc, setShowAdsc] = useState<boolean>(() => lsGet('ft-adsc', false))
  const [showAirac, setShowAirac] = useState<boolean>(() => lsGet('ft-airac', false))
  const [showWow, setShowWow] = useState<boolean>(() => lsGet('ft-wow', false))
  const [showTpis, setShowTpis] = useState<boolean>(() => lsGet('ft-tpis', false))
  const [showItp, setShowItp] = useState<boolean>(() => lsGet('ft-itp', false))
  const [showAsdex, setShowAsdex] = useState<boolean>(() => lsGet('ft-asdex', false))
  const [showPsrSsr, setShowPsrSsr] = useState<boolean>(() => lsGet('ft-psrssr', false))
  const [showFireLoop, setShowFireLoop] = useState<boolean>(() => lsGet('ft-fireloop', false))
  const [showVaac, setShowVaac] = useState<boolean>(() => lsGet('ft-vaac', false))
  const [showEosid, setShowEosid] = useState<boolean>(() => lsGet('ft-eosid', false))
  const [showSteep, setShowSteep] = useState<boolean>(() => lsGet('ft-steepappr', false))
  const [showTfm, setShowTfm] = useState<boolean>(() => lsGet('ft-tfm', false))
  const [showRowRop, setShowRowRop] = useState<boolean>(() => lsGet('ft-rowrop', false))
  const [showPapi, setShowPapi] = useState<boolean>(() => lsGet('ft-papi', false))
  const [showRedispatch, setShowRedispatch] = useState<boolean>(() => lsGet('ft-redispatch', false))
  const [showOptAlt, setShowOptAlt] = useState<boolean>(() => lsGet('ft-optalt', false))
  const [showMsaw, setShowMsaw] = useState<boolean>(() => lsGet('ft-msaw', false))
  const [showPirep, setShowPirep] = useState<boolean>(() => lsGet('ft-pirep', false))
  const [showTdwr, setShowTdwr] = useState<boolean>(() => lsGet('ft-tdwr', false))
  const [showMtcd, setShowMtcd] = useState<boolean>(() => lsGet('ft-mtcd', false))
  const [showVdl2, setShowVdl2] = useState<boolean>(() => lsGet('ft-vdl2', false))
  const [showTbs, setShowTbs] = useState<boolean>(() => lsGet('ft-tbs', false))
  const [showVtf, setShowVtf] = useState<boolean>(() => lsGet('ft-vtf', false))
  const [showRfi, setShowRfi] = useState<boolean>(() => lsGet('ft-rfi', false))
  const [showMnt, setShowMnt] = useState<boolean>(() => lsGet('ft-mnt', false))
  const [showCco, setShowCco] = useState<boolean>(() => lsGet('ft-cco', false))
  const [showWat, setShowWat] = useState<boolean>(() => lsGet('ft-wat', false))
  const [showAcdm, setShowAcdm] = useState<boolean>(() => lsGet('ft-acdm', false))
  const [showAman, setShowAman] = useState<boolean>(() => lsGet('ft-aman', false))
  const [showHiro, setShowHiro] = useState<boolean>(() => lsGet('ft-hiro', false))
  const [showHspot, setShowHspot] = useState<boolean>(() => lsGet('ft-hspot', false))
  const [showLrah, setShowLrah] = useState<boolean>(() => lsGet('ft-lrah', false))
  const [showRffs, setShowRffs] = useState<boolean>(() => lsGet('ft-rffs', false))
  const [showCwy, setShowCwy] = useState<boolean>(() => lsGet('ft-cwy', false))
  const [showJblast, setShowJblast] = useState<boolean>(() => lsGet('ft-jblast', false))
  const [showMrva, setShowMrva] = useState<boolean>(() => lsGet('ft-mrva', false))
  const [showAirprox, setShowAirprox] = useState<boolean>(() => lsGet('ft-airprox', false))
  const [showMedlink, setShowMedlink] = useState<boolean>(() => lsGet('ft-medlink', false))
  const [showCirc, setShowCirc] = useState<boolean>(() => lsGet('ft-circ', false))
  const [showVmoMmo, setShowVmoMmo] = useState<boolean>(() => lsGet('ft-vmommo', false))
  const [showNemo, setShowNemo] = useState<boolean>(() => lsGet('ft-nemo', false))
  const [showRotor, setShowRotor] = useState<boolean>(() => lsGet('ft-rotor', false))
  const [showBreg, setShowBreg] = useState<boolean>(() => lsGet('ft-breg', false))
  const [showDoc, setShowDoc] = useState<boolean>(() => lsGet('ft-doc', false))
  const [showCircad, setShowCircad] = useState<boolean>(() => lsGet('ft-circad', false))
  const [showVmca, setShowVmca] = useState<boolean>(() => lsGet('ft-vmca', false))
  const [showTem, setShowTem] = useState<boolean>(() => lsGet('ft-tem', false))
  const [showCzne, setShowCzne] = useState<boolean>(() => lsGet('ft-czne', false))
  const [showCast, setShowCast] = useState<boolean>(() => lsGet('ft-cast', false))
  const [showBlkhol, setShowBlkhol] = useState<boolean>(() => lsGet('ft-blkhol', false))
  const [showGld, setShowGld] = useState<boolean>(() => lsGet('ft-gld', false))
  const [showOld, setShowOld] = useState<boolean>(() => lsGet('ft-old', false))
  const [showPrd, setShowPrd] = useState<boolean>(() => lsGet('ft-prd', false))
  const [showAltn, setShowAltn] = useState<boolean>(() => lsGet('ft-altn', false))
  const [showFlex, setShowFlex] = useState<boolean>(() => lsGet('ft-flex', false))
  const [showMelt, setShowMelt] = useState<boolean>(() => lsGet('ft-melt', false))
  const [showCrzl, setShowCrzl] = useState<boolean>(() => lsGet('ft-crzl', false))
  const [showDrftdn, setShowDrftdn] = useState<boolean>(() => lsGet('ft-drftdn', false))
  const [showTmi, setShowTmi] = useState<boolean>(() => lsGet('ft-tmi', false))
  const [showFleet, setShowFleet] = useState<boolean>(() => lsGet('ft-fleet', false))
  const [showGust, setShowGust] = useState<boolean>(() => lsGet('ft-gust', false))
  const [showEdr, setShowEdr] = useState<boolean>(() => lsGet('ft-edr', false))
  const [showNvpm, setShowNvpm] = useState<boolean>(() => lsGet('ft-nvpm', false))
  const [showSwell, setShowSwell] = useState<boolean>(() => lsGet('ft-swell', false))
  const [showWxad, setShowWxad] = useState<boolean>(() => lsGet('ft-wxad', false))
  const [showVfe, setShowVfe] = useState<boolean>(() => lsGet('ft-vfe', false))
  const [showDecrab, setShowDecrab] = useState<boolean>(() => lsGet('ft-decrab', false))
  const [showRtow, setShowRtow] = useState<boolean>(() => lsGet('ft-rtow', false))
  const [showTropo, setShowTropo] = useState<boolean>(() => lsGet('ft-tropo', false))
  const [showWafs, setShowWafs] = useState<boolean>(() => lsGet('ft-wafs', false))
  const [showAcasx, setShowAcasx] = useState<boolean>(() => lsGet('ft-acasx', false))
  const [showVrp, setShowVrp] = useState<boolean>(() => lsGet('ft-vrp', false))
  const [showPms, setShowPms] = useState<boolean>(() => lsGet('ft-pms', false))
  const [showFra, setShowFra] = useState<boolean>(() => lsGet('ft-fra', false))
  const [showCdr, setShowCdr] = useState<boolean>(() => lsGet('ft-cdr', false))
  const [showStca, setShowStca] = useState<boolean>(() => lsGet('ft-stca', false))
  const [showDcb, setShowDcb] = useState<boolean>(() => lsGet('ft-dcb', false))
  const [showRwsl, setShowRwsl] = useState<boolean>(() => lsGet('ft-rwsl', false))
  const [showAltm, setShowAltm] = useState<boolean>(() => lsGet('ft-altm', false))
  const [showHold, setShowHold] = useState<boolean>(() => lsGet('ft-hold', false))
  const [showFim, setShowFim] = useState<boolean>(() => lsGet('ft-fim', false))
  const [showClam, setShowClam] = useState<boolean>(() => lsGet('ft-clam', false))
  const [showCsc, setShowCsc] = useState<boolean>(() => lsGet('ft-csc', false))
  const [showSigmet, setShowSigmet] = useState<boolean>(() => lsGet('ft-sigmet', false))
  const [showLahso, setShowLahso] = useState<boolean>(() => lsGet('ft-lahso', false))
  const [showMora, setShowMora] = useState<boolean>(() => lsGet('ft-mora', false))
  const [showStar, setShowStar] = useState<boolean>(() => lsGet('ft-star', false))
  const [showDatis, setShowDatis] = useState<boolean>(() => lsGet('ft-datis', false))
  const [showVolmet, setShowVolmet] = useState<boolean>(() => lsGet('ft-volmet', false))
  const [showStart, setShowStart] = useState<boolean>(() => lsGet('ft-start', false))
  const [showO2dur, setShowO2dur] = useState<boolean>(() => lsGet('ft-o2dur', false))
  const [showCtac, setShowCtac] = useState<boolean>(() => lsGet('ft-ctac', false))
  const [showCcm, setShowCcm] = useState<boolean>(() => lsGet('ft-ccm', false))
  const [showTasar, setShowTasar] = useState<boolean>(() => lsGet('ft-tasar', false))
  const [showTcam, setShowTcam] = useState<boolean>(() => lsGet('ft-tcam', false))
  const [showTurn, setShowTurn] = useState<boolean>(() => lsGet('ft-turn', false))
  const [showDgs, setShowDgs] = useState<boolean>(() => lsGet('ft-dgs', false))
  const [showOls, setShowOls] = useState<boolean>(() => lsGet('ft-ols', false))
  const [showDaaWc, setShowDaaWc] = useState<boolean>(() => lsGet('ft-daawc', false))
  const [showElec, setShowElec] = useState<boolean>(() => lsGet('ft-elec', false))
  const [showNgs, setShowNgs] = useState<boolean>(() => lsGet('ft-ngs', false))
  const [showGadss, setShowGadss] = useState<boolean>(() => lsGet('ft-gadss', false))
  const [showEfvs, setShowEfvs] = useState<boolean>(() => lsGet('ft-efvs', false))
  const [showIrs, setShowIrs] = useState<boolean>(() => lsGet('ft-irs', false))
  const [showRcam, setShowRcam] = useState<boolean>(() => lsGet('ft-rcam', false))
  const [showMlat, setShowMlat] = useState<boolean>(() => lsGet('ft-mlat', false))
  const [showPbcs, setShowPbcs] = useState<boolean>(() => lsGet('ft-pbcs', false))
  const [showTanker, setShowTanker] = useState<boolean>(() => lsGet('ft-tanker', false))
  const [showSidc, setShowSidc] = useState<boolean>(() => lsGet('ft-sidc', false))
  const [showRvsm, setShowRvsm] = useState<boolean>(() => lsGet('ft-rvsm', false))
  const [showSpdLim, setShowSpdLim] = useState<boolean>(() => lsGet('ft-spdlim', false))
  const [showBoom, setShowBoom] = useState<boolean>(() => lsGet('ft-boom', false))
  const [showRnp, setShowRnp] = useState<boolean>(() => lsGet('ft-rnp', false))
  const [showSaar, setShowSaar] = useState<boolean>(() => lsGet('ft-saar', false))
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
  const activeLayerCount = [showHeat,chase,showWatch,showStats,showRadar,showEmissions,showConflict,showOverhead,showSun,showHolding,showFormation,showCpa,showDiversion,showVProfile,showTcas,showWake,showContrail,showAtlas,showVip,showFlow,showRecords,showShadow,showDoppler,showAprSeq,showPass,showNoise,showTod,showTripwire,showGeofence,showVoronoi,showSunGlare,showAnomaly,showGlide,showCoffin,showCompareStudio,showSymphony,showTimeMachine,showReach,showTrip,showEventLog,showLadder,showPhase,showCockpit,showRuler,showBullseye,showWinds,showBoard,showScatter,showSquawk,showRace,showDensity,showRoute,showSua,showShear,showCosmic,showHypoxia,showStepClimb,showEtops,showDepSeq,showXwind,showJet,showHstack,showIcing,showCurfew,showMtnWave,showBird,showAsh,showRaim,showOcean,showE6b,showMetar,showCells,showSar,showStable,showFir,showFirX,showRwyCfg,showEnergy].filter(Boolean).length + (showCostIdx?1:0) + (showTaf?1:0) + (showToc?1:0) + (showCabin?1:0) + (showApMin?1:0) + (showFuelTemp?1:0) + (showNavaid?1:0) + (showDrift?1:0) + (showReserve?1:0) + (showTurb?1:0) + (showCrew?1:0) + (showNordo?1:0) + (showTerrain?1:0) + (showMass?1:0) + (showMagVar?1:0) + (showCda?1:0) + (showSidc?1:0) + (showRvsm?1:0) + (showSpdLim?1:0) + (showBoom?1:0) + (showRnp?1:0) + (showSaar?1:0) + (showTank?1:0) + (showWkld?1:0) + (showGnss?1:0) + (showCpdlc?1:0) + (showLbust?1:0) + (showOzone?1:0) + (showAdsbq?1:0) + (showEtp?1:0) + (showRta?1:0) + (showSatcom?1:0) + (showBrake?1:0) + (showMapp?1:0) + (showVhf?1:0) + (showSpwx?1:0) + (showFoqa?1:0) + (showEgt?1:0) + (showPolar?1:0) + (showLibat?1:0) + (showRexhyd?1:0) + (showCgTrim?1:0) + (showOwl?1:0) + (showNadp?1:0) + (showRecat?1:0) + (showUas?1:0) + (showBleed?1:0) + (showDeice?1:0) + (showPstatic?1:0) + (showFlutter?1:0) + (showStall?1:0) + (showTailStrike?1:0) + (showTaws?1:0) + (showCtot?1:0) + (showRera?1:0) + (showEai?1:0) + (showTold?1:0) + (showRelight?1:0) + (showHotsec?1:0) + (showLhirf?1:0) + (showAdiz?1:0) + (showEgress?1:0) + (showNotam?1:0) + (showRadalt5g?1:0) + (showCtAlt?1:0) + (showHyd?1:0) + (showApu?1:0) + (showPcn?1:0) + (showFuelImb?1:0) + (showCsff?1:0) + (showCargoFs?1:0) + (showFbw?1:0) + (showMel?1:0) + (showOil?1:0) + (showVib?1:0) + (showNgs?1:0) + (showAutoland?1:0) + (showGadss?1:0) + (showEfvs?1:0) + (showIrs?1:0) + (showRcam?1:0) + (showMlat?1:0) + (showPbcs?1:0) + (showTanker?1:0) + (showVapp?1:0) + (showGls?1:0) + (showSaf?1:0) + (showHfdl?1:0) + (showArff?1:0) + (showIlsCs?1:0) + (showTrim?1:0) + (showDme?1:0) + (showTRev?1:0) + (showPaxO2?1:0) + (showUlb?1:0) + (showSlop?1:0) + (showSelcal?1:0) + (showAdsc?1:0) + (showAirac?1:0) + (showVolmet?1:0) + (showStart?1:0) + (showWow?1:0) + (showItp?1:0) + (showAsdex?1:0) + (showPsrSsr?1:0) + (showFireLoop?1:0) + (showTpis?1:0) + (showVaac?1:0) + (showEosid?1:0) + (showTfm?1:0) + (showRowRop?1:0) + (showPapi?1:0) + (showSteep?1:0) + (showRedispatch?1:0) + (showOptAlt?1:0) + (showMsaw?1:0) + (showPirep?1:0) + (showSigmet?1:0) + (showVdl2?1:0) + (showTbs?1:0) + (showRfi?1:0) + (showMnt?1:0) + (showCco?1:0) + (showWat?1:0) + (showAcdm?1:0) + (showAman?1:0) + (showHiro?1:0) + (showFim?1:0) + (showClam?1:0) + (showCast?1:0) + (showBlkhol?1:0) + (showGld?1:0) + (showCrzl?1:0) + (showDrftdn?1:0) + (showTmi?1:0) + (showFleet?1:0) + (showGust?1:0) + (showEdr?1:0) + (showNvpm?1:0) + (showRtow?1:0) + (showTropo?1:0) + (showWafs?1:0) + (showSwell?1:0) + (showWxad?1:0) + (showVfe?1:0) + (showDecrab?1:0)
  + (showLahso?1:0) + (showAcasx?1:0)
  + (showMora?1:0)
  + (showStar?1:0)
  + (showSbas?1:0)
  + (showElec?1:0)
  + (showVmon?1:0)
  + (showEhs?1:0)
  + (showPrm?1:0)
  + (showO2dur?1:0)
  + (showCtac?1:0)
  + (showCcm?1:0)
  + (showTasar?1:0)
  + (showTcam?1:0)
  + (showTurn?1:0)
  + (showDgs?1:0)
  + (showOls?1:0)
  + (showDaaWc?1:0)
  + (showHspot?1:0)
  + (showLrah?1:0)
  + (showRffs?1:0)
  + (showCwy?1:0)
  + (showJblast?1:0)
  + (showMrva?1:0) + (showAirprox?1:0) + (showMedlink?1:0) + (showCirc?1:0) + (showVmoMmo?1:0) + (showNemo?1:0) + (showRotor?1:0) + (showBreg?1:0) + (showCzne?1:0) + (showOld?1:0)
  + (showMrva?1:0) + (showAirprox?1:0) + (showMedlink?1:0) + (showCirc?1:0) + (showVmoMmo?1:0) + (showNemo?1:0) + (showRotor?1:0) + (showBreg?1:0) + (showCzne?1:0) + (showDoc?1:0) + (showPrd?1:0) + (showAltn?1:0) + (showFlex?1:0) + (showCircad?1:0) + (showMelt?1:0) + (showVmca?1:0) + (showTem?1:0)
  + (showVrp?1:0)
  + (showDatis?1:0)
  + (showTdwr?1:0)
  + (showMtcd?1:0) + (showPms?1:0) + (showFra?1:0) + (showCdr?1:0) + (showStca?1:0) + (showDcb?1:0) + (showRwsl?1:0) + (showAltm?1:0) + (showHold?1:0)
  + (showVdl2?1:0)
  + (showTbs?1:0)
  + (showVtf?1:0) + (showCsc?1:0)
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
          { id: 'toggle-acasx', group: 'View', label: showAcasx ? 'Close ACAS-Xa monitor' : 'ACAS-Xa collision-avoidance monitor (DO-385)', run: () => { const nv = !showAcasx; setShowAcasx(nv); lsSet('ft-acasx', nv) }, keywords: ['acas', 'acas-x', 'acasx', 'do-385', 'do-386', 'tso-c219', 'ed-256', 'collision', 'avoidance', 'ra', 'ta', 'cpa', 'nmac', 'ueberlingen', 'tcas-replacement'] },
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
          { id: 'toggle-hyd', group: 'View', label: showHyd ? 'Close Hydraulic Redundancy & Loss Monitor' : 'Hydraulic Redundancy · 3-System Loss · RAT / PTU / Function-Loss (14 CFR 25.1309 / ARP4761 / FCOM 13.20 / UAL232)', run: () => { const nv = !showHyd; setShowHyd(nv); lsSet('ft-hyd', nv) }, keywords: ['hydraulic', 'hydraulics', 'rat', 'ram air turbine', 'ptu', 'power transfer unit', 'green', 'blue', 'yellow', 'left', 'center', 'right', 'sys 1', 'sys 2', 'pc-1', 'pc-2', 'redundancy', 'ual232', 'sioux city', 'qantas qf32', '14 cfr 25.1309', 'arp4761', 'fcom 13.20', 'leak', 'reservoir', 'edp', 'acmp', 'alternate gear', 'manual reversion', 'accumulator brakes', 'autoland', 'flight controls'] },
          { id: 'toggle-egress', group: 'View', label: showEgress ? 'Close Cabin Egress / 90-Sec Evacuation Compliance Monitor' : 'Cabin Egress · 90-Sec Evacuation Compliance · Exits / Load / Crew / ELS (14 CFR 25.803 / AC 25.803-1A / ARP 4101)', run: () => { const nv = !showEgress; setShowEgress(nv); lsSet('ft-egress', nv) }, keywords: ['egress', 'evacuation', '90 second', '90s', 'cabin safety', 'far 25.803', 'ac 25.803-1a', 'cs-25.803', '25.807', '121.391', 'emergency exit', 'type-a', 'type-iii', 'overwing', 'flight attendant', 'cabin crew', 'els', 'emergency lighting', 'arp 4101', 'slide raft', 'survivable', 'pax load', 'mel', 'cabin'] },
          { id: 'toggle-notam', group: 'View', label: showNotam ? 'Close NOTAM / TFR Compliance Monitor' : 'NOTAM / TFR Active-Restriction Compliance · Presidential / Stadium / Space-launch / GPS-test / VIP / Prohibited / MOA / Warning / Disaster (ICAO Annex 15 · FAA JO 7930.2R · 14 CFR 91.137/138/141/143/145 · 14 CFR 99 · 14 CFR 73 · AC 91-63D)', run: () => { const nv = !showNotam; setShowNotam(nv); lsSet('ft-notam', nv) }, keywords: ['notam', 'tfr', 'temporary flight restriction', 'presidential', 'stadium', 'space launch', 'spacex', 'starbase', 'gps test', 'gps jamming', 'vip', 'prohibited', 'p-40', 'p-56', 'moa', 'military operating area', 'warning area', 'disaster', 'wildfire', '91.137', '91.141', '91.143', '91.145', '14 cfr 99', '14 cfr 73', 'icao annex 15', 'jo 7930', 'ac 91-63d', 'waiver', 'fdc', 'incursion'] },
          { id: 'toggle-radalt5g', group: 'View', label: showRadalt5g ? 'Close 5G C-Band / Radio-Altimeter Interference Monitor' : '5G C-Band / Radio-Altimeter Interference & AMOC Compliance · Verizon / AT&T / T-Mobile / DT / KDDI / SK · 3.45-4.0 GHz vs 4.2-4.4 GHz radalt (FAA AD 2021-23-12 · AD 2023-10-02 · SAIB AIR-21-18 · RTCA DO-401 · ITU-R M.2059 · EASA SIB 2022-02R3)', run: () => { const nv = !showRadalt5g; setShowRadalt5g(nv); lsSet('ft-radalt5g', nv) }, keywords: ['5g', 'c-band', 'c band', 'radalt', 'radio altimeter', 'radar altimeter', 'amoc', 'verizon', 'att', 'at&t', 't-mobile', 'tmobile', 'kddi', 'sk telecom', 'deutsche telekom', 'autoland', 'cat ii', 'cat iii', 'autoland category', 'ad 2021-23-12', 'ad 2023-10-02', 'saib air-21-18', 'rtca do-401', 'itu-r m.2059', 'easa sib 2022-02', 'fcc auction 107', '3.7 ghz', '3.98 ghz', '4.2 ghz', 'guard band', 'psd', 'interference', 'safo 21007', 'safo 22002'] },
          { id: 'toggle-ctalt', group: 'View', label: showCtAlt ? 'Close Cold-Temp Altimetry Correction Monitor' : 'Cold-Temperature Altimetry (CTA) Correction Monitor · ΔH cold-temp altitude error at restricted airports (ICAO Doc 8168 §III.4.1.1 · FAA AC 91-79B App 1 · FAA Order 7900.5C · TC AIM RAC 9.17 · NTSB AAR-79-7 Cranbrook YXC)', run: () => { const nv = !showCtAlt; setShowCtAlt(nv); lsSet('ft-ctalt', nv) }, keywords: ['cold temperature', 'cold temp', 'altimetry', 'altimeter', 'correction', 'cta', 'restricted airport', 'icao doc 8168', 'pans ops', 'isa deviation', 'doc 7488', 'ac 91-79b', 'faa order 7900', '14 cfr 97.20', 'tc aim rac 9.17', 'cranbrook', 'yxc', 'cfit', 'mda', 'da', 'minimums', 'segment minimum altitude', 'qnh', 'true height', 'eagle', 'aspen', 'jackson hole', 'innsbruck', 'edmonton', 'calgary', 'iqaluit', 'fairbanks', 'sapporo', 'pressure altitude', 'temperature error', 'cold soaked'] },
          { id: 'toggle-cargofs', group: 'View', label: showCargoFs ? 'Close Cargo Fire Suppression / DTLD Monitor' : 'Cargo Fire Suppression Endurance & Diversion-Time Limited Dispatch (14 CFR 25.857 / 25.858 / 121.1119 · FAA AC 25-9A · AC 120-42B · AC 120-80B · NFPA 12A halon-1301)', run: () => { const nv = !showCargoFs; setShowCargoFs(nv); lsSet('ft-cargofs', nv) }, keywords: ['cargo fire', 'fire suppression', 'halon', 'halon-1301', 'halon-1211', 'dtld', 'diversion time', 'time limited system', 'tls', 'etops', 'cargo class', 'class c', 'class d', '14 cfr 25.857', '25.858', '121.1119', 'ac 25-9a', 'ac 120-42b', 'ac 120-80b', 'nfpa 12a', 'kidde', 'fire bottle', 'extinguisher', 'smoke detector', 'driftdown', 'oei', 'diversion airport', 'ups 6', 'valujet', 'air canada 797', 'in-flight fire'] },
          { id: 'toggle-autoland', group: 'View', label: showAutoland ? 'Close CAT-II/III Autoland LVO Compliance Monitor' : 'CAT-II / CAT-III Autoland Fail-Operational Capability & LVO Compliance · Channel status / RVR / ceiling / crosswind / lighting (FAA AC 120-29A · AC 120-28D · AC 120-118 · 14 CFR 121.651 · ICAO Doc 9365 · EASA AMC1 CAT.OP.MPA.110 · Boeing FCOM 9.20 SP.16 · Airbus PRO-NOR-SOP-15)', run: () => { const nv = !showAutoland; setShowAutoland(nv); lsSet('ft-autoland', nv) }, keywords: ['autoland', 'lvo', 'low visibility', 'low vis', 'cat i', 'cat ii', 'cat iii', 'cat iiia', 'cat iiib', 'cat iiic', 'category iii', 'fail operational', 'fail passive', 'rvr', 'runway visual range', 'ceiling', 'decision height', 'dh', 'dual channel', 'autopilot', 'alsf-ii', 'hials', 'malsr', 'centreline lights', 'tdzl', 'crosswind', 'autoland limit', 'ac 120-29a', 'ac 120-28d', 'ac 120-118', '121.651', '91.175', '121.349', 'icao doc 9365', 'amc1 cat.op.mpa.110', 'sp.16', 'pro-nor-sop-15', 'all weather', 'smartlanding', 'smartrunway'] },
          { id: 'toggle-hotsec', group: 'View', label: showHotsec ? 'Close Hot-Section LCF / Engine Shop-Visit Predictor' : 'Hot-Section LCF · EGT Margin Erosion · LCF Cycles · Shop-Visit Predictor (14 CFR 33.70 / AC 33.70-1 / CS-E 515)', run: () => { const nv = !showHotsec; setShowHotsec(nv); lsSet('ft-hotsec', nv) }, keywords: ['hot section', 'lcf', 'low cycle fatigue', 'ellp', 'shop visit', 'tbsv', 'egt margin', 'engine life', 'derate', 'severity', 'genx', 'cfm56', 'leap', 'trent', 'cf6', 'pw1100g', 'borescope', '33.70', 'ac 33.70-1', 'cs-e 515', 'msg-3', 'arp 5757'] },
          { id: 'toggle-lhirf', group: 'View', label: showLhirf ? 'Close Lightning Strike Zone / HIRF Monitor' : 'Lightning Strike Zone · HIRF Compliance (SAE ARP 5414B / DO-160G §22-23 / AC 20-136B / 25.954)', run: () => { const nv = !showLhirf; setShowLhirf(nv); lsSet('ft-lhirf', nv) }, keywords: ['lightning', 'strike', 'zone', 'arp 5414', 'arp 5412', 'hirf', 'high intensity radiated fields', 'ac 20-136b', 'do-160', 'do-160g', 'lit', 'lightning induced transient', '25.954', 'fuel system', 'bonding', 'cmr', 'static discharger', 'plumer'] },
          { id: 'toggle-taws', group: 'View', label: showTaws ? 'Close EGPWS / TAWS Mode 1-7 Predictor' : 'EGPWS / TAWS Mode 1-7 Alert Predictor (DO-161A / DO-367 / TSO-C151d / Honeywell MK-V/VII/VIII)', run: () => { const nv = !showTaws; setShowTaws(nv); lsSet('ft-taws', nv) }, keywords: ['taws', 'egpws', 'gpws', 'terrain', 'pull up', 'pullup', 'sink rate', 'mode 1', 'mode 2', 'mode 3', 'mode 4', 'mode 5', 'mode 6', 'mode 7', 'windshear', 'glideslope', 'too low terrain', 'too low gear', 'too low flaps', "don't sink", 'dont sink', 'bank angle', 'minimums', 'rad alt', 'radalt', 'cfit', 'controlled flight into terrain', 'honeywell', 'mk-v', 'mk-vii', 'mk-viii', 'do-161a', 'do-367', 'tso-c151', 'tcf', 'terrain clearance floor', 'look-ahead', 'forward looking windshear'] },
          { id: 'toggle-ctot', group: 'View', label: showCtot ? 'Close CTOT / ATFM Slot Monitor' : 'CTOT / ATFM Slot Compliance (EUROCONTROL CFMU / FAA EDCT / slot adherence)', run: () => { const nv = !showCtot; setShowCtot(nv); lsSet('ft-ctot', nv) }, keywords: ['ctot', 'atfm', 'cfmu', 'eurocontrol', 'edct', 'slot', 'departure slot', 'flow management', 'regulation', 'ground stop', 'expect departure clearance', 'sip slot', 'atfcm', 'network manager', 'nm', 'slot adherence'] },
          { id: 'toggle-recat', group: 'View', label: showRecat ? 'Close RECAT-EU Wake Separation Monitor' : 'RECAT-EU Pairwise Wake Vortex Separation Monitor (ICAO Doc 9426 / EUROCONTROL RECAT 6-cat matrix)', run: () => { const nv = !showRecat; setShowRecat(nv); lsSet('ft-recat', nv) }, keywords: ['recat', 'wake', 'vortex', 'separation', 'eurocontrol', 'icao doc 9426', 'faa jo 7110.659', 'pairwise', 'leader follower', 'cat-a', 'cat-b', 'cat-c', 'cat-d', 'cat-e', 'cat-f', 'super heavy', 'a380', 'b777'] },
          { id: 'toggle-eai', group: 'View', label: showEai ? 'Close Engine Anti-Ice Penalty Monitor' : 'Engine Anti-Ice (EAI) / Cowl Heat Penalty Monitor (FAA AC 20-73A / AC 91-74B / 14 CFR 25 App C+O bleed-extraction N1/SFC/climb-gradient/EGT-rise stack)', run: () => { const nv = !showEai; setShowEai(nv); lsSet('ft-eai', nv) }, keywords: ['eai', 'anti-ice', 'cowl heat', 'engine anti-ice', 'bleed', 'app c', 'app o', 'sld', 'supercooled', 'tat', 'sat', 'ac 20-73a', 'ac 91-74b', 'cs-25.1419', 'n1 penalty', 'climb gradient', 'sfc'] },
          { id: 'toggle-adiz', group: 'View', label: showAdiz ? 'Close ADIZ Penetration Monitor' : 'ADIZ Penetration & Intercept-Risk Monitor (ICAO Annex 15 / FAA JO 7610.4 / 14 CFR 99 / NORAD CONR-CANR / JADIZ / KADIZ / ECS-ADIZ 24-zone QRA-risk scoring)', run: () => { const nv = !showAdiz; setShowAdiz(nv); lsSet('ft-adiz', nv) }, keywords: ['adiz', 'air defense', 'intercept', 'qra', 'norad', 'jadiz', 'kadiz', 'ecs', 'taiwan', 'cadiz', 'fir security', '14 cfr 99', 'icao annex 15', 'dvfr', 'transponder', 'mode 3a', 'incursion'] },
          { id: 'toggle-apu', group: 'View', label: showApu ? 'Close APU Health / ETOPS-CR Monitor' : 'APU Health & ETOPS Continuous-Running Capability Monitor · EGT margin / oil / start reliability / MEL APU-INOP vs ETOPS authority (14 CFR 121.633 · FAA AC 120-42B · AC 25-19A · EASA AMC 20-6 · Honeywell 131-9 · APS5000)', run: () => { const nv = !showApu; setShowApu(nv); lsSet('ft-apu', nv) }, keywords: ['apu', 'auxiliary power unit', 'etops', 'edto', 'continuous running', 'cr', 'honeywell', '131-9', 'aps5000', 'aps3200', 'egt margin', 'oil pressure', 'inop', 'mel', '14 cfr 121.633', 'ac 120-42b', 'ac 25-19a', 'amc 20-6', 'annex 6', 'in-flight start', 'pneumatic bleed'] },
          { id: 'toggle-pcn', group: 'View', label: showPcn ? 'Close PCN / ACR Pavement Bearing-Strength Monitor' : 'PCN / ACR Pavement Bearing-Strength Compliance Monitor · ACN vs PCN ratio / tire-pressure category / gear-config / subgrade / overload-frequency per ICAO Annex 14 · Doc 9157 Pt 3 · FAA AC 150/5335-5C · ACR-PCR 2024', run: () => { const nv = !showPcn; setShowPcn(nv); lsSet('ft-pcn', nv) }, keywords: ['pcn', 'acn', 'acr', 'pcr', 'pavement', 'bearing strength', 'subgrade', 'tire pressure', 'gear config', 'overload', 'icao annex 14', 'doc 9157', 'ac 150/5335-5c', 'eb 109', 'rigid', 'flexible', 'concrete', 'asphalt'] },
          { id: 'toggle-fuelimb', group: 'View', label: showFuelImb ? 'Close Fuel Tank Lateral Imbalance Monitor' : 'Fuel Tank Lateral Imbalance & Asymmetric Roll-Trim Monitor · L/R wing-tank quantity / FCOM imbalance limit / cross-feed valve state / aileron-trim demand / leak detection / TTL per 14 CFR 25.959 · 25.979 · Boeing FCOM 12.20 · Airbus PRO-ABN-28 · QRH FUEL IMBALANCE', run: () => { const nv = !showFuelImb; setShowFuelImb(nv); lsSet('ft-fuelimb', nv) }, keywords: ['fuel', 'imbalance', 'asymmetry', 'tank', 'wing', 'crossfeed', 'cross-feed', 'leak', 'trim', 'aileron', 'rudder', 'qrh', 'fcom', '25.959', '25.979', 'fqis', 'roll', 'lateral cg'] },
          { id: 'toggle-csff', group: 'View', label: showCsff ? 'Close CSFF Cold-Soak Frost Predictor' : 'Cold-Soaked Fuel Frost (CSFF) Wing Underside Frost Predictor · cruise fuel-skin soak / descent warm-up / dest OAT-dewpoint margin / centre-tank-empty / paint absorptivity / 14 CFR 121.629(b) Clean Aircraft · FAA SAFO 06014 · AC 120-58 · TC AC 700-005 · Boeing FCOM SP.16', run: () => { const nv = !showCsff; setShowCsff(nv); lsSet('ft-csff', nv) }, keywords: ['csff', 'cold-soaked fuel frost', 'cold soak', 'frost', 'wing frost', 'underwing', 'clean aircraft', 'deice', 'de-ice', 'dewpoint', 'fuel skin', 'safo 06014', 'ac 120-58', 'ac 700-005', '121.629', 'sp.16', 'air florida 90', 'arp4737', 'tactile check'] },
          { id: 'toggle-fbw', group: 'View', label: showFbw ? 'Close FBW Law Reversion Monitor' : 'Fly-By-Wire Control Law Reversion & Protection-Loss Monitor · Airbus NORMAL/ALT-1/ALT-2/DIRECT/MECH · Boeing NORMAL/SECONDARY/DIRECT · ADIRU disagreement / EFCS channel health / probe faults / lost protections per 14 CFR 25.671 · 25.672 · 25.1329 · Airbus FCOM DSC-27 PRO-ABN-27 · Boeing FCOM 9.20', run: () => { const nv = !showFbw; setShowFbw(nv); lsSet('ft-fbw', nv) }, keywords: ['fbw', 'fly-by-wire', 'law', 'reversion', 'direct', 'alternate', 'alt-1', 'alt-2', 'mech', 'mechanical', 'normal', 'secondary', 'adiru', 'efcs', 'pfc', 'protections', 'envelope', 'high-aoa', 'autotrim', 'pitot', 'airbus', 'boeing', 'embraer', 'gulfstream', '25.671', '25.672', 'fcom', 'dsc-27', 'pro-abn-27'] },
          { id: 'toggle-mel', group: 'View', label: showMel ? 'Close MEL / CDL Dispatch Monitor' : 'MEL / CDL Dispatch Deferral & Compliance Monitor · open ATA-coded deferred items per airframe / category A-B-C-D interval tracking (1d / 3d / 10d / 120d) / dispatch restrictions imposed (NO-ETOPS · NO-CAT-III · NO-RVSM · NO-RNP · SINGLE-ENG-TAXI) / aero perf penalty / interval-breach risk per 14 CFR 91.213 · 121.628 · EASA Part-MEL · MMEL PL-25/110 · FAA AC 120-77', run: () => { const nv = !showMel; setShowMel(nv); lsSet('ft-mel', nv) }, keywords: ['mel', 'cdl', 'minimum equipment', 'configuration deviation', 'deferral', 'dispatch', 'ata chapter', 'category a', 'category b', 'category c', 'category d', 'mmel', 'no etops', 'no cat iii', 'rvsm', 'rnp', 'inop', 'inoperative', 'placard', 'm-procedure', 'o-procedure', '91.213', '121.628', 'part-mel', 'ac 120-77', 'poi extension', 'pl-25', 'pl-110'] },
          { id: 'toggle-oil', group: 'View', label: showOil ? 'Close Oil Consumption / IFSD-Risk Monitor' : 'Engine Oil Consumption & IFSD-Risk Monitor (ATA-79) · per-engine oil qty / consumption rate qt/h / oil temp / oil press / filter-bypass / time-to-min-qty vs ETOPS authority per 14 CFR 25.1019 · 25.1305 · 33.39 · 121.374 ETOPS ECM · AC 120-42B App 2 · Boeing FCOM 7.30 · Airbus PRO-NOR-SOP-23', run: () => { const nv = !showOil; setShowOil(nv); lsSet('ft-oil', nv) }, keywords: ['oil', 'consumption', 'ifsd', 'in-flight shutdown', 'ata-79', 'ata 79', 'oil pressure', 'oil temp', 'oil quantity', 'engine', 'ecm', 'engine condition monitoring', 'etops', 'ac 120-42b', '25.1019', '33.39', '121.374', 'filter bypass', 'fcom 7.30', 'cfm56', 'leap', 'genx', 'trent', 'gtf', 'pw1100g', 'oil-loss'] },
          { id: 'toggle-hfdl', group: 'View', label: showHfdl ? 'Close HFDL Polar Coverage Monitor' : 'HFDL (HF Datalink) Polar / Oceanic Coverage & Slot-Util Monitor · ARINC 635 / EUROCAE ED-92 / 14-station Collins network (RKV/RHD/MOL/AKL/KRY/KSD/SNN/HTY/ALB/SCZ/JNB/GUM/BRW/CYI) · groundwave + skywave reach per HF-SSN solar / K-index geomagnetic / PCA polar-cap absorption ITU-R P.531-15 · SNR / BER / 32-slot TDMA utilization · ICAO Annex 10 Vol III ch 11 · Doc 9896 ATN/IPS · Doc 10037 GOLD · NAT OPS Bulletin 2015-001 PBCS · MIL-STD-188-110B', run: () => { const nv = !showHfdl; setShowHfdl(nv); lsSet('ft-hfdl', nv) }, keywords: ['hfdl', 'hf datalink', 'hf data link', 'arinc 635', 'ed-92', 'polar', 'oceanic', 'collins', 'rockwell', 'sky wave', 'ground wave', 'ionosphere', 'pca', 'polar cap absorption', 'k-index', 'sunspot', 'ssn', 'muf', 'snr', 'ber', 'tdma', 'slot', 'acars', 'long range datalink', 'nat', 'nordo', 'gold', 'doc 10037', 'annex 10', 'reykjavik', 'shannon', 'barrow', 'krasnoyarsk', 'auckland', 'guam'] },
          { id: 'toggle-sbas', group: 'View', label: showSbas ? 'Close SBAS / LPV Approach Monitor' : 'SBAS / LPV Approach Availability & Service-Volume Monitor · TSO-C145d / C146d receiver class vs published LPV-200 / LPV / LNAV-VNAV / LP procedure · 8 SBAS providers WAAS / EGNOS / MSAS / GAGAN / SDCM / KASS / BDSBAS service-volume coverage · HPL/VPL vs HAL/VAL alert limits · ICAO Annex 10 Vol I §3.7.3 · Doc 9849 GNSS Manual · RTCA DO-229E · FAA AC 90-107 · AC 20-138D · Order 8260.54A · EASA AMC 20-28', run: () => { const nv = !showSbas; setShowSbas(nv); lsSet('ft-sbas', nv) }, keywords: ['sbas', 'lpv', 'lpv-200', 'lnav-vnav', 'lp', 'waas', 'egnos', 'msas', 'gagan', 'sdcm', 'kass', 'bdsbas', 'wide area augmentation', 'satellite based augmentation', 'tso-c145', 'tso-c146', 'do-229', 'hpl', 'vpl', 'hal', 'val', 'protection level', 'alert limit', 'rnp apch', 'baro-vnav', 'ionosphere', 'kp index', 'annex 10', 'doc 9849', 'ac 90-107', 'amc 20-28', 'order 8260.54'] },
          { id: 'toggle-ehs', group: 'View', label: showEhs ? 'Close EHS / ELS Mode-S BDS Monitor' : 'EHS / ELS · Mode-S Enhanced & Elementary Surveillance BDS Register Decode-Quality & Mandate Compliance Monitor · per-airframe transponder generation (DO-181E Ed.4 / Ed.3 / Ed.2) · ELS registers BDS 1,0 / 1,7 / 2,0 / 3,0 · EHS registers BDS 4,0 selected vertical intent / 5,0 track & turn / 6,0 heading & speed · 32 SSR Mode-S interrogator stations (FAA STARS · EUROCONTROL THALES STAR-NG / DFS ASR-S · ASIA-PAC TOSHIBA / INDRA · NAV CANADA Selex ATM-S) · II/SI subnet coordination · radar horizon 1.23·√h · Friis 1090 MHz SNR · per-register decode-fail % · EU Reg 1207/2011 + 1028/2014 SPI mandate compliance · ICAO Annex 10 Vol IV / Doc 9871 / RTCA DO-181E / EUROCAE ED-73E / FAA AC 90-114B', run: () => { const nv = !showEhs; setShowEhs(nv); lsSet('ft-ehs', nv) }, keywords: ['ehs', 'els', 'mode-s', 'mode s', 'bds', 'bds 4,0', 'bds 5,0', 'bds 6,0', 'enhanced surveillance', 'elementary surveillance', 'transponder', 'xpdr', 'do-181', 'do-181e', 'gicb', 'ssr', 'secondary radar', 'reg 1207/2011', 'spi', 'mandate', 'annex 10', 'doc 9871', 'eurocae', 'ed-73e', 'thales star-ng', 'asr-s', 'stars', 'selex', 'indra', 'interrogator', 'ii code', 'si code', '1090 mhz', 'df17', 'decode'] },          { id: 'toggle-arff', group: 'View', label: showArff ? 'Close ARFF / RFFS Annex 14 Cat Monitor' : 'ARFF / RFFS Aerodrome Rescue & Fire Fighting Category Compliance Monitor · ICAO Annex 14 Vol I §9.2 Table 9-1 cat 1-10 per fuselage L×Wf · Doc 9137 Pt 1 ch 2 Q₁ water + foam concentrate calculation · response time T₁ ≤180s / ≤120s Cat 7+ · 14 CFR 139.315/.317/.319 ARFF index · FAA AC 150/5210-6D / 7D / 25 · EASA ADR.OPS.B.010 · UK CAP 168 ch 8 · NFPA 403 / 414 · 56-airport catalogue ATL ORD LHR AMS HND DXB SIN HKG PEK FRA CDG ATX SDF · per-airframe required category vs published with low-traffic remission · vehicle/agent/T1 drivers', run: () => { const nv = !showArff; setShowArff(nv); lsSet('ft-arff', nv) }, keywords: ['arff', 'rffs', 'rescue', 'fire fighting', 'annex 14', 'doc 9137', 'cfr 139', 'cat 10', 'foam', 'afff', 'water', 'agent', 'q1', 'q2', 't1', 'response time', 'nfpa 403', 'aerodrome category', 'critical area', 'airport rescue', 'fuselage width', 'easa adr.ops', 'cap 168', 'remission', 'vehicle', 'pumper'] },
          { id: 'toggle-ilscs', group: 'View', label: showIlsCs ? 'Close ILS Critical & Sensitive Area Monitor' : 'ILS Critical & Sensitive Area / LVO Surface-Movement Protection Monitor · per-aircraft LLZ + GP critical-area (300×60 m / 90×60 m) and sensitive-area (3000×120 m / 1200×300 m triangle) infringement vs published CAT-II / III runways · per-day declared LVO category gated by WX-LVO % slider · ICAO Annex 10 Vol I Att C §2.1.9 · FAA Order 6750.16E · Order JO 7110.65 §3-7-5 · Order 8260.3D TERPS · AC 120-118 · AC 120-28D · AC 150/5340-30J ch 9 LVP hold-bars · EASA CS-AWO Sub-D · AMC1 SPA.LVO.100 · AMC1 ADR.OPS.B.045 · ICAO Doc 4444 §7.13 · Doc 9476 SMGCS · Doc 9870 A-SMGCS · EUROCONTROL EUR Doc 013 · EUROCAE ED-46B / ED-126 · RTCA DO-235B / DO-249 · 24-runway catalogue CDG LHR FRA AMS MUC ZRH VIE CPH OSL ARN HEL EDDF JFK ORD ATL SEA YYZ MEM HND NRT ICN PEK', run: () => { const nv = !showIlsCs; setShowIlsCs(nv); lsSet('ft-ilscs', nv) }, keywords: ['ils', 'localizer', 'llz', 'glideslope', 'glide path', 'gp', 'critical area', 'sensitive area', 'lvo', 'low visibility', 'lvp', 'cat ii', 'cat iii', 'cat iiib', 'autoland', 'rvr', 'surface movement', 'hold bar', 'category iii', 'annex 10', 'app c', '6750.16e', 'jo 7110.65', 'ac 120-118', 'ac 120-28', 'ac 150/5340-30', 'doc 4444', 'doc 9476', 'doc 9870', 'smgcs', 'a-smgcs', 'eur doc 013', 'cs-awo', 'spa.lvo.100', 'adr.ops.b.045', 'ed-46b', 'do-235b', 'signal protection', 'course bend', 'path bend', 'usair 405', 'lhr llz'] },
          { id: 'toggle-prm', group: 'View', label: showPrm ? 'Close PRM / SOIA NTZ Breach Monitor' : 'PRM / SOIA · No-Transgression Zone Breach Monitor · Precision Runway Monitor and Simultaneous Offset Instrument Approach deviation surveillance · closely-spaced (700-4300 ft) parallel runway pairs · per-arrival cross-track / cross-rate / time-to-intrusion / glideslope deviation / paired-traffic conflict · 17-airport catalogue SFO 28L/28R + 19L/19R SOIA · EWR PHL CLT MSP BOS IAH ORD SEA AMS ICN · JFK ATL DFW LHR CDG CSPR · 5-tier BREACH IMMINENT DEVIATE CAUTION OK · FAA Order JO 7110.65 §5-9-7/8 · Order 7110.308 SOIA · Order 8260.49B · AC 90-101A · AC 90-115 · ICAO Doc 4444 §6.7.3 · Doc 9643 SOIR · EUROCONTROL CRDS · RTCA DO-260B · NTSB AAB-95/01 USAir 1493', run: () => { const nv = !showPrm; setShowPrm(nv); lsSet('ft-prm', nv) }, keywords: ['prm', 'soia', 'ntz', 'no transgression zone', 'parallel runway', 'closely spaced', 'simultaneous approach', 'breakout', 'precision runway monitor', 'sfo', '28l', '28r', 'phl', 'ewr', 'clt', 'msp', 'cspr', 'jo 7110.65', '7110.308', '8260.49', 'ac 90-101', 'ac 90-115', 'doc 9643', 'soir', 'crds', 'lda prm', 'usair 1493'] },
          { id: 'toggle-ngs', group: 'View', label: showNgs ? 'Close NGS / OBIGGS Ullage O₂ Monitor' : 'NGS / OBIGGS Fuel-Tank Inerting Ullage O₂ Compliance Monitor · per-airframe ASM service-life / NEA-flow / BPRV trim / ullage O₂ % / cruise-flammability exposure per 14 CFR 25.981 · App N · SFAR 88 · 121.1117 · 26.33/37 · FAA AC 25.981-2C · AC 25-19A · EASA CS-25.981 · NTSB AAR-00/03 TWA800 · Honeywell ASM · Boeing FCOM 12.30 · Airbus PRO-NOR-SOP-28', run: () => { const nv = !showNgs; setShowNgs(nv); lsSet('ft-ngs', nv) }, keywords: ['ngs', 'obiggs', 'iggs', 'inerting', 'nitrogen', 'nea', 'fuel tank', 'ullage', 'cwt', 'centre wing tank', 'center wing tank', 'flammability', 'frm', 'asm', 'air separation', 'sfar 88', '25.981', '121.1117', '26.33', '26.37', 'app n', 'appendix n', 'twa800', 'twa 800', 'bprv', 'bleed', 'hfm', 'lfm', 'honeywell', 'parker', 'cobham', 'ac 25.981', 'ac 25-19a', 'cs-25.981', 'special condition f-44', '737ng', '737max', 'a320neo', '787', 'a350', 'a380'] },
          { id: 'toggle-gadss', group: 'View', label: showGadss ? 'Close GADSS / ELT-DT Distress Tracking Monitor' : 'GADSS Normal/Autonomous Distress Tracking & 406 MHz ELT-DT Cospas-Sarsat Compliance Monitor · per-airframe ELT generation (LEGACY-121.5/406-AF/406-AP/ELT-DT) / NT 15-min report cap / ADT 1-min distress cap / SATCOM Iridium-Inmarsat-ACARS link health / ADS-B NIC integrity / 406 battery months vs 60-mo 14 CFR 91.207(c) renewal / self-test fault / distress detection (descent / unusual attitude / low-alt) per ICAO Annex 6 Pt I 6.18 · Annex 10 Vol III · Doc 10054 · Cospas-Sarsat A.001 / T.001 / G.005 MEOSAR · RTCA DO-204B · EUROCAE ED-237 · EASA AMC1 CAT.IDE.A.280 · MH370 / AF447 lessons', run: () => { const nv = !showGadss; setShowGadss(nv); lsSet('ft-gadss', nv) }, keywords: ['gadss', 'elt', 'elt-dt', 'distress tracking', 'cospas-sarsat', 'cospas sarsat', '406 mhz', '121.5', 'meosar', 'leosar', 'sar', 'search and rescue', 'iamsar', 'tracking', 'satcom', 'iridium', 'inmarsat', 'acars', 'ads-b', 'nic', 'mh370', 'af447', 'annex 6', 'annex 10', 'annex 11', 'doc 10054', 'do-204b', 'ed-237', '91.207', '121.339', '135.167', 'cat.ide.a.280', 'mcc', 'usmcc', 'fmcc'] },
          { id: 'toggle-efvs', group: 'View', label: showEfvs ? 'Close EFVS / HUD §91.176 Credit Monitor' : 'EFVS / HUD Enhanced Flight Vision System Lower-Minima & 14 CFR 91.176 Operational Credit Monitor · per-airframe IR / MMW / Combined sensor + HUD fit + DO-315B MOPS health (NETD mK / combiner nits / HUD alignment mrad / MMW antenna gain dB) + atmospheric attenuation (wet-fog kills IR @ 3-5µm / wet-snow kills MMW @ 94 GHz) + 14 CFR 61.66 pilot currency / §91.176(a) to-touchdown vs §91.176(b) to 100 AGL credit-claim resolution per FAA AC 90-106A · AC 20-167B · RTCA DO-315B / DO-341 · SAE ARP 5825 · EASA AMC1 SPA.LVO.100 · ICAO Doc 9365 ch 8 · Boeing HGS-4000 / HGS-6000 · Honeywell SmartView / Universal EVS-1500 / Elbit ClearVision / Gulfstream PlaneView EVS-II', run: () => { const nv = !showEfvs; setShowEfvs(nv); lsSet('ft-efvs', nv) }, keywords: ['efvs', 'evs', 'hud', 'enhanced flight vision', 'enhanced vision', 'synthetic vision', 'svs', 'cvs', 'combined vision', '91.176', '61.66', 'lower minima', 'low visibility', 'lvo', 'hgs', 'head up display', 'infrared', 'ir', 'mmw', 'millimeter wave', 'do-315b', 'do-341', 'ac 90-106a', 'ac 20-167b', 'arp 5825', 'spa.lvo.100', 'gulfstream', 'planeview', 'falconeye', 'smartview', 'clearvision', 'rockwell collins', 'elbit', 'universal avionics', 'doc 9365'] },
          { id: 'toggle-irs', group: 'View', label: showIrs ? 'Close IRS / ADIRU Drift Monitor' : 'IRS / ADIRU Inertial Reference Drift & ARINC 704A Navigation Integrity Monitor · per-airframe triplex IRU/ADIRU drift nm/hr / Schuler 84.4-min residual / ground-align mils / gyro-bias deg-hr / ADR-IR cross-channel vote / GPS-coupled vs pure-INS / MEL 1-ch deferral per 14 CFR 121.349 · ARINC 704A · ARINC 738 · RTCA DO-178C / DO-254 · FAA AC 25-7C · AC 90-105A · AC 20-130A · EASA AMC 20-12 · ICAO Doc 9613 · Honeywell LASEREF V/VI · Northrop Grumman LTN-101 GNADIRU · Boeing 777/787 FCOM 11.20 · Airbus FCOM DSC-34-15 · QF72 ATSB AO-2008-070 · FAA AD 2009-21-13', run: () => { const nv = !showIrs; setShowIrs(nv); lsSet('ft-irs', nv) }, keywords: ['irs', 'iru', 'adiru', 'inertial', 'reference', 'drift', 'schuler', 'gyro', 'rlg', 'ring laser', 'fog', 'fiber optic gyro', 'adr', 'air data', 'nav integrity', 'arinc 704', 'arinc 738', 'laseref', 'ltn-101', 'gnadiru', 'qf72', 'learmonth', 'pbn', 'rnp', 'ahrs', 'ad 2009-21-13', 'do-178c', 'do-254', 'ac 20-130a', '121.349', 'gps coupled', 'pure ins'] },
          { id: 'toggle-rcam', group: 'View', label: showRcam ? 'Close RCAM / TALPA Braking Monitor' : 'RCAM / TALPA Runway-Condition Braking-Action & Landing-Distance Compliance Monitor · per-airport RwyCC 0-6 vs per-airframe LDA / LDR×1.15 LPATA margin / contaminant (DRY/WET/COMPSNOW/DRYSNOW/WETSNOW/SLUSH/ICE/WET-ICE) / RCC-keyed crosswind limits / tailwind / PIREP braking action per FAA SAFO 06012 / SAFO 19001 · AC 91-79A CHG 2 · AC 25-32 · 14 CFR 121.195/197 · FAA InFO 16016 · InFO 21013 · ICAO Annex 14 § 2.9 · ICAO Doc 9981 PANS-AGA · ICAO Doc 10064 · ICAO GRF · EASA Reg (EU) 2018/1119 · Boeing FCOM PI ch L · Airbus FCOM PER-OAN-MLD-30 · NTSB AAR-08/02 SWA1248 KMDW · AAR-08/03 Pinnacle 4712 · TSB-A05H0002 AF358 YYZ · AAIB 1/2021 EZY ATR-72 BHD', run: () => { const nv = !showRcam; setShowRcam(nv); lsSet('ft-rcam', nv) }, keywords: ['rcam', 'talpa', 'runway condition', 'rwycc', 'braking action', 'lpata', 'lda', 'ldr', 'landing distance', 'snow', 'slush', 'ice', 'contaminated', 'crosswind', 'tailwind', 'pirep', 'grf', 'global reporting format', 'safo', 'snowtam', 'ficon', 'ac 91-79a', 'ac 25-32', '121.195', '121.197', 'annex 14', 'doc 9981', 'doc 10064', 'eu 2018/1119', 'fcom pi', 'mdw 1248', 'pinnacle 4712', 'af358', 'overrun'] },
          { id: 'toggle-mlat', group: 'View', label: showMlat ? 'Close MLAT / WAM TDoA Surveillance Monitor' : 'MLAT / WAM Wide-Area Multilateration TDoA Surveillance Coverage & GDOP Monitor · per-airframe 1090 MHz Mode-S ES TDoA station-set vs radio-horizon (1.23·√h) + free-space-loss link budget + hyperbolic-solve GDOP/HDOP/VDOP/TDOP via H matrix + EPU/NUC equivalence per DO-260B Table 2-72 vs required NUC for 5-NM radar-equivalent separation per ICAO Annex 10 Vol IV / Doc 9924 ASM ch 7 / Doc 4444 PANS-ATM 8.5 / EUROCAE ED-129B WAM / ED-117A / ED-142 / RTCA DO-260B / FAA JO 7110.65 5-5-4 / EUROCONTROL WAM-NRA / Asterix CAT-021', run: () => { const nv = !showMlat; setShowMlat(nv); lsSet('ft-mlat', nv) }, keywords: ['mlat', 'multilateration', 'wam', 'wide area', 'tdoa', 'time difference', 'hyperbolic', 'surveillance', 'gdop', 'hdop', 'vdop', 'tdop', 'nuc', 'nacp', 'sda', 'sil', 'mode s', 'mode-s', '1090', '1090 mhz', 'extended squitter', 'ads-b', 'adsb', 'ed-129b', 'ed-117a', 'ed-142', 'do-260b', 'doc 9924', 'doc 4444', 'annex 10', 'jo 7110.65', 'asterix', 'cat-021', 'radar separation', 'aireon', 'saab sensis', 'horizon'] },
          { id: 'toggle-pbcs', group: 'View', label: showPbcs ? 'Close PBCS · RCP / RSP Performance Monitor' : 'PBCS · Performance-Based Communication & Surveillance Monitor · per-airframe CPDLC RCP-95 transaction time / ADS-C RSP-95 report age / 99.9-pct expiry / link bearer success rate / provider outage vs region-required RCP-240/RSP-180 PBCS allocation enabling 23-NM RLatSM and 30-NM longitudinal separation per ICAO Doc 9869 PBCS Manual / Doc 10037 GOLD / Doc 4444 PANS-ATM 5.4.2.6 / Doc 7030 NAT SUPPS / EUROCAE ED-122 / ED-228A / ED-110B / RTCA DO-258A / DO-280B / FAA AC 90-117A / AC 91-70B ch 5 / Order JO 7110.65 § 8-1 § 8-3 / Order 8400.10 V4 Ch 1 / EASA AMC 20-25 / AMC 20-140 / NAT Doc 007 / Doc 008 / NAT OPS Bulletin 2015-001 / 2017-002 / 2020-002 / Asia-Pac AAITF/26 / IATA PBCS Implementation Guide 2019 / ARINC 622 / 623 / 631 · 18-region airspace catalogue NAT-RLatSM / NAT-HLA / Shanwick / Gander / NY / Reykjavik / Santa Maria / SAT / WATRS-LAR / NOPAC / Tahiti / Auckland / Brisbane / BOBCAT / Mumbai / Polar / Arctic-CEP · 5-bearer link Inmarsat-Classic / SBB-Safety / Iridium-NEXT / VDL-Mode-2 / HF-DL · FANS-1/A+ vs ATN-B1/B2 ATSU stack · 5-tier LOSS-PBCS / DEGRADED / WATCH / OK / IDLE', run: () => { const nv = !showPbcs; setShowPbcs(nv); lsSet('ft-pbcs', nv) }, keywords: ['pbcs', 'rcp', 'rsp', 'performance based communication', 'cpdlc', 'ads-c', 'adsc', 'fans', 'fans-1/a', 'fans-1a', 'atn', 'atn-b1', 'atn-b2', 'datalink', 'data link', 'oceanic', 'nat hla', 'rlatsm', 'shanwick', 'gander', 'nopac', 'watrs', 'bobcat', 'auckland', 'tahiti', 'santa maria', 'reykjavik', 'sat corridor', 'separation', '23 nm', '30 nm lateral', 'doc 9869', 'doc 10037', 'gold', 'doc 4444', 'doc 7030', 'nat doc 007', 'nat doc 008', 'ed-122', 'ed-228', 'ed-110b', 'do-258a', 'do-280b', 'ac 90-117', 'ac 91-70', '8400.10', 'amc 20-25', 'amc 20-140', 'inmarsat', 'iridium', 'sbb', 'swiftbroadband', 'vdl mode 2', 'vdl m2', 'hfdl', 'hf-dl', 'arinc 622', 'arinc 623', 'arinc 631', 'iata pbcs', 'transaction time', 'report age', 'provider outage'] },
          { id: 'toggle-vapp', group: 'View', label: showVapp ? 'Close Vapp Advisor' : 'Vapp Wind-Corrected Approach Speed Advisor · per-airframe Vref scaled √(W/MLW) from class MTOW/MLW · Vapp = Vref + max(5, HW/2) + Gust/2 capped Vref+20 kt per AC 120-71B App.3 / Airbus FCOM AOM 3.04.20 · ICAO Approach Categories A-E per PANS-OPS Doc 8168 Vol I §6.4 Table I-4-1-1 · 56-airport surface-wind atlas with prevailing direction/gust/QFU · headwind / crosswind decomposition against best-aligned runway · stable-approach window Vapp+10/-5 per FSF ALAR Toolkit Briefing Note 7.1 · 5-tier GOOD/MARGIN/HIGH/LOW/NO-IAS grading · runway centreline projection + cyan headwind arrow + tier-coloured halo · ΔIAS-vs-Vapp diagnostic scatter', run: () => { const nv = !showVapp; setShowVapp(nv); lsSet('ft-vapp', nv) }, keywords: ['vapp', 'vref', 'approach speed', 'reference speed', 'stable approach', 'landing speed', 'headwind', 'crosswind', 'gust', 'wind additive', 'ac 120-71b', 'pans-ops', 'doc 8168', 'category', 'cat a', 'cat b', 'cat c', 'cat d', 'cat e', 'fsf', 'alar', 'briefing note', 'flaps', 'final approach', 'ias', 'fcom', 'mlw', 'landing weight'] },
          { id: 'toggle-gls', group: 'View', label: showGls ? 'Close GLS / GBAS Availability Monitor' : 'GLS / GBAS Approach Availability & VDB Coverage · per-airframe MMR equipage (NO-MMR / MMR-I / MMR-II / MMR-III GAST-D) vs destination GBAS Ground Facility published service (GAST-C / GAST-D / CAT-I / TEST / NOTAM) · 32-station VDB ground-facility catalogue (Honeywell SmartPath / Indra NORMARC / Thales) with regional service-volume circles ≈23 nm per ICAO Annex 10 · per-icao ionospheric I-state NOM / WATCH / ANOM per RTCA DO-253D threat model (CONUS A, EUR B, LATAM/equatorial C) · LPL / VPL vs VAL/LAL alert limits (GAST-D 2.5 m / 10 m, GAST-C 5.3 m / 17 m, MMR-I 10 m / 40 m) per RTCA DO-245A SAGR · reference-satellite count ≥ 5 GAST-D minimum · continuity-of-service synth · 5-tier UNABLE / DEGRADE / WATCH / OK / IDLE · 5 risk drivers COV / SVC / ION / SAT / INT · MapLibre tier-coloured halos + rose UNABLE pin + station service-pins + dashed VDB coverage circles + tier-coloured callsign+ach+I-state labels · VPL-vs-LPL scatter diagnostic · 6 sliders MIN-FL / MAX-FL / CAPTURE / ION-MUL / NOTAM-RATE / VAL-buf · MMR + SVC chip filters · AIRCRAFT / STATIONS tabs · references ICAO Annex 10 Vol I §3.7 / Doc 9849 / Doc 8168 Vol II §6 / RTCA DO-245A / DO-253D / DO-246E / EUROCAE ED-114B / ED-95 / FAA AC 120-118 / AC 20-138D / FAA Order 8260.55A / 8260.57 / Order JO 7110.65 / FAA Spec FAA-E-2937A / EASA AMC 20-28 / AMC 20-26 / Honeywell SmartPath SLS-4000/5000 / Indra NORMARC 8100/7000 / Boeing 737/747/787 FCOM 11.30 / AERO Q3-2009 / Airbus FCOM PRO-NOR-SOP-15 / RTCA SC-159 ionospheric threat model', run: () => { const nv = !showGls; setShowGls(nv); lsSet('ft-gls', nv) }, keywords: ['gls', 'gbas', 'vdb', 'gast-c', 'gast-d', 'mmr', 'multi-mode receiver', 'laas', 'local-area augmentation', 'smartpath', 'normarc', 'do-253d', 'do-245a', 'do-246e', 'ed-114b', 'annex 10', 'doc 9849', 'pans-ops', 'cat ii', 'cat iii', 'ionospheric', 'ion threat', 'lpl', 'vpl', 'val', 'lal', 'protection level', 'ac 120-118', 'ac 20-138d', '8260.55a', '8260.57', 'amc 20-28', 'd8psk', '108 mhz', 'sls-4000', 'sls-5000'] },
          { id: 'toggle-tanker', group: 'View', label: showTanker ? 'Close Fuel Tankering Economics Optimizer' : 'Fuel Tankering Economics Optimizer · per-airframe origin→destination Jet-A1 price-differential analysis · 64-airport regional price catalogue (USGC / ME / SE-Asia cheap vs Switzerland / Iceland / Nordics expensive) · per-class tankerable fuel bounded by MTOW-ZFW-leg-fuel and MLW-ZFW landing-weight gate · carriage-penalty fuel-burn ≈ 3.8-6.2 %/hr × tankered × block-time per class catalogue · net USD = Δprice × tankered − origin-price × penalty − wear surcharge · 5-tier SKIP/CAUTION/WATCH/RECOMMEND/IDLE · 5-driver ECN/MLW/PEN/RES/ENV per EUROCONTROL Fuel Tankering Study 2019/2022 · IATA Fuel Efficiency Gap Analysis · ICAO CORSIA Doc 9988 · Annex 6 Pt I § 4.3.6 minimum fuel · 14 CFR 121.639/121.645 · EASA CAT.OP.MPA.150 · Boeing Performance Engineer Manual · Airbus Getting to Grips With Fuel Economy · Reuters / Platts JET CIF NWE & USGC weekly assessments', run: () => { const nv = !showTanker; setShowTanker(nv); lsSet('ft-tanker', nv) }, keywords: ['fuel', 'tanker', 'tankering', 'economics', 'cost', 'savings', 'jet-a1', 'jet a1', 'jet-a', 'price', 'platts', 'usd per gallon', 'usg', 'origin', 'destination', 'leg', 'mlw', 'landing weight', 'mtow', 'zfw', 'mzfw', 'carriage', 'penalty', 'payback', 'co2', 'corsia', 'eurocontrol', 'iata', 'fega', 'sustainability', 'optimization', 'optimizer', '121.639', '121.645', 'cat.op.mpa.150', 'annex 6', 'reserve fuel', 'ferry', 'reposition', 'ozone', 'usgc', 'middle east', 'dxb', 'doh', 'auh', 'iah', 'sin', 'kul', 'lhr', 'cdg', 'kef', 'zrh', 'gva'] },
          { id: 'toggle-saf', group: 'View', label: showSaf ? 'Close SAF · CORSIA · ReFuelEU monitor' : 'SAF Blend & CORSIA / ReFuelEU Compliance · per-airframe Sustainable Aviation Fuel blend pct · lifecycle CO2eq gCO2e/MJ vs Jet-A1 89.0 baseline · 10 pathways HEFA-UCO/TALLOW/SOY · FT-MSW/WOOD · ATJ-SUGAR/CORN · CHJ · PtL-WIND/SOLAR with ICAO CORSIA Default LCA values · 28-airport SAF supply catalogue (EU ReFuelEU mandate jurisdiction + US IRA §45Z + Asia-Pacific) · ReFuelEU Reg 2023/2405 stepped mandate 2% 2025 / 6% 2030 / 20% 2035 / 70% 2050 · CORSIA offset $/leg @ carbon-price slider · 5-driver MAND/LCA/OFFSET/BLEND/PATH max-driver composite · 5-tier NONCOMP/SHORT/WATCH/COMPLY/IDLE · CO2 saved vs all-Jet-A baseline · per-pathway lifecycle gCO2e/MJ ranking · MapLibre halo + leg + airport pathway pins · blend-vs-LCA diagnostic scatter · references ICAO Annex 16 Vol IV · Doc 9988 · Assembly Res A41-22 · ASTM D7566 Annex A1-A7 · EU Reg 2018/2001 RED II · IRA §40B/§45Z · IATA Net Zero CO2 by 2050 · ATAG Waypoint 2050 · CAEP/12 · FAA SAF Grand Challenge · UK Jet Zero Strategy', run: () => { const nv = !showSaf; setShowSaf(nv); lsSet('ft-saf', nv) }, keywords: ['saf', 'sustainable aviation fuel', 'corsia', 'refueleu', 'refuel eu', 'eu 2023/2405', 'mandate', 'blend', 'pathway', 'hefa', 'ft-msw', 'atj', 'ptl', 'e-saf', 'e-fuel', 'lca', 'lifecycle', 'gco2e', 'co2', 'carbon', 'offset', 'a41-22', 'astm d7566', 'd7566', 'jet-a1', 'red ii', '40b', '45z', 'ira', 'iata', 'atag', 'jet zero', 'net zero', 'environment', 'sustainability'] },
          { id: 'toggle-vib', group: 'View', label: showVib ? 'Close Engine Vibration / FBO Monitor' : 'Engine Vibration & Fan-Blade-Imbalance Monitor (ATA-77)', run: () => { const nv = !showVib; setShowVib(nv); lsSet('ft-vib', nv) }, keywords: ['vibration', 'vib', 'n1', 'n2', 'ips', 'fan', 'fbo', 'imbalance', 'bearing', 'ata-77', 'cfm56', 'leap', 'genx', 'trent', 'gtf', 'engine'] },
          { id: 'toggle-trim', group: 'View', label: showTrim ? 'Close Pitch-Trim Authority Monitor' : 'Pitch-Trim Authority & Runaway / MCAS-STS Margin Monitor (ATA-27-40)', run: () => { const nv = !showTrim; setShowTrim(nv); lsSet('ft-trim', nv) }, keywords: ['trim', 'pitch', 'stab', 'stabilizer', 'mcas', 'sts', 'ansu', 'prim', 'elac', 'runaway', 'jackscrew', 'ata-27', 'cg', 'authority'] },
          { id: 'toggle-dme', group: 'View', label: showDme ? 'Close DME/DME RNAV FOM Monitor' : 'DME/DME RNAV Position Accuracy & Pair-Geometry FOM (ATA-34-55)', run: () => { const nv = !showDme; setShowDme(nv); lsSet('ft-dme', nv) }, keywords: ['dme', 'rnav', 'pbn', 'navaid', 'fom', 'nuc', 'epu', 'positioning', 'ata-34', 'doc 9613', 'ac 90-100a', '8260.58', 'pair geometry'] },
          { id: 'toggle-trev', group: 'View', label: showTRev ? 'Close Thrust Reverser Inhibit Monitor' : 'Thrust Reverser Deploy / In-Flight Inhibit / Asymmetric Reverse Monitor (ATA-78-30) · per-engine sleeve-position / HCU psi / interlock chain WoW+RA+TLA / sleeve-lock indicator / asymmetric rollout (Lauda Air AAR-93-07 / 14 CFR 25.933 / AC 25.933-1 / Boeing FCOM 7.10 / Airbus PRO-NOR-SOP-70)', run: () => { const nv = !showTRev; setShowTRev(nv); lsSet('ft-trev', nv) }, keywords: ['thrust reverser', 'reverser', 't/r', 'tr', 'reverse thrust', 'lauda', 'lauda air 004', 'in-flight deploy', 'asymmetric reverse', 'sleeve', 'blocker door', 'cascade', 'target', 'pivot door', 'beta range', 'hcu', 'sync lock', 'interlock', 'unlock', 'wow', 'radio altimeter ra', 'tla', 'throttle resolver', 'ata-78', '25.933', 'ac 25.933-1', 'aar-93-07', 'aar-09-03', 'pw4000', 'ge90', 'trent 1000', 'mmel 78', 'fcom 7.10', 'pro-nor-sop-70'] },
          { id: 'toggle-vmon', group: 'View', label: showVmon ? 'Close VOR MON Reversion Monitor' : 'VOR MON · Minimum Operational Network & GPS-Loss Conventional Navigation Reversion (FAA Order JO 7400.10 / 1100.181 / 8260.55A / AC 90-100A §6 / AIM 1-1-3 / 81 FR 36772) · nearest MON airport / 3-VOR chain / DOC service volume / NOTAM U/S / chain bearing gap / GPS-fault simulation slider', run: () => { const nv = !showVmon; setShowVmon(nv); lsSet('ft-vmon', nv) }, keywords: ['vor', 'mon', 'minimum operational network', 'gps loss', 'gps denied', 'gps jam', 'spoof', 'reversion', 'conventional', 'navaid', '7400.10', '8260.55a', '1100.181', 'aim 1-1-3', 'doc service volume', 'fallback', 'raim', 'fr 36772', 'volpe', 'gao-18-263'] },
          { id: 'toggle-paxo2', group: 'View', label: showPaxO2 ? 'Close PAX Oxygen Reserve Monitor' : 'PAX Oxygen · Chemical Generator Reserve & Emergency Descent (14 CFR 25.1441-1453 / 121.629 / SFAR 25 / AC 25-22 / ICAO Annex 6 4.3.8) · per-airframe burn-time vs descent-to-FL100 / chem-gen cargo violation flag / mask deployment / SpO2 floor / post-ValuJet 592 NTSB AAR-97-06', run: () => { const nv = !showPaxO2; setShowPaxO2(nv); lsSet('ft-paxo2', nv) }, keywords: ['oxygen', 'o2', 'pax', 'passenger', 'chem', 'chemical', 'generator', 'candle', 'sodium chlorate', 'valujet', '592', 'sfar 25', '25.1447', '121.629', 'decompression', 'descent', 'mask', 'spo2', 'ata 35', 'hypoxia', 'cabin altitude'] },
          { id: 'toggle-ulb', group: 'View', label: showUlb ? 'Close ULB / CVR-FDR Battery Monitor' : 'ULB · CVR/FDR Underwater Locator Beacon Battery EOL & Recorder Health (ICAO Annex 6 Pt I App 8 / §6.3.1.2 90-day post-AF447 / TSO-C121b 37.5 kHz HF + 8.8 kHz LF / EUROCAE ED-112A / 14 CFR 25.1457 / 25.1459 / Annex 13) · battery remaining days / acoustic detection range vs sea-state & depth / CVR overwrite / FDR param coverage / GADSS streaming · BEA AF447 / ATSB MH370', run: () => { const nv = !showUlb; setShowUlb(nv); lsSet('ft-ulb', nv) }, keywords: ['ulb', 'pinger', 'underwater', 'locator', 'beacon', 'cvr', 'fdr', 'recorder', 'black box', 'eafr', 'af447', 'mh370', 'annex 6', '90 day', 'tso-c121b', 'ed-112a', '25.1457', '25.1459', 'dukane', '37.5 khz', '8.8 khz', 'gadss', 'bea', 'atsb'] },
          { id: 'toggle-selcal', group: 'View', label: showSelcal ? 'Close SELCAL / HF Voice-Watch Monitor' : 'SELCAL · ARINC 596 Code-Pair Conflict & HF Voice-Watch Coverage (10,920 codes / 16-letter A-S alphabet / family-A A-H / family-B J-S / 14 MWARA stations Shanwick Gander NY Reykjavik Stockholm Bahrain Mumbai SFO Honolulu Auckland Brisbane Tahiti Cape Town Sao Paulo / Doc 7030 NAT SUPPS §1.5 / Doc 10037 GOLD §6.4 / NAT OPS 2017-002 PBCS HF voice fallback)', run: () => { const nv = !showSelcal; setShowSelcal(nv); lsSet('ft-selcal', nv) }, keywords: ['selcal', 'arinc 596', 'hf voice', 'mwara', 'shanwick', 'gander', 'oceanic', 'code pair', 'asri', 'voice watch', 'nat doc 007', 'pbcs', 'kal007', 'tone pair', 'gold'] },
          { id: 'toggle-adsc', group: 'View', label: showAdsc ? 'Close ADS-C / FANS-1A Contract Monitor' : 'ADS-C / FANS-1A Contract & Periodic Position-Report Compliance (PBCS RSP-180/240 + RCP-240/400 / 18 GES Inmarsat-Iridium-VDL2-Polar / 7 ARINC 745 groups BASIC FLT-ID PRED-RT EARTH AIR METEO INTENT / PERIODIC EVENT DEMAND contract types / Doc 10037 GOLD ch 5 / NAT OPS 2017-002 / FAA AC 91-70B Ch 5)', run: () => { const nv = !showAdsc; setShowAdsc(nv); lsSet('ft-adsc', nv) }, keywords: ['adsc', 'ads-c', 'fans', 'fans-1a', 'pbcs', 'rsp', 'rcp', 'cpdlc', 'inmarsat', 'iridium', 'vdl', 'oceanic', 'periodic report', 'contract', 'gold', 'doc 10037', 'nat ops', 'arinc 622', 'arinc 745'] },
          { id: 'toggle-airac', group: 'View', label: showAirac ? 'Close AIRAC · FMS Nav-DB Currency Monitor' : 'AIRAC Cycle · FMS Nav-Database Currency & ARINC 424 Coded-Procedure Compliance (28-day ICAO AIRAC cycle / 9-supplier catalogue Jeppesen Navblue LIDO Honeywell Collins Garmin Universal Rockwell UASC / DO-200B Type-1/2 LoA / 4-part coverage NAV/CHART/TERR/OBST / DAL-1/2/3 alignment vs RNP-AR/RNP-1/RNAV / regional coverage WW/NAM/EUR/MID/AFI/ASIA/PAC/LATAM/ATL/POL/TAILORED / dual-DB active+standby tracking / cycles-behind escalation / Annex 15 App 4 / Doc 10066 PANS-AIM / Doc 8126 AIS / Doc 9613 PBN / RTCA DO-200B / DO-201A / ARINC 424-22 / EUROCAE ED-76A / ED-77 / FAA AC 20-153B / 90-100A / 90-107 / Order 8400.10 V4 / EASA AMC 20-26A / 20-27A / Part-CAT.OP.MPA.300 / EU Reg 73/2010 / 2017/373 / NTSB AAR-00-03 American 965 Cali R-vs-ROZO / KAL801 Guam)', run: () => { const nv = !showAirac; setShowAirac(nv); lsSet('ft-airac', nv) }, keywords: ['airac', 'nav database', 'navdb', 'fms', 'navdata', 'jeppesen', 'navblue', 'lido', 'honeywell', 'collins', 'garmin', 'universal avionics', 'rockwell', 'cycle', '28 day', 'aim', 'pans-aim', 'doc 10066', 'doc 8126', 'annex 15', 'do-200b', 'do-201a', 'arinc 424', 'ed-76', 'ed-77', 'ac 20-153b', 'ac 90-100', 'ac 90-105', 'ac 90-107', 'order 8400.10', 'amc 20-26', 'amc 20-27', 'amc 20-28', 'cat ops mpa', 'spa pbn', 'eu reg 73/2010', 'eu reg 2017/373', 'pbn', 'rnp', 'rnp-ar', 'lpv', 'cali', 'rozo', 'american 965', 'kal801', 'guam', 'dal', 'data assurance level', 'loa', 'data quality'] },
          { id: 'toggle-wow', group: 'View', label: showWow ? 'Close WoW · Squat-Switch · Air-Ground Logic Monitor' : 'WoW / Squat-Switch · Air-Ground Logic Discrepancy & Ground-Spoiler / Autobrake / T-R Interlock Coherency Monitor', run: () => { const nv = !showWow; setShowWow(nv); lsSet('ft-wow', nv) }, keywords: ['wow', 'squat switch', 'air ground', 'lgciu', 'pseu', 'spanair', 'jk5022', 'emirates', 'ek521'] },
          { id: 'toggle-tpis', group: 'View', label: showTpis ? 'Close TPIS · BTMS · Fuse-Plug Monitor' : 'TPIS · BTMS · Fuse-Plug Release · Per-Wheel Tire Pressure & Brake Temperature & RTO Energy Margin Monitor', run: () => { const nv = !showTpis; setShowTpis(nv); lsSet('ft-tpis', nv) }, keywords: ['tpis', 'btms', 'tire', 'pressure', 'brake', 'temperature', 'fuse plug', 'concorde', 'af4590', 'rto', 'wheel', 'cooling'] },
          { id: 'toggle-psrssr', group: 'View', label: showPsrSsr ? 'Close PSR / SSR Radar Coverage Monitor' : 'PSR / SSR · Primary & Secondary Surveillance Radar Coverage Gap & Procedural-Separation Fallback Monitor (32-station global ATC radar catalogue ARSR-4 / ASR-11 / Watchman / STAR-NG / J/TPS-117 / IRS-20MP across FAA / EUROCONTROL / ASIA-PAC / OCEANIC · per-station type PSR/SSR/COMBO + range + scan-rate + horizon + uptime · radar-horizon 1.23(√h_ac+√h_st) · best-SSR / best-PSR pair selection · update-age vs 5/12/60s threshold · 5 risk drivers COV/SSR/PSR/AGE/TRN · 5 tiers GAP/DEGRADE/WATCH/RDR-OK/IDLE · procedural-separation fallback per ICAO Doc 4444 §8.4 · Annex 10 Vol IV · JO 7110.65 §5-1 §5-3 · ESARR 4 · DO-260B / DO-181E · ED-117 / ED-129B · NTSB AAR-86-08 AeroMexico 498 Cerritos PSR-gap)', run: () => { const nv = !showPsrSsr; setShowPsrSsr(nv); lsSet('ft-psrssr', nv) }, keywords: ['psr', 'ssr', 'radar', 'surveillance', 'arsr', 'asr', 'mode-s', 'mode s', 'atc radar', 'primary radar', 'secondary radar', 'procedural separation', 'radar gap', 'coverage', 'cerritos', 'aeromexico 498', 'aar-86-08', 'horizon', 'antenna', 'watchman', 'star-ng', 'arsr-4', 'asr-11', 'thales', 'lockheed', 'raytheon', 'eurocontrol', 'icao doc 4444', 'annex 10', 'jo 7110.65', 'esarr 4', 'do-260b', 'ed-117', 'tracker', 'artas', 'ofa', 'gap-filler', 'rdr', 'rader contact', 'oceanic'] },
          { id: 'toggle-start', group: 'View', label: showStart ? 'Close Engine Start Envelope Monitor' : 'Engine Start Envelope · Hot-Start / Hung-Start / Wet-Start Cold-Soak Monitor (ATA-80) · per-engine starter-air psi vs FCOM min / N2 motoring rpm/s / fuel-on cut-in N2% / peak EGT vs redline / light-off timing / TAT cold-soak / APU vs cross-bleed vs GPU source · 14 CFR 33.89 · AC 33.89-1 · CS-E 740 · SAE ARP 5316 · Boeing FCOM 7.20 · Airbus PRO-NOR-SOP-70 · NTSB DCA08IA049 PW-150 / DCA14IA063 V2500 · AD 2018-08-09 CFM56-7B SAV · AD 2021-12-09 LEAP-1B SAV · EASA AD 2020-0186 Trent XWB SCV', run: () => { const nv = !showStart; setShowStart(nv); lsSet('ft-start', nv) }, keywords: ['start', 'engine start', 'hot start', 'hung start', 'wet start', 'light off', 'lightoff', 'egt', 'starter', 'sav', 'starter air valve', 'apu bleed', 'cross bleed', 'cross-bleed', 'gpu', 'air cart', 'motoring', 'n2', 'cut-in', 'cold soak', 'tat', 'ata-80', 'ata 80', '33.89', 'cs-e 740', 'arp 5316', 'pw-150', 'v2500', 'cfm56', 'leap', 'trent xwb', 'fcom 7.20', 'pro-nor-sop-70', 'borescope', 'eec', 'fadec'] },
          { id: 'toggle-elec', group: 'View', label: showElec ? 'Close Electrical / IDG / Bus-Tie / RAT Monitor' : 'Electrical Load / IDG · Generator Bus-Tie & RAT Deployment Monitor (ATA-24) · per-airframe per-generator electrical load % vs rated kVA · IDG oil-in temp vs disconnect limit · GCU fault flag · bus-tie / cross-tie configuration (SYM / SPLIT / ISO / LOST) · TRU output amps · battery state-of-charge % · Ram Air Turbine arm / deploy criteria · ETOPS electrical-source-isolation compliance per 14 CFR 25.1351 / 25.1353 / 25.1357 / 25 App K / 14 CFR 121.374 · AC 25-22 · AC 120-42B App 2 electrical · ARINC 624 OMS · Boeing 777/787 FCOM 6.10 IDG / VFSG / TRU bus · Airbus FCOM PRO-NOR-SOP-25 elec / DSC-24 · CFM56-7B SB 24-1015 IDG · Trent 1000 SB 24-AJ-001 VFSG · NTSB DCA15IA014 A380 IDG disc · FAA AD 2017-13-09 787 GCU · EASA AD 2018-0233 A350 ELMS · SAE ARP 1199 electrical-load analysis', run: () => { const nv = !showElec; setShowElec(nv); lsSet('ft-elec', nv) }, keywords: ['electrical', 'elec', 'idg', 'integrated drive generator', 'vfsg', 'gcu', 'generator control unit', 'bus', 'bus tie', 'cross tie', 'tru', 'transformer rectifier', 'battery', 'soc', 'rat', 'ram air turbine', 'ata-24', 'ata 24', 'elms', 'pepdc', 'apu start', 'cross-feed', 'ac bus', 'dc bus', 'kva', '25.1351', '25.1357', '25 app k', 'app k', 'ac 25-22', 'ac 120-42b', 'arinc 624', 'fcom 6.10', 'pro-nor-sop-25', 'dsc-24', 'overload', 'load shed', 'qantas qf32', 'a380', 'gen fail', 'all ac off', 'etops electrical'] },
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

      {showHyd && (
        <HydraulicMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowHyd(false); lsSet('ft-hyd', false) }}
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

      {showCargoFs && (
        <CargoFireSuppress
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowCargoFs(false); lsSet('ft-cargofs', false) }}
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

      {showApu && (
        <ApuMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowApu(false); lsSet('ft-apu', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showPcn && (
        <PcnPavement
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowPcn(false); lsSet('ft-pcn', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showFuelImb && (
        <FuelImbalance
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowFuelImb(false); lsSet('ft-fuelimb', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showCsff && (
        <CsffFrost
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowCsff(false); lsSet('ft-csff', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showFbw && (
        <FbwReversion
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowFbw(false); lsSet('ft-fbw', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showMel && (
        <MelMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowMel(false); lsSet('ft-mel', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showOil && (
        <OilConsumption
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowOil(false); lsSet('ft-oil', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showHfdl && (
        <HfdlCoverage
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowHfdl(false); lsSet('ft-hfdl', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showEhs && (
        <EhsBds
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowEhs(false); lsSet('ft-ehs', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showArff && (
        <ArffRffs
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowArff(false); lsSet('ft-arff', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showSbas && (
        <SbasLpv
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowSbas(false); lsSet('ft-sbas', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showIlsCs && (
        <IlsCriticalArea
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowIlsCs(false); lsSet('ft-ilscs', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showPrm && (
        <PrmNtz
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowPrm(false); lsSet('ft-prm', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showNgs && (
        <NgsInerting
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowNgs(false); lsSet('ft-ngs', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showVib && (
        <VibMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowVib(false); lsSet('ft-vib', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showTrim && (
        <TrimAuthority
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowTrim(false); lsSet('ft-trim', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showDme && (
        <DmeDmeFom
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowDme(false); lsSet('ft-dme', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showTRev && (
        <TReverserMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowTRev(false); lsSet('ft-trev', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showVmon && (
        <VorMonReversion
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowVmon(false); lsSet('ft-vmon', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showPaxO2 && (
        <PaxOxygenMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowPaxO2(false); lsSet('ft-paxo2', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showUlb && (
        <UlbPingerMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowUlb(false); lsSet('ft-ulb', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 6) } }}
        />
      )}

      {showSlop && (
        <SlopMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowSlop(false); lsSet('ft-slop', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 5) } }}
        />
      )}

      {showRowRop && (
        <RowRopMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowRowRop(false); lsSet('ft-rowrop', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showPapi && (
        <PapiVgsiMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowPapi(false); lsSet('ft-papi', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showSelcal && (
        <SelcalMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowSelcal(false); lsSet('ft-selcal', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 5) } }}
        />
      )}

      {showAdsc && (
        <AdscFans
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowAdsc(false); lsSet('ft-adsc', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 5) } }}
        />
      )}

      {showAirac && (
        <AiracNavDb
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowAirac(false); lsSet('ft-airac', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 6) } }}
        />
      )}

      {showWow && (
        <WowSquat
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowWow(false); lsSet('ft-wow', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 9) } }}
        />
      )}

      {showTpis && (
        <TpisBtms
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowTpis(false); lsSet('ft-tpis', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 9) } }}
        />
      )}

      {showItp && (
        <ItpAseps
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowItp(false); lsSet('ft-itp', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 6) } }}
        />
      )}

      {showAsdex && (
        <AsdexSurface
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowAsdex(false); lsSet('ft-asdex', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 9) } }}
        />
      )}

      {showPsrSsr && (
        <PsrSsrCoverage
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowPsrSsr(false); lsSet('ft-psrssr', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 6) } }}
        />
      )}

      {showFireLoop && (
        <FireLoop
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowFireLoop(false); lsSet('ft-fireloop', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 7) } }}
        />
      )}

      {showVaac && (
        <VaacMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowVaac(false); lsSet('ft-vaac', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 5) } }}
        />
      )}

      {showEosid && (
        <EosidMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowEosid(false); lsSet('ft-eosid', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showSteep && (
        <SteepApproach
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowSteep(false); lsSet('ft-steepappr', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showRedispatch && (
        <RedispatchMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowRedispatch(false); lsSet('ft-redispatch', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 5) } }}
        />
      )}

      {showMsaw && (
        <MsawController
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowMsaw(false); lsSet('ft-msaw', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showPirep && (
        <PirepMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowPirep(false); lsSet('ft-pirep', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 6) } }}
        />
      )}

      {showTdwr && (
        <TdwrLlwas
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowTdwr(false); lsSet('ft-tdwr', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 9) } }}
        />
      )}
      {showMtcd && (
        <MtcdMonitor
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowMtcd(false); lsSet('ft-mtcd', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 7) } }}
        />
      )}
      {showVdl2 && (
        <Vdl2Datalink
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowVdl2(false); lsSet('ft-vdl2', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 9) } }}
        />
      )}
      {showTbs && (
        <TbsMonitor
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowTbs(false); lsSet('ft-tbs', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 10) } }}
        />
      )}
      {showVtf && (
        <VtfIntercept
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowVtf(false); lsSet('ft-vtf', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 10) } }}
        />
      )}
      {showRfi && (
        <RfiGnss
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowRfi(false); lsSet('ft-rfi', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 7) } }}
        />
      )}
      {showMnt && (
        <MntMonitor
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowMnt(false); lsSet('ft-mnt', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 6) } }}
        />
      )}
      {showCco && (
        <CcoMonitor
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowCco(false); lsSet('ft-cco', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 7) } }}
        />
      )}
      {showWat && (
        <WatMonitor
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowWat(false); lsSet('ft-wat', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 9) } }}
        />
      )}
      {showAcdm && (
        <AcdmMonitor
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowAcdm(false); lsSet('ft-acdm', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 10) } }}
        />
      )}
      {showAman && (
        <AmanMonitor
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowAman(false); lsSet('ft-aman', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 9) } }}
        />
      )}
      {showHiro && (
        <HiroMonitor
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowHiro(false); lsSet('ft-hiro', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 11) } }}
        />
      )}
      {showHspot && (
        <HotspotIncursion
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowHspot(false); lsSet('ft-hspot', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 14) } }}
        />
      )}
      {showLrah && (
        <LrahMonitor
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowLrah(false); lsSet('ft-lrah', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 7) } }}
        />
      )}
      {showRffs && (
        <RffsMonitor
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowRffs(false); lsSet('ft-rffs', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 12) } }}
        />
      )}
      {showCwy && (
        <CwyWakeEncounter
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowCwy(false); lsSet('ft-cwy', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 10) } }}
        />
      )}
      {showJblast && (
        <JblastJetBlast
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowJblast(false); lsSet('ft-jblast', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 12) } }}
        />
      )}
      {showMrva && (
        <MrvaMonitor
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowMrva(false); lsSet('ft-mrva', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 10) } }}
        />
      )}
      {showAirprox && (
        <AirproxRat
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowAirprox(false); lsSet('ft-airprox', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 10) } }}
        />
      )}
      {showMedlink && (
        <MedlinkDiversion
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowMedlink(false); lsSet('ft-medlink', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 10) } }}
        />
      )}
      {showCirc && (
        <CirclingApproach
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowCirc(false); lsSet('ft-circ', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 10) } }}
        />
      )}
      {showVmoMmo && (
        <VmoMmoEnvelope
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowVmoMmo(false); lsSet('ft-vmommo', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 10) } }}
        />
      )}
      {showNemo && (
        <NemoOtp
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowNemo(false); lsSet('ft-nemo', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 10) } }}
        />
      )}
      {showRotor && (
        <RotorOps
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowRotor(false); lsSet('ft-rotor', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 10) } }}
        />
      )}
      {showBreg && (
        <BregSpecificRange
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowBreg(false); lsSet('ft-breg', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 10) } }}
        />
      )}
      {showDoc && (
        <DocCostBreakeven
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowDoc(false); lsSet('ft-doc', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 9) } }}
        />
      )}
      {showCircad && (
        <CircadFatigue
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowCircad(false); lsSet('ft-circad', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}
      {showVmca && (
        <VmcaMonitor
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowVmca(false); lsSet('ft-vmca', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}
      {showTem && (
        <TemEnergy
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowTem(false); lsSet('ft-tem', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}
      {showCzne && (
        <CzneConflictZone
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowCzne(false); lsSet('ft-czne', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 6) } }}
        />
      )}
      {showCast && (
        <CastAccidentCat
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowCast(false); lsSet('ft-cast', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 9) } }}
        />
      )}
      {showBlkhol && (
        <BlkHolIllusion
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowBlkhol(false); lsSet('ft-blkhol', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 10) } }}
        />
      )}
      {showGld && (
        <GldGlideReach
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowGld(false); lsSet('ft-gld', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 7) } }}
        />
      )}
      {showOld && (
        <OldLandingDistance
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowOld(false); lsSet('ft-old', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 12) } }}
        />
      )}
      {showPrd && (
        <PrdPayloadRange
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowPrd(false); lsSet('ft-prd', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 7) } }}
        />
      )}
      {showAltn && (
        <AltnAlternateSuit
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowAltn(false); lsSet('ft-altn', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 7) } }}
        />
      )}
      {showFlex && (
        <FlexAtmThrust
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowFlex(false); lsSet('ft-flex', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 11) } }}
        />
      )}
      {showMelt && (
        <MeltMassEstimator
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowMelt(false); lsSet('ft-melt', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 9) } }}
        />
      )}
      {showCrzl && (
        <CrzlSemicircular
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowCrzl(false); lsSet('ft-crzl', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 9) } }}
        />
      )}
      {showDrftdn && (
        <DrftdnDriftdown
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowDrftdn(false); lsSet('ft-drftdn', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 9) } }}
        />
      )}
      {showTmi && (
        <TmiHfe
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowTmi(false); lsSet('ft-tmi', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 6) } }}
        />
      )}
      {showFleet && (
        <FleetComparison
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowFleet(false); lsSet('ft-fleet', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}
      {showGust && (
        <GustVraMargin
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowGust(false); lsSet('ft-gust', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}
      {showEdr && (
        <EdrEmergDescent
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowEdr(false); lsSet('ft-edr', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}
      {showNvpm && (
        <NvpmParticulate
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowNvpm(false); lsSet('ft-nvpm', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}
      {showSwell && (
        <SwellDitch
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowSwell(false); lsSet('ft-swell', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}
      {showWxad && (
        <WxadRadarTilt
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowWxad(false); lsSet('ft-wxad', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}
      {showVfe && (
        <VfeFlapMargin
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowVfe(false); lsSet('ft-vfe', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}
      {showDecrab && (
        <DecrabSideload
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowDecrab(false); lsSet('ft-decrab', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}
      {showRtow && (
        <RtowRtoMargin
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowRtow(false); lsSet('ft-rtow', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}
      {showTropo && (
        <TropoEncounter
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowTropo(false); lsSet('ft-tropo', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 6) } }}
        />
      )}
      {showWafs && (
        <WafsWindFL
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowWafs(false); lsSet('ft-wafs', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 6) } }}
        />
      )}
      {showAcasx && (
        <AcasX
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowAcasx(false); lsSet('ft-acasx', false) }}
          onFly={(icao, lat, lng, zoom) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(lat, lng, zoom) } }}
        />
      )}
      {showVrp && (
        <VrpCorridor
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowVrp(false); lsSet('ft-vrp', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 10) } }}
        />
      )}
      {showTurn && (
        <TurnMonitor
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowTurn(false); lsSet('ft-turn', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 14) } }}
        />
      )}
      {showDgs && (
        <DgsDocking
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowDgs(false); lsSet('ft-dgs', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 17) } }}
        />
      )}
      {showOls && (
        <OlsObstacleSurface
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowOls(false); lsSet('ft-ols', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 12) } }}
        />
      )}
      {showPms && (
        <PmsPointMerge
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowPms(false); lsSet('ft-pms', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}
      {showFra && (
        <FraFreeRoute
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowFra(false); lsSet('ft-fra', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 6) } }}
        />
      )}
      {showCdr && (
        <CdrConditionalRoute
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowCdr(false); lsSet('ft-cdr', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 6) } }}
        />
      )}
      {showStca && (
        <StcaConflict
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowStca(false); lsSet('ft-stca', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 6) } }}
        />
      )}
      {showDcb && (
        <DcbSectorLoad
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowDcb(false); lsSet('ft-dcb', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 5) } }}
        />
      )}
      {showRwsl && (
        <RwslStatusLights
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowRwsl(false); lsSet('ft-rwsl', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 13) } }}
        />
      )}
      {showAltm && (
        <AltmSettingRegion
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowAltm(false); lsSet('ft-altm', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 6) } }}
        />
      )}
      {showHold && (
        <HoldStack
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowHold(false); lsSet('ft-hold', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 9) } }}
        />
      )}
      {showFim && (
        <FimAspa
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowFim(false); lsSet('ft-fim', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 9) } }}
        />
      )}
      {showClam && (
        <ClamRam
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowClam(false); lsSet('ft-clam', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 7) } }}
        />
      )}
      {showCsc && (
        <CscCallsign
          map={mapRef.current}
          flights={flights as any}
          onClose={() => { setShowCsc(false); lsSet('ft-csc', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 10) } }}
        />
      )}

      {showSigmet && (
        <SigmetAirmet
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowSigmet(false); lsSet('ft-sigmet', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 6) } }}
        />
      )}

      {showOptAlt && (
        <OptAltCruise
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowOptAlt(false); lsSet('ft-optalt', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 5) } }}
        />
      )}

      {showTfm && (
        <TfmInitiatives
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowTfm(false); lsSet('ft-tfm', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 7) } }}
        />
      )}

      {showLahso && (
        <LahsoMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowLahso(false); lsSet('ft-lahso', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 10) } }}
        />
      )}

      {showMora && (
        <MoraGrid
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowMora(false); lsSet('ft-mora', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 6) } }}
        />
      )}

      {showStar && (
        <StarConstraints
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowStar(false); lsSet('ft-star', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 9) } }}
        />
      )}

      {showDatis && (
        <DAtisMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowDatis(false); lsSet('ft-datis', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 7) } }}
        />
      )}

      {showVolmet && (
        <VolmetMonitor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowVolmet(false); lsSet('ft-volmet', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 6) } }}
        />
      )}

      {showStart && (
        <StartEnvelope
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowStart(false); lsSet('ft-start', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 10) } }}
        />
      )}

      {showO2dur && (
        <OxygenDuration
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowO2dur(false); lsSet('ft-o2dur', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 10) } }}
        />
      )}

      {showCtac && (
        <ColdTempCorr
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowCtac(false); lsSet('ft-ctac', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 10) } }}
        />
      )}

      {showCcm && (
        <CcmCallsignConfusion
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowCcm(false); lsSet('ft-ccm', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showTasar && (
        <TasarAdvisor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowTasar(false); lsSet('ft-tasar', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 7) } }}
        />
      )}

      {showTcam && (
        <TcamCyclone
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowTcam(false); lsSet('ft-tcam', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 5) } }}
        />
      )}

      {showDaaWc && (
        <DaaWellClear
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowDaaWc(false); lsSet('ft-daawc', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 9) } }}
        />
      )}

      {showElec && (
        <ElectricalBus
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowElec(false); lsSet('ft-elec', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showAutoland && (
        <AutolandLvo
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowAutoland(false); lsSet('ft-autoland', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showGadss && (
        <GadssEltDt
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowGadss(false); lsSet('ft-gadss', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showEfvs && (
        <EfvsHud
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowEfvs(false); lsSet('ft-efvs', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showIrs && (
        <IrsAdiru
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowIrs(false); lsSet('ft-irs', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showRcam && (
        <RcamTalpa
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowRcam(false); lsSet('ft-rcam', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showMlat && (
        <MlatWam
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowMlat(false); lsSet('ft-mlat', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showPbcs && (
        <PbcsRcpRsp
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowPbcs(false); lsSet('ft-pbcs', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showTanker && (
        <FuelTanker
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowTanker(false); lsSet('ft-tanker', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showVapp && (
        <VappAdvisor
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, ias: f.ias, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowVapp(false); lsSet('ft-vapp', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showGls && (
        <GlsGbas
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowGls(false); lsSet('ft-gls', false) }}
          onFly={(icao) => { const f = flightsRef.current.find(x => x.icao === icao); if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 8) } }}
        />
      )}

      {showSaf && (
        <SafCorsia
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowSaf(false); lsSet('ft-saf', false) }}
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

      {showSaar && (
        <SaarRnpAr
          map={mapRef.current}
          flights={flights.map(f => ({ icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, category: f.category, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, track: f.track, vertRate: f.vertRate, ground: f.ground }))}
          onClose={() => { setShowSaar(false); lsSet('ft-saar', false) }}
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
                ['VMCA · OEI Vmcg/Vmca/Vmcl asymmetric-control margin (14 CFR §25.149 / AC 25-7D §6 / AMC 25.149 / FCTM Eng-Out)', showVmca, ()=>{ const nv=!showVmca; setShowVmca(nv); lsSet('ft-vmca', nv) }],
                ['Radar', showRadar, ()=>{ const nv=!showRadar; setShowRadar(nv); lsSet('ft-radar', nv) }],
                ['Conflict', showConflict, ()=>{ const nv=!showConflict; setShowConflict(nv); lsSet('ft-cflx', nv) }],
                ['TCAS', showTcas, ()=>{ const nv=!showTcas; setShowTcas(nv); lsSet('ft-tcas', nv) }],
                ['ACASX', showAcasx, ()=>{ const nv=!showAcasx; setShowAcasx(nv); lsSet('ft-acasx', nv) }],
                ['CPA', showCpa, ()=>{ const nv=!showCpa; setShowCpa(nv); lsSet('ft-cpa', nv) }],
                ['Diversion', showDiversion, ()=>{ const nv=!showDiversion; setShowDiversion(nv); lsSet('ft-div', nv) }],
                ['Holding', showHolding, ()=>{ const nv=!showHolding; setShowHolding(nv); lsSet('ft-hold', nv) }],
                ['Formation', showFormation, ()=>{ const nv=!showFormation; setShowFormation(nv); lsSet('ft-form', nv) }],
                ['Anomaly', showAnomaly, ()=>{ const nv=!showAnomaly; setShowAnomaly(nv); lsSet('ft-anomaly', nv) }],
                ['Glide atlas', showGlide, ()=>{ const nv=!showGlide; setShowGlide(nv); lsSet('ft-glide', nv) }],
                ['DAA-WC · Detect-And-Avoid Well-Clear · RTCA DO-365B DWC pair scorer + ACAS Xu / sXu coordination (RTCA DO-365B §2.2.4.3 / DO-366A / DO-386 / DO-389 / SC-228 / FAA UAS-NAS ConOps v3.0 / AC 90-114B / AC 91-57C / Order 8900.1 Vol 16 / ICAO Doc 10019 RPAS / Annex 2 App 4 / EASA SORA v2.5 / JARUS RPAS Manual / NASA UTM ConOps v2.0 / TM-2020-220615)', showDaaWc, ()=>{ const nv=!showDaaWc; setShowDaaWc(nv); lsSet('ft-daawc', nv) }],
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
                ['Hydraulic redundancy', showHyd, ()=>{ const nv=!showHyd; setShowHyd(nv); lsSet('ft-hyd', nv) }],
                ['Cabin egress 90s', showEgress, ()=>{ const nv=!showEgress; setShowEgress(nv); lsSet('ft-egress', nv) }],
                ['NOTAM / TFR', showNotam, ()=>{ const nv=!showNotam; setShowNotam(nv); lsSet('ft-notam', nv) }],
                ['5G C-Band / Radalt', showRadalt5g, ()=>{ const nv=!showRadalt5g; setShowRadalt5g(nv); lsSet('ft-radalt5g', nv) }],
                ['CT-Alt (cold-temp)', showCtAlt, ()=>{ const nv=!showCtAlt; setShowCtAlt(nv); lsSet('ft-ctalt', nv) }],
                ['APU / ETOPS-CR', showApu, ()=>{ const nv=!showApu; setShowApu(nv); lsSet('ft-apu', nv) }],
                ['Fuel imbalance', showFuelImb, ()=>{ const nv=!showFuelImb; setShowFuelImb(nv); lsSet('ft-fuelimb', nv) }],
                ['CSFF cold-soak frost', showCsff, ()=>{ const nv=!showCsff; setShowCsff(nv); lsSet('ft-csff', nv) }],
                ['Cargo fire / DTLD', showCargoFs, ()=>{ const nv=!showCargoFs; setShowCargoFs(nv); lsSet('ft-cargofs', nv) }],
                ['FBW law reversion', showFbw, ()=>{ const nv=!showFbw; setShowFbw(nv); lsSet('ft-fbw', nv) }],
                ['MEL / CDL dispatch', showMel, ()=>{ const nv=!showMel; setShowMel(nv); lsSet('ft-mel', nv) }],
                ['Oil consumption / IFSD', showOil, ()=>{ const nv=!showOil; setShowOil(nv); lsSet('ft-oil', nv) }],
                ['HFDL polar coverage', showHfdl, ()=>{ const nv=!showHfdl; setShowHfdl(nv); lsSet('ft-hfdl', nv) }],
                ['EHS / ELS Mode-S BDS', showEhs, ()=>{ const nv=!showEhs; setShowEhs(nv); lsSet('ft-ehs', nv) }],
                ['ARFF / RFFS Annex 14 Cat', showArff, ()=>{ const nv=!showArff; setShowArff(nv); lsSet('ft-arff', nv) }],
                ['SBAS / LPV approach', showSbas, ()=>{ const nv=!showSbas; setShowSbas(nv); lsSet('ft-sbas', nv) }],
                ['Engine vibration / FBO', showVib, ()=>{ const nv=!showVib; setShowVib(nv); lsSet('ft-vib', nv) }],
                ['Pitch-trim authority / MCAS-STS', showTrim, ()=>{ const nv=!showTrim; setShowTrim(nv); lsSet('ft-trim', nv) }],
                ['DME/DME RNAV FOM', showDme, ()=>{ const nv=!showDme; setShowDme(nv); lsSet('ft-dme', nv) }],
                ['Thrust reverser inhibit', showTRev, ()=>{ const nv=!showTRev; setShowTRev(nv); lsSet('ft-trev', nv) }],
                ['VOR MON · GPS-loss reversion', showVmon, ()=>{ const nv=!showVmon; setShowVmon(nv); lsSet('ft-vmon', nv) }],
                ['PAX O2 · chem-gen / descent', showPaxO2, ()=>{ const nv=!showPaxO2; setShowPaxO2(nv); lsSet('ft-paxo2', nv) }],
                ['ULB · CVR/FDR 90-day battery', showUlb, ()=>{ const nv=!showUlb; setShowUlb(nv); lsSet('ft-ulb', nv) }],
                ['SELCAL · ARINC 596 / HF watch', showSelcal, ()=>{ const nv=!showSelcal; setShowSelcal(nv); lsSet('ft-selcal', nv) }],
                ['ADS-C / FANS-1A contract', showAdsc, ()=>{ const nv=!showAdsc; setShowAdsc(nv); lsSet('ft-adsc', nv) }],
                ['AIRAC · FMS nav-DB currency', showAirac, ()=>{ const nv=!showAirac; setShowAirac(nv); lsSet('ft-airac', nv) }],
                ['WoW · squat-switch / air-ground', showWow, ()=>{ const nv=!showWow; setShowWow(nv); lsSet('ft-wow', nv) }],
                ['TPIS · BTMS · fuse-plug', showTpis, ()=>{ const nv=!showTpis; setShowTpis(nv); lsSet('ft-tpis', nv) }],
                ['ITP · ASEPS oceanic 1000 ft', showItp, ()=>{ const nv=!showItp; setShowItp(nv); lsSet('ft-itp', nv) }],
                ['SLOP · lateral offset (Doc 4444 §16.5)', showSlop, ()=>{ const nv=!showSlop; setShowSlop(nv); lsSet('ft-slop', nv) }],
                ['ASDE-X · surface incursion', showAsdex, ()=>{ const nv=!showAsdex; setShowAsdex(nv); lsSet('ft-asdex', nv) }],
                ['PSR/SSR · radar coverage gap', showPsrSsr, ()=>{ const nv=!showPsrSsr; setShowPsrSsr(nv); lsSet('ft-psrssr', nv) }],
                ['Fire-loop · halon reserve', showFireLoop, ()=>{ const nv=!showFireLoop; setShowFireLoop(nv); lsSet('ft-fireloop', nv) }],
                ['VAAC · volcanic-ash plume', showVaac, ()=>{ const nv=!showVaac; setShowVaac(nv); lsSet('ft-vaac', nv) }],
                ['EOSID · OEI escape & net-flight-path', showEosid, ()=>{ const nv=!showEosid; setShowEosid(nv); lsSet('ft-eosid', nv) }],
                ['LAHSO · land-and-hold-short ALD vs LDR', showLahso, ()=>{ const nv=!showLahso; setShowLahso(nv); lsSet('ft-lahso', nv) }],
                ['ROW/ROP · runway overrun warning (AC 91-79B / AC 25-32)', showRowRop, ()=>{ const nv=!showRowRop; setShowRowRop(nv); lsSet('ft-rowrop', nv) }],
                ['HIRO / RET · runway occupancy & rapid-exit selection (Annex 14 §3.10 / Doc 9157 Pt 2 §1.10 / Doc 9981 / EUROCONTROL HIRO / CAP 1378 §6 / AC 150/5300-13B §4.5 / IGOM 4.4)', showHiro, ()=>{ const nv=!showHiro; setShowHiro(nv); lsSet('ft-hiro', nv) }],
                ['HOTSPOT · runway-incursion hot-spot monitor (ICAO Doc 9870 §3.4 / Annex 14 §3.12 / Doc 9981 Pt II / Doc 4444 §7 / FAA AC 91-73B / AC 150/5340-1M / JO 7110.65 §3-7 §3-10 / FAA RIM / Jeppesen 10-9 / EUROCONTROL Hot-Spot Toolkit ed.3 / CAP 791 §6 / IGOM 4.1-4.4 / NTSB AAR-08-02 LEX)', showHspot, ()=>{ const nv=!showHspot; setShowHspot(nv); lsSet('ft-hspot', nv) }],
                ['LRAH · launch & reentry Aircraft-Hazard-Area monitor · 24-pad catalogue, T-minus countdown, AHA + downrange corridor, dynamic SDI (14 CFR Part 450 §450.101 §450.139 / FAA AC 450.139-1A / AC 91-63D / JO 7110.65 §9-3 §9-4 / JO 7210.3DD §18-9 / FAA SDI ConOps v2.0 / ICAO Annex 11 §2.20 / Doc 10039 §4 / EUROCONTROL Sub-Orb ConOps 2019 / Aerospace TOR-2018-02816 / NTSB AAR-15-02 SS2)', showLrah, ()=>{ const nv=!showLrah; setShowLrah(nv); lsSet('ft-lrah', nv) }],
                ['RFFS · ARFF category compliance monitor · req-cat vs avail-cat by ICAO Annex 14 Tbl 9-1 length/fuselage, Q1/Q2 agent deficit, vehicle count, response-time (Annex 14 §9.2 / Doc 9137 Pt 1 §2 §6 §13 / Doc 9981 Pt I ch 9 / 14 CFR Part 139.315/.317/.319 / AC 150/5210-6E / AC 150/5220-10E / Order 5200.12C / EASA CS-ADR-DSN.D.305/.310 / CAP 168 ch.8 / NFPA 403 / NFPA 412 / NFPA 414 / NTSB AAR-04-04 5481 / AAR-14-01 Asiana 214 SFO)', showRffs, ()=>{ const nv=!showRffs; setShowRffs(nv); lsSet('ft-rffs', nv) }],
                ['CWY · wake-vortex decay & encounter predictor · Burnham-Hallock vortex profile, Sarpkaya atmospheric decay, b0/2 sink, rolling-moment Cl, in-tube alert (FAA AC 90-23G / JO 7110.65 §5-5 / RECAT-EU ed.3 / ICAO Doc 4444 §5.8 / Doc 9426 §3 / EUROCONTROL EUROWAKE / CREDOS / DLR WakeNet3 / NASA TM-2008-215534 / TP-1976-1465 / Sarpkaya JA 1998 / Spalart ARFM 1998 / Hinton-Tatnall NASA TM-4768 / Holzäpfel JA 2003 / Crow AIAA 1970 / NTSB AAR-02-01 AA587)', showCwy, ()=>{ const nv=!showCwy; setShowCwy(nv); lsSet('ft-cwy', nv) }],
                ['JBLAST · jet-blast / exhaust-hazard zone monitor · Tollmien-Schlichting axisymmetric centreline decay V=6.5·D_eq·V_e/x, 11.5° Gaussian cone, regime-aware Ve (TOGA/breakaway/taxi/airborne), AGSM 56km/h + Annex-14 24kt thresholds (FAA AC 150/5300-13B §4.10 / AC 91-79B §9 / JO 7110.65 §3-1 / ICAO Annex 14 §3.4.3 / Doc 9157 Pt II §1.6 / Doc 9981 Pt II §4 / Boeing AGSM §8.4 / Airbus AGSM App B / Pope §11.5 / Schlichting §24 / IATA AHM 910 §3 / IGOM 4.1 / NTSB DCA01MA060 / DCA08IA037 / AAIB 12-2019 EGCC)', showJblast, ()=>{ const nv=!showJblast; setShowJblast(nv); lsSet('ft-jblast', nv) }],
                ['MRVA · Minimum Radar Vectoring Altitude conformance · 36-sector TRACON/APP catalogue (KJFK/EWR/LAX/SFO/DEN/ATL/ORD/BOS/DFW/PHX/SEA/LAS/SLC/ANC + LON/AMS/CDG/FRA/MUC/ZRH/MAD/FCO/HND/HKG/SIN/SYD) with terrain/obstacle floor + MVA bust scorer (FAA JO 7110.65 §5-6-3 / JO 7210.3 §7-4 / 8260.19 §8 / JO 7110.118 / Doc 4444 §8.6 / Doc 8168 Vol II Pt I §3 / Annex 11 §3.7.5 / EUROCONTROL MSA Spec ed.1.0 / EASA AMC1 SERA.8005(b) / CAP 493 §1.7 / CAP 670 RAC §3 / NTSB AAR-77-04 DL-723 BOS / NTSB AAR-08-04 EJM-748 SDL)', showMrva, ()=>{ const nv=!showMrva; setShowMrva(nv); lsSet('ft-mrva', nv) }],
                ['TURN · Turnaround critical-path monitor · per-airframe ground-service timeline (deplane → clean → fuel+cater → board → push) classified per IATA AHM-630 6-class taxonomy (WB-LONGHAUL / WB-MEDIUM / NB-180 / NB-150 / REGIONAL / BIZ), predicted off-block vs scheduled stand time, slip detection, recovery-room scoring (ICAO Doc 9082 §3.4 / Doc 9971 Pt I Ch 4 / Doc 9554 / IATA AHM 630 / AHM 633 / AHM 810 §4 / IGOM ed.13 ch.4 / EUROCONTROL A-CDM IM ed.5 §4 / EU 716/2014 PCP §AF-3 / FAA SCDM TFDM v3.0 / Boeing AMM ch.10 / Airbus ARM §1.6)', showTurn, ()=>{ const nv=!showTurn; setShowTurn(nv); lsSet('ft-turn', nv) }],
                ['DGS · Advanced Visual Docking Guidance & stand-centerline conformance · 24-stand global catalogue · azimuth/closure/stop indications per IATA AHM 621 (ICAO Annex 14 §5.3.24 / Doc 9157 Pt 4 §15 / Doc 9476 / Doc 9830 / Doc 9981 Pt II Ch 4 / IATA AHM 621 / 631 / 651 / IGOM ed.13 §4.1 / FAA AC 150/5300-13B §4.7 / EASA CS-ADR-DSN.M.690 / SAE ARP 4942 / IEC 62700 / NTSB DCA09FA098 / AAIB 5/2014 EGLL)', showDgs, ()=>{ const nv=!showDgs; setShowDgs(nv); lsSet('ft-dgs', nv) }],
                ['OLS · Obstacle Limitation Surfaces conformance · 20-runway catalogue (KJFK/LAX/SFO/ORD/ATL/DFW/BOS/SEA + EGLL/EGKK/EHAM/EDDF/LFPG/OMDB/WSSS/VHHH/RJTT) · inner-horizontal / conical / approach (2%/3000m + 2.5%/3600m) / transitional (14.3%) / take-off climb (2%/15km) / outer-horizontal penetration scorer with TERPS-grade tier escalators (ICAO Annex 14 Vol I Ch 4 §4.1 / Doc 9137 Pt 6 / Doc 9774 §3.4 / Doc 8168 Vol II Pt III §3.4 / Doc 9905 §3.5 / FAA Order 8260.3D §2-2 / Order 8260.19 §8 / 14 CFR Part 77 Subpart C / AC 150/5300-13B §3 / EASA CS-ADR-DSN.J §J.5 / AMC1 ADR.OPS.B.075 / EUROCONTROL EAD Obstacle DB ed.4 / UK CAA CAP 168 Ch.4 / CAP 738 / Doc 9981 Pt II §2 / NTSB AAR-13-02 Asiana 214 SFO / AAR-09-08 CAL-1404 DEN / AAIB EW/C2008/01/01 BA38 LHR)', showOls, ()=>{ const nv=!showOls; setShowOls(nv); lsSet('ft-ols', nv) }],
                ['AIRPROX · Risk Assessment Tool encounter classifier · pairwise CPA + ICAO severity grading A/B/C/D/E per Doc 9870 §5.4 + ESARR-2 RAT v3 · regime-aware minima (TMA/CTR 3nm·1000ft, ENR-RAD 5nm·1000ft, OCEANIC 23nm RLatSM, RVSM 5nm·1000ft) · 6 drivers SEP/CLOSURE/ACAS-RA/ASP/PILOT/CTRL · TCAS-II tau-based RA likelihood (DO-185B / DO-385) · loss-of-sep escalator · forward-projected CPA geometry + scatter dCPA·vCPA vs minima · (ICAO Doc 9870 §5.4 / Doc 4444 §15.7 §17 / Doc 9859 SMM §2.6 / Annex 13 §2.2 / ESARR-2 ed.3 / EUROCONTROL RAT v3 2018 / SCS / UK CAP 1455 UKAB / CAP 670 SUR / CAP 493 §1.7 / FAA Order 8020.11D §6 / JO 7210.632 §3 ATSAP / JO 7110.65 §2-1-6 §5-5 §5-7 / 14 CFR §830.5 / EASA AMC1 ARO.GEN.305(b) / ARINC 718A / DO-260B / DO-185B / DO-385 / NTSB AAR-09-05 Bashkirian-DHL Überlingen / NTSB AAR-02-04 Cerritos AeroMexico 498 / AAIB EW/C2018/07/01 LHR / BFU 2X004-02 / ATSB AO-2014-101 Mildura / TSB A18C0098 Toronto / JTSB AA2010-04 NRT)', showAirprox, ()=>{ const nv=!showAirprox; setShowAirprox(nv); lsSet('ft-airprox', nv) }],
                ['MEDLINK · In-Flight Medical Diversion & Trauma-Center Advisor · 11-etiology classifier + 16-hospital ACS Lvl-I trauma-center catalogue + 22-airport diversion catalogue · door-to-care composite (airborne TTF + EMS ground + taxi/hand-off) · MedAire/STAT-MD/GlobaLifeline/LH-MedOps 7-region escalation · 7 tiers DIVERT-IMM/CONS/MON · runway-cat gate per Annex 14 RFFS · (ICAO Annex 6 Pt I §6.2.2 / Doc 8984 Civil Aviation Medicine §2.6 / Annex 9 §8.16 / FAA AC 121-33B / 14 CFR §121.803 §121.805 / JO 7110.65 §10-2 / Order 8900.1 V3 Ch33 §5 / EASA AMC1 CAT.IDE.A.220 / SIB 2018-04 / IATA Medical Manual ed.13 / UK CAP 757 Annex C / CAP 666 / ACS Orange Book 2022 / TJC CSC 2024 / ACC/AHA STEMI door-to-balloon ≤90min / AHA Stroke door-to-needle ≤45min / MedAire MedLink GRC / STAT-MD UPMC / GlobaLifeline ATL / LH MedOps FRA OCC / NTSB SR-95-01 / NEJM 2013;368:2075 Peterson / JAMA 2018;320:2580)', showMedlink, ()=>{ const nv=!showMedlink; setShowMedlink(nv); lsSet('ft-medlink', nv) }],
                ['CIRC · Circling-Approach Protected-Area & Minima Conformance · 18-runway global catalogue · ICAO PANS-OPS Vol II §7.3 race-track envelope / FAA TERPS 8260.3E §2.7 · MDA(H) bust scorer · Cat-max IAS gate · sustained bank-angle proxy · 6 drivers LAT/ALT/IAS/BANK/VIS/PHASE · 5 tiers EXCURSION/UNSTABLE/PROXIMITY/WATCH/CONFORM · (ICAO Doc 8168 PANS-OPS Vol I Pt I §4.1.2 / Vol II Pt I §7.3 Amdt 13 / Doc 9905 §4.7 / Annex 6 Pt I §4.5.5 / FAA Order 8260.3E §2.7 / AC 120-108 / AC 120-71 §4 / AC 90-66B §10 / AC 91-79B §4 / 14 CFR §91.175(j) / EASA AMC1 CAT.OP.MPA.110 / CS-AWO §3 / EUROCONTROL EAPPRI ed.3 §4 / UK CAA CAP 696 / NTSB AAR-13-04 KLEX / AAR-19-02 AS3296 / AAIB EW/C2017/04/02 EGGD)', showCirc, ()=>{ const nv=!showCirc; setShowCirc(nv); lsSet('ft-circ', nv) }],
                ['VMO/MMO · Speed-envelope conformance monitor · per-airframe certificated Vmo/Mmo/Va/Vfe/Vlo/Vle/Vra/Vs scorer over 40-type catalogue (B748/B744/B77W/B772/B788/B789/B78X/B763/B764/B737/B738/B739/B38M/B39M/B752/B753 + A388/A359/A35K/A332/A333/A339/A319/A320/A321/A20N/A21N/BCS3/BCS1 + E190/E195/E170/E175/E290/E295/CRJ2/CRJ7/CRJ9 + AT72/AT76/AT45/DH8D/DH8C + GLEX/GL5T/G650/GLF6/CL60/FA8X/E55P/C25B/PC12) with ISA-modelled TAS/IAS/Mach crossover and per-altitude active-limit (lower of Vmo·KIAS and Mmo·KIAS at altitude) · 6 drivers OVR/MMO/VAS/REG/STL/CFG · §91.117 250-KIAS-below-10k bust · §25.143 Va manoeuvring exceedance · §25.253 overspeed escalator · Vs stall margin · phase-weighted (TKO/CLB/CRZ/DES/APP) · MapLibre halo+pin+label overlay + IAS·Vmo vs Mach·Mmo scatter diagnostic · (14 CFR Part 25 §25.1505 Vmo/Mmo / §25.1511 Vfe / §25.1515 Vlo·Vle / §25.143 Va / §25.253 / §25.335 Vd·Md / §25.103 stall / 14 CFR §91.117 §91.711 / EASA CS-25 Subpart B / ICAO Annex 6 Pt I §4.2.5 / Doc 9760 Vol II Pt IV / FAA AC 25-7D §31 / AC 91-79A App.B / Boeing FCOM 737/747/757/767/777/787 Vol.I §1.10 / Airbus A220/A320/A330/A350/A380 FCOM 3.01.20 / Embraer E170/E190/E2 AOM §1.04 / ATR FCOM §2.01.10 / CRJ FCM / NTSB AAR-04-04 BTA-5481 Comair / AAR-02-01 AA587 / AAR-94-04 USAir 427 / BFU 5X023-09 Egyptair 990 / TSB A05F0047 MK1602 / AAIB 4/2008 BA38 LHR)', showVmoMmo, ()=>{ const nv=!showVmoMmo; setShowVmoMmo(nv); lsSet('ft-vmommo', nv) }],
                ['ROTOR · Rotary-wing mission classifier & monitor · per-airframe rotorcraft scorer with 8-mission auto-classifier (HEMS / OFFSHORE / SAR / LE / ENG / TOUR / UTIL / EXEC / UNK) from operator-prefix + ADS-B cat-B + slow/low signature · 6 rotor-specific drivers CFIT-LL / VRS / AUTOROT (HV avoid-curve §27.79/§29.79) / WIRE / DVE / NIGHT · hard escalators VRS≥70+descending=88 / CFIT-LL≥80=86 / HV-violation=82 · 6 tiers EMERGENCY/CRITICAL/WARN/CAUTION/WATCH/NOMINAL · mission-coloured halos + pins + labels · MISSIONS/AIRCRAFT/OPERATORS tabs · (FAA-H-8083-21B Ch11/12 / 14 CFR Part 27/29/133/135 §135.601-621 / Part 136 Subpart A / Part 137 / AC 135-14B / AC 136-1 / AC 133-1B / AC 90-114B / AC 60-22 / AC 60-25C / AC 91-110 / Order 8900.1 V3 Ch20 Ch33 / ICAO Annex 6 Pt III §IV §V / Annex 12 SAR / Doc 9966 HEMS / Doc 9261 Heliport / Doc 9731 IAMSAR Vol III / Doc 9870 §6 / EASA SPA.HEMS / SPA.HOFO / SPA.SAR / SPA.NVIS / HESLO / CAP 437 / CAP 999 / TC TP 4938 / TM 1-203 / FM 3-04 §3 / API RP 2L / HSAC RP 92 / NTSB SR-13-01 HEMS / SR-19-01 air-tour / SR-19-02 CFIT / SR-94-01 wire-strike / USHST H-SE-127 / IHST SMS Toolkit ed.2 / HAI Land & Live / IS-BAH IBAC)', showRotor, ()=>{ const nv=!showRotor; setShowRotor(nv); lsSet('ft-rotor', nv) }],
                ['VRP · Visual Reporting Points & VFR corridor conformance · 36-point catalogue (NY Hudson SFRA / DC SFRA / GCN SFAR-50-2 / LAX mini-route / LHR/LGW/LCY VRPs / CDG-PAR / AMS / FRA / MUC alps / ZRH / MAD / FCO / SYD harbour / BNE / HND heli / HKG / SIN / YVR / YYZ / BOS-CapeCod / CHI lakefront / SF Bay / HNL / CPT / DXB Palm / AKL) with cross-track axis error, alt-band, squawk-code conformance + SFRA incursion scorer (ICAO Annex 11 §2.10 §3.3.2 / Annex 2 §4 / Annex 10 Vol IV §3 / Doc 4444 §16 / Doc 8168 Vol I Pt II §2 / FAA AIM 3-5-6 / JO 7110.65 §7-5 / JO 7400.2 §13-2 / 14 CFR §91.225 §91.215 / SFAR-50-2 / SFAR-71 / SFAR-77 / EASA SERA.5005 §6005 / CAP 413 §4 / CAP 493 §5 / DFS DSNA ENR 6 / NTSB AAR-09-04 Hudson midair)', showVrp, ()=>{ const nv=!showVrp; setShowVrp(nv); lsSet('ft-vrp', nv) }],
                ['PAPI/VGSI · visual glide-slope deviation (Annex 14 §5.3.5)', showPapi, ()=>{ const nv=!showPapi; setShowPapi(nv); lsSet('ft-papi', nv) }],
                ['STEEP · approach approval & configuration (AC 25-29 / SC-D-04)', showSteep, ()=>{ const nv=!showSteep; setShowSteep(nv); lsSet('ft-steepappr', nv) }],
                ['MORA · Grid-MORA / OROCA terrain clearance', showMora, ()=>{ const nv=!showMora; setShowMora(nv); lsSet('ft-mora', nv) }],
                ['STAR · descend-via speed/alt constraints', showStar, ()=>{ const nv=!showStar; setShowStar(nv); lsSet('ft-star', nv) }],
                ['Engine start envelope', showStart, ()=>{ const nv=!showStart; setShowStart(nv); lsSet('ft-start', nv) }],
                ['O₂ supply duration', showO2dur, ()=>{ const nv=!showO2dur; setShowO2dur(nv); lsSet('ft-o2dur', nv) }],
                ['CTAC · cold-temp altitude correction', showCtac, ()=>{ const nv=!showCtac; setShowCtac(nv); lsSet('ft-ctac', nv) }],
                ['CCM · Callsign Confusion Monitor · same-airline confusable pairs (ICAO Doc 9870 ch.5 / Doc 4444 §12.3.4.6 / Annex 10 Vol II §5.2.1.7 / EUROCONTROL AGC SCST 2018-12 / FAA JO 7110.65 §2-4-20 / AC 90-117 §8 / CAP 745 §6 / NTSB AAR-95-05 AAL1572 BDL)', showCcm, ()=>{ const nv=!showCcm; setShowCcm(nv); lsSet('ft-ccm', nv) }],
                ['Electrical / IDG / Bus-tie / RAT', showElec, ()=>{ const nv=!showElec; setShowElec(nv); lsSet('ft-elec', nv) }],
                ['NGS / OBIGGS inerting', showNgs, ()=>{ const nv=!showNgs; setShowNgs(nv); lsSet('ft-ngs', nv) }],
                ['Autoland / LVO', showAutoland, ()=>{ const nv=!showAutoland; setShowAutoland(nv); lsSet('ft-autoland', nv) }],
                ['GADSS / ELT-DT tracking', showGadss, ()=>{ const nv=!showGadss; setShowGadss(nv); lsSet('ft-gadss', nv) }],
                ['EFVS / HUD § 91.176', showEfvs, ()=>{ const nv=!showEfvs; setShowEfvs(nv); lsSet('ft-efvs', nv) }],
                ['IRS / ADIRU drift', showIrs, ()=>{ const nv=!showIrs; setShowIrs(nv); lsSet('ft-irs', nv) }],
                ['RCAM / TALPA braking', showRcam, ()=>{ const nv=!showRcam; setShowRcam(nv); lsSet('ft-rcam', nv) }],
                ['MLAT / WAM TDoA surveillance', showMlat, ()=>{ const nv=!showMlat; setShowMlat(nv); lsSet('ft-mlat', nv) }],
                ['PBCS · RCP / RSP', showPbcs, ()=>{ const nv=!showPbcs; setShowPbcs(nv); lsSet('ft-pbcs', nv) }],
                ['Vapp advisor', showVapp, ()=>{ const nv=!showVapp; setShowVapp(nv); lsSet('ft-vapp', nv) }],
                ['GLS / GBAS availability', showGls, ()=>{ const nv=!showGls; setShowGls(nv); lsSet('ft-gls', nv) }],
                ['ILS critical / sensitive area', showIlsCs, ()=>{ const nv=!showIlsCs; setShowIlsCs(nv); lsSet('ft-ilscs', nv) }],
                ['PRM / SOIA · NTZ breach', showPrm, ()=>{ const nv=!showPrm; setShowPrm(nv); lsSet('ft-prm', nv) }],
                ['SAAR · RNP-AR Approach Conformance · 18-procedure SAAR catalogue (KPSP/KEGE/KASE/KSUN/KJAC/KMMH/KSAN/KDCA/KORD/KJFK/PANC/PAJN/CYLW + LSGS/LOWI/LFLB/ENBR/RJAF) · Radius-to-Fix arc containment + RNP 0.10/0.15/0.20/0.30 lateral + baro-VNAV temp limits + missed-approach RNP + dual-FMS/dual-GNSS eligibility · 6 drivers LAT/RF/TMP/ELG/STB/ALT · 6 tiers INCURSION/GO-AROUND/DEVIATION/WATCH/CONFORM/OUT (FAA AC 90-101A §10.4 §11.6 App D / AC 90-105A / 14 CFR §91.205 §97 §121.353 §135.165 / ICAO Doc 9905 Vol II Pt B Table II-A-3-1 §3.3 §3.5 / Annex 6 Pt I §4.5.7.5 / Annex 11 §2.27 §3.7.5 / Doc 8168 PANS-OPS Vol II Pt III §3.1 §3.3 §3.6 / Doc 9613 Vol II PBN Manual §3 §C-5 / EASA AMC 20-26 / SPA.PBN.105 / Decision 2016/021/R / UK CAP 1385 §3 / CAP 670 SUR §5 / EUROCONTROL PBN Spec 2020 §6.4 / Boeing FCOM 11.40 / Airbus PRO-NOR-SOP-19 / ARINC 424-21 §5.10-5.16 / NTSB AAR-13-02 Asiana 214 SFO / AAIB EW/C2017/04/02 EGGD / ATSB AO-2018-016 Mildura)', showSaar, ()=>{ const nv=!showSaar; setShowSaar(nv); lsSet('ft-saar', nv) }],
                ['CZNE · Conflict-Zone & Airspace-Restriction Overflight Advisor · 18-zone catalogue (UKBV / RUEU / SYRI / IRAQ / IRAN / YEMI / LIBY / SUDA / SSDN / LEBN / GAZA / SOMA / MALI / DPRK / ETHI / NIGR / MYAN / VENZ) AVOID/DISCR/CAUTION threat bands with FL floor/ceiling + FIR-envelope polygon + sanctioned-operator pinning · 6 drivers INZ/ALT/DWL/PRX/OPR/RTE with forward-projected dwell minutes · 5 tiers CRITICAL/HIGH/ELEVATED/GUARDED/CLEAR · MapLibre zone fill+boundary+halo+pin+label overlay · AIRCRAFT/ZONES tabs · (EASA CZIB portal v2024 / EASA SIB 2022-05R3 / EU Reg 376/2014 / 14 CFR §91.703 §91.711 / FAA SFAR 77/79/81/110/112/113/114/116/117 / FAA AC 91-70B ch.10 / ICAO Annex 11 §2.18 / Annex 15 §5.1 / Doc 4444 §16 / Doc 10084 CZ-RAM / ICAO C-WP/14533 post-MH17 / UK CAA Overseas Territories Ops Notices 2024 / CAP 1864 / IATA Safety Issue Hub Q1 2025 / Dutch Safety Board MH17 §5 / ATSB AO-2014-110 / BFU 5X008-14)', showCzne, ()=>{ const nv=!showCzne; setShowCzne(nv); lsSet('ft-czne', nv) }],
                ['CAST · CAST/SE Top-Accident-Category Susceptibility Monitor · per-airframe real-time scorer against the CAST/ICAO CICTT 8-category top-accident taxonomy LOC-I (Loss of Control In-flight) / CFIT (Controlled Flight Into Terrain) / RE (Runway Excursion) / MAC (Mid-Air Collision incl NMAC) / SCF-PP (System/Component Failure Powerplant) / ARC (Abnormal Runway Contact) / WSTRW (Weather/Wake/Windshear Encounter) / USOS (Undershoot/Overshoot)', showCast, ()=>{ const nv=!showCast; setShowCast(nv); lsSet('ft-cast', nv) }],
                ['BLKHOL · Black-Hole / featureless-terrain night-approach visual-illusion monitor · 20-runway catalogue (PHNL/PHOG/PHTO/KSAN/PANC/PAJN/KEGE/KASE/KJAC/KMMH/KSUN/KCRP/KEYW/SBSP/VOMM/OERK/RJSN/CYYR/SCEL/CYHZ) tagged with approach bearing + terrain class (WATER/DESERT/VALLEY/SUBARCTIC/MIXED) + ambient-light index 0-10 + dark-NM over final + PAPI/HUD equipage · per-airframe night-approach scorer for the FAA-H-8083-25B Ch.17 black-hole illusion in which absence of foreground visual cues induces a shallower-than-normal approach + short-touchdown CFIT · 6 drivers ILL (illusion-source magnitude from ambient-light gap + dark-NM + over-water boost) / PROF (signed deviation below ideal 3.0° GPA = atan(VS/GS_fps), positive=shallow is the canonical black-hole symptom) / ENRG (energy-low V/Vref proxy on final per AC 120-71) / LUMA (synthetic lunar-phase + subarctic boost) / EXP (operator night-approach experience proxy FLAG/MAJOR=low / LCC/CARGO=med / BIZ/GA=high) / EQUIP (PAPI/VASI -20pts / HUD -18pts mitigations) · composite max·0.65 + mean·0.35 × ADV-MUL · hard escalators sustained PROF≥70 → score-min 84 (go-around per AIM 8-1-5) / ILL≥70+PROF≥35 → 78 / energy-low advisories · 6 tiers CRITICAL/HIGH/ELEVATED/WATCH/NOMINAL/IDLE · only-at-night gate via solar-position from UTC+lng+offset · MapLibre dark-terrain envelope polygons (sector length=darkNM × halfwidth 1.2NM, opacity scaled by dark-index 1-10) + tier-coloured halo+pin+dashed link aircraft→threshold + runway markers with terrain-coloured DARK index labels + cs/rwy/GPA/tier symbol labels · AIRCRAFT/RUNWAYS/TERRAIN tabs · 4 sliders SCOPE 5-60NM / GPA-IDEAL 2.5-4.0° / ADV-MUL / UTC-OFF ±6h · 5-terrain chip filter · HALO/PIN/ENV/LINK/LBL toggles · (FAA-H-8083-25B Pilot Hbk Ch.17 §Visual Illusions Leading to Landing Errors / FAA AIM 8-1-5 Black-Hole Approach / AC 60-22 §10 ADM / AC 60-25C Pilot Vision / AC 120-71 §4 / AC 91-79B App.1 / NASA TM-2003-212279 / NASA CR-2010-216868 / ICAO Annex 6 Pt I §4.3.4 / Doc 9683 HF Trg Manual Ch.3 / Doc 9870 §6 / NTSB AAR-93-04 GP-Express Anniston / AAR-92-04 KAL-803 Tripoli / AAR-15-02 UPS-1354 BHM / AAR-78-08 PSA-182 / AAIB EW/G2014/06/02 Glasgow / ATSB AO-2010-019 Norfolk Island / Boeing FCTM 5.50 / Airbus Getting-to-Grips-Approach §4 / FSF ALAR Toolkit Briefing 5.3 5.4)', showBlkhol, ()=>{ const nv=!showBlkhol; setShowBlkhol(nv); lsSet('ft-blkhol', nv) }],
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
                ['SAF · CORSIA / ReFuelEU', showSaf, ()=>{ const nv=!showSaf; setShowSaf(nv); lsSet('ft-saf', nv) }],
                ['VOLMET · HF/VHF met broadcast', showVolmet, ()=>{ const nv=!showVolmet; setShowVolmet(nv); lsSet('ft-volmet', nv) }],
                ['PIREP · pilot-report geo-correlation & decay (AC 00-45H / AIM 7-1-21 / Annex 3 §5)', showPirep, ()=>{ const nv=!showPirep; setShowPirep(nv); lsSet('ft-pirep', nv) }],
                ['SIGMET/AIRMET · MWO hazard polygon penetration (Annex 3 App 6 / AIM 7-1-6/7/8)', showSigmet, ()=>{ const nv=!showSigmet; setShowSigmet(nv); lsSet('ft-sigmet', nv) }],
                ['TCAM · Tropical Cyclone Avoidance & Eye-Wall Standoff · R64/R50/R34 wind-radii + Saffir-Simpson / JMA / IMD severity + forecast-cone convergence (ICAO Annex 3 App 1 §1 / App 5 TCAC / Doc 9817 §3.7 / Doc 9874 / WMO 1194 §4.6 / NHC SSHWS 2012 / JMA RSMC Tokyo / IMD RSMC New Delhi / BOM TCOP / MFR La Réunion / FAA AC 00-24C §11 / AC 00-45H §5 / Boeing FCTM 5.50-5.51 / Airbus GTG Adverse Weather §6 / IATA FCG-005 §4 / NHC TCR Hugo 1989)', showTcam, ()=>{ const nv=!showTcam; setShowTcam(nv); lsSet('ft-tcam', nv) }],
              ]},
              {group:'Analysis', items:[
                ['TEM · Total Energy Management · specific energy height He = h + V²/(2g) and specific excess power SEP scorer (Rutowski JAS 1954 / Bryson J.Aircraft 1969 / Anderson AFD 6e §6.3 / Etkin & Reid §3.6 / Hale Aircraft Performance §8 / FAA AC 120-71B stabilised approach / IATA Doc 9920 / FAA-H-8083-3C Ch 8 / Boeing FCTM Energy Mgmt / Airbus FCTM PRO-APPR Energy) · per-class HVY/NB/RGN-J/RGN-T/BIZ/LIGHT envelope · phase gate CRZ/CLB/DESC/APP-INT/APP-STAB/LVL-BUST · target He bands ±15m (FAF) / ±60m (intercept) / ±30m (cruise) · 8 drivers DELHE DELSEP DUMP FAST SLOW HIGH LOW ALPHA · 5 tiers DEPLETED/EXCESS/DRIFT/TRACK/OPTIMAL · MapLibre tier-coloured halo+pin+SEP-trend vector + ΔHe labels · side panel sliders ADV-MUL BAND VAPP MIN-FL MAX-FL + 6-class chip filter + HALO/PIN/LBL/VEC toggles + AIRCRAFT/CLASSES/ENERGY tabs · ENERGY tab SVG He-isocurve diagram (V_TAS m/s × altitude ft) with per-class iso-He lines + fleet dots + target marker · hard escalators ΔHe<-30m@AGL<1000ft 92 / ΔHe>+60m@APP-STAB 84 / |SEP|>redline 80 · ft-tem persisted preference', showTem, ()=>{ const nv=!showTem; setShowTem(nv); lsSet('ft-tem', nv) }],
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
                ['Fuel tankering', showTanker, ()=>{ const nv=!showTanker; setShowTanker(nv); lsSet('ft-tanker', nv) }],
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
                ['GLD · Glide-Reach & All-Engines-Out Footprint Monitor · per-airframe deadstick reachability scorer computing maximum-glide ground-track footprint from current FL and weight assuming total propulsion loss (twin double-flameout or quad multi-failure: fuel-exhaustion / dual bird-strike / volcanic-ash core-stall / fuel-contamination) and identifying reachable diversion airports for immediate engines-out forced landing · canonical AEO emergency precedent set Air Canada 143 Gimli Glider 1983 / Air Transat 236 Azores Glider 2001 / US Airways 1549 Hudson 2009 / British Airways 9 KLM volcanic-ash 1982 / KLM 867 Redoubt 1989 / TACA 110 hail 1988 · 7-class L/D catalogue HVY 18 (B748/B77W/B789/A388/A359) / WB-M 17 (B763/A332/A339) / NB 17 (B738/A320/A21N/B752) / RGN-J 16 (E190/E295/CRJ9) / RGN-T 14 (AT72/DH8D/Q400) / BIZ 18 (GLEX/G650/GLF6/FA8X) / LIGHT 12 (C25B/PC12) per Boeing 767 PEH §3.30 / Airbus A320 FCOM PRO-ABN-80 · still-air glide R_NM = (FL_kft - 1.5) × L/D × 0.1645 per NASA TN D-6573 · wind-corrected R along bearing b = R_still × (1 + W_along/Vbg) with class-specific Vbg best-glide TAS · 36-vertex glide footprint polygon generated per airframe with wind drift offset · reachable airport selection from full ICAO catalogue with margin computation R_b − distance · 6 risk drivers RNG reachable-airport-count (0=90 / 1=65 / 2-3=40 / 4-6=20 / >6=8) / PROX margin-to-nearest-runway (>50%R=8 / >30%R=22 / >15%R=42 / >5NM=60 / else=82) / RWY runway-adequacy proxy / ALT altitude margin (FL35+=10 / FL25+=22 / FL15+=38 / FL10+=55 / else=75) / WIND headwind/tailwind asymmetry / TERR over-water proxy from nearby-airport density (0=80 / 1=55 / 2-3=30 / >3=10) · composite max-driver × 0.62 + mean × 0.38 × ADV-MUL · hard escalators no-airport-in-envelope ≥ 86 / margin <5NM ≥ 70 · 6 tiers DITCH-IMM no airport reachable rose prepare ditching per AC 91-44 AIM 6-3-3 FAA-H-8083 Ch.18 / DITCH-CONS marginal field only rose-pink plan ditching backup / MAY-REACH single suitable airport amber brief crew immediately / ADEQUATE multiple airports sky best-glide Vmd / COMFORTABLE abundant divert options emerald / IDLE on-ground FL<5 · MapLibre overlay 36-vertex tier-coloured glide-footprint polygons (top-12 worst) + emerald reachable-airport pins inside footprints + tier-coloured aircraft→best-divert connector lines + tier-coloured halo rings 8-22px by score + rose pins DITCH-IMM/CONS + cs/best-icao/range/tier labels · AIRCRAFT/CLASSES/TABLE tab switcher · AIRCRAFT tab sorted tier-worst-first with cs+type+class-pill+L/D pill+tier-pill plus FL/RNG/REACH-count/MARG/BEST/BRG/DIST rows plus tier-coloured score bar plus 6-driver chips RNG PROX RWY ALT WIND TERR plus reachable-airport chip strip top-5 plus tier-coloured rationale notes · CLASSES tab grouped by 7-class with class-pill L/D Vbg ac-count mean-RNG mean-SCORE worst-tier plus class-specific precedent reference italic · TABLE tab compact 100-row CS KL FL R-NM REACH BEST MARG SCORE table · 5 sliders SCOPE-FL 50-450 / GLIDE-MUL 60-140% / WIND-MUL 0-200% / MIN-RWY 2500-8000ft / ADV-MUL 50-200% · 7-class chip filter HVY/WB-M/NB/RGN-J/RGN-T/BIZ/LIGHT · FP/PIN/LINK/LBL toggles · search by callsign / type / divert icao · synthetic deterministic wind aloft from icao24-hash + jet-stream alt amplification ±60kt · References Boeing 767 PEH §3.30 all-engines-out flight (Gimli Glider precedent) / Boeing FCOM 11.20 unscheduled fuel-jettison and AEO / Airbus A320 FCOM PRO-ABN-80 all engines flame out / Airbus A330/A340 FCOM 3.02.70-08 fuel-emergency / FAA AC 25-7D §31 high-altitude flight test / AC 91-79B Runway Overrun Prevention / AC 91-44 ditching / FAA-H-8083-3C Airplane Flying Handbook Ch.18 emergency procedures / FAA-H-8083-25B Ch.16 / AIM 6-1-2 6-3-3 emergency communications and ditching / ICAO Annex 6 Pt I §4.3.7 forced-landing planning / Doc 9760 §III App.A glide-distance computation / NASA TN D-6573 glide-distance computation / NASA TR R-3 / NTSB AAR-10-03 US Airways 1549 Hudson dual bird-strike / TSB A01H0004 Air Transat 236 Azores fuel exhaustion / CASB CASB-83-A0019 Air Canada 143 Gimli Glider / AAIB EW/A1/1/1/1/82 BA-9 volcanic-ash dual-flame-out / NTSB AAR-89-08 KLM-867 Redoubt volcanic-ash / FSF ALAR Briefing 4.1 · GLD entry registered in Layers Analysis category after Lightning/HIRF before BREG, ft-gld persisted preference', showGld, ()=>{ const nv=!showGld; setShowGld(nv); lsSet('ft-gld', nv) }],
                ['CIRCAD · Crew Circadian Fatigue & Window-of-Circadian-Low Monitor · per-airframe SAFTE-FAST biomathematical fatigue scorer with two-process Borbély-Achermann circadian model (acrophase 17:30 / nadir 05:30 per Folkard-Åkerstedt 1987) + homeostatic Hursh reservoir from deterministic per-ICAO24 hash-driven FDP start (0.5..maxFDP+1.5h) + prior-sleep (3..9h) + Samn-Perelli 7-pt sleepiness mapping + WOCL window 02:00-05:59 local (Doc 9966 App.B) · 12-class crew-rule catalogue NB-DOM/NB-INT/NB-NIGHT/WB-MED/WB-LH/WB-ULR/RGN-J/TURBO/BIZ/CARGO-LH/HEMS/CHARTER with max-FDP/pilots/WOCL-encroachment cap (8-17h) tagged to FAR-117 Table B / EASA ORO.FTL.205 / CAP 371 / NBAA Duty-Rest 2018 / AC 135-14B / FAR 121.523 ULR · auto-classifier from ICAO type + callsign/operator prefix (MED→HEMS, FDX/UPS/CLX→CARGO-LH, EJA/LXJ/VJT→BIZ, B748/A388/B789 augmented→WB-ULR/WB-LH) · localHr from longitude+UTC, effectiveness E = max(0,R+C) clipped 0-120, SP = round(7-E/20) · 6 risk drivers max·0.66+mean·0.34 EFF/WOCL/FDP/AWAKE/SLEEP/ULR with ADV-MUL+FDP-MUL+WOCL-MUL sliders · 7 tiers RED-LINE≥85 rose STOP-FLIGHT / CRITICAL≥70 rose-pk augmented-rest / ELEVATED≥55 amber / CAUTION≥35 sky / ALERT≥18 emerald / FRESH<18 slate / IDLE · MapLibre overlay tier-coloured halo+class-coloured inner-ring + RED-LINE/CRITICAL rose pins + amber dashed WOCL bracket on in-window aircraft + cs+SP-pill+tier labels · CREWS/CLASSES/RHYTHM tabs · CREWS tier-sorted row stack with cs+type+class-pill+SP-tier-pill + LCL-hr+WOCL-flag+AWK+FDP+SLP row + Eff/FDP%/Score chips + tier-coloured score bar + 6-driver breakdown + tier-coloured advice citing regulatory ref · CLASSES per-rule row showing pilots+maxFDP+WOCL-cap+citation italic + ⌀-SP + RED+CRIT count · RHYTHM SVG 24-hr two-process curve with amber WOCL band 02-06 + ★ acrophase + ▼ nadir + fleet aircraft plotted as tier-coloured dots at (localHr,E) coords + picked aircraft callout + 3-cell summary · (ICAO Doc 9966 FRMS Manual 2e App.B / App.C · ICAO Annex 6 Pt I §4.10 · ICAO Doc 9859 ed.4 ch.9 · IATA/ICAO/IFALPA FRMS Implementation Guide 2e · 14 CFR Part 117 §117.13/.17/.19/.21/.23/.25/.27 + Table B · 14 CFR 121.471/.481/.523 · 14 CFR 135.267 · FAA AC 117-3 · AC 120-103A · AC 135-14B §6 · EASA Reg (EU) 2016/1199 ORO.FTL.205/.235/.250 · EASA CS-FCD App.1 · EASA AMC1 ORO.FTL.205(b) · UK CAA CAP 371 Sch.10-11 · CAP 1185 · ORS4 1390 · TC TP-13950 · CASA CAO 48.1 · NBAA Duty-Rest 2018 · ATSB AR-2019-008 · NTSB AAR-09-03 Colgan 3407 · AAR-15-01 UPS 1354 BHM · Hursh et al. ASEM 75-3 2004 SAFTE · SAFTE-FAST Tech Doc IBR v4.3 · Borbély-Achermann JBR 14-6 1999 · Folkard-Åkerstedt APS 1987 · Samn-Perelli USAF SAM 82-21 · ICAO Cir 351 2020)', showCircad, ()=>{ const nv=!showCircad; setShowCircad(nv); lsSet('ft-circad', nv) }],
                ['BREG · Breguet Specific-Range & Cruise-Efficiency Optimizer · per-airframe parametric drag-polar + TSFC model computing SR [NM/kg-fuel], current FF [kg/hr], MRC (Maximum Range Cruise) Mach maximising M·(L/D), LRC (Long-Range Cruise) at 99%-MRC, Cost-Index optimum Mach (CI 0-500 kg/min slider), and optimum FL · 36-type catalogue (B738/A320/B789/A359/B77W/A388/E190/CRJ9/ATR/Q400/GLEX/G650 etc.) with class-specific drag polar CD = CD0 + k·CL² + ΔCD_wave(M, Mcrit) (Lock-style wave-drag rise per Mason Configuration Aero Ch 8 + Boeing PEM §3) · Mach-corrected TSFC = SFC0·(1+0.16·M) per Roskam Pt VI / Mattingly §8 · ISA atmosphere with TAS/Mach/CL/CD numerical brute-force optimisation over Mach 0.55-0.92 · weight estimator deterministic per ICAO24 hash between OEW + typical-payload and MTOW with WT-MUL 70-130% slider · 6 tiers WASTE/POOR/OK/GOOD/OPTIMAL based on SR/MRC ratio · burn-penalty %: (FF_current - FF_LRC) / FF_LRC · MapLibre overlay class-coloured halo rings 7-19px by tier + WASTE/POOR pins + cs δ% pen% labels · AIRCRAFT/CLASSES/POLAR tabs · POLAR tab renders SR-vs-Mach curve with Mcrit/Mmo reference lines + MRC/LRC/CI/CUR markers · (Breguet 1923 · Anderson Aircraft Performance & Design §5 · Hale §5 · Roskam Airplane Design Pt VI Ch 3-4 · Mason Configuration Aero Ch 8 · Mattingly Aircraft Engine Design §8 · Boeing 737/777/787 PEM §3 §4 · Boeing FCOM PI-22 LRC tables · Airbus Getting to Grips with Fuel Economy §1.3 §2.1 · Airbus Getting to Grips with the Cost Index ed.2 · EUROCONTROL BADA 3.15 / 4.2 · ICAO Doc 9889 §A.3)', showBreg, ()=>{ const nv=!showBreg; setShowBreg(nv); lsSet('ft-breg', nv) }],
                ['OLD · Operational Landing-Distance & Runway-Stop-Margin Monitor · per-airframe Required Landing Distance vs Landing-Distance-Available scorer across 24-runway hub catalogue (KJFK 04R / KLAX 25L / KORD 10C / KATL 09L / KDFW 17C / KSFO 28L / KSEA 16L / KDEN 16R / KBOS 04R / KMDW 31C / CYYZ 05 / EGLL 27L / EGKK 26L / EHAM 18R / EDDF 25C / EDDM 26R / LFPG 26R / LSZH 14 / LIRF 16L / LEMD 32L / OMDB 12L / WSSS 02L / VHHH 07L / RJTT 34L) with explicit LDA/elev/landing-heading/slope · 42-type aircraft certification table (B737/B738/B739/B38M/B39M/A319/A320/A321/A20N/A21N narrowbody · B763/B764/B772/B77L/B77W/B788/B789/B78X/B744/B748/A332/A333/A338/A339/A359/A35K/A388 widebody · E170/E75L/E190/E195/E290/E295/CRJ2/CRJ7/CRJ9/CRJX regional · AT72/AT76/DH8D turboprop · GLEX/GL5T/G650 business) with certified ALD-dry and Vref/MLW · RLD = ALD_dry × dispatch_factor (1.67× dry / 1.92× wet per 14 CFR §121.195(d)/(e)) × RWYCC multiplier × wind × slope × density-altitude · 8-code RWYCC table per FAA TALPA ARC / ICAO GRF (6 Dry 1.00× / 5 Wet 1.15× / 4 Slush≤3mm 1.40× / 3 Compacted-snow 1.65× / 2 Standing-water 2.00× / 1 Ice 2.50× / 0 Wet-ice prohibited / U Unknown 1.92×) · wind correction −5%/10kt headwind +50%/10kt tailwind per AC 91-79B App 1 · slope +10% per 1% downslope per AC 25-32 · density correction RLD ∝ 1/σ via ISA atmosphere · runway-snap via great-circle distance within SCOPE 8-80NM + bearing-gate within TRK-GATE 15-90° of landing heading + alignment check · 6 tiers OVERRUN<0% rose / CRITICAL<10% rose-pink / MARGINAL<25% amber / ADEQUATE<50% sky / COMFORTABLE<75% emerald / AMPLE≥75% slate · phase classifier APPR/TMA/DES/CRZ/GND with only approach-phase aircraft scored · MapLibre overlay tier-coloured halo rings 8-18px sized worst-first + OVERRUN/CRITICAL rose pins + dashed link lines aircraft→runway + tier-coloured cs/apt/rwy/margin% labels · AIRCRAFT/RUNWAYS/RWYCC tab switcher · AIRCRAFT tab sorted worst-tier-first with cs+type+phase+tier pills + apt/rwy/dist/RLD/LDA/margin% row · RUNWAYS tab per-runway with LDA/elev/hdg + per-aircraft chip cluster · RWYCC tab clickable contamination-code selector with multiplier and surface description · SCOPE/TRK-GATE/BRK-MUL 70-150%/WIND ±20kt sliders + DSP dispatch-factor toggle + HALO/PIN/LBL toggles + search by callsign/type/operator/airport/tier · (FAA Order 8900.1 Vol 4 Ch 3 §1 / FAA AC 25-32 Landing Performance Data for Time-of-Arrival Landing Performance Assessments / FAA AC 91-79B Runway Overrun Prevention / FAA AC 150/5200-30D Airport Field Condition Assessments and Winter Operations Safety / FAA SAFO 19001 Landing Performance Assessments / FAA SAFO 06012 Landing Performance Assessments at Time of Arrival / 14 CFR §121.195 Airplanes: Turbine engine powered: Landing limitations: Destination airports / 14 CFR §25.125 Landing distance / 14 CFR §135.385 Large transport category airplanes: Turbine engine powered: Landing limitations: Destination airports / ICAO Doc 9981 PANS-Aerodromes Pt I Global Reporting Format GRF / ICAO Annex 6 Pt I §4.2.8 §5.2.10 / ICAO Annex 14 Vol I §2.9 Aerodrome data: Runway surface conditions / EASA Part-CAT CAT.POL.A.230 Landing — Dry runways / CAT.POL.A.235 Landing — Wet and contaminated runways / EASA AMC1 CAT.OP.MPA.300 Approach and landing conditions / Boeing FCOM PI-LAND.20 series / Boeing OPT Onboard Performance Tool / Airbus FCOM PER-LDG-10 In-flight performance / Airbus Getting to Grips with Aircraft Performance §3.5 / Airbus Getting to Grips with Cold Weather Operations §6 / NTSB AAR-08-02 Southwest 1248 KMDW 2005 / NTSB AAR-22-02 / TSB A05H0002 Air France 358 CYYZ 2005 / AAIB EW/C2008/01/01 BA38 EGLL / DGCA SpiceJet SG6237 BLR 2020)', showOld, ()=>{ const nv=!showOld; setShowOld(nv); lsSet('ft-old', nv) }],
                ['NEMO · Network ETA & OTP Monitor with IATA AHM-730 Delay-Code Classifier · per-airframe airborne arrival predictor over 28-hub global catalogue (KJFK/KLAX/KORD/KATL/KDFW/KSFO/KSEA/KBOS/KEWR/KMIA/CYYZ/EGLL/EGKK/EHAM/EDDF/EDDM/LFPG/LSZH/LIRF/LEMD/LEBL/OMDB/OMAA/WSSS/VHHH/RJTT/RJAA/YSSY) · ETA = cruise + 3°-descent + decel + TMA-saturation overhead minus ANSP-absorption capacity · STA from 5-tier punctuality (A-Tier 82% legacy / B-Tier 76% / C-Tier 68% LCC / D-Tier 71% US-dom / E-Tier 64% regional per CODA 2024 + BTS Form 234) with deterministic slack jitter · delay drivers TIME/WX/ATFM/SAT/CFW/ROT composite max·0.62 + mean·0.38 · 6 tiers CANCEL/SEVERE/MAJOR/MODERATE/MINOR/ON-TIME mapped to delay-band 180/120/60/30/15min · 27-code AHM-730/SCAP classifier (06-Reactionary/11-12-Late-pax/16-17-Comm-Cater/23-25-Handling/31-32-Cargo/37-Doc/41-Tech-AOG/51-Damage/61-FOC/71-72-75-WX/81-83-84-ATFM/85-Sec/87-89-Airport/93-Rotation/94-95-Crew/97-Industrial/99-Cancel) with hold-pattern detector + curfew-window matcher + emergency-squawk override · MapLibre overlay tier-coloured halo+pin+link with hub-cluster markers + holding-ring annotations · (IATA AHM-730/SCAP 2024 · IATA WSG ed.32 §8.7 · EUROCONTROL CODA Punctuality 2024 · EUROCONTROL NOP 2024-2028 §5 · ICAO Doc 9971 Pt I §6.3 · ICAO Doc 4444 §6.5 · FAA TBFM Concept of Use v3 · FAA TFMS/TFDM EOBT-TOBT-TTOT chain v2.1 · FAA Order JO 7210.3DD ch.17 · BTS Form 234 B43 · EU Reg 261/2004 · EU Reg 80/2009 · UK CAA CAP 1862 NATS XMAN · SESAR PJ.07 SWIM FF-ICE/R1 §5)', showNemo, ()=>{ const nv=!showNemo; setShowNemo(nv); lsSet('ft-nemo', nv) }],
                ['DOC · Direct Operating Cost & Breakeven Load-Factor Estimator · per-airframe trip economics computing the canonical DOC decomposition (Fuel+Crew+Maintenance+Ownership+Nav+Landing+Handling+Insurance), unit-cost CASM (Cost per Available Seat Mile) and CASMx (ex-fuel), Breakeven Load Factor BELF = CASM / RASM and per-trip net profit · 38-type catalogue WB-LH/WB-M/NB/RGN-J/TURBO/BIZ (B748/B744/B77W/B772/B788/B789/B78X/A388/A359/A35K/A332/A333/A339/B763/B737/B738/B739/B38M/B39M/B752/A319/A320/A321/A20N/A21N/BCS3/E190/E195/E290/E295/CRJ7/CRJ9/AT72/DH8D/GLEX/G650) per ICAO Doc 9082 9th ed. App.C + IATA ACMG 2024 + US DOT BTS Form 41 Schedule P-5.2 + EUROCONTROL CRCO 2024 + ACI Airport Charges 2024 with hourly rates for crew/maint/ownership/insurance + LRC fuel-burn kg/hr + MTOW/seats · FUEL ¢/kg + LF-ASSUMED % + YIELD ¢/ASM + ADV-MUL % + MIN/MAX-FL sliders · 6 BELF tiers PROFIT (Δ≥+15pp emerald) / MARGIN (≥+5pp sky) / AT-BE (|Δ|<5pp amber) / BLEED (-15..-5pp rose-pink) / LOSS (≤-15pp rose) / IDLE (on-ground/<FL050 slate) · MapLibre overlay tier-coloured halo+class-coloured-inner-ring + LOSS/BLEED rose pins + CASM ¢/BELF % labels · class chip filter WB-LH/WB-M/NB/RGN-J/TURBO/BIZ + HALO/PIN/LBL toggles + search by callsign/type/operator/class · AIRCRAFT/CLASSES/BREAKDOWN tabs · AIRCRAFT tier-sorted with CASM/CASMx/BELF/Δ-LF cells + DOC-fraction chips + Pax-BE/Net-trip + tier-advice line · CLASSES per-class mean CASM/BELF/Δ + 5-tier sub-counter · BREAKDOWN 8-component stacked bar visualising Fuel/Crew/Maint/Owner/Nav/Landing/Handling/Ins composition with $/blk-hr legend + DOC/BLK/$-hr/CASM/CASMx/BELF/Pax-BE/Trip-net/Dist summary grid · (ICAO Doc 9082 App.C · Doc 9161 Pt II · IATA ACMG Cost Report 2024 · IATA Economic Reports H1/H2 2024 · IATA Jet Fuel Price Monitor Q1 2026 · US DOT BTS Form 41 P-5.2 / P-1.2 · T-100 / T-2 · EUROCONTROL CRCO Unit Rates 2024 · EUROCONTROL Standard Inputs ed.9 · ACI Airport Charges 2024 · Boeing PEM §3-4 · Airbus GTG Cost Index ed.2 · Belobaba/Odoni/Barnhart Global Airline Industry 2e Ch.5 · Doganis Flying Off Course 4e Ch.4-6 · Holloway Straight & Level 3e Pt II · Vasigh/Fleming/Tacker Air Transport Economics 3e Ch.7-9)', showDoc, ()=>{ const nv=!showDoc; setShowDoc(nv); lsSet('ft-doc', nv) }],
                ['PRD · Payload-Range Diagram & Mission Capability Envelope · per-airframe four-corner payload-range envelope evaluator computing the classical PRD breakpoints A·MZFW B·MTOW C·HARVEST D·FERRY per Roskam Airplane Design Pt I §3.7 / Torenbeek Synthesis of Subsonic Airplane Design Ch.5 / Raymer Aircraft Design 6e §3.3 / Airbus Getting to Grips with Aircraft Performance §2.3 / Boeing PEM §2 · Breguet-anchored range model R = (V/SFC)(L/D)·ln(W_to/W_zfwres) at LRC TAS+mid-cruise L/D+mid-cruise SFC consistent with BREG monitor applied at trip-planning scope · 32-type catalogue (6-class WB-LH/WB-M/NB/RGN-J/RGN-T/BIZ: B748/B744/B77W/B772/B788/B789/B78X/A388/A359/A35K/A332/A333/A339/B763/B737/B738/B739/B38M/B39M/B752/A319/A320/A321/A20N/A21N/BCS3/E190/E195/E290/E295/CRJ9/AT72/DH8D/GLEX/G650/GLF6/FA8X) per Boeing Airport Planning Documents §3.2 / Airbus ACAP §3.5 / Embraer APM §3.4 / ATR/Q400 APM §3 / business-jet ACAPs with OEW/MZFW/MTOW/MaxFuel/FF-LRC/TAS-LRC/seats catalogued · trip-distance estimator deterministic per-icao24 hash gated by class typical-leg (NB 400-2400 / WB-LH 1800-7800 / RGN-J 200-1100 / RGN-T 80-600 / BIZ 600-4800) coupled to GS bias · payload model SEATS × LOAD-FACTOR slider × 95kg FAA AC 120-27F summer standard + cargo-belly fraction CGO-MUL slider · ZFW = OEW + payload · fuel_req = FF × (trip/TAS + RES-HR slider) × CONT (1+CONT-MUL%) per 14 CFR §121.639 / EASA CAT.OP.MPA.150 reserves · TOW_req = ZFW + fuel_req · feasibility R-at-payload via piecewise-linear interpolation through corners A→B→C→D in (payload,range) plane per Roskam Pt I §3.7 fig 3.10 · 6 risk drivers max-driver composite ZFW (zfw/MZFW) / TOW (tow/MTOW) / FUEL (fuel/MaxFuel) / RNG (trip/R-at-payload) / BLOCK (block-fuel margin) / CFG (payload-utilisation amplifier) · composite max·0.68 + mean·0.32 × ADV-MUL · hard escalators ZFW>MZFW score-min 90 / TOW>MTOW 92 / trip>R-B 84 / fuel_req>MaxFuel 88 · 6 hard tiers OVER-MTOW rose structural breach reduce fuel/payload per FCOM PI-WT 14 CFR §25.25 / FUEL-LIMITED rose-pink trip exceeds R-C even with full tanks offload pax/cargo or tech-stop per AC 91-79B App.1 / TIGHT amber <5% margin brief crew weight-critical per Boeing PEM §2.5 / ADEQUATE sky 5-15% margin standard dispatch per Airbus GTG Perf §2.3 / COMFORTABLE emerald >15% margin all axes / IDLE slate on-ground · MapLibre overlay tier-coloured halo rings 7-19px by score + class-coloured-inner-ring WB-LH violet WB-M sky NB emerald RGN-J amber RGN-T yellow BIZ rose + OVER-MTOW/FUEL-LIMITED rose pins + cs trip-NM margin% labels · Side panel 6-tier counter strip click-to-filter ALL + 6-cell summary MEAN-margin/WORST-cs/Σ-trip-NM/OVR-cnt rose/FUEL-LIM-cnt rose-pink/MEAN-LF + 6 sliders LF 30-100% CGO-MUL 0-100% RES-HR 0.5-3.0h CONT-MUL 0-15% ADV-MUL 50-200% TRIP-MUL 50-200% + 6-class chip filter + HALO PIN LBL toggles + search by cs/type/operator/class + AIRCRAFT/CLASSES/DIAGRAM tab switcher · AIRCRAFT tier-worst-first row stack with cs+type+class-pill+tier-pill + FL/GS/trip/R-at-payload/margin% row + 4-cell PAYLD/ZFW/FUEL/TOW with vs-limit tier-coloured + 4-corner pill row A-violet B-sky C-amber D-emerald + score bar + 6-driver chips ZFW TOW FUEL RNG BLOCK CFG + tier-coloured advice citing FCOM PI-WT 14 CFR §25.25 AC 91-79B App.1 Boeing PEM §2.5 Airbus GTG Perf §2.3 click-to-fly · CLASSES per-class mean ZFW/TOW/FUEL pct + class-coloured mean-score bar + 6-tier sub-counter strip · DIAGRAM full SVG four-corner PRD plot for selected airframe with sky-shaded feasible polygon + A/B/C/D markers + current-mission dot tier-coloured + range/payload axes with ticks + OEW/MZFW/MTOW/MAX-FUEL readout · References Roskam Airplane Design Pt I §3.7 / Torenbeek Synthesis of Subsonic Airplane Design Ch.5 / Raymer Aircraft Design 6e §3.3 / Anderson Aircraft Performance & Design §5.10 / Boeing 737/747/757/767/777/787 Airport Planning §3.2 / Airbus ACAP A220/A319/A320/A321/A330/A350/A380 §3.5 / Embraer E170/E175/E190/E195 APM §3.4 / ATR-72/Q400 APM §3 / Airbus Getting to Grips with Aircraft Performance §2.3 / Boeing PEM §2 §3 / 14 CFR §121.639 §121.641 §121.645 / EASA Part-CAT CAT.OP.MPA.150 / ICAO Annex 6 Pt I §4.3.6 / Doc 9760 Vol II Pt IV / Doc 9889 §A.3 / EUROCONTROL BADA 3.15 / 4.2 / FAA AC 120-27F / AC 91-79B App.1 / IATA AHM 632 / 642 / Belobaba/Odoni/Barnhart Global Airline Industry 2e §4 / Doganis Flying Off Course 4e Ch.4. PRD entry registered in Layers Analysis category after DOC, ft-prd persisted preference', showPrd, ()=>{ const nv=!showPrd; setShowPrd(nv); lsSet('ft-prd', nv) }],
                ['ALTN · Alternate-airport suitability & diversion planner', showAltn, ()=>{ const nv=!showAltn; setShowAltn(nv); lsSet('ft-altn', nv) }],
                ['MELT · Live gross-weight estimator · energy-method inversion from observed ROC + IAS + FL using BADA-style class polars (CD0 + k·CL²) and APF max-climb thrust deck · solves quadratic (k/qS)·W² + (ROC/V)·W + (CD0·qS − T_MCL) = 0 for in-flight W* per Anderson §5.4 / Hale §5 · 6-class catalogue HVY/WB-M/NB/RGN-J/RGN-T/BIZ with OEW/MTOW/T_MCL/CD0/k/S · ISA atmosphere with σ^0.7 thrust lapse and Mach-decrement · 6 tiers AT-MTOW (Wfrac≥97% rose) / HEAVY (≥88% rose-pink) / NOMINAL (≥78% amber) / MID (≥68% sky) / LIGHT (<68% emerald) / UNKNOWN · phase gate CLIMB-INV (VS>+400fpm best) / CRUISE-INV (MRC-anchored coarse) · MapLibre tier-coloured halo + AT-MTOW/HEAVY rose pins + cs/W-t/Wfrac% labels · AIRCRAFT/CLASSES/PHYSICS tabs · PHYSICS tab renders live equation panel + class polar grid + confidence model · (Anderson Aircraft Performance & Design §5.4 / Hale §5 / Mason Configuration Aero Ch.8 / Mattingly Aircraft Engine Design §8 / Roskam Pt VI Ch.3 / Boeing 737/777/787 PEM §3-§4 / Airbus GTG Aircraft Performance §3 / EUROCONTROL BADA 3.15/4.2 OPF/APF / ICAO Doc 9889 §A.3 / 14 CFR §25.115 §25.121)', showMelt, ()=>{ const nv=!showMelt; setShowMelt(nv); lsSet('ft-melt', nv) }],
                ['CRZL · Semicircular cruise-level compliance · track-vs-FL parity scorer per ICAO Annex 2 App.3 / 14 CFR §91.179 §91.159 / Doc 9574 RVSM Ch.4 · checks IFR-RVSM (FL290-FL410 odd/even 1000-ft VSM) + IFR pre-RVSM (FL050-FL280) + VFR-hemispheric (>3000 ft, odd+500/even+500) parity bands · zonal magvar model deriving track_mag from track_true · 6 drivers PARITY (Δft to correct slab) / BAND (in published band) / TRACK (±° to flip boundary) / DRIFT (transition relief on |VS|>500fpm step-climbs) / OCEANIC (NAT-OTS / PACOTS waiver mute per NAT Doc 007 §2.2.5) / CONF · composite max·0.62 + mean·0.38 − DRIFT·0.40 − OCEANIC·0.50 × ADV-MUL · 6 tiers WRONG-FL ≥80 rose (parity flat wrong, ATC re-clear) / OFF-PARITY ≥55 rose-pink (one slab off) / BOUNDARY ≥35 amber (track within ±10° of 000/180 flip) / OK ≥12 sky / WAIVED ≥4 emerald (organised-track) / NOT-CRUISE slate · MapLibre tier halo + WRONG/OFF rose pins + cs/FL/→correctFL/Δft labels + sky correct-FL ghost annotation · 4 rulesets ICAO-IFR/FAA-IFR/VFR-3000/ALL-MIXED · 5 sliders RULESET/BOUND-°/MIN-FL/MAX-FL/ADV-MUL · 7-class chip filter · HALO/PIN/LBL/CORR toggles · AIRCRAFT/RULES/DIAGRAM tabs · DIAGRAM renders parity wheel with east/odd west/even hemisphere arcs and fleet samples placed by track_mag and FL radius · distinguishes semicircular-rule violations (which FL is correct) from RVSM height-keeping (whether assigned FL is held within ±200 ft) · (ICAO Annex 2 App.3 · Doc 9574 Ch.4 · Doc 4444 PANS-ATM §4.5 §5.4 · Doc 7030 RAC SUPPS · Doc 9613 Vol II Pt C · NAT Doc 007 §2.2.5 · NAT-OPS Bull 2024-01 · 14 CFR §91.159 §91.179 · FAA AIM §3-1-5 §4-4-9 · FAA Order JO 7110.65 §5-7-1)', showCrzl, ()=>{ const nv=!showCrzl; setShowCrzl(nv); lsSet('ft-crzl', nv) }],
                ['DRFTDN · OEI Driftdown & Net-Ceiling vs Terrain Monitor · per-airframe Engine-Out driftdown scorer evaluating whether each cruising aircraft retains adequate OEI net-ceiling clearance over the projected ground-track terrain envelope · computes canonical driftdown trajectory from cruise FL down to net level-off altitude per Boeing FCOM PI-11 §11.30 / Airbus FCOM PRO-NOR-SOP-19 / 14 CFR §121.191 §25.121(c) / EASA CAT.POL.A.215 / AC 120-42B §10.3.7 / ICAO Annex 6 Pt I §4.2.4.4 / Doc 8168 Vol I Pt V · 5-class catalogue ETOPS-LH (B777/B787/A350/A330) net-ceil FL155-185 drift 320 KIAS OEI-FF 6800 kg/h ETOPS-180 / ETOPS-N (B737/A320) FL145-170 280 KIAS 3200 kg/h / QUAD-LH (B747/A380) FL215-245 / RGN (E190/CRJ/AT72) FL115-135 / BIZ (GLEX/G650) FL235-265 · steady-state Ps_OEI = (T_OEI−D)·V/W = 0 solving T_SL·σ^0.7 = qS·CD0 + (k/qS)·W² per Anderson §6.5 / Mattingly §8 / Roskam Pt VI §3 · 12-zone terrain proxy (Himalaya 24k / Tibet-Pamir 22k / Andes 22k / NA-Rockies 16k / Alps 14k / Greenland-Iceland 12k / Ethiopia 12k / NewGuinea 14k / NZ-Southern-Alps 12k / Rockies-Canada 13k / Caucasus 14k / Iran-Zagros 12k) scanned along ground-track over SCAN-NM 60-600 (8-step bearing sweep) · ETOPS exposure proxy (polar 90 / central-Pacific 80 / South-Atlantic 65 / South-Indian 60 / NAT 40 / continental 8) · weight phase amplifier deterministic per icao24 hash 0.2-1.05 of MTOW-OEW fraction · 6 drivers NETCEIL (clearance ramp 0→+6000ft) / WEIGHT (heavy early-leg amplifier) / TERRAIN (proxy ceiling 0-24k) / ETOPS (oceanic exposure) / TIME (drift duration min) / CONF · composite max(NETCEIL,TERRAIN,ETOPS·0.6,WEIGHT·0.4)·0.66 + mean·0.34 × ADV-MUL · hard escalators clearance<0 score-min 92 (terrain bust) / clearance<1000ft AC120-42B floor 78 / oceanic ETOPS-twin net-ceil<FL180 65 · 6 tiers CRITICAL ≥80 rose (OEI net-ceil BELOW terrain — cannot clear on one engine, re-route per AC 120-42B §10.3.7) / MARGINAL ≥55 rose-pink (<1000ft floor, divert preferable) / TIGHT ≥35 amber (1000-3000ft, advisable step-climb FCOM PI-11.30) / NOMINAL ≥12 sky (3000-6000ft, standard ETOPS dispatch) / COMFORTABLE <12 emerald (>6000ft full redispatch options) / NOT-CRUISE slate (climbing/descending or FL<100) · MapLibre overlay tier-coloured halo rings 7-19px by score + CRITICAL/MARGINAL rose pins + dashed track-scan line aircraft→worst-terrain-point for top-12 worst + cs / net-FL / clearance-k labels · Side panel 6-tier counter strip click-to-filter ALL + 5-cell summary MEAN-CLR / WORST-cs / CRITICAL-cnt / Σ-NM-at-risk / MEAN-NET-FL + 5 sliders MIN-FL 50-350 / SCAN-NM 60-600 / MARGIN 500-3000ft (AC120-42B floor) / WT-MUL 60-130% calibration / ADV-MUL 50-200% + 5-class chip filter + HALO/PIN/TRK/LBL toggles + search by cs/type/operator/region + AIRCRAFT/CLASSES/DRIFTDOWN tabs · AIRCRAFT tier-worst-first row stack with cs+type+class-pill+engines-pill+tier-pill + FL/→net-FL/terr-k/clr/Δt row + REGION/DD-FUEL/ETOPS-exp 3-cell + tier-coloured score bar + 5-driver chips NETCEIL TERRAIN ETOPS WEIGHT TIME + tier-coloured advice citing AC 120-42B §10.3.7 / FCOM PI-11.30 / Annex 6 §4.2.4.4 click-to-fly · CLASSES per-class row with net-clean/net-heavy/drift-IAS/ROD/ETOPS-min + MEAN-CLR/MEAN-NET/CRIT/MARG 4-cell + class-coloured worst-score bar · DRIFTDOWN tab full SVG driftdown trajectory plot for top-row aircraft with FL grid, time-axis 0-30min, rose terrain band, amber AC120-42B margin-floor dashed line, sky OEI net-ceil line, tier-coloured driftdown path from cruise FL → level-off with OEI-event start dot + level-off dot annotated with time+fuel-burned + 4-cell DRIFT-IAS/ROD/OEI-FF/ENGINES grid + physics narrative · References Boeing 737/747/777/787 FCOM PI-11 §11.30 Driftdown · Boeing PEM §3.5 D6-1420 OEI cruise · Airbus A320/A330/A350 FCOM PRO-NOR-SOP-19 · Airbus GTG Aircraft Performance §3.7 · 14 CFR §121.191 §25.123 §25.121 §121.161 §121.633 ETOPS · EASA CAT.POL.A.215 · EASA AMC-20-6 ETOPS · FAA AC 120-42B §10 alternate planning §10.3.7 · AC 25-7D §31 high-altitude flight test · ICAO Annex 6 Pt I §4.2.4.4 net-flight-path · Doc 8168 Vol I Pt V · EUROCONTROL BADA 3.15/4.2 OPF/APF · Anderson Aircraft Performance & Design §6.5 · Roskam Airplane Design Pt VI §3 OEI performance · NTSB AAR-92-04 Avianca 052 · NTSB AAR-08-03 Pinnacle 3701. DRFTDN entry registered in Layers Analysis category after CRZL, ft-drftdn persisted preference', showDrftdn, ()=>{ const nv=!showDrftdn; setShowDrftdn(nv); lsSet('ft-drftdn', nv) }],
                ['TMI · Track-Mile Inefficiency & Horizontal Flight Efficiency · per-airframe live HFE scorer implementing the canonical CANSO PRC KEA (Key Performance Environment Indicator) and ICAO/GANP horizontal-flight-efficiency metric HFE = (D_actual − D_great_circle) / D_great_circle × 100 % per CANSO ATM Performance Review Report 2024 §4.2 / EUROCONTROL PRR 2024 §6.3 KEA / ICAO Doc 9854 GATMOC §1.5.3 / GANP §3.4.4 ASBU B0-FRTO B1-FRTO · 36-hub global anchor catalogue (KATL/KORD/KDFW/KLAX/KJFK/KSFO/KMIA/KSEA/KBOS/CYYZ/EGLL/EGKK/LFPG/EHAM/EDDF/EDDM/LEMD/LIRF/LSZH/LTFM/OMDB/OTHH/OERK/VIDP/VABB/VHHH/WSSS/RJTT/RJAA/RKSI/ZBAA/ZSPD/YSSY/NZAA/FAOR/SBGR) with deterministic per-icao24 origin/destination snap based on nearest-6 / farthest-12 hub partition · per-class fuel-flow + LRC TAS catalogue (HVY 9.8 t/h @ 480 KTAS / WB-M 5.6 t/h @ 460 KTAS / NB 2.7 t/h @ 440 KTAS / RGN-J 1.9 t/h @ 420 KTAS / RGN-T 0.75 t/h @ 280 KTAS / BIZ 1.4 t/h @ 460 KTAS / LIGHT 0.12 t/h @ 160 KTAS) per BADA 3.15 / Boeing PEM §3 / Airbus GTG §3 · spherical great-circle distance via haversine R_E = 3440.065 NM · initial-bearing via spherical law of sines · cross-track error XTE = |asin(sin(d_OC/R)·sin(θ_OC − θ_OD))|·R per Bowditch American Practical Navigator · along-track decomposition √(d²_OC − XTE²) · future-detour penalty remGC·(1 − cosΔθ)·0.6 per EUROCONTROL PRR §6.3 along-track approximation · 6 drivers GCDEV cross-track miles (ramp 0→80NM) / DETOUR HFE % (ramp 0.5%→12%) / BRGERR track vs bearing-to-dest (ramp 0→60°) / HOLD low-GS+low-FL holding-pattern proxy / WX ITCZ ±12° + NA/EU jet 28-52°N convection band / ATC TMA vectoring proxy FL<220 + GS<320 · composite max·0.62 + mean·0.38 × ADV-MUL · hard escalators HFE>8% score-min 82 / HFE>12% 92 / XTE>100NM 75 · 6 tiers SEVERE ≥80 rose HFE>8% re-route per CANSO KEA / POOR ≥60 rose-pink 5-8% request shortcut per EUROCONTROL FRA / MARGINAL ≥40 amber 3-5% monitor vectors / NOMINAL ≥18 sky 1-3% normal vectoring envelope / OPTIMAL <18 emerald <1% ASBU B0-FRTO compliant near-GC / NOT-CRZ slate on-ground or below FL100 · excess-fuel kg = (excessNM / TAS) × FF · excess-CO₂ kg = excess-fuel × 3.16 per ICAO Doc 9889 §A.3 jet-A1 emission index · fleet USD impact = Σ-fuel-kg × FUEL-USD slider (0.50-2.50 USD/kg, default 0.90 per IATA Jet Fuel Price Monitor) · MapLibre overlay tier-coloured halo rings 7-19px + SEVERE/POOR rose pins + dashed great-circle planned line + solid actual deviated line (origin→current→dest via 32-step gcArc) for top-14 worst aircraft + tier-coloured cs · ORIG→DEST · HFE% labels · Side panel 6-tier counter strip click-to-filter ALL + 5-cell summary MEAN-HFE / WORST-cs / Σ-EXCESS-NM / Σ-FUEL-tonnes / Σ-CO₂-tonnes (rose if >1000) + fleet-cost line ($ thousands) + SEVERE+POOR counter + 4 sliders MIN-FL 50-400 / MAX-FL 100-500 / ADV-MUL 50-200% / FUEL-USD 0.50-2.50/kg + 7-class chip filter HVY WB-M NB RGN-J RGN-T BIZ LIGHT + HALO/PIN/GC/LBL toggles + search by callsign/type/operator/hub-icao + AIRCRAFT/HUBS/KEA tab switcher · AIRCRAFT tier-worst-first row stack with cs+type+class-pill+tier-pill + ORIG/DEST/GC-NM 3-cell pill row + HFE/XTE/ΔNM/FL grid + REM/BRG/TRK/FUEL grid + tier-coloured score bar + 6-driver chips GCDEV DETOUR BRGERR HOLD WX ATC + tier-coloured advice citing CANSO KEA / EUROCONTROL FRA / ASBU B0-FRTO click-to-fly · HUBS tab top-24 hub-pair aggregation sorted worst-tier-first with origin→dest pill row + mean-HFE/Σ-NM/Σ-fuel-tonnes/Σ-CO₂-tonnes 4-cell + worst-tier left-border stripe · KEA tab full SVG scatter plot of fleet on (great-circle-distance NM, HFE %) axes 0-7500 NM × 0-12% with threshold-band dashed lines OPTIMAL<1% emerald NOMINAL 1-3% sky MARGINAL 3-5% amber POOR 5-8% rose + violet dashed EUROCONTROL KEA target 2.18% benchmark line + per-aircraft tier-coloured scatter dots + 3-cell PRR-2024-KEA / Fleet-μ-HFE / Δ-vs-target readout grid + physics narrative · References CANSO ATM Performance Review Report 2024 §4.2 KEA · EUROCONTROL Performance Review Report 2024 §6.3 Horizontal Flight Efficiency · ICAO Doc 9854 Global ATM Operational Concept §1.5.3 horizontal flight efficiency · ICAO GANP Global Air Navigation Plan §3.4.4 ASBU B0-FRTO B1-FRTO · ICAO Doc 9613 PBN Manual Vol II Pt C · ICAO Doc 9889 §A.3 fuel-burn methodology · CORSIA SARPs Annex 16 Vol IV §I.3.2 emissions · FAA NextGen Implementation Plan 2024 §5.2 · SESAR Master Plan ed.2020 §4.2 free-route · IATA Fuel Efficiency Gap Analysis 2024 §3.1 · IATA Sustainability & Economics 2024 §2.4 · EUROCONTROL Free Route Airspace Implementation 2024 · NATS NERL Performance Plan RP3 §6 · ATAG Waypoint 2050 §3.2 operational efficiency · Bowditch American Practical Navigator Pub.9 Ch.24 great-circle sailing · IATA Jet Fuel Price Monitor Q1 2026. TMI entry registered in Layers Analysis category after DRFTDN, ft-tmi persisted preference', showTmi, ()=>{ const nv=!showTmi; setShowTmi(nv); lsSet('ft-tmi', nv) }],
                ['FLEET · Airline Fleet & Class-Mix Comparison Studio · per-operator real-time aggregator over the currently-tracked airborne fleet bucketing each in-air aircraft into a 7-class ICAO-aligned size/role taxonomy (HVY / WB-M / NB / RGN-J / RGN-T / BIZ / LIGHT) per ICAO Doc 8643 Aircraft Type Designators ed.52 and the EUROCONTROL BADA 3.15/4.2 OPF/APF class scheme · derives canonical ICAO 3-letter operator key from callsign prefix (AAL/UAL/DAL/SWA/BAW/AFR/KLM/DLH/SWR/IBE/AZA/THY/UAE/QTR/SIA/CPA/JAL/ANA/QFA/RYR/EZY/etc) blended with operator-string fallback · per-operator metrics count / μ-FL / μ-GS / LH% long-haul share (FL340+ AND GS≥440kt AND HVY-or-WB-M) / ETOPS% twin-WB/NB oceanic-band share / Σ-network-NM pairwise great-circle separation across operator fleet (network footprint proxy per IATA WATS network-scope methodology) / μ-fuel class-weighted t/h BADA APF / μ-pax class-weighted seats · composite operator score 0.35·log-network + 0.25·Shannon-H′-class-diversity (normalised to ln-7) + 0.20·LH-share + 0.10·log-fleet-count + 0.10·oceanic-ETOPS-share scaled by ADV-MUL 50-200% · 6 strategic-presence tiers MEGA ≥80 sky global hub-and-spoke megacarrier / MAJOR ≥60 emerald multi-region full-service / REGIONAL ≥40 amber regional/feeder / LCC ≥25 rose-pink point-to-point low-cost / NICHE ≥10 violet specialty/biz/charter / MICRO <10 slate single-airframe sample · MapLibre overlay tier-coloured halo rings sized by score with cs+ICAO labels + selected-operator radial network skeleton from fleet centroid · Side panel 6-tier counter strip click-to-filter ALL + 5-cell summary OPS / FLEET / μ-SCORE / Σ-FF / TOP-operator + 2 sliders MIN-CNT 1-20 minimum-fleet-count filter + ADV-MUL + 7-class chip filter + HALO/LBL/NET toggles + search by operator name/ICAO + OPERATORS/CLASSES/DIVERSITY tab switcher · OPERATORS tier-sorted row stack with ICAO+name+tier-pill + μFL/μGS/LH%/DIV/NET 5-cell + 7-class stacked-mix bar visualising fleet composition + tier-coloured score bar + click-to-expand revealing 7-cell per-class count grid + click-to-fly aircraft sub-grid + tier-coloured strategic descriptor citing CAPA/IATA WATS segmentation · CLASSES per-class row with class-pill ops-count / ac-count / μ-seats / fuel-rate + top-6 operators-by-count horizontal-bar ranking · DIVERSITY tab full SVG scatter plot (fleet-count, Shannon-H′) axes with 5 tier-zone background bands + per-operator tier-coloured dot sized by score with ICAO label for cnt≥6 + 3-cell μ-DIVERSITY / Σ-NETWORK / μ-PAX-AC summary + methodology narrative explaining Shannon entropy normalisation and composite weighting · References ICAO Doc 8643 Aircraft Type Designators ed.52 · EUROCONTROL BADA 3.15 / 4.2 OPF / APF class scheme · ICAO Doc 9889 §A.3 fuel-burn methodology · IATA WATS World Air Transport Statistics 2024 §3 network/coverage methodology · IATA Airline Cost Management Group 2024 §2 fleet-mix · Boeing Commercial Market Outlook 2024 §4 fleet categories · Airbus Global Market Forecast 2024 §3 segment definitions · CAPA Centre for Aviation Fleet Database 2024 ed.4 · CIRIUM Fleets Analyzer Methodology ed.7 2024 · Belobaba/Odoni/Barnhart Global Airline Industry 2e Ch.4 network/spoke/hub fleet decomposition · Shannon (1948) Mathematical Theory of Communication entropy diversity index. FLEET entry registered in Layers Analysis category after TMI, ft-fleet persisted preference', showFleet, ()=>{ const nv=!showFleet; setShowFleet(nv); lsSet('ft-fleet', nv) }],
                ['GUST · Vertical-Gust Loading & V_RA / V_B Penetration-Speed Margin · per-airframe live evaluator of the design vertical-gust load factor Δn induced on each airborne aircraft at current speed/altitude/weight under the certified discrete (1-cosine) tuned gust per 14 CFR §25.341(a) / EASA CS-25.341, and the resulting excess margin against V_RA (rough-air penetration speed) and V_B (design speed for max gust intensity) per §25.335(d) · structurally distinct from VMO/MMO envelope (red-line speed compliance), Flutter margin (aeroelastic eigen-mode) and Turbulence-EDR map (atmospheric energy dissipation rate) — GUST measures STRUCTURAL response Δn vs aircraft mass+speed under the certified discrete-gust load case · Δn equation Pratt-Walker discrete gust per 14 CFR §25.341(a): Δn = (K_g · ρ₀ · V_e · U_de · a · S) / (2 · W) with K_g = 0.88 μ_g / (5.3 + μ_g) gust alleviation factor and μ_g = 2(W/S) / (ρ · c̄ · a · g) mass parameter · U_de design gust velocity m/s EAS table 17.07 m/s @ SL → 13.41 m/s @ FL150 → 6.36 m/s @ FL500 per §25.341(a)(5) · a = 2π·AR / (2+√(AR²+4)) wing CL_α slope (rad⁻¹) · S wing area, c̄ mean aerodynamic chord · V_e = TAS · √σ equivalent airspeed · per-class structural catalogue HVY/WB-M/NB/RGN-J/RGN-T/BIZ/LIGHT carrying MTOW/OEW/S/c̄/AR/V_MO/M_MO/V_RA/M_RA compiled from Boeing 737/747/777/787 APD §3, Airbus ACAP §3.5, ICAO Doc 8643 ed.52, BADA 3.15 OPF/APF · ISA atmosphere troposphere/stratosphere derivation with σ ratio · weight model OEW + deterministic 30-99% hash of MTOW-OEW envelope · V_RA effective = min(V_RA_class, 0.9·V_MO, M_RA·a_local_KIAS) per §25.335(d) / FCOM CRZ-TURB · atmospheric-gust band proxy: jet-stream corridor 28-52° at FL280-410 ×1.25, ITCZ ±12° ×1.15, mid-lat MCS 30-45° at FL250-380 over US/EU ×1.12, mountain-wave proxy Rockies/Andes/Alps lon-bands FL150-340 ×1.18, current-encounter VS swing ×(1+|VS|/4000) · 6 drivers DNLOAD |Δn| vs design limit 2.5g ramp 0→2.0g / VSPEED IAS over V_RA ramp 0→+60 KIAS / GUSTHI atmospheric band 1.0-1.6× / MASSLO light-weight amplifier / ALTLO low-alt high-density-air penalty FL<200 / MARGIN V_MO/M_MO crosshair · composite max·0.66 + mean·0.34 × ADV-MUL · hard escalators 1+|Δn|>2.5g score-min 92 limit-load bust per §25.337 / IAS>V_RA+40 82 §25.335(d) breach / IAS>V_MO 96 · 6 tiers LIMIT ≥85 rose |Δn|>1.5g OR IAS>V_RA+30 reduce-to-V_RA declare-TURB per §25.341(c) FCOM CRZ-TURB / STRESS ≥65 rose-pink 1.0-1.5g brief crew / MOD ≥40 amber 0.6-1.0g slow toward V_RA / LIGHT ≥18 sky 0.3-0.6g monitor PIREPs / NIL <18 emerald <0.3g normal cruise / OFF slate on-ground or below FL050 · MapLibre overlay tier-coloured halo rings 7-19px by score + LIMIT/STRESS rose pins + forward heading-cone wedge gust-severity polygon for top-20 worst aircraft + cs · Δn=±X.XXg · ±YY kt V_RA-Δ labels · Side panel 6-tier counter strip click-to-filter ALL + 5-cell summary μ-Δn / WORST-cs / LIMIT-cnt / STRESS-cnt / μ-V_RA-Δ + 4 sliders MIN-FL 50-400 / MAX-FL 100-500 / ADV-MUL 50-200% / GUST-MUL 50-200% calibration + 7-class chip filter + HALO/PIN/LBL/CONE toggles + search by callsign/type/operator/tier + AIRCRAFT/CLASSES/PHYSICS tab switcher · AIRCRAFT tier-worst-first row stack with cs+type+class-pill+tier-pill + FL/IAS/V_RA/Δ/U_de 5-cell + Δn/W-tonne/K_g/μ_g 4-cell + tier-coloured score bar + 6-driver chips DNLOAD VSPEED GUSTHI MASSLO ALTLO MARGIN + tier-coloured advice line citing §25.341(c) §25.335(d) FCOM CRZ-TURB AC 120-88A click-to-fly · CLASSES per-class μ-Δn / μ-V_RA-Δ / LIMIT-cnt / STRESS-cnt + S/c̄/AR/MTOW reference cells + class-coloured mean-Δn bar · PHYSICS tab renders Pratt-Walker equation panel with K_g/μ_g/CL_α derivations + live V-n GUST envelope diagram for selected aircraft showing Δn vs KIAS curves (both gust-up and gust-down), +2.5g §25.337 limit-load line, -1.0g negative limit, V_RA / V_MO vertical reference lines, current state dot tier-coloured at (V_kt_ias, 1+Δn) + 4-cell U_de-eff / band× / σ / W readout + caveats note + references list · References 14 CFR §25.341 §25.335(d) §25.337 §25.305(d) · EASA CS-25.341 / AMC 25.341 continuous turbulence PSD · FAA AC 25-7D §32 gust load test · AC 120-88A turbulence avoidance · ICAO Annex 3 §3.4 / Doc 4444 §4.12 turb reporting · Doc 8168 Vol I Pt VI Ch.3 · Boeing FCOM PI-5 / FCT 4.30 / 8.4 turbulent-air penetration · Airbus FCOM PRO-NOR-SOP-32 / PRO-ABN-MISC turbulence · Pratt-Walker NACA TN-2964 (1954) discrete gust K_g · Hoblit "Gust Loads on Aircraft" AIAA 1988 Ch.4-5 · Roskam Airplane Design Pt VI §3 gust envelope · NTSB AAR-97-06 USAir 1455 / AAR-09-01 NWA 85 turbulence upsets. GUST entry registered in Layers Analysis category after FLEET, ft-gust persisted preference', showGust, ()=>{ const nv=!showGust; setShowGust(nv); lsSet('ft-gust', nv) }],
                ['EDR · Emergency-Descent Reach & 10k MSA Conflict Monitor · per-airframe rapid-decompression descent-profile scorer modeling the certified VMO/MMO idle-thrust speedbrake-extended emergency descent from cruise FL down to max(10,000ft MSL, MSA+1,000ft) per Boeing FCOM SP.16.1 Rapid Depressurization / Airbus FCOM PRO-ABN-EMER-D / 14 CFR §25.841(a)(2) §121.333(c)(2) supplemental O₂ / §25.1447 / EASA CS-25.841 / AMC-25.841 / ICAO Annex 6 Pt I §4.4.2 emergency descent / Doc 8168 Vol I Pt VI Ch.2 / FAA AC 25-20 pressurisation / AC 91-70B oceanic ops / Boeing FCT 8.10 / Airbus FCTM EMER-DEP · 6-class profile catalogue HVY 7200fpm 460KTAS 18min-O₂ FL380 / WB-M 6800fpm 440KTAS 15min FL360 / NB 6500fpm 420KTAS 12min FL350 / RGN-J 6000fpm 380KTAS 12min FL330 / RGN-T 3500fpm 250KTAS 10min FL220 / BIZ 8000fpm 480KTAS 22min FL410 · 14-zone MSA proxy (Himalaya 24k / Tibet-Pamir 22k / Andes 22k / NA-Rockies 14k / Alps 12k / Greenland 10k / Ethiopia 11k / NewGuinea 13k / NZ-Southern-Alps 11k / Caucasus 13k / Iran-Zagros 11k / Pyrenees 9k / Mexico-Sierra 12k / oceanic 0k) scanned 8-step along projected ground-track · descent time t_d = (FL − FLOOR) / ROD · descent forward distance d_d = t_d × V_dive_GS × 0.85 (dive-angle reduction) · descent-endpoint via great-circle projection on track · pax O₂ margin O₂Δ = O₂_avail(class) − t_d per §121.333(c)(2) ten-minute minimum + actual installed supply · MSA-conflict scan along 8 sample points flags TERRAIN-DRIVEN when worst-MSA floor exceeds 10,000ft · nearest hub diversion from 28-airport catalogue · 6 drivers O2MARG (negative=bust ramp 0→−6min) / DESCT (descent duration vs 4min target) / TERR (MSA floor 10→18kft ramp) / FUEL (excess-burn proxy) / DIVDIST (0→300NM ramp) / CABIN (cabin-alt ROC proxy FL+ASCENT) · composite max·0.66 + mean·0.34 × ADV-MUL · hard escalators t_d>O₂_avail bust score-min 92 per §121.333 / floor>14kft terrain bust 80 / no-divert-in-1.5×d_d 70 · 6 tiers BUST ≥85 rose O₂ depletes before 10k MAYDAY max-ROD per FCOM SP.16 / TIGHT ≥65 rose-pink margin<2min initiate descent immediately / TERRAIN ≥45 amber MSA-driven floor>12k divert per AC 91-70B / OK ≥22 sky standard ETOPS-compliant profile / SAFE <22 emerald clear margin all axes / OFF slate not cruising or below FL150 · MapLibre overlay tier-coloured halo rings 7-19px by score + BUST/TIGHT rose pins + forward-cone descent-footprint wedge for top-16 worst + dashed descent-track line from current to descent-endpoint with tier-coloured endpoint dot + cs/O₂Δ/FLOOR labels · Side panel 6-tier counter strip click-to-filter ALL + 5-cell summary μ-O₂Δ / WORST-cs / BUST-cnt rose / Σ-t-DESC / μ-FLOOR + 5 sliders MIN-FL 50-400 / MAX-FL 150-500 / ROD-MUL 50-150% / O₂-MUL 50-200% / ADV-MUL 50-200% + 6-class chip filter HVY WB-M NB RGN-J RGN-T BIZ + HALO/PIN/LBL/CONE/TRK toggles + search by cs/type/operator/divert-icao + AIRCRAFT/CLASSES/PROFILE tab switcher · AIRCRAFT tier-worst-first row stack with cs+type+class-pill+tier-pill + FL/FLOOR/ROD/t-d/O₂Δ 5-cell + d-d/MSA/DIV-icao/d-DIV 4-cell + tier-coloured score bar + 6-driver chips O2MARG DESCT TERR FUEL DIVDIST CABIN + tier-coloured advice citing FCOM SP.16 / §121.333(c)(2) / AC 91-70B click-to-fly · CLASSES per-class row with class-pill ac-count + ROD/V-dive/O₂-min reference cells + μ-O₂Δ/μ-t-d/BUST/TIGHT 4-cell + class-coloured margin bar · PROFILE tab renders SVG emergency-descent trajectory plot for selected aircraft with alt-axis 0-45k+ time-axis 0-tMax minutes + rose worst-MSA terrain band + amber FLOOR dashed line + sky 10k MSA reference line + rose-pink O₂_avail vertical depletion line + tier-coloured descent path from cruise FL → FLOOR with start+end dots annotated with t and altitude + 4-cell CRZ/FLOOR/t-d/d-d readout + methodology narrative + caveats + references list · References 14 CFR §25.841(a)(2) cabin-alt schedule / §25.1447 pax O₂ / §121.329 §121.337 crew O₂ / §121.333(c)(2) supplemental O₂ duration / EASA CS-25.841 / CS-25.1447 / AMC-25.841 / ICAO Annex 6 Pt I §4.4.2 emergency descent / Doc 8168 Vol I Pt VI Ch.2 / FAA AC 25-20 pressurisation / AC 91-70B oceanic ops / Boeing FCOM SP.16.1 Rapid Depressurization / FCT 8.10 / B777 FCOM 02.01.16 / Airbus FCOM PRO-ABN-EMER-D / FCOM EMER-CAB / FCTM EMER-DEP / NTSB AAR-99-01 SWR 111 cabin smoke descent / AAR-09-01 Helios 522 cabin pressure / NTSB AAR-13-01 Asiana 214. EDR entry registered in Layers Analysis category after GUST, ft-edr persisted preference', showEdr, ()=>{ const nv=!showEdr; setShowEdr(nv); lsSet('ft-edr', nv) }],
                ['NVPM · Non-Volatile Particulate Matter Emissions Monitor', showNvpm, ()=>{ const nv=!showNvpm; setShowNvpm(nv); lsSet('ft-nvpm', nv) }],
                ['SWELL · Sea-State / Ditching-Survivability & Raft-Drift Monitor · per-airframe over-water ditching survivability scorer for every airborne flight whose projected glide footprint falls outside the catchment of a suitable diversion airport, distinct from GLD glide-reach (measures the glide envelope) / SAR planner (interactive ramp + asset chooser) / ULB pinger (CVR/FDR battery EOL + acoustic range) / MEDLINK (in-flight medical diversion) — SWELL is the ditching-time-of-flight survivability layer covering what happens *after* the airframe enters the water · sea-state model: Hs significant-wave-height m from U10 10m wind via Pierson-Moskowitz fully-developed-sea Hs ≈ 0.0246·U10²/g (Hasselmann 1973 / WMO 471 §1.4) basin-modulated · Douglas Sea-State 0-9 (Hs <0.1 / <0.5 / <1.25 / <2.5 / <4 / <6 / <9 / <14 / <20 / ≥20 m) per Douglas 1929 / WMO 1100 · 7-basin catalogue NAT (40-60°N winter storm track) / PAC (25-50°N jet-stream coupled) / SIO ("roaring 40s" 30-50°S high Hs 4-6m) / ARC (>65°N moderate Hs + ice-rim) / ANT (<-55°S sub-zero SST minimal SAR) / ITCZ (<10° squall-prone low Hs) / CST (gated out) · synthetic surface wind from icao24 hash + basin amplifier (NAT+8 / SIO+12 / ARC+6 / ITCZ-2) · sea-surface temperature Tw °C proxy 28·cos²(lat)−2 with Arctic/Antarctic cap 4°C / ITCZ floor 26°C / NAT Labrador-current cap 8°C >50°N per NOAA WOA-23 §5 World Ocean Atlas climatology · USCG cold-water survival nomogram CG-PUB-3-3 Ch.4 Fig 4-2: Tw>26°C no thermal limit (heat exhaustion 12h) / 15-25°C 6h expected 24h fatigue / 10-15°C 2h expected 4-6h limit / 5-10°C 1h expected 1-3h / <5°C 30min expected <1h · SOLAS Ch.III Reg.7 immersion-suit multiplier ×4 capped 24h water-only · raft endurance 96h potable + ration per TSO-C70a / 14 CFR §121.339 · raft drift: surface current 0.3kt baseline + 3% windage per Allen-Plourde USCG-D-04-2005 leeway · Ekman deflection NH +35° right / SH -35° left · 72h cumulative drift d = (0.03·U10 + 0.3)·t NM · 16-MRCC catalogue JRCC-Halifax/Norfolk/Honolulu/Alameda/Adak / JRCC-Falmouth-UK/Stavanger/Reykjavík/Bodø / CROSS-Gris-Nez / MRCC-Madrid / MRCC-Tokyo / RCC-Hong-Kong / RCC-Seoul / JRCC-Auckland / MRCC-Cape-Town / JRCC-Buenos-Aires with nominal 900-1800 NM CL-415/C-130J/P-8A first-response range per IAMSAR Vol II §3.4 · time-to-survivor = gc-distance / 380 KTAS P-8A cruise + 1.5h launch delay · 6 drivers DITCH (over-water + no nearby airport ramp + low-FL stranding) / STATE (Douglas SS 0-9 ramp ×11) / TEMP (Tw<5°C=92 / <10°C=72 / <15°C=50 / <22°C=28 / else=12) / DRIFT (72h raft drift NM ramp ×0.6) / SAR (Δt SAR-arrival vs water-survival window) / NIGHT (diurnal night-ditching ×2 for SS≥5) · composite max·0.64 + mean·0.36 × ADV-MUL · hard escalators SS≥7 unsuited score-min 88 / Tw<5°C + SAR>2h 84 / SAR>survival-window 86 / night+SS≥6 78 · 6 tiers CATASTROPHIC ≥85 rose Stockdale-class survival (SS≥7 + Tw<5°C + SAR > survival) divert NOW per AC 91-44 · CRITICAL ≥70 rose-pink narrow window brief crew deploy raft drills suit-up cabin crew per FCOM SP · MARGINAL ≥50 amber survivable with SOLAS kit SAR feasible monitor · ADEQUATE ≥30 sky moderate sea + warm SST + SAR<90min manageable · COMFORTABLE <30 emerald calm + warm + close SAR Hudson-class plausible · OFF slate not over-water (>50NM inland or >120NM nearest airport gate) · phase-gate airborne ≥FL080 over-water (no nearby airport within 200NM) · MapLibre overlay tier-coloured halo rings 8-23px by score + CATASTROPHIC/CRITICAL rose pins + dashed 72h raft-drift line tier-coloured from current position with endpoint marker + dotted MRCC-link line (top-30 CRIT+) + cs / SS / Tw° / SAR-h labels · Side panel 6-tier counter strip click-to-filter ALL + 5-cell summary μ-SCORE / μ-SS / μ-Tw / CRIT+ / WORST-cs + 3 sliders MIN-FL 50-400 / ADV-MUL 50-200% / UTC-OFF -12→+12h + SOLAS-suit checkbox + HALO/PIN/DRIFT/MRCC/LBL toggles + search by callsign/type/basin + AIRCRAFT/BASINS/MRCC tab switcher · AIRCRAFT tier-worst-first row stack with cs+type+basin-pill+NIGHT-pill+tier-pill + SS/Hs/Tw/SURV row + U10/DRIFT/DBRG/SAR row + MRCC/NEAREST-APT cells + tier-coloured score bar + 6-driver chips DITCH STATE TEMP DRIFT SAR NIGHT + tier-coloured rationale notes citing AC 91-44 / IAMSAR Vol III §2 / FCOM SP / SOLAS Ch.III Reg.7 / USCG CG-PUB-3-3 Ch.4 / Annex 6 Pt I §4.3 / IAMSAR Vol II App.N click-to-fly · BASINS per-basin row with basin-pill + climatology note + μ-SCORE/μ-SS/μ-Tw/μ-SAR 4-cell + basin-coloured mean-score bar · MRCC tab table with code+name+range+load (aircraft-snapped count)+μ-ETA columns colour-coded by load/eta · References IMO SOLAS Ch.III Reg.7 / LSA Code Ch.II §2.3 IV §4 / IAMSAR Manual Vol I-III ICAO Annex 12 SAR Doc 9731 / FAA AC 91-44 over-water ditching / FAA-H-8083-3C Ch.18 / 14 CFR §121.339 §125.209 §135.167 / TSO-C70a life raft TSO-C72c life preserver / USCG CG-PUB-3-3 Ch.4 cold-water survival nomogram / USCG R&DC-2005 Ch.2 §2.3 SAR Optimal Planning System / NOAA WOA-23 §5 World Ocean Atlas SST / WMO 1100/1106 Sea-State + Beaufort / Douglas Sea-State 1929 / Pierson-Moskowitz 1964 / Hasselmann 1973 / Allen-Plourde USCG-D-04-2005 leeway / IMO MSC.81(70) LSA performance / NTSB AAR-10-03 US Airways 1549 Hudson / TSB A01H0004 Air Transat 236 / BEA AF447 §3-§4 / ATSB MH370 §2018-06 / ICAO Cir 332 GADSS / Tipton-Vincent J.R.Soc.Med. 1989 cold-water shock / Golden-Tipton Essentials of Sea Survival 2002. SWELL entry registered in Layers Analysis category after NVPM, ft-swell persisted preference', showSwell, ()=>{ const nv=!showSwell; setShowSwell(nv); lsSet('ft-swell', nv) }],
                ['WXAD · Onboard Weather-Radar Tilt &amp; X-band Rain-Attenuation Advisor · per-airframe live evaluator of the onboard X-band airborne weather-radar (Honeywell IntuVue RDR-4000 / Collins MultiScan WXR-2100 / Honeywell RDR-4B / Garmin GWX-80 class) tilt geometry and two-way rain attenuation along projected ground track, distinct from CONVECTIVE-CELLS (storm-object catalogue), DOPPLER-SCOPE (ground NEXRAD), CONTRAIL (ice-supersaturation), METAR/SIGMET/TAF (reported text) — WXAD measures the airborne-radar beam geometry vs storm tops, ground-clutter horizon, X-band specific attenuation and resulting tilt recommendation per phase of flight · phase-of-flight tilt envelopes per Honeywell A28-1146-148 §3.4 CRZ FL&gt;200 -1°/+1° / CLB -3°/-1° / DSC -4°/-2° / APP -5°/-3° / GND standby · beam geometry h_bc(R) = h_ac + R·6076·tan(tilt) ft with ±1.5° half-power beam-width for 30-inch flat-plate array per RTCA DO-220A §2.2 · storm-top scan target per AC 00-24C §7 beam-bottom = cell-top + 4000ft buffer · X-band specific attenuation k = 0.01217·R^1.16 dB/km/(mm/h)^1.16 two-way per ITU-R P.838-3 with cell-path = 0.55·cell-range NM core depth · ground-clutter horizon R_h_nm = 1.23·√h_ft per 4/3 earth-radius equivalent · synthetic convective-cell field by lat/lng grid climatology (ITCZ 55% prob 18-55kft tops / mid-lat 28% 18-42kft / polar 5%) with Marshall-Palmer 5-90 mm/h core rain rate · auto-tilt converges within ±0.4° (IntuVue/MultiScan 55% fleet) vs ±2.4° (legacy RDR-4B/GWX-80) · 6 drivers TILT-ERR |tilt_actual - tilt_recommended|·18 / ATTEN two-way rain attenuation dB / TOP-MISS beam-bottom misses cell-top &gt;1kft / GND-CLUT ground-clutter intrudes scope / OVRSCAN beam over-shoots tops &gt;4kft no echo / BLIND attenuation &gt;22dB wet-radome shadow · composite max·0.62 + mean·0.38 × ADV-MUL · hard escalators atten&gt;22dB score-min 88 / topMiss&gt;6kft 78 / |tiltErr|&gt;4° 60 · 6 tiers BLIND ≥85 rose wet-radome attenuation shadow likely deviate ≥20NM per AC 00-24C §7 / SHADOW ≥65 rose-pink range-cell attenuation building request WX deviation per FCTM Ch.8 / MISALN ≥45 amber tilt 2-4° off recommended adjust per Honeywell A28-1146 §3.4 / ADQ ≥22 sky within ±2° of phase envelope monitor cell tops / OPT &lt;22 emerald auto-tilt converged no atten paints clean ✓ / OFF slate radar standby (ground / no-installation) · MapLibre overlay tier-coloured halo rings 7-19px by score + BLIND/SHADOW rose pins + tier-coloured ±30° azimuth beam-footprint cone polygon (top-14 worst) + rain-coloured convective-cell markers (top-40) + cs / tilt° / atten-dB labels · Side panel 6-tier counter strip click-to-filter ALL + 5-cell summary μ-tilt-err / Σ-atten-dB / BLIND / SHADOW / WORST-cs + 4 sliders ADV-MUL 50-200pct / SCOPE-NM 40-320 / SCAN-PATH-NM 30-240 / MIN-FL 0-400 + HALO/PIN/LBL/BEAM/CELL toggles + search by callsign/type/radar-class + AIRCRAFT/RADARS/BEAM tab switcher · AIRCRAFT tier-worst-first row stack with cs+type+radar-class-pill+phase-pill+tier-pill + tilt-act/tilt-tgt/Δ/atten/scope row + cell-top/rain/range/miss row (when cell present) + tier-coloured score bar + 6-driver chips TILT ATTEN TOPMISS GND OVRSC BLIND + tier-coloured advice line citing AC 00-24C §7 / FCTM Ch.8 / Honeywell A28-1146 §3.4 click-to-fly · RADARS per-class row with class-pill + radar-name italic + fleet-cnt/μ-err/μ-atten/BLIND 5-cell · BEAM tab full SVG vertical scan-geometry plot for worst aircraft showing alt 0-60kft × range 0-scope-NM with tier-coloured beam envelope polygon (±beam-half) + beam centerline + dashed sky recommended-tilt centerline + aircraft origin dot + tier-coloured cell-column (top-down to ground) + ground-horizon marker + 4-cell tilt-act/tilt-rec/atten/cell-top readout + Marshall-Palmer/ITU-R/DO-220A methodology narrative · References ARINC 708A-3 §3 Airborne Weather Radar / RTCA DO-220A §2 Airborne X-band MOPS / ITU-R P.838-3 Specific attenuation model for rain / FAA AC 00-24C §7 Thunderstorm penetration / AC 00-45H §7 Aviation Weather Services / FAA-H-8083-15B IPH Ch.11 / Honeywell A28-1146-148 RDR-2100/4000 Pilot\'s Guide §3.4 / Collins Pro Line 21 WXR-2100 MultiScan AOM §5 / Garmin GWX-80 Pilot\'s Guide §4 Tilt Management / Boeing FCTM Ch.8 Adverse Weather / Airbus FCTM PRO-NOR-SOP §WXR / Marshall-Palmer Z-R J.Meteor. 5 1948 / Olsen-Rogers IEEE-TAP 26 1978 / NTSB AAR-86-04 Delta 191 DFW microburst / AAR-01-03 Southwest 1455 BUR / AAR-95-05 American Eagle Flagship ATR-72 ROA. WXAD entry registered in Layers Analysis category after SWELL, ft-wxad persisted preference', showWxad, ()=>{ const nv=!showWxad; setShowWxad(nv); lsSet('ft-wxad', nv) }],
                ['TROPO · Tropopause Encounter & ISA-Deviation Monitor · per-airframe live evaluator of each cruising aircraft\'s vertical position relative to the local dynamic tropopause modelled from latitude+season+season-anomaly (polar 28kft / mid-lat 38kft / tropical 56kft per ISA Doc 7488 + WMO Tropopause Definition + Reichler J.Geophys.Res. 108 2003) · computes ISA temperature deviation aloft via NCEP/NCAR reanalysis-class lapse-rate model (positive ΔISA above tropopause / variable below) · 5 cruise-FL impact regimes well-below-tropo / approaching-tropo / at-tropopause / above-tropopause / stratospheric · ΔISA aloft drives Mmo/buffet margin (M·sqrt(T/T0)), TAS deviation from ISA, contrail-formation Schmidt-Appleman threshold (Schumann ICAO Cir 312 / Doc 9889 §A.5), specific-range degradation, and step-climb opportunity · 6 risk drivers TROPOΔ vertical separation from tropopause / ISAΔ temperature deviation magnitude / BUFFET high-ΔISA buffet-margin compression / CONTRAIL ice-supersaturation Schmidt-Appleman crossing / SR specific-range degradation vs LRC optimum / WIND jet-stream proximity correlation · composite max·0.62 + mean·0.38 × ADV-MUL · 6 tiers STRATO ≥80 rose above-tropopause penetration buffet-margin compressed / NEAR-TROPO ≥55 amber within ±2000ft of tropopause expect ΔISA reversal Mmo squeeze / WARM ≥35 amber persistent ΔISA>+10°C SR degraded request FL change / NOMINAL ≥15 sky standard cruise envelope ΔISA within ±5°C / OPTIMAL <15 emerald near LRC optimum FL within ΔISA ±3°C / NOT-CRZ slate on-ground or below FL180 · MapLibre overlay tier-coloured halo rings 7-19px + STRATO/NEAR-TROPO rose pins + forward-cone wind/contrail indicator + cs/FL/Δtropo/ΔISA labels · Side panel 6-tier counter strip + 6-cell summary μ-ΔTropo / μ-ΔISA / WORST-cs / Σ-STRATO / CONTRAIL-cnt / μ-SR + 5 sliders MIN-FL/MAX-FL/SEASON-OFFSET ±90day/ISA-MUL/ADV-MUL + 8-region chip filter (POLAR-N/SUB-POL-N/MID-N/SUB-TRO-N/EQUAT/SUB-TRO-S/MID-S/POLAR-S) + HALO/PIN/LBL/CONE toggles + search by callsign/type/operator/region · AIRCRAFT/REGIONS/PROFILE tabs · AIRCRAFT tier-worst-first row stack with cs+type+region-pill+tier-pill + FL/TropoFL/Δft/ΔISA 4-cell + Mmo/SR/ContrailΔ 3-cell + tier-coloured score bar + 6-driver chips + tier-coloured advice line citing Schumann ICAO Cir 312 / Doc 9889 §A.5 / Reichler 2003 click-to-fly · REGIONS per-region row with lat-band + season-adj-FL + μ-tropoFL + ac-count + μ-ΔISA + STRATO/NEAR counts + region-coloured bar · PROFILE tab full SVG vertical cross-section plot for selected region showing tropopause FL band 250-580 vs latitude -90→+90, ISA reference temperature curve, fleet aircraft plotted as tier-coloured dots at (lat, FL) coords with picked aircraft highlight + 4-cell μ-TropoFL/μ-ΔISA/STRATO%/PEAK readout + methodology narrative + references · References ICAO Doc 7488 Standard Atmosphere · WMO Tropopause Definition / Manual on Codes Doc 306 · NCEP/NCAR Reanalysis (Kalnay et al. BAMS 1996) · Reichler Held & Stenke J.Geophys.Res. 108 2003 · Holton Introduction to Dynamic Meteorology 5e Ch.6 · Schumann ICAO Cir 312 contrail Schmidt-Appleman · ICAO Doc 9889 §A.5 cirrus & contrail · IPCC AR6 WG-I Ch.7 aviation forcing · Boeing FCOM PI-22 LRC tables · Airbus GTG Aircraft Performance §3 · Lee Atmos.Env. 244 2021 contrail RF · Burkhardt & Kärcher Nature Climate Change 1 2011 · NTSB AAR-09-01 high-altitude upset · ICAO Annex 3 §3.4 met service', showTropo, ()=>{ const nv=!showTropo; setShowTropo(nv); lsSet('ft-tropo', nv) }],
                ['RTOW · Rejected-Takeoff Overrun Margin & V1 Balanced-Field Monitor · per-airframe live evaluator of the certified accelerate-stop distance ASD vs declared ASDA and accelerate-go OEI distance TOR vs TODA at the balanced-field V1 decision boundary per FAA AC 25-7D §13 / AC 120-62 Takeoff Safety Training Aid Vol 1+2 / AC 91-79B App.A / 14 CFR §25.105 §25.107 §25.109 §25.111 §25.113 §25.115 §25.121(b)(c) §25.149 §121.189 §121.195 / EASA CS-25.105 CS-25.109 AMC 25.109 / ICAO Annex 6 Pt I §5.2 / Annex 14 Vol I §3.3 RWY declared distances / Doc 9760 Vol II Pt IV / Boeing FCOM PI-10 §10.10 §10.20 / Boeing PEM §3.4 D6-1420 / Airbus FCOM PRO-NOR-SOP-13 / GTG Aircraft Perf §3.1-3.6 · 7-class catalogue HVY-T (B777/A350/B787 350t, V1 148, TOR 2900m, ASD 3420m, γ2 2.8%) / HVY-Q (B748/A380 560t, V1 155, TOR 3230m, ASD 3780m) / WB-M (B767/A330 220t, V1 140, TOR 2500m) / NB (B737/A320 78t, V1 138, TOR 2160m, ASD 2590m, brake 78MJ) / RGN-J (E190/CRJ9 45t, V1 130, TOR 1650m) / RGN-T (AT72/Q400 24t, V1 100, TOR 1040m) / BIZ (G650/GLEX 45t, V1 130, TOR 1460m) per BADA 3.15 OPF + Boeing APD §3.2 + Airbus ACAP §3.5 · 28-hub runway catalogue with TORA/TODA/ASDA m, slope %, elevation per Jeppesen 10-9 + AIP declared-distances tables · departure airport snap via SCOPE-NM ≤50NM · model TOR = TOR_ref·(W/Wref)²·σ⁻¹·⁷ with slope±10%/1% and wind±60ft/kt per Boeing PEM §3.4 · ASD = ASD_ref·(W/Wref)²·¹·σ⁻¹·⁶ brake-energy quadratic per ESDU 76034 / AC 25-7D §13.3 · ISA σ from PA+ΔT · V1 scaling V1_class·(1+(W/MTOW−1)·0.08) · γ2 OEI 2nd-segment gradient ≥ 2.4% CS-25.121(b) compliance check · surface-friction multiplier DRY 1.00 / WET 1.18 / SNOW 1.42 per AC 91-79B App.A · brake-energy fraction 0.5·W·V1²/E_brake_class limit · 6 drivers ASDM (ASDA−ASD margin %, ramp −10→+20) / TOM (TODA−TOR margin %) / V1MAR (V1 vs VMCG+15kt margin) / BRAKE (brake-energy vs limit %) / GAMMA2 (γ2 OEI 2nd-seg gradient vs 2.4%) / WIND (headwind/tailwind asymmetry with TW penalty) · composite max·0.66 + mean·0.34 × ADV-MUL · hard escalators ASDA breach score-min 92 / TODA breach 88 / γ2<2.4% bust 80 / TW>+10kt+contaminated 70 · 6 tiers OVERRUN ≥85 rose ASDA/TODA breach reject or delay per AC 120-62 Vol 1 §3.2 / TIGHT ≥60 rose-pink <5% balanced-field margin brief V1 strategy per FCOM PI-10 §10.20 / ADEQUATE ≥35 amber 5-12% margin monitor surface contamination CS-25.109 / COMFORT ≥15 sky 12-20% margin standard dispatch / EXCESS <15 emerald >20% margin derate available see FLEX overlay AC 25-13 / OFF slate not in takeoff phase · phase-gate on-ground GS>40kt OR climbing<6000ft+GS>120kt+VS>+400fpm · MapLibre overlay tier-coloured halo rings 7-19px by score + OVERRUN/TIGHT rose pins + dashed link line departing aircraft → snapped runway endpoint tier-coloured + cs/ASDM%/TOM% labels · Side panel 6-tier counter strip click-to-filter ALL + 5-cell summary μ-ASDM / WORST-cs / OVERRUN-cnt / Σ-MARGIN-km / μ-V1 + 6 sliders MIN-FL 0-120 / MAX-FL 20-300 / OAT-DEV −30→+30°C / WIND-MUL 50-150% / SLOPE −2.0→+2.0% / ADV-MUL 50-200% + 3-button SURFACE selector DRY/WET/SNOW + 7-class chip filter HVY-T HVY-Q WB-M NB RGN-J RGN-T BIZ + HALO/PIN/LINK/LBL toggles + search by callsign/type/operator/airport-icao + AIRCRAFT/RUNWAYS/BALANCED-FIELD tab switcher · AIRCRAFT tier-worst-first row stack with cs+type+class-pill+rwy-icao-pill+tier-pill + W-t/V1/Vr/V2 4-cell + ASD/ASDA/ASDM%/γ2% 4-cell + TOR/TODA/TOM%/WIND-kt 4-cell + tier-coloured score bar + 6-driver chips ASDM TOM V1MAR BRAKE GAMMA2 WIND + tier-coloured advice citing AC 120-62 / FCOM PI-10 / CS-25.109 / CS-25.121(b) / AC 25-13 click-to-fly · RUNWAYS per-airport row sorted by ac-count with ICAO+name + TORA/TODA/ASDA/SLOPE 4-cell + ELEV/OAT/SURFACE/HDG 4-cell + worst-tier left-border stripe + worst-callsign+tier+score readout · BALANCED-FIELD tab full SVG diagram for selected aircraft with x-axis V kts 0→1.2·Vr + y-axis distance m + sky TOR(V) accelerate-go curve + rose ASD(V) accelerate-stop curve + tier-coloured crossover V1 dot + amber TODA dashed line + rose ASDA dashed line + V1/Vr/V2/γ2 4-cell readout + methodology narrative + references · References FAA AC 25-7D §13 takeoff perf flight test / AC 120-62 Takeoff Safety Training Aid Vol 1+2 / AC 91-79B App.A runway overrun prevention / 14 CFR §25.105 §25.107 §25.109 §25.111 §25.113 §25.115 §25.121(b)(c) §25.149 §121.189 §121.195 / EASA CS-25.105 CS-25.109 CS-25.113 AMC 25.109 / Boeing FCOM PI-10 §10.10 §10.20 / PEM §3.4 D6-1420 / Airbus FCOM PRO-NOR-SOP-13 / GTG Aircraft Perf §3 / ICAO Annex 6 Pt I §5.2 / Annex 14 Vol I §3.3 declared distances / Doc 9760 Vol II Pt IV / ESDU 71026 take-off ground-roll / ESDU 76034 accelerate-stop / ESDU 88033 wet/contaminated runway / ESDU 84036 brake-energy / Torenbeek Synthesis of Subsonic Airplane Design §5.4 / Roskam Pt VII §10 / NTSB AAR-08-04 Comair 5191 LEX / NTSB AAR-08-02 MK Airlines 1602 HFX / NTSB AAR-89-04 USAir 5050 LGA late-RTO / FSF ALAR Briefing Note 8.2 Rejected Takeoff. RTOW entry registered in Layers Analysis category after NVPM, ft-rtow persisted preference', showRtow, ()=>{ const nv=!showRtow; setShowRtow(nv); lsSet('ft-rtow', nv) }], //  · per-airframe live evaluator of engine non-volatile particulate matter (nvPM) mass + number emission rate along the projected ground-track per ICAO Annex 16 Vol II Pt III Ch.4 (nvPM standard >26.7 kN since 2020/2023) / ICAO Doc 9889 §A.4 / EEDB ed.29 2024 / CAEP/11 Doc 10180 §5.2 / SCOPE11 (Agarwal ASME GT2019-91504) / FOA4 (Wayson 2009) / BFFM2 (DuBois-Paynter SAE 2006-01-1987) / 14 CFR Pt 34 / EASA CS-34 · distinct from EMISSIONS overlay (CO2/radiative-forcing) and CONTRAIL overlay (ice-particle persistence) — NVPM measures the soot/black-carbon aerosol mass + number emissions, the dominant non-CO2 surface-air-quality pollutant and primary nucleation seed for contrail ice crystals · 11-class engine catalogue HVY-CFM (CFM56/LEAP-1B 18 mg/kg / 6e15) / HVY-RR (RB211/Trent 22 / 8) / HVY-GE (GE90/GEnx/GE9X TAPS-II 12 / 4) / HVY-PW (PW4000/PW1100G 16 / 5) / NB-CFM (CFM56-5B/-7B legacy 28 / 14) / NB-LEAP (LEAP/GTF CAEP/11 6 / 3) / NB-V2500 (IAE V2500-A5 35 / 18) / RGN-J (CF34/AE3007/PW1500 24 / 12) / RGN-T (PW100/PT6/TPE331 8 / 5) / BIZ (BR710/PW307/Tay 18 / 9) / LIGHT (PT6A/Avgas piston 4 / 2) · BFFM2 thrust-setting proxy = (FL/FL_LRC)·(1+|VS|/3000) interpolating cruise-LRC fuel-flow per engine · mass rate g/s = EI_mass·FF_kgs·n_eng/1000 · number rate ×10¹⁵/s = EI_num·FF_kgs·n_eng · climb/idle rich-burn EI amplification 1.4-1.6× per FOA4/SCOPE11 · BCA below-3000ft AGL amplifier 3.0× FL<030 / 1.5× FL030-070 / 1.0× FL070-100 / 0.6× FL100+ per Doc 9889 §3 LTO cycle weighting · 6 drivers MASS (g/s ramp 0→5) / NUM (×10¹⁵/s ramp 0→8) / BCA (LTO penalty) / OLDFLT (pre-CAEP/11 engine penalty 60) / SMOKE (BFM rich-burn regime) / FUEL (fuel-burn proxy) · composite max·0.64 + mean·0.36 × ADV-MUL · hard escalators MASS>4g/s score-min 88 / BCA≥2.0×+pre-CAEP/11 78 / pre-CAEP/11+cruise+MASS>2.5g/s 60 · 6 tiers SEVERE ≥80 rose major BC plume (LTO/old engine, CAEP/11 §5.2 review) / HIGH ≥60 rose-pink pre-CAEP/11 fleet at altitude (Doc 9889 §A.4) / MODERATE ≥40 amber typical CFM56/V2500 generation (monitor LTO) / LOW ≥18 sky CAEP/11-compliant LEAP/GTF / CLEAN <18 emerald GTF/GEnx TAPS-II low-soot / OFF slate stationary or below FL010 · MapLibre overlay tier-coloured halo rings 7-19px by score + SEVERE/HIGH rose pins + forward-cone PLUME wedge tier-coloured polygon sized by mass-rate (10-38 NM) for top-18 worst + cs / g-s / N-rate labels · Side panel 6-tier counter strip click-to-filter ALL + 6-cell summary μ-MASS / Σ-MASS / WORST-cs / SEVERE / μ-NUM / Σ-FUEL-t/h + 5 sliders MIN-FL 0-200 / MAX-FL 50-500 / EI-MUL 50-200% (calibration) / BCA-MUL 50-300% (LTO weighting) / ADV-MUL 50-200% + 11-class chip filter + HALO/PIN/PLUME/LBL toggles + search by callsign/type/operator/class + AIRCRAFT/CLASSES/EEDB tab switcher · AIRCRAFT tier-worst-first row stack with cs+type+class-pill+n×eng-pill+tier-pill + FL/FF-kg/h/EI-m/EI-n row + MASS-g/s/NUM-1e15/s/BCA×/SCORE row + tier-coloured score bar + 6-driver chips MASS NUM BCA OLDFLT SMOKE FUEL + tier-coloured advice line citing CAEP/11 §5.2 / Annex 16 II Pt III Ch.4 / Doc 9889 §A.4 click-to-fly · CLASSES per-class row with class-pill ac-count + engine-family note + EI-m/EI-n/FF-LRC/FL-LRC cells + μ-MASS/Σ-MASS/SEV/HIGH 4-cell + CAEP/11 compliance pill (emerald=pass / rose=pre-cert) + class-coloured mass-rate bar · EEDB tab full SVG scatter plot positioning 11 classes by EI-mass (0-40 mg/kg) × EI-number (0-25×10¹⁵/kg) per ICAO EEDB ed.29 + CAEP/11 mass-limit dashed line (12 mg/kg) + CAEP/11 number-limit dashed line (1.0×10¹⁵/kg) + class dots stroke-coloured by compliance + live fleet centroid μ-fleet dot + 3-cell μ-EI-mass / μ-EI-num / CAEP/11-PASS-% summary + methodology narrative + references · References ICAO Annex 16 Vol II Pt III Ch.4 nvPM standard / Doc 9889 Manual on Air Quality §A.4 App.A / EEDB Engine Emissions Databank ed.29 2024 / CAEP/11 Doc 10180 §5.2 / SCOPE11 Agarwal et al. ASME GT2019-91504 / FOA4 Wayson-Fleming-Iovinelli J.Air&Waste 59 (2009) / BFFM2 DuBois-Paynter SAE 2006-01-1987 / 14 CFR Pt 34 / EASA CS-34 §34.1 / AMC 34.1 / IATA Aviation Climate Action Manual ed.2 2024 §3.4 / ACI World Airport Air Quality Handbook ed.3 2025 §4 / Wesely Atmos.Env. 23 (1989) dry deposition / Stettler Atmos.Env. 67 (2013) UK aviation nvPM / Lobo EST 49 (2015) nvPM SN / Brem EST 49 (2015) cruise EI / Moore Nature 543 (2017) biofuel BC / Boulanger Aeronaut.J. 124 (2020) GTF nvPM. NVPM entry registered in Layers Analysis category after EDR, ft-nvpm persisted preference', showNvpm, ()=>{ const nv=!showNvpm; setShowNvpm(nv); lsSet('ft-nvpm', nv) }],
                ['FLEX · ATM / Reduced-Thrust Takeoff Compliance & Efficiency Monitor · per-airframe Assumed-Temperature-Method scorer evaluating max-available Tflex / ΔN1 reduction / TOD vs TODA margin / γ2 2nd-segment climb gradient (CS-25.121(b)) / VLOF vs tire-cert / brake-energy margin / EGT-margin gain / LCF hot-section cycle benefit · 6 thrust classes HVY-T HVY-2 WB-M NB RGN BIZ with per-class TOGA klbf / engines / Tflat / derateMax / TOD_base / MTOW / Vtire-cert · departure-airport snap to 28-hub catalogue via SCOPE-NM with synthetic TORA/TODA/elev/OAT/surface · TOD model TOD = TOD_ref·(W/Wref)²·(1/σ)^1.7 per Roskam Pt VII §10 / Torenbeek §5.4 · ISA density ratio σ from PA/OAT · iterative Tflex search 0-derateCap·°C such that TOD ≤ TODA·0.94 AND γ2 ≥ MIN-γ2 · thrust-relative ≈ (Tflat/Tassumed)^2.4 per FADEC engine deck · realised N1_used from VertRate inversion · wasted-margin = N1_used - N1_optimum · ΔEGT lost ≈ ΔN1×11°C per CFM/GE/RR/PW SBs · LCF multiplier ≈ exp((N1opt-82)/26) per RR Trent SB · 7 drivers N1WASTE / EGTMARG / LCFLOSS / TODMARG / GAMMA2 / TIRESP / BRKENG composite max·0.64 + mean·0.36 × ADV-MUL · hard escalators TOGA-with-Flex≥15°C-avail score-min 88 / γ2-bust 70 / TOD<4% margin 60 · 6 tiers OVERTHRUST ≥85 rose TOGA when Flex >15°C available brief crew & SOP review per FCOM PI-11 / AC 25-13 / SUBOPT ≥65 rose-pink Flex used but ≥10°C below max-available reduce next leg / TIGHT-PERF ≥45 amber Flex at limit <5% TOD margin or γ2<2.5% derate vs Flex review / OPTIMAL ≥20 sky within 5°C of max Tflex / EFFICIENT <20 emerald at max-Flex best EGT/LCF benefit captured / NOT-IN-PHASE slate cruise-or-stationary · phase-gate climbing<6000ft∧VS>600fpm OR on-runway>25kt · MapLibre overlay class-coloured halo rings 7-19px tier-stroked + OVERTHRUST/SUBOPT rose pins + dashed link line departing AC → snapped runway + cs Tflex ΔN1% tier labels · Side panel 6-tier counter strip click-to-filter ALL + 5-cell summary MEAN-ΔN1 / WORST-cs / OVR-cnt / Σ-EGT-margin-lost / Σ-LCF-cycle-saved + 7 sliders SCOPE-NM 8-80 TODA% 70-120 OAT-MUL 70-130% WT-MUL 70-110% DERATE-CAP 20-55°C MIN-γ2 18-35‰ ADV-MUL 50-200% + 6-class chip filter + HALO/PIN/LINK/LBL toggles + search by callsign/type/airport icao + AIRCRAFT/RUNWAYS/FLEX-CARD tab switcher · AIRCRAFT tier-worst-first row stack with cs+type+klass-pill+nEng×klbf-pill+tier-pill + RWY/OAT/ELEV/SURF row + W/TODA/TOD/γ2 row + Tflex(Δ+°C)/N1opt/N1used/ΔN1 + EGT-lost/LCF×/SCORE row + score bar + 7-driver chips N1WASTE EGTMARG LCFLOSS TODMARG GAMMA2 TIRESP BRKENG + tier-coloured advice notes citing FCOM PI-11 / AC 25-13 / CS-25.121(b) click-to-fly · RUNWAYS tab per-airport row sorted by ac-count with TORA/TODA/ELEV/OAT/SURF + MEAN-ΔN1/OVR/SUB/HDG + tier-coloured worst-tier left-border · FLEX-CARD tab full takeoff-performance card for top-row aircraft with 12-cell DEP/ELEV/OAT/ISA-Δ/TORA/TODA/SURF/HDG/TOW/MTOW/W-MTOW%/σ grid + sky-bordered Flex result panel showing Tflex (28px), N1-optimum (28px), N1-used (28px tier-coloured) + 3 limit-margin bars TOD-vs-TODA / γ2-vs-CS25.121 / VLOF-vs-Vtire with tier-coloured progress + 3-cell engine-life-benefit grid EGT-margin-gain / LCF-cycle-mult / EGT-margin-lost-this-departure + tier-coloured advice cards · References Boeing 737/777/787 FCOM PI-11 §11.20 ATM Takeoff Charts / Boeing PEM §3.4 D6-1420 vol I / Airbus FCOM PRO-NOR-SOP-13 Flex Takeoff / Airbus GTG Aircraft Performance §3.2 / Airbus GTG Engine Maintenance §2.6 / 14 CFR §25.107 §25.111 §25.113 §25.121(a)(b)(c)(d) §25.143 / 14 CFR §121.189 §121.193 §121.195 / AC 25-13 Reduced & Derated Takeoff Thrust / AC 25.1581-1 / AC 91-79B App.1 / EASA CS-25.121 / AMC 25-13 / AMC 25.1581 / ICAO Doc 8168 Vol I Pt V §1 / Doc 9760 Vol II Pt IV / Doc 9889 §A.4 reduced-thrust fuel-burn / IATA Fuel Efficiency Gap Analysis 2024 §4.2 / IATA Best Practice for Reduced Thrust Takeoffs ed.2 2023 / CFM SB CFM56-7B 72-0234 / LEAP-1A 72-0188 / GE GE90 SB 72-0451 / GEnx SB 72-0212 / RR Trent 900 SB 72-AF192 / Trent 1000 SB 72-AG215 / PW1100G SB 72-0143 / PW4000 SB 72-0289 / NTSB AAR-89-04 USAir 5050 LGA · FLEX entry registered in Layers Analysis category after ALTN, ft-flex persisted preference', showFlex, ()=>{ const nv=!showFlex; setShowFlex(nv); lsSet('ft-flex', nv) }],
                ['VFE · Flap / Slat / Gear Extension-Speed Margin Monitor · per-airframe high-speed evaluator of the certified secondary-control envelope VFE (Velocity Flaps Extended) VSE (Slats) VLE/VLO (Landing Gear) and VFTO (Final Takeoff Speed) per 14 CFR §25.345 §25.729 §25.103 §25.107 §25.111 §25.1583 / EASA CS-25.345 / CS-25.729 / AMC 25.1581 OM-B / FAA AC 25-7D §6 §13 / ICAO Annex 8 Pt IIIA §1.2 / Doc 9760 Vol II Pt IV §3 · structurally distinct from VMO/MMO (clean-config Vne), STALL (low-speed α-floor), GUST (Δn structural-load), FLUTTER (aeroelastic eigen-mode) — VFE measures the OPPOSITE high-speed limit of *deployed* high-lift devices and landing gear during configuration changes on the arrival/departure envelope · 8-class certified VFE/VSE/VLE/VLO catalogue KIAS HVY-T B777/B787/A350/A330 F1=265 F5=240 F15=215 F20=200 F25=190 F30=180 VLE=270 VLO=270/250 VFTO=210 / HVY-Q B748/A380 F1=270 F5=240 F10=220 F20=200 F25=190 F30=178 VLE=270 VFTO=215 / WB-M B767/A330ceo F1=255 F5=235 F15=215 F20=200 F25=190 F30=170 VLE=270 VFTO=205 / NB B737/A320/A321 F1=250 F5=220 F10=210 F15=200 F25=190 F30=170 F40=158 VLE=270 VLO=235/250 VFTO=195 / RGN-J E190/CRJ9/AT76 F1=230 F2=215 F4=200 F5=190 FF=170 VLE=250 VFTO=185 / RGN-T AT72/Q400 F15=185 F30=170 F45=140 VLE=200 VFTO=150 / BIZ G650/GLEX/FA8X F1=250 F2=220 F3=210 FF=180 VLE=250 VFTO=200 / LIGHT PC12/C25B F1=200 F2=180 FF=150 VLE=180 VFTO=170 sourced from Boeing 737/757/767/777/787/747 FCOM Limits Ch.1 + FCTM / Airbus A320/A330/A350/A380 FCOM LIM-21 + FCTM PRO-NOR / Embraer E170/E190/E195 AFM §2 / Bombardier CRJ AFM §2 / ATR-72/Q400 FCOM §2.04 / G650/GLEX/FA8X/PC-12/CitationMustang AFM §2 · phase classifier APPR-FNL (FL&lt;40 VS&lt;-500fpm GS&lt;220) gear-down + landing flap range / APPR-INT (FL&lt;120 VS&lt;-300fpm GS&lt;280) progressive intermediate flap + gear-down below 2500ft / TMA (FL&lt;150 partial flap likely above 200kt) / DEPT (VS&gt;+600 FL&lt;80) flap retract schedule + gear-up after 800ft AGL / CLEAN (FL&gt;180 no deployment) / GND · configuration inference per icao24 hash + phase + GS-vs-Vref since public ADS-B feed has no flap/gear discrete · 6 risk drivers VFE-MAR |IAS-VFE_inferred|/15kt ramp / VLE-MAR |IAS-VLE| margin on gear-down APPR / VFTO below Final-Takeoff-Speed at flap-retract / RETRACT flap-retract-while-fast schedule violation / CHANGE Δflap-detent-per-15s burst-rate hazard / ICING icing-band IAS bias must add +10kt at detents per FCOM ICE · composite max·0.66 + mean·0.34 × ADV-MUL · hard escalators IAS&gt;VFE_inferred score-min 92 immediate retract / IAS&gt;VLE on gear-down APPR 88 risk gear-door tear / Flap-retract at IAS&lt;VFTO climb 80 / APPR F30/F40 with IAS&gt;Vref+30 72 · 6 tiers BUST ≥85 rose over VFE/VLE immediate retract per FCOM LIM Ch.1 (14 CFR §25.345) / CRITICAL ≥65 rose-pink within 10kt of VFE anticipate retract or reduce thrust per FCTM Approach / TIGHT ≥45 amber within 20kt of VFE / ADEQUATE ≥22 sky normal arrival-config envelope / NOMINAL &lt;22 emerald clean-config or well-margined / IDLE slate on-ground or cruise-clean · MapLibre overlay tier-coloured halo rings 7-19px score-sized + class-coloured inner ring + BUST/CRITICAL rose pins + cs/band/ΔkT labels · Side panel 6-tier counter strip click-to-filter ALL + 5-cell summary μ-SCORE / μ-VFE-MAR / BUST / CRIT / WORST-cs + 2 sliders ADV-MUL 50-200pct / MAX-FL 50-400 + ICING checkbox + 8-class chip filter + HALO/PIN/LBL toggles + search by callsign/type/class + AIRCRAFT/CLASSES/ENVELOPE tab switcher · AIRCRAFT tier-worst-first row stack with cs+type+class-pill+phase-pill+tier-pill + IAS/VFE/Δ/VLE-Δ 4-cell + tier-coloured score bar + 6-driver chips VFEMAR VLEMAR VFTO RETRACT CHANGE ICING + tier-coloured advice line citing FCOM LIM Ch.1 / 14 CFR §25.345 / §25.729 / FAA InFO 14001 / FCOM ICE click-to-fly · CLASSES per-class row with cls-pill + VLE/VLO/VFTO/Vref cells + AFM citation italic + μ-SCORE / μ-Δ / BUST / CRIT 4-cell + per-detent VFE chip strip · ENVELOPE tab full SVG IAS-vs-altitude plot 80-300kt × 0-15000ft with amber dashed VFE vertical lines per flap detent + red dashed VLE landing-gear line + sky dotted VFTO line + fleet aircraft plotted as tier-coloured dots at (IAS, alt) coords + picked aircraft highlight + methodology narrative citing NTSB AAR-92-04 USAir 405 LGA flap-icing / AAR-96-06 ValuJet 597 ATL / AAR-09-03 Pinnacle 3701 / TSB A07A0134 ACA A319 · References 14 CFR §25.345 high-lift devices / §25.729 landing gear / §25.103 V_S / §25.107 V1/VR/V2 / §25.111 climb / §25.149 V_MCA / §25.1583 operating limits / EASA CS-25.345 / CS-25.729 / AMC 25.1581 OM-B / FAA AC 25-7D §6 §13 / ICAO Annex 8 Pt IIIA §1.2 / Doc 9760 Vol II Pt IV §3 / Boeing 737/757/767/777/787/747 FCOM Limits Ch.1 + FCTM / Airbus A320/A330/A350/A380 FCOM LIM-21 + FCTM PRO-NOR / Embraer E170/E190/E195 AFM §2 / Bombardier CRJ AFM §2 / ATR-72/Q400 FCOM §2.04 / NTSB AAR-92-04 USAir 405 LGA flap-icing / AAR-96-06 ValuJet 597 ATL flap retract / AAR-09-03 Pinnacle 3701 cruise-flap bust / BEA AF F-GZCP §3.4 / TSB A07A0134 ACA A319 / FAA InFO 14001 flap-retract energy mgmt / IATA FCG-005 §5 configuration management. VFE entry registered in Layers Safety category after WXAD, ft-vfe persisted preference', showVfe, ()=>{ const nv=!showVfe; setShowVfe(nv); lsSet('ft-vfe', nv) }],
                ['DECRAB · Crosswind-Landing Decrab Tire-Sideload & Touchdown-Drift Monitor · per-airframe live evaluator of the expected decrab-manoeuvre tire side-load, touchdown drift and runway-width budget for every flight in the final-approach window (FL<40 GS<200kt VS<-300fpm) snapped to the nearest aligned IATA runway, given the certified maximum demonstrated crosswind component per Boeing AFM §1 / Airbus AFM Lim §1.4 and the per-class main-gear-tire side-slip energy budget · distinct from CROSSWIND-COMPASS (head/cross vector resolution), TAIL-STRIKE (pitch-attitude limit), ROW-ROP (rollout overrun), STABLE-APPROACH (gate gross checks) — DECRAB targets the touchdown technique itself: how much side-force the gear sees during the decrab kick and how far the airplane drifts before main-gear spin-up · 8-class certified envelope catalogue (dry/wet KIAS crosswind component max-demonstrated for landing) HVY-T B777/B787/A350/A330 38/25 / HVY-Q B748/A380 40/28 / WB-M B767/A330ceo 36/25 / NB B737NG-MAX/A320-family 33/25 / RGN-J E190/CRJ9/E195 32/22 / RGN-T AT72/Q400 25/18 / BIZ G650/GLEX/FA8X 28/20 / LIGHT PC12/C25B 20/15 per FCTM Ch.6 + AFM Lim §1.4 + ATR FCOM 2.04 + Embraer AFM §2 · two recognised touchdown techniques per FCTM UPWIND-WHEEL slip into the wind downwind wing low partial-decrab residual crab ≤5° preferred narrow-body vs FULL-DECRAB kick rudder level wings at flare align fuselage with centreline preferred wide-body and engine-pod clearance · decrab side-load proxy F_side/W ≈ sin(crab_residual)·(V_app)²/(g·R_turn) with class constants giving a normalised dimensionless tire-sideload index 0-1.4 where 1.0 = limit-load tire side-slip rating per Goodyear Aircraft Tire Engineering Manual §4 · touchdown drift D_drift m = V_cross_ms × t_align with t_align 1.8s NB/RGN 2.3s WB 3.0s HVY-Q per Boeing FCTM Ch.6 / Airbus FCTM PRO-NOR-SOP-22 · runway-width budget = (RWY_width − wheelbase_proj)/2 − D_drift with wheelbase proj per class 3-12m; negative → off-side excursion risk · 6 risk drivers WIND crosswind/max-demo ratio ×100 / SIDE normalised tire side-slip vs limit / DRIFT touchdown drift vs RWY half-width / GUST gust component above steady ×1.3 / POD engine-pod clearance crab limit (HVY/WB) / TECH technique vs class preference penalty · composite max·0.66 + mean·0.34 × ADV-MUL · hard escalators crosswind>max-demo score-min 92 / tire side-slip>1.1 limit 84 / drift>RWY half-width − 1.5m 78 / gust>10kt over steady on HVY 70 · 6 tiers BUST ≥85 rose diversion candidate per FCTM Approach & Landing (14 CFR §25.237) / CRITICAL ≥65 rose-pink within 5kt of max-demo brief crew technique per FCTM Ch.6 / TIGHT ≥45 amber within 10kt of max-demo monitor gust evolution / ADEQUATE ≥22 sky normal crosswind handling envelope / NOMINAL <22 emerald near-calm or well in-limits / IDLE slate not on final approach · MapLibre overlay tier-coloured halo rings 7-19px score-sized + class-coloured inner ring + BUST/CRITICAL rose pins + dashed wind-arrow lines (top-12 worst) tier-coloured from AC pointing into wind direction sized by crosswind kt + cs/apt-icao/xw-kt labels · Side panel 6-tier counter strip click-to-filter ALL + 5-cell summary μ-XW / μ-SIDE / BUST / CRIT / WORST-cs + 2 sliders ADV-MUL 50-200% / GUST-MUL 50-180% + Wet/contaminated runway checkbox (lowers max-demo per AFM Lim §1.4) + 8-class chip filter + HALO/PIN/LBL/ARR toggles + search by callsign/type/airport-icao + AIRCRAFT/CLASSES/POLAR tab switcher · AIRCRAFT tier-worst-first row stack with cs+type+class-pill+tier-pill + airport-icao+runway-hdg + 4-cell XW/HW/SIDE/DRIFT + 4-cell RWY-W/MARG/CRAB/TECH + tier-coloured score bar + 6-driver chips WIND SIDE DRIFT GUST POD TECH + tier-coloured advice citing FCTM Ch.6 / AC 25-7D §6.5 / FCOM Lim Ch.1 / Goodyear ATEM §4 / NTSB AAR-04-04 Air Midwest 5481 CLT / TSB A05H0002 ACA A340 TRD click-to-fly · CLASSES per-class row with cls-pill + max-demo dry/wet KIAS + Vapp + technique + 4-cell μ-XW/μ-SIDE/BUST/CRIT + AFM citation italic · POLAR tab full SVG crosswind/headwind polar plot 460×320 with concentric kt rings + amber NB-max-demo 33kt dashed reference ring + violet HVY-max-demo 38kt dashed reference ring + axis labels HW→ ↑XW with tick marks every 10/20 kt + fleet plotted as tier-coloured dots positioned by (windHead, windCross) coordinates + picked aircraft highlighted with white stroke + picked annotation cs/cls/apt/technique/tier/score readout + methodology narrative citing 14 CFR §25.237 / CS-25.237 / FCTM / Goodyear ATEM §4 + references list · References 14 CFR §25.237 wind velocities (crosswind cert) / FAA AC 25-7D §6.5 lateral control demonstration / FAA AC 91-79B App.1 runway excursion mitigations / EASA CS-25.237 / AMC 25.237 / Boeing FCTM Ch.6 Approach & Landing — Crosswind / Boeing FCOM Limitations Ch.1 max-demonstrated crosswind / Airbus FCTM PRO-NOR-SOP-22 Crosswind Landing / Airbus FCOM PRO-NOR-SOP-32 / LIM-22 / Embraer AFM §2.4 max-demo crosswind / ATR FCOM 2.04 / FAA-H-8083-3C Airplane Flying Handbook Ch.8 / Goodyear Aircraft Tire Engineering Manual §4 tire side-slip rating / NTSB AAR-04-04 Air Midwest 5481 CLT off-side excursion / NTSB AAR-09-04 Continental 1404 DEN runway excursion / TSB A05H0002 Air Canada A340 TRD off-runway / TSB A07A0134 ACA A319 / IATA Runway Excursion Risk Reduction Toolkit 2024 · DECRAB entry registered in Layers Safety category after VFE, ft-decrab persisted preference', showDecrab, ()=>{ const nv=!showDecrab; setShowDecrab(nv); lsSet('ft-decrab', nv) }],
              ]},
              {group:'Routes & Flow', items:[
                ['Overhead', showOverhead, ()=>{ const nv=!showOverhead; setShowOverhead(nv); lsSet('ft-overhead', nv) }],
                ['Route planner', showRoute, ()=>{ const nv=!showRoute; setShowRoute(nv); lsSet('ft-route', nv) }],
                ['Step climb', showStepClimb, ()=>{ const nv=!showStepClimb; setShowStepClimb(nv); lsSet('ft-stepclimb', nv) }],
                ['ETOPS', showEtops, ()=>{ const nv=!showEtops; setShowEtops(nv); lsSet('ft-etops', nv) }],
                ['Departure seq', showDepSeq, ()=>{ const nv=!showDepSeq; setShowDepSeq(nv); lsSet('ft-depseq', nv) }],
                ['Crosswind', showXwind, ()=>{ const nv=!showXwind; setShowXwind(nv); lsSet('ft-xwind', nv) }],
                ['Jet stream', showJet, ()=>{ const nv=!showJet; setShowJet(nv); lsSet('ft-jet', nv) }],
                ['WAFS · Upper-Wind Optimum-FL Advisor · pseudo-WAFC grid scan across ICAO Annex 3 App.2 mandatory pressure levels (FL050/100/140/180/240/270/300/340/390/450/530) selecting the tailwind-optimal cruise FL for each airframe in current heading subject to Ellrod TI2 ≤ MODERATE + class service-ceiling + ΔFL ≤ ±60 step-climb gate · 6 drivers LOST-GS / ΔFUEL / CAT-EXP / MISS-OPT / TROPO-PEN / CONF · 6 tiers SUB-OPT ≥80 rose / POOR ≥60 rose-pink / OFF-OPT ≥40 amber / NOMINAL ≥20 sky / OPTIMAL <20 emerald / NOT-CRZ slate · MapLibre halo+pin+label + LEVELS per-FL μ-TW aggregate + WIND vertical tailwind/CAT profile SVG (ICAO Annex 3 App.2 / Doc 7488 ISA / Doc 9974 IWXXM / NOAA WAFS GRIB2 / UKMO WAFC London / Ellrod & Knapp Wea.Forecasting 7 1992 / Endlich JAM 3 1964 / ICAO Doc 4444 §15.2.5 / FAA AC 00-30C / AC 00-45H §5 / Boeing FCOM PI-22 / Airbus GTG Aircraft Performance §3.7 / Sharman JAM 45 2006 GTG / Lee Atmos.Env. 244 2021)', showWafs, ()=>{ const nv=!showWafs; setShowWafs(nv); lsSet('ft-wafs', nv) }],
                ['Holding stack', showHstack, ()=>{ const nv=!showHstack; setShowHstack(nv); lsSet('ft-hstack', nv) }],
                ['Curfew', showCurfew, ()=>{ const nv=!showCurfew; setShowCurfew(nv); lsSet('ft-curfew', nv) }],
                ['Approach seq', showAprSeq, ()=>{ const nv=!showAprSeq; setShowAprSeq(nv); lsSet('ft-aprseq', nv) }],
                ['Oceanic tracks', showOcean, ()=>{ const nv=!showOcean; setShowOcean(nv); lsSet('ft-ocean', nv) }],
                ['FIR load', showFir, ()=>{ const nv=!showFir; setShowFir(nv); lsSet('ft-fir', nv) }],
                ['SAR planner', showSar, ()=>{ const nv=!showSar; setShowSar(nv); lsSet('ft-sar', nv) }],
                ['Stable approach', showStable, ()=>{ const nv=!showStable; setShowStable(nv); lsSet('ft-stable', nv) }],
                ['Approach mins', showApMin, ()=>{ const nv=!showApMin; setShowApMin(nv); lsSet('ft-apmin', nv) }],
                ['CDA compliance', showCda, ()=>{ const nv=!showCda; setShowCda(nv); lsSet('ft-cda', nv) }],
                ['CCO · Continuous Climb Operations (Doc 9993 / AC 91-86 / JO 7110.65 §4-5 / EUROCONTROL CCO ConOps / FCOM PI-22)', showCco, ()=>{ const nv=!showCco; setShowCco(nv); lsSet('ft-cco', nv) }],
                ['WAT · Weight/Alt/Temp 2nd-segment climb-limit · hot-and-high MTOW envelope (FAR 25.121 / CS-25.121 / AC 25-7D / AC 120-91A / AMC 25-13 / Boeing PI-22 / Airbus FPOM 3.04 / CAP 698 §4 / NTSB AAR-89-04 USAir 5050)', showWat, ()=>{ const nv=!showWat; setShowWat(nv); lsSet('ft-wat', nv) }],
                ['A-CDM · TOBT/TSAT/ATOT milestones & departure pre-sequencer (EUROCONTROL A-CDM IM ed.5 / CDM ConOps ed.2.1 / ICAO Doc 9971 / EU 716/2014 PCP §AF-3 / FAA SCDM-TFDM)', showAcdm, ()=>{ const nv=!showAcdm; setShowAcdm(nv); lsSet('ft-acdm', nv) }],
                ['AMAN / E-AMAN · Arrival sequencer ETA/STA/delay & wake-pair gap (EUROCONTROL E-AMAN ConOps ed.1.4 / SESAR PJ.01-W2 / Doc 9971 Pt II Ch 6 / JO 7110.65 §5-8 §5-9 / JO 7110.117 TBFM / RECAT-EU ed.3)', showAman, ()=>{ const nv=!showAman; setShowAman(nv); lsSet('ft-aman', nv) }],
                ['SID climb', showSidc, ()=>{ const nv=!showSidc; setShowSidc(nv); lsSet('ft-sidc', nv) }],
                ['ETP / CP', showEtp, ()=>{ const nv=!showEtp; setShowEtp(nv); lsSet('ft-etp', nv) }],
                ['Re-dispatch · RDP fuel reserve (FAR 121.631(c) / RCF)', showRedispatch, ()=>{ const nv=!showRedispatch; setShowRedispatch(nv); lsSet('ft-redispatch', nv) }],
                ['Optimum-Altitude · SAR / tropopause / step-climb (AC 120-103A)', showOptAlt, ()=>{ const nv=!showOptAlt; setShowOptAlt(nv); lsSet('ft-optalt', nv) }],
                ['MSAW · APW controller-side low-altitude warning (JO 7110.65 §5-15)', showMsaw, ()=>{ const nv=!showMsaw; setShowMsaw(nv); lsSet('ft-msaw', nv) }],
                ['TDWR / LLWAS-NE · terminal wind-shear / microburst (JO 7110.65 §3-1-8 / AC 00-54 / ICAO Doc 9817)', showTdwr, ()=>{ const nv=!showTdwr; setShowTdwr(nv); lsSet('ft-tdwr', nv) }],
                ['MTCD · medium-term conflict detection 8-20min trajectory probe (Doc 4444 §15.7 / EUROCONTROL iFACTS / ED-202A / JO 7110.65 §5-7)', showMtcd, ()=>{ const nv=!showMtcd; setShowMtcd(nv); lsSet('ft-mtcd', nv) }],
                ['STCA · Short-Term Conflict Alert controller safety-net 60-180s CPA probe (Doc 4444 §15.7 / EUROCONTROL STCA Spec ed.1.0 / Safety Nets Implementation Guideline 2018 / ED-202A / ED-153 / JO 7110.65 §5-7 / JO 6190.18 / Annex 11 §2.27 / CAP 670 SUR §5)', showStca, ()=>{ const nv=!showStca; setShowStca(nv); lsSet('ft-stca', nv) }],
                ['CLAM / RAM · Cleared Level & Route Adherence ground safety-net · CFL vertical / cross-track lateral conformance (EUROCONTROL Safety Nets Implementation Guideline 2018 / CLAM Spec ed.1.0 / RAM Spec ed.1.2 / EUROCAE ED-202A / ED-153 / ICAO Doc 4444 §15.7 / Annex 11 §2.27 / Doc 9426 III.4 / FAA JO 7110.65 §5-6-1 / JO 6190.18 / CAP 670 SUR §5 / CAP 710 Level Bust Action Plan / EASA SIB 2018-04 / BFU 02-02 Überlingen)', showClam, ()=>{ const nv=!showClam; setShowClam(nv); lsSet('ft-clam', nv) }],
                ['CSC · Call-Sign Confusion & R/T mis-identification · pairwise similarity / transpose / 1-digit Δ / anagram (ICAO Doc 9870 §4 / Doc 4444 §12.3 / Annex 10 Vol II §5.2 / EASA SIB 2018-08 / EUROCONTROL AGC-AP / CSC Hot-Spot Tool 2019 / FAA JO 7110.65 §2-4 / AC 120-71B ch 7 / CAP 413 §1.1 / CAP 745 §3 / NTSB AAR-91-08 LAX1493 / AAR-09-03 LEX5191)', showCsc, ()=>{ const nv=!showCsc; setShowCsc(nv); lsSet('ft-csc', nv) }],
                ['PMS · Point Merge System arrival sequencer (EUROCONTROL PMS ConOps v3 / DSNA STAC / CAP 1772 / Doc 9931 §4 / Doc 4444 §8)', showPms, ()=>{ const nv=!showPms; setShowPms(nv); lsSet('ft-pms', nv) }],
                ['FRA · Free Route Airspace direct-routing efficiency (EUROCONTROL FRA ConOps ed.3.0 / NMIR 2019/123 / Doc 9854 §3.6 / Doc 9931 §4 / Doc 9993 §3 / PCP AF-5)', showFra, ()=>{ const nv=!showFra; setShowFra(nv); lsSet('ft-fra', nv) }],
                ['CDR · Conditional Route activation & compliance (EUROCONTROL ASM Hbk ed.6 §3.4 / RAD / AUP-UUP / NMIR 2019/123 / Doc 9554 FUA / Doc 4444 §15 / Reg 2150/2005 / FAA JO 7110.65 §4-3 CDR-US Playbook)', showCdr, ()=>{ const nv=!showCdr; setShowCdr(nv); lsSet('ft-cdr', nv) }],
                ['DCB · Sector demand-capacity-balancing & overload (EUROCONTROL DCB Hbk ed.2.0 / ATFCM Ops Manual ed.27 §4.4 / NMIR 2019/123 §6 / Doc 9971 / JO 7210.3 §17 / JO 7110.65 §17-1)', showDcb, ()=>{ const nv=!showDcb; setShowDcb(nv); lsSet('ft-dcb', nv) }],
                ['HOLD · Racetrack holding-pattern & stack monitor · leg / spacing / fuel burn (ICAO Doc 4444 §6.5 / Doc 8168 Vol II Pt III §3.3 §3.5 / FAA AIM 5-3-7 / JO 7110.65 §4-4 / IATA FCG-005)', showHold, ()=>{ const nv=!showHold; setShowHold(nv); lsSet('ft-hold', nv) }],
                ['FIM · ASPA Flight-deck Interval Management · pairwise spacing / Vfim / RECAT wake (RTCA DO-328A / DO-361A / DO-317C / ICAO Doc 9854 §3.6 / Doc 9993 / FAA AC 20-172A / JO 7110.65 §5-3 / SESAR PJ.01-W2-04 / Boeing FCOM PI 11.32)', showFim, ()=>{ const nv=!showFim; setShowFim(nv); lsSet('ft-fim', nv) }],
                ['TASAR · Traffic Aware Strategic Aircrew Requests · wind/fuel/time-optimal route advisor with conflict + SUA probe (RTCA DO-381 / DO-388 / NASA ConOps v2.0 2017 / NASA TM-2013-218001 TAP / NASA TM-2015-218788 Alaska Airlines Trial / NASA TM-2018-219839 EFB Phase-2 / FAA AC 120-76D / AC 90-100A / ICAO Doc 4444 §4.5 / Doc 9931 §4 / Doc 9993 §3 / Doc 9613 / EUROCONTROL FRA ConOps ed.3.0 §4 / IATA FCG-005)', showTasar, ()=>{ const nv=!showTasar; setShowTasar(nv); lsSet('ft-tasar', nv) }],
                ['RWSL · Runway Status Lights · REL/THL/RIL surface conflict (FAA AC 150/5340-30J ch 14 / JO 7110.65 §3-1-12 / 6850.2B App F-G / RWSL ConOps ed.4 / AIM 2-1-6 / ICAO Doc 9476 SMGCS / Doc 9830 A-SMGCS)', showRwsl, ()=>{ const nv=!showRwsl; setShowRwsl(nv); lsSet('ft-rwsl', nv) }],
                ['ALTM · Altimeter Setting Region & TA/TL transition + cold-temp correction (ICAO Annex 2 §3.6 / Doc 8168 §I.2.7 / §4.3 / Doc 7030 / FAA AIM 7-2 / 14 CFR §91.121 / AC 91-79A / SERA.5005(d))', showAltm, ()=>{ const nv=!showAltm; setShowAltm(nv); lsSet('ft-altm', nv) }],
                ['VDL-2 / FANS-1A · datalink coverage & RCP/RSP handoff (DO-281B / Doc 9869 PBCS / AC 20-140C)', showVdl2, ()=>{ const nv=!showVdl2; setShowVdl2(nv); lsSet('ft-vdl2', nv) }],
                ['TBS · Time-Based Separation HW-compression (RECAT-EU / eTBS / LHR-TBS / JO 7110.65 §5-5 / CAP 1378)', showTbs, ()=>{ const nv=!showTbs; setShowTbs(nv); lsSet('ft-tbs', nv) }],
                ['VTF · Vector-to-Final intercept geometry (JO 7110.65 §5-9 / AIM 5-4-7 / Doc 4444 §8.6.5 / FCOM 11.31)', showVtf, ()=>{ const nv=!showVtf; setShowVtf(nv); lsSet('ft-vtf', nv) }],
                ['RFI · GNSS Jamming / Spoofing threat-zones (EASA SIB 2022-02R3 / 2023-09 / FAA InFO 22002 / Doc 9849 / EVAIR 27-28)', showRfi, ()=>{ const nv=!showRfi; setShowRfi(nv); lsSet('ft-rfi', nv) }],
                ['MNT · Oceanic Mach Number Technique compliance (Doc 4444 §5.4.2.4 / NAT Doc 007 Ch.6 / JO 7110.65 §8-1-4 / AC 91-70B Ch.6 / Doc 9869 PBCS)', showMnt, ()=>{ const nv=!showMnt; setShowMnt(nv); lsSet('ft-mnt', nv) }],
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
                ['TFM · GDP/GS/AFP/MIT/CTOP (ATCSCC/NMOC)', showTfm, ()=>{ const nv=!showTfm; setShowTfm(nv); lsSet('ft-tfm', nv) }],
                ['TOLD / V-speeds / BFL', showTold, ()=>{ const nv=!showTold; setShowTold(nv); lsSet('ft-told', nv) }],
                ['PCN / ACR pavement', showPcn, ()=>{ const nv=!showPcn; setShowPcn(nv); lsSet('ft-pcn', nv) }],
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
                ['D-ATIS · letter cycle', showDatis, ()=>{ const nv=!showDatis; setShowDatis(nv); lsSet('ft-datis', nv) }],
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
