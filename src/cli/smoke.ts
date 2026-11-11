#!/usr/bin/env node
import { createHash } from "node:crypto"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { dirname, relative, resolve } from "node:path"
import { PNG } from "pngjs"

import { BrowserRuntime } from "../browser-runtime.js"
import { loadConfig } from "../config.js"
import type {
  ArtifactEntry,
  DialogInfo,
  PageSummary,
  SnapshotElement,
  ToolResult,
} from "../contracts.js"

const DEFAULT_SMOKE_TIMEOUT_MS = 180_000

const baseConfig = loadConfig()
const smokeHeadless =
  process.env.CHROME_POWER_HEADLESS == null ||
  process.env.CHROME_POWER_HEADLESS === ""
    ? true
    : baseConfig.headless
const smokeTimeoutMs = envPositiveNumber(
  "CHROME_POWER_SMOKE_TIMEOUT_MS",
  DEFAULT_SMOKE_TIMEOUT_MS
)
const config = {
  ...baseConfig,
  headless: smokeHeadless,
}

const runtime = new BrowserRuntime(config)
const deviceRuntime = new BrowserRuntime(config)
const fixturePath = resolve(config.screenshotDir, "smoke-fixture.html")
const targetPath = resolve(config.screenshotDir, "smoke-target.html")
const framePath = resolve(config.screenshotDir, "smoke-frame.html")
const assetStylePath = resolve(config.screenshotDir, "smoke-assets.css")
const assetScriptPath = resolve(config.screenshotDir, "smoke-assets.js")
const uploadPath = resolve(config.screenshotDir, "smoke-upload.txt")
const secondUploadPath = resolve(config.screenshotDir, "smoke-upload-second.txt")
const fixtureUrl = `file://${fixturePath}`
const targetUrl = `file://${targetPath}`
const frameUrl = `file://${framePath}`
const assetStyleUrl = `file://${assetStylePath}`
const assetScriptUrl = `file://${assetScriptPath}`
const diagnosticConsoleSourceUrl =
  "https://user:password@example.test/console-smoke.js?token=smoke-diagnostic#fragment"
const diagnosticConsolePageUrl = `data:text/html,${encodeURIComponent(
  `<script>console.warn("diagnostic console URL smoke")\n//# sourceURL=${diagnosticConsoleSourceUrl}</script>`
)}`
const geolocationPage = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Chrome Power Environment Smoke</title>
  </head>
  <body>
    <main>
      <h1>Environment Smoke</h1>
      <button id="read-geolocation" onclick="navigator.geolocation.getCurrentPosition(
        (position) => {
          document.querySelector('#geolocation-output').textContent =
            position.coords.latitude.toFixed(4) + ',' +
            position.coords.longitude.toFixed(4) + ',' +
            Math.round(position.coords.accuracy);
        },
        (error) => {
          document.querySelector('#geolocation-output').textContent =
            'error:' + error.code + ':' + error.message;
        },
        { timeout: 5000 }
      )">Read geolocation</button>
      <p id="geolocation-output"></p>
    </main>
  </body>
</html>
`
const geolocationServer = await listenOnLoopback(geolocationPage)
const geolocationUrl = `http://127.0.0.1:${geolocationServer.port}`
const networkSmokeServer = await listenOnNetworkSmoke()
const networkSmokeUrl = `http://127.0.0.1:${networkSmokeServer.port}`
const webSocketSmokeServer = await listenOnWebSocketSmoke()
const webSocketSmokeUrl = `http://127.0.0.1:${webSocketSmokeServer.port}`

await mkdir(dirname(fixturePath), { recursive: true })
await writeFile(uploadPath, "smoke upload file")
await writeFile(secondUploadPath, "second smoke upload file")
await writeFile(
  assetStylePath,
  `@font-face { font-family: SmokeAssetFont; src: url('file:///definitely-missing-chrome-power-font.woff2'); }
  #asset-background { font-family: SmokeAssetFont, sans-serif; }`
)
await writeFile(assetScriptPath, "window.__chromePowerAssetScript = true")
await writeFile(
  framePath,
  `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Chrome Power Smoke Frame</title>
  </head>
  <body>
    <main>
      <h2>Smoke Frame Title</h2>
      <svg id="frame-asset-svg" width="18" height="9" viewBox="0 0 18 9"><rect width="18" height="9"></rect></svg>
      <p data-testid="frame-copy">Frame locator text</p>
      <input id="frame-message" aria-label="Frame message" placeholder="Frame type here" onfocus="document.querySelector('#frame-focus-output').textContent = 'frame semantic focused'">
      <button id="frame-copy-button" onclick="document.querySelector('#frame-output').textContent = document.querySelector('#frame-message').value">Frame Copy</button>
      <input id="frame-upload" aria-label="Frame upload" type="file" onchange="document.querySelector('#upload-output').textContent = this.files.length + ':' + this.files[0].name">
      <input id="frame-upload-multiple" aria-label="Frame upload multiple" type="file" multiple onchange="document.querySelector('#upload-multiple-output').textContent = Array.from(this.files).map(file => file.name).join(',')">
      <button id="frame-chooser-button" onclick="document.querySelector('#frame-upload').click()">Choose File</button>
      <p id="frame-output"></p>
      <span id="frame-focus-output"></span>
      <p id="upload-output"></p>
      <p id="upload-multiple-output"></p>
    </main>
  </body>
</html>
`
)
await writeFile(
  fixturePath,
  `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Chrome Power Smoke</title>
    <link rel="stylesheet" href="${assetStyleUrl}">
    <script src="${assetScriptUrl}"></script>
    <style>
      #hover-target,
      #drag-source,
      #drop-target {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 120px;
        height: 44px;
        margin: 8px;
        border: 1px solid #333;
      }
      #desktop-viewport,
      #mobile-viewport {
        display: none;
      }
      @media (min-width: 800px) {
        #desktop-viewport {
          display: block;
        }
      }
      @media (max-width: 500px) {
        #mobile-viewport {
          display: block;
        }
      }
      #media-dark, #media-reduced, #media-forced { display: none; }
      #element-visual-target { width: 120px; height: 44px; background: rgb(20, 120, 220); }
      #element-offscreen-target { position: absolute; top: 3000px; left: 20px; width: 140px; height: 40px; }
      @media (prefers-color-scheme: dark) { #media-dark { display: block; } }
      @media (prefers-reduced-motion: reduce) { #media-reduced { display: block; } }
      @media (forced-colors: active) { #media-forced { display: block; } }
    </style>
  </head>
  <body>
    <script>
      console.log('smoke log entry');
      console.warn('smoke warn entry');
      console.error('smoke error entry');
      setTimeout(() => {
        throw new Error('smoke page error');
      }, 0);
      fetch('http://127.0.0.1:1/smoke-network-fail').catch(() => {});
    </script>
    <main>
      <h1>Chrome Power Smoke</h1>
      <section aria-label="Emulation diagnostics">
        <p id="emulation-user-agent"></p>
        <p id="emulation-locale"></p>
        <p id="emulation-timezone"></p>
        <p id="emulation-dpr"></p>
        <p id="emulation-touch"></p>
      </section>
      <p id="desktop-viewport">Desktop viewport active</p>
      <p id="mobile-viewport">Mobile viewport active</p>
      <p id="media-dark">Dark media active</p>
      <p id="media-reduced">Reduced motion active</p>
      <p id="media-forced">Forced colors active</p>
      <button id="element-visual-target" aria-label="Element visual target">Visual target</button>
      <button id="element-offscreen-target" aria-label="Offscreen visual target">Offscreen target</button>
      <input id="fine-input" aria-label="Fine input" oninput="document.querySelector('#fine-input-output').textContent = this.value">
      <button id="fine-mouse" aria-label="Fine mouse" onpointerdown="document.querySelector('#fine-mouse-output').textContent = 'mouse down'" onpointerup="document.querySelector('#fine-mouse-output').textContent = 'mouse up'">Fine mouse</button>
      <span id="fine-input-output"></span><span id="fine-mouse-output"></span>
      <section aria-label="Locator playground">
        <p data-testid="locator-copy" data-kind="p1">Locator text alpha</p>
        <p class="locator-item">First locator item</p>
        <p class="locator-item">Second locator item</p>
        <label>Email locator <input id="locator-email" aria-label="Locator email" placeholder="Locator email placeholder" oninput="document.querySelector('#locator-email-output').textContent = this.value"></label>
        <button data-testid="locator-action" aria-label="Locator action" onclick="document.querySelector('#locator-action-output').textContent = 'locator clicked'">Locator Action</button>
        <button class="locator-index-action" onmouseenter="document.querySelector('#locator-index-output').textContent = 'first hover index'" onclick="document.querySelector('#locator-index-output').textContent = 'first index'">Repeated locator action</button>
        <button class="locator-index-action" onmouseenter="document.querySelector('#locator-index-output').textContent = 'second hover index'" onclick="document.querySelector('#locator-index-output').textContent = 'second index'">Repeated locator action</button>
        <input data-testid="locator-key" aria-label="Locator key" onkeydown="if (event.key === 'Enter') document.querySelector('#locator-key-output').textContent = 'locator pressed'">
        <button aria-label="Locator hover" onmouseenter="document.querySelector('#locator-hover-output').textContent = 'semantic hover done'">Locator Hover</button>
        <input data-testid="locator-focus" aria-label="Locator focus" onfocus="document.querySelector('#locator-focus-output').textContent = 'locator focused'">
        <label><input data-testid="locator-check" type="checkbox" aria-label="Locator check" onchange="document.querySelector('#locator-check-output').textContent = this.checked ? 'locator checked' : 'locator unchecked'"> Locator check</label>
        <select data-testid="locator-select" aria-label="Locator select" onchange="document.querySelector('#locator-select-output').textContent = this.value">
          <option value="">Choose locator option</option>
          <option value="alpha">Locator Alpha</option>
          <option value="beta">Locator Beta</option>
        </select>
        <button aria-label="Locator dialog" onclick="alert('locator alert')">Locator Dialog</button>
        <p id="locator-action-output"></p>
        <p id="locator-email-output"></p>
        <p id="locator-index-output"></p>
        <p id="locator-key-output"></p>
        <span id="locator-hover-output"></span>
        <span id="locator-focus-output"></span>
        <span id="locator-check-output"></span>
        <span id="locator-select-output"></span>
        <button id="disabled-action" disabled>Disabled locator</button>
        <div id="delayed-visible" hidden>Delayed locator ready</div>
      </section>
      <input id="message" placeholder="Type here">
      <button id="copy" onclick="document.querySelector('#output').textContent = document.querySelector('#message').value">Copy</button>
      <button id="delayed-console" onclick="setTimeout(() => console.error('future smoke console error'), 100)">Delayed console</button>
      <button id="delayed-page-error" onclick="setTimeout(() => { throw new Error('future smoke page error') }, 100)">Delayed page error</button>
      <button id="performance-interaction" onclick="const started=performance.now(); while(performance.now()-started<70){}; document.querySelector('#performance-shift').style.marginTop='80px'">Performance interaction</button>
      <div id="performance-shift">Performance shift target</div>
      <input id="ref-message" aria-label="Ref message" placeholder="Ref type here">
      <button id="ref-copy" onclick="document.querySelector('#ref-output').textContent = document.querySelector('#ref-message').value">Copy ref</button>
      <input id="password" type="password" name="password" aria-label="password" value="super-secret-password">
      <input id="api-token" name="api_token" aria-label="api-token" value="super-secret-token">
      <input id="card-number" autocomplete="cc-number" aria-label="Card number" value="4111111111111111">
      <input id="card-cvv" autocomplete="cc-csc" aria-label="Card CVV" value="123">
      <input id="ssn" name="social-security-number" aria-label="SSN" value="123-45-6789">
      <input id="iban" name="iban" aria-label="IBAN" value="DE89370400440532013000">
      <input id="account-number" name="bank_account_number" aria-label="Bank account number" value="9876543210">
      <input id="zip-code" name="zipcode" aria-label="ZIP code" value="200000">
      <input id="postal-code" name="postal_code" aria-label="Postal code" value="SW1A 1AA">
      <div id="account-number-editor" role="textbox" contenteditable="true" aria-label="Bank account number editor">contenteditable-account-secret</div>
      <input id="key-input" aria-label="Key input" value="press ready" onkeydown="if (event.key === 'Enter') document.querySelector('#key-output').textContent = 'pressed enter'">
      <label><input id="agree" type="checkbox" aria-label="Agree terms"> Agree</label>
      <select id="flavor" aria-label="Flavor" onchange="document.querySelector('#select-output').textContent = 'select=' + this.value">
        <option value="">Choose</option>
        <option value="alpha">Alpha</option>
        <option value="beta">Beta</option>
      </select>
      <button id="dbl" ondblclick="document.querySelector('#dbl-output').textContent = 'double clicked'">Double</button>
      <div id="hover-target" role="button" aria-label="Hover target" onmouseenter="document.querySelector('#hover-output').textContent = 'hovered'">Hover</div>
      <div id="drag-source" role="button" aria-label="Drag source" onpointerdown="window.__dragging = true">Drag</div>
      <div id="drop-target" role="button" aria-label="Drop target" onpointerup="if (window.__dragging) { document.querySelector('#drag-output').textContent = 'dropped'; window.__dragging = false; }">Drop</div>
      <button id="alert-button" onclick="alert('smoke alert'); document.querySelector('#dialog-output').textContent = 'alert handled'">Alert</button>
      <button id="confirm-button" onclick="document.querySelector('#dialog-output').textContent = confirm('smoke confirm') ? 'confirm accepted' : 'confirm dismissed'">Confirm</button>
      <button id="prompt-button" onclick="const value = prompt('smoke prompt', 'seed'); document.querySelector('#dialog-output').textContent = value ? 'prompt=' + value : 'prompt dismissed'">Prompt</button>
      <a id="nav-link" href="${targetUrl}">Go target</a>
      <a id="popup-link" target="_blank" href="${targetUrl}">Open popup</a>
      <button id="multi-popup" onclick="window.open('${targetUrl}'); window.open('${targetUrl}#second')">Open two popups</button>
      <a id="download-link" download="smoke-download.txt" href="data:text/plain;charset=utf-8,smoke%20download">Download</a>
      <section id="asset-background" style="width:32px;height:24px;background-image:url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2232%22 height=%2224%22/%3E')">
        <img class="asset-duplicate" alt="asset one" width="16" height="12" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2216%22 height=%2212%22/%3E">
        <img class="asset-duplicate" alt="asset two" width="32" height="24" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2216%22 height=%2212%22/%3E">
        <picture><source media="(min-width: 1px)" srcset="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2212%22/%3E"><img alt="responsive asset" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%226%22/%3E"></picture>
        <img id="asset-missing" alt="missing asset" src="file:///definitely-missing-chrome-power-asset.png">
        <video width="40" height="20"><source src="file:///definitely-missing-chrome-power-video.mp4"></video>
        <audio><source src="file:///definitely-missing-chrome-power-audio.mp3"></audio>
        <svg id="asset-inline-svg" width="40" height="20" viewBox="0 0 40 20"><rect width="40" height="20"></rect></svg>
      </section>
      <iframe id="smoke-frame" name="smoke-frame" title="Smoke frame" src="${frameUrl}"></iframe>
      <p id="output"></p>
      <p id="ref-output"></p>
      <p id="key-output"></p>
      <p id="select-output"></p>
      <p id="dbl-output"></p>
      <p id="hover-output"></p>
      <p id="drag-output"></p>
      <p id="dialog-output"></p>
    </main>
    <script>
      document.querySelector('#emulation-user-agent').textContent = navigator.userAgent;
      document.querySelector('#emulation-locale').textContent = navigator.language;
      document.querySelector('#emulation-timezone').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
      document.querySelector('#emulation-dpr').textContent = String(window.devicePixelRatio);
      document.querySelector('#emulation-touch').textContent = String(navigator.maxTouchPoints);
      setTimeout(() => {
        document.querySelector('#delayed-visible').hidden = false;
      }, 100);
    </script>
  </body>
</html>
`
)
await writeFile(
  targetPath,
  `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Chrome Power Smoke Target</title>
  </head>
  <body>
    <main>
      <h1>Chrome Power Smoke Target</h1>
      <a id="return-link" href="${fixtureUrl}">Return</a>
    </main>
  </body>
</html>
`
)

