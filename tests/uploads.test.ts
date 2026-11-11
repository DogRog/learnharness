/**
 * iPad access uploads: files picked on a paired device are copied into
 * <data>/uploads/<day>/ on the Mac, never overwriting, and their paths come
 * back for the draft.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { saveUpload, uploadFileName, uploadPost, MAX_UPLOAD_BYTES } from "../src/server/uploads.ts";
import { uploadFiles } from "../components/upload-files.ts";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-uploads-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function multipart(file?: File): Request {
	const body = new FormData();
	if (file) body.append("file", file, file.name);
	return new Request("http://localhost/api/uploads", { method: "POST", body });
}

describe("uploadFileName", () => {
	it("keeps a plain name", () => assert.equal(uploadFileName("Lecture 3.pdf"), "Lecture 3.pdf"));
	it("drops folders, control and reserved characters", () => {
		assert.equal(uploadFileName("../../etc/pass\u0000wd"), "passwd");
		assert.equal(uploadFileName("C:\\x\\a:b*c?.png"), "abc.png");
		assert.equal(uploadFileName("`tick`.md"), "tick.md");
	});
	it("never starts with a dot and never ends up empty", () => {
		assert.equal(uploadFileName(".env"), "env");
		assert.equal(uploadFileName("..."), "upload");
		assert.equal(uploadFileName(""), "upload");
		assert.equal(uploadFileName(".pdf"), "pdf");
	});
	it("caps long names but keeps the extension", () => {
		const name = uploadFileName(`${"x".repeat(500)}.jpeg`);
		assert.equal(name, `${"x".repeat(100)}.jpeg`);
	});
});

describe("saveUpload", () => {
	const now = new Date(2026, 10, 11, 16, 0);
	it("writes into uploads/<day>/ with owner-only permissions", async () => {
		const saved = await saveUpload(dir, "image.jpg", new Uint8Array([1, 2, 3]), now);
		assert.equal(saved, path.join(dir, "uploads", "2026-11-11", "image.jpg"));
		assert.deepEqual([...fs.readFileSync(saved)], [1, 2, 3]);
		if (process.platform !== "win32") assert.equal(fs.statSync(saved).mode & 0o777, 0o600);
	});
	it("never overwrites: a taken name gets a number", async () => {
		const first = await saveUpload(dir, "image.jpg", new Uint8Array([1]), now);
		const second = await saveUpload(dir, "image.jpg", new Uint8Array([2]), now);
		const third = await saveUpload(dir, "image.jpg", new Uint8Array([3]), now);
		assert.equal(path.basename(second), "image (2).jpg");
		assert.equal(path.basename(third), "image (3).jpg");
		assert.deepEqual([...fs.readFileSync(first)], [1]);
	});
});

describe("POST /api/uploads", () => {
	it("is off without a data folder", async () => {
		const response = await uploadPost(multipart(new File(["x"], "a.txt")), undefined);
		assert.equal(response.status, 404);
	});
	it("refuses a missing or empty file", async () => {
		assert.equal((await uploadPost(multipart(), dir)).status, 400);
		assert.equal((await uploadPost(multipart(new File([], "a.txt")), dir)).status, 400);
	});
	it("refuses a file over the limit", async () => {
		const response = await uploadPost(multipart(new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "big.pdf")), dir);
		assert.equal(response.status, 413);
		assert.equal(fs.existsSync(path.join(dir, "uploads")), false);
	});
	it("saves the file and returns its path", async () => {
		const response = await uploadPost(multipart(new File(["%PDF-1.7"], "notes.pdf", { type: "application/pdf" })), dir);
		assert.equal(response.status, 200);
		const { path: saved } = await response.json() as { path: string };
		assert.ok(saved.startsWith(path.join(dir, "uploads")));
		assert.equal(path.basename(saved), "notes.pdf");
		assert.equal(fs.readFileSync(saved, "utf8"), "%PDF-1.7");
	});
});

describe("uploadFiles (client)", () => {
	it("uploads in order and reports failures by name", async () => {
		const calls: string[] = [];
		const fetcher = (async (_url: string, init: RequestInit) => {
			const file = (init.body as FormData).get("file") as File;
			calls.push(file.name);
			return file.name === "bad.png"
				? Response.json({ error: "That file is too big. The limit is 25 MB." }, { status: 413 })
				: Response.json({ path: `/mac/uploads/${file.name}` });
		}) as typeof fetch;
		const result = await uploadFiles([new File(["a"], "a.jpg"), new File(["b"], "bad.png"), new File(["c"], "c.pdf")], fetcher);
		assert.deepEqual(calls, ["a.jpg", "bad.png", "c.pdf"]);
		assert.deepEqual(result.paths, ["/mac/uploads/a.jpg", "/mac/uploads/c.pdf"]);
		assert.deepEqual(result.errors, ["bad.png: That file is too big. The limit is 25 MB."]);
	});
});
