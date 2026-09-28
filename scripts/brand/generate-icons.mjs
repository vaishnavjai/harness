#!/usr/bin/env node
// Regenerates every raster/container brand asset from the SVG sources in
// scripts/brand/. Run after editing a source SVG:
//
//   node scripts/brand/generate-icons.mjs
//
// sharp is resolved from the pnpm store (it is already in the lockfile as a
// transitive dependency), so no extra install is needed after `pnpm install`.
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const brandDir = join(repoRoot, "scripts", "brand");

function loadSharp() {
  const require = createRequire(import.meta.url);
  try {
    return require(require.resolve("sharp", { paths: [join(repoRoot, "node_modules", ".pnpm", "node_modules")] }));
  } catch {
    throw new Error("sharp is not installed. Run `pnpm install` at the repository root first.");
  }
}

const sharp = loadSharp();

async function png(svgPath, size) {
  const svg = await readFile(svgPath);
  // Rasterize well above the target size, then downsample for crisp edges.
  return sharp(svg, { density: Math.max(72, Math.ceil((size / 1024) * 72 * 4)) })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** ICNS container of PNG payloads (supported since macOS 10.7). */
async function icns(svgPath) {
  const types = [
    ["icp4", 16], ["icp5", 32], ["ic11", 32], ["icp6", 64], ["ic12", 64],
    ["ic07", 128], ["ic13", 256], ["ic08", 256], ["ic14", 512], ["ic09", 512], ["ic10", 1024],
  ];
  const chunks = [];
  for (const [type, size] of types) {
    const data = await png(svgPath, size);
    const header = Buffer.alloc(8);
    header.write(type, 0, "ascii");
    header.writeUInt32BE(data.length + 8, 4);
    chunks.push(header, data);
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

/** ICO container of PNG payloads (supported since Windows Vista). */
async function ico(svgPath) {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = await Promise.all(sizes.map((size) => png(svgPath, size)));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  const directory = Buffer.alloc(16 * sizes.length);
  let offset = header.length + directory.length;
  sizes.forEach((size, index) => {
    const entry = index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, entry);
    directory.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    directory.writeUInt8(0, entry + 2);
    directory.writeUInt8(0, entry + 3);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(images[index].length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  });
  return Buffer.concat([header, directory, ...images]);
}

async function write(relativePath, data) {
  const target = join(repoRoot, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
  process.stdout.write(`wrote ${relativePath}\n`);
}

const appIcon = join(brandDir, "harness-icon.svg");
const devIcon = join(brandDir, "harness-icon-dev.svg");
const desktopIcons = "apps/desktop/resources/icons";

await write(`${desktopIcons}/icon.png`, await png(appIcon, 512));
await write(`${desktopIcons}/icon.icns`, await icns(appIcon));
await write(`${desktopIcons}/icon.ico`, await ico(appIcon));
for (const size of [16, 24, 32, 48, 64, 96, 128, 256, 512]) {
  await write(`${desktopIcons}/linux/${size}x${size}.png`, await png(appIcon, size));
}
await write(`${desktopIcons}/dev/icon.png`, await png(devIcon, 512));
await write(`${desktopIcons}/dev/icon-dev.icns`, await icns(devIcon));
await write(`${desktopIcons}/dev/32x32.png`, await png(devIcon, 32));
await write(`${desktopIcons}/dev/128x128.png`, await png(devIcon, 128));
await write(`${desktopIcons}/dev/128x128@2x.png`, await png(devIcon, 256));

await write("apps/app/public/favicon-16x16.png", await png(appIcon, 16));
await write("apps/app/public/favicon-32x32.png", await png(appIcon, 32));
await write("apps/app/public/apple-touch-icon.png", await png(appIcon, 180));
