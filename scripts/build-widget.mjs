#!/usr/bin/env node
/**
 * Builds "Learnbox 2.0 Widget.app" — the macOS widget, its companion app and the helper program, in one bundle:
 *
 *   Learnbox 2.0 Widget.app
 *     Contents/MacOS/LearnboxWidgetCompanion     background app (widget/Companion): triggers, runs the helper, reloads the widget
 *     Contents/Resources/widget-helper.mjs       the helper program (scripts/widget-helper.ts, one self-contained file)
 *     Contents/PlugIns/LearnboxWidget.appex      the WidgetKit extension (widget/Widget), sandboxed
 *
 *   node scripts/build-widget.mjs [--out <dir>]      default: ~/Learnbox-Build/widget/
 *
 * Signing: ad-hoc by default (a local build; macOS registers and runs it). `LEARNBOX_WIDGET_SIGN_IDENTITY="Apple
 * Development: …"` signs with a certificate instead (the keychain may ask for access).
 * Needs Xcode's command line tools (swiftc) and macOS 14+. Install with `npm run learnbox:update -- --widget`.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const APP_NAME = "Learnbox 2.0 Widget";
/** Outside the repo on purpose: the repo lives under ~/Desktop (iCloud), whose file provider stamps Finder
 *  attributes on bundle folders and breaks the signature (the app build does the same, in ~/Learnbox-Build/_work). */
export const DEFAULT_OUT = path.join(os.homedir(), "Learnbox-Build", "widget");

const arg = (name) => {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
};
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"], ...opts });

export async function buildWidget({ outDir = DEFAULT_OUT, identity = process.env.LEARNBOX_WIDGET_SIGN_IDENTITY || "-" } = {}) {
	if (process.platform !== "darwin") throw new Error("the widget is for macOS");
	const arch = process.arch === "arm64" ? "arm64" : "x86_64";
	const target = `${arch}-apple-macos14.0`;
	const app = path.join(outDir, `${APP_NAME}.app`);
	const ext = path.join(app, "Contents", "PlugIns", "LearnboxWidget.appex");
	const w = path.join(ROOT, "widget");

	fs.rmSync(app, { recursive: true, force: true });
	for (const dir of [path.join(app, "Contents", "MacOS"), path.join(app, "Contents", "Resources"), path.join(ext, "Contents", "MacOS")]) {
		fs.mkdirSync(dir, { recursive: true });
	}

	// 1. the helper program: one file, runnable by Electron-as-Node
	await build({
		entryPoints: [path.join(ROOT, "scripts", "widget-helper.ts")],
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node20",
		outfile: path.join(app, "Contents", "Resources", "widget-helper.mjs"),
		logLevel: "warning",
	});

	// 2. the widget extension (an extension's executable starts at NSExtensionMain)
	run("swiftc", [
		"-O",
		"-target", target,
		"-parse-as-library",
		"-application-extension",
		path.join(w, "Shared", "Snapshot.swift"),
		path.join(w, "Widget", "LearnboxWidget.swift"),
		"-o", path.join(ext, "Contents", "MacOS", "LearnboxWidget"),
		"-Xlinker", "-e", "-Xlinker", "_NSExtensionMain",
		"-framework", "WidgetKit",
		"-framework", "SwiftUI",
	]);
	fs.copyFileSync(path.join(w, "Widget", "Info.plist"), path.join(ext, "Contents", "Info.plist"));

	// 3. the companion app
	run("swiftc", [
		"-O",
		"-target", target,
		path.join(w, "Companion", "main.swift"),
		"-o", path.join(app, "Contents", "MacOS", "LearnboxWidgetCompanion"),
		"-framework", "AppKit",
		"-framework", "WidgetKit",
		"-framework", "ServiceManagement",
	]);
	fs.copyFileSync(path.join(w, "Companion", "Info.plist"), path.join(app, "Contents", "Info.plist"));
	const icon = path.join(ROOT, "build", "icon.icns");
	if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(app, "Contents", "Resources", "AppIcon.icns"));

	// 4. sign: the extension first (with its sandbox entitlements), then the app around it
	run("xattr", ["-cr", app]);
	run("codesign", ["--force", "--sign", identity, "--entitlements", path.join(w, "Widget", "widget.entitlements"), "--timestamp=none", ext]);
	run("codesign", ["--force", "--sign", identity, "--timestamp=none", app]);
	run("codesign", ["--verify", "--deep", "--strict", app]);
	return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const out = arg("--out");
	buildWidget(out ? { outDir: path.resolve(out) } : {})
		.then((app) => console.log(`built ${app}`))
		.catch((e) => {
			console.error(e instanceof Error ? e.message : e);
			process.exit(1);
		});
}
