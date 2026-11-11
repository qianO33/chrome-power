import type {
  ConsoleLogEntry,
  ConsoleLogsOptions,
  ConsoleLogWaitOptions,
  ConsoleLogWaitData,
  NetworkEventEntry,
  NetworkEventsOptions,
  NetworkSummaryData,
  NetworkWaitData,
  NetworkWaitEventOptions,
  NetworkSummaryOptions,
  PageErrorEntry,
  PageErrorsOptions,
  PageErrorWaitOptions,
  PageErrorWaitData,
  WebSocketEventEntry,
  WebSocketEventsOptions,
  WebSocketWaitEventOptions,
  WebSocketWaitData,
  WebSocketSummaryOptions,
  WebSocketSummaryData,
} from "./contracts.js"
import {
  waitForBufferedEntry,
  removeBufferedEntry,
  DEFAULT_CONSOLE_LOG_LIMIT,
  DEFAULT_DIAGNOSTIC_EVENT_LIMIT,
  type DiagnosticBuffers,
} from "./diagnostic-buffers.js"
import {
  filterConsoleLogs,
  findNewestConsoleLog,
  filterPageErrors,
  findNewestPageError,
  validateNetworkStatusRange,
  filterNetworkEvents,
  summarizeNetworkEvents,
  filterWebSocketEvents,
  summarizeWebSocketEvents,
} from "./diagnostics-filter.js"

const DEFAULT_TIMEOUT_MS = 30_000

export type ConsoleQueryResult = {
  logs: ConsoleLogEntry[]
  remaining?: ConsoleLogEntry[]
}

export function queryConsoleLogs(
  diagnostics: DiagnosticBuffers,
  tabId: string,
  options: ConsoleLogsOptions
): ConsoleQueryResult {
  const logs = diagnostics.consoleLogsFor(tabId)
  const limit = options.limit ?? DEFAULT_CONSOLE_LOG_LIMIT
  const filtered = filterConsoleLogs(logs, options).slice(-limit)

  if (options.clear) {
    const returned = new Set(filtered)
    return {
      logs: filtered,
      remaining: logs.filter((entry) => !returned.has(entry)),
    }
  }

  return { logs: filtered }
}

export async function waitConsoleLog(
  diagnostics: DiagnosticBuffers,
  tabId: string,
  options: ConsoleLogWaitOptions
): Promise<{ data: ConsoleLogWaitData; entry: ConsoleLogEntry | undefined }> {
  const matchedExisting = Boolean(
    findNewestConsoleLog(diagnostics.consoleLogsFor(tabId), options)
  )
  const entry = await waitForBufferedEntry(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    () => findNewestConsoleLog(diagnostics.consoleLogsFor(tabId), options),
    "console log"
  )
  return {
    data: {
      entry,
      matchedExisting,
      cleared: options.clear === true,
    },
    entry,
  }
}

export type PageErrorQueryResult = {
  errors: PageErrorEntry[]
  remaining?: PageErrorEntry[]
}

export function queryPageErrors(
  diagnostics: DiagnosticBuffers,
  tabId: string,
  options: PageErrorsOptions
): PageErrorQueryResult {
  const errors = diagnostics.pageErrorsFor(tabId)
  const limit = options.limit ?? DEFAULT_DIAGNOSTIC_EVENT_LIMIT
  const filtered = filterPageErrors(errors, options).slice(-limit)

  if (options.clear) {
    const returned = new Set(filtered)
    return {
      errors: filtered,
      remaining: errors.filter((entry) => !returned.has(entry)),
    }
  }

  return { errors: filtered }
}

export async function waitPageError(
  diagnostics: DiagnosticBuffers,
  tabId: string,
  options: PageErrorWaitOptions
): Promise<{ data: PageErrorWaitData; entry: PageErrorEntry | undefined }> {
  const matchedExisting = Boolean(
    findNewestPageError(diagnostics.pageErrorsFor(tabId), options)
  )
  const entry = await waitForBufferedEntry(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    () => findNewestPageError(diagnostics.pageErrorsFor(tabId), options),
    "page error"
  )
  return {
    data: {
      entry,
      matchedExisting,
      cleared: options.clear === true,
    },
    entry,
  }
}

