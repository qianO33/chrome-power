import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import type { Page } from "playwright"
import { PNG } from "pngjs"

import { BrowserRuntime } from "../browser-runtime.js"
import { loadConfig } from "../config.js"
import type { ToolResult } from "../contracts.js"
import { callBrowserTool } from "../tools.js"

type Fixture = { runtime: BrowserRuntime; page: Page; tabId: string; root: string; url: string }

const fixtureHtml = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Viewport Regression</title><style>
html,body { margin:0; width:100%; height:100%; overflow:hidden; }
header { height:64px; background:#ddeeff; }
#pane { position:absolute; top:64px; bottom:48px; left:16px; right:16px; overflow:auto; }
#content { height:2400px; background:linear-gradient(white, #ccddee); }
footer { position:fixed; bottom:0; left:0; right:0; height:48px; background:#eeddcc; }
#bottom-control { position:fixed; bottom:8px; right:8px; width:160px; height:32px; }
</style></head><body>
<header><a id="popup" href="viewport.html" target="_blank">Popup</a>
<button id="dialog" onclick="alert('viewport dialog')">Dialog</button></header>
<main id="pane"><div id="content">Nested scroll content</div><button id="last-row">Last row</button></main>
<footer>Fixed footer<button id="bottom-control" onclick="document.body.dataset.clicked='yes'">Bottom control</button></footer>
<script>
document.addEventListener('mousemove', event => {
  document.body.dataset.pointer = event.clientX + ',' + event.clientY;
});
document.addEventListener('wheel', () => {
  document.body.dataset.wheels = String(Number(document.body.dataset.wheels || 0) + 1);
}, {passive:true});
</script></body></html>`

function data<T>(result: ToolResult<T>): T {
  assert(result.ok, JSON.stringify(result.error))
  assert(result.data !== undefined, "successful result has data")
  return result.data
}

// Only tests inspect runtime pages: window resizing and fixture measurements
// must reach the real browser, rather than mocking the runtime's size cache.
function pageFor(runtime: BrowserRuntime, tabId: string): Page {
  const pages = (runtime as unknown as { pages: Map<string, { page: Page }> }).pages
  const entry = pages.get(tabId)
  assert(entry)
  return entry.page
}

async function withFixture(
  headless: boolean,
  run: (fixture: Fixture) => Promise<void>,
  configure?: (runtime: BrowserRuntime) => Promise<void>
) {
  const root = await mkdtemp(join(tmpdir(), "chrome-power-viewport-test-"))
  const runtime = new BrowserRuntime({ ...loadConfig({ cwd: root, env: {} }), headless })
  try {
    await configure?.(runtime)
    const path = join(root, "viewport.html")
    await writeFile(path, fixtureHtml)
    const url = pathToFileURL(path).href
    const tabId = data(await runtime.open({ url })).id
    await run({ runtime, page: pageFor(runtime, tabId), tabId, root, url })
  } finally {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

async function resizeWindow(page: Page, width: number, height: number) {
  const cdp = await page.context().newCDPSession(page)
  try {
    const { windowId } = await cdp.send("Browser.getWindowForTarget")
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } })
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width, height } })
    await page.waitForFunction(size => outerWidth === size.width && outerHeight === size.height,
      { width, height }, { timeout: 5_000 })
    await page.evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
  } finally {
    await cdp.detach()
  }
}

async function geometry(page: Page) {
  return page.evaluate(() => ({
    width: innerWidth, height: innerHeight,
    outerWidth, outerHeight, dpr: devicePixelRatio,
  }))
}

async function readPng(path: string) {
  return PNG.sync.read(await readFile(path))
}

async function assertVisualTools(fixture: Fixture) {
  const { runtime, page, tabId, root } = fixture
  const actual = await geometry(page)
  const box = data(await runtime.elementBox({ tabId, selector: "#bottom-control" }))
  const x = box.box.x + box.box.width / 2
  const y = box.box.y + box.box.height / 2
  const annotated = data(await runtime.inspectPoint({ tabId, x, y,
    annotatedScreenshot: true, path: join(root, "annotated.png") }))
  assert.equal(annotated.scale, "css")
  const png = await readPng(annotated.path!)
  assert.equal(png.width, actual.width)
  assert.equal(png.height, actual.height)
  const offset = (Math.round(y) * png.width + Math.round(x)) * 4
  assert.deepEqual([...png.data.subarray(offset, offset + 3)], [255, 0, 0],
    "the annotated crosshair is at the same CSS coordinate as input")

  const clipped = data(await runtime.screenshot({ tabId, path: join(root, "clip.png"),
    clip: { x: actual.width - 200, y: actual.height - 120, width: 200, height: 120 } }))
  assert.equal(clipped.scale, "css")
  const clipPng = await readPng(clipped.path)
  assert.equal(clipPng.width, 200)
  assert.equal(clipPng.height, 120)

  const element = data(await runtime.elementScreenshot({ tabId, selector: "#bottom-control", path: join(root, "element.png") }))
  assert.equal(element.scale, "css")
  const elementPng = await readPng(element.path)
  assert.equal(elementPng.width, 160)
  assert.equal(elementPng.height, 32)
  const highlight = data(await runtime.elementHighlight({ tabId, selector: "#bottom-control", path: join(root, "highlight.png") }))
  assert.equal(highlight.scale, "css")
  const highlightPng = await readPng(highlight.path)
  assert.equal(highlightPng.width, actual.width)
  assert.equal(highlightPng.height, actual.height)
  const corner = (Math.round(box.box.y) * highlightPng.width + Math.round(box.box.x)) * 4
  assert.deepEqual([...highlightPng.data.subarray(corner, corner + 3)], [255, 45, 85])

  for (const result of [
    await runtime.inspectPoint({ tabId, x: actual.width, y: 10 }),
    await runtime.mouse({ action: "move", tabId, x: 10, y: actual.height }),
    await runtime.screenshot({ tabId, clip: { x: actual.width - 10, y: 0, width: 20, height: 20 } }),
  ]) assert.equal(result.error?.code, "invalid_request")

  const snapshot = data(await runtime.snapshot({ tabId }))
  const control = snapshot.elements.find(element => element.name === "Bottom control")
  assert(control)
  assert.deepEqual(control.box, box.box)
  assert.equal(data(await runtime.elementBox({ tabId, selector: "#last-row" })).inViewport, false)
  data(await runtime.scrollIntoView({ tabId, selector: "#last-row" }))
  assert.equal(data(await runtime.elementBox({ tabId, selector: "#last-row" })).inViewport, true)
}

test("headed layout, screenshots and input follow the real resized window", { timeout: 45_000 }, async () => {
  await withFixture(false, async fixture => {
    const { runtime, page, tabId, root } = fixture
    assert.equal(data(await runtime.viewport({ tabId })).mode, "window")
    for (const [width, height] of [[800, 600], [1000, 700], [820, 620]]) {
      await resizeWindow(page, width, height)
      const actual = await geometry(page)
      assert(actual.width <= actual.outerWidth, `layout width ${actual.width} exceeds real window width ${actual.outerWidth}`)
      assert(actual.height < actual.outerHeight, "layout fits below the browser chrome")
      const viewport = data(await runtime.viewport({ tabId }))
      assert.equal(viewport.width, actual.width)
      assert.equal(viewport.height, actual.height)
      assert("mode" in viewport && viewport.mode === "window")

      const box = data(await runtime.elementBox({ tabId, selector: "#bottom-control" }))
      assert.equal(box.inViewport, true)
      assert(box.box.x + box.box.width <= actual.width)
      assert(box.box.y + box.box.height <= actual.height)
      const x = box.box.x + box.box.width / 2
      const y = box.box.y + box.box.height / 2

      const capture = data(await runtime.screenshot({ tabId, path: join(root, "window.png") }))
      const png = await readPng(capture.path)
      assert.equal(png.width, actual.width)
      assert.equal(png.height, actual.height)
      assert("scale" in capture && capture.scale === "css")
      const inspected = data(await runtime.inspectPoint({ tabId, x, y, annotatedScreenshot: true, path: join(root, "point.png") }))
      assert(inspected.candidates.some(candidate => candidate.name === "Bottom control"))
      data(await runtime.mouse({ action: "move", tabId, x, y }))
      data(await runtime.click({ tabId, x, y }))
      assert.equal(await page.getAttribute("body", "data-clicked"), "yes")
    }
    await assertVisualTools(fixture)
  })
})

test("wheel coordinates target an inner scroll container instead of the previous pointer position", { timeout: 30_000 }, async () => {
  await withFixture(true, async ({ runtime, page, tabId }) => {
    data(await runtime.mouse({ action: "move", tabId, x: 300, y: 20 }))
    data(await callBrowserTool(runtime, "browser_mouse", { action: "wheel", tabId, x: 400, y: 200, deltaY: 600 }))
    await page.waitForFunction(() => document.querySelector("#pane")!.scrollTop > 0,
      undefined, { timeout: 1_500 }).catch(() => undefined)
    assert((await page.locator("#pane").evaluate(element => element.scrollTop)) > 0,
      "wheel x/y must move the pointer into the scroll container")

    const previous = await page.locator("#pane").evaluate(element => element.scrollTop)
    data(await runtime.mouse({ action: "wheel", tabId, deltaY: 300 }))
    await page.waitForFunction(top => document.querySelector("#pane")!.scrollTop > top,
      previous, { timeout: 1_500 })
    const pointerBefore = await page.getAttribute("body", "data-pointer")
    const wheelsBefore = await page.getAttribute("body", "data-wheels")
    const viewport = data(await runtime.viewport({ tabId }))
    for (const point of [
      { x: 40 }, { y: 40 }, { x: -1, y: 100 },
      { x: viewport.width, y: 100 }, { x: 100, y: viewport.height },
      { x: Number.NaN, y: 100 }, { x: 100, y: Infinity },
      { x: 400, y: 200, deltaX: 0, deltaY: 0 },
    ]) {
      const invalid = await runtime.mouse({ action: "wheel", tabId, deltaY: 600, ...point })
      assert.equal(invalid.error?.code, "invalid_request")
      assert.equal(await page.getAttribute("body", "data-pointer"), pointerBefore)
      assert.equal(await page.getAttribute("body", "data-wheels"), wheelsBefore)
    }
  })
})

test("new tabs, popups and context recovery retain normal window mode", { timeout: 30_000 }, async () => {
  await withFixture(false, async ({ runtime, page, tabId, url }) => {
    const fixed = data(await runtime.setViewport({ tabId, preset: "mobile" }))
    assert.equal(fixed.mode, "fixed")
    assert.equal(fixed.width, 390)
    const nextTab = data(await runtime.open({ url, newTab: true })).id
    const nextPage = pageFor(runtime, nextTab)
    await resizeWindow(nextPage, 900, 650)
    const nextViewport = data(await runtime.viewport({ tabId: nextTab }))
    assert.equal(nextViewport.mode, "window")
    assert.equal(nextViewport.width, (await geometry(nextPage)).width)
    assert.equal(data(await runtime.viewport({ tabId })).width, 390, "new tabs do not clear a sibling's explicit sizing")

    const popup = data(await runtime.expectPopup({ tabId: nextTab,
      action: { type: "click", selector: "#popup" } }))
    assert.equal(data(await runtime.viewport({ tabId: popup.id })).mode, "window")
    await page.context().close()
    assert.equal(data(await runtime.status()).contextLaunched, false)
    const recovered = data(await runtime.open({ url })).id
    const recoveredViewport = data(await runtime.viewport({ tabId: recovered }))
    assert.equal(recoveredViewport.mode, "window")
    assert.equal(recoveredViewport.width, (await geometry(pageFor(runtime, recovered))).width)
  }, async runtime => {
    data(await runtime.emulation({ action: "set", locale: "fr-FR" }))
  })
})

test("headless defaults and explicit presets remain fixed", { timeout: 30_000 }, async () => {
  await withFixture(true, async ({ runtime, tabId }) => {
    const initial = data(await runtime.viewport({ tabId }))
    assert.equal(initial.mode, "fixed")
    assert.equal(initial.width, 1280)
    assert.equal(initial.height, 900)
    for (const [preset, width, height] of [["desktop", 1280, 900], ["tablet", 820, 1180], ["mobile", 390, 844]] as const) {
      const resized = data(await runtime.setViewport({ tabId, preset }))
      assert.equal(resized.mode, "fixed")
      assert.equal(resized.width, width)
      assert.equal(resized.height, height)
    }
    assert.equal(data(await runtime.setViewport({ tabId, width: 777, height: 666 })).width, 777)
  })
})

test("explicit high-DPI emulation remains fixed while all images use CSS pixels", { timeout: 30_000 }, async () => {
  await withFixture(false, async fixture => {
    const { runtime, page, tabId, root } = fixture
    assert.equal(data(await runtime.viewport({ tabId })).mode, "fixed")
    assert.equal((await geometry(page)).dpr, 2)
    data(await runtime.setViewport({ tabId, width: 800, height: 500 }))
    const screenshot = data(await runtime.screenshot({ tabId, path: join(root, "hidpi.png") }))
    const png = await readPng(screenshot.path)
    assert.equal(png.width, 800)
    assert.equal(png.height, 500)
    await assertVisualTools(fixture)
  }, async runtime => {
    data(await runtime.emulation({ action: "set", deviceScaleFactor: 2 }))
  })
})

test("explicit mobile emulation still launches with a fixed viewport", { timeout: 30_000 }, async () => {
  await withFixture(false, async ({ runtime, tabId }) => {
    const viewport = data(await runtime.viewport({ tabId }))
    assert.equal(viewport.mode, "fixed")
    assert.equal(viewport.width, 1280)
    assert.equal(viewport.height, 900)
  }, async runtime => {
    data(await runtime.emulation({ action: "set", isMobile: true, hasTouch: true }))
  })
})

test("native viewport reads fail promptly for an open dialog and recover after handling it", { timeout: 15_000 }, async () => {
  await withFixture(false, async ({ runtime, tabId, root }) => {
    data(await runtime.click({ tabId, selector: "#dialog" }))
    const started = Date.now()
    for (const result of [
      await runtime.viewport({ tabId }),
      await runtime.mouse({ action: "move", tabId, x: 100, y: 100 }),
      await runtime.elementBox({ tabId, selector: "#bottom-control" }),
      await runtime.screenshot({ tabId, path: join(root, "dialog.png") }),
    ]) {
      assert.equal(result.ok, false)
      assert.match(result.error?.message ?? "", /browser_dialog/)
    }
    assert(Date.now() - started < 2_000, "dialog preflight avoids blocked renderer evaluation")
    data(await runtime.handleDialog({ tabId, accept: true }))
    assert.equal(data(await runtime.viewport({ tabId })).mode, "window")
  })
})
