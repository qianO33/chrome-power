import type { ToolResult } from "./contracts.js"
import {
  BROWSER_MCP_TOOL_GROUPS,
  BROWSER_TOOL_DEFINITIONS,
  type BrowserMcpToolGroup,
  type BrowserToolDefinition,
  type BrowserToolName,
} from "./tool-registry.js"

export const BROWSER_CAPABILITIES_TOOL_NAME = "browser_capabilities"
export const MCP_SURFACE_SESSION_ID = "mcp-surface"
export const MCP_TOOL_PROFILE_ENV = "CHROME_POWER_MCP_TOOLS"
export const MCP_CAPABILITIES_CONTRACT_VERSION = 1

export type McpToolSelection = {
  source: "default" | "environment"
  requested: "all" | BrowserMcpToolGroup[]
  activeGroups: BrowserMcpToolGroup[]
  enabledDefinitions: readonly BrowserToolDefinition[]
  omittedDefinitions: readonly BrowserToolDefinition[]
  enabledToolNames: ReadonlySet<BrowserToolName>
}

export type BrowserMcpCapabilitiesData = {
  contractVersion: number
  source: McpToolSelection["source"]
  requested: McpToolSelection["requested"]
  activeGroups: BrowserMcpToolGroup[]
  availableGroups: Array<{ name: BrowserMcpToolGroup; toolCount: number }>
  enabledRuntimeTools: BrowserToolName[]
  omittedRuntimeTools: BrowserToolName[]
  runtimeToolCount: number
  exposedToolCount: number
}

validateCanonicalGroupMetadata()

export function resolveMcpToolSelection(
  value = process.env[MCP_TOOL_PROFILE_ENV]
): McpToolSelection {
  const normalized = value?.trim()
  if (!normalized) return allSelection("default")

  const tokens = normalized.split(",").map((token) => token.trim())
  if (tokens.some((token) => token.length === 0)) {
    throw profileConfigError("group names must not be empty")
  }

  if (tokens.includes("all")) {
    if (tokens.length !== 1) {
      throw profileConfigError('"all" cannot be combined with other groups')
    }
    return allSelection("environment")
  }

  const unknown = tokens.filter((token) => !isBrowserMcpToolGroup(token))
  if (unknown.length > 0) {
    throw profileConfigError(
      `unknown group${unknown.length === 1 ? "" : "s"}: ${[...new Set(unknown)].join(", ")}`
    )
  }

  const requested = [
    ...new Set(tokens as BrowserMcpToolGroup[]),
  ]
  const requestedSet = new Set(requested)
  const activeGroups = BROWSER_MCP_TOOL_GROUPS.filter((group) =>
    requestedSet.has(group)
  )
  const enabledDefinitions = BROWSER_TOOL_DEFINITIONS.filter((definition) =>
    definition.mcpGroups.some((group) => requestedSet.has(group))
  )
  return buildSelection(
    "environment",
    requested,
    [...activeGroups],
    enabledDefinitions
  )
}

export function browserMcpCapabilities(
  selection: McpToolSelection
): ToolResult<BrowserMcpCapabilitiesData> {
  return {
    ok: true,
    sessionId: MCP_SURFACE_SESSION_ID,
    data: {
      contractVersion: MCP_CAPABILITIES_CONTRACT_VERSION,
      source: selection.source,
      requested:
        selection.requested === "all"
          ? "all"
          : [...selection.requested],
      activeGroups: [...selection.activeGroups],
      availableGroups: BROWSER_MCP_TOOL_GROUPS.map((name) => ({
        name,
        toolCount: BROWSER_TOOL_DEFINITIONS.filter((definition) =>
          definition.mcpGroups.includes(name)
        ).length,
      })),
      enabledRuntimeTools: selection.enabledDefinitions.map(
        (definition) => definition.name as BrowserToolName
      ),
      omittedRuntimeTools: selection.omittedDefinitions.map(
        (definition) => definition.name as BrowserToolName
      ),
      runtimeToolCount: BROWSER_TOOL_DEFINITIONS.length,
      exposedToolCount: selection.enabledDefinitions.length + 1,
    },
  }
}

export function isToolEnabled(
  selection: McpToolSelection,
  name: BrowserToolName
) {
  return selection.enabledToolNames.has(name)
}

function allSelection(source: McpToolSelection["source"]): McpToolSelection {
  return buildSelection(
    source,
    "all",
    [...BROWSER_MCP_TOOL_GROUPS],
    BROWSER_TOOL_DEFINITIONS
  )
}

function buildSelection(
  source: McpToolSelection["source"],
  requested: McpToolSelection["requested"],
  activeGroups: BrowserMcpToolGroup[],
  enabledDefinitions: readonly BrowserToolDefinition[]
): McpToolSelection {
  const enabledToolNames = new Set(
    enabledDefinitions.map((definition) => definition.name as BrowserToolName)
  )
  return {
    source,
    requested,
    activeGroups,
    enabledDefinitions,
    omittedDefinitions: BROWSER_TOOL_DEFINITIONS.filter(
      (definition) =>
        !enabledToolNames.has(definition.name as BrowserToolName)
    ),
    enabledToolNames,
  }
}

function isBrowserMcpToolGroup(value: string): value is BrowserMcpToolGroup {
  return (BROWSER_MCP_TOOL_GROUPS as readonly string[]).includes(value)
}

function validateCanonicalGroupMetadata() {
  for (const definition of BROWSER_TOOL_DEFINITIONS) {
    if (definition.mcpGroups.length === 0) {
      throw new Error(`${definition.name} must declare at least one MCP group.`)
    }
    if (new Set(definition.mcpGroups).size !== definition.mcpGroups.length) {
      throw new Error(`${definition.name} contains duplicate MCP groups.`)
    }
  }
  for (const group of BROWSER_MCP_TOOL_GROUPS) {
    if (
      !BROWSER_TOOL_DEFINITIONS.some((definition) =>
        definition.mcpGroups.includes(group)
      )
    ) {
      throw new Error(`MCP group ${group} does not contain any browser tools.`)
    }
  }
}

function profileConfigError(message: string) {
  return new Error(
    `Invalid ${MCP_TOOL_PROFILE_ENV}: ${message}. Available groups: ${BROWSER_MCP_TOOL_GROUPS.join(
      ", "
    )}, or all.`
  )
}
