#!/usr/bin/env node
// Partition lint for the hardened AWS deployment (deploy/aws).
//
// The hardened deployment runs in an AWS partition that lacks some services and
// uses a different ARN prefix. The Terraform module is written to be
// partition-neutral: ARNs come from data.aws_partition, no region or endpoint is a
// literal, and no resource type is used that an isolated partition does not offer.
// This tool is the proof that it stays so. It has two layers:
//
//   Static checks — need only the source tree. Run in CI on every push
//   (`npm run lint-partition`) and by an operator before an apply.
//
//   Plan checks — need `terraform show -json` output (`--plan`) and a service
//   snapshot for the target region (`--region`, see refresh-services.mjs).
//
// Usage:
//   node deploy/aws/lint/partition-lint.mjs --static-only
//   node deploy/aws/lint/partition-lint.mjs --region <r> --plan plan.json
//   node deploy/aws/lint/partition-lint.mjs --region <r> --plan plan.json --snapshot file.json
//   node deploy/aws/lint/partition-lint.mjs --sources deploy/aws docker --static-only
//   add --json for machine-readable output
//
// Exit status: 0 when nothing failed, 1 on any failure, 2 on a usage error.
// Plain Node, no dependencies. The check functions are exported for tests.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LINT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(LINT_DIR, '..', '..', '..');

export const DEFAULT_SOURCES = ['deploy/aws', 'sitrecServer', 'src', 'docker'];
export const DEFAULT_SNAPSHOT_DIR = path.join(LINT_DIR, 'snapshots');

// Directory names never descended into, wherever they occur.
const SKIP_DIR_NAMES = new Set(['node_modules', 'vendor', '.git', '.terraform', 'dist',
    'dist-standalone', 'dist-serverless', 'dist-secure', '__pycache__']);

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

// The commercial-partition ARN prefix. Every partition has its own; a literal one
// is wrong everywhere but the partition it names.
const ARN_LITERAL = /arn:aws:/g;

// An AWS endpoint hostname. Also the partition-specific DNS suffix.
const ENDPOINT_LITERAL = /amazonaws\.com(?![a-z0-9.-])/gi;

// A region name. Only checked in Terraform files; the application has a
// documented reason for the ones it carries (commercial S3 URL parsing).
const REGION_LITERAL = /\b(us|eu|ap|sa|ca|me|af|il)-(gov-)?[a-z]+-\d\b/g;

// Resource types that are never part of an isolated deployment: either the
// service does not exist in the target partition, or the design forbids it.
export const FORBIDDEN_RESOURCE_TYPES = [
    /^aws_cloudfront_/,
    /^aws_apprunner_/,
    /^aws_amplify_/,
    /^aws_lightsail_/,
    /^aws_nat_gateway$/,
];

