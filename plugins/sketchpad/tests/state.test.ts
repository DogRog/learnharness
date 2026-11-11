import assert from "node:assert/strict";
import { it } from "node:test";
import { Sheets } from "../src/state.ts";
import { ERASER_RADIUS, sizeFor, type InkStroke, type Stroke } from "../src/strokes.ts";

const pen = (y: number, color: InkStroke["color"] = "ink"): InkStroke =>
  ({ tool: "pen", color, size: sizeFor("pen", 1), points: [{ x: 0, y, pressure: 0.5 }, { x: 100, y, pressure: 0.5 }] });
const eraseAt = (y: number): Stroke => ({ tool: "eraser", size: ERASER_RADIUS, points: [{ x: 50, y, pressure: 0.5 }] });
const picture = { width: 800, height: 600, label: "photo.jpg", source: {} };
function fixture() {
  let changes = 0, repaints = 0;
  const sheets = new Sheets(() => { changes++; });
  sheets.onChange(() => { repaints++; });
  return { sheets, changes: () => changes, repaints: () => repaints };
}

it("each session has its own sheet, kept for the window, with pen defaults", () => {
  const { sheets } = fixture(), a = sheets.session("a", "teaching"), b = sheets.session("b", "practice");
  assert.notEqual(a, b); assert.equal(sheets.session("a", "teaching"), a);
  assert.equal(a.tool, "pen"); assert.deepEqual(a.colors, { pen: "ink", highlighter: "orange" }); assert.deepEqual(a.sizes, { pen: 1, highlighter: 1 });
  assert.equal(a.view, undefined); assert.equal(a.draft.hasInk, false);
  assert.throws(() => sheets.session("a", "practice"), /kind changed/);
  sheets.addStroke(a, pen(0));
  assert.equal(b.draft.strokes.length, 0, "ink never crosses sessions");
  sheets.setPenWidth(2);
  assert.equal(sheets.session("c", "teaching").sizes.pen, 2, "the default width applies to new sheets");
  assert.equal(a.sizes.pen, 1, "and never to sheets that already exist");
});
it("undo and redo walk the history, and a new stroke discards the redo branch", () => {
  const { sheets } = fixture(), state = sheets.session("a", "teaching"), [one, two, three] = [pen(0), pen(50), pen(100)];
  assert.equal(sheets.canUndo(state), false); assert.equal(sheets.canRedo(state), false);
  sheets.undo(state); sheets.redo(state); assert.equal(state.draft.revision, 0, "nothing to undo or redo is not an edit");
  for (const stroke of [one, two, three]) sheets.addStroke(state, stroke);
  sheets.undo(state); sheets.undo(state);
  assert.deepEqual(state.draft.strokes, [one]); assert.deepEqual(state.draft.redo, [three, two]);
  sheets.redo(state);
  assert.deepEqual(state.draft.strokes, [one, two]); assert.equal(sheets.canRedo(state), true);
  const other = pen(200, "red"); sheets.addStroke(state, other);
  assert.deepEqual(state.draft.strokes, [one, two, other]); assert.equal(sheets.canRedo(state), false);
  sheets.addStroke(state, { ...pen(0), points: [] });
  assert.equal(state.draft.strokes.length, 3, "an empty stroke is not added");
});
it("undoing an erase restores the complete stroke, and redo erases it again", () => {
  const { sheets } = fixture(), state = sheets.session("a", "teaching");
  sheets.addStroke(state, pen(0)); sheets.addStroke(state, eraseAt(0));
  assert.equal(state.draft.hasInk, false); assert.equal(sheets.pending(state), false);
  sheets.undo(state); assert.equal(state.draft.hasInk, true); assert.equal(sheets.pending(state), true);
  sheets.redo(state); assert.equal(state.draft.hasInk, false);
});
it("clear removes ink and its history but keeps the background", () => {
  const { sheets } = fixture(), state = sheets.session("a", "teaching");
  sheets.clear(state); assert.equal(state.draft.revision, 0);
  sheets.setBackground(state, picture); sheets.addStroke(state, pen(0)); sheets.addStroke(state, pen(50)); sheets.undo(state);
  sheets.clear(state);
  assert.deepEqual(state.draft.strokes, []); assert.deepEqual(state.draft.redo, []);
  assert.equal(sheets.canUndo(state), false); assert.equal(sheets.canRedo(state), false);
  assert.equal(state.draft.background?.label, "photo.jpg"); assert.equal(sheets.pending(state), false, "a background alone is not unsent ink");
  sheets.setBackground(state, undefined); assert.equal(state.draft.background, undefined);
  const revision = state.draft.revision; sheets.setBackground(state, undefined);
  assert.equal(state.draft.revision, revision, "removing nothing is not an edit");
});
it("tool, color, width, camera and full screen repaint without touching content or the host", () => {
  const { sheets, changes, repaints } = fixture(), state = sheets.session("a", "teaching");
  sheets.addStroke(state, pen(0));
  const revision = state.draft.revision, hostChanges = changes(), signature = sheets.signature(state);
  sheets.setTool(state, "highlighter"); sheets.setColor(state, "green"); sheets.setSize(state, 2);
  assert.deepEqual(state.colors, { pen: "ink", highlighter: "green" }); assert.deepEqual(state.sizes, { pen: 1, highlighter: 2 });
  sheets.setTool(state, "eraser"); sheets.setColor(state, "blue");
  assert.equal(state.tool, "pen", "picking a color or width while erasing returns to the pen"); assert.equal(state.colors.pen, "blue");
  sheets.setView(state, { zoom: 3, x: 5, y: 6 }); sheets.setFullscreen(true); sheets.setFullscreen(true);
  assert.deepEqual(state.view, { zoom: 3, x: 5, y: 6 }); assert.equal(sheets.fullscreen, true);
  assert.equal(state.draft.revision, revision); assert.equal(sheets.signature(state), signature); assert.equal(changes(), hostChanges);
  assert.ok(repaints() >= 6);
});
it("teaching: an accepted sketch starts a fresh sheet; newer edits and stale acknowledgements keep the work", () => {
  const { sheets, changes } = fixture(), state = sheets.session("a", "teaching");
  sheets.setBackground(state, picture); sheets.addStroke(state, pen(0)); sheets.setView(state, { zoom: 2, x: 1, y: 1 });
  assert.equal(sheets.pending(state), true);
  const first = sheets.capture(state); assert.equal(first.sendImage, true);
  // Still pending while the attempt is in flight, and after a failure nothing changes at all.
  assert.equal(sheets.pending(state), true); assert.equal(state.draft, first.draft);
  // The learner draws again before the acknowledgement arrives: keep everything.
  sheets.addStroke(state, pen(50)); sheets.accepted(first);
  assert.equal(state.draft.strokes.length, 2); assert.equal(state.draft.background?.label, "photo.jpg"); assert.equal(sheets.pending(state), true);
  const second = sheets.capture(state), before = changes(); sheets.accepted(second);
  assert.equal(state.draft.strokes.length, 0); assert.equal(state.draft.background, undefined); assert.equal(state.view, undefined);
  assert.notEqual(state.draft.id, second.draft.id); assert.equal(sheets.pending(state), false); assert.equal(changes(), before + 1);
  // An acknowledgement for the replaced sheet cannot clear the new one.
  sheets.addStroke(state, pen(0, "red")); sheets.accepted(second);
  assert.equal(state.draft.strokes.length, 1);
});
it("practice: the board is kept; an image is sent only when the visible sketch differs from the last accepted one", () => {
  const { sheets } = fixture(), state = sheets.session("p", "practice");
  sheets.addStroke(state, pen(0));
  const first = sheets.capture(state); assert.equal(first.sendImage, true); sheets.accepted(first);
  assert.equal(state.draft.strokes.length, 1, "the board stays"); assert.equal(sheets.pending(state), false);
  assert.equal(sheets.capture(state).sendImage, false, "an unchanged sketch is not sent twice");
  sheets.addStroke(state, pen(50)); assert.equal(sheets.pending(state), true);
  sheets.undo(state); assert.equal(sheets.pending(state), false, "undo back to the sent sketch is not new content");
  sheets.setColor(state, "red"); assert.equal(sheets.pending(state), false, "picking a color is not an edit");
  sheets.setBackground(state, picture); assert.equal(sheets.pending(state), true, "a new background changes the image");
  const second = sheets.capture(state); sheets.accepted(second); assert.equal(sheets.pending(state), false);
  sheets.addStroke(state, eraseAt(0)); assert.equal(sheets.pending(state), false, "an empty sheet has nothing to send");
  sheets.accepted({ ...second, sendImage: false }); assert.equal(state.sentSignature, second.signature);
});
it("disposal drops every sheet and listener", () => {
  const { sheets, repaints } = fixture(), state = sheets.session("a", "teaching");
  sheets.dispose(); assert.equal(sheets.sessions.size, 0);
  const before = repaints(); sheets.setTool(state, "eraser"); assert.equal(repaints(), before);
  sheets.accepted({ session: state, draft: state.draft, signature: "x", imageScale: 50, sendImage: true });
  assert.equal(state.sentSignature, "", "an acknowledgement after disposal changes nothing");
});
