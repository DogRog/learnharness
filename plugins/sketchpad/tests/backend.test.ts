import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginBackendContext, PluginInferenceRequest } from "learnharness-plugin-api";
import { TRANSCRIBE_PROMPT, activate, parseTranscribeRequest } from "../src/backend.ts";
import { imageScaleError, parseImageScaleChange, parsePenWidthChange, parseSettings, penWidthError, penWidthIndex } from "../src/settings.ts";

const png = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" };
const vision = { provider: "anthropic", id: "vision-model" };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sketchpad-test-"));
  const directory = path.join(root, "data"), controller = new AbortController();
  const handlers = new Map<string, (input: unknown) => unknown>();
  const events: unknown[] = [], requests: PluginInferenceRequest[] = [];
  let catalog: unknown = { models: [{ ...vision, name: "Vision Model", input: ["text", "image"] }], slots: { vision: { model: vision, thinkingLevel: "low" } } };
  let reply: (request: PluginInferenceRequest) => unknown = () => ({ stopReason: "stop", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "  $$x^2 + 1$$\n" }] });
  const ctx = { dataDirectory: directory, signal: controller.signal,
    handle(name: string, handler: (input: unknown) => unknown) { handlers.set(name, handler); return () => { handlers.delete(name); }; },
    events: { emit(topic: string, data: unknown) { events.push({ topic, data }); } },
    inference: { async catalog() { return catalog; }, async complete(request: PluginInferenceRequest) { requests.push(request); return reply(request); } },
  } as unknown as PluginBackendContext;
  let off: (() => void) | undefined;
  return { directory, events, requests, controller, handlers,
    start() { off = activate(ctx); },
    call(name: string, input?: unknown) { return handlers.get(name)!(input); },
    setCatalog(value: unknown) { catalog = value; }, setReply(value: typeof reply) { reply = value; },
    stop() { off?.(); },
    close() { off?.(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}
it("validates settings strictly and does not coerce", () => {
  assert.deepEqual(parseSettings({ revision: 3, penWidth: "bold", imageScale: 25 }), { revision: 3, penWidth: "bold", imageScale: 25 });
  for (const revision of [-1, .5, "1", Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => parseSettings({ revision, penWidth: "fine", imageScale: 50 }));
  assert.throws(() => parseSettings({ revision: 0, penWidth: "fine", imageScale: 50, draft: [] }));
  for (const value of ["thin", "", 1, null, undefined, "Fine"]) { assert.ok(penWidthError(value)); assert.throws(() => parsePenWidthChange({ penWidth: value })); }
  for (const value of [0, -1, 100.1, NaN, Infinity, "50", null]) { assert.ok(imageScaleError(value)); assert.throws(() => parseImageScaleChange({ imageScale: value })); }
  assert.equal(parsePenWidthChange({ penWidth: "fine" }), "fine"); assert.equal(parseImageScaleChange({ imageScale: 100 }), 100);
  assert.throws(() => parsePenWidthChange({ penWidth: "fine", imageScale: 50 })); assert.throws(() => parseImageScaleChange([50]));
  assert.deepEqual(["fine", "medium", "bold"].map(width => penWidthIndex(width as "fine")), [0, 1, 2]);
});
it("loads defaults without creating any data file", () => {
  const f = fixture(); try {
    f.start(); assert.deepEqual(f.call("get-settings"), { revision: 0, penWidth: "medium", imageScale: 50 });
    assert.equal(fs.existsSync(f.directory), false); assert.deepEqual(f.events, []);
  } finally { f.close(); }
});
it("persists each preference, emits only accepted snapshots, and reloads them", () => {
  const f = fixture(); try {
    f.start();
    assert.deepEqual(f.call("set-pen-width", { penWidth: "bold" }), { revision: 1, penWidth: "bold", imageScale: 50 });
    assert.deepEqual(f.call("set-image-scale", { imageScale: 80 }), { revision: 2, penWidth: "bold", imageScale: 80 });
    assert.deepEqual(f.call("set-image-scale", { imageScale: 80 }), { revision: 2, penWidth: "bold", imageScale: 80 }, "an unchanged value is not a new revision");
    assert.throws(() => f.call("set-pen-width", { penWidth: "huge" })); assert.throws(() => f.call("set-image-scale", { imageScale: 0 }));
    assert.deepEqual(f.events, [{ topic: "settings-changed", data: { revision: 1, penWidth: "bold", imageScale: 50 } },
      { topic: "settings-changed", data: { revision: 2, penWidth: "bold", imageScale: 80 } }]);
    assert.deepEqual(fs.readdirSync(f.directory), ["settings.json"], "no temporary file and no sketch is ever stored");
    f.stop(); f.start(); assert.deepEqual(f.call("get-settings"), { revision: 2, penWidth: "bold", imageScale: 80 });
  } finally { f.close(); }
});
it("refuses corrupt stored settings instead of silently resetting them", () => {
  const f = fixture(); try {
    fs.mkdirSync(f.directory, { recursive: true }); fs.writeFileSync(path.join(f.directory, "settings.json"), '{"revision":1,"penWidth":"huge","imageScale":50}');
    assert.throws(() => f.start());
  } finally { f.close(); }
});
it("Convert to LaTeX sends one learner-initiated request with the sketch to the Vision model", async () => {
  const f = fixture(); try {
    f.start();
    const result = await f.call("transcribe", { requestId: "r1", image: png });
    assert.deepEqual(result, { text: "$$x^2 + 1$$", model: "Vision Model", truncated: false });
    assert.equal(f.requests.length, 1);
    const request = f.requests[0]!;
    assert.deepEqual(request.model, { ...vision, thinkingLevel: "low" }); assert.equal(request.purpose, "user");
    assert.equal(request.context.systemPrompt, TRANSCRIBE_PROMPT); assert.equal(request.context.tools, undefined);
    assert.equal(request.context.messages.length, 1);
    const message = request.context.messages[0]!;
    assert.equal(message.role, "user"); assert.deepEqual((message.content as unknown[])[0], png);
    assert.ok(request.signal instanceof AbortSignal);
    assert.match(TRANSCRIBE_PROMPT, /German stays German/); assert.match(TRANSCRIBE_PROMPT, /Do not solve, correct/); assert.match(TRANSCRIBE_PROMPT, /\[unreadable\]/);
  } finally { f.close(); }
});
it("reports an unset or text-only Vision model instead of choosing another model", async () => {
  const f = fixture(); try {
    f.start();
    f.setCatalog({ models: [], slots: { vision: null, strong: { model: { provider: "p", id: "strong" } } } });
    await assert.rejects(async () => f.call("transcribe", { requestId: "r1", image: png }), /No Vision model is set/);
    f.setCatalog({ models: [{ ...vision, name: "Text Only", input: ["text"] }], slots: { vision: { model: vision } } });
    await assert.rejects(async () => f.call("transcribe", { requestId: "r2", image: png }), /Text Only\) cannot read images/);
    assert.equal(f.requests.length, 0, "no model request is made");
  } finally { f.close(); }
});
it("model errors, empty answers and cut-off answers are reported as they are", async () => {
  const f = fixture(); try {
    f.start();
    f.setReply(() => ({ stopReason: "error", errorMessage: "quota exceeded", content: [{ type: "text", text: "partial" }] }));
    await assert.rejects(async () => f.call("transcribe", { requestId: "r1", image: png }), /quota exceeded/);
    f.setReply(() => ({ stopReason: "stop", content: [{ type: "thinking", thinking: "…" }] }));
    await assert.rejects(async () => f.call("transcribe", { requestId: "r2", image: png }), /returned no text/);
    f.setReply(() => ({ stopReason: "length", content: [{ type: "text", text: "$a" }] }));
    assert.deepEqual(await f.call("transcribe", { requestId: "r3", image: png }), { text: "$a", model: "Vision Model", truncated: true });
    assert.deepEqual(await f.call("transcribe", { requestId: "r1", image: png }), { text: "$a", model: "Vision Model", truncated: true }, "a finished request id can be used again");
  } finally { f.close(); }
});
it("a running conversion can be cancelled, and disabling the plugin cancels it too", async () => {
  const f = fixture(); try {
    f.start();
    f.setReply(request => new Promise(resolve => request.signal!.addEventListener("abort", () => resolve({ stopReason: "aborted", content: [] }), { once: true })));
    const first = f.call("transcribe", { requestId: "r1", image: png }) as Promise<unknown>;
    await new Promise(resolve => setTimeout(resolve, 0));
    await assert.rejects(async () => f.call("transcribe", { requestId: "r1", image: png }), /already running/);
    assert.deepEqual(f.call("cancel-transcribe", { requestId: "r1" }), { cancelled: true });
    await assert.rejects(first, /Conversion cancelled/);
    assert.deepEqual(f.call("cancel-transcribe", { requestId: "r1" }), { cancelled: false });
    const second = f.call("transcribe", { requestId: "r2", image: png }) as Promise<unknown>;
    await new Promise(resolve => setTimeout(resolve, 0));
    f.stop(); await assert.rejects(second, /Conversion cancelled/);
    assert.equal(f.handlers.size, 0);
  } finally { f.close(); }
});
it("accepts only a PNG or JPEG base64 image with a plain request id", () => {
  assert.deepEqual(parseTranscribeRequest({ requestId: "a-B_1", image: { mimeType: "image/jpeg", data: "QUJD", extra: true } }),
    { requestId: "a-B_1", image: { type: "image", mimeType: "image/jpeg", data: "QUJD" } });
  for (const value of [null, [], {}, { requestId: "r", image: null }, { requestId: "r", image: { mimeType: "image/gif", data: "QUJD" } },
    { requestId: "r", image: { mimeType: "image/png", data: "" } }, { requestId: "r", image: { mimeType: "image/png", data: "not base64!" } },
    { requestId: "r", image: { mimeType: "image/png", data: "A".repeat(8_000_001) } }, { requestId: "../x", image: png }, { requestId: "", image: png },
    { requestId: "r", image: png, model: "other" }]) assert.throws(() => parseTranscribeRequest(value));
});
