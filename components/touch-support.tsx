"use client";

/**
 * TOUCH SUPPORT (iPad access, phase 4) — the script half of app/touch.css.
 * Mounted once in the root layout, renders nothing, and does three things
 * CSS cannot. Each one is inert unless the primary pointer is touch
 * (`(pointer: coarse)`), so the Mac window never runs any of it.
 *
 * 1. ON-SCREEN KEYBOARD. iPadOS Safari keeps the layout viewport (and
 *    `dvh`) at full height when the keyboard opens and pans the page
 *    instead, so a full-height shell ends up half under the keyboard. The
 *    visible rectangle is published on <html> (`data-lh-keyboard`,
 *    `--lh-keyboard-viewport-height`, `--lh-keyboard-viewport-top`) and
 *    touch.css sizes the shell and open dialogs to it.
 * 2. LONG PRESS = RIGHT CLICK. iPadOS Safari does not send `contextmenu`
 *    for a finger or Pencil long press, so the right-click menus (session
 *    rows, graph nodes) would be unreachable without a trackpad. A held
 *    press dispatches the same `contextmenu` event a right click would.
 * 3. NARROW WIDTHS (Split View / Slide Over). Below the width where the
 *    inline sidebar would crush the page (the desktop shell's own
 *    threshold) touch.css turns the sidebar into an overlay; this closes
 *    it on entering that width, after a navigation and on a tap outside,
 *    and brings it back when the window is wide again.
 */

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { useSidebar } from "@/components/sidebar";

const TOUCH_QUERY = "(pointer: coarse)";
/** Mirrors SIDEBAR_AUTOCLOSE (928) in components/sidebar.tsx and the
 *  max-width in app/touch.css — keep the three in sync. */
const NARROW_QUERY = "(pointer: coarse) and (max-width: 927px)";
/** The sidebar provider's own persisted preference (components/sidebar.tsx). */
const SIDEBAR_KEY = "lh:sidebar-open";
/** The preference to restore once the window is wide again. */
const WIDE_SIDEBAR_KEY = "lh:touch-sidebar-wide";

/** Less than this much of the window covered is not a keyboard (rounding,
 *  a hardware keyboard's shortcut strip is handled the same way above it). */
const KEYBOARD_MIN_COVER = 40;
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;

export interface VisualViewportSnapshot {
	innerHeight: number;
	height: number;
	pageTop: number;
	scale: number;
}

/** The visible rectangle while an on-screen keyboard covers part of the
 *  window, else null. A pinch zoom also shrinks the visual viewport; only
 *  an unscaled one means a keyboard. Pure — exported for tests. */
export function keyboardViewport(viewport: VisualViewportSnapshot): { height: number; top: number } | null {
	if (Math.abs(viewport.scale - 1) > 0.01) return null;
	if (viewport.innerHeight - viewport.height < KEYBOARD_MIN_COVER) return null;
	return { height: viewport.height, top: Math.max(0, viewport.pageTop) };
}

function watchKeyboard(): () => void {
	const viewport = window.visualViewport;
	if (!viewport) return () => {};
	const root = document.documentElement;
	let frame = 0;
	let height: number | null = null;
	// Menus, the side-question window and other anchored surfaces re-place
	// on window resize, which Safari does not send for the keyboard.
	const settle = (next: number | null) => {
		if (next === height) return;
		height = next;
		window.dispatchEvent(new Event("resize"));
	};
	const clear = () => {
		delete root.dataset.lhKeyboard;
		root.style.removeProperty("--lh-keyboard-viewport-height");
		root.style.removeProperty("--lh-keyboard-viewport-top");
	};
	const apply = () => {
		frame = 0;
		const visible = keyboardViewport({ innerHeight: window.innerHeight, height: viewport.height, pageTop: viewport.pageTop, scale: viewport.scale });
		if (!visible) {
			if (root.dataset.lhKeyboard !== undefined) clear();
			settle(null);
			return;
		}
		root.dataset.lhKeyboard = "";
		root.style.setProperty("--lh-keyboard-viewport-height", `${visible.height}px`);
		root.style.setProperty("--lh-keyboard-viewport-top", `${visible.top}px`);
		settle(visible.height);
	};
	// One write per frame: Safari sends bursts of resize/scroll while the
	// keyboard animates and while it pans the page to the focused field.
	const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };
	viewport.addEventListener("resize", schedule);
	viewport.addEventListener("scroll", schedule);
	apply();
	return () => {
		cancelAnimationFrame(frame);
		viewport.removeEventListener("resize", schedule);
		viewport.removeEventListener("scroll", schedule);
		clear();
	};
}

