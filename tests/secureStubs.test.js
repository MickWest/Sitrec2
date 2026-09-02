// Guards the secure-build stub layer (src/secureStubs/, scripts/secureStubs.js):
//
//   - every module the secure build aliases away exists, and so does its stub
//   - every stub exports at least the names the original exports, so no "export X was not
//     found" warning can appear only in the secure build
//   - every stub carries its audit marker, exactly once across the set
//   - no stub reintroduces a hostname the stubbing exists to remove
//   - the "must be absent" hostname list is honest: each is absent from every module that
//     stays in the bundle, and each gated hostname is still where the registry says it is
//   - the compile-time gate flag exists and each gated module reads it
//
// Everything here is read statically from the source on disk; no stub is imported.

import fs from "fs";
import path from "path";

const registry = require("../scripts/secureStubs.js");
const {aliases, removedMarkers, originalHostLiterals, gatedHostLiterals} = registry;

const REPO_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(REPO_ROOT, "src");
const STUBS_DIR = path.join(SRC_DIR, "secureStubs");
const pairs = Object.entries(aliases);

const GATE_FLAG = "isSecureBuild";
const GATED_FILES = [
    "src/index.js",
    "src/CClientNLU.js",
    "src/nodes/CNodeDisplayWindField.js",
    "src/nodes/WindSources.js",
];

const read = (file) => fs.readFileSync(file, "utf8");
const rel = (file) => path.relative(REPO_ROOT, file);

// The names a module exports, read statically. Covers the forms the aliased modules use:
//   export function f / export async function f / export class C
//   export const a / export let a / export var a      (one declarator per statement)
//   export const {a, b} = ...
//   export {a, b as c} [from "..."]
//   export default ...
// `export * from` cannot be resolved without following the import, so it fails the test
// rather than silently contributing nothing. Only column-0 `export` counts, which keeps a
// mention inside a comment block (indented with " * ") from registering.
function exportNames(source, file) {
    const names = new Set();
    const re = /^export\s+(?:(default)\b|(\*)|(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s*\{([^}]*)\}|\{([^}]*)\})/gm;
    let m;
    while ((m = re.exec(source)) !== null) {
        const [, dflt, star, fn, cls, decl, destructured, list] = m;
        if (dflt) {
            names.add("default");
        } else if (star) {
            throw new Error(`${file}: "export * from" is not supported by this extractor`);
        } else if (fn) {
            names.add(fn);
        } else if (cls) {
            names.add(cls);
        } else if (decl) {
            names.add(decl);
        } else if (destructured !== undefined) {
            for (const part of destructured.split(",")) {
                const name = part.split(":").pop().split("=")[0].trim();
                if (name) names.add(name);
            }
        } else if (list !== undefined) {
            for (const part of list.split(",")) {
                const item = part.trim();
                if (!item) continue;
                const asMatch = item.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
                names.add(asMatch ? asMatch[2] : item);
            }
        }
    }
    return names;
}

// The module specifiers a file imports, static `import ... from` forms only.
function importSpecifiers(source) {
    return [...source.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map(m => m[1]);
}

function walkSources(dir, out = []) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkSources(full, out);
        else if (/\.(js|mjs|cjs|ts)$/.test(entry.name)) out.push(full);
    }
    return out;
}

// Source files that stay in the secure bundle: everything under src/ except the aliased
// originals and the stubs themselves.
function remainingSources() {
    const originals = new Set(Object.keys(aliases));
    return walkSources(SRC_DIR).filter(f => !originals.has(f) && !f.startsWith(STUBS_DIR + path.sep));
}

describe("secure-build stub registry shape", () => {
    test("has the exports webpack.secure.js requires", () => {
        expect(pairs.length).toBeGreaterThan(0);
        expect(Array.isArray(removedMarkers)).toBe(true);
        expect(Array.isArray(originalHostLiterals)).toBe(true);
        expect(Array.isArray(gatedHostLiterals)).toBe(true);
    });

    test("alias keys and values are absolute and distinct", () => {
        for (const [original, stub] of pairs) {
            expect(path.isAbsolute(original)).toBe(true);
            expect(path.isAbsolute(stub)).toBe(true);
            expect(original).not.toBe(stub);
        }
        expect(new Set(Object.values(aliases)).size).toBe(pairs.length);
    });

    test("one marker per stub, all distinct", () => {
        expect(removedMarkers.length).toBe(pairs.length);
        expect(new Set(removedMarkers).size).toBe(removedMarkers.length);
        for (const marker of removedMarkers) expect(marker).toMatch(/^__SITREC_SECURE_STUB__:[A-Za-z0-9_]+$/);
    });
});

