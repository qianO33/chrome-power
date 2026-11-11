import { randomUUID } from "node:crypto"

import { BrowserCallScheduler } from "./browser-call-scheduler.js"
import type { BrowserRuntime } from "./browser-runtime.js"
import { BrowserTargetManager } from "./browser-target-manager.js"
import {
  DEFAULT_MAX_CONCURRENT_CALLS,
  DEFAULT_MAX_DIAGNOSTIC_WAITS,
  DEFAULT_MAX_QUEUED_CALLS,
  type BrowserCallLimitConfig,
} from "./config.js"
import type {
  BrowserTargetData,
  BrowserTargetOperation,
  BrowserTargetSummary,
  CloseData,
  StatusData,
  ToolResult,
} from "./contracts.js"
import { BrowserToolError, failResult } from "./errors.js"
import {
  ownerEndpointLabel,
  type OwnerEndpoint,
} from "./owner-ipc.js"
import {
  callBrowserTool,
  browserToolForRuntimeMethod,
  isContextGlobalBrowserToolCall,
  isLockFreeDiagnosticWaitCall,
  isTabScopedBrowserTool,
  parseBrowserToolInput,
  requiresExistingTab,
  type BrowserToolCallContext,
  type BrowserToolName,
} from "./tools.js"

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1_000
const DEFAULT_LOCK_TIMEOUT_MS = 120_000

type PreparedCall = {
  input: Record<string, unknown>
  injectedTabId: boolean
}

type TargetSelection = {
  management?: boolean
  overview?: boolean
  targetId?: string
  runtime?: BrowserRuntime
}

type TabRecord = Record<string, unknown> & {
  id: string
}

type SessionState = {
  selectedTargetId?: string
  activeTabByTarget: Map<string, string>
  lastSeenAt: number
}

type BrowserSessionRouterOptions = {
  endpoint?: OwnerEndpoint
  sessionTtlMs?: number
  lockTimeoutMs?: number
  browserCallLimits?: BrowserCallLimitConfig
  targetManager?: BrowserTargetManager
}

export class BrowserSessionRouter {
  private readonly sessions = new Map<string, SessionState>()
  private readonly coordinators = new Map<string, SharedExclusiveCoordinator>()
  private readonly sessionLocks: KeyedMutex
  private readonly tabLocks: KeyedMutex
  private readonly scheduler: BrowserCallScheduler
  private readonly sessionTtlMs: number
  private readonly lockTimeoutMs: number
  private readonly targetManager?: BrowserTargetManager
  private readonly removeTargetListener?: () => void

  constructor(
    private readonly runtime: BrowserRuntime,
    private readonly options: BrowserSessionRouterOptions = {}
  ) {
    this.targetManager = options.targetManager
    this.removeTargetListener = this.targetManager?.addDisconnectListener(
      (targetId) => this.clearTargetBindings(targetId)
    )
    const lockTimeoutMs =
      options.lockTimeoutMs ??
      parsePositiveEnv("CHROME_POWER_LOCK_TIMEOUT_MS") ??
      DEFAULT_LOCK_TIMEOUT_MS
    const browserCallLimits = options.browserCallLimits ?? {
      maxConcurrentCalls: DEFAULT_MAX_CONCURRENT_CALLS,
      maxQueuedCalls: DEFAULT_MAX_QUEUED_CALLS,
      maxDiagnosticWaits: DEFAULT_MAX_DIAGNOSTIC_WAITS,
    }
    this.sessionTtlMs =
      options.sessionTtlMs ??
      parsePositiveEnv("CHROME_POWER_SESSION_TTL_MS") ??
      DEFAULT_SESSION_TTL_MS
    this.lockTimeoutMs = lockTimeoutMs
    this.coordinators.set(
      "power",
      new SharedExclusiveCoordinator(lockTimeoutMs)
    )
    this.sessionLocks = new KeyedMutex(lockTimeoutMs)
    this.tabLocks = new KeyedMutex(lockTimeoutMs)
    this.scheduler = new BrowserCallScheduler({
      ...browserCallLimits,
      queueWaitTimeoutMs: lockTimeoutMs,
    })
  }

