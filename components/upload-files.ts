"use client";
/**
 * iPad access uploads (2026-11-11): a paired device has no Mac paths, so
 * each picked or dropped file is copied to the Mac first (POST /api/uploads)
 * and the returned Mac path enters the draft like any attached file.
 */
import { isRemoteDevice } from "@/components/remote-device";

/** Same type list as the picker: Safari converts HEIC photos to JPEG when
 * the list does not name HEIC, so the model gets an image it can read. */
export const UPLOAD_ACCEPT = "image/*,application/pdf,.pdf,text/*,.md,.tex,.csv,.json,.py,.ipynb";

/** True where files must be uploaded instead of attached by path. */
export function uploadsAvailable(): boolean {
	return isRemoteDevice();
}

export async function uploadFile(file: File, fetcher: typeof fetch = fetch): Promise<string> {
	const body = new FormData();
	body.append("file", file, file.name);
	const response = await fetcher("/api/uploads", { method: "POST", body, cache: "no-store" });
	const result = await response.json().catch(() => ({})) as { path?: unknown; error?: unknown };
	if (!response.ok || typeof result.path !== "string") {
		throw new Error(typeof result.error === "string" ? result.error : `Upload failed (${response.status}).`);
	}
	return result.path;
}

/** One at a time keeps each request under the size limit and the order of
 * the paths the same as the order picked. */
export async function uploadFiles(files: Iterable<File>, fetcher: typeof fetch = fetch): Promise<{ paths: string[]; errors: string[] }> {
	const paths: string[] = [];
	const errors: string[] = [];
	for (const file of files) {
		try { paths.push(await uploadFile(file, fetcher)); }
		catch (err) { errors.push(`${file.name || "File"}: ${err instanceof Error ? err.message : String(err)}`); }
	}
	return { paths, errors };
}