describe("secure-build alias pairs", () => {
    test.each(pairs.map(([original, stub]) => [rel(original), original, stub]))(
        "%s: original and stub both exist on disk", (label, original, stub) => {
            expect(fs.existsSync(original)).toBe(true);
            expect(fs.existsSync(stub)).toBe(true);
        });

    test.each(pairs.map(([original, stub]) => [rel(original), original, stub]))(
        "%s: the stub exports every name the original exports", (label, original, stub) => {
            const wanted = exportNames(read(original), rel(original));
            const have = exportNames(read(stub), rel(stub));
            const missing = [...wanted].filter(name => !have.has(name));
            expect(missing).toEqual([]);
            expect(wanted.size).toBeGreaterThan(0);
        });

    test.each(pairs.map(([original, stub]) => [rel(stub), stub]))(
        "%s: carries its own marker and the standard header", (label, stub) => {
            const source = read(stub);
            const marker = "__SITREC_SECURE_STUB__:" + path.basename(stub, ".js");
            expect(removedMarkers).toContain(marker);
            expect(source).toContain(`export const SECURE_STUB_MARKER = "${marker}"`);
            expect(source).toContain("Secure-build stub. The original module is compiled out of the secure build");
        });

    test("every marker appears in exactly one stub", () => {
        const sources = pairs.map(([, stub]) => read(stub));
        for (const marker of removedMarkers) {
            const count = sources.filter(s => s.includes(marker)).length;
            expect({marker, count}).toEqual({marker, count: 1});
        }
    });

    test.each(pairs.map(([, stub]) => [rel(stub), stub]))(
        "%s: contains no removed or gated hostname", (label, stub) => {
            const source = read(stub);
            const found = [...originalHostLiterals, ...gatedHostLiterals].filter(host => source.includes(host));
            expect(found).toEqual([]);
        });

    test("no stub imports an aliased original", () => {
        const originalNames = Object.keys(aliases).map(f => path.basename(f, ".js"));
        for (const [, stub] of pairs) {
            const offending = importSpecifiers(read(stub))
                .filter(spec => originalNames.includes(path.basename(spec, ".js")));
            expect({stub: rel(stub), offending}).toEqual({stub: rel(stub), offending: []});
        }
    });

    // The secure build swaps the module in after resolution, and the swapped-in module keeps
    // the ORIGINAL's directory as the base for its own relative imports. A stub import must
    // therefore name an existing file from the original's directory AND from the stub's own,
    // so that it works whichever base webpack uses. (Every stub but one has no imports.)
    test.each(pairs.map(([original, stub]) => [rel(stub), original, stub]))(
        "%s: every relative import resolves from the original's directory and from its own", (label, original, stub) => {
            const unresolved = [];
            for (const spec of importSpecifiers(read(stub))) {
                if (!spec.startsWith(".")) continue;
                for (const base of [path.dirname(original), path.dirname(stub)]) {
                    const target = path.resolve(base, spec);
                    const exists = [target, target + ".js", target + ".ts"].some(f => fs.existsSync(f) && fs.statSync(f).isFile());
                    if (!exists) unresolved.push(`${spec} from ${rel(base)}`);
                }
            }
            expect(unresolved).toEqual([]);
        });
});

describe("secure-build hostname lists", () => {
    const remaining = remainingSources().map(file => ({file, source: read(file)}));

    test.each(originalHostLiterals)("%s is absent from every module that stays in the bundle", (host) => {
        const carriers = remaining.filter(({source}) => source.includes(host)).map(({file}) => rel(file));
        expect(carriers).toEqual([]);
    });

    test.each(originalHostLiterals)("%s is present in at least one aliased original", (host) => {
        const carriers = Object.keys(aliases).filter(file => read(file).includes(host));
        expect(carriers.length).toBeGreaterThan(0);
    });

    test.each(gatedHostLiterals)("%s is present in a gated module that reads the flag", (host) => {
        const carriers = GATED_FILES
            .map(file => path.join(REPO_ROOT, file))
            .filter(file => read(file).includes(host));
        expect(carriers.length).toBeGreaterThan(0);
        for (const file of carriers) expect(read(file)).toContain(GATE_FLAG);
    });
});

describe("secure-build compile-time gate", () => {
    test("configUtils exports the flag in the agreed form", () => {
        const source = read(path.join(SRC_DIR, "configUtils.js"));
        const matches = source.match(/^export const isSecureBuild = process\.env\.IS_SECURE_BUILD === 'true';?$/gm) || [];
        expect(matches.length).toBe(1);
    });

    test.each(GATED_FILES)("%s imports and reads the flag", (file) => {
        const source = read(path.join(REPO_ROOT, file));
        expect(source).toMatch(/^import\s+\{[^}]*\bisSecureBuild\b[^}]*\}\s+from\s+["'][./]*\/?configUtils["']/m);
        expect(source.split(GATE_FLAG).length).toBeGreaterThan(2);
    });
});
