import type { BrowserErrorCode, ToolResult } from "./contracts.js"

export class BrowserToolError extends Error {
  readonly code: BrowserErrorCode

  constructor(code: BrowserErrorCode, message: string) {
    super(message)
    this.name = "BrowserToolError"
    this.code = code
  }
}

export function failResult(
  sessionId: string,
  error: unknown,
  fallbackCode: BrowserErrorCode = "operation_failed"
): ToolResult {
  if (error instanceof BrowserToolError) {
    return {
      ok: false,
      sessionId,
      error: {
        code: error.code,
        message: error.message,
      },
    }
  }

  return {
    ok: false,
    sessionId,
    error: {
      code: fallbackCode,
      message: error instanceof Error ? error.message : String(error),
    },
  }
}
