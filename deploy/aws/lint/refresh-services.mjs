#!/usr/bin/env node
// Fetches the list of AWS services offered in a region and writes it as a
// snapshot for partition-lint.mjs.
//
//   node deploy/aws/lint/refresh-services.mjs --region <r> [--region <r2> ...]
//
// The list comes from the public global-infrastructure parameters:
//   /aws/service/global-infrastructure/regions/<r>/services/<code>
// They are queryable only from a commercial region, so the query goes to
// us-east-1 (override with --source-region) whatever the target region is. The
// AWS CLI is used rather than an SDK; set AWS_CLI to point at a specific binary.
//
// Output: deploy/aws/lint/snapshots/<r>.json (override the directory with --out)
//   { "region": r, "fetchedAt": iso, "services": [codes, sorted] }
//
// Snapshots are never committed: the directory is gitignored because a snapshot
// names the target region. Refresh before every plan check.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LINT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT_DIR = path.join(LINT_DIR, 'snapshots');
const DEFAULT_SOURCE_REGION = 'us-east-1';

export function servicesPath(region) {
    return `/aws/service/global-infrastructure/regions/${region}/services`;
}

// Service codes from one or more pages of get-parameters-by-path output.
// The code is the last segment of the parameter name; the value repeats it.
export function servicesFromPages(pages) {
    const codes = new Set();
    for (const page of pages) {
        for (const parameter of page.Parameters ?? []) {
            const name = parameter.Name ?? '';
            const code = name.slice(name.lastIndexOf('/') + 1);
            if (code) codes.add(code);
        }
    }
    return [...codes].sort();
}

function awsCli() {
    return process.env.AWS_CLI || 'aws';
}

// Runs the paged query and returns every page's parsed JSON.
export function fetchServicePages(region, { sourceRegion = DEFAULT_SOURCE_REGION, profile = null } = {}) {
    const pages = [];
    let nextToken = null;
    do {
        const args = ['ssm', 'get-parameters-by-path',
            '--region', sourceRegion,
            '--path', servicesPath(region),
            '--recursive',
            '--output', 'json'];
        if (profile) args.push('--profile', profile);
        if (nextToken) args.push('--next-token', nextToken);
        const stdout = execFileSync(awsCli(), args, { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] });
        const page = JSON.parse(stdout);
        pages.push(page);
        nextToken = page.NextToken ?? null;
    } while (nextToken);
    return pages;
}

export function writeSnapshot(outDir, region, services) {
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${region}.json`);
    const snapshot = { region, fetchedAt: new Date().toISOString(), services };
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n');
    return file;
}

function parseArgs(argv) {
    const opts = { regions: [], out: DEFAULT_OUT_DIR, sourceRegion: DEFAULT_SOURCE_REGION, profile: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => {
            const value = argv[++i];
            if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
            return value;
        };
        switch (arg) {
            case '--region': opts.regions.push(next()); break;
            case '--out': opts.out = path.resolve(next()); break;
            case '--source-region': opts.sourceRegion = next(); break;
            case '--profile': opts.profile = next(); break;
            case '--help': case '-h': opts.help = true; break;
            default: throw new Error(`unknown argument ${arg}`);
        }
    }
    return opts;
}

const USAGE = `usage: refresh-services.mjs --region <r> [--region <r2> ...] [--out <dir>]
                            [--source-region <commercial region>] [--profile <name>]
`;

export function main(argv = process.argv.slice(2)) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (err) {
        console.error(`refresh-services: ${err.message}\n${USAGE}`);
        return 2;
    }
    if (opts.help) {
        console.log(USAGE);
        return 0;
    }
    if (opts.regions.length === 0) {
        console.error(`refresh-services: at least one --region is required\n${USAGE}`);
        return 2;
    }

    let failed = false;
    for (const region of opts.regions) {
        let pages;
        try {
            pages = fetchServicePages(region, { sourceRegion: opts.sourceRegion, profile: opts.profile });
        } catch (err) {
            const detail = (err.stderr ?? err.message ?? '').toString().trim();
            console.error(`refresh-services: query for ${region} failed (${awsCli()} via ${opts.sourceRegion}):\n  ${detail}`);
            failed = true;
            continue;
        }
        const services = servicesFromPages(pages);
        if (services.length === 0) {
            console.error(`refresh-services: no services listed for ${region}; is the region name right?`);
            failed = true;
            continue;
        }
        const file = writeSnapshot(opts.out, region, services);
        console.log(`refresh-services: ${region}: ${services.length} services (${pages.length} page(s)) -> ${file}`);
    }
    return failed ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    process.exitCode = main();
}
