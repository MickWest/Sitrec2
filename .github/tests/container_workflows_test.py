"""Exercise the actual workflow shell against a local fake registry. No network."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]
RELEASE = yaml.safe_load((ROOT / '.github/workflows/docker.yml').read_text())
CLEANUP = yaml.safe_load((ROOT / '.github/workflows/docker-cleanup.yml').read_text())
INDEX = 'application/vnd.oci.image.index.v1+json'
MANIFEST = 'application/vnd.oci.image.manifest.v1+json'


def digest(number):
    return f'sha256:{number:064x}'


def descriptor(number):
    return dict(digest=digest(number), mediaType=MANIFEST, size=123)


def index(*children):
    return dict(schemaVersion=2, mediaType=INDEX, manifests=[descriptor(n) for n in children])


def leaf(subject=None):
    body = dict(schemaVersion=2, mediaType=MANIFEST, config=descriptor(900), layers=[])
    if subject is not None:
        body['subject'] = descriptor(subject)
    return body


def step(workflow, job, name):
    return next(s for s in workflow['jobs'][job]['steps'] if s.get('name') == name)


def version(number, tags=(), fresh=False):
    return dict(id=number, name=digest(number), metadata=dict(container=dict(tags=list(tags))),
                created_at='2020-01-01T00:00:00Z',
                updated_at='2999-01-01T00:00:00Z' if fresh else '2020-01-01T00:00:00Z')


MOCK_REGISTRY = r'''
gh() {
  [ "$1" = api ] || return 90
  shift
  if [ "${1:-}" = "--method" ]; then
    [ "$2" = DELETE ] || return 90
    vid="${3##*/}"
    echo "$vid" >> "$FIXTURES/deleted"
    jq --argjson id "$vid" 'map(select(.id != $id))' "$FIXTURES/versions.json" > "$FIXTURES/versions.next"
    mv "$FIXTURES/versions.next" "$FIXTURES/versions.json"
  else
    cat "$FIXTURES/versions.json"
  fi
}
curl() {
  url="${!#}"
  if [[ "$url" == https://ghcr.io/token* ]]; then
    if [ -f "$FIXTURES/token-failure" ]; then return 22; fi
    printf '{"token":"fixture"}'
    return 0
  fi
  key="${url##*/}"
  if [ ! -f "$FIXTURES/$key" ]; then printf 404; return 0; fi
  cp "$FIXTURES/$key" "$BODY"
  if [ -f "$FIXTURES/$key.code" ]; then cat "$FIXTURES/$key.code"; else printf 200; fi
  if [ -f "$FIXTURES/$key.exit" ]; then return "$(cat "$FIXTURES/$key.exit")"; fi
  return 0
}
'''


@unittest.skipUnless(os.name == 'posix', 'Workflow shell requires Unix')
class ContainerWorkflows(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='container-workflows-')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.env = dict(os.environ, FIXTURES=str(self.path), RUNNER_TEMP=str(self.path),
                        GITHUB_OUTPUT=str(self.path / 'output'), GITHUB_ENV=str(self.path / 'env'),
                        GITHUB_SHA='a' * 40, GITHUB_RUN_ID='12345', GITHUB_RUN_ATTEMPT='2',
                        GITHUB_REPOSITORY_OWNER='example', GH_TOKEN='fixture', PKG='fixture',
                        MIN_AGE_DAYS='7', DRY_RUN='false', REGISTRY='ghcr.io',
                        IMAGE_NAME_LC='example/fixture', ARCH='amd64', BUILD_DIGEST=digest(1))

    def write(self, name, data):
        (self.path / name).write_text(data if isinstance(data, str) else json.dumps(data))

    def shell(self, script, prefix='', env=None):
        return subprocess.run(['bash', '-euo', 'pipefail', '-c', prefix + '\n' + script],
                              cwd=self.path, env={**self.env, **(env or {})},
                              text=True, capture_output=True, timeout=60)

    def run_cleanup(self, dry=False, all_passes=False):
        scripts = [s['run'] for s in CLEANUP['jobs']['cleanup']['steps'] if 'run' in s]
        return self.shell('\n'.join(scripts if all_passes else scripts[-1:]), MOCK_REGISTRY,
                          dict(DRY_RUN='true' if dry else 'false'))

    def deleted(self):
        path = self.path / 'deleted'
        return set(map(int, path.read_text().split())) if path.exists() else set()

    def test_invalid_manifest_never_reaches_untagged_deletion(self):
        variants = [
            ('truncated', '{"manifests":[', 200, 0),
            ('interrupted', '{"manifests":[', 200, 18),
            ('unexpected-object', '{"errors":[]}', 200, 0),
            ('empty-response', '', 200, 0),
            ('multiple-documents', json.dumps(index(2)) + '\n' + json.dumps(leaf()), 200, 0),
            ('bad-descriptor', json.dumps(dict(schemaVersion=2, mediaType=INDEX,
                                             manifests=[dict(digest='bad')])), 200, 0),
            ('server-error', 'unavailable', 503, 0),
            ('unauthorized', '{}', 401, 0),
        ]
        for name, body, code, exit_code in variants:
            with self.subTest(name=name):
                self.write('versions.json', [version(1, ['2.155.0']), version(2), version(3)])
                self.write(digest(1), body)
                self.write(digest(1) + '.code', str(code))
                self.write(digest(1) + '.exit', str(exit_code))
                result = self.run_cleanup()
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(self.deleted(), set())

    def test_token_failure_never_reaches_deletion(self):
        self.write('token-failure', '')
        self.write('versions.json', [version(1, ['2.155.0']), version(2)])
        result = self.run_cleanup()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.deleted(), set())

    def test_closure_keeps_nested_images_subjects_and_fresh_orphans(self):
        self.write('versions.json', [version(1, ['2.155.0'])] + [version(n) for n in range(2, 7)]
                   + [version(7, fresh=True), version(8, ['old-broken-release'])])
        self.write(digest(1), index(2, 3))
        self.write(digest(2), index(4))
        self.write(digest(3), leaf(subject=5))
        self.write(digest(4), leaf())
        self.write(digest(5), leaf())
        result = self.run_cleanup()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.deleted(), {6})

    def test_build_pass_preserves_recent_and_released_versions(self):
        self.write('versions.json', [version(1, ['build-index-1-1'], fresh=True),
                   version(2, ['build-amd64-1-1'], fresh=True),
                   version(3, ['build-index-old', '2.155.0']),
                   version(4, ['build-index-old']), version(5, ['build-arm64-old'])])
        script = step(CLEANUP, 'cleanup', 'Prune leftover build-* tags')['run']
        result = self.shell(script, MOCK_REGISTRY)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.deleted(), {4, 5})

    def test_dry_run_previews_all_three_real_passes(self):
        versions = [version(1, ['build-index-old']), version(2), version(3)]
        self.write(digest(1), index(2))
        for n in range(100, 121):
            versions.append(version(n, [f'2.100.{n - 100}']))
            self.write(digest(n), index(3) if n == 100 else index())
        self.write('versions.json', versions)
        dry = self.run_cleanup(dry=True, all_passes=True)
        self.assertEqual(dry.returncode, 0, dry.stdout + dry.stderr)
        self.assertEqual(self.deleted(), set())
        preview = set(map(int, re.findall(r'^  version (\d+) ', dry.stdout, re.M)))
        (self.path / 'pruned-ids.txt').unlink()
        real = self.run_cleanup(all_passes=True)
        self.assertEqual(real.returncode, 0, real.stdout + real.stderr)
        self.assertEqual(self.deleted(), {1, 2, 3, 100})
        self.assertEqual(preview, self.deleted())

    def test_platform_resolver_ignores_moved_build_tags(self):
        body = index(2)
        body['manifests'][0]['platform'] = dict(os='linux', architecture='amd64')
        self.write('index.json', body)
        mock = r'''
docker() {
  printf '%s\n' "$*" >> "$FIXTURES/docker-calls"
  [ "$4" = "$REGISTRY/$IMAGE_NAME_LC@$BUILD_DIGEST" ] || return 91
  cat "$FIXTURES/index.json"
}
'''
        script = step(RELEASE, 'package', 'Resolve the platform manifest digest')['run']
        result = self.shell(script, mock)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.path / 'output').read_text().strip(), 'digest=' + digest(2))
        record = json.loads((self.path / 'image-digests/amd64.json').read_text())
        self.assertEqual(record['index'], digest(1))
        self.assertEqual(record['platform'], digest(2))
        self.assertEqual(record['run'], self.env['GITHUB_RUN_ID'])
        body['manifests'].append(body['manifests'][0])
        self.write('index.json', body)
        self.assertNotEqual(self.shell(script, mock).returncode, 0)

    def test_record_handoff_accepts_retry_but_rejects_foreign_or_corrupt_records(self):
        record = dict(index=digest(1), platform=digest(2), arch='amd64', commit='a' * 40,
                      run='12345', attempt='1')
        script = f'bash "{ROOT}/.github/scripts/read-image-record.sh" amd64 "$FIXTURES/record.json"'
        self.write('record.json', record)
        result = self.shell(script)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('SOURCE_AMD64=ghcr.io/example/fixture@' + digest(1), result.stdout)
        self.assertIn('PLATFORM_AMD64=ghcr.io/example/fixture@' + digest(2), result.stdout)
        for key, value in [('run', '999'), ('commit', 'b' * 40), ('arch', 'arm64'),
                           ('attempt', '3'), ('platform', digest(2) + '\n'), ('index', 'null')]:
            with self.subTest(key=key):
                self.write('record.json', {**record, key: value})
                failed = self.shell(script)
                self.assertNotEqual(failed.returncode, 0)
                self.assertEqual(failed.stdout, '')

    def test_smoke_tests_use_recorded_platform(self):
        mock = r'''
docker() { printf '%s\n' "$*" >> "$FIXTURES/docker-calls"; }
curl() { printf OK; }
'''
        reference = 'ghcr.io/example/fixture@' + digest(2)
        for name in ['Start Docker container', 'Legacy port-80 back-compat smoke test']:
            result = self.shell(step(RELEASE, 'smoke-test', name)['run'], mock,
                                dict(PLATFORM_AMD64=reference))
            self.assertEqual(result.returncode, 0, result.stderr)
        calls = (self.path / 'docker-calls').read_text()
        self.assertNotIn(':build-', calls)
        self.assertEqual(calls.count(reference), 3)  # pull plus both container runs

    def test_publication_and_cleanup_share_a_non_cancelling_queue(self):
        self.assertEqual(RELEASE['concurrency'], CLEANUP['concurrency'])
        self.assertNotIn('${{', RELEASE['concurrency']['group'])
        self.assertIs(RELEASE['concurrency']['cancel-in-progress'], False)
        self.assertEqual(RELEASE['concurrency']['queue'], 'max')

    def test_index_assembly_and_publication_keep_the_recorded_sources(self):
        self.write('index.json', index(2, 12))
        mock = r'''
docker() {
  printf '%s\n' "$*" >> "$FIXTURES/docker-calls"
  case "$3" in
    create)
      [[ "$*" == *"$SOURCE_AMD64"* && "$*" == *"$SOURCE_ARM64"* ]] || return 92
      if [[ "$*" == *--dry-run* ]]; then cat "$FIXTURES/index.json"; fi
      ;;
    inspect)
      case "$4" in
        "$REGISTRY/$IMAGE_NAME_LC:build-index-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"|"$REGISTRY/$IMAGE_NAME_LC:2.155.0")
          printf '{"digest":"%s"}' "$EXPECTED_INDEX"
          ;;
        "$REGISTRY/$IMAGE_NAME_LC@$EXPECTED_INDEX") cat "$FIXTURES/index.json" ;;
        *) return 93 ;;
      esac
      ;;
    *) return 94 ;;
  esac
}
'''
        env = dict(SOURCE_AMD64='ghcr.io/example/fixture@' + digest(1),
                   SOURCE_ARM64='ghcr.io/example/fixture@' + digest(11),
                   EXPECTED_INDEX=digest(100), ANNOTATIONS='index:org.opencontainers.image.description=Sitrec')
        create = step(RELEASE, 'manifest', 'Push the multi-arch index under a staging tag')['run']
        result = self.shell(create, mock, env)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('index-digest=' + digest(100), (self.path / 'output').read_text())
        publish = step(RELEASE, 'manifest', 'Tag the attested index for release')['run']
        publish = publish.replace("${{ steps.meta.outputs.tags }}", 'ghcr.io/example/fixture:2.155.0')
        result = self.shell(publish, mock, {**env, 'ATTESTED_DIGEST': digest(100)})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = (self.path / 'docker-calls').read_text()
        self.assertNotIn(':build-amd64-', calls)
        self.assertNotIn(':build-arm64-', calls)
        self.assertIn('inspect ghcr.io/example/fixture@' + digest(100) + ' --raw', calls)
        self.assertIn('build-index-12345-2', calls)

        # A changed candidate must stop before any release-tag create call.
        self.write('docker-calls', '')
        self.write('index.json', index(999))
        result = self.shell(publish, mock, {**env, 'ATTESTED_DIGEST': digest(100)})
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('--tag ghcr.io/example/fixture:2.155.0', (self.path / 'docker-calls').read_text())

    def test_shell_syntax(self):
        for workflow in [RELEASE, CLEANUP]:
            for job in workflow['jobs'].values():
                for item in job['steps']:
                    if 'run' not in item:
                        continue
                    script = re.sub(r'\$\{\{.*?\}\}', 'FIXTURE', item['run'])
                    result = subprocess.run(['bash', '-n'], input=script, text=True, capture_output=True)
                    self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
