/** iPad access settings and status. Mac window only (remote-access-http.ts). */
import { remoteAccessGet, remoteAccessPut } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
	return remoteAccessGet(request);
}

export function PUT(request: Request) {
	return remoteAccessPut(request);
}