  async call(
    clientSessionId: string,
    tool: BrowserToolName,
    input: unknown = {},
    context: BrowserToolCallContext = {}
  ): Promise<ToolResult> {
    const parsed = parseBrowserToolInput(this.runtime, tool, input)
    if (!parsed.ok) {
      const requestedTargetId =
        isRecord(input) && typeof input.targetId === "string"
          ? input.targetId
          : undefined
      return requestedTargetId == null
        ? parsed.result
        : { ...parsed.result, targetId: requestedTargetId }
    }
    const record = parsed.input
    const dialogHandle = isDialogHandleCall(tool, record)
    const diagnosticWait = isLockFreeDiagnosticWaitCall(tool, record)
    const operation = () => {
      if (
        dialogHandle ||
        this.canRunDiagnosticWaitWithoutLocks(clientSessionId, tool, record)
      ) {
        return this.callForSession(clientSessionId, tool, record)
      }
      return this.sessionLocks.run(
        this.sessionLockKey(clientSessionId, record),
        () => this.callForSession(clientSessionId, tool, record)
      )
    }

    try {
      const result = dialogHandle
        ? await this.scheduler.runUrgent(operation, context.signal)
        : await this.scheduler.run(
            {
              lane: diagnosticWait ? "diagnostic_wait" : "regular",
              mode: isContextGlobalBrowserToolCall(tool, record)
                ? "exclusive"
                : "shared",
              resourceKeys: this.schedulingResourceKeys(
                clientSessionId,
                tool,
                record,
                diagnosticWait
              ),
              signal: context.signal,
            },
            operation
          )
      return this.decorateResourceProtection(tool, result)
    } catch (error) {
      return operationFailure(
        this.runtime,
        error,
        typeof record.targetId === "string"
          ? record.targetId
          : this.targetIdForRecord(clientSessionId, record)
      )
    }
  }

  private async callForSession(
    clientSessionId: string,
    tool: BrowserToolName,
    record: Record<string, unknown>
  ): Promise<ToolResult> {
    this.pruneExpiredSessions()
    this.touchSession(clientSessionId)
    const selection = await this.resolveTargetSelection(
      clientSessionId,
      tool,
      record
    )
    if (selection.management) {
      const managementTargetId = this.targetIdForRecord(
        clientSessionId,
        record
      )
      const managementAction = record.action
      const runManagement = async () =>
        this.callTargetManagement(clientSessionId, record)
      // Connect/disconnect mutate one target's connection and list reads its
      // state. Coordinate those operations with ordinary calls on that same
      // target, while leaving unrelated targets independent.
      const managed =
        typeof managementAction === "string" &&
        managementAction !== "select" &&
        (typeof record.targetId === "string" ||
          this.targetManager?.hasTarget(managementTargetId))
          ? await (managementAction === "connect" ||
              managementAction === "disconnect"
              ? this.coordinatorFor(managementTargetId).runExclusive(
                  runManagement
                )
              : this.coordinatorFor(managementTargetId).runShared(
                  runManagement
                ))
          : await runManagement()
      return this.decorateResult(
        clientSessionId,
        tool,
        managed,
        record,
        typeof record.targetId === "string"
          ? record.targetId
          : this.sessions.get(clientSessionId)?.selectedTargetId,
        this.sessions.size,
        0
      )
    }
    if (selection.overview) {
      const overview = await this.statusOverview(clientSessionId)
      return this.decorateResult(
        clientSessionId,
        tool,
        overview,
        record,
        undefined,
        this.sessions.size,
        0
      )
    }
    const targetId = selection.targetId as string
    const runtime = selection.runtime as BrowserRuntime
    const exclusive = isContextGlobalBrowserToolCall(tool, record)
    const lockFreeDiagnosticWait =
      isLockFreeDiagnosticWaitCall(tool, record) &&
      (typeof record.tabId === "string" ||
        this.activeTab(clientSessionId, targetId) != null)

    const run = lockFreeDiagnosticWait
      ? (operation: () => Promise<ToolResult>) => operation()
      : exclusive
      ? (operation: () => Promise<ToolResult>) =>
          this.coordinatorFor(targetId).runExclusive(operation)
      : (operation: () => Promise<ToolResult>) =>
          this.coordinatorFor(targetId).runShared(operation)

    try {
      return await run(async () => {
        this.pruneExpiredSessions()
        this.touchSession(clientSessionId)
        const affectedSessionCount = this.sessions.size
        const affectedTabCount = exclusive
          ? await this.currentTabCount(runtime)
          : 0

        if (
          isTabAction(tool, record, "close") &&
          record.all === true &&
          (runtime.mode === "attach" || affectedSessionCount > 1) &&
          record.confirmed !== true
        ) {
          const reason =
            runtime.mode === "attach"
              ? "Closing all tabs in an attached Chrome requires confirmed: true."
              : `Closing the shared browser would affect ${affectedSessionCount} active sessions; confirmed: true is required.`
          return this.decorateResult(
            clientSessionId,
            tool,
            invalidRequest(
              runtime,
              reason
            ),
            record,
            targetId,
            affectedSessionCount,
            affectedTabCount
          )
        }

        let prepared = await this.prepareCall(
          clientSessionId,
          tool,
          record,
          targetId,
          runtime
        )
        const execute = async () => {
          let result = await callBrowserTool(runtime, tool, prepared.input)
          if (tool === "browser_status" && this.targetManager) {
            result = await this.addTargetStatus(result, clientSessionId)
          }

          if (
            result.error?.code === "tab_not_found" &&
            prepared.injectedTabId &&
            !hasExplicitTabId(record)
          ) {
            this.setActiveTab(clientSessionId, undefined, targetId)
            prepared = await this.prepareCall(
              clientSessionId,
              tool,
              record,
              targetId,
              runtime
            )
            result = await callBrowserTool(runtime, tool, prepared.input)
          }

          this.updateSessionBinding(
            clientSessionId,
            tool,
            prepared.input,
            result,
            targetId
          )
          return this.decorateResult(
            clientSessionId,
            tool,
            result,
            prepared.input,
            targetId,
            affectedSessionCount,
            affectedTabCount
          )
        }

        const tabId = lockFreeDiagnosticWait
          ? undefined
          : tabLockId(tool, prepared.input)
        return tabId
          ? this.tabLocks.run(`${targetId}:${tabId}`, execute)
          : execute()
      })
    } catch (error) {
      return operationFailure(this.runtime, error, targetId)
    }
  }

