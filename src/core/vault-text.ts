/**
 * What lands in an Obsidian vault and how an existing note is protected (Learnbox 2.0, 2026-11): the pure text rules
 * of MedAnki's vault.py. A vault is only a folder of Markdown files, so the notes are written directly. The files
 * are in store/vault.ts; tests/vault-text.test.ts compares these functions with MedAnki's own output.
 *
 * A note has no visible marker — its parts are told apart by their headings (the names stay as MedAnki wrote them,
 * so notes already in the vault keep working):
 *
 *     ---frontmatter (medanki_id …)---
 *     # Title
 *     <the generated text>
 *     ## Verwandte Themen        (only after "link the vault": a list of `- [[…]]`)
 *     ## Eigene Notizen          (the reader's own; never touched)
 *
 * Saving again replaces only what is between the title line and the first of the two headings. A note whose
 * heading is gone is not touched at all.
 */

/** From this heading on a note belongs to the reader. */
export const OWN_HEADING = "## Eigene Notizen";
/** Links to related notes (written by the vault linker). */
export const LINKS_HEADING = "## Verwandte Themen";
export const INDEX_NAME = "Übersicht.md";
/** The topic notes of a course lie in `<course>/Themen/`. */
export const SAVE_DIR = "Themen";
/** The overview note of a course. */
export const MOC_NAME = "00 Übersicht";
/** Attachments (the PDFs, the figures). */
export const ASSETS = "Files";

const LEGACY_START = "%% medanki:start %%";
const LEGACY_END = "%% medanki:end %%";
const LEGACY_LINKS = ["%% medanki:links:start %%", "%% medanki:links:end %%"];

