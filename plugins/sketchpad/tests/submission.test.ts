import assert from "node:assert/strict";
import { it } from "node:test";
import type { PluginSubmission, PluginSubmissionContext, PluginSubmissionTarget } from "learnharness-plugin-api";
import { Sheets, type Capture } from "../src/state.ts";
import { appendSketch, createSubmissionInterceptor, type SketchImage } from "../src/submission.ts";
import { sizeFor, type InkStroke } from "../src/strokes.ts";

const existing = { type: "image" as const, mimeType: "image/png", data: "existing" };
const drawingPad = { type: "image" as const, mimeType: "image/png", data: "drawing-pad" };
const sketch: SketchImage = { type: "image", mimeType: "image/png", data: "sketch" };
const content = { text: "  exact learner text  ", images: [existing] };
const inputs: PluginSubmission[] = [
  { type: "text", content }, { type: "thinking", content },
  { type: "answer", answer: { values: ["stable-b"], confidence: 30, images: [existing] }, thinking: content, readingThinking: content },
  { type: "plugin-question-answer", answer: false, answerImages: [existing], thinking: content, readingThinking: content },
  { type: "plugin-problem-submission", submission: 0, submissionImages: [existing], thinking: content },
];
for (const input of inputs) it(`appends a native image without mutating ${input.type} learner values`, () => {
  const before = JSON.stringify(input), result = appendSketch(input, sketch);
  assert.equal(JSON.stringify(input), before); assert.notEqual(result, input); assert.equal(result.type, input.type);
  if (result.type === "text" || result.type === "thinking") {
    assert.equal(result.content.text, content.text); assert.deepEqual(result.content.images, [existing, sketch]);
  } else if (result.type === "answer") {
    assert.deepEqual(result.answer.values, ["stable-b"]); assert.equal(result.answer.confidence, 30);
    assert.deepEqual(result.answer.images, [existing, sketch]); assert.equal(result.thinking, content); assert.equal(result.readingThinking, content);
  } else if (result.type === "plugin-question-answer") {
    assert.equal(result.answer, false); assert.deepEqual(result.answerImages, [existing, sketch]); assert.equal(result.thinking, content);
  } else { assert.equal(result.submission, 0); assert.deepEqual(result.submissionImages, [existing, sketch]); assert.equal(result.thinking, content); }
});

const pen = (y: number): InkStroke => ({ tool: "pen", color: "ink", size: sizeFor("pen", 1), points: [{ x: 0, y, pressure: 0.5 }, { x: 90, y, pressure: 0.5 }] });
function fixture(kind: "teaching" | "practice" = "teaching") {
  const sheets = new Sheets(), state = sheets.session("s", kind);
  const exported: Capture[] = [], flushed: string[] = [];
  let active = true, fail: Error | undefined, held: ((image: SketchImage) => void) | undefined, hold = false;
  const interceptor = createSubmissionInterceptor({
    sheets, active: () => active, flush: id => { flushed.push(id); },
    exportImage(captured, signal) {
      signal.throwIfAborted(); exported.push(captured);
      if (fail) throw fail;
      const image: SketchImage = { type: "image", mimeType: "image/png", data: `sketch-${captured.draft.revision}` };
      return hold ? new Promise<SketchImage>(resolve => { held = () => resolve(image); }) : image;
    },
  });
  const target = (type: "text" | "thinking" | "answer" | "plugin-question-answer" | "plugin-problem-submission" = "text", mode = "text", sessionId = "s") =>
    ({ sessionId, sessionKind: kind, surfaceTarget: {}, type, channels: ["content"],
      ...(type === "answer" ? { question: { mode } } : {}) }) as unknown as PluginSubmissionTarget;
  async function submit(input: PluginSubmission = { type: "text", content: { text: "hello", images: [] } }, { signal = new AbortController().signal, sessionId = "s" } = {}) {
    const callbacks: (() => void | Promise<void>)[] = [];
    const context = { ...target(input.type, "text", sessionId), messages: [], signal, onAccepted(fn: () => void) { callbacks.push(fn); } } as unknown as PluginSubmissionContext;
    const result = await interceptor.intercept(input, context);
    return { result, accept() { for (const fn of callbacks) void fn(); }, callbacks };
  }
  return { sheets, state, interceptor, exported, flushed, target, submit,
    deactivate() { active = false; }, failWith(error: Error | undefined) { fail = error; },
    holdExport() { hold = true; }, releaseExport() { held?.(sketch); } };
}
const imagesOf = (result: PluginSubmission | null | void) => result && (result.type === "text" || result.type === "thinking") ? result.content.images : [];

