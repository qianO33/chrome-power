export type BrowserErrorCode =
  | "browser_unavailable"
  | "invalid_request"
  | "resource_busy"
  | "operation_cancelled"
  | "navigation_failed"
  | "popup_failed"
  | "download_failed"
  | "upload_failed"
  | "tab_not_found"
  | "frame_not_found"
  | "selector_not_found"
  | "locator_not_found"
  | "element_ref_not_found"
  | "dialog_not_found"
  | "file_not_found"
  | "operation_failed"
  | "target_not_found"
  | "target_not_selected"
  | "target_unavailable"
  | "target_connection_failed"
  | "unsupported_in_attach_mode"

export type BrowserTargetMode = "launch" | "attach"
export type BrowserTargetState =
  | "available"
  | "connecting"
  | "connected"
  | "disconnected"
  | "unavailable"
  | "error"

export type BrowserTargetConnection =
  | {
      kind: "endpoint"
      endpoint: string
    }
  | {
      kind: "active_port"
      userDataDir?: string
      activePortFile?: string
    }

export type BrowserTargetDefinition = {
  id: string
  label: string
  browser: "chrome"
  connection: BrowserTargetConnection
}

export type BrowserTargetSummary = {
  id: string
  label: string
  browser: "chrome"
  mode: BrowserTargetMode
  state: BrowserTargetState
  connected: boolean
  tabCount?: number
  capabilities?: {
    attach: string[]
    unsupported: string[]
  }
}

export type BrowserTargetOperation =
  | {
      action: "list"
      targetId?: string
      confirmed?: true
    }
  | {
      action: "connect" | "select" | "disconnect"
      targetId: string
      confirmed?: true
    }

export type BrowserTargetData = {
  action: BrowserTargetOperation["action"]
  selectedTargetId?: string
  targets: BrowserTargetSummary[]
  target?: BrowserTargetSummary
}

export const COOKIE_ACTIONS = ["inject", "clear_target"] as const
export type CookieAction = (typeof COOKIE_ACTIONS)[number]

export const COOKIE_MODES = ["merge", "replace_target"] as const
export type CookieMode = (typeof COOKIE_MODES)[number]

export const COOKIE_SAME_SITE_VALUES = ["Strict", "Lax", "None"] as const
export type CookieSameSite = (typeof COOKIE_SAME_SITE_VALUES)[number]

export type CookieInput = {
  name: string
  value: string
  url?: string
  domain?: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: CookieSameSite
}

export type CookieOperationInput = {
  action: CookieAction
  targetId?: string
  tabId?: string
  url?: string
  cookieHeader?: string
  cookies?: CookieInput[]
  mode?: CookieMode
  persist?: boolean
  ttlSeconds?: number
  reload?: boolean
}

export type CookieTargetData = {
  scheme: "http" | "https"
  host: string
  port?: number
}

export type CookieOperationData = {
  action: CookieAction
  target: CookieTargetData
  tabId: string
  inputFormat?: "cookie_header" | "structured"
  inputCount?: number
  appliedCount?: number
  clearedTarget: boolean
  mode?: CookieMode
  persistent: boolean
  reloaded: boolean
  warnings?: Array<"localhost_cookie_scope_shared">
}

export type BrowserError = {
  code: BrowserErrorCode
  message: string
}

export type ClientSessionInfo = {
  id: string
  selectedTargetId?: string
  activeTabId?: string
}

type ToolResultData<TData> = TData extends object
  ? TData & { clientSession?: ClientSessionInfo }
  : TData

export type ToolResult<TData = unknown> = {
  sessionId: string
  targetId?: string
  tabId?: string
  url?: string
  title?: string
} & (
  | {
      ok: true
      data?: ToolResultData<TData>
      error?: never
    }
  | {
      ok: false
      data?: never
      error: BrowserError
    }
)

export type TabInfo = {
  id: string
  active: boolean
  sessionActive?: boolean
  url: string
  title: string
}

