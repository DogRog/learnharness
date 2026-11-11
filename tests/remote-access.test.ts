/**
 * iPad access: the record, pairing codes, the device cookie, and the API
 * gate that accepts a paired device beside the Mac window's secret.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "../proxy.ts";
import { apiRequestRefusal, desktopAPIAuthorized, desktopSecretAuthorized } from "../src/server/desktop-access.ts";
import {
	PAIRING_MAX_ATTEMPTS,
	completePairing,
	cookieValue,
	deviceCookie,
	pairedDevice,
	readRemoteAccess,
	revokeDevice,
	sanitizeRemoteAccess,
	startPairing,
	updateRemoteAccess,
} from "../src/server/remote-access.ts";
import { needsPairing, remoteAccessGet, remotePairPost, remotePairingPost, remoteAccessStatus, remotePageDecision } from "../src/server/remote-access-http.ts";
import { config } from "../proxy.ts";
// Installed Next retains this name for its Proxy matcher test helper.
import { unstable_doesMiddlewareMatch as unstable_doesProxyMatch } from "next/experimental/testing/server";

const secret = "b".repeat(64);
const ipad = "https://mymac.tail1234.ts.net";
const ipadHost = "mymac.tail1234.ts.net";
let dir: string;
let saved: Record<string, string | undefined>;

function setEnv(values: Record<string, string | undefined>) {
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-remote-"));
	saved = { LH_DATA_DIR: process.env.LH_DATA_DIR, LH_DESKTOP_SERVER: process.env.LH_DESKTOP_SERVER, LH_DESKTOP_API_SECRET: process.env.LH_DESKTOP_API_SECRET, PORT: process.env.PORT, LH_REMOTE_ACCESS_PORT: process.env.LH_REMOTE_ACCESS_PORT };
	setEnv({ LH_DATA_DIR: dir, LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: secret, PORT: undefined, LH_REMOTE_ACCESS_PORT: undefined });
});

afterEach(() => {
	setEnv(saved);
	fs.rmSync(dir, { recursive: true, force: true });
});

/** Turn access on and pair one device; returns its cookie value. */
function pairOne(): string {
	updateRemoteAccess({ enabled: true });
	const { code } = startPairing();
	const result = completePairing(code, "Test iPad");
	assert.equal(result.ok, true);
	return (result as { cookieValue: string }).cookieValue;
}

/** What Safari sends through `tailscale serve`: forwarded headers always. */
function ipadHeaders(cookie: string | undefined, extra: Record<string, string> = {}): Headers {
	return new Headers({ host: ipadHost, "x-forwarded-for": "100.101.102.103", "x-forwarded-host": ipadHost, ...(cookie ? { cookie: `other=1; __Host-lh_device=${cookie}` } : {}), ...extra });
}

describe("remote-access record", () => {
	it("is off with no file, and with a malformed one", () => {
		assert.equal(readRemoteAccess().enabled, false);
		fs.writeFileSync(path.join(dir, "remote-access.json"), "{not json");
		assert.equal(readRemoteAccess().enabled, false);
		assert.deepEqual(sanitizeRemoteAccess({ enabled: "yes", port: 80, devices: [{ id: "x" }] }).devices, []);
		assert.equal(sanitizeRemoteAccess({ enabled: "yes" }).enabled, false);
		assert.equal(sanitizeRemoteAccess({ port: 80 }).port, 47321);
	});

	it("is off outside the desktop app (no data dir)", () => {
		setEnv({ LH_DATA_DIR: undefined });
		assert.equal(readRemoteAccess().enabled, false);
		assert.throws(() => updateRemoteAccess({ enabled: true }));
	});

	it("never stores a code or token in clear", () => {
		const cookie = pairOne();
		const text = fs.readFileSync(path.join(dir, "remote-access.json"), "utf8");
		assert(!text.includes(cookie.split(".")[1]!));
		assert.equal((fs.statSync(path.join(dir, "remote-access.json")).mode & 0o777).toString(8), "600");
	});
});

