// Drive the LIVE deployed tool with a fresh (empty-cache) browser context, the
// real Sitrec TLE proxy, and no .tle file — i.e. the user's exact path — to prove
// the current deployment works end-to-end with real Starlink TLEs.
import { chromium } from "playwright";

const URL = "https://local.metabunk.org/sitrec/tools/starlink/";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
// iPhone SE logical viewport (375×667) — the tightest target we design for.
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 375, height: 667 }, bypassCSP: true });
await ctx.clearCookies();
const page = await ctx.newPage();
const errs = [];
const versioned = new Set();
const unversionedAssets = new Set();
page.on("console", (m) => { if (m.type() === "error") errs.push("console:" + m.text()); });
page.on("pageerror", (e) => errs.push("pageerror:" + e.message));
page.on("request", (r) => {
    const u = r.url();
    if (!u.includes("/tools/starlink/")) return;
    const name = u.split("/tools/starlink/")[1];
    if (/\?v=\d+/.test(u)) versioned.add(name.split("?")[0]);
    else if (/\.(js|css|json)$/.test(name)) unversionedAssets.add(name);
});

await page.goto(URL, { waitUntil: "load" });
await page.waitForTimeout(500);
console.log("loaded:", await page.url());
console.log("date/time defaults:", await page.inputValue("#date"), await page.inputValue("#time"));

// Capture the landing/form screen first (verifies the input-page layout).
const formShot = (process.env.TMPDIR || "/tmp") + "/starlink-form.png";
await page.screenshot({ path: formShot, fullPage: true }).catch(() => {});
console.log("form screenshot:", formShot,
    "| advanced-after-button:", await page.evaluate(() => {
        const go = document.getElementById("go"), adv = document.querySelector("details.advanced");
        return !!(go && adv && (go.compareDocumentPosition(adv) & Node.DOCUMENT_POSITION_FOLLOWING));
    }));

await page.fill("#origin", "LAX");
await page.fill("#time", "20:00");
await page.click("#go");
console.log("results screen visible right after click:", await page.locator("#results-screen").isVisible());

let verdict = "(timeout)";
try {
    await page.waitForSelector("#results .r-when, #results .verdict", { timeout: 90000 });
    verdict = (await page.locator("#results .r-when, #results .verdict").first().innerText()).trim();
} catch { /* timeout */ }

const sentence = await page.locator("#results .r-dir").innerText().catch(() => "");
const detsum = await page.locator("#results .flare-details > summary").innerText().catch(() => "");
console.log("VERDICT:", verdict);
console.log("SENTENCE:", sentence.replace(/\s+/g, " "));
console.log("DETAILS:", detsum.replace(/\s+/g, " "));
console.log("compass-rose present:", await page.locator("#results svg.compass-rose").count());
console.log("horizon-view present:", await page.locator("#results svg.horizon-view").count());
console.log("errors:", errs.length ? errs.slice(0, 5).join(" | ") : "(none)");
console.log("VERSIONED assets (?v=…):", [...versioned].sort().join(", "));
console.log("UNVERSIONED .js/.css/.json under tool:", unversionedAssets.size ? [...unversionedAssets].join(", ") : "(none — good)");

console.log("sprinkle dots:", await page.locator('#results svg.compass-rose circle[fill="#ffffff"]').count());
const contentH = await page.evaluate(() => document.getElementById("results-screen").getBoundingClientRect().height);
console.log(`results content height: ${Math.round(contentH)}px (iPhone SE viewport = 667px)`);
// Reveal all sprinkle dots so the still screenshot shows their placement.
await page.evaluate(() => document.querySelectorAll('svg.compass-rose circle[fill="#ffffff"]')
    .forEach((c) => c.setAttribute("opacity", "0.9")));
const shot = (process.env.TMPDIR || "/tmp") + "/starlink-live.png";
await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
console.log("screenshot:", shot);

await browser.close();