try {
  await withSmokeTimeout(runSmoke())
} finally {
  await deviceRuntime.dispose()
  await runtime.dispose()
  await closeServer(webSocketSmokeServer.server)
  await closeServer(networkSmokeServer.server)
  await closeServer(geolocationServer.server)
}

async function runDeviceSmoke() {
  try {
    const initialDevices = await deviceRuntime.device({ action: "get" })
    assertOk(initialDevices, "devices")
    assertEqual(
      initialDevices.data.contextLaunched,
      false,
      "initial devices context"
    )
    assertArrayIncludes(
      initialDevices.data.presets.map((preset) => preset.name),
      "pixel-5",
      "device presets"
    )
    assertArrayIncludes(
      initialDevices.data.presets.map((preset) => preset.name),
      "galaxy-tab-s9",
      "device presets"
    )

    const unknownDevice = await deviceRuntime.setDevice({
      preset: "iphone-13",
    })
    assertError(unknownDevice, "unknown device preset", "invalid_request")

    const mixedDeviceMode = await deviceRuntime.setDevice({
      preset: "pixel-5",
      clear: true,
    })
    assertError(mixedDeviceMode, "mixed device mode", "invalid_request")

    const prelaunchDevice = await deviceRuntime.device({
      action: "set",
      preset: "pixel-5",
    })
    assertOk(prelaunchDevice, "prelaunch device")
    assertEqual(
      prelaunchDevice.data.active?.name,
      "pixel-5",
      "prelaunch active device"
    )
    assertEqual(
      prelaunchDevice.data.contextLaunched,
      false,
      "prelaunch device context"
    )

    const deviceOpened = await deviceRuntime.open({
      url: fixtureUrl,
      newTab: true,
    })
    assertOk(deviceOpened, "device open")

    const activeDevices = await deviceRuntime.devices()
    assertOk(activeDevices, "active devices")
    assertEqual(
      activeDevices.data.active?.name,
      "pixel-5",
      "active device"
    )
    assertEqual(
      activeDevices.data.appliedToCurrentContext,
      true,
      "active device applied"
    )

    const pixelViewport = await deviceRuntime.viewport()
    assertOk(pixelViewport, "pixel device viewport")
    assertEqual(pixelViewport.data.width, 393, "pixel viewport width")
    assertEqual(pixelViewport.data.height, 727, "pixel viewport height")

    const deviceUserAgent = await deviceRuntime.locatorText({
      locator: { selector: "#emulation-user-agent" },
    })
    assertOk(deviceUserAgent, "device user agent")
    assertStringIncludes(
      deviceUserAgent.data.text ?? "",
      "Pixel 5",
      "device user agent"
    )

    const deviceDpr = await deviceRuntime.locatorText({
      locator: { selector: "#emulation-dpr" },
    })
    assertOk(deviceDpr, "device DPR")
    assertEqual(deviceDpr.data.text, "2.75", "device DPR")

    const deviceTouch = await deviceRuntime.locatorText({
      locator: { selector: "#emulation-touch" },
    })
    assertOk(deviceTouch, "device touch")
    assertEqual(deviceTouch.data.text, "1", "device touch")

    const deviceChangeWithoutConfirmation = await deviceRuntime.setDevice({
      preset: "galaxy-tab-s9",
    })
    assertError(
      deviceChangeWithoutConfirmation,
      "device confirmation",
      "invalid_request"
    )

    assertOk(
      await deviceRuntime.setGeolocation({
        latitude: 31.2304,
        longitude: 121.4737,
        accuracy: 12,
      }),
      "device set geolocation"
    )
    assertOk(
      await deviceRuntime.setPermissions({
        permissions: ["geolocation"],
        origin: geolocationUrl,
      }),
      "device grant geolocation permission"
    )
    assertOk(
      await deviceRuntime.open({ url: geolocationUrl }),
      "device open geolocation page"
    )
    assertOk(
      await deviceRuntime.click({ selector: "#read-geolocation" }),
      "device click geolocation"
    )
    assertOk(
      await deviceRuntime.wait({ selector: "text=31.2304,121.4737,12" }),
      "device geolocation wait"
    )

    const confirmedDevice = await deviceRuntime.setDevice({
      preset: "galaxy-tab-s9",
      confirmed: true,
    })
    assertOk(confirmedDevice, "confirmed device relaunch")
    assertEqual(
      confirmedDevice.data.active?.name,
      "galaxy-tab-s9",
      "confirmed active device"
    )
    assertEqual(
      confirmedDevice.data.relaunched,
      true,
      "confirmed device relaunched"
    )

    const oldDeviceTab = await deviceRuntime.current({
      tabId: deviceOpened.tabId,
    })
    assertError(oldDeviceTab, "old device tab", "tab_not_found")

    assertOk(
      await deviceRuntime.open({ url: geolocationUrl }),
      "device open geolocation after relaunch"
    )
    assertOk(
      await deviceRuntime.click({ selector: "#read-geolocation" }),
      "device click geolocation after relaunch"
    )
    assertOk(
      await deviceRuntime.wait({ selector: "text=31.2304,121.4737,12" }),
      "device geolocation wait after relaunch"
    )

    const clearDeviceWithoutConfirmation = await deviceRuntime.setDevice({
      clear: true,
    })
    assertError(
      clearDeviceWithoutConfirmation,
      "clear device confirmation",
      "invalid_request"
    )

    const clearedDevice = await deviceRuntime.setDevice({
      clear: true,
      confirmed: true,
    })
    assertOk(clearedDevice, "clear device")
    assertEqual(clearedDevice.data.active, undefined, "cleared active device")
    assertEqual(
      clearedDevice.data.relaunched,
      true,
      "cleared device relaunched"
    )
    const emulationAfterClearDevice = await deviceRuntime.emulation()
    assertOk(emulationAfterClearDevice, "emulation after clear device")
    assertEqual(
      Object.keys(emulationAfterClearDevice.data.overrides).length,
      0,
      "device clear emulation fields"
    )

    const manualViewportDevice = await deviceRuntime.setDevice({
      preset: "pixel-5",
      confirmed: true,
    })
    assertOk(manualViewportDevice, "manual viewport device")
    assertOk(
      await deviceRuntime.open({ url: fixtureUrl }),
      "manual viewport fixture"
    )
    assertOk(
      await deviceRuntime.setViewport({ width: 777, height: 666 }),
      "manual viewport clears device"
    )
    const devicesAfterViewport = await deviceRuntime.devices()
    assertOk(devicesAfterViewport, "devices after manual viewport")
    assertEqual(
      devicesAfterViewport.data.active,
      undefined,
      "manual viewport active device"
    )

    const manualEmulationDevice = await deviceRuntime.setDevice({
      preset: "pixel-5",
      confirmed: true,
    })
    assertOk(manualEmulationDevice, "manual emulation device")
    assertOk(
      await deviceRuntime.setEmulation({
        locale: "en-US",
        confirmed: true,
      }),
      "manual emulation clears device"
    )
    const devicesAfterEmulation = await deviceRuntime.devices()
    assertOk(devicesAfterEmulation, "devices after manual emulation")
    assertEqual(
      devicesAfterEmulation.data.active,
      undefined,
      "manual emulation active device"
    )

    return {
      covered:
        initialDevices.ok &&
        prelaunchDevice.ok &&
        activeDevices.ok &&
        pixelViewport.ok &&
        deviceUserAgent.ok &&
        deviceDpr.ok &&
        deviceTouch.ok &&
        unknownDevice.error?.code === "invalid_request" &&
        mixedDeviceMode.error?.code === "invalid_request" &&
        deviceChangeWithoutConfirmation.error?.code === "invalid_request" &&
        confirmedDevice.ok &&
        oldDeviceTab.error?.code === "tab_not_found" &&
        clearDeviceWithoutConfirmation.error?.code === "invalid_request" &&
        clearedDevice.ok &&
        emulationAfterClearDevice.ok &&
        manualViewportDevice.ok &&
        devicesAfterViewport.ok &&
        manualEmulationDevice.ok &&
        devicesAfterEmulation.ok,
    }
  } finally {
    await deviceRuntime.dispose()
  }
}

