// Tests for the partition lint (deploy/aws/lint/partition-lint.mjs) and the
// snapshot refresher's pure parts (deploy/aws/lint/refresh-services.mjs). Both
// are run as child processes because the Jest config maps every .mjs import to a
// stub. Region names in the fixtures are invented; none is a real region.

const {spawnSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LINT = path.join(ROOT, 'deploy', 'aws', 'lint', 'partition-lint.mjs');
const REFRESH = path.join(ROOT, 'deploy', 'aws', 'lint', 'refresh-services.mjs');

const TARGET = 'xx-isolated-1';
const OTHER = 'xx-other-9';

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'partition-lint-'));
}

function writeFiles(dir, files) {
    for (const [name, text] of Object.entries(files)) {
        const file = path.join(dir, name);
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, text);
    }
    return dir;
}

function run(args) {
    return spawnSync(process.execPath, [LINT, ...args], {cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26});
}

function runJson(args) {
    const r = run([...args, '--json']);
    expect(r.stderr).toBe('');
    const out = JSON.parse(r.stdout);
    out.status = r.status;
    return out;
}

// Evaluates an ES-module snippet that can import the tools directly.
function evalModule(code) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {cwd: ROOT, encoding: 'utf8'});
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    return JSON.parse(r.stdout);
}

function byCheck(findings, check) {
    return findings.filter(f => f.check === check);
}

function basenames(findings) {
    return findings.map(f => path.basename(f.file)).sort();
}

// ---------------------------------------------------------------------------
// Static fixtures
// ---------------------------------------------------------------------------

const BAD_TREE = {
    'bad_arn.tf': [
        'resource "aws_iam_role" "app" {',
        '  name                = "app"',
        '  managed_policy_arns = ["arn:aws:iam::aws:policy/ReadOnlyAccess"]',
        '}',
    ].join('\n'),
    'comment_arn.tf': [
        '# Example of the shape, never used: arn:aws:s3:::example-bucket',
        '// arn:aws:s3:::example-bucket',
        '/* arn:aws:s3:::example-bucket */',
        'locals {',
        '  bucket_arn = "arn:${data.aws_partition.current.partition}:s3:::${var.bucket}"',
        '}',
    ].join('\n'),
    'region.tf': [
        'provider "aws" {',
        '  region = "eu-west-1"',
        '}',
    ].join('\n'),
    'nat.tf': [
        'resource "aws_nat_gateway" "egress" {',
        '  subnet_id = aws_subnet.public.id',
        '}',
    ].join('\n'),
    'endpoint.tf': [
        'locals {',
        '  # a URL in a string must still be found: "//" inside "https://" is not a comment',
        '  url = "https://s3.amazonaws.com/example-bucket"',
        '}',
    ].join('\n'),
    'app.js': [
        '// application code: informational only',
        'export const isS3 = host => host.endsWith(".amazonaws.com");',
    ].join('\n'),
    'notes.md': 'Markdown is exempt: arn:aws:s3:::example-bucket in eu-west-1 at s3.amazonaws.com',
    'example.tfvars.example': 'region = "eu-central-1"\n',
    'binary.bin': Buffer.from([0, 1, 2, 3, 0, 0]),
};

const CLEAN_TREE = {
    'main.tf': [
        'data "aws_partition" "current" {}',
        '',
        'resource "aws_s3_bucket" "data" {',
        '  bucket = var.bucket',
        '}',
        '',
        'resource "aws_iam_role_policy" "read" {',
        '  policy = jsonencode({',
        '    Resource = "arn:${data.aws_partition.current.partition}:s3:::${var.bucket}/*"',
        '  })',
        '}',
    ].join('\n'),
    'app.js': 'export const isS3 = host => host.endsWith(".amazonaws.com");\n',
};

