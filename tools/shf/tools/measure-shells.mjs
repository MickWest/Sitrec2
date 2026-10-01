#!/usr/bin/env node
// measure-shells.mjs — measure the Starlink constellation from a CelesTrak OMM CSV and write
// ../starlinkShells.js, the shell table that drives the synthetic constellation
// (../dummyTLE.js) and the flare-rate model (../rate/rateModel.js).
//
// Refresh the table (from the repository root):
//
//   curl -o starlink.csv 'https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=csv'
//   node tools/shf/tools/measure-shells.mjs starlink.csv
//
// The supplemental set (SpaceX ephemeris based, fresh epochs, the set the predictor's "Fetch
// current TLE" uses) is preferred. The standard group CSV
// (https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=csv) also works: the two
// share the leading columns, and the supplemental set adds RMS and DATA_SOURCE, which are
// ignored. Columns are found by name, so the column order does not matter. Legacy TLE text
// is not accepted (it cannot hold catalog numbers above 99999).
//
//   node tools/shf/tools/measure-shells.mjs <omm.csv> [outFile] [--ref ISO] [--min-shell N] [--min-planes N]
//
//   outFile       default tools/shf/starlinkShells.js (an ES module); a name ending in .json
//                 writes plain JSON instead.
//   --ref ISO     the reference epoch (default: the most common epoch day in the file, 12:00 UTC)
//   --min-shell N a 10 km altitude band with fewer satellites is merged into its nearest kept
//                 band (default 8)
//   --min-planes N a shell with fewer satellites carries no plane list (default 8, the same
//                 floor as the shell: every shell gets its measured planes. Small shells with
//                 random planes were measured to be wrong by up to 30% for the 70° group at
//                 high latitude, because a shell of three planes has no average layout).
//
// What it measures:
//   * Each satellite's inclination, "generator altitude" (semi-major axis from the Kozai mean
//     motion by Kepler's law, minus 6371 km — the convention dummyTLE.js uses, so the generated
//     mean motion equals the real one for the same table altitude), and its RAAN moved to one
//     reference epoch with the J2 secular rate, so that rows with stale epochs line up with
//     fresh ones (one day of drift at 53° is 4.7°, more than a plane spacing).
//   * Shells: satellites grouped by inclination (gap > 0.3°) and then by 10 km altitude band;
//     a band with fewer than --min-shell satellites is merged into the nearest kept band of
//     the same inclination, so the total count is kept exactly. Shell altitude = the band's
//     median; altSd = the standard deviation of the members within 6 km of it.
//   * Planes: within a shell, RAANs (at the reference epoch) sorted and split at gaps > 0.8°
//     (2° for the 70° shells, whose planes are 10° apart with wider scatter); a cluster wider
//     than 1.5° (3°) is cut into equal pieces so that a chain of near planes cannot merge into
//     one entry at their mean. Each plane is stored as [raanDeg, count]. For a Sun-synchronous
//     shell (nodal rate within 15% of 0.9856°/day) planes are split at gaps > 0.03 h, cut at
//     0.05 h, and stored as [ltanHours, count], the local MEAN solar time of the ascending
//     node, LTAN = UT + (RAAN - GMST)/15, which is fixed on any date.
//   * gapSd: the within-plane irregularity of the phases (the standard deviation of the gaps in
//     argument of latitude, degrees), the median over the shell's planes with >= 8 satellites.
//     Regular planes (53°, 43°, 97°) give 1-4°; the 70° planes, filled from mixed launch
//     batches, give ~10°.
// The output is one line per shell, so a diff of the table is readable.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { gmstRad } = await import(pathToFileURL(path.resolve(HERE, "../astro.js")).href);

const MU = 398600.4418, RE_GEN = 6371, RE_J2 = 6378.137, J2 = 1.08262668e-3;
const SSO_RATE = 360 / 365.2422;            // deg/day, the Sun's mean motion in right ascension
const wrap360 = (x) => ((x % 360) + 360) % 360;
const wrap24 = (x) => ((x % 24) + 24) % 24;

function splitCSVRow(line) {
    const out = []; let f = "", q = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) { if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
        else if (c === '"') q = true; else if (c === ",") { out.push(f); f = ""; } else f += c;
    }
    out.push(f);
    return out;
}

// J2 secular nodal rate (deg/day) for a near-circular orbit.
function nodalRateDegPerDay(a, inc, ecc) {
    const n = Math.sqrt(MU / (a * a * a)) * 86400 / (2 * Math.PI); // rev/day
    const p = a * (1 - ecc * ecc);
    return -1.5 * n * 360 * J2 * (RE_J2 / p) ** 2 * Math.cos(inc * Math.PI / 180);
}

