# Attribution and licenses

## Drawing Pad and the handwriting contribution (adapted mechanics)

Pressure-sensitive pen segments, whole-stroke segment-distance erasing, eraser
gestures kept in undo history, mouse/stylus pointer handling, tight export
cropping with a fixed pixel cap, and acknowledgment-aware submission handling are
adapted from the Core plugin [`plugins/drawing-pad`](../drawing-pad/), which in
turn adapted them from:

- Repository: https://github.com/hrdkj/learnharness
- Branch: `codex/handwriting-contribution`
- Reviewed commit: `48dd022`
- License: AGPL-3.0-only, the same license as LearnHarness and this plugin.

Sketchpad adds the zoomable camera, touch gestures and palm rejection, the
highlighter, colors and widths, redo, image backgrounds and Convert to LaTeX.

## Runtime dependencies

None. The built package contains only this plugin's own code.