async function runSmoke() {
  const deviceSmoke = await runDeviceSmoke()
  const preOpenStatus = await runtime.status()
  assertOk(preOpenStatus, "pre-open status")
  assertEqual(preOpenStatus.data.contextLaunched, false, "pre-open context")
  assertEqual(preOpenStatus.data.tabCount, 0, "pre-open tab count")
  assertNotEqual(preOpenStatus.data.runtime.packageVersion, "unknown", "runtime version")
  assertEqual(preOpenStatus.data.runtime.mode, "direct", "direct runtime mode")
  assertEqual(
    preOpenStatus.data.config.profileDir,
    config.profileDir,
    "status profile dir"
  )
  assertEqual(
    preOpenStatus.data.config.screenshotDir,
    config.screenshotDir,
    "status screenshot dir"
  )
  assertEqual(
    preOpenStatus.data.config.screenshotInlineMaxBytes,
    config.screenshotInlineMaxBytes,
    "status screenshot inline limit"
  )
  assertEqual(
    preOpenStatus.data.config.downloadDir,
    config.downloadDir,
    "status download dir"
  )
  assertArrayExcludes(
    preOpenStatus.data.environment.deferred.contextRelaunchRequired,
    "userAgent",
    "environment deferred emulation fields"
  )

  const initialEmulation = await runtime.emulation({ action: "get" })
  assertOk(initialEmulation, "initial emulation")
  assertEqual(
    initialEmulation.data.contextLaunched,
    false,
    "initial emulation context"
  )
  assertArrayIncludes(
    initialEmulation.data.supported,
    "isMobile",
    "supported emulation fields"
  )

  const prelaunchEmulation = await runtime.emulation({
    action: "set",
    userAgent: "ChromePowerSmoke/1.0",
    locale: "fr-FR",
    timezoneId: "Asia/Shanghai",
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  })
  assertOk(prelaunchEmulation, "prelaunch emulation")
  assertEqual(
    prelaunchEmulation.data.contextLaunched,
    false,
    "prelaunch emulation context"
  )
  assertEqual(
    prelaunchEmulation.data.overrides.userAgent,
    "ChromePowerSmoke/1.0",
    "prelaunch emulation user agent"
  )
  assertEqual(
    prelaunchEmulation.data.overrides.locale,
    "fr-FR",
    "prelaunch emulation locale"
  )

  const opened = await runtime.open({ url: fixtureUrl, newTab: true })
  assertOk(opened, "open")
  const openerTabId = opened.data.id

  const assets = await runtime.assets()
  assertOk(assets, "asset inventory")
  assertEqual(assets.data.frameId.includes("_main"), true, "asset main frame")
  const duplicateAsset = assets.data.assets.find(
    (asset) => asset.kind === "image" && asset.scheme === "data"
  )
  if (!duplicateAsset) throw new Error("asset inventory missing data image")
  assertEqual(duplicateAsset.occurrenceCount, 2, "asset duplicate aggregation")
  assertEqual(duplicateAsset.url, undefined, "asset data URL hidden")
  assertEqual(
    assets.data.frameUrl.includes("data:image"),
    false,
    "asset frame URL cannot indirectly expose data assets"
  )
  assertEqual(duplicateAsset.state, "inline", "asset data URL state")
  const inlineSvg = assets.data.assets.find(
    (asset) => asset.kind === "inline_svg"
  )
  if (!inlineSvg) throw new Error("asset inventory missing inline SVG")
  assertEqual(inlineSvg.viewBox?.width, 40, "asset inline SVG viewBox")
  assertNoKeys(
    duplicateAsset,
    ["body", "headers", "postData", "markup", "source", "content"],
    "asset inventory metadata boundary"
  )
  const filteredAssets = await runtime.assets({
    kinds: ["inline_svg"],
    states: ["inline"],
    limit: 1,
  })
  assertOk(filteredAssets, "filtered asset inventory")
  assertEqual(filteredAssets.data.returnedCount, 1, "asset filtered count")

  await runtime.wait({ timeoutMs: 250 })
  const initialPerformance = await runtime.performanceSummary({
    sortResourcesBy: "duration",
    resourceLimit: 5,
  })
  assertOk(initialPerformance, "initial performance summary")
  assertEqual(
    initialPerformance.data.completeness.earlyObserverInstalled,
    true,
    "performance observer installed early"
  )
  assertEqual(
    initialPerformance.data.vitals.fcp.available,
    true,
    "performance FCP available"
  )
  assertEqual(
    initialPerformance.data.longTasks.available,
    true,
    "performance long tasks supported"
  )
  assertEqual(
    initialPerformance.data.vitals.inp.available,
    false,
    "performance INP unavailable before interaction"
  )
  assertEqual(
    initialPerformance.data.resources.returnedCount <= 5,
    true,
    "performance resource limit"
  )
  assertNoKeys(
    initialPerformance.data,
    ["body", "headers", "postData", "target", "selector", "stack", "attribution"],
    "performance summary metadata boundary"
  )
  assertOk(
    await runtime.click({ selector: "#performance-interaction" }),
    "performance interaction"
  )
  await runtime.wait({ timeoutMs: 100 })
  const interactedPerformance = await runtime.performanceSummary()
  assertOk(interactedPerformance, "interacted performance summary")
  assertEqual(
    interactedPerformance.data.vitals.inp.available,
    true,
    "performance INP available after interaction"
  )

  const selectorPopup = await runtime.expectPopup({
    tabId: openerTabId,
    action: { type: "click", selector: "#popup-link" },
    waitUntil: "domcontentloaded",
  })
  assertOk(selectorPopup, "selector popup")
  assertEqual(
    selectorPopup.data.openerTabId,
    openerTabId,
    "selector popup opener"
  )
  assertEqual(
    selectorPopup.data.title,
    "Chrome Power Smoke Target",
    "selector popup title"
  )

  assertOk(await runtime.selectTab(openerTabId), "reselect popup opener")
  const popupSnapshot = await runtime.snapshot({ tabId: openerTabId })
  assertOk(popupSnapshot, "popup opener snapshot")
  const popupLink = popupSnapshot.data.elements.find(
    (element) => element.text === "Open popup"
  )
  if (!popupLink) throw new Error("popup link ref missing")
  const refPopup = await runtime.expectPopup({
    tabId: openerTabId,
    action: { type: "click", ref: popupLink.ref },
  })
  assertOk(refPopup, "ref popup")
  assertEqual(refPopup.data.openerTabId, openerTabId, "ref popup opener")

  assertOk(await runtime.selectTab(openerTabId), "reselect opener after ref popup")
  const missingPopup = await runtime.expectPopup({
    tabId: openerTabId,
    action: { type: "click", selector: "#copy" },
    timeoutMs: 100,
  })
  assertError(missingPopup, "missing popup", "popup_failed")

  const tabsBeforeMultiplePopups = await runtime.tabs()
  assertOk(tabsBeforeMultiplePopups, "tabs before multiple popups")
  const multiplePopup = await runtime.expectPopup({
    tabId: openerTabId,
    action: { type: "click", selector: "#multi-popup" },
  })
  assertOk(multiplePopup, "multiple popup first result")
  await runtime.wait({ tabId: multiplePopup.tabId, timeoutMs: 100 })
  const tabsAfterMultiplePopups = await runtime.tabs()
  assertOk(tabsAfterMultiplePopups, "tabs after multiple popups")
  assertEqual(
    tabsAfterMultiplePopups.data.tabs.length >=
      tabsBeforeMultiplePopups.data.tabs.length + 2,
    true,
    "additional popups remain tracked"
  )
  assertOk(await runtime.selectTab(openerTabId), "reselect opener after multiple popups")

  const appliedEmulation = await runtime.emulation()
  assertOk(appliedEmulation, "applied emulation")
  assertEqual(
    appliedEmulation.data.contextLaunched,
    true,
    "applied emulation context"
  )
  assertEqual(
    appliedEmulation.data.appliedToCurrentContext,
    true,
    "applied emulation current context"
  )

  const emulatedUserAgent = await runtime.locatorText({
    locator: { selector: "#emulation-user-agent" },
  })
  assertOk(emulatedUserAgent, "emulated user agent")
  assertStringIncludes(
    emulatedUserAgent.data.text ?? "",
    "ChromePowerSmoke/1.0",
    "emulated user agent"
  )

  const emulatedLocale = await runtime.locatorText({
    locator: { selector: "#emulation-locale" },
  })
  assertOk(emulatedLocale, "emulated locale")
  assertEqual(emulatedLocale.data.text, "fr-FR", "emulated locale")

  const emulatedTimezone = await runtime.locatorText({
    locator: { selector: "#emulation-timezone" },
  })
  assertOk(emulatedTimezone, "emulated timezone")
  assertEqual(
    emulatedTimezone.data.text,
    "Asia/Shanghai",
    "emulated timezone"
  )

  const emulatedDpr = await runtime.locatorText({
    locator: { selector: "#emulation-dpr" },
  })
  assertOk(emulatedDpr, "emulated device scale factor")
  assertEqual(emulatedDpr.data.text, "2", "emulated device scale factor")

  const emulatedTouch = await runtime.locatorText({
    locator: { selector: "#emulation-touch" },
  })
  assertOk(emulatedTouch, "emulated touch")
  assertEqual(emulatedTouch.data.text, "1", "emulated touch")

  const postOpenStatus = await runtime.status()
  assertOk(postOpenStatus, "post-open status")
  assertEqual(postOpenStatus.data.contextLaunched, true, "post-open context")
  assertEqual(
    postOpenStatus.data.tabCount >= 1,
    true,
    "post-open tab count"
  )
  assertEqual(
    postOpenStatus.data.activeTabId,
    opened.tabId,
    "post-open active tab"
  )
  assertEqual(
    postOpenStatus.data.tabs.some((tab) => tab.id === opened.tabId),
    true,
    "post-open status tabs"
  )
  assertEqual(
    postOpenStatus.data.environment.supportedPermissions.includes("geolocation"),
    true,
    "status environment metadata"
  )

  // The headed regression covers native window resizing. Keep this broad
  // fixture deterministic even when smoke is explicitly run with a window.
  if (!config.headless) {
    assertOk(await runtime.setViewport({ preset: "desktop" }), "fixed smoke viewport")
  }
  const initialViewport = await runtime.viewport()
  assertOk(initialViewport, "viewport")
  assertEqual(initialViewport.data.width, 1280, "default viewport width")
  assertEqual(initialViewport.data.height, 900, "default viewport height")
  assertEqual(initialViewport.data.preset, "desktop", "default viewport preset")
  assertOkWithoutNarrowing(
    await runtime.locatorWait({
      locator: { text: "Desktop viewport active", exact: true },
      state: "visible",
    }),
    "desktop viewport marker"
  )

  const mobileViewport = await runtime.viewport({ action: "set", preset: "mobile" })
  assertOk(mobileViewport, "set mobile viewport")
  assertEqual(mobileViewport.data.width, 390, "mobile viewport width")
  assertEqual(mobileViewport.data.height, 844, "mobile viewport height")
  assertEqual(mobileViewport.data.preset, "mobile", "mobile viewport preset")
  assertOkWithoutNarrowing(
    await runtime.locatorWait({
      locator: { text: "Mobile viewport active", exact: true },
      state: "visible",
    }),
    "mobile viewport marker"
  )

  const explicitViewport = await runtime.setViewport({ width: 777, height: 666 })
  assertOk(explicitViewport, "set explicit viewport")
  assertEqual(explicitViewport.data.width, 777, "explicit viewport width")
  assertEqual(explicitViewport.data.height, 666, "explicit viewport height")
  assertEqual(explicitViewport.data.preset, undefined, "explicit viewport preset")

  const unknownViewportPreset = await runtime.setViewport({
    preset: "watch",
  })
  assertError(unknownViewportPreset, "unknown viewport preset", "invalid_request")

  const partialViewport = await runtime.setViewport({ width: 640 })
  assertError(partialViewport, "partial viewport", "invalid_request")

  assertOk(await runtime.setViewport({ preset: "desktop" }), "restore viewport")

  const initialEnvironment = await runtime.browserContext({ action: "get" })
  assertOk(initialEnvironment, "environment")
  assertArrayIncludes(
    initialEnvironment.data.supportedPermissions,
    "geolocation",
    "supported permissions"
  )
  assertArrayIncludes(
    initialEnvironment.data.supportedPermissions,
    "notifications",
    "supported permissions"
  )

  const geolocation = await runtime.browserContext({
    action: "geolocation",
    latitude: 31.2304,
    longitude: 121.4737,
    accuracy: 12,
  })
  assertOk(geolocation, "set geolocation")
  assertEqual(
    geolocation.data.geolocation?.latitude,
    31.2304,
    "geolocation latitude"
  )
  assertEqual(
    geolocation.data.geolocation?.longitude,
    121.4737,
    "geolocation longitude"
  )

  const permissionGrant = await runtime.setPermissions({
    permissions: ["geolocation"],
    origin: geolocationUrl,
  })
  assertOk(permissionGrant, "grant geolocation permission")
  if (
    !permissionGrant.data.permissionGrants.some(
      (grant) =>
        grant.origin === geolocationUrl &&
        grant.permissions.includes("geolocation")
    )
  ) {
    throw new Error(
      `geolocation permission grant missing: ${JSON.stringify(permissionGrant.data)}`
    )
  }

  assertOk(await runtime.open({ url: geolocationUrl }), "open geolocation page")
  assertOk(
    await runtime.click({ selector: "#read-geolocation" }),
    "click geolocation"
  )
  assertOk(
    await runtime.wait({ selector: "text=31.2304,121.4737,12" }),
    "geolocation wait"
  )

  const externallyClosedContext = (
    runtime as unknown as {
      context: { close(): Promise<void> } | null
    }
  ).context
  if (!externallyClosedContext) {
    throw new Error("external-close smoke missing launched context")
  }
  await externallyClosedContext.close()
  const statusAfterExternalClose = await runtime.status()
  assertOk(statusAfterExternalClose, "status after external context close")
  assertEqual(
    statusAfterExternalClose.data.contextLaunched,
    false,
    "external-close context status"
  )
  assertEqual(
    statusAfterExternalClose.data.tabCount,
    0,
    "external-close tab count"
  )
  assertOk(
    await runtime.open({ url: geolocationUrl }),
    "open after external context close"
  )
  assertOk(
    await runtime.click({ selector: "#read-geolocation" }),
    "click geolocation after external context close"
  )
  assertOk(
    await runtime.wait({ selector: "text=31.2304,121.4737,12" }),
    "geolocation wait after external context close"
  )

  const emulationWithoutConfirmation = await runtime.setEmulation({
    locale: "de-DE",
  })
  assertError(
    emulationWithoutConfirmation,
    "emulation confirmation",
    "invalid_request"
  )

  const confirmedEmulation = await runtime.setEmulation({
    locale: "en-US",
    timezoneId: "UTC",
    confirmed: true,
  })
  assertOk(confirmedEmulation, "confirmed emulation relaunch")
  assertEqual(
    confirmedEmulation.data.relaunched,
    true,
    "confirmed emulation relaunched"
  )
  assertEqual(
    confirmedEmulation.data.overrides.locale,
    "en-US",
    "confirmed emulation locale"
  )

  const oldTabAfterRelaunch = await runtime.current({ tabId: opened.tabId })
  assertError(oldTabAfterRelaunch, "old tab after relaunch", "tab_not_found")

  assertOk(
    await runtime.open({ url: geolocationUrl }),
    "open geolocation after relaunch"
  )
  assertOk(
    await runtime.click({ selector: "#read-geolocation" }),
    "click geolocation after relaunch"
  )
  assertOk(
    await runtime.wait({ selector: "text=31.2304,121.4737,12" }),
    "geolocation wait after relaunch"
  )

  const clearEmulationWithoutConfirmation = await runtime.setEmulation({
    clear: true,
  })
  assertError(
    clearEmulationWithoutConfirmation,
    "clear emulation confirmation",
    "invalid_request"
  )

  const clearedEmulation = await runtime.setEmulation({
    clear: true,
    confirmed: true,
  })
  assertOk(clearedEmulation, "clear emulation")
  assertEqual(clearedEmulation.data.relaunched, true, "clear emulation relaunch")
  assertEqual(
    Object.keys(clearedEmulation.data.overrides).length,
    0,
    "cleared emulation overrides"
  )

  const invalidUserAgent = await runtime.setEmulation({ userAgent: "" })
  assertError(invalidUserAgent, "invalid user agent", "invalid_request")

  const invalidLocale = await runtime.setEmulation({ locale: "not a locale" })
  assertError(invalidLocale, "invalid locale", "invalid_request")

  const invalidTimezone = await runtime.setEmulation({
    timezoneId: "Mars/Base",
  })
  assertError(invalidTimezone, "invalid timezone", "invalid_request")

  const invalidDeviceScaleFactor = await runtime.setEmulation({
    deviceScaleFactor: 0,
  })
  assertError(
    invalidDeviceScaleFactor,
    "invalid device scale factor",
    "invalid_request"
  )

  const clearGeolocation = await runtime.setGeolocation({ clear: true })
  assertOk(clearGeolocation, "clear geolocation")
  assertEqual(
    clearGeolocation.data.geolocation,
    undefined,
    "cleared geolocation"
  )

  const clearPermissions = await runtime.setPermissions({ clear: true })
  assertOk(clearPermissions, "clear permissions")
  assertEqual(
    clearPermissions.data.permissionGrants.length,
    0,
    "cleared permission grants"
  )

  const invalidLatitude = await runtime.setGeolocation({
    latitude: 91,
    longitude: 0,
  })
  assertError(invalidLatitude, "invalid latitude", "invalid_request")

  const invalidLongitude = await runtime.setGeolocation({
    latitude: 0,
    longitude: 181,
  })
  assertError(invalidLongitude, "invalid longitude", "invalid_request")

  const invalidPermission = await runtime.setPermissions({
    permissions: ["camera"],
  })
  assertError(invalidPermission, "invalid permission", "invalid_request")

  const invalidOrigin = await runtime.setPermissions({
    permissions: ["geolocation"],
    origin: `${geolocationUrl}/path`,
  })
  assertError(invalidOrigin, "invalid permission origin", "invalid_request")

  assertOk(
    await runtime.consoleLogs({ clear: true }),
    "clear diagnostics before fixture restore"
  )
  assertOk(
    await runtime.pageErrors({ clear: true }),
    "clear page errors before fixture restore"
  )
  assertOk(
    await runtime.networkEvents({ clear: true }),
    "clear network events before fixture restore"
  )

  assertOk(
    await runtime.open({ url: diagnosticConsolePageUrl }),
    "open diagnostic console URL fixture"
  )
  const diagnosticConsoleLogs = await runtime.consoleLogs({
    filter: "diagnostic console URL smoke",
  })
  assertOk(diagnosticConsoleLogs, "diagnostic console URL logs")
  const diagnosticConsoleLog = diagnosticConsoleLogs.data.logs.find(
    (entry) => entry.message.includes("diagnostic console URL smoke")
  )
  assertEqual(
    diagnosticConsoleLog?.url,
    diagnosticConsoleSourceUrl,
    "console source URL preserves userinfo/query/fragment metadata"
  )

  const restoredFixture = await runtime.open({ url: fixtureUrl })
  assertOk(restoredFixture, "restore fixture")

  const consoleWarns = await runtime.consoleLogs({
    levels: ["warn"],
    filter: "smoke warn",
    limit: 5,
  })
  assertOk(consoleWarns, "console logs")
  assertLogContains(consoleWarns.data.logs, "warn", "smoke warn entry")

  const existingConsoleWait = await runtime.waitConsoleLog({
    levels: ["warning"],
    filter: "smoke warn",
    clear: true,
  })
  assertOk(existingConsoleWait, "existing console wait")
  assertEqual(
    existingConsoleWait.data.matchedExisting,
    true,
    "existing console wait matched buffer"
  )
  assertEqual(existingConsoleWait.data.cleared, true, "existing console cleared")
  assertEqual(existingConsoleWait.data.entry.level, "warn", "console warning normalized")

  const clearedLogs = await runtime.consoleLogs({
    filter: "smoke",
    limit: 10,
    clear: true,
  })
  assertOk(clearedLogs, "clear console logs")
  assertLogContains(clearedLogs.data.logs, "log", "smoke log entry")
  assertLogContains(clearedLogs.data.logs, "error", "smoke error entry")

  const logsAfterClear = await runtime.consoleLogs({ filter: "smoke" })
  assertOk(logsAfterClear, "console logs after clear")
  assertEqual(logsAfterClear.data.logs.length, 0, "console clear count")

  const futureConsoleWaitPromise = runtime.waitConsoleLog({
    levels: ["error"],
    filter: "future smoke console error",
    timeoutMs: 1_000,
    clear: true,
  })
  assertOk(
    await runtime.click({ selector: "#delayed-console" }),
    "trigger future console"
  )
  const futureConsoleWait = await futureConsoleWaitPromise
  assertOk(futureConsoleWait, "future console wait")
  assertEqual(
    futureConsoleWait.data.matchedExisting,
    false,
    "future console wait matched future entry"
  )
  assertStringIncludes(
    futureConsoleWait.data.entry.message,
    "future smoke console error",
    "future console message"
  )
  assertNoKeys(
    futureConsoleWait.data.entry,
    ["args", "handles", "preview", "body", "headers"],
    "console wait safety boundary"
  )
  const consoleWaitTimeout = await runtime.waitConsoleLog({
    filter: "missing future console entry",
    timeoutMs: 100,
  })
  assertError(consoleWaitTimeout, "console wait timeout", "operation_failed")

  assertOk(await runtime.wait({ timeoutMs: 500 }), "diagnostic wait")

  const diagnosticStatus = await runtime.status()
  assertOk(diagnosticStatus, "diagnostic status")
  const diagnosticTab = diagnosticStatus.data.diagnostics.tabs.find(
    (entry) => entry.tabId === restoredFixture.tabId
  )
  if (!diagnosticTab) {
    throw new Error(
      `diagnostic status missing tab: ${JSON.stringify(diagnosticStatus.data)}`
    )
  }
  if (
    diagnosticTab.consoleLogCount <= 0 ||
    diagnosticTab.pageErrorCount <= 0 ||
    diagnosticTab.networkEventCount <= 0
  ) {
    throw new Error(
      `diagnostic counts missing captured entries: ${JSON.stringify(diagnosticTab)}`
    )
  }

  const pageErrors = await runtime.pageErrors({
    filter: "smoke page error",
    limit: 5,
  })
  assertOk(pageErrors, "page errors")
  assertEqual(pageErrors.data.errors.length, 1, "page error count")
  assertStringIncludes(
    pageErrors.data.errors[0].message,
    "smoke page error",
    "page error message"
  )

  const existingPageErrorWait = await runtime.waitPageError({
    filter: "smoke page error",
  })
  assertOk(existingPageErrorWait, "existing page error wait")
  assertEqual(
    existingPageErrorWait.data.matchedExisting,
    true,
    "existing page error wait matched buffer"
  )

  const clearedPageErrors = await runtime.pageErrors({
    filter: "smoke page error",
    clear: true,
  })
  assertOk(clearedPageErrors, "clear page errors")
  const pageErrorsAfterClear = await runtime.pageErrors({
    filter: "smoke page error",
  })
  assertOk(pageErrorsAfterClear, "page errors after clear")
  assertEqual(pageErrorsAfterClear.data.errors.length, 0, "page error clear")

  const futurePageErrorWaitPromise = runtime.waitPageError({
    filter: "future smoke page error",
    timeoutMs: 1_000,
    clear: true,
  })
  assertOk(
    await runtime.click({ selector: "#delayed-page-error" }),
    "trigger future page error"
  )
  const futurePageErrorWait = await futurePageErrorWaitPromise
  assertOk(futurePageErrorWait, "future page error wait")
  assertEqual(
    futurePageErrorWait.data.matchedExisting,
    false,
    "future page error wait matched future entry"
  )
  assertStringIncludes(
    futurePageErrorWait.data.entry.message,
    "future smoke page error",
    "future page error message"
  )
  assertNoKeys(
    futurePageErrorWait.data.entry,
    ["body", "headers", "cookies", "storage"],
    "page error wait safety boundary"
  )
  const pageErrorWaitTimeout = await runtime.waitPageError({
    filter: "missing future page error",
    timeoutMs: 100,
  })
  assertError(pageErrorWaitTimeout, "page error wait timeout", "operation_failed")

  const responseEvents = await runtime.networkEvents({
    types: ["response"],
    filter: "smoke-fixture.html",
    statusMin: 200,
    statusMax: 299,
    limit: 5,
  })
  assertOk(responseEvents, "network response events")
  if (
    !responseEvents.data.events.some(
      (event) =>
        event.type === "response" &&
        event.url.includes("smoke-fixture.html") &&
        event.status === 200
    )
  ) {
    throw new Error(
      `network response event missing fixture: ${JSON.stringify(responseEvents.data.events)}`
    )
  }
  assertNoKeys(
    responseEvents.data.events[0],
    ["headers", "body", "postData"],
    "network response metadata"
  )

  const failedNetworkEvents = await runtime.networkEvents({
    types: ["request_failed"],
    filter: "smoke-network-fail",
    limit: 5,
  })
  assertOk(failedNetworkEvents, "network failed events")
  if (
    !failedNetworkEvents.data.events.some(
      (event) =>
        event.type === "request_failed" &&
        event.url.includes("smoke-network-fail") &&
        event.failureText
    )
  ) {
    throw new Error(
      `network failed event missing failed request: ${JSON.stringify(failedNetworkEvents.data.events)}`
    )
  }
  assertNoKeys(
    failedNetworkEvents.data.events[0],
    ["headers", "body", "postData"],
    "network failed metadata"
  )

  const clearedNetworkEvents = await runtime.networkEvents({
    filter: "smoke-network-fail",
    clear: true,
  })
  assertOk(clearedNetworkEvents, "clear network events")
  const networkEventsAfterClear = await runtime.networkEvents({
    filter: "smoke-network-fail",
  })
  assertOk(networkEventsAfterClear, "network events after clear")
  assertEqual(
    networkEventsAfterClear.data.events.length,
    0,
    "network event clear"
  )

  const invalidStatusRange = await runtime.networkEvents({
    statusMin: 500,
    statusMax: 400,
  })
  assertError(
    invalidStatusRange,
    "invalid network status range",
    "invalid_request"
  )

  assertOk(
    await runtime.open({ url: networkSmokeUrl }),
    "open network smoke page"
  )
  assertOk(await runtime.networkEvents({ clear: true }), "clear network smoke")
  assertOk(await runtime.click({ selector: "#fetch-ok" }), "fetch ok")
  assertOk(
    await runtime.wait({ selector: "text=ok-done" }),
    "wait fetch ok"
  )
  const existingNetworkWait = await runtime.waitNetworkEvent({
    types: ["response"],
    filter: "/api/smoke-ok?case=existing",
    statusMin: 200,
    statusMax: 200,
    timeoutMs: 5_000,
    clear: true,
  })
  assertOk(existingNetworkWait, "existing network wait")
  assertEqual(
    existingNetworkWait.data.matchedExisting,
    true,
    "existing network wait matched existing"
  )
  assertEqual(
    existingNetworkWait.data.cleared,
    true,
    "existing network wait clear flag"
  )
  assertNoKeys(
    existingNetworkWait.data.event,
    ["headers", "body", "postData"],
    "existing network wait metadata"
  )
  const existingNetworkAfterClear = await runtime.networkEvents({
    filter: "/api/smoke-ok?case=existing",
  })
  assertOk(existingNetworkAfterClear, "network wait clear check")
  assertEqual(
    existingNetworkAfterClear.data.events.length,
    0,
    "network wait clear"
  )

  const futureNetworkWaitPromise = runtime.waitNetworkEvent({
    types: ["response"],
    filter: "/api/smoke-delayed?case=future",
    statusMin: 201,
    statusMax: 201,
    timeoutMs: 5_000,
  })
  assertOk(await runtime.click({ selector: "#fetch-delayed" }), "fetch delayed")
  const futureNetworkWait = await futureNetworkWaitPromise
  assertOk(futureNetworkWait, "future network wait")
  assertEqual(
    futureNetworkWait.data.matchedExisting,
    false,
    "future network wait matched future"
  )
  assertEqual(
    futureNetworkWait.data.event.status,
    201,
    "future network wait status"
  )

  const networkWaitTimeout = await runtime.waitNetworkEvent({
    filter: "network-wait-timeout-never-matches",
    timeoutMs: 100,
  })
  assertError(networkWaitTimeout, "network wait timeout", "operation_failed")

  const invalidNetworkWaitRange = await runtime.waitNetworkEvent({
    statusMin: 500,
    statusMax: 400,
    timeoutMs: 100,
  })
  assertError(
    invalidNetworkWaitRange,
    "invalid network wait status range",
    "invalid_request"
  )

  assertOk(
    await runtime.networkEvents({ clear: true }),
    "clear network summary smoke"
  )
  assertOk(await runtime.click({ selector: "#fetch-summary" }), "fetch summary")
  assertOk(
    await runtime.wait({ selector: "text=summary-done" }),
    "wait fetch summary"
  )
  const networkSummary = await runtime.networkSummary({
    filter: "kind=summary",
    limit: 10,
  })
  assertOk(networkSummary, "network summary")
  assertEqual(networkSummary.data.matchingEventCount, 3, "network summary match")
  assertEqual(
    networkSummary.data.eventsSummarized,
    3,
    "network summary summarized"
  )
  assertEqual(networkSummary.data.byType.response, 2, "network summary response")
  assertEqual(
    networkSummary.data.byType.request_failed,
    1,
    "network summary failed type"
  )
  assertEqual(networkSummary.data.byMethod.GET, 3, "network summary method")
  assertEqual(networkSummary.data.byStatus["200"], 1, "network summary 200")
  assertEqual(networkSummary.data.byStatus["503"], 1, "network summary 503")
  assertEqual(networkSummary.data.byStatusClass["2xx"], 1, "network summary 2xx")
  assertEqual(networkSummary.data.byStatusClass["5xx"], 1, "network summary 5xx")
  assertEqual(
    networkSummary.data.byStatusClass.unknown,
    1,
    "network summary unknown"
  )
  assertEqual(
    networkSummary.data.failedRequestCount,
    1,
    "network summary failed count"
  )
  assertNoKeys(
    networkSummary.data,
    ["headers", "body", "postData", "events", "urls"],
    "network summary metadata"
  )

  const invalidNetworkSummaryRange = await runtime.networkSummary({
    statusMin: 500,
    statusMax: 400,
  })
  assertError(
    invalidNetworkSummaryRange,
    "invalid network summary status range",
    "invalid_request"
  )

  assertOk(
    await runtime.open({ url: webSocketSmokeUrl }),
    "open websocket smoke page"
  )
  assertOk(
    await runtime.webSocketEvents({ clear: true }),
    "clear websocket smoke"
  )
  assertOk(await runtime.click({ selector: "#websocket-run" }), "run websocket")
  assertOk(
    await runtime.wait({ selector: "text=ws-done", timeoutMs: 5_000 }),
    "wait websocket smoke"
  )
  const webSocketEvents = await runtime.webSocketEvents({
    filter: "/socket?case=metadata",
    limit: 20,
  })
  assertOk(webSocketEvents, "websocket events")
  const webSocketTypes = webSocketEvents.data.events.map((event) => event.type)
  assertArrayIncludes(webSocketTypes, "open", "websocket open")
  assertArrayIncludes(webSocketTypes, "frame_sent", "websocket frame sent")
  assertArrayIncludes(
    webSocketTypes,
    "frame_received",
    "websocket frame received"
  )
  assertArrayIncludes(webSocketTypes, "close", "websocket close")
  const sentWebSocketEvent = webSocketEvents.data.events.find(
    (event) => event.type === "frame_sent"
  )
  const receivedWebSocketEvent = webSocketEvents.data.events.find(
    (event) => event.type === "frame_received"
  )
  if (!sentWebSocketEvent || !receivedWebSocketEvent) {
    throw new Error(
      `websocket frame metadata missing: ${JSON.stringify(webSocketEvents.data.events)}`
    )
  }
  const clientWebSocketPayloadBytes = Buffer.byteLength(
    "client-smoke-secret",
    "utf8"
  )
  const serverWebSocketPayloadBytes = Buffer.byteLength(
    "server-smoke-secret",
    "utf8"
  )
  assertEqual(sentWebSocketEvent.direction, "sent", "websocket sent direction")
  assertEqual(
    receivedWebSocketEvent.direction,
    "received",
    "websocket received direction"
  )
  assertEqual(
    sentWebSocketEvent.payloadBytes,
    clientWebSocketPayloadBytes,
    "websocket sent byte length"
  )
  assertEqual(
    receivedWebSocketEvent.payloadBytes,
    serverWebSocketPayloadBytes,
    "websocket received byte length"
  )
  assertNoKeys(
    sentWebSocketEvent,
    ["payload", "data", "message", "text", "body", "headers", "postData"],
    "websocket sent metadata"
  )
  const webSocketEventsJson = JSON.stringify(webSocketEvents.data.events)
  if (
    webSocketEventsJson.includes("client-smoke-secret") ||
    webSocketEventsJson.includes("server-smoke-secret")
  ) {
    throw new Error(`websocket events exposed payload: ${webSocketEventsJson}`)
  }
  const filteredWebSocketEvents = await runtime.webSocketEvents({
    types: ["frame_received"],
    filter: "/socket?case=metadata",
  })
  assertOk(filteredWebSocketEvents, "filtered websocket events")
  assertEqual(
    filteredWebSocketEvents.data.events.length,
    1,
    "filtered websocket event count"
  )
  assertEqual(
    filteredWebSocketEvents.data.events[0]?.type,
    "frame_received",
    "filtered websocket event type"
  )
  const webSocketStatus = await runtime.status()
  assertOk(webSocketStatus, "websocket status")
  const webSocketDiagnostic = webSocketStatus.data.diagnostics.tabs.find(
    (tab) => tab.tabId === webSocketStatus.data.activeTabId
  )
  if (!webSocketDiagnostic || webSocketDiagnostic.webSocketEventCount <= 0) {
    throw new Error(
      `websocket status count missing: ${JSON.stringify(webSocketStatus.data)}`
    )
  }

  const existingWebSocketWait = await runtime.waitWebSocketEvent({
    types: ["frame_sent"],
    filter: "/socket?case=metadata",
    timeoutMs: 5_000,
    clear: true,
  })
  assertOk(existingWebSocketWait, "existing websocket wait")
  assertEqual(
    existingWebSocketWait.data.matchedExisting,
    true,
    "existing websocket wait matched existing"
  )
  assertEqual(
    existingWebSocketWait.data.cleared,
    true,
    "existing websocket wait clear flag"
  )
  assertEqual(
    existingWebSocketWait.data.event.type,
    "frame_sent",
    "existing websocket wait event type"
  )
  assertNoKeys(
    existingWebSocketWait.data.event,
    ["payload", "data", "message", "text", "body", "headers", "postData"],
    "existing websocket wait metadata"
  )
  const existingWebSocketAfterClear = await runtime.webSocketEvents({
    types: ["frame_sent"],
    filter: "/socket?case=metadata",
  })
  assertOk(existingWebSocketAfterClear, "websocket wait clear check")
  assertEqual(
    existingWebSocketAfterClear.data.events.length,
    0,
    "websocket wait clear"
  )

  assertOk(
    await runtime.webSocketEvents({
      filter: "/socket?case=metadata",
      clear: true,
    }),
    "clear websocket before future wait"
  )
  const futureWebSocketWaitPromise = runtime.waitWebSocketEvent({
    types: ["frame_received"],
    filter: "/socket?case=metadata",
    timeoutMs: 5_000,
  })
  assertOk(
    await runtime.click({ selector: "#websocket-run" }),
    "run future websocket"
  )
  const futureWebSocketWait = await futureWebSocketWaitPromise
  assertOk(futureWebSocketWait, "future websocket wait")
  assertEqual(
    futureWebSocketWait.data.matchedExisting,
    false,
    "future websocket wait matched future"
  )
  assertEqual(
    futureWebSocketWait.data.event.type,
    "frame_received",
    "future websocket wait event type"
  )

  const webSocketWaitTimeout = await runtime.waitWebSocketEvent({
    filter: "websocket-wait-timeout-never-matches",
    timeoutMs: 100,
  })
  assertError(
    webSocketWaitTimeout,
    "websocket wait timeout",
    "operation_failed"
  )

  assertOk(
    await runtime.webSocketEvents({
      filter: "/socket?case=metadata",
      clear: true,
    }),
    "clear websocket before summary"
  )
  const webSocketSummaryWaitPromise = runtime.waitWebSocketEvent({
    types: ["close"],
    filter: "/socket?case=metadata",
    timeoutMs: 5_000,
  })
  assertOk(
    await runtime.click({ selector: "#websocket-run" }),
    "run summary websocket"
  )
  const webSocketSummaryWait = await webSocketSummaryWaitPromise
  assertOk(webSocketSummaryWait, "websocket summary wait")
  const webSocketSummary = await runtime.webSocketSummary({
    filter: "/socket?case=metadata",
    limit: 10,
  })
  assertOk(webSocketSummary, "websocket summary")
  assertEqual(
    webSocketSummary.data.matchingEventCount,
    4,
    "websocket summary match"
  )
  assertEqual(
    webSocketSummary.data.eventsSummarized,
    4,
    "websocket summary summarized"
  )
  assertEqual(webSocketSummary.data.byType.open, 1, "websocket summary open")
  assertEqual(
    webSocketSummary.data.byType.frame_sent,
    1,
    "websocket summary sent"
  )
  assertEqual(
    webSocketSummary.data.byType.frame_received,
    1,
    "websocket summary received"
  )
  assertEqual(webSocketSummary.data.byType.close, 1, "websocket summary close")
  assertEqual(
    webSocketSummary.data.byType.socket_error,
    0,
    "websocket summary error"
  )
  assertEqual(
    webSocketSummary.data.byDirection.sent,
    1,
    "websocket summary sent direction"
  )
  assertEqual(
    webSocketSummary.data.byDirection.received,
    1,
    "websocket summary received direction"
  )
  assertEqual(
    webSocketSummary.data.byDirection.unknown,
    2,
    "websocket summary unknown direction"
  )
  assertEqual(webSocketSummary.data.socketCount, 1, "websocket summary sockets")
  assertEqual(
    webSocketSummary.data.frameEventCount,
    2,
    "websocket summary frames"
  )
  assertEqual(
    webSocketSummary.data.totalPayloadBytes,
    clientWebSocketPayloadBytes + serverWebSocketPayloadBytes,
    "websocket summary total bytes"
  )
  assertEqual(
    webSocketSummary.data.sentPayloadBytes,
    clientWebSocketPayloadBytes,
    "websocket summary sent bytes"
  )
  assertEqual(
    webSocketSummary.data.receivedPayloadBytes,
    serverWebSocketPayloadBytes,
    "websocket summary received bytes"
  )
  assertEqual(
    webSocketSummary.data.maxPayloadBytes,
    Math.max(clientWebSocketPayloadBytes, serverWebSocketPayloadBytes),
    "websocket summary max bytes"
  )
  assertNoKeys(
    webSocketSummary.data,
    [
      "events",
      "urls",
      "payload",
      "data",
      "message",
      "text",
      "body",
      "headers",
      "postData",
    ],
    "websocket summary metadata"
  )
  const webSocketSummaryJson = JSON.stringify(webSocketSummary.data)
  if (
    webSocketSummaryJson.includes("client-smoke-secret") ||
    webSocketSummaryJson.includes("server-smoke-secret")
  ) {
    throw new Error(`websocket summary exposed payload: ${webSocketSummaryJson}`)
  }
  const invalidWebSocketSummaryTab = await runtime.webSocketSummary({
    tabId: "missing-tab",
  })
  assertError(
    invalidWebSocketSummaryTab,
    "invalid websocket summary tab",
    "tab_not_found"
  )

  const clearedWebSocketEvents = await runtime.webSocketEvents({
    filter: "/socket?case=metadata",
    clear: true,
  })
  assertOk(clearedWebSocketEvents, "clear websocket events")
  const webSocketEventsAfterClear = await runtime.webSocketEvents({
    filter: "/socket?case=metadata",
  })
  assertOk(webSocketEventsAfterClear, "websocket events after clear")
  assertEqual(
    webSocketEventsAfterClear.data.events.length,
    0,
    "websocket event clear"
  )
  const invalidWebSocketTab = await runtime.webSocketEvents({
    tabId: "missing-tab",
  })
  assertError(invalidWebSocketTab, "invalid websocket tab", "tab_not_found")

  assertOk(
    await runtime.open({ url: fixtureUrl }),
    "restore fixture after network smoke"
  )

  const frames = await runtime.frames()
  assertOk(frames, "frames")
  const mainFrame = frames.data.frames.find((frame) => frame.main)
  const childFrame = frames.data.frames.find((frame) =>
    frame.url.includes("smoke-frame.html")
  )
  if (!mainFrame || !childFrame || childFrame.parentId !== mainFrame.id) {
    throw new Error(`frame tree mismatch: ${JSON.stringify(frames.data.frames)}`)
  }
  const frameId = childFrame.id

  const restoredPerformance = await runtime.performanceSummary()
  assertOk(restoredPerformance, "restored performance summary")
  assertEqual(
    restoredPerformance.data.navigation.navigationId !==
      initialPerformance.data.navigation.navigationId,
    true,
    "performance navigation creates a new lifecycle window"
  )

  const framePerformance = await runtime.performanceSummary({ frameId })
  assertOk(framePerformance, "frame performance summary")
  assertEqual(
    framePerformance.data.frameId,
    frameId,
    "performance summary is explicitly frame scoped"
  )

  const frameAssets = await runtime.assets({ frameId })
  assertOk(frameAssets, "frame asset inventory")
  assertEqual(frameAssets.data.frameId, frameId, "frame asset inventory id")
  assertEqual(
    frameAssets.data.assets.some((asset) => asset.kind === "inline_svg"),
    true,
    "frame asset inventory is explicitly scoped"
  )

  const frameSnapshot = await runtime.snapshot({
    frameId,
    maxTextLength: 2_000,
    maxElements: 20,
  })
  assertOk(frameSnapshot, "frame snapshot")
  assertEqual(frameSnapshot.data.frameId, frameId, "frame snapshot id")
  assertStringIncludes(
    frameSnapshot.data.text,
    "Smoke Frame Title",
    "frame snapshot text"
  )

  const frameLocatorText = await runtime.locatorText({
    frameId,
    locator: { testId: "frame-copy" },
  })
  assertOk(frameLocatorText, "frame locator text")
  assertEqual(
    frameLocatorText.data.text,
    "Frame locator text",
    "frame locator text value"
  )

  assertOk(
    await runtime.type({
      frameId,
      selector: "#frame-message",
      text: "hello from frame",
    }),
    "frame type"
  )
  assertOk(
    await runtime.click({ frameId, selector: "#frame-copy-button" }),
    "frame click"
  )
  assertOk(
    await runtime.wait({ frameId, selector: "text=hello from frame" }),
    "frame wait"
  )

  const frameRefInput = findElement(
    frameSnapshot.data,
    (element) => element.name === "Frame message"
  )
  const wrongFrameRef = await runtime.type({
    frameId: mainFrame.id,
    ref: frameRefInput.ref,
    text: "wrong frame",
  })
  assertError(wrongFrameRef, "wrong frame ref", "invalid_request")

  const frameCoordinateTarget = await runtime.click({
    frameId,
    x: 1,
    y: 1,
  })
  assertError(frameCoordinateTarget, "frame coordinate target", "invalid_request")

  const uploadNoConfirmation = await runtime.setInputFiles({
    frameId,
    selector: "#frame-upload",
    paths: [uploadPath],
    confirmed: false,
  })
  assertError(uploadNoConfirmation, "upload confirmation", "invalid_request")

  const uploadRelativePath = await runtime.setInputFiles({
    frameId,
    selector: "#frame-upload",
    paths: ["relative-upload.txt"],
    confirmed: true,
  })
  assertError(uploadRelativePath, "upload relative path", "invalid_request")

  const uploadMissingFile = await runtime.setInputFiles({
    frameId,
    selector: "#frame-upload",
    paths: [resolve(config.screenshotDir, "missing-upload.txt")],
    confirmed: true,
  })
  assertError(uploadMissingFile, "upload missing file", "file_not_found")

  const uploadTooMany = await runtime.setInputFiles({
    frameId,
    selector: "#frame-upload",
    paths: [uploadPath, secondUploadPath],
    confirmed: true,
  })
  assertError(uploadTooMany, "upload too many", "invalid_request")

  const directUpload = await runtime.setInputFiles({
    frameId,
    selector: "#frame-upload",
    paths: [uploadPath],
    confirmed: true,
  })
  assertOk(directUpload, "direct upload")
  assertEqual(directUpload.data.count, 1, "direct upload count")
  assertEqual(
    directUpload.data.files[0].name,
    "smoke-upload.txt",
    "direct upload name"
  )
  assertOk(
    await runtime.wait({ frameId, selector: "text=1:smoke-upload.txt" }),
    "direct upload wait"
  )

  const chooserUpload = await runtime.expectFileChooser({
    action: { type: "click", frameId, selector: "#frame-chooser-button" },
    paths: [secondUploadPath],
    confirmed: true,
    timeoutMs: 5_000,
  })
  assertOk(chooserUpload, "file chooser upload")
  assertEqual(
    chooserUpload.data.files[0].name,
    "smoke-upload-second.txt",
    "file chooser upload name"
  )
  assertOk(
    await runtime.wait({ frameId, selector: "text=1:smoke-upload-second.txt" }),
    "file chooser upload wait"
  )

  const chooserTooMany = await runtime.expectFileChooser({
    action: { type: "click", frameId, selector: "#frame-chooser-button" },
    paths: [uploadPath, secondUploadPath],
    confirmed: true,
    timeoutMs: 5_000,
  })
  assertError(chooserTooMany, "file chooser too many", "invalid_request")

  const locatorCount = await runtime.locatorCount({
    locator: { selector: ".locator-item" },
  })
  assertOk(locatorCount, "locator count")
  assertEqual(locatorCount.data.count, 2, "locator count value")
  assertOkWithoutNarrowing(
    await runtime.elementQuery({
      action: "count",
      locator: { selector: ".locator-item" },
    }),
    "aggregated element query"
  )

  const locatorHeadingText = await runtime.locatorText({
    locator: { role: "heading", name: "Chrome Power Smoke", exact: true },
  })
  assertOk(locatorHeadingText, "locator heading text")
  assertEqual(
    locatorHeadingText.data.text,
    "Chrome Power Smoke",
    "locator heading text value"
  )

  const locatorAllText = await runtime.locatorText({
    locator: { selector: ".locator-item" },
    all: true,
    textKind: "textContent",
  })
  assertOk(locatorAllText, "locator all text")
  assertArrayIncludes(
    locatorAllText.data.texts ?? [],
    "Second locator item",
    "locator all text values"
  )

  const locatorAttribute = await runtime.locatorAttribute({
    locator: { testId: "locator-copy" },
    name: "data-kind",
  })
  assertOk(locatorAttribute, "locator attribute")
  assertEqual(locatorAttribute.data.value, "p1", "locator attribute value")

  const locatorState = await runtime.locatorState({
    locator: { placeholder: "Locator email placeholder" },
  })
  assertOk(locatorState, "locator state")
  assertEqual(locatorState.data.visible, true, "locator visible state")
  assertEqual(locatorState.data.enabled, true, "locator enabled state")

  const disabledState = await runtime.locatorState({
    locator: { selector: "#disabled-action" },
  })
  assertOk(disabledState, "disabled locator state")
  assertEqual(disabledState.data.enabled, false, "disabled locator enabled")

  const locatorWait = await runtime.locatorWait({
    locator: { text: "Delayed locator ready", exact: true },
    state: "visible",
  })
  assertOk(locatorWait, "locator wait")

  const ambiguousLocator = await runtime.locatorText({
    locator: { selector: ".locator-item", text: "First locator item" },
  })
  assertError(ambiguousLocator, "ambiguous locator", "invalid_request")

  const missingLocator = await runtime.locatorText({
    locator: { text: "missing locator value", exact: true },
    timeoutMs: 500,
  })
  assertError(missingLocator, "missing locator", "locator_not_found")

  const locatorClick = await runtime.locatorClick({
    locator: { role: "button", name: "Locator action", exact: true },
  })
  assertOk(locatorClick, "locator click")
  assertOkWithoutNarrowing(
    await runtime.elementAction({
      action: "hover",
      locator: { role: "button", name: "Locator action", exact: true },
    }),
    "aggregated element action"
  )
  assertOk(
    await runtime.locatorWait({ locator: { text: "locator clicked", exact: true } }),
    "locator click effect"
  )

  const locatorSecret = "semantic-locator-secret"
  const locatorType = await runtime.locatorType({
    locator: { label: "Locator email", exact: true },
    text: locatorSecret,
  })
  assertOk(locatorType, "locator type")
  assertEqual(
    JSON.stringify(locatorType).includes(locatorSecret),
    false,
    "locator type result privacy"
  )
  const locatorAppend = await runtime.locatorType({
    locator: { placeholder: "Locator email placeholder", exact: true },
    text: "-append",
    clear: false,
  })
  assertOk(locatorAppend, "locator append")
  assertOkWithoutNarrowing(
    await runtime.locatorWait({
      locator: { text: `${locatorSecret}-append`, exact: true },
    }),
    "locator append value"
  )

  const locatorPress = await runtime.locatorPress({
    locator: { testId: "locator-key" },
    key: "Enter",
  })
  assertOk(locatorPress, "locator press")
  assertOk(
    await runtime.locatorWait({ locator: { text: "locator pressed", exact: true } }),
    "locator press effect"
  )

  const locatorIndexedClick = await runtime.locatorClick({
    locator: { text: "Repeated locator action", exact: true, index: 1 },
  })
  assertOk(locatorIndexedClick, "locator indexed click")
  assertOk(
    await runtime.locatorWait({ locator: { text: "second index", exact: true } }),
    "locator indexed click effect"
  )
  assertError(
    await runtime.locatorClick({
      locator: { text: "Repeated locator action", exact: true },
      timeoutMs: 500,
    }),
    "ambiguous locator click",
    "invalid_request"
  )
  assertError(
    await runtime.locatorClick({
      locator: { text: "missing locator action", exact: true },
      timeoutMs: 500,
    }),
    "missing locator click",
    "locator_not_found"
  )

  const frameLocatorType = await runtime.locatorType({
    frameId,
    locator: { label: "Frame message", exact: true },
    text: "frame semantic action",
  })
  assertOk(frameLocatorType, "frame locator type")
  assertOk(
    await runtime.locatorClick({
      frameId,
      locator: { role: "button", name: "Frame Copy", exact: true },
    }),
    "frame locator click"
  )
  assertOk(
    await runtime.locatorWait({
      frameId,
      locator: { text: "frame semantic action", exact: true },
    }),
    "frame locator action effect"
  )

  const locatorDialog = await runtime.locatorClick({
    locator: { role: "button", name: "Locator dialog", exact: true },
  })
  assertOk(locatorDialog, "locator dialog click")
  assertDialog(
    await runtime.dialog(),
    "locator dialog click",
    "alert",
    "locator alert"
  )
  assertOk(
    await runtime.handleDialog({ accept: true }),
    "locator dialog handle"
  )

  const locatorHover = await runtime.locatorHover({
    locator: { role: "button", name: "Locator hover", exact: true },
  })
  assertOkWithoutNarrowing(locatorHover, "locator hover")
  assertOk(
    await runtime.locatorWait({
      locator: { text: "semantic hover done", exact: true },
    }),
    "locator hover effect"
  )
  const locatorIndexedHover = await runtime.locatorHover({
    locator: { text: "Repeated locator action", exact: true, index: 1 },
  })
  assertOkWithoutNarrowing(locatorIndexedHover, "locator indexed hover")
  assertOk(
    await runtime.locatorWait({
      locator: { text: "second hover index", exact: true },
    }),
    "locator indexed hover effect"
  )

  const locatorFocus = await runtime.locatorFocus({
    locator: { testId: "locator-focus" },
  })
  assertOkWithoutNarrowing(locatorFocus, "locator focus")
  assertOk(
    await runtime.locatorWait({
      locator: { text: "locator focused", exact: true },
    }),
    "locator focus effect"
  )
  const frameLocatorFocus = await runtime.locatorFocus({
    frameId,
    locator: { label: "Frame message", exact: true },
  })
  assertOkWithoutNarrowing(frameLocatorFocus, "frame locator focus")
  assertOk(
    await runtime.locatorWait({
      frameId,
      locator: { text: "frame semantic focused", exact: true },
    }),
    "frame locator focus effect"
  )

  const locatorChecked = await runtime.locatorSetChecked({
    locator: { label: "Locator check", exact: true },
    checked: true,
  })
  assertOkWithoutNarrowing(locatorChecked, "locator set checked")
  assertOk(
    await runtime.locatorWait({
      locator: { text: "locator checked", exact: true },
    }),
    "locator checked effect"
  )
  const locatorUnchecked = await runtime.locatorSetChecked({
    locator: { testId: "locator-check" },
    checked: false,
  })
  assertOkWithoutNarrowing(locatorUnchecked, "locator set unchecked")
  assertOk(
    await runtime.locatorWait({
      locator: { text: "locator unchecked", exact: true },
    }),
    "locator unchecked effect"
  )

  const locatorSelectValue = await runtime.locatorSelectOption({
    locator: { label: "Locator select", exact: true },
    value: "alpha",
  })
  const locatorSelectValueData = okData(locatorSelectValue, "locator select value")
  assertArrayIncludes(locatorSelectValueData.values, "alpha", "locator selected value")
  const locatorSelectLabel = await runtime.locatorSelectOption({
    locator: { testId: "locator-select" },
    label: "Locator Beta",
  })
  const locatorSelectLabelData = okData(locatorSelectLabel, "locator select label")
  assertArrayIncludes(locatorSelectLabelData.values, "beta", "locator selected label")
  const locatorSelectIndex = await runtime.locatorSelectOption({
    locator: { role: "combobox", name: "Locator select", exact: true },
    index: 1,
  })
  const locatorSelectIndexData = okData(locatorSelectIndex, "locator select option index")
  assertArrayIncludes(locatorSelectIndexData.values, "alpha", "locator selected index")
  const locatorSelectMissingOption = await runtime.locatorSelectOption({
    locator: { testId: "locator-select" },
    timeoutMs: 500,
  })
  assertError(
    locatorSelectMissingOption,
    "locator select missing option",
    "invalid_request"
  )
  const locatorCheckedWrongControl = await runtime.locatorSetChecked({
    locator: { testId: "locator-focus" },
    checked: true,
    timeoutMs: 500,
  })
  assertError(
    locatorCheckedWrongControl,
    "locator checked wrong control",
    "locator_not_found"
  )
  const locatorFocusMissing = await runtime.locatorFocus({
    locator: { text: "missing locator focus", exact: true },
    timeoutMs: 500,
  })
  assertError(
    locatorFocusMissing,
    "missing locator focus",
    "locator_not_found"
  )

  okData(
    await runtime.locatorFocus({ locator: { label: "Fine input", exact: true } }),
    "fine input focus"
  )
  const fineSecret = "fine-input-secret"
  const focusedTyped = await runtime.keyboard({ action: "type", text: fineSecret })
  assertOkWithoutNarrowing(focusedTyped, "focused keyboard type")
  assertEqual(JSON.stringify(focusedTyped).includes(fineSecret), false, "focused type privacy")
  assertOkWithoutNarrowing(
    await runtime.locatorWait({ locator: { text: fineSecret, exact: true } }),
    "focused type effect"
  )
  okData(await runtime.keyboard({ action: "down", key: "Shift" }), "shift down")
  assertError(await runtime.keyboard({ action: "down", key: "Shift" }), "duplicate shift down", "invalid_request")
  okData(await runtime.keyboard({ action: "type", text: "a" }), "shift chord type")
  okData(await runtime.keyboard({ action: "up", key: "Shift" }), "shift up")
  assertError(await runtime.keyboard({ action: "up", key: "Shift" }), "unheld shift up", "invalid_request")
  okData(await runtime.keyboard({ action: "down", key: "Alt" }), "navigation alt down")
  assertOkWithoutNarrowing(
    await runtime.navigation({ action: "reload" }),
    "navigation clears held input accounting"
  )
  okData(
    await runtime.keyboard({ action: "down", key: "Alt" }),
    "alt down after navigation"
  )
  okData(await runtime.keyboard({ action: "up", key: "Alt" }), "alt up after navigation")

  const fineMouseBox = okData(
    await runtime.elementBox({ selector: "#fine-mouse" }),
    "fine mouse box"
  )
  okData(
    await runtime.mouse({
      action: "move",
      x: fineMouseBox.box.x + fineMouseBox.box.width / 2,
      y: fineMouseBox.box.y + fineMouseBox.box.height / 2,
    }),
    "fine mouse move"
  )
  okData(await runtime.mouse({ action: "down", button: "left" }), "fine mouse down")
  assertError(
    await runtime.mouse({ action: "down", button: "left" }),
    "duplicate mouse down",
    "invalid_request"
  )
  okData(await runtime.mouse({ action: "up", button: "left" }), "fine mouse up")
  assertError(
    await runtime.mouse({ action: "up", button: "left" }),
    "unheld mouse up",
    "invalid_request"
  )
  okData(await runtime.keyboard({ action: "down", key: "Alt" }), "reset alt down")
  okData(await runtime.mouse({ action: "down", button: "right" }), "reset right down")
  const inputReset = okData(await runtime.inputReset(), "input reset")
  assertArrayIncludes(inputReset.releasedKeys, "Alt", "reset keys")
  assertArrayIncludes(inputReset.releasedButtons, "right", "reset buttons")
  const emptyReset = okData(await runtime.inputReset(), "empty input reset")
  assertEqual(emptyReset.releasedKeys.length, 0, "empty reset keys")
  assertError(
    await runtime.mouse({ action: "move", x: -1, y: 0 }),
    "invalid mouse move",
    "invalid_request"
  )
  assertError(
    await runtime.mouse({ action: "wheel", deltaX: 0, deltaY: 0 }),
    "zero mouse wheel",
    "invalid_request"
  )
  okData(await runtime.mouse({ action: "wheel", deltaY: 10 }), "mouse wheel")

  const initialMedia = okData(await runtime.media(), "initial media")
  assertEqual(Object.keys(initialMedia.overrides).length, 0, "initial media overrides")
  const darkMedia = okData(
    await runtime.media({ action: "set", colorScheme: "dark" }),
    "dark media"
  )
  assertEqual(darkMedia.overrides.colorScheme, "dark", "dark media state")
  assertOkWithoutNarrowing(
    await runtime.locatorWait({
      locator: { text: "Dark media active", exact: true },
    }),
    "dark media effect"
  )
  const mergedMedia = okData(
    await runtime.setMedia({
      reducedMotion: "reduce",
      forcedColors: "active",
    }),
    "merged media"
  )
  assertEqual(mergedMedia.overrides.colorScheme, "dark", "media merge color")
  assertEqual(mergedMedia.overrides.reducedMotion, "reduce", "media merge motion")
  assertEqual(mergedMedia.overrides.forcedColors, "active", "media merge forced")
  assertOkWithoutNarrowing(
    await runtime.locatorWait({
      locator: { text: "Reduced motion active", exact: true },
    }),
    "reduced motion effect"
  )
  assertOkWithoutNarrowing(
    await runtime.locatorWait({
      locator: { text: "Forced colors active", exact: true },
    }),
    "forced colors effect"
  )
  assertError(
    await runtime.setMedia({ clear: true, colorScheme: "light" }),
    "mixed media clear",
    "invalid_request"
  )
  const clearedMedia = okData(
    await runtime.setMedia({ clear: true }),
    "clear media"
  )
  assertEqual(Object.keys(clearedMedia.overrides).length, 0, "cleared media overrides")

  const initialOffline = okData(await runtime.offline(), "initial offline")
  assertEqual(initialOffline.offline, false, "initial offline state")
  const offlineEnabled = okData(
    await runtime.offline({ action: "set", offline: true }),
    "enable offline"
  )
  assertEqual(offlineEnabled.offline, true, "enabled offline state")
  const offlineNavigation = await runtime.open({ url: networkSmokeUrl })
  assertError(offlineNavigation, "offline navigation", "navigation_failed")
  const offlineDisabled = okData(
    await runtime.setOffline({ offline: false }),
    "disable offline"
  )
  assertEqual(offlineDisabled.offline, false, "disabled offline state")
  assertOkWithoutNarrowing(
    await runtime.open({ url: fixtureUrl }),
    "restore fixture after offline"
  )

  const typed = await runtime.type({
    selector: "#message",
    text: "hello from chrome-power",
  })
  assertOk(typed, "type")

  const clicked = await runtime.click({ selector: "#copy" })
  assertOk(clicked, "click")

  const waited = await runtime.wait({ selector: "text=hello from chrome-power" })
  assertOk(waited, "wait")

  const firstSnapshot = await runtime.snapshot({
    maxTextLength: 5_000,
    maxElements: 50,
  })
  assertOk(firstSnapshot, "first snapshot")

  const refInput = findElement(
    firstSnapshot.data,
    (element) => element.name === "Ref message"
  )
  const refButton = findElement(
    firstSnapshot.data,
    (element) => element.name === "Copy ref"
  )
  const keyInput = findElement(
    firstSnapshot.data,
    (element) => element.name === "Key input"
  )
  const checkbox = findElement(
    firstSnapshot.data,
    (element) => element.name === "Agree terms"
  )
  const select = findElement(
    firstSnapshot.data,
    (element) => element.name === "Flavor"
  )
  const doubleButton = findElement(
    firstSnapshot.data,
    (element) => element.name === "Double"
  )
  const hoverTarget = findElement(
    firstSnapshot.data,
    (element) => element.name === "Hover target"
  )
  const dragSource = findElement(
    firstSnapshot.data,
    (element) => element.name === "Drag source"
  )
  const dropTarget = findElement(
    firstSnapshot.data,
    (element) => element.name === "Drop target"
  )

  const refTyped = await runtime.type({
    ref: refInput.ref,
    text: "hello from ref",
  })
  assertOk(refTyped, "ref type")

  const refClicked = await runtime.click({ ref: refButton.ref })
  assertOk(refClicked, "ref click")

  const refWaited = await runtime.wait({ selector: "text=hello from ref" })
  assertOk(refWaited, "ref wait")

  const pressed = await runtime.press({ ref: keyInput.ref, key: "Enter" })
  assertOk(pressed, "press")
  assertOk(await runtime.wait({ selector: "text=pressed enter" }), "press wait")

  const checked = await runtime.setChecked({
    ref: checkbox.ref,
    checked: true,
  })
  assertOk(checked, "set checked")
  assertOk(await runtime.wait({ selector: "#agree:checked" }), "checked wait")

  const selected = await runtime.selectOption({
    ref: select.ref,
    value: "beta",
  })
  assertOk(selected, "select option")
  assertOk(await runtime.wait({ selector: "text=select=beta" }), "select wait")

  const doubleClicked = await runtime.elementAction({
    action: "double_click",
    ref: doubleButton.ref,
  })
  assertOk(doubleClicked, "double click")
  assertOk(
    await runtime.wait({ selector: "text=double clicked" }),
    "double click wait"
  )

  const hovered = await runtime.hover({ ref: hoverTarget.ref })
  assertOk(hovered, "hover")
  assertOk(await runtime.wait({ selector: "text=hovered" }), "hover wait")

  const dragged = await runtime.elementAction({
    action: "drag",
    fromRef: dragSource.ref,
    toRef: dropTarget.ref,
  })
  assertOk(dragged, "drag")
  assertOk(await runtime.wait({ selector: "text=dropped" }), "drag wait")

  const ambiguousPress = await runtime.press({
    ref: keyInput.ref,
    selector: "#key-input",
    key: "Enter",
  })
  assertError(ambiguousPress, "ambiguous press", "invalid_request")

  const snapshot = await runtime.snapshot({
    maxTextLength: 5_000,
    maxElements: 50,
  })
  assertOk(snapshot, "snapshot")
  const tokenElement = findElement(
    snapshot.data,
    (element) => element.name === "api-token" || element.placeholder === "api-token"
  )
  const passwordElement = findElement(
    snapshot.data,
    (element) => element.name === "password"
  )
  const sensitiveElements = [
    [tokenElement, "api-token"],
    [passwordElement, "password"],
    [
      findElement(snapshot.data, (element) => element.name === "Card number"),
      "card number",
    ],
    [
      findElement(snapshot.data, (element) => element.name === "Card CVV"),
      "card CVV",
    ],
    [findElement(snapshot.data, (element) => element.name === "SSN"), "SSN"],
    [findElement(snapshot.data, (element) => element.name === "IBAN"), "IBAN"],
    [
      findElement(
        snapshot.data,
        (element) => element.name === "Bank account number"
      ),
      "account number",
    ],
    [
      findElement(
        snapshot.data,
        (element) => element.name === "Bank account number editor"
      ),
      "contenteditable account number",
    ],
  ] as const
  for (const [element, label] of sensitiveElements) {
    assertRedacted(element, label)
  }
  const zipCodeElement = findElement(
    snapshot.data,
    (element) => element.name === "ZIP code"
  )
  const postalCodeElement = findElement(
    snapshot.data,
    (element) => element.name === "Postal code"
  )
  assertEqual(zipCodeElement.value, "200000", "ZIP code remains visible")
  assertEqual(
    postalCodeElement.value,
    "SW1A 1AA",
    "postal code remains visible"
  )
  const serializedSnapshot = JSON.stringify(snapshot.data)
  for (const sensitiveValue of [
    "super-secret-password",
    "super-secret-token",
    "4111111111111111",
    "123-45-6789",
    "DE89370400440532013000",
    "9876543210",
    "contenteditable-account-secret",
  ]) {
    if (serializedSnapshot.includes(sensitiveValue)) {
      throw new Error(`snapshot exposed sensitive value: ${sensitiveValue}`)
    }
  }
  const currentRefButton = findElement(
    snapshot.data,
    (element) => element.name === "Copy ref"
  )

  const clippedScreenshotPath = resolve(
    config.screenshotDir,
    "smoke-clipped.png"
  )
  const clippedScreenshot = await runtime.screenshot({
    path: clippedScreenshotPath,
    clip: { x: 0, y: 0, width: 200, height: 120 },
  })
  assertOk(clippedScreenshot, "clipped screenshot")
  assertEqual(clippedScreenshot.data.clip?.width, 200, "clip width")
  assertEqual(clippedScreenshot.data.clip?.height, 120, "clip height")
  const clippedPng = PNG.sync.read(await readFile(clippedScreenshotPath))
  assertEqual(clippedPng.width, 200, "clipped PNG width")
  assertEqual(clippedPng.height, 120, "clipped PNG height")
  assertError(
    await runtime.screenshot({
      fullPage: true,
      clip: { x: 0, y: 0, width: 20, height: 20 },
    }),
    "full-page clip conflict",
    "invalid_request"
  )
  assertError(
    await runtime.screenshot({
      clip: { x: -1, y: 0, width: 20, height: 20 },
    }),
    "invalid screenshot clip",
    "invalid_request"
  )

  const inspectX = currentRefButton.box.x + currentRefButton.box.width / 2
  const inspectY = currentRefButton.box.y + currentRefButton.box.height / 2
  const pointInspection = await runtime.inspectPoint({
    x: inspectX,
    y: inspectY,
  })
  assertOk(pointInspection, "point inspection")
  const inspectedButton = pointInspection.data.candidates.find(
    (candidate) => candidate.actionable && candidate.tag === "button"
  )
  if (!inspectedButton) {
    throw new Error(
      `point inspection missing button: ${JSON.stringify(pointInspection.data)}`
    )
  }
  assertEqual(
    inspectedButton.locator?.selector,
    "#ref-copy",
    "point locator hint"
  )
  const inclusiveInspection = await runtime.inspectPoint({
    x: inspectX,
    y: inspectY,
    includeNonActionable: true,
  })
  assertOk(inclusiveInspection, "inclusive point inspection")
  if (!inclusiveInspection.data.candidates.some((candidate) => !candidate.actionable)) {
    throw new Error("inclusive point inspection missing non-actionable ancestor")
  }
  const emptyPointInspection = await runtime.inspectPoint({ x: 1, y: 1 })
  assertOk(emptyPointInspection, "empty point inspection")
  assertEqual(
    emptyPointInspection.data.candidates.length,
    0,
    "empty actionable point candidates"
  )
  assertNoKeys(
    inspectedButton as unknown as Record<string, unknown>,
    ["value", "placeholder", "href"],
    "point candidate safe metadata"
  )
  const sensitiveInspection = await runtime.inspectPoint({
    x: tokenElement.box.x + tokenElement.box.width / 2,
    y: tokenElement.box.y + tokenElement.box.height / 2,
  })
  assertOk(sensitiveInspection, "sensitive point inspection")
  const serializedSensitiveInspection = JSON.stringify(sensitiveInspection.data)
  if (
    serializedSensitiveInspection.includes("super-secret-token") ||
    serializedSensitiveInspection.includes("super-secret-password")
  ) {
    throw new Error("point inspection exposed a sensitive field value")
  }
  assertError(
    await runtime.inspectPoint({
      x: inspectX,
      y: inspectY,
      path: resolve(config.screenshotDir, "unused-inspection.png"),
    }),
    "annotation-only path",
    "invalid_request"
  )
  assertError(
    await runtime.inspectPoint({ x: -1, y: 0 }),
    "invalid inspection point",
    "invalid_request"
  )
  const annotatedPath = resolve(config.screenshotDir, "smoke-inspected.png")
  const annotatedInspection = await runtime.inspectPoint({
    x: inspectX,
    y: inspectY,
    includeNonActionable: true,
    annotatedScreenshot: true,
    path: annotatedPath,
    base64: true,
  })
  assertOk(annotatedInspection, "annotated point inspection")
  assertEqual(annotatedInspection.data.path, annotatedPath, "annotation path")
  if (!annotatedInspection.data.sizeBytes || annotatedInspection.data.sizeBytes <= 0) {
    throw new Error("annotated screenshot byte size must be positive")
  }
  const annotatedPng = PNG.sync.read(await readFile(annotatedPath))
  const currentViewportForAnnotation = await runtime.viewport()
  assertOk(currentViewportForAnnotation, "annotation viewport")
  assertEqual(
    annotatedPng.width,
    currentViewportForAnnotation.data.width,
    "annotated PNG width"
  )
  assertEqual(
    annotatedPng.height,
    currentViewportForAnnotation.data.height,
    "annotated PNG height"
  )
  const elementBox = okData(
    await runtime.elementBox({ selector: "#element-visual-target" }),
    "element box"
  )
  assertEqual(Math.round(elementBox.box.width), 120, "element box width")
  assertEqual(Math.round(elementBox.box.height), 44, "element box height")
  assertOkWithoutNarrowing(
    await runtime.elementVisual({
      action: "box",
      selector: "#element-visual-target",
    }),
    "aggregated element visual"
  )
  const visualFrames = okData(await runtime.frames(), "visual frames")
  const visualFrame = visualFrames.frames.find((entry) => !entry.main)
  if (!visualFrame) throw new Error("visual frame missing")
  const frameElementBox = okData(
    await runtime.elementBox({
      frameId: visualFrame.id,
      locator: { testId: "frame-copy" },
    }),
    "frame element box"
  )
  assertEqual(frameElementBox.box.width > 0, true, "frame element box width")
  const elementScreenshotPath = resolve(config.screenshotDir, "smoke-element.png")
  const elementScreenshot = okData(
    await runtime.elementScreenshot({
      locator: { role: "button", name: "Element visual target", exact: true },
      path: elementScreenshotPath,
      base64: true,
    }),
    "element screenshot"
  )
  const elementPng = PNG.sync.read(await readFile(elementScreenshot.path))
  assertEqual(
    Math.abs(elementPng.width - Math.round(elementScreenshot.box.width)) <= 1,
    true,
    "element screenshot width"
  )
  assertEqual(
    Math.abs(elementPng.height - Math.round(elementScreenshot.box.height)) <= 1,
    true,
    "element screenshot height"
  )
  const offscreenBox = okData(
    await runtime.elementBox({ selector: "#element-offscreen-target" }),
    "offscreen element box"
  )
  assertEqual(offscreenBox.inViewport, false, "offscreen element viewport")
  okData(
    await runtime.scrollIntoView({ selector: "#element-offscreen-target" }),
    "scroll element into view"
  )
  const visualSnapshot = okData(
    await runtime.snapshot({ maxElements: 100 }),
    "visual target snapshot"
  )
  const visualRef = findElement(
    visualSnapshot,
    (element) => element.name === "Offscreen visual target"
  )
  const highlighted = okData(
    await runtime.elementHighlight({
      ref: visualRef.ref,
      path: resolve(config.screenshotDir, "smoke-highlight.png"),
    }),
    "element highlight"
  )
  await assertFileExists(highlighted.path, "element highlight")
  assertError(
    await runtime.elementBox({
      selector: "#element-visual-target",
      locator: { testId: "locator-action" },
    }),
    "conflicting visual targets",
    "invalid_request"
  )
  const internalRuntime = runtime as unknown as {
    activeTabId: string | null
    pages: Map<
      string,
      {
        page: {
          locator(selector: string): {
            scrollIntoViewIfNeeded(): Promise<void>
            boundingBox(): Promise<
              | { x: number; y: number; width: number; height: number }
              | null
            >
          }
        }
      }
    >
  }
  const internalPage = internalRuntime.activeTabId
    ? internalRuntime.pages.get(internalRuntime.activeTabId)?.page
    : undefined
  const iframeLocator = internalPage?.locator("#smoke-frame")
  await iframeLocator?.scrollIntoViewIfNeeded()
  const iframeBox = await iframeLocator?.boundingBox()
  if (iframeBox) {
    const iframeInspection = await runtime.inspectPoint({
      x: iframeBox.x + iframeBox.width / 2,
      y: iframeBox.y + iframeBox.height / 2,
      includeNonActionable: true,
    })
    assertOk(iframeInspection, "iframe point inspection")
    const iframeCandidate = iframeInspection.data.candidates.find(
      (candidate) => candidate.tag === "iframe"
    )
    if (
      !iframeCandidate?.insideFrame ||
      !iframeCandidate.frameInspectionDeferred
    ) {
      throw new Error(
        `iframe point inspection missing deferred flags: ${JSON.stringify(iframeInspection.data)}`
      )
    }
  }

  const staleRef = await runtime.click({ ref: refButton.ref })
  assertError(staleRef, "stale ref", "element_ref_not_found")

  const ambiguous = await runtime.click({
    ref: currentRefButton.ref,
    selector: "#ref-copy",
  })
  assertError(ambiguous, "ambiguous click", "invalid_request")

  const current = await runtime.tab({ action: "current" })
  assertOk(current, "current")
  assertUrl(current, "current", "smoke-fixture.html")

  const urlWait = await runtime.navigation({ action: "wait_url", url: "*smoke-fixture.html" })
  assertOk(urlWait, "wait url")

  const downloaded = await runtime.expectDownload({
    action: { type: "click", selector: "#download-link" },
    filename: "nested/smoke-download.txt",
    timeoutMs: 5_000,
  })
  assertOk(downloaded, "expect download")
  assertEqual(
    downloaded.data.suggestedFilename,
    "smoke-download.txt",
    "download suggested filename"
  )
  assertPathInside(downloaded.data.path, config.downloadDir, "download path")
  assertStringIncludes(
    downloaded.data.path,
    "smoke-download.txt",
    "download saved filename"
  )
  assertStringIncludes(
    downloaded.data.url,
    "data:text/plain",
    "download URL"
  )
  await assertFileExists(downloaded.data.path, "download file")

  const ambiguousDownload = await runtime.expectDownload({
    action: {
      type: "click",
      selector: "#download-link",
      x: 1,
      y: 1,
    },
    timeoutMs: 500,
  })
  assertError(ambiguousDownload, "ambiguous download", "invalid_request")

  const failedNavigationTrigger = await runtime.expectNavigation({
    action: { type: "click", selector: "[" },
    timeoutMs: 100,
  })
  assertError(
    failedNavigationTrigger,
    "failed navigation trigger",
    "selector_not_found"
  )
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 150))

  const navigated = await runtime.expectPage({
    event: "navigation",
    trigger: { type: "click", selector: "#nav-link" },
    waitUntil: "domcontentloaded",
  })
  assertOk(navigated, "expect navigation")
  assertUrl(navigated, "expect navigation", "smoke-target.html")

  const targetCurrent = await runtime.tab({ action: "current" })
  assertOk(targetCurrent, "target current")
  assertUrl(targetCurrent, "target current", "smoke-target.html")

  const back = await runtime.navigation({ action: "back" })
  assertOk(back, "back")
  assertUrl(back, "back", "smoke-fixture.html")

  const forward = await runtime.navigation({ action: "forward" })
  assertOk(forward, "forward")
  assertUrl(forward, "forward", "smoke-target.html")

  const reloaded = await runtime.navigation({ action: "reload" })
  assertOk(reloaded, "reload")
  assertUrl(reloaded, "reload", "smoke-target.html")

  const backToFixture = await runtime.navigation({ action: "back" })
  assertOk(backToFixture, "back to fixture")
  assertUrl(backToFixture, "back to fixture", "smoke-fixture.html")

  const missingDialog = await runtime.dialog({ action: "handle", accept: true })
  assertError(missingDialog, "missing dialog", "dialog_not_found")

  const alertClicked = await runtime.click({ selector: "#alert-button" })
  assertOk(alertClicked, "alert click")
  const alertDialog = await runtime.dialog()
  assertDialog(alertDialog, "alert dialog", "alert", "smoke alert")
  for (const [label, blocked] of [
    ["snapshot", await runtime.snapshot({})],
    ["assets", await runtime.assets()],
    ["performance summary", await runtime.performanceSummary()],
  ] as const) {
    assertError(blocked, `dialog-blocked ${label}`, "operation_failed")
    assertStringIncludes(
      blocked.error?.message ?? "",
      "browser_dialog",
      `dialog-blocked ${label} guidance`
    )
  }
  assertOk(await runtime.handleDialog({ accept: true }), "handle alert")
  assertOk(
    await runtime.wait({ selector: "text=alert handled" }),
    "alert wait"
  )

  const confirmClicked = await runtime.click({ selector: "#confirm-button" })
  assertOk(confirmClicked, "confirm click")
  const confirmDialog = await runtime.dialog()
  assertDialog(confirmDialog, "confirm dialog", "confirm", "smoke confirm")
  assertOk(
    await runtime.handleDialog({ accept: false }),
    "dismiss confirm"
  )
  assertOk(
    await runtime.wait({ selector: "text=confirm dismissed" }),
    "confirm wait"
  )

  const promptClicked = await runtime.click({ selector: "#prompt-button" })
  assertOk(promptClicked, "prompt click")
  const promptDialog = await runtime.dialog()
  assertDialog(promptDialog, "prompt dialog", "prompt", "smoke prompt", "seed")
  assertOk(
    await runtime.handleDialog({
      accept: true,
      promptText: "typed prompt",
    }),
    "accept prompt"
  )
  assertOk(
    await runtime.wait({ selector: "text=prompt=typed prompt" }),
    "prompt wait"
  )

  const screenshot = await runtime.screenshot({
    path: resolve(config.screenshotDir, "smoke.png"),
  })
  assertOk(screenshot, "screenshot")
  assertEqual(
    screenshot.data.path,
    resolve(config.screenshotDir, "smoke.png"),
    "screenshot absolute path"
  )
  if (screenshot.data.sizeBytes <= 0) {
    throw new Error("screenshot byte size must be positive")
  }

  const artifacts = await runtime.artifacts({
    types: ["screenshot", "download"],
    limit: 1_000,
  })
  assertOk(artifacts, "artifacts")
  assertEqual(
    artifacts.data.roots.screenshots,
    config.screenshotDir,
    "artifact screenshot root"
  )
  assertEqual(
    artifacts.data.roots.downloads,
    config.downloadDir,
    "artifact download root"
  )
  assertArtifactPath(
    artifacts.data.artifacts,
    "screenshot",
    screenshot.data.path,
    "screenshot artifact"
  )
  assertArtifactPath(
    artifacts.data.artifacts,
    "download",
    downloaded.data.path,
    "download artifact"
  )
  assertNoKeys(
    artifacts.data.artifacts[0],
    ["content", "base64", "body", "text", "data"],
    "artifact metadata"
  )

  const screenshotArtifacts = await runtime.artifacts({
    types: ["screenshot"],
    limit: 1,
  })
  assertOk(screenshotArtifacts, "screenshot artifacts")
  assertEqual(
    screenshotArtifacts.data.artifacts.length <= 1,
    true,
    "artifact limit"
  )
  assertEqual(
    screenshotArtifacts.data.artifacts.every(
      (artifact) => artifact.type === "screenshot"
    ),
    true,
    "artifact type filter"
  )

  const invalidArtifactType = await runtime.artifacts({
    types: ["profile"],
  })
  assertError(invalidArtifactType, "invalid artifact type", "invalid_request")

  console.log(
    JSON.stringify(
      {
        ok: true,
        sessionId: runtime.sessionId,
        screenshot: screenshot.data?.path,
        textIncludesOutput:
          typeof snapshot.data?.text === "string" &&
          snapshot.data.text.includes("hello from chrome-power"),
        refTextIncludesOutput:
          typeof snapshot.data?.text === "string" &&
          snapshot.data.text.includes("hello from ref"),
        elementCount: snapshot.data?.elements.length,
        redactedValues:
          tokenElement.valueRedacted === true &&
          passwordElement.valueRedacted === true,
        staleRefRejected: staleRef.error?.code === "element_ref_not_found",
        ambiguousRejected: ambiguous.error?.code === "invalid_request",
        ambiguousPressRejected:
          ambiguousPress.error?.code === "invalid_request",
        downloadCovered:
          downloaded.ok && ambiguousDownload.error?.code === "invalid_request",
        p3FrameUploadCovered:
          frames.ok &&
          frameSnapshot.ok &&
          frameLocatorText.ok &&
          directUpload.ok &&
          chooserUpload.ok &&
          uploadNoConfirmation.error?.code === "invalid_request" &&
          uploadRelativePath.error?.code === "invalid_request" &&
          uploadMissingFile.error?.code === "file_not_found" &&
          uploadTooMany.error?.code === "invalid_request" &&
          chooserTooMany.error?.code === "invalid_request",
        p4ViewportCovered:
          initialViewport.ok &&
          mobileViewport.ok &&
          explicitViewport.ok &&
          unknownViewportPreset.error?.code === "invalid_request" &&
          partialViewport.error?.code === "invalid_request",
        p6EnvironmentCovered:
          initialEnvironment.ok &&
          geolocation.ok &&
          permissionGrant.ok &&
          clearGeolocation.ok &&
          clearPermissions.ok &&
          invalidLatitude.error?.code === "invalid_request" &&
          invalidLongitude.error?.code === "invalid_request" &&
          invalidPermission.error?.code === "invalid_request" &&
          invalidOrigin.error?.code === "invalid_request",
        p8EmulationCovered:
          initialEmulation.ok &&
          prelaunchEmulation.ok &&
          appliedEmulation.ok &&
          emulatedUserAgent.ok &&
          emulatedLocale.ok &&
          emulatedTimezone.ok &&
          emulatedDpr.ok &&
          emulatedTouch.ok &&
          emulationWithoutConfirmation.error?.code === "invalid_request" &&
          confirmedEmulation.ok &&
          oldTabAfterRelaunch.error?.code === "tab_not_found" &&
          clearEmulationWithoutConfirmation.error?.code === "invalid_request" &&
          clearedEmulation.ok &&
          invalidUserAgent.error?.code === "invalid_request" &&
          invalidLocale.error?.code === "invalid_request" &&
          invalidTimezone.error?.code === "invalid_request" &&
          invalidDeviceScaleFactor.error?.code === "invalid_request",
        p9DevicePresetsCovered: deviceSmoke.covered,
        p7ObservabilityCovered:
          preOpenStatus.ok &&
          postOpenStatus.ok &&
          statusAfterExternalClose.ok &&
          diagnosticStatus.ok &&
          artifacts.ok &&
          screenshotArtifacts.ok &&
          invalidArtifactType.error?.code === "invalid_request",
        p5DiagnosticsCovered:
          pageErrors.ok &&
          responseEvents.ok &&
          failedNetworkEvents.ok &&
          invalidStatusRange.error?.code === "invalid_request",
        p10NetworkWorkflowCovered:
          existingNetworkWait.ok &&
          existingNetworkAfterClear.ok &&
          futureNetworkWait.ok &&
          networkWaitTimeout.error?.code === "operation_failed" &&
          invalidNetworkWaitRange.error?.code === "invalid_request" &&
          networkSummary.ok &&
          invalidNetworkSummaryRange.error?.code === "invalid_request",
        p11WebSocketDiagnosticsCovered:
          webSocketEvents.ok &&
          filteredWebSocketEvents.ok &&
          webSocketStatus.ok &&
          existingWebSocketWait.ok &&
          existingWebSocketAfterClear.ok &&
          futureWebSocketWait.ok &&
          webSocketWaitTimeout.error?.code === "operation_failed" &&
          webSocketSummaryWait.ok &&
          webSocketSummary.ok &&
          invalidWebSocketSummaryTab.error?.code === "tab_not_found" &&
          clearedWebSocketEvents.ok &&
          webSocketEventsAfterClear.ok &&
          invalidWebSocketTab.error?.code === "tab_not_found",
        p12AssetInventoryCovered:
          assets.ok && filteredAssets.ok && frameAssets.ok,
        p13PerformanceDiagnosticsCovered:
          initialPerformance.ok && interactedPerformance.ok,
        p14PopupWorkflowCovered:
          selectorPopup.ok &&
          refPopup.ok &&
          missingPopup.error?.code === "popup_failed" &&
          multiplePopup.ok,
        p15DiagnosticWaitsCovered:
          existingConsoleWait.ok &&
          futureConsoleWait.ok &&
          consoleWaitTimeout.error?.code === "operation_failed" &&
          existingPageErrorWait.ok &&
          futurePageErrorWait.ok &&
          pageErrorWaitTimeout.error?.code === "operation_failed",
        p0ActionsCovered: true,
        p1LocatorReadCovered: true,
        p16SemanticLocatorActionsCovered: true,
        p17SemanticLocatorActionsCovered: true,
        p18TestingControlsCovered: true,
        p19ElementVisualInspectionCovered: true,
        p20FineGrainedInputCovered: true,
        p1ConsoleLogsCovered: true,
      },
      null,
      2
    )
  )
}