/** Swallow the click that ends the current touch (a long press that opened
 *  a menu, a tap that only dismissed the sidebar). Self-removing. */
function swallowNextClick(): void {
	let timer = 0;
	const stop = () => {
		window.clearTimeout(timer);
		window.removeEventListener("click", swallow, true);
		window.removeEventListener("pointerdown", stop, true);
	};
	const swallow = (event: MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
		stop();
	};
	const armExpiry = () => { timer = window.setTimeout(stop, 400); };
	window.addEventListener("click", swallow, true);
	// The next press belongs to a new gesture; the click, if any, follows
	// the lift within a few hundred ms.
	window.addEventListener("pointerup", armExpiry, { capture: true, once: true });
	window.addEventListener("pointercancel", armExpiry, { capture: true, once: true });
	window.setTimeout(() => window.addEventListener("pointerdown", stop, true), 0);
}

function watchLongPress(): () => void {
	let timer = 0;
	let press: { id: number; x: number; y: number; target: Element } | null = null;
	/** True from our dispatch until the finger lifts: a browser that also
	 *  sends its own long-press contextmenu must not open the menu twice. */
	let dispatched = false;
	const cancel = () => { window.clearTimeout(timer); timer = 0; press = null; };
	const down = (event: PointerEvent) => {
		cancel();
		dispatched = false;
		if (!event.isPrimary || event.pointerType === "mouse" || !(event.target instanceof Element)) return;
		press = { id: event.pointerId, x: event.clientX, y: event.clientY, target: event.target };
		timer = window.setTimeout(() => {
			const held = press;
			cancel();
			if (!held || !held.target.isConnected) return;
			dispatched = true;
			const handled = !held.target.dispatchEvent(new MouseEvent("contextmenu", {
				bubbles: true, cancelable: true, composed: true, view: window,
				clientX: held.x, clientY: held.y, button: 2, buttons: 0,
			}));
			// A handled press opened a menu: the lift must not also click.
			if (handled) swallowNextClick();
		}, LONG_PRESS_MS);
	};
	const move = (event: PointerEvent) => {
		if (press && event.pointerId === press.id && Math.hypot(event.clientX - press.x, event.clientY - press.y) > LONG_PRESS_SLOP) cancel();
	};
	const up = (event: PointerEvent) => { if (press && event.pointerId === press.id) cancel(); };
	const native = (event: MouseEvent) => {
		if (!event.isTrusted) return;
		// The browser has long-press context menus of its own: ours stands down.
		if (dispatched) { event.preventDefault(); event.stopImmediatePropagation(); }
		cancel();
	};
	window.addEventListener("pointerdown", down, true);
	window.addEventListener("pointermove", move, true);
	window.addEventListener("pointerup", up, true);
	window.addEventListener("pointercancel", up, true);
	window.addEventListener("scroll", cancel, true);
	window.addEventListener("contextmenu", native, true);
	return () => {
		cancel();
		window.removeEventListener("pointerdown", down, true);
		window.removeEventListener("pointermove", move, true);
		window.removeEventListener("pointerup", up, true);
		window.removeEventListener("pointercancel", up, true);
		window.removeEventListener("scroll", cancel, true);
		window.removeEventListener("contextmenu", native, true);
	};
}

