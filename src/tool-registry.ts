import { z } from "zod"

import type { BrowserRuntime } from "./browser-runtime.js"
import {
  CookieValidationError,
  cookieInputSchema,
  validateCookieOperationShape,
} from "./cookie.js"
import type { CookieOperationInput } from "./contracts.js"
import {
  ASSET_KINDS,
  ASSET_OBSERVATION_STATES,
  ASSET_ORIGIN_RELATIONSHIPS,
  ASSET_SORT_MODES,
  PERFORMANCE_RESOURCE_SORT_MODES,
  SUPPORTED_ARTIFACT_TYPES,
  SUPPORTED_BROWSER_PERMISSIONS,
  type ToolResult,
} from "./contracts.js"

const waitUntilSchema = z.enum(["load", "domcontentloaded", "networkidle"])
const targetIdSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const strictObjectWithoutTarget = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).strict()
const strictObject = <T extends z.ZodRawShape>(shape: T) =>
  strictObjectWithoutTarget({
    ...shape,
    // Every top-level browser operation may be explicitly routed to one named
    // target. Nested action objects have their own contracts and must not
    // inherit this field accidentally.
    targetId: targetIdSchema.optional(),
  })
const timeoutMsSchema = z.number().int().positive().max(120_000)
const viewportDimensionSchema = z.number().int().positive().max(10_000)
const browserPermissionSchema = z.enum(SUPPORTED_BROWSER_PERMISSIONS)
const artifactTypeSchema = z.enum(SUPPORTED_ARTIFACT_TYPES)
const frameIdSchema = z.string().optional()
const screenshotClipSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .strict()
const pointTargetSchema = {
  ref: z.string().optional(),
  selector: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
}
const elementTargetSchema = {
  ref: z.string().optional(),
  selector: z.string().optional(),
}
const locatorQuerySchema = z
  .object({
    selector: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    text: z.string().optional(),
    label: z.string().optional(),
    placeholder: z.string().optional(),
    testId: z.string().optional(),
    exact: z.boolean().optional(),
    index: z.number().int().nonnegative().optional(),
  })
  .strict()
const elementVisualTargetSchema = {
  ref: z.string().optional(),
  selector: z.string().optional(),
  locator: locatorQuerySchema.optional(),
}
const consoleLevelSchema = z.enum([
  "debug",
  "info",
  "log",
  "warn",
  "warning",
  "error",
])
const networkEventTypeSchema = z.enum(["response", "request_failed"])
const webSocketEventTypeSchema = z.enum([
  "open",
  "frame_sent",
  "frame_received",
  "socket_error",
  "close",
])
const assetKindSchema = z.enum(ASSET_KINDS)
const assetObservationStateSchema = z.enum(ASSET_OBSERVATION_STATES)
const assetOriginRelationshipSchema = z.enum(ASSET_ORIGIN_RELATIONSHIPS)
const assetSortModeSchema = z.enum(ASSET_SORT_MODES)
const performanceResourceSortModeSchema = z.enum(PERFORMANCE_RESOURCE_SORT_MODES)
const colorSchemeSchema = z.enum(["light", "dark", "no-preference"])
const reducedMotionSchema = z.enum(["reduce", "no-preference"])
const forcedColorsSchema = z.enum(["active", "none"])
const mouseButtonSchema = z.enum(["left", "right", "middle"])
const triggerActionSchema = strictObjectWithoutTarget({
  type: z.enum(["click", "double_click", "press"]),
  frameId: z.string().optional(),
  ref: z.string().optional(),
  selector: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  key: z.string().optional(),
})

export type BrowserToolSessionScope = "none" | "tab" | "context"
export type BrowserToolResultKind = "json" | "screenshot"

export const BROWSER_MCP_TOOL_GROUPS = [
  "core",
  "interaction",
  "visual",
  "files",
  "diagnostics",
  "environment",
] as const

export type BrowserMcpToolGroup = (typeof BROWSER_MCP_TOOL_GROUPS)[number]