describe('partition-lint: static checks', () => {
    let bad;
    beforeAll(() => {
        bad = runJson(['--static-only', '--sources', writeFiles(tmpDir(), BAD_TREE)]);
    });

    test('the fixture tree fails and reports what it scanned', () => {
        expect(bad.status).toBe(1);
        expect(bad.ok).toBe(false);
        expect(bad.sources.files).toBe(8);      // the binary file is skipped
        expect(bad.sources.missingRoots).toEqual([]);
        expect(bad.summary.fail).toBeGreaterThan(0);
    });

    test('arn:aws: in code fails; in a comment or Markdown it does not', () => {
        const arn = byCheck(bad.findings, 'arn-literal');
        expect(basenames(arn)).toEqual(['bad_arn.tf']);
        expect(arn[0]).toMatchObject({severity: 'fail', line: 3, match: 'arn:aws:'});
    });

    test('a region literal in .tf fails; a .tfvars.example is exempt', () => {
        const region = byCheck(bad.findings, 'region-literal');
        expect(basenames(region)).toEqual(['region.tf']);
        expect(region[0]).toMatchObject({severity: 'fail', line: 2, match: 'eu-west-1'});
    });

    test('a forbidden resource type fails', () => {
        const forbidden = byCheck(bad.findings, 'forbidden-resource');
        expect(basenames(forbidden)).toEqual(['nat.tf']);
        expect(forbidden[0]).toMatchObject({severity: 'fail', line: 1, match: 'aws_nat_gateway'});
    });

    test('an endpoint hostname fails in .tf (even inside a URL) and is informational in .js', () => {
        const endpoint = byCheck(bad.findings, 'endpoint-literal');
        expect(basenames(endpoint)).toEqual(['app.js', 'endpoint.tf']);
        const tf = endpoint.find(f => f.file.endsWith('endpoint.tf'));
        const js = endpoint.find(f => f.file.endsWith('app.js'));
        expect(tf).toMatchObject({severity: 'fail', line: 3});
        expect(js).toMatchObject({severity: 'info', line: 2});
    });

    test('a clean tree passes, with the informational finding still listed', () => {
        const clean = runJson(['--static-only', '--sources', writeFiles(tmpDir(), CLEAN_TREE)]);
        expect(clean.status).toBe(0);
        expect(clean.ok).toBe(true);
        expect(clean.summary).toEqual({fail: 0, warn: 0, info: 1});
        expect(clean.findings.map(f => f.check)).toEqual(['endpoint-literal']);
    });

    test('a missing source root is reported, not fatal', () => {
        const dir = tmpDir();
        const r = runJson(['--static-only', '--sources', path.join(dir, 'absent'), writeFiles(path.join(dir, 'present'), CLEAN_TREE)]);
        expect(r.status).toBe(0);
        expect(r.sources.missingRoots).toEqual([path.join(dir, 'absent')]);
        expect(r.sources.roots).toEqual([path.join(dir, 'present')]);
    });

    test('the human-readable report groups by check and ends with a summary line', () => {
        const r = run(['--static-only', '--sources', writeFiles(tmpDir(), BAD_TREE)]);
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/^FAIL arn-literal \(1\)$/m);
        expect(r.stdout).toMatch(/^FAIL forbidden-resource \(1\)$/m);
        expect(r.stdout).toMatch(/^INFO|^FAIL endpoint-literal \(2\)$/m);
        expect(r.stdout).toMatch(/partition-lint: FAIL — 4 failure\(s\), 0 warning\(s\), 1 informational$/m);
    });
});

// ---------------------------------------------------------------------------
// Plan fixtures
// ---------------------------------------------------------------------------

function change(address, type, after = {}, actions = ['create']) {
    return {address, mode: 'managed', type, name: address.split('.').pop(), change: {actions, after}};
}

// One resource per mapped service, plus the cases the checks must tell apart.
const MAPPED = [
    ['aws_lb.app', 'aws_lb'],
    ['aws_lb_listener.https', 'aws_lb_listener'],
    ['aws_lb_target_group.app', 'aws_lb_target_group'],
    ['aws_lb_trust_store.clients', 'aws_lb_trust_store'],
    ['aws_ecs_cluster.main', 'aws_ecs_cluster'],
    ['aws_ecs_service.app', 'aws_ecs_service'],
    ['aws_ecs_task_definition.app', 'aws_ecs_task_definition'],
    ['aws_ecr_repository.app', 'aws_ecr_repository'],
    ['aws_s3_bucket.data', 'aws_s3_bucket'],
    ['aws_kms_key.data', 'aws_kms_key'],
    ['aws_iam_role.task', 'aws_iam_role'],
    ['aws_cloudwatch_log_group.app', 'aws_cloudwatch_log_group'],
    ['aws_cloudtrail.audit', 'aws_cloudtrail'],
    ['aws_acm_certificate.app', 'aws_acm_certificate'],
    ['aws_route53_record.app', 'aws_route53_record'],
    ['aws_vpc.main', 'aws_vpc'],
    ['aws_subnet.private', 'aws_subnet'],
    ['aws_route_table.private', 'aws_route_table'],
    ['aws_internet_gateway.main', 'aws_internet_gateway'],
    ['aws_security_group.app', 'aws_security_group'],
    ['aws_vpc_endpoint.s3', 'aws_vpc_endpoint'],
    ['aws_flow_log.vpc', 'aws_flow_log'],
    ['aws_secretsmanager_secret.db', 'aws_secretsmanager_secret'],
];

const EXPECTED_SERVICES = ['acm', 'cloudtrail', 'ec2', 'ecr', 'ecs', 'elasticloadbalancing', 'iam',
    'kms', 'logs', 'route53', 's3', 'secretsmanager'];