describe("pairing codes", () => {
	it("requires access to be on", () => {
		assert.throws(() => startPairing(), /Turn on/);
		const result = completePairing("123456", "x");
		assert.equal(result.ok, false);
	});

	it("are single use", () => {
		updateRemoteAccess({ enabled: true });
		const { code } = startPairing();
		assert.equal(completePairing(code, "a").ok, true);
		assert.equal(completePairing(code, "b").ok, false);
		assert.equal(readRemoteAccess().devices.length, 1);
	});

	it("expire", () => {
		updateRemoteAccess({ enabled: true });
		const { code, expiresAt } = startPairing(1_000);
		const result = completePairing(code, "a", expiresAt);
		assert.equal(result.ok, false);
		assert.equal((result as { status: number }).status, 403);
	});

	it("burn after too many wrong guesses, even if the right code follows", () => {
		updateRemoteAccess({ enabled: true });
		const { code } = startPairing();
		const wrong = code === "000000" ? "111111" : "000000";
		for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i++) assert.equal(completePairing(wrong, "x").ok, false);
		assert.equal(completePairing(code, "x").ok, false);
		assert.equal(readRemoteAccess().pairing, undefined);
	});

	it("are cancelled when access is turned off", () => {
		updateRemoteAccess({ enabled: true });
		const { code } = startPairing();
		updateRemoteAccess({ enabled: false });
		updateRemoteAccess({ enabled: true });
		assert.equal(completePairing(code, "x").ok, false);
	});
});

