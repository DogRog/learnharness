// Checkout-only browser test: real pointer input (pen, touch, mouse, wheel) from
// the DevTools protocol against the plugin in a disposable page.
//   npm run test:browser              source build
//   npm run test:browser -- --built   dist/main.js
//   npm run test:browser -- --serve   keep the fixture open for manual inspection
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";

const root = fileURLToPath(new URL("../", import.meta.url)), repo = path.resolve(root, "../..");
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sketchpad-browser-"));
const chrome = process.env.CHROME_PATH ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/opt/pw-browsers/chromium"].find(file => fs.existsSync(file));
const errors = [], denied = [], groups = [];
let browser, server, page;
// SCREENSHOT_DIR=<folder> saves the page after each group for visual review.
const shots = process.env.SCREENSHOT_DIR;
async function shot(name) {
  if (shots && page) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${name}.png`) }); }
}
async function group(label) { groups.push(label); console.log(`PASS ${label}`); await shot(String(groups.length).padStart(2, "0")); }
try {
  if (!chrome) throw new Error("Set CHROME_PATH to a Chrome or Chromium executable.");
  await build({ absWorkingDir: root, entryPoints: ["tests/browser-fixture.mjs"], outfile: path.join(evidence, "fixture.js"), bundle: true,
    format: "esm", platform: "browser", target: "es2022", jsx: "automatic", alias: { "@": repo },
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning",
    banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "production" } };' },
    plugins: [{ name: "fixture-resolution", setup(builder) {
      if (process.argv.includes("--built")) builder.onResolve({ filter: /^\.\.\/src\/main\.ts$/ }, args =>
        args.importer === path.join(root, "tests/browser-fixture.mjs") ? { path: path.join(root, "dist/main.js") } : undefined);
      builder.onResolve({ filter: /^node:crypto$/ }, args => ({ path: args.path, external: true, sideEffects: false }));
    } }] });
  assert.doesNotMatch(fs.readFileSync(path.join(evidence, "fixture.js"), "utf8"), /(?:from\s*|import\s*)["']node:/, "the fixture must not retain any Node runtime import");
  // The page mirrors the app frame: a sidebar, a top bar, and the session area that hosts the surface.
  const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="/plugin.css"><style>
    html.dark{color-scheme:dark}html.light{color-scheme:light}
    *{box-sizing:border-box} html,body{height:100%} body{margin:0;display:flex;background:var(--background);color:var(--foreground);font-family:system-ui,sans-serif}
    #sidebar{flex:0 0 220px;border-right:1px solid var(--border);padding:12px}
    #pane{position:relative;isolation:isolate;flex:1;min-width:0;display:flex;flex-direction:column}
    #bar{flex:0 0 48px;display:flex;align-items:center;gap:12px;padding:0 12px;border-bottom:1px solid var(--border)}
    #session{position:relative;flex:1;min-height:0}
    #pad{position:absolute;inset:0;display:flex;flex-direction:column;overflow:hidden;background:var(--background);z-index:101}
    #pad-scroll{flex:1;min-height:0;width:100%;overflow-y:auto}
    #close-pad{position:absolute;right:8px;top:8px;z-index:10;width:28px;height:28px}
    </style></head><body><aside id="sidebar">Fixture sidebar</aside><div id="pane"><div id="bar"><button id="sketch">Loading</button></div>
    <div id="session"><p style="padding:24px">Fixture transcript</p><div id="mounts" style="display:contents"></div></div></div>
    <script type="module" src="/fixture.js"></script></body></html>`;
  server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://fixture");
    if (url.pathname === "/") { response.setHeader("content-type", "text/html"); response.end(html); return; }
    if (url.pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
    const file = url.pathname === "/fixture.js" ? path.join(evidence, "fixture.js")
      : url.pathname === "/plugin.css" ? path.join(root, process.argv.includes("--built") ? "dist/styles.css" : "src/styles.css") : undefined;
    if (!file || !fs.existsSync(file)) { response.writeHead(404).end(); return; }
    response.setHeader("content-type", file.endsWith(".css") ? "text/css" : "text/javascript"); response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  if (process.argv.includes("--serve")) {
    console.log(`Sketchpad interactive fixture: ${origin}`);
    await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  } else {
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: path.join(evidence, "profile"), args: ["--no-sandbox"] });
  await browser.defaultBrowserContext().overridePermissions(origin, ["clipboard-read", "clipboard-write"]);
  page = await browser.newPage(); await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1, hasTouch: true });
  page.on("pageerror", error => errors.push(error.stack ?? String(error)));
  page.on("console", message => { if (message.type() === "error" && !message.text().includes("favicon.ico")) errors.push(message.text()); });
  await page.setRequestInterception(true);
  page.on("request", request => {
    const url = request.url();
    if (/^(data:|blob:)/.test(url) || url.startsWith(origin + "/")) void request.continue();
    else { denied.push(url); void request.abort(); }
  });
  await page.goto(origin, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => window.fixtureReady);
  const cdp = await page.createCDPSession();
  const run = (fn, ...args) => page.evaluate(fn, ...args);
  const call = (method, ...args) => page.evaluate((method, args) => window.fixture[method](...args), method, args);
  const label = () => run(() => document.querySelector("#sketch").textContent);
  const frames = () => run(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  /** Wait until the committed-ink canvas is repainted for the current camera. */
  const settled = async () => { await frames(); await page.waitForFunction(() => !document.querySelector(".sketchpad-ink")?.style.transform); await frames(); };
  const open = async () => { await page.click("#sketch"); await page.waitForSelector(".sketchpad-live"); await settled(); };
  /** Press a toolbar control by its accessible name; the toolbar repaints on the next frame. */
  const tool = async name => { await run(name => [...document.querySelectorAll(".sketchpad-button")].find(button => button.getAttribute("aria-label") === name).click(), name); await frames(); };
  const pressed = groupLabel => run(groupLabel => [...document.querySelectorAll(`.sketchpad-group[aria-label="${groupLabel}"] .sketchpad-button[aria-pressed="true"]`)]
    .map(button => button.getAttribute("aria-label")), groupLabel);
  const isDisabled = name => run(name => [...document.querySelectorAll(".sketchpad-button")].find(button => button.getAttribute("aria-label") === name).disabled, name);
  const item = async text => { await run(text => [...document.querySelectorAll(".sketchpad-item")].find(button => button.textContent === text).click(), text); await frames(); };
  const zoom = () => run(() => document.querySelector(".sketchpad-zoom").textContent);
  const box = async () => (await page.$(".sketchpad-live")).boundingBox();
  /** Painted pixels of a canvas: count and bounding box in canvas pixels (the fixture runs at 1× density). */
  const stats = (selector = ".sketchpad-ink") => run(selector => {
    const canvas = document.querySelector(selector), data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0, left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) if (data[(y * canvas.width + x) * 4 + 3] > 0) {
      count++; left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
    return { count, left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
  }, selector);
  /** RGBA of the committed-ink canvas at a viewport-relative point. */
  const pixel = (x, y) => run((x, y) => [...document.querySelector(".sketchpad-ink").getContext("2d").getImageData(x, y, 1, 1).data], Math.round(x), Math.round(y));
  // Real pen input: Chrome turns these into pointer events with pointerType "pen" and the given pressure.
  const pen = async (points, { force = 0.5, button = "left", buttons = 1 } = {}) => {
    const area = await box(), at = ([x, y]) => ({ x: area.x + x, y: area.y + y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at(points[0]), button, buttons, clickCount: 1, pointerType: "pen", force });
    for (const next of points.slice(1)) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at(next), button, buttons, pointerType: "pen", force });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at(points.at(-1)), button, buttons: 0, clickCount: 1, pointerType: "pen" });
    await frames();
  };
  const line = (from, to, steps = 12) => Array.from({ length: steps + 1 }, (_, index) => [from[0] + (to[0] - from[0]) * index / steps, from[1] + (to[1] - from[1]) * index / steps]);
  // Real touch input: each entry is [x, y, id] relative to the sheet.
  const touch = async (type, points, radius = 8) => {
    const area = await box();
    await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y, id]) => ({ x: area.x + x, y: area.y + y, id, radiusX: radius, radiusY: radius, force: 1 })) });
  };
  /** Longer than the pause after pen use during which touches are treated as a resting hand. */
  const rest = () => new Promise(resolve => setTimeout(resolve, 600));
  const images = result => result?.content?.images ?? [];
  const decode = image => run(async image => {
    const picture = new Image(); picture.src = `data:${image.mimeType};base64,${image.data}`; await picture.decode();
    const canvas = document.createElement("canvas"); canvas.width = picture.naturalWidth; canvas.height = picture.naturalHeight;
    const context = canvas.getContext("2d"); context.drawImage(picture, 0, 0);
    window.decoded = context;
    return [picture.naturalWidth, picture.naturalHeight];
  }, image);
  const decodedPixel = (x, y) => run((x, y) => [...window.decoded.getImageData(x, y, 1, 1).data], Math.round(x), Math.round(y));
  const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message ?? "value"}: ${actual} is not within ${tolerance} of ${expected}`);
  const sameColor = (actual, expected, message) => { for (let i = 0; i < 3; i++) near(actual[i], expected[i], 6, message); };

  // ── Action, shortcut, toolbar ──────────────────────────────────────────────
  assert.deepEqual((await call("actions")).map(action => [action.id, action.name, action.shortcut?.defaultBinding]),
    [["sketch", "Sketch", "mod+shift+k"], ["undo", "Undo sketch", undefined], ["redo", "Redo sketch", undefined]]);
  assert.deepEqual(await run(() => window.fixture.placement), { id: "session-sketch", actionId: "sketch", location: "top-bar", sessions: ["teaching", "practice"] });
  assert.equal(await label(), "Sketch"); assert.equal(await call("pending"), false);
  await open();
  assert.equal(await run(() => document.querySelector("#pad").getAttribute("aria-label")), "Sketchpad");
  assert.equal(await run(() => document.activeElement?.className), "sketchpad-viewport", "the sheet takes initial focus");
  const controls = await run(() => [...document.querySelectorAll(".sketchpad-toolbar button")].map(button => {
    const rect = button.getBoundingClientRect();
    return { name: button.getAttribute("aria-label"), title: button.title, width: rect.width, height: rect.height, icon: !!button.querySelector("svg, span") };
  }));
  assert.deepEqual(controls.map(control => control.name), ["Pen", "Highlighter", "Eraser", "Default ink", "Red", "Blue", "Green", "Orange",
    "Fine", "Medium", "Bold", "Undo", "Redo", "Clear", "Background", "Zoom to fit", "Convert to LaTeX", "Full screen"]);
  for (const control of controls) {
    assert.ok(control.width >= 44 && control.height >= 44, `${control.name} is ${control.width} × ${control.height}`);
    assert.equal(control.title, control.name); assert.ok(control.icon, `${control.name} has an icon`);
  }
  assert.equal(await run(() => { const bar = document.querySelector(".sketchpad-toolbar").getBoundingClientRect(), close = document.querySelector("#close-pad").getBoundingClientRect();
    return [...document.querySelectorAll(".sketchpad-toolbar button")].some(button => { const rect = button.getBoundingClientRect(); return rect.right > close.left && rect.top < close.bottom && bar.width > 0; }); }), false,
    "no control sits under the host close button");
  assert.equal(await run(() => getComputedStyle(document.querySelector(".sketchpad-live")).touchAction), "none");
  assert.deepEqual(await pressed("Tool"), ["Pen"]); assert.deepEqual(await pressed("Color"), ["Default ink"]); assert.deepEqual(await pressed("Width"), ["Medium"]);
  assert.equal(await zoom(), "100%"); assert.equal((await stats()).count, 0);
  for (const name of ["Undo", "Redo", "Clear", "Convert to LaTeX"]) assert.equal(await isDisabled(name), true, `${name} is disabled on an empty sheet`);
  await group("action, default shortcut, opaque surface and a touch-sized, named toolbar");

  // ── Pen, pressure, mouse ───────────────────────────────────────────────────
  await pen(line([100, 100], [300, 100]), { force: 0.5 });
  const first = await stats();
  assert.ok(first.count > 400, "the pen stroke painted"); near(first.left, 100, 3, "stroke start"); near(first.right, 300, 3, "stroke end");
  sameColor(await pixel(200, 100), [255, 255, 255], "default ink is white on the dark theme");
  assert.equal(await label(), "Sketch (unsent)"); assert.equal(await call("pending"), true);
  assert.equal((await stats(".sketchpad-live")).count, 0, "the finished stroke left the live layer");
  await pen(line([100, 160], [300, 160]), { force: 1 }); const heavy = (await stats()).count - first.count;
  await pen(line([100, 220], [300, 220]), { force: 0.1 }); const light = (await stats()).count - first.count - heavy;
  assert.ok(heavy > first.count * 1.3 && light < first.count * 0.8, `pressure changes the width: light ${light}, medium ${first.count}, heavy ${heavy}`);
  const beforeMouse = (await stats()).count, area = await box();
  await page.mouse.move(area.x + 100, area.y + 280); await page.mouse.down(); await page.mouse.move(area.x + 300, area.y + 280, { steps: 10 }); await page.mouse.up(); await frames();
  near((await stats()).count - beforeMouse, first.count, first.count * 0.15, "a mouse draws at the nominal width");
  await group("pen draws with pressure, mouse draws, and the action reports unsent ink");

  // ── Fingers never draw: one finger pans, two fingers pinch ─────────────────
  // A touch that lands right after the pen was used is a resting hand: it does not move the sheet.
  await pen(line([100, 340], [300, 340]));
  const beforeTouch = await stats();
  await touch("touchStart", [[500, 400, 1]]); await touch("touchMove", [[620, 460, 1]]); await touch("touchEnd", []); await settled();
  assert.equal((await stats()).left, beforeTouch.left, "a hand resting just after a pen stroke does not pan");
  await rest();
  await touch("touchStart", [[500, 400, 1]]); await touch("touchMove", [[540, 430, 1]]); await touch("touchMove", [[620, 460, 1]]); await touch("touchEnd", []);
  await settled();
  const panned = await stats();
  near(panned.count, beforeTouch.count, beforeTouch.count * 0.03, "a finger adds no ink");
  near(panned.left - beforeTouch.left, 120, 2, "one finger pans horizontally"); near(panned.top - beforeTouch.top, 60, 2, "one finger pans vertically");
  assert.equal(await zoom(), "100%");
  await touch("touchStart", [[300, 300, 1]]); await touch("touchStart", [[300, 300, 1], [500, 300, 2]]);
  await touch("touchMove", [[250, 300, 1], [550, 300, 2]]); await touch("touchMove", [[200, 300, 1], [600, 300, 2]]); await touch("touchEnd", []);
  await settled();
  assert.equal(await zoom(), "200%", "spreading two fingers to twice the distance doubles the zoom");
  const pinched = await stats();
  near(pinched.width, panned.width * 2, 6, "ink is twice as wide on screen");
  // The world point under the first midpoint (400, 300) stayed under the fingers.
  near(pinched.left, 400 + (panned.left - 400) * 2, 4, "the pinch zooms around the fingers");
  await touch("touchStart", [[200, 300, 1], [600, 300, 2]]); await touch("touchMove", [[300, 400, 1], [700, 400, 2]]); await touch("touchEnd", []);
  await settled();
  assert.equal(await zoom(), "200%"); near((await stats()).left - pinched.left, 100, 3, "two fingers moving together pan");
  // A third finger and a palm-sized contact are ignored.
  await touch("touchStart", [[100, 500, 7]], 60); await touch("touchMove", [[300, 600, 7]], 60); await touch("touchEnd", []); await settled();
  near((await stats()).left - pinched.left, 100, 3, "a palm-sized contact does not move the sheet");
  await touch("touchStart", [[300, 400, 1], [700, 400, 2]]); await touch("touchMove", [[499, 400, 1], [501, 400, 2]]); await touch("touchEnd", []); await settled();
  assert.equal(await zoom(), "25%", "pinching in stops at 25%");
  await touch("touchStart", [[499, 400, 1], [501, 400, 2]]); await touch("touchMove", [[100, 400, 1], [900, 400, 2]]); await touch("touchEnd", []); await settled();
  assert.equal(await zoom(), "800%", "pinching out stops at 800%");
  assert.equal(await run(() => window.fixture.actionRefreshes), 5, "the host hears about five strokes, never about camera movement");
  await group("palm rejection: fingers never draw; one finger pans; two fingers pinch-zoom and pan within 25%–800%");

  // ── Wheel: ctrl+wheel zooms at the cursor, plain wheel pans; Zoom to fit ───
  await tool("Zoom to fit"); await settled();
  const fitted = await stats(), fitZoom = Number((await zoom()).replace("%", ""));
  assert.ok(fitZoom > 100 && fitZoom <= 200, `fit zoom ${fitZoom}%`);
  near((fitted.left + fitted.right) / 2, area.width / 2, 3, "fit centers horizontally"); near((fitted.top + fitted.bottom) / 2, area.height / 2, 3, "fit centers vertically");
  await page.mouse.move(area.x + fitted.left, area.y + fitted.top);
  await page.keyboard.down("Control"); await page.mouse.wheel({ deltaY: -50 }); await page.keyboard.up("Control"); await settled();
  const wheeled = await stats();
  assert.ok(Number((await zoom()).replace("%", "")) > fitZoom, "ctrl+wheel up zooms in");
  near(wheeled.left, fitted.left, 2, "the point under the cursor stays put"); near(wheeled.top, fitted.top, 2, "the point under the cursor stays put");
  await page.mouse.wheel({ deltaX: 30, deltaY: 40 }); await settled();
  const scrolled = await stats();
  near(scrolled.left - wheeled.left, -30, 2, "wheel pans horizontally"); near(scrolled.top - wheeled.top, -40, 2, "wheel pans vertically");
  await page.keyboard.down("Control"); for (let i = 0; i < 12; i++) await page.mouse.wheel({ deltaY: 100 }); await page.keyboard.up("Control"); await settled();
  assert.equal(await zoom(), "25%");
  // Right mouse drag pans without drawing.
  const beforeDrag = await stats();
  await page.mouse.move(area.x + 600, area.y + 500); await page.mouse.down({ button: "right" }); await page.mouse.move(area.x + 650, area.y + 520, { steps: 4 }); await page.mouse.up({ button: "right" }); await settled();
  const dragged = await stats();
  near(dragged.left - beforeDrag.left, 50, 2, "right drag pans"); near(dragged.count, beforeDrag.count, 4, "right drag adds no ink");
  await tool("Zoom to fit"); await settled();
  await group("ctrl+wheel zooms at the cursor, wheel and right-drag pan, Zoom to fit centers the sketch");

  // ── Undo, Redo, whole-stroke Eraser, stylus eraser ─────────────────────────
  const four = (await stats()).count;
  await tool("Undo"); await settled(); const three = (await stats()).count;
  assert.ok(three < four); assert.equal(await isDisabled("Redo"), false);
  await tool("Redo"); await settled(); near((await stats()).count, four, 2, "redo restores the stroke");
  assert.equal(await isDisabled("Redo"), true);
  assert.equal(await call("disabled", "undo"), false); await call("run", "undo"); await settled();
  near((await stats()).count, three, 2, "the Undo sketch action undoes"); assert.equal(await call("disabled", "redo"), false);
  await call("run", "redo"); await settled(); near((await stats()).count, four, 2, "the Redo sketch action redoes");
  await tool("Eraser"); assert.deepEqual(await pressed("Tool"), ["Eraser"]); assert.deepEqual(await pressed("Color"), []);
  const target = await stats();
  // Cross the top stroke at one point: the whole stroke disappears.
  await pen(line([(target.left + target.right) / 2, target.top - 30], [(target.left + target.right) / 2, target.top + 12], 6));
  await settled(); const erased = await stats();
  assert.ok(erased.count < target.count * 0.95 && erased.top > target.top + 20, `crossing one stroke removes all of it (${target.count} → ${erased.count}, top ${target.top} → ${erased.top})`);
  await tool("Undo"); await settled(); near((await stats()).count, target.count, 2, "undo restores the erased stroke completely");
  await tool("Pen");
  // A held barrel button on a real pen erases without changing the selected tool.
  await pen(line([(target.left + target.right) / 2, target.top - 30], [(target.left + target.right) / 2, target.top + 12], 6), { button: "right", buttons: 2 });
  await settled(); near((await stats()).count, erased.count, 4, "the barrel button erases"); assert.deepEqual(await pressed("Tool"), ["Pen"]);
  await tool("Undo"); await settled();
  // The eraser end of a stylus reports buttons = 32.
  await run((x, top) => {
    const canvas = document.querySelector(".sketchpad-live"), rect = canvas.getBoundingClientRect();
    const fire = (type, y, buttons) => canvas.dispatchEvent(new PointerEvent(type, { pointerId: 91, pointerType: "pen", pressure: buttons ? 0.5 : 0, buttons,
      button: type === "pointermove" ? -1 : 5, clientX: rect.left + x, clientY: rect.top + y, bubbles: true, cancelable: true }));
    fire("pointerdown", top - 30, 32); fire("pointermove", top - 10, 32); fire("pointermove", top + 12, 32); fire("pointerup", top + 12, 0);
  }, (target.left + target.right) / 2, target.top);
  await settled(); near((await stats()).count, erased.count, 4, "the stylus eraser end erases"); assert.deepEqual(await pressed("Tool"), ["Pen"]);
  await tool("Undo"); await settled(); near((await stats()).count, target.count, 2);
  await group("Undo and Redo (buttons and actions), whole-stroke Eraser, barrel button and stylus eraser end");

  // ── Colors, widths, highlighter under pen ──────────────────────────────────
  await tool("Clear"); await shot("clear-confirm");
  assert.match(await run(() => document.querySelector(".sketchpad-popover").textContent), /Clear all ink on this sheet\? This cannot be undone\./);
  assert.ok(await run(() => [...document.querySelectorAll(".sketchpad-popover .sketchpad-item")].every(button => { const rect = button.getBoundingClientRect(); return rect.width >= 44 && rect.height >= 44; })));
  await item("Cancel"); await settled(); near((await stats()).count, target.count, 2, "Cancel keeps the ink");
  await tool("Clear"); await item("Clear ink"); await settled();
  assert.equal((await stats()).count, 0); assert.equal(await label(), "Sketch"); assert.equal(await call("pending"), false);
  assert.equal(await isDisabled("Undo"), true); assert.equal(await isDisabled("Clear"), true);
  await tool("Zoom to fit"); await settled(); assert.equal(await zoom(), "100%", "an empty sheet returns to 100%");
  await pen(line([200, 200], [500, 200])); // white pen first
  await tool("Highlighter"); assert.deepEqual(await pressed("Color"), ["Orange"], "the highlighter keeps its own color");
  await tool("Bold");
  await pen(line([350, 120], [350, 280])); await settled(); // orange highlighter drawn afterwards, across the pen line
  sameColor(await pixel(350, 200), [255, 255, 255], "pen ink stays on top of a highlighter drawn later");
  const marker = await pixel(350, 150);
  sameColor(marker, [240, 140, 0], "highlighter color"); assert.ok(marker[3] > 60 && marker[3] < 120, `highlighter is semi-transparent (alpha ${marker[3]})`);
  assert.ok((await pixel(336, 150))[3] > 0 && (await pixel(364, 150))[3] > 0, "the highlighter is wide");
  await tool("Pen"); assert.deepEqual(await pressed("Color"), ["Default ink"]); assert.deepEqual(await pressed("Width"), ["Medium"], "width is remembered per tool");
  await tool("Red"); await tool("Fine"); await pen(line([200, 320], [500, 320])); await settled();
  sameColor(await pixel(350, 320), [229, 72, 77], "red ink");
  await tool("Blue"); await tool("Bold"); await pen(line([200, 360], [500, 360])); await settled();
  sameColor(await pixel(350, 360), [59, 130, 246], "blue ink");
  assert.ok((await pixel(350, 362))[3] > 0 && (await pixel(350, 322))[3] === 0, "Bold is wider than Fine");
  await tool("Green"); await pen(line([200, 400], [500, 400])); await settled(); sameColor(await pixel(350, 400), [47, 168, 79], "green ink");
  await group("Clear asks first; five colors, three widths; highlighter is wide, translucent and under pen ink");

  // ── Theme ──────────────────────────────────────────────────────────────────
  await call("setTheme", "light"); await settled();
  sameColor(await pixel(250, 200), [0, 0, 0], "default ink is black on the light theme");
  sameColor(await pixel(350, 320), [229, 72, 77], "accent colors do not change with the theme");
  const lightExport = await call("submit", { accept: false });
  await decode(images(lightExport)[0]); sameColor(await decodedPixel(2, 2), [239, 241, 245], "the image uses the light page color");
  await call("setTheme", "dark"); await settled();
  sameColor(await pixel(250, 200), [255, 255, 255], "back to white on dark");
  await group("ink and export follow the app theme");

  // ── Sending through the host's submission runner ───────────────────────────
  assert.equal(await call("pending"), true, "a refused attempt keeps the sketch");
  await run(() => { const canvas = document.createElement("canvas"); canvas.width = 4; canvas.height = 4; window.fixture.otherPadImage = canvas.toDataURL("image/png").split(",")[1]; });
  const strokesBefore = (await stats()).count;
  const sent = await call("submit", { withOtherPad: true, accept: false });
  assert.equal(sent.error, undefined); assert.equal(sent.content.text, "message", "learner text is untouched");
  assert.equal(images(sent).length, 2, "both pads attach an image");
  assert.equal(images(sent)[0].data, await run(() => window.fixture.otherPadImage), "Drawing Pad's image comes first, the sketch second");
  assert.equal(images(sent)[1].mimeType, "image/png");
  const [exportWidth, exportHeight] = await decode(images(sent)[1]);
  // Ink spans x 197..503 and y 103..403 in world units (round caps included), plus 24 units
  // of padding on each side. Image scale 50% is one pixel per unit.
  assert.deepEqual([exportWidth, exportHeight], [354, 348], "tight crop");
  sameColor(await decodedPixel(2, 2), [20, 20, 20], "padding has the page color");
  sameColor(await decodedPixel(250 - 173, 200 - 79), [255, 255, 255], "the pen line is where it was drawn");
  sameColor(await decodedPixel(350 - 173, 400 - 79), [47, 168, 79], "the green line too");
  near((await stats()).count, strokesBefore, 2, "a refused attempt changes nothing"); assert.equal(await label(), "Sketch (unsent)");
  assert.equal(await call("setSetting", "imageScale", 0), "Enter a percentage greater than 0 and at most 100.");
  assert.equal(await call("setSetting", "imageScale", 100), null); assert.equal((await call("saved")).imageScale, 100);
  const doubled = await decode(images(await call("submit", { accept: false }))[0]);
  near(doubled[0], exportWidth * 2, 4, "Image scale 100% is two pixels per unit");
  // Far-apart ink: the image is capped at 2000 × 2000 and keeps its aspect ratio.
  await rest();
  await touch("touchStart", [[300, 400, 1], [700, 400, 2]]); await touch("touchMove", [[499, 400, 1], [501, 400, 2]]); await touch("touchEnd", []); await settled();
  await pen(line([20, 20], [60, 20])); await pen(line([1000, 700], [1040, 700])); await settled();
  const capped = await decode(images(await call("submit", { accept: false }))[0]);
  assert.equal(Math.max(...capped), 2000, `capped export ${capped}`); assert.ok(Math.min(...capped) < 2000 && Math.min(...capped) > 1000);
  await tool("Undo"); await tool("Undo"); await tool("Zoom to fit"); await settled();
  assert.equal(await call("setSetting", "imageScale", 50), null);
  const accepted = await call("submit");
  assert.equal(images(accepted).length, 1); await settled();
  assert.equal((await stats()).count, 0, "teaching: an accepted sketch leaves a fresh sheet"); assert.equal(await label(), "Sketch"); assert.equal(await call("pending"), false);
  assert.equal(await zoom(), "100%"); assert.equal(await isDisabled("Undo"), true);
  assert.equal(images(await call("submit")).length, 0, "an empty sheet attaches nothing");
  await group("sending: appended after Drawing Pad's image, tight crop, Image scale, 2000 px cap, refusal keeps, acceptance clears");

  // ── Sheets are per session and survive closing and reopening ───────────────
  await tool("Red"); await pen(line([150, 150], [400, 300])); await settled();
  await rest();
  await touch("touchStart", [[600, 500, 1]]); await touch("touchMove", [[640, 520, 1]]); await touch("touchEnd", []); await settled();
  const kept = await stats();
  await page.keyboard.press("Escape"); assert.equal(await page.$(".sketchpad-root"), null); assert.equal(await label(), "Sketch (unsent)");
  await open(); const reopened = await stats();
  assert.deepEqual([reopened.count, reopened.left, reopened.top], [kept.count, kept.left, kept.top], "ink and camera are kept across close and reopen");
  assert.deepEqual(await pressed("Color"), ["Red"]);
  await page.click("#close-pad"); assert.equal(await page.$(".sketchpad-root"), null);
  await call("navigate", "practice-1", "practice"); assert.equal(await label(), "Sketch");
  await open(); assert.equal((await stats()).count, 0, "another session starts blank"); assert.deepEqual(await pressed("Color"), ["Default ink"]);
  await pen(line([100, 100], [300, 100])); await settled(); assert.equal(await label(), "Sketch (unsent)");
  assert.equal(images(await call("submit")).length, 1); await settled();
  assert.ok((await stats()).count > 0, "practice: the board stays after acceptance"); assert.equal(await label(), "Sketch"); assert.equal(await call("pending"), false);
  assert.equal(images(await call("submit")).length, 0, "an unchanged practice sketch is not sent again");
  await pen(line([100, 150], [300, 150])); await settled(); assert.equal(await label(), "Sketch (unsent)");
  await tool("Undo"); await settled(); assert.equal(await label(), "Sketch", "undo back to the sent sketch is not new content");
  await page.keyboard.press("Escape");
  await call("navigate", "teach", "teaching"); assert.equal(await label(), "Sketch (unsent)");
  await group("per-session sheets survive close/reopen and navigation; practice marks sent instead of clearing");

  // ── Background: file picker, downscaling, drawing on top, session images ───
  const photo = path.join(evidence, "photo.png");
  fs.writeFileSync(photo, Buffer.from(await run(() => {
    const canvas = document.createElement("canvas"); canvas.width = 3000; canvas.height = 2000;
    const context = canvas.getContext("2d"); context.fillStyle = "#0050c8"; context.fillRect(0, 0, 3000, 2000);
    context.fillStyle = "#ffd200"; context.fillRect(0, 0, 1500, 1000);
    return canvas.toDataURL("image/png").split(",")[1];
  }), "base64"));
  const tutorSvg = '<svg viewBox="0 0 400 200"><rect width="400" height="200" fill="white"/><circle cx="100" cy="100" r="60" fill="#c00000"/></svg>';
  const learnerImage = await run(() => { const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 240;
    const context = canvas.getContext("2d"); context.fillStyle = "#00a000"; context.fillRect(0, 0, 320, 240); return canvas.toDataURL("image/png").split(",")[1]; });
  await call("setHistory", "teach", [
    { id: "u1", role: "user", content: [{ type: "text", text: "my working" }, { type: "image", mimeType: "image/png", data: learnerImage }], timestamp: 1 },
    { id: "s1", role: "custom", customType: "subagent-steer", content: "", display: true, timestamp: 2, details: { kind: "visual", jobId: "j", toolCallId: "v", result: { svg: tutorSvg } } },
  ]);
  await open(); await tool("Clear"); await item("Clear ink"); await tool("Zoom to fit"); await settled();
  await tool("Background"); await shot("background-menu");
  assert.deepEqual(await run(() => [...document.querySelectorAll(".sketchpad-popover .sketchpad-item, .sketchpad-popover .sketchpad-thumb")].map(node => node.textContent || node.getAttribute("aria-label"))),
    ["Choose photo or file", "Tutor figure 1", "Your image 1"]);
  assert.equal(await run(() => { const input = document.querySelector(".sketchpad-file"); return `${input.type} ${input.accept}`; }), "file image/*");
  assert.ok(await run(() => [...document.querySelectorAll(".sketchpad-thumb")].every(button => { const rect = button.getBoundingClientRect(); return rect.width >= 44 && rect.height >= 44; })));
  const [chooser] = await Promise.all([page.waitForFileChooser(), item("Choose photo or file")]);
  await chooser.accept([photo]);
  await page.waitForSelector(".sketchpad-background"); await settled();
  assert.deepEqual(await run(() => { const canvas = document.querySelector(".sketchpad-background"); return [canvas.width, canvas.height, canvas.style.width, canvas.style.height]; }),
    [2400, 1600, "1200px", "800px"], "a 3000 × 2000 photo is kept at 2400 px and placed 1200 units wide");
  const fitBackground = await run(() => { const rect = document.querySelector(".sketchpad-background").getBoundingClientRect(), view = document.querySelector(".sketchpad-viewport").getBoundingClientRect();
    return { left: rect.left - view.left, top: rect.top - view.top, width: rect.width, height: rect.height, viewWidth: view.width, viewHeight: view.height }; });
  near(fitBackground.left + fitBackground.width / 2, fitBackground.viewWidth / 2, 2, "the background is centered"); near(fitBackground.top + fitBackground.height / 2, fitBackground.viewHeight / 2, 2);
  assert.ok(fitBackground.width <= fitBackground.viewWidth && fitBackground.height <= fitBackground.viewHeight, "the whole image is visible");
  assert.equal(await label(), "Sketch", "a background alone is not unsent ink"); assert.equal(await call("pending"), false);
  assert.deepEqual(await pressed("Sheet"), ["Background"]);
  // Mark the image: red ink across the middle.
  const mid = [fitBackground.left + fitBackground.width / 2, fitBackground.top + fitBackground.height / 2];
  await tool("Red"); await pen(line([mid[0] - 100, mid[1]], [mid[0] + 100, mid[1]])); await settled();
  await shot("photo-background");
  const marked = await decode(images(await call("submit", { accept: false }))[0]);
  assert.deepEqual(marked, [1248, 848], "the whole image plus padding at one pixel per unit");
  sameColor(await decodedPixel(24 + 100, 24 + 100), [255, 210, 0], "top-left quadrant of the photo"); sameColor(await decodedPixel(24 + 1100, 24 + 700), [0, 80, 200], "bottom-right quadrant");
  sameColor(await decodedPixel(624, 424), [229, 72, 77], "ink is drawn over the photo"); sameColor(await decodedPixel(5, 5), [20, 20, 20], "padding around the photo");
  // Clear keeps the background; Remove background takes it away.
  await tool("Clear"); assert.match(await run(() => document.querySelector(".sketchpad-popover").textContent), /The background image stays\./);
  await item("Clear ink"); await settled(); assert.ok(await page.$(".sketchpad-background"));
  await tool("Background"); await item("Remove background"); await settled(); assert.equal(await page.$(".sketchpad-background"), null);
  // A tutor figure from the session becomes a white-backed background.
  await tool("Background"); await run(() => document.querySelector('.sketchpad-thumb[aria-label="Tutor figure 1"]').click());
  await page.waitForSelector(".sketchpad-background"); await settled();
  assert.deepEqual(await run(() => { const canvas = document.querySelector(".sketchpad-background"); return [canvas.width, canvas.height, canvas.style.width, canvas.style.height]; }), [1200, 600, "600px", "300px"]);
  assert.deepEqual(await run(() => { const context = document.querySelector(".sketchpad-background").getContext("2d");
    return [[...context.getImageData(300, 300, 1, 1).data.slice(0, 3)], [...context.getImageData(900, 300, 1, 1).data.slice(0, 3)]]; }), [[192, 0, 0], [255, 255, 255]]);
  await tool("Background"); await run(() => document.querySelector('.sketchpad-thumb[aria-label="Your image 1"]').click());
  await page.waitForFunction(() => document.querySelector(".sketchpad-background")?.width === 320); await settled();
  // The background survives closing and reopening with the sheet.
  await page.keyboard.press("Escape"); await open();
  assert.equal(await run(() => document.querySelector(".sketchpad-background")?.width), 320);
  // A file that is not an image is reported and changes nothing.
  const broken = path.join(evidence, "broken.png"); fs.writeFileSync(broken, "not an image");
  await tool("Background"); const [again] = await Promise.all([page.waitForFileChooser(), item("Choose photo or file")]); await again.accept([broken]);
  await page.waitForFunction(() => document.querySelector(".sketchpad-toast")?.getAttribute("role") === "alert");
  assert.equal(await run(() => document.querySelector(".sketchpad-toast").textContent), "This file could not be read as an image.");
  assert.equal(await run(() => document.querySelector(".sketchpad-background")?.width), 320);
  await tool("Background"); await item("Remove background"); await settled();
  await group("Background: photo picker, 2400 px downscale, ink over the image in the export, session images and tutor figures");

  // ── Convert to LaTeX ───────────────────────────────────────────────────────
  assert.equal(await isDisabled("Convert to LaTeX"), true);
  await tool("Default ink"); await pen(line([200, 200], [400, 260])); await settled();
  await run(() => { window.fixture.holdTranscribe = true; });
  await tool("Convert to LaTeX");
  await page.waitForFunction(() => !document.querySelector(".sketchpad-latex").hidden);
  assert.equal(await run(() => document.querySelector(".sketchpad-latex-status").textContent), "Reading your sketch…");
  assert.equal(await run(() => document.querySelector(".sketchpad-latex-text").disabled), true);
  await page.waitForFunction(() => window.fixture.releaseTranscribe);
  const request = (await run(() => window.fixture.calls)).findLast(entry => entry.name === "transcribe");
  assert.equal(request.value.mimeType, "image/png"); assert.match(request.value.requestId, /^[A-Za-z0-9_-]{1,64}$/);
  const transcribed = await decode(await run(() => window.fixture.lastTranscribeImage));
  assert.ok(Math.max(...transcribed) <= 1568 && transcribed[0] > 200, `the model gets the cropped sketch (${transcribed})`);
  await run(() => { window.fixture.holdTranscribe = false; window.fixture.releaseTranscribe(); });
  await page.waitForFunction(() => !document.querySelector(".sketchpad-latex-text").disabled);
  assert.equal(await run(() => document.querySelector(".sketchpad-latex-text").value), await run(() => window.fixture.transcription));
  assert.equal(await run(() => document.querySelector(".sketchpad-latex-status").textContent), "Read by Fixture Vision. Check the text and fix anything that was misread.");
  assert.equal(await run(() => document.querySelector(".sketchpad-latex-preview").textContent), await run(() => window.fixture.transcription), "the host Markdown preview shows the text");
  assert.match(await run(() => document.querySelector(".sketchpad-latex-note").textContent), /cannot type into the message box/);
  // The learner fixes the text, then copies it.
  await page.click(".sketchpad-latex-text"); await page.keyboard.down("Control"); await page.keyboard.press("End"); await page.keyboard.up("Control");
  await page.keyboard.type(" (geprüft)");
  await page.waitForFunction(() => document.querySelector(".sketchpad-latex-preview").textContent.endsWith("(geprüft)"));
  await shot("latex-panel");
  await item("Copy text");
  await page.waitForFunction(() => document.querySelector(".sketchpad-latex-status").textContent.startsWith("Copied."));
  assert.equal(await run(() => navigator.clipboard.readText()), `${await run(() => window.fixture.transcription)} (geprüft)`);
  assert.match(await run(() => document.querySelector(".sketchpad-latex-status").textContent), /Your sketch is still attached to your next message/);
  assert.equal(await call("pending"), true, "sending the image remains the default");
  // Typing in the text box never draws, and drawing still works while the panel is open.
  const withPanel = (await stats()).count; await pen(line([100, 400], [200, 400])); await settled(); assert.ok((await stats()).count > withPanel);
  // A failure is shown where the learner is looking, and the sketch is kept.
  await run(() => { window.fixture.failTranscribe = "No Vision model is set. Choose one in Settings → Agent, then try again."; });
  await item("Convert again");
  await page.waitForFunction(() => document.querySelector(".sketchpad-latex-status").getAttribute("role") === "alert");
  assert.equal(await run(() => document.querySelector(".sketchpad-latex-status").textContent), "Could not convert the sketch. No Vision model is set. Choose one in Settings → Agent, then try again.");
  assert.equal(await call("pending"), true);
  await run(() => { window.fixture.failTranscribe = ""; });
  await item("Close"); assert.equal(await run(() => document.querySelector(".sketchpad-latex").hidden), true);
  assert.ok((await run(() => window.fixture.calls)).some(entry => entry.name === "cancel-transcribe") === false, "nothing was running, so nothing is cancelled");
  await run(() => { window.fixture.holdTranscribe = true; window.fixture.releaseTranscribe = undefined; });
  await tool("Convert to LaTeX"); await page.waitForFunction(() => window.fixture.releaseTranscribe); await item("Close");
  assert.equal((await run(() => window.fixture.calls)).at(-1).name, "cancel-transcribe", "closing a running conversion cancels it");
  await run(() => { window.fixture.holdTranscribe = false; window.fixture.releaseTranscribe(); }); await frames();
  assert.equal(await run(() => document.querySelector(".sketchpad-latex").hidden), true, "a cancelled answer does not reopen the panel");
  await group("Convert to LaTeX: capped image to the model, editable text with preview, copy to clipboard, errors and cancellation");

  // ── Full screen ────────────────────────────────────────────────────────────
  const windowed = await run(() => { const rect = document.querySelector(".sketchpad-root").getBoundingClientRect(); return [rect.left, rect.top, rect.width, rect.height]; });
  assert.deepEqual(windowed, [220, 48, 1060, 852]);
  const inkBefore = await stats();
  await tool("Full screen"); await settled();
  assert.deepEqual(await run(() => { const rect = document.querySelector(".sketchpad-root").getBoundingClientRect(); return [rect.left, rect.top, rect.width, rect.height]; }), [0, 0, 1280, 900]);
  for (const [x, y] of [[10, 10], [110, 400], [700, 20], [1270, 890], [1262, 22]])
    assert.ok(await run((x, y) => !!document.elementFromPoint(x, y)?.closest(".sketchpad-root"), x, y), `the sheet covers the window at ${x}, ${y}`);
  assert.deepEqual(await pressed("Sheet"), ["Exit full screen"]); await shot("full-screen");
  near((await stats()).count, inkBefore.count, 2, "the sketch is unchanged in full screen");
  const fullArea = await box(); assert.ok(fullArea.width === 1280 && fullArea.height > 800);
  await pen(line([30, 30], [130, 30])); await settled(); assert.ok((await stats()).count > inkBefore.count, "drawing works where the sidebar was");
  await page.keyboard.press("Escape"); await open();
  assert.deepEqual(await pressed("Sheet"), ["Exit full screen"], "full screen is remembered for the window");
  await tool("Exit full screen"); await settled();
  assert.deepEqual(await run(() => { const rect = document.querySelector(".sketchpad-root").getBoundingClientRect(); return [rect.left, rect.top, rect.width, rect.height]; }), windowed);
  await group("Full screen covers the whole window and back");

  // ── Settings and disposal ──────────────────────────────────────────────────
  assert.deepEqual(await call("settings"), [{ key: "penWidth", type: "dropdown", label: "Default pen width", value: "medium" }, { key: "imageScale", type: "number", label: "Image scale", value: 50 }]);
  assert.equal(await call("setSetting", "penWidth", "bold"), null);
  await page.keyboard.press("Escape"); await call("navigate", "teach-2", "teaching"); await open();
  assert.deepEqual(await pressed("Width"), ["Bold"], "a new sheet starts with the default pen width");
  await pen(line([100, 100], [300, 100])); // leave a stroke under way when the plugin is disabled
  await call("dispose");
  assert.equal(await page.$(".sketchpad-root"), null); assert.equal(await label(), "Disabled");
  await group("settings apply to new sheets; disabling removes the surface and registrations");
  }
  assert.deepEqual(denied, [], "no request left the fixture origin");
  assert.deepEqual(errors, [], "no page errors");
  if (page) assert.deepEqual(await page.evaluate(() => window.fixture.errors), []);
  console.log(`${groups.length} groups passed${process.argv.includes("--built") ? " (built)" : ""}`);
} catch (error) {
  console.error(error);
  if (errors.length) console.error("Page errors:", errors);
  try { if (page) { const shot = path.join(evidence, "failure.png"); await page.screenshot({ path: shot }); console.error(`Screenshot: ${shot}`); } } catch { /* page gone */ }
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  if (!process.exitCode) fs.rmSync(evidence, { recursive: true, force: true });
}