function cleanPlan() {
    return {
        format_version: '1.2',
        variables: {region: {value: TARGET}},
        resource_changes: [
            ...MAPPED.map(([address, type]) => change(address, type, {tags: {Name: address}})),
            change('random_password.db', 'random_password'),                                // not an AWS type
            change('data.aws_partition.current', 'aws_partition', {partition: 'aws-xx'}),    // metadata
            change('aws_ssm_parameter.old', 'aws_ssm_parameter', null, ['delete']),        // going away
            change('aws_iam_role.task_trust', 'aws_iam_role', {
                assume_role_policy: '{"Statement":[{"Principal":{"Service":"ecs-tasks.amazonaws.com"}}]}',
            }),
        ],
        output_changes: {
            bucket_host: {actions: ['create'], after: `example-bucket.s3.${TARGET}.amazonaws.com`},
        },
    };
}

function badPlan() {
    const plan = cleanPlan();
    plan.resource_changes.push(
        change('aws_cloudfront_distribution.cdn', 'aws_cloudfront_distribution'),
        change('aws_frobnicator_widget.x', 'aws_frobnicator_widget'),
        change('aws_iam_role.bad', 'aws_iam_role', {managed_policy_arns: ['arn:aws:iam::aws:policy/ReadOnlyAccess']}),
    );
    plan.output_changes.other_host = {actions: ['create'], after: `https://example-bucket.s3.${OTHER}.amazonaws.com/key`};
    return plan;
}

function snapshotFor(region, services) {
    return {region, fetchedAt: '2026-01-01T00:00:00.000Z', services};
}

function planRun(plan, snapshot, extra = []) {
    const dir = tmpDir();
    const planFile = path.join(dir, 'plan.json');
    const snapshotFile = path.join(dir, 'snapshot.json');
    fs.writeFileSync(planFile, JSON.stringify(plan));
    fs.writeFileSync(snapshotFile, JSON.stringify(snapshot));
    const sources = writeFiles(path.join(dir, 'src'), CLEAN_TREE);
    return runJson(['--region', TARGET, '--plan', planFile, '--snapshot', snapshotFile, '--sources', sources, ...extra]);
}

describe('partition-lint: plan checks', () => {
    test('a clean plan against a snapshot with every service passes', () => {
        const r = planRun(cleanPlan(), snapshotFor(TARGET, EXPECTED_SERVICES));
        expect(r.status).toBe(0);
        expect(r.ok).toBe(true);
        expect(r.plan.services).toEqual(EXPECTED_SERVICES);
        expect(r.plan.resources).toBe(MAPPED.length + 3);   // the deleted one is excluded
        expect(byCheck(r.findings, 'unknown-resource-type')).toEqual([]);
        expect(byCheck(r.findings, 'plan-endpoint-region')).toEqual([]);
    });

    test('a service missing from the snapshot fails, an unknown type warns, literals in values fail', () => {
        const r = planRun(badPlan(), snapshotFor(TARGET, EXPECTED_SERVICES));
        expect(r.status).toBe(1);

        const availability = byCheck(r.findings, 'service-availability');
        expect(availability).toHaveLength(1);
        expect(availability[0]).toMatchObject({severity: 'fail', match: 'cloudfront', file: 'aws_cloudfront_distribution.cdn'});

        const forbidden = byCheck(r.findings, 'forbidden-resource');
        expect(forbidden.map(f => f.match)).toEqual(['aws_cloudfront_distribution']);

        const unknown = byCheck(r.findings, 'unknown-resource-type');
        expect(unknown).toHaveLength(1);
        expect(unknown[0]).toMatchObject({severity: 'warn', match: 'aws_frobnicator_widget', file: 'aws_frobnicator_widget.x'});

        const arn = byCheck(r.findings, 'plan-arn-literal');
        expect(arn).toHaveLength(1);
        expect(arn[0].file).toBe('aws_iam_role.bad.managed_policy_arns[0]');

        expect(r.summary.warn).toBe(1);
    });

    test('an endpoint in another region fails; the target region and a service principal pass', () => {
        const r = planRun(badPlan(), snapshotFor(TARGET, EXPECTED_SERVICES));
        const hosts = byCheck(r.findings, 'plan-endpoint-region');
        expect(hosts).toHaveLength(1);
        expect(hosts[0]).toMatchObject({
            severity: 'fail', file: 'output.other_host', match: `example-bucket.s3.${OTHER}.amazonaws.com`,
        });
        expect(hosts[0].message).toContain(OTHER);
    });

    test('a snapshot for a different region than --region fails', () => {
        const r = planRun(cleanPlan(), snapshotFor(OTHER, EXPECTED_SERVICES));
        expect(r.status).toBe(1);
        const availability = byCheck(r.findings, 'service-availability');
        expect(availability).toHaveLength(1);
        expect(availability[0].message).toContain(OTHER);
    });

    test('a plan needs a region, and the default snapshot path is named when it is missing', () => {
        const planFile = path.join(tmpDir(), 'plan.json');
        fs.writeFileSync(planFile, JSON.stringify(cleanPlan()));

        const noRegion = run(['--plan', planFile]);
        expect(noRegion.status).toBe(2);
        expect(noRegion.stderr).toMatch(/--plan needs --region/);

        const noSnapshot = run(['--region', 'xx-nowhere-7', '--plan', planFile, '--sources', tmpDir()]);
        expect(noSnapshot.status).toBe(2);
        expect(noSnapshot.stderr).toMatch(/snapshots[\\/]xx-nowhere-7\.json/);
        expect(noSnapshot.stderr).toMatch(/refresh-services\.mjs --region xx-nowhere-7/);
    });

    test('no arguments is a usage error', () => {
        const r = run([]);
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/--static-only/);
    });
});

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