function useMediaQuery(query: string): boolean {
	return useSyncExternalStore(
		(notify) => {
			const list = window.matchMedia(query);
			list.addEventListener("change", notify);
			return () => list.removeEventListener("change", notify);
		},
		() => window.matchMedia(query).matches,
		() => false,
	);
}

function readStorage(key: string): string | null {
	try { return window.localStorage.getItem(key); } catch { return null; }
}
function writeStorage(key: string, value: string | null): void {
	try {
		if (value === null) window.localStorage.removeItem(key);
		else window.localStorage.setItem(key, value);
	} catch { /* private mode: the sidebar just keeps its current state */ }
}

/** Narrow touch windows: the sidebar is an overlay that is closed unless
 *  the learner just asked for it. The wide-window preference is parked in
 *  WIDE_SIDEBAR_KEY and restored when the window widens (the desktop
 *  shell's auto-close/auto-restore rule, without a window to widen). */
function useNarrowSidebar(): void {
	const { open, toggle } = useSidebar();
	const pathname = usePathname();
	const [narrow, setNarrow] = useState(false);
	const live = useRef({ open, toggle });
	live.current = { open, toggle };

	useLayoutEffect(() => {
		// The desktop shell owns narrow windows there (window.lh = Electron).
		if (window.lh) return;
		const list = window.matchMedia(NARROW_QUERY);
		// ON LOAD: a layout effect runs before the sidebar provider's mount
		// effect reads its preference, so the provider starts from what this
		// leaves behind — no flash of an open overlay, no toggle animation.
		const parked = readStorage(WIDE_SIDEBAR_KEY);
		if (list.matches) {
			const stored = readStorage(SIDEBAR_KEY);
			const wantsOpen = stored === null || stored === "1"; // the provider's default is open
			if (parked === null) writeStorage(WIDE_SIDEBAR_KEY, wantsOpen ? "1" : "0");
			if (wantsOpen) writeStorage(SIDEBAR_KEY, "0");
		} else if (parked !== null) {
			writeStorage(WIDE_SIDEBAR_KEY, null);
			if (parked === "1") writeStorage(SIDEBAR_KEY, "1");
		}
		setNarrow(list.matches);
		// LATER (rotation, entering or leaving Split View): toggle the live state.
		const onChange = () => {
			const parkedNow = readStorage(WIDE_SIDEBAR_KEY);
			if (list.matches) {
				if (parkedNow === null) writeStorage(WIDE_SIDEBAR_KEY, live.current.open ? "1" : "0");
				if (live.current.open) live.current.toggle();
			} else if (parkedNow !== null) {
				writeStorage(WIDE_SIDEBAR_KEY, null);
				if (parkedNow === "1" && !live.current.open) live.current.toggle();
			}
			setNarrow(list.matches);
		};
		list.addEventListener("change", onChange);
		return () => list.removeEventListener("change", onChange);
	}, []);

	// A navigation is the overlay's job done.
	const lastPath = useRef(pathname);
	useEffect(() => {
		if (lastPath.current === pathname) return;
		lastPath.current = pathname;
		if (narrow && live.current.open) live.current.toggle();
	}, [pathname, narrow]);

	// A tap on the page behind the overlay closes it and does nothing else.
	useEffect(() => {
		if (!narrow || !open) return;
		const onPointerDown = (event: PointerEvent) => {
			const page = document.querySelector("body > .h-dvh > aside")?.nextElementSibling;
			if (!(event.target instanceof Node) || !page?.contains(event.target)) return;
			swallowNextClick();
			live.current.toggle();
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => document.removeEventListener("pointerdown", onPointerDown, true);
	}, [narrow, open]);
}

export function TouchSupport(): null {
	const touch = useMediaQuery(TOUCH_QUERY);
	useEffect(() => {
		if (!touch) return;
		const offKeyboard = watchKeyboard();
		const offLongPress = watchLongPress();
		return () => { offKeyboard(); offLongPress(); };
	}, [touch]);
	useNarrowSidebar();
	return null;
}