// Parse a CelesTrak OMM CSV (standard group or supplemental). Columns are found by name.
export function readOMM(text) {
    const lines = text.replace(/^﻿/, "").replace(/\r/g, "").split("\n").filter((l) => l.trim());
    const head = splitCSVRow(lines[0]).map((h) => h.trim());
    const col = Object.fromEntries(head.map((h, i) => [h, i]));
    for (const k of ["INCLINATION", "RA_OF_ASC_NODE", "MEAN_MOTION", "EPOCH"]) if (!(k in col)) throw new Error(`no ${k} column (is this a CelesTrak OMM CSV?)`);
    const sats = [];
    for (const line of lines.slice(1)) {
        const c = splitCSVRow(line);
        if (c.length < head.length) continue;
        const mm = Number(c[col.MEAN_MOTION]);
        if (!(mm > 0)) continue;
        const n = mm * 2 * Math.PI / 86400;
        const a = Math.cbrt(MU / (n * n));
        const epochStr = c[col.EPOCH].replace(/Z?$/, "Z");
        sats.push({
            inc: Number(c[col.INCLINATION]), raan: Number(c[col.RA_OF_ASC_NODE]), ecc: Number(c[col.ECCENTRICITY] || 0),
            argp: Number(c[col.ARG_OF_PERICENTER] || 0), ma: Number(c[col.MEAN_ANOMALY] || 0), mm,
            a, alt: a - RE_GEN, epochMs: Date.parse(epochStr), name: c[col.OBJECT_NAME] || "",
        });
    }
    return sats;
}

// Sort scalar values and split at gaps larger than tol; a circular domain (period) joins the
// last cluster to the first across the wrap. Returns [{ mean, n, members }].
function gapClusters(items, key, tol, period) {
    const v = [...items].sort((p, q) => key(p) - key(q));
    if (!v.length) return [];
    const cl = [[v[0]]];
    for (let i = 1; i < v.length; i++) (key(v[i]) - key(v[i - 1]) > tol ? cl.push([v[i]]) : cl[cl.length - 1].push(v[i]));
    const out = cl.map((members) => ({ members, offset: 0 }));
    if (period && out.length > 1) {
        const first = out[0], last = out[out.length - 1];
        if (key(first.members[0]) + period - key(last.members[last.members.length - 1]) <= tol) {
            last.offset = -period; // last cluster wraps onto the first
            first.members.push(...last.members); first.wrapped = last.members;
            out.pop();
        }
    }
    return out.map((c) => {
        const vals = c.members.map((m) => (c.wrapped && c.wrapped.includes(m) ? key(m) - period : key(m)));
        let mean = vals.reduce((s, x) => s + x, 0) / vals.length;
        if (period) mean = wrap360(mean * (360 / period)) * (period / 360);
        return { mean, n: c.members.length, members: c.members };
    });
}

// Gap clustering with a maximum cluster width: a cluster whose span exceeds maxWidth is cut
// into equal pieces, so a chain of near planes cannot merge into one entry far from any of
// them (that moved some Sun-synchronous planes by up to 0.2 h), while a real plane with its
// natural scatter stays one entry.
function boundedClusters(items, key, tol, maxWidth, period) {
    const out = [];
    for (const c of gapClusters(items, key, tol, period)) {
        const vals = c.members.map((m) => { let v = key(m) - c.mean; if (period) v = ((v + period * 1.5) % period) - period / 2; return v; });
        const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo;
        const pieces = Math.max(1, Math.ceil(span / maxWidth));
        if (pieces === 1) { out.push(c); continue; }
        const groups = Array.from({ length: pieces }, () => []);
        c.members.forEach((m, i) => groups[Math.min(pieces - 1, Math.floor((vals[i] - lo) / (span / pieces)))].push(m));
        for (const g of groups) if (g.length) {
            let mean = g.reduce((s, m) => s + key(m), 0) / g.length;
            if (period) { // circular mean for a group that may straddle the wrap
                const ang = g.map((m) => key(m) * 2 * Math.PI / period);
                mean = Math.atan2(ang.reduce((s, a) => s + Math.sin(a), 0), ang.reduce((s, a) => s + Math.cos(a), 0)) * period / (2 * Math.PI);
                mean = ((mean % period) + period) % period;
            }
            out.push({ mean, n: g.length, members: g });
        }
    }
    return out;
}

