import type {
  ResourceProtectionLimits,
  ResourceProtectionSchedulerStatus,
} from "./contracts.js"
import { BrowserToolError } from "./errors.js"

export type BrowserCallLane = "regular" | "diagnostic_wait"
export type BrowserCallMode = "shared" | "exclusive"

export type BrowserCallDescriptor = {
  lane: BrowserCallLane
  mode: BrowserCallMode
  resourceKeys?: readonly string[]
  signal?: AbortSignal
}

type QueueEntry = {
  lane: BrowserCallLane
  mode: BrowserCallMode
  resourceKeys: readonly string[]
  signal?: AbortSignal
  abortHandler?: () => void
  timer?: NodeJS.Timeout
  operation: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

export class BrowserCallScheduler {
  private readonly queue: QueueEntry[] = []
  private readonly activeEntries = new Set<QueueEntry>()
  private readonly activeResourceKeys = new Set<string>()
  private activeRegular = 0
  private activeDiagnosticWait = 0
  private activeUrgentControl = 0
  private exclusiveActive = false
  private disposed = false
  private started = 0
  private completed = 0
  private rejectedQueueFull = 0
  private timedOutInQueue = 0
  private cancelledInQueue = 0
  private scheduledHighWater = 0
  private queuedHighWater = 0
  private diagnosticWaitHighWater = 0
  private urgentControlHighWater = 0

  constructor(private readonly limits: ResourceProtectionLimits) {
    validateLimits(limits)
  }

  run<T>(
    descriptor: BrowserCallDescriptor,
    operation: () => Promise<T>
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(
        new BrowserToolError(
          "operation_cancelled",
          "Browser call scheduling stopped before this operation could start."
        )
      )
    }
    if (descriptor.signal?.aborted) {
      this.cancelledInQueue += 1
      return Promise.reject(cancelledBeforeExecutionError())
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        lane: descriptor.lane,
        mode: descriptor.mode,
        resourceKeys: [...new Set(descriptor.resourceKeys ?? [])],
        signal: descriptor.signal,
        operation,
        resolve: (value) => resolve(value as T),
        reject,
      }

      const pendingExclusiveIndex = this.queue.findIndex(
        (queued) => queued.lane === "regular" && queued.mode === "exclusive"
      )
      if (
        this.canStart(
          entry,
          this.queue.length,
          pendingExclusiveIndex
        )
      ) {
        this.start(entry)
        return
      }

      if (this.queue.length >= this.limits.maxQueuedCalls) {
        this.rejectedQueueFull += 1
        reject(
          new BrowserToolError(
            "resource_busy",
            `Browser call queue is full (${this.limits.maxQueuedCalls} waiting); retry after active work completes.`
          )
        )
        return
      }

      entry.abortHandler = () => {
        if (!this.removeQueuedEntry(entry)) return
        this.cancelledInQueue += 1
        entry.reject(cancelledBeforeExecutionError())
        this.drain()
      }
      entry.signal?.addEventListener("abort", entry.abortHandler, {
        once: true,
      })
      entry.timer = setTimeout(() => {
        if (!this.removeQueuedEntry(entry)) return
        this.timedOutInQueue += 1
        entry.reject(
          new BrowserToolError(
            "resource_busy",
            `Timed out after ${this.limits.queueWaitTimeoutMs}ms waiting for browser call admission.`
          )
        )
        this.drain()
      }, this.limits.queueWaitTimeoutMs)
      entry.timer.unref()
      this.queue.push(entry)
      this.queuedHighWater = Math.max(
        this.queuedHighWater,
        this.queue.length
      )
      this.drain()
    })
  }

  async runUrgent<T>(operation: () => Promise<T>, signal?: AbortSignal) {
    if (this.disposed || signal?.aborted) {
      throw new BrowserToolError(
        "operation_cancelled",
        "Urgent browser control was cancelled before it started."
      )
    }
    this.activeUrgentControl += 1
    this.started += 1
    this.urgentControlHighWater = Math.max(
      this.urgentControlHighWater,
      this.activeUrgentControl
    )
    try {
      return await operation()
    } finally {
      this.activeUrgentControl -= 1
      this.completed += 1
    }
  }

  snapshot(): ResourceProtectionSchedulerStatus {
    const queuedRegular = this.queue.filter(
      (entry) => entry.lane === "regular"
    ).length
    const queuedDiagnosticWait = this.queue.length - queuedRegular
    return {
      limits: { ...this.limits },
      active: {
        scheduled: this.activeEntries.size,
        regular: this.activeRegular,
        diagnosticWait: this.activeDiagnosticWait,
        urgentControl: this.activeUrgentControl,
      },
      queued: {
        total: this.queue.length,
        regular: queuedRegular,
        diagnosticWait: queuedDiagnosticWait,
      },
      highWaterMarks: {
        scheduled: this.scheduledHighWater,
        queued: this.queuedHighWater,
        diagnosticWait: this.diagnosticWaitHighWater,
        urgentControl: this.urgentControlHighWater,
      },
      totals: {
        started: this.started,
        completed: this.completed,
        rejectedQueueFull: this.rejectedQueueFull,
        timedOutInQueue: this.timedOutInQueue,
        cancelledInQueue: this.cancelledInQueue,
      },
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const entry of [...this.queue]) {
      if (!this.removeQueuedEntry(entry)) continue
      this.cancelledInQueue += 1
      entry.reject(
        new BrowserToolError(
          "operation_cancelled",
          "Browser call was cancelled because scheduling stopped before execution."
        )
      )
    }
  }

  private drain() {
    for (;;) {
      const next = this.nextStartableEntry()
      if (!next) return
      this.removeQueuedEntry(next)
      this.start(next)
    }
  }

  private nextStartableEntry() {
    const pendingExclusiveIndex = this.queue.findIndex(
      (entry) => entry.lane === "regular" && entry.mode === "exclusive"
    )
    for (let index = 0; index < this.queue.length; index += 1) {
      const entry = this.queue[index]
      if (entry.lane !== "regular") continue
      if (this.canStart(entry, index, pendingExclusiveIndex)) return entry
    }
    for (let index = 0; index < this.queue.length; index += 1) {
      const entry = this.queue[index]
      if (entry.lane !== "diagnostic_wait") continue
      if (this.canStart(entry, index, pendingExclusiveIndex)) return entry
    }
    return undefined
  }

  private canStart(
    entry: QueueEntry,
    queueIndex: number,
    pendingExclusiveIndex: number
  ) {
    if (this.activeEntries.size >= this.limits.maxConcurrentCalls) {
      return false
    }
    if (entry.lane === "diagnostic_wait") {
      return this.activeDiagnosticWait < this.limits.maxDiagnosticWaits
    }
    if (this.exclusiveActive) return false
    if (entry.mode === "exclusive") {
      return this.activeRegular === 0
    }
    if (
      pendingExclusiveIndex >= 0 &&
      queueIndex > pendingExclusiveIndex
    ) {
      return false
    }
    return entry.resourceKeys.every(
      (key) => !this.activeResourceKeys.has(key)
    )
  }

  private start(entry: QueueEntry) {
    this.activeEntries.add(entry)
    for (const key of entry.resourceKeys) this.activeResourceKeys.add(key)
    if (entry.lane === "diagnostic_wait") {
      this.activeDiagnosticWait += 1
      this.diagnosticWaitHighWater = Math.max(
        this.diagnosticWaitHighWater,
        this.activeDiagnosticWait
      )
    } else {
      this.activeRegular += 1
      if (entry.mode === "exclusive") this.exclusiveActive = true
    }
    this.started += 1
    this.scheduledHighWater = Math.max(
      this.scheduledHighWater,
      this.activeEntries.size
    )

    void Promise.resolve()
      .then(entry.operation)
      .then(
        (value) => {
          this.finish(entry)
          entry.resolve(value)
        },
        (error) => {
          this.finish(entry)
          entry.reject(error)
        }
      )
  }

  private finish(entry: QueueEntry) {
    this.activeEntries.delete(entry)
    for (const key of entry.resourceKeys) this.activeResourceKeys.delete(key)
    if (entry.lane === "diagnostic_wait") {
      this.activeDiagnosticWait -= 1
    } else {
      this.activeRegular -= 1
      if (entry.mode === "exclusive") this.exclusiveActive = false
    }
    this.completed += 1
    this.drain()
  }

  private removeQueuedEntry(entry: QueueEntry) {
    const index = this.queue.indexOf(entry)
    if (index < 0) return false
    this.queue.splice(index, 1)
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.abortHandler) {
      entry.signal?.removeEventListener("abort", entry.abortHandler)
    }
    entry.timer = undefined
    entry.abortHandler = undefined
    return true
  }
}

function cancelledBeforeExecutionError() {
  return new BrowserToolError(
    "operation_cancelled",
    "Browser call was cancelled before execution. An operation that had already started may still complete."
  )
}

function validateLimits(limits: ResourceProtectionLimits) {
  const values = [
    limits.maxConcurrentCalls,
    limits.maxQueuedCalls,
    limits.maxDiagnosticWaits,
    limits.queueWaitTimeoutMs,
  ]
  if (
    !values.every(Number.isInteger) ||
    limits.maxConcurrentCalls <= 0 ||
    limits.maxQueuedCalls < 0 ||
    limits.maxDiagnosticWaits <= 0 ||
    limits.queueWaitTimeoutMs <= 0
  ) {
    throw new Error("Browser call scheduler limits are invalid.")
  }
}
