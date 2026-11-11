#!/usr/bin/env node
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { BrowserRuntime } from "../browser-runtime.js"
import { BrowserTargetManager } from "../browser-target-manager.js"
import { loadConfig, type RuntimeConfig } from "../config.js"
import type { BrowserErrorCode, ToolResult } from "../contracts.js"
import { ownerEndpoint } from "../owner-ipc.js"
import { ownerEndpointIsLive } from "../owner-client.js"
import { callBrowserTool } from "../tools.js"
import { createSessionRouterRuntimeProxy } from "../session-router.js"

type BatchStep = {
  tool: string
  arguments: unknown
}

type BatchStepResult = {
  index: number
  tool: string
  result: ToolResult
}

type CliBatchResult = {
  ok: boolean
  sessionId: string
  results: BatchStepResult[]
}

type CliOutput = CliBatchResult | ToolResult

class CliInputError extends Error {
  constructor(
    message: string,
    readonly index?: number
  ) {
    super(message)
    this.name = "CliInputError"
  }
}

let activeRuntime: BrowserRuntime | undefined

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    const exitCode = signal === "SIGINT" ? 130 : 143
    if (!activeRuntime) {
      process.exit(exitCode)
    }
    void activeRuntime.dispose().finally(() => process.exit(exitCode))
  })
}

const { args, pretty } = consumeGlobalFlags(process.argv.slice(2))

if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
  printUsage()
  process.exit(0)
}

let runtime: BrowserRuntime | undefined

try {
  const config = loadCliConfig()
  if (
    args[0] !== "status" &&
    await ownerEndpointIsLive(ownerEndpoint(config))
  ) {
    throw new Error(
      "A chrome-power owner is already running for this profile. Use the MCP server or set CHROME_POWER_PROFILE_DIR (or CHROME_POWER_NAMESPACE) to an isolated runtime before using the direct CLI."
    )
  }
  // Keep the fallback on the same target-aware routing path as the owner and
  // direct MCP server. With no manifest the manager contains only the built-in
  // `power` target, so legacy launch behavior remains unchanged while
  // `browser_target` can still list/select that target in a batch.
  const targetManager = new BrowserTargetManager(config)
  runtime = createSessionRouterRuntimeProxy(targetManager.powerRuntime, {
    targetManager,
    browserCallLimits: config.browserCallLimits,
  })
  activeRuntime = runtime
  const output = await runCommand(runtime, args[0] as string, args.slice(1))
  writeJson(output, pretty)
  process.exitCode = output.ok ? 0 : 1
} catch (error) {
  const output =
    error instanceof CliInputError
      ? inputFailure(error.message, runtime?.sessionId, error.index)
      : inputFailure(
          errorMessage(error),
          runtime?.sessionId,
          undefined,
          "operation_failed"
        )
  writeJson(output, pretty)
  process.exitCode = error instanceof CliInputError ? 2 : 1
} finally {
  activeRuntime = undefined
  await runtime?.dispose()
}

async function runCommand(
  runtime: BrowserRuntime,
  command: string,
  args: string[]
): Promise<CliOutput> {
  switch (command) {
    case "status":
      requireNoArgs(command, args)
      return callBrowserTool(runtime, "browser_status")

    case "open":
      return callBrowserTool(runtime, "browser_navigation", {
        action: "open",
        ...parseOpenArgs(args),
      })

    case "snapshot": {
      const { url, options } = parseSnapshotArgs(args)
      if (!url) return callBrowserTool(runtime, "browser_snapshot", options)
      return runBatch(runtime, [
        { tool: "browser_navigation", arguments: { action: "open", url } },
        { tool: "browser_snapshot", arguments: options },
      ])
    }

    case "screenshot": {
      const { url, options } = parseScreenshotArgs(args)
      if (!url) return callBrowserTool(runtime, "browser_screenshot", options)
      return runBatch(runtime, [
        { tool: "browser_navigation", arguments: { action: "open", url } },
        { tool: "browser_screenshot", arguments: options },
      ])
    }

    case "batch": {
      const { steps, stopOnError } = await parseBatchArgs(args)
      return runBatch(runtime, steps, stopOnError)
    }

    default:
      throw new CliInputError(`Unknown command: ${command}`)
  }
}

