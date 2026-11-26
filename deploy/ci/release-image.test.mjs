// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import yaml from 'js-yaml';

const root = resolve(process.env.PLATFORM_REPO_ROOT ?? '.');
const read = file => readFileSync(join(root, file), 'utf8');
const workflow = yaml.load(read('.github/workflows/platform.yml'));
const evaluate = (value, event_name) => runInNewContext(value.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), {
  github: { event_name }, fromJSON: JSON.parse,
});

test('PRs build and smoke-test one native image; release events retain both architectures', () => {
  const build = workflow.jobs.build;
  for (const event of ['pull_request', 'merge_group', 'push', 'schedule', 'workflow_dispatch']) {
    assert.equal(evaluate(build.if, event), ['merge_group', 'push'].includes(event), event);
    for (const name of ['PR image cache credentials', 'Build PR image without publishing', 'Test PR image']) {
      const step = workflow.jobs.validate.steps.find(step => step.name === name);
      assert.equal(evaluate(step.if, event), event === 'pull_request', `${event}: ${name}`);
    }
  }
  assert.deepEqual(build.strategy.matrix.include.map(row => row.arch), ['amd64', 'arm64']);
  assert.equal(build.strategy.matrix.exclude, undefined);
  assert.deepEqual(build.permissions, { contents: 'read', actions: 'read' });
  assert.deepEqual(workflow.jobs.validate.permissions, { contents: 'read' });
  assert.notEqual(build['continue-on-error'], true);
  assert.ok(build.steps.every(step => step['continue-on-error'] !== true));
  assert.notEqual(workflow.jobs.validate['continue-on-error'], true);
  assert.ok(workflow.jobs.validate.steps.every(step => step['continue-on-error'] !== true));
  assert.ok(build.steps.some(step => step.run?.includes('image-smoke.sh')));
  const script = build.steps.find(step => step.name === 'Native image and GHA cache').run;
  const pr = workflow.jobs.validate.steps.find(step => step.name === 'Build PR image without publishing');
  assert.equal(pr.run, script);
  assert.deepEqual(pr.env, { ARCH: 'amd64', CACHE_WRITE: 'false' });
  assert.equal(workflow.jobs.validate.steps.find(step => step.name === 'Test PR image').run,
    build.steps.find(step => step.name === 'Test native image').run);
  assert.doesNotMatch(script, /--push|docker (?:push|login)/);
  assert.equal(workflow.jobs.publish.if, "github.event_name == 'push' && github.ref == 'refs/heads/dev'");
});

