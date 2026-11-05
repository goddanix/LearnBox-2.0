/**
 * The byte range a client asks for with a `Range` header, so a player can wind through an MP3 (one range only: "bytes=a-b",
 * "bytes=a-", "bytes=-n"). Pure.
 */

/** `start`..`end` (both included) of a file of `size` bytes; null: no (usable) range was asked, the whole file goes; "unsatisfiable": it lies outside the file (416). */
export function byteRange(header: string | null, size: number): { start: number; end: number } | null | "unsatisfiable" {
	const m = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
	if (!m || (m[1] === "" && m[2] === "")) return null;
	if (size === 0) return "unsatisfiable";
	const start = m[1] === "" ? Math.max(0, size - Number(m[2])) : Number(m[1]);
	const end = m[1] === "" || m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
	if (start >= size || start > end) return "unsatisfiable";
	return { start, end };
}
