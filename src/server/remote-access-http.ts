/**
 * HTTP side of iPad access (remote-access.ts holds the record and rules).
 *
 * Management (status, settings, pairing codes, revoking) answers only the
 * Mac window's per-launch secret, never a paired device. Redeeming a code
 * is the one route a not-yet-paired device may call; Proxy lets exactly that
 * POST through (desktop-access.ts REMOTE_PAIRING_PATH) after a same-origin
 * check, and this module re-checks the rest.
 */

import { browserOnlyMode, desktopSecretAuthorized, pairingRequestRefusal } from "./desktop-access.ts";
import {
	cancelPairing,
	completePairing,
	REMOTE_ACCESS_COOKIE,
	deviceCookie,
	localRequest,
	pairedDevice,
	readRemoteAccess,
	revokeDevice,
	startPairing,
	updateRemoteAccess,
	validPort,
	type RemoteAccessRecord,
} from "./remote-access.ts";

const NO_STORE = { "Cache-Control": "no-store" };

function refuse(error: string, status: number): Response {
	return Response.json({ error }, { status, headers: NO_STORE });
}

function managementRefusal(request: Request): Response | undefined {
	if (!process.env.LH_DATA_DIR || !desktopSecretAuthorized(request.headers)) {
		return refuse("iPad access is managed from the LearnHarness window on your Mac.", 403);
	}
}

/** What the Mac window shows. Never includes codes or token hashes. */
export function remoteAccessStatus(record: RemoteAccessRecord = readRemoteAccess(), now: number = Date.now(), env: Record<string, string | undefined> = process.env) {
	// The shell sets LH_REMOTE_ACCESS_PORT when it pinned the server to the
	// record's port at launch. A different (or missing) value means the
	// running server is not where the HTTPS proxy points yet.
	const pinned = env.LH_REMOTE_ACCESS_PORT;
	const listening = pinned !== undefined && pinned === env.PORT && pinned === String(record.port);
	return {
		enabled: record.enabled,
		port: record.port,
		keepAwake: record.keepAwake,
		listening,
		restartRequired: record.enabled && !listening,
		pairing: record.pairing && record.pairing.expiresAt > now ? { expiresAt: record.pairing.expiresAt } : null,
		devices: record.devices.map(({ id, name, createdAt }) => ({ id, name, createdAt })),
	};
}

export function remoteAccessGet(request: Request): Response {
	return managementRefusal(request) ?? Response.json(remoteAccessStatus(), { headers: NO_STORE });
}

export async function remoteAccessPut(request: Request): Promise<Response> {
	const refused = managementRefusal(request);
	if (refused) return refused;
	let body: unknown;
	try { body = await request.json(); } catch { return refuse("Invalid JSON.", 400); }
	if (!body || typeof body !== "object" || Array.isArray(body)) return refuse("Invalid settings.", 400);
	const b = body as Record<string, unknown>;
	if (b.enabled !== undefined && typeof b.enabled !== "boolean") return refuse("enabled must be true or false.", 400);
	if (b.keepAwake !== undefined && typeof b.keepAwake !== "boolean") return refuse("keepAwake must be true or false.", 400);
	if (b.port !== undefined && !validPort(b.port)) return refuse("Port must be a whole number from 1024 to 65535.", 400);
	const record = updateRemoteAccess({
		enabled: b.enabled as boolean | undefined,
		keepAwake: b.keepAwake as boolean | undefined,
		port: b.port as number | undefined,
	});
	return Response.json(remoteAccessStatus(record), { headers: NO_STORE });
}

export function remotePairingPost(request: Request): Response {
	const refused = managementRefusal(request);
	if (refused) return refused;
	try {
		return Response.json(startPairing(), { headers: NO_STORE });
	} catch (error) {
		return refuse(error instanceof Error ? error.message : "Could not create a code.", 409);
	}
}

export function remotePairingDelete(request: Request): Response {
	const refused = managementRefusal(request);
	if (refused) return refused;
	cancelPairing();
	return new Response(null, { status: 204, headers: NO_STORE });
}

export function remoteDeviceDelete(request: Request, id: string): Response {
	const refused = managementRefusal(request);
	if (refused) return refused;
	return revokeDevice(id) ? new Response(null, { status: 204, headers: NO_STORE }) : refuse("No such device.", 404);
}

/** A device redeems a code. Proxy already ran pairingRequestRefusal; it is
 * repeated here so the route never depends on the matcher alone. */
export async function remotePairPost(request: Request): Promise<Response> {
	if (!process.env.LH_DATA_DIR || browserOnlyMode()) return refuse("iPad access is only available in the desktop app.", 404);
	const refusal = pairingRequestRefusal(request);
	if (refusal) return refuse(refusal, 403);
	let body: unknown;
	try { body = await request.json(); } catch { return refuse("Invalid JSON.", 400); }
	const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
	const result = completePairing(b.code, b.name);
	if (!result.ok) return refuse(result.error, result.status);
	return Response.json({ device: result.device }, { headers: { ...NO_STORE, "Set-Cookie": deviceCookie(result.cookieValue) } });
}

/** Page loads (Proxy, before anything renders): the Mac's own window passes
 * untouched. A remote request without a valid device cookie goes to /pair;
 * a paired one passes with its cookie refreshed and framing forbidden. */
export type RemotePageDecision = { kind: "local" } | { kind: "pair" } | { kind: "paired"; cookie: string };

export function remotePageDecision(headers: Headers, env: Record<string, string | undefined> = process.env): RemotePageDecision {
	if (browserOnlyMode(env) || localRequest(headers)) return { kind: "local" };
	const device = pairedDevice(headers);
	if (!device) return { kind: "pair" };
	const raw = headers.get("cookie") ?? "";
	const match = raw.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${REMOTE_ACCESS_COOKIE}=`));
	return { kind: "paired", cookie: deviceCookie(match!.slice(REMOTE_ACCESS_COOKIE.length + 1)) };
}

export function needsPairing(headers: Headers, env: Record<string, string | undefined> = process.env): boolean {
	return remotePageDecision(headers, env).kind === "pair";
}
