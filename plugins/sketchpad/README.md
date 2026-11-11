# Sketchpad

A trusted-local Core LearnHarness plugin: a blank, zoomable sheet for Apple Pencil,
other styluses and the mouse. Draw, highlight, put a photo or a session image under
the ink, send the sketch with your next message, or have a vision model read your
handwriting into LaTeX/Markdown text.

Requires the public [session-view context](../../docs/plugin-view-context.md),
[scoped action shortcuts](../../docs/plugin-authoring.md#action-shortcuts), surfaces,
learner-submission interception and the backend model service (`ctx.inference`).
A version number alone does not establish capabilities; use host documentation/types
matching the target app.

Sketchpad is separate from [Drawing Pad](../drawing-pad/), which draws over the
current question. Both can be enabled together; see [Sending](#sending).

## Core plugin and source reference

Core plugins are off until you turn them on. Enable Sketchpad in
**Settings → Core plugins**. The app supplies and updates its code; writable
preferences live under `<learning data>/core-plugin-data/sketchpad/`.
`sketchpad` is a reserved Core ID even when disabled or missing. A Community fork
needs its own manifest/folder ID. Do not install this build into a Community
`plugins/sketchpad/` folder.

## Behavior

### Opening and closing

- **Sketch** in the top bar of teaching and practice sessions opens and closes the
  sheet. **Sketch (unsent)** means the sheet holds ink that will be attached to your
  next message in that session.
- The sheet starts blank. Each session has its own sheet. Closing with the top-bar
  button, the X or Escape keeps everything: ink, undo history, background, tool,
  colors, widths and the zoom/pan position come back when you reopen it.
- Sheets live in this app window's memory only. Reloading the page, restarting the
  app or disabling the plugin loses unsent sketches. Nothing is written to disk.

### Drawing

- **Apple Pencil / stylus and mouse draw.** Pencil pressure changes the line width;
  the mouse draws at a fixed middle pressure.
- **Fingers never draw.** One finger pans, two fingers pinch to zoom and pan.
- Zoom range is 25% to 800%; the current zoom is shown in the bottom-left corner.
- Mouse and trackpad: **Ctrl/Cmd + wheel** (or a trackpad pinch) zooms at the
  pointer, the wheel alone pans, and dragging with the right or middle mouse
  button pans with any tool selected.
- Lines are stored as strokes, so they stay sharp at every zoom level.

### Toolbar

Every control is at least 44 × 44 CSS pixels and has an accessible name.

| Group | Controls |
| --- | --- |
| Tool | **Pen**, **Highlighter** (wide and translucent, always painted under pen ink), **Eraser** (removes whole strokes it touches) |
| Color | **Default ink** (white in dark mode, black in light mode), **Red**, **Blue**, **Green**, **Orange** |
| Width | **Fine**, **Medium**, **Bold** |
| History | **Undo**, **Redo**, **Clear** (asks first) |
| Sheet | **Background**, **Zoom to fit**, **Convert to LaTeX**, **Full screen** |

- Pen and Highlighter each remember their own color and width.
- A stylus eraser tip or a held barrel button erases without switching tools.
- Erasing is an undo step: Undo brings back the complete strokes an eraser pass removed.
- **Clear** removes all ink and its undo history after a confirmation. It keeps the
  background.
- **Zoom to fit** centers everything on the sheet (background and ink). It never
  magnifies beyond 200%. An empty sheet returns to 100%.
- **Full screen** makes the sheet cover the whole app window, including the sidebar
  and top bar. It is a layout change inside the page, not the browser's full-screen
  mode, so it works in Safari on iPad. Press the button again to leave.

### Background image

**Background** opens a small menu:

- **Choose photo or file** opens the system picker for images (on iPad: Photo
  Library, Take Photo, or Files).
- **From this session** lists up to 12 recent images from the session: images you
  sent, images in tool results and tutor figures (SVG).
- **Remove background** takes the image away and keeps the ink.

Large photos are downscaled once when they are loaded: the longest side is capped at
2400 pixels in memory and 1200 units on the sheet. The image sits with its top-left
corner at the sheet origin and moves and zooms together with the ink. A background
alone is never sent; there must be ink.

PDF pages are not offered. The public plugin API can turn a document into Markdown
text but cannot render a page as an image. Files you attached with the paperclip are
not offered either, because the session only records them as file paths.

### Sending

- The sketch is attached as one PNG to your next message in that session: an ordinary
  message, practice thinking, a built-in answer, a custom-question answer or a
  custom-problem submission. Text, selections and images that are already part of the
  message are not changed.
- The PNG contains the page color, the whole background image and all visible ink,
  cropped tightly with 24 units of padding. It does not depend on what is on screen:
  ink outside the current view is included, and the toolbar is not.
- Size: two pixels per sheet unit, multiplied by **Image scale**, then reduced if
  needed to stay within the fixed **2000 × 2000 pixel cap**.
- **Teaching:** once the app confirms it accepted the message, the sheet starts over
  blank (ink, background and zoom/pan). If you kept drawing while the message was on
  its way, the sheet is kept.
- **Practice:** the sheet and its undo history are kept across submissions. The image
  is sent again only when the visible sketch differs from the one last accepted.
  Undo back to the sent sketch does not resend it.
- A failed, refused or cancelled message leaves the sheet exactly as it was.
- **With Drawing Pad:** both plugins attach their own image to the same message. The
  host runs Drawing Pad first, then Sketchpad, and each appends without touching the
  other's image. The host's image limits and text-only-model refusals still apply.

### Convert to LaTeX

**Convert to LaTeX** sends a picture of the current sheet to the model chosen in
**Settings → Agent → Vision** and asks for a faithful transcription:

- Mathematics becomes LaTeX inside Markdown (`$...$`, `$$...$$`).
- Ordinary words stay as written, in their language. German stays German.
- Nothing is solved, corrected or completed. Unreadable parts are marked `[unreadable]`.

The result opens in a side panel with an editable text box and a rendered preview.
Check it, fix anything that was misread, then press **Copy text** and paste it into
your message. **Convert again** makes a new request; **Close** cancels a running one.

- Plugins cannot type into the message box, so the text goes to the clipboard.
  The panel says so.
- Converting does not remove the sketch. It is still attached to your next message.
  Clear the sheet first if you only want to send the text.
- If no Vision model is set, or the chosen model cannot read images, the panel says
  what to change. No other model is used instead.
- Each press is one model request and is billed like any other request to that model.

### Theme

The sheet follows the app theme (`html.light` / `html.dark`), not the OS setting.
Default ink is white on a dark sheet and black on a light sheet, and switches when
the theme changes while the sheet is open. Red, blue, green and orange stay the same.
Images that were already sent do not change.

## Keyboard shortcuts

Settings → Keyboard → Sketchpad lists the actions. They use the host's shared
action/shortcut registry, so Rebind, Clear and Reset work without reloading.

| Action | Default |
| --- | --- |
| Sketch (open/close) | Cmd/Ctrl+Shift+K |
| Undo sketch | none |
| Redo sketch | none |

All three are scoped to teaching and practice pages. Undo and Redo have no default
key because Cmd/Ctrl+Z belongs to Drawing Pad on the same pages; bind them yourself
if you want them. They only act while the sheet for that session is open.
Escape closes the sheet (handled by the host).

## Settings

Settings → Sketchpad:

- **Default pen width**: Fine, Medium (default) or Bold. The width a new sheet starts
  with. Sheets that are already open keep the width picked on them.
- **Image scale**: default **50%**; a percentage greater than 0 and at most 100.
  Sets the size of the image that is sent, before the fixed 2000 × 2000 cap. It never
  changes the sheet or the strokes. Convert to LaTeX ignores it and always uses a
  sharp image of at most 1568 pixels on the longest side.

The backend stores only `{revision, penWidth, imageScale}` in its own
`data/settings.json`. Invalid values are refused and not saved.

## iPad notes

- Use the Pencil to draw and your fingers to move the sheet. While the Pencil is
  down, for half a second after it lifts, and for very large contact areas (a resting
  palm), touches are ignored so the sheet does not jump while you write.
- If iPadOS Scribble or a double-tap gesture gets in the way, they are system
  features; the sheet itself sets `touch-action: none` and turns off text selection
  and the long-press callout on the drawing area.
- **Full screen** gives the most room in a Home Screen web app. The toolbar keeps
  clear of the notch and home indicator (`safe-area-inset`).
- Copying to the clipboard: Safari only offers its clipboard API on secure pages
  (HTTPS or localhost). On a plain `http://` Tailscale address Sketchpad falls back to
  the older copy command; if that also fails, the panel asks you to select the text
  and copy it yourself.
- The palm-rejection timings and the pressure curve were tuned in a desktop browser
  with simulated pen and touch input, not on a real iPad.

## Public-API boundary

- Session images come only from the click-time `context.view.messages`.
- Convert to LaTeX runs in the plugin backend through `ctx.inference.complete` with
  the Vision slot from `ctx.inference.catalog()`. The request contains the fixed
  transcription instruction and the one sketch image; no session history is sent.
- The submission interceptor only appends an image to the existing channel and marks
  the sketch as sent after the host's acknowledged acceptance (`context.onAccepted`).
- No runtime host imports, native DOM scraping, global key hook, polling, core-record
  writes or route parsing. Keyboard bindings are declared on public plugin actions;
  the host owns dispatch and Escape.

Not possible with the public API today, and therefore not included:

- typing the converted text into the message box (the composer text is read-only),
- rendering a PDF page as a background (only `ctx.documents.toMarkdown` exists).

## Development

Sketchpad is developed in a LearnHarness source checkout; it is not one of the
reference projects in the extracted authoring kit. From `plugins/sketchpad/`,
`npm run sdk` generates the type-only `.sdk/` via
`../../scripts/build-plugin-types.mjs` (`npm run plugins:setup` at the repository
root does this and installs dependencies for every plugin). Runtime code does not
import the SDK.

```sh
npm run build
```

The build writes `dist/` directly (`main.js`, `backend.cjs`, `styles.css`, manifest
and license files). It has no runtime dependencies and refuses to bundle anything
outside `src/`. It does not build the host or install, enable or update the Core
plugin; from the repository root, `npm run plugins:build-core` does that for all
Core plugins.

## Tests

```sh
npm run typecheck
npm test
```

Unit tests cover zoom/pan/pinch geometry, the stroke model with undo/redo and
erasing, export crop and cap, session-image selection, settings, the backend
(settings and transcription requests), frontend lifetimes, submission interception
and build-output guards. Host capabilities are mocked.

The browser test is **checkout-only**: it bundles the host's real
`PluginSubmissionRunner` and needs a local Chrome/Chromium (`CHROME_PATH`).

```sh
npm run test:browser
npm run build
npm run test:browser -- --built
# Optional fixture for manual inspection; Ctrl+C stops it:
npm run test:browser -- --built --serve
```

It drives the sheet with simulated pen (with pressure), mouse and two-finger touch
input and checks canvas pixels, pan/pinch/wheel zoom, palm rejection, tools, undo/redo,
clear, backgrounds, full screen, the exported PNG, teaching and practice sending,
sending together with a second pad, Convert to LaTeX and theme switching. Set
`SCREENSHOT_DIR` to keep screenshots.

These checks do not establish real-iPad, real-Pencil, installed-app or real-model
behavior.

## Source reading route

- [`src/main.ts`](src/main.ts): actions/shortcuts, surface ownership, settings and
  submission interception.
- [`src/sheet.ts`](src/sheet.ts): toolbar, pointer/touch/wheel handling, rendering
  loop, background menu and the LaTeX panel.
- [`src/strokes.ts`](src/strokes.ts) and [`src/geometry.ts`](src/geometry.ts):
  stroke model, painting, camera math and export bounds.
- [`src/state.ts`](src/state.ts) and [`src/submission.ts`](src/submission.ts):
  session sheets, captured revisions, acknowledgment and image attachment.
- [`src/background.ts`](src/background.ts), [`src/images.ts`](src/images.ts) and
  [`src/export.ts`](src/export.ts): background loading, session images and the PNG.
- [`src/backend.ts`](src/backend.ts) and [`src/settings.ts`](src/settings.ts):
  preferences and the transcription request.

## License

AGPL-3.0-only. See [`LICENSE`](LICENSE) and [`THIRD-PARTY.md`](THIRD-PARTY.md).
