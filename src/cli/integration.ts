#!/usr/bin/env node
import { randomUUID } from "node:crypto"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { createConnection, createServer } from "node:net"
import { createServer as createHttpServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { chromium } from "playwright"

import {
  BrowserCallScheduler,
  type BrowserCallDescriptor,
} from "../browser-call-scheduler.js"
import { BrowserRuntime } from "../browser-runtime.js"
import {
  loadBrowserTargetsFile,
  parseBrowserTargetsFile,
  resolveBrowserTargetEndpoint,
} from "../browser-targets.js"
import { boundedDiagnosticUrl } from "../validation-utils.js"
import { BrowserOwnerClient } from "../owner-client.js"
import {
  ownerControlPath,
  ownerEndpoint,
  ownerSocketPath,
} from "../owner-ipc.js"
import {
  DEFAULT_MAX_CONCURRENT_CALLS,
  DEFAULT_MAX_DIAGNOSTIC_WAITS,
  DEFAULT_MAX_QUEUED_CALLS,
  DEFAULT_SCREENSHOT_INLINE_MAX_BYTES,
  loadConfig,
} from "../config.js"
import {
  DEFAULT_COOKIE_MAX_TTL_SECONDS,
  MAX_COOKIE_MAX_TTL_SECONDS,
  cookieDomainClearFilters,
  normalizeCookieOperation,
  resolveCookieTarget,
} from "../cookie.js"
import type { ToolResult } from "../contracts.js"
import { BrowserToolError } from "../errors.js"
import {
  BROWSER_CAPABILITIES_TOOL_NAME,
  BROWSER_TOOL_NAMES,
  callBrowserTool,
  resolveMcpToolSelection,
} from "../tools.js"

const root = await mkdtemp(join(tmpdir(), "chrome-power-integration-"))
const ownerSocket = join(root, "owner.sock")
const serverEntry = fileURLToPath(new URL("../server.js", import.meta.url))
const fallbackEntry = fileURLToPath(new URL("./fallback.js", import.meta.url))
const appRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const stderr: string[] = []
const clients: ConnectedClient[] = []
const execFileAsync = promisify(execFile)

try {
  await writeFile(ownerSocket, "stale owner socket fixture")
  const pageAPath = join(root, "page-a.html")
  const pageBPath = join(root, "page-b.html")
  await writeFile(
    pageAPath,
    `<!doctype html><title>Session A</title><img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%228%22/%3E"><svg width="20" height="10" viewBox="0 0 20 10"><rect width="20" height="10"></rect></svg><p>A</p><button id="integration-dialog" onclick="alert('integration dialog')">Open dialog</button><a id="popup" target="_blank" href="${pathToFileURL(pageBPath).href}">Open B popup</a>`
  )
  await writeFile(pageBPath, "<!doctype html><title>Session B</title><p>B</p>")

  await assertBrowserCallSchedulerCases()
  await assertOwnerClientDoesNotReplayUnknownResult()
  await assertOwnerClientCancellation()
  await assertMalformedOwnerResponseRejected()

  const [clientA, clientB] = await Promise.all([
    connectClient("integration-a"),
    connectClient("integration-b"),
  ])
  clients.push(clientA, clientB)

  await assertOwnerStartFromReplacedWorkingDirectory()
  await assertCookieInjectionCases()

  const listedTools = await clientA.client.listTools()
  const defaultMcpToolNames = [
    ...BROWSER_TOOL_NAMES,
    BROWSER_CAPABILITIES_TOOL_NAME,
  ]
  assertEqual(
    listedTools.tools.length,
    defaultMcpToolNames.length,
    "default MCP tool list includes every runtime tool plus capabilities"
  )
  assertEqual(
    JSON.stringify(listedTools.tools.map((tool) => tool.name)),
    JSON.stringify(defaultMcpToolNames),
    "default MCP tool list preserves registry ordering before capabilities"
  )
  const listedToolNames = new Set(listedTools.tools.map((tool) => tool.name))
  const uploadTool = listedTools.tools.find(
    (tool) => tool.name === "browser_set_input_files"
  )
  const uploadProperties = record(record(uploadTool?.inputSchema).properties)
  assertEqual(
    record(uploadProperties.confirmed).const,
    true,
    "upload schema exposes confirmed as the literal true"
  )
  assert(
    listedToolNames.has("browser_element_action"),
    "aggregated element action is advertised"
  )
  for (const aggregateName of [
    "browser_navigation",
    "browser_tab",
    "browser_expect_page",
    "browser_expect_file",
    "browser_viewport",
    "browser_device",
    "browser_context",
    "browser_emulation",
    "browser_offline",
    "browser_media",
    "browser_dialog",
  ]) {
    assert(
      listedToolNames.has(aggregateName),
      `aggregated workflow tool is advertised: ${aggregateName}`
    )
  }
  for (const removedName of [
    "browser_click",
    "browser_double_click",
    "browser_hover",
    "browser_drag",
    "browser_type",
    "browser_press",
    "browser_set_checked",
    "browser_select_option",
    "browser_scroll",
    "browser_wait",
    "browser_open",
    "browser_back",
    "browser_forward",
    "browser_reload",
    "browser_wait_url",
    "browser_tabs",
    "browser_select_tab",
    "browser_current",
    "browser_close",
    "browser_expect_navigation",
    "browser_expect_popup",
    "browser_expect_download",
    "browser_expect_file_chooser",
    "browser_set_viewport",
    "browser_devices",
    "browser_set_device",
    "browser_environment",
    "browser_set_emulation",
    "browser_set_geolocation",
    "browser_set_permissions",
    "browser_set_offline",
    "browser_set_media",
    "browser_handle_dialog",
  ]) {
    assert(
      !listedToolNames.has(removedName),
      `removed interaction micro-tool is not advertised: ${removedName}`
    )
  }
  const listedCapabilities = listedTools.tools.find(
    (tool) => tool.name === BROWSER_CAPABILITIES_TOOL_NAME
  )
  assertEqual(
    listedCapabilities?.annotations?.readOnlyHint,
    true,
    "browser capabilities is advertised as read-only"
  )
  const defaultCapabilities = await callOk(
    clientA.client,
    BROWSER_CAPABILITIES_TOOL_NAME
  )
  const defaultCapabilityData = record(defaultCapabilities.data)
  assertEqual(
    defaultCapabilityData.source,
    "default",
    "missing MCP profile reports the compatibility default"
  )
  assertEqual(
    defaultCapabilityData.requested,
    "all",
    "default MCP capabilities request all runtime tools"
  )
  assertEqual(
    defaultCapabilityData.exposedToolCount,
    BROWSER_TOOL_NAMES.length + 1,
    "default capabilities include every runtime tool plus metadata"
  )
  assertEqual(
    JSON.stringify(defaultCapabilityData.omittedRuntimeTools),
    JSON.stringify([]),
    "default capabilities omit no runtime tools"
  )
  const invalidCapabilities = await callTool(
    clientA.client,
    BROWSER_CAPABILITIES_TOOL_NAME,
    { unknown: true }
  )
  assertEqual(
    invalidCapabilities.error?.code,
    "invalid_request",
    "capabilities schema rejects unknown fields"
  )

  assertProfileParserCases()
  assertNamespaceConfigCases()
  assertNumericConfigCases()
  assertBrowserCallLimitConfigCases()
  assertCookieConfigCases()
  assertOwnerEndpointCases()
  await assertOwnerTargetFingerprintIsolation()
  await assertBrowserTargetConfigCases()
  await assertAttachedTargetCases(pageAPath, pageBPath)
  await assertCliOwnerConflict()
  await assertPermissionGrantBound()

  const coreClient = await connectClient("integration-core", {
    ownerSocket: join(root, "core-owner.sock"),
    profileDir: join(root, "core-profile"),
    mcpTools: "core",
  })
  clients.push(coreClient)
  const coreSelection = resolveMcpToolSelection("core")
  const coreListedTools = await coreClient.client.listTools()
  assertEqual(
    JSON.stringify(coreListedTools.tools.map((tool) => tool.name)),
    JSON.stringify([
      ...coreSelection.enabledDefinitions.map((definition) => definition.name),
      BROWSER_CAPABILITIES_TOOL_NAME,
    ]),
    "core MCP tool list matches the canonical registry subset"
  )
  const coreToolNames = new Set(coreListedTools.tools.map((tool) => tool.name))
  assert(coreToolNames.has("browser_expect_page"), "core exposes page expectations")
  assert(coreToolNames.has("browser_artifacts"), "core exposes artifact discovery")
  assert(!coreToolNames.has("browser_expect_file"), "core does not expose file expectations")
  const coreCapabilities = await callOk(
    coreClient.client,
    BROWSER_CAPABILITIES_TOOL_NAME
  )
  const coreCapabilityData = record(coreCapabilities.data)
  assertEqual(
    JSON.stringify(coreCapabilityData.activeGroups),
    JSON.stringify(["core"]),
    "core capabilities report the active group"
  )
  assertEqual(
    coreCapabilityData.runtimeToolCount,
    BROWSER_TOOL_NAMES.length,
    "capabilities report the canonical runtime tool count"
  )
  assertEqual(
    coreCapabilityData.exposedToolCount,
    coreSelection.enabledDefinitions.length + 1,
    "capabilities include the server-local discovery tool in exposed count"
  )
  const disabledCoreCall = await callTool(
    coreClient.client,
    "browser_network"
  )
  assertEqual(
    disabledCoreCall.error?.code,
    "invalid_request",
    "disabled canonical tools return invalid_request"
  )
  assert(
    disabledCoreCall.error?.message.includes("not enabled") === true,
    "disabled canonical tools explain the active MCP selection"
  )
  const unknownCoreField = await callTool(
    coreClient.client,
    "browser_status",
    { fullpage: true }
  )
  assertEqual(
    unknownCoreField.error?.code,
    "invalid_request",
    "top-level schema rejects unknown fields"
  )
  const coreStatus = await callOk(coreClient.client, "browser_status")
  assertEqual(
    record(coreStatus.data).contextLaunched,
    false,
    "capability and disabled-tool checks do not launch Chromium"
  )

  const composedClient = await connectClient("integration-composed", {
    ownerSocket: join(root, "composed-owner.sock"),
    profileDir: join(root, "composed-profile"),
    mcpTools: "diagnostics, core,diagnostics",
  })
  clients.push(composedClient)
  const composedSelection = resolveMcpToolSelection(
    "diagnostics, core,diagnostics"
  )
  const composedCapabilities = await callOk(
    composedClient.client,
    BROWSER_CAPABILITIES_TOOL_NAME
  )
  assertEqual(
    JSON.stringify(record(composedCapabilities.data).requested),
    JSON.stringify(["diagnostics", "core"]),
    "capabilities preserve deduplicated requested group order"
  )
  const composedListedTools = await composedClient.client.listTools()
  assertEqual(
    JSON.stringify(composedListedTools.tools.map((tool) => tool.name)),
    JSON.stringify([
      ...composedSelection.enabledDefinitions.map(
        (definition) => definition.name
      ),
      BROWSER_CAPABILITIES_TOOL_NAME,
    ]),
    "composed MCP groups form a deduplicated canonical-order union"
  )

  await assertInvalidProfileStartup()

  const namespaceBaseProfile = join(root, "namespace-base", "profile")
  const namespaceBaseScreenshots = join(root, "namespace-screenshots")
  const namespaceBaseDownloads = join(root, "namespace-downloads")
  const namespaceAClient1 = await connectClient("integration-namespace-a1", {
    namespace: "project-a",
    profileDir: namespaceBaseProfile,
    screenshotDir: namespaceBaseScreenshots,
    downloadDir: namespaceBaseDownloads,
  })
  const namespaceAClient2 = await connectClient("integration-namespace-a2", {
    namespace: "project-a",
    profileDir: namespaceBaseProfile,
    screenshotDir: namespaceBaseScreenshots,
    downloadDir: namespaceBaseDownloads,
  })
  const namespaceBClient = await connectClient("integration-namespace-b", {
    namespace: "project-b",
    profileDir: namespaceBaseProfile,
    screenshotDir: namespaceBaseScreenshots,
    downloadDir: namespaceBaseDownloads,
  })
  clients.push(namespaceAClient1, namespaceAClient2, namespaceBClient)

  await callOk(namespaceAClient1.client, "browser_device", {
    action: "set",
    preset: "pixel-5",
  })
  await Promise.all([
    callOk(namespaceAClient1.client, "browser_navigation", {
      action: "open",
      url: pathToFileURL(pageAPath).href,
    }),
    callOk(namespaceAClient2.client, "browser_navigation", {
      action: "open",
      url: pathToFileURL(pageBPath).href,
      newTab: true,
    }),
    callOk(namespaceBClient.client, "browser_navigation", {
      action: "open",
      url: pathToFileURL(pageAPath).href,
    }),
  ])
  const [namespaceAStatus1, namespaceAStatus2, namespaceBStatus] =
    await Promise.all([
      callOk(namespaceAClient1.client, "browser_status"),
      callOk(namespaceAClient2.client, "browser_status"),
      callOk(namespaceBClient.client, "browser_status"),
    ])
  assertNamespaceStatus(
    namespaceAStatus1,
    "project-a",
    namespaceBaseProfile,
    namespaceBaseScreenshots,
    namespaceBaseDownloads
  )
  assertNamespaceStatus(
    namespaceAStatus2,
    "project-a",
    namespaceBaseProfile,
    namespaceBaseScreenshots,
    namespaceBaseDownloads
  )
  assertNamespaceStatus(
    namespaceBStatus,
    "project-b",
    namespaceBaseProfile,
    namespaceBaseScreenshots,
    namespaceBaseDownloads
  )
  assertEqual(
    ownerData(namespaceAStatus1).endpoint,
    ownerData(namespaceAStatus2).endpoint,
    "same namespace clients share one owner endpoint"
  )
  assert(
    ownerData(namespaceAStatus1).endpoint !== ownerData(namespaceBStatus).endpoint,
    "different namespaces use different owner endpoints"
  )
  assertEqual(
    ownerData(namespaceAStatus1).activeSessionCount,
    2,
    "same namespace retains shared-owner client collaboration"
  )
  const [namespaceATabs, namespaceBTabs] = await Promise.all([
    callOk(namespaceAClient1.client, "browser_tab", { action: "list" }),
    callOk(namespaceBClient.client, "browser_tab", { action: "list" }),
  ])
  const namespaceATabList = record(namespaceATabs.data).tabs
  const namespaceBTabList = record(namespaceBTabs.data).tabs
  assert(Array.isArray(namespaceATabList), "namespace A returns a tab list")
  assert(Array.isArray(namespaceBTabList), "namespace B returns a tab list")
  const namespaceATitles = namespaceATabList.map((tab) => record(tab).title)
  const namespaceBTitles = namespaceBTabList.map((tab) => record(tab).title)
  assert(
    namespaceATitles.includes("Session A") &&
      namespaceATitles.includes("Session B"),
    "same namespace clients share their opened tabs"
  )
  assert(
    namespaceBTitles.includes("Session A") &&
      !namespaceBTitles.includes("Session B"),
    "different namespace does not receive another namespace's tabs"
  )
  const [namespaceADevices, namespaceBDevices] = await Promise.all([
    callOk(namespaceAClient1.client, "browser_device", { action: "get" }),
    callOk(namespaceBClient.client, "browser_device", { action: "get" }),
  ])
  assertEqual(
    record(record(namespaceADevices.data).active).name,
    "pixel-5",
    "device state is retained within its namespace"
  )
  assertEqual(
    record(namespaceBDevices.data).active,
    undefined,
    "device state does not cross namespace boundaries"
  )
  const [namespaceAScreenshot, namespaceBScreenshot] = await Promise.all([
    callOk(namespaceAClient1.client, "browser_screenshot"),
    callOk(namespaceBClient.client, "browser_screenshot"),
  ])
  assert(
    String(record(namespaceAScreenshot.data).path).startsWith(
      join(namespaceBaseScreenshots, "namespaces", "project-a")
    ),
    "namespace A writes screenshots below its artifact boundary"
  )
  assert(
    String(record(namespaceBScreenshot.data).path).startsWith(
      join(namespaceBaseScreenshots, "namespaces", "project-b")
    ),
    "namespace B writes screenshots below its artifact boundary"
  )
  await callOk(namespaceAClient1.client, "browser_tab", {
    action: "close",
    all: true,
    confirmed: true,
  })
  const namespaceBAfterClose = await callOk(
    namespaceBClient.client,
    "browser_status"
  )
  assertEqual(
    record(namespaceBAfterClose.data).contextLaunched,
    true,
    "close-all in one namespace does not close another namespace"
  )
  assertEqual(
    record(namespaceBAfterClose.data).tabCount,
    namespaceBTabList.length,
    "cross-namespace tab state survives another namespace close-all"
  )
  const namespaceAControlPath = join(
    dirname(
      join(root, "namespace-base", "namespaces", "project-a", "profile")
    ),
    "owner.control.json"
  )
  const namespaceBControlPath = join(
    dirname(
      join(root, "namespace-base", "namespaces", "project-b", "profile")
    ),
    "owner.control.json"
  )
  const namespaceAControlBefore = record(
    JSON.parse(await readFile(namespaceAControlPath, "utf8"))
  )
  const namespaceBControlBefore = record(
    JSON.parse(await readFile(namespaceBControlPath, "utf8"))
  )
  const namespaceBEndpoint = record(namespaceBControlBefore.endpoint)
  assertEqual(
    namespaceBEndpoint.kind,
    "socket",
    "namespaced owner uses a profile-derived Unix endpoint"
  )
  const namespaceBShutdown = await sendOwnerShutdownAt(
    String(namespaceBEndpoint.path),
    String(namespaceBControlBefore.token)
  )
  assertEqual(
    record(namespaceBShutdown.control).status,
    "accepted",
    "namespaced owner accepts authenticated shutdown"
  )
  const namespaceBAfterRollover = await callOk(
    namespaceBClient.client,
    "browser_status"
  )
  assertEqual(
    record(namespaceBAfterRollover.data).contextLaunched,
    false,
    "next namespace call starts a fresh owner without replaying browser state"
  )
  const namespaceAControlAfter = record(
    JSON.parse(await readFile(namespaceAControlPath, "utf8"))
  )
  const namespaceBControlAfter = record(
    JSON.parse(await readFile(namespaceBControlPath, "utf8"))
  )
  assertEqual(
    namespaceAControlAfter.token,
    namespaceAControlBefore.token,
    "rolling one namespace does not replace another namespace owner"
  )
  assert(
    namespaceBControlAfter.token !== namespaceBControlBefore.token,
    "rolled namespace publishes a new owner control identity"
  )

  const directRuntime = new BrowserRuntime({
    ...loadConfig(),
    headless: true,
    profileDir: join(root, "direct-profile"),
    screenshotDir: join(root, "direct-screenshots"),
    downloadDir: join(root, "direct-downloads"),
  })
  const directInvalid = await callBrowserTool(
    directRuntime,
    "browser_navigation",
    { action: "open", url: 42 }
  )
  const rawTabA = await directRuntime.open({
    url: pathToFileURL(pageAPath).href,
    newTab: true,
  })
  const rawTabB = await directRuntime.open({
    url: pathToFileURL(pageBPath).href,
    newTab: true,
  })
  assert(rawTabA.ok && rawTabA.tabId, "raw runtime opens the first tab")
  assert(rawTabB.ok && rawTabB.tabId, "raw runtime opens the active tab")
  await directRuntime.close({ tabId: rawTabB.tabId })
  const rawStatusAfterClose = await directRuntime.status()
  assert(
    rawStatusAfterClose.ok &&
      rawStatusAfterClose.data?.activeTabId == null &&
      rawStatusAfterClose.data?.tabs.some((tab) => tab.id === rawTabA.tabId),
    "closing the active raw-runtime tab does not select an unrelated tab"
  )
  const runtimeInternals = directRuntime as unknown as {
    appendPageError(tabId: string, entry: unknown): void
    appendNetworkEvent(tabId: string, entry: unknown): void
    pageErrorsByTab: Map<string, unknown>
    networkEventsByTab: Map<string, unknown>
  }
  runtimeInternals.appendPageError(rawTabB.tabId, {
    message: "late error",
    timestamp: new Date().toISOString(),
  })
  runtimeInternals.appendNetworkEvent(rawTabB.tabId, {
    type: "request_failed",
    timestamp: new Date().toISOString(),
    url: "https://example.test/late",
    method: "GET",
    resourceType: "document",
  })
  assert(
    !runtimeInternals.pageErrorsByTab.has(rawTabB.tabId) &&
      !runtimeInternals.networkEventsByTab.has(rawTabB.tabId),
    "late callbacks cannot recreate per-tab diagnostic maps after close"
  )
  await directRuntime.dispose()
  const mcpInvalid = await callTool(clientA.client, "browser_navigation", { action: "open", url: 42 })
  assertEqual(mcpInvalid.ok, false, "invalid MCP arguments return a tool error")
  assertEqual(
    mcpInvalid.error?.code,
    directInvalid.error?.code,
    "MCP and direct dispatch use the same invalid-request code"
  )
  assertEqual(
    mcpInvalid.error?.message,
    directInvalid.error?.message,
    "MCP and direct dispatch use the same validation message"
  )

  const completeDiagnosticUrl =
    "https://user:password@example.test/path?token=secret&mode=debug#fragment"
  assertEqual(
    boundedDiagnosticUrl(completeDiagnosticUrl),
    completeDiagnosticUrl,
    "diagnostic URLs preserve userinfo, query, and fragment"
  )
  const oversizedDiagnosticUrl = `https://example.test/${"x".repeat(5_000)}`
  const boundedUrl = boundedDiagnosticUrl(oversizedDiagnosticUrl)
  assert(
    boundedUrl.startsWith(oversizedDiagnosticUrl.slice(0, 4_000)),
    "diagnostic URL keeps the first 4,000 characters"
  )
  assert(
    boundedUrl.includes("[truncated "),
    "diagnostic URL reports explicit truncation"
  )

  await Promise.all([
    callTool(clientA.client, "browser_status"),
    callTool(clientB.client, "browser_status"),
  ])

  const sharedStatus = await waitForStatus(clientA.client, (status) => status.ok)
  const sharedRuntime = record(record(sharedStatus.data).runtime)
  assertEqual(
    ownerData(sharedStatus).activeSessionCount,
    2,
    "two MCP sessions registered with one owner"
  )
  assertEqual(
    ownerData(sharedStatus).transport,
    "socket",
    "owner uses isolated Unix socket"
  )
  assert(
    sharedRuntime.packageVersion !== "unknown",
    "owner reports package version"
  )
  assertEqual(
    sharedRuntime.mode,
    "owner",
    "owner reports shared runtime mode"
  )

  const openedA = await callOk(clientA.client, "browser_navigation", {
    action: "open",
    url: pathToFileURL(pageAPath).href,
  })
  const openedB = await callOk(clientB.client, "browser_navigation", {
    action: "open",
    url: pathToFileURL(pageBPath).href,
  })
  assert(openedA.tabId && openedB.tabId, "both sessions received tab ids")
  assert(openedA.tabId !== openedB.tabId, "sessions default to separate tabs")

  const nativeAssets = await callToolDetailed(clientA.client, "browser_assets", {
    kinds: ["image", "inline_svg"],
    limit: 10,
  })
  assert(nativeAssets.result.ok, "native MCP asset inventory succeeds")
  const nativeAssetData = record(nativeAssets.result.data)
  assert(
    Array.isArray(nativeAssetData.assets) && nativeAssetData.assets.length === 2,
    "native MCP asset inventory returns bounded typed assets"
  )
  assert(
    JSON.stringify(nativeAssetData).includes("data:image") === false,
    "native MCP asset inventory hides raw data URLs"
  )
  const nativePerformance = await callToolDetailed(
    clientA.client,
    "browser_performance_summary",
    { resourceLimit: 5 }
  )
  assert(nativePerformance.result.ok, "native MCP performance summary succeeds")
  const nativePerformanceData = record(nativePerformance.result.data)
  assertEqual(
    record(nativePerformanceData.completeness).earlyObserverInstalled,
    true,
    "native MCP performance observer was installed early"
  )

  const defaultScreenshot = await callToolDetailed(
    clientA.client,
    "browser_screenshot"
  )
  assert(defaultScreenshot.result.ok, "default screenshot succeeds")
  const defaultScreenshotData = record(defaultScreenshot.result.data)
  assert(
    typeof defaultScreenshotData.path === "string" &&
      isAbsolute(defaultScreenshotData.path),
    "default screenshot returns an absolute path"
  )
  assert(
    String(defaultScreenshotData.path).startsWith(join(root, "screenshots")),
    "default screenshot uses the configured screenshot directory"
  )
  assert(
    typeof defaultScreenshotData.sizeBytes === "number" &&
      defaultScreenshotData.sizeBytes > 0,
    "default screenshot returns its byte size"
  )
  assertEqual(
    imageContent(defaultScreenshot.response),
    undefined,
    "default screenshot does not inline image content"
  )

  const nativeInspection = await callToolDetailed(
    clientA.client,
    "browser_inspect_point",
    {
      x: 20,
      y: 20,
      includeNonActionable: true,
      annotatedScreenshot: true,
      base64: true,
    }
  )
  assert(nativeInspection.result.ok, "native point inspection succeeds")
  const nativeInspectionData = record(nativeInspection.result.data)
  assert(
    typeof nativeInspectionData.path === "string" &&
      isAbsolute(nativeInspectionData.path),
    "native point inspection returns absolute annotation path"
  )
  assert(
    typeof nativeInspectionData.sizeBytes === "number" &&
      nativeInspectionData.sizeBytes > 0,
    "native point inspection returns annotation byte size"
  )
  assertEqual(
    nativeInspectionData.base64,
    undefined,
    "native point inspection structured data omits base64"
  )
  assert(
    imageContent(nativeInspection.response),
    "native point inspection returns image content"
  )

  const absoluteScreenshot = await callOk(
    clientA.client,
    "browser_screenshot",
    { path: join(root, "custom", "absolute-shot") }
  )
  assertEqual(
    record(absoluteScreenshot.data).path,
    join(root, "custom", "absolute-shot.png"),
    "absolute screenshot path is preserved and normalized to PNG"
  )

  const relativeScreenshot = await callOk(
    clientA.client,
    "browser_screenshot",
    { path: relative(appRoot, join(root, "relative-shot")) }
  )
  assertEqual(
    record(relativeScreenshot.data).path,
    join(root, "relative-shot.png"),
    "relative screenshot path resolves from the server working directory"
  )

  const invalidScreenshotExtension = await callTool(
    clientA.client,
    "browser_screenshot",
    { path: join(root, "invalid.jpg") }
  )
  assertEqual(
    invalidScreenshotExtension.error?.code,
    "invalid_request",
    "explicit non-PNG screenshot path is rejected"
  )

  const nativeScreenshot = await callToolDetailed(
    clientA.client,
    "browser_screenshot",
    { path: join(root, "native.png"), base64: true }
  )
  assert(nativeScreenshot.result.ok, "native MCP screenshot succeeds")
  const nativeScreenshotData = record(nativeScreenshot.result.data)
  assertEqual(
    nativeScreenshotData.base64,
    undefined,
    "MCP structured screenshot data omits duplicate base64"
  )
  const nativeImage = imageContent(nativeScreenshot.response)
  assert(nativeImage, "requested MCP screenshot returns image content")
  const pngBytes = Buffer.from(nativeImage.data, "base64")
  assertEqual(
    pngBytes.subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
    "MCP screenshot image content is a PNG"
  )

  const currentA = await callOk(clientA.client, "browser_tab", { action: "current" })
  const currentB = await callOk(clientB.client, "browser_tab", { action: "current" })
  assertEqual(currentA.tabId, openedA.tabId, "session A keeps its active tab")
  assertEqual(currentB.tabId, openedB.tabId, "session B keeps its active tab")

  const popupA = await callOk(clientA.client, "browser_expect_page", {
    event: "popup",
    trigger: { type: "click", selector: "#popup" },
  })
  assertEqual(
    record(popupA.data).openerTabId,
    openedA.tabId,
    "popup reports session A opener"
  )
  assert(
    popupA.tabId && popupA.tabId !== openedA.tabId,
    "popup returns a distinct tab id"
  )
  const popupCurrentA = await callOk(clientA.client, "browser_tab", { action: "current" })
  const popupCurrentB = await callOk(clientB.client, "browser_tab", { action: "current" })
  assertEqual(
    popupCurrentA.tabId,
    popupA.tabId,
    "popup becomes session A active tab"
  )
  assertEqual(
    popupCurrentB.tabId,
    openedB.tabId,
    "popup does not change session B active tab"
  )
  await callOk(clientA.client, "browser_tab", { action: "select", tabId: openedA.tabId })

  await callOk(clientB.client, "browser_tab", {
    action: "select",
    tabId: openedA.tabId,
  })
  const selectedByB = await callOk(clientB.client, "browser_tab", { action: "current" })
  assertEqual(
    selectedByB.tabId,
    openedA.tabId,
    "intentional cross-session tab selection remains available"
  )

  await callOk(clientA.client, "browser_element_action", {
    action: "click",
    selector: "#integration-dialog",
  })
  const dialogBlockedWait = callTool(clientA.client, "browser_console", {
    action: "wait",
    filter: "integration-dialog-never-matches",
    timeoutMs: 750,
  })
  await delay(50)
  const dialogHandleStartedAt = Date.now()
  await callOk(clientA.client, "browser_dialog", {
    action: "handle",
    accept: true,
  })
  assert(
    Date.now() - dialogHandleStartedAt < 500,
    "same-session dialog handle bypasses an occupied tab/session lock"
  )
  const dialogWaitResult = await dialogBlockedWait
  assertEqual(
    dialogWaitResult.error?.code,
    "operation_failed",
    "dialog lock fixture wait times out normally after dialog handling"
  )

  const lockFreeDiagnosticWait = callTool(
    clientA.client,
    "browser_console",
    {
      action: "wait",
      filter: "integration-lock-free-never-matches",
      timeoutMs: 750,
    }
  )
  await delay(50)
  const lockFreeCallsStartedAt = Date.now()
  await Promise.all([
    callOk(clientA.client, "browser_tab", { action: "current" }),
    callOk(clientB.client, "browser_offline", {
      action: "set",
      offline: true,
    }),
  ])
  assert(
    Date.now() - lockFreeCallsStartedAt < 500,
    "diagnostic wait does not hold session, tab, or global coordination locks"
  )
  await callOk(clientB.client, "browser_offline", {
    action: "set",
    offline: false,
  })
  const lockFreeWaitResult = await lockFreeDiagnosticWait
  assertEqual(
    lockFreeWaitResult.error?.code,
    "operation_failed",
    "lock-free diagnostic wait preserves timeout failure semantics"
  )

  const sameTabStartedAt = Date.now()
  await Promise.all([
    callOk(clientA.client, "browser_element_action", { action: "wait", timeoutMs: 180 }),
    callOk(clientB.client, "browser_element_action", { action: "wait", timeoutMs: 180 }),
  ])
  assert(
    Date.now() - sameTabStartedAt >= 300,
    "operations targeting the same tab are serialized across sessions"
  )

  const rejectedCloseAll = await callTool(clientA.client, "browser_tab", {
    action: "close",
    all: true,
  })
  assertEqual(rejectedCloseAll.ok, false, "unconfirmed shared close-all rejected")
  assertEqual(
    rejectedCloseAll.error?.code,
    "invalid_request",
    "unconfirmed shared close-all error code"
  )

  const activeWait = callOk(clientA.client, "browser_element_action", { action: "wait", timeoutMs: 250 })
  await delay(30)
  const globalCloseStartedAt = Date.now()
  const closed = await callOk(clientB.client, "browser_tab", {
    action: "close",
    all: true,
    confirmed: true,
  })
  await activeWait
  assert(
    Date.now() - globalCloseStartedAt >= 180,
    "context-global close waits for active tab operations"
  )
  const affected = record(record(closed.data).affected)
  assertEqual(affected.sessionCount, 2, "confirmed close reports affected sessions")
  assert(
    typeof affected.tabCount === "number" && affected.tabCount >= 2,
    "confirmed close reports affected tabs"
  )

  await callOk(clientA.client, "browser_navigation", {
    action: "open",
    url: pathToFileURL(pageAPath).href,
  })
  await callOk(clientB.client, "browser_navigation", {
    action: "open",
    url: pathToFileURL(pageBPath).href,
  })
  const relaunched = await callOk(clientA.client, "browser_emulation", {
    action: "set",
    locale: "en-US",
    confirmed: true,
  })
  assertEqual(
    record(relaunched.data).relaunched,
    true,
    "confirmed context emulation relaunch succeeds"
  )
  const relaunchAffected = record(record(relaunched.data).affected)
  assertEqual(
    relaunchAffected.sessionCount,
    2,
    "context relaunch reports affected sessions"
  )
  assert(
    typeof relaunchAffected.tabCount === "number" &&
      relaunchAffected.tabCount >= 2,
    "context relaunch reports affected tabs"
  )

  await sendAbandonedOwnerSession()
  const statusWithAbandonedSession = await callOk(
    clientA.client,
    "browser_status"
  )
  assertEqual(
    ownerData(statusWithAbandonedSession).activeSessionCount,
    3,
    "abandoned owner session is initially tracked"
  )
  await delay(1_000)
  await callOk(clientB.client, "browser_status")
  await delay(700)
  const prunedStatus = await callOk(clientA.client, "browser_status")
  assertEqual(
    ownerData(prunedStatus).activeSessionCount,
    2,
    "stale owner session is pruned after TTL"
  )

  await closeClient(clientB)
  const releasedStatus = await waitForStatus(clientA.client, (status) =>
    ownerData(status).activeSessionCount === 1
  )
  assertEqual(
    ownerData(releasedStatus).activeSessionCount,
    1,
    "closing MCP client releases owner session"
  )

  const smallInlineRoot = join(root, "small-inline")
  const smallInlineClient = await connectClient("integration-small-inline", {
    ownerSocket: join(smallInlineRoot, "owner.sock"),
    profileDir: join(smallInlineRoot, "profile"),
    screenshotDir: join(smallInlineRoot, "screenshots"),
    downloadDir: join(smallInlineRoot, "downloads"),
    screenshotInlineMaxBytes: 1,
  })
  clients.push(smallInlineClient)
  await callOk(smallInlineClient.client, "browser_navigation", {
    action: "open",
    url: pathToFileURL(pageAPath).href,
  })
  const oversizedInlineScreenshot = await callToolDetailed(
    smallInlineClient.client,
    "browser_screenshot",
    { base64: true }
  )
  assert(oversizedInlineScreenshot.result.ok, "oversized inline screenshot succeeds")
  const oversizedInlineData = record(oversizedInlineScreenshot.result.data)
  assertEqual(
    oversizedInlineData.imageOmittedReason,
    "size_limit",
    "oversized inline screenshot reports size-limit omission"
  )
  assertEqual(
    oversizedInlineData.inlineImageLimitBytes,
    1,
    "oversized inline screenshot reports the configured limit"
  )
  assert(
    typeof oversizedInlineData.path === "string" &&
      isAbsolute(oversizedInlineData.path),
    "oversized inline screenshot still returns its saved path"
  )
  assertEqual(
    imageContent(oversizedInlineScreenshot.response),
    undefined,
    "oversized inline screenshot omits MCP image content"
  )
  await closeClient(smallInlineClient)

  const directRoot = join(root, "direct-runtime")
  const directClient = await connectClient("integration-direct-runtime", {
    profileDir: join(directRoot, "profile"),
    screenshotDir: join(directRoot, "screenshots"),
    downloadDir: join(directRoot, "downloads"),
    directRuntime: true,
  })
  clients.push(directClient)
  const directOpened = await callOk(
    directClient.client,
    "browser_navigation",
    { action: "open", url: pathToFileURL(pageAPath).href }
  )
  assert(
    typeof record(directOpened.data).clientSession === "object",
    "direct runtime results include clientSession metadata"
  )
  const directSerializationStartedAt = Date.now()
  await Promise.all([
    callOk(directClient.client, "browser_element_action", {
      action: "wait",
      timeoutMs: 180,
    }),
    callOk(directClient.client, "browser_element_action", {
      action: "wait",
      timeoutMs: 180,
    }),
  ])
  assert(
    Date.now() - directSerializationStartedAt >= 300,
    "direct runtime serializes concurrent same-tab calls"
  )
  await closeClient(directClient)

  await assertBrowserResourceProtectionBurst(pageAPath)
  await assertQueuedMcpCancellation(pageAPath)

  const idleRoot = join(root, "idle-owner")
  const idleClient = await connectClient("integration-idle-owner", {
    ownerSocket: join(idleRoot, "owner.sock"),
    profileDir: join(idleRoot, "profile"),
    screenshotDir: join(idleRoot, "screenshots"),
    downloadDir: join(idleRoot, "downloads"),
    ownerIdleMs: 1_000,
  })
  clients.push(idleClient)
  await callOk(idleClient.client, "browser_status")
  const idleOwnerSocket = join(idleRoot, "owner.sock")
  const silentOwnerConnection = createConnection(idleOwnerSocket)
  await new Promise<void>((resolveConnect, rejectConnect) => {
    silentOwnerConnection.once("connect", resolveConnect)
    silentOwnerConnection.once("error", rejectConnect)
  })
  await delay(1_300)
  const restartedStatus = await callOk(idleClient.client, "browser_status")
  silentOwnerConnection.destroy()
  assertEqual(
    ownerData(restartedStatus).activeSessionCount,
    1,
    "client retries after owner idle restart"
  )
  assertEqual(
    record(restartedStatus.data).contextLaunched,
    false,
    "restarted owner reports a fresh context"
  )
  await closeClient(idleClient)

  await callOk(clientA.client, "browser_navigation", {
    action: "open",
    url: pathToFileURL(pageAPath).href,
  })
  await terminateIsolatedChromium(join(root, "profile"))
  const externallyClosedStatus = await waitForStatus(
    clientA.client,
    (status) => record(status.data).contextLaunched === false
  )
  assertEqual(
    ownerData(externallyClosedStatus).activeSessionCount,
    1,
    "owner remains alive after Playwright Chromium closes"
  )
  const recoveredOpen = await callOk(clientA.client, "browser_navigation", {
    action: "open",
    url: pathToFileURL(pageBPath).href,
  })
  assert(recoveredOpen.tabId, "owner recovers a tab after Chromium closes")
  const recoveredScreenshot = await callOk(
    clientA.client,
    "browser_screenshot"
  )
  assert(
    typeof record(recoveredScreenshot.data).path === "string",
    "recovered owner captures a screenshot"
  )

  const controlPath = `${ownerSocket}.control.json`
  const controlBeforeSocketFault = record(
    JSON.parse(await readFile(controlPath, "utf8"))
  )
  await resetOwnerClientDuringRequest(openedA.tabId as string)
  await delay(400)
  await callOk(clientA.client, "browser_status")
  const controlAfterSocketFault = record(
    JSON.parse(await readFile(controlPath, "utf8"))
  )
  assertEqual(
    controlAfterSocketFault.token,
    controlBeforeSocketFault.token,
    "client reset during response does not crash or replace the owner"
  )
  await sendOwnerRelease("integration-socket-reset")
  const controlStat = await stat(controlPath)
  assertEqual(
    controlStat.mode & 0o777,
    0o600,
    "owner control metadata permissions"
  )
  const socketStat = await stat(ownerSocket)
  assertEqual(socketStat.mode & 0o777, 0o600, "owner socket permissions")
  const controlBefore = record(JSON.parse(await readFile(controlPath, "utf8")))
  const rejectedShutdown = await sendOwnerShutdown("invalid-token")
  assertEqual(
    record(rejectedShutdown.control).status,
    "authentication_failed",
    "owner rejects an invalid shutdown token before dispatch"
  )
  const authenticatedStatus = await callOk(clientA.client, "browser_status")
  const authenticatedSessionId = String(
    record(record(authenticatedStatus.data).clientSession).id
  )
  for (const request of [
    {
      id: randomUUID(),
      kind: "call",
      sessionId: "unauthenticated-call",
      token: "invalid-token",
      tool: "browser_status",
      input: {},
    },
    {
      id: randomUUID(),
      kind: "release",
      sessionId: authenticatedSessionId,
      token: "invalid-token",
    },
  ]) {
    const response = await sendRawOwnerRequest(request)
    assertEqual(
      record(response.control).status,
      "authentication_failed",
      `${request.kind} rejects an invalid owner token`
    )
  }
  const missingTokenResponse = await sendRawOwnerRequest({
    id: randomUUID(),
    kind: "call",
    sessionId: "missing-token-call",
    tool: "browser_status",
    input: {},
  })
  assert(
    typeof missingTokenResponse.error === "object",
    "owner rejects a call with no token"
  )
  const statusAfterRejectedAuth = await callOk(clientA.client, "browser_status")
  assertEqual(
    ownerData(statusAfterRejectedAuth).activeSessionCount,
    ownerData(authenticatedStatus).activeSessionCount,
    "unauthenticated call/release does not change owner sessions"
  )
  await assertOversizedOwnerFrameRejected()
  await callOk(clientA.client, "browser_status")
  const ownerActiveWait = callTool(clientA.client, "browser_element_action", {
    action: "wait",
    selector: "#integration-owner-rollover-never-matches",
    timeoutMs: 500,
  })
  await delay(50)
  const busyShutdown = await sendOwnerShutdown(String(controlBefore.token))
  assertEqual(
    record(busyShutdown.control).status,
    "busy",
    "owner refuses shutdown while another request is active"
  )
  await ownerActiveWait
  const acceptedShutdown = await sendOwnerShutdown(String(controlBefore.token))
  assertEqual(
    record(acceptedShutdown.control).status,
    "accepted",
    "idle owner accepts authenticated shutdown"
  )
  const statusAfterOwnerRollover = await callOk(clientA.client, "browser_status")
  assertEqual(
    record(statusAfterOwnerRollover.data).contextLaunched,
    false,
    "next call starts a fresh owner after authenticated shutdown"
  )
  const controlAfter = record(JSON.parse(await readFile(controlPath, "utf8")))
  assert(
    controlAfter.token !== controlBefore.token,
    "replacement owner publishes a new control identity"
  )

  console.log(
    JSON.stringify(
      {
        ok: true,
        staleSocketRecovered: true,
        concurrentOwnerStartupCovered: true,
        sessionRoutingCovered: true,
        collaborativeTabSelectionCovered: true,
        sameTabSerializationCovered: true,
        sharedCloseConfirmationCovered: true,
        globalOperationCoordinationCovered: true,
        relaunchImpactCovered: true,
        sessionReleaseCovered: true,
        staleSessionTtlCovered: true,
        ownerRestartCovered: true,
        replacedWorkingDirectoryCovered: true,
        ownerAuthenticationCovered: true,
        ownerConnectionBoundsCovered: true,
        ownerSocketFaultContained: true,
        unknownResultReplayPrevented: true,
        dialogHandleEscapeCovered: true,
        diagnosticWaitEscapeCovered: true,
        directRuntimeRoutingCovered: true,
        numericConfigValidationCovered: true,
        p2OwnerBoundaryCovered: true,
        p2RuntimeLifecycleCovered: true,
        p2StrictSchemaCovered: true,
        p2CliConflictCovered: true,
        p2PermissionBoundCovered: true,
        closedContextRecoveryCovered: true,
        authenticatedOwnerRolloverCovered: true,
        unifiedRegistryValidationCovered: true,
        mcpToolProfilesCovered: true,
        mcpCapabilitiesCovered: true,
        namespaceIsolationCovered: true,
        namespaceOwnerRolloverCovered: true,
        assetInventoryCovered: true,
        performanceDiagnosticsCovered: true,
        structuredMcpResultsCovered: true,
        nativeScreenshotContentCovered: true,
        screenshotInlineLimitCovered: true,
        completeDiagnosticUrlsCovered: true,
        browserCallSchedulerCovered: true,
        browserResourceProtectionBurstCovered: true,
        queuedMcpCancellationCovered: true,
        cookieInjectionCovered: true,
        targetConfigurationCovered: true,
        targetSelectionCovered: true,
        targetIsolationCovered: true,
        attachLifecycleCovered: true,
        attachNoCloseTeardownCovered: true,
      },
      null,
      2
    )
  )
} catch (error) {
  if (stderr.length > 0) {
    process.stderr.write(`${stderr.join("")}\n`)
  }
  throw error
} finally {
  await Promise.all(clients.map((client) => closeClient(client)))
  await delay(1_200)
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}

type ConnectedClient = {
  client: Client
  closed: boolean
}

type ConnectedClientOptions = {
  cwd?: string
  ownerSocket?: string
  profileDir?: string
  screenshotDir?: string
  downloadDir?: string
  screenshotInlineMaxBytes?: number
  ownerIdleMs?: number
  lockTimeoutMs?: number
  mcpTools?: string
  namespace?: string
  directRuntime?: boolean
  maxConcurrentCalls?: number
  maxQueuedCalls?: number
  maxDiagnosticWaits?: number
  cookieAllowedOrigins?: string
  cookieMaxTtlSeconds?: number
  targetsFile?: string
}

type ChromeFixture = {
  child: ChildProcess
  pid: number
  port: number
  endpoint: string
  browserWebSocketUrl: string
  profileDir: string
}

async function assertBrowserTargetConfigCases() {
  const configRoot = await mkdtemp(join(root, "target-config-"))
  const activeProfile = await mkdtemp(join(configRoot, "active-profile-"))
  const activePortFile = join(activeProfile, "DevToolsActivePort")
  await writeFile(activePortFile, "19399\n/devtools/browser/config-fixture\n")

  const parsed = parseBrowserTargetsFile(
    {
      version: 1,
      defaultTarget: "power",
      targets: [
        {
          id: "work",
          label: "Work Chrome",
          browser: "chrome",
          connection: {
            kind: "endpoint",
            endpoint: "http://127.0.0.1:9222",
          },
        },
        {
          id: "personal",
          label: "Personal Chrome",
            browser: "chrome",
            connection: {
              kind: "active_port",
              userDataDir: relative(configRoot, activeProfile),
            },
        },
      ],
    },
    configRoot
  )
  assertEqual(parsed.defaultTargetId, "power", "built-in power is a valid explicit default")
  assertEqual(parsed.targets.length, 2, "target config decodes multiple targets")
  assertEqual(
    parsed.targets[1]?.connection.kind,
    "active_port",
    "active-port connection is decoded"
  )
  assertEqual(
    resolveBrowserTargetEndpoint(parsed.targets[1] as (typeof parsed.targets)[number]),
    "ws://127.0.0.1:19399/devtools/browser/config-fixture",
    "active-port metadata resolves to the loopback browser websocket endpoint"
  )
  const malformedActivePort = join(configRoot, "malformed-active-port")
  await writeFile(malformedActivePort, "19399\n/devtools/browser/config-fixture\nextra\n")
  assertThrows(
    () =>
      resolveBrowserTargetEndpoint({
        id: "active",
        label: "Active",
        browser: "chrome",
        connection: { kind: "active_port", activePortFile: malformedActivePort },
      }),
    "active-port metadata rejects unexpected extra lines"
  )

  const targetFile = join(configRoot, "targets.json")
  await writeFile(
    targetFile,
    JSON.stringify({
      version: 1,
      defaultTarget: "work",
      targets: [
        {
          id: "work",
          label: "Work Chrome",
          browser: "chrome",
          connection: {
            kind: "endpoint",
            endpoint: "http://127.0.0.1:9222",
          },
        },
      ],
    })
  )
  const loaded = loadBrowserTargetsFile(targetFile)
  assertEqual(loaded.filePath, resolve(targetFile), "target file path is normalized")
  assert(
    typeof loaded.fingerprint === "string" && loaded.fingerprint.length > 0,
    "target file receives a stable configuration fingerprint"
  )
  const config = loadConfig({
    cwd: configRoot,
    env: { CHROME_POWER_TARGETS_FILE: "targets.json" },
  })
  assertEqual(config.targetsFile, resolve(targetFile), "config resolves a relative target file")
  assertEqual(
    config.browserTargets?.defaultTargetId,
    "work",
    "runtime config retains the configured default target"
  )
  const legacyConfig = loadConfig({ cwd: configRoot, env: {} })
  assertEqual(
    legacyConfig.browserTargets,
    undefined,
    "omitting the target file preserves the legacy launch configuration"
  )
  assert(
    !Object.hasOwn(legacyConfig, "targetsFile") &&
      !Object.hasOwn(legacyConfig, "targetConfigFingerprint"),
    "omitting the target file preserves the legacy config object shape"
  )

  const invalidCases: Array<[unknown, string]> = [
    [
      {
        version: 1,
        targets: [
          {
            id: "work",
            label: "Work",
            browser: "chrome",
            connection: {
              kind: "endpoint",
              endpoint: "http://192.0.2.1:9222",
            },
          },
        ],
      },
      "non-loopback endpoint is rejected",
    ],
    [
      {
        version: 1,
        targets: [
          {
            id: "Work",
            label: "Work",
            browser: "chrome",
            connection: {
              kind: "endpoint",
              endpoint: "http://127.0.0.1:9222",
            },
          },
        ],
      },
      "unsafe target id is rejected",
    ],
    [
      {
        version: 1,
        targets: [
          {
            id: "work",
            label: "Work",
            browser: "chrome",
            connection: {
              kind: "endpoint",
              endpoint: "http://127.0.0.1:9222",
            },
          },
          {
            id: "work",
            label: "Duplicate",
            browser: "chrome",
            connection: {
              kind: "endpoint",
              endpoint: "http://127.0.0.1:9223",
            },
          },
        ],
      },
      "duplicate target id is rejected",
    ],
    [
      {
        version: 1,
        defaultTarget: "missing",
        targets: [
          {
            id: "work",
            label: "Work",
            browser: "chrome",
            connection: {
              kind: "endpoint",
              endpoint: "http://127.0.0.1:9222",
            },
          },
        ],
      },
      "unknown default target is rejected",
    ],
    [
      {
        version: 1,
        targets: [
          {
            id: "work",
            label: "Work",
            browser: "chrome",
            connection: { kind: "active_port" },
          },
        ],
      },
      "active-port connection without metadata is rejected",
    ],
    [
      {
        version: 1,
        targets: [
          {
            id: "work",
            label: "Work",
            browser: "chrome",
            connection: {
              kind: "endpoint",
              endpoint: "http://127.0.0.1:9222",
              extra: true,
            },
          },
        ],
      },
      "unknown target connection fields are rejected",
    ],
  ]
  for (const [value, message] of invalidCases) {
    assertThrows(() => parseBrowserTargetsFile(value, configRoot), message)
  }

  await writeFile(join(configRoot, "bad.json"), "{not-json")
  assertThrows(
    () => loadBrowserTargetsFile(join(configRoot, "bad.json")),
    "malformed target JSON is rejected"
  )
}

async function assertAttachedTargetCases(pageAPath: string, pageBPath: string) {
  const fixtureRoot = await mkdtemp(join(root, "attach-fixture-"))
  const workProfile = await mkdtemp(join(fixtureRoot, "work-profile-"))
  const personalProfile = await mkdtemp(join(fixtureRoot, "personal-profile-"))
  const workPagePath = join(fixtureRoot, "work.html")
  const personalPagePath = join(fixtureRoot, "personal.html")
  await writeFile(
    workPagePath,
    `<!doctype html><title>Work Chrome</title><p id="identity">work-login-state</p><input id="work-input"><button id="work-button" onclick="document.querySelector('#identity').textContent='work-clicked'">Work action</button><a id="work-popup" target="_blank" href="${pathToFileURL(pageBPath).href}">Popup</a><output id="viewport-metrics"></output><script>const reportViewport = () => document.querySelector('#viewport-metrics').textContent = JSON.stringify({width:innerWidth,height:innerHeight}); addEventListener('resize', reportViewport); reportViewport();</script>`
  )
  await writeFile(
    personalPagePath,
    `<!doctype html><title>Personal Chrome</title><p id="identity">personal-login-state</p><input id="personal-input">`
  )

  let work: ChromeFixture | undefined
  let personal: ChromeFixture | undefined
  let clientA: ConnectedClient | undefined
  let clientB: ConnectedClient | undefined
  try {
    work = await launchChromeFixture(workProfile, workPagePath)
    personal = await launchChromeFixture(personalProfile, personalPagePath)
    const personalActivePortFile = join(personalProfile, "DevToolsActivePort")
    // Headless Chrome versions differ in whether they publish this file when
    // an explicit port is supplied. Writing the narrow, documented metadata
    // here exercises the active_port discovery path without scanning a profile.
    await writeFile(
      personalActivePortFile,
      `${personal.port}\n${new URL(personal.browserWebSocketUrl).pathname}\n`
    )

    const targetsFile = join(fixtureRoot, "targets.json")
    await writeFile(
      targetsFile,
      JSON.stringify({
        version: 1,
        targets: [
          {
            id: "work",
            label: "Work Chrome",
            browser: "chrome",
            connection: { kind: "endpoint", endpoint: work.endpoint },
          },
          {
            id: "personal",
            label: "Personal Chrome",
            browser: "chrome",
            connection: { kind: "active_port", userDataDir: personalProfile },
          },
        ],
      })
    )

    const runtimeRoot = join(fixtureRoot, "runtime")
    clientA = await connectClient("integration-target-a", {
      ownerSocket: join(root, "attach-owner.sock"),
      profileDir: join(runtimeRoot, "profile"),
      screenshotDir: join(runtimeRoot, "screenshots"),
      downloadDir: join(runtimeRoot, "downloads"),
      targetsFile,
      ownerIdleMs: 600_000,
    })
    clientB = await connectClient("integration-target-b", {
      ownerSocket: join(root, "attach-owner.sock"),
      profileDir: join(runtimeRoot, "profile"),
      screenshotDir: join(runtimeRoot, "screenshots"),
      downloadDir: join(runtimeRoot, "downloads"),
      targetsFile,
      ownerIdleMs: 600_000,
    })
    clients.push(clientA, clientB)

    const initialList = await callOk(clientA.client, "browser_target", {
      action: "list",
    })
    const initialListData = record(initialList.data)
    const initialTargets = initialListData.targets
    assert(Array.isArray(initialTargets), "target list returns target summaries")
    assertEqual(initialTargets.length, 3, "target list includes power and both configured targets")
    assertEqual(initialListData.selectedTargetId, undefined, "no implicit target selection is made")
    const initialListText = JSON.stringify(initialList)
    assert(!initialListText.includes(work.endpoint), "target list does not expose CDP endpoints")
    assert(!initialListText.includes(work.profileDir), "target list does not expose Chrome profile paths")
    assert(
      initialTargets.every((entry) => {
        const target = record(entry)
        return target.id === "power" || target.state === "available"
      }),
      "configured targets start disconnected without probing or attaching"
    )

    const overview = await callOk(clientA.client, "browser_status")
    const overviewData = record(overview.data)
    assertEqual(overviewData.contextLaunched, false, "target overview does not launch power")
    assertEqual(overviewData.selectedTargetId, undefined, "overview reports an empty selection")
    const missingSelection = await callTool(clientA.client, "browser_tab", {
      action: "list",
    })
    assertEqual(missingSelection.error?.code, "target_not_selected", "ordinary attach calls require selection")

    const unconfirmedConnect = await callTool(clientA.client, "browser_target", {
      action: "connect",
      targetId: "work",
    })
    assertEqual(unconfirmedConnect.error?.code, "invalid_request", "target connect requires confirmation")

    await callOk(clientA.client, "browser_target", {
      action: "select",
      targetId: "work",
    })
    const selectedButDisconnected = await callTool(clientA.client, "browser_tab", {
      action: "list",
    })
    assertEqual(
      selectedButDisconnected.error?.code,
      "target_unavailable",
      "select does not connect a target implicitly"
    )

    const [connectedWork] = await Promise.all([
      callOk(clientA.client, "browser_target", {
        action: "connect",
        targetId: "work",
        confirmed: true,
      }),
      callOk(clientB.client, "browser_target", {
        action: "connect",
        targetId: "work",
        confirmed: true,
      }),
    ])
    assertEqual(connectedWork.targetId, "work", "connect result identifies its target")
    assertEqual(record(record(connectedWork.data).target).state, "connected", "work target connects explicitly")
    const workTabs = await callOk(clientA.client, "browser_tab", { action: "list" })
    const workTabRows = record(workTabs.data).tabs
    assert(Array.isArray(workTabRows) && workTabRows.length >= 1, "attach discovers tabs opened before connection")
    const workTab = record(workTabRows[0])
    assert(String(workTab.id).startsWith("work_g1_"), "attached tab ids include target and generation")
    assertEqual(workTab.title, "Work Chrome", "work target exposes its existing page")
    const unboundSnapshot = await callTool(clientA.client, "browser_snapshot")
    assertEqual(
      unboundSnapshot.error?.code,
      "tab_not_found",
      "attached tab-scoped calls require an explicit session tab binding"
    )
    const unboundNavigation = await callTool(clientA.client, "browser_navigation", {
      action: "open",
      url: pathToFileURL(pageAPath).href,
    })
    assertEqual(
      unboundNavigation.error?.code,
      "tab_not_found",
      "attached navigation does not use the runtime-global tab implicitly"
    )

    const personalSelect = await callOk(clientB.client, "browser_target", {
      action: "select",
      targetId: "personal",
    })
    assertEqual(personalSelect.targetId, "personal", "second session selects personal target")
    const personalBeforeConnect = await callTool(clientB.client, "browser_tab", {
      action: "list",
    })
    assertEqual(personalBeforeConnect.error?.code, "target_unavailable", "personal selection remains connect-only")
    await callOk(clientB.client, "browser_target", {
      action: "connect",
      targetId: "personal",
      confirmed: true,
    })
    const personalTabs = await callOk(clientB.client, "browser_tab", { action: "list" })
    const personalTabRows = record(personalTabs.data).tabs
    assert(Array.isArray(personalTabRows) && personalTabRows.length >= 1, "active-port target discovers its existing page")
    const personalTab = record(personalTabRows[0])
    assert(String(personalTab.id).startsWith("personal_g1_"), "active-port tab ids identify the target")
    assertEqual(personalTab.title, "Personal Chrome", "personal target remains isolated")
    await callOk(clientB.client, "browser_tab", {
      action: "select",
      tabId: String(personalTab.id),
    })

    const connectedList = await callOk(clientA.client, "browser_target", { action: "list" })
    const connectedRows = record(connectedList.data).targets
    assert(
      Array.isArray(connectedRows) &&
        connectedRows.some((entry) => record(entry).id === "work" && record(entry).state === "connected") &&
        connectedRows.some((entry) => record(entry).id === "personal" && record(entry).state === "connected"),
      "multiple targets remain connected concurrently"
    )

    await callOk(clientA.client, "browser_tab", {
      action: "select",
      tabId: String(workTab.id),
    })
    const workSnapshot = await callOk(clientA.client, "browser_snapshot")
    assert(String(record(workSnapshot.data).text).includes("work-login-state"), "snapshot reads attached login state")
    const attachedViewport = record((await callOk(clientA.client, "browser_viewport", { action: "get" })).data)
    const measuredViewport = await callOk(clientA.client, "browser_element_query", {
      action: "text",
      locator: { selector: "#viewport-metrics" },
    })
    const nativeSize = record(JSON.parse(String(record(measuredViewport.data).text)))
    assertEqual(attachedViewport.mode, "window", "attached viewport reports native window mode")
    assertEqual(attachedViewport.width, nativeSize.width, "attached viewport uses the actual width")
    assertEqual(attachedViewport.height, nativeSize.height, "attached viewport uses the actual height")
    await callOk(clientA.client, "browser_mouse", { action: "move", x: 20, y: 20 })
    const attachedBox = record((await callOk(clientA.client, "browser_element_visual", {
      action: "box", selector: "#work-button",
    })).data)
    assertEqual(attachedBox.inViewport, true, "native attached element visibility is measured")
    const attachedClip = await callOk(clientA.client, "browser_screenshot", {
      clip: { x: 0, y: 0, width: 40, height: 30 },
    })
    assertEqual(record(attachedClip.data).scale, "css", "native attached clips use CSS scale")
    await callOk(clientA.client, "browser_element_action", {
      action: "type",
      selector: "#work-input",
      text: "typed-work",
    })
    await callOk(clientA.client, "browser_element_action", {
      action: "click",
      selector: "#work-button",
    })
    const workAfterAction = await callOk(clientA.client, "browser_snapshot")
    assert(String(record(workAfterAction.data).text).includes("work-clicked"), "attached click/type actions operate on the selected tab")
    const workScreenshot = await callOk(clientA.client, "browser_screenshot")
    assertEqual(record(workScreenshot.data).scale, "css", "MCP preserves screenshot scale metadata")
    assert(
      String(record(workScreenshot.data).path).startsWith(join(runtimeRoot, "screenshots", "targets", "work")),
      "attached screenshots use a target-specific artifact directory"
    )

    const popup = await callOk(clientA.client, "browser_expect_page", {
      targetId: "work",
      tabId: String(workTab.id),
      event: "popup",
      trigger: { type: "click", selector: "#work-popup" },
    })
    assert(String(popup.tabId).startsWith("work_g1_"), "attached popup belongs to its target generation")
    assertEqual(record(popup.data).openerTabId, workTab.id, "attached popup reports its opener")

    const explicitPersonalReload = await callOk(clientA.client, "browser_navigation", {
      targetId: "personal",
      tabId: String(personalTab.id),
      action: "reload",
    })
    assertEqual(explicitPersonalReload.targetId, "personal", "explicit target override is reflected in results")
    const defaultWorkCurrent = await callOk(clientA.client, "browser_tab", { action: "current" })
    assertEqual(defaultWorkCurrent.targetId, "work", "explicit override does not change the session selection")
    assertEqual(defaultWorkCurrent.tabId, popup.tabId, "session A retains its work target binding")
    const defaultPersonalCurrent = await callOk(clientB.client, "browser_tab", { action: "current" })
    assertEqual(defaultPersonalCurrent.targetId, "personal", "session B retains its independent target selection")
    assertEqual(defaultPersonalCurrent.tabId, personalTab.id, "session B retains its personal tab binding")

    const unsupportedDevice = await callTool(clientA.client, "browser_device", {
      targetId: "work",
      action: "set",
      preset: "pixel-5",
    })
    assertEqual(unsupportedDevice.error?.code, "unsupported_in_attach_mode", "attach device mutation is explicit unsupported")
    const unsupportedEmulation = await callTool(clientA.client, "browser_emulation", {
      targetId: "work",
      action: "set",
      locale: "en-US",
    })
    assertEqual(unsupportedEmulation.error?.code, "unsupported_in_attach_mode", "attach emulation mutation is explicit unsupported")

    const unconfirmedCloseAll = await callTool(clientA.client, "browser_tab", {
      targetId: "work",
      action: "close",
      all: true,
    })
    assertEqual(unconfirmedCloseAll.error?.code, "invalid_request", "attached close-all requires confirmation")

    const oldWorkTabId = String(workTab.id)
    const disconnected = await callOk(clientA.client, "browser_target", {
      action: "disconnect",
      targetId: "work",
      confirmed: true,
    })
    assertEqual(record(record(disconnected.data).target).state, "disconnected", "target disconnect reports disconnected")
    assert(await cdpEndpointAlive(work.endpoint), "disconnect leaves the user's work Chrome alive")
    const unavailableAfterDisconnect = await callTool(clientA.client, "browser_tab", {
      action: "list",
    })
    assertEqual(unavailableAfterDisconnect.error?.code, "target_unavailable", "disconnected target does not fall back")

    await callOk(clientA.client, "browser_target", {
      action: "connect",
      targetId: "work",
      confirmed: true,
    })
    const reconnectedWorkTabs = await callOk(clientA.client, "browser_tab", { action: "list" })
    const reconnectedRows = record(reconnectedWorkTabs.data).tabs
    assert(Array.isArray(reconnectedRows) && reconnectedRows.length >= 1, "reconnect rediscovers the still-open remote tab")
    const reconnectedWorkTabId = String(record(reconnectedRows[0]).id)
    assert(reconnectedWorkTabId.startsWith("work_g2_"), "reconnect advances the tab generation")
    assert(reconnectedWorkTabId !== oldWorkTabId, "reconnect never reuses stale tab ids")
    const staleSelection = await callTool(clientA.client, "browser_tab", {
      action: "select",
      tabId: oldWorkTabId,
    })
    assertEqual(staleSelection.error?.code, "tab_not_found", "stale tab ids are rejected after reconnect")
    await callOk(clientA.client, "browser_tab", {
      action: "select",
      tabId: reconnectedWorkTabId,
    })
    const remoteWorkTabsAfterReconnect = await cdpJsonList(work.endpoint)
    assert(
      remoteWorkTabsAfterReconnect.some((entry) => String(entry.title) === "Work Chrome"),
      "reconnect does not replay or replace the remote page"
    )

    const confirmedCloseAll = await callOk(clientA.client, "browser_tab", {
      action: "close",
      all: true,
      confirmed: true,
    })
    assert(Array.isArray(record(confirmedCloseAll.data).closed), "confirmed attach close-all closes pages individually")
    assert(await cdpEndpointAlive(work.endpoint), "attach close-all leaves the remote Chrome endpoint alive")
    const personalClosed = await callOk(clientB.client, "browser_tab", {
      action: "close",
      tabId: String(personalTab.id),
    })
    assert(personalClosed.targetId === "personal", "closing a personal tab is target-scoped")
    const workAfterPersonalClose = await callOk(clientA.client, "browser_tab", { action: "list" })
    const remainingWorkTabs = record(workAfterPersonalClose.data).tabs
    assert(Array.isArray(remainingWorkTabs), "work tab listing remains well-formed after close-all")
    assertEqual(remainingWorkTabs.length, 0, "work has no active page after its own close-all")

    await callOk(clientA.client, "browser_target", {
      action: "disconnect",
      targetId: "personal",
      confirmed: true,
    })
    assert(await cdpEndpointAlive(personal.endpoint), "owner disconnect leaves the active-port Chrome alive")
  } finally {
    if (clientA) await closeClient(clientA)
    if (clientB) await closeClient(clientB)
    await delay(1_200)
    if (work) await stopChromeFixture(work)
    if (personal) await stopChromeFixture(personal)
  }
}

async function launchChromeFixture(
  profileDir: string,
  pagePath: string
): Promise<ChromeFixture> {
  const port = await reserveLoopbackPort()
  const endpoint = `http://127.0.0.1:${port}`
  const child = spawn(
    chromium.executablePath(),
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      pathToFileURL(pagePath).href,
    ],
    { stdio: "ignore" }
  )
  const pid = child.pid
  assert(Number.isInteger(pid) && (pid as number) > 0, "temporary Chrome fixture exposes an exact child pid")
  const fixture = {
    child,
    pid: pid as number,
    port,
    endpoint,
    browserWebSocketUrl: "",
    profileDir,
  }
  try {
    const version = await waitForCdpEndpoint(endpoint)
    const browserWebSocketUrl = version.webSocketDebuggerUrl
    if (typeof browserWebSocketUrl !== "string") {
      throw new Error("Temporary Chrome did not publish a browser WebSocket endpoint.")
    }
    await waitForCdpTab(
      endpoint,
      (entry) => String(entry.url ?? "").startsWith(pathToFileURL(pagePath).href)
    )
    return { ...fixture, browserWebSocketUrl }
  } catch (error) {
    await stopChromeFixture(fixture)
    throw error
  }
}