// Python's re.M anchors, written out: `^` after a newline only, `$` before a newline only (JS's `m` flag would also
// treat a lone CR, U+2028 and U+2029 as line ends, and `.` would stop at them).
const BOL = "(?:^|(?<=\\n))";
const EOL = "(?=\\n|$)";
const BOUNDARY = `${BOL}## (?:Verwandte Themen|Eigene Notizen)[ \\t]*${EOL}`;
const FM_RE = /^---\n[\s\S]*?\n---\n/;
const H1_SRC = `${BOL}# [^\\n]+${EOL}`;
const LINKS_SRC = `${BOL}## Verwandte Themen[ \\t]*${EOL}`;
const OWN_SRC = `${BOL}## Eigene Notizen[ \\t]*${EOL}`;
const FORBIDDEN = /[\\/:*?"<>|#^[\]\x00-\x1f]/g;

const chars = (s: string): string[] => [...s];
const cut = (s: string, max: number): string => chars(s).slice(0, max).join("");

/** Python's `str.strip(set)`: the given characters off both ends. */
function stripSet(s: string, set: string): string {
	const c = chars(s);
	let a = 0;
	let b = c.length;
	while (a < b && set.includes(c[a]!)) a++;
	while (b > a && set.includes(c[b - 1]!)) b--;
	return c.slice(a, b).join("");
}

function searchFrom(source: string, text: string, pos: number): RegExpExecArray | null {
	const re = new RegExp(source, "g");
	re.lastIndex = pos;
	return re.exec(text);
}

/** A file name Obsidian and macOS accept (no path characters, no `[[ ]] # ^`). */
export function safeName(text: unknown, fallback = "Notiz", maxlen = 80): string {
	const raw = text === null || text === undefined || text === "" ? "" : String(text);
	let s = stripSet(raw.replace(FORBIDDEN, " "), " .");
	s = stripSet(cut(s.replace(/\s+/g, " "), maxlen), " .");
	return s || fallback;
}

const UMLAUTS: Record<string, string> = { ä: "a", ö: "o", ü: "u", ß: "s", Ä: "A", Ö: "O", Ü: "U" };

/** An ASCII short name for picture files. */
export function slug(text: unknown, maxlen = 40): string {
	const raw = text === null || text === undefined || text === "" ? "" : String(text);
	const ascii = chars(raw)
		.map((c) => UMLAUTS[c] ?? c)
		.join("");
	const s = stripSet(ascii.replace(/[^A-Za-z0-9]+/g, "-"), "-");
	return cut(s || "bild", maxlen);
}

/** The `medanki_id` of a note's frontmatter. */
export function frontmatterId(text: string): string | null {
	if (!text.startsWith("---")) return null;
	const head = text.split("\n---")[0]!;
	const m = new RegExp(`${BOL}medanki_id:\\s*(\\S+)\\s*${EOL}`).exec(head);
	return m ? stripSet(m[1]!, "\"'") : null;
}

/** The frontmatter of a topic note (or of the overview of a course). Texts as JSON strings: safe for YAML. */
export function topicFrontmatter(o: { subject: string; id: string; created: string; tags: readonly string[]; sources: readonly string[]; topic?: string | null; moc?: boolean }): string {
	const lines = ["---", `fach: ${JSON.stringify(o.subject)}`];
	if (o.topic !== null && o.topic !== undefined) lines.push(`thema: ${JSON.stringify(o.topic)}`);
	lines.push(o.sources.length > 0 ? "quellen:" : "quellen: []");
	for (const s of o.sources) lines.push(`  - ${JSON.stringify(`[[${s}]]`)}`);
	lines.push("tags:");
	for (const t of o.tags) lines.push(`  - ${t}`);
	lines.push(`erstellt: ${o.created}`, `medanki_id: ${o.id}`);
	if (o.moc) lines.push("medanki_moc: true");
	return `${lines.join("\n")}\n---\n`;
}

/** The earlier visible `%% medanki:… %%` markers off. The old end marker of the main text becomes the heading "Eigene Notizen" unless a boundary heading follows. */
export function stripLegacyMarkers(text: string): string {
	if (!text.includes("%% medanki:")) return text;
	const lines = text.split("\n");
	const out: string[] = [];
	lines.forEach((ln, i) => {
		const s = ln.trim();
		if (s === LEGACY_START || LEGACY_LINKS.includes(s)) return;
		if (s === LEGACY_END) {
			if (new RegExp(BOUNDARY).test(lines.slice(i + 1).join("\n"))) return;
			out.push(OWN_HEADING, "");
			return;
		}
		out.push(ln);
	});
	return out.join("\n");
}

/** The generated text must not contain the boundary headings itself (the part would no longer be unambiguous). */
export function sanitizeBody(body: string): string {
	return body.trim().replace(new RegExp(BOUNDARY, "g"), (m) => `${m.trimEnd()} (Skript)`);
}

/** (end of the title line, start of the first boundary heading): the generated text lies in between. */
function bodySpan(text: string): [number, number] | null {
	const fm = FM_RE.exec(text);
	const h1 = searchFrom(H1_SRC, text, fm ? fm[0].length : 0);
	if (!h1) return null;
	const end = h1.index + h1[0].length;
	const b = searchFrom(BOUNDARY, text, end);
	return b ? [end, b.index] : null;
}

/** An existing note with its generated text replaced; null when its structure is no longer recognisable. */
export function setBody(text: string, body: string): string | null {
	const span = bodySpan(text);
	if (span === null) return null;
	return `${text.slice(0, span[0])}\n\n${sanitizeBody(body)}\n\n${text.slice(span[1])}`;
}

export type ManagedState = "created" | "updated" | "skipped";

/**
 * A note as it is to be written: a new one with its frontmatter, title and the empty "Eigene Notizen" part, or an
 * existing one with only its generated text replaced. `text` is null when nothing is to be written ("skipped": the
 * structure of the existing note changed). `changed` says whether the existing text differs.
 */
export function manageNote(existing: string | null, note: { title: string; body: string; front: string }): { state: ManagedState; text: string | null; changed: boolean } {
	if (existing !== null) {
		const next = setBody(stripLegacyMarkers(existing), note.body);
		if (next === null) return { state: "skipped", text: null, changed: false };
		return { state: "updated", text: next, changed: next !== existing };
	}
	return { state: "created", text: `${note.front}\n# ${note.title}\n\n${sanitizeBody(note.body)}\n\n${OWN_HEADING}\n\n`, changed: true };
}

/** The text of `Übersicht.md` at the root of the vault: every course overview, by course (the generated part). */
export function indexBody(entries: ReadonlyMap<string, readonly { rel: string; name: string }[]>): string {
	const lines: string[] = [];
	for (const subject of [...entries.keys()].sort(byCodePoint)) {
		lines.push(`## ${subject}`);
		for (const e of entries.get(subject)!) lines.push(`- [[${e.rel}|${e.name}]]`);
		lines.push("");
	}
	return `Von MedAnki erzeugte Dokumente, nach Fach sortiert.\n\n${lines.join("\n").trim() || "_Noch keine Notizen._"}`;
}

/** `Übersicht.md` after an update: a new file, the existing one with its generated text replaced, or null (leave it as it is). */
export function indexText(existing: string | null, body: string): string | null {
	if (existing === null) return `# Übersicht\n\n${sanitizeBody(body)}\n\n${OWN_HEADING}\n\n`;
	const next = setBody(stripLegacyMarkers(existing), body);
	return next !== null && next !== existing ? next : null;
}

/** Python's string order (by code point). */
export function byCodePoint(a: string, b: string): number {
	const x = chars(a);
	const y = chars(b);
	for (let i = 0; i < Math.min(x.length, y.length); i++) {
		const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
		if (d !== 0) return d;
	}
	return x.length - y.length;
}

/** Python's order of paths: part by part, not by the whole string ("a/x" before "a b/x"). */
export function byPathParts(a: string, b: string): number {
	const x = a.split("/");
	const y = b.split("/");
	for (let i = 0; i < Math.min(x.length, y.length); i++) {
		const d = byCodePoint(x[i]!, y[i]!);
		if (d !== 0) return d;
	}
	return x.length - y.length;
}

/** The link to a file in Obsidian (works once the vault has been opened there). Python's `quote(path, safe="")`. */
export function obsidianUrl(path: string): string {
	return `obsidian://open?path=${encodeURIComponent(path).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

// ─── the related-topics block (written by the vault linker) ──────────────────

/** The heading "Verwandte Themen" with the list of `- [[…]]` right under it (only that; text below it stays). */
function linksSpan(text: string): [number, number] | null {
	const m = new RegExp(LINKS_SRC).exec(text);
	if (!m) return null;
	const start = m.index;
	const after = start + m[0].length;
	let end = after;
	let offset = 0;
	for (const ln of text.slice(after).split("\n").slice(1)) {
		if (ln.startsWith("- [[")) end = after + offset + 1 + ln.length;
		else if (ln.trim()) break;
		offset += 1 + ln.length;
	}
	return [start, end];
}

/** A note without the section "Verwandte Themen" (and the blank line before it); everything else stays. */
export function removeLinksBlock(text: string): string {
	const clean = stripLegacyMarkers(text);
	const span = linksSpan(clean);
	if (span === null) return clean;
	const head = clean.slice(0, span[0]).replace(/\n+$/, "");
	const tail = clean.slice(span[1]).replace(/^\n+/, "");
	return tail ? `${head}\n\n${tail}` : `${head}\n`;
}

/** The section "Verwandte Themen" set or replaced: where it was, else before "Eigene Notizen", else at the end. */
export function setLinksBlock(text: string, body: string): string {
	const clean = stripLegacyMarkers(text);
	const block = body.trim();
	const span = linksSpan(clean);
	if (span) return clean.slice(0, span[0]) + block + clean.slice(span[1]);
	const own = new RegExp(OWN_SRC).exec(clean);
	if (own) return `${clean.slice(0, own.index)}${block}\n\n${clean.slice(own.index)}`;
	return `${clean.replace(/\n+$/, "")}\n\n${block}\n`;
}

const PALETTE = [0x4f8ef7, 0xf2994a, 0x27ae60, 0xeb5757, 0x9b51e0, 0x2d9cdb, 0xf2c94c, 0xbb6bd9, 0x56ccf2, 0x6fcf97, 0xe87c86, 0xa0a0a0];

/**
 * `.obsidian/graph.json` with a colour group per course (folder = course) for the graph view, or null when nothing is
 * to be written: the file already has colour groups (the reader's own settings stay), is unreadable, or there is no course.
 */
export function graphColorsFile(existing: string | null, subjects: readonly string[]): string | null {
	let data: Record<string, unknown> = {};
	if (existing !== null) {
		try {
			const parsed: unknown = JSON.parse(existing);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
			data = parsed as Record<string, unknown>;
		} catch {
			return null;
		}
	}
	const groups = data.colorGroups;
	if ((Array.isArray(groups) ? groups.length > 0 : Boolean(groups)) || subjects.length === 0) return null;
	data.colorGroups = [...subjects].sort(byCodePoint).map((s, i) => ({ query: `path:"${s}/"`, color: { a: 1, rgb: PALETTE[i % PALETTE.length] } }));
	return JSON.stringify(data, null, 2);
}
