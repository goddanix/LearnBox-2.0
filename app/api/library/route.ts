/**
 * /api/library — the lecture library's transport (Learnbox, 2026-10).
 *
 *   GET   → { sources }: every stored lecture, newest first
 *   POST  → multipart form data (field "files", PDFs): one result per file,
 *           in request order. A file that cannot be stored (not a PDF,
 *           empty, too large, unreadable) fails ALONE with a machine code;
 *           the others still land. Uploading identical bytes twice returns
 *           the existing lecture with duplicate:true.
 */
import { addLecture, listLectures } from "@/src/server";
import { LibraryError, type LectureSource, type LibraryErrorCode } from "@/src/core";

export const dynamic = "force-dynamic";

interface UploadResult {
	requestIndex: number;
	fileName: string;
	ok: boolean;
	source?: LectureSource;
	duplicate?: boolean;
	error?: string;
	code?: LibraryErrorCode | "failed";
}

export async function GET() {
	return Response.json({ sources: listLectures() });
}

export async function POST(request: Request) {
	const form = await request.formData().catch(() => null);
	const files = form?.getAll("files").filter((f): f is File => f instanceof File) ?? [];
	if (files.length === 0) {
		return Response.json({ results: [] as UploadResult[], error: "no files" }, { status: 400 });
	}

	const results: UploadResult[] = [];
	for (const [requestIndex, file] of files.entries()) {
		try {
			const data = new Uint8Array(await file.arrayBuffer());
			const { source, duplicate } = await addLecture(file.name, data);
			results.push({ requestIndex, fileName: file.name, ok: true, source, duplicate });
		} catch (err) {
			const code = err instanceof LibraryError ? err.code : "failed";
			const error = err instanceof Error ? err.message : String(err);
			results.push({ requestIndex, fileName: file.name, ok: false, error, code });
		}
	}
	return Response.json({ results });
}
