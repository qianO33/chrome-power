import {
  chromium,
  type Browser,
  type BrowserContext,
} from "playwright"

export type BrowserConnectionMode = "launch" | "attach"

export interface BrowserConnection {
  readonly mode: BrowserConnectionMode
  ensureContext(): Promise<BrowserContext>
  isConnected(): boolean
  dispose(): Promise<void>
}

export type LaunchConnectionFactory = () => Promise<BrowserContext>

/** Adapter for the existing Playwright-owned persistent context. */
export class LaunchBrowserConnection implements BrowserConnection {
  readonly mode = "launch" as const
  private context: BrowserContext | null = null
  private launchPromise: Promise<BrowserContext> | null = null

  constructor(private readonly factory: LaunchConnectionFactory) {}

  async ensureContext() {
    if (this.context) return this.context
    if (this.launchPromise) return this.launchPromise
    this.launchPromise = this.factory()
    try {
      this.context = await this.launchPromise
      const context = this.context
      context.on("close", () => {
        if (this.context === context) this.context = null
      })
      return this.context
    } finally {
      this.launchPromise = null
    }
  }

  isConnected() {
    return this.context != null
  }

  async dispose() {
    // A shutdown can race the first launch. Wait for the factory so a context
    // that finishes opening after dispose is still closed and cannot leak a
    // browser process.
    const pending = this.launchPromise
    if (pending) await pending.catch(() => undefined)
    const context = this.context
    this.context = null
    await context?.close().catch(() => undefined)
  }
}

export type AttachedConnectionOptions = {
  resolveEndpoint: () => string
  onDisconnected?: () => void
}

type NativeWebSocket = {
  readonly readyState: number
  readonly OPEN: number
  send(data: string): void
  close(): void
  addEventListener(
    type: "open" | "error" | "message" | "close",
    listener: (event: NativeWebSocketEvent) => void,
    options?: { once?: boolean }
  ): void
  removeEventListener?(
    type: "open" | "error" | "message" | "close",
    listener: (event: NativeWebSocketEvent) => void
  ): void
}

type NativeWebSocketEvent = {
  data?: unknown
  error?: unknown
  message?: string
}

type PlaywrightConnectionTransport = {
  onmessage?: (message: unknown) => void
  onclose?: () => void
  send(message: unknown): void
  close(): void
}

const ATTACHED_TRANSPORT_OPEN_TIMEOUT_MS = 15_000

/**
 * Playwright's bundled WebSocket transport can hang while initializing the
 * special remote-debugging endpoint exposed by Chrome 144+. Node's native
 * WebSocket client completes the same CDP handshake, so use it as the
 * transport passed to Playwright. The transport speaks Playwright's object
 * message interface and never exposes the endpoint outside this process.
 */
async function connectNativeWebSocketTransport(
  endpoint: string
): Promise<PlaywrightConnectionTransport> {
  const WebSocketConstructor = (
    globalThis as typeof globalThis & {
      WebSocket?: new (url: string) => NativeWebSocket
    }
  ).WebSocket
  if (!WebSocketConstructor) {
    throw new Error(
      "Attached Chrome requires a Node runtime with native WebSocket support."
    )
  }

  const socket = new WebSocketConstructor(endpoint)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.close()
      reject(new Error("Timed out opening the Chrome DevTools WebSocket."))
    }, ATTACHED_TRANSPORT_OPEN_TIMEOUT_MS)
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    socket.addEventListener("open", () => finish(), { once: true })
    socket.addEventListener(
      "error",
      (event) =>
        finish(
          new Error(
            (event as NativeWebSocketEvent).message ||
              "Unable to open the Chrome DevTools WebSocket."
          )
        ),
      { once: true }
    )
    socket.addEventListener(
      "close",
      () => finish(new Error("Chrome closed the DevTools WebSocket.")),
      { once: true }
    )
  })

  const transport: PlaywrightConnectionTransport = {
    send(message) {
      if (socket.readyState !== socket.OPEN) {
        throw new Error("Chrome DevTools WebSocket is not open.")
      }
      socket.send(JSON.stringify(message))
    },
    close() {
      socket.close()
    },
  }
  socket.addEventListener("message", (event) => {
    const data = event.data
    if (typeof data !== "string") return
    try {
      transport.onmessage?.(JSON.parse(data))
    } catch {
      transport.onclose?.()
    }
  })
  socket.addEventListener("close", () => transport.onclose?.())
  socket.addEventListener("error", () => transport.onclose?.())
  return transport
}

/**
 * Adapter for an already-running Chrome instance. `dispose` only disconnects
 * Playwright's transport (`Browser.close`) and never closes the remote context.
 */
export class AttachedBrowserConnection implements BrowserConnection {
  readonly mode = "attach" as const
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private connectPromise: Promise<BrowserContext> | null = null
  private disposing = false

  constructor(private readonly options: AttachedConnectionOptions) {}

  async ensureContext() {
    if (this.context && this.browser?.isConnected()) return this.context
    if (this.connectPromise) return this.connectPromise
    this.disposing = false
    this.connectPromise = this.connect()
    try {
      return await this.connectPromise
    } finally {
      this.connectPromise = null
    }
  }

  isConnected() {
    return this.context != null && this.browser?.isConnected() === true
  }

  async dispose() {
    const browser = this.browser
    this.disposing = true
    const pending = this.connectPromise
    if (pending) await pending.catch(() => undefined)
    const connectedBrowser = this.browser ?? browser
    this.browser = null
    this.context = null
    if (connectedBrowser) {
      // Playwright documents browser.close() for connected browsers as a
      // transport disconnect. It does not close the user's Chrome process.
      await connectedBrowser.close().catch(() => undefined)
    }
  }

  private async connect() {
    const endpoint = this.options.resolveEndpoint()
    // A WebSocket endpoint is used by Chrome's modern remote-debugging flow.
    // Passing a native transport avoids Playwright's HTTP discovery and its
    // bundled WebSocket initialization hang on Chrome 152. Keep the existing
    // URL path for traditional HTTP CDP endpoints.
    const browser = endpoint.startsWith("ws://") || endpoint.startsWith("wss://")
      ? await chromium.connectOverCDP(
          await connectNativeWebSocketTransport(endpoint)
        )
      : await chromium.connectOverCDP(endpoint)
    const context = browser.contexts()[0]
    if (!context) {
      await browser.close().catch(() => undefined)
      throw new Error("Attached Chrome has no default browser context.")
    }
    this.browser = browser
    this.context = context
    browser.once("disconnected", () => {
      if (this.browser !== browser) return
      this.browser = null
      this.context = null
      if (!this.disposing) this.options.onDisconnected?.()
    })
    context.once("close", () => {
      if (this.context !== context) return
      this.context = null
      this.browser = null
      if (!this.disposing) this.options.onDisconnected?.()
    })
    return context
  }
}
