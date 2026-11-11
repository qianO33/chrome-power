import { randomUUID } from "node:crypto"
import type { ElementHandle } from "playwright"
import type { FrameLike } from "./locator-query.js"
import {
  ACTIONABLE_ELEMENT_SELECTOR,
  readSnapshotElement,
  SENSITIVE_FIELD_HINTS,
} from "./page-projections.js"
import { BrowserToolError } from "./errors.js"
import { hasValue } from "./validation-utils.js"
import type { SnapshotElement } from "./contracts.js"

type SnapshotState = {
  id: string
  refs: Map<string, SnapshotRef>
}

type SnapshotRef = {
  handle: ElementHandle<Element>
  frameId: string
}

export class SnapshotRegistry {
  private readonly snapshots = new Map<string, SnapshotState>()
  private snapshotSequence = 0

  async collect(
    tabId: string,
    frame: FrameLike,
    frameId: string,
    maxElements: number
  ): Promise<{ snapshotId: string; elements: SnapshotElement[] }> {
    await this.clear(tabId)

    const snapshotId = `snapshot_${++this.snapshotSequence}_${randomUUID().slice(
      0,
      8
    )}`
    const refs = new Map<string, SnapshotRef>()
    const elements: SnapshotElement[] = []
    const handles = await frame.$$(ACTIONABLE_ELEMENT_SELECTOR)

    for (const handle of handles) {
      if (elements.length >= maxElements) {
        await handle.dispose().catch(() => undefined)
        continue
      }

      const elementData = await handle
        .evaluate(readSnapshotElement, SENSITIVE_FIELD_HINTS)
        .catch(() => null)

      if (!elementData) {
        await handle.dispose().catch(() => undefined)
        continue
      }

      const ref = `${snapshotId}_el_${elements.length + 1}`
      refs.set(ref, { handle: handle as ElementHandle<Element>, frameId })
      elements.push({ ref, ...elementData })
    }

    this.snapshots.set(tabId, { id: snapshotId, refs })
    return { snapshotId, elements }
  }

  async clear(tabId: string) {
    const state = this.snapshots.get(tabId)
    if (!state) return
    this.snapshots.delete(tabId)
    await Promise.all(
      [...state.refs.values()].map((handle) =>
        handle.handle.dispose().catch(() => undefined)
      )
    )
  }

  async clearAll() {
    await Promise.all(
      [...this.snapshots.keys()].map((id) => this.clear(id))
    )
  }

  async resolveRef(
    tabId: string,
    ref: string,
    frameId?: string
  ): Promise<ElementHandle<Element>> {
    const state = this.snapshots.get(tabId)
    const snapshotRef = state?.refs.get(ref)
    if (!state || !snapshotRef) {
      throw new BrowserToolError(
        "element_ref_not_found",
        `Unknown or expired element ref: ${ref}. Take a new browser_snapshot for this tab.`
      )
    }

    if (hasValue(frameId) && snapshotRef.frameId !== frameId) {
      throw new BrowserToolError(
        "invalid_request",
        `Element ref ${ref} belongs to a different frame. Use a ref from the requested frame snapshot.`
      )
    }

    const isAttached = await snapshotRef.handle
      .evaluate((element) => element.isConnected)
      .catch(() => false)

    if (!isAttached) {
      state.refs.delete(ref)
      await snapshotRef.handle.dispose().catch(() => undefined)
      throw new BrowserToolError(
        "element_ref_not_found",
        `Element ref is detached or expired: ${ref}. Take a new browser_snapshot for this tab.`
      )
    }

    return snapshotRef.handle
  }

  refCount(tabId: string): number {
    return this.snapshots.get(tabId)?.refs.size ?? 0
  }
}
