// Smoke test for the SVG builders in skyview.js — checks they emit well-formed
// SVG with the expected elements and no NaN / invalid colours. (Visual layout is
// verified by the headless browser test.)
import { compassRose, horizonView, horizonWindow } from "../skyview.js";

let fails = 0;
const ok = (name, cond) => { console.log((cond ? "  ok   " : "  FAIL ") + name); if (!cond) fails++; };

const flares = [
    { azDeg: 318, elDeg: 6, dAzDeg: 1.2, dElDeg: -0.8, intensity: 1 },
    { azDeg: 322, elDeg: 9, dAzDeg: 1.1, dElDeg: 0.1, intensity: 0.9 },
    { azDeg: 333, elDeg: 11, dAzDeg: 1.0, dElDeg: 0.5, intensity: 0.6 },
];
const rose = compassRose([{ azDeg: 315 }, { azDeg: 340 }], flares);
const win = horizonWindow(flares);
const stars = [
    { name: "Vega", azDeg: 320, altDeg: 18, mag: 0.03 },
    { name: "Deneb", azDeg: 300, altDeg: 22, mag: 1.25 },
    { name: "Faint", azDeg: 325, altDeg: 5, mag: 3.1 },
];
const hv = horizonView({ stars, flares, ...win });

ok("rose is an <svg>…</svg>", rose.startsWith("<svg") && rose.trim().endsWith("</svg>"));
ok("rose has 2 arrowheads", (rose.match(/<polygon/g) || []).length >= 2);
ok("rose has a North label", rose.includes(">N</text>"));
ok("rose has animated white flare dots", rose.includes('fill="#ffffff"') && (rose.match(/<animateTransform/g) || []).length >= 8);
ok("flare animations loop every 60s", (rose.match(/dur="60s"/g) || []).length >= 16);
ok("flare opacity is a 3-stage up/hold/down envelope", (rose.match(/values="0;0;0\.95;0\.95;0;0"/g) || []).length >= 8);
ok("rose has the density arc along the rim", rose.includes('class="flare-arc"') && (rose.match(/stroke-opacity=/g) || []).length >= 2);
ok("horizon is an <svg>…</svg>", hv.startsWith("<svg") && hv.trim().endsWith("</svg>"));
ok("horizon draws a white disk per flare", (hv.match(/r="3\.5" fill="#ffffff"/g) || []).length === flares.length);
ok("horizon motion arrows are thin & ~75% opacity", hv.includes('opacity="0.75"') && hv.includes('stroke-width="1"'));
ok("horizon labels bright star Vega", hv.includes(">Vega</text>"));
ok("horizon labels Deneb", hv.includes(">Deneb</text>"));
ok("horizon omits faint star label", !hv.includes(">Faint</text>"));
ok("horizon has a compass-ribbon NW label", hv.includes(">NW</text>"));
ok("window centred near 325° (NW-ish)", Math.abs(win.azCenter - 325.5) < 3);
ok("no NaN in any output", !/NaN/.test(rose + hv));
// Only flag bad colours inside fill=/stroke= attributes (ignore url(#id) refs).
ok("no invalid hex colour leaked", !(/(?:fill|stroke)="#[0-9a-f]*[g-z]/i.test(rose + hv)));

console.log(`win: azCenter=${win.azCenter.toFixed(1)} HW=${win.halfWidthDeg} elMax=${win.elMaxDeg}`);
console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