async function listenOnLoopback(html: string) {
  const server = createServer((request, response) => {
    if (request.url === "/" || request.url === "/index.html") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      })
      response.end(html)
      return
    }

    response.writeHead(404, {
      "content-type": "text/plain; charset=utf-8",
    })
    response.end("not found")
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen)
      resolveListen()
    })
  })

  const address = server.address()
  if (address == null || typeof address === "string") {
    await closeServer(server)
    throw new Error(`Unable to start geolocation smoke server: ${address}`)
  }

  return { server, port: address.port }
}

async function listenOnNetworkSmoke() {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Chrome Power Network Smoke</title>
  </head>
  <body>
    <main>
      <h1>Network Smoke</h1>
      <button id="fetch-ok" onclick="fetch('/api/smoke-ok?case=existing').then(() => {
        document.querySelector('#network-output').textContent = 'ok-done';
      })">Fetch OK</button>
      <button id="fetch-delayed" onclick="fetch('/api/smoke-delayed?case=future').then(() => {
        document.querySelector('#network-output').textContent = 'delayed-done';
      })">Fetch Delayed</button>
      <button id="fetch-summary" onclick="Promise.allSettled([
        fetch('/api/smoke-summary-ok?kind=summary'),
        fetch('/api/smoke-summary-status?kind=summary'),
        fetch('http://127.0.0.1:1/smoke-summary-fail?kind=summary')
      ]).then(() => {
        document.querySelector('#network-output').textContent = 'summary-done';
      })">Fetch Summary</button>
      <p id="network-output"></p>
    </main>
  </body>