export type PopupData = TabInfo & {
  openerTabId: string
}

export type RuntimeMode = "direct" | "owner"

export type RuntimeMetadata = {
  packageVersion: string
  deployedCommit?: string
  mode: RuntimeMode
}

export type OwnerStatusData = {
  transport: "socket" | "tcp"
  endpoint: string
  activeSessionCount: number
  globalOperationInProgress: boolean
}

export type ResourceProtectionLimits = {
  maxConcurrentCalls: number
  maxQueuedCalls: number
  maxDiagnosticWaits: number
  queueWaitTimeoutMs: number
}

export type ResourceProtectionSchedulerStatus = {
  limits: ResourceProtectionLimits
  active: {
    scheduled: number
    regular: number
    diagnosticWait: number
    urgentControl: number
  }
  queued: {
    total: number
    regular: number
    diagnosticWait: number
  }
  highWaterMarks: {
    scheduled: number
    queued: number
    diagnosticWait: number
    urgentControl: number
  }
  totals: {
    started: number
    completed: number
    rejectedQueueFull: number
    timedOutInQueue: number
    cancelledInQueue: number
  }
}

export type ResourceProtectionStatus = ResourceProtectionSchedulerStatus & {
  memory: {
    rssBytes: number
    heapTotalBytes: number
    heapUsedBytes: number
    externalBytes: number
    arrayBuffersBytes: number
  }
}

export type SharedOperationImpact = {
  sessionCount: number
  tabCount: number
}

export type CloseData = {
  closed: string[]
  affected?: SharedOperationImpact
}

export const SUPPORTED_ARTIFACT_TYPES = ["screenshot", "download"] as const

export type ArtifactType = (typeof SUPPORTED_ARTIFACT_TYPES)[number]

export type ArtifactEntry = {
  type: ArtifactType
  name: string
  path: string
  size: number
  modifiedTime: string
}

export type ArtifactsData = {
  roots: {
    screenshots: string
    downloads: string
  }
  artifacts: ArtifactEntry[]
}

export type ViewportPresetName = "desktop" | "tablet" | "mobile"

export type ViewportSize = {
  width: number
  height: number
}

export type ViewportData = ViewportSize & {
  mode: "window" | "fixed"
  preset?: ViewportPresetName
  presets: Record<ViewportPresetName, ViewportSize>
}

export const SUPPORTED_DEVICE_PRESETS = [
  "desktop-chrome",
  "desktop-chrome-hidpi",
  "pixel-5",
  "pixel-5-landscape",
  "galaxy-tab-s9",
  "galaxy-tab-s9-landscape",
] as const

export type BrowserDevicePresetName =
  (typeof SUPPORTED_DEVICE_PRESETS)[number]

export type BrowserDeviceEmulationData = {
  userAgent: string
  deviceScaleFactor: number
  hasTouch: boolean
  isMobile: boolean
}

export type BrowserDevicePresetData = {
  name: BrowserDevicePresetName
  label: string
  source: "playwright"
  browserType: "chromium"
  viewport: ViewportSize
  emulation: BrowserDeviceEmulationData
}

export type DeviceData = {
  presets: BrowserDevicePresetData[]
  active?: {
    name: BrowserDevicePresetName
    label: string
  }
  contextLaunched: boolean
  appliedToCurrentContext: boolean
  relaunchRequired: false
  relaunched: boolean
  affected?: SharedOperationImpact
}

export const SUPPORTED_BROWSER_PERMISSIONS = [
  "geolocation",
  "notifications",
] as const

export type BrowserPermissionName =
  (typeof SUPPORTED_BROWSER_PERMISSIONS)[number]

export type GeolocationData = {
  latitude: number
  longitude: number
  accuracy?: number
}

export type PermissionGrantData = {
  permissions: BrowserPermissionName[]
  origin?: string
}