// Terraform resource type → AWS service code, as named under
// /aws/service/global-infrastructure/regions/<region>/services/<code>.
// First match wins, so more specific prefixes come first. `null` means the type
// is provider metadata and makes no service call.
export const RESOURCE_SERVICE_MAP = [
    [/^aws_lb(_|$)/, 'elasticloadbalancing'],        // aws_lb, _listener, _target_group, _trust_store*
    [/^aws_alb(_|$)/, 'elasticloadbalancing'],
    [/^aws_elb(_|$)/, 'elasticloadbalancing'],
    [/^aws_ecs_/, 'ecs'],
    [/^aws_ecr_/, 'ecr'],
    [/^aws_s3_/, 's3'],
    [/^aws_kms_/, 'kms'],
    [/^aws_iam_/, 'iam'],
    [/^aws_cloudwatch_log_/, 'logs'],
    [/^aws_cloudwatch_event_/, 'events'],
    [/^aws_cloudwatch_/, 'cloudwatch'],
    [/^aws_cloudtrail(_|$)/, 'cloudtrail'],
    [/^aws_acm_/, 'acm'],                             // aws_acm_certificate, _validation
    [/^aws_route53_/, 'route53'],
    [/^aws_vpc(_|$)/, 'ec2'],                         // aws_vpc, aws_vpc_endpoint*, ...
    [/^aws_subnet(_|$)/, 'ec2'],
    [/^aws_route(_|$)/, 'ec2'],                       // aws_route, _table, _table_association
    [/^aws_internet_gateway(_|$)/, 'ec2'],
    [/^aws_egress_only_internet_gateway$/, 'ec2'],
    [/^aws_nat_gateway$/, 'ec2'],
    [/^aws_security_group(_|$)/, 'ec2'],
    [/^aws_network_acl(_|$)/, 'ec2'],
    [/^aws_flow_log$/, 'ec2'],
    [/^aws_eip(_|$)/, 'ec2'],
    [/^aws_default_(vpc|subnet|security_group|route_table|network_acl)$/, 'ec2'],
    [/^aws_availability_zones$/, 'ec2'],
    [/^aws_ami(_|$)/, 'ec2'],
    [/^aws_instance$/, 'ec2'],
    [/^aws_launch_template$/, 'ec2'],
    [/^aws_secretsmanager_/, 'secretsmanager'],
    [/^aws_ssm_/, 'ssm'],
    [/^aws_sns_/, 'sns'],
    [/^aws_sqs_/, 'sqs'],
    [/^aws_lambda_/, 'lambda'],
    [/^aws_dynamodb_/, 'dynamodb'],
    [/^aws_(db|rds)_/, 'rds'],
    [/^aws_efs_/, 'efs'],
    [/^aws_elasticache_/, 'elasticache'],
    [/^aws_appautoscaling_/, 'application-autoscaling'],
    [/^aws_autoscaling_/, 'autoscaling'],
    [/^aws_wafv2_/, 'wafv2'],
    [/^aws_cloudfront_/, 'cloudfront'],
    [/^aws_apprunner_/, 'apprunner'],
    [/^aws_amplify_/, 'amplify'],
    [/^aws_lightsail_/, 'lightsail'],
    [/^aws_caller_identity$/, 'sts'],
    [/^aws_(partition|region|regions|default_tags|arn|service|service_principal)$/, null],
];

// Returns the service code for a Terraform resource type: a string, `null` for
// provider metadata, or `undefined` when the type is not in the map.
export function serviceForResourceType(type) {
    for (const [pattern, service] of RESOURCE_SERVICE_MAP) {
        if (pattern.test(type)) return service;
    }
    return undefined;
}

export function isForbiddenResourceType(type) {
    return FORBIDDEN_RESOURCE_TYPES.some(pattern => pattern.test(type));
}

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

// Which comment syntaxes a file uses, by extension. A trailing `.example` is
// ignored (config.php.example is PHP, shared.env.example is an env file).
export function commentStylesFor(file) {
    let base = path.basename(file).toLowerCase();
    if (base.endsWith('.example')) base = base.slice(0, -'.example'.length);
    const ext = path.extname(base);
    if (['.tf', '.tfvars', '.hcl', '.php'].includes(ext)) {
        return { hash: true, slash: true, block: true, html: false };
    }
    if (['.sh', '.bash', '.zsh', '.yml', '.yaml', '.env', '.toml', '.ini', '.conf', '.cfg',
        '.py', '.rb', '.txt', '.gitignore', '.dockerignore', '.properties'].includes(ext)
        || base === 'dockerfile' || base.startsWith('dockerfile.') || base === 'makefile') {
        return { hash: true, slash: false, block: false, html: false };
    }
    if (['.html', '.htm', '.xml', '.svg', '.vue', '.xhtml'].includes(ext)) {
        return { hash: false, slash: true, block: true, html: true };
    }
    // JS, TS, CSS, JSON, GLSL and anything else C-like.
    return { hash: false, slash: true, block: true, html: false };
}

function lineEnd(text, from) {
    const nl = text.indexOf('\n', from);
    return nl < 0 ? text.length : nl;
}