  releaseSession(clientSessionId: string) {
    return this.sessions.delete(clientSessionId)
  }

  dispose() {
    this.removeTargetListener?.()
    this.scheduler.dispose()
  }

  private async resolveTargetSelection(
    clientSessionId: string,
    tool: BrowserToolName,
    record: Record<string, unknown>
  ): Promise<TargetSelection> {
    if (tool === "browser_target") return { management: true }

    const explicitTargetId =
      typeof record.targetId === "string" ? record.targetId : undefined
    const session = this.touchSession(clientSessionId)
    const selectedTargetId = session.selectedTargetId

    if (tool === "browser_status" && !explicitTargetId && !selectedTargetId) {
      return this.targetManager ? { overview: true } : {
        targetId: "power",
        runtime: this.runtime,
      }
    }

    if (
      this.targetManager?.hasAttachTargets &&
      !explicitTargetId &&
      !selectedTargetId
    ) {
      throw new BrowserToolError(
        "target_not_selected",
        "Select a browser target before using browser tools."
      )
    }

    const targetId = explicitTargetId ?? selectedTargetId ?? "power"
    if (this.targetManager) {
      if (!this.targetManager.hasTarget(targetId)) {
        throw new BrowserToolError(
          "target_not_found",
          `Unknown browser target: ${targetId}`
        )
      }
      const runtime = this.targetManager.runtimeFor(targetId)
      if (!runtime) {
        throw new BrowserToolError(
          "target_unavailable",
          "The selected Chrome target is unavailable. Connect it explicitly before use."
        )
      }
      if (
        this.targetManager.modeFor(targetId) === "attach" &&
        !runtime.isConnected &&
        tool !== "browser_status"
      ) {
        throw new BrowserToolError(
          "target_unavailable",
          "The selected Chrome target is not connected. Use browser_target connect with confirmed: true."
        )
      }
      return { targetId, runtime }
    }

    if (targetId !== "power") {
      throw new BrowserToolError(
        "target_not_found",
        `Unknown browser target: ${targetId}`
      )
    }
    return { targetId: "power", runtime: this.runtime }
  }

