import assert from "node:assert/strict";
import { it } from "node:test";
import { ERASER_RADIUS, HIGHLIGHTER_ALPHA, HIGHLIGHTER_SIZES, PEN_SIZES, inkSignature, paintInk, pointWidth, segmentWidth, sizeFor, visibleStrokes,
  type EraserStroke, type InkStroke, type Stroke } from "../src/strokes.ts";

const line = (tool: "pen" | "highlighter", from: [number, number], to: [number, number], color: InkStroke["color"] = "ink"): InkStroke =>
  ({ tool, color, size: sizeFor(tool, 1), points: [{ x: from[0], y: from[1], pressure: 0.5 }, { x: to[0], y: to[1], pressure: 0.5 }] });
const erase = (...points: [number, number][]): EraserStroke =>
  ({ tool: "eraser", size: ERASER_RADIUS, points: points.map(([x, y]) => ({ x, y, pressure: 0.5 })) });

it("there are three widths per ink tool and the highlighter is wide and translucent", () => {
  assert.equal(PEN_SIZES.length, 3); assert.equal(HIGHLIGHTER_SIZES.length, 3);
  assert.ok(Math.min(...HIGHLIGHTER_SIZES) > Math.max(...PEN_SIZES));
  assert.ok(HIGHLIGHTER_ALPHA > 0 && HIGHLIGHTER_ALPHA < 1);
  assert.equal(sizeFor("pen", 0), PEN_SIZES[0]); assert.equal(sizeFor("highlighter", 2), HIGHLIGHTER_SIZES[2]);
});
it("pen width follows pressure; mouse pressure paints the nominal size; the highlighter ignores pressure", () => {
  const pen = line("pen", [0, 0], [10, 0]), a = { x: 0, y: 0, pressure: 0.5 };
  assert.equal(segmentWidth(pen, a, a), pen.size);
  assert.ok(segmentWidth(pen, { ...a, pressure: 1 }, { ...a, pressure: 1 }) > pen.size);
  assert.ok(segmentWidth(pen, { ...a, pressure: 0.05 }, { ...a, pressure: 0.05 }) < pen.size);
  const marker = line("highlighter", [0, 0], [10, 0]);
  assert.equal(segmentWidth(marker, { ...a, pressure: 1 }, { ...a, pressure: 0.01 }), marker.size);
  assert.equal(pointWidth(pen, a), pen.size); assert.equal(pointWidth(marker, { ...a, pressure: 1 }), marker.size);
  assert.ok(Math.abs(segmentWidth(pen, { ...a, pressure: 0 }, { ...a, pressure: 1 }) - pen.size) < 1e-9, "a segment is as wide as the mean of its ends");
});
it("the eraser removes whole strokes it touches, of either ink tool, and only earlier ones", () => {
  const a = line("pen", [0, 0], [100, 0]), b = line("highlighter", [0, 200], [100, 200]), c = line("pen", [0, 400], [100, 400]);
  assert.deepEqual(visibleStrokes([a, b, c]), [a, b, c]);
  assert.deepEqual(visibleStrokes([a, b, c, erase([50, -30], [50, 30])]), [b, c], "crossing removes the whole pen stroke");
  assert.deepEqual(visibleStrokes([a, b, c, erase([50, 215])]), [a, c], "a tap within reach of the wide highlighter removes it");
  assert.deepEqual(visibleStrokes([a, b, c, erase([50, 100])]), [a, b, c], "a miss removes nothing");
  const later = line("pen", [0, 0], [100, 0], "red");
  assert.deepEqual(visibleStrokes([a, erase([50, 0]), later]), [later], "ink drawn after an erase is not affected by it");
  assert.deepEqual(visibleStrokes([{ ...a, points: [] }]), [], "empty strokes are not ink");
});
it("the eraser reach is its frozen radius plus half the stroke width", () => {
  const pen = line("pen", [0, 0], [100, 0]), reach = ERASER_RADIUS + pen.size / 2;
  assert.deepEqual(visibleStrokes([pen, erase([50, reach - 0.01])]), []);
  assert.deepEqual(visibleStrokes([pen, erase([50, reach + 0.01])]), [pen]);
  // A gesture started while zoomed in carries a smaller world radius.
  assert.deepEqual(visibleStrokes([pen, { ...erase([50, 5]), size: 2 }]), [pen]);
});
it("the signature covers visible ink only, so history-only changes are not new content", () => {
  const a = line("pen", [0, 0], [100, 0]), b = line("pen", [0, 50], [100, 50]);
  assert.equal(inkSignature([]), ""); assert.equal(inkSignature([erase([0, 0])]), "");
  assert.equal(inkSignature([a, b, erase([50, 50])]), inkSignature([a]), "erasing back to an earlier drawing matches it");
  assert.notEqual(inkSignature([a]), inkSignature([{ ...a, color: "red" }]));
  assert.notEqual(inkSignature([a]), inkSignature([{ ...a, tool: "highlighter" }]));
  assert.notEqual(inkSignature([a]), inkSignature([{ ...a, size: a.size + 1 }]));
  assert.equal(inkSignature([a, erase([50, 0])]), "", "a fully erased sheet has no signature");
});
it("visible strokes are computed once per history array", () => {
  const history: Stroke[] = [line("pen", [0, 0], [1, 1])];
  assert.equal(visibleStrokes(history), visibleStrokes(history));
});
it("highlighter paints under pen ink whatever the drawing order, each highlighter stroke as one path", () => {
  const log: string[] = [];
  let alpha = 1, width = 0, style = "", fillColor = "";
  const context = {
    set globalAlpha(value: number) { alpha = value; }, get globalAlpha() { return alpha; },
    set lineWidth(value: number) { width = value; }, get lineWidth() { return width; },
    set strokeStyle(value: string) { style = value; }, set fillStyle(value: string) { fillColor = value; },
    globalCompositeOperation: "", lineCap: "", lineJoin: "",
    beginPath() { log.push("begin"); }, moveTo() {}, lineTo() {}, arc() {}, closePath() {},
    stroke() { log.push(`stroke ${style} ${alpha}`); }, fill() { log.push(`fill ${fillColor} ${alpha}`); },
  } as unknown as CanvasRenderingContext2D;
  const pen = line("pen", [0, 0], [10, 0]), marker: InkStroke = { ...line("highlighter", [0, 0], [10, 0], "orange"),
    points: [0, 10, 20, 30].map(x => ({ x, y: 0, pressure: 0.5 })) };
  paintInk(context, [pen, marker], { ink: "#fff", red: "r", blue: "b", green: "g", orange: "#f80" });
  assert.deepEqual(log, ["begin", `stroke #f80 ${HIGHLIGHTER_ALPHA}`, "begin", "fill #fff 1"], "one path and one paint per stroke");
  assert.equal(alpha, 1, "opacity is restored for whatever paints next");
});
