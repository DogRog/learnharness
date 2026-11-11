/**
 * iPad access (remote-access wave, 2026-11-11): lets one person's own
 * devices, such as an iPad in Safari, use the desktop app's server.
 *
 * Shape of the feature:
 * - The desktop server keeps listening on 127.0.0.1 only. A reverse proxy
 *   the user runs, normally `tailscale serve`, terminates HTTPS and forwards
 *   to that loopback port. The Electron shell pins the port from this record
 *   so the proxy target stays stable across launches.
 * - A device pairs once with a short code shown in the Mac window and gets a
 *   long-lived HttpOnly, Secure, SameSite=Strict cookie. The record keeps
 *   only a SHA-256 of each device token.
 * - Everything is off until the user enables it. Pairing codes expire and
 *   burn after a few wrong guesses.
 *
 * The record lives in <data>/remote-access.json, beside settings.json, so
 * the Electron shell can read the port and keep-awake flag before it starts
 * the server. This is not a multi-user account system: every paired device
 * has the same full access as the Mac window.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { writeFileAtomicSync } from "../store/atomic-write.ts";

/** `__Host-` binds the cookie to the exact host, Secure, Path=/, with no
 * Domain, so a sibling *.ts.net host cannot plant or shadow it. */
export const REMOTE_ACCESS_COOKIE = "__Host-lh_device";
export const DEFAULT_REMOTE_ACCESS_PORT = 47321;
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const PAIRING_MAX_ATTEMPTS = 5;
/** Safari caps cookie lifetimes at 400 days; the server never expires one itself. */
export const DEVICE_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
const MAX_DEVICES = 20;
const MAX_NAME = 60;

export interface RemoteDevice {
	id: string;
	name: string;
	tokenHash: string;
	createdAt: string;
}

export interface RemoteAccessRecord {
	version: 1;
	enabled: boolean;
	port: number;
	keepAwake: boolean;
	devices: RemoteDevice[];
	pairing?: { codeHash: string; expiresAt: number; attempts: number };
}

/** iPad access exists only in the desktop app, whose shell always sets
 * LH_DATA_DIR. Without it there is no record, so access stays off. Read from
 * the environment directly: Proxy loads this module too. */
export function remoteAccessFile(dataDir: string | undefined = process.env.LH_DATA_DIR): string | undefined {
	return dataDir ? path.join(/* turbopackIgnore: true */ path.resolve(/* turbopackIgnore: true */ dataDir), "remote-access.json") : undefined;
}

