import { join } from "node:path"

import { BrowserRuntime } from "./browser-runtime.js"
import type { RuntimeConfig } from "./config.js"
import {
  type BrowserTargetData,
  type BrowserTargetDefinition,
  type BrowserTargetSummary,
  type BrowserTargetState,
  type ToolResult,
} from "./contracts.js"
import { BrowserToolError, failResult } from "./errors.js"
import { TargetEndpointError } from "./browser-targets.js"

const ATTACH_CAPABILITIES = [
  "tabs",
  "navigation",
  "snapshots",
  "interaction",
  "screenshots",
  "popups",
  "diagnostics",
] as const

const ATTACH_UNSUPPORTED = [
  "device_presets",
  "launch_time_emulation",
  "raw_cdp",
  "arbitrary_evaluate",
  "credential_storage_readback",
] as const

type TargetRecord = {
  id: string
  label: string
  browser: "chrome"
  mode: "launch" | "attach"
  definition?: BrowserTargetDefinition
  runtime: BrowserRuntime
  state: BrowserTargetState
  connectPromise?: Promise<BrowserRuntime>
}

export type BrowserTargetDisconnectListener = (targetId: string) => void

/** Owns the independent runtime/context lifecycle for every named target. */
export class BrowserTargetManager {
  readonly powerRuntime: BrowserRuntime
  private readonly records = new Map<string, TargetRecord>()
  private readonly disconnectListeners = new Set<BrowserTargetDisconnectListener>()

  constructor(private readonly config: RuntimeConfig) {
    this.powerRuntime = new BrowserRuntime(config, {
      mode: "launch",
      targetId: "power",
    })
    this.records.set("power", {
      id: "power",
      label: "chrome-power",
      browser: "chrome",
      mode: "launch",
      runtime: this.powerRuntime,
      state: "available",
    })

    for (const definition of config.browserTargets?.targets ?? []) {
      this.records.set(definition.id, {
        id: definition.id,
        label: definition.label,
        browser: definition.browser,
        mode: "attach",
        definition,
        runtime: this.createAttachRuntime(definition),
        state: "available",
      })
    }
  }

  get hasAttachTargets() {
    return [...this.records.values()].some((record) => record.mode === "attach")
  }

  get defaultTargetId() {
    if (!this.hasAttachTargets) return "power"
    return this.config.browserTargets?.defaultTargetId
  }

  addDisconnectListener(listener: BrowserTargetDisconnectListener) {
    this.disconnectListeners.add(listener)
    return () => this.disconnectListeners.delete(listener)
  }

  hasTarget(targetId: string) {
    return this.records.has(targetId)
  }

  modeFor(targetId: string) {
    return this.records.get(targetId)?.mode
  }

  runtimeFor(targetId: string) {
    return this.records.get(targetId)?.runtime
  }

  async connectTarget(targetId: string): Promise<BrowserTargetSummary> {
    const record = this.requireRecord(targetId)
    if (record.connectPromise) {
      await record.connectPromise
      return this.summaryForRecord(record)
    }
    record.state = "connecting"
    record.connectPromise = (async () => {
      try {
        const result = await record.runtime.connect()
        if (!result.ok) {
          throw new BrowserToolError(
            result.error?.code === "target_unavailable"
              ? "target_unavailable"
              : "target_connection_failed",
            "Unable to connect to the selected Chrome target."
          )
        }
        record.state = "connected"
        return record.runtime
      } catch (error) {
        record.state =
          error instanceof TargetEndpointError ||
          (error instanceof BrowserToolError &&
            error.code === "target_unavailable")
            ? "unavailable"
            : "error"
        if (error instanceof BrowserToolError) throw error
        if (error instanceof TargetEndpointError) {
          throw new BrowserToolError(
            "target_unavailable",
            "The selected Chrome target is unavailable. Start it with remote debugging enabled, then retry connect."
          )
        }
        if (isUnavailableError(error)) {
          throw new BrowserToolError(
            "target_unavailable",
            "The selected Chrome target is unavailable. Start it with remote debugging enabled, then retry connect."
          )
        }
        throw new BrowserToolError(
          "target_connection_failed",
          "Unable to connect to the selected Chrome target."
        )
      } finally {
        record.connectPromise = undefined
      }
    })()
    await record.connectPromise
    return this.summaryForRecord(record)
  }

