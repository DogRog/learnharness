import { pointWidth, type InkStroke } from "./strokes.ts";

export interface Offset { x: number; y: number }
export interface Bounds extends Offset { width: number; height: number }
export interface Size { width: number; height: number }
/** The camera: screen = world × zoom + (x, y), in CSS pixels of the viewport. */
export interface View { zoom: number; x: number; y: number }

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 8;
/** Zoom to fit never magnifies small content beyond this. */
export const MAX_FIT_ZOOM = 2;
export const FIT_PADDING = 24;
export const EXPORT_PADDING = 24;
export const EXPORT_CAP = 2000;
/** Export density before Image scale: two pixels per world unit. */
export const EXPORT_PIXEL_RATIO = 2;
/** Longest side of a background raster kept in memory, in pixels. */
export const BACKGROUND_PIXEL_CAP = 2400;
/** Longest side of a background on the sheet, in world units. */
export const BACKGROUND_WORLD_CAP = 1200;
export const HOME_VIEW: Readonly<View> = Object.freeze({ zoom: 1, x: 0, y: 0 });

export function clampZoom(zoom: number): number {
  return Number.isFinite(zoom) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) : 1;
}
export function toWorld(view: View, x: number, y: number): Offset {
  return { x: (x - view.x) / view.zoom, y: (y - view.y) / view.zoom };
}
export function toScreen(view: View, x: number, y: number): Offset {
  return { x: x * view.zoom + view.x, y: y * view.zoom + view.y };
}
export function panBy(view: View, dx: number, dy: number): View {
  return { zoom: view.zoom, x: view.x + dx, y: view.y + dy };
}
/** Zoom by factor, keeping the world point under the screen point (x, y) in place. */
export function zoomAt(view: View, x: number, y: number, factor: number): View {
  const zoom = clampZoom(view.zoom * factor), world = toWorld(view, x, y);
  return { zoom, x: x - world.x * zoom, y: y - world.y * zoom };
}
/** Two-finger gesture from where it started: the world point under the first
 * midpoint follows the fingers, and the distance between them sets the zoom. */
export function pinchView(start: View, a0: Offset, b0: Offset, a1: Offset, b1: Offset): View {
  const before = Math.hypot(b0.x - a0.x, b0.y - a0.y), after = Math.hypot(b1.x - a1.x, b1.y - a1.y);
  const zoom = clampZoom(start.zoom * (before > 0 && after > 0 ? after / before : 1));
  const world = toWorld(start, (a0.x + b0.x) / 2, (a0.y + b0.y) / 2);
  return { zoom, x: (a1.x + b1.x) / 2 - world.x * zoom, y: (a1.y + b1.y) / 2 - world.y * zoom };
}
/** Ctrl+wheel and trackpad pinch: an exponential step, bounded per event. */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1);
  return Math.exp(-Math.max(-100, Math.min(100, pixels)) * 0.01);
}
export function wheelPan(deltaX: number, deltaY: number, deltaMode = 0): Offset {
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1;
  return { x: -deltaX * unit, y: -deltaY * unit };
}
/** Center the content in the viewport. Empty sheets return to the home view. */
export function fitView(content: Bounds | undefined, viewport: Size, padding = FIT_PADDING): View {
  if (!content || content.width <= 0 || content.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return { ...HOME_VIEW };
  const room = { width: Math.max(1, viewport.width - 2 * padding), height: Math.max(1, viewport.height - 2 * padding) };
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_FIT_ZOOM, room.width / content.width, room.height / content.height));
  return { zoom, x: viewport.width / 2 - (content.x + content.width / 2) * zoom,
    y: viewport.height / 2 - (content.y + content.height / 2) * zoom };
}
/** CSS transform (origin 0 0) that shows a canvas painted for `rendered` as `current`. */
export function relativeTransform(rendered: View, current: View): { scale: number; x: number; y: number } {
  const scale = current.zoom / rendered.zoom;
  return { scale, x: current.x - rendered.x * scale, y: current.y - rendered.y * scale };
}
export function sameView(a: View, b: View): boolean { return a.zoom === b.zoom && a.x === b.x && a.y === b.y; }

