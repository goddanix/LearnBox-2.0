/**
 * A minimal PDF with real extractable text, one string per page — the fixture
 * the lecture-library tests feed pdfjs. No xref table: pdfjs rebuilds it
 * (the same shortcut tests/library.test.ts's blank-page PDF relies on).
 * Page text must not contain parentheses or backslashes (PDF string syntax).
 */
export function textPdf(pageTexts: string[], tag = ""): Uint8Array {
	const pageCount = pageTexts.length;
	const firstPageObj = 4;
	const kids = pageTexts.map((_, i) => `${firstPageObj + i * 2} 0 R`).join(" ");
	let body = `%PDF-1.4\n%${tag}\n1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n`;
	body += `2 0 obj\n<</Type/Pages/Kids[${kids}]/Count ${pageCount}>>\nendobj\n`;
	body += "3 0 obj\n<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\nendobj\n";
	pageTexts.forEach((text, i) => {
		const pageObj = firstPageObj + i * 2;
		// Wrapped into short lines that stay on the page: pdfjs drops the part of
		// one long line that runs off the MediaBox.
		const lines = text.match(/.{1,80}/g) ?? [""];
		const height = 20 + lines.length * 10;
		const stream = `BT /F1 8 Tf 10 ${height - 10} Td 10 TL ${lines.map((l) => `(${l}) '`).join(" ")} ET`;
		body +=
			`${pageObj} 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 600 ${height}]/Resources<</Font<</F1 3 0 R>>>>/Contents ${pageObj + 1} 0 R>>\nendobj\n` +
			`${pageObj + 1} 0 obj\n<</Length ${stream.length}>>\nstream\n${stream}\nendstream\nendobj\n`;
	});
	body += `trailer\n<</Root 1 0 R/Size ${firstPageObj + pageCount * 2}>>\nstartxref\n0\n%%EOF\n`;
	return new TextEncoder().encode(body);
}

/** `count` filler words, distinct per tag, so pages are long enough to count as content. */
export function words(count: number, tag: string): string {
	return Array.from({ length: count }, (_, i) => `${tag}${i}`).join(" ");
}
