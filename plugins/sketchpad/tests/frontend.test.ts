import assert from "node:assert/strict";
import { it } from "node:test";
import type { PluginAction, PluginActionContext, PluginFrontendContext, PluginNotification, PluginSettingsSchema, PluginSubmissionInterceptor, PluginSurfaceProps } from "learnharness-plugin-api";
import { activate } from "../src/main.ts";
function fixture() {
  const signal = new AbortController(), notifications = new Set<(event: PluginNotification) => void>(), resyncs = new Set<() => void>();
  const actions = new Map<string, PluginAction>(), placements: unknown[] = []; let schema: PluginSettingsSchema | undefined, surface: PluginSurfaceProps | undefined;
  let interceptor: PluginSubmissionInterceptor | undefined, closes = 0, disposedSettings = 0;
  let saved = { revision: 0, penWidth: "medium", imageScale: 50 };
  const calls: { name: string; value: unknown }[] = [];
  let read: () => unknown | Promise<unknown> = () => ({ ...saved });
  const ctx = {
    manifest: { id: "sketchpad" }, signal: signal.signal, cleanup() {},
    registerAction(action: PluginAction) { actions.set(action.id, action); return () => { actions.delete(action.id); }; },
    placeAction(placement: unknown) { placements.push(placement); return () => {}; },
    registerSubmissionInterceptor(value: PluginSubmissionInterceptor) { interceptor = value; return () => { interceptor = undefined; }; },
    refreshActions() {}, refreshSubmissions() {},
    registerSettings(value: PluginSettingsSchema) { schema = value; return { update(value: PluginSettingsSchema) { schema = value; }, dispose() { disposedSettings++; schema = undefined; } }; },
    async call(name: string, value: unknown) {
      calls.push({ name, value });
      if (name === "get-settings") return await read();
      if (name === "set-pen-width" || name === "set-image-scale") {
        saved = { ...saved, ...(value as Partial<typeof saved>), revision: saved.revision + 1 };
        return { ...saved };
      }
      throw new Error(name);
    },
    onNotification(fn: (event: PluginNotification) => void) { notifications.add(fn); return () => notifications.delete(fn); },
    onResync(fn: () => void) { resyncs.add(fn); return () => resyncs.delete(fn); },
    app: { pathname: () => "/opaque-path" },
    ui: { openSurface(_target: unknown, props: PluginSurfaceProps) { surface = props; return { update() {}, dispose() { closes++; surface = undefined; } }; } },
  } as unknown as PluginFrontendContext;
  return { ctx, actions, placements, signal, notifications, resyncs, calls,
    schema: () => schema, surface: () => surface, interceptor: () => interceptor, closes: () => closes, disposedSettings: () => disposedSettings,
    setRead(fn: typeof read) { read = fn; },
    notify(value: unknown) { for (const fn of notifications) fn({ pluginId: "sketchpad", topic: "settings-changed", data: value }); },
  };
}
const session = (sessionId = "a", kind: "teaching" | "practice" = "teaching") => ({ placement: "keyboard", surface: "session", sessionId, kind, surfaceTarget: {},
  view: { messages: [], input: { type: "text" } } }) as unknown as PluginActionContext;

