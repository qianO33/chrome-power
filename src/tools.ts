import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

import type { BrowserRuntime } from "./browser-runtime.js"
import { failResult } from "./errors.js"
import {
  BROWSER_CAPABILITIES_TOOL_NAME,
  browserMcpCapabilities,
  isToolEnabled,
  type McpToolSelection,
} from "./mcp-tool-profiles.js"
import { asMcpResult } from "./tool-result.js"
import {
  callBrowserTool,
  getBrowserToolDefinition,
  invalidBrowserToolRequest,
  isBrowserToolName,
  type BrowserToolCallContext,
  type BrowserToolDefinition,
} from "./tool-registry.js"

const browserCapabilitiesInputSchema = z.object({}).strict()

export {
  BROWSER_TOOL_DEFINITIONS,
  BROWSER_TOOL_NAMES,
  browserToolForRuntimeMethod,
  callBrowserTool,
  getBrowserToolDefinition,
  invalidBrowserToolRequest,
  isBrowserToolName,
  isContextGlobalBrowserToolCall,
  isLockFreeDiagnosticWaitCall,
  isTabScopedBrowserTool,
  parseBrowserToolInput,
  requiresExistingTab,
  type BrowserToolCallContext,
  type BrowserToolName,
  type BrowserToolResultKind,
} from "./tool-registry.js"

export {
  BROWSER_CAPABILITIES_TOOL_NAME,
  MCP_TOOL_PROFILE_ENV,
  browserMcpCapabilities,
  resolveMcpToolSelection,
  type BrowserMcpCapabilitiesData,
  type McpToolSelection,
} from "./mcp-tool-profiles.js"

export function registerBrowserTools(
  server: McpServer,
  runtime: BrowserRuntime,
  selection: McpToolSelection
) {
  for (const definition of selection.enabledDefinitions as readonly BrowserToolDefinition[]) {
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.inputSchema,
      },
      async (input, extra) =>
        dispatchBrowserToolCall(
          runtime,
          selection,
          definition.name,
          input,
          { signal: extra.signal }
        )
    )
  }

  server.registerTool(
    BROWSER_CAPABILITIES_TOOL_NAME,
    {
      description:
        "Report the MCP browser tool groups and canonical runtime tools enabled for this server process without launching Chromium.",
      inputSchema: browserCapabilitiesInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, extra) =>
      dispatchBrowserToolCall(
        runtime,
        selection,
        BROWSER_CAPABILITIES_TOOL_NAME,
        input,
        { signal: extra.signal }
      )
  )

  // The SDK registrations own tools/list metadata. Its current implementation
  // installs one tools/call handler for those callbacks, so this canonical
  // handler intentionally replaces it to preserve disabled-tool envelopes.
  // Both paths still share dispatchBrowserToolCall as their only dispatcher.
  server.server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    dispatchBrowserToolCall(
      runtime,
      selection,
      request.params.name,
      request.params.arguments ?? {},
      { signal: extra.signal }
    )
  )
}

async function dispatchBrowserToolCall(
  runtime: BrowserRuntime,
  selection: McpToolSelection,
  name: string,
  input: unknown,
  context: BrowserToolCallContext = {}
) {
  try {
    if (name === BROWSER_CAPABILITIES_TOOL_NAME) {
      const parsed = browserCapabilitiesInputSchema.safeParse(input ?? {})
      return asMcpResult(
        parsed.success
          ? browserMcpCapabilities(selection)
          : invalidBrowserToolRequest(
              runtime,
              `Invalid arguments for ${BROWSER_CAPABILITIES_TOOL_NAME}: ${parsed.error.message}`
            )
      )
    }
    if (isBrowserToolName(name) && !isToolEnabled(selection, name)) {
      return asMcpResult(
        invalidBrowserToolRequest(
          runtime,
          `${name} is not enabled by ${selection.requested === "all" ? "the all profile" : `the active MCP groups: ${selection.activeGroups.join(", ")}`}.`
        )
      )
    }
    const result = await callBrowserTool(runtime, name, input, context)
    const resultKind = isBrowserToolName(name)
      ? getBrowserToolDefinition(name).resultKind
      : "json"
    return asMcpResult(result, resultKind)
  } catch (error) {
    return asMcpResult(failResult(runtime.sessionId, error))
  }
}