async function stopChromeFixture(fixture: ChromeFixture) {
  if (fixture.child.exitCode != null || fixture.child.signalCode != null) return
  try {
    fixture.child.kill("SIGTERM")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
  await new Promise<void>((resolvePromise) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolvePromise()
    }
    fixture.child.once("exit", finish)
    setTimeout(() => {
      if (settled) return
      try {
        fixture.child.kill("SIGKILL")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          // The fixture is already on its bounded cleanup path; resolving is
          // safer than surfacing an uncaught timer exception during teardown.
        }
      }
      finish()
    }, 2_000).unref()
  })
}

async function reserveLoopbackPort() {
  const server = createServer()
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolvePromise()
    })
  })
  const address = server.address()
  if (address == null || typeof address === "string") {
    await closeNetServer(server)
    throw new Error("Temporary Chrome fixture did not receive a loopback port.")
  }
  const port = address.port
  await closeNetServer(server)
  return port
}

async function waitForCdpEndpoint(endpoint: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`)
      if (response.ok) return (await response.json()) as Record<string, unknown>
      lastError = new Error(`CDP endpoint returned ${response.status}.`)
    } catch (error) {
      lastError = error
    }
    await delay(50)
  }
  throw new Error(`Timed out waiting for temporary Chrome CDP endpoint: ${errorMessage(lastError)}`)
}

async function waitForCdpTab(
  endpoint: string,
  predicate: (entry: Record<string, unknown>) => boolean,
  timeoutMs = 10_000
) {
  const deadline = Date.now() + timeoutMs
  let latest: Array<Record<string, unknown>> = []
  while (Date.now() < deadline) {
    try {
      latest = await cdpJsonList(endpoint)
      if (latest.some(predicate)) return
    } catch {
      // The browser may publish its CDP HTTP server before /json/list is
      // ready; keep polling within the bounded fixture timeout.
    }
    await delay(50)
  }
  throw new Error(`Timed out waiting for temporary Chrome tab: ${JSON.stringify(latest)}`)
}

async function cdpEndpointAlive(endpoint: string) {
  try {
    const response = await fetch(`${endpoint}/json/version`)
    return response.ok
  } catch {
    return false
  }
}

async function cdpJsonList(endpoint: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${endpoint}/json/list`)
  if (!response.ok) throw new Error("Temporary Chrome did not return its tab list.")
  const value = (await response.json()) as unknown
  if (!Array.isArray(value)) throw new Error("Temporary Chrome returned an invalid tab list.")
  return value.filter(isRecord)
}

