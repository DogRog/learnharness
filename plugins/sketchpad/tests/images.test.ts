import assert from "node:assert/strict";
import { it } from "node:test";
import { SESSION_IMAGE_LIMIT, figureMarkup, sessionImages } from "../src/images.ts";

const image = (data: string, mimeType = "image/png") => ({ type: "image", mimeType, data });
const svg = '<svg viewBox="0 0 400 300"><rect width="400" height="300" fill="white"/></svg>';
const steer = (details: unknown, customType = "subagent-steer") => ({ id: "m", role: "custom", customType, content: "", display: true, details });

it("collects learner images, answer images, practice thinking images and tutor figures, newest first", () => {
  const messages = [
    { role: "user", content: "plain text only" },
    { role: "user", content: [{ type: "text", text: "see photo" }, image("AAAA", "image/jpeg")] },
    { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "toolCall", id: "t", name: "quiz", arguments: {} }] },
    { role: "toolResult", toolCallId: "t", toolName: "quiz", content: [{ type: "text", text: "Answer images:" }, image("BBBB")] },
    steer({ problemCallId: "p", text: "thinking", images: [image("CCCC")] }, "practice-thinking"),
    steer({ images: { submission: [image("DDDD")], thinking: [image("EEEE", "image/webp")] } }, "plugin-problem-submission"),
    steer({ kind: "visual", jobId: "j", toolCallId: "v", result: { svg } }),
  ];
  const found = sessionImages(messages);
  assert.deepEqual(found.map(entry => [entry.kind, entry.label]), [
    ["figure", "Tutor figure 1"], ["bitmap", "Your image 5"], ["bitmap", "Your image 4"], ["bitmap", "Your image 3"],
    ["bitmap", "Session image 2"], ["bitmap", "Your image 1"],
  ]);
  const first = found.at(-1)!; assert.ok(first.kind === "bitmap" && first.mimeType === "image/jpeg" && first.data === "AAAA");
  assert.equal(new Set(found.map(entry => entry.key)).size, found.length);
});
it("ignores what it cannot use: other types, failed or photo-annotation figures, and malformed blocks", () => {
  assert.deepEqual(sessionImages([
    null, "text", 7, [], { role: "user" }, { role: "user", content: [null, { type: "image" }, image("", "image/png"), image("AAAA", "image/svg+xml"), image("AAAA", "text/html")] },
    { role: "assistant", content: [image("AAAA")] },
    steer({ kind: "visual", result: { svg: "" } }), steer({ kind: "visual", result: { svg, image: { path: "/p.jpg", snapshotId: "s" } } }),
    steer({ kind: "demo", result: { svg } }), steer({ kind: "visual", result: { svg } }, "side-question"), steer(null), steer({ kind: "visual", result: { svg: "not markup" } }),
  ]), []);
});
it("drops duplicates and keeps only the most recent images", () => {
  const repeated = sessionImages([{ role: "user", content: [image("AAAA"), image("AAAA")] }, { role: "user", content: [image("AAAA")] },
    steer({ kind: "visual", result: { svg } }), steer({ kind: "visual", result: { svg } })]);
  assert.deepEqual(repeated.map(entry => entry.label), ["Tutor figure 1", "Your image 1"]);
  const many = sessionImages(Array.from({ length: 30 }, (_, index) => ({ role: "user", content: [image(`data${index}`)] })));
  assert.equal(many.length, SESSION_IMAGE_LIMIT);
  assert.equal(many[0]!.label, "Your image 30"); assert.equal(many.at(-1)!.label, `Your image ${31 - SESSION_IMAGE_LIMIT}`);
});
it("figures get a namespace and an explicit pixel size so the browser can decode them as images", () => {
  const sized = figureMarkup(svg);
  assert.equal(sized.width, 400); assert.equal(sized.height, 300);
  assert.match(sized.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 400 300" width="400" height="300">/);
  assert.ok(sized.svg.endsWith('<rect width="400" height="300" fill="white"/></svg>'), "only the root element is changed");
  const explicit = figureMarkup('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="640px" height="480" stroke-width="2"><g/></svg>');
  assert.equal(explicit.width, 640); assert.equal(explicit.height, 480);
  assert.match(explicit.svg, /^<\?xml version="1\.0"\?>\n<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" stroke-width="2" width="640" height="480"><g\/><\/svg>$/);
  const widthOnly = figureMarkup('<svg width="200" viewBox="0 0 100 50"/>');
  assert.deepEqual([widthOnly.width, widthOnly.height], [200, 100]); assert.match(widthOnly.svg, /width="200" height="100"\/>$/);
  const relative = figureMarkup('<svg width="100%" height="auto" viewBox="0 0 320 240"></svg>');
  assert.deepEqual([relative.width, relative.height], [320, 240]);
  assert.deepEqual([figureMarkup("<svg></svg>").width, figureMarkup("<svg></svg>").height], [800, 600]);
  assert.throws(() => figureMarkup("<div/>"), /not an SVG/);
});
