/** Stroke model and painting. Pressure-sensitive segments and whole-stroke
 * segment-distance erasing are adapted from Drawing Pad (see THIRD-PARTY.md).
 * Coordinates are world units: one unit is one CSS pixel at 100% zoom. */
export interface Point { x: number; y: number; pressure: number }
export type InkTool = "pen" | "highlighter";
export type Tool = InkTool | "eraser";
export const COLOR_KEYS = ["ink", "red", "blue", "green", "orange"] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];
export interface InkStroke { tool: InkTool; color: ColorKey; size: number; points: Point[] }
/** size is the hit radius in world units, frozen when the gesture started. */
export interface EraserStroke { tool: "eraser"; size: number; points: Point[] }
export type Stroke = InkStroke | EraserStroke;

/** Three widths per ink tool, in world units at mouse pressure. */
export const PEN_SIZES = [2, 3.5, 6] as const;
export const HIGHLIGHTER_SIZES = [14, 22, 34] as const;
export const HIGHLIGHTER_ALPHA = 0.35;
export const ERASER_RADIUS = 10;
export type SizeIndex = 0 | 1 | 2;
export function sizeFor(tool: InkTool, index: SizeIndex): number {
  return (tool === "pen" ? PEN_SIZES : HIGHLIGHTER_SIZES)[index];
}

/** A pen at mouse pressure (0.5) paints exactly its size; a highlighter ignores pressure. */
export function pointWidth(stroke: InkStroke, point: Point): number {
  return stroke.tool === "highlighter" ? stroke.size : stroke.size * (0.4 + 1.2 * point.pressure);
}
export function segmentWidth(stroke: InkStroke, a: Point, b: Point): number {
  return (pointWidth(stroke, a) + pointWidth(stroke, b)) / 2;
}
function pointSegmentDistanceSquared(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return (point.x - a.x - t * dx) ** 2 + (point.y - a.y - t * dy) ** 2;
}
function segmentDistanceSquared(a: Point, b: Point, c: Point, d: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, ex = d.x - c.x, ey = d.y - c.y;
  const determinant = dx * ey - dy * ex;
  if (determinant !== 0) {
    const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / determinant;
    const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / determinant;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(pointSegmentDistanceSquared(a, c, d), pointSegmentDistanceSquared(b, c, d),
    pointSegmentDistanceSquared(c, a, b), pointSegmentDistanceSquared(d, a, b));
}
function touchesStroke(stroke: InkStroke, eraser: EraserStroke): boolean {
  for (let i = 0; i < stroke.points.length; i++) {
    const a = stroke.points[Math.max(0, i - 1)]!, b = stroke.points[i]!;
    const radius = eraser.size + segmentWidth(stroke, a, b) / 2;
    for (let j = 0; j < eraser.points.length; j++) {
      const c = eraser.points[Math.max(0, j - 1)]!, d = eraser.points[j]!;
      if (segmentDistanceSquared(a, b, c, d) <= radius * radius) return true;
    }
  }
  return false;
}
const visibleCache = new WeakMap<readonly Stroke[], InkStroke[]>();
/** Eraser gestures stay in history, so Undo restores the complete strokes they removed. */
export function visibleStrokes(history: readonly Stroke[]): InkStroke[] {
  const cached = visibleCache.get(history);
  if (cached) return cached;
  let visible: InkStroke[] = [];
  for (const stroke of history) {
    if (stroke.tool === "eraser") visible = visible.filter(ink => !touchesStroke(ink, stroke));
    else if (stroke.points.length) visible.push(stroke);
  }
  visibleCache.set(history, visible);
  return visible;
}
/** History-only edits (or Undo back to the sent sketch) are not new image content. */
export function inkSignature(history: readonly Stroke[]): string {
  const visible = visibleStrokes(history);
  return visible.length ? JSON.stringify(visible.map(stroke => [stroke.tool, stroke.color, stroke.size, stroke.points])) : "";
}

type Context = CanvasRenderingContext2D;
/** Paint the pen stroke from point index `from` on. Every point is a disc of its
 * pressure-dependent width and every segment the quad between two discs, all in
 * ONE filled path: edges are antialiased once, so joints do not bead, and a
 * stroke costs one fill. Opaque, so a growing stroke can be painted in batches. */
export function paintPen(context: Context, stroke: InkStroke, color: string, from = 0): void {
  const points = stroke.points;
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  context.fillStyle = color;
  context.beginPath();
  for (let i = Math.max(0, from); i < points.length; i++) {
    const b = points[i]!, rb = pointWidth(stroke, b) / 2;
    context.moveTo(b.x + rb, b.y); context.arc(b.x, b.y, rb, 0, Math.PI * 2);
    if (i === 0) continue;
    const a = points[i - 1]!, ra = pointWidth(stroke, a) / 2, dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    if (!length) continue;
    // Same winding as the discs, so the nonzero fill is their union.
    const nx = -dy / length, ny = dx / length;
    context.moveTo(a.x + nx * ra, a.y + ny * ra); context.lineTo(a.x - nx * ra, a.y - ny * ra);
    context.lineTo(b.x - nx * rb, b.y - ny * rb); context.lineTo(b.x + nx * rb, b.y + ny * rb); context.closePath();
  }
  context.fill();
}
/** One path per stroke: a highlighter never darkens where it crosses itself. */
export function paintHighlighter(context: Context, stroke: InkStroke, color: string): void {
  const first = stroke.points[0];
  if (!first) return;
  context.globalAlpha = HIGHLIGHTER_ALPHA;
  context.globalCompositeOperation = "source-over";
  context.strokeStyle = color; context.fillStyle = color;
  context.lineCap = "round"; context.lineJoin = "round"; context.lineWidth = stroke.size;
  context.beginPath();
  if (stroke.points.every(point => point.x === first.x && point.y === first.y)) {
    context.arc(first.x, first.y, stroke.size / 2, 0, Math.PI * 2); context.fill();
  } else {
    context.moveTo(first.x, first.y);
    for (let i = 1; i < stroke.points.length; i++) context.lineTo(stroke.points[i]!.x, stroke.points[i]!.y);
    context.stroke();
  }
  context.globalAlpha = 1;
}
/** Highlighter first, pen on top, whatever order they were drawn in. The caller owns the transform. */
export function paintInk(context: Context, visible: readonly InkStroke[], colors: Readonly<Record<ColorKey, string>>): void {
  for (const stroke of visible) if (stroke.tool === "highlighter") paintHighlighter(context, stroke, colors[stroke.color]);
  for (const stroke of visible) if (stroke.tool === "pen") paintPen(context, stroke, colors[stroke.color]);
}