type BrowserRuntimeMethod = {
  [K in keyof BrowserRuntime]: BrowserRuntime[K] extends (
    ...args: any[]
  ) => Promise<ToolResult<any>>
    ? K
    : never
}[keyof BrowserRuntime]
type BrowserToolArgumentMode = "object" | "none"

type BrowserToolOptions = {
  sessionScope?: BrowserToolSessionScope
  contextGlobal?: boolean | ((input: Record<string, unknown>) => boolean)
  resultKind?: BrowserToolResultKind
  argumentMode?: BrowserToolArgumentMode
  requiresExistingTab?: boolean
}

export type BrowserToolDefinition = {
  name: string
  description: string
  inputSchema: z.AnyZodObject
  runtimeMethod: BrowserRuntimeMethod
  sessionScope: BrowserToolSessionScope
  contextGlobal: boolean | ((input: Record<string, unknown>) => boolean)
  resultKind: BrowserToolResultKind
  mcpGroups: readonly BrowserMcpToolGroup[]
  requiresExistingTab: boolean
  invoke(
    runtime: BrowserRuntime,
    input: Record<string, unknown>,
    context?: BrowserToolCallContext
  ): Promise<ToolResult>
}

export type BrowserToolCallContext = {
  signal?: AbortSignal
}

function defineBrowserTool<
  const Name extends string,
>(
  name: Name,
  description: string,
  inputSchema: z.AnyZodObject,
  runtimeMethod: BrowserRuntimeMethod,
  mcpGroups: readonly BrowserMcpToolGroup[],
  options: BrowserToolOptions = {}
): BrowserToolDefinition & { name: Name } {
  const argumentMode = options.argumentMode ?? "object"
  return {
    name,
    description,
    inputSchema,
    runtimeMethod,
    sessionScope: options.sessionScope ?? "none",
    contextGlobal: options.contextGlobal ?? false,
    resultKind: options.resultKind ?? "json",
    mcpGroups,
    requiresExistingTab: options.requiresExistingTab ?? false,
    async invoke(
      runtime: BrowserRuntime,
      input: Record<string, unknown>,
      context: BrowserToolCallContext = {}
    ) {
      const method = (runtime as unknown as Record<string, unknown>)[
        String(runtimeMethod)
      ] as (
        ...args: unknown[]
      ) => Promise<ToolResult>
      const args =
        argumentMode === "none"
          ? [{}, context]
          : [input, context]
      return method.apply(runtime, args)
    },
  }
}