</html>
`

  const server = createServer((request, response) => {
    const url = request.url ?? "/"
    if (url === "/" || url === "/index.html") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      })
      response.end(html)
      return
    }

    if (url.startsWith("/api/smoke-ok")) {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      })
      response.end(JSON.stringify({ ok: true }))
      return
    }

    if (url.startsWith("/api/smoke-delayed")) {
      setTimeout(() => {
        response.writeHead(201, {
          "content-type": "application/json; charset=utf-8",
        })
        response.end(JSON.stringify({ delayed: true }))
      }, 150)
      return
    }

    if (url.startsWith("/api/smoke-summary-ok")) {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      })
      response.end(JSON.stringify({ summary: "ok" }))
      return
    }

    if (url.startsWith("/api/smoke-summary-status")) {
      response.writeHead(503, {
        "content-type": "application/json; charset=utf-8",
      })
      response.end(JSON.stringify({ summary: "unavailable" }))
      return
    }

    response.writeHead(404, {
      "content-type": "text/plain; charset=utf-8",
    })
    response.end("not found")
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen)
      resolveListen()
    })
  })

  const address = server.address()
  if (address == null || typeof address === "string") {
    await closeServer(server)
    throw new Error(`Unable to start network smoke server: ${address}`)
  }

  return { server, port: address.port }
}

async function listenOnWebSocketSmoke() {
  let port = 0
  const server = createServer((request, response) => {
    const url = request.url ?? "/"
    if (url === "/" || url === "/index.html") {
      const webSocketUrl = `ws://127.0.0.1:${port}/socket?case=metadata`
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      })
      response.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Chrome Power WebSocket Smoke</title>
  </head>
  <body>
    <main>
      <h1>WebSocket Smoke</h1>
      <button id="websocket-run" onclick="window.runWebSocketSmoke()">Run WebSocket</button>
      <p id="websocket-output"></p>
    </main>
    <script>
      window.runWebSocketSmoke = () => {
        const output = document.querySelector('#websocket-output');
        const socket = new WebSocket('${webSocketUrl}');
        socket.addEventListener('open', () => {
          socket.send('client-smoke-secret');
        });
        socket.addEventListener('message', () => {
          output.textContent = 'ws-message';
          socket.close();
        });
        socket.addEventListener('close', () => {
          output.textContent = 'ws-done';
        });
        socket.addEventListener('error', () => {
          output.textContent = 'ws-error';
        });
      };
    </script>
  </body>
