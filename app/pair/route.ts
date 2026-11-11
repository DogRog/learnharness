/**
 * GET /pair — the page an unpaired device lands on (iPad access). Proxy also
 * serves the same page in place of any page an unpaired device requests.
 */
import { needsPairing, pairPageResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
	// Already paired (or the Mac's own window): nothing to do here.
	if (!needsPairing(request.headers)) return new Response(null, { status: 303, headers: { Location: "/" } });
	return pairPageResponse();
}
