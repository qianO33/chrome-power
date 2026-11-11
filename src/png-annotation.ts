import { PNG } from "pngjs"

import type { ElementBox, InspectPointCandidate, ViewportSize } from "./contracts.js"

export function annotateScreenshot(
  source: Buffer,
  viewport: ViewportSize | null,
  point: { x: number; y: number },
  candidates: InspectPointCandidate[]
) {
  if (!viewport) return source
  const png = PNG.sync.read(source)
  const scaleX = png.width / viewport.width
  const scaleY = png.height / viewport.height
  const colors = [
    [255, 45, 85, 255],
    [255, 159, 10, 255],
    [50, 173, 230, 255],
  ] as const
  candidates.forEach((candidate, index) => {
    const color = colors[Math.min(index, colors.length - 1)]
    const x = Math.round(candidate.box.x * scaleX)
    const y = Math.round(candidate.box.y * scaleY)
    const width = Math.round(candidate.box.width * scaleX)
    const height = Math.round(candidate.box.height * scaleY)
    drawRect(png, x, y, width, height, color, index === 0 ? 3 : 2)
  })
  const pointX = Math.round(point.x * scaleX)
  const pointY = Math.round(point.y * scaleY)
  const crosshair = [255, 0, 0, 255] as const
  drawLine(png, pointX - 8, pointY, pointX + 8, pointY, crosshair, 2)
  drawLine(png, pointX, pointY - 8, pointX, pointY + 8, crosshair, 2)
  return PNG.sync.write(png)
}

export function annotateElementBox(
  source: Buffer,
  viewport: ViewportSize | null,
  box: ElementBox
) {
  if (!viewport) return source
  const png = PNG.sync.read(source)
  const scaleX = png.width / viewport.width
  const scaleY = png.height / viewport.height
  drawRect(
    png,
    Math.round(box.x * scaleX),
    Math.round(box.y * scaleY),
    Math.round(box.width * scaleX),
    Math.round(box.height * scaleY),
    [255, 45, 85, 255],
    4
  )
  return PNG.sync.write(png)
}

function drawRect(
  png: PNG,
  x: number,
  y: number,
  width: number,
  height: number,
  color: readonly [number, number, number, number],
  thickness: number
) {
  for (let offset = 0; offset < thickness; offset += 1) {
    drawLine(png, x, y + offset, x + width, y + offset, color, 1)
    drawLine(
      png,
      x,
      y + height - offset,
      x + width,
      y + height - offset,
      color,
      1
    )
    drawLine(png, x + offset, y, x + offset, y + height, color, 1)
    drawLine(
      png,
      x + width - offset,
      y,
      x + width - offset,
      y + height,
      color,
      1
    )
  }
}

function drawLine(
  png: PNG,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  color: readonly [number, number, number, number],
  thickness: number
) {
  const steps = Math.max(Math.abs(endX - startX), Math.abs(endY - startY), 1)
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(startX + ((endX - startX) * step) / steps)
    const y = Math.round(startY + ((endY - startY) * step) / steps)
    for (let dx = -Math.floor(thickness / 2); dx <= Math.floor(thickness / 2); dx += 1) {
      for (let dy = -Math.floor(thickness / 2); dy <= Math.floor(thickness / 2); dy += 1) {
        setPngPixel(png, x + dx, y + dy, color)
      }
    }
  }
}

function setPngPixel(
  png: PNG,
  x: number,
  y: number,
  color: readonly [number, number, number, number]
) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return
  const offset = (png.width * y + x) * 4
  png.data[offset] = color[0]
  png.data[offset + 1] = color[1]
  png.data[offset + 2] = color[2]
  png.data[offset + 3] = color[3]
}