const browserToolDefinitions = [
  defineBrowserTool(
    "browser_navigation",
    "Open a URL, move through history, reload, or wait for a URL match.",
    strictObject({
      action: z.enum(["open", "back", "forward", "reload", "wait_url"]),
      url: z.string().optional(),
      tabId: z.string().optional(),
      newTab: z.boolean().optional(),
      waitUntil: waitUntilSchema.optional(),
      timeoutMs: timeoutMsSchema.optional(),
    }),
    "navigation",
    ["core"],
    { sessionScope: "tab" }
  ),
  defineBrowserTool(
    "browser_tab",
    "List, select, inspect, or close browser tabs.",
    strictObject({
      action: z.enum(["list", "select", "current", "close"]),
      tabId: z.string().optional(),
      all: z.boolean().optional(),
      confirmed: z.literal(true).optional(),
    }),
    "tab",
    ["core"],
    { contextGlobal: (input) => input.action === "close" && input.all === true }
  ),
  defineBrowserTool(
    "browser_status",
    "Return runtime/session status, target state, config paths, tabs, environment metadata, and diagnostic counts.",
    strictObject({}),
    "status",
    ["core", "diagnostics"],
    {}
  ),
  defineBrowserTool(
    "browser_target",
    "List, connect, select, or disconnect an explicitly named Chrome target.",
    strictObject({
      action: z.enum(["list", "connect", "select", "disconnect"]),
      confirmed: z.literal(true).optional(),
    }),
    "browserTarget",
    ["core"],
    {
      sessionScope: "none",
      // Target lifecycle is coordinated per target by BrowserSessionRouter;
      // keeping it out of the scheduler's process-wide exclusive lane lets
      // independent Chrome targets connect/disconnect concurrently.
      contextGlobal: false,
    }
  ),
  defineBrowserTool(
    "browser_artifacts",
    "List read-only metadata for screenshot and download artifacts.",
    strictObject({
      types: z.array(artifactTypeSchema).min(1).max(2).optional(),
      limit: z.number().int().positive().max(1_000).optional(),
    }),
    "artifacts",
    ["core", "visual", "files"]
  ),
  defineBrowserTool(
    "browser_viewport",
    "Get the actual viewport and window/fixed mode, or set explicit dimensions or a named preset.",
    strictObject({
      action: z.enum(["get", "set"]),
      tabId: z.string().optional(),
      width: viewportDimensionSchema.optional(),
      height: viewportDimensionSchema.optional(),
      preset: z.string().optional(),
    }),
    "viewport",
    ["visual", "environment"],
    { sessionScope: "tab" }
  ),
  defineBrowserTool(
    "browser_device",
    "Get supported Chromium device presets or set/clear the active preset.",
    strictObject({
      action: z.enum(["get", "set"]),
      preset: z.string().optional(),
      clear: z.boolean().optional(),
      confirmed: z.literal(true).optional(),
    }),
    "device",
    ["visual", "environment"],
    { sessionScope: "context", contextGlobal: (input) => input.action === "set" }
  ),
  defineBrowserTool(
    "browser_context",
    "Get runtime-owned context state or change geolocation/permission overrides.",
    strictObject({
      action: z.enum(["get", "geolocation", "permissions"]),
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      accuracy: z.number().optional(),
      permissions: z.array(browserPermissionSchema).min(1).max(10).optional(),
      origin: z.string().optional(),
      clear: z.boolean().optional(),
    }),
    "browserContext",
    ["environment"],
    { contextGlobal: (input) => input.action !== "get" }
  ),
  defineBrowserTool(
    "browser_cookie",
    "Inject or clear target-scoped Cookies in the existing Playwright browser context without Cookie readback.",
    cookieInputSchema,
    "cookie",
    ["environment"],
    {
      sessionScope: "tab",
      contextGlobal: true,
      requiresExistingTab: true,
    }
  ),
  defineBrowserTool(
    "browser_emulation",
    "Get, set, or clear runtime-owned context emulation overrides.",
    strictObject({
      action: z.enum(["get", "set"]),
      userAgent: z.string().optional(),
      locale: z.string().optional(),
      timezoneId: z.string().optional(),
      deviceScaleFactor: z.number().optional(),
      hasTouch: z.boolean().optional(),
      isMobile: z.boolean().optional(),
      clear: z.boolean().optional(),
      confirmed: z.literal(true).optional(),
    }),
    "emulation",
    ["environment"],
    { sessionScope: "context", contextGlobal: (input) => input.action === "set" }
  ),
  defineBrowserTool(
    "browser_offline",
    "Get or set shared BrowserContext offline mode.",
    strictObject({
      action: z.enum(["get", "set"]),
      offline: z.boolean().optional(),
    }),
    "offline",
    ["environment"],
    { sessionScope: "context", contextGlobal: (input) => input.action === "set" }
  ),
  defineBrowserTool(
    "browser_media",
    "Get, set, merge, or clear media emulation for one tab.",
    strictObject({
      action: z.enum(["get", "set"]),
      tabId: z.string().optional(),
      colorScheme: colorSchemeSchema.optional(),
      reducedMotion: reducedMotionSchema.optional(),
      forcedColors: forcedColorsSchema.optional(),
      clear: z.boolean().optional(),
    }),
    "media",
    ["visual", "environment"],
    { sessionScope: "tab" }
  ),
  defineBrowserTool(
    "browser_frames",
    "List frames for the active or specified tab. Frame ids are runtime-local.",
    strictObject({ tabId: z.string().optional() }),
    "frames",
    ["core", "interaction"],
    { sessionScope: "tab" }
  ),
  defineBrowserTool(
    "browser_snapshot",
    "Read visible page text plus links, inputs, and actionable elements with snapshot-level refs.",
    strictObject({
      tabId: z.string().optional(),
      frameId: frameIdSchema,
      maxTextLength: z.number().int().positive().max(200_000).optional(),
      maxElements: z.number().int().positive().max(500).optional(),
    }),
    "snapshot",
    ["core", "visual"],
    { sessionScope: "tab" }
  ),
  defineBrowserTool(
    "browser_screenshot",
    "Capture a CSS-pixel PNG screenshot aligned with input coordinates. Defaults to the screenshot directory; an explicit path may write elsewhere.",
    strictObject({
      tabId: z.string().optional(),
      path: z.string().optional(),
      base64: z.boolean().optional(),
      fullPage: z.boolean().optional(),
      clip: screenshotClipSchema.optional(),
    }),
    "screenshot",
    ["core", "visual"],
    { sessionScope: "tab", resultKind: "screenshot" }
  ),
  defineBrowserTool(
    "browser_inspect_point",
    "Inspect visible main-document elements at viewport coordinates, with an optional annotated PNG screenshot.",
    strictObject({
      tabId: z.string().optional(),
      x: z.number(),
      y: z.number(),
      includeNonActionable: z.boolean().optional(),
      annotatedScreenshot: z.boolean().optional(),
      path: z.string().optional(),
      base64: z.boolean().optional(),
    }),
    "inspectPoint",
    ["visual"],
    { sessionScope: "tab", resultKind: "screenshot" }
  ),
  defineBrowserTool(
    "browser_element_visual",
    "Read bounds, capture, scroll, or highlight one ref, selector, or semantic locator target.",
    strictObject({
      tabId: z.string().optional(),
      frameId: frameIdSchema,
      action: z.enum(["box", "screenshot", "scroll_into_view", "highlight"]),
      ...elementVisualTargetSchema,
      timeoutMs: timeoutMsSchema.optional(),
      path: z.string().optional(),
      base64: z.boolean().optional(),
    }),
    "elementVisual",
    ["visual", "interaction"],
    { sessionScope: "tab", resultKind: "screenshot" }
  ),
  defineBrowserTool(
    "browser_keyboard",
    "Type into current focus, hold a key, or release a tracked key. Typed text is not echoed in logs.",
    strictObject({
      tabId: z.string().optional(),
      action: z.enum(["type", "down", "up"]),
      text: z.string().optional(),
      key: z.string().optional(),
      delayMs: z.number().int().min(0).max(10_000).optional(),
    }),
    "keyboard",
    ["interaction"],
    { sessionScope: "tab" }
  ),
  defineBrowserTool(
    "browser_mouse",
    "Move, hold/release a button, or dispatch a wheel event at optional CSS viewport x/y coordinates; omitted coordinates use the current pointer.",
    strictObject({
      tabId: z.string().optional(),
      action: z.enum(["move", "down", "up", "wheel"]),
      x: z.number().optional(),
      y: z.number().optional(),
      steps: z.number().int().positive().max(100).optional(),
      button: mouseButtonSchema.optional(),
      clickCount: z.number().int().positive().max(10).optional(),
      deltaX: z.number().optional(),
      deltaY: z.number().optional(),
    }),
    "mouse",
    ["interaction"],
    { sessionScope: "tab" }
  ),
  defineBrowserTool(
    "browser_input_reset",
    "Release all keys and mouse buttons held through chrome-power on one tab.",
    strictObject({ tabId: z.string().optional() }),
    "inputReset",
    ["interaction"],
    { sessionScope: "tab" }
  ),
  defineBrowserTool(
    "browser_set_input_files",
    "Set files on an input[type=file]. Requires absolute paths and confirmed user approval.",
    strictObject({
      tabId: z.string().optional(),
      frameId: frameIdSchema,
      ...elementTargetSchema,
      paths: z.array(z.string().min(1)).min(1).max(20),
      confirmed: z.literal(true),
      timeoutMs: timeoutMsSchema.optional(),
    }),
    "setInputFiles",
    ["interaction", "files"],
    { sessionScope: "tab" }
  ),
  defineBrowserTool(
    "browser_element_query",
    "Count, read text/attribute/state, or wait through one semantic locator.",
    strictObject({
      tabId: z.string().optional(),
      frameId: frameIdSchema,
      action: z.enum(["count", "text", "attribute", "state", "wait"]),
      locator: locatorQuerySchema,
      all: z.boolean().optional(),
      textKind: z.enum(["innerText", "textContent"]).optional(),
      state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
      name: z.string().optional(),
      timeoutMs: timeoutMsSchema.optional(),
    }),
    "elementQuery",
    ["interaction"],
    { sessionScope: "tab" }
  ),
  defineBrowserTool(
    "browser_element_action",
    "Perform bounded element interaction actions through a locator, ref, selector, coordinates, or drag endpoints.",
    strictObject({
      tabId: z.string().optional(),
      frameId: frameIdSchema,
      action: z.enum(["click", "double_click", "hover", "drag", "type", "press", "focus", "set_checked", "select_option", "scroll", "wait"]),
      locator: locatorQuerySchema.optional(),
      ...pointTargetSchema,
      fromRef: z.string().optional(),
      fromSelector: z.string().optional(),
      fromX: z.number().optional(),
      fromY: z.number().optional(),
      toRef: z.string().optional(),
      toSelector: z.string().optional(),
      toX: z.number().optional(),
      toY: z.number().optional(),
      steps: z.number().int().positive().max(100).optional(),
      text: z.string().optional(),
      clear: z.boolean().optional(),
      key: z.string().optional(),
      checked: z.boolean().optional(),
      value: z.string().optional(),
      label: z.string().optional(),
      index: z.number().int().nonnegative().optional(),
      deltaX: z.number().optional(),
      deltaY: z.number().optional(),
      loadState: waitUntilSchema.optional(),
      timeoutMs: timeoutMsSchema.optional(),
    }),
    "elementAction",
    ["interaction"],
    { sessionScope: "tab" }
  ),
  defineBrowserTool(
    "browser_console",
    "List or wait for bounded console logs.",
    strictObject({
      tabId: z.string().optional(),
      action: z.enum(["list", "wait"]),
      levels: z.array(consoleLevelSchema).max(10).optional(),
      filter: z.string().optional(),
      limit: z.number().int().positive().max(1_000).optional(),
      timeoutMs: timeoutMsSchema.optional(),
      clear: z.boolean().optional(),
    }),
    "console",
    ["diagnostics"],
    { sessionScope: "tab" }
  ),
  defineBrowserTool(
    "browser_page_error",
    "List or wait for bounded page runtime errors.",
    strictObject({
      tabId: z.string().optional(),
      action: z.enum(["list", "wait"]),
      filter: z.string().optional(),
      limit: z.number().int().positive().max(1_000).optional(),
      timeoutMs: timeoutMsSchema.optional(),
      clear: z.boolean().optional(),
    }),
    "pageError",
    ["diagnostics"],
    { sessionScope: "tab" }
  ),
  defineBrowserTool(
    "browser_network",
    "List, wait for, or summarize bounded metadata-only network events.",
    strictObject({
      tabId: z.string().optional(),
      action: z.enum(["list", "wait", "summary"]),
      types: z.array(networkEventTypeSchema).max(2).optional(),
      filter: z.string().optional(),
      statusMin: z.number().int().min(100).max(999).optional(),
      statusMax: z.number().int().min(100).max(999).optional(),
      limit: z.number().int().positive().max(1_000).optional(),
      timeoutMs: timeoutMsSchema.optional(),
      clear: z.boolean().optional(),
    }),
    "network",
    ["diagnostics"],
    { sessionScope: "tab" }
  ),
  defineBrowserTool(
    "browser_assets",
    "Inventory bounded metadata-only page assets from DOM declarations, resource timing, and captured network observations for the active or specified frame.",
    strictObject({
      tabId: z.string().optional(),
      frameId: z.string().optional(),
      kinds: z.array(assetKindSchema).max(9).optional(),
      states: z.array(assetObservationStateSchema).max(5).optional(),
      origins: z.array(assetOriginRelationshipSchema).max(4).optional(),
      filter: z.string().optional(),
      minTransferBytes: z.number().int().nonnegative().optional(),
      sortBy: assetSortModeSchema.optional(),
      limit: z.number().int().positive().max(500).optional(),
    }),
    "assets",
    ["diagnostics"],
    { sessionScope: "tab" }
  ),
  defineBrowserTool(
    "browser_performance_summary",
    "Summarize bounded navigation timing, Web Vitals, long tasks, and top Resource Timing metadata for the active or specified frame.",
    strictObject({
      tabId: z.string().optional(),
      frameId: z.string().optional(),
      resourceKinds: z.array(assetKindSchema).max(9).optional(),
      minResourceDurationMs: z.number().nonnegative().optional(),
      minTransferBytes: z.number().int().nonnegative().optional(),
      sortResourcesBy: performanceResourceSortModeSchema.optional(),
      resourceLimit: z.number().int().positive().max(50).optional(),
    }),
    "performanceSummary",
    ["diagnostics"],
    { sessionScope: "tab" }
  ),
  defineBrowserTool(
    "browser_websocket",
    "List, wait for, or summarize bounded metadata-only WebSocket events.",
    strictObject({
      tabId: z.string().optional(),
      action: z.enum(["list", "wait", "summary"]),
      types: z.array(webSocketEventTypeSchema).max(5).optional(),
      filter: z.string().optional(),
      limit: z.number().int().positive().max(1_000).optional(),
      timeoutMs: timeoutMsSchema.optional(),
      clear: z.boolean().optional(),
    }),
    "webSocket",
    ["diagnostics"],
    { sessionScope: "tab" }
  ),
  defineBrowserTool(
    "browser_expect_page",
    "Perform one narrow trigger action and wait for navigation or a popup.",
    strictObject({
      event: z.enum(["navigation", "popup"]),
      tabId: z.string().optional(),
      trigger: triggerActionSchema,
      waitUntil: waitUntilSchema.optional(),
      timeoutMs: timeoutMsSchema.optional(),
    }),
    "expectPage",
    ["core", "interaction"],
    { sessionScope: "tab" }
  ),
  defineBrowserTool(
    "browser_expect_file",
    "Perform one narrow trigger action and wait for a download or confirmed file chooser.",
    strictObject({
      event: z.enum(["download", "file_chooser"]),
      tabId: z.string().optional(),
      trigger: triggerActionSchema,
      filename: z.string().optional(),
      paths: z.array(z.string().min(1)).min(1).max(20).optional(),
      confirmed: z.literal(true).optional(),
      timeoutMs: timeoutMsSchema.optional(),
    }),
    "expectFile",
    ["interaction", "files"],
    { sessionScope: "tab" }
  ),
  defineBrowserTool(
    "browser_dialog",
    "Inspect or handle the active JavaScript dialog for one tab.",
    strictObject({
      action: z.enum(["get", "handle"]),
      tabId: z.string().optional(),
      accept: z.boolean().optional(),
      promptText: z.string().optional(),
    }),
    "dialog",
    ["core", "interaction"],
    { sessionScope: "tab" }
  ),
]

