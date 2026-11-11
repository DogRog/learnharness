import { EXPORT_CAP, exportBounds, exportRaster } from "./geometry.ts";
import type { Capture } from "./state.ts";
import { paintInk, visibleStrokes } from "./strokes.ts";
import { appMode, inkColors, sheetBackground } from "./theme.ts";

export interface ExportedImage { type: "image"; mimeType: "image/png"; data: string }
export interface ExportOptions { cap?: number; imageScale?: number }

function hasVisibleInk(canvas: HTMLCanvasElement): boolean {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not read the sketch canvas.");
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 3; index < pixels.length; index += 4) if (pixels[index]! > 0) return true;
  return false;
}
/** One PNG from one immutable snapshot: page color, background image, then ink.
 * Tightly cropped with padding and capped; no toolbar and no camera extent. */
export function exportSheet(captured: Capture, signal: AbortSignal, options: ExportOptions = {}): ExportedImage {
  signal.throwIfAborted();
  const draft = captured.draft, visible = visibleStrokes(draft.strokes);
  const bounds = exportBounds(draft.background, visible);
  if (!bounds) throw new Error("No visible ink could be captured. Your sketch has been kept.");
  const raster = exportRaster(bounds, options.imageScale ?? captured.imageScale, options.cap ?? EXPORT_CAP);
  const sx = raster.width / bounds.width, sy = raster.height / bounds.height;
  const ink = document.createElement("canvas"); ink.width = raster.width; ink.height = raster.height;
  const inkContext = ink.getContext("2d", { willReadFrequently: true });
  if (!inkContext) throw new Error("Could not export your sketch. Your sketch has been kept.");
  inkContext.setTransform(sx, 0, 0, sy, -bounds.x * sx, -bounds.y * sy);
  paintInk(inkContext, visible, inkColors(appMode()));
  if (!hasVisibleInk(ink)) throw new Error("No visible ink could be captured at the export resolution. Your sketch has been kept.");
  const combined = document.createElement("canvas"); combined.width = raster.width; combined.height = raster.height;
  const context = combined.getContext("2d");
  if (!context) throw new Error("Could not export your sketch. Your sketch has been kept.");
  context.fillStyle = sheetBackground(); context.fillRect(0, 0, combined.width, combined.height);
  if (draft.background) {
    context.setTransform(sx, 0, 0, sy, -bounds.x * sx, -bounds.y * sy);
    context.imageSmoothingQuality = "high";
    context.drawImage(draft.background.source as CanvasImageSource, 0, 0, draft.background.width, draft.background.height);
    context.resetTransform();
  }
  context.drawImage(ink, 0, 0);
  const data = combined.toDataURL("image/png").split(",")[1];
  if (!data) throw new Error("Could not encode your sketch. Your sketch has been kept.");
  return { type: "image", mimeType: "image/png", data };
}
