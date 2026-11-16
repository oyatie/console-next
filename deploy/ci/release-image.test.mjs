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
  assert.match(script, /--file deploy\/images\/console\.Dockerfile/);
  assert.match(script, /--build-arg "SOURCE_REVISION=\$\{GITHUB_SHA\}"/);
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
    for (const name of ['node', 'rust', 'runtime']) assert.ok(args.includes(`${name.toUpperCase()}_IMAGE=${versions.images[name]}`));
    assert.ok(args.includes(`SOURCE_REVISION=${revision}`));
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