describe('partition-lint: exports', () => {
    test('RESOURCE_SERVICE_MAP, serviceForResourceType and hostnameRegion', () => {
        const out = evalModule(`
            import { RESOURCE_SERVICE_MAP, serviceForResourceType, hostnameRegion, checkPlan, scanSources }
                from ${JSON.stringify(LINT)};
            const types = ['aws_lb_trust_store_revocation', 'aws_ecs_service', 'aws_ecr_lifecycle_policy',
                'aws_s3_bucket_policy', 'aws_kms_alias', 'aws_iam_role_policy_attachment',
                'aws_cloudwatch_log_group', 'aws_cloudwatch_metric_alarm', 'aws_cloudtrail',
                'aws_acm_certificate_validation', 'aws_route53_zone', 'aws_route_table_association',
                'aws_vpc_endpoint_route_table_association', 'aws_flow_log', 'aws_secretsmanager_secret_version',
                'aws_nat_gateway', 'aws_cloudfront_distribution', 'aws_partition', 'aws_made_up_thing'];
            console.log(JSON.stringify({
                mapSize: RESOURCE_SERVICE_MAP.length,
                services: Object.fromEntries(types.map(t => [t, serviceForResourceType(t) === undefined ? 'UNKNOWN' : serviceForResourceType(t)])),
                regions: ['s3.${TARGET}.amazonaws.com', 'ecs-tasks.amazonaws.com', 'x.s3.eu-west-2.amazonaws.com']
                    .map(hostnameRegion),
                exports: [typeof checkPlan, typeof scanSources],
            }));
        `);
        expect(out.mapSize).toBeGreaterThan(20);
        expect(out.services).toEqual({
            aws_lb_trust_store_revocation: 'elasticloadbalancing',
            aws_ecs_service: 'ecs',
            aws_ecr_lifecycle_policy: 'ecr',
            aws_s3_bucket_policy: 's3',
            aws_kms_alias: 'kms',
            aws_iam_role_policy_attachment: 'iam',
            aws_cloudwatch_log_group: 'logs',
            aws_cloudwatch_metric_alarm: 'cloudwatch',
            aws_cloudtrail: 'cloudtrail',
            aws_acm_certificate_validation: 'acm',
            aws_route53_zone: 'route53',
            aws_route_table_association: 'ec2',
            aws_vpc_endpoint_route_table_association: 'ec2',
            aws_flow_log: 'ec2',
            aws_secretsmanager_secret_version: 'secretsmanager',
            aws_nat_gateway: 'ec2',
            aws_cloudfront_distribution: 'cloudfront',
            aws_partition: null,
            aws_made_up_thing: 'UNKNOWN',
        });
        expect(out.regions).toEqual([TARGET, null, 'eu-west-2']);
        expect(out.exports).toEqual(['function', 'function']);
    });

    test('refresh-services: service codes come from the parameter names, across pages, sorted', () => {
        const out = evalModule(`
            import { servicesFromPages, servicesPath } from ${JSON.stringify(REFRESH)};
            const base = servicesPath('${TARGET}');
            const pages = [
                { Parameters: [{ Name: base + '/s3', Value: 's3' }, { Name: base + '/ec2', Value: 'ec2' }], NextToken: 't' },
                { Parameters: [{ Name: base + '/acm', Value: 'acm' }, { Name: base + '/s3', Value: 's3' }] },
            ];
            console.log(JSON.stringify({ base, services: servicesFromPages(pages) }));
        `);
        expect(out.base).toBe(`/aws/service/global-infrastructure/regions/${TARGET}/services`);
        expect(out.services).toEqual(['acm', 'ec2', 's3']);
    });
});
