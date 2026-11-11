/**
 * Uploads from a paired device (iPad access, 2026-11-11). The iPad has no
 * Mac file paths, so a picked photo, scan or PDF is copied into
 * `<data>/uploads/<YYYY-MM-DD>/` on the Mac and its path enters the draft,
 * exactly like a file attached in the Mac window. The agent then reads it
 * with its ordinary file tools. Nothing is ever overwritten.
 */
import { mkdir, open, unlink } from "node:fs/promises";
import * as path from "node:path";
import { FormBodyLimitError, readBoundedFormData } from "../../lib/bounded-form-data.ts";
import { MAX_IMPORT_BODY_BYTES } from "../../lib/notes-import-limits.ts";

/** One file per request; the multipart body stays under the Proxy buffer. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** A safe basename: no folders, control characters or characters Finder and
 * Windows refuse, no leading dot, at most ~120 characters. */
export function uploadFileName(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? "";
	const clean = base.normalize("NFC").replace(/[\x00-\x1f\x7f:*?"<>|`]/g, "").replace(/^[.\s]+/, "").trim();
	const ext = path.extname(clean);
	const keepExt = ext.length > 1 && ext.length <= 16 ? ext : "";
	const stem = (keepExt ? clean.slice(0, -keepExt.length) : clean).trim().slice(0, 100).trim() || "upload";
	return stem + keepExt;
}

function day(now: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Writes the bytes to a new file and returns its absolute path. A name that
 * is taken gets " (2)", " (3)" … like Finder. */
export async function saveUpload(dataDir: string, name: string, bytes: Uint8Array, now: Date = new Date()): Promise<string> {
	const dir = path.join(dataDir, "uploads", day(now));
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const file = uploadFileName(name);
	const ext = path.extname(file);
	const stem = ext ? file.slice(0, -ext.length) : file;
	for (let n = 1; n <= 999; n++) {
		const candidate = path.join(dir, n === 1 ? file : `${stem} (${n})${ext}`);
		let handle;
		try { handle = await open(candidate, "wx", 0o600); }
		catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw err;
		}
		try {
			await handle.writeFile(bytes);
			await handle.close();
		} catch (err) {
			await handle.close().catch(() => undefined);
			await unlink(candidate).catch(() => undefined);
			throw err;
		}
		return candidate;
	}
	throw new Error("Too many uploads with this name today. Rename the file and try again.");
}

const refuse = (error: string, status: number) => Response.json({ error }, { status });

/** POST /api/uploads — multipart field "file", one file. The Proxy has
 * already authorized the request (Mac window or paired device). */
export async function uploadPost(request: Request, dataDir: string | undefined = process.env.LH_DATA_DIR): Promise<Response> {
	if (!dataDir) return refuse("Uploads are only available in the desktop app.", 404);
	let form: FormData;
	try { form = await readBoundedFormData(request, MAX_IMPORT_BODY_BYTES); }
	catch (err) {
		return err instanceof FormBodyLimitError
			? refuse("That file is too big. The limit is 25 MB.", 413)
			: refuse("Could not read the upload. Try again.", 400);
	}
	const file = form.get("file");
	if (!(file instanceof File)) return refuse("No file in the upload.", 400);
	if (file.size === 0) return refuse("That file is empty.", 400);
	if (file.size > MAX_UPLOAD_BYTES) return refuse("That file is too big. The limit is 25 MB.", 413);
	try {
		const saved = await saveUpload(dataDir, file.name, new Uint8Array(await file.arrayBuffer()));
		return Response.json({ path: saved }, { headers: { "Cache-Control": "no-store" } });
	} catch (err) {
		return refuse(err instanceof Error && err.message.startsWith("Too many") ? err.message : "Could not save the file on the Mac.", 500);
	}
}
