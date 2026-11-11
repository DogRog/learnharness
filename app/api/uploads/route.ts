import { uploadPost } from "@/src/server";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
	return uploadPost(request);
}