function closeNetServer(server: ReturnType<typeof createServer>) {
  return new Promise<void>((resolvePromise) => {
    if (!server.listening) {
      resolvePromise()
      return
    }
    server.close(() => resolvePromise())
  })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function assertCookieInjectionCases() {
  const server = createHttpServer((request, response) => {
    const cookie = request.headers.cookie ?? "none"
    const escaped = cookie
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
    response.writeHead(200, { "content-type": "text/html" })
    response.end(`<title>${escaped}</title><p id="cookies">${escaped}</p>`)
  })
  const secondServer = createHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" })
    response.end("<title>Cookie second port</title><p>second</p>")
  })
  await listenHttpServer(server)
  await listenHttpServer(secondServer)
  const firstPort = addressPort(server)
  const secondPort = addressPort(secondServer)
  const connected = await connectClient("integration-cookie", {
    ownerSocket: join(root, "cookie-owner.sock"),
    profileDir: join(root, "cookie-profile"),
    screenshotDir: join(root, "cookie-screenshots"),
    downloadDir: join(root, "cookie-downloads"),
    cookieMaxTtlSeconds: 60,
  })
  clients.push(connected)

  try {
    const noTab = await callTool(connected.client, "browser_cookie", {
      action: "inject",
      cookieHeader: "auth=must-not-appear",
    })
    assertEqual(
      noTab.error?.code,
      "tab_not_found",
      "Cookie injection requires an existing target tab"
    )
    assert(
      !JSON.stringify(noTab).includes("must-not-appear"),
      "missing-target Cookie errors do not echo Cookie values"
    )
    const noTabStatus = await callOk(connected.client, "browser_status")
    const noTabStatusConfig = record(record(noTabStatus.data).config)
    const noTabCookieConfig = record(noTabStatusConfig.cookie)
    assertEqual(
      record(noTabStatus.data).contextLaunched,
      false,
      "missing-target Cookie calls do not launch a browser context"
    )
    assertEqual(
      noTabCookieConfig.allowedOriginCount,
      0,
      "browser status reports only the Cookie allowlist count"
    )
    assertEqual(
      noTabCookieConfig.maxTtlSeconds,
      60,
      "browser status reports the configured Cookie TTL maximum"
    )

    const targetUrl = `http://127.0.0.1:${firstPort}/debug?token=hidden`
    const opened = await callOk(connected.client, "browser_navigation", {
      action: "open",
      url: targetUrl,
      newTab: true,
    })
    assert(opened.tabId, "Cookie fixture opens an existing target tab")

    const firstInjection = await callOk(connected.client, "browser_cookie", {
      action: "inject",
      url: targetUrl,
      tabId: opened.tabId,
      cookieHeader: "Cookie: auth=alpha-secret=one; theme=dark",
      mode: "replace_target",
    })
    const firstData = record(firstInjection.data)
    assertEqual(firstData.inputFormat, "cookie_header", "header Cookie input is reported")
    assertEqual(firstData.inputCount, 2, "header Cookie count is reported")
    assertEqual(firstData.appliedCount, 2, "applied Cookie count is reported")
    assertEqual(firstInjection.url, `http://127.0.0.1:${firstPort}`, "Cookie result URL is origin-only")
    assert(
      !JSON.stringify(firstInjection).includes("alpha-secret") &&
        !JSON.stringify(firstInjection).includes("token=hidden"),
      "Cookie success results redact values, page titles, and URL query data"
    )
    const firstSnapshot = await callOk(connected.client, "browser_snapshot", {
      tabId: opened.tabId,
      maxTextLength: 2_000,
    })
    const firstText = String(record(firstSnapshot.data).text)
    assert(
      firstText.includes("auth=alpha-secret=one") && firstText.includes("theme=dark"),
      "header Cookie injection reaches the reloaded page"
    )

    await callOk(connected.client, "browser_cookie", {
      action: "inject",
      tabId: opened.tabId,
      cookies: [{ name: "secondary", value: "beta", path: "/" }],
      mode: "merge",
    })
    const mergedSnapshot = await callOk(connected.client, "browser_snapshot", {
      tabId: opened.tabId,
      maxTextLength: 2_000,
    })
    const mergedText = String(record(mergedSnapshot.data).text)
    assert(
      mergedText.includes("auth=alpha-secret=one") && mergedText.includes("secondary=beta"),
      "merge mode preserves unrelated target Cookies"
    )

    const replacement = await callOk(connected.client, "browser_cookie", {
      action: "inject",
      tabId: opened.tabId,
      cookieHeader: "auth=retry",
      mode: "replace_target",
    })
    assertEqual(
      record(replacement.data).clearedTarget,
      true,
      "replace_target reports target clearing"
    )
    const replacementSnapshot = await callOk(connected.client, "browser_snapshot", {
      tabId: opened.tabId,
      maxTextLength: 2_000,
    })
    const replacementText = String(record(replacementSnapshot.data).text)
    assert(
      replacementText.includes("auth=retry") &&
        !replacementText.includes("alpha-secret") &&
        !replacementText.includes("secondary=beta"),
      "replace_target removes the previous target Cookie set"
    )

    const invalidBatch = await callTool(connected.client, "browser_cookie", {
      action: "inject",
      tabId: opened.tabId,
      cookies: [
        { name: "new-cookie", value: "should-not-appear" },
        { name: "bad-domain", value: "x", domain: "outside.example" },
      ],
      mode: "replace_target",
      reload: false,
    })
    assertEqual(
      invalidBatch.error?.code,
      "invalid_request",
      "invalid Cookie batches are rejected before mutation"
    )
    assert(
      !JSON.stringify(invalidBatch).includes("should-not-appear"),
      "invalid Cookie errors do not echo values"
    )
    const atomicSnapshot = await callOk(connected.client, "browser_snapshot", {
      tabId: opened.tabId,
      maxTextLength: 2_000,
    })
    assert(
      String(record(atomicSnapshot.data).text).includes("auth=retry"),
      "invalid Cookie batches leave the previous target unchanged"
    )

    const noReload = await callOk(connected.client, "browser_cookie", {
      action: "inject",
      tabId: opened.tabId,
      cookieHeader: "live=without-reload",
      reload: false,
    })
    assertEqual(record(noReload.data).reloaded, false, "reload=false is reported")
    const staleSnapshot = await callOk(connected.client, "browser_snapshot", {
      tabId: opened.tabId,
      maxTextLength: 2_000,
    })
    assert(
      !String(record(staleSnapshot.data).text).includes("live=without-reload"),
      "reload=false does not claim the page was refreshed"
    )
    await callOk(connected.client, "browser_navigation", {
      action: "reload",
      tabId: opened.tabId,
    })
    const refreshedSnapshot = await callOk(connected.client, "browser_snapshot", {
      tabId: opened.tabId,
      maxTextLength: 2_000,
    })
    assert(
      String(record(refreshedSnapshot.data).text).includes("live=without-reload"),
      "reload after a no-reload Cookie write observes the new Cookie"
    )

    const persistent = await callOk(connected.client, "browser_cookie", {
      action: "inject",
      tabId: opened.tabId,
      cookies: [
        {
          name: "persistent",
          value: "yes",
          path: "/",
          httpOnly: true,
          sameSite: "Lax",
          expires: Math.floor(Date.now() / 1_000) + 3_600,
        },
      ],
      persist: true,
      ttlSeconds: 30,
    })
    assertEqual(record(persistent.data).persistent, true, "persistent Cookie mode is reported")
    const overTtl = await callTool(connected.client, "browser_cookie", {
      action: "inject",
      tabId: opened.tabId,
      cookieHeader: "over-ttl=blocked",
      persist: true,
      ttlSeconds: 61,
    })
    assertEqual(overTtl.error?.code, "invalid_request", "Cookie TTL is capped")

    const secondOpened = await callOk(connected.client, "browser_navigation", {
      action: "open",
      url: `http://127.0.0.1:${secondPort}/second`,
      newTab: true,
    })
    const crossPort = await callOk(connected.client, "browser_cookie", {
      action: "inject",
      tabId: opened.tabId,
      url: targetUrl,
      cookieHeader: "cross-port=warning",
      reload: false,
    })
    const crossPortWarnings = record(crossPort.data).warnings
    assert(
      Array.isArray(crossPortWarnings) &&
        crossPortWarnings.includes("localhost_cookie_scope_shared"),
      "localhost cross-port Cookie scope emits a warning"
    )

    const cleared = await callOk(connected.client, "browser_cookie", {
      action: "clear_target",
      tabId: opened.tabId,
    })
    assertEqual(record(cleared.data).clearedTarget, true, "clear_target reports clearing")
    await callOk(connected.client, "browser_navigation", {
      action: "reload",
      tabId: opened.tabId,
    })
    const clearedSnapshot = await callOk(connected.client, "browser_snapshot", {
      tabId: opened.tabId,
      maxTextLength: 2_000,
    })
    assertEqual(
      String(record(clearedSnapshot.data).text),
      "none",
      "clear_target removes target Cookies without readback"
    )
    assert(secondOpened.tabId, "cross-port fixture opens a second tab")
  } finally {
    const tabs = await callTool(connected.client, "browser_tab", { action: "list" })
    const tabList = tabs.ok ? record(tabs.data).tabs : undefined
    if (Array.isArray(tabList)) {
      for (const tab of tabList) {
        if (isRecord(tab) && typeof tab.id === "string") {
          await callTool(connected.client, "browser_tab", {
            action: "close",
            tabId: tab.id,
          })
        }
      }
    }
    await Promise.all([server, secondServer].map((fixtureServer) =>
      new Promise<void>((resolve) => {
        fixtureServer.close(() => resolve())
        // Chromium preconnects can remain open without ever sending a request.
        fixtureServer.closeAllConnections()
      })
    ))
  }
}

