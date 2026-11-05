/** A QR code as rows of "0"/"1" (1 = dark module), for the pairing card in Settings → Phone. Medium error correction. */

import qrcode from "qrcode-generator";

export function qrRows(text: string): string[] {
	const qr = qrcode(0, "M");
	qr.addData(text);
	qr.make();
	const size = qr.getModuleCount();
	const rows: string[] = [];
	for (let r = 0; r < size; r++) {
		let row = "";
		for (let c = 0; c < size; c++) row += qr.isDark(r, c) ? "1" : "0";
		rows.push(row);
	}
	return rows;
}