// Removes comments, keeping every newline so line numbers are unchanged. String
// literals are skipped so `https://` and `#fff` never start a comment.
export function stripComments(text, styles) {
    const n = text.length;
    let out = '';
    let segStart = 0;
    let i = 0;
    while (i < n) {
        const c = text[i];
        if (c === '"' || c === "'" || c === '`') {
            const quote = c;
            i++;
            while (i < n && text[i] !== quote) {
                if (text[i] === '\\') i++;
                else if (text[i] === '\n' && quote !== '`') break;   // unterminated: give up at EOL
                i++;
            }
            i++;
            continue;
        }
        let commentEnd = -1;
        if (styles.hash && c === '#') {
            commentEnd = lineEnd(text, i);
        } else if (styles.slash && c === '/' && text[i + 1] === '/' && text[i - 1] !== ':') {
            commentEnd = lineEnd(text, i);
        } else if (styles.block && c === '/' && text[i + 1] === '*') {
            const close = text.indexOf('*/', i + 2);
            commentEnd = close < 0 ? n : close + 2;
        } else if (styles.html && text.startsWith('<!--', i)) {
            const close = text.indexOf('-->', i + 4);
            commentEnd = close < 0 ? n : close + 3;
        }
        if (commentEnd >= 0) {
            out += text.slice(segStart, i);
            out += text.slice(i, commentEnd).replace(/[^\n]/g, '');
            i = commentEnd;
            segStart = i;
            continue;
        }
        i++;
    }
    out += text.slice(segStart, n);
    return out;
}

function lineOf(text, index) {
    let line = 1;
    for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
    return line;
}

// The text of line `line` (1-based). Matches are found in the comment-stripped
// text, whose indices differ from the original's, but whose line numbers do not.
function lineText(text, line) {
    let start = 0;
    for (let n = 1; n < line; n++) {
        start = text.indexOf('\n', start) + 1;
        if (start === 0) return '';
    }
    return text.slice(start, lineEnd(text, start)).trim();
}

// ---------------------------------------------------------------------------
// Static checks
// ---------------------------------------------------------------------------

function fileKind(file) {
    const base = path.basename(file).toLowerCase();
    if (base.endsWith('.md') || base.endsWith('.markdown')) return 'markdown';
    if (base.endsWith('.tfvars.example')) return 'tfvars-example';
    if (base.endsWith('.tf') || base.endsWith('.tfvars') || base.endsWith('.hcl')) return 'terraform';
    if (base.endsWith('.php')) return 'php';
    if (/\.(js|mjs|cjs|ts|tsx|jsx)$/.test(base)) return 'js';
    return 'other';
}

function isBinary(buffer) {
    const len = Math.min(buffer.length, 8000);
    for (let i = 0; i < len; i++) if (buffer[i] === 0) return true;
    return false;
}

function walk(dir, out, skipDirs) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIR_NAMES.has(entry.name)) continue;
            if (skipDirs.has(path.resolve(full))) continue;
            walk(full, out, skipDirs);
        } else if (entry.isFile()) {
            out.push(full);
        }
        // Symlinks are not followed: shared directories are linked into
        // worktrees and would take the scan outside the tree.
    }
}

function collectMatches(regex, text, original, file, rel, check, severity, message) {
    const findings = [];
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
        const line = lineOf(text, m.index);
        findings.push({
            check, severity, file: rel, line,
            match: m[0], message, context: lineText(original, line),
        });
    }
    return findings;
}

