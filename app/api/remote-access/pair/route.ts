/** A device redeems a pairing code and receives its cookie. The only
 * iPad-access route an unpaired device may reach. */
import { remotePairPost } from "@/src/server";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
	return remotePairPost(request);
}