async function runBatch(
  runtime: BrowserRuntime,
  steps: BatchStep[],
  stopOnError = true
): Promise<CliBatchResult> {
  const results: BatchStepResult[] = []

  for (const [index, step] of steps.entries()) {
    const result = await callBrowserTool(runtime, step.tool, step.arguments)
    results.push({ index, tool: step.tool, result })

    if (!result.ok && stopOnError) {
      return { ok: false, sessionId: runtime.sessionId, results }
    }
  }

  return {
    ok: results.every((entry) => entry.result.ok),
    sessionId: runtime.sessionId,
    results,
  }
}

function parseOpenArgs(args: string[]) {
  const positionals: string[] = []
  let newTab = false

  for (const arg of args) {
    if (arg === "--new-tab") {
      newTab = true
    } else if (arg.startsWith("--")) {
      throw new CliInputError(`Unknown option for open: ${arg}`)
    } else {
      positionals.push(arg)
    }
  }

  if (positionals.length !== 1) {
    throw new CliInputError("Usage: chrome-power-cli open <url> [--new-tab]")
  }

  return {
    url: positionals[0],
    newTab: newTab || undefined,
  }
}

function parseSnapshotArgs(args: string[]) {
  const positionals: string[] = []
  const options: Record<string, unknown> = {}

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    if (arg === "--max-text-length") {
      options.maxTextLength = positiveIntOption(arg, args[++index])
    } else if (arg === "--max-elements") {
      options.maxElements = positiveIntOption(arg, args[++index])
    } else if (arg.startsWith("--")) {
      throw new CliInputError(`Unknown option for snapshot: ${arg}`)
    } else {
      positionals.push(arg)
    }
  }

  if (positionals.length > 1) {
    throw new CliInputError(
      "Usage: chrome-power-cli snapshot [url] [--max-text-length n] [--max-elements n]"
    )
  }

  return {
    url: positionals[0],
    options,
  }
}

function parseScreenshotArgs(args: string[]) {
  const positionals: string[] = []
  const options: Record<string, unknown> = {}

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    if (arg === "--path") {
      const value = args[++index]
      if (!value) throw new CliInputError("--path requires a value")
      options.path = value
    } else if (arg === "--full-page") {
      options.fullPage = true
    } else if (arg.startsWith("--")) {
      throw new CliInputError(`Unknown option for screenshot: ${arg}`)
    } else {
      positionals.push(arg)
    }
  }

  if (positionals.length > 1) {
    throw new CliInputError(
      "Usage: chrome-power-cli screenshot [url] [--path path] [--full-page]"
    )
  }

  return {
    url: positionals[0],
    options,
  }
}

async function parseBatchArgs(args: string[]) {
  let source: string | undefined
  let file: string | undefined
  let stopOnError = true

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    if (arg === "--file") {
      file = args[++index]
      if (!file) throw new CliInputError("--file requires a value")
    } else if (arg === "--continue-on-error") {
      stopOnError = false
    } else if (arg === "--stop-on-error") {
      stopOnError = true
    } else if (arg.startsWith("--")) {
      throw new CliInputError(`Unknown option for batch: ${arg}`)
    } else if (source == null) {
      source = arg
    } else {
      source = `${source} ${arg}`
    }
  }

  if (file && source && source !== "-") {
    throw new CliInputError("batch accepts either JSON input or --file, not both")
  }

  const jsonText = file
    ? await readFile(file, "utf8")
    : source == null || source === "-"
      ? await readStdin()
      : source
  const parsed = parseJson(jsonText)

  if (Array.isArray(parsed)) {
    return { steps: parsed.map(normalizeBatchStep), stopOnError }
  }

  if (!isRecord(parsed)) {
    throw new CliInputError("Batch input must be a JSON array or object")
  }

  const steps = parsed.steps
  if (!Array.isArray(steps)) {
    throw new CliInputError("Batch object must include a steps array")
  }

  const parsedStopOnError =
    typeof parsed.stopOnError === "boolean" ? parsed.stopOnError : stopOnError

  return {
    steps: steps.map(normalizeBatchStep),
    stopOnError: parsedStopOnError,
  }
}