  private async callTargetManagement(
    clientSessionId: string,
    record: Record<string, unknown>
  ): Promise<ToolResult> {
    const action = record.action as BrowserTargetOperation["action"]
    const targetId =
      typeof record.targetId === "string" ? record.targetId : undefined
    const session = this.touchSession(clientSessionId)

    if (!this.targetManager) {
      return this.callLegacyTargetManagement(clientSessionId, action, targetId, record)
    }

    if (action === "list") {
      if (targetId && !this.targetManager.hasTarget(targetId)) {
        return operationFailure(
          this.runtime,
          new BrowserToolError("target_not_found", `Unknown browser target: ${targetId}`)
        )
      }
      const data = await this.targetManager.targetData(
        action,
        session.selectedTargetId,
        targetId
      )
      return targetSuccess(this.runtime, data)
    }

    if (!targetId) {
      return operationFailure(
        this.runtime,
        new BrowserToolError(
          "invalid_request",
          `${action} requires targetId.`
        )
      )
    }
    if (action === "select") {
      if (!this.targetManager.hasTarget(targetId)) {
        return operationFailure(
          this.runtime,
          new BrowserToolError("target_not_found", `Unknown browser target: ${targetId}`)
        )
      }
      session.selectedTargetId = targetId
      return targetSuccess(
        this.runtime,
        await this.targetManager.targetData(action, targetId, targetId),
        targetId
      )
    }

    if (record.confirmed !== true) {
      return operationFailure(
        this.runtime,
        new BrowserToolError(
          "invalid_request",
          `${action} requires confirmed: true.`
        )
      )
    }

    try {
      if (action === "connect") {
        await this.targetManager.connectTarget(targetId)
      } else {
        await this.targetManager.disconnectTarget(targetId)
      }
      if (action === "disconnect") this.clearTargetBindings(targetId)
      return targetSuccess(
        this.runtime,
        await this.targetManager.targetData(
          action,
          session.selectedTargetId,
          targetId
        ),
        targetId
      )
    } catch (error) {
      return operationFailure(this.runtime, error, targetId)
    }
  }

  private async callLegacyTargetManagement(
    clientSessionId: string,
    action: BrowserTargetOperation["action"],
    targetId: string | undefined,
    record: Record<string, unknown>
  ): Promise<ToolResult> {
    const session = this.touchSession(clientSessionId)
    if (action === "list") {
      if (targetId != null && targetId !== "power") {
        return operationFailure(
          this.runtime,
          new BrowserToolError(
            "target_not_found",
            `Unknown browser target: ${targetId}`
          )
        )
      }
      const status = await this.runtime.status()
      return targetSuccess(this.runtime, {
        action,
        selectedTargetId: session.selectedTargetId ?? "power",
        targets: [legacyPowerSummary(status)],
      })
    }
    if (targetId !== "power") {
      return operationFailure(
        this.runtime,
        new BrowserToolError("target_not_found", `Unknown browser target: ${targetId ?? ""}`)
      )
    }
    if (action === "select") {
      session.selectedTargetId = "power"
      return targetSuccess(this.runtime, {
        action,
        selectedTargetId: "power",
        targets: [legacyPowerSummary(await this.runtime.status())],
      })
    }
    if (record.confirmed !== true) {
      return operationFailure(
        this.runtime,
        new BrowserToolError("invalid_request", `${action} requires confirmed: true.`)
      )
    }
    if (action === "connect") {
      const result = await this.runtime.connect()
      if (!result.ok) return { ...result, targetId: "power" }
    } else {
      await this.runtime.dispose()
    }
    return targetSuccess(this.runtime, {
      action,
      selectedTargetId: session.selectedTargetId ?? "power",
      targets: [legacyPowerSummary(await this.runtime.status())],
    }, "power")
  }

  private async statusOverview(clientSessionId: string): Promise<ToolResult> {
    const result = await this.runtime.status()
    return this.addTargetStatus(result, clientSessionId)
  }

  private async addTargetStatus(result: ToolResult, clientSessionId: string) {
    if (!this.targetManager || !result.ok || !isRecord(result.data)) return result
    const session = this.touchSession(clientSessionId)
    return {
      ...result,
      data: {
        ...result.data,
        selectedTargetId: session.selectedTargetId,
        targets: await this.targetManager.listTargets(),
      },
    }
  }

  private targetIdForRecord(
    clientSessionId: string,
    input: Record<string, unknown>
  ) {
    const explicit = typeof input.targetId === "string" ? input.targetId : undefined
    return (
      explicit ??
      this.sessions.get(clientSessionId)?.selectedTargetId ??
      this.targetManager?.defaultTargetId ??
      "power"
    )
  }

  private sessionLockKey(
    clientSessionId: string,
    input: Record<string, unknown>
  ) {
    return `${clientSessionId}:${this.targetIdForRecord(clientSessionId, input)}`
  }

  private coordinatorFor(targetId: string) {
    let coordinator = this.coordinators.get(targetId)
    if (!coordinator) {
      coordinator = new SharedExclusiveCoordinator(this.lockTimeoutMs)
      this.coordinators.set(targetId, coordinator)
    }
    return coordinator
  }

  private clearTargetBindings(targetId: string) {
    for (const session of this.sessions.values()) {
      session.activeTabByTarget.delete(targetId)
    }
  }