function listenHttpServer(server: ReturnType<typeof createHttpServer>) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
}

function addressPort(server: ReturnType<typeof createHttpServer>) {
  const address = server.address()
  if (address == null || typeof address === "string") {
    throw new Error("Cookie fixture server did not expose a port.")
  }
  return address.port
}

async function connectClient(
  name: string,
  options: ConnectedClientOptions = {}
): Promise<ConnectedClient> {
  const environment: Record<string, string> = {
    ...stringEnvironment(process.env),
    CHROME_POWER_HEADLESS: "1",
    CHROME_POWER_PROFILE_DIR: options.profileDir ?? join(root, "profile"),
    CHROME_POWER_SCREENSHOT_DIR:
      options.screenshotDir ?? join(root, "screenshots"),
    CHROME_POWER_SCREENSHOT_INLINE_MAX_BYTES: String(
      options.screenshotInlineMaxBytes ?? DEFAULT_SCREENSHOT_INLINE_MAX_BYTES
    ),
    CHROME_POWER_DOWNLOAD_DIR:
      options.downloadDir ?? join(root, "downloads"),
    CHROME_POWER_OWNER_SOCKET: options.ownerSocket ?? ownerSocket,
    CHROME_POWER_OWNER_IDLE_MS: String(options.ownerIdleMs ?? 600_000),
    CHROME_POWER_SESSION_TTL_MS: "1500",
    CHROME_POWER_LOCK_TIMEOUT_MS: String(options.lockTimeoutMs ?? 5_000),
    CHROME_POWER_MAX_CONCURRENT_CALLS: String(
      options.maxConcurrentCalls ?? DEFAULT_MAX_CONCURRENT_CALLS
    ),
    CHROME_POWER_MAX_QUEUED_CALLS: String(
      options.maxQueuedCalls ?? DEFAULT_MAX_QUEUED_CALLS
    ),
    CHROME_POWER_MAX_DIAGNOSTIC_WAITS: String(
      options.maxDiagnosticWaits ?? DEFAULT_MAX_DIAGNOSTIC_WAITS
    ),
  }
  delete environment.CHROME_POWER_MCP_TOOLS
  delete environment.CHROME_POWER_NAMESPACE
  delete environment.CHROME_POWER_OWNER_SOCKET
  delete environment.CHROME_POWER_OWNER_PORT
  delete environment.CHROME_POWER_OWNER_HOST
  delete environment.CHROME_POWER_TARGETS_FILE
  if (options.mcpTools !== undefined) {
    environment.CHROME_POWER_MCP_TOOLS = options.mcpTools
  }
  if (options.namespace !== undefined) {
    environment.CHROME_POWER_NAMESPACE = options.namespace
  } else {
    environment.CHROME_POWER_OWNER_SOCKET = options.ownerSocket ?? ownerSocket
  }
  if (options.directRuntime) {
    environment.CHROME_POWER_DIRECT_RUNTIME = "1"
  } else {
    delete environment.CHROME_POWER_DIRECT_RUNTIME
  }
  if (options.cookieAllowedOrigins !== undefined) {
    environment.CHROME_POWER_COOKIE_ALLOWED_ORIGINS = options.cookieAllowedOrigins
  } else {
    delete environment.CHROME_POWER_COOKIE_ALLOWED_ORIGINS
  }
  if (options.cookieMaxTtlSeconds !== undefined) {
    environment.CHROME_POWER_COOKIE_MAX_TTL_SECONDS = String(
      options.cookieMaxTtlSeconds
    )
  } else {
    delete environment.CHROME_POWER_COOKIE_MAX_TTL_SECONDS
  }
  if (options.targetsFile !== undefined) {
    environment.CHROME_POWER_TARGETS_FILE = options.targetsFile
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: options.cwd ?? appRoot,
    env: environment,
    stderr: "pipe",
  })
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)))
  const client = new Client(
    { name, version: "1.0.0" },
    { capabilities: {} }
  )
  await client.connect(transport)
  return { client, closed: false }
}

