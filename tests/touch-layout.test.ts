/**
 * Touch layout (iPad access): app/touch.css must never reach the Mac
 * window, and the on-screen keyboard detection must not mistake a pinch
 * zoom for a keyboard.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { keyboardViewport } from "../components/touch-support.tsx";

/** Top-level statements of a stylesheet, comments stripped. */
function topLevelRules(css: string): { prelude: string; body: string }[] {
	const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const rules: { prelude: string; body: string }[] = [];
	let depth = 0;
	let start = 0;
	let open = 0;
	for (let i = 0; i < source.length; i++) {
		if (source[i] === "{") { if (depth === 0) open = i; depth++; }
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) {
				rules.push({ prelude: source.slice(start, open).trim(), body: source.slice(open + 1, i) });
				start = i + 1;
			}
		}
	}
	assert.equal(depth, 0, "unbalanced braces");
	assert.equal(source.slice(start).trim(), "", "trailing text outside a rule");
	return rules;
}

describe("app/touch.css", () => {
	const rules = topLevelRules(readFileSync(new URL("../app/touch.css", import.meta.url), "utf8"));

	it("has rules", () => {
		assert.ok(rules.length > 0);
	});

	it("gates every rule on a touch primary pointer", () => {
		for (const { prelude } of rules) {
			assert.match(prelude, /^@media /, `not a media rule: ${prelude}`);
			assert.match(prelude, /\(pointer: coarse\)|\(hover: none\)/, `not touch-gated: ${prelude}`);
			// "A or B" would let a mouse-only condition in.
			assert.doesNotMatch(prelude, /,| or /, `alternative condition: ${prelude}`);
		}
	});

	it("uses !important only against inline styles of modal layers", () => {
		for (const { body } of rules) {
			for (const block of body.split("}")) {
				if (block.includes("!important")) assert.match(block, /\[data-interaction-layer\]/);
			}
		}
	});
});

describe("keyboardViewport", () => {
	const full = { innerHeight: 1032, height: 1032, pageTop: 0, scale: 1 };

	it("is null without a keyboard", () => {
		assert.equal(keyboardViewport(full), null);
		// Sub-threshold differences (rounding, toolbars) are not a keyboard.
		assert.equal(keyboardViewport({ ...full, height: 1010 }), null);
	});

	it("reports the visible rectangle while a keyboard covers the window", () => {
		assert.deepEqual(keyboardViewport({ ...full, height: 562 }), { height: 562, top: 0 });
		// Safari panned the page to the focused field.
		assert.deepEqual(keyboardViewport({ ...full, height: 562, pageTop: 180 }), { height: 562, top: 180 });
	});

	it("ignores a pinch zoom, which also shrinks the visual viewport", () => {
		assert.equal(keyboardViewport({ ...full, height: 516, scale: 2 }), null);
	});

	it("never reports a negative offset (rubber-band scrolling)", () => {
		assert.deepEqual(keyboardViewport({ ...full, height: 562, pageTop: -12 }), { height: 562, top: 0 });
	});
});
