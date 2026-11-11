import { randomUUID } from "node:crypto"
import { mkdir, readdir, stat, writeFile } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, resolve } from "node:path"

import {
  chromium,
  type BrowserContext,
  type ConsoleMessage,
  type Dialog,
  type ElementHandle,
  type Locator,
  type Page,
  type Request,
  type Response,
  type WebSocket as PlaywrightWebSocket,
} from "playwright"
import type {
  ArtifactEntry,
  ArtifactsData,
  ArtifactType,
  AssetInventoryData,
  AssetKind,
  AssetObservationState,
  AssetOriginRelationship,
  AssetRecord,
  AssetSortMode,
  BrowserPermissionName,
  BrowserLoadState,
  ConsoleLogEntry,
  ConsoleLogLevel,
  ConsoleLogsOptions,
  ConsoleLogWaitData,
  ConsoleLogWaitOptions,
  ContextEmulationOverrides,
  CookieOperationData,
  CookieOperationInput,
  BrowserDevicePresetData,
  BrowserDevicePresetName,
  CloseData,
  DeviceData,
  DialogInfo,
  DownloadData,
  EmulationData,
  ElementBox,
  ElementBoxData,
  ElementScreenshotData,
  EnvironmentData,
  FrameInfo,
  GeolocationData,
  InspectPointData,
  LocatorAttributeData,
  LocatorCountData,
  LocatorQuery,
  LocatorStateData,
  LocatorTextData,
  LocatorTextKind,
  LocatorWaitState,
  MediaData,
  MediaOverrides,
  NetworkEventEntry,
  NetworkEventsOptions,
  NetworkSummaryData,
  NetworkSummaryOptions,
  NetworkStatusClassCounts,
  NetworkEventType,
  NetworkWaitData,
  NetworkWaitEventOptions,
  PageErrorEntry,
  PageErrorWaitData,
  PageErrorsOptions,
  PageErrorWaitOptions,
  PageSummary,
  PermissionGrantData,
  PerformanceMetric,
  PerformanceResourceSortMode,
  PerformanceResourceSummary,
  PerformanceSummaryData,
  OfflineData,
  PopupData,
  ScreenshotData,
  ScreenshotClip,
  SnapshotElement,
  StatusData,
  StatusDiagnosticCounts,
  TabInfo,
  ToolResult,
  UploadData,
  UploadFileData,
  ViewportData,
  ViewportPresetName,
  ViewportSize,
  WebSocketEventEntry,
  WebSocketEventsOptions,
  WebSocketEventType,
  WebSocketFrameDirection,
  WebSocketSummaryData,
  WebSocketSummaryOptions,
  WebSocketDirectionCounts,
  WebSocketWaitData,
  WebSocketWaitEventOptions,
  BrowserTargetData,
  BrowserTargetOperation,
  BrowserTargetDefinition,
} from "./contracts.js"
import {
  SUPPORTED_ARTIFACT_TYPES,
  SUPPORTED_BROWSER_PERMISSIONS,
  SUPPORTED_EMULATION_FIELDS,
  SUPPORTED_MEDIA_FIELDS,
} from "./contracts.js"
import { BrowserToolError, failResult } from "./errors.js"
import { ensureRuntimeDirs, type RuntimeConfig } from "./config.js"
import {
  AttachedBrowserConnection,
  LaunchBrowserConnection,
  type BrowserConnection,
  type BrowserConnectionMode,
} from "./browser-connection.js"
import {
  TargetEndpointError,
  resolveBrowserTargetEndpoint,
} from "./browser-targets.js"
import { loadRuntimeMetadata } from "./runtime-metadata.js"
import {
  CookieValidationError,
  cookieDomainClearFilters,
  cookieTargetData,
  hasOtherLoopbackPort,
  normalizeCookieOperation,
  resolveCookieTarget,
  validateCookieOperationShape,
} from "./cookie.js"
import {
  locatorCountOp,
  locatorTextOp,
  locatorAttributeOp,
  locatorStateOp,
  locatorWaitOp,
  locatorClickOp,
  locatorDoubleClickOp,
  locatorTypeOp,
  locatorPressOp,
  locatorHoverOp,
  locatorFocusOp,
  locatorScrollOp,
  locatorSetCheckedOp,
  locatorSelectOptionOp,
} from "./locator-operations.js"
import {
  performActionOrCaptureDialog,
  evaluateWithDialogGuard,
  performClick,
  performDoubleClick,
  performHover,
  performPress,
  performTriggerAction,
  pointForTarget,
  type ActionDeps,
} from "./action-execution.js"
import {
  collectPointCandidates,
  resolveElementVisualTarget,
  withElementVisualTargetError,
  elementVisualBox,
  elementScreenshotData,
  type ElementVisualOptions,
  type ResolvedElementVisualTarget,
  type ElementVisualDeps,
} from "./element-visual.js"
import { resolveScreenshotClip, validateViewportPoint, type ScreenshotOptions } from "./screenshot-capture.js"
import { readPageViewport } from "./page-viewport.js"
import { listArtifacts, type ArtifactsOptions } from "./artifact-listing.js"
import {
  VIEWPORT_PRESETS,
  resolveViewportSize,
  resolveDeviceState,
  resolveEmulationOverrides,
  resolveGeolocation,
  resolvePermissions,
  resolvePermissionOrigin,
  recordPermissionGrant,
  resolveMediaOverrides,
  buildViewportData,
  buildEnvironmentData,
  buildDeviceData,
  buildEmulationData,
  buildOfflineData,
  buildMediaData,
  type ViewportOptions,
  type DeviceOptions,
  type MediaOptions,
  type GeolocationOptions,
  type PermissionsOptions,
  type EmulationOptions,
} from "./emulation-state.js"
import {
  DiagnosticBuffers,
  waitForBufferedEntry,
  removeBufferedEntry,
  DEFAULT_CONSOLE_LOG_LIMIT,
  DEFAULT_DIAGNOSTIC_EVENT_LIMIT,
} from "./diagnostic-buffers.js"
import { annotateScreenshot, annotateElementBox } from "./png-annotation.js"
import {
  hasValue,
  isSupportedBrowserPermission,
  sanitizeDownloadFilename,
  uniqueDownloadFilename,
  urlMatcher,
  dialogInfo,
  sleep,
  trimStart,
  truncate,
  boundedDiagnosticUrl,
  resolveScreenshotPath,
  errorMessage,
  isClosedContextError,
  isNotFoundError,
  isDetachedRefError,
} from "./validation-utils.js"
import {
  DEVICE_PRESETS,
  devicePresetList,
  cloneDevicePreset,
  cloneEmulationOverrides,
  clearDeviceEmulationFields,
  viewportSizesEqual,
  emulationOverridesEqual,
  isSupportedDevicePreset,
} from "./device-presets.js"
import { FrameRegistry } from "./frame-registry.js"
import { SnapshotRegistry } from "./snapshot-registry.js"
import {
  queryConsoleLogs,
  waitConsoleLog as waitConsoleLogQuery,
  queryPageErrors,
  waitPageError as waitPageErrorQuery,
  queryNetworkEvents,
  waitNetworkEvent as waitNetworkEventQuery,
  summarizeNetwork,
  queryWebSocketEvents,
  waitWebSocketEvent as waitWebSocketEventQuery,
  summarizeWebSocket,
} from "./diagnostic-queries.js"
import {
  normalizeConsoleLevel,
  filterConsoleLogs,
  findNewestConsoleLog,
  filterPageErrors,
  findNewestPageError,
  validateNetworkStatusRange,
  filterNetworkEvents,
  summarizeNetworkEvents,
  filterWebSocketEvents,
  summarizeWebSocketEvents,
  webSocketPayloadBytes,
} from "./diagnostics-filter.js"
import {
  buildPerformanceSummary,
} from "./performance-summary.js"
import {
  buildAssetInventory,
} from "./asset-inventory.js"
import {
  SENSITIVE_FIELD_HINTS,
  DEFAULT_MAX_ELEMENTS,
  MAX_ELEMENTS,
  MAX_ASSET_DOM_OCCURRENCES,
  MAX_ASSET_BACKGROUND_ELEMENTS,
  evaluateSnapshotSummary,
  evaluateDomAssets,
  evaluatePerformanceSummary,
  installPerformanceObserver,
  type SensitiveFieldHints,
  type SnapshotElementData,
  type PerformancePageProjection,
  type DomAssetProjection,
  type PerformanceAssetProjection,
  type PerformanceObserverProjection,
} from "./page-projections.js"
import {
  resolvePointerTarget,
  resolveDragEndpoint,
  resolveSelectOption,
  resolveElementTarget,
  resolveOptionalElementTarget,
  resolveWaitTarget,
  resolveTriggerAction,
  resolveExpectNavigationAction,
  resolveExpectDownloadAction,
  resolveExpectFileChooserAction,
  resolveDownloadFilename,
  withSelectorError,
  withRefActionError,
  type PointerTarget,
  type ElementTarget,
  type DragOptions,
  type SelectOptionOptions,
  type ExpectNavigationAction,
  type ExpectDownloadAction,
  type ExpectFileChooserAction,
} from "./target-resolution.js"

type RuntimePage = {
  id: string
  page: Page
}

type OpenOptions = {
  url: string
  tabId?: string
  newTab?: boolean
  waitUntil?: BrowserLoadState
  timeoutMs?: number
}

type InspectPointOptions = {
  tabId?: string
  x: number
  y: number
  includeNonActionable?: boolean
  annotatedScreenshot?: boolean
  path?: string
  base64?: boolean
}

type MouseButton = "left" | "right" | "middle"
type HeldInputState = { keys: string[]; buttons: MouseButton[] }

type NavigationOptions = {
  tabId?: string
  waitUntil?: BrowserLoadState
  timeoutMs?: number
}

type ElementTargetOptions = {
  tabId?: string
  frameId?: string
  ref?: string
  selector?: string
  timeoutMs?: number
}

type PointerTargetOptions = {
  tabId?: string
  frameId?: string
  ref?: string
  selector?: string
  x?: number
  y?: number
  timeoutMs?: number
}

type ExpectPopupAction = ExpectNavigationAction

type LocatorOptions = {
  tabId?: string
  frameId?: string
  locator: LocatorQuery
}

type UploadOptions = ElementTargetOptions & {
  paths: string[]
  confirmed?: boolean
}


type AssetsOptions = {
  tabId?: string
  frameId?: string
  kinds?: AssetKind[]
  states?: AssetObservationState[]
  origins?: AssetOriginRelationship[]
  filter?: string
  minTransferBytes?: number
  sortBy?: AssetSortMode
  limit?: number
}

type PerformanceSummaryOptions = {
  tabId?: string
  frameId?: string
  resourceKinds?: AssetKind[]
  minResourceDurationMs?: number
  minTransferBytes?: number
  sortResourcesBy?: PerformanceResourceSortMode
  resourceLimit?: number
}

type WebSocketFrameData = {
  payload: string | Buffer
}

export type BrowserRuntimeOptions = {
  mode?: BrowserConnectionMode
  targetId?: string
  targetDefinition?: BrowserTargetDefinition
  onDisconnected?: () => void
}


const DEFAULT_TIMEOUT_MS = 15_000

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value)
}

function isUnavailableAttachError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|ETIMEDOUT|EACCES|EPERM|ERR_CONNECTION_REFUSED|timed out|timeout/i.test(
    message
  )
}

export class BrowserRuntime {
  readonly sessionId = randomUUID()
  readonly mode: BrowserConnectionMode
  readonly targetId?: string

  private context: BrowserContext | null = null
  private contextCleanupPromise: Promise<void> = Promise.resolve()
  private activeTabId: string | null = null
  private readonly pages = new Map<string, RuntimePage>()
  private readonly dialogs = new Map<string, Dialog>()
  private readonly diagnostics = new DiagnosticBuffers({
    isTabTracked: (tabId) => this.pages.has(tabId),
    frameIdForRequest: (tabId, request) => this.networkRequestFrameId(tabId, request),
  })
  private readonly frameRegistry = new FrameRegistry()
  private readonly snapshotRegistry = new SnapshotRegistry()
  private readonly mediaOverridesByTab = new Map<string, MediaOverrides>()
  private readonly heldInputsByTab = new Map<string, HeldInputState>()
  private geolocationOverride: GeolocationData | undefined
  private permissionGrants: PermissionGrantData[] = []
  private emulationOverrides: ContextEmulationOverrides = {}
  private activeDevicePreset: BrowserDevicePresetName | undefined
  private launchViewportOverride: ViewportSize | undefined
  private offlineOverride = false
  private readonly attachedConnection?: AttachedBrowserConnection
  private readonly launchConnection?: LaunchBrowserConnection
  private readonly connection: BrowserConnection
  private connectionGeneration = 0