async function assertOwnerStartFromReplacedWorkingDirectory() {
  const fixtureRoot = join(root, "replaced-cwd")
  const currentCwd = join(fixtureRoot, "app")
  const retiredCwd = join(fixtureRoot, "retired-app")
  await mkdir(currentCwd, { recursive: true })
  const connected = await connectClient("integration-replaced-cwd", {
    cwd: currentCwd,
    ownerSocket: join(root, "cwd.sock"),
    profileDir: "profile",
    screenshotDir: "screenshots",
    downloadDir: "downloads",
    ownerIdleMs: 1_000,
  })
  clients.push(connected)
  try {
    // Keep the MCP client alive across the same directory replacement used
    // by global deployment, including removal of its old working directory.
    await rename(currentCwd, retiredCwd)
    await mkdir(currentCwd)
    await rm(retiredCwd, { recursive: true, force: true })
    const status = await callOk(connected.client, "browser_status")
    const data = record(status.data)
    assertEqual(data.contextLaunched, false, "owner recovery does not launch Chromium")
    const config = record(data.config)
    const resolvedCwd = await realpath(currentCwd)
    for (const [key, directory] of [
      ["profileDir", "profile"],
      ["screenshotDir", "screenshots"],
      ["downloadDir", "downloads"],
    ] as const) {
      assertEqual(
        config[key],
        join(resolvedCwd, directory),
        `owner recovery preserves the client's relative ${key} base`
      )
    }
  } finally {
    await closeClient(connected)
  }
}

async function assertBrowserResourceProtectionBurst(pagePath: string) {
  const burstRoot = join(root, "resource-protection-burst")
  // This burst checks resource accounting; dedicated scheduler cases cover
  // short admission timeouts. Allow queued real-browser reads to finish.
  const lockTimeoutMs = 30_000
  const connected = await connectClient("integration-resource-burst", {
    ownerSocket: join(root, "burst.sock"),
    profileDir: join(burstRoot, "profile"),
    screenshotDir: join(burstRoot, "screenshots"),
    downloadDir: join(burstRoot, "downloads"),
    ownerIdleMs: 1_000,
    lockTimeoutMs,
  })
  clients.push(connected)
  const opened = await callOk(connected.client, "browser_navigation", {
    action: "open",
    url: pathToFileURL(pagePath).href,
  })
  assert(typeof opened.tabId === "string", "burst fixture opens a tab")

  const runBurst = async (iteration: number) => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        index % 2 === 0
          ? callTool(connected.client, "browser_console", {
              action: "wait",
              tabId: opened.tabId,
              filter: `resource-burst-${iteration}-${index}-never-matches`,
              timeoutMs: 60,
            })
          : callTool(connected.client, "browser_status")
      )
    )
    for (let index = 0; index < results.length; index += 1) {
      if (index % 2 === 0) {
        assertEqual(
          results[index].error?.code,
          "operation_failed",
          `burst diagnostic wait ${iteration}-${index} preserves timeout semantics`
        )
      } else {
        assert(
          results[index].ok,
          `burst status ${iteration}-${index} succeeds: ${JSON.stringify(results[index].error)}`
        )
      }
    }
    const status = await callOk(connected.client, "browser_status")
    return assertResourceProtectionStatus(status, `burst ${iteration}`, lockTimeoutMs)
  }

  const first = await runBurst(1)
  const second = await runBurst(2)
  const firstTotals = record(first.totals)
  const secondTotals = record(second.totals)
  assert(
    Number(secondTotals.started) > Number(firstTotals.started),
    "repeated burst advances cumulative scheduler totals"
  )
  assertEqual(
    Number(secondTotals.started) - Number(secondTotals.completed),
    0,
    "repeated burst leaves no retained scheduler operations"
  )
  await closeClient(connected)
}