export type EnvironmentData = {
  geolocation?: GeolocationData
  permissionGrants: PermissionGrantData[]
  supportedPermissions: BrowserPermissionName[]
  deferred: {
    contextRelaunchRequired: string[]
  }
}

export const SUPPORTED_EMULATION_FIELDS = [
  "userAgent",
  "locale",
  "timezoneId",
  "deviceScaleFactor",
  "hasTouch",
  "isMobile",
] as const

export type BrowserEmulationField =
  (typeof SUPPORTED_EMULATION_FIELDS)[number]

export type ContextEmulationOverrides = {
  userAgent?: string
  locale?: string
  timezoneId?: string
  deviceScaleFactor?: number
  hasTouch?: boolean
  isMobile?: boolean
}

export type EmulationData = {
  overrides: ContextEmulationOverrides
  supported: BrowserEmulationField[]
  contextLaunched: boolean
  appliedToCurrentContext: boolean
  relaunchRequired: false
  relaunched: boolean
  affected?: SharedOperationImpact
}

export type OfflineData = {
  offline: boolean
  contextLaunched: boolean
  appliedToCurrentContext: boolean
  affected?: SharedOperationImpact
}

export const SUPPORTED_MEDIA_FIELDS = [
  "colorScheme",
  "reducedMotion",
  "forcedColors",
] as const

export type BrowserMediaField = (typeof SUPPORTED_MEDIA_FIELDS)[number]
export type BrowserColorScheme = "light" | "dark" | "no-preference"
export type BrowserReducedMotion = "reduce" | "no-preference"
export type BrowserForcedColors = "active" | "none"

export type MediaOverrides = {
  colorScheme?: BrowserColorScheme
  reducedMotion?: BrowserReducedMotion
  forcedColors?: BrowserForcedColors
}

export type MediaData = {
  overrides: MediaOverrides
  supported: BrowserMediaField[]
}

export type StatusDiagnosticCounts = {
  tabId: string
  consoleLogCount: number
  pageErrorCount: number
  networkEventCount: number
  webSocketEventCount: number
  dialogOpen: boolean
  snapshotRefCount: number
}

export type StatusData = {
  sessionId: string
  selectedTargetId?: string
  targets?: BrowserTargetSummary[]
  clientSession?: ClientSessionInfo
  runtime: RuntimeMetadata
  owner?: OwnerStatusData
  resourceProtection?: ResourceProtectionStatus
  contextLaunched: boolean
  activeTabId?: string
  tabCount: number
  tabs: TabInfo[]
  config: {
    headless: boolean
    slowMoMs: number
    namespace: {
      mode: "shared" | "isolated"
      name?: string
    }
    profileDir: string
    screenshotDir: string
    screenshotInlineMaxBytes: number
    downloadDir: string
    cookie: {
      allowedOriginCount: number
      maxTtlSeconds: number
    }
  }
  environment: EnvironmentData
  diagnostics: {
    tabs: StatusDiagnosticCounts[]
  }
}

export type FrameInfo = {
  id: string
  parentId?: string
  main: boolean
  name?: string
  url: string
  title?: string
}

export type BrowserLoadState = "load" | "domcontentloaded" | "networkidle"

export type DialogInfo = {
  type: "alert" | "beforeunload" | "confirm" | "prompt"
  message: string
  defaultValue?: string
}

export type LocatorQuery = {
  selector?: string
  role?: string
  name?: string
  text?: string
  label?: string
  placeholder?: string
  testId?: string
  exact?: boolean
  index?: number
}

export type LocatorTextKind = "innerText" | "textContent"

export type LocatorWaitState = "attached" | "detached" | "visible" | "hidden"

export type LocatorCountData = {
  count: number
}

export type LocatorTextData = {
  text?: string | null
  texts?: string[]
}

export type LocatorAttributeData = {
  name: string
  value: string | null
}

export type LocatorStateData = {
  count: number
  visible: boolean
  enabled: boolean
}