export type BrowserToolName =
  (typeof browserToolDefinitions)[number]["name"]

// Keep the exported registry widened so concrete Zod schemas do not form one
// giant inferred tuple during declaration emit. Only the erased literal names
// above are retained for the BrowserToolName union.
export const BROWSER_TOOL_DEFINITIONS: BrowserToolDefinition[] =
  browserToolDefinitions

export const BROWSER_TOOL_NAMES = browserToolDefinitions.map(
  (definition) => definition.name
)

if (new Set(BROWSER_TOOL_NAMES).size !== BROWSER_TOOL_NAMES.length) {
  throw new Error("Browser tool registry contains duplicate tool names.")
}

const browserToolRegistry = Object.fromEntries(
  BROWSER_TOOL_DEFINITIONS.map((definition) => [definition.name, definition])
) as Record<BrowserToolName, BrowserToolDefinition>

const browserToolByRuntimeMethod = new Map<string, BrowserToolName>(
  BROWSER_TOOL_DEFINITIONS.map((definition) => [
    String(definition.runtimeMethod),
    definition.name as BrowserToolName,
  ])
)

if (browserToolByRuntimeMethod.size !== BROWSER_TOOL_DEFINITIONS.length) {
  throw new Error("Browser tool registry contains duplicate runtime methods.")
}

