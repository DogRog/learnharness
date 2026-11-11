import type { SizeIndex } from "./strokes.ts";

export const PEN_WIDTHS = ["fine", "medium", "bold"] as const;
export type PenWidth = (typeof PEN_WIDTHS)[number];
export const PEN_WIDTH_LABELS: Readonly<Record<PenWidth, string>> = { fine: "Fine", medium: "Medium", bold: "Bold" };
export const DEFAULT_PEN_WIDTH: PenWidth = "medium";
export const DEFAULT_IMAGE_SCALE = 50;
export interface Settings { revision: number; penWidth: PenWidth; imageScale: number }
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({ revision: 0, penWidth: DEFAULT_PEN_WIDTH, imageScale: DEFAULT_IMAGE_SCALE });

export function penWidthIndex(width: PenWidth): SizeIndex { return PEN_WIDTHS.indexOf(width) as SizeIndex; }
export function penWidthError(value: unknown): string | undefined {
  return typeof value === "string" && (PEN_WIDTHS as readonly string[]).includes(value) ? undefined : "Choose Fine, Medium or Bold.";
}
export function parsePenWidth(value: unknown): PenWidth {
  const error = penWidthError(value);
  if (error) throw new Error(error);
  return value as PenWidth;
}
export function imageScaleError(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100
    ? undefined : "Enter a percentage greater than 0 and at most 100.";
}
export function parseImageScale(value: unknown): number {
  const error = imageScaleError(value);
  if (error) throw new Error(error);
  return value as number;
}
function single(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, key))
    throw new Error(`Expected a ${key} setting.`);
  return (value as Record<string, unknown>)[key];
}
export function parsePenWidthChange(value: unknown): PenWidth { return parsePenWidth(single(value, "penWidth")); }
export function parseImageScaleChange(value: unknown): number { return parseImageScale(single(value, "imageScale")); }
export function parseSettings(value: unknown): Settings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Sketchpad settings.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "revision" && key !== "penWidth" && key !== "imageScale") ||
    !Number.isSafeInteger(input.revision) || (input.revision as number) < 0) throw new Error("Invalid Sketchpad settings revision.");
  return { revision: input.revision as number, penWidth: parsePenWidth(input.penWidth), imageScale: parseImageScale(input.imageScale) };
}