  private canRunDiagnosticWaitWithoutLocks(
    clientSessionId: string,
    tool: BrowserToolName,
    input: Record<string, unknown>
  ) {
    const targetId = this.targetIdForRecord(clientSessionId, input)
    return (
      isLockFreeDiagnosticWaitCall(tool, input) &&
      (typeof input.tabId === "string" ||
        this.activeTab(clientSessionId, targetId) != null)
    )
  }

  private async prepareCall(
    clientSessionId: string,
    tool: BrowserToolName,
    record: Record<string, unknown>,
    targetId: string,
    runtime: BrowserRuntime
  ): Promise<PreparedCall> {
    const cleanRecord = withoutTargetId(record)
    const allowAutoCreate = runtime.mode !== "attach"
    if (
      runtime.mode === "attach" &&
      record.tabId == null &&
      this.activeTab(clientSessionId, targetId) == null &&
      requiresAttachTabBinding(tool, record)
    ) {
      throw new BrowserToolError(
        "tab_not_found",
        "Select an existing tab before using this operation; use newTab: true for navigation to a new tab."
      )
    }
    if (isNavigationAction(tool, record, "open")) {
      if (record.tabId == null && record.newTab !== true) {
        const activeTabId = this.activeTab(clientSessionId, targetId)
        if (activeTabId) {
          return {
            input: { ...cleanRecord, tabId: activeTabId },
            injectedTabId: true,
          }
        }
        if (!allowAutoCreate) {
          return { input: cleanRecord, injectedTabId: false }
        }
        return {
          input: { ...cleanRecord, newTab: true },
          injectedTabId: false,
        }
      }
      return { input: cleanRecord, injectedTabId: false }
    }

    if (isTabAction(tool, record, "close")) {
      if (record.all !== true && record.tabId == null) {
        const activeTabId = this.activeTab(clientSessionId, targetId)
        if (activeTabId) {
          return {
            input: { ...cleanRecord, tabId: activeTabId },
            injectedTabId: true,
          }
        }
      }
      return { input: cleanRecord, injectedTabId: false }
    }

    if (isTabAction(tool, record, "current") && record.tabId == null) {
      const activeTabId =
        this.activeTab(clientSessionId, targetId) ??
        (allowAutoCreate
          ? await this.createSessionTab(clientSessionId, targetId, runtime)
          : undefined)
      if (activeTabId) {
        return {
          input: { ...cleanRecord, tabId: activeTabId },
          injectedTabId: true,
        }
      }
    }

    if (requiresExistingTab(tool) && record.tabId == null) {
      const activeTabId = this.activeTab(clientSessionId, targetId)
      if (activeTabId) {
        return {
          input: { ...cleanRecord, tabId: activeTabId },
          injectedTabId: true,
        }
      }
      return { input: cleanRecord, injectedTabId: false }
    }

    if (isTabScopedBrowserTool(tool) && record.tabId == null) {
      const activeTabId =
        this.activeTab(clientSessionId, targetId) ??
        (allowAutoCreate
          ? await this.createSessionTab(clientSessionId, targetId, runtime)
          : undefined)
      if (activeTabId) {
        return {
          input: { ...cleanRecord, tabId: activeTabId },
          injectedTabId: true,
        }
      }
    }

    return { input: cleanRecord, injectedTabId: false }
  }

  private async createSessionTab(
    clientSessionId: string,
    targetId: string,
    runtime: BrowserRuntime
  ) {
    const result = await callBrowserTool(runtime, "browser_navigation", {
      action: "open",
      url: "about:blank",
      newTab: true,
    })
    if (result.ok && result.tabId) {
      this.setActiveTab(clientSessionId, result.tabId, targetId)
      return result.tabId
    }
    return undefined
  }

  private updateSessionBinding(
    clientSessionId: string,
    tool: BrowserToolName,
    input: Record<string, unknown>,
    result: ToolResult,
    targetId: string
  ) {
    if (!result.ok) return

    if (isTabAction(tool, input, "close")) {
      const closed = closedTabsFromResult(result)
      if (input.all === true) {
        for (const session of this.sessions.values()) {
          session.activeTabByTarget.delete(targetId)
        }
      } else if (closed.length > 0) {
        for (const session of this.sessions.values()) {
          const activeTabId = session.activeTabByTarget.get(targetId)
          if (activeTabId && closed.includes(activeTabId)) {
            session.activeTabByTarget.delete(targetId)
          }
        }
      }
      return
    }

    if (
      (tool === "browser_device" || tool === "browser_emulation") &&
      input.action === "set"
    ) {
      if (isRecord(result.data) && result.data.relaunched === true) {
        for (const session of this.sessions.values()) {
          session.activeTabByTarget.delete(targetId)
        }
      }
    }

    if (isTabAction(tool, input, "select") && typeof input.tabId === "string") {
      this.setActiveTab(clientSessionId, input.tabId, targetId)
      return
    }

    if (result.tabId) {
      this.setActiveTab(clientSessionId, result.tabId, targetId)
    }
  }

