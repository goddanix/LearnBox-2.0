// Learnbox: regenerate the macOS icon (build/icon.icns) from the flat design
// source (build/icon-flat.svg). The local Intel build uses build/icon.icns
// directly (electron-builder.intel.yml mac.icon, and scripts/after-pack.cjs
// copies the same file over the bundle's fallback icon), so this is the macOS
// source of truth for Learnbox — the upstream Icon Composer document
// (build/icon.icon) is not used here.
//
//   node scripts/make-icns.mjs        (macOS only: needs `iconutil`)
//
// Renders each size straight from the SVG (resvg), like make-icons.mjs.
import { Resvg } from "@resvg/resvg-js";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const svg = readFileSync(path.join(root, "build", "icon-flat.svg"), "utf8");
const render = (size) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();

// The iconset names macOS expects: each point size at 1x and 2x.
const ENTRIES = [
	["icon_16x16.png", 16], ["icon_16x16@2x.png", 32],
	["icon_32x32.png", 32], ["icon_32x32@2x.png", 64],
	["icon_128x128.png", 128], ["icon_128x128@2x.png", 256],
	["icon_256x256.png", 256], ["icon_256x256@2x.png", 512],
	["icon_512x512.png", 512], ["icon_512x512@2x.png", 1024],
];

const iconset = path.join(root, "build", "icon.iconset");
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });
for (const [name, size] of ENTRIES) writeFileSync(path.join(iconset, name), render(size));
execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(root, "build", "icon.icns")]);
rmSync(iconset, { recursive: true, force: true });
console.log("build/icon.icns  16–1024 (1x/2x)");