  constructor(
    private readonly config: RuntimeConfig,
    options: BrowserRuntimeOptions = {}
  ) {
    this.mode = options.mode ?? "launch"
    this.targetId = options.targetId
    if (this.mode === "attach") {
      if (!options.targetDefinition) {
        throw new Error("Attached browser runtime requires a target definition.")
      }
      this.attachedConnection = new AttachedBrowserConnection({
        resolveEndpoint: () =>
          resolveBrowserTargetEndpoint(options.targetDefinition as BrowserTargetDefinition),
        onDisconnected: () => {
          // A remote browser can disappear without closing Playwright's
          // BrowserContext object first. Invalidate all target-local page,
          // frame, ref, dialog, and diagnostic state before allowing an
          // explicit reconnect, then notify the manager/session router.
          void this.handleAttachedDisconnect()
          options.onDisconnected?.()
        },
      })
      this.connection = this.attachedConnection
    } else {
      this.launchConnection = new LaunchBrowserConnection(() =>
        this.launchContext()
      )
      this.connection = this.launchConnection
    }
  }

  get isAttachMode() {
    return this.mode === "attach"
  }

  get isConnected() {
    return this.connection.isConnected() && this.context != null
  }

  private get actionDeps(): ActionDeps {
    return {
      snapshotRegistry: this.snapshotRegistry,
      dialogs: this.dialogs,
      frameRegistry: this.frameRegistry,
    }
  }

  private get elementVisualDeps(): ElementVisualDeps {
    return {
      snapshotRegistry: this.snapshotRegistry,
      frameRegistry: this.frameRegistry,
    }
  }