test('a broken image fails the actual PR build command with the pinned inputs and source revision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'image-build-refusal-'));
  try {
    const script = workflow.jobs.validate.steps.find(step => step.name === 'Build PR image without publishing').run;
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', `
docker() { echo x86_64; }
buildx() { if [ "$1" = build ]; then printf '%s\\n' "$@" > "$CALLS"; return 31; fi; }
${script}`], { cwd: root, encoding: 'utf8', env: { ...process.env,
      ARCH: 'amd64', CACHE_WRITE: 'false', RUNNER_TEMP: dir, CALLS: join(dir, 'calls'), GITHUB_SHA: revision,
    } });
    assert.equal(result.status, 31, result.stderr);
    const args = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n');
    const versions = JSON.parse(read('deploy/versions.json'));
    const buildArgs = args.flatMap((arg, index) => {
      if (arg === '--build-arg') return [args[index + 1]];
      return arg.startsWith('--build-arg=') ? [arg.slice('--build-arg='.length)] : [];
    });
    for (const name of ['node', 'rust', 'runtime']) {
      const key = `${name.toUpperCase()}_IMAGE=`;
      assert.deepEqual(buildArgs.filter(arg => arg.startsWith(key)), [key + versions.images[name]]);
    }
    assert.ok(buildArgs.includes(`SOURCE_REVISION=${revision}`));
    assert.deepEqual(buildArgs.map(arg => arg.split('=')[0]).sort(), ['NODE_IMAGE', 'RUNTIME_IMAGE', 'RUST_IMAGE', 'SOURCE_REVISION']);
    const files = args.flatMap((arg, index) => {
      if (arg === '-f' || arg === '--file') return [args[index + 1]];
      return arg.match(/^(?:--file=|-f=?)(.*)$/)?.slice(1) ?? [];
    });
    assert.deepEqual(files, ['deploy/images/console.Dockerfile']);
    assert.ok(!args.some(arg => /^--(?:target|build-context)(?:=|$)/.test(arg)),
      'the build must use the default stage and the pinned image inputs');
    assert.ok(!args.includes('--cache-to'));
    assert.ok(!args.includes('--push'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the shared image preserves release provenance, probes and panic diagnostics', () => {
  const dockerfile = read('deploy/images/console.Dockerfile');
  assert.match(dockerfile, /ARG SOURCE_REVISION/);
  for (const label of ['org.opencontainers.image.revision', 'com.cosskorea.console.backend.revision', 'com.cosskorea.console.web.revision']) {
    assert.ok(dockerfile.includes(`${label}="\${SOURCE_REVISION}"`), label);
  }
  assert.match(dockerfile, /org\.opencontainers\.image\.title="console-app"/);
  assert.match(dockerfile, /RUST_BACKTRACE=1 RUST_LIB_BACKTRACE=0/);
  assert.match(dockerfile, /COPY --from=web \/src\/api-probe.json \/app\/api-probe.json/);
  assert.match(dockerfile, /node deploy\/ci\/api-probe.mjs backend\/openapi\/openapi.yaml "\$\{SOURCE_REVISION\}"/);
  assert.match(dockerfile, /USER 65532:65532/);
});

test('runtime smoke requires two missing shells, a hardened app run and exit 64 for an invalid role', t => {
  const dir = mkdtempSync(join(tmpdir(), 'image-smoke-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'curl'), `#!/bin/bash
case "\${!#}" in
  */healthz) echo '{"status":"ok","role":"api"}' ;;
  */readyz) echo '{"status":"ready"}' ;;
  */) echo '<!doctype html>' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(dir, 'docker'), `#!/bin/sh
set -e
case "$1" in
  port) echo 127.0.0.1:8080; exit 0 ;;
  logs|rm) exit 0 ;;
  run) shift ;;
  *) exit 99 ;;
esac
while [ "$#" -gt 0 ]; do
  case "$1" in
    --detach|--detach=true) detached=yes; shift ;;
    --read-only|--read-only=true) readonly_root=yes; shift ;;
    --*=*) option=$1; shift; set -- "\${option%%=*}" "\${option#*=}" "$@" ;;
    --tmpfs) tmpfs=$2; shift 2 ;;
    --cap-drop) caps=$2; shift 2 ;;
    --security-opt) security=$2; shift 2 ;;
    --publish) shift 2 ;;
    --pull) pull=$2; shift 2 ;;
    --rm|--rm=true) cleanup=yes; shift ;;
    --entrypoint) shell=$2; shift 2 ;;
    -e|--env) role=$2; shift 2 ;;
    *) break ;;
  esac
done
[ "$1" = smoke-image ] || exit 99
if [ "$detached" = yes ]; then
  [ "$readonly_root" = yes ] && [ "$tmpfs" = /tmp:rw,noexec,nosuid,size=64m ] &&
    [ "$caps" = ALL ] && [ "$security" = no-new-privileges ] || exit 99
  echo smoke-container
  exit 0
fi
[ "$cleanup" = yes ] || exit 99
shift
if [ "$role" = CONSOLE_APP_ROLE=invalid ]; then exit "$ROLE_STATUS"; fi
[ "$pull" = never ] && [ "$1" = -c ] && sh "$@" || exit 99
case "$shell" in
  "$PROBE_SHELL") exit "$PROBE_STATUS" ;;
  /bin/sh|/busybox/sh) exit 127 ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
  function smoke(shell, probeStatus, roleStatus) {
    return spawnSync('bash', ['deploy/ci/image-smoke.sh', 'smoke-image'], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PROBE_SHELL: shell,
        PROBE_STATUS: String(probeStatus), ROLE_STATUS: String(roleStatus) },
    });
  }
  for (const shell of ['/bin/sh', '/busybox/sh']) {
    for (const status of [0, 125, 126]) {
      const result = smoke(shell, status, 64);
      assert.equal(result.status, 1, result.stderr);
      assert.ok(result.stderr.includes(`PLAT_RUNTIME_SHELL: smoke-image: expected missing ${shell} (exit 127), got exit ${status}`), result.stderr);
    }
  }
  for (const roleStatus of [0, 1, 64]) {
    const result = smoke('/bin/sh', 127, roleStatus);
    assert.equal(result.status, roleStatus === 64 ? 0 : 1, result.stderr);
  }
});

const revision = 'a'.repeat(40);
const response = { content: { 'application/problem+json': {} } };
const operation = { security: [{ bearer: [] }], responses: { 401: response } };
function probe(spec, sha = revision) {
  const dir = mkdtempSync(join(tmpdir(), 'api-probe-'));
  try {
    const file = join(dir, 'openapi.yaml');
    writeFileSync(file, yaml.dump(spec));
    return spawnSync(process.execPath, [join(root, 'deploy/ci/api-probe.mjs'), file, sha], { encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the probe selects a documented protected GET without required inputs in stable path order', () => {
  const spec = { paths: {
    '/api/z': { get: operation },
    '/api/a': { get: operation },
    '/api/0-public': { get: { ...operation, security: [] } },
    '/api/0-optional-auth': { get: { ...operation, security: [{}, { bearer: [] }] } },
    '/api/0-parameter': { parameters: [{ required: true }], get: operation },
    '/api/0-query': { get: { ...operation, parameters: [{ required: true }] } },
    '/api/0-post': { post: operation },
    '/api/0-body': { get: { ...operation, requestBody: {} } },
    '/api/0-status': { get: { ...operation, responses: { 200: response } } },
    '/api/0-{id}': { get: operation },
  } };
  const result = probe(spec);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { backend: revision, path: '/api/a', code: 'unauthorized' });
});

test('the probe resolves local references and inherited security', () => {
  const spec = { security: [{ bearer: [] }], paths: { '/api/a': { $ref: '#/components/path' } }, components: {
    path: { parameters: [{ $ref: '#/components/parameter' }], get: { responses: { 401: { $ref: '#/components/response' } } } },
    parameter: { required: false }, response,
  } };
  const result = probe(spec);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).path, '/api/a');
});

test('the probe refuses an invalid revision, missing candidates, and unsupported or cyclic references', () => {
  for (const [spec, sha, code] of [
    [{ paths: { '/api/a': { get: operation } } }, 'invalid', 'API_PROBE_REVISION'],
    [{ paths: {} }, revision, 'API_PROBE_MISSING'],
    [{ paths: { '/api/a': { $ref: 'external.yaml#/path' } } }, revision, 'API_PROBE_REF'],
    [{ paths: { '/api/a': { $ref: '#/paths/~1api~1a' } } }, revision, 'API_PROBE_REF'],
  ]) {
    const result = probe(spec, sha);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, new RegExp(code));
  }
});

test('the release probe can be generated from the tracked OpenAPI contract', () => {
  const result = spawnSync(process.execPath, [join(root, 'deploy/ci/api-probe.mjs'), join(root, 'backend/openapi/openapi.yaml'), revision], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).backend, revision);
});
