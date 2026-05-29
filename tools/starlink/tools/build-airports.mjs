// Regenerates starlink/airports.json from the OpenFlights "airport-data" npm package.
// Run from a dir where `airport-data` is available, e.g.:
//   npm pack airport-data --pack-destination /tmp/at --cache /tmp/at/.npmcache
//   tar -xzf /tmp/at/airport-data-*.tgz -C /tmp/at
//   node build-airports.mjs /tmp/at/package/airports.json
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const srcPath = process.argv[2];
if (!srcPath) {
  console.error("usage: node build-airports.mjs <path-to-openflights-airports.json>");
  process.exit(1);
}
const all = JSON.parse(readFileSync(srcPath, "utf8"));
const arr = Array.isArray(all) ? all : Object.values(all);
const out = [];
for (const a of arr) {
  const iata = (a.iata && a.iata !== "\\N" && a.iata.length === 3) ? a.iata.toUpperCase() : "";
  const icao = (a.icao && a.icao !== "\\N" && a.icao.length === 4) ? a.icao.toUpperCase() : "";
  if (!iata && !icao) continue;
  if (typeof a.latitude !== "number" || typeof a.longitude !== "number") continue;
  out.push({
    iata, icao,
    name: a.name || "",
    city: a.city || "",
    country: a.country || "",
    lat: Math.round(a.latitude * 1e4) / 1e4,
    lon: Math.round(a.longitude * 1e4) / 1e4,
    alt: Math.round((a.altitude || 0) * 0.3048), // feet -> meters
    tz: (a.tz && a.tz !== "\\N") ? a.tz : "",
  });
}
out.sort((x, y) => (x.iata || x.icao).localeCompare(y.iata || y.icao));
const json = JSON.stringify(out);
const outPath = join(dirname(dirname(fileURLToPath(import.meta.url))), "airports.json");
writeFileSync(outPath, json);
console.log("airports written:", out.length, "->", outPath);
console.log("bytes:", json.length, "| with tz:", out.filter((a) => a.tz).length);
