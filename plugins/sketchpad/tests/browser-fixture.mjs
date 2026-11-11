// Checkout-only browser fixture. The surface shell, settings, backend calls and
// view context are small adapters; submission preparation runs through the
// host's real PluginSubmissionRunner so ordering and output validation are real.
import { PluginSubmissionRunner } from "../../../components/plugin-submission-runner.ts";
import { activate } from "../src/main.ts";

const controller = new AbortController(), notifications = new Set(), resyncs = new Set();
const errors = [], calls = [], attempts = [], markdown = [];
let actions = new Map(), interceptor, settingsSchema, surface, off;
let currentSession = "teach", currentKind = "teaching", pathname = "/opaque/teach";
let savedSettings = { revision: 0, penWidth: "medium", imageScale: 50 };
const histories = new Map();
const palettes = {
  dark: { background: "#141414", foreground: "#e6e6e6", card: "#1c1c1c", border: "#434343", "muted-foreground": "#8d8d8d", accent: "#2a2a2a" },
  light: { background: "#eff1f5", foreground: "#4c4f69", card: "#e6e9ef", border: "#ccd0da", "muted-foreground": "#6c6f85", accent: "#dce0e8" },
};
function setTheme(mode) {
  const html = document.documentElement;
  html.classList.remove("dark", "light"); html.classList.add(mode);
  for (const [key, value] of Object.entries({ ring: "#8d8d8d", "lh-error": "#ef4444", ...palettes[mode] })) html.style.setProperty(`--${key}`, value);
}
setTheme("dark");
const clone = value => structuredClone(value);
const topButton = document.querySelector("#sketch"), mounts = document.querySelector("#mounts");
const target = Object.freeze({ fixtureSurfaceTarget: true });
function refresh() { topButton.textContent = actions.get("sketch")?.name ?? "Disabled"; }

