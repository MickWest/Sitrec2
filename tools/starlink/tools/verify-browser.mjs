// Headless end-to-end browser smoke test (Playwright/chromium).
// Verifies the browser-only parts the Node tests can't: ES-module loading, the
// module Web Worker, app<->worker<->engine wiring, airports.json fetch, location
// resolution, form handling and result rendering — all without outbound network
// (airport code instead of geocoding; a local .tle file instead of Celestrak).
import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // tools/starlink
const TLE = `STARLINK-TESTA
1 44713U 19074A   26100.50000000  .00001000  00000-0  10000-3 0  9990
2 44713  53.0540 100.0000 0001400  90.0000 270.0000 15.06000000    13
STARLINK-TESTB
1 44714U 19074B   26100.50000000  .00001000  00000-0  10000-3 0  9991
2 44714  53.0540 120.0000 0001400  90.0000 270.0000 15.06000000    19
STARLINK-TESTC
1 44715U 19074C   26100.50000000  .00001000  00000-0  10000-3 0  9992
2 44715  53.0540 140.0000 0001400  90.0000 270.0000 15.06000000    14`;
const tlePath = join(process.env.TMPDIR || "/tmp", "starlink-verify.tle");
await writeFile(tlePath, TLE);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
    ".json": "application/json", ".css": "text/css", ".map": "application/json" };

const server = http.createServer(async (req, res) => {
    try {
        let p = decodeURIComponent(req.url.split("?")[0]);
        if (p === "/") p = "/index.html";
        const full = normalize(join(ROOT, p));
        if (!full.startsWith(ROOT)) { res.writeHead(403).end(); return; }
        const buf = await readFile(full);
        const ext = full.slice(full.lastIndexOf("."));
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        res.end(buf);
    } catch {
        res.writeHead(404).end("not found");
    }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const base = `http://127.0.0.1:${PORT}/`;

const consoleErrors = [];
const pageErrors = [];
let fails = 0;
const ok = (n, c, e = "") => { console.log((c ? "  ok   " : "  FAIL ") + n + (e ? "  " + e : "")); if (!c) fails++; };

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => pageErrors.push(e.message));

console.log("== browser: load page (ES module entry) ==");
await page.goto(base + "index.html", { waitUntil: "load" });
await page.waitForTimeout(400); // let module script run init()
ok("no page errors on load", pageErrors.length === 0, pageErrors.join(" | "));
ok("date input defaulted to now", !!(await page.inputValue("#date")), await page.inputValue("#date"));
ok("origin input present", await page.locator("#origin").count() === 1);

console.log("== browser: drive the form -> results screen ==");
// Use a local .tle (no network) and a very wide flare cone so the few synthetic
// satellites actually register flares within the forward search — exercising the
// full FLARES VISIBLE results screen (verdict, sentence, compass rose, horizon view).
await page.fill("#origin", "LAX");
await page.fill("#date", "2026-06-15");
await page.fill("#time", "20:45");
await page.setInputFiles("#tlefile", tlePath);
await page.locator("details.advanced > summary").click().catch(() => {});
await page.fill("#cone", "90");
await page.click("#go");

ok("navigated to results screen", await page.locator("#results-screen").isVisible());
ok("form screen hidden", !(await page.locator("#form-screen").isVisible()));

// Wait for the verdict headline (FLARES VISIBLE or No Flares).
let rendered = false;
try {
    await page.waitForSelector("#results .verdict", { timeout: 35000 });
    rendered = true;
} catch { /* timed out */ }
ok("a verdict headline rendered", rendered);

const verdict = (await page.locator("#results .verdict").innerText().catch(() => "")).trim();
const resultsHtml = await page.locator("#results").innerHTML().catch(() => "");
ok("verdict is FLARES VISIBLE or No Flares", /FLARES VISIBLE|No Flares/i.test(verdict), verdict);

if (/FLARES VISIBLE/i.test(verdict)) {
    ok("one-sentence summary present", /Flares will be visible from/i.test(resultsHtml));
    ok("compass rose SVG rendered", await page.locator("#results svg.compass-rose").count() === 1);
    ok("compass rose has a direction arrow", await page.locator("#results svg.compass-rose polygon").count() >= 1);
    ok("horizon view SVG rendered", await page.locator("#results svg.horizon-view").count() === 1);
    ok("horizon view has flare markers", (resultsHtml.match(/url\(#glow\)/g) || []).length >= 1);
} else {
    console.log("    (synthetic TLEs produced no flares; verdict=No Flares is acceptable)");
}

ok("no uncaught page errors during run", pageErrors.length === 0, pageErrors.join(" | "));
ok("no console errors during run", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

// Save a screenshot artifact of the results screen for visual inspection.
const shotPath = (process.env.TMPDIR || "/tmp") + "/starlink-results.png";
await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
console.log("    screenshot:", shotPath);

console.log("== browser: Edit button returns to the form ==");
await page.click("#edit");
ok("Edit shows the form screen again", await page.locator("#form-screen").isVisible());
ok("results screen hidden after Edit", !(await page.locator("#results-screen").isVisible()));
ok("origin value preserved for editing", (await page.inputValue("#origin")) === "LAX");

await browser.close();
server.close();

console.log(fails === 0 ? "\nBROWSER SMOKE: ALL PASS" : `\nBROWSER SMOKE: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
