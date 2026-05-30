// generate-screenshots.mjs — capture mobile screenshots for the web-app manifest
// (the richer install UI on Android/desktop). Serves the tool locally and shoots
// the form and a results screen at a phone viewport. node tools/generate-screenshots.mjs
import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHOTS = join(ROOT, "screenshots");
await mkdir(SHOTS, { recursive: true });

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
    ".json": "application/json", ".css": "text/css", ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml", ".png": "image/png" };
const server = http.createServer(async (req, res) => {
    try {
        let p = decodeURIComponent(req.url.split("?")[0]);
        if (p === "/") p = "/index.html";
        const full = normalize(join(ROOT, p));
        if (!full.startsWith(ROOT)) { res.writeHead(403).end(); return; }
        const buf = await readFile(full);
        res.writeHead(200, { "Content-Type": MIME[full.slice(full.lastIndexOf("."))] || "application/octet-stream" });
        res.end(buf);
    } catch { res.writeHead(404).end("not found"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const W = 390, H = 844;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

await page.goto(base + "index.html", { waitUntil: "load" });
await page.waitForTimeout(400);
await page.screenshot({ path: join(SHOTS, "form.png") });
console.log("wrote screenshots/form.png");

await page.fill("#origin", "LAX");
await page.fill("#time", "20:45");
await page.click("#go");
await page.waitForSelector("#results .r-when, #results .verdict", { timeout: 35000 }).catch(() => {});
await page.waitForTimeout(300);
// reveal the animated sprinkle so the shot is representative
await page.evaluate(() => document.querySelectorAll('svg.compass-rose circle[fill="#ffffff"]').forEach((c) => c.setAttribute("opacity", "0.9"))).catch(() => {});
await page.screenshot({ path: join(SHOTS, "results.png") });
console.log("wrote screenshots/results.png");

await browser.close();
server.close();
console.log(`screenshots are ${W}x${H}`);
