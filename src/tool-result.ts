import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

import type { ToolResult } from "./contracts.js"
import type { BrowserToolResultKind } from "./tool-registry.js"

export function asMcpResult(
  result: ToolResult,
  resultKind: BrowserToolResultKind = "json"
): CallToolResult {
  const content: CallToolResult["content"] = []
  let serializableResult: ToolResult = result

  if (resultKind === "screenshot" && result.ok) {
    const sourceData = isRecord(result.data) ? result.data : undefined
    if (typeof sourceData?.base64 === "string") {
      content.push({
        type: "image",
        data: sourceData.base64,
        mimeType: "image/png",
      })
      const { base64: _base64, ...publicData } = sourceData
      serializableResult = { ...result, data: publicData }
    }
  }

  const publicResult = JSON.parse(JSON.stringify(serializableResult)) as Record<
    string,
    unknown
  >

  content.unshift({
    type: "text",
    text: JSON.stringify(publicResult, null, 2),
  })

  return {
    content,
    structuredContent: publicResult,
    isError: !result.ok,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value)
}
