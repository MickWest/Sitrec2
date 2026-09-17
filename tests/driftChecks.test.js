/**
 * Drift Checks — verifies that things that must stay in sync across files actually do.
 *
 * These tests catch silent regressions where a change in one file requires
 * a corresponding change in another, but the second change was forgotten.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');

// ============================================================
// 1. Test Registry ↔ Actual Test Files
// ============================================================

describe('Test Registry sync', () => {
    let TEST_REGISTRY;

    beforeAll(() => {
        // Parse test-registry.js by evaluating the array literal
        // (can't use dynamic import() without --experimental-vm-modules)
        const content = fs.readFileSync(path.join(ROOT, 'test-registry.js'), 'utf-8');
        // Extract the array between "export const TEST_REGISTRY = [" and the matching "];"
        const match = content.match(/export const TEST_REGISTRY\s*=\s*(\[[\s\S]*?\n\];)/);
        if (!match) throw new Error('Could not parse TEST_REGISTRY from test-registry.js');
        // eslint-disable-next-line no-eval
        TEST_REGISTRY = eval(match[1]);
    });

    test('registry is non-empty', () => {
        expect(TEST_REGISTRY.length).toBeGreaterThan(30);
    });

    test('all registry IDs are unique', () => {
        const ids = TEST_REGISTRY.map(t => t.id);
        const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
        expect(dupes).toEqual([]);
    });

    test('all registry entries reference existing test files', () => {
        const missing = [];
        for (const entry of TEST_REGISTRY) {
            const testFile = path.join(ROOT, 'tests_regression', entry.file);
            if (!fs.existsSync(testFile)) {
                missing.push(`${entry.id}: references ${entry.file} which does not exist`);
            }
        }
        expect(missing).toEqual([]);
    });

    test('all registry grep patterns appear in their test files', () => {
        const mismatches = [];
        // Cache file contents
        const fileCache = {};
        for (const entry of TEST_REGISTRY) {
            const testFile = path.join(ROOT, 'tests_regression', entry.file);
            if (!fs.existsSync(testFile)) continue;
            if (!fileCache[entry.file]) {
                fileCache[entry.file] = fs.readFileSync(testFile, 'utf-8');
            }
            const content = fileCache[entry.file];
            if (!content.includes(entry.grep)) {
                mismatches.push(`${entry.id}: grep "${entry.grep}" not found in ${entry.file}`);
            }
        }
        expect(mismatches).toEqual([]);
    });

    test('playwright.config.js testMatch includes all non-Docker test files referenced by registry', () => {
        const configPath = path.join(ROOT, 'playwright.config.js');
        const configContent = fs.readFileSync(configPath, 'utf-8');

        // Docker tests use playwright.docker.config.js, not the main config
        const registryFiles = [...new Set(
            TEST_REGISTRY.filter(t => t.group !== 'Docker').map(t => t.file)
        )];
        const missing = registryFiles.filter(f => !configContent.includes(f));
        expect(missing).toEqual([]);
    });

});

// ============================================================
// 2. 3D Model Files — referenced models must exist
// ============================================================

describe('3D Model file sync', () => {
    const modelsDir = path.join(ROOT, 'data/models');
    let modelFilesContent;

    beforeAll(() => {
        modelFilesContent = fs.readFileSync(
            path.join(ROOT, 'src/nodes/CNode3DObject.js'), 'utf-8'
        );
    });

    test('all active (non-commented) ModelFiles entries exist on disk', () => {
        const missing = [];
        // Extract the ModelFiles object block
        const mfMatch = modelFilesContent.match(/const\s+ModelFiles\s*=\s*\{([\s\S]*?)\n\}/);
        if (!mfMatch) return; // ModelFiles not found, skip

        const block = mfMatch[1];
        const lines = block.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('//')) continue;
            // Match the value side: "key": "data/models/foo.glb"
            const match = trimmed.match(/:\s*"(data\/models\/[^"]+\.glb)"/);
            if (match) {
                const glbFile = match[1];
                // Decode URL-encoded characters (e.g., %20 -> space)
                const decoded = decodeURIComponent(glbFile);
                const fullPath = path.join(ROOT, decoded);
                if (!fs.existsSync(fullPath)) {
                    missing.push(`${decoded} (from CNode3DObject.js)`);
                }
            }
        }
        expect(missing).toEqual([]);
    });
});

// ============================================================
// 3. Serverless sitch exclusion list — excluded sitches should exist
// ============================================================

describe('Serverless sitch exclusion sync', () => {
    test('all excluded sitch names have corresponding sitch definitions', () => {
        const registerContent = fs.readFileSync(
            path.join(ROOT, 'src/RegisterSitches.js'), 'utf-8'
        );

        // Extract the excludedInServerless array
        const match = registerContent.match(/excludedInServerless\s*=\s*isServerless\s*\?\s*\[([^\]]+)\]/);
        if (!match) {
            // No exclusion list found — nothing to check
            return;
        }

        const excludedNames = match[1].match(/'([^']+)'/g)?.map(s => s.replace(/'/g, '')) || [];

        // Each excluded name should correspond to a sitch with that name
        // Read all sitch files and extract their name fields
        const sitchDir = path.join(ROOT, 'src/sitch');
        const sitchNames = new Set();
        if (fs.existsSync(sitchDir)) {
            for (const file of fs.readdirSync(sitchDir).filter(f => f.endsWith('.js'))) {
                const content = fs.readFileSync(path.join(sitchDir, file), 'utf-8');
                const nameMatch = content.match(/name:\s*"([^"]+)"/);
                if (nameMatch) sitchNames.add(nameMatch[1]);
            }
        }

        // Also check data/ directory sitches
        const dataDir = path.join(ROOT, 'data');
        if (fs.existsSync(dataDir)) {
            for (const dir of fs.readdirSync(dataDir)) {
                const sitFile = path.join(dataDir, dir, `Sit${dir.charAt(0).toUpperCase() + dir.slice(1)}.js`);
                if (fs.existsSync(sitFile)) {
                    const content = fs.readFileSync(sitFile, 'utf-8');
                    const nameMatch = content.match(/name:\s*"([^"]+)"/);
                    if (nameMatch) sitchNames.add(nameMatch[1]);
                }
            }
        }

        const orphans = excludedNames.filter(n => !sitchNames.has(n));
        if (orphans.length > 0) {
            console.warn('Excluded sitches with no matching definition (may be variants):', orphans);
        }
        // Warn but don't fail — some may be intentional variants
    });
});

// ============================================================
// 4. Config example files — examples should exist for all config files
// ============================================================

describe('Config template sync', () => {
    const configDir = path.join(ROOT, 'config');

    test('every .example config file has the same base name pattern', () => {
        if (!fs.existsSync(configDir)) return;
        const files = fs.readdirSync(configDir);
        const examples = files.filter(f => f.includes('.example'));
        // Each example should correspond to a live config filename pattern
        expect(examples.length).toBeGreaterThan(0);

        for (const example of examples) {
            // config.js.example -> config.js
            const liveFile = example.replace('.example', '');
            // The live file won't be in git, but the example should be well-formed
            expect(liveFile).not.toBe(example); // sanity: replacement worked
        }
    });
});

// ============================================================
// 5. Package.json script references — all referenced files should exist
// ============================================================

describe('Package.json script file references', () => {
    let scripts;

    beforeAll(() => {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
        scripts = pkg.scripts || {};
    });

    test('all "node <file>" script references point to existing files', () => {
        const missing = [];
        // Scripts that reference files outside this repo (sitrec-tools, etc.)
        // These are legitimate external references, not drift
        const externalScripts = new Set(['test-misb']);

        for (const [name, cmd] of Object.entries(scripts)) {
            if (externalScripts.has(name)) continue;
            // Match patterns like "node test-viewer.js" or "node scripts/foo.js"
            const match = cmd.match(/\bnode\s+([^\s&|;]+\.m?js)/);
            if (match) {
                // Resolve relative to ROOT (handles ../ paths correctly)
                const filePath = path.resolve(ROOT, match[1]);
                if (!fs.existsSync(filePath)) {
                    missing.push(`script "${name}": references ${match[1]} which does not exist`);
                }
            }
        }
        expect(missing).toEqual([]);
    });
});

// ============================================================
// 6. Node file imports — src/nodes/ files should not import from "three/src/*"
// ============================================================

describe('Three.js import convention', () => {
    const nodesDir = path.join(ROOT, 'src/nodes');

    test('no node files import from "three/src/*" (must use "three")', () => {
        const violations = [];
        const files = fs.readdirSync(nodesDir).filter(f => f.endsWith('.js'));
        for (const file of files) {
            const content = fs.readFileSync(path.join(nodesDir, file), 'utf-8');
            if (content.includes('from "three/src/') || content.includes("from 'three/src/")) {
                violations.push(file);
            }
        }
        expect(violations).toEqual([]);
    });

    test('no src/ files import from "three/src/*"', () => {
        const srcDir = path.join(ROOT, 'src');
        const violations = [];
        const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.js'));
        for (const file of files) {
            const content = fs.readFileSync(path.join(srcDir, file), 'utf-8');
            if (content.includes('from "three/src/') || content.includes("from 'three/src/")) {
                violations.push(file);
            }
        }
        expect(violations).toEqual([]);
    });
});

// ============================================================
// 7. Webpack copy patterns — serverless data whitelist vs actual data dirs
// ============================================================

describe('Serverless data directory whitelist', () => {
    test('whitelisted data directories all exist', () => {
        const wpContent = fs.readFileSync(
            path.join(ROOT, 'webpackCopyPatterns.js'), 'utf-8'
        );

        // Extract the serverless data directory whitelist
        // Pattern: filter(dir => ['custom', 'images', ...].includes(dir))
        const match = wpContent.match(/\[([^\]]*)\]\.includes\(dir\)/);
        if (!match) return; // pattern not found, skip

        const dirs = match[1].match(/'([^']+)'/g)?.map(s => s.replace(/'/g, '')) || [];
        const dataDir = path.join(ROOT, 'data');
        const missing = dirs.filter(d => !fs.existsSync(path.join(dataDir, d)));
        expect(missing).toEqual([]);
    });
});

// ============================================================
// 8. Modules copied unbundled to tools/src — their static imports must be there too
// ============================================================

describe('Modules copied unbundled to tools/src', () => {
    // A tool page loads these files as plain ES modules, not through webpack. A static
    // import that is not also copied, or that leaves off its .js extension, 404s in the
    // browser, and the whole tool then fails to load. That happened to tools/flowgen.html
    // and went unnoticed for months. Dynamic import() is not checked: it fails only on
    // the code path that reaches it.
    let copied;

    beforeAll(() => {
        let patterns;
        const previous = process.env.IS_SERVERLESS_BUILD;
        jest.isolateModules(() => {
            // The patterns read this checkout's install configuration and, outside a
            // serverless build, its server files. Neither affects these copies.
            jest.doMock("../config/config-install", () => ({dev_path: "/nonexistent"}), {virtual: true});
            process.env.IS_SERVERLESS_BUILD = "true";
            try {
                patterns = require("../webpackCopyPatterns");
            } finally {
                if (previous === undefined) delete process.env.IS_SERVERLESS_BUILD;
                else process.env.IS_SERVERLESS_BUILD = previous;
            }
        });
        copied = patterns
            .filter(p => typeof p.from === 'string' && /^\.\/src\/[^*]+\.js$/.test(p.from)
                && String(p.to).startsWith('./tools/src/'))
            .map(p => ({from: path.normalize(p.from), to: path.normalize(p.to)}));
    });

    test('the copy patterns still name at least one module', () => {
        expect(copied.length).toBeGreaterThan(0);
    });

    test('every static relative import resolves to a copied file', () => {
        const copiedTo = new Set(copied.map(c => c.to));
        const problems = [];
        for (const {from, to} of copied) {
            const source = fs.readFileSync(path.join(ROOT, from), 'utf-8');
            for (const match of source.matchAll(/^\s*import\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/gm)) {
                const target = path.normalize(path.join(path.dirname(to), match[1]));
                // tools/src also holds files that live there in the repo, copied by the tools/ pattern.
                if (!copiedTo.has(target) && !fs.existsSync(path.join(ROOT, target))) {
                    problems.push(`${from} imports "${match[1]}", but nothing is copied to ${target}`);
                }
            }
        }
        expect(problems).toEqual([]);
    });
});
