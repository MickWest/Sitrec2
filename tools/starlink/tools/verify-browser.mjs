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

console.log("== browser: drive the form -> results screen (synthetic default) ==");
// Default flow: no file, no fetch -> the synthetic constellation, which is dense
// enough to produce flares and exercise the full results screen.
await page.fill("#origin", "LAX");
// leave #date at its default (today) so it is in TLE range — no date simulation
await page.fill("#time", "20:45");
await page.click("#go");

ok("navigated to results screen", await page.locator("#results-screen").isVisible());
ok("form screen hidden", !(await page.locator("#form-screen").isVisible()));

// Wait for the results header — the compact ".r-when" (flares) or ".verdict" (none).
let rendered = false;
try {
    await page.waitForSelector("#results .r-when, #results .verdict", { timeout: 35000 });
    rendered = true;
} catch { /* timed out */ }
ok("results header rendered", rendered);

const hasFlares = (await page.locator("#results .r-when").count()) > 0;
const resultsHtml = await page.locator("#results").innerHTML().catch(() => "");

if (hasFlares) {
    const when = (await page.locator("#results .r-when").innerText().catch(() => "")).trim();
    ok("compact header reads 'Flares visible …'", /Flares visible/i.test(when), when);
    ok("no large verdict banner on the flares screen", await page.locator("#results .verdict").count() === 0);
    ok("three-line header (when + dir + meta)",
        await page.locator("#results .r-when").count() === 1 &&
        await page.locator("#results .r-dir").count() === 1 &&
        await page.locator("#results .r-meta").count() === 1);
    ok("compass rose SVG rendered", await page.locator("#results svg.compass-rose").count() === 1);
    ok("compass rose has a direction arrow", await page.locator("#results svg.compass-rose polygon").count() >= 1);
    ok("horizon view SVG rendered", await page.locator("#results svg.horizon-view").count() === 1);
    ok("horizon view has white flare disks", (resultsHtml.match(/r="3\.5" fill="#ffffff"/g) || []).length >= 1);
    ok("compass rose has the animated white flare sprinkle",
        await page.locator('#results svg.compass-rose circle[fill="#ffffff"]').count() >= 8);
    ok("no 'All N flares' detail section", await page.locator("#results .flare-details").count() === 0);
    ok("shows the synthetic-satellites note (default data)",
        await page.locator("#results .sim-note").filter({ hasText: /synthetic satellites/i }).count() >= 1);
    // Reveal all sprinkle dots so the screenshot shows their placement (live they
    // twinkle a few at a time).
    await page.evaluate(() => document.querySelectorAll('svg.compass-rose circle[fill="#ffffff"]')
        .forEach((c) => c.setAttribute("opacity", "0.9")));
} else {
    console.log("    (synthetic TLEs produced no flares; 'No Flares' verdict is acceptable)");
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

console.log("== browser: out-of-range date -> simulated note ==");
await page.fill("#date", "2027-12-25");   // far future -> clamps to today, simulated
await page.click("#go");
let simRendered = false;
try { await page.waitForSelector("#results .r-when, #results .verdict", { timeout: 35000 }); simRendered = true; } catch {}
ok("results rendered for far-future date", simRendered);
ok("shows the 'out of date range' note",
    await page.locator("#results .sim-note").filter({ hasText: /out of date range/i }).count() >= 1);
ok("far-future run had no errors", pageErrors.length === 0);

console.log("== browser: blank origin -> browser geolocation ==");
const context = page.context();
await context.grantPermissions(["geolocation"]);
await context.setGeolocation({ latitude: 40.0, longitude: -105.0 });
await page.route("**/nominatim.openstreetmap.org/reverse*", (route) =>
    route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ address: { city: "Testville", country: "Testland" }, display_name: "Testville, Testland" }),
    }));
const today = await page.evaluate(() => {
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
});
await page.click("#edit");
await page.fill("#origin", "");          // blank -> should use geolocation
await page.fill("#date", today);          // back in range
await page.click("#go");
let geoRendered = false;
try { await page.waitForSelector("#results .r-when, #results .verdict", { timeout: 35000 }); geoRendered = true; } catch {}
ok("geolocation run produced results", geoRendered);
ok("blank origin was populated from geolocation", /Testville, Testland/.test(await page.inputValue("#origin")),
    await page.inputValue("#origin"));
ok("geolocation run had no errors", pageErrors.length === 0, pageErrors.join(" | "));

console.log("== browser: Advanced 'Fetch current TLE' button ==");
// Mock the Sitrec proxy so the fetch button has something to load.
const FETCH_TLE = "STARLINK-X\n1 44713U 19074A   26100.50000000  .00001000  00000-0  10000-3 0  9990\n2 44713  53.0540 100.0000 0001400  90.0000 270.0000 15.06000000    13\n";
await page.route("**/sitrecServer/proxy.php*", (r) =>
    r.fulfill({ status: 200, contentType: "text/plain", body: FETCH_TLE }));
await page.click("#edit");
await page.evaluate(() => { const d = document.querySelector("details.advanced"); if (d) d.open = true; });
await page.click("#fetchtle");
await page.waitForFunction(() => /Current TLE loaded|Couldn't fetch/.test(document.getElementById("tlestatus").textContent), { timeout: 15000 }).catch(() => {});
const tleStatus = await page.locator("#tlestatus").innerText();
ok("Fetch button reports the loaded TLE", /Current TLE loaded — 1 satellite/i.test(tleStatus), tleStatus);

console.log("== browser: a loaded TLE is used on the NEXT run (race-fix regression) ==");
// After fetching, the immediately-following search must use the real TLE — not fall
// through to synthetic for one run. The data-source note must flip to "real".
// (We are already on the form screen from the fetch step — no #edit needed.)
await page.fill("#origin", "LAX");
await page.fill("#date", today);          // back in range
await page.click("#go");
await page.waitForSelector("#results .r-when, #results .verdict", { timeout: 35000 }).catch(() => {});
ok("loaded TLE applies on the very next run (real-data note shown)",
    await page.locator("#results .sim-note.real").count() >= 1);
ok("no synthetic note once a real TLE is loaded",
    await page.locator("#results .sim-note.synth").count() === 0);

console.log("== browser: reload returns to synthetic default (cache not reused across loads) ==");
// The fetched TLE is cached in localStorage, but a hard reload must forget the
// session opt-in and default to synthetic again — NOT silently reuse the cache.
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(400);
await page.fill("#origin", "LAX");
await page.fill("#date", today);
await page.click("#go");
await page.waitForSelector("#results .r-when, #results .verdict", { timeout: 35000 }).catch(() => {});
ok("after reload, default is synthetic again (despite a cached TLE on disk)",
    await page.locator("#results .sim-note.synth").count() >= 1);
ok("no real-data note on a fresh load",
    await page.locator("#results .sim-note.real").count() === 0);

await browser.close();
server.close();

console.log(fails === 0 ? "\nBROWSER SMOKE: ALL PASS" : `\nBROWSER SMOKE: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
