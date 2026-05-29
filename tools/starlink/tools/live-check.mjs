// Drive the LIVE deployed tool with a fresh (empty-cache) browser context, the
// real Sitrec TLE proxy, and no .tle file — i.e. the user's exact path — to prove
// the current deployment works end-to-end with real Starlink TLEs.
import { chromium } from "playwright";

const URL = "https://local.metabunk.org/sitrec/tools/starlink/";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, bypassCSP: true });
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

await page.fill("#origin", "LAX");
await page.fill("#time", "20:00");
await page.click("#go");
console.log("results screen visible right after click:", await page.locator("#results-screen").isVisible());

let verdict = "(timeout)";
try {
    await page.waitForSelector("#results .verdict", { timeout: 90000 });
    verdict = (await page.locator("#results .verdict").innerText()).trim();
} catch { /* timeout */ }

const sentence = await page.locator("#results .sentence").innerText().catch(() => "");
const detsum = await page.locator("#results .flare-details > summary").innerText().catch(() => "");
console.log("VERDICT:", verdict);
console.log("SENTENCE:", sentence.replace(/\s+/g, " "));
console.log("DETAILS:", detsum.replace(/\s+/g, " "));
console.log("compass-rose present:", await page.locator("#results svg.compass-rose").count());
console.log("horizon-view present:", await page.locator("#results svg.horizon-view").count());
console.log("errors:", errs.length ? errs.slice(0, 5).join(" | ") : "(none)");
console.log("VERSIONED assets (?v=…):", [...versioned].sort().join(", "));
console.log("UNVERSIONED .js/.css/.json under tool:", unversionedAssets.size ? [...unversionedAssets].join(", ") : "(none — good)");

const shot = (process.env.TMPDIR || "/tmp") + "/starlink-live.png";
await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
console.log("screenshot:", shot);

await browser.close();