function normalizeBatchStep(value: unknown, index: number): BatchStep {
  if (!isRecord(value)) {
    throw new CliInputError("Batch step must be a JSON object", index)
  }

  const tool = typeof value.tool === "string" ? value.tool : value.name
  if (typeof tool !== "string" || tool.length === 0) {
    throw new CliInputError(
      "Batch step must include a tool or name string",
      index
    )
  }

  const stepArguments =
    "arguments" in value ? value.arguments : "args" in value ? value.args : {}

  return {
    tool,
    arguments: stepArguments,
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new CliInputError(`Invalid JSON: ${errorMessage(error)}`)
  }
}

function positiveIntOption(option: string, value: string | undefined) {
  if (!value) throw new CliInputError(`${option} requires a value`)
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliInputError(`${option} must be a positive integer`)
  }
  return parsed
}

function requireNoArgs(command: string, args: string[]) {
  if (args.length > 0) {
    throw new CliInputError(`${command} does not accept arguments`)
  }
}

function consumeGlobalFlags(args: string[]) {
  const nextArgs: string[] = []
  let pretty = false

  for (const arg of args) {
    if (arg === "--pretty") {
      pretty = true
    } else {
      nextArgs.push(arg)
    }
  }

  return { args: nextArgs, pretty }
}

async function readStdin() {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString("utf8")
}

function writeJson(output: CliOutput, pretty: boolean) {
  process.stdout.write(`${JSON.stringify(output, null, pretty ? 2 : 0)}\n`)
}

function inputFailure(
  message: string,
  sessionId?: string,
  index?: number,
  code: BrowserErrorCode = "invalid_request"
): ToolResult {
  const indexMessage = index == null ? "" : ` (batch step ${index})`
  return {
    ok: false,
    sessionId: sessionId ?? "cli",
    error: {
      code,
      message: `${message}${indexMessage}`,
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function printUsage() {
  process.stdout.write(`Usage:
  chrome-power-cli status [--pretty]
  chrome-power-cli open <url> [--new-tab] [--pretty]
  chrome-power-cli snapshot [url] [--max-text-length n] [--max-elements n] [--pretty]
  chrome-power-cli screenshot [url] [--path path] [--full-page] [--pretty]
  chrome-power-cli batch '<json-array-or-object>' [--continue-on-error] [--pretty]
  chrome-power-cli batch --file batch.json [--continue-on-error] [--pretty]
  chrome-power-cli batch - [--continue-on-error] [--pretty]
`)
}

function loadCliConfig(): RuntimeConfig {
  const config = loadConfig()
  const deployRoot = deployedRootFromModuleUrl(import.meta.url)
  if (!deployRoot) return config

  return {
    ...config,
    profileDir:
      process.env.CHROME_POWER_PROFILE_DIR ??
      resolve(deployRoot, "profile"),
    screenshotDir:
      process.env.CHROME_POWER_SCREENSHOT_DIR ??
      resolve(deployRoot, "artifacts/screenshots"),
    downloadDir:
      process.env.CHROME_POWER_DOWNLOAD_DIR ??
      resolve(deployRoot, "artifacts/downloads"),
  }
}

function deployedRootFromModuleUrl(moduleUrl: string) {
  const cliDir = dirname(fileURLToPath(moduleUrl))
  const appDir = resolve(cliDir, "../..")
  if (basename(appDir) !== "app") return undefined
  if (!existsSync(resolve(appDir, "DEPLOYED_COMMIT"))) return undefined
  return dirname(appDir)
}