export type ConsoleLogLevel = "debug" | "info" | "log" | "warn" | "error"

export type ConsoleLogEntry = {
  level: ConsoleLogLevel
  message: string
  timestamp: string
  url?: string
}

export type ConsoleLogWaitData = {
  entry: ConsoleLogEntry
  matchedExisting: boolean
  cleared: boolean
}

export type ConsoleLogsOptions = {
  tabId?: string
  levels?: Array<ConsoleLogLevel | "warning">
  filter?: string
  limit?: number
  clear?: boolean
}

export type ConsoleLogWaitOptions = Omit<ConsoleLogsOptions, "limit"> & {
  timeoutMs?: number
}

export type PageErrorEntry = {
  message: string
  timestamp: string
  name?: string
  stack?: string
}

export type PageErrorWaitData = {
  entry: PageErrorEntry
  matchedExisting: boolean
  cleared: boolean
}

export type PageErrorsOptions = {
  tabId?: string
  filter?: string
  limit?: number
  clear?: boolean
}

export type PageErrorWaitOptions = Omit<PageErrorsOptions, "limit"> & {
  timeoutMs?: number
}

export type NetworkEventType = "response" | "request_failed"

export type NetworkEventEntry = {
  type: NetworkEventType
  timestamp: string
  url: string
  method: string
  resourceType: string
  status?: number
  statusText?: string
  failureText?: string
  fromServiceWorker?: boolean
  frameId?: string
}

export type NetworkQueryOptions = {
  tabId?: string
  types?: NetworkEventType[]
  filter?: string
  statusMin?: number
  statusMax?: number
}

export type NetworkEventsOptions = NetworkQueryOptions & {
  limit?: number
  clear?: boolean
}

export type NetworkWaitEventOptions = NetworkQueryOptions & {
  timeoutMs?: number
  clear?: boolean
}

export type NetworkSummaryOptions = NetworkQueryOptions & {
  limit?: number
}

export const ASSET_KINDS = [
  "image",
  "background_image",
  "font",
  "stylesheet",
  "script",
  "video",
  "audio",
  "inline_svg",
  "other",
] as const

export type AssetKind = (typeof ASSET_KINDS)[number]

export const ASSET_OBSERVATION_STATES = [
  "loaded",
  "failed",
  "declared_unobserved",
  "observed",
  "inline",
] as const

export type AssetObservationState = (typeof ASSET_OBSERVATION_STATES)[number]

export const ASSET_ORIGIN_RELATIONSHIPS = [
  "same_origin",
  "cross_origin",
  "opaque",
  "inline",
] as const

export type AssetOriginRelationship =
  (typeof ASSET_ORIGIN_RELATIONSHIPS)[number]

export const ASSET_SORT_MODES = [
  "discovery",
  "transfer_size",
  "decoded_size",
  "rendered_area",
] as const

export type AssetSortMode = (typeof ASSET_SORT_MODES)[number]

export type AssetRenderedSizeRange = {
  minWidth: number
  minHeight: number
  maxWidth: number
  maxHeight: number
}

export type AssetRecord = {
  assetId: string
  kind: AssetKind
  state: AssetObservationState
  origin: AssetOriginRelationship
  provenance: Array<"dom" | "network" | "performance" | "inline">
  occurrenceCount: number
  url?: string
  scheme?: string
  tagNames?: string[]
  loading?: string[]
  rendered?: AssetRenderedSizeRange
  intrinsicWidth?: number
  intrinsicHeight?: number
  viewBox?: { x: number; y: number; width: number; height: number }
  network?: Omit<NetworkEventEntry, "url" | "frameId">
  performance?: {
    initiatorType: string
    startTime: number
    duration: number
    sizeAvailable: boolean
    transferSize?: number
    encodedBodySize?: number
    decodedBodySize?: number
  }
}

