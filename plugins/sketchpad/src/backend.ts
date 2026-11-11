import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { DEFAULT_SETTINGS, parseImageScaleChange, parsePenWidthChange, parseSettings, type Settings } from "./settings.ts";

/** The whole instruction for Convert to LaTeX. The learner checks the result before using it. */
export const TRANSCRIBE_PROMPT = [
  "You transcribe a learner's handwritten sketch into text. The image may show mathematics, short notes, code or a diagram, possibly drawn on top of a photo.",
  "Rules:",
  "- Transcribe faithfully. Do not solve, correct, complete, simplify or comment on the work, even if it contains mistakes.",
  "- Write mathematics as LaTeX inside Markdown: $...$ inline and $$...$$ for displayed lines. Keep the learner's line breaks and the order of their steps; use an aligned environment for a chain of equations.",
  "- Keep ordinary words exactly as written, in the language they were written in. German stays German (keep ä, ö, ü, ß); do not translate.",
  "- Write code as a fenced code block.",
  "- Mark anything you cannot read with [unreadable]. Never guess silently.",
  "- A drawing or diagram that cannot be written as text gets one short line in square brackets, for example [diagram: right triangle with sides a, b, c].",
  "- Reply with the transcription only: no introduction, no explanation, no surrounding code fence.",
].join("\n");
export const TRANSCRIBE_REQUEST = "Transcribe this sketch.";
const IMAGE_TYPES = new Set(["image/png", "image/jpeg"]);
/** About 6 MB of image bytes: far above any capped sketch export. */
const MAX_IMAGE_CHARACTERS = 8_000_000;

interface TranscribeRequest { requestId: string; image: { type: "image"; mimeType: string; data: string } }
function requestId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error("Expected a valid requestId.");
  return value;
}
export function parseTranscribeRequest(value: unknown): TranscribeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a sketch image.");
  const input = value as Record<string, unknown>, image = input.image as Record<string, unknown> | null | undefined;
  if (Object.keys(input).some(key => key !== "requestId" && key !== "image") || !image || typeof image !== "object" ||
    typeof image.mimeType !== "string" || !IMAGE_TYPES.has(image.mimeType) || typeof image.data !== "string" || !image.data ||
    image.data.length > MAX_IMAGE_CHARACTERS || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error("Expected a PNG or JPEG sketch image.");
  return { requestId: requestId(input.requestId), image: { type: "image", mimeType: image.mimeType, data: image.data } };
}

/** The backend stores preferences and relays Convert to LaTeX to the host's
 * model service. Editable sketches never leave window memory. */
export function activate(ctx: PluginBackendContext): () => void {
  const file = path.join(ctx.dataDirectory, "settings.json");
  let settings: Settings;
  try { settings = parseSettings(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    settings = { ...DEFAULT_SETTINGS };
  }
  let disposed = false;
  const running = new Map<string, AbortController>();
  const assertActive = () => {
    if (disposed || ctx.signal.aborted) throw new Error("Sketchpad is disabled.");
  };
  const persist = (change: Partial<Pick<Settings, "penWidth" | "imageScale">>) => {
    assertActive();
    const next = { ...settings, ...change, revision: settings.revision + 1 };
    if (next.penWidth === settings.penWidth && next.imageScale === settings.imageScale) return { ...settings };
    if (settings.revision === Number.MAX_SAFE_INTEGER) throw new Error("Settings revision limit reached.");
    fs.mkdirSync(ctx.dataDirectory, { recursive: true });
    const temporary = path.join(ctx.dataDirectory, `.settings-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(next) + "\n", { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
    settings = next;
    ctx.events.emit("settings-changed", { ...settings });
    return { ...settings };
  };
  /** One explicit, learner-initiated request to the configured Vision model.
   * No model fallback: an unset or text-only Vision slot is reported, not replaced. */
  const transcribe = async (input: unknown) => {
    assertActive();
    const request = parseTranscribeRequest(input);
    if (running.has(request.requestId)) throw new Error("This conversion is already running.");
    const controller = new AbortController(), abort = () => controller.abort();
    running.set(request.requestId, controller);
    ctx.signal.addEventListener("abort", abort, { once: true });
    try {
      const catalog = await ctx.inference.catalog();
      const slot = catalog.slots.vision;
      if (!slot) throw new Error("No Vision model is set. Choose one in Settings → Agent, then try again.");
      const entry = catalog.models.find(model => model.provider === slot.model.provider && model.id === slot.model.id);
      if (entry && !entry.input.includes("image")) throw new Error(`The Vision model (${entry.name}) cannot read images. Choose another one in Settings → Agent.`);
      if (controller.signal.aborted) throw new Error("Conversion cancelled.");
      const message = await ctx.inference.complete({
        model: { ...slot.model, ...(slot.thinkingLevel ? { thinkingLevel: slot.thinkingLevel } : {}) },
        purpose: "user", signal: controller.signal, options: { maxTokens: 4096 },
        context: { systemPrompt: TRANSCRIBE_PROMPT, messages: [{ role: "user", timestamp: Date.now(),
          content: [request.image, { type: "text", text: TRANSCRIBE_REQUEST }] }] },
      });
      if (message.stopReason === "aborted" || controller.signal.aborted) throw new Error("Conversion cancelled.");
      if (message.stopReason === "error") throw new Error(message.errorMessage || "The model could not read the sketch.");
      const text = message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("").trim();
      if (!text) throw new Error("The model returned no text. Try again, or send the sketch as an image.");
      return { text, model: entry?.name ?? slot.model.id, truncated: message.stopReason === "length" };
    } finally {
      ctx.signal.removeEventListener("abort", abort);
      if (running.get(request.requestId) === controller) running.delete(request.requestId);
    }
  };
  const unregister = [
    ctx.handle("get-settings", () => { assertActive(); return { ...settings }; }),
    ctx.handle("set-pen-width", input => { assertActive(); return persist({ penWidth: parsePenWidthChange(input) }); }),
    ctx.handle("set-image-scale", input => { assertActive(); return persist({ imageScale: parseImageScaleChange(input) }); }),
    ctx.handle("transcribe", transcribe),
    ctx.handle("cancel-transcribe", input => {
      const id = requestId(input && typeof input === "object" ? (input as Record<string, unknown>).requestId : undefined);
      running.get(id)?.abort();
      return { cancelled: running.has(id) };
    }),
  ];
  return () => {
    if (disposed) return;
    disposed = true;
    for (const controller of running.values()) controller.abort();
    for (const off of unregister) off();
  };
}
