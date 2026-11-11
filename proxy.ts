import { NextResponse, type NextRequest } from "next/server";
import { apiRequestRefusal } from "./src/server/desktop-access.ts";
import { remotePageDecision } from "./src/server/remote-access-http.ts";
import { pairPageResponse } from "./src/server/pair-page.ts";
import { remoteMarkerCookie } from "./src/server/remote-access.ts";

/** Protects API methods, including SSE and spending/settings routes. The one
 * streamed document route enforces the identical all-method request policy
 * inside its handler, avoiding Next's silently truncated Proxy body clone.
 * No public callback or worker bypass: legitimate self-HTTP still needs the capability. */
export function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;
	if (pathname !== "/api" && !pathname.startsWith("/api/")) return remotePage(request);
	const refusal = apiRequestRefusal(request);
	if (refusal) {
		return NextResponse.json(
			{ error: refusal },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	return NextResponse.next();
}

/** iPad access: pages are gated BEFORE rendering, because server-rendered
 * pages (a chat's transcript) carry data and a redirect from inside a render
 * still ships that render's payload. The Mac's own window passes untouched;
 * see remote-access-http.ts. */
function remotePage(request: NextRequest) {
	const decision = remotePageDecision(request.headers);
	if (decision.kind === "local") return NextResponse.next();
	if (decision.kind === "pair") {
		// Answer with the pairing page itself: Proxy only sees the plain-HTTP
		// side of the HTTPS proxy, so neither an absolute redirect nor a
		// rewrite can be built reliably. The page is static, never this
		// route's data, and its script reloads "/" once paired.
		return pairPageResponse();
	}
	const response = NextResponse.next();
	// Slide the cookie's expiry on real page loads only, not every asset.
	if (request.headers.get("sec-fetch-dest") === "document") {
		response.headers.append("Set-Cookie", decision.cookie);
		response.headers.append("Set-Cookie", remoteMarkerCookie());
	}
	response.headers.set("Content-Security-Policy", "frame-ancestors 'self'");
	response.headers.set("X-Frame-Options", "SAMEORIGIN");
	return response;
}

export const config = {
	// Keep /api itself covered; exempt only the exact streamed endpoint, not
	// the documents subtree or other plugin routes. Pages are matched too
	// (iPad access), except /pair and what the pairing page and Home Screen
	// install need. Must remain static literals.
	matcher: [
		"/api",
		"/api/((?!plugins/[^/]+/documents/markdown/?$).*)",
		"/((?!api/|api$|_next/static/|pair$|manifest\\.webmanifest$|apple-icon\\.png$|icon-192\\.png$|icon-512\\.png$).*)",
	],
};
