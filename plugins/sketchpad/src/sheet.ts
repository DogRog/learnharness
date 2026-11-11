import type { PluginFrontendContext, PluginMarkdownProps, PluginWidgetHandle } from "learnharness-plugin-api";
import { abortable } from "./abort.ts";
import { loadBackground, sessionImageBlob } from "./background.ts";
import { exportSheet } from "./export.ts";
import { HOME_VIEW, contentBounds, fitView, panBy, pinchView, relativeTransform, sameView, toWorld, wheelPan, wheelZoomFactor, zoomAt,
  type Offset, type View } from "./geometry.ts";
import { CLEAR, ERASER, EXPAND, FIT, HIGHLIGHTER, IMAGE, LATEX, PEN, REDO, SHRINK, UNDO } from "./icons.ts";
import type { SessionImage } from "./images.ts";
import { PEN_WIDTH_LABELS, PEN_WIDTHS } from "./settings.ts";
import type { Draft, SessionSheet, Sheets } from "./state.ts";
import { COLOR_KEYS, ERASER_RADIUS, paintHighlighter, paintInk, paintPen, sizeFor, visibleStrokes,
  type InkStroke, type Point, type SizeIndex, type Stroke, type Tool } from "./strokes.ts";
import { COLOR_LABELS, appMode, inkColors } from "./theme.ts";

export interface MountedSheet {
  /** Commit a stroke that is still under the pen. */
  flush(): void;
  dispose(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): void;
  redo(): void;
}
export interface SheetOptions {
  ctx: PluginFrontendContext;
  sheets: Sheets;
  state: SessionSheet;
  /** Images found in the session's messages when Sketch was opened. */
  images: readonly SessionImage[];
  signal: AbortSignal;
}

/** A full repaint slower than this is not repeated on every frame of a pan or
 * zoom; the painted canvas is moved with CSS instead and repainted once the
 * camera rests. */
const FRAME_BUDGET_MS = 6;
const SETTLE_MS = 90;
/** Touches that land this soon after the pen was used are a resting hand, not a gesture. */
const PEN_COOLDOWN_MS = 500;
/** Contact wider than this (CSS px) is a palm, not a fingertip. */
const PALM_SIZE = 64;
/** Longest side of the image sent for Convert to LaTeX. */
const LATEX_IMAGE_CAP = 1568;
const TOOL_LABELS: Readonly<Record<Tool, string>> = { pen: "Pen", highlighter: "Highlighter", eraser: "Eraser" };
const NO_INSERT_NOTE = "LearnHarness plugins cannot type into the message box. Copy puts the text on the clipboard so you can paste it there.";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const describe = (error: unknown) => error instanceof Error && error.message ? error.message : "Something went wrong.";

