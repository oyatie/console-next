// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const root = resolve(process.env.PLATFORM_REPO_ROOT ?? '.');
const workflow = yaml.load(readFileSync(join(root, '.github/workflows/platform.yml'), 'utf8'));
const build = workflow.jobs.build.steps.find(s => s.name === 'Native image and GHA cache');
const trustedPush = "github.event_name == 'push' && github.ref_name == github.event.repository.default_branch";

test('only default-branch pushes may export image caches or prune old caches', () => {
  assert.equal(build.env.CACHE_WRITE, '${{ ' + trustedPush + ' }}');
  const prune = workflow.jobs['prune-image-cache'];
  assert.equal(prune.if, trustedPush);
  assert.equal(prune.permissions.actions, 'write');
  assert.ok(workflow.jobs.build.needs.includes('prune-image-cache'));
  assert.match(workflow.jobs.build.if, /needs\['prune-image-cache'\]\.result == 'success'/);
  assert.match(workflow.jobs.build.if, /needs\['prune-image-cache'\]\.result == 'skipped'/);
  assert.match(workflow.jobs.build.if, /!cancelled\(\)/);
  assert.match(JSON.stringify(prune.steps), /prune-image-cache\.mjs/);
});

for (const arch of ['amd64', 'arm64']) for (const write of ['true', 'false', '']) {
  test(`${arch}: actual build imports a cache and exports only with CACHE_WRITE=${JSON.stringify(write)}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'image-cache-'));
    try {
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', `
docker() { if [ "$1" = info ]; then echo "$NATIVE_ARCH"; fi; }
buildx() { if [ "$1" = build ]; then printf '%s\\n' "$@" > "$CALLS"; fi; }
${build.run}`], {cwd: root, encoding: 'utf8', env: {...process.env,
        ARCH: arch, NATIVE_ARCH: arch === 'amd64' ? 'x86_64' : 'aarch64',
        CACHE_WRITE: write, RUNNER_TEMP: dir, CALLS: join(dir, 'calls'),
      }});
      assert.equal(result.status, 0, result.stderr);
      const args = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n');
      const scope = `type=gha,version=2,scope=console-platform-${arch}`;
      assert.equal(args[args.indexOf('--cache-from') + 1], scope);
      if (write === 'true') assert.equal(args[args.indexOf('--cache-to') + 1], `${scope},mode=min`);
      else assert.ok(!args.includes('--cache-to'), 'PRs and merge groups must never export');
      assert.ok(!args.some(a => a.includes('mode=max')));
      assert.ok(args.includes(`linux/${arch}`));
      assert.ok(args.includes(`type=docker,dest=${dir}/console-${arch}.tar`));
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });
}

const context = {eventName: 'push', ref: 'refs/heads/dev', repo: {owner: 'example', repo: 'console'}, payload: {repository: {default_branch: 'dev'}}};
const blob = {id: 1, key: `buildkit-blob-1-sha256:${'a'.repeat(64)}`, size_in_bytes: 8000};
const old = {id: 2, key: 'index-platform-amd64-1-5a70b200#87', size_in_bytes: 100};
const npm = {id: 3, key: 'node-cache-Linux-x64-npm-lock', size_in_bytes: 200};
const current = {id: 4, key: 'index-console-platform-arm64-1-5a70b200#1', size_in_bytes: 100};

async function prune(caches, ctx = context, failure) {
  const {pruneImageCache} = await import(pathToFileURL(join(root, 'deploy/ci/prune-image-cache.mjs')));
  const deleted = [];
  const github = {rest: {actions: {
    getActionsCacheList() {},
    async deleteActionsCacheById(args) { deleted.push(args.cache_id); if (failure) throw failure; },
  }}, async paginate(method, args) {
    assert.equal(method, github.rest.actions.getActionsCacheList);
    assert.deepEqual(args, {...context.repo, per_page: 100});
    return caches;
  }};
  const result = await pruneImageCache(github, ctx);
  return {deleted, result};
}

test('migration reclaims legacy BuildKit blobs and scopes, preserving npm and CodeQL', async () => {
  const codeql = {...npm, id: 5, key: 'codeql-trap-1'};
  const {deleted, result} = await prune([blob, old, npm, codeql]);
  assert.deepEqual(deleted, [1, 2]);
  assert.deepEqual(result, {deleted: 2, bytes: 8100});
});

test('existing new or unrelated image indexes protect shared blobs; legacy indexes still go', async () => {
  for (const index of [current, {...current, key: 'index-another-image-1-5a70b200#1'}]) {
    assert.deepEqual((await prune([blob, old, npm, index])).deleted, [2]);
  }
  assert.deepEqual((await prune([blob, npm, current])).deleted, []);
  assert.deepEqual((await prune([blob, npm])).deleted, []);
});

test('cleanup refuses PRs, merge groups, manual runs and pushes to other branches before any API call', async () => {
  for (const eventName of ['pull_request', 'merge_group', 'workflow_dispatch', 'schedule']) {
    await assert.rejects(prune([blob, old], {...context, eventName}), /default-branch push/);
  }
  await assert.rejects(prune([blob, old], {...context, ref: 'refs/heads/topic'}), /default-branch push/);
  assert.deepEqual((await prune([old], {...context, ref: 'refs/heads/main', payload: {repository: {default_branch: 'main'}}})).deleted, [2]);
});

test('cleanup tolerates entries already evicted but propagates API failures', async () => {
  assert.deepEqual((await prune([old], context, {status: 404})).result, {deleted: 0, bytes: 0});
  await assert.rejects(prune([old], context, new Error('permission denied')), /permission denied/);
});
