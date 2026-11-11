"use client";
/**
 * iPad access: true in a browser that reached the Mac's server as a paired
 * remote device (the server sets a readable marker cookie on page loads).
 * UI-only: it hides controls that work only in the Mac window. Never used
 * for access decisions.
 */
import { useSyncExternalStore } from "react";

const noSubscribe = () => () => {};

export function isRemoteDevice(): boolean {
	try {
		return typeof document !== "undefined" && !window.lh && String(document.cookie ?? "").split(";").some((part) => part.trim() === "__Host-lh_remote=1");
	} catch { return false; }
}

export function useRemoteDevice(): boolean {
	return useSyncExternalStore(noSubscribe, isRemoteDevice, () => false);
}