export function validPort(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

function defaults(): RemoteAccessRecord {
	return { version: 1, enabled: false, port: DEFAULT_REMOTE_ACCESS_PORT, keepAwake: true, devices: [] };
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Anything malformed falls back to "off" rather than throwing: a broken
 * file must never open access, and must never break the Mac window. */
export function sanitizeRemoteAccess(raw: unknown): RemoteAccessRecord {
	const base = defaults();
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
	const r = raw as Record<string, unknown>;
	const devices = Array.isArray(r.devices)
		? r.devices.filter((d): d is RemoteDevice => !!d && typeof d === "object"
			&& typeof (d as RemoteDevice).id === "string" && /^[0-9a-f-]{36}$/.test((d as RemoteDevice).id)
			&& typeof (d as RemoteDevice).name === "string"
			&& typeof (d as RemoteDevice).tokenHash === "string" && /^[0-9a-f]{64}$/.test((d as RemoteDevice).tokenHash)
			&& typeof (d as RemoteDevice).createdAt === "string")
			.slice(0, MAX_DEVICES)
			.map((d) => ({ id: d.id, name: d.name.slice(0, MAX_NAME), tokenHash: d.tokenHash, createdAt: d.createdAt }))
		: [];
	const p = r.pairing as Record<string, unknown> | undefined;
	const pairing = p && typeof p === "object" && typeof p.codeHash === "string" && /^[0-9a-f]{64}$/.test(p.codeHash) && typeof p.expiresAt === "number" && typeof p.attempts === "number"
		? { codeHash: p.codeHash, expiresAt: p.expiresAt, attempts: p.attempts }
		: undefined;
	return {
		version: 1,
		enabled: r.enabled === true,
		port: validPort(r.port) ? r.port : base.port,
		keepAwake: r.keepAwake !== false,
		devices,
		...(pairing ? { pairing } : {}),
	};
}

let cache: { file: string; ino: number; mtimeMs: number; size: number; record: RemoteAccessRecord } | undefined;

/** Called on every gated request, so it re-parses only when the file changed. */
export function readRemoteAccess(file: string | undefined = remoteAccessFile()): RemoteAccessRecord {
	if (!file) return defaults();
	let stat: fs.Stats;
	try { stat = fs.statSync(/* turbopackIgnore: true */ file); }
	catch { return defaults(); }
	// Atomic writes rename a new file into place, so the inode changes on
	// every write even when size and a coarse mtime do not.
	if (cache && cache.file === file && cache.ino === stat.ino && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.record;
	let record: RemoteAccessRecord;
	try { record = sanitizeRemoteAccess(JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8"))); }
	catch { record = defaults(); }
	cache = { file, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size, record };
	return record;
}

function writeRemoteAccess(record: RemoteAccessRecord, file: string | undefined): void {
	if (!file) throw new Error("iPad access is only available in the desktop app.");
	fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
	writeFileAtomicSync(file, JSON.stringify(record, null, "\t"), { mode: 0o600 });
	cache = undefined;
}

export function updateRemoteAccess(
	patch: { enabled?: boolean; port?: number; keepAwake?: boolean },
	file: string | undefined = remoteAccessFile(),
): RemoteAccessRecord {
	const current = readRemoteAccess(file);
	const next: RemoteAccessRecord = {
		...current,
		...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
		...(validPort(patch.port) ? { port: patch.port } : {}),
		...(typeof patch.keepAwake === "boolean" ? { keepAwake: patch.keepAwake } : {}),
	};
	// Turning access off also cancels a code that is waiting to be used.
	if (!next.enabled) delete next.pairing;
	writeRemoteAccess(next, file);
	return next;
}

/** A fresh 6-digit code replaces any earlier one. */
export function startPairing(now: number = Date.now(), file: string | undefined = remoteAccessFile()): { code: string; expiresAt: number } {
	const current = readRemoteAccess(file);
	if (!current.enabled) throw new Error("Turn on iPad access first.");
	const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
	const expiresAt = now + PAIRING_CODE_TTL_MS;
	writeRemoteAccess({ ...current, pairing: { codeHash: sha256(code), expiresAt, attempts: 0 } }, file);
	return { code, expiresAt };
}

export function cancelPairing(file: string | undefined = remoteAccessFile()): void {
	const current = readRemoteAccess(file);
	if (!current.pairing) return;
	const { pairing: _drop, ...rest } = current;
	writeRemoteAccess(rest, file);
}

export type PairingResult =
	| { ok: true; cookieValue: string; device: Omit<RemoteDevice, "tokenHash"> }
	| { ok: false; status: number; error: string };

const PAIRING_FAILED = { ok: false, status: 403, error: "That code didn't work. Check iPad access on the Mac, create a new code, and try again." } as const;

export function completePairing(
	code: unknown,
	name: unknown,
	now: number = Date.now(),
	file: string | undefined = remoteAccessFile(),
): PairingResult {
	const current = readRemoteAccess(file);
	// One answer for "off", "no code", "expired" and "wrong": a caller learns
	// nothing about the Mac's state from a failed attempt.
	const pairing = current.pairing;
	if (!current.enabled || !pairing || pairing.expiresAt <= now || pairing.attempts >= PAIRING_MAX_ATTEMPTS) return PAIRING_FAILED;
	const supplied = typeof code === "string" ? code.replace(/\s+/g, "") : "";
	const match = /^\d{6}$/.test(supplied)
		&& timingSafeEqual(Buffer.from(sha256(supplied), "hex"), Buffer.from(pairing.codeHash, "hex"));
	if (!match) {
		const attempts = pairing.attempts + 1;
		if (attempts >= PAIRING_MAX_ATTEMPTS) {
			const { pairing: _drop, ...rest } = current;
			writeRemoteAccess(rest, file);
			return PAIRING_FAILED;
		}
		writeRemoteAccess({ ...current, pairing: { ...pairing, attempts } }, file);
		return PAIRING_FAILED;
	}
	if (current.devices.length >= MAX_DEVICES) {
		return { ok: false, status: 409, error: `${MAX_DEVICES} devices are paired already. Revoke one on the Mac first.` };
	}
	const token = randomBytes(32).toString("base64url");
	const device: RemoteDevice = {
		id: randomUUID(),
		name: (typeof name === "string" && name.trim() ? name.trim() : "iPad").slice(0, MAX_NAME),
		tokenHash: sha256(token),
		createdAt: new Date(now).toISOString(),
	};
	const devices = [...current.devices, device];
	const { pairing: _used, ...rest } = current;
	writeRemoteAccess({ ...rest, devices }, file);
	return { ok: true, cookieValue: `${device.id}.${token}`, device: { id: device.id, name: device.name, createdAt: device.createdAt } };
}

export function revokeDevice(id: string, file: string | undefined = remoteAccessFile()): boolean {
	const current = readRemoteAccess(file);
	const devices = current.devices.filter((d) => d.id !== id);
	if (devices.length === current.devices.length) return false;
	writeRemoteAccess({ ...current, devices }, file);
	return true;
}

export function cookieValue(cookieHeader: string | null, name: string = REMOTE_ACCESS_COOKIE): string | undefined {
	if (!cookieHeader) return;
	for (const part of cookieHeader.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
}

/** The paired device a request's cookie names, when access is on. */
export function pairedDevice(headers: Pick<Headers, "get">, file: string | undefined = remoteAccessFile()): RemoteDevice | undefined {
	const raw = cookieValue(headers.get("cookie"));
	if (!raw) return;
	const dot = raw.indexOf(".");
	if (dot <= 0) return;
	const id = raw.slice(0, dot);
	const token = raw.slice(dot + 1);
	if (!token) return;
	const record = readRemoteAccess(file);
	if (!record.enabled) return;
	const device = record.devices.find((d) => d.id === id);
	if (!device) return;
	const actual = Buffer.from(sha256(token), "hex");
	const wanted = Buffer.from(device.tokenHash, "hex");
	return actual.length === wanted.length && timingSafeEqual(actual, wanted) ? device : undefined;
}

/** A readable, non-secret marker so the UI can tell it runs on a paired
 * remote device (and hide Mac-only controls). Grants nothing. */
export const REMOTE_MARKER_COOKIE = "__Host-lh_remote";
export function remoteMarkerCookie(): string {
	return `${REMOTE_MARKER_COOKIE}=1; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE_S}; Secure; SameSite=Lax`;
}

/** SameSite=Lax so a link into the app from elsewhere still opens it paired.
 * API calls do not lean on SameSite: they must carry Sec-Fetch-Site:
 * same-origin (desktop-access.ts). Re-sent on page loads to slide expiry. */
export function deviceCookie(value: string): string {
	return `${REMOTE_ACCESS_COOKIE}=${value}; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax`;
}

function hostnameOf(host: string | null): string | undefined {
	if (!host) return;
	try { return new URL(`http://${host}`).hostname.toLowerCase(); }
	catch { return; }
}

function loopbackName(hostname: string | undefined): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function loopbackAddress(address: string): boolean {
	const a = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
	return a === "::1" || a === "127.0.0.1" || a === "::ffff:127.0.0.1" || /^127\.\d+\.\d+\.\d+$/.test(a);
}

/** The Mac's own window (or a local tool) talks to 127.0.0.1 directly.
 * `tailscale serve` forwards the client's Host unchanged, so a tailnet peer
 * can send `Host: localhost`; but it sets X-Forwarded-For to the peer's
 * tailnet address. Next fills X-Forwarded-For (socket address) and
 * X-Forwarded-Host (= Host) only when they are missing. So a request is local
 * only when the Host, any X-Forwarded-Host and every X-Forwarded-For hop are
 * loopback. Decides which page loads need pairing; API access never relies
 * on it. */
export function localRequest(headers: Pick<Headers, "get">): boolean {
	if (headers.get("tailscale-funnel-request") !== null) return false;
	if (!loopbackName(hostnameOf(headers.get("host")))) return false;
	const forwardedHost = headers.get("x-forwarded-host");
	if (forwardedHost !== null && !loopbackName(hostnameOf(forwardedHost.split(",")[0]!.trim()))) return false;
	const forwardedFor = headers.get("x-forwarded-for");
	return forwardedFor === null || forwardedFor.split(",").every(loopbackAddress);
}

/** Host names a paired device may use: Tailscale's *.ts.net HTTPS names,
 * plus exact names in LH_ALLOWED_HOSTS for another HTTPS proxy. A DNS
 * rebinding page (any other name pointed at 127.0.0.1) never qualifies. */
export function remoteHostAllowed(host: string | null, env: Record<string, string | undefined> = process.env): boolean {
	const hostname = hostnameOf(host);
	if (!hostname) return false;
	if (hostname.endsWith(".ts.net") && hostname.length > ".ts.net".length) return true;
	return (env.LH_ALLOWED_HOSTS ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean).includes(hostname);
}

/** Tailscale Funnel exposes a serve target to the public internet. Never
 * accept device cookies or pairing from it. */
export function funnelRequest(headers: Pick<Headers, "get">): boolean {
	return headers.get("tailscale-funnel-request") !== null;
}
