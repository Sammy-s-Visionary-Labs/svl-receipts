// Render the website's code-based SVL monogram for native launcher/splash assets.
// Run from the repository root: node scripts/generate-mobile-brand.mjs
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const directory = new URL("../apps/mobile/assets/images/", import.meta.url);
const svg = (body, size = 1024) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">${body}</svg>`,
  );
const letters = (fill) =>
  `<text x="502" y="584" text-anchor="middle" fill="${fill}" font-family="Arial, sans-serif" font-size="172" font-weight="800" letter-spacing="-18">S<tspan dy="-16">V</tspan><tspan dy="16">L</tspan></text>`;
const tile = `<rect x="248" y="248" width="528" height="528" rx="86" fill="#e3e8ca"/>${letters("#203d32")}`;
const background = '<rect width="1024" height="1024" fill="#203d32"/>';
for (const [name, body] of [
  ["icon.png", background + tile],
  ["android-icon-foreground.png", tile],
  ["android-icon-background.png", background],
  ["android-icon-monochrome.png", letters("#ffffff")],
])
  await sharp(svg(body))
    .png()
    .toFile(fileURLToPath(new URL(name, directory)));
const mark = await sharp(svg(tile))
  .extract({ left: 248, top: 248, width: 528, height: 528 })
  .resize(512)
  .png()
  .toBuffer();
await fs.writeFile(new URL("svl-mark.png", directory), mark);
await fs.writeFile(new URL("splash-icon.png", directory), mark);
await sharp(svg(background + tile))
  .resize(64)
  .png()
  .toFile(fileURLToPath(new URL("favicon.png", directory)));