async function assertQueuedMcpCancellation(pagePath: string) {
  const cancellationRoot = join(root, "queued-mcp-cancellation")
  const connected = await connectClient("integration-queued-cancellation", {
    ownerSocket: join(root, "cancel.sock"),
    profileDir: join(cancellationRoot, "profile"),
    screenshotDir: join(cancellationRoot, "screenshots"),
    downloadDir: join(cancellationRoot, "downloads"),
    ownerIdleMs: 1_000,
    maxConcurrentCalls: 1,
    maxQueuedCalls: 8,
    maxDiagnosticWaits: 1,
  })
  clients.push(connected)
  const opened = await callOk(connected.client, "browser_navigation", {
    action: "open",
    url: pathToFileURL(pagePath).href,
  })
  assert(typeof opened.tabId === "string", "cancellation fixture opens a tab")
  const baselineStatus = await callOk(connected.client, "browser_status")
  const baselineProtection = record(
    record(baselineStatus.data).resourceProtection
  )
  const baselineCancelled = Number(
    record(baselineProtection.totals).cancelledInQueue
  )
  const baselineTabCount = Number(record(baselineStatus.data).tabCount)

  const blocker = callTool(connected.client, "browser_console", {
    action: "wait",
    tabId: opened.tabId,
    filter: "queued-cancellation-blocker-never-matches",
    timeoutMs: 800,
  })
  await delay(75)
  const controller = new AbortController()
  const cancelledCall = connected.client
    .callTool(
      {
        name: "browser_navigation",
        arguments: {
          action: "open",
          url: pathToFileURL(pagePath).href,
          newTab: true,
        },
      },
      undefined,
      { signal: controller.signal, timeout: 5_000 }
    )
    .then(
      () => undefined,
      (error: unknown) => error
    )
  await delay(75)
  controller.abort()
  const cancellation = await cancelledCall
  assert(cancellation instanceof Error, "MCP cancellation rejects the caller request")
  await delay(75)
  const blockerResult = await blocker
  assertEqual(
    blockerResult.error?.code,
    "operation_failed",
    "cancellation blocker preserves diagnostic timeout semantics"
  )

  const finalStatus = await callOk(connected.client, "browser_status")
  const finalProtection = record(record(finalStatus.data).resourceProtection)
  const finalTotals = record(finalProtection.totals)
  assertEqual(
    record(finalStatus.data).tabCount,
    baselineTabCount,
    "aborted queued navigation never creates a tab"
  )
  assertEqual(
    Number(finalTotals.cancelledInQueue),
    baselineCancelled + 1,
    "owner socket close cancels exactly one queued browser call"
  )
  assertEqual(
    record(finalProtection.active).scheduled,
    0,
    "queued MCP cancellation leaves no active scheduler work"
  )
  assertEqual(
    record(finalProtection.queued).total,
    0,
    "queued MCP cancellation leaves no queued scheduler work"
  )
  await closeClient(connected)
}

function assertResourceProtectionStatus(status: ToolResult, label: string, lockTimeoutMs: number) {
  const protection = record(record(status.data).resourceProtection)
  const limits = record(protection.limits)
  const active = record(protection.active)
  const queued = record(protection.queued)
  const highWaterMarks = record(protection.highWaterMarks)
  const totals = record(protection.totals)
  const memory = record(protection.memory)
  assertEqual(
    limits.maxConcurrentCalls,
    DEFAULT_MAX_CONCURRENT_CALLS,
    `${label} reports the configured global call limit`
  )
  assertEqual(
    limits.maxQueuedCalls,
    DEFAULT_MAX_QUEUED_CALLS,
    `${label} reports the configured queue limit`
  )
  assertEqual(
    limits.maxDiagnosticWaits,
    DEFAULT_MAX_DIAGNOSTIC_WAITS,
    `${label} reports the configured diagnostic limit`
  )
  assertEqual(
    limits.queueWaitTimeoutMs,
    lockTimeoutMs,
    `${label} reports the lock-derived queue timeout`
  )
  assert(
    Number(highWaterMarks.scheduled) <= DEFAULT_MAX_CONCURRENT_CALLS,
    `${label} scheduled high-water stays within the global limit`
  )
  assert(
    Number(highWaterMarks.diagnosticWait) <= DEFAULT_MAX_DIAGNOSTIC_WAITS,
    `${label} diagnostic high-water stays within its limit`
  )
  assert(
    Number(highWaterMarks.queued) <= DEFAULT_MAX_QUEUED_CALLS,
    `${label} queue high-water stays within its limit`
  )
  assertEqual(active.scheduled, 0, `${label} status excludes itself from active work`)
  assertEqual(active.regular, 0, `${label} leaves no active regular work`)
  assertEqual(active.diagnosticWait, 0, `${label} leaves no active diagnostics`)
  assertEqual(queued.total, 0, `${label} leaves no queued work`)
  assertEqual(
    totals.started,
    totals.completed,
    `${label} balances started and completed scheduler work`
  )
  for (const field of [
    "rssBytes",
    "heapTotalBytes",
    "heapUsedBytes",
    "externalBytes",
    "arrayBuffersBytes",
  ]) {
    const value = memory[field]
    assert(
      typeof value === "number" && Number.isFinite(value) && value >= 0,
      `${label} reports finite non-negative ${field}`
    )
  }
  return protection
}

function assertProfileParserCases() {
  assertEqual(
    resolveMcpToolSelection(undefined).source,
    "default",
    "missing MCP profile defaults to all"
  )
  assertEqual(
    resolveMcpToolSelection("   ").requested,
    "all",
    "blank MCP profile defaults to all"
  )
  assertEqual(
    resolveMcpToolSelection("all").source,
    "environment",
    "explicit all records environment selection"
  )
  assertEqual(
    JSON.stringify(resolveMcpToolSelection(" core , core ").activeGroups),
    JSON.stringify(["core"]),
    "duplicate MCP groups are deduplicated"
  )
  assertThrows(
    () => resolveMcpToolSelection("core,"),
    "empty MCP group token is rejected"
  )
  assertThrows(
    () => resolveMcpToolSelection("unknown"),
    "unknown MCP group is rejected"
  )
  assertThrows(
    () => resolveMcpToolSelection("all,core"),
    "all cannot be composed with another MCP group"
  )
}

function assertNamespaceConfigCases() {
  const cwd = join(root, "namespace-config-cwd")
  const baseEnvironment: NodeJS.ProcessEnv = {
    CHROME_POWER_PROFILE_DIR: join(root, "config-base-profile"),
    CHROME_POWER_SCREENSHOT_DIR: join(root, "config-base-screenshots"),
    CHROME_POWER_DOWNLOAD_DIR: join(root, "config-base-downloads"),
  }
  const shared = loadConfig({ cwd, env: baseEnvironment })
  assertEqual(shared.namespaceMode, "shared", "missing namespace stays shared")
  assertEqual(
    shared.profileDir,
    join(root, "config-base-profile"),
    "missing namespace preserves the exact profile path"
  )
  assertEqual(
    loadConfig({
      cwd,
      env: { ...baseEnvironment, CHROME_POWER_NAMESPACE: "   " },
    }).namespaceMode,
    "shared",
    "blank namespace stays shared"
  )
  const isolated = loadConfig({
    cwd,
    env: { ...baseEnvironment, CHROME_POWER_NAMESPACE: "project-a" },
  })
  assertEqual(isolated.namespace, "project-a", "valid namespace is retained")
  assertEqual(isolated.namespaceMode, "isolated", "valid namespace isolates")
  assertEqual(
    isolated.profileDir,
    join(root, "namespaces", "project-a", "profile"),
    "namespace derives profile below the base profile parent"
  )
  assertEqual(
    isolated.screenshotDir,
    join(root, "config-base-screenshots", "namespaces", "project-a"),
    "namespace derives screenshot artifacts below the configured base"
  )
  assertEqual(
    isolated.downloadDir,
    join(root, "config-base-downloads", "namespaces", "project-a"),
    "namespace derives download artifacts below the configured base"
  )
  assertEqual(
    loadConfig({
      cwd,
      env: {
        ...baseEnvironment,
        CHROME_POWER_NAMESPACE: "a".repeat(63),
      },
    }).namespace?.length,
    63,
    "namespace accepts the maximum length"
  )
  for (const invalid of [
    "default",
    "Project-A",
    "project_a",
    "project.a",
    "project/a",
    "project--a",
    "-project",
    "project-",
    "a".repeat(64),
  ]) {
    assertThrows(
      () =>
        loadConfig({
          cwd,
          env: { ...baseEnvironment, CHROME_POWER_NAMESPACE: invalid },
        }),
      `invalid namespace is rejected: ${invalid}`
    )
  }
  for (const override of [
    { CHROME_POWER_OWNER_SOCKET: join(root, "custom.sock") },
    { CHROME_POWER_OWNER_PORT: "9223" },
    { CHROME_POWER_OWNER_HOST: "127.0.0.1" },
  ]) {
    assertThrows(
      () =>
        loadConfig({
          cwd,
          env: {
            ...baseEnvironment,
            CHROME_POWER_NAMESPACE: "project-a",
            ...override,
          },
        }),
      "namespace rejects explicit owner endpoint overrides"
    )
  }
}

function assertNamespaceStatus(
  status: ToolResult,
  namespace: string,
  baseProfileDir: string,
  baseScreenshotDir: string,
  baseDownloadDir: string
) {
  const config = record(record(status.data).config)
  const namespaceData = record(config.namespace)
  assertEqual(namespaceData.mode, "isolated", "status reports isolated mode")
  assertEqual(namespaceData.name, namespace, "status reports namespace name")
  assertEqual(
    config.profileDir,
    join(dirname(baseProfileDir), "namespaces", namespace, "profile"),
    "status reports the resolved namespace profile"
  )
  assertEqual(
    config.screenshotDir,
    join(baseScreenshotDir, "namespaces", namespace),
    "status reports the resolved namespace screenshot directory"
  )
  assertEqual(
    config.downloadDir,
    join(baseDownloadDir, "namespaces", namespace),
    "status reports the resolved namespace download directory"
  )
}

function assertNumericConfigCases() {
  const cwd = join(root, "numeric-config-cwd")
  assertEqual(
    loadConfig({
      cwd,
      env: { CHROME_POWER_SCREENSHOT_INLINE_MAX_BYTES: "0" },
    }).screenshotInlineMaxBytes,
    0,
    "zero screenshot inline limit disables inline output"
  )
  assertEqual(
    loadConfig({
      cwd,
      env: { CHROME_POWER_SLOW_MO: "10000" },
    }).slowMoMs,
    10_000,
    "slow motion accepts its upper bound"
  )
  for (const value of ["-1", "1.5", "abc"]) {
    assertThrows(
      () =>
        loadConfig({
          cwd,
          env: { CHROME_POWER_SCREENSHOT_INLINE_MAX_BYTES: value },
        }),
      `invalid screenshot inline limit is rejected: ${value}`
    )
  }
  for (const value of ["-1", "10001", "Infinity", "abc"]) {
    assertThrows(
      () =>
        loadConfig({
          cwd,
          env: { CHROME_POWER_SLOW_MO: value },
        }),
      `invalid slow motion is rejected: ${value}`
    )
  }
}

function assertBrowserCallLimitConfigCases() {
  const cwd = join(root, "browser-call-limit-config-cwd")
  const defaults = loadConfig({ cwd, env: {} }).browserCallLimits
  assertEqual(
    defaults.maxConcurrentCalls,
    DEFAULT_MAX_CONCURRENT_CALLS,
    "browser call concurrency uses the documented default"
  )
  assertEqual(
    defaults.maxQueuedCalls,
    DEFAULT_MAX_QUEUED_CALLS,
    "browser call queue uses the documented default"
  )
  assertEqual(
    defaults.maxDiagnosticWaits,
    DEFAULT_MAX_DIAGNOSTIC_WAITS,
    "diagnostic wait concurrency uses the documented default"
  )

  const configured = loadConfig({
    cwd,
    env: {
      CHROME_POWER_MAX_CONCURRENT_CALLS: "64",
      CHROME_POWER_MAX_QUEUED_CALLS: "1024",
      CHROME_POWER_MAX_DIAGNOSTIC_WAITS: "64",
    },
  }).browserCallLimits
  assertEqual(
    configured.maxConcurrentCalls,
    64,
    "browser call concurrency accepts its upper bound"
  )
  assertEqual(
    configured.maxQueuedCalls,
    1_024,
    "browser call queue accepts its upper bound"
  )
  assertEqual(
    configured.maxDiagnosticWaits,
    64,
    "diagnostic wait concurrency accepts its upper bound"
  )

  const invalidCases: Array<[string, string, string]> = [
    ["CHROME_POWER_MAX_CONCURRENT_CALLS", "0", "zero concurrency"],
    ["CHROME_POWER_MAX_CONCURRENT_CALLS", "65", "excess concurrency"],
    ["CHROME_POWER_MAX_QUEUED_CALLS", "-1", "negative queue size"],
    ["CHROME_POWER_MAX_QUEUED_CALLS", "1025", "excess queue size"],
    ["CHROME_POWER_MAX_DIAGNOSTIC_WAITS", "0", "zero diagnostics"],
    ["CHROME_POWER_MAX_DIAGNOSTIC_WAITS", "65", "excess diagnostics"],
  ]
  for (const [name, value, label] of invalidCases) {
    assertThrows(
      () => loadConfig({ cwd, env: { [name]: value } }),
      `${label} is rejected`
    )
  }
  for (const name of [
    "CHROME_POWER_MAX_CONCURRENT_CALLS",
    "CHROME_POWER_MAX_QUEUED_CALLS",
    "CHROME_POWER_MAX_DIAGNOSTIC_WAITS",
  ]) {
    for (const value of ["1.5", "abc", "Infinity"]) {
      assertThrows(
        () => loadConfig({ cwd, env: { [name]: value } }),
        `${name} rejects a non-integer value: ${value}`
      )
    }
  }
}

function assertCookieConfigCases() {
  const cwd = join(root, "cookie-config-cwd")
  const defaults = loadConfig({ cwd, env: {} })
  assertEqual(
    defaults.cookieMaxTtlSeconds,
    DEFAULT_COOKIE_MAX_TTL_SECONDS,
    "Cookie TTL uses the documented seven-day default"
  )
  assertEqual(
    JSON.stringify(defaults.cookieAllowedOrigins),
    JSON.stringify([]),
    "Cookie targets default to loopback-only"
  )

  const configured = loadConfig({
    cwd,
    env: {
      CHROME_POWER_COOKIE_ALLOWED_ORIGINS:
        "https://Example.com/, http://example.test:8080",
      CHROME_POWER_COOKIE_MAX_TTL_SECONDS: "3600",
    },
  })
  assertEqual(
    JSON.stringify(configured.cookieAllowedOrigins),
    JSON.stringify(["https://example.com", "http://example.test:8080"]),
    "Cookie allowlist normalizes exact origins"
  )
  assertEqual(
    configured.cookieMaxTtlSeconds,
    3_600,
    "Cookie TTL accepts a bounded configured maximum"
  )
  resolveCookieTarget(
    "https://example.com/debug?secret=hidden",
    "https://example.com/assertion",
    configured.cookieAllowedOrigins
  )
  assertThrows(
    () =>
      resolveCookieTarget(
        "https://unlisted.example/debug",
        undefined,
        configured.cookieAllowedOrigins
      ),
    "remote Cookie targets require exact allowlist membership"
  )
  resolveCookieTarget("http://localhost:3000/debug", undefined, [])
  resolveCookieTarget("http://127.0.0.1:4000/debug", undefined, [])
  resolveCookieTarget("http://[::1]:5000/debug", undefined, [])
  const normalizationTarget = resolveCookieTarget(
    "https://example.com/app/debug",
    undefined,
    configured.cookieAllowedOrigins
  )
  const normalizedHeader = normalizeCookieOperation(
    {
      action: "inject",
      cookieHeader: "Cookie: auth=alpha=beta; theme=dark",
      persist: true,
      ttlSeconds: 60,
    },
    normalizationTarget,
    3_600,
    1_000
  )
  assertEqual(
    normalizedHeader.records[0]?.value,
    "alpha=beta",
    "Cookie header parsing splits each pair only at the first equals sign"
  )
  assertEqual(
    normalizedHeader.records[0]?.expires,
    1_060,
    "persistent header Cookies use the explicit bounded TTL"
  )
  const normalizedStructured = normalizeCookieOperation(
    {
      action: "inject",
      cookies: [
        {
          name: "structured",
          value: "value",
          domain: ".example.com",
          path: "/app",
          expires: 2_000,
          httpOnly: true,
          secure: true,
          sameSite: "None",
        },
      ],
      persist: true,
      ttlSeconds: 60,
    },
    normalizationTarget,
    3_600,
    1_000
  )
  assertEqual(
    normalizedStructured.records[0]?.expires,
    1_060,
    "structured Cookie expiry is clamped to the requested TTL"
  )
  assert(
    normalizedStructured.clearDomains.includes(".example.com"),
    "structured compatible domains participate in replacement clearing"
  )
  const sessionStructured = normalizeCookieOperation(
    {
      action: "inject",
      cookies: [{ name: "session", value: "value", expires: 2_000 }],
    },
    normalizationTarget,
    3_600,
    1_000
  )
  assertEqual(
    sessionStructured.records[0]?.expires,
    undefined,
    "session-mode Cookie input does not retain source expiry"
  )
  for (const [input, message] of [
    [
      { action: "inject", cookieHeader: "duplicate=one; duplicate=two" },
      "duplicate effective Cookie keys are rejected",
    ],
    [
      {
        action: "inject",
        cookies: [
          {
            name: "unsupported",
            value: "value",
            partitionKey: "https://example.com",
          },
        ],
      },
      "unsupported structured Cookie fields are rejected",
    ],
    [
      {
        action: "inject",
        cookies: [
          { name: "same-site", value: "value", sameSite: "None" },
        ],
      },
      "SameSite=None without secure=true is rejected",
    ],
    [
      {
        action: "inject",
        cookies: [{ name: "path", value: "value", path: "/other" }],
      },
      "Cookie paths outside the selected page are rejected",
    ],
    [
      {
        action: "inject",
        cookies: [
          { name: "domain", value: "value", domain: "outside.example" },
        ],
      },
      "Cookie domains outside the selected page are rejected",
    ],
    [
      {
        action: "inject",
        cookieHeader: "persistent=value",
        persist: true,
      },
      "persistent Cookie input requires an explicit TTL",
    ],
    [
      {
        action: "inject",
        cookieHeader: "ttl=value",
        persist: true,
        ttlSeconds: 3_601,
      },
      "Cookie TTL over the configured maximum is rejected",
    ],
  ] as const) {
    assertThrows(
      () =>
        normalizeCookieOperation(
          input as Parameters<typeof normalizeCookieOperation>[0],
          normalizationTarget,
          3_600,
          1_000
        ),
      message
    )
  }
  assertEqual(
    JSON.stringify(cookieDomainClearFilters(["example.test", ".example.test"])),
    JSON.stringify(["example.test", ".example.test"]),
    "Cookie clearing covers host-only and domain-cookie variants"
  )
  assertEqual(
    JSON.stringify(cookieDomainClearFilters(["127.0.0.1"])),
    JSON.stringify(["127.0.0.1"]),
    "Cookie clearing does not synthesize dotted IP domains"
  )

  for (const value of [
    "https://*.example.com",
    "https://example.com/path",
    "https://example.com?query=1",
    "file:///tmp/example",
    "https://example.com,",
  ]) {
    assertThrows(
      () =>
        loadConfig({
          cwd,
          env: { CHROME_POWER_COOKIE_ALLOWED_ORIGINS: value },
        }),
      `invalid Cookie allowlist entry is rejected: ${value}`
    )
  }
  for (const value of ["0", String(MAX_COOKIE_MAX_TTL_SECONDS + 1), "1.5", "abc"]) {
    assertThrows(
      () =>
        loadConfig({
          cwd,
          env: { CHROME_POWER_COOKIE_MAX_TTL_SECONDS: value },
        }),
      `invalid Cookie TTL maximum is rejected: ${value}`
    )
  }
}

