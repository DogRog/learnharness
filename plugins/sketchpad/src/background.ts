import { abortable } from "./abort.ts";
import { placeBackground } from "./geometry.ts";
import { figureMarkup, type SessionImage } from "./images.ts";
import type { Background } from "./state.ts";

export type LoadedBackground = Omit<Background, "id"> & { readonly source: HTMLCanvasElement };

/** Decode once, downscale to the memory cap, and keep only that raster.
 * Vector figures get a white page, the convention they are authored for. */
export async function loadBackground(blob: Blob, label: string, signal: AbortSignal, vector = false): Promise<LoadedBackground> {
  signal.throwIfAborted();
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image(); image.decoding = "async"; image.src = url;
    try { await abortable(image.decode(), signal); }
    catch (error) { if (signal.aborted) throw error; throw new Error("This file could not be read as an image."); }
    const { raster, world } = placeBackground(image.naturalWidth, image.naturalHeight, vector);
    const canvas = document.createElement("canvas"); canvas.width = raster.width; canvas.height = raster.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Drawing is unavailable in this browser.");
    if (vector) { context.fillStyle = "#ffffff"; context.fillRect(0, 0, raster.width, raster.height); }
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, raster.width, raster.height);
    // A raster the browser refuses to read back could never be exported with the ink.
    try { context.getImageData(0, 0, 1, 1); } catch { throw new Error("This image cannot be drawn on in this browser."); }
    return { source: canvas, width: world.width, height: world.height, label };
  } finally { URL.revokeObjectURL(url); }
}
export function sessionImageBlob(image: SessionImage): { blob: Blob; vector: boolean } {
  if (image.kind === "figure") return { blob: new Blob([figureMarkup(image.svg).svg], { type: "image/svg+xml" }), vector: true };
  const binary = atob(image.data), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { blob: new Blob([bytes], { type: image.mimeType }), vector: false };
}