  private decorateResult(
    clientSessionId: string,
    tool: BrowserToolName,
    result: ToolResult,
    input: Record<string, unknown>,
    targetId: string | undefined,
    affectedSessionCount: number,
    affectedTabCount: number
  ): ToolResult {
    if (!result.ok) return { ...result, targetId }
    const activeTabId = this.activeTab(clientSessionId, targetId)
    if (!isRecord(result.data)) return result
    let data: Record<string, unknown> = result.data

    if (isTabInfo(data)) {
      data = decorateTab(data, activeTabId)
    } else if (Array.isArray(data.tabs)) {
      data = {
        ...data,
        tabs: data.tabs.map((tab: unknown) =>
          isTabInfo(tab) ? decorateTab(tab, activeTabId) : tab
        ),
      }
    }

    if (
      isTabAction(tool, input, "close") &&
      input.all === true &&
      Array.isArray(data.closed)
    ) {
      const closeData: CloseData = {
        ...data,
        closed: data.closed.filter(
          (value): value is string => typeof value === "string"
        ),
        affected: {
          sessionCount: affectedSessionCount,
          tabCount: data.closed.length,
        },
      }
      data = closeData
    }

    if (
      (tool === "browser_device" || tool === "browser_emulation") &&
      input.action === "set" &&
      data.relaunched === true
    ) {
      data = {
        ...data,
        affected: {
          sessionCount: affectedSessionCount,
          tabCount: affectedTabCount,
        },
      }
    }

    if (tool === "browser_offline" && input.action === "set") {
      data = {
        ...data,
        affected: {
          sessionCount: affectedSessionCount,
          tabCount: affectedTabCount,
        },
      }
    }

    if (tool === "browser_status" && this.options.endpoint) {
      data = {
        ...data,
        owner: {
          transport: this.options.endpoint.kind,
          endpoint: ownerEndpointLabel(this.options.endpoint),
          activeSessionCount: this.sessions.size,
          globalOperationInProgress: targetId == null
            ? [...this.coordinators.values()].some(
                (coordinator) => coordinator.globalOperationInProgress
              )
            : this.coordinatorFor(targetId).globalOperationInProgress,
        },
      }
    }

    return {
      ...result,
      targetId,
      data: {
        ...data,
        clientSession: {
          id: clientSessionId,
          selectedTargetId: this.sessions.get(clientSessionId)?.selectedTargetId,
          activeTabId,
        },
      },
    }
  }

  private activeTab(clientSessionId: string, targetId = "power") {
    return this.sessions.get(clientSessionId)?.activeTabByTarget.get(targetId)
  }

  private setActiveTab(
    clientSessionId: string,
    activeTabId: string | undefined,
    targetId = "power"
  ) {
    const session = this.touchSession(clientSessionId)
    if (activeTabId == null) session.activeTabByTarget.delete(targetId)
    else session.activeTabByTarget.set(targetId, activeTabId)
  }

  private touchSession(clientSessionId: string) {
    const existing = this.sessions.get(clientSessionId)
    if (existing) {
      existing.lastSeenAt = Date.now()
      return existing
    }
    const session: SessionState = {
      selectedTargetId: this.targetManager?.defaultTargetId,
      activeTabByTarget: new Map(),
      lastSeenAt: Date.now(),
    }
    this.sessions.set(clientSessionId, session)
    return session
  }

  private pruneExpiredSessions() {
    const cutoff = Date.now() - this.sessionTtlMs
    for (const [sessionId, session] of this.sessions) {
      if (session.lastSeenAt < cutoff) this.sessions.delete(sessionId)
    }
  }

  private async currentTabCount(runtime: BrowserRuntime) {
    const status = await runtime.status()
    return status.ok && status.data ? status.data.tabCount : 0
  }

  private schedulingResourceKeys(
    clientSessionId: string,
    tool: BrowserToolName,
    input: Record<string, unknown>,
    diagnosticWait: boolean
  ) {
    if (diagnosticWait) return []
    const targetId = this.targetIdForRecord(clientSessionId, input)
    const keys = [`session:${clientSessionId}:${targetId}`]
    const explicitTabId =
      typeof input.tabId === "string" ? input.tabId : undefined
    const activeTabId = this.callUsesActiveTab(tool, input)
      ? this.activeTab(clientSessionId, targetId)
      : undefined
    const tabId = explicitTabId ?? activeTabId
    if (tabId) keys.push(`tab:${targetId}:${tabId}`)
    return keys
  }

