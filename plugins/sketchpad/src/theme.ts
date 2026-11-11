import type { ColorKey } from "./strokes.ts";

export type Mode = "dark" | "light";
/** The selected app theme (html.light / html.dark), not the operating system's preference. */
export function appMode(): Mode {
  return typeof document !== "undefined" && document.documentElement.classList.contains("light") ? "light" : "dark";
}
/** The default ink follows the theme: white on dark, black on light. The four
 * accent colors are mid-tones that stay readable on both. */
export function inkColors(mode: Mode): Record<ColorKey, string> {
  return { ink: mode === "light" ? "#000000" : "#ffffff", red: "#e5484d", blue: "#3b82f6", green: "#2fa84f", orange: "#f08c00" };
}
export const COLOR_LABELS: Readonly<Record<ColorKey, string>> = { ink: "Default ink", red: "Red", blue: "Blue", green: "Green", orange: "Orange" };
/** The app's page background as a canvas-ready color, resolved by the browser. */
export function sheetBackground(): string {
  const fallback = appMode() === "light" ? "#ffffff" : "#141414";
  if (typeof document === "undefined" || !document.body) return fallback;
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:-100000px;top:0;width:1px;height:1px;pointer-events:none;background:var(--background)";
  document.body.append(probe);
  try {
    const color = getComputedStyle(probe).backgroundColor;
    return !color || color === "transparent" || /^rgba\(0, 0, 0, 0\)$/.test(color) ? fallback : color;
  } finally { probe.remove(); }
}