/** Downscale large photos once: `raster` is what is kept in memory, `world` its
 * size on the sheet. Vector figures are rasterized at twice their sheet size. */
export function placeBackground(naturalWidth: number, naturalHeight: number, vector = false): { raster: Size; world: Size } {
  if (!(naturalWidth > 0) || !(naturalHeight > 0) || !Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight))
    throw new Error("This image has no size and cannot be used as a background.");
  const longest = Math.max(naturalWidth, naturalHeight);
  const round = (size: Size) => ({ width: Math.max(1, Math.round(size.width)), height: Math.max(1, Math.round(size.height)) });
  if (vector) {
    const worldScale = Math.min(BACKGROUND_WORLD_CAP, Math.max(600, longest)) / longest;
    const world = { width: naturalWidth * worldScale, height: naturalHeight * worldScale };
    return { raster: round({ width: world.width * 2, height: world.height * 2 }), world: round(world) };
  }
  const rasterScale = Math.min(1, BACKGROUND_PIXEL_CAP / longest);
  const raster = round({ width: naturalWidth * rasterScale, height: naturalHeight * rasterScale });
  const worldScale = Math.min(1, BACKGROUND_WORLD_CAP / Math.max(raster.width, raster.height));
  return { raster, world: round({ width: raster.width * worldScale, height: raster.height * worldScale }) };
}

/** Includes round caps and each point's pressure-dependent painted extent. */
export function inkBounds(visible: readonly InkStroke[]): Bounds | undefined {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const stroke of visible) {
    for (const point of stroke.points) {
      const radius = pointWidth(stroke, point) / 2;
      left = Math.min(left, point.x - radius); top = Math.min(top, point.y - radius);
      right = Math.max(right, point.x + radius); bottom = Math.max(bottom, point.y + radius);
    }
  }
  return left === Infinity ? undefined : { x: left, y: top, width: right - left, height: bottom - top };
}
/** Everything on the sheet: the whole background (top-left at the origin) and all visible ink. */
export function contentBounds(background: Size | undefined, visible: readonly InkStroke[]): Bounds | undefined {
  const ink = inkBounds(visible);
  const image = background && background.width > 0 && background.height > 0 ? { x: 0, y: 0, ...background } : undefined;
  if (!ink) return image;
  if (!image) return ink;
  const x = Math.min(ink.x, image.x), y = Math.min(ink.y, image.y);
  return { x, y, width: Math.max(ink.x + ink.width, image.width) - x, height: Math.max(ink.y + ink.height, image.height) - y };
}
/** Tight crop for sending: independent of the camera and of erased history.
 * A sheet without visible ink exports nothing, even with a background. */
export function exportBounds(background: Size | undefined, visible: readonly InkStroke[], padding = EXPORT_PADDING): Bounds | undefined {
  if (!inkBounds(visible)) return undefined;
  const content = contentBounds(background, visible)!;
  const x = Math.floor(content.x - padding), y = Math.floor(content.y - padding);
  return { x, y, width: Math.ceil(content.x + content.width + padding) - x, height: Math.ceil(content.y + content.height + padding) - y };
}
/** Bound only the export raster, never world geometry or the camera. */
export function exportRaster(bounds: Bounds, imageScale: number, cap = EXPORT_CAP): Size {
  if (![bounds.x, bounds.y, bounds.width, bounds.height, imageScale, cap].every(Number.isFinite) ||
    bounds.width <= 0 || bounds.height <= 0 || imageScale <= 0 || imageScale > 100 || cap < 1)
    throw new Error("The sketch bounds cannot be exported. Your sketch has been kept.");
  const scale = Math.min(EXPORT_PIXEL_RATIO * imageScale / 100, cap / bounds.width, cap / bounds.height);
  return { width: Math.max(1, Math.min(cap, Math.round(bounds.width * scale))),
    height: Math.max(1, Math.min(cap, Math.round(bounds.height * scale))) };
}
