import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { funnelRequest, pairedDevice, remoteHostAllowed } from "./remote-access.ts";

/** Browser-only mode: `next dev` / `next start` without the desktop shell's
 * per-launch secret. */
export function browserOnlyMode(env: Record<string, string | undefined> = process.env): boolean {
	return env.LH_DESKTOP_SERVER !== "1" && !env.LH_DESKTOP_API_SECRET;
}

/** Per-launch desktop HTTP capability. This is not an OS-user malware
 * boundary and is not an OAuth credential. Browser-only mode is checked by
 * browserAPIRefusal instead. */
export function desktopAPIAuthorized(
	headers: Headers,
	env: Record<string, string | undefined> = process.env,
): boolean {
	if (browserOnlyMode(env)) return true;
	return desktopSecretAuthorized(headers, env) || pairedDeviceAuthorized(headers, env);
}

/** The Mac window's own capability only. iPad-access management (pairing,
 * revoking) requires this, so a paired device cannot mint more devices. */
export function desktopSecretAuthorized(
	headers: Headers,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const expected = env.LH_DESKTOP_API_SECRET;
	if (browserOnlyMode(env)) return false;
	if (!expected || expected.length < 64) return false;
	const supplied = headers.get("x-learnharness-desktop");
	if (!supplied) return false;
	const actual = Buffer.from(supplied);
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/** iPad access: a paired-device cookie (see remote-access.ts), accepted only
 * in desktop mode with access turned on, never through Tailscale Funnel, and
 * only on requests the browser itself marks Sec-Fetch-Site: same-origin
 * (Safari 16.4+). SameSite alone is not enough: other *.ts.net hosts of the
 * same tailnet count as same-site. Origin is compared by host only: the
 * HTTPS proxy forwards plain HTTP, so the server's own URL never carries the
 * https scheme the browser used. */
export function pairedDeviceAuthorized(
	headers: Headers,
	env: Record<string, string | undefined> = process.env,
): boolean {
	if (browserOnlyMode(env)) return false;
	if (funnelRequest(headers) || sameOriginHeadersRefusal(headers, true)) return false;
	return pairedDevice(headers) !== undefined;
}

export function sameOriginHeadersRefusal(headers: Headers, requireFetchSite = false): string | undefined {
	const refusal = "Cross-site requests to the LearnHarness API are not allowed.";
	const site = headers.get("sec-fetch-site");
	if (site === null ? requireFetchSite : site !== "same-origin") return refusal;
	const origin = headers.get("origin");
	if (origin === null) return;
	try {
		if (new URL(origin).host.toLowerCase() === (headers.get("host") ?? "").toLowerCase()) return;
	} catch { /* fall through */ }
	return refusal;
}

/** Pairing may be attempted only on a remote host name the owner's proxy
 * serves (*.ts.net or LH_ALLOWED_HOSTS), never via Funnel, and only from
 * a same-origin page: this keeps DNS-rebinding pages off the endpoint. */
export function pairingRequestRefusal(request: Request, env: Record<string, string | undefined> = process.env): string | undefined {
	if (funnelRequest(request.headers) || !remoteHostAllowed(request.headers.get("host"), env)) return "Pairing is only available through your Tailscale address.";
	return sameOriginHeadersRefusal(request.headers, true);
}

/** The one unauthenticated iPad-access endpoint: a device redeeming a
 * pairing code. The route itself checks that access is on and rate-limits
 * codes; this only demands a same-origin browser POST. */
export const REMOTE_PAIRING_PATH = "/api/remote-access/pair";

/** Same-origin browser controls, not user authentication. Web/dev deliberately
 * retains the existing shared-server/API-key trust model. Never trust forwarded
 * origins or add CORS grants here. A public deployment needs its own access gate. */
export function subscriptionRequestOrigin(request: Request): string | undefined {
	try {
		const url = new URL(request.url);
		const host = request.headers.get("host") ?? url.host;
		const addressed = new URL(`${url.protocol}//${host}`);
		if (!["http:", "https:"].includes(addressed.protocol) || addressed.username || addressed.password || addressed.pathname !== "/" || addressed.search || addressed.hash) return;
		return addressed.origin;
	} catch { return; }
}

/** DNS rebinding needs an attacker-owned DNS name, so localhost names and IP
 * literals are always safe. Any other name must be listed in LH_ALLOWED_HOSTS
 * (comma-separated, case-insensitive, port ignored). */
export function browserHostAllowed(host: string | null, env: Record<string, string | undefined> = process.env): boolean {
	if (!host) return false;
	let hostname: string;
	try {
		hostname = new URL(`http://${host}`).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
	if (isIP(hostname.replace(/^\[|\]$/g, "")) !== 0) return true;
	const allowed = (env.LH_ALLOWED_HOSTS ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
	return allowed.includes(hostname);
}

/** Shared by Proxy and the streamed document route that deliberately bypasses
 * Proxy's truncated body clone. Check before any route-specific work. */
export function apiRequestRefusal(request: Request, env: Record<string, string | undefined> = process.env): string | undefined {
	if (browserOnlyMode(env)) return browserAPIRefusal(request, env);
	if (desktopSecretAuthorized(request.headers, env)) return;
	if (pairedDeviceAuthorized(request.headers, env)) return;
	if (new URL(request.url).pathname === REMOTE_PAIRING_PATH && request.method.toUpperCase() === "POST") {
		return pairingRequestRefusal(request, env);
	}
	return "Desktop API access requires the trusted LearnHarness window.";
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Browser-only API gate: a Host check against DNS rebinding and a
 * cross-site check on writes. Writes without Origin or Sec-Fetch-Site come
 * from non-browser clients and are allowed. Returns the refusal, if any. */
export function browserAPIRefusal(request: Request, env: Record<string, string | undefined> = process.env): string | undefined {
	if (!browserHostAllowed(request.headers.get("host") ?? new URL(request.url).host, env)) {
		return "This host name is not allowed. Use localhost or an IP address, or add the name to LH_ALLOWED_HOSTS.";
	}
	if (READ_METHODS.has(request.method.toUpperCase())) return;
	const site = request.headers.get("sec-fetch-site");
	const origin = request.headers.get("origin");
	if ((site !== null && site !== "same-origin") || (origin !== null && origin !== subscriptionRequestOrigin(request))) {
		return "Cross-site requests to the LearnHarness API are not allowed.";
	}
}