function assertOwnerEndpointCases() {
  assertThrows(
    () =>
      loadConfig({
        cwd: root,
        env: {
          CHROME_POWER_OWNER_PORT: "eighty",
          CHROME_POWER_OWNER_HOST: "127.0.0.1",
        },
      }),
    "invalid owner port is rejected"
  )
  assertThrows(
    () =>
      loadConfig({
        cwd: root,
        env: {
          CHROME_POWER_OWNER_PORT: "43123",
          CHROME_POWER_OWNER_HOST: "0.0.0.0",
        },
      }),
    "non-loopback owner host is rejected"
  )
  assertEqual(
    ownerEndpoint(
      loadConfig({
        cwd: root,
        env: {
          CHROME_POWER_OWNER_PORT: "43123",
          CHROME_POWER_OWNER_HOST: "127.0.0.1",
        },
      })
    ).kind,
    "tcp",
    "loopback owner host is accepted"
  )
  const longRoot = join(root, "long-root", "x".repeat(140))
  const longSocket = ownerSocketPath(
    loadConfig({ cwd: longRoot, env: {} })
  )
  assert(
    Buffer.byteLength(longSocket) <= 100,
    "default owner socket path stays within macOS sun_path bounds"
  )
  assert(
    longSocket.includes("chrome-power-owner-") && longSocket.endsWith(".sock"),
    "long default owner path uses the hashed fallback"
  )
  const ownerBaseConfig = loadConfig({
    cwd: join(root, "target-owner-identity"),
    env: {},
  })
  assert(
    ownerSocketPath({
      ...ownerBaseConfig,
      targetConfigFingerprint: "targets-a",
    }) !==
      ownerSocketPath({
        ...ownerBaseConfig,
        targetConfigFingerprint: "targets-b",
      }),
    "different target configurations cannot share a derived owner endpoint"
  )
  const namespacedTargetSocketA = ownerSocketPath({
    ...ownerBaseConfig,
    namespace: "team",
    profileDir: join(root, "namespaces", "team", "profile"),
    targetConfigFingerprint: "targets-a",
  })
  const namespacedTargetSocketB = ownerSocketPath({
    ...ownerBaseConfig,
    namespace: "team",
    profileDir: join(root, "namespaces", "team", "profile"),
    targetConfigFingerprint: "targets-b",
  })
  assert(
    namespacedTargetSocketA !== namespacedTargetSocketB,
    "namespaced target configurations cannot share a derived owner endpoint"
  )
  for (const value of ["0", "65536", "1.5", "Infinity"]) {
    assertThrows(
      () =>
        loadConfig({
          cwd: root,
          env: { CHROME_POWER_OWNER_PORT: value },
        }),
      `owner port bounds are enforced: ${value}`
    )
  }
}

async function assertOwnerTargetFingerprintIsolation() {
  const fixtureRoot = await mkdtemp(join(root, "owner-target-identity-"))
  const socketPath = join(fixtureRoot, "shared-owner.sock")
  const targetsAPath = join(fixtureRoot, "targets-a.json")
  const targetsBPath = join(fixtureRoot, "targets-b.json")
  const targetConfig = (endpoint: string) => ({
    version: 1,
    targets: [
      {
        id: "work",
        label: "Work Chrome",
        browser: "chrome",
        connection: { kind: "endpoint", endpoint },
      },
    ],
  })
  await writeFile(targetsAPath, JSON.stringify(targetConfig("http://127.0.0.1:9222")))
  await writeFile(targetsBPath, JSON.stringify(targetConfig("http://127.0.0.1:9223")))

  const configA = loadConfig({
    cwd: fixtureRoot,
    env: {
      CHROME_POWER_TARGETS_FILE: targetsAPath,
      CHROME_POWER_OWNER_SOCKET: socketPath,
    },
  })
  const configB = loadConfig({
    cwd: fixtureRoot,
    env: {
      CHROME_POWER_TARGETS_FILE: targetsBPath,
      CHROME_POWER_OWNER_SOCKET: socketPath,
    },
  })
  assert(
    configA.targetConfigFingerprint !== configB.targetConfigFingerprint,
    "different target manifests receive different owner fingerprints"
  )

  let requestCount = 0
  const server = createServer((socket) => {
    socket.on("error", () => undefined)
    socket.on("data", () => {
      requestCount += 1
    })
    socket.resume()
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(socketPath, () => {
      server.off("error", rejectListen)
      resolveListen()
    })
  })

  try {
    await writeFile(
      ownerControlPath(configA),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        token: "other-target-token",
        endpoint: ownerEndpoint(configA),
        targetConfigFingerprint: configB.targetConfigFingerprint,
      })
    )
    const client = new BrowserOwnerClient(configA, {
      requestTimeoutMs: 250,
      startOwner: async () => {
        throw new Error("target identity mismatch must not start another owner")
      },
    })
    const result = await client.call("browser_status")
    assertEqual(
      result.error?.code,
      "operation_failed",
      "a live owner with a different target fingerprint is rejected"
    )
    assert(
      result.error?.message.includes("different chrome-power target configuration") ===
        true,
      "target identity rejection is actionable"
    )
    assert(!result.error?.message.includes(socketPath), "target identity error hides owner path")
    assert(
      !result.error?.message.includes(String(configB.targetConfigFingerprint)),
      "target identity error hides the fingerprint"
    )
    assertEqual(
      requestCount,
      0,
      "target identity mismatch does not send a request to the other owner"
    )
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) rejectClose(error)
        else resolveClose()
      })
    })
    await rm(fixtureRoot, { recursive: true, force: true })
  }
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value == null) delete process.env[name]
  else process.env[name] = value
}

async function assertCliOwnerConflict() {
  const socketPath = join(root, "cli-owner-conflict.sock")
  const server = createServer((socket) => {
    socket.on("error", () => undefined)
    socket.resume()
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(socketPath, () => {
      server.off("error", rejectListen)
      resolveListen()
    })
  })

  try {
    const environment = {
      ...stringEnvironment(process.env),
      CHROME_POWER_OWNER_SOCKET: socketPath,
      CHROME_POWER_OWNER_PORT: "",
      CHROME_POWER_OWNER_HOST: "",
      CHROME_POWER_NAMESPACE: "",
      CHROME_POWER_PROFILE_DIR: join(root, "cli-conflict-profile"),
    }
    const status = await execFileAsync(
      process.execPath,
      [fallbackEntry, "status"],
      { env: environment }
    )
    assertEqual(
      record(JSON.parse(status.stdout)).ok,
      true,
      "read-only CLI status remains available beside a live owner"
    )
    let stdout = ""
    try {
      await execFileAsync(
        process.execPath,
        [fallbackEntry, "open", "https://example.test"],
        {
          env: environment,
        },
      )
      throw new Error("CLI should reject a live owner for the same profile")
    } catch (error) {
      stdout = String((error as { stdout?: unknown }).stdout ?? "")
    }
    const result = record(JSON.parse(stdout))
    assertEqual(result.ok, false, "CLI owner conflict returns a failure envelope")
    assertEqual(
      record(result.error).code,
      "operation_failed",
      "CLI owner conflict uses the ToolResult error code"
    )
    assert(
      String(record(result.error).message).includes("owner is already running"),
      "CLI owner conflict gives an actionable explanation"
    )
    assertEqual(result.sessionId, "cli", "pre-runtime CLI failures have a stable session id")
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) rejectClose(error)
        else resolveClose()
      })
    })
  }
}

async function assertPermissionGrantBound() {
  const runtime = new BrowserRuntime({
    ...loadConfig({ cwd: root, env: {} }),
    headless: true,
    profileDir: join(root, "permission-bound-profile"),
    screenshotDir: join(root, "permission-bound-screenshots"),
    downloadDir: join(root, "permission-bound-downloads"),
  })
  try {
    let latest:
      | Awaited<ReturnType<BrowserRuntime["setPermissions"]>>
      | undefined
    for (let index = 0; index <= 100; index += 1) {
      latest = await runtime.setPermissions({
        permissions: ["geolocation"],
        origin: `https://permission-${index}.example.test`,
      })
      assert(latest.ok, `permission grant ${index} succeeds`)
    }
    assert(latest?.ok, "permission bound returns a final result")
    assertEqual(
      latest.data?.permissionGrants.length,
      100,
      "permission grant origins stay bounded"
    )
    assert(
      latest.data?.permissionGrants.every(
        (grant) => grant.origin !== "https://permission-0.example.test"
      ),
      "permission grant bound evicts the oldest origin"
    )
  } finally {
    await runtime.dispose()
  }
}

async function assertInvalidProfileStartup() {
  const environment = {
    ...stringEnvironment(process.env),
    CHROME_POWER_MCP_TOOLS: "core,unknown",
  }
  let stderrOutput = ""
  let rejected = false
  try {
    await execFileAsync(process.execPath, [serverEntry], {
      cwd: appRoot,
      env: environment,
      timeout: 5_000,
    })
  } catch (error) {
    rejected = true
    stderrOutput = String((error as { stderr?: unknown }).stderr ?? error)
  }
  assert(rejected, "invalid MCP profile exits nonzero")
  assert(
    stderrOutput.includes("Invalid CHROME_POWER_MCP_TOOLS") &&
      stderrOutput.includes("unknown"),
    "invalid MCP profile reports a clear configuration error"
  )
}

async function closeClient(connected: ConnectedClient) {
  if (connected.closed) return
  connected.closed = true
  await connected.client.close().catch(() => undefined)
}

