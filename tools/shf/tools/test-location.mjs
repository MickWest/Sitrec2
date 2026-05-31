// Integration test for location.js against the REAL bundled airports.json.
// fetch() is stubbed: "./airports.json" reads the local file; the Nominatim URL
// returns a canned response so the geocode fallback path runs without network.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const airportsPath = join(dirname(here), "airports.json");
const airportsText = readFileSync(airportsPath, "utf8");

globalThis.fetch = async (url) => {
    if (String(url).endsWith("airports.json")) {
        return { ok: true, status: 200, json: async () => JSON.parse(airportsText), text: async () => airportsText };
    }
    if (String(url).includes("nominatim")) {
        return {
            ok: true, status: 200,
            json: async () => ([{ lat: "48.8566", lon: "2.3522", display_name: "Paris, Île-de-France, France" }]),
        };
    }
    throw new Error("unexpected fetch: " + url);
};

const { loadAirports, resolveLocation, searchAirports } = await import("../location.js");

let fails = 0;
function ok(name, cond, extra = "") {
    console.log((cond ? "  ok   " : "  FAIL ") + name + (extra ? "  " + extra : ""));
    if (!cond) fails++;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

console.log("== location: dataset loads ==");
const list = await loadAirports();
ok("airports.json loads as array", Array.isArray(list) && list.length > 5000, `n=${list.length}`);

console.log("== location: resolveLocation ==");
const lax = await resolveLocation("LAX");
ok("IATA 'LAX' -> Los Angeles", lax.source === "airport" && near(lax.lat, 33.94, 0.1) && near(lax.lon, -118.41, 0.1),
    `${lax.name} (${lax.lat},${lax.lon}) tz=${lax.tz}`);
ok("LAX has tz America/Los_Angeles", lax.tz === "America/Los_Angeles", lax.tz);
ok("LAX altKm small & non-negative", lax.altKm >= 0 && lax.altKm < 1, String(lax.altKm));

const klax = await resolveLocation("KLAX");
ok("ICAO 'KLAX' resolves to LAX coords", near(klax.lat, lax.lat, 1e-6) && near(klax.lon, lax.lon, 1e-6));

const laxLower = await resolveLocation("lax");
ok("lowercase 'lax' matches IATA", near(laxLower.lat, lax.lat, 1e-6), laxLower.name);

const lhr = await resolveLocation("Heathrow");
ok("name 'Heathrow' -> LHR (London)", lhr.source === "airport" && near(lhr.lat, 51.47, 0.2) && near(lhr.lon, -0.45, 0.3),
    `${lhr.name} (${lhr.lat},${lhr.lon})`);

const jfk = await resolveLocation("JFK");
ok("IATA 'JFK' -> New York", jfk.source === "airport" && near(jfk.lat, 40.64, 0.2) && near(jfk.lon, -73.78, 0.3),
    `${jfk.name}`);

console.log("== location: Nominatim fallback ==");
const paris = await resolveLocation("123 nowhere boulevard zzz");
ok("non-airport falls back to Nominatim", paris.source === "nominatim" && near(paris.lat, 48.8566, 0.01),
    `${paris.name} (${paris.lat},${paris.lon})`);

console.log("== location: searchAirports (autocomplete) ==");
const lonResults = await searchAirports("Lond", 8);
ok("'Lond' returns London-area airports", lonResults.length > 0 &&
    lonResults.some((a) => /london/i.test(a.city + " " + a.name)), `n=${lonResults.length}`);
ok("searchAirports respects limit", (await searchAirports("a", 5)).length <= 5);
const sfoSug = await searchAirports("SFO", 8);
ok("'SFO' ranks the exact IATA first", sfoSug.length > 0 && sfoSug[0].iata === "SFO", sfoSug[0] && sfoSug[0].iata);

console.log("== location: error handling ==");
let threw = false;
try { await resolveLocation(""); } catch (_) { threw = true; }
ok("empty query throws", threw);

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