export function measure(sats, { refEpochMs, minShell = 8, minPlanes = 8 } = {}) {
    // Reference epoch: default = the most common epoch day, at 12:00 UTC.
    if (!refEpochMs) {
        const days = {};
        for (const s of sats) { const d = new Date(s.epochMs).toISOString().slice(0, 10); days[d] = (days[d] || 0) + 1; }
        const day = Object.entries(days).sort((p, q) => q[1] - p[1])[0][0];
        refEpochMs = Date.parse(day + "T12:00:00Z");
    }
    // Local MEAN solar time of the ascending node (hours) at the reference epoch:
    // LTAN = UT + (RAAN - GMST) / 15. A Sun-synchronous plane precesses at the mean Sun's
    // uniform rate, so this is the quantity that stays fixed on any date. (The true Sun's
    // right ascension differs by the equation of time, up to 4° = 16 min.)
    const refDate = new Date(refEpochMs);
    const gmstDeg = gmstRad(refDate) * 180 / Math.PI;
    const utHours = (refEpochMs % 86400000) / 3600000;
    for (const s of sats) {
        const dtDays = (refEpochMs - s.epochMs) / 86400000;
        s.rate = nodalRateDegPerDay(s.a, s.inc, s.ecc);
        s.raanRef = wrap360(s.raan + s.rate * dtDays);
        s.ltan = wrap24(utHours + (s.raanRef - gmstDeg) / 15);
        // Argument of latitude at the reference epoch (perigee drift ignored: ~0.1°/day).
        s.u = wrap360(s.argp + s.ma + s.mm * 360 * dtDays);
    }
    const shells = [];
    for (const incCl of gapClusters(sats, (s) => s.inc, 0.3)) {
        const incMean = incCl.members.reduce((s, m) => s + m.inc, 0) / incCl.n;
        const sso = Math.abs(incCl.members.reduce((s, m) => s + m.rate, 0) / incCl.n - SSO_RATE) < 0.15 * SSO_RATE;
        // 10 km altitude bands; small bands merge into the nearest kept band.
        const bands = new Map();
        for (const m of incCl.members) { const b = Math.round(m.alt / 10) * 10; if (!bands.has(b)) bands.set(b, []); bands.get(b).push(m); }
        const kept = [...bands.entries()].filter(([, ms]) => ms.length >= minShell).map(([b, ms]) => ({ band: b, members: ms }));
        if (!kept.length) kept.push({ band: [...bands.keys()][0], members: [] });
        for (const [b, ms] of bands) {
            if (ms.length >= minShell && kept.some((k) => k.band === b && k.members === ms)) continue;
            const near = kept.reduce((p, q) => (Math.abs(q.band - b) < Math.abs(p.band - b) ? q : p));
            near.members.push(...ms);
        }
        for (const k of kept) {
            const ms = k.members, n = ms.length;
            // Robust centre and spread: the median, and the standard deviation of the core
            // (members within 6 km of the median), so the few stragglers merged in from other
            // bands do not widen the shell.
            const alts = ms.map((m) => m.alt).sort((p, q) => p - q);
            const alt = alts[Math.floor(n / 2)];
            const core = alts.filter((x) => Math.abs(x - alt) <= 6);
            const coreMean = core.reduce((s, x) => s + x, 0) / core.length;
            const altSd = Math.sqrt(core.reduce((s, x) => s + (x - coreMean) ** 2, 0) / core.length);
            const shell = { inc: +incMean.toFixed(3), alt: +alt.toFixed(1), altSd: +altSd.toFixed(1), count: n };
            if (sso) {
                shell.sso = true;
                // Planes by local mean solar time of the ascending node. The real planes are
                // tight (< 0.01 h wide) and often come in pairs 0.04-0.08 h apart, so gaps
                // > 0.03 h separate planes, and a cluster wider than 0.05 h (0.75° of RAAN) is cut.
                const pl = boundedClusters(ms, (m) => m.ltan, 0.03, 0.05, 24);
                shell.ltan = pl.map((p) => [+p.mean.toFixed(2), p.n]);
            } else if (n >= minPlanes) {
                // Planes by RAAN at the reference epoch: gaps > 0.8° (2° at 70°) separate
                // planes; a cluster wider than 1.5° (3° at 70°) is cut.
                const pl = incMean > 60 ? boundedClusters(ms, (m) => m.raanRef, 2, 3, 360) : boundedClusters(ms, (m) => m.raanRef, 0.8, 1.5, 360);
                shell.raan = pl.map((p) => [+p.mean.toFixed(1), p.n]);
            }   // a smaller shell carries no plane list: the generator gives it random RAANs
            // Within-plane phase irregularity: for each plane with >= 8 satellites, the standard
            // deviation of the gaps in argument of latitude (deg) at the reference epoch; the
            // shell's gapSd is the median over its planes.
            const planes = sso ? gapClusters(ms, (m) => m.ltan, 0.08, 24) : (n >= minPlanes ? gapClusters(ms, (m) => m.raanRef, incMean > 60 ? 2 : 0.8, 360) : []);
            const sds = [];
            for (const p of planes) {
                if (p.n < 8) continue;
                const us = p.members.map((m) => m.u).sort((a, b) => a - b);
                const gaps = us.map((x, i) => (i ? x - us[i - 1] : x + 360 - us[us.length - 1]));
                const mean = 360 / us.length;
                sds.push(Math.sqrt(gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length));
            }
            if (sds.length) { sds.sort((a, b) => a - b); shell.gapSd = +sds[Math.floor(sds.length / 2)].toFixed(1); }
            shells.push(shell);
        }
    }
    shells.sort((p, q) => q.count - p.count);
    return { refEpoch: new Date(refEpochMs).toISOString(), total: sats.length, shells };
}

