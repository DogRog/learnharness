/** Create (POST) or cancel (DELETE) the one active pairing code. Mac window only. */
import { remotePairingDelete, remotePairingPost } from "@/src/server";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
	return remotePairingPost(request);
}

export function DELETE(request: Request) {
	return remotePairingDelete(request);
}