  private callUsesActiveTab(
    tool: BrowserToolName,
    input: Record<string, unknown>
  ) {
    if (isTabScopedBrowserTool(tool)) {
      return !isNavigationAction(tool, input, "open") || input.newTab !== true
    }
    return (
      isTabAction(tool, input, "current") ||
      (isTabAction(tool, input, "close") && input.all !== true)
    )
  }

  private decorateResourceProtection(
    tool: BrowserToolName,
    result: ToolResult
  ): ToolResult {
    if (tool !== "browser_status" || !result.ok || !isRecord(result.data)) {
      return result
    }
    const memory = process.memoryUsage()
    return {
      ...result,
      data: {
        ...result.data,
        resourceProtection: {
          ...this.scheduler.snapshot(),
          memory: {
            rssBytes: memory.rss,
            heapTotalBytes: memory.heapTotal,
            heapUsedBytes: memory.heapUsed,
            externalBytes: memory.external,
            arrayBuffersBytes: memory.arrayBuffers,
          },
        },
      },
    }
  }
}

export function createSessionRouterRuntimeProxy(
  runtime: BrowserRuntime,
  options: BrowserSessionRouterOptions = {}
) {
  const router = new BrowserSessionRouter(runtime, options)
  const clientSessionId = `direct-${randomUUID()}`
  return new Proxy(
    {
      sessionId: runtime.sessionId,
      dispose: async () => {
        router.releaseSession(clientSessionId)
        router.dispose()
        if (options.targetManager) await options.targetManager.dispose()
        else await runtime.dispose()
      },
    },
    {
      get(target, property) {
        if (property in target) {
          return target[property as keyof typeof target]
        }
        if (typeof property !== "string") return undefined
        const tool = browserToolForRuntimeMethod(property)
        if (!tool) return undefined
        return (
          input: unknown = {},
          context: BrowserToolCallContext = {}
        ) => router.call(clientSessionId, tool, input, context)
      },
    }
  ) as unknown as BrowserRuntime
}

function withoutTargetId(record: Record<string, unknown>) {
  const { targetId: _targetId, ...rest } = record
  return rest
}

function targetSuccess(
  runtime: BrowserRuntime,
  data: BrowserTargetData,
  targetId?: string
): ToolResult<BrowserTargetData> {
  return {
    ok: true,
    sessionId: runtime.sessionId,
    targetId,
    data,
  }
}

function legacyPowerSummary(result: ToolResult): BrowserTargetSummary {
  const status = result.ok && isRecord(result.data) ? result.data : undefined
  const connected = status?.contextLaunched === true
  return {
    id: "power",
    label: "chrome-power",
    browser: "chrome",
    mode: "launch",
    state: connected ? "connected" : "available",
    connected,
    ...(typeof status?.tabCount === "number"
      ? { tabCount: status.tabCount }
      : {}),
    capabilities: {
      attach: ["tabs", "navigation", "snapshots", "interaction", "screenshots", "diagnostics"],
      unsupported: [],
    },
  }
}

function tabLockId(tool: BrowserToolName, input: Record<string, unknown>) {
  if (isDialogHandleCall(tool, input)) return undefined
  if (typeof input.tabId === "string") return input.tabId
  return undefined
}

function isDialogHandleCall(tool: BrowserToolName, input: unknown) {
  return (
    tool === "browser_dialog" && isRecord(input) && input.action === "handle"
  )
}

function isNavigationAction(
  tool: BrowserToolName,
  input: Record<string, unknown>,
  action: string
) {
  return tool === "browser_navigation" && input.action === action
}

function isTabAction(
  tool: BrowserToolName,
  input: Record<string, unknown>,
  action: string
) {
  return tool === "browser_tab" && input.action === action
}

function requiresAttachTabBinding(
  tool: BrowserToolName,
  input: Record<string, unknown>
) {
  if (isNavigationAction(tool, input, "open") && input.newTab === true) {
    return false
  }
  if (isTabAction(tool, input, "list")) return false
  if (isTabAction(tool, input, "select")) return false
  if (isTabAction(tool, input, "close") && input.all === true) return false
  return (
    isTabScopedBrowserTool(tool) ||
    isTabAction(tool, input, "current") ||
    isTabAction(tool, input, "close")
  )
}

