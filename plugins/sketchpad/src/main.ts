import type { PluginAction, PluginActionContext, PluginFrontendContext, PluginSettingsSchema, PluginSurfaceProps, PluginWidgetHandle } from "learnharness-plugin-api";
import { exportSheet } from "./export.ts";
import { SKETCH } from "./icons.ts";
import { sessionImages } from "./images.ts";
import { PEN_WIDTHS, PEN_WIDTH_LABELS, imageScaleError, parseSettings, penWidthError, penWidthIndex, type PenWidth, type Settings } from "./settings.ts";
import { mountSheet, type MountedSheet } from "./sheet.ts";
import { Sheets, type SessionSheet } from "./state.ts";
import { createSubmissionInterceptor } from "./submission.ts";

type SessionAction = Extract<PluginActionContext, { surface: "session" }>;
interface OpenPad {
  session: SessionSheet;
  controller: AbortController;
  handle?: PluginWidgetHandle<PluginSurfaceProps>;
  mounted?: MountedSheet;
  closed: boolean;
}
const SESSIONS = { sessions: ["teaching", "practice"] } as const;

export async function activate(ctx: PluginFrontendContext): Promise<() => void> {
  let disposed = false, open: OpenPad | undefined, current: Settings | undefined;
  let settings: PluginWidgetHandle<PluginSettingsSchema> | undefined;
  const cleanups: (() => void)[] = [];
  const live = () => !disposed && !ctx.signal.aborted;
  // Opaque public path strings are associated ONLY on an actual contextual click.
  // No route parsing or global-current-session inference is used for targeting.
  const pageSessions = new Map<string, string>();
  const sheets = new Sheets(() => { if (live()) { ctx.refreshActions(); ctx.refreshSubmissions(); } });
  function close(pad: OpenPad): void {
    if (pad.closed) return;
    pad.closed = true;
    if (open === pad) open = undefined;
    pad.mounted?.dispose(); pad.controller.abort(); pad.handle?.dispose();
  }
  function toggle(context: SessionAction): void {
    if (!context.view) throw new Error("This LearnHarness build does not expose the session view context required by Sketchpad.");
    const state = sheets.session(context.sessionId, context.kind);
    pageSessions.set(ctx.app.pathname(), state.id);
    const wasOpen = open?.session === state;
    if (open) close(open);
    if (wasOpen) return;
    const images = sessionImages(context.view.messages);
    const pad: OpenPad = { session: state, controller: new AbortController(), closed: false };
    open = pad;
    try {
      pad.handle = ctx.ui.openSurface(context.surfaceTarget, {
        title: "Sketchpad", background: "opaque",
        content(container, signal) {
          if (pad.closed || signal.aborted) return;
          const mounted = mountSheet(container, { ctx, sheets, state, images, signal });
          pad.mounted = mounted;
          return () => {
            mounted.dispose();
            // Content mounts can be replayed by the host (e.g. development
            // StrictMode). Only the latest, genuinely departed mount owns close.
            queueMicrotask(() => {
              if (pad.mounted !== mounted) return;
              pad.mounted = undefined;
              close(pad);
            });
          };
        },
        onClose: () => close(pad),
      }, { signal: pad.controller.signal });
      if (pad.closed) pad.handle.dispose();
    } catch (error) { close(pad); throw error; }
  }
  const action: PluginAction = {
    id: "sketch", icon: SKETCH,
    shortcut: { scope: SESSIONS, defaultBinding: "mod+shift+k" },
    // A readonly string accessor uses the public pathname and our click-time mapping.
    get name() {
      const id = pageSessions.get(ctx.app.pathname());
      const state = id ? sheets.sessions.get(id) : undefined;
      return state && sheets.pending(state) ? "Sketch (unsent)" : "Sketch";
    },
    run(context) { if (context.surface === "session") toggle(context); },
  };
  function editingPad(context: PluginActionContext): MountedSheet | undefined {
    if (!live() || context.surface !== "session" || !open || open.closed ||
      open.session.id !== context.sessionId || open.session.kind !== context.kind) return;
    return open.mounted;
  }
  // Unbound by default: Cmd/Ctrl+Z already belongs to Drawing Pad in the same pages.
  const undoAction: PluginAction = {
    id: "undo", name: "Undo sketch", shortcut: { scope: SESSIONS },
    disabled: context => !editingPad(context)?.canUndo(),
    run(context) { editingPad(context)?.undo(); },
  };
  const redoAction: PluginAction = {
    id: "redo", name: "Redo sketch", shortcut: { scope: SESSIONS },
    disabled: context => !editingPad(context)?.canRedo(),
    run(context) { editingPad(context)?.redo(); },
  };
  const rows = (value: Settings): PluginSettingsSchema["rows"] => [{
    key: "penWidth", type: "dropdown", label: "Default pen width", value: value.penWidth,
    options: PEN_WIDTHS.map(width => ({ value: width, label: PEN_WIDTH_LABELS[width] })),
    description: "The pen width a new sheet starts with. Sheets that are already open keep the width picked on them.",
    validate: penWidthError,
    async onChange(penWidth: string) { applySettings(await ctx.call("set-pen-width", { penWidth })); },
  }, {
    key: "imageScale", type: "number", label: "Image scale", value: value.imageScale, min: 0, max: 100,
    description: "Size of the image that is sent, as a percentage (default 50%). Applied before the fixed 2000 × 2000 pixel cap. Does not change the sheet.",
    validate: imageScaleError,
    async onChange(imageScale: number) { applySettings(await ctx.call("set-image-scale", { imageScale })); },
  }];
  function applySettings(value: unknown): void {
    if (!live()) return;
    const next = parseSettings(value);
    if (current && next.revision <= current.revision) return;
    current = next;
    sheets.setImageScale(next.imageScale); sheets.setPenWidth(penWidthIndex(next.penWidth as PenWidth));
    if (settings) settings.update({ rows: rows(next) });
    else settings = ctx.registerSettings({ rows: rows(next) });
  }
  let settingsRead: Promise<void> = Promise.resolve();
  function refreshSettings(): Promise<void> {
    settingsRead = settingsRead.catch(() => {}).then(async () => {
      if (live()) applySettings(await ctx.call("get-settings"));
    });
    return settingsRead;
  }
  const report = (error: unknown) => { if (live()) console.error("Sketchpad settings resync failed; keeping the current settings.", error); };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (open) close(open);
    for (const cleanup of cleanups.splice(0)) cleanup();
    settings?.dispose(); sheets.dispose(); pageSessions.clear();
  };
  ctx.cleanup(dispose);
  cleanups.push(ctx.onNotification(event => {
    if (event.pluginId === ctx.manifest.id && event.topic === "settings-changed") applySettings(event.data);
  }));
  cleanups.push(ctx.onResync(() => { void refreshSettings().catch(report); }));
  try {
    await refreshSettings();
    if (!live()) return dispose;
    cleanups.push(ctx.registerAction(action));
    cleanups.push(ctx.registerAction(undoAction));
    cleanups.push(ctx.registerAction(redoAction));
    cleanups.push(ctx.placeAction({ id: "session-sketch", actionId: "sketch", location: "top-bar", sessions: ["teaching", "practice"] }));
    cleanups.push(ctx.registerSubmissionInterceptor(createSubmissionInterceptor({
      sheets, active: live,
      flush(sessionId) { if (open?.session.id === sessionId) open.mounted?.flush(); },
      exportImage: (captured, signal) => exportSheet(captured, signal),
    })));
  } catch (error) { dispose(); throw error; }
  return dispose;
}