export type AssetInventoryData = {
  frameId: string
  frameUrl: string
  assets: AssetRecord[]
  totalDiscovered: number
  matchingCount: number
  returnedCount: number
  limit: number
  truncated: boolean
  completeness: {
    domScanned: true
    domOccurrenceCount: number
    backgroundElementsScanned: number
    backgroundScanTruncated: boolean
    performanceEntryCount: number
    networkEventCount: number
    caveats: string[]
  }
}

export const PERFORMANCE_RESOURCE_SORT_MODES = [
  "duration",
  "transfer_size",
  "decoded_size",
] as const
export type PerformanceResourceSortMode =
  (typeof PERFORMANCE_RESOURCE_SORT_MODES)[number]
export type PerformanceRating = "good" | "needs_improvement" | "poor"
export type PerformanceMetric = {
  available: boolean
  value?: number
  unit: "ms" | "score"
  rating?: PerformanceRating
  reason?: string
}
export type PerformanceResourceSummary = {
  kind: AssetKind
  url?: string
  scheme: string
  initiatorType: string
  startTimeMs: number
  durationMs: number
  sizeAvailable: boolean
  transferSize?: number
  encodedBodySize?: number
  decodedBodySize?: number
}
export type PerformanceSummaryData = {
  frameId: string
  frameUrl: string
  navigation: {
    navigationId: string
    startedAt: string
    type?: string
    phases: Record<string, number>
  }
  vitals: {
    thresholdVersion: "web-vitals-2024"
    fcp: PerformanceMetric
    lcp: PerformanceMetric
    cls: PerformanceMetric
    inp: PerformanceMetric
  }
  longTasks: {
    available: boolean
    count: number
    totalDurationMs: number
    maxDurationMs: number
    totalBlockingTimeMs: number
  }
  resources: {
    totalCount: number
    filteredCount: number
    returnedCount: number
    truncated: boolean
    totalDurationMs: number
    transferBytesAvailable: boolean
    totalTransferBytes?: number
    totalDecodedBytes?: number
    byKind: Record<string, { count: number; durationMs: number; transferBytes?: number }>
    slowest: PerformanceResourceSummary[]
  }
  completeness: {
    earlyObserverInstalled: boolean
    supportedEntryTypes: string[]
    caveats: string[]
  }
}

export type NetworkWaitData = {
  event: NetworkEventEntry
  matchedExisting: boolean
  cleared: boolean
}

export type NetworkStatusClassCounts = {
  "1xx": number
  "2xx": number
  "3xx": number
  "4xx": number
  "5xx": number
  other: number
  unknown: number
}

export type NetworkSummaryData = {
  matchingEventCount: number
  eventsSummarized: number
  limit: number
  firstTimestamp?: string
  lastTimestamp?: string
  byType: Record<NetworkEventType, number>
  byMethod: Record<string, number>
  byResourceType: Record<string, number>
  byStatus: Record<string, number>
  byStatusClass: NetworkStatusClassCounts
  failedRequestCount: number
  serviceWorkerResponseCount: number
}

export type WebSocketEventType =
  | "open"
  | "frame_sent"
  | "frame_received"
  | "socket_error"
  | "close"

export type WebSocketFrameDirection = "sent" | "received"

export type WebSocketEventEntry = {
  socketId: string
  type: WebSocketEventType
  timestamp: string
  url: string
  direction?: WebSocketFrameDirection
  payloadBytes?: number
}

export type WebSocketWaitData = {
  event: WebSocketEventEntry
  matchedExisting: boolean
  cleared: boolean
}

export type WebSocketQueryOptions = {
  tabId?: string
  types?: WebSocketEventType[]
  filter?: string
}

export type WebSocketEventsOptions = WebSocketQueryOptions & {
  limit?: number
  clear?: boolean
}

export type WebSocketWaitEventOptions = WebSocketQueryOptions & {
  timeoutMs?: number
  clear?: boolean
}

export type WebSocketSummaryOptions = WebSocketQueryOptions & {
  limit?: number
}

