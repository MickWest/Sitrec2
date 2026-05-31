// Cross-tabulate the real constellation into (inclination, altitude) shells with
// counts, so the synthetic generator can replicate the real joint distribution.
import { readFileSync } from "node:fs";
const mu = 398600.4418, Re = 6371;
const lines = readFileSync(process.argv[2], "utf8").split(/\r?\n/);
const sats = [];
for (const l of lines) {
    if (l.startsWith("2 ")) {
        const inc = parseFloat(l.slice(8, 16));
        const mm = parseFloat(l.slice(52, 63));
        if (!(mm > 0)) continue;
        const n = mm * 2 * Math.PI / 86400;
        sats.push({ inc, alt: Math.cbrt(mu / (n * n)) - Re });
    }
}
// bucket by (inclination rounded to 0.5°, altitude rounded to 10 km)
const cells = {};
for (const s of sats) {
    const key = (Math.round(s.inc * 2) / 2).toFixed(1) + " / " + (Math.round(s.alt / 10) * 10);
    cells[key] = (cells[key] || 0) + 1;
}
const rows = Object.entries(cells).sort((a, b) => b[1] - a[1]);
console.log(`total ${sats.length}`);
console.log("inc° / alt(km) : count  (%)");
for (const [k, c] of rows.slice(0, 18)) {
    console.log(`  ${k.padEnd(14)}: ${String(c).padStart(5)}  (${(c / sats.length * 100).toFixed(1)}%)`);
}
