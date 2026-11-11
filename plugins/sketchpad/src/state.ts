import type { View } from "./geometry.ts";
import { DEFAULT_IMAGE_SCALE, DEFAULT_PEN_WIDTH, penWidthIndex } from "./settings.ts";
import { inkSignature, visibleStrokes, type ColorKey, type InkTool, type SizeIndex, type Stroke, type Tool } from "./strokes.ts";

/** An image under the ink, top-left at the world origin. `source` is a browser
 * raster owned by this window; state logic never looks inside it. */
export interface Background { readonly id: number; readonly width: number; readonly height: number; readonly label: string; readonly source: unknown }
export interface Draft {
  readonly id: number;
  readonly revision: number;
  /** History in drawing order, eraser gestures included. */
  readonly strokes: Stroke[];
  /** Undone entries, most recently undone last. Any new stroke empties it. */
  readonly redo: Stroke[];
  readonly background?: Background;
  readonly hasInk: boolean;
}
export interface SessionSheet {
  readonly id: string;
  readonly kind: "teaching" | "practice";
  draft: Draft;
  tool: Tool;
  colors: Record<InkTool, ColorKey>;
  sizes: Record<InkTool, SizeIndex>;
  /** Unset until the sheet is first shown, and again after a sent sheet is replaced. */
  view?: View;
  sentSignature: string;
}
export interface Capture { session: SessionSheet; draft: Draft; signature: string; imageScale: number; sendImage: boolean }

/** Window-owned only. No storage, navigation parsing, or host input reconstruction. */
export class Sheets {
  readonly sessions = new Map<string, SessionSheet>();
  imageScale = DEFAULT_IMAGE_SCALE;
  penWidth: SizeIndex = penWidthIndex(DEFAULT_PEN_WIDTH);
  /** A window preference, kept while the app window lives. */
  fullscreen = false;
  private nextId = 0;
  private readonly listeners = new Set<() => void>();
  private readonly signatures = new WeakMap<Draft, string>();
  constructor(private readonly changed: () => void = () => {}) {}
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** Content changed: what is pending for the next submission may differ. */
  private publish(): void { this.changed(); this.touch(); }
  /** Tool, color, width, camera and window preferences: repaint only, no host refresh. */
  private touch(): void { for (const listener of [...this.listeners]) listener(); }
  private blank(): Draft { return { id: ++this.nextId, revision: 0, strokes: [], redo: [], hasInk: false }; }
  private edit(state: SessionSheet, change: Partial<Pick<Draft, "strokes" | "redo" | "background">>): void {
    const next = { ...state.draft, ...change, revision: state.draft.revision + 1 };
    state.draft = { ...next, hasInk: visibleStrokes(next.strokes).length > 0 };
    this.publish();
  }
  session(id: string, kind: SessionSheet["kind"]): SessionSheet {
    let state = this.sessions.get(id);
    if (!state) {
      state = { id, kind, draft: this.blank(), tool: "pen", colors: { pen: "ink", highlighter: "orange" },
        sizes: { pen: this.penWidth, highlighter: 1 }, sentSignature: "" };
      this.sessions.set(id, state);
    }
    if (state.kind !== kind) throw new Error("Sketch session kind changed.");
    return state;
  }
  /** Delivery resolution and the default width are not sketch edits. */
  setImageScale(imageScale: number): void { this.imageScale = imageScale; }
  /** Applies to sheets created afterwards; open sheets keep the width picked on them. */
  setPenWidth(index: SizeIndex): void { this.penWidth = index; }
  setFullscreen(fullscreen: boolean): void { if (this.fullscreen !== fullscreen) { this.fullscreen = fullscreen; this.touch(); } }
  addStroke(state: SessionSheet, stroke: Stroke): void {
    if (stroke.points.length) this.edit(state, { strokes: [...state.draft.strokes, stroke], redo: [] });
  }
  canUndo(state: SessionSheet): boolean { return state.draft.strokes.length > 0; }
  canRedo(state: SessionSheet): boolean { return state.draft.redo.length > 0; }
  undo(state: SessionSheet): void {
    const { strokes, redo } = state.draft, last = strokes.at(-1);
    if (last) this.edit(state, { strokes: strokes.slice(0, -1), redo: [...redo, last] });
  }
  redo(state: SessionSheet): void {
    const { strokes, redo } = state.draft, next = redo.at(-1);
    if (next) this.edit(state, { strokes: [...strokes, next], redo: redo.slice(0, -1) });
  }
  /** Removes ink and its history. The background stays until it is removed or replaced. */
  clear(state: SessionSheet): void {
    if (state.draft.strokes.length || state.draft.redo.length) this.edit(state, { strokes: [], redo: [] });
  }
  setBackground(state: SessionSheet, background: Omit<Background, "id"> | undefined): void {
    if (!background && !state.draft.background) return;
    this.edit(state, { background: background ? { ...background, id: ++this.nextId } : undefined });
  }
  /** Tool, color, width and camera changes are not content edits and cannot invalidate an acceptance. */
  setTool(state: SessionSheet, tool: Tool): void { if (state.tool !== tool) { state.tool = tool; this.touch(); } }
  private inkTool(state: SessionSheet): InkTool {
    if (state.tool === "eraser") state.tool = "pen";
    return state.tool;
  }
  setColor(state: SessionSheet, color: ColorKey): void {
    const tool = this.inkTool(state);
    state.colors = { ...state.colors, [tool]: color }; this.touch();
  }
  setSize(state: SessionSheet, size: SizeIndex): void {
    const tool = this.inkTool(state);
    state.sizes = { ...state.sizes, [tool]: size }; this.touch();
  }
  setView(state: SessionSheet, view: View): void { state.view = view; this.touch(); }
  signature(state: SessionSheet): string {
    const draft = state.draft;
    if (!draft.hasInk) return "";
    const cached = this.signatures.get(draft);
    if (cached !== undefined) return cached;
    const ink = inkSignature(draft.strokes);
    const signature = ink ? `${draft.id}:${draft.background?.id ?? 0}:${ink}` : "";
    this.signatures.set(draft, signature);
    return signature;
  }
  /** Teaching sheets send whenever they hold ink; practice sheets only when the visible sketch changed. */
  pending(state: SessionSheet): boolean {
    const signature = this.signature(state);
    return !!signature && (state.kind === "teaching" || signature !== state.sentSignature);
  }
  capture(state: SessionSheet): Capture {
    const signature = this.signature(state);
    return { session: state, draft: state.draft, imageScale: this.imageScale, signature,
      sendImage: !!signature && (state.kind === "teaching" || signature !== state.sentSignature) };
  }
  accepted(captured: Capture): void {
    const state = captured.session;
    if (this.sessions.get(state.id) !== state || state.draft.id !== captured.draft.id || !captured.sendImage) return;
    if (state.kind === "practice") { state.sentSignature = captured.signature; this.publish(); return; }
    // Teaching: start a fresh sheet, unless the learner kept drawing while the message was on its way.
    if (state.draft.revision !== captured.draft.revision) return;
    state.draft = this.blank(); state.view = undefined; state.sentSignature = "";
    this.publish();
  }
  dispose(): void { this.sessions.clear(); this.listeners.clear(); }
}
