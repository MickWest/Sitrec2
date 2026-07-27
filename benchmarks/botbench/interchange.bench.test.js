/**
 * interchange.bench.test.js — generate the generic BOT interchange file set
 * (input + truth) for a curated group of scenarios, so algorithms outside
 * Sitrec can be run against them and scored against the same truth.
 *
 *     npm run bench-bot-interchange                      # development set
 *     BOTBENCH_OPAQUE=1 BOTBENCH_SEAL_SALT=$(openssl rand -hex 32) \
 *       npm run bench-bot-interchange                    # sealed release
 *
 * Development set (default) — descriptive filenames, truth alongside:
 *
 *     input/<name>.input.csv       the challenge
 *     input/<name>.scenario.json   frame, datum, timing, declared LOS error
 *     truth/<name>.truth.csv       the answer key
 *     truth/<name>.truth.json      class, events, geometry gate, provenance
 *     index.json, MANIFEST.json
 *
 * Sealed release — opaque salt-permuted ids, parameters drawn from the salt,
 * and a separable challenge:
 *
 *     challenge/   ship this
 *     answers/     keep this (truth, opaque map, realized specs, salt)
 *
 * The scenario set and the release builder live in lib/interchangeRelease.js;
 * the security properties of a sealed release are tested by
 * tests/botbench/interchangeReidentification.test.js.
 */

import fs from "fs";
import path from "path";
import {setSit} from "../../src/Globals";
import {VENUS_EPOCH_ISO} from "./lib/venus";
import {sha256} from "./lib/exportInterchange";
import {SCENARIOS, buildRelease, assignOpaqueIds} from "./lib/interchangeRelease";

const OUT_DIR = path.resolve(__dirname, "results", "interchange");

describe("BOT interchange export", () => {
    jest.setTimeout(180000);

    beforeAll(() => {
        setSit({name: "botbench-interchange", frames: 10000, fps: 10,
            simSpeed: 1, lat: 40, lon: -105});
    });

    test("writes input + truth file sets", () => {
        const sealed = process.env.BOTBENCH_OPAQUE === "1";
        const saltHex = process.env.BOTBENCH_SEAL_SALT ?? null;

        // FAIL CLOSED: buildRelease throws without a valid salt when sealed.
        const rel = buildRelease({outDir: OUT_DIR, sealed, saltHex});
        const {index, manifest, challengeDir, answersDir, realized} = rel;

        // A sealed release withholds noiseless members and truth-sharing
        // duplicates, so it ships fewer scenarios than the template set. Both
        // reasons count — a noiseless member is now dropped on its own merits
        // before the duplicate pass sees it.
        const withheld = (manifest.withheldNoiseless ?? 0)
            + manifest.withheldForSharedTruth;
        expect(index.length).toBe(SCENARIOS.length - withheld);
        if (!sealed) expect(index.length).toBe(SCENARIOS.length);

        for (const r of index) {
            const inputText = fs.readFileSync(r.files.inputFile, "utf8");
            const truthText = fs.readFileSync(r.files.truthFile, "utf8");
            // header + one row per frame, plus the trailing newline
            expect(inputText.trim().split("\n").length).toBe(r.frames + 1);
            expect(truthText.trim().split("\n").length).toBe(r.frames + 1);

            // Truth must NOT be reachable from the public manifest: the seed,
            // the generator version and the spec regenerate it exactly.
            const pub = JSON.parse(fs.readFileSync(r.files.scenarioFile, "utf8"));
            expect(pub.scenarioSeed).toBeUndefined();
            expect(pub.generatorVersion).toBeUndefined();
            expect(pub.spec).toBeUndefined();
            // The seal must cover every file, not just truth.csv.
            expect(pub.seal.inputCsvSha256).toBe(sha256(inputText));
            expect(pub.seal.truthCsvCommit).toMatch(/^[0-9a-f]{64}$/);
            expect(pub.seal.truthJsonCommit).toMatch(/^[0-9a-f]{64}$/);
            expect(pub.seal.salted).toBe(sealed);
        }

        // Names must be unique — two scenarios differing only in a field the
        // name omits would silently overwrite each other.
        const names = index.map((r) => r.name);
        expect(new Set(names).size).toBe(names.length);

        // Rows must be id-sorted: generator order is a channel.
        expect([...names].sort()).toEqual(names);
        expect(manifest.files.map((f) => f.name)).toEqual(names);

        // No two public manifests may be identical modulo their id. Two that
        // match on every other field are an identifiable pair, and a matched
        // anomaly/control pair being identifiable means the entrant knows
        // exactly one of the two is anomalous.
        const fingerprints = index.map((r) => {
            const p = JSON.parse(fs.readFileSync(r.files.scenarioFile, "utf8"));
            delete p.trackId; delete p.label; delete p.seal;
            return JSON.stringify(p);
        });
        expect(new Set(fingerprints).size).toBe(fingerprints.length);

        // Venus truth is generated at venus.js's own VENUS_EPOCH_ISO —
        // generateScenario does NOT forward spec.epochISO to it. Publishing a
        // different epoch would silently hand out an epoch that does not
        // correspond to the bearings in truth.csv. Randomization must never
        // touch it, and it must not be the only night epoch in the set.
        const venus = realized.find((r) => r.spec.target.kind === "venus");
        expect(venus.spec.epochISO).toBe(VENUS_EPOCH_ISO);
        const nightCount = realized.filter((r) => r.spec.epochISO === VENUS_EPOCH_ISO).length;
        expect(nightCount).toBeGreaterThan(1);

        if (sealed) {
            expect(manifest.parametersRandomized).toBe(true);
            // The permutation must depend on the salt, and be reproducible
            // from it once released.
            const descriptives = realized.map((r) => r.descriptive);
            expect(assignOpaqueIds(descriptives, saltHex))
                .not.toEqual(assignOpaqueIds(descriptives, "0".repeat(64)));

            // Nothing under the shippable challenge root may carry a
            // descriptive name, a note, or the salt.
            const walk = (d) => fs.readdirSync(d, {withFileTypes: true}).flatMap((x) =>
                x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)]);
            const leaked = [];
            for (const f of walk(challengeDir)) {
                const text = fs.readFileSync(f, "utf8");
                for (const d of descriptives) {
                    if (text.includes(d)) leaked.push(`${path.basename(f)}: ${d}`);
                }
                for (const s of SCENARIOS) {
                    if (text.includes(s.note.slice(0, 40))) leaked.push(`${path.basename(f)}: note`);
                }
                if (text.includes(saltHex)) leaked.push(`${path.basename(f)}: SALT`);
                if (/Truth(Pos|Dir|Vel)/.test(text)) leaked.push(`${path.basename(f)}: truth cols`);
            }
            expect(leaked).toEqual([]);
        }

        console.log(`[botbench] wrote ${index.length} interchange sets to ${OUT_DIR}`
            + `${sealed ? " (SEALED: ship challenge/, keep answers/)" : ""}`);
        console.log(`[botbench] manifestSha256 ${manifest.manifestSha256}`);
        if (sealed) console.log(`[botbench] answers kept in ${answersDir}`);
        for (const r of index) console.log(`  ${r.name}`);
    });
});