</html>
`)
      return
    }

    response.writeHead(404, {
      "content-type": "text/plain; charset=utf-8",
    })
    response.end("not found")
  })

  server.on("upgrade", (request, socket) => {
    if (!request.url?.startsWith("/socket")) {
      socket.destroy()
      return
    }

    const key = request.headers["sec-websocket-key"]
    if (typeof key !== "string") {
      socket.destroy()
      return
    }

    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64")
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
      ].join("\r\n") + "\r\n\r\n"
    )

    let responded = false
    socket.on("data", () => {
      if (responded) return
      responded = true
      socket.write(webSocketTextFrame("server-smoke-secret"))
      setTimeout(() => {
        socket.write(Buffer.from([0x88, 0x00]))
        socket.end()
      }, 50)
    })
    socket.on("error", () => undefined)
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen)
      resolveListen()
    })
  })

  const address = server.address()
  if (address == null || typeof address === "string") {
    await closeServer(server)
    throw new Error(`Unable to start websocket smoke server: ${address}`)
  }

  port = address.port
  return { server, port }
}

function webSocketTextFrame(payload: string) {
  const body = Buffer.from(payload, "utf8")
  if (body.length > 125) {
    throw new Error(`WebSocket smoke payload is too large: ${body.length}`)
  }
  return Buffer.concat([Buffer.from([0x81, body.length]), body])
}

async function closeServer(server: Server) {
  if (!server.listening) return
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error)
      else resolveClose()
    })
  })
}

async function withSmokeTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      void deviceRuntime.dispose()
      void runtime.dispose()
      reject(new Error(`Smoke timed out after ${smokeTimeoutMs}ms`))
    }, smokeTimeoutMs)
    timeout.unref()
  })

  try {
    return await Promise.race([operation, timeoutPromise])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function envPositiveNumber(name: string, fallback: number) {
  const value = process.env[name]
  if (value == null || value === "") return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function assertOk<T>(
  result: ToolResult<T>,
  step: string
): asserts result is ToolResult<T> & { ok: true; data: T } {
  if (!result.ok || result.data == null) {
    throw new Error(`${step} failed: ${JSON.stringify(result.error)}`)
  }
}

function assertOkWithoutNarrowing(result: ToolResult, step: string) {
  if (!result.ok || result.data == null) {
    throw new Error(`${step} failed: ${JSON.stringify(result.error)}`)
  }
}

function okData<T>(result: ToolResult<T>, step: string): T {
  if (!result.ok || result.data == null) {
    throw new Error(`${step} failed: ${JSON.stringify(result.error)}`)
  }
  return result.data
}

function assertError(
  result: ToolResult,
  step: string,
  expectedCode: string
) {
  if (result.ok || result.error?.code !== expectedCode) {
    throw new Error(
      `${step} should fail with ${expectedCode}: ${JSON.stringify(result)}`
    )
  }
}

function assertUrl(result: ToolResult, step: string, expectedFragment: string) {
  if (!result.ok || !result.url?.includes(expectedFragment)) {
    throw new Error(
      `${step} should have URL containing ${expectedFragment}: ${JSON.stringify(result)}`
    )
  }
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(
      `${label} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    )
  }
}