const RESOURCE_BLOCK = /^\s*resource\s+"([^"]+)"\s+"([^"]+)"/gm;

// Runs the static checks on one file's text. `rel` is the path shown in findings.
export function scanFileText(rel, text) {
    const kind = fileKind(rel);
    if (kind === 'markdown') return [];
    const code = stripComments(text, commentStylesFor(rel));
    const findings = [];

    findings.push(...collectMatches(ARN_LITERAL, code, text, rel, rel, 'arn-literal', 'fail',
        'commercial-partition ARN prefix; build ARNs from data.aws_partition'));

    const isTerraform = kind === 'terraform' || kind === 'tfvars-example';
    findings.push(...collectMatches(ENDPOINT_LITERAL, code, text, rel, rel, 'endpoint-literal',
        kind === 'terraform' ? 'fail' : 'info',
        kind === 'terraform'
            ? 'endpoint hostname literal; use data.aws_partition.dns_suffix'
            : 'endpoint hostname in application code (informational; see README)'));

    if (kind === 'terraform') {
        findings.push(...collectMatches(REGION_LITERAL, code, text, rel, rel, 'region-literal', 'fail',
            'region name literal; take the region from a variable'));
    }

    if (isTerraform) {
        RESOURCE_BLOCK.lastIndex = 0;
        let m;
        while ((m = RESOURCE_BLOCK.exec(code)) !== null) {
            if (isForbiddenResourceType(m[1])) {
                const line = lineOf(code, m.index);
                findings.push({
                    check: 'forbidden-resource', severity: 'fail', file: rel,
                    line, match: m[1],
                    message: 'resource type never used in an isolated deployment',
                    context: lineText(text, line),
                });
            }
        }
    }
    return findings;
}

// Scans every text file under the given roots (relative to `cwd`).
// Returns { findings, roots, missingRoots, files }.
export function scanSources(roots = DEFAULT_SOURCES, { cwd = REPO_ROOT } = {}) {
    const findings = [];
    const scannedRoots = [];
    const missingRoots = [];
    const skipDirs = new Set([path.resolve(LINT_DIR)]);   // never lint the linter
    let fileCount = 0;

    for (const root of roots) {
        const abs = path.resolve(cwd, root);
        let stat;
        try {
            stat = fs.statSync(abs);
        } catch {
            missingRoots.push(root);
            continue;
        }
        scannedRoots.push(root);
        const files = [];
        if (stat.isDirectory()) walk(abs, files, skipDirs);
        else files.push(abs);

        for (const file of files) {
            let buffer;
            try {
                buffer = fs.readFileSync(file);
            } catch {
                continue;
            }
            if (isBinary(buffer)) continue;
            fileCount++;
            const relToCwd = path.relative(cwd, file);
            const rel = relToCwd.startsWith('..') ? file : relToCwd.split(path.sep).join('/');
            findings.push(...scanFileText(rel, buffer.toString('utf8')));
        }
    }
    return { findings, roots: scannedRoots, missingRoots, files: fileCount };
}

// ---------------------------------------------------------------------------
// Plan checks
// ---------------------------------------------------------------------------

const HOSTNAME = /\b((?:[a-z0-9-]+\.)+amazonaws\.com)(?![a-z0-9.-])/gi;
const REGION_LABEL = /^[a-z]{2}-(?:[a-z]+-)+\d$/;

// The region segment of an AWS hostname, or null when it has none (a service
// principal such as ecs-tasks.amazonaws.com is partition-independent).
export function hostnameRegion(hostname) {
    for (const label of hostname.toLowerCase().split('.')) {
        if (REGION_LABEL.test(label)) return label;
    }
    return null;
}

// Every string value in a JSON value, with a dotted path to it.
function* stringsIn(value, where) {
    if (typeof value === 'string') {
        yield [where, value];
    } else if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) yield* stringsIn(value[i], `${where}[${i}]`);
    } else if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) yield* stringsIn(value[key], `${where}.${key}`);
    }
}

function* planValues(plan) {
    for (const rc of plan.resource_changes ?? []) {
        const after = rc.change?.after;
        if (after !== undefined) yield* stringsIn(after, rc.address ?? rc.type);
    }
    for (const [name, change] of Object.entries(plan.output_changes ?? {})) {
        if (change?.after !== undefined) yield* stringsIn(change.after, `output.${name}`);
    }
    for (const [name, variable] of Object.entries(plan.variables ?? {})) {
        if (variable?.value !== undefined) yield* stringsIn(variable.value, `var.${name}`);
    }
}

// Reads a snapshot written by refresh-services.mjs. Throws on a malformed file.
export function loadSnapshot(file) {
    const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof snapshot.region !== 'string' || !Array.isArray(snapshot.services)) {
        throw new Error(`${file}: not a services snapshot (expected { region, fetchedAt, services })`);
    }
    return snapshot;
}

