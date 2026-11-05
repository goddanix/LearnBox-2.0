// electron-builder beforePack hook — mac only.
//
// WHY (Learnbox 2.0, Slice 8, 2026-11): the text recognition for labels inside raster figures (src/agent/layout/vision.ts) is a tiny
// Swift program around Apple's Vision framework (native/vision-ocr/main.swift). Development compiles it on first use, but an
// installed app has no compiler to do that and the figures' labels would silently go without OCR. So the build compiles it for
// the architecture being packed into build/bin/<arch>/vision-ocr, and electron-builder.yml (mac.extraResources) ships that as
// Contents/Resources/bin/vision-ocr — the first place vision.ts looks.
//
// Runs before the app is assembled, once per architecture. A missing compiler fails the build: an app without the helper would
// look fine and lose the labels.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// electron-builder's Arch enum: 1 = x64, 3 = arm64 (the two this app is built for).
const TARGETS = { 1: { dir: "x64", triple: "x86_64-apple-macos11.0" }, 3: { dir: "arm64", triple: "arm64-apple-macos11.0" } };

module.exports = async function buildVisionOcr(context) {
	if (context.electronPlatformName !== "darwin") return;
	const target = TARGETS[context.arch];
	if (!target) throw new Error(`[vision-ocr] no helper for architecture ${context.arch} (only x64 and arm64 are built)`);
	const root = context.packager.info.projectDir;
	const source = path.join(root, "native", "vision-ocr", "main.swift");
	const out = path.join(root, "build", "bin", target.dir, "vision-ocr");
	fs.mkdirSync(path.dirname(out), { recursive: true });
	try {
		execFileSync("swiftc", ["-O", "-target", target.triple, source, "-o", out], { stdio: "inherit", timeout: 300_000 });
	} catch (err) {
		throw new Error(`[vision-ocr] could not compile ${source} for ${target.dir} — is Xcode (or its command line tools) installed? ${err.message}`);
	}
	console.log(`[vision-ocr] ${target.dir} → ${out}`);
};