export function mountSheet(container: HTMLElement, { ctx, sheets, state, images, signal }: SheetOptions): MountedSheet {
  // ── Structure ────────────────────────────────────────────────────────────
  const root = element("div", "sketchpad-root");
  const toolbar = element("div", "sketchpad-toolbar"); toolbar.setAttribute("role", "toolbar");
  const body = element("div", "sketchpad-body");
  const viewport = element("div", "sketchpad-viewport");
  viewport.tabIndex = -1; viewport.dataset.pluginInitialFocus = "";
  viewport.setAttribute("role", "group"); viewport.setAttribute("aria-label", "Sketch sheet");
  const ink = element("canvas", "sketchpad-ink"); ink.setAttribute("aria-hidden", "true");
  const live = element("canvas", "sketchpad-live"); live.setAttribute("role", "img");
  live.setAttribute("aria-label", "Sketch sheet. Draw with Apple Pencil or a mouse. One finger moves the sheet, two fingers zoom.");
  const zoomLabel = element("div", "sketchpad-zoom"); zoomLabel.setAttribute("aria-hidden", "true");
  const toastBox = element("div", "sketchpad-toast"); toastBox.hidden = true;
  const popover = element("div", "sketchpad-popover"); popover.hidden = true;
  const fileInput = element("input", "sketchpad-file"); fileInput.type = "file"; fileInput.accept = "image/*";
  fileInput.tabIndex = -1; fileInput.setAttribute("aria-hidden", "true");
  const latex = element("div", "sketchpad-latex"); latex.hidden = true;
  latex.setAttribute("role", "group"); latex.setAttribute("aria-label", "Convert to LaTeX");
  viewport.append(ink, live, zoomLabel, toastBox);
  body.append(viewport, latex);
  root.append(toolbar, body, popover, fileInput);
  container.append(root);

  // ── Local state ──────────────────────────────────────────────────────────
  let disposed = false, frameId = 0, settleTimer = 0, toastTimer = 0;
  let inkDirty = true, chromeDirty = true, skipInkDirty = false;
  let seenDraft: Draft | undefined = state.draft;
  let renderedView: View | undefined, renderedStrokes: readonly Stroke[] | undefined, lastFullMs = 0;
  let cssWidth = 0, cssHeight = 0, ratio = 1;
  let active: Stroke | undefined, activePointer: number | undefined, livePainted = 0, liveView: View | undefined, liveShown = false;
  let rect: DOMRect | undefined, lastPenTime = -Infinity;
  const touches = new Map<number, Offset>(), ignoredTouches = new Set<number>();
  let gesture: { type: "pan"; start: View; id: number; origin: Offset } |
    { type: "pinch"; start: View; a: number; b: number; a0: Offset; b0: Offset } | undefined;
  let mousePan: { id: number; start: View; origin: Offset } | undefined;
  let trackpadZoom: View | undefined;
  let backgroundElement: HTMLCanvasElement | undefined;
  let popoverAnchor: HTMLElement | undefined, popoverCleanup: (() => void) | undefined;
  let loadTicket = 0, latexTicket = 0, latexRequest: string | undefined, previewTimer = 0;
  let preview: PluginWidgetHandle<PluginMarkdownProps> | undefined;

  const view = (): View => state.view ?? (state.view = { ...HOME_VIEW });
  const setView = (next: View) => sheets.setView(state, next);
  const schedule = () => { if (!disposed && !frameId) frameId = requestAnimationFrame(frame); };
  const toast = (message: string, alert = false) => {
    window.clearTimeout(toastTimer);
    toastBox.textContent = message; toastBox.hidden = false;
    toastBox.setAttribute("role", alert ? "alert" : "status");
    toastTimer = window.setTimeout(() => { toastBox.hidden = true; }, alert ? 6000 : 3500);
  };

  // ── Toolbar ──────────────────────────────────────────────────────────────
  const group = (label: string) => {
    const node = element("div", "sketchpad-group"); node.setAttribute("role", "group"); node.setAttribute("aria-label", label);
    toolbar.append(node); return node;
  };
  const guard = (run: () => void) => () => { try { run(); } catch (error) { toast(describe(error), true); } };
  /** `markup` is this plugin's own constant SVG/HTML, never learner or model text. */
  const button = (parent: HTMLElement, label: string, markup: string, onClick: () => void, className = "") => {
    const node = element("button", `sketchpad-button ${className}`.trim()); node.type = "button";
    node.setAttribute("aria-label", label); node.title = label; node.innerHTML = markup;
    node.addEventListener("click", guard(onClick), { signal });
    parent.append(node); return node;
  };
  const tools = group("Tool");
  const toolButtons: Record<Tool, HTMLButtonElement> = {
    pen: button(tools, "Pen", PEN, () => sheets.setTool(state, "pen")),
    highlighter: button(tools, "Highlighter", HIGHLIGHTER, () => sheets.setTool(state, "highlighter")),
    eraser: button(tools, "Eraser", ERASER, () => sheets.setTool(state, "eraser")),
  };
  const colors = group("Color");
  const colorButtons = COLOR_KEYS.map(key => button(colors, COLOR_LABELS[key], '<span class="sketchpad-swatch"></span>',
    () => sheets.setColor(state, key)));
  const widths = group("Width");
  const widthButtons = PEN_WIDTHS.map((key, index) => button(widths, PEN_WIDTH_LABELS[key],
    `<span class="sketchpad-dot" style="width:${5 + index * 6}px;height:${5 + index * 6}px"></span>`,
    () => sheets.setSize(state, index as SizeIndex)));
  const history = group("History");
  const undoButton = button(history, "Undo", UNDO, () => undo());
  const redoButton = button(history, "Redo", REDO, () => redo());
  const clearButton = button(history, "Clear", CLEAR, () => togglePopover(clearButton, clearConfirm));
  const sheetGroup = group("Sheet");
  const backgroundButton = button(sheetGroup, "Background", IMAGE, () => togglePopover(backgroundButton, backgroundMenu));
  button(sheetGroup, "Zoom to fit", FIT, () => zoomToFit());
  const latexButton = button(sheetGroup, "Convert to LaTeX", LATEX, () => { void convert(); });
  const fullscreenButton = button(sheetGroup, "Full screen", EXPAND, () => sheets.setFullscreen(!sheets.fullscreen));
  for (const node of [clearButton, backgroundButton]) node.setAttribute("aria-haspopup", "dialog");

  const idle = () => activePointer === undefined;
  const canUndo = () => !disposed && idle() && sheets.canUndo(state);
  const canRedo = () => !disposed && idle() && sheets.canRedo(state);
  const undo = () => { if (canUndo()) sheets.undo(state); };
  const redo = () => { if (canRedo()) sheets.redo(state); };
  const viewportSize = () => ({ width: viewport.clientWidth, height: viewport.clientHeight });
  const zoomToFit = () => setView(fitView(contentBounds(state.draft.background, visibleStrokes(state.draft.strokes)), viewportSize()));

  function renderChrome(): void {
    const draft = state.draft, palette = inkColors(appMode());
    const inkTool = state.tool === "eraser" ? undefined : state.tool;
    root.dataset.fullscreen = String(sheets.fullscreen);
    toolbar.setAttribute("aria-label", `Sketch tools. ${TOOL_LABELS[state.tool]} selected.`);
    for (const tool of Object.keys(toolButtons) as Tool[]) toolButtons[tool].setAttribute("aria-pressed", String(state.tool === tool));
    COLOR_KEYS.forEach((key, index) => {
      const node = colorButtons[index]!;
      node.setAttribute("aria-pressed", String(!!inkTool && state.colors[inkTool] === key));
      (node.firstElementChild as HTMLElement).style.background = palette[key];
    });
    widthButtons.forEach((node, index) => node.setAttribute("aria-pressed", String(!!inkTool && state.sizes[inkTool] === index)));
    undoButton.disabled = !canUndo(); redoButton.disabled = !canRedo();
    clearButton.disabled = !draft.strokes.length && !draft.redo.length;
    latexButton.disabled = !draft.hasInk;
    const full = sheets.fullscreen ? "Exit full screen" : "Full screen";
    if (fullscreenButton.title !== full) {
      fullscreenButton.title = full; fullscreenButton.setAttribute("aria-label", full);
      fullscreenButton.innerHTML = sheets.fullscreen ? SHRINK : EXPAND;
    }
    fullscreenButton.setAttribute("aria-pressed", String(sheets.fullscreen));
    backgroundButton.setAttribute("aria-pressed", String(!!draft.background));
    live.style.cursor = mousePan ? "grabbing" : "crosshair";
  }

  // ── Painting ─────────────────────────────────────────────────────────────
  const transform = (context: CanvasRenderingContext2D, camera: View) =>
    context.setTransform(camera.zoom * ratio, 0, 0, camera.zoom * ratio, camera.x * ratio, camera.y * ratio);
  function sizeCanvases(): boolean {
    const width = viewport.clientWidth, height = viewport.clientHeight;
    if (!width || !height) return false;
    const nextRatio = Math.min(window.devicePixelRatio || 1, 2);
    if (width !== cssWidth || height !== cssHeight || nextRatio !== ratio) {
      cssWidth = width; cssHeight = height; ratio = nextRatio; rect = undefined;
      for (const canvas of [ink, live]) {
        canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
      }
      inkDirty = true; liveView = undefined;
    }
    return true;
  }
  function paintCommitted(camera: View): void {
    const context = ink.getContext("2d");
    if (!context) throw new Error("Drawing is unavailable in this browser.");
    const started = performance.now();
    const strokes = active?.tool === "eraser" ? [...state.draft.strokes, active] : state.draft.strokes;
    context.resetTransform(); context.clearRect(0, 0, ink.width, ink.height);
    transform(context, camera);
    paintInk(context, visibleStrokes(strokes), inkColors(appMode()));
    ink.style.transform = "";
    renderedView = { ...camera }; renderedStrokes = state.draft.strokes; lastFullMs = performance.now() - started;
  }
  function paintLive(camera: View): void {
    const context = live.getContext("2d");
    if (!context) return;
    if (!active || active.tool === "eraser") {
      if (liveShown) { context.resetTransform(); context.clearRect(0, 0, live.width, live.height); liveShown = false; }
      livePainted = 0; liveView = undefined; return;
    }
    const color = inkColors(appMode())[active.color];
    const incremental = active.tool === "pen" && liveShown && !!liveView && sameView(liveView, camera) && livePainted > 0;
    if (!incremental) { context.resetTransform(); context.clearRect(0, 0, live.width, live.height); }
    transform(context, camera);
    if (active.tool === "pen") paintPen(context, active, color, incremental ? livePainted : 0);
    else paintHighlighter(context, active, color);
    livePainted = active.points.length; liveView = { ...camera }; liveShown = true;
  }
  function syncBackground(camera: View): void {
    const background = state.draft.background, next = background?.source as HTMLCanvasElement | undefined;
    if (backgroundElement !== next) {
      backgroundElement?.remove(); backgroundElement = next;
      if (next && background) {
        next.className = "sketchpad-background"; next.setAttribute("aria-hidden", "true");
        next.style.width = `${background.width}px`; next.style.height = `${background.height}px`;
        viewport.prepend(next);
      }
    }
    if (backgroundElement) backgroundElement.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`;
  }
  function frame(): void {
    frameId = 0;
    if (disposed) return;
    if (chromeDirty) { chromeDirty = false; renderChrome(); }
    if (!sizeCanvases()) return;
    const camera = view();
    syncBackground(camera);
    const moved = !renderedView || !sameView(renderedView, camera);
    if (inkDirty || moved) {
      if (!inkDirty && renderedView && lastFullMs > FRAME_BUDGET_MS) {
        const relative = relativeTransform(renderedView, camera);
        ink.style.transform = `translate(${relative.x}px, ${relative.y}px) scale(${relative.scale})`;
        window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(() => { inkDirty = true; schedule(); }, SETTLE_MS);
      } else { window.clearTimeout(settleTimer); inkDirty = false; paintCommitted(camera); }
    }
    paintLive(camera);
    const percent = `${Math.round(camera.zoom * 100)}%`;
    if (zoomLabel.textContent !== percent) zoomLabel.textContent = percent;
  }

  // ── Pen and mouse ────────────────────────────────────────────────────────
  /** Viewport coordinates. The box is measured once per stroke, not per sample. */
  const local = (event: { clientX: number; clientY: number }): Offset => {
    const box = activePointer !== undefined && rect ? rect : (rect = viewport.getBoundingClientRect());
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const point = (event: PointerEvent): Point => {
    const position = local(event), world = toWorld(view(), position.x, position.y);
    return { x: world.x, y: world.y, pressure: event.pointerType === "pen" && event.pressure > 0 ? event.pressure : 0.5 };
  };
  /** A stylus eraser end, or a held barrel button, erases without switching the selected tool. */
  const toolFor = (event: PointerEvent): Tool =>
    (event.buttons & 32) !== 0 || (event.pointerType === "pen" && (event.buttons & 2) !== 0) ? "eraser" : state.tool;
  const capture = (id: number) => { try { live.setPointerCapture(id); } catch { /* synthetic or already released pointer */ } };
  const release = (id: number) => { try { if (live.hasPointerCapture(id)) live.releasePointerCapture(id); } catch { /* already released */ } };
  function begin(event: PointerEvent): void {
    const tool = toolFor(event);
    active = tool === "eraser" ? { tool, size: ERASER_RADIUS / view().zoom, points: [point(event)] }
      : { tool, color: state.colors[tool], size: sizeFor(tool, state.sizes[tool]), points: [point(event)] };
    livePainted = 0; liveView = undefined;
    if (tool === "eraser") inkDirty = true;
    schedule();
  }
  function commit(): void {
    const stroke = active;
    active = undefined;
    if (!stroke) return;
    // A pen stroke always lands on top of everything already painted, so it can be
    // added to the committed canvas without repainting the whole sheet.
    const camera = view(), context = ink.getContext("2d");
    const direct = stroke.tool === "pen" && !inkDirty && !!context && !!renderedView && sameView(renderedView, camera) &&
      renderedStrokes === state.draft.strokes && !ink.style.transform;
    skipInkDirty = direct;
    try { sheets.addStroke(state, stroke); } finally { skipInkDirty = false; }
    if (direct && context && stroke.tool === "pen") {
      transform(context, camera); paintPen(context, stroke, inkColors(appMode())[stroke.color]);
      renderedStrokes = state.draft.strokes;
    } else inkDirty = true;
    schedule();
  }
  function restartGesture(): void {
    const entries = [...touches.entries()], camera = view();
    if (entries.length === 1) gesture = { type: "pan", start: { ...camera }, id: entries[0]![0], origin: entries[0]![1] };
    else if (entries.length === 2) gesture = { type: "pinch", start: { ...camera }, a: entries[0]![0], b: entries[1]![0], a0: entries[0]![1], b0: entries[1]![1] };
    else gesture = undefined;
  }
  function down(event: PointerEvent): void {
    if (event.pointerType === "touch") {
      // Fingers never draw. A hand resting while the pen writes never moves the sheet either.
      if (active || activePointer !== undefined || performance.now() - lastPenTime < PEN_COOLDOWN_MS ||
        Math.max(event.width, event.height) > PALM_SIZE || touches.size >= 2) { ignoredTouches.add(event.pointerId); return; }
      event.preventDefault(); closePopover(); capture(event.pointerId);
      touches.set(event.pointerId, local(event)); restartGesture();
      return;
    }
    if (activePointer !== undefined || mousePan) return;
    const pen = event.pointerType === "pen";
    if (!pen && (event.button === 1 || event.button === 2)) {
      event.preventDefault(); closePopover(); capture(event.pointerId);
      mousePan = { id: event.pointerId, start: { ...view() }, origin: local(event) }; chromeDirty = true; schedule();
      return;
    }
    if (!pen && event.button !== 0) return;
    event.preventDefault(); closePopover(); viewport.focus({ preventScroll: true });
    // The pen wins over any fingers already down.
    for (const id of touches.keys()) { ignoredTouches.add(id); release(id); }
    touches.clear(); gesture = undefined;
    activePointer = event.pointerId; capture(event.pointerId); rect = undefined;
    if (pen) lastPenTime = performance.now();
    if (!pen || event.pressure > 0) begin(event);
    chromeDirty = true; schedule();
  }
  function move(event: PointerEvent): void {
    if (event.pointerType === "touch") {
      if (!touches.has(event.pointerId)) return;
      touches.set(event.pointerId, local(event));
      if (gesture?.type === "pan") {
        const now = touches.get(gesture.id)!;
        setView(panBy(gesture.start, now.x - gesture.origin.x, now.y - gesture.origin.y));
      } else if (gesture?.type === "pinch") setView(pinchView(gesture.start, gesture.a0, gesture.b0, touches.get(gesture.a)!, touches.get(gesture.b)!));
      return;
    }
    if (mousePan?.id === event.pointerId) {
      // Releasing the button while another is held arrives as a move, not an up.
      if ((event.buttons & 6) === 0) { finish(event); return; }
      const now = local(event);
      setView(panBy(mousePan.start, now.x - mousePan.origin.x, now.y - mousePan.origin.y));
      return;
    }
    if (activePointer !== event.pointerId) return;
    if (event.pointerType === "pen") lastPenTime = performance.now();
    const coalesced = event.getCoalescedEvents?.() ?? [];
    for (const sample of coalesced.length ? coalesced : [event]) {
      if (sample.pointerType === "pen" && sample.pressure <= 0) { commit(); continue; }
      if (active && active.tool !== toolFor(sample)) commit();
      if (!active) { begin(sample); continue; }
      const next = point(sample), last = active.points.at(-1)!;
      if (next.x !== last.x || next.y !== last.y) active.points.push(next);
    }
    if (active?.tool === "eraser") inkDirty = true;
    schedule();
  }
  function finish(event: PointerEvent): void {
    if (event.pointerType === "touch") {
      ignoredTouches.delete(event.pointerId);
      if (touches.delete(event.pointerId)) { release(event.pointerId); restartGesture(); }
      return;
    }
    if (mousePan?.id === event.pointerId) {
      mousePan = undefined; release(event.pointerId); chromeDirty = true; schedule();
      return;
    }
    if (activePointer !== event.pointerId) return;
    if (event.pointerType === "pen") lastPenTime = performance.now();
    if (active && event.type === "pointerup" && event.pointerType !== "pen") {
      const next = point(event), last = active.points.at(-1)!;
      if (next.x !== last.x || next.y !== last.y) active.points.push(next);
    }
    activePointer = undefined; commit(); release(event.pointerId);
    chromeDirty = true; schedule();
  }
  const flush = () => { if (active) commit(); };
  live.addEventListener("pointerdown", down, { signal });
  live.addEventListener("pointermove", move, { signal });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const) live.addEventListener(name, finish, { signal });
  for (const name of ["contextmenu", "dragstart", "selectstart"] as const) viewport.addEventListener(name, event => event.preventDefault(), { signal });
  viewport.addEventListener("wheel", event => {
    event.preventDefault();
    const at = local(event);
    if (event.ctrlKey || event.metaKey) setView(zoomAt(view(), at.x, at.y, wheelZoomFactor(event.deltaY, event.deltaMode)));
    else { const pan = wheelPan(event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX, event.shiftKey && !event.deltaX ? 0 : event.deltaY, event.deltaMode); setView(panBy(view(), pan.x, pan.y)); }
  }, { signal, passive: false });
  // Safari reports a trackpad pinch as gesture events, not as ctrl+wheel.
  // Finger pinches are already handled as pointers above.
  type Pinch = Event & { scale: number; clientX: number; clientY: number };
  viewport.addEventListener("gesturestart", event => { event.preventDefault(); trackpadZoom = touches.size ? undefined : { ...view() }; }, { signal });
  viewport.addEventListener("gesturechange", event => {
    event.preventDefault();
    const pinch = event as Pinch;
    if (!trackpadZoom || touches.size || !(pinch.scale > 0)) return;
    const at = local(pinch);
    setView(zoomAt(trackpadZoom, at.x, at.y, pinch.scale));
  }, { signal });
  viewport.addEventListener("gestureend", event => { event.preventDefault(); trackpadZoom = undefined; }, { signal });

  // ── Popovers: Clear confirmation and Background ──────────────────────────
  function closePopover(): void {
    if (popover.hidden) return;
    popover.hidden = true; popover.replaceChildren();
    popoverAnchor?.setAttribute("aria-expanded", "false"); popoverAnchor = undefined;
    popoverCleanup?.(); popoverCleanup = undefined;
  }
  function togglePopover(anchor: HTMLElement, build: (panel: HTMLElement) => void | (() => void)): void {
    const reopen = popoverAnchor !== anchor;
    closePopover();
    if (!reopen) return;
    popoverAnchor = anchor; anchor.setAttribute("aria-expanded", "true");
    popoverCleanup = build(popover) ?? undefined;
    popover.hidden = false;
    const rootBox = root.getBoundingClientRect(), anchorBox = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchorBox.left - rootBox.left, rootBox.width - popover.offsetWidth - 8));
    popover.style.left = `${left}px`; popover.style.top = `${anchorBox.bottom - rootBox.top + 6}px`;
    popover.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }
  const panelButton = (parent: HTMLElement, label: string, onClick: () => void, className = "") => {
    const node = element("button", `sketchpad-item ${className}`.trim(), label); node.type = "button";
    node.addEventListener("click", guard(onClick), { signal });
    parent.append(node); return node;
  };
  function clearConfirm(panel: HTMLElement): void {
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Clear ink");
    panel.append(element("p", "sketchpad-popover-text", state.draft.background
      ? "Clear all ink on this sheet? This cannot be undone. The background image stays."
      : "Clear all ink on this sheet? This cannot be undone."));
    const row = element("div", "sketchpad-row"); panel.append(row);
    panelButton(row, "Clear ink", () => { closePopover(); flush(); sheets.clear(state); viewport.focus({ preventScroll: true }); }, "sketchpad-danger");
    panelButton(row, "Cancel", () => { closePopover(); clearButton.focus({ preventScroll: true }); });
  }
  async function useBackground(blob: Blob, label: string, vector = false): Promise<void> {
    const ticket = ++loadTicket;
    toast("Loading image…");
    try {
      const loaded = await loadBackground(blob, label, signal, vector);
      if (disposed || ticket !== loadTicket) return;
      sheets.setBackground(state, loaded);
      zoomToFit();
      toast("Background set. Draw on top of it.");
    } catch (error) { if (!disposed && !signal.aborted && ticket === loadTicket) toast(describe(error), true); }
  }
  function backgroundMenu(panel: HTMLElement): () => void {
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Background");
    const urls: string[] = [];
    panelButton(panel, "Choose photo or file", () => { closePopover(); fileInput.click(); });
    if (images.length) {
      panel.append(element("div", "sketchpad-popover-heading", "From this session"));
      const grid = element("div", "sketchpad-thumbs"); panel.append(grid);
      for (const image of images) {
        let source: { blob: Blob; vector: boolean };
        try { source = sessionImageBlob(image); } catch { continue; }
        const url = URL.createObjectURL(source.blob); urls.push(url);
        const node = element("button", "sketchpad-thumb"); node.type = "button";
        node.setAttribute("aria-label", image.label); node.title = image.label;
        const picture = element("img", ""); picture.alt = ""; picture.draggable = false; picture.src = url;
        node.append(picture);
        node.addEventListener("click", guard(() => { closePopover(); void useBackground(source.blob, image.label, source.vector); }), { signal });
        grid.append(node);
      }
    }
    if (state.draft.background) panelButton(panel, "Remove background", () => { closePopover(); loadTicket++; sheets.setBackground(state, undefined); });
    return () => { for (const url of urls) URL.revokeObjectURL(url); };
  }
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (file) void useBackground(file, file.name || "Image", file.type === "image/svg+xml");
  }, { signal });
  root.addEventListener("pointerdown", event => {
    const target = event.target as Node | null;
    if (!popover.hidden && target && !popover.contains(target) && !popoverAnchor?.contains(target)) closePopover();
  }, { signal, capture: true });

  // ── Convert to LaTeX ─────────────────────────────────────────────────────
  latex.append(element("div", "sketchpad-latex-title", "Convert to LaTeX"));
  const latexStatus = element("div", "sketchpad-latex-status"); latexStatus.setAttribute("role", "status");
  const latexText = element("textarea", "sketchpad-latex-text");
  latexText.setAttribute("aria-label", "Transcription. Check it and fix anything that was misread.");
  latexText.spellcheck = false; latexText.autocapitalize = "off"; latexText.rows = 6;
  const previewBox = element("div", "sketchpad-latex-preview"); previewBox.setAttribute("aria-label", "Preview");
  const latexActions = element("div", "sketchpad-row");
  latex.append(latexStatus, latexText, element("div", "sketchpad-popover-heading", "Preview"), previewBox, latexActions,
    element("p", "sketchpad-latex-note", NO_INSERT_NOTE));
  const copyButton = panelButton(latexActions, "Copy text", () => { void copy(); }, "sketchpad-primary");
  const againButton = panelButton(latexActions, "Convert again", () => { void convert(); });
  panelButton(latexActions, "Close", () => closeLatex());
  const setLatexStatus = (message: string, alert = false) => {
    latexStatus.textContent = message; latexStatus.setAttribute("role", alert ? "alert" : "status");
    latexStatus.dataset.alert = String(alert);
  };
  const updatePreview = () => {
    const text = latexText.value;
    if (preview) preview.update({ text }); else preview = ctx.ui.mountMarkdown(previewBox, { text }, { signal });
  };
  latexText.addEventListener("input", () => {
    copyButton.disabled = !latexText.value.trim();
    window.clearTimeout(previewTimer); previewTimer = window.setTimeout(() => { if (!disposed) updatePreview(); }, 150);
  }, { signal });
  function cancelConversion(): void {
    latexTicket++;
    const id = latexRequest; latexRequest = undefined;
    if (id) void ctx.call("cancel-transcribe", { requestId: id }).catch(() => {});
  }
  function closeLatex(): void {
    cancelConversion(); latex.hidden = true; schedule();
    latexButton.focus({ preventScroll: true });
  }
  /** One learner-initiated model request. The image stays the default way to
   * send a sketch; this only produces text for the learner to check and copy. */
  async function convert(): Promise<void> {
    flush();
    if (!state.draft.hasInk) { toast("Draw something first."); return; }
    cancelConversion();
    const ticket = latexTicket, id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    latex.hidden = false; latexText.value = ""; latexText.disabled = true; copyButton.disabled = true; againButton.disabled = true;
    updatePreview(); setLatexStatus("Reading your sketch…"); schedule();
    try {
      const image = exportSheet(sheets.capture(state), signal, { cap: LATEX_IMAGE_CAP, imageScale: 100 });
      latexRequest = id;
      const result = await abortable(ctx.call<{ text?: unknown; model?: unknown; truncated?: unknown }>("transcribe", { requestId: id, image }), signal);
      if (disposed || ticket !== latexTicket) return;
      latexRequest = undefined;
      if (!result || typeof result.text !== "string" || !result.text.trim()) throw new Error("The model returned no text. Try again, or send the sketch as an image.");
      latexText.value = result.text; latexText.disabled = false; copyButton.disabled = false; updatePreview();
      setLatexStatus(`${typeof result.model === "string" && result.model ? `Read by ${result.model}. ` : ""}Check the text and fix anything that was misread.` +
        (result.truncated === true ? " The answer was cut off, so the end may be missing." : ""));
      latexText.focus({ preventScroll: true });
    } catch (error) {
      if (disposed || signal.aborted || ticket !== latexTicket) return;
      latexRequest = undefined;
      setLatexStatus(`Could not convert the sketch. ${describe(error)}`, true);
    } finally { if (!disposed && ticket === latexTicket) againButton.disabled = false; }
  }
  async function copy(): Promise<void> {
    const text = latexText.value;
    if (!text.trim()) return;
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; }
    catch {
      try { latexText.focus(); latexText.select(); copied = document.execCommand("copy"); } catch { copied = false; }
    }
    if (disposed) return;
    setLatexStatus(copied
      ? "Copied. Paste it into your message. Your sketch is still attached to your next message; clear the sheet if you only want the text."
      : "Could not copy. Select the text and copy it yourself.", !copied);
  }

  // ── Lifetime ─────────────────────────────────────────────────────────────
  const unsubscribe = sheets.onChange(() => {
    if (state.draft !== seenDraft) {
      seenDraft = state.draft;
      if (!skipInkDirty) inkDirty = true;
    }
    chromeDirty = true; schedule();
  });
  const resize = new ResizeObserver(() => { rect = undefined; schedule(); }); resize.observe(viewport);
  // The app theme can change while the sheet is open: default ink and swatches follow it.
  const theme = new MutationObserver(() => { inkDirty = true; chromeDirty = true; liveView = undefined; schedule(); });
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
  const dispose = () => {
    if (disposed) return;
    flush(); disposed = true; activePointer = undefined;
    cancelConversion(); closePopover();
    if (frameId) cancelAnimationFrame(frameId);
    for (const timer of [settleTimer, toastTimer, previewTimer]) window.clearTimeout(timer);
    unsubscribe(); resize.disconnect(); theme.disconnect(); preview?.dispose();
    backgroundElement?.remove(); backgroundElement = undefined;
    signal.removeEventListener("abort", dispose); root.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });
  renderChrome(); chromeDirty = false;
  schedule();
  return { flush, dispose, canUndo, canRedo, undo, redo };
}