// Checks a `terraform show -json` plan against the target region and its services
// snapshot. Returns { findings, services, resources }.
export function checkPlan(plan, { region, snapshot }) {
    const findings = [];
    const byService = new Map();          // service → [addresses]
    const resources = [];

    for (const rc of plan.resource_changes ?? []) {
        const actions = rc.change?.actions ?? [];
        if (actions.length === 1 && actions[0] === 'delete') continue;   // gone after apply
        const type = rc.type;
        const address = rc.address ?? type;
        resources.push({ address, type });

        if (isForbiddenResourceType(type)) {
            findings.push({
                check: 'forbidden-resource', severity: 'fail', file: address, match: type,
                message: 'resource type never used in an isolated deployment',
            });
        }
        if (!type.startsWith('aws_')) continue;              // another provider (random, tls, ...)
        const service = serviceForResourceType(type);
        if (service === undefined) {
            findings.push({
                check: 'unknown-resource-type', severity: 'warn', file: address, match: type,
                message: 'resource type not in RESOURCE_SERVICE_MAP; add it so its service is checked',
            });
            continue;
        }
        if (service === null) continue;
        if (!byService.has(service)) byService.set(service, []);
        byService.get(service).push(address);
    }

    if (snapshot.region !== region) {
        findings.push({
            check: 'service-availability', severity: 'fail', file: 'snapshot', match: snapshot.region,
            message: `snapshot is for region ${snapshot.region}, not the target region ${region}`,
        });
    }
    const available = new Set(snapshot.services);
    for (const [service, addresses] of [...byService.entries()].sort()) {
        if (!available.has(service)) {
            findings.push({
                check: 'service-availability', severity: 'fail', file: addresses.join(', '), match: service,
                message: `service "${service}" is not offered in ${region}`,
            });
        }
    }

    for (const [where, value] of planValues(plan)) {
        ARN_LITERAL.lastIndex = 0;
        if (ARN_LITERAL.test(value)) {
            findings.push({
                check: 'plan-arn-literal', severity: 'fail', file: where, match: 'arn:aws:',
                message: 'commercial-partition ARN in planned values',
            });
        }
        HOSTNAME.lastIndex = 0;
        let m;
        while ((m = HOSTNAME.exec(value)) !== null) {
            const hostRegion = hostnameRegion(m[1]);
            if (hostRegion && hostRegion !== region) {
                findings.push({
                    check: 'plan-endpoint-region', severity: 'fail', file: where, match: m[1],
                    message: `endpoint is in ${hostRegion}, not the target region ${region}`,
                });
            }
        }
    }

    return { findings, services: [...byService.keys()].sort(), resources };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const opts = { region: null, plan: null, sources: null, snapshot: null, staticOnly: false, json: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => {
            const value = argv[++i];
            if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
            return value;
        };
        switch (arg) {
            case '--region': opts.region = next(); break;
            case '--plan': opts.plan = next(); break;
            case '--snapshot': opts.snapshot = next(); break;
            case '--sources':
                opts.sources = [];
                while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opts.sources.push(argv[++i]);
                if (opts.sources.length === 0) throw new Error('--sources needs at least one directory');
                break;
            case '--static-only': opts.staticOnly = true; break;
            case '--json': opts.json = true; break;
            case '--help': case '-h': opts.help = true; break;
            default: throw new Error(`unknown argument ${arg}`);
        }
    }
    return opts;
}

const USAGE = `usage: partition-lint.mjs [--static-only] [--region <r>] [--plan <plan.json>]
                          [--snapshot <file>] [--sources <dir>...] [--json]

  --static-only   source checks only (no region, plan or snapshot needed)
  --region <r>    target region; required for plan checks
  --plan <file>   output of \`terraform show -json <planfile>\`
  --snapshot <f>  services snapshot (default deploy/aws/lint/snapshots/<region>.json)
  --sources <d>.. source roots to scan (default ${DEFAULT_SOURCES.join(' ')})
  --json          machine-readable output
`;

const SEVERITY_ORDER = { fail: 0, warn: 1, info: 2 };

