// generate-icons.mjs — render the app icon set from one SVG "horizon flare" motif
// (an amber glint above Earth's limb, on the app's dark theme), via Playwright.
// Produces the PWA icon set + apple-touch-icon + favicons, and writes favicon.svg.
//
//   node tools/generate-icons.mjs
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // tools/starlink
const ICONS = join(ROOT, "icons");

// --- the motif, drawn in a 512x512 coordinate space ---------------------------
const DEFS = `<defs>
  <radialGradient id="bg" cx="50%" cy="36%" r="80%">
    <stop offset="0%" stop-color="#0c1430"/><stop offset="100%" stop-color="#070b18"/>
  </radialGradient>
  <radialGradient id="glow" cx="50%" cy="50%" r="50%">
    <stop offset="0%" stop-color="#fff3cf" stop-opacity="0.95"/>
    <stop offset="30%" stop-color="#ffd24a" stop-opacity="0.6"/>
    <stop offset="100%" stop-color="#ff9e2c" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="limb" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#15294a"/><stop offset="100%" stop-color="#091324"/>
  </linearGradient>
</defs>`;

function sparkle(cx, cy, R, w) {
  return `M${cx},${cy - R} Q${cx + w},${cy - w} ${cx + R},${cy} Q${cx + w},${cy + w} ${cx},${cy + R} Q${cx - w},${cy + w} ${cx - R},${cy} Q${cx - w},${cy - w} Z`;
}

function motif() {
  const cx = 256, cy = 226;
  return `
    <!-- Earth's limb across the lower portion + atmosphere glow -->
    <circle cx="256" cy="1000" r="690" fill="url(#limb)"/>
    <circle cx="256" cy="1000" r="690" fill="none" stroke="#3b7fc4" stroke-width="5" opacity="0.55"/>
    <circle cx="256" cy="1000" r="703" fill="none" stroke="#9bdcff" stroke-width="3" opacity="0.30"/>
    <!-- a few satellites -->
    <circle cx="118" cy="150" r="6" fill="#cfe3ff" opacity="0.85"/>
    <circle cx="406" cy="300" r="5" fill="#cfe3ff" opacity="0.70"/>
    <circle cx="356" cy="116" r="4" fill="#cfe3ff" opacity="0.55"/>
    <!-- flare: soft glow, 8-point sparkle, bright core -->
    <circle cx="${cx}" cy="${cy}" r="176" fill="url(#glow)"/>
    <g transform="rotate(45 ${cx} ${cy})"><path d="${sparkle(cx, cy, 96, 13)}" fill="#ffd24a" opacity="0.75"/></g>
    <path d="${sparkle(cx, cy, 150, 24)}" fill="#ffd24a"/>
    <circle cx="${cx}" cy="${cy}" r="21" fill="#fff6da"/>`;
}

// scale the motif around the centre (for maskable safe-zone padding)
function scaled(s) {
  return s === 1 ? motif() : `<g transform="translate(256,256) scale(${s}) translate(-256,-256)">${motif()}</g>`;
}

// rounded — rounded-rect background (transparent corners); else full-bleed square.
function iconSVG({ rounded = false, maskable = false } = {}) {
  const bg = rounded
    ? `<rect x="0" y="0" width="512" height="512" rx="112" ry="112" fill="url(#bg)"/>`
    : `<rect x="0" y="0" width="512" height="512" fill="url(#bg)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${DEFS}${bg}${scaled(maskable ? 0.78 : 1)}</svg>`;
}

const TARGETS = [
  { file: "icon-192.png", size: 192, svg: iconSVG({ rounded: true }) },
  { file: "icon-512.png", size: 512, svg: iconSVG({ rounded: true }) },
  { file: "icon-maskable-192.png", size: 192, svg: iconSVG({ maskable: true }) },
  { file: "icon-maskable-512.png", size: 512, svg: iconSVG({ maskable: true }) },
  { file: "apple-touch-icon.png", size: 180, svg: iconSVG({ maskable: false }) }, // full square; iOS rounds
  { file: "favicon-32.png", size: 32, svg: iconSVG({ rounded: true }) },
  { file: "favicon-16.png", size: 16, svg: iconSVG({ rounded: true }) },
];

const browser = await chromium.launch({ args: ["--no-sandbox"] });
for (const t of TARGETS) {
  const page = await browser.newPage({ viewport: { width: t.size, height: t.size }, deviceScaleFactor: 1 });
  const svg = t.svg.replace('width="512" height="512"', `width="${t.size}" height="${t.size}"`);
  await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`, { waitUntil: "load" });
  await page.screenshot({ path: join(ICONS, t.file), omitBackground: true });
  await page.close();
  console.log("wrote icons/" + t.file);
}
await browser.close();

// scalable favicon (the rounded "any" design)
await writeFile(join(ICONS, "favicon.svg"), iconSVG({ rounded: true }) + "\n");
console.log("wrote icons/favicon.svg");