export type WebSocketDirectionCounts = {
  sent: number
  received: number
  unknown: number
}

export type WebSocketSummaryData = {
  matchingEventCount: number
  eventsSummarized: number
  limit: number
  firstTimestamp?: string
  lastTimestamp?: string
  byType: Record<WebSocketEventType, number>
  byDirection: WebSocketDirectionCounts
  socketCount: number
  frameEventCount: number
  totalPayloadBytes: number
  sentPayloadBytes: number
  receivedPayloadBytes: number
  maxPayloadBytes: number
}

export type ElementBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type ScreenshotClip = ElementBounds

export type InspectPointLocatorHint = {
  selector?: string
  role?: string
  name?: string
  testId?: string
  exact?: true
}

export type InspectPointCandidate = {
  depth: number
  tag: string
  role?: string
  name?: string
  text?: string
  testId?: string
  actionable: boolean
  box: ElementBounds
  locator?: InspectPointLocatorHint
  insideFrame?: true
  frameInspectionDeferred?: true
}

export type InspectPointData = {
  point: { x: number; y: number }
  candidates: InspectPointCandidate[]
  mainFrameOnly: true
  scale?: "css"
  path?: string
  sizeBytes?: number
  base64?: string
  imageOmittedReason?: "size_limit"
  inlineImageLimitBytes?: number
}

export type SnapshotElement = {
  ref: string
  tag: string
  role?: string
  name?: string
  text?: string
  placeholder?: string
  value?: string
  valueRedacted?: boolean
  disabled?: boolean
  checked?: boolean
  href?: string
  box: ElementBounds
}

export type PageSummary = {
  frameId?: string
  text: string
  links: Array<{ text: string; href: string }>
  inputs: Array<{ name: string; type: string; placeholder: string }>
  snapshotId?: string
  elements: SnapshotElement[]
}

export type ScreenshotData = {
  scale: "css"
  path: string
  sizeBytes: number
  base64?: string
  fullPage: boolean
  clip?: ScreenshotClip
  imageOmittedReason?: "size_limit"
  inlineImageLimitBytes?: number
}

export type ElementBox = {
  x: number
  y: number
  width: number
  height: number
}

export type ElementBoxData = {
  box: ElementBox
  visible: boolean
  inViewport: boolean
}

export type ElementScreenshotData = ElementBoxData & {
  scale: "css"
  path: string
  sizeBytes: number
  base64?: string
  imageOmittedReason?: "size_limit"
  inlineImageLimitBytes?: number
}

export type DownloadData = {
  suggestedFilename: string
  path: string
  url: string
}

export type UploadFileData = {
  path: string
  name: string
  size: number
}

export type UploadData = {
  files: UploadFileData[]
  count: number
}

export const DEFAULT_COOKIE_MAX_TTL_SECONDS = 7 * 24 * 60 * 60
export const MAX_COOKIE_MAX_TTL_SECONDS = DEFAULT_COOKIE_MAX_TTL_SECONDS

function parseHttpOriginUrl(value: string, message: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(message)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(message)
  }
  return url
}

export function parseCookieAllowedOrigins(value: string | undefined) {
  if (value == null || value.trim() === "") return []

  const entries = value.split(",").map((entry) => entry.trim())
  if (entries.some((entry) => entry === "")) {
    throw new Error(
      "Invalid CHROME_POWER_COOKIE_ALLOWED_ORIGINS: entries must be exact HTTP(S) origins."
    )
  }

  const origins = new Set<string>()
  for (const entry of entries) {
    const url = parseHttpOriginUrl(entry, "Invalid Cookie allowlist origin.")
    if (
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      entry.includes("*")
    ) {
      throw new Error(
        "Invalid CHROME_POWER_COOKIE_ALLOWED_ORIGINS: entries must be exact HTTP(S) origins."
      )
    }
    origins.add(url.origin)
  }
  return [...origins]
}