function printReport(result) {
    const { sources, plan, findings } = result;
    const rootsText = sources.roots.length ? sources.roots.join(', ') : 'none';
    const missing = sources.missingRoots.length ? `; not found: ${sources.missingRoots.join(', ')}` : '';
    console.log(`partition-lint: static checks over ${rootsText} (${sources.files} files${missing})`);
    if (plan) {
        console.log(`partition-lint: plan ${plan.file} for ${result.region}: ${plan.resources} resources, `
            + `services ${plan.services.join(', ') || 'none'} (snapshot ${plan.snapshot}, `
            + `${plan.snapshotServices} services, fetched ${plan.fetchedAt})`);
    }

    const groups = new Map();
    for (const f of findings) {
        if (!groups.has(f.check)) groups.set(f.check, []);
        groups.get(f.check).push(f);
    }
    const ordered = [...groups.entries()].sort((a, b) => {
        const sa = Math.min(...a[1].map(f => SEVERITY_ORDER[f.severity]));
        const sb = Math.min(...b[1].map(f => SEVERITY_ORDER[f.severity]));
        return sa - sb || a[0].localeCompare(b[0]);
    });
    for (const [check, list] of ordered) {
        const worst = list.reduce((w, f) => SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[w] ? f.severity : w, 'info');
        console.log(`\n${worst.toUpperCase()} ${check} (${list.length})`);
        for (const f of list) {
            const where = f.line ? `${f.file}:${f.line}` : f.file;
            const context = f.context ? `    ${f.context.slice(0, 160)}` : '';
            console.log(`  ${where}  ${f.match}  — ${f.message}`);
            if (context) console.log(context);
        }
    }

    const s = result.summary;
    console.log(`\npartition-lint: ${s.fail ? 'FAIL' : 'PASS'} — ${s.fail} failure(s), ${s.warn} warning(s), ${s.info} informational`);
}

export function main(argv = process.argv.slice(2)) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (err) {
        console.error(`partition-lint: ${err.message}\n${USAGE}`);
        return 2;
    }
    if (opts.help) {
        console.log(USAGE);
        return 0;
    }
    if (!opts.staticOnly && !opts.plan) {
        console.error('partition-lint: give --plan <plan.json> for plan checks, or --static-only\n' + USAGE);
        return 2;
    }
    if (opts.plan && !opts.region) {
        console.error('partition-lint: --plan needs --region <target region>\n' + USAGE);
        return 2;
    }

    const findings = [];
    const sources = scanSources(opts.sources ?? DEFAULT_SOURCES, { cwd: REPO_ROOT });
    findings.push(...sources.findings);

    let planInfo = null;
    if (opts.plan) {
        const snapshotFile = opts.snapshot ?? path.join(DEFAULT_SNAPSHOT_DIR, `${opts.region}.json`);
        let plan;
        let snapshot;
        try {
            plan = JSON.parse(fs.readFileSync(opts.plan, 'utf8'));
        } catch (err) {
            console.error(`partition-lint: cannot read plan ${opts.plan}: ${err.message}`);
            return 2;
        }
        try {
            snapshot = loadSnapshot(snapshotFile);
        } catch (err) {
            console.error(`partition-lint: cannot read services snapshot ${snapshotFile}: ${err.message}\n`
                + `  refresh it with: node deploy/aws/lint/refresh-services.mjs --region ${opts.region}`);
            return 2;
        }
        const checked = checkPlan(plan, { region: opts.region, snapshot });
        findings.push(...checked.findings);
        planInfo = {
            file: opts.plan, resources: checked.resources.length, services: checked.services,
            snapshot: snapshotFile, snapshotServices: snapshot.services.length, fetchedAt: snapshot.fetchedAt,
        };
    }

    const summary = { fail: 0, warn: 0, info: 0 };
    for (const f of findings) summary[f.severity]++;
    const result = {
        ok: summary.fail === 0,
        region: opts.region,
        sources: { roots: sources.roots, missingRoots: sources.missingRoots, files: sources.files },
        plan: planInfo,
        findings,
        summary,
    };

    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else printReport(result);
    return result.ok ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    process.exitCode = main();
}