function assertNotEqual<T>(actual: T, unexpected: T, label: string) {
  if (actual === unexpected) {
    throw new Error(
      `${label} should not equal ${JSON.stringify(unexpected)}`
    )
  }
}

function assertArrayIncludes(values: string[], expected: string, label: string) {
  if (!values.includes(expected)) {
    throw new Error(
      `${label} missing ${JSON.stringify(expected)}: ${JSON.stringify(values)}`
    )
  }
}

function assertArrayExcludes(values: string[], expected: string, label: string) {
  if (values.includes(expected)) {
    throw new Error(
      `${label} unexpectedly includes ${JSON.stringify(expected)}: ${JSON.stringify(values)}`
    )
  }
}

function assertStringIncludes(value: string, expected: string, label: string) {
  if (!value.includes(expected)) {
    throw new Error(
      `${label} missing ${JSON.stringify(expected)}: ${JSON.stringify(value)}`
    )
  }
}

function assertNoKeys(
  value: Record<string, unknown>,
  keys: string[],
  label: string
) {
  const present = keys.filter((key) =>
    Object.prototype.hasOwnProperty.call(value, key)
  )
  if (present.length > 0) {
    throw new Error(`${label} exposes unexpected keys: ${present.join(", ")}`)
  }
}

function assertPathInside(path: string, parent: string, label: string) {
  const relativePath = relative(parent, path)
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\")
  ) {
    throw new Error(`${label} is outside ${parent}: ${path}`)
  }
}

