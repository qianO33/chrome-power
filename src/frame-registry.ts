import { randomUUID } from "node:crypto"
import type { Frame, Page } from "playwright"
import type { FrameInfo } from "./contracts.js"
import { BrowserToolError } from "./errors.js"
import { hasValue } from "./validation-utils.js"

type RuntimePage = {
  id: string
  page: Page
}

export class FrameRegistry {
  private readonly frameIdsByTab = new Map<string, Map<Frame, string>>()
  private readonly framesByTab = new Map<string, Map<string, Frame>>()

  idFor(runtimePage: RuntimePage, frame: Frame): string {
    const { idsByFrame } = this.refresh(runtimePage)
    const frameId = idsByFrame.get(frame)
    if (!frameId) {
      throw new BrowserToolError(
        "frame_not_found",
        "Frame is detached. Refresh browser_frames and retry."
      )
    }
    return frameId
  }

  async resolve(runtimePage: RuntimePage, frameId?: string): Promise<Frame> {
    if (!hasValue(frameId)) return runtimePage.page.mainFrame()
    const { framesById } = this.refresh(runtimePage)
    const frame = framesById.get(frameId)
    if (!frame || frame.isDetached()) {
      throw new BrowserToolError(
        "frame_not_found",
        `Unknown or detached frameId: ${frameId}. Refresh browser_frames and retry.`
      )
    }
    return frame
  }

  async list(runtimePage: RuntimePage): Promise<FrameInfo[]> {
    const { idsByFrame, frames } = this.refresh(runtimePage)
    const mainFrame = runtimePage.page.mainFrame()
    const result: FrameInfo[] = []

    for (const frame of frames) {
      const id = idsByFrame.get(frame)
      if (!id) continue
      const parent = frame.parentFrame()
      const parentId = parent ? idsByFrame.get(parent) : undefined
      const title = await frame.title().catch(() => "")
      result.push({
        id,
        parentId,
        main: frame === mainFrame,
        name: frame.name() || undefined,
        url: frame.url(),
        title: title || undefined,
      })
    }

    return result
  }

  clearTab(tabId: string): void {
    this.frameIdsByTab.delete(tabId)
    this.framesByTab.delete(tabId)
  }

  clearAll(): void {
    this.frameIdsByTab.clear()
    this.framesByTab.clear()
  }

  private refresh(runtimePage: RuntimePage) {
    const frames = runtimePage.page.frames().filter((frame) => !frame.isDetached())
    const liveFrames = new Set(frames)
    const idsByFrame =
      this.frameIdsByTab.get(runtimePage.id) ?? new Map<Frame, string>()

    for (const frame of [...idsByFrame.keys()]) {
      if (!liveFrames.has(frame)) {
        idsByFrame.delete(frame)
      }
    }

    for (const frame of frames) {
      if (!idsByFrame.has(frame)) {
        const suffix =
          frame === runtimePage.page.mainFrame()
            ? "main"
            : randomUUID().slice(0, 8)
        idsByFrame.set(frame, `frame_${runtimePage.id}_${suffix}`)
      }
    }

    const framesById = new Map<string, Frame>()
    for (const [frame, id] of idsByFrame) {
      framesById.set(id, frame)
    }
    this.frameIdsByTab.set(runtimePage.id, idsByFrame)
    this.framesByTab.set(runtimePage.id, framesById)
    return { idsByFrame, framesById, frames }
  }
}
