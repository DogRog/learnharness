import assert from "node:assert/strict";
import { it } from "node:test";
import { BACKGROUND_PIXEL_CAP, BACKGROUND_WORLD_CAP, HOME_VIEW, MAX_FIT_ZOOM, MAX_ZOOM, MIN_ZOOM, clampZoom, contentBounds, exportBounds, exportRaster,
  fitView, inkBounds, panBy, pinchView, placeBackground, relativeTransform, sameView, toScreen, toWorld, wheelPan, wheelZoomFactor, zoomAt } from "../src/geometry.ts";
import type { InkStroke } from "../src/strokes.ts";

const pen = (points: [number, number][], size = 2, pressure = 0.5): InkStroke =>
  ({ tool: "pen", color: "ink", size, points: points.map(([x, y]) => ({ x, y, pressure })) });
const close = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} ≈ ${expected}`);

it("the zoom range is 25% to 800% and rejects non-finite values", () => {
  assert.equal(MIN_ZOOM, 0.25); assert.equal(MAX_ZOOM, 8);
  assert.equal(clampZoom(0.01), 0.25); assert.equal(clampZoom(50), 8); assert.equal(clampZoom(1.5), 1.5);
  assert.equal(clampZoom(NaN), 1); assert.equal(clampZoom(Infinity), 1);
});
it("screen and world coordinates round-trip through the camera", () => {
  const view = { zoom: 2.5, x: -40, y: 17 };
  const world = toWorld(view, 310, 92), screen = toScreen(view, world.x, world.y);
  close(screen.x, 310); close(screen.y, 92);
  assert.deepEqual(toWorld(HOME_VIEW, 12, 34), { x: 12, y: 34 });
  assert.deepEqual(panBy(view, 10, -5), { zoom: 2.5, x: -30, y: 12 });
});
it("zooming keeps the world point under the cursor in place and clamps at both ends", () => {
  const view = { zoom: 1, x: 30, y: -20 }, anchor = toWorld(view, 200, 150);
  const zoomed = zoomAt(view, 200, 150, 3);
  assert.equal(zoomed.zoom, 3);
  const after = toScreen(zoomed, anchor.x, anchor.y); close(after.x, 200); close(after.y, 150);
  const max = zoomAt(view, 200, 150, 1000); assert.equal(max.zoom, 8);
  const still = toScreen(max, anchor.x, anchor.y); close(still.x, 200); close(still.y, 150);
  assert.equal(zoomAt(view, 0, 0, 0.0001).zoom, 0.25);
  assert.ok(sameView(zoomAt(view, 77, 5, 1), view));
});
it("a two-finger pinch zooms by the finger distance and pans with the midpoint", () => {
  const start = { zoom: 1, x: 0, y: 0 };
  // Fingers 100px apart around (200, 200) spread to 200px apart around (260, 220).
  const view = pinchView(start, { x: 150, y: 200 }, { x: 250, y: 200 }, { x: 160, y: 220 }, { x: 360, y: 220 });
  assert.equal(view.zoom, 2);
  const anchor = toScreen(view, 200, 200); close(anchor.x, 260); close(anchor.y, 220);
  // Moving both fingers together is a pure pan.
  assert.deepEqual(pinchView(start, { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 30, y: 40 }, { x: 130, y: 40 }), { zoom: 1, x: 30, y: 40 });
  // The zoom clamps while the midpoint still tracks.
  const clamped = pinchView(start, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 }, { x: 1000, y: 0 });
  assert.equal(clamped.zoom, 8);
  // Coincident fingers cannot divide by zero.
  assert.equal(pinchView(start, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 90, y: 5 }).zoom, 1);
});
it("ctrl+wheel steps are exponential, symmetric and bounded per event", () => {
  close(wheelZoomFactor(0), 1);
  assert.ok(wheelZoomFactor(-10) > 1); assert.ok(wheelZoomFactor(10) < 1);
  close(wheelZoomFactor(-10) * wheelZoomFactor(10), 1);
  assert.equal(wheelZoomFactor(1e6), wheelZoomFactor(100)); assert.equal(wheelZoomFactor(-1e6), wheelZoomFactor(-100));
  assert.equal(wheelZoomFactor(1, 1), wheelZoomFactor(16));
  assert.deepEqual(wheelPan(10, -4), { x: -10, y: 4 }); assert.deepEqual(wheelPan(1, 2, 1), { x: -16, y: -32 });
});
it("zoom to fit centers the content, shrinks large sheets and never over-magnifies", () => {
  const viewport = { width: 1000, height: 800 };
  assert.deepEqual(fitView(undefined, viewport), { zoom: 1, x: 0, y: 0 });
  const large = fitView({ x: 0, y: 0, width: 3808, height: 1000 }, viewport);
  assert.equal(large.zoom, 0.25, "952px of room over 3808 units");
  close(toScreen(large, 1904, 500).x, 500); close(toScreen(large, 1904, 500).y, 400);
  const small = fitView({ x: 100, y: 100, width: 10, height: 10 }, viewport);
  assert.equal(small.zoom, MAX_FIT_ZOOM);
  close(toScreen(small, 105, 105).x, 500); close(toScreen(small, 105, 105).y, 400);
  assert.equal(fitView({ x: 0, y: 0, width: 1e6, height: 10 }, viewport).zoom, MIN_ZOOM);
});
it("a canvas painted for one camera is shown at another with one CSS transform", () => {
  const rendered = { zoom: 1.5, x: 20, y: -10 }, current = { zoom: 3, x: -200, y: 55 };
  const relative = relativeTransform(rendered, current);
  for (const [x, y] of [[0, 0], [123, -45], [-9, 800]] as const) {
    const painted = toScreen(rendered, x, y), wanted = toScreen(current, x, y);
    close(painted.x * relative.scale + relative.x, wanted.x); close(painted.y * relative.scale + relative.y, wanted.y);
  }
  assert.deepEqual(relativeTransform(rendered, rendered), { scale: 1, x: 0, y: 0 });
});
it("large photos are downscaled once for memory and placed at a workable sheet size", () => {
  // A 48 MP photo: 2400px raster, 1200 world units wide.
  const photo = placeBackground(8064, 6048);
  assert.deepEqual(photo.raster, { width: BACKGROUND_PIXEL_CAP, height: 1800 });
  assert.deepEqual(photo.world, { width: BACKGROUND_WORLD_CAP, height: 900 });
  // Portrait caps the longest side, not the width.
  assert.deepEqual(placeBackground(3000, 6000).raster, { width: 1200, height: 2400 });
  // Small images are never enlarged.
  assert.deepEqual(placeBackground(640, 480), { raster: { width: 640, height: 480 }, world: { width: 640, height: 480 } });
  // Vector figures are rasterized at twice their sheet size, within the same cap.
  assert.deepEqual(placeBackground(400, 300, true), { raster: { width: 1200, height: 900 }, world: { width: 600, height: 450 } });
  assert.deepEqual(placeBackground(4000, 1000, true), { raster: { width: 2400, height: 600 }, world: { width: 1200, height: 300 } });
  for (const [w, h] of [[0, 10], [10, 0], [NaN, 5], [Infinity, 5], [-4, 4]] as const) assert.throws(() => placeBackground(w, h), /no size/);
});
it("ink bounds include round caps and the pressure-dependent width", () => {
  assert.equal(inkBounds([]), undefined);
  // size 2 at mouse pressure paints 2 units wide: radius 1.
  assert.deepEqual(inkBounds([pen([[10, 20]])]), { x: 9, y: 19, width: 2, height: 2 });
  assert.deepEqual(inkBounds([pen([[0, 0], [100, 50]], 5)]), { x: -2.5, y: -2.5, width: 105, height: 55 });
  // Full pressure paints 1.6 × the size: radius 1.6 for size 2.
  const pressed = inkBounds([pen([[0, 0], [100, 50]], 2, 1)])!;
  close(pressed.x, -1.6); close(pressed.width, 103.2); close(pressed.height, 53.2);
  const highlighter: InkStroke = { tool: "highlighter", color: "orange", size: 20, points: [{ x: 0, y: 0, pressure: 1 }, { x: 50, y: 0, pressure: 0.1 }] };
  assert.deepEqual(inkBounds([highlighter]), { x: -10, y: -10, width: 70, height: 20 });
});
it("export crops tightly to background plus ink with padding, independent of the camera", () => {
  const ink = [pen([[100, 100], [300, 200]])];
  assert.equal(exportBounds(undefined, []), undefined, "an empty sheet sends nothing");
  assert.equal(exportBounds({ width: 800, height: 600 }, []), undefined, "a background without ink sends nothing");
  assert.deepEqual(exportBounds(undefined, ink), { x: 75, y: 75, width: 250, height: 150 });
  assert.deepEqual(exportBounds(undefined, ink, 0), { x: 99, y: 99, width: 202, height: 102 });
  // The whole background is included, and ink beyond it extends the crop.
  assert.deepEqual(exportBounds({ width: 800, height: 600 }, ink), { x: -24, y: -24, width: 848, height: 648 });
  assert.deepEqual(exportBounds({ width: 200, height: 150 }, [pen([[-50, 40], [400, 300]])]), { x: -75, y: -24, width: 500, height: 349 });
  assert.deepEqual(contentBounds({ width: 800, height: 600 }, []), { x: 0, y: 0, width: 800, height: 600 });
  assert.deepEqual(contentBounds({ width: 0, height: 0 }, ink), inkBounds(ink));
});
it("the export raster applies Image scale first and then the 2000 × 2000 cap", () => {
  const bounds = { x: 0, y: 0, width: 500, height: 300 };
  assert.deepEqual(exportRaster(bounds, 100), { width: 1000, height: 600 }, "two pixels per world unit at 100%");
  assert.deepEqual(exportRaster(bounds, 50), { width: 500, height: 300 });
  assert.deepEqual(exportRaster({ x: -9, y: 4, width: 6000, height: 4000 }, 100), { width: 2000, height: 1333 });
  assert.deepEqual(exportRaster({ x: 0, y: 0, width: 300, height: 9000 }, 50), { width: 67, height: 2000 });
  assert.deepEqual(exportRaster({ x: 0, y: 0, width: 4000, height: 4000 }, 100, 1568), { width: 1568, height: 1568 });
  assert.deepEqual(exportRaster({ x: 0, y: 0, width: 1, height: 1 }, 1), { width: 1, height: 1 });
  for (const [box, scale] of [[{ x: 0, y: 0, width: 0, height: 5 }, 50], [bounds, 0], [bounds, 101], [bounds, NaN], [{ x: NaN, y: 0, width: 5, height: 5 }, 50]] as const)
    assert.throws(() => exportRaster(box, scale), /has been kept/);
});
