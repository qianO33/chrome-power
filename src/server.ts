#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

import { BrowserTargetManager } from "./browser-target-manager.js"
import { loadConfig } from "./config.js"
import {
  BrowserOwnerClient,
  createOwnerRuntimeProxy,
} from "./owner-client.js"
import { resolveMcpToolSelection } from "./mcp-tool-profiles.js"
import { createSessionRouterRuntimeProxy } from "./session-router.js"
import { registerBrowserTools } from "./tools.js"
import { loadRuntimeMetadata } from "./runtime-metadata.js"

const mcpToolSelection = resolveMcpToolSelection()
const config = loadConfig()
const directRuntime =
  process.env.CHROME_POWER_DIRECT_RUNTIME === "1" ||
  process.env.CHROME_POWER_OWNER_PROCESS === "1"
const targetManager = directRuntime
  ? new BrowserTargetManager(config)
  : undefined
const runtime =
  directRuntime && targetManager
    ? createSessionRouterRuntimeProxy(targetManager.powerRuntime, {
        targetManager: targetManager,
        browserCallLimits: config.browserCallLimits,
      })
    : createOwnerRuntimeProxy(new BrowserOwnerClient(config))
const server = new McpServer({
  name: "chrome-power",
  version: loadRuntimeMetadata().packageVersion,
})

registerBrowserTools(server, runtime, mcpToolSelection)

const transport = new StdioServerTransport()
transport.onclose = () => {
  void disposeRuntime()
}

let disposePromise: Promise<void> | undefined

function disposeRuntime() {
  disposePromise ??= runtime.dispose()
  return disposePromise
}

function shutdown(exitCode: number) {
  void disposeRuntime().finally(() => process.exit(exitCode))
}

process.stdin.once("end", () => shutdown(0))
process.stdin.once("close", () => shutdown(0))

process.on("SIGINT", () => {
  shutdown(130)
})

process.on("SIGTERM", () => {
  shutdown(143)
})

await server.connect(transport)