async function callOk(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
) {
  const result = await callTool(client, name, args)
  if (!result.ok) {
    throw new Error(`${name} failed: ${JSON.stringify(result.error)}`)
  }
  return result
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolResult> {
  return (await callToolDetailed(client, name, args)).result
}

async function callToolDetailed(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ result: ToolResult; response: Record<string, unknown> }> {
  const response = await client.callTool({ name, arguments: args })
  const responseRecord = record(response)
  const content = responseRecord.content
  if (!Array.isArray(content)) throw new Error(`${name} returned no content`)
  const text = content.find(
    (item) =>
      typeof item === "object" &&
      item != null &&
      !Array.isArray(item) &&
      item.type === "text" &&
      typeof item.text === "string"
  )
  if (!text) throw new Error(`${name} returned no text result`)
  const textResult = JSON.parse((text as { text: string }).text) as ToolResult
  const structuredResult = record(responseRecord.structuredContent) as ToolResult
  assertEqual(
    JSON.stringify(structuredResult),
    JSON.stringify(textResult),
    `${name} structured content matches text fallback`
  )
  assertEqual(
    responseRecord.isError === true,
    !structuredResult.ok,
    `${name} MCP isError matches ToolResult.ok`
  )
  return { result: structuredResult, response: responseRecord }
}

async function waitForStatus(
  client: Client,
  predicate: (status: ToolResult) => boolean
) {
  const deadline = Date.now() + 7_000
  let latest: ToolResult | undefined
  while (Date.now() < deadline) {
    latest = await callTool(client, "browser_status")
    if (latest.ok && predicate(latest)) return latest
    await delay(50)
  }
  throw new Error(`Timed out waiting for owner status: ${JSON.stringify(latest)}`)
}

function ownerData(status: ToolResult) {
  return record(record(status.data).owner)
}

async function terminateIsolatedChromium(profileDir: string) {
  const { stdout } = await execFileAsync("ps", [
    "-ax",
    "-o",
    "pid=,command=",
  ])
  const marker = `--user-data-dir=${profileDir}`
  const pids = stdout
    .split("\n")
    .filter((line) => line.includes(marker))
    .map((line) => Number(line.trim().split(/\s+/, 1)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
  assert(pids.length > 0, "isolated Playwright Chromium process exists")
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
}

async function assertBrowserCallSchedulerCases() {
  await assertSchedulerLimitsAndPriority()
  await assertSchedulerKeysAndExclusiveFairness()
  await assertSchedulerOverloadAndCancellation()
}

async function assertSchedulerLimitsAndPriority() {
  const scheduler = new BrowserCallScheduler({
    maxConcurrentCalls: 2,
    maxQueuedCalls: 8,
    maxDiagnosticWaits: 1,
    queueWaitTimeoutMs: 1_000,
  })
  const starts: string[] = []
  const firstDiagnosticGate = createGate()
  const firstRegularGate = createGate()
  const secondDiagnosticGate = createGate()
  const secondRegularGate = createGate()
  const firstDiagnostic = runGatedSchedulerOperation(
    scheduler,
    { lane: "diagnostic_wait", mode: "shared" },
    "diagnostic-1",
    firstDiagnosticGate,
    starts
  )
  const firstRegular = runGatedSchedulerOperation(
    scheduler,
    { lane: "regular", mode: "shared", resourceKeys: ["session:1"] },
    "regular-1",
    firstRegularGate,
    starts
  )
  await waitForCondition(
    () => starts.length === 2,
    "initial scheduler operations start"
  )

  const secondDiagnostic = runGatedSchedulerOperation(
    scheduler,
    { lane: "diagnostic_wait", mode: "shared" },
    "diagnostic-2",
    secondDiagnosticGate,
    starts
  )
  const secondRegular = runGatedSchedulerOperation(
    scheduler,
    { lane: "regular", mode: "shared", resourceKeys: ["session:2"] },
    "regular-2",
    secondRegularGate,
    starts
  )
  firstRegularGate.release()
  await firstRegular
  await waitForCondition(
    () => starts.includes("regular-2"),
    "regular work starts before an earlier diagnostic waiter"
  )
  assert(
    !starts.includes("diagnostic-2"),
    "queued regular work has priority over diagnostic waits"
  )
  secondRegularGate.release()
  await secondRegular
  await delay(10)
  assert(
    !starts.includes("diagnostic-2"),
    "diagnostic concurrency limit holds while one wait remains active"
  )
  firstDiagnosticGate.release()
  await firstDiagnostic
  await waitForCondition(
    () => starts.includes("diagnostic-2"),
    "next diagnostic starts after diagnostic capacity is released"
  )
  secondDiagnosticGate.release()
  await secondDiagnostic

  const status = scheduler.snapshot()
  assertEqual(status.highWaterMarks.scheduled, 2, "global scheduler cap is enforced")
  assertEqual(
    status.highWaterMarks.diagnosticWait,
    1,
    "diagnostic scheduler cap is enforced"
  )
  assertEqual(status.active.scheduled, 0, "scheduler releases all active work")
  assertEqual(status.queued.total, 0, "scheduler drains all queued work")
  assertEqual(status.totals.started, 4, "scheduler counts every started operation")
  assertEqual(status.totals.completed, 4, "scheduler counts every completed operation")
}

async function assertSchedulerKeysAndExclusiveFairness() {
  const scheduler = new BrowserCallScheduler({
    maxConcurrentCalls: 3,
    maxQueuedCalls: 8,
    maxDiagnosticWaits: 1,
    queueWaitTimeoutMs: 1_000,
  })
  const starts: string[] = []
  const firstSessionGate = createGate()
  const secondSessionGate = createGate()
  const otherSessionGate = createGate()
  const exclusiveGate = createGate()
  const laterSharedGate = createGate()
  const firstSession = runGatedSchedulerOperation(
    scheduler,
    { lane: "regular", mode: "shared", resourceKeys: ["session:a", "tab:a"] },
    "session-a-1",
    firstSessionGate,
    starts
  )
  await waitForCondition(
    () => starts.includes("session-a-1"),
    "first keyed operation starts"
  )
  const secondSession = runGatedSchedulerOperation(
    scheduler,
    { lane: "regular", mode: "shared", resourceKeys: ["session:a", "tab:a"] },
    "session-a-2",
    secondSessionGate,
    starts
  )
  const otherSession = runGatedSchedulerOperation(
    scheduler,
    { lane: "regular", mode: "shared", resourceKeys: ["session:b", "tab:b"] },
    "session-b",
    otherSessionGate,
    starts
  )
  await waitForCondition(
    () => starts.includes("session-b"),
    "unrelated keyed operation bypasses a blocked queue entry"
  )
  assert(
    !starts.includes("session-a-2"),
    "matching session and tab keys remain serialized"
  )

  const exclusive = runGatedSchedulerOperation(
    scheduler,
    { lane: "regular", mode: "exclusive" },
    "exclusive",
    exclusiveGate,
    starts
  )
  const laterShared = runGatedSchedulerOperation(
    scheduler,
    { lane: "regular", mode: "shared", resourceKeys: ["session:c"] },
    "session-c",
    laterSharedGate,
    starts
  )
  otherSessionGate.release()
  await otherSession
  assert(
    !starts.includes("session-c"),
    "later shared work cannot bypass a queued exclusive operation"
  )
  firstSessionGate.release()
  await firstSession
  await waitForCondition(
    () => starts.includes("session-a-2"),
    "shared work queued before exclusive work keeps its order"
  )
  assert(
    !starts.includes("exclusive") && !starts.includes("session-c"),
    "exclusive waits for earlier shared work and blocks later shared work"
  )
  secondSessionGate.release()
  await secondSession
  await waitForCondition(
    () => starts.includes("exclusive"),
    "exclusive work starts after earlier shared work drains"
  )
  assert(
    !starts.includes("session-c"),
    "shared work stays blocked while exclusive work is active"
  )
  exclusiveGate.release()
  await exclusive
  await waitForCondition(
    () => starts.includes("session-c"),
    "later shared work resumes after exclusive work"
  )
  laterSharedGate.release()
  await laterShared
  const status = scheduler.snapshot()
  assertEqual(status.active.scheduled, 0, "keyed scheduler releases active work")
  assertEqual(status.queued.total, 0, "keyed scheduler drains queued work")
}

async function assertSchedulerOverloadAndCancellation() {
  const scheduler = new BrowserCallScheduler({
    maxConcurrentCalls: 1,
    maxQueuedCalls: 2,
    maxDiagnosticWaits: 1,
    queueWaitTimeoutMs: 100,
  })
  const blockerGate = createGate()
  const blocker = runGatedSchedulerOperation(
    scheduler,
    { lane: "regular", mode: "shared", resourceKeys: ["session:blocker"] },
    "blocker",
    blockerGate,
    []
  )
  await waitForCondition(
    () => scheduler.snapshot().active.scheduled === 1,
    "overload blocker starts"
  )
  const controller = new AbortController()
  let cancelledOperationStarted = false
  let timedOutOperationStarted = false
  const cancelled = scheduler.run(
    {
      lane: "regular",
      mode: "shared",
      resourceKeys: ["session:cancelled"],
      signal: controller.signal,
    },
    async () => {
      cancelledOperationStarted = true
    }
  )
  const timedOut = scheduler.run(
    { lane: "regular", mode: "shared", resourceKeys: ["session:timeout"] },
    async () => {
      timedOutOperationStarted = true
    }
  )
  await assertSchedulerRejection(
    scheduler.run(
      { lane: "regular", mode: "shared", resourceKeys: ["session:full"] },
      async () => undefined
    ),
    "resource_busy",
    "full queue rejects additional work"
  )
  controller.abort()
  await assertSchedulerRejection(
    cancelled,
    "operation_cancelled",
    "queued abort returns the cancellation code"
  )
  const timeoutKeepAlive = delay(150)
  await assertSchedulerRejection(
    timedOut,
    "resource_busy",
    "queue timeout returns the resource-busy code"
  )
  await timeoutKeepAlive
  assert(!cancelledOperationStarted, "aborted queued work never executes")
  assert(!timedOutOperationStarted, "timed-out queued work never executes")
  blockerGate.release()
  await blocker
  const status = scheduler.snapshot()
  assertEqual(status.totals.rejectedQueueFull, 1, "queue-full rejection is counted")
  assertEqual(status.totals.timedOutInQueue, 1, "queue timeout is counted")
  assertEqual(status.totals.cancelledInQueue, 1, "queued cancellation is counted")

  const fullQueueScheduler = new BrowserCallScheduler({
    maxConcurrentCalls: 2,
    maxQueuedCalls: 1,
    maxDiagnosticWaits: 1,
    queueWaitTimeoutMs: 1_000,
  })
  const fullQueueStarts: string[] = []
  const activeKeyGate = createGate()
  const waitingKeyGate = createGate()
  const immediatelyStartableGate = createGate()
  const activeKey = runGatedSchedulerOperation(
    fullQueueScheduler,
    { lane: "regular", mode: "shared", resourceKeys: ["session:a"] },
    "full-queue-active-a",
    activeKeyGate,
    fullQueueStarts
  )
  await waitForCondition(
    () => fullQueueStarts.includes("full-queue-active-a"),
    "full-queue fixture starts keyed work"
  )
  const waitingKey = runGatedSchedulerOperation(
    fullQueueScheduler,
    { lane: "regular", mode: "shared", resourceKeys: ["session:a"] },
    "full-queue-waiting-a",
    waitingKeyGate,
    fullQueueStarts
  )
  assertEqual(
    fullQueueScheduler.snapshot().queued.total,
    1,
    "full-queue fixture fills its waiting capacity"
  )
  const immediatelyStartable = runGatedSchedulerOperation(
    fullQueueScheduler,
    { lane: "regular", mode: "shared", resourceKeys: ["session:b"] },
    "full-queue-startable-b",
    immediatelyStartableGate,
    fullQueueStarts
  )
  await waitForCondition(
    () => fullQueueStarts.includes("full-queue-startable-b"),
    "startable work bypasses a full waiting queue"
  )
  assertEqual(
    fullQueueScheduler.snapshot().queued.total,
    1,
    "immediately started work does not consume queue capacity"
  )
  immediatelyStartableGate.release()
  await immediatelyStartable
  activeKeyGate.release()
  await activeKey
  await waitForCondition(
    () => fullQueueStarts.includes("full-queue-waiting-a"),
    "blocked keyed work starts after its resource is released"
  )
  waitingKeyGate.release()
  await waitingKey

  const disposingScheduler = new BrowserCallScheduler({
    maxConcurrentCalls: 1,
    maxQueuedCalls: 1,
    maxDiagnosticWaits: 1,
    queueWaitTimeoutMs: 1_000,
  })
  const activeGate = createGate()
  const active = runGatedSchedulerOperation(
    disposingScheduler,
    { lane: "regular", mode: "shared" },
    "active-during-dispose",
    activeGate,
    []
  )
  await waitForCondition(
    () => disposingScheduler.snapshot().active.scheduled === 1,
    "dispose fixture starts active work"
  )
  let disposedQueuedOperationStarted = false
  const disposedQueued = disposingScheduler.run(
    { lane: "regular", mode: "shared" },
    async () => {
      disposedQueuedOperationStarted = true
    }
  )
  disposingScheduler.dispose()
  await assertSchedulerRejection(
    disposedQueued,
    "operation_cancelled",
    "scheduler disposal cancels queued work"
  )
  assert(!disposedQueuedOperationStarted, "disposed queued work never executes")
  activeGate.release()
  await active
  await assertSchedulerRejection(
    disposingScheduler.run(
      { lane: "regular", mode: "shared" },
      async () => undefined
    ),
    "operation_cancelled",
    "disposed scheduler rejects new work"
  )

  const zeroQueueScheduler = new BrowserCallScheduler({
    maxConcurrentCalls: 1,
    maxQueuedCalls: 0,
    maxDiagnosticWaits: 1,
    queueWaitTimeoutMs: 1_000,
  })
  const zeroQueueGate = createGate()
  const zeroQueueActive = runGatedSchedulerOperation(
    zeroQueueScheduler,
    { lane: "regular", mode: "shared" },
    "zero-queue-active",
    zeroQueueGate,
    []
  )
  await waitForCondition(
    () => zeroQueueScheduler.snapshot().active.scheduled === 1,
    "zero-capacity queue fixture starts active work"
  )
  await assertSchedulerRejection(
    zeroQueueScheduler.run(
      { lane: "regular", mode: "shared" },
      async () => undefined
    ),
    "resource_busy",
    "zero-capacity queue rejects only when no slot is free"
  )
  zeroQueueGate.release()
  await zeroQueueActive
}

type SchedulerGate = {
  promise: Promise<void>
  release(): void
}

function createGate(): SchedulerGate {
  let release = () => undefined as void
  const promise = new Promise<void>((resolvePromise) => {
    release = () => resolvePromise()
  })
  return { promise, release }
}

function runGatedSchedulerOperation(
  scheduler: BrowserCallScheduler,
  descriptor: BrowserCallDescriptor,
  name: string,
  gate: SchedulerGate,
  starts: string[]
) {
  return scheduler.run(descriptor, async () => {
    starts.push(name)
    await gate.promise
    return name
  })
}

async function assertSchedulerRejection(
  promise: Promise<unknown>,
  code: "resource_busy" | "operation_cancelled",
  message: string
) {
  try {
    await promise
  } catch (error) {
    assert(error instanceof BrowserToolError, `${message} uses BrowserToolError`)
    assertEqual(error.code, code, message)
    return
  }
  throw new Error(`Assertion failed: ${message}; promise resolved`)
}

async function assertMalformedOwnerResponseRejected() {
  const socketPath = join(root, "malformed-owner.sock")
  const server = createServer((socket) => {
    let buffer = ""
    socket.setEncoding("utf8")
    socket.on("error", () => undefined)
    socket.on("data", (chunk) => {
      buffer += chunk
      const newlineIndex = buffer.indexOf("\n")
      if (newlineIndex === -1) return
      const request = JSON.parse(buffer.slice(0, newlineIndex)) as { id: string }
      socket.end(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`)
    })
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(socketPath, () => {
      server.off("error", rejectListen)
      resolveListen()
    })
  })

  try {
    const config = loadConfig({
      cwd: root,
      env: { CHROME_POWER_PROFILE_DIR: join(root, "malformed-profile") },
    })
    const client = new BrowserOwnerClient(config, {
      endpoint: { kind: "socket", path: socketPath },
      requestTimeoutMs: 500,
      getControlToken: async () => "integration-fake-token",
      startOwner: async () => {
        throw new Error("malformed responses must not be retried")
      },
    })
    const result = await client.call("browser_status")
    assertEqual(
      result.error?.code,
      "browser_unavailable",
      "malformed owner response returns the standard unavailable envelope"
    )
    assert(
      result.error?.message.includes("was not retried") === true,
      "malformed owner response is result-unknown after delivery"
    )
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) rejectClose(error)
        else resolveClose()
      })
    })
  }
}

async function assertOwnerClientDoesNotReplayUnknownResult() {
  const socketPath = join(root, "unknown-result-owner.sock")
  let requestCount = 0
  const server = createServer((socket) => {
    let buffer = ""
    socket.setEncoding("utf8")
    socket.on("error", () => undefined)
    socket.on("data", (chunk) => {
      buffer += chunk
      if (!buffer.includes("\n")) return
      requestCount += 1
    })
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(socketPath, () => {
      server.off("error", rejectListen)
      resolveListen()
    })
  })

  try {
    const config = loadConfig({
      cwd: root,
      env: {
        CHROME_POWER_HEADLESS: "1",
        CHROME_POWER_PROFILE_DIR: join(root, "unknown-result-profile"),
      },
    })
    const client = new BrowserOwnerClient(config, {
      endpoint: { kind: "socket", path: socketPath },
      requestTimeoutMs: 50,
      getControlToken: async () => "integration-fake-token",
      startOwner: async () => {
        throw new Error("result-unknown requests must not start or retry owner")
      },
    })
    const result = await client.call("browser_status")
    assertEqual(result.ok, false, "result-unknown owner call fails")
    assertEqual(
      result.error?.code,
      "browser_unavailable",
      "result-unknown owner call keeps the owner failure envelope"
    )
    assert(
      result.error?.message.includes("was not retried"),
      "result-unknown owner call explains duplicate-action protection"
    )
    assertEqual(
      requestCount,
      1,
      "an already-written owner request is never replayed"
    )
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) rejectClose(error)
        else resolveClose()
      })
    })
  }
}

async function assertOwnerClientCancellation() {
  const socketPath = join(root, "cancelled-owner.sock")
  let requestCount = 0
  const requestReceived = createGate()
  const server = createServer((socket) => {
    let buffer = ""
    socket.setEncoding("utf8")
    socket.on("error", () => undefined)
    socket.on("data", (chunk) => {
      buffer += chunk
      if (!buffer.includes("\n")) return
      requestCount += 1
      requestReceived.release()
    })
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(socketPath, () => {
      server.off("error", rejectListen)
      resolveListen()
    })
  })

  try {
    const config = loadConfig({
      cwd: root,
      env: {
        CHROME_POWER_HEADLESS: "1",
        CHROME_POWER_PROFILE_DIR: join(root, "cancelled-owner-profile"),
      },
    })
    const client = new BrowserOwnerClient(config, {
      endpoint: { kind: "socket", path: socketPath },
      requestTimeoutMs: 5_000,
      getControlToken: async () => "integration-fake-token",
      startOwner: async () => {
        throw new Error("cancelled owner requests must not start or retry owner")
      },
    })
    const controller = new AbortController()
    const pending = client.call("browser_status", {}, controller.signal)
    await requestReceived.promise
    controller.abort()
    const result = await pending
    assertEqual(result.ok, false, "cancelled delivered owner call fails")
    assertEqual(
      result.error?.code,
      "operation_cancelled",
      "cancelled delivered owner call uses the cancellation envelope"
    )
    assert(
      result.error?.message.includes("may have already started") === true,
      "delivered owner cancellation warns that execution may have started"
    )
    await delay(20)
    assertEqual(requestCount, 1, "cancelled delivered owner call is not replayed")

    const preAborted = new AbortController()
    preAborted.abort()
    const preAbortedResult = await client.call(
      "browser_status",
      {},
      preAborted.signal
    )
    assertEqual(
      preAbortedResult.error?.code,
      "operation_cancelled",
      "pre-send abort uses the cancellation envelope"
    )
    assert(
      preAbortedResult.error?.message.includes("before it was sent") === true,
      "pre-send abort reports that no owner request was sent"
    )
    assertEqual(requestCount, 1, "pre-send abort does not contact the owner")
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) rejectClose(error)
        else resolveClose()
      })
    })
  }
}

async function resetOwnerClientDuringRequest(tabId: string) {
  const token = await readOwnerToken()
  return new Promise<void>((resolvePromise, reject) => {
    const socket = createConnection(ownerSocket)
    socket.once("error", reject)
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          id: randomUUID(),
          kind: "call",
          sessionId: "integration-socket-reset",
          token,
          tool: "browser_element_action",
          input: { action: "wait", tabId, timeoutMs: 250 },
        })}\n`,
        (error) => {
          if (error) {
            reject(error)
            return
          }
          socket.destroy()
          resolvePromise()
        }
      )
    })
  })
}

async function sendOwnerRelease(sessionId: string) {
  const token = await readOwnerToken()
  return new Promise<void>((resolvePromise, reject) => {
    const socket = createConnection(ownerSocket)
    let buffer = ""
    socket.setEncoding("utf8")
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          id: randomUUID(),
          kind: "release",
          sessionId,
          token,
        })}\n`
      )
    })
    socket.on("data", (chunk) => {
      buffer += chunk
      if (!buffer.includes("\n")) return
      socket.end()
      resolvePromise()
    })
    socket.once("error", reject)
  })
}

function sendOwnerShutdown(token: string) {
  return sendOwnerShutdownAt(ownerSocket, token)
}

function sendRawOwnerRequest(request: Record<string, unknown>) {
  return new Promise<Record<string, unknown>>((resolvePromise, reject) => {
    const socket = createConnection(ownerSocket)
    let buffer = ""
    socket.setEncoding("utf8")
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`)
    })
    socket.on("data", (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf("\n")
      if (newline === -1) return
      socket.end()
      resolvePromise(record(JSON.parse(buffer.slice(0, newline))))
    })
    socket.once("error", reject)
  })
}

function assertOversizedOwnerFrameRejected() {
  return new Promise<void>((resolvePromise, reject) => {
    const socket = createConnection(ownerSocket)
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolvePromise()
    }
    socket.setTimeout(5_000)
    socket.once("connect", () => {
      socket.write("x".repeat(10 * 1024 * 1024 + 1))
    })
    socket.once("close", () => finish())
    socket.once("error", () => finish())
    socket.once("timeout", () =>
      finish(new Error("Owner did not reject an oversized frame."))
    )
  })
}

function sendOwnerShutdownAt(socketPath: string, token: string) {
  return new Promise<Record<string, unknown>>((resolvePromise, reject) => {
    const socket = createConnection(socketPath)
    let buffer = ""
    socket.setEncoding("utf8")
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          id: randomUUID(),
          kind: "shutdown",
          sessionId: "integration-rollover",
          token,
        })}\n`
      )
    })
    socket.on("data", (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf("\n")
      if (newline === -1) return
      socket.end()
      resolvePromise(record(JSON.parse(buffer.slice(0, newline))))
    })
    socket.once("error", reject)
  })
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected object, received ${JSON.stringify(value)}`)
  }
  return value
}

function imageContent(value: Record<string, unknown>) {
  if (!Array.isArray(value.content)) return undefined
  const image = value.content.find(
    (item) =>
      isRecord(item) &&
      item.type === "image" &&
      typeof item.data === "string" &&
      item.mimeType === "image/png"
  )
  if (!isRecord(image) || typeof image.data !== "string") return undefined
  return { data: image.data, mimeType: "image/png" as const }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(
      `Assertion failed: ${message}; expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
    )
  }
}

function assertThrows(operation: () => unknown, message: string) {
  let threw = false
  try {
    operation()
  } catch {
    threw = true
  }
  assert(threw, message)
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1_000
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(5)
  }
  throw new Error(`Timed out waiting for ${message}.`)
}

async function sendAbandonedOwnerSession() {
  const token = await readOwnerToken()
  return new Promise<void>((resolve, reject) => {
    const socket = createConnection(ownerSocket)
    let buffer = ""
    socket.setEncoding("utf8")
    socket.setTimeout(2_000)
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          id: randomUUID(),
          kind: "call",
          sessionId: `abandoned-${randomUUID()}`,
          token,
          tool: "browser_status",
          input: {},
        })}\n`
      )
    })
    socket.on("data", (chunk) => {
      buffer += chunk
      if (!buffer.includes("\n")) return
      socket.end()
      resolve()
    })
    socket.once("timeout", () => {
      socket.destroy()
      reject(new Error("Timed out creating abandoned owner session fixture."))
    })
    socket.once("error", reject)
  })
}

async function readOwnerToken() {
  const control = record(
    JSON.parse(await readFile(`${ownerSocket}.control.json`, "utf8"))
  )
  assert(typeof control.token === "string", "owner control token is available")
  return control.token
}

function stringEnvironment(environment: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  )
}
