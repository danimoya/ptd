// Stitch the screenshots in this folder into one animated WebP (docs/screenshots/tour.webp)
// for the README header. Each frame is held for DELAY_MS and the animation loops forever.
//
//   node docs/screenshots/build-tour.mjs
//
// Needs `sharp-cli` installed globally (`sudo npm i -g sharp-cli`); the bundled `sharp`
// library is loaded from there, so nothing is added to package.json.
import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// `npm root -g` may point at a user prefix (~/.npm-global) while sharp-cli lives in the
// system one, so look in both.
const roots = [
  execSync("npm root -g", { encoding: "utf8" }).trim(),
  "/usr/lib/node_modules",
  "/usr/local/lib/node_modules",
];
const sharpPath = roots
  .flatMap((r) => [
    join(r, "sharp", "lib", "index.js"),
    join(r, "sharp-cli", "node_modules", "sharp", "lib", "index.js"),
  ])
  .find((p) => existsSync(p));
if (!sharpPath) throw new Error(`sharp not found under ${roots.join(", ")}. Run: sudo npm i -g sharp-cli`);
const sharp = (await import(pathToFileURL(sharpPath).href)).default;

// CONFIG
const FRAME_PATTERN = /^\d{2}-.*\.png$/i; // frames play in filename order
const WIDTH = 1200;                        // output canvas; README renders at ~900px anyway
const HEIGHT = 750;                        // 16:10, the viewport the screenshots were taken at
const DELAY_MS = 2200;
const QUALITY = 72;
const OUTPUT = "tour.webp";
// END CONFIG

const frames = readdirSync(here).filter((n) => FRAME_PATTERN.test(n)).sort();
if (frames.length === 0) throw new Error(`no frames matching ${FRAME_PATTERN} in ${here}`);

// Sources are a mix of viewport (1440×900) and full-page captures; sharp refuses to join
// mismatched canvases, so every frame is scaled to WIDTH and cropped from the top.
const buffers = await Promise.all(
  frames.map((n) =>
    sharp(join(here, n))
      .resize(WIDTH, HEIGHT, { fit: "cover", position: "top" })
      .png()
      .toBuffer(),
  ),
);

await sharp(buffers, { join: { animated: true } })
  .webp({ quality: QUALITY, effort: 6, loop: 0, delay: frames.map(() => DELAY_MS) })
  .toFile(join(here, OUTPUT));

console.log(`${OUTPUT} written — ${frames.length} frames @ ${DELAY_MS}ms, ${WIDTH}×${HEIGHT}, infinite loop`);