function assertArtifactPath(
  artifacts: ArtifactEntry[],
  type: ArtifactEntry["type"],
  path: string | undefined,
  label: string
) {
  if (!path) {
    throw new Error(`${label} missing source path`)
  }
  const artifact = artifacts.find(
    (entry) => entry.type === type && entry.path === path
  )
  if (!artifact) {
    throw new Error(
      `${label} missing ${path}: ${JSON.stringify(artifacts)}`
    )
  }
  if (artifact.size < 0 || !artifact.modifiedTime) {
    throw new Error(`${label} metadata invalid: ${JSON.stringify(artifact)}`)
  }
}

async function assertFileExists(path: string, label: string) {
  try {
    await access(path)
  } catch {
    throw new Error(`${label} missing: ${path}`)
  }
}

function assertLogContains(
  logs: Array<{ level: string; message: string }>,
  level: string,
  message: string
) {
  if (!logs.some((entry) => entry.level === level && entry.message === message)) {
    throw new Error(
      `console log missing ${level}/${message}: ${JSON.stringify(logs)}`
    )
  }
}

function assertDialog(
  result: ToolResult,
  step: string,
  expectedType: DialogInfo["type"],
  expectedMessage: string,
  expectedDefaultValue?: string
) {
  const data = result.data as { dialog?: DialogInfo } | undefined
  if (!result.ok || data?.dialog == null) {
    throw new Error(`${step} missing dialog: ${JSON.stringify(result)}`)
  }
  const dialog = data.dialog
  if (
    dialog.type !== expectedType ||
    dialog.message !== expectedMessage ||
    (expectedDefaultValue != null && dialog.defaultValue !== expectedDefaultValue)
  ) {
    throw new Error(
      `${step} dialog mismatch: ${JSON.stringify(dialog)}`
    )
  }
}

function findElement(
  summary: PageSummary,
  predicate: (element: SnapshotElement) => boolean
) {
  const element = summary.elements.find(predicate)
  if (!element) {
    throw new Error(`element not found: ${JSON.stringify(summary.elements)}`)
  }
  return element
}

function assertRedacted(element: SnapshotElement, label: string) {
  if (element.value != null || element.valueRedacted !== true) {
    throw new Error(
      `${label} value was not redacted: ${JSON.stringify(element)}`
    )
  }
}