it("activates without browser globals and registers its action, placement, interceptor and settings", async () => {
  const f = fixture(), off = await activate(f.ctx);
  try {
    const sketch = f.actions.get("sketch")!;
    assert.equal(sketch.name, "Sketch"); assert.ok(sketch.icon?.startsWith("<svg"));
    assert.deepEqual(sketch.shortcut, { scope: { sessions: ["teaching", "practice"] }, defaultBinding: "mod+shift+k" });
    assert.notEqual(sketch.shortcut!.defaultBinding, "mod+shift+d", "Drawing Pad keeps its own shortcut");
    assert.deepEqual(f.placements, [{ id: "session-sketch", actionId: "sketch", location: "top-bar", sessions: ["teaching", "practice"] }]);
    assert.equal(f.interceptor()!.id, "sketch"); assert.equal(f.interceptor()!.priority, 0);
    assert.deepEqual(f.schema()!.rows.map(row => [row.type, row.label, row.value]), [["dropdown", "Default pen width", "medium"], ["number", "Image scale", 50]]);
  } finally { off(); }
});
it("Undo and Redo are rebindable actions without a default that could collide with Drawing Pad's Cmd/Ctrl+Z", async () => {
  const f = fixture(), off = await activate(f.ctx);
  try {
    for (const id of ["undo", "redo"]) {
      const action = f.actions.get(id)!;
      assert.deepEqual(action.shortcut, { scope: { sessions: ["teaching", "practice"] } });
      assert.equal((action.disabled as (context: PluginActionContext) => boolean)(session()), true, "nothing to edit while closed");
      await action.run(session());
      assert.equal((action.disabled as (context: PluginActionContext) => boolean)({ placement: "keyboard", surface: "app", pathname: "/" }), true);
    }
    assert.equal(f.surface(), undefined);
  } finally { off(); }
});
it("Sketch toggles one opaque surface per session and replaces another session's surface", async () => {
  const f = fixture(), off = await activate(f.ctx);
  try {
    const sketch = f.actions.get("sketch")!;
    await sketch.run(session()); assert.equal(f.surface()?.title, "Sketchpad"); assert.equal(f.surface()?.background, "opaque");
    await sketch.run(session()); assert.equal(f.surface(), undefined); assert.equal(f.closes(), 1);
    await sketch.run(session("a")); await sketch.run(session("b", "practice"));
    assert.equal(f.closes(), 2, "the first session's surface is closed"); assert.equal(f.surface()?.title, "Sketchpad");
    await sketch.run({ placement: "keyboard", surface: "app", pathname: "/" }); assert.equal(f.closes(), 2);
    assert.throws(() => sketch.run({ ...session(), view: undefined } as unknown as PluginActionContext), /session view context/);
  } finally { off(); }
});
it("settings rows validate, save through the backend and show only accepted values", async () => {
  const f = fixture(), off = await activate(f.ctx);
  try {
    const [width, scale] = f.schema()!.rows;
    assert.ok(width!.validate?.("huge" as never)); assert.equal(width!.validate?.("bold" as never), undefined);
    await width!.onChange("bold" as never);
    assert.deepEqual(f.calls.at(-1), { name: "set-pen-width", value: { penWidth: "bold" } }); assert.equal(f.schema()!.rows[0]!.value, "bold");
    assert.ok(scale!.validate?.(0 as never)); assert.equal(scale!.validate?.(25 as never), undefined);
    await scale!.onChange(25 as never); assert.equal(f.schema()!.rows[1]!.value, 25);
    f.notify({ revision: 9, penWidth: "fine", imageScale: 100 }); f.notify({ revision: 3, penWidth: "bold", imageScale: 10 });
    assert.deepEqual(f.schema()!.rows.map(row => row.value), ["fine", 100], "an older notification cannot replace a newer value");
    f.setRead(() => ({ revision: 0, penWidth: "medium", imageScale: 50 }));
    for (const fn of f.resyncs) fn(); await new Promise<void>(resolve => setTimeout(resolve, 0));
    assert.deepEqual(f.schema()!.rows.map(row => row.value), ["fine", 100]);
  } finally { off(); }
});
it("disposal removes registrations and listeners exactly once and closes an open surface", async () => {
  const f = fixture(), off = await activate(f.ctx);
  await f.actions.get("sketch")!.run(session()); off(); off();
  assert.equal(f.actions.size, 0); assert.equal(f.notifications.size, 0); assert.equal(f.resyncs.size, 0);
  assert.equal(f.interceptor(), undefined); assert.equal(f.disposedSettings(), 1); assert.equal(f.closes(), 1);
});
it("late initial settings after activation cancellation cannot create UI registrations", async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.setRead(() => new Promise(resolve => { finish = resolve; }));
  const activating = activate(f.ctx); await new Promise<void>(resolve => queueMicrotask(resolve));
  f.signal.abort(); finish({ revision: 0, penWidth: "medium", imageScale: 50 }); const off = await activating;
  assert.equal(f.actions.size, 0); assert.equal(f.schema(), undefined); off();
});