describe("device cookie", () => {
	it("identifies a paired device until it is revoked or access is off", () => {
		const cookie = pairOne();
		const device = pairedDevice(ipadHeaders(cookie));
		assert.equal(device?.name, "Test iPad");
		assert.equal(pairedDevice(ipadHeaders(cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A")))), undefined, "tampered token");
		assert.equal(pairedDevice(ipadHeaders(undefined)), undefined);
		updateRemoteAccess({ enabled: false });
		assert.equal(pairedDevice(ipadHeaders(cookie)), undefined, "access off");
		updateRemoteAccess({ enabled: true });
		assert(pairedDevice(ipadHeaders(cookie)));
		assert(revokeDevice(device!.id));
		assert.equal(pairedDevice(ipadHeaders(cookie)), undefined, "revoked");
	});

	it("is a __Host- cookie: HttpOnly, Secure, Path=/, no Domain", () => {
		const header = deviceCookie("id.token");
		for (const part of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) assert(header.includes(part), part);
		assert(header.startsWith("__Host-lh_device="));
		assert(!/Domain=/i.test(header));
		assert.equal(cookieValue("a=1; __Host-lh_device=id.token; b=2"), "id.token");
	});
});

describe("API gate with iPad access", () => {
	it("accepts a paired device's same-origin requests", () => {
		const cookie = pairOne();
		assert(desktopAPIAuthorized(ipadHeaders(cookie, { "sec-fetch-site": "same-origin" })));
		assert(!desktopAPIAuthorized(ipadHeaders(cookie)), "Sec-Fetch-Site is required for cookie auth");
		assert(!desktopAPIAuthorized(ipadHeaders(cookie, { "sec-fetch-site": "same-origin", "tailscale-funnel-request": "?1" })), "never via Funnel");
		assert.equal(apiRequestRefusal(new Request("http://127.0.0.1:47321/api/settings", { method: "PUT", headers: ipadHeaders(cookie, { origin: ipad, "sec-fetch-site": "same-origin" }) })), undefined);
		assert.equal(proxy(new NextRequest(`${ipad}/api/settings`, { headers: ipadHeaders(cookie, { "sec-fetch-site": "same-origin" }) })).headers.get("x-middleware-next"), "1");
	});

	it("refuses a paired cookie on cross-site requests", () => {
		const cookie = pairOne();
		const cases: Record<string, string>[] = [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { "sec-fetch-site": "same-origin", origin: "https://evil.tail1234.ts.net" }, { "sec-fetch-site": "same-origin", origin: "null" }, {}];
		for (const extra of cases) {
			assert(!desktopAPIAuthorized(ipadHeaders(cookie, extra)), JSON.stringify(extra));
			assert(apiRequestRefusal(new Request(`${ipad}/api/settings`, { method: "PUT", headers: ipadHeaders(cookie, extra) })), JSON.stringify(extra));
		}
	});

	it("refuses unpaired devices, and paired ones when access is off", () => {
		assert(apiRequestRefusal(new Request(`${ipad}/api/settings`, { headers: ipadHeaders(undefined) })));
		const cookie = pairOne();
		updateRemoteAccess({ enabled: false });
		assert(apiRequestRefusal(new Request(`${ipad}/api/settings`, { headers: ipadHeaders(cookie) })));
	});

	it("does not let a paired device manage pairing", async () => {
		const cookie = pairOne();
		const headers = ipadHeaders(cookie, { origin: ipad, "sec-fetch-site": "same-origin" });
		assert(!desktopSecretAuthorized(headers));
		assert.equal(remoteAccessGet(new Request(`${ipad}/api/remote-access`, { headers })).status, 403);
		assert.equal(remotePairingPost(new Request(`${ipad}/api/remote-access/pairing`, { method: "POST", headers })).status, 403);
	});

	it("lets the pairing POST through Proxy only from a same-origin page on the Tailscale name", () => {
		const url = `${ipad}/api/remote-access/pair`;
		const good = { host: ipadHost, origin: ipad, "sec-fetch-site": "same-origin" };
		assert.equal(apiRequestRefusal(new Request(url, { method: "POST", headers: good })), undefined);
		assert(apiRequestRefusal(new Request(url, { method: "POST", headers: { host: ipadHost } })), "no browser headers");
		assert(apiRequestRefusal(new Request(url, { method: "POST", headers: { ...good, origin: "https://evil.example" } })));
		assert(apiRequestRefusal(new Request(url, { method: "POST", headers: { ...good, "tailscale-funnel-request": "?1" } })), "Funnel");
		// DNS rebinding: an attacker's name pointed at 127.0.0.1, same-origin to itself.
		assert(apiRequestRefusal(new Request("http://rebind.example:47321/api/remote-access/pair", { method: "POST", headers: { host: "rebind.example:47321", origin: "http://rebind.example:47321", "sec-fetch-site": "same-origin" } })));
		assert(apiRequestRefusal(new Request(url, { method: "GET", headers: good })), "GET is not the pairing call");
		assert(apiRequestRefusal(new Request(`${ipad}/api/remote-access/pair/extra`, { method: "POST", headers: good })));
	});

	it("gives one answer for every failed pairing", () => {
		const off = completePairing("123456", "x");
		updateRemoteAccess({ enabled: true });
		const none = completePairing("123456", "x");
		startPairing();
		const wrong = completePairing("abc", "x");
		assert.deepEqual(new Set([JSON.stringify(off), JSON.stringify(none), JSON.stringify(wrong)]).size, 1);
	});

	it("pairs through the route and sets the cookie", async () => {
		updateRemoteAccess({ enabled: true });
		const { code } = startPairing();
		const response = await remotePairPost(new Request(`${ipad}/api/remote-access/pair`, {
			method: "POST",
			headers: { host: ipadHost, origin: ipad, "sec-fetch-site": "same-origin", "content-type": "application/json" },
			body: JSON.stringify({ code, name: "Route iPad" }),
		}));
		assert.equal(response.status, 200);
		const cookie = response.headers.get("set-cookie") ?? "";
		assert.match(cookie, /^__Host-lh_device=[0-9a-f-]{36}\.[\w-]+;/);
		const value = cookie.slice("__Host-lh_device=".length, cookie.indexOf(";"));
		assert.equal(pairedDevice(ipadHeaders(value))?.name, "Route iPad");
	});
});

describe("page redirect and status", () => {
	it("sends only unpaired proxied page loads to /pair", () => {
		updateRemoteAccess({ enabled: true });
		assert.equal(needsPairing(new Headers({ host: "127.0.0.1:47321" })), false, "Mac window");
		assert.equal(needsPairing(new Headers({ host: "127.0.0.1:47321", "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "127.0.0.1:47321" })), false, "Mac window after Next fills forwarded headers");
		assert.equal(needsPairing(new Headers({ host: ipadHost })), true);
		assert.equal(needsPairing(ipadHeaders(undefined)), true);
		// tailscale serve keeps the client's Host but always adds forwarded headers.
		assert.equal(needsPairing(new Headers({ host: "localhost", "x-forwarded-for": "100.1.2.3", "x-forwarded-host": ipadHost })), true, "forged loopback Host");
		const cookie = pairOne();
		assert.equal(needsPairing(ipadHeaders(cookie)), false);
		const decision = remotePageDecision(ipadHeaders(cookie));
		assert.equal(decision.kind, "paired");
		assert.match((decision as { cookie: string }).cookie, /^__Host-lh_device=.+Max-Age=/);
		setEnv({ LH_DESKTOP_SERVER: undefined, LH_DESKTOP_API_SECRET: undefined });
		assert.equal(needsPairing(new Headers({ host: ipadHost })), false, "browser-only mode keeps its own rules");
	});

	it("gates pages in Proxy before they render", async () => {
		const matches = (pathname: string) => unstable_doesProxyMatch({ config, nextConfig: {}, url: ipad + pathname });
		for (const pathname of ["/", "/chat/new", "/chat/chat_abc_12345678", "/settings", "/fonts/x.woff2"]) assert(matches(pathname), pathname);
		for (const pathname of ["/pair", "/manifest.webmanifest", "/apple-icon.png", "/icon-192.png", "/_next/static/chunks/a.js"]) assert(!matches(pathname), pathname);
		updateRemoteAccess({ enabled: true });
		const unpaired = proxy(new NextRequest(`${ipad}/chat/chat_abc_12345678`, { headers: ipadHeaders(undefined) }));
		assert.equal(unpaired.headers.get("x-middleware-next"), null);
		assert.match(await unpaired.text(), /Pair this device/);
		const local = proxy(new NextRequest("http://127.0.0.1:47321/chat/new", { headers: { host: "127.0.0.1:47321" } }));
		assert.equal(local.headers.get("x-middleware-next"), "1");
		const cookie = pairOne();
		const paired = proxy(new NextRequest(`${ipad}/chat/new`, { headers: ipadHeaders(cookie, { "sec-fetch-dest": "document" }) }));
		assert.equal(paired.headers.get("x-middleware-next"), "1");
		assert.match(paired.headers.get("content-security-policy") ?? "", /frame-ancestors 'self'/);
		assert.match(paired.headers.get("set-cookie") ?? "", /__Host-lh_device=/);
	});

	it("refuses pairing past the device limit instead of evicting", () => {
		updateRemoteAccess({ enabled: true });
		for (let i = 0; i < 20; i++) { const { code } = startPairing(); assert.equal(completePairing(code, `d${i}`).ok, true); }
		const { code } = startPairing();
		const result = completePairing(code, "one too many");
		assert.equal(result.ok, false);
		assert.equal(readRemoteAccess().devices.length, 20);
	});

	it("reports when the running server is not on the pinned port", () => {
		const record = updateRemoteAccess({ enabled: true, port: 50000 });
		assert.equal(remoteAccessStatus(record, Date.now(), { PORT: "41000" }).restartRequired, true);
		assert.equal(remoteAccessStatus(record, Date.now(), { PORT: "50000", LH_REMOTE_ACCESS_PORT: "50000" }).restartRequired, false);
		const status = remoteAccessStatus(record);
		assert.equal(JSON.stringify(status).includes("tokenHash"), false);
	});
});