  async disconnectTarget(targetId: string) {
    const record = this.requireRecord(targetId)
    if (record.connectPromise) await record.connectPromise.catch(() => undefined)
    await record.runtime.dispose()
    record.state = record.mode === "launch" ? "available" : "disconnected"
    return this.summaryForRecord(record)
  }

  async listTargets(): Promise<BrowserTargetSummary[]> {
    return Promise.all(
      [...this.records.values()].map((record) => this.summaryForRecord(record))
    )
  }

  async targetData(
    action: BrowserTargetData["action"],
    selectedTargetId?: string,
    targetId?: string
  ): Promise<BrowserTargetData> {
    const targets = await this.listTargets()
    const target = targetId
      ? targets.find((entry) => entry.id === targetId)
      : undefined
    return {
      action,
      selectedTargetId,
      targets,
      ...(target ? { target } : {}),
    }
  }

  async dispose() {
    await Promise.all(
      [...this.records.values()].map(async (record) => {
        if (record.connectPromise) {
          await record.connectPromise.catch(() => undefined)
        }
        await record.runtime.dispose().catch(() => undefined)
      })
    )
    for (const record of this.records.values()) {
      record.state = record.mode === "launch" ? "available" : "disconnected"
    }
  }

  private createAttachRuntime(definition: BrowserTargetDefinition) {
    const targetConfig: RuntimeConfig = {
      ...this.config,
      // This is an internal, target-scoped artifact namespace. It is never
      // passed to Chrome and does not create or inspect the user's profile.
      profileDir: join(this.config.profileDir, "targets", definition.id),
      screenshotDir: join(this.config.screenshotDir, "targets", definition.id),
      downloadDir: join(this.config.downloadDir, "targets", definition.id),
      browserTargets: undefined,
      targetsFile: undefined,
      targetConfigFingerprint: undefined,
    }
    return new BrowserRuntime(targetConfig, {
      mode: "attach",
      targetId: definition.id,
      targetDefinition: definition,
      onDisconnected: () => this.handleDisconnected(definition.id),
    })
  }

  private handleDisconnected(targetId: string) {
    const record = this.records.get(targetId)
    if (!record || record.mode !== "attach") return
    if (record.state === "disconnected" || record.state === "unavailable") {
      return
    }
    record.state = "disconnected"
    for (const listener of this.disconnectListeners) {
      try {
        listener(targetId)
      } catch {
        // A routing observer must never turn a browser disconnect event into
        // an uncaught process error.
      }
    }
  }

  private async summaryForRecord(record: TargetRecord) {
    let connected = record.runtime.isConnected
    if (record.mode === "launch" && record.state !== "connecting") {
      record.state = connected ? "connected" : "available"
    }
    if (record.mode === "attach" && connected) record.state = "connected"
    if (record.mode === "attach" && !connected && record.state === "connected") {
      record.state = "disconnected"
    }
    let tabCount: number | undefined
    if (connected) {
      const status = await record.runtime.status()
      if (status.ok && status.data) tabCount = status.data.tabCount
      else {
        connected = false
        if (record.mode === "attach") record.state = "disconnected"
      }
    }
    return {
      id: record.id,
      label: record.label,
      browser: record.browser,
      mode: record.mode,
      state: record.state,
      connected,
      ...(tabCount == null ? {} : { tabCount }),
      capabilities: {
        attach: [...ATTACH_CAPABILITIES],
        unsupported: record.mode === "attach" ? [...ATTACH_UNSUPPORTED] : [],
      },
    } satisfies BrowserTargetSummary
  }

  private requireRecord(targetId: string) {
    const record = this.records.get(targetId)
    if (!record) {
      throw new BrowserToolError(
        "target_not_found",
        `Unknown browser target: ${targetId}`
      )
    }
    return record
  }
}

function isUnavailableError(error: unknown) {
  if (error instanceof BrowserToolError) {
    return error.code === "target_unavailable"
  }
  const message = error instanceof Error ? error.message : String(error)
  return /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|ETIMEDOUT|EACCES|EPERM|ERR_CONNECTION_REFUSED|timed out|timeout/i.test(
    message
  )
}

export function targetFailure(
  sessionId: string,
  error: unknown
): ToolResult {
  return failResult(sessionId, error, "target_connection_failed")
}