  async open(options: OpenOptions): Promise<ToolResult<TabInfo>> {
    return this.wrap(async () => {
      const runtimePage = await this.pageForNavigation(options)
      await runtimePage.page.goto(options.url, {
        waitUntil: options.waitUntil ?? "domcontentloaded",
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(tab.id, tab, tab.url, tab.title)
    }, "navigation_failed")
  }

  async tabs(): Promise<ToolResult<{ tabs: TabInfo[] }>> {
    return this.wrap(async () => {
      await this.ensureContext()
      return this.ok(undefined, { tabs: await this.listTabs() })
    })
  }

  /**
   * Target management is owned by BrowserTargetManager. This method exists on
   * the runtime surface so the canonical registry can remain method-derived;
   * the session router intercepts it when a manager is present.
   */
  async browserTarget(
    _options: BrowserTargetOperation
  ): Promise<ToolResult<BrowserTargetData>> {
    return failResult(
      this.sessionId,
      new BrowserToolError(
        "target_not_found",
        "Browser target management is unavailable for this runtime."
      )
    ) as ToolResult<BrowserTargetData>
  }

  /** Establish an explicitly requested attached connection. */
  async connect(): Promise<ToolResult<{ connected: true }>> {
    if (!this.isAttachMode) {
      return this.wrap(async () => {
        await this.ensureContext()
        return this.ok(undefined, { connected: true })
      })
    }
    try {
      await this.connectAttachedContext()
      return this.ok(undefined, { connected: true })
    } catch (error) {
      if (error instanceof BrowserToolError) {
        return failResult(this.sessionId, error) as ToolResult<{ connected: true }>
      }
      if (error instanceof TargetEndpointError) {
        return failResult(
          this.sessionId,
          new BrowserToolError(
            "target_unavailable",
            "The selected Chrome target is unavailable. Start it with remote debugging enabled, then retry connect."
          )
        ) as ToolResult<{ connected: true }>
      }
      if (isUnavailableAttachError(error)) {
        return failResult(
          this.sessionId,
          new BrowserToolError(
            "target_unavailable",
            "The selected Chrome target is unavailable. Start it with remote debugging enabled, then retry connect."
          )
        ) as ToolResult<{ connected: true }>
      }
      return failResult(
        this.sessionId,
        new BrowserToolError(
          "target_connection_failed",
          "Unable to connect to the selected Chrome target."
        )
      ) as ToolResult<{ connected: true }>
    }
  }

  async selectTab(tabId: string): Promise<ToolResult<TabInfo>> {
    return this.wrap(async () => {
      const page = this.requirePage(tabId)
      this.activeTabId = tabId
      await page.bringToFront()
      const tab = await this.tabInfo(tabId)
      return this.ok(tabId, tab, tab.url, tab.title)
    })
  }

  async current(options: { tabId?: string } = {}): Promise<ToolResult<TabInfo>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, tab, tab.url, tab.title)
    })
  }

  async status(): Promise<ToolResult<StatusData>> {
    return this.wrap(async () => {
      await this.refreshContextHealth()
      const tabs = this.context ? await this.listTabs() : []
      return this.ok(undefined, {
        sessionId: this.sessionId,
        runtime: loadRuntimeMetadata(),
        contextLaunched: this.context != null,
        activeTabId: this.context ? this.activeTabId ?? undefined : undefined,
        tabCount: tabs.length,
        tabs,
        config: {
          headless: this.config.headless,
          slowMoMs: this.config.slowMoMs,
          namespace: {
            mode: this.config.namespaceMode,
            name: this.config.namespace,
          },
          profileDir: this.config.profileDir,
          screenshotDir: this.config.screenshotDir,
          screenshotInlineMaxBytes: this.config.screenshotInlineMaxBytes,
          downloadDir: this.config.downloadDir,
          cookie: {
            allowedOriginCount: this.config.cookieAllowedOrigins.length,
            maxTtlSeconds: this.config.cookieMaxTtlSeconds,
          },
        },
        environment: buildEnvironmentData(this.geolocationOverride, this.permissionGrants),
        diagnostics: {
          tabs: this.context ? this.diagnosticCounts() : [],
        },
      })
    })
  }

  async artifacts(
    options: ArtifactsOptions = {}
  ): Promise<ToolResult<ArtifactsData>> {
    return this.wrap(async () =>
      this.ok(undefined, await listArtifacts(this.config, options))
    )
  }

  async viewport(
    options: ({ action?: "get" | "set" } & ViewportOptions) = {}
  ): Promise<ToolResult<ViewportData>> {
    if (options.action === "set") return this.setViewport(options)
    if (options.width != null || options.height != null || hasValue(options.preset)) {
      return this.invalidRequest("Viewport get does not accept sizing fields.")
    }
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const viewport = await readPageViewport(runtimePage, this.actionDeps)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(
        runtimePage.id,
        buildViewportData(viewport),
        tab.url,
        tab.title
      )
    })
  }

  async setViewport(options: ViewportOptions): Promise<ToolResult<ViewportData>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const size = resolveViewportSize(options)
      this.clearDevicePresetState()
      await runtimePage.page.setViewportSize(size)
      await this.snapshotRegistry.clear(runtimePage.id)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(
        runtimePage.id,
        buildViewportData(await readPageViewport(runtimePage, this.actionDeps)),
        tab.url,
        tab.title
      )
    })
  }

  async devices(): Promise<ToolResult<DeviceData>> {
    return this.wrap(async () => this.ok(undefined, buildDeviceData(this.activeDevicePreset, this.context != null)))
  }

  async device(options: DeviceOptions & {
    action: "get" | "set"
  }): Promise<ToolResult<DeviceData>> {
    if (options.action === "set") return this.setDevice(options)
    if (hasValue(options.preset) || options.clear != null || options.confirmed != null) {
      return this.invalidRequest("Device get does not accept set fields.")
    }
    return this.devices()
  }

  async setDevice(options: DeviceOptions): Promise<ToolResult<DeviceData>> {
    if (this.isAttachMode) {
      return this.unsupportedAttach(
        "Device presets and launch-time emulation are unavailable for an attached Chrome."
      )
    }
    return this.wrap(async () => {
      const nextState = resolveDeviceState(this.emulationOverrides, options)
      const changed =
        this.activeDevicePreset !== nextState.activeDevicePreset ||
        !viewportSizesEqual(
          this.launchViewportOverride,
          nextState.launchViewportOverride
        ) ||
        !emulationOverridesEqual(
          this.emulationOverrides,
          nextState.emulationOverrides
        )

      if (!changed) {
        return this.ok(undefined, buildDeviceData(this.activeDevicePreset, this.context != null, false))
      }

      if (this.context && options.confirmed !== true) {
        throw new BrowserToolError(
          "invalid_request",
          "Changing device preset for a launched browser context requires confirmed: true because existing tabs, frame ids, element refs, dialogs, and diagnostic buffers will be cleared."
        )
      }

      this.activeDevicePreset = nextState.activeDevicePreset
      this.launchViewportOverride = nextState.launchViewportOverride
      this.emulationOverrides = nextState.emulationOverrides

      if (!this.context) {
        return this.ok(undefined, buildDeviceData(this.activeDevicePreset, this.context != null, false))
      }

      await this.relaunchContext()
      return this.ok(undefined, buildDeviceData(this.activeDevicePreset, this.context != null, true))
    })
  }

  async environment(): Promise<ToolResult<EnvironmentData>> {
    return this.wrap(async () => this.ok(undefined, buildEnvironmentData(this.geolocationOverride, this.permissionGrants)))
  }

  async browserContext(options: {
    action: "get" | "geolocation" | "permissions"
    latitude?: number
    longitude?: number
    accuracy?: number
    permissions?: BrowserPermissionName[]
    origin?: string
    clear?: boolean
  }): Promise<ToolResult<EnvironmentData>> {
    const hasGeolocation = options.latitude != null || options.longitude != null || options.accuracy != null
    const hasPermissions = options.permissions != null || hasValue(options.origin)
    if (options.action === "get") {
      if (hasGeolocation || hasPermissions || options.clear != null) {
        return this.invalidRequest("Context get does not accept mutation fields.")
      }
      return this.environment()
    }
    if (options.action === "geolocation") {
      if (hasPermissions) return this.invalidRequest("Context geolocation does not accept permission fields.")
      return this.setGeolocation(options)
    }
    if (hasGeolocation) return this.invalidRequest("Context permissions does not accept geolocation fields.")
    return this.setPermissions(options)
  }

  async emulation(
    options: ({ action?: "get" | "set" } & EmulationOptions) = {}
  ): Promise<ToolResult<EmulationData>> {
    if (options.action === "set") return this.setEmulation(options)
    if (
      hasValue(options.userAgent) || hasValue(options.locale) || hasValue(options.timezoneId) ||
      options.deviceScaleFactor != null || options.hasTouch != null || options.isMobile != null ||
      options.clear != null || options.confirmed != null
    ) {
      return this.invalidRequest("Emulation get does not accept set fields.")
    }
    return this.wrap(async () => this.ok(undefined, buildEmulationData(this.emulationOverrides, this.context != null)))
  }

  async setEmulation(
    options: EmulationOptions
  ): Promise<ToolResult<EmulationData>> {
    if (this.isAttachMode) {
      return this.unsupportedAttach(
        "Context emulation changes are unavailable for an attached Chrome."
      )
    }
    return this.wrap(async () => {
      const nextOverrides = resolveEmulationOverrides(this.emulationOverrides, options)
      const changed = !emulationOverridesEqual(
        this.emulationOverrides,
        nextOverrides
      )

      if (!changed) {
        this.clearDevicePresetState()
        return this.ok(undefined, buildEmulationData(this.emulationOverrides, this.context != null, false))
      }

      if (this.context && options.confirmed !== true) {
        throw new BrowserToolError(
          "invalid_request",
          "Changing context emulation for a launched browser context requires confirmed: true because existing tabs, frame ids, element refs, dialogs, and diagnostic buffers will be cleared."
        )
      }

      this.clearDevicePresetState()
      this.emulationOverrides = nextOverrides
      if (!this.context) {
        return this.ok(undefined, buildEmulationData(this.emulationOverrides, this.context != null, false))
      }

      await this.relaunchContext()
      return this.ok(undefined, buildEmulationData(this.emulationOverrides, this.context != null, true))
    })
  }

  async setGeolocation(
    options: GeolocationOptions
  ): Promise<ToolResult<EnvironmentData>> {
    return this.wrap(async () => {
      const context = await this.ensureContext()
      const geolocation = resolveGeolocation(options)
      await context.setGeolocation(geolocation)
      this.geolocationOverride = geolocation ?? undefined
      return this.ok(undefined, buildEnvironmentData(this.geolocationOverride, this.permissionGrants))
    })
  }

  async setPermissions(
    options: PermissionsOptions
  ): Promise<ToolResult<EnvironmentData>> {
    return this.wrap(async () => {
      const context = await this.ensureContext()
      if (options.clear === true) {
        if (options.permissions != null || hasValue(options.origin)) {
          throw new BrowserToolError(
            "invalid_request",
            "Permission clear mode cannot include permissions or origin."
          )
        }
        await context.clearPermissions()
        this.permissionGrants = []
        return this.ok(undefined, buildEnvironmentData(this.geolocationOverride, this.permissionGrants))
      }

      const permissions = resolvePermissions(options.permissions)
      const origin = resolvePermissionOrigin(options.origin)
      await context.grantPermissions(permissions, origin ? { origin } : {})
      this.permissionGrants = recordPermissionGrant(this.permissionGrants, { permissions, origin })
      return this.ok(undefined, buildEnvironmentData(this.geolocationOverride, this.permissionGrants))
    })
  }

  async offline(options: {
    action?: "get" | "set"
    offline?: boolean
  } = {}): Promise<ToolResult<OfflineData>> {
    if (options.action === "set") {
      if (options.offline == null) {
        return this.invalidRequest("Offline set requires offline.")
      }
      return this.setOffline({ offline: options.offline })
    }
    if (options.offline != null) {
      return this.invalidRequest("Offline get does not accept offline.")
    }
    return this.wrap(async () => {
      await this.refreshContextHealth()
      return this.ok(undefined, buildOfflineData(this.offlineOverride, this.context != null))
    })
  }

  async setOffline(options: {
    offline: boolean
  }): Promise<ToolResult<OfflineData>> {
    return this.wrap(async () => {
      const context = await this.ensureContext()
      if (this.offlineOverride !== options.offline) {
        await context.setOffline(options.offline)
        this.offlineOverride = options.offline
      }
      return this.ok(undefined, buildOfflineData(this.offlineOverride, this.context != null))
    })
  }

  async media(
    options: ({ action?: "get" | "set" } & MediaOptions) = {}
  ): Promise<ToolResult<MediaData>> {
    if (options.action === "set") return this.setMedia(options)
    if (
      options.colorScheme != null || options.reducedMotion != null ||
      options.forcedColors != null || options.clear != null
    ) {
      return this.invalidRequest("Media get does not accept set fields.")
    }
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, buildMediaData(this.mediaOverridesByTab.get(runtimePage.id)), tab.url, tab.title)
    })
  }

  async setMedia(options: MediaOptions): Promise<ToolResult<MediaData>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const overrides = resolveMediaOverrides(this.mediaOverridesByTab.get(runtimePage.id), options)
      await runtimePage.page.emulateMedia({
        colorScheme: overrides.colorScheme ?? null,
        reducedMotion: overrides.reducedMotion ?? null,
        forcedColors: overrides.forcedColors ?? null,
      })
      if (Object.keys(overrides).length === 0) {
        this.mediaOverridesByTab.delete(runtimePage.id)
      } else {
        this.mediaOverridesByTab.set(runtimePage.id, overrides)
      }
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, buildMediaData(this.mediaOverridesByTab.get(runtimePage.id)), tab.url, tab.title)
    })
  }

  async frames(
    options: { tabId?: string } = {}
  ): Promise<ToolResult<{ frames: FrameInfo[] }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frames = await this.frameRegistry.list(runtimePage)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, { frames }, tab.url, tab.title)
    })
  }

  async back(options: NavigationOptions = {}): Promise<ToolResult<TabInfo>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      await this.snapshotRegistry.clear(runtimePage.id)
      await runtimePage.page.goBack({
        waitUntil: options.waitUntil ?? "domcontentloaded",
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, tab, tab.url, tab.title)
    }, "navigation_failed")
  }

  async forward(options: NavigationOptions = {}): Promise<ToolResult<TabInfo>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      await this.snapshotRegistry.clear(runtimePage.id)
      await runtimePage.page.goForward({
        waitUntil: options.waitUntil ?? "domcontentloaded",
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, tab, tab.url, tab.title)
    }, "navigation_failed")
  }

  async reload(options: NavigationOptions = {}): Promise<ToolResult<TabInfo>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      await this.snapshotRegistry.clear(runtimePage.id)
      await runtimePage.page.reload({
        waitUntil: options.waitUntil ?? "domcontentloaded",
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, tab, tab.url, tab.title)
    }, "navigation_failed")
  }

  async cookie(
    options: CookieOperationInput
  ): Promise<ToolResult<CookieOperationData>> {
    try {
      validateCookieOperationShape(options)
      const runtimePage = await this.requireExistingPage(options.tabId)
      const target = resolveCookieTarget(
        runtimePage.page.url(),
        options.url,
        this.config.cookieAllowedOrigins
      )
      const context = this.context
      if (!context) {
        throw new BrowserToolError(
          "tab_not_found",
          "Open the target project page before using browser_cookie."
        )
      }
      const reload = options.reload !== false
      const warnings = hasOtherLoopbackPort(
        [...this.pages.values()].map((entry) => entry.page.url()),
        target
      )

      if (options.action === "clear_target") {
        await this.clearCookieDomains(context, [target.hostname])
        if (reload) await this.reloadCookiePage(runtimePage)
        return this.ok(
          runtimePage.id,
          {
            action: "clear_target",
            target: cookieTargetData(target),
            tabId: runtimePage.id,
            clearedTarget: true,
            persistent: false,
            reloaded: reload,
            ...(warnings ? { warnings: ["localhost_cookie_scope_shared"] } : {}),
          },
          target.origin
        )
      }

      const batch = normalizeCookieOperation(
        options,
        target,
        this.config.cookieMaxTtlSeconds
      )
      const mode = options.mode ?? "merge"
      if (mode === "replace_target") {
        await this.clearCookieDomains(context, batch.clearDomains)
      }
      await context.addCookies(batch.records)
      if (reload) await this.reloadCookiePage(runtimePage)
      return this.ok(
        runtimePage.id,
        {
          action: "inject",
          target: cookieTargetData(target),
          tabId: runtimePage.id,
          inputFormat: batch.inputFormat,
          inputCount: batch.inputCount,
          appliedCount: batch.records.length,
          clearedTarget: mode === "replace_target",
          mode,
          persistent: options.persist === true,
          reloaded: reload,
          ...(warnings ? { warnings: ["localhost_cookie_scope_shared"] } : {}),
        },
        target.origin
      )
    } catch (error) {
      if (error instanceof BrowserToolError) {
        return failResult(this.sessionId, error) as ToolResult<CookieOperationData>
      }
      if (error instanceof CookieValidationError) {
        return failResult(
          this.sessionId,
          new BrowserToolError("invalid_request", error.message)
        ) as ToolResult<CookieOperationData>
      }
      return failResult(
        this.sessionId,
        new BrowserToolError("operation_failed", "Cookie operation failed.")
      ) as ToolResult<CookieOperationData>
    }
  }

  async navigation(options: {
    action: "open" | "back" | "forward" | "reload" | "wait_url"
    url?: string
    tabId?: string
    newTab?: boolean
    waitUntil?: BrowserLoadState
    timeoutMs?: number
  }): Promise<ToolResult> {
    if (options.action === "open") {
      if (!hasValue(options.url)) {
        return this.wrap(async () => { throw new BrowserToolError("invalid_request", "Navigation open requires url.") })
      }
      try {
        new URL(options.url)
      } catch {
        return this.wrap(async () => { throw new BrowserToolError("invalid_request", "Navigation open requires a valid URL.") })
      }
      return this.open({
        url: options.url,
        tabId: options.tabId,
        newTab: options.newTab,
        waitUntil: options.waitUntil,
        timeoutMs: options.timeoutMs,
      })
    }
    if (options.newTab != null) {
      return this.wrap(async () => { throw new BrowserToolError("invalid_request", `Navigation ${options.action} does not accept newTab.`) })
    }
    if (options.action === "back") return this.back(options)
    if (options.action === "forward") return this.forward(options)
    if (options.action === "reload") return this.reload(options)
    if (!hasValue(options.url)) {
      return this.wrap(async () => { throw new BrowserToolError("invalid_request", "Navigation wait_url requires url.") })
    }
    return this.waitUrl({
      tabId: options.tabId,
      url: options.url,
      waitUntil: options.waitUntil,
      timeoutMs: options.timeoutMs,
    })
  }

  async tab(options: {
    action: "list" | "select" | "current" | "close"
    tabId?: string
    all?: boolean
    confirmed?: boolean
  }): Promise<ToolResult> {
    if (options.action === "list") return this.tabs()
    if (options.action === "select") {
      if (!hasValue(options.tabId)) {
        return this.wrap(async () => { throw new BrowserToolError("invalid_request", "Tab select requires tabId.") })
      }
      return this.selectTab(options.tabId)
    }
    if (options.action === "current") return this.current({ tabId: options.tabId })
    return this.close({
      tabId: options.tabId,
      all: options.all,
      confirmed: options.confirmed,
    })
  }

  async snapshot(options: {
    tabId?: string
    frameId?: string
    maxTextLength?: number
    maxElements?: number
  }): Promise<ToolResult<PageSummary>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const frameId = this.frameRegistry.idFor(runtimePage, frame)
      const maxTextLength = options.maxTextLength ?? 20_000
      const maxElements = Math.min(
        Math.max(options.maxElements ?? DEFAULT_MAX_ELEMENTS, 0),
        MAX_ELEMENTS
      )
      const summary = await evaluateWithDialogGuard(
        runtimePage,
        "browser_snapshot",
        () =>
          frame.evaluate(evaluateSnapshotSummary, {
            limit: maxTextLength,
            sensitiveFieldHints: SENSITIVE_FIELD_HINTS,
          }),
        this.actionDeps
      )
      const snapshot = await this.snapshotRegistry.collect(
        runtimePage.id,
        frame,
        frameId,
        maxElements
      )
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(
        runtimePage.id,
        {
          frameId,
          ...summary,
          snapshotId: snapshot.snapshotId,
          elements: snapshot.elements,
        },
        tab.url,
        tab.title
      )
    })
  }

  async screenshot(
    options: ScreenshotOptions = {}
  ): Promise<ToolResult<ScreenshotData>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const fullPage = options.fullPage ?? false
      const clip = resolveScreenshotClip(
        options.clip,
        await readPageViewport(runtimePage, this.actionDeps),
        fullPage
      )
      const path = options.path
        ? resolveScreenshotPath(options.path)
        : resolve(
            this.config.screenshotDir,
            `${Date.now()}-${runtimePage.id}.png`
          )
      await mkdir(dirname(path), { recursive: true })
      const buffer = await runtimePage.page.screenshot({
        fullPage,
        clip,
        path,
        type: "png",
        scale: "css",
      })
      const includeInlineImage =
        options.base64 === true &&
        buffer.byteLength <= this.config.screenshotInlineMaxBytes
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(
        runtimePage.id,
        {
          path,
          sizeBytes: buffer.byteLength,
          scale: "css",
          base64: includeInlineImage ? buffer.toString("base64") : undefined,
          fullPage,
          clip,
          imageOmittedReason:
            options.base64 === true && !includeInlineImage
              ? "size_limit"
              : undefined,
          inlineImageLimitBytes:
            options.base64 === true && !includeInlineImage
              ? this.config.screenshotInlineMaxBytes
              : undefined,
        },
        tab.url,
        tab.title
      )
    })
  }

  async inspectPoint(
    options: InspectPointOptions
  ): Promise<ToolResult<InspectPointData>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const viewport = await readPageViewport(runtimePage, this.actionDeps)
      validateViewportPoint(options.x, options.y, viewport)
      if (!options.annotatedScreenshot && (options.path || options.base64)) {
        throw new BrowserToolError(
          "invalid_request",
          "path and base64 require annotatedScreenshot: true."
        )
      }

      const candidates = await collectPointCandidates(
        runtimePage.page,
        options.x,
        options.y,
        options.includeNonActionable === true
      )
      const data: InspectPointData = {
        point: { x: options.x, y: options.y },
        candidates,
        mainFrameOnly: true,
      }

      if (options.annotatedScreenshot) {
        const path = options.path
          ? resolveScreenshotPath(options.path)
          : resolve(
              this.config.screenshotDir,
              `${Date.now()}-${runtimePage.id}-inspect.png`
            )
        await mkdir(dirname(path), { recursive: true })
        const source = await runtimePage.page.screenshot({ type: "png", scale: "css" })
        const buffer = annotateScreenshot(
          source,
          viewport,
          { x: options.x, y: options.y },
          candidates
        )
        await writeFile(path, buffer)
        const includeInlineImage =
          options.base64 === true &&
          buffer.byteLength <= this.config.screenshotInlineMaxBytes
        Object.assign(data, {
          path,
          sizeBytes: buffer.byteLength,
          scale: "css",
          base64: includeInlineImage ? buffer.toString("base64") : undefined,
          imageOmittedReason:
            options.base64 === true && !includeInlineImage
              ? "size_limit"
              : undefined,
          inlineImageLimitBytes:
            options.base64 === true && !includeInlineImage
              ? this.config.screenshotInlineMaxBytes
              : undefined,
        })
      }

      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async elementBox(
    options: ElementVisualOptions
  ): Promise<ToolResult<ElementBoxData>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const viewport = await readPageViewport(runtimePage, this.actionDeps)
      const target = await resolveElementVisualTarget(runtimePage, options, this.elementVisualDeps)
      const data = await elementVisualBox(target, viewport, options.timeoutMs)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async scrollIntoView(
    options: ElementVisualOptions
  ): Promise<ToolResult<{ scrolled: true; box: ElementBox }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const viewport = await readPageViewport(runtimePage, this.actionDeps)
      const target = await resolveElementVisualTarget(runtimePage, options, this.elementVisualDeps)
      await withElementVisualTargetError(target, () =>
        target.kind === "ref"
          ? target.handle.scrollIntoViewIfNeeded({ timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS })
          : target.locator.scrollIntoViewIfNeeded({ timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS })
      )
      const data = await elementVisualBox(target, viewport, options.timeoutMs)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, { scrolled: true, box: data.box }, tab.url, tab.title)
    })
  }

  async elementScreenshot(
    options: ElementVisualOptions & { path?: string; base64?: boolean }
  ): Promise<ToolResult<ElementScreenshotData>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const viewport = await readPageViewport(runtimePage, this.actionDeps)
      const target = await resolveElementVisualTarget(runtimePage, options, this.elementVisualDeps)
      const path = options.path
        ? resolveScreenshotPath(options.path)
        : resolve(this.config.screenshotDir, `${Date.now()}-${runtimePage.id}-element.png`)
      await mkdir(dirname(path), { recursive: true })
      const buffer = await withElementVisualTargetError(target, () =>
        target.kind === "ref"
          ? target.handle.screenshot({ path, type: "png", scale: "css", timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS })
          : target.locator.screenshot({ path, type: "png", scale: "css", timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS })
      )
      const box = await elementVisualBox(target, viewport, options.timeoutMs)
      const data = elementScreenshotData(buffer, path, box, options.base64, this.config.screenshotInlineMaxBytes)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async elementHighlight(
    options: ElementVisualOptions & { path?: string; base64?: boolean }
  ): Promise<ToolResult<ElementScreenshotData>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const viewport = await readPageViewport(runtimePage, this.actionDeps)
      const target = await resolveElementVisualTarget(runtimePage, options, this.elementVisualDeps)
      await withElementVisualTargetError(target, () =>
        target.kind === "ref"
          ? target.handle.scrollIntoViewIfNeeded({ timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS })
          : target.locator.scrollIntoViewIfNeeded({ timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS })
      )
      const box = await elementVisualBox(target, viewport, options.timeoutMs)
      const source = await runtimePage.page.screenshot({ type: "png", scale: "css" })
      const buffer = annotateElementBox(source, viewport, box.box)
      const path = options.path
        ? resolveScreenshotPath(options.path)
        : resolve(this.config.screenshotDir, `${Date.now()}-${runtimePage.id}-highlight.png`)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, buffer)
      const data = elementScreenshotData(buffer, path, box, options.base64, this.config.screenshotInlineMaxBytes)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async elementVisual(options: ElementVisualOptions & {
    action: "box" | "screenshot" | "scroll_into_view" | "highlight"
    path?: string
    base64?: boolean
  }): Promise<ToolResult> {
    if (options.action === "box") return this.elementBox(options)
    if (options.action === "scroll_into_view") return this.scrollIntoView(options)
    if (options.action === "screenshot") return this.elementScreenshot(options)
    return this.elementHighlight(options)
  }

  async click(options: {
    tabId?: string
    frameId?: string
    ref?: string
    selector?: string
    x?: number
    y?: number
  }): Promise<ToolResult<{ clicked: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const target = resolvePointerTarget(options, "click")
      await performClick(
        runtimePage,
        frame,
        options.frameId,
        target,
        DEFAULT_TIMEOUT_MS,
        false,
        this.actionDeps
      )
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, { clicked: true }, tab.url, tab.title)
    })
  }

  async keyboardType(options: {
    tabId?: string
    text: string
    delayMs?: number
  }): Promise<ToolResult<{ typed: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      await runtimePage.page.keyboard.type(options.text, { delay: options.delayMs })
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, { typed: true }, tab.url, tab.title)
    })
  }

  async keyboard(options: {
    tabId?: string
    action: "type" | "down" | "up"
    text?: string
    key?: string
    delayMs?: number
  }): Promise<ToolResult> {
    return this.wrap<unknown>(async () => {
      if (options.action === "type") {
        if (options.text == null || options.key != null) {
          throw new BrowserToolError("invalid_request", "Keyboard type requires text and does not accept key.")
        }
        return await this.keyboardType({ tabId: options.tabId, text: options.text, delayMs: options.delayMs })
      }
      if (!hasValue(options.key) || options.text != null || options.delayMs != null) {
        throw new BrowserToolError("invalid_request", `Keyboard ${options.action} requires key only.`)
      }
      return options.action === "down"
        ? await this.keyDown({ tabId: options.tabId, key: options.key })
        : await this.keyUp({ tabId: options.tabId, key: options.key })
    })
  }

  async keyDown(options: { tabId?: string; key: string }): Promise<ToolResult<{ keyDown: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const state = this.heldInputState(runtimePage.id)
      if (state.keys.includes(options.key)) {
        throw new BrowserToolError("invalid_request", `Key is already held: ${options.key}`)
      }
      await runtimePage.page.keyboard.down(options.key)
      state.keys.push(options.key)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, { keyDown: true }, tab.url, tab.title)
    })
  }

  async keyUp(options: { tabId?: string; key: string }): Promise<ToolResult<{ keyUp: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const state = this.heldInputState(runtimePage.id)
      const index = state.keys.lastIndexOf(options.key)
      if (index < 0) throw new BrowserToolError("invalid_request", `Key is not held: ${options.key}`)
      await runtimePage.page.keyboard.up(options.key)
      state.keys.splice(index, 1)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, { keyUp: true }, tab.url, tab.title)
    })
  }

  async mouseMove(options: { tabId?: string; x: number; y: number; steps?: number }): Promise<ToolResult<{ moved: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      validateViewportPoint(options.x, options.y, await readPageViewport(runtimePage, this.actionDeps))
      await runtimePage.page.mouse.move(options.x, options.y, { steps: options.steps })
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, { moved: true }, tab.url, tab.title)
    })
  }

  async mouseDown(options: { tabId?: string; button?: MouseButton; clickCount?: number }): Promise<ToolResult<{ mouseDown: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const button = options.button ?? "left"
      const state = this.heldInputState(runtimePage.id)
      if (state.buttons.includes(button)) throw new BrowserToolError("invalid_request", `Mouse button is already held: ${button}`)
      await runtimePage.page.mouse.down({ button, clickCount: options.clickCount })
      state.buttons.push(button)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, { mouseDown: true }, tab.url, tab.title)
    })
  }

  async mouseUp(options: { tabId?: string; button?: MouseButton; clickCount?: number }): Promise<ToolResult<{ mouseUp: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const button = options.button ?? "left"
      const state = this.heldInputState(runtimePage.id)
      const index = state.buttons.lastIndexOf(button)
      if (index < 0) throw new BrowserToolError("invalid_request", `Mouse button is not held: ${button}`)
      await runtimePage.page.mouse.up({ button, clickCount: options.clickCount })
      state.buttons.splice(index, 1)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, { mouseUp: true }, tab.url, tab.title)
    })
  }

  async mouseWheel(options: { tabId?: string; x?: number; y?: number; deltaX?: number; deltaY?: number }): Promise<ToolResult<{ wheeled: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const deltaX = options.deltaX ?? 0
      const deltaY = options.deltaY ?? 700
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || (deltaX === 0 && deltaY === 0)) {
        throw new BrowserToolError("invalid_request", "Mouse wheel requires finite deltas with at least one non-zero value.")
      }
      if (options.x != null || options.y != null) {
        if (options.x == null || options.y == null) {
          throw new BrowserToolError("invalid_request", "Mouse wheel targeting requires both x and y.")
        }
        validateViewportPoint(options.x, options.y, await readPageViewport(runtimePage, this.actionDeps))
        await runtimePage.page.mouse.move(options.x, options.y)
      }
      await runtimePage.page.mouse.wheel(deltaX, deltaY)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, { wheeled: true }, tab.url, tab.title)
    })
  }

  async mouse(options: {
    tabId?: string
    action: "move" | "down" | "up" | "wheel"
    x?: number
    y?: number
    steps?: number
    button?: MouseButton
    clickCount?: number
    deltaX?: number
    deltaY?: number
  }): Promise<ToolResult> {
    return this.wrap<unknown>(async () => {
      if (options.action === "move") {
        if (options.x == null || options.y == null) {
          throw new BrowserToolError("invalid_request", "Mouse move requires x and y.")
        }
        return await this.mouseMove({
          tabId: options.tabId,
          x: options.x,
          y: options.y,
          steps: options.steps,
        })
      }
      if (options.action === "wheel") {
        return await this.mouseWheel({
          tabId: options.tabId,
          x: options.x,
          y: options.y,
          deltaX: options.deltaX,
          deltaY: options.deltaY,
        })
      }
      if (
        options.x != null || options.y != null || options.steps != null ||
        options.deltaX != null || options.deltaY != null
      ) {
        throw new BrowserToolError("invalid_request", `Mouse ${options.action} accepts only button and clickCount.`)
      }
      return options.action === "down"
        ? await this.mouseDown({ tabId: options.tabId, button: options.button, clickCount: options.clickCount })
        : await this.mouseUp({ tabId: options.tabId, button: options.button, clickCount: options.clickCount })
    })
  }

  async inputReset(options: { tabId?: string } = {}): Promise<ToolResult<{ reset: true; releasedKeys: string[]; releasedButtons: MouseButton[] }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const state = this.heldInputState(runtimePage.id)
      const releasedButtons: MouseButton[] = []
      const releasedKeys: string[] = []
      const failures: string[] = []
      for (const button of [...state.buttons].reverse()) {
        try {
          await runtimePage.page.mouse.up({ button })
          state.buttons.splice(state.buttons.lastIndexOf(button), 1)
          releasedButtons.push(button)
        } catch (error) {
          failures.push(`mouse ${button}: ${errorMessage(error)}`)
        }
      }
      for (const key of [...state.keys].reverse()) {
        try {
          await runtimePage.page.keyboard.up(key)
          state.keys.splice(state.keys.lastIndexOf(key), 1)
          releasedKeys.push(key)
        } catch (error) {
          failures.push(`key ${key}: ${errorMessage(error)}`)
        }
      }
      if (failures.length > 0) {
        throw new BrowserToolError(
          "operation_failed",
          `Input reset could not release all held state: ${failures.join("; ")}`
        )
      }
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, { reset: true, releasedKeys, releasedButtons }, tab.url, tab.title)
    })
  }

  async doubleClick(
    options: PointerTargetOptions
  ): Promise<ToolResult<{ doubleClicked: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const target = resolvePointerTarget(options, "double click")
      await performDoubleClick(
        runtimePage,
        frame,
        options.frameId,
        target,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        false,
        this.actionDeps
      )
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(
        runtimePage.id,
        { doubleClicked: true },
        tab.url,
        tab.title
      )
    })
  }

  async hover(options: PointerTargetOptions): Promise<ToolResult<{ hovered: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const target = resolvePointerTarget(options, "hover")
      await performHover(
        runtimePage,
        frame,
        options.frameId,
        target,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        this.actionDeps
      )
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, { hovered: true }, tab.url, tab.title)
    })
  }

  async drag(options: DragOptions): Promise<ToolResult<{ dragged: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const source = resolveDragEndpoint(options, "from")
      const destination = resolveDragEndpoint(options, "to")
      const from = await pointForTarget(
        runtimePage,
        runtimePage.page,
        source,
        timeout,
        this.actionDeps
      )
      const to = await pointForTarget(
        runtimePage,
        runtimePage.page,
        destination,
        timeout,
        this.actionDeps
      )
      const steps = options.steps ?? 10

      await runtimePage.page.mouse.move(from.x, from.y)
      await runtimePage.page.mouse.down()
      await runtimePage.page.mouse.move(to.x, to.y, { steps })
      await runtimePage.page.mouse.up()

      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, { dragged: true }, tab.url, tab.title)
    })
  }

  async type(options: {
    tabId?: string
    frameId?: string
    ref?: string
    selector?: string
    text: string
    clear?: boolean
  }): Promise<ToolResult<{ typed: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const target = resolveElementTarget(options, "type")
      if (options.clear ?? true) {
        if (target.kind === "ref") {
          const handle = await this.snapshotRegistry.resolveRef(
            runtimePage.id,
            target.ref,
            options.frameId
          )
          await withRefActionError(target.ref, () =>
            handle.fill(options.text, { timeout: DEFAULT_TIMEOUT_MS })
          )
        } else {
          await withSelectorError(() =>
            frame
              .locator(target.selector)
              .fill(options.text, { timeout: DEFAULT_TIMEOUT_MS })
          )
        }
      } else {
        if (target.kind === "ref") {
          const handle = await this.snapshotRegistry.resolveRef(
            runtimePage.id,
            target.ref,
            options.frameId
          )
          await withRefActionError(target.ref, () =>
            handle.type(options.text, { timeout: DEFAULT_TIMEOUT_MS })
          )
        } else {
          await withSelectorError(() =>
            frame
              .locator(target.selector)
              .type(options.text, { timeout: DEFAULT_TIMEOUT_MS })
          )
        }
      }
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, { typed: true }, tab.url, tab.title)
    })
  }

  async press(
    options: ElementTargetOptions & { key: string }
  ): Promise<ToolResult<{ pressed: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const target = resolveElementTarget(options, "press")
      await performPress(
        runtimePage,
        frame,
        options.frameId,
        target,
        options.key,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        false,
        this.actionDeps
      )
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, { pressed: true }, tab.url, tab.title)
    })
  }

  async setChecked(
    options: ElementTargetOptions & { checked: boolean }
  ): Promise<ToolResult<{ checked: boolean }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const target = resolveElementTarget(options, "set checked")
      const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      if (target.kind === "ref") {
        const handle = await this.snapshotRegistry.resolveRef(
          runtimePage.id,
          target.ref,
          options.frameId
        )
        await withRefActionError(target.ref, () =>
          handle.setChecked(options.checked, { timeout })
        )
      } else {
        await withSelectorError(() =>
          frame
            .locator(target.selector)
            .setChecked(options.checked, { timeout })
        )
      }
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(
        runtimePage.id,
        { checked: options.checked },
        tab.url,
        tab.title
      )
    })
  }

  async selectOption(
    options: SelectOptionOptions
  ): Promise<ToolResult<{ selected: true; values: string[] }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const target = resolveElementTarget(options, "select option")
      const option = resolveSelectOption(options)
      const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      let values: string[]
      if (target.kind === "ref") {
        const handle = await this.snapshotRegistry.resolveRef(
          runtimePage.id,
          target.ref,
          options.frameId
        )
        values = await withRefActionError(target.ref, () =>
          handle.selectOption(option, { timeout })
        )
      } else {
        values = await withSelectorError(() =>
          frame
            .locator(target.selector)
            .selectOption(option, { timeout })
        )
      }
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(
        runtimePage.id,
        { selected: true, values },
        tab.url,
        tab.title
      )
    })
  }

  async setInputFiles(options: UploadOptions): Promise<ToolResult<UploadData>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const files = await this.resolveUploadFiles(options)
      const target = resolveElementTarget(options, "file upload")

      if (target.kind === "ref") {
        const handle = await this.snapshotRegistry.resolveRef(
          runtimePage.id,
          target.ref,
          options.frameId
        )
        await this.ensureFileInputAllowsFiles(handle, files.length)
        await withRefActionError(target.ref, () =>
          handle.setInputFiles(
            files.map((file) => file.path),
            { timeout }
          )
        )
      } else {
        await withSelectorError(async () => {
          const locator = frame.locator(target.selector)
          const handle = await locator.elementHandle({ timeout })
          if (!handle) {
            throw new BrowserToolError(
              "selector_not_found",
              `Selector not found: ${target.selector}`
            )
          }
          try {
            await this.ensureFileInputAllowsFiles(handle, files.length)
          } finally {
            await handle.dispose().catch(() => undefined)
          }
          await locator.setInputFiles(
            files.map((file) => file.path),
            { timeout }
          )
        })
      }

      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(
        runtimePage.id,
        { files, count: files.length },
        tab.url,
        tab.title
      )
    }, "upload_failed")
  }

  async scroll(options: {
    tabId?: string
    frameId?: string
    ref?: string
    selector?: string
    deltaX?: number
    deltaY?: number
  }): Promise<ToolResult<{ scrolled: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const deltaX = options.deltaX ?? 0
      const deltaY = options.deltaY ?? 700
      const target = resolveOptionalElementTarget(options, "scroll")
      if (target.kind === "ref") {
        const handle = await this.snapshotRegistry.resolveRef(
          runtimePage.id,
          target.ref,
          options.frameId
        )
        await withRefActionError(target.ref, () =>
          handle.evaluate(
            (element, delta) => {
              const scrollable = element as HTMLElement
              scrollable.scrollBy(delta.x, delta.y)
            },
            { x: deltaX, y: deltaY }
          )
        )
      } else if (target.kind === "selector") {
        await withSelectorError(() =>
          frame.locator(target.selector).evaluate(
            (element, delta) => {
              element.scrollBy(delta.x, delta.y)
            },
            { x: deltaX, y: deltaY }
          )
        )
      } else if (options.frameId) {
        await frame.evaluate((delta) => {
          window.scrollBy(delta.x, delta.y)
        }, { x: deltaX, y: deltaY })
      } else {
        await runtimePage.page.mouse.wheel(deltaX, deltaY)
      }
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, { scrolled: true }, tab.url, tab.title)
    })
  }

  async wait(options: {
    tabId?: string
    frameId?: string
    ref?: string
    selector?: string
    loadState?: "load" | "domcontentloaded" | "networkidle"
    timeoutMs?: number
  }): Promise<ToolResult<{ waited: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const target = resolveWaitTarget(options)
      if (target.kind === "ref") {
        const handle = await this.snapshotRegistry.resolveRef(
          runtimePage.id,
          target.ref,
          options.frameId
        )
        await withRefActionError(target.ref, () =>
          handle.waitForElementState("visible", { timeout })
        )
      } else if (target.kind === "selector") {
        await withSelectorError(() =>
          frame.locator(target.selector).waitFor({ timeout })
        )
      } else if (target.kind === "loadState") {
        await frame.waitForLoadState(target.loadState, { timeout })
      } else {
        await runtimePage.page.waitForTimeout(timeout)
      }
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, { waited: true }, tab.url, tab.title)
    })
  }

  async waitUrl(options: {
    tabId?: string
    url: string
    waitUntil?: BrowserLoadState
    timeoutMs?: number
  }): Promise<ToolResult<{ matched: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      await runtimePage.page.waitForURL(urlMatcher(options.url), {
        waitUntil: options.waitUntil ?? "domcontentloaded",
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, { matched: true }, tab.url, tab.title)
    }, "navigation_failed")
  }

  async locatorCount(
    options: LocatorOptions
  ): Promise<ToolResult<LocatorCountData>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const data = await locatorCountOp(frame, { locator: options.locator })
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async locatorText(options: LocatorOptions & {
    all?: boolean
    textKind?: LocatorTextKind
    timeoutMs?: number
  }): Promise<ToolResult<LocatorTextData>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const data = await locatorTextOp(frame, {
        locator: options.locator,
        all: options.all,
        textKind: options.textKind,
        timeoutMs: options.timeoutMs,
      })
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async locatorAttribute(options: LocatorOptions & {
    name: string
    timeoutMs?: number
  }): Promise<ToolResult<LocatorAttributeData>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const data = await locatorAttributeOp(frame, {
        locator: options.locator,
        name: options.name,
        timeoutMs: options.timeoutMs,
      })
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async locatorState(options: LocatorOptions & {
    timeoutMs?: number
  }): Promise<ToolResult<LocatorStateData>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const data = await locatorStateOp(frame, { locator: options.locator })
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async locatorWait(options: LocatorOptions & {
    state?: LocatorWaitState
    timeoutMs?: number
  }): Promise<ToolResult<{ waited: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const data = await locatorWaitOp(frame, {
        locator: options.locator,
        state: options.state,
        timeoutMs: options.timeoutMs,
      })
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async locatorClick(options: LocatorOptions & {
    timeoutMs?: number
  }): Promise<ToolResult<{ clicked: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const data = await locatorClickOp(
        frame,
        { locator: options.locator, timeoutMs: options.timeoutMs },
        (op) => performActionOrCaptureDialog(runtimePage, op, this.actionDeps)
      )
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async locatorDoubleClick(options: LocatorOptions & {
    timeoutMs?: number
  }): Promise<ToolResult<{ doubleClicked: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const data = await locatorDoubleClickOp(
        frame,
        { locator: options.locator, timeoutMs: options.timeoutMs },
        (op) => performActionOrCaptureDialog(runtimePage, op, this.actionDeps)
      )
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async locatorType(options: LocatorOptions & {
    text: string
    clear?: boolean
    timeoutMs?: number
  }): Promise<ToolResult<{ typed: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const data = await locatorTypeOp(frame, {
        locator: options.locator,
        text: options.text,
        clear: options.clear,
        timeoutMs: options.timeoutMs,
      })
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async locatorPress(options: LocatorOptions & {
    key: string
    timeoutMs?: number
  }): Promise<ToolResult<{ pressed: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const data = await locatorPressOp(
        frame,
        { locator: options.locator, key: options.key, timeoutMs: options.timeoutMs },
        (op) => performActionOrCaptureDialog(runtimePage, op, this.actionDeps)
      )
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async locatorHover(options: LocatorOptions & {
    timeoutMs?: number
  }): Promise<ToolResult<{ hovered: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const data = await locatorHoverOp(frame, {
        locator: options.locator,
        timeoutMs: options.timeoutMs,
      })
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async locatorFocus(options: LocatorOptions & {
    timeoutMs?: number
  }): Promise<ToolResult<{ focused: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const data = await locatorFocusOp(frame, {
        locator: options.locator,
        timeoutMs: options.timeoutMs,
      })
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async locatorScroll(options: LocatorOptions & {
    deltaX?: number
    deltaY?: number
    timeoutMs?: number
  }): Promise<ToolResult<{ scrolled: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const data = await locatorScrollOp(frame, {
        locator: options.locator,
        deltaX: options.deltaX,
        deltaY: options.deltaY,
        timeoutMs: options.timeoutMs,
      })
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async locatorSetChecked(options: LocatorOptions & {
    checked: boolean
    timeoutMs?: number
  }): Promise<ToolResult<{ checked: boolean }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const data = await locatorSetCheckedOp(frame, {
        locator: options.locator,
        checked: options.checked,
        timeoutMs: options.timeoutMs,
      })
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async locatorSelectOption(options: LocatorOptions & {
    value?: string
    label?: string
    index?: number
    timeoutMs?: number
  }): Promise<ToolResult<{ selected: true; values: string[] }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const data = await locatorSelectOptionOp(frame, {
        locator: options.locator,
        value: options.value,
        label: options.label,
        index: options.index,
        timeoutMs: options.timeoutMs,
      })
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async elementQuery(options: LocatorOptions & {
    action: "count" | "text" | "attribute" | "state" | "wait"
    all?: boolean
    textKind?: LocatorTextKind
    name?: string
    state?: LocatorWaitState
    timeoutMs?: number
  }): Promise<ToolResult> {
    if (options.action === "count") return this.locatorCount(options)
    if (options.action === "text") return this.locatorText(options)
    if (options.action === "attribute") {
      if (!hasValue(options.name)) {
        return this.wrap(async () => { throw new BrowserToolError("invalid_request", "Element query attribute requires name.") })
      }
      return this.locatorAttribute({ ...options, name: options.name })
    }
    if (options.action === "state") return this.locatorState(options)
    return this.locatorWait(options)
  }

  async elementAction(options: {
    tabId?: string
    frameId?: string
    action: "click" | "double_click" | "hover" | "drag" | "type" | "press" | "focus" | "set_checked" | "select_option" | "scroll" | "wait"
    locator?: LocatorQuery
    ref?: string
    selector?: string
    x?: number
    y?: number
    fromRef?: string
    fromSelector?: string
    fromX?: number
    fromY?: number
    toRef?: string
    toSelector?: string
    toX?: number
    toY?: number
    steps?: number
    text?: string
    clear?: boolean
    key?: string
    checked?: boolean
    value?: string
    label?: string
    index?: number
    deltaX?: number
    deltaY?: number
    loadState?: BrowserLoadState
    timeoutMs?: number
  }): Promise<ToolResult> {
    const hasStandardTarget =
      hasValue(options.ref) || hasValue(options.selector) ||
      options.x != null || options.y != null
    const hasDragTarget =
      hasValue(options.fromRef) || hasValue(options.fromSelector) ||
      options.fromX != null || options.fromY != null ||
      hasValue(options.toRef) || hasValue(options.toSelector) ||
      options.toX != null || options.toY != null
    if (options.locator && (hasStandardTarget || hasDragTarget)) {
      return this.wrap(async () => { throw new BrowserToolError("invalid_request", "Element action locator cannot be combined with ref, selector, coordinates, or drag endpoints.") })
    }
    if (options.action === "drag") {
      if (options.locator || hasStandardTarget) {
        return this.wrap(async () => { throw new BrowserToolError("invalid_request", "Element drag requires from/to endpoints only.") })
      }
      return this.drag(options)
    }
    if (hasDragTarget) {
      return this.wrap(async () => { throw new BrowserToolError("invalid_request", "Drag endpoints are valid only for the drag action.") })
    }
    if (options.locator) {
      const locatorOptions = { ...options, locator: options.locator }
      if (options.action === "click") return this.locatorClick(locatorOptions)
      if (options.action === "double_click") return this.locatorDoubleClick(locatorOptions)
      if (options.action === "hover") return this.locatorHover(locatorOptions)
      if (options.action === "focus") return this.locatorFocus(locatorOptions)
      if (options.action === "scroll") return this.locatorScroll(locatorOptions)
      if (options.action === "wait") return this.locatorWait(locatorOptions)
      if (options.action === "type") {
        if (options.text == null) return this.wrap(async () => { throw new BrowserToolError("invalid_request", "Element type requires text.") })
        return this.locatorType({ ...locatorOptions, text: options.text })
      }
      if (options.action === "press") {
        if (!hasValue(options.key)) return this.wrap(async () => { throw new BrowserToolError("invalid_request", "Element press requires key.") })
        return this.locatorPress({ ...locatorOptions, key: options.key })
      }
      if (options.action === "set_checked") {
        if (options.checked == null) return this.wrap(async () => { throw new BrowserToolError("invalid_request", "Element set_checked requires checked.") })
        return this.locatorSetChecked({ ...locatorOptions, checked: options.checked })
      }
      return this.locatorSelectOption(locatorOptions)
    }
    if (options.action === "click") return this.click(options)
    if (options.action === "double_click") return this.doubleClick(options)
    if (options.action === "hover") return this.hover(options)
    if (options.action === "scroll") return this.scroll(options)
    if (options.action === "wait") return this.wait(options)
    if (options.action === "focus") {
      return this.wrap(async () => { throw new BrowserToolError("invalid_request", "Element focus requires a semantic locator.") })
    }
    if (options.action === "type") {
      if (options.text == null) return this.wrap(async () => { throw new BrowserToolError("invalid_request", "Element type requires text.") })
      return this.type({ ...options, text: options.text })
    }
    if (options.action === "press") {
      if (!hasValue(options.key)) return this.wrap(async () => { throw new BrowserToolError("invalid_request", "Element press requires key.") })
      return this.press({ ...options, key: options.key })
    }
    if (options.action === "set_checked") {
      if (options.checked == null) return this.wrap(async () => { throw new BrowserToolError("invalid_request", "Element set_checked requires checked.") })
      return this.setChecked({ ...options, checked: options.checked })
    }
    return this.selectOption(options)
  }

  async consoleLogs(
    options: ConsoleLogsOptions = {}
  ): Promise<ToolResult<{ logs: ConsoleLogEntry[] }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const { logs, remaining } = queryConsoleLogs(this.diagnostics, runtimePage.id, options)
      if (remaining) this.diagnostics.consoleLogsByTab.set(runtimePage.id, remaining)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, { logs }, tab.url, tab.title)
    })
  }

  async waitConsoleLog(
    options: ConsoleLogWaitOptions = {}
  ): Promise<ToolResult<ConsoleLogWaitData>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const { data, entry } = await waitConsoleLogQuery(this.diagnostics, runtimePage.id, options)
      if (options.clear && entry) {
        removeBufferedEntry(this.diagnostics.consoleLogsByTab, runtimePage.id, entry)
      }
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async pageErrors(
    options: PageErrorsOptions = {}
  ): Promise<ToolResult<{ errors: PageErrorEntry[] }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const { errors, remaining } = queryPageErrors(this.diagnostics, runtimePage.id, options)
      if (remaining) this.diagnostics.pageErrorsByTab.set(runtimePage.id, remaining)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, { errors }, tab.url, tab.title)
    })
  }

  async waitPageError(
    options: PageErrorWaitOptions = {}
  ): Promise<ToolResult<PageErrorWaitData>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const { data, entry } = await waitPageErrorQuery(this.diagnostics, runtimePage.id, options)
      if (options.clear && entry) {
        removeBufferedEntry(this.diagnostics.pageErrorsByTab, runtimePage.id, entry)
      }
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async networkEvents(
    options: NetworkEventsOptions = {}
  ): Promise<ToolResult<{ events: NetworkEventEntry[] }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const { events, remaining } = queryNetworkEvents(this.diagnostics, runtimePage.id, options)
      if (remaining) this.diagnostics.networkEventsByTab.set(runtimePage.id, remaining)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, { events }, tab.url, tab.title)
    })
  }

  async waitNetworkEvent(
    options: NetworkWaitEventOptions = {}
  ): Promise<ToolResult<NetworkWaitData>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const data = await waitNetworkEventQuery(this.diagnostics, runtimePage.id, options)
      if (options.clear) this.diagnostics.removeNetworkEvent(runtimePage.id, data.event)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async networkSummary(
    options: NetworkSummaryOptions = {}
  ): Promise<ToolResult<NetworkSummaryData>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const data = summarizeNetwork(this.diagnostics, runtimePage.id, options)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async assets(
    options: AssetsOptions = {}
  ): Promise<ToolResult<AssetInventoryData>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const frameId = this.frameRegistry.idFor(runtimePage, frame)
      const collected = await evaluateWithDialogGuard(
        runtimePage,
        "browser_assets",
        () => frame.evaluate(evaluateDomAssets, {
          maxOccurrences: MAX_ASSET_DOM_OCCURRENCES,
          maxBackgroundElements: MAX_ASSET_BACKGROUND_ELEMENTS,
        }),
        this.actionDeps
      )
      const networkEvents = (this.diagnostics.networkEventsFor(runtimePage.id))
        .filter((entry) => entry.frameId === frameId)
      const data = buildAssetInventory({
        frameId,
        frameUrl: frame.url(),
        dom: collected.assets,
        performance: collected.performanceEntries,
        network: networkEvents,
        backgroundElementsScanned: collected.backgroundElementsScanned,
        backgroundScanTruncated: collected.backgroundScanTruncated,
        options,
      })
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async performanceSummary(
    options: PerformanceSummaryOptions = {}
  ): Promise<ToolResult<PerformanceSummaryData>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const frame = await this.frameRegistry.resolve(runtimePage, options.frameId)
      const frameId = this.frameRegistry.idFor(runtimePage, frame)
      const projection = await evaluateWithDialogGuard(
        runtimePage,
        "browser_performance_summary",
        () => frame.evaluate(evaluatePerformanceSummary),
        this.actionDeps
      )
      const data = buildPerformanceSummary({
        frameId,
        frameUrl: frame.url(),
        projection,
        options,
      })
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async webSocketEvents(
    options: WebSocketEventsOptions = {}
  ): Promise<ToolResult<{ events: WebSocketEventEntry[] }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const { events, remaining } = queryWebSocketEvents(this.diagnostics, runtimePage.id, options)
      if (remaining) this.diagnostics.webSocketEventsByTab.set(runtimePage.id, remaining)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, { events }, tab.url, tab.title)
    })
  }

  async waitWebSocketEvent(
    options: WebSocketWaitEventOptions = {}
  ): Promise<ToolResult<WebSocketWaitData>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const data = await waitWebSocketEventQuery(this.diagnostics, runtimePage.id, options)
      if (options.clear) this.diagnostics.removeWebSocketEvent(runtimePage.id, data.event)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async webSocketSummary(
    options: WebSocketSummaryOptions = {}
  ): Promise<ToolResult<WebSocketSummaryData>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const data = summarizeWebSocket(this.diagnostics, runtimePage.id, options)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, data, tab.url, tab.title)
    })
  }

  async console(options: ConsoleLogsOptions & {
    action: "list" | "wait"
    timeoutMs?: number
  }): Promise<ToolResult> {
    return options.action === "list"
      ? this.consoleLogs(options)
      : this.waitConsoleLog(options)
  }

  async pageError(options: PageErrorsOptions & {
    action: "list" | "wait"
    timeoutMs?: number
  }): Promise<ToolResult> {
    return options.action === "list"
      ? this.pageErrors(options)
      : this.waitPageError(options)
  }

  async network(options: NetworkEventsOptions & {
    action: "list" | "wait" | "summary"
    timeoutMs?: number
  }): Promise<ToolResult> {
    if (options.action === "list") return this.networkEvents(options)
    if (options.action === "wait") return this.waitNetworkEvent(options)
    return this.networkSummary(options)
  }

  async webSocket(options: WebSocketEventsOptions & {
    action: "list" | "wait" | "summary"
    timeoutMs?: number
  }): Promise<ToolResult> {
    if (options.action === "list") return this.webSocketEvents(options)
    if (options.action === "wait") return this.waitWebSocketEvent(options)
    return this.webSocketSummary(options)
  }

  async expectNavigation(options: {
    tabId?: string
    action: ExpectNavigationAction
    waitUntil?: BrowserLoadState
    timeoutMs?: number
  }): Promise<ToolResult<TabInfo>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const action = resolveExpectNavigationAction(options.action)
      const navigationPromise = runtimePage.page.waitForNavigation({
        waitUntil: options.waitUntil ?? "domcontentloaded",
        timeout,
      })
      navigationPromise.catch(() => undefined)
      await Promise.all([
        navigationPromise,
        performTriggerAction(runtimePage, action, timeout, "navigation", this.actionDeps),
      ])
      await this.snapshotRegistry.clear(runtimePage.id)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, tab, tab.url, tab.title)
    }, "navigation_failed")
  }

  async expectPopup(options: {
    tabId?: string
    action: ExpectPopupAction
    waitUntil?: BrowserLoadState
    timeoutMs?: number
  }): Promise<ToolResult<PopupData>> {
    return this.wrap(async () => {
      const opener = await this.requireActivePage(options.tabId)
      const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const action = resolveTriggerAction(options.action, "popup")
      const popupPromise = opener.page.waitForEvent("popup", { timeout })

      try {
        await performTriggerAction(opener, action, timeout, "popup", this.actionDeps)
        const popup = await popupPromise
        const runtimePopup = this.trackPage(popup, opener.page.context())
        if (!runtimePopup) {
          throw new BrowserToolError(
            "target_unavailable",
            "The attached Chrome target disconnected before the popup could be registered."
          )
        }
        this.activeTabId = runtimePopup.id
        await popup.waitForLoadState(options.waitUntil ?? "domcontentloaded", {
          timeout,
        })
        const tab = await this.tabInfo(runtimePopup.id)
        return this.ok(
          runtimePopup.id,
          { ...tab, openerTabId: opener.id },
          tab.url,
          tab.title
        )
      } catch (error) {
        popupPromise.catch(() => undefined)
        throw error
      }
    }, "popup_failed")
  }

  async expectDownload(options: {
    tabId?: string
    action: ExpectDownloadAction
    filename?: string
    timeoutMs?: number
  }): Promise<ToolResult<DownloadData>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const action = resolveExpectDownloadAction(options.action)
      const downloadPromise = runtimePage.page.waitForEvent("download", {
        timeout,
      })

      try {
        await performTriggerAction(runtimePage, action, timeout, "download", this.actionDeps)
        const download = await downloadPromise
        const suggestedFilename = download.suggestedFilename()
        const savedFilename = uniqueDownloadFilename(
          resolveDownloadFilename(
            options.filename,
            suggestedFilename || "download"
          )
        )
        const path = resolve(this.config.downloadDir, savedFilename)
        await mkdir(this.config.downloadDir, { recursive: true })
        await download.saveAs(path)

        const failure = await download.failure()
        if (failure) {
          throw new BrowserToolError("download_failed", failure)
        }

        const tab = await this.tabInfo(runtimePage.id)
        return this.ok(
          runtimePage.id,
          {
            suggestedFilename,
            path,
            url: download.url(),
          },
          tab.url,
          tab.title
        )
      } catch (error) {
        downloadPromise.catch(() => undefined)
        throw error
      }
    }, "download_failed")
  }

  async expectFileChooser(options: {
    tabId?: string
    action: ExpectFileChooserAction
    paths: string[]
    confirmed?: boolean
    timeoutMs?: number
  }): Promise<ToolResult<UploadData>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const action = resolveExpectFileChooserAction(options.action)
      const files = await this.resolveUploadFiles(options)
      const fileChooserPromise = runtimePage.page.waitForEvent("filechooser", {
        timeout,
      })

      try {
        await performTriggerAction(runtimePage, action, timeout, "upload", this.actionDeps)
        const fileChooser = await fileChooserPromise
        if (files.length > 1 && !fileChooser.isMultiple()) {
          throw new BrowserToolError(
            "invalid_request",
            "File chooser does not accept multiple files."
          )
        }
        await fileChooser.setFiles(files.map((file) => file.path))
        const tab = await this.tabInfo(runtimePage.id)
        return this.ok(
          runtimePage.id,
          { files, count: files.length },
          tab.url,
          tab.title
        )
      } catch (error) {
        fileChooserPromise.catch(() => undefined)
        throw error
      }
    }, "upload_failed")
  }

  async expect(options: {
    event: "navigation" | "popup" | "download" | "file_chooser"
    tabId?: string
    trigger: ExpectNavigationAction
    waitUntil?: BrowserLoadState
    filename?: string
    paths?: string[]
    confirmed?: boolean
    timeoutMs?: number
  }): Promise<ToolResult> {
    if (options.event === "navigation") {
      return this.expectNavigation({
        tabId: options.tabId,
        action: options.trigger,
        waitUntil: options.waitUntil,
        timeoutMs: options.timeoutMs,
      })
    }
    if (options.event === "popup") {
      return this.expectPopup({
        tabId: options.tabId,
        action: options.trigger,
        waitUntil: options.waitUntil,
        timeoutMs: options.timeoutMs,
      })
    }
    if (options.event === "download") {
      return this.expectDownload({
        tabId: options.tabId,
        action: options.trigger,
        filename: options.filename,
        timeoutMs: options.timeoutMs,
      })
    }
    if (!options.paths) {
      return this.wrap(async () => { throw new BrowserToolError("invalid_request", "Expected file chooser requires paths.") })
    }
    return this.expectFileChooser({
      tabId: options.tabId,
      action: options.trigger,
      paths: options.paths,
      confirmed: options.confirmed,
      timeoutMs: options.timeoutMs,
    })
  }

  async expectPage(options: {
    event: "navigation" | "popup"
    tabId?: string
    trigger: ExpectNavigationAction
    waitUntil?: BrowserLoadState
    timeoutMs?: number
  }): Promise<ToolResult> {
    return this.expect(options)
  }

  async expectFile(options: {
    event: "download" | "file_chooser"
    tabId?: string
    trigger: ExpectNavigationAction
    filename?: string
    paths?: string[]
    confirmed?: boolean
    timeoutMs?: number
  }): Promise<ToolResult> {
    return this.expect(options)
  }

  async dialog(options: {
    action?: "get" | "handle"
    tabId?: string
    accept?: boolean
    promptText?: string
  } = {}): Promise<ToolResult> {
    if (options.action === "handle") {
      if (options.accept == null) {
        return this.invalidRequest("Dialog handle requires accept.")
      }
      return this.handleDialog({
        tabId: options.tabId,
        accept: options.accept,
        promptText: options.promptText,
      })
    }
    if (options.accept != null || options.promptText != null) {
      return this.invalidRequest("Dialog get does not accept handle fields.")
    }
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const dialog = this.dialogs.get(runtimePage.id)
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(
        runtimePage.id,
        { dialog: dialog ? dialogInfo(dialog) : undefined },
        tab.url,
        tab.title
      )
    })
  }

  async handleDialog(options: {
    tabId?: string
    accept: boolean
    promptText?: string
  }): Promise<ToolResult<{ handled: true }>> {
    return this.wrap(async () => {
      const runtimePage = await this.requireActivePage(options.tabId)
      const dialog = this.dialogs.get(runtimePage.id)
      if (!dialog) {
        throw new BrowserToolError(
          "dialog_not_found",
          "No active JavaScript dialog is available for this tab."
        )
      }
      this.dialogs.delete(runtimePage.id)
      if (options.accept) {
        await dialog.accept(options.promptText)
      } else {
        await dialog.dismiss()
      }
      const tab = await this.tabInfo(runtimePage.id)
      return this.ok(runtimePage.id, { handled: true }, tab.url, tab.title)
    })
  }

  async close(options: {
    tabId?: string
    all?: boolean
    confirmed?: boolean
  } = {}): Promise<ToolResult<CloseData>> {
    if (options.all === true && this.isAttachMode && options.confirmed !== true) {
      return this.invalidRequest(
        "Closing all tabs in an attached Chrome requires confirmed: true."
      )
    }
    return this.wrap(async () => {
      const closed: string[] = []
      if (options.all) {
        for (const runtimePage of [...this.pages.values()]) {
          await this.snapshotRegistry.clear(runtimePage.id)
          this.dialogs.delete(runtimePage.id)
          this.diagnostics.clearTab(runtimePage.id)
          this.frameRegistry.clearTab(runtimePage.id)
          this.mediaOverridesByTab.delete(runtimePage.id)
          this.heldInputsByTab.delete(runtimePage.id)
          await runtimePage.page.close().catch(() => undefined)
          this.pages.delete(runtimePage.id)
          closed.push(runtimePage.id)
        }
        if (this.isAttachMode) {
          // Closing all attached tabs must not close the remote context or
          // terminate the user's Chrome process.
          this.activeTabId = null
        } else {
          this.context = null
          await this.connection.dispose()
          await this.queueContextStateCleanup()
          this.resetEnvironmentOverrides()
          this.resetEmulationOverrides()
          this.resetDeviceState()
          this.resetTestingControls()
        }
        return this.ok(undefined, { closed })
      }

      if (options.tabId == null) {
        throw new BrowserToolError("invalid_request", "tabId is required.")
      }
      const page = this.requirePage(options.tabId)
      await this.snapshotRegistry.clear(options.tabId)
      this.dialogs.delete(options.tabId)
      this.diagnostics.clearTab(options.tabId)
      this.frameRegistry.clearTab(options.tabId)
      this.mediaOverridesByTab.delete(options.tabId)
      this.heldInputsByTab.delete(options.tabId)
      await page.close()
      this.pages.delete(options.tabId)
      closed.push(options.tabId)
      if (this.activeTabId === options.tabId) this.activeTabId = null
      return this.ok(undefined, { closed })
    })
  }

  async dispose() {
    if (this.isAttachMode) {
      this.context = null
      this.invalidateLocalContextState()
      await this.attachedConnection?.dispose()
      await this.queueContextStateCleanup()
      this.resetEnvironmentOverrides()
      this.resetEmulationOverrides()
      this.resetDeviceState()
      this.resetTestingControls()
      this.activeTabId = null
      return
    }
    this.context = null
    this.invalidateLocalContextState()
    await this.connection.dispose()
    await this.queueContextStateCleanup()
    this.resetEnvironmentOverrides()
    this.resetEmulationOverrides()
    this.resetDeviceState()
    this.resetTestingControls()
    this.activeTabId = null
  }


  private async resolveUploadFiles(options: {
    paths?: string[]
    confirmed?: boolean
  }): Promise<UploadFileData[]> {
    if (options.confirmed !== true) {
      throw new BrowserToolError(
        "invalid_request",
        "File upload requires confirmed: true after user approval."
      )
    }

    if (!options.paths || options.paths.length === 0) {
      throw new BrowserToolError(
        "invalid_request",
        "Provide at least one absolute file path to upload."
      )
    }

    const files: UploadFileData[] = []
    for (const path of options.paths) {
      if (!isAbsolute(path)) {
        throw new BrowserToolError(
          "invalid_request",
          `Upload path must be absolute: ${path}`
        )
      }

      let fileStat
      try {
        fileStat = await stat(path)
      } catch (error) {
        if (isNotFoundError(error)) {
          throw new BrowserToolError("file_not_found", `File not found: ${path}`)
        }
        throw new BrowserToolError("upload_failed", errorMessage(error))
      }

      if (!fileStat.isFile()) {
        throw new BrowserToolError(
          "invalid_request",
          `Upload path must be a regular file: ${path}`
        )
      }

      files.push({
        path,
        name: basename(path),
        size: fileStat.size,
      })
    }

    return files
  }

  private async ensureFileInputAllowsFiles(
    handle: ElementHandle<Element>,
    fileCount: number
  ) {
    const inputInfo = await handle
      .evaluate((element) => {
        if (!(element instanceof HTMLInputElement)) {
          return { isFileInput: false, multiple: false }
        }
        return {
          isFileInput: element.type.toLowerCase() === "file",
          multiple: element.multiple,
        }
      })
      .catch((error) => {
        throw new BrowserToolError("upload_failed", errorMessage(error))
      })

    if (!inputInfo.isFileInput) {
      throw new BrowserToolError(
        "invalid_request",
        "File upload target must be an input[type=file]."
      )
    }

    if (fileCount > 1 && !inputInfo.multiple) {
      throw new BrowserToolError(
        "invalid_request",
        "File input does not accept multiple files."
      )
    }
  }


  private diagnosticCounts(): StatusDiagnosticCounts[] {
    return [...this.pages.keys()].map((tabId) => ({
      tabId,
      consoleLogCount: this.diagnostics.consoleLogsFor(tabId).length,
      pageErrorCount: this.diagnostics.pageErrorsFor(tabId).length,
      networkEventCount: this.diagnostics.networkEventsFor(tabId).length,
      webSocketEventCount: this.diagnostics.webSocketEventsFor(tabId).length,
      dialogOpen: this.dialogs.has(tabId),
      snapshotRefCount: this.snapshotRegistry.refCount(tabId),
    }))
  }

  // Kept as narrow diagnostic test hooks for the production-path integration
  // fixture. They are intentionally no-ops for untracked tabs, matching the
  // event listeners' post-close containment behavior.
  get pageErrorsByTab() {
    return this.diagnostics.pageErrorsByTab
  }

  get networkEventsByTab() {
    return this.diagnostics.networkEventsByTab
  }

  appendPageError(tabId: string, entry: unknown) {
    if (!isRecordValue(entry) || typeof entry.message !== "string") return
    this.diagnostics.appendPageError(tabId, {
      message: entry.message,
      timestamp:
        typeof entry.timestamp === "string"
          ? entry.timestamp
          : new Date().toISOString(),
      ...(typeof entry.name === "string" ? { name: entry.name } : {}),
      ...(typeof entry.stack === "string" ? { stack: entry.stack } : {}),
    })
  }

  appendNetworkEvent(tabId: string, entry: unknown) {
    if (!isRecordValue(entry) || typeof entry.type !== "string") return
    this.diagnostics.appendNetworkEvent(tabId, entry as NetworkEventEntry)
  }

  private resetEnvironmentOverrides() {
    this.geolocationOverride = undefined
    this.permissionGrants = []
  }

  private resetEmulationOverrides() {
    this.emulationOverrides = {}
  }

  private resetDeviceState() {
    this.activeDevicePreset = undefined
    this.launchViewportOverride = undefined
  }

  private clearDevicePresetState() {
    this.activeDevicePreset = undefined
    this.launchViewportOverride = undefined
  }


  private heldInputState(tabId: string): HeldInputState {
    let state = this.heldInputsByTab.get(tabId)
    if (!state) {
      state = { keys: [], buttons: [] }
      this.heldInputsByTab.set(tabId, state)
    }
    return state
  }


  private resetTestingControls() {
    this.offlineOverride = false
    this.mediaOverridesByTab.clear()
    this.heldInputsByTab.clear()
  }


  private networkRequestFrameId(tabId: string, request: Request) {
    const runtimePage = this.pages.get(tabId)
    if (!runtimePage) return undefined
    try {
      return this.frameRegistry.idFor(runtimePage, request.frame())
    } catch {
      return undefined
    }
  }

  private async closeContextAndClearRuntimeState() {
    this.context = null
    this.invalidateLocalContextState()
    await this.connection.dispose()
    await this.queueContextStateCleanup()
  }

  private queueContextStateCleanup() {
    this.contextCleanupPromise = this.contextCleanupPromise
      .catch(() => undefined)
      .then(async () => {
        await this.snapshotRegistry.clearAll()
        this.pages.clear()
        this.dialogs.clear()
        this.diagnostics.clearAll()
        this.frameRegistry.clearAll()
        this.mediaOverridesByTab.clear()
        this.heldInputsByTab.clear()
        this.activeTabId = null
      })
    return this.contextCleanupPromise
  }

  private invalidateContext(context: BrowserContext) {
    if (this.context !== context) return this.contextCleanupPromise
    this.context = null
    this.invalidateLocalContextState()
    return this.queueContextStateCleanup()
  }

  /**
   * Invalidate browser-owned maps synchronously before asynchronous handle
   * disposal. This makes the diagnostic `isTabTracked` guard and page event
   * listeners reject stale events immediately after a disconnect.
   */
  private invalidateLocalContextState() {
    void this.snapshotRegistry.clearAll()
    this.pages.clear()
    this.dialogs.clear()
    this.diagnostics.clearAll()
    this.frameRegistry.clearAll()
    this.mediaOverridesByTab.clear()
    this.heldInputsByTab.clear()
    this.activeTabId = null
  }

  private handleAttachedDisconnect() {
    const context = this.context
    return context
      ? this.invalidateContext(context)
      : this.queueContextStateCleanup()
  }

  private async refreshContextHealth() {
    if (this.isAttachMode) {
      if (!this.attachedConnection?.isConnected()) {
        if (this.context) await this.invalidateContext(this.context)
        else await this.contextCleanupPromise
      }
      return
    }
    const context = this.context
    if (!context) {
      await this.contextCleanupPromise
      return
    }
    const browser = context.browser()
    if (!browser || !browser.isConnected()) {
      await this.invalidateContext(context)
    }
  }

  private async relaunchContext() {
    const geolocation = this.geolocationOverride
      ? { ...this.geolocationOverride }
      : undefined
    const permissionGrants = this.permissionGrants.map((grant) => ({
      permissions: [...grant.permissions],
      origin: grant.origin,
    }))

    await this.closeContextAndClearRuntimeState()
    const context = await this.ensureContext()

    if (geolocation) {
      await context.setGeolocation(geolocation)
    }
    for (const grant of permissionGrants) {
      await context.grantPermissions(
        grant.permissions,
        grant.origin ? { origin: grant.origin } : {}
      )
    }
  }

  private async ensureContext() {
    await this.contextCleanupPromise
    await this.refreshContextHealth()
    if (this.context) return this.context
    if (this.isAttachMode) {
      throw new BrowserToolError(
        "target_unavailable",
        "The selected Chrome target is not connected. Use browser_target connect with confirmed: true."
      )
    }
    return this.connection.ensureContext()
  }

  private async launchContext() {
    await ensureRuntimeDirs(this.config)
    const context = await chromium.launchPersistentContext(
      this.config.profileDir,
      {
        channel: "chromium",
        headless: this.config.headless,
        slowMo: this.config.slowMoMs,
        viewport: this.launchViewportOverride
          ? { ...this.launchViewportOverride }
          : this.config.headless ||
              this.emulationOverrides.deviceScaleFactor != null ||
              this.emulationOverrides.isMobile === true
            ? { ...VIEWPORT_PRESETS.desktop }
            : null,
        acceptDownloads: true,
        ...this.emulationOverrides,
      }
    )
    await context.addInitScript(installPerformanceObserver)

    context.on("close", () => {
      void this.invalidateContext(context)
    })
    this.context = context

    if (this.geolocationOverride) {
      await context.setGeolocation({ ...this.geolocationOverride })
    }
    await context.setOffline(this.offlineOverride)
    for (const grant of this.permissionGrants) {
      await context.grantPermissions(
        [...grant.permissions],
        grant.origin ? { origin: grant.origin } : {}
      )
    }

    context.on("page", (page) => {
      if (this.context !== context) return
      this.trackPage(page, context)
    })

    // Register the listener before enumerating pages so a tab opened during
    // initial setup cannot fall through the attach window. `trackPage` is
    // idempotent and deduplicates pages observed by both paths.
    for (const page of context.pages()) {
      this.trackPage(page, context)
    }

    return context
  }

  private async connectAttachedContext() {
    if (!this.isAttachMode || !this.attachedConnection) {
      throw new BrowserToolError(
        "target_connection_failed",
        "This runtime is not an attach target."
      )
    }
    await this.contextCleanupPromise
    if (this.context && this.attachedConnection.isConnected()) {
      return this.context
    }
    const context = await this.attachedConnection.ensureContext()
    if (!this.attachedConnection.isConnected()) {
      await this.attachedConnection.dispose()
      throw new BrowserToolError(
        "target_unavailable",
        "The selected Chrome target disconnected before attachment completed. Retry connect explicitly."
      )
    }
    // Multiple callers can await the same attached connection promise. The
    // first caller installs the runtime generation; later callers must reuse
    // it instead of incrementing the generation or re-registering listeners.
    if (this.context === context) return context
    this.connectionGeneration += 1
    this.context = context
    context.on("page", (page) => {
      if (this.context !== context || !this.attachedConnection?.isConnected()) {
        return
      }
      this.trackPage(page, context)
    })
    context.on("close", () => {
      void this.invalidateContext(context)
    })
    // Install the page listener before enumerating existing pages. A popup or
    // tab created during setup is then observed by either path without a race.
    for (const page of context.pages()) this.trackPage(page, context)
    return context
  }

  private async pageForNavigation(options: OpenOptions): Promise<RuntimePage> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const context = await this.ensureContext()
      try {
        if (
          options.newTab === true ||
          (!this.isAttachMode && this.pages.size === 0)
        ) {
          const runtimePage = this.trackPage(await context.newPage(), context)
          if (!runtimePage) {
            throw new BrowserToolError(
              "target_unavailable",
              "The browser target disconnected before the new tab could be registered."
            )
          }
          this.activeTabId = runtimePage.id
          return runtimePage
        }
        if (options.tabId) {
          this.requirePage(options.tabId)
          this.activeTabId = options.tabId
          return this.pages.get(options.tabId) as RuntimePage
        }
        return await this.requireActivePage()
      } catch (error) {
        if (attempt !== 0 || !isClosedContextError(error)) throw error
        await this.invalidateContext(context)
      }
    }
    throw new Error("Browser context recovery exhausted.")
  }

  private trackPage(
    page: Page,
    expectedContext: BrowserContext = page.context()
  ): RuntimePage | undefined {
    // Page events from an invalidated context must never repopulate maps
    // while cleanup or an explicit reconnect is in flight.
    if (this.context !== expectedContext) return undefined
    const existing = [...this.pages.values()].find((entry) => entry.page === page)
    if (existing) return existing

    const prefix = this.isAttachMode
      ? `${this.targetId ?? "target"}_g${this.connectionGeneration}_`
      : ""
    const id = `${prefix}tab_${this.pages.size + 1}_${randomUUID().slice(0, 8)}`
    const runtimePage = { id, page }
    this.pages.set(id, runtimePage)
    this.activeTabId ??= id
    page.on("framenavigated", (frame) => {
      if (this.context !== expectedContext || this.pages.get(id)?.page !== page) {
        return
      }
      if (frame === page.mainFrame()) {
        void this.snapshotRegistry.clear(id)
        this.heldInputsByTab.delete(id)
      }
    })
    page.on("dialog", (dialog) => {
      if (this.context !== expectedContext || this.pages.get(id)?.page !== page) {
        return
      }
      this.dialogs.set(id, dialog)
    })
    this.diagnostics.attach(page, id)
    page.on("close", () => {
      if (this.context !== expectedContext || this.pages.get(id)?.page !== page) {
        return
      }
      void this.snapshotRegistry.clear(id)
      this.dialogs.delete(id)
      this.diagnostics.clearTab(id)
      this.frameRegistry.clearTab(id)
      this.mediaOverridesByTab.delete(id)
      this.heldInputsByTab.delete(id)
      this.pages.delete(id)
      if (this.activeTabId === id) {
        this.activeTabId = null
      }
    })
    return runtimePage
  }

  private requirePage(tabId: string) {
    const runtimePage = this.pages.get(tabId)
    if (!runtimePage) {
      throw new BrowserToolError("tab_not_found", `Unknown tabId: ${tabId}`)
    }
    return runtimePage.page
  }

  private async requireActivePage(tabId?: string) {
    await this.ensureContext()
    const resolvedTabId = tabId ?? this.activeTabId
    if (!resolvedTabId) {
      throw new BrowserToolError("tab_not_found", "No active tab is available.")
    }
    const runtimePage = this.pages.get(resolvedTabId)
    if (!runtimePage) {
      throw new BrowserToolError("tab_not_found", `Unknown tabId: ${resolvedTabId}`)
    }
    return runtimePage
  }

  private async requireExistingPage(tabId?: string) {
    await this.refreshContextHealth()
    if (!this.context) {
      throw new BrowserToolError(
        "tab_not_found",
        "Open the target project page before using browser_cookie."
      )
    }
    const resolvedTabId = tabId ?? this.activeTabId
    if (!resolvedTabId) {
      throw new BrowserToolError(
        "tab_not_found",
        "Open the target project page before using browser_cookie."
      )
    }
    const runtimePage = this.pages.get(resolvedTabId)
    if (!runtimePage || runtimePage.page.isClosed()) {
      throw new BrowserToolError(
        "tab_not_found",
        "The target project tab is no longer available."
      )
    }
    return runtimePage
  }

  private async clearCookieDomains(
    context: BrowserContext,
    domains: readonly string[]
  ) {
    for (const domain of cookieDomainClearFilters(domains)) {
      await context.clearCookies({ domain })
    }
  }

  private async reloadCookiePage(runtimePage: RuntimePage) {
    await this.snapshotRegistry.clear(runtimePage.id)
    await runtimePage.page.reload({
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT_MS,
    })
  }

  private async listTabs(): Promise<TabInfo[]> {
    return Promise.all([...this.pages.keys()].map((id) => this.tabInfo(id)))
  }

  private async tabInfo(tabId: string): Promise<TabInfo> {
    const page = this.requirePage(tabId)
    return {
      id: tabId,
      active: tabId === this.activeTabId,
      url: page.url(),
      title: await page.title().catch(() => basename(page.url()) || ""),
    }
  }

  private ok<TData>(
    tabId: string | undefined,
    data: TData,
    url?: string,
    title?: string
  ): ToolResult<TData> {
    return {
      ok: true,
      sessionId: this.sessionId,
      targetId: this.targetId,
      tabId,
      url,
      title,
      data: data as ToolResult<TData>["data"],
    }
  }

  private async wrap<TData>(
    operation: () => Promise<ToolResult<TData>>,
    fallbackCode: Parameters<typeof failResult>[2] = "operation_failed"
  ): Promise<ToolResult<TData>> {
    try {
      return await operation()
    } catch (error) {
      return failResult(this.sessionId, error, fallbackCode) as ToolResult<TData>
    }
  }

  private async invalidRequest<TData>(message: string): Promise<ToolResult<TData>> {
    return failResult(
      this.sessionId,
      new BrowserToolError("invalid_request", message)
    ) as ToolResult<TData>
  }

  private unsupportedAttach<TData>(message: string): ToolResult<TData> {
    return failResult(
      this.sessionId,
      new BrowserToolError("unsupported_in_attach_mode", message)
    ) as ToolResult<TData>
  }
}