it("pending input is reported only for sessions with unsent ink and for content targets", () => {
  const f = fixture();
  assert.equal(f.interceptor.hasPendingInput!(f.target()), false);
  f.sheets.addStroke(f.state, pen(0));
  assert.equal(f.interceptor.hasPendingInput!(f.target("text")), true);
  assert.equal(f.interceptor.hasPendingInput!(f.target("thinking")), true);
  assert.equal(f.interceptor.hasPendingInput!(f.target("answer", "text")), true);
  assert.equal(f.interceptor.hasPendingInput!(f.target("answer", "single-select")), false, "a sketch does not make a choice question ready");
  assert.equal(f.interceptor.hasPendingInput!(f.target("plugin-question-answer")), false);
  assert.equal(f.interceptor.hasPendingInput!(f.target("plugin-problem-submission")), false);
  assert.equal(f.interceptor.hasPendingInput!(f.target("text", "text", "other-session")), false);
});
it("teaching: the sketch is attached, kept until the host acknowledges, then replaced by a fresh sheet", async () => {
  const f = fixture(); f.sheets.addStroke(f.state, pen(0));
  const attempt = await f.submit();
  assert.deepEqual(f.flushed, ["s"], "a stroke still under the pen is committed first");
  assert.deepEqual(imagesOf(attempt.result).map(image => image.data), ["sketch-1"]);
  assert.equal(attempt.result && attempt.result.type === "text" && attempt.result.content.text, "hello");
  assert.equal(f.state.draft.strokes.length, 1); assert.equal(f.sheets.pending(f.state), true, "nothing is consumed before acceptance");
  attempt.accept();
  assert.equal(f.state.draft.strokes.length, 0); assert.equal(f.sheets.pending(f.state), false);
  assert.equal((await f.submit()).result, undefined, "an empty sheet leaves the submission untouched");
});
it("a refused, failed or unacknowledged attempt keeps the sketch for the next one", async () => {
  const f = fixture(); f.sheets.addStroke(f.state, pen(0));
  const lost = await f.submit(); assert.equal(imagesOf(lost.result).length, 1);
  // No acknowledgement arrives. The next attempt sends the same sketch again.
  const retry = await f.submit(); assert.deepEqual(imagesOf(retry.result).map(image => image.data), ["sketch-1"]);
  f.failWith(new Error("No visible ink could be captured. Your sketch has been kept."));
  await assert.rejects(f.submit(), /has been kept/);
  assert.equal(f.state.draft.strokes.length, 1); assert.equal(f.sheets.pending(f.state), true);
  f.failWith(undefined);
  const aborted = new AbortController(); aborted.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(f.submit(undefined, { signal: aborted.signal }), /cancelled/);
  assert.equal(f.state.draft.strokes.length, 1);
});
it("ink drawn while the message is on its way survives the acknowledgement", async () => {
  const f = fixture(); f.sheets.addStroke(f.state, pen(0));
  const attempt = await f.submit(); f.sheets.addStroke(f.state, pen(50)); attempt.accept();
  assert.equal(f.state.draft.strokes.length, 2); assert.equal(f.sheets.pending(f.state), true);
});
it("a sheet replaced during export refuses the attempt instead of sending a stale image", async () => {
  const f = fixture(); f.sheets.addStroke(f.state, pen(0)); f.holdExport();
  const pending = f.submit();
  await new Promise<void>(resolve => queueMicrotask(resolve));
  f.sheets.accepted(f.sheets.capture(f.state)); // an earlier attempt's acknowledgement replaces the sheet
  f.releaseExport();
  await assert.rejects(pending, /replaced while it was being prepared/);
});
it("practice: the board stays, the image is marked sent and is not attached again until it changes", async () => {
  const f = fixture("practice"); f.sheets.addStroke(f.state, pen(0));
  const first = await f.submit({ type: "thinking", content: { text: "step 1", images: [] } });
  assert.equal(imagesOf(first.result).length, 1); first.accept();
  assert.equal(f.state.draft.strokes.length, 1); assert.equal(f.interceptor.hasPendingInput!(f.target("thinking")), false);
  assert.equal((await f.submit({ type: "thinking", content: { text: "step 2", images: [] } })).result, undefined);
  assert.equal(f.exported.length, 1, "nothing is exported when there is nothing new");
  f.sheets.addStroke(f.state, pen(50));
  const second = await f.submit({ type: "thinking", content: { text: "step 3", images: [] } });
  assert.deepEqual(imagesOf(second.result).map(image => image.data), ["sketch-2"]);
});
it("a Drawing Pad image already attached by the earlier interceptor is kept, with the sketch after it", async () => {
  const f = fixture(); f.sheets.addStroke(f.state, pen(0));
  const after = await f.submit({ type: "text", content: { text: "both", images: [drawingPad] } });
  assert.deepEqual(imagesOf(after.result).map(image => image.data), ["drawing-pad", "sketch-1"]);
  const answer = await f.submit({ type: "answer", answer: { text: "x", images: [drawingPad] }, thinking: { text: "", images: [] }, readingThinking: { text: "", images: [] } });
  assert.deepEqual(answer.result && answer.result.type === "answer" && answer.result.answer.images.map(image => image.data), ["drawing-pad", "sketch-1"]);
});
it("unknown sessions pass through, and an acknowledgement after deactivation changes nothing", async () => {
  const f = fixture(); f.sheets.addStroke(f.state, pen(0));
  assert.equal((await f.submit(undefined, { sessionId: "elsewhere" })).result, undefined);
  const attempt = await f.submit(); f.deactivate(); attempt.accept();
  assert.equal(f.state.draft.strokes.length, 1);
});