export function getBrowserToolDefinition(name: BrowserToolName) {
  return browserToolRegistry[name]
}

export function isBrowserToolName(name: string): name is BrowserToolName {
  return Object.hasOwn(browserToolRegistry, name)
}

export function browserToolForRuntimeMethod(method: string) {
  return browserToolByRuntimeMethod.get(method)
}

export function isTabScopedBrowserTool(name: BrowserToolName) {
  return browserToolRegistry[name].sessionScope === "tab"
}

export function requiresExistingTab(name: BrowserToolName) {
  return browserToolRegistry[name].requiresExistingTab
}

export function isContextGlobalBrowserToolCall(
  name: BrowserToolName,
  input: Record<string, unknown>
) {
  const contextGlobal = browserToolRegistry[name].contextGlobal
  return typeof contextGlobal === "function"
    ? contextGlobal(input)
    : contextGlobal
}

export function isLockFreeDiagnosticWaitCall(
  name: BrowserToolName,
  input: Record<string, unknown>
) {
  return (
    input.action === "wait" &&
    (name === "browser_console" ||
      name === "browser_page_error" ||
      name === "browser_network" ||
      name === "browser_websocket")
  )
}

export type ParsedBrowserToolInput =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; result: ToolResult }

export function parseBrowserToolInput(
  runtime: Pick<BrowserRuntime, "sessionId">,
  name: BrowserToolName,
  input: unknown = {}
): ParsedBrowserToolInput {
  const parsed = browserToolRegistry[name].inputSchema.safeParse(input ?? {})
  if (parsed.success) {
    if (name === "browser_cookie") {
      try {
        validateCookieOperationShape(parsed.data as CookieOperationInput)
      } catch (error) {
        if (error instanceof CookieValidationError) {
          return {
            ok: false,
            result: invalidBrowserToolRequest(runtime, error.message),
          }
        }
        return {
          ok: false,
          result: invalidBrowserToolRequest(
            runtime,
            "Invalid arguments for browser_cookie."
          ),
        }
      }
    }
    return { ok: true, input: parsed.data }
  }
  return {
    ok: false,
    result: invalidBrowserToolRequest(
      runtime,
      `Invalid arguments for ${name}: ${formatZodError(parsed.error)}`
    ),
  }
}

export async function callBrowserTool(
  runtime: BrowserRuntime,
  name: string,
  input: unknown = {},
  context: BrowserToolCallContext = {}
): Promise<ToolResult> {
  if (!isBrowserToolName(name)) {
    return invalidBrowserToolRequest(runtime, `Unknown browser tool: ${name}`)
  }
  const parsed = parseBrowserToolInput(runtime, name, input)
  if (!parsed.ok) return parsed.result
  return browserToolRegistry[name].invoke(runtime, parsed.input, context)
}

export function invalidBrowserToolRequest(
  runtime: Pick<BrowserRuntime, "sessionId">,
  message: string
): ToolResult {
  return {
    ok: false,
    sessionId: runtime.sessionId,
    error: {
      code: "invalid_request",
      message,
    },
  }
}

function formatZodError(error: z.ZodError) {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "arguments"
      return `${path}: ${issue.message}`
    })
    .join("; ")
}