export type NetworkQueryResult = {
  events: NetworkEventEntry[]
  remaining?: NetworkEventEntry[]
}

export function queryNetworkEvents(
  diagnostics: DiagnosticBuffers,
  tabId: string,
  options: NetworkEventsOptions
): NetworkQueryResult {
  validateNetworkStatusRange(options)
  const events = diagnostics.networkEventsFor(tabId)
  const limit = options.limit ?? DEFAULT_DIAGNOSTIC_EVENT_LIMIT
  const filtered = filterNetworkEvents(events, options).slice(-limit)

  if (options.clear) {
    const returned = new Set(filtered)
    return {
      events: filtered,
      remaining: events.filter((entry) => !returned.has(entry)),
    }
  }

  return { events: filtered }
}

export async function waitNetworkEvent(
  diagnostics: DiagnosticBuffers,
  tabId: string,
  options: NetworkWaitEventOptions
): Promise<NetworkWaitData> {
  validateNetworkStatusRange(options)
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const matchedExisting = Boolean(
    diagnostics.findNewestNetworkEvent(tabId, options)
  )
  const event = await waitForBufferedEntry(
    timeout,
    () => diagnostics.findNewestNetworkEvent(tabId, options),
    "network event"
  )
  return {
    event,
    matchedExisting,
    cleared: options.clear === true,
  }
}

export function summarizeNetwork(
  diagnostics: DiagnosticBuffers,
  tabId: string,
  options: NetworkSummaryOptions
): NetworkSummaryData {
  validateNetworkStatusRange(options)
  const events = diagnostics.networkEventsFor(tabId)
  const matchingEvents = filterNetworkEvents(events, options)
  const limit = options.limit ?? DEFAULT_DIAGNOSTIC_EVENT_LIMIT
  const summarizedEvents = matchingEvents.slice(-limit)
  return summarizeNetworkEvents(summarizedEvents, matchingEvents.length, limit)
}

export type WebSocketQueryResult = {
  events: WebSocketEventEntry[]
  remaining?: WebSocketEventEntry[]
}

export function queryWebSocketEvents(
  diagnostics: DiagnosticBuffers,
  tabId: string,
  options: WebSocketEventsOptions
): WebSocketQueryResult {
  const events = diagnostics.webSocketEventsFor(tabId)
  const limit = options.limit ?? DEFAULT_DIAGNOSTIC_EVENT_LIMIT
  const filtered = filterWebSocketEvents(events, options).slice(-limit)

  if (options.clear) {
    const returned = new Set(filtered)
    return {
      events: filtered,
      remaining: events.filter((entry) => !returned.has(entry)),
    }
  }

  return { events: filtered }
}

export async function waitWebSocketEvent(
  diagnostics: DiagnosticBuffers,
  tabId: string,
  options: WebSocketWaitEventOptions
): Promise<WebSocketWaitData> {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const matchedExisting = Boolean(
    diagnostics.findNewestWebSocketEvent(tabId, options)
  )
  const event = await waitForBufferedEntry(
    timeout,
    () => diagnostics.findNewestWebSocketEvent(tabId, options),
    "WebSocket event"
  )
  return {
    event,
    matchedExisting,
    cleared: options.clear === true,
  }
}

export function summarizeWebSocket(
  diagnostics: DiagnosticBuffers,
  tabId: string,
  options: WebSocketSummaryOptions
): WebSocketSummaryData {
  const events = diagnostics.webSocketEventsFor(tabId)
  const matchingEvents = filterWebSocketEvents(events, options)
  const limit = options.limit ?? DEFAULT_DIAGNOSTIC_EVENT_LIMIT
  const summarizedEvents = matchingEvents.slice(-limit)
  return summarizeWebSocketEvents(
    summarizedEvents,
    matchingEvents.length,
    limit
  )
}