// The table as text: one line per shell (JSON), wrapped as an ES module unless asJson.
export function formatTable(res, { asJson = false, measuredAt = new Date().toISOString() } = {}) {
    const head = { source: res.source, measuredAt, refEpoch: res.refEpoch, total: res.total };
    const body = JSON.stringify(head, null, 1).replace(/\n}$/, ",\n") +
        ' "shells": [\n' + res.shells.map((sh) => "  " + JSON.stringify(sh)).join(",\n") + "\n ]\n}";
    if (asJson) return body + "\n";
    return `// starlinkShells.js — the measured Starlink shell table: what the real constellation looks
// like, as the synthetic constellation (dummyTLE.js) and the flare-rate model
// (rate/rateModel.js) need it. GENERATED by tools/measure-shells.mjs; do not edit by hand.
//
// Measured ${measuredAt.slice(0, 10)} from ${res.source} (${res.total} satellites, CelesTrak OMM CSV),
// elements moved to the reference epoch ${res.refEpoch}.
//
// One line per shell, in order of size: inc (deg), alt (km, generator altitude = semi-major
// axis from the mean motion minus 6371 km), altSd (km, spread), count, and the planes:
//   raan: [[raanDeg at refEpoch, satellites], ...]   the measured orbital planes; the
//         generator precesses them to the date with the J2 rate;
//   ltan: [[hours, satellites], ...]  for a Sun-synchronous shell (sso: true): the local
//         MEAN solar time of each plane's ascending node, which stays fixed on any date;
//   gapSd: the within-plane phase irregularity (deg).
// A plain ES module with the data inline (no JSON import, no fetch), so that Safari, the
// service worker and Node all load it the same way.
//
// To refresh: download a fresh CSV and run the measurement tool (see its header):
//   node tools/shf/tools/measure-shells.mjs starlink.csv
// Then run \`npm test\` in tools/shf and rebuild the rate page's year table
// (node tools/shf/tools/build-rate-table.mjs).

export const STARLINK_SHELLS = ${body};
`;
}

// ---- CLI ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2), opt = {}, pos = [];
    for (let i = 0; i < args.length; i++) (args[i].startsWith("--") ? (opt[args[i].slice(2)] = args[++i]) : pos.push(args[i]));
    const [inFile, outArg] = pos;
    if (!inFile) { console.error("usage: measure-shells.mjs <omm.csv> [outFile] [--ref ISO] [--min-shell N] [--min-planes N]"); process.exit(2); }
    const outFile = outArg || path.resolve(HERE, "../starlinkShells.js");
    const sats = readOMM(fs.readFileSync(inFile, "utf8"));
    const res = measure(sats, { refEpochMs: opt.ref ? Date.parse(opt.ref) : undefined, minShell: Number(opt["min-shell"] || 8), minPlanes: Number(opt["min-planes"] || 8) });
    res.source = path.basename(inFile);
    const epochs = sats.map((s) => s.epochMs).sort((p, q) => p - q);
    const stale = sats.filter((s) => (Date.parse(res.refEpoch) - s.epochMs) > 2 * 86400000).length;
    console.log(`${sats.length} satellites; epochs ${new Date(epochs[0]).toISOString().slice(0, 10)}..${new Date(epochs[epochs.length - 1]).toISOString().slice(0, 10)}; ${stale} older than 2 days before ${res.refEpoch}`);
    console.log(`${res.shells.length} shells:`);
    for (const sh of res.shells) {
        const planes = sh.sso ? sh.ltan : sh.raan;
        const big = planes ? planes.filter((p) => p[1] >= 5).length : 0;
        console.log(`  ${String(sh.inc).padStart(7)}° ${String(sh.alt).padStart(6)} km ±${sh.altSd}  n=${String(sh.count).padStart(5)} (${(100 * sh.count / res.total).toFixed(2)}%)  ${sh.sso ? "SSO " : ""}${planes ? `planes ${planes.length} (${big} with >=5 sats)` : "random RAAN"}${sh.gapSd != null ? `  gapSd ${sh.gapSd}°` : ""}`);
    }
    const text = formatTable(res, { asJson: outFile.endsWith(".json") });
    fs.writeFileSync(outFile, text);
    console.log(`wrote ${outFile} (${text.length} bytes)`);
}