const ctx = {
  manifest: { id: "sketchpad" }, signal: controller.signal,
  cleanup() {},
  registerAction(value) { actions.set(value.id, value); refresh(); return () => { actions.delete(value.id); refresh(); }; },
  placeAction(value) { window.fixture.placement = value; return () => {}; },
  refreshActions() { window.fixture.actionRefreshes++; refresh(); }, refreshSubmissions() { window.fixture.submissionRefreshes++; },
  registerSubmissionInterceptor(value) { interceptor = value; return () => { interceptor = undefined; }; },
  registerSettings(schema) { settingsSchema = schema; return { update(next) { settingsSchema = { ...settingsSchema, ...next }; }, dispose() { settingsSchema = undefined; } }; },
  async call(name, value) {
    calls.push({ name, value: name === "transcribe" ? { requestId: value.requestId, mimeType: value.image.mimeType, length: value.image.data.length } : clone(value ?? null) });
    if (name === "get-settings") return clone(savedSettings);
    if (name === "set-pen-width" || name === "set-image-scale") {
      savedSettings = { ...savedSettings, ...value, revision: savedSettings.revision + 1 };
      for (const fn of notifications) fn({ pluginId: "sketchpad", topic: "settings-changed", data: clone(savedSettings) });
      return clone(savedSettings);
    }
    if (name === "transcribe") {
      window.fixture.lastTranscribeImage = value.image;
      if (window.fixture.holdTranscribe) await new Promise(resolve => { window.fixture.releaseTranscribe = resolve; });
      if (window.fixture.failTranscribe) throw new Error(window.fixture.failTranscribe);
      return { text: window.fixture.transcription, model: "Fixture Vision", truncated: false };
    }
    if (name === "cancel-transcribe") return { cancelled: true };
    throw new Error(`Unexpected operation ${name}`);
  },
  onNotification(fn) { notifications.add(fn); return () => notifications.delete(fn); },
  onAppEvent() { return () => {}; },
  onResync(fn) { resyncs.add(fn); return () => resyncs.delete(fn); },
  app: { pathname: () => pathname },
  ui: {
    mountMarkdown(container, props, options) {
      // The host renders Markdown and math here; the fixture records the text it was given.
      const render = text => { markdown.push(text); container.textContent = text; };
      render(props.text);
      const dispose = () => { container.textContent = ""; };
      options.signal.addEventListener("abort", dispose, { once: true });
      return { update(next) { if (next.text !== undefined) render(next.text); }, dispose };
    },
    openSurface(surfaceTarget, props, options) {
      if (surfaceTarget !== target) throw new Error("wrong opaque target");
      if (props.background !== "opaque") throw new Error("Sketchpad must open an opaque surface");
      // Mirrors the host shell: an absolutely positioned, clipped frame with a
      // scrolling content box and the host close button in the top right corner.
      const section = document.createElement("section"); section.id = "pad"; section.setAttribute("aria-label", props.title);
      const scroller = document.createElement("div"); scroller.id = "pad-scroll";
      const host = document.createElement("div"); host.style.cssText = "height:100%;width:100%";
      const button = document.createElement("button"); button.id = "close-pad"; button.textContent = "×"; button.setAttribute("aria-label", "Close");
      scroller.append(host); section.append(scroller, button); mounts.append(section);
      const owner = new AbortController();
      let disposed = false, teardown;
      const dispose = () => {
        if (disposed) return; disposed = true;
        owner.abort(); teardown?.(); section.remove();
        options.signal.removeEventListener("abort", dispose); if (surface?.section === section) surface = undefined;
      };
      options.signal.addEventListener("abort", dispose, { once: true });
      const close = () => { props.onClose?.(); dispose(); };
      button.onclick = close;
      surface = { section, dispose, close };
      Promise.resolve(props.content(host, owner.signal)).then(result => { if (disposed) result?.(); else teardown = result; })
        .catch(error => errors.push(String(error)));
      section.querySelector("[data-plugin-initial-focus]")?.focus();
      return { update() {}, dispose };
    },
  },
};
function submissionTarget() { return { sessionId: currentSession, sessionKind: currentKind, surfaceTarget: target, type: "text", channels: ["content"] }; }
function viewContext() {
  return { placement: "top-bar", surface: "session", sessionId: currentSession, kind: currentKind, surfaceTarget: target,
    view: { sessionId: currentSession, kind: currentKind, title: "Fixture", messages: clone(histories.get(currentSession) ?? []), transcript: [],
      status: "ready", reconciliation: "ready", busy: false, compacting: false, phase: currentKind === "practice" ? "practice" : "teach",
      contextTokens: null, queuedSteers: [], composer: { text: "" }, input: submissionTarget() } };
}
const runner = new PluginSubmissionRunner();
const registration = (pluginId, pluginName, definition) => ({ pluginId, pluginName, interceptor: definition, signal: controller.signal, isCurrent: () => true, report(error) { errors.push(String(error)); } });
// Stands in for Drawing Pad: same priority, an earlier plugin id, one appended image.
const otherPad = { id: "drawing", priority: 0, intercept(input) {
  return { ...input, content: { ...input.content, images: [...input.content.images, { type: "image", mimeType: "image/png", data: window.fixture.otherPadImage }] } };
} };
window.fixture = {
  errors, calls, attempts, markdown, placement: undefined, actionRefreshes: 0, submissionRefreshes: 0,
  transcription: "$$\\int_0^1 x^2\\,dx = \\tfrac{1}{3}$$\n\nDie Fläche ist ein Drittel.", holdTranscribe: false, failTranscribe: "", releaseTranscribe: undefined,
  lastTranscribeImage: undefined, otherPadImage: "",
  actions() { return [...actions.values()].map(action => ({ id: action.id, name: action.name, shortcut: action.shortcut })); },
  run(id) { return actions.get(id).run({ ...viewContext(), placement: "keyboard" }); },
  disabled(id) { const action = actions.get(id); return typeof action.disabled === "function" ? action.disabled({ ...viewContext(), placement: "keyboard" }) : !!action.disabled; },
  navigate(session, kind) { surface?.dispose(); currentSession = session; currentKind = kind; pathname = `/opaque/${session}`; refresh(); },
  setHistory(session, messages) { histories.set(session, clone(messages)); },
  pending() { return interceptor.hasPendingInput(submissionTarget()); },
  /** Prepare one text submission through the host runner, then acknowledge or refuse it. */
  async submit({ accept = true, withOtherPad = false } = {}) {
    // Registered in the "wrong" order on purpose: the host sorts by priority, then plugin id.
    const registrations = [registration("sketchpad", "Sketchpad", interceptor), ...(withOtherPad ? [registration("drawing-pad", "Drawing Pad", otherPad)] : [])];
    const attempt = runner.begin(submissionTarget(), registrations, () => true);
    if (!attempt) return { error: "A submission is already being prepared" };
    let result;
    try { result = await attempt.prepare({ type: "text", content: { text: "message", images: [] } }, clone(histories.get(currentSession) ?? [])); }
    catch (error) { attempt.cancel(); return { error: String(error) }; }
    attempt.deliver();
    if (accept) attempt.accepted(); else attempt.refused();
    attempts.push(result); refresh(); return clone(result);
  },
  settings() { return settingsSchema.rows.map(row => ({ key: row.key, type: row.type, label: row.label, value: row.value })); },
  async setSetting(key, value) { const row = settingsSchema.rows.find(row => row.key === key); const error = row.validate?.(value); if (error) return error; await row.onChange(value); return null; },
  saved() { return clone(savedSettings); },
  setTheme,
  closeSurface() { surface?.close(); },
  dispose() { off?.(); controller.abort(); },
};
topButton.onclick = () => { try { actions.get("sketch").run(viewContext()); } catch (error) { errors.push(String(error)); } };
document.addEventListener("keydown", event => { if (event.key === "Escape" && surface) { event.preventDefault(); surface.close(); } });
off = await activate(ctx);
refresh();
window.fixtureReady = true;