function hasExplicitTabId(value: unknown) {
  return isRecord(value) && typeof value.tabId === "string"
}

function closedTabsFromResult(result: ToolResult) {
  if (!isRecord(result.data)) return []
  if (!Array.isArray(result.data.closed)) return []
  return result.data.closed.filter(
    (value): value is string => typeof value === "string"
  )
}

function decorateTab(tab: TabRecord, activeTabId?: string) {
  return {
    ...tab,
    sessionActive: tab.id === activeTabId,
  }
}

function isTabInfo(value: unknown): value is TabRecord {
  return isRecord(value) && typeof value.id === "string"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value)
}

function invalidRequest(runtime: BrowserRuntime, message: string): ToolResult {
  return {
    ok: false,
    sessionId: runtime.sessionId,
    error: {
      code: "invalid_request",
      message,
    },
  }
}

function operationFailure(
  runtime: BrowserRuntime,
  error: unknown,
  targetId?: string
): ToolResult {
  const result = failResult(runtime.sessionId, error)
  return targetId == null ? result : { ...result, targetId }
}

function parsePositiveEnv(name: string) {
  const value = process.env[name]
  if (value == null || value === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

type LockMode = "shared" | "exclusive"

type LockWaiter = {
  mode: LockMode
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

class SharedExclusiveCoordinator {
  private activeShared = 0
  private exclusiveActive = false
  private readonly waiters: LockWaiter[] = []

  constructor(private readonly timeoutMs: number) {}

  get globalOperationInProgress() {
    return (
      this.exclusiveActive ||
      this.waiters.some((waiter) => waiter.mode === "exclusive")
    )
  }

  async runShared<T>(operation: () => Promise<T>) {
    const release = await this.acquire("shared")
    try {
      return await operation()
    } finally {
      release()
    }
  }

  async runExclusive<T>(operation: () => Promise<T>) {
    const release = await this.acquire("exclusive")
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private acquire(mode: LockMode) {
    return new Promise<() => void>((resolve, reject) => {
      const waiter: LockWaiter = {
        mode,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(
            new Error(
              `Timed out waiting for ${mode} browser operation lock after ${this.timeoutMs}ms.`
            )
          )
          this.drain()
        }, this.timeoutMs),
      }
      waiter.timer.unref()
      this.waiters.push(waiter)
      this.drain()
    })
  }

  private drain() {
    if (this.exclusiveActive || this.waiters.length === 0) return
    const first = this.waiters[0]
    if (first.mode === "exclusive") {
      if (this.activeShared > 0) return
      this.waiters.shift()
      clearTimeout(first.timer)
      this.exclusiveActive = true
      first.resolve(() => {
        this.exclusiveActive = false
        this.drain()
      })
      return
    }

    while (this.waiters[0]?.mode === "shared" && !this.exclusiveActive) {
      const waiter = this.waiters.shift() as LockWaiter
      clearTimeout(waiter.timer)
      this.activeShared += 1
      let released = false
      waiter.resolve(() => {
        if (released) return
        released = true
        this.activeShared -= 1
        this.drain()
      })
    }
  }
}

class KeyedMutex {
  private readonly locks = new Map<string, Mutex>()

  constructor(private readonly timeoutMs: number) {}

  async run<T>(key: string, operation: () => Promise<T>) {
    const mutex = this.locks.get(key) ?? new Mutex(this.timeoutMs)
    this.locks.set(key, mutex)
    try {
      return await mutex.run(operation)
    } finally {
      if (mutex.idle) this.locks.delete(key)
    }
  }
}

class Mutex {
  private locked = false
  private readonly waiters: Array<{
    resolve: (release: () => void) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }> = []

  constructor(private readonly timeoutMs: number) {}

  get idle() {
    return !this.locked && this.waiters.length === 0
  }

  async run<T>(operation: () => Promise<T>) {
    const release = await this.acquire()
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private acquire() {
    return new Promise<() => void>((resolve, reject) => {
      if (!this.locked) {
        this.locked = true
        resolve(() => this.release())
        return
      }
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(
            new Error(
              `Timed out waiting for tab operation lock after ${this.timeoutMs}ms.`
            )
          )
        }, this.timeoutMs),
      }
      waiter.timer.unref()
      this.waiters.push(waiter)
    })
  }

  private release() {
    const waiter = this.waiters.shift()
    if (!waiter) {
      this.locked = false
      return
    }
    clearTimeout(waiter.timer)
    waiter.resolve(() => this.release())
  }
}
