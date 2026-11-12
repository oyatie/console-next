// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import yaml from 'js-yaml';

const root = resolve(process.env.STORAGE_REPO_ROOT ?? '.');
const load = () => import(pathToFileURL(resolve(root, 'scripts/cache-retention.mjs')));
const config = () => JSON.parse(readFileSync(resolve(root, 'scripts/cache-retention.config.json')));
const ci = yaml.load(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'));
const key = (n, hash = 'a', arch = 'ARM64') => `backend-Linux-${arch}-${hash.repeat(64)}-${String(n).padStart(40, '0')}`;
const cache = (id, extra = {}) => ({id, key: key(id), ref: 'refs/heads/dev', version: 'zstd-linux',
  size_in_bytes: 100, created_at: new Date(id * 1000).toISOString(), ...extra});
const context = {eventName: 'push', ref: 'refs/heads/dev', repo: {owner: 'example', repo: 'console'},
  payload: {repository: {default_branch: 'dev'}}};
const options = {family: 'backend', savedKey: key(4), restoredKey: key(3)};

test('newest two and every compatible restore prefix survive, regardless of API ordering', async () => {
  const {planCaches} = await load();
  const entries = [cache(1), cache(4), cache(2), cache(3), cache(5, {key: key(5, 'b')}),
    cache(6, {key: key(6, 'b')}), cache(7, {key: key(7, 'c')}), cache(8, {key: key(8, 'd')})];
  const plan = planCaches(entries, config(), options);
  assert.deepEqual(plan.delete.map(c => c.id).sort(), [1, 2, 5]);
  assert.deepEqual(plan.keep.map(c => c.id).sort(), [3, 4, 6, 7, 8]);
  assert.equal(plan.beforeBytes, 800);
  assert.equal(plan.projectedBytes, 500);
});

test('next dev and PR restore the same newest compatible fallback after pruning', async () => {
  const {planCaches} = await load();
  const entries = [cache(1), cache(2), cache(3), cache(4), cache(5, {key: key(5, 'b')})];
  const plan = planCaches(entries, config(), options);
  for (const prefix of ['backend-Linux-ARM64-', `backend-Linux-ARM64-${'a'.repeat(64)}-`,
    `backend-Linux-ARM64-${'b'.repeat(64)}-`]) {
    const newest = list => list.filter(c => c.key.startsWith(prefix)).sort((a, b) => b.id - a.id)[0].id;
    assert.equal(newest(plan.keep), newest(entries));
  }
});

test('versions, runner families, unknown caches and non-PR branches are isolated', async () => {
  const {planCaches} = await load();
  const entries = [cache(1), cache(2), cache(3), cache(4), cache(5, {version: 'other'}),
    cache(6, {key: key(6, 'a', 'X64')}), cache(7, {key: 'codeql-overlay'}),
    cache(8, {ref: 'refs/heads/release'}), cache(9, {ref: 'refs/pull/42/merge'})];
  assert.deepEqual(planCaches(entries, config(), options).delete.map(c => c.id).sort(), [1, 2, 9]);
});

test('saved and restored entries are protected even when newer concurrent saves exist', async () => {
  const {planCaches} = await load();
  const plan = planCaches([1, 2, 3, 4, 5, 6].map(n => cache(n)), config(), options);
  assert.deepEqual(plan.keep.map(c => c.id).sort(), [3, 4, 5, 6]);
});

test('missing save, unknown family, invalid counts and incomplete metadata refuse to plan', async () => {
  const {planCaches} = await load();
  assert.throws(() => planCaches([cache(3)], config(), options), /CACHE_SAVE_MISSING/);
  assert.throws(() => planCaches([cache(4)], config(), {...options, family: 'unknown'}), /CACHE_POLICY/);
  for (const patch of [{copies: 0}, {restoreCopies: 0}, {purpose: ''}, {readers: []}]) {
    const policy = config();
    Object.assign(policy.families.backend, patch);
    assert.throws(() => planCaches([cache(4)], policy, options), /CACHE_POLICY/);
  }
  for (const patch of [{created_at: 'invalid'}, {size_in_bytes: -1}, {version: ''}, {id: undefined}]) {
    assert.throws(() => planCaches([cache(4), cache(1, patch)], config(), options), /CACHE_METADATA/);
  }
});

function api(entries, failure) {
  const calls = [];
  const github = {rest: {actions: {getActionsCacheList() {}, async deleteActionsCacheById(args) {
    calls.push(args.cache_id);
    if (failure) throw failure;
  }}}, async paginate(method, args) {
    assert.equal(method, github.rest.actions.getActionsCacheList);
    assert.deepEqual(args, {...context.repo, per_page: 100});
    return entries;
  }};
  return {github, calls};
}

test('default mode is dry-run and reports observed/projected budget and deletion IDs', async () => {
  const {maintainCaches} = await load();
  const {github, calls} = api([1, 2, 3, 4].map(n => cache(n)));
  const result = await maintainCaches(github, context, options);
  assert.deepEqual(calls, []);
  assert.match(result.summary, /DRY RUN/);
  assert.match(result.summary, /Observed.*400.*Projected.*200/s);
  assert.match(result.summary, /70%/);
  assert.match(result.summary, /\| DELETE \| 1 \|/);
  assert.match(result.summary, /\| KEEP \| 4 \|/);
});

test('apply deletes only the plan; 404 is harmless, other API errors propagate', async () => {
  const {maintainCaches} = await load();
  for (const failure of [undefined, {status: 404}]) {
    const {github, calls} = api([1, 2, 3, 4].map(n => cache(n)), failure);
    const result = await maintainCaches(github, context, {...options, dryRun: false});
    assert.deepEqual(calls, [1, 2]);
    assert.match(result.summary, /APPLY/);
  }
  const {github} = api([1, 2, 3, 4].map(n => cache(n)), new Error('permission denied'));
  await assert.rejects(maintainCaches(github, context, {...options, dryRun: false}), /permission denied/);
});

test('untrusted events and branches refuse before listing or deleting', async () => {
  const {maintainCaches} = await load();
  for (const patch of [{eventName: 'pull_request'}, {eventName: 'merge_group'},
    {eventName: 'workflow_dispatch'}, {ref: 'refs/heads/topic'}, {payload: {repository: {default_branch: 'main'}}}]) {
    await assert.rejects(maintainCaches({}, {...context, ...patch}, options), /CACHE_TRUST/);
  }
});

test('an unsuccessful save or unreadable inventory cannot delete anything', async () => {
  const {maintainCaches} = await load();
  const {github, calls} = api([cache(1), cache(2), cache(3)]);
  await assert.rejects(maintainCaches(github, context, {...options, dryRun: false}), /CACHE_SAVE_MISSING/);
  assert.deepEqual(calls, []);
  github.paginate = async () => { throw new Error('inventory unavailable'); };
  await assert.rejects(maintainCaches(github, context, {...options, dryRun: false}), /inventory unavailable/);
  assert.deepEqual(calls, []);
});

test('restore summary distinguishes exact hit, warm fallback and cold miss', async () => {
  const {restoreSummary} = await load();
  assert.match(restoreSummary('backend', key(1), key(1)), /exact hit/);
  assert.match(restoreSummary('backend', key(2), key(1)), /warm fallback/);
  assert.match(restoreSummary('backend', key(2), ''), /MISS/);
});

test('actual reader shell reports from both backend and repository working directories', () => {
  const step = ci.jobs.backend.steps.find(s => s.name === 'Report Rust cache restore');
  assert.ok(step);
  const dir = mkdtempSync(join(tmpdir(), 'cache-restore-'));
  try {
    for (const cwd of [root, resolve(root, 'backend')]) {
      const summary = join(dir, 'summary');
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {cwd, encoding: 'utf8', env: {
        ...process.env, GITHUB_WORKSPACE: root, GITHUB_STEP_SUMMARY: summary, CACHE_PRIMARY: key(4), CACHE_MATCHED: key(3),
      }});
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /backend cache restore: warm fallback/);
      assert.match(readFileSync(summary, 'utf8'), /backend cache restore: warm fallback/);
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('Rust producer census: successful save and merge gate retention, with reviewed apply opt-in', () => {
  const writer = ci.jobs['backend-cache'];
  const saves = writer.steps.filter(s => s.uses?.startsWith('actions/cache/save@'));
  assert.equal(saves.length, 1);
  assert.equal(saves[0].id, 'rust-cache-save');
  const merge = writer.steps.find(s => s.name === 'Merge Rust cache changes');
  assert.equal(merge.id, 'rust-cache-merge');
  const cleanup = writer.steps.find(s => s.name === 'Retain Rust caches by purpose and count');
  assert.ok(cleanup);
  assert.match(cleanup.if, /steps.rust-cache-save.outcome == 'success'/);
  assert.match(cleanup.if, /steps.rust-cache-merge.outcome == 'success'/);
  const condition = new Function('steps', `return ${cleanup.if.replace(/steps\.([\w-]+)/g, 'steps["$1"]')}`);
  for (const save of ['success', 'failure', 'skipped', 'cancelled']) for (const merge of ['success', 'failure', 'skipped', 'cancelled']) {
    assert.equal(condition({'rust-cache-save': {outcome: save}, 'rust-cache-merge': {outcome: merge}}),
      save === 'success' && merge === 'success');
  }
  assert.equal(writer.permissions.actions, 'write');
  assert.equal(cleanup.env.CACHE_RETENTION_APPLY, '${{ vars.CACHE_RETENTION_APPLY }}');
  assert.match(cleanup.with.script, /dryRun: process.env.CACHE_RETENTION_APPLY !== 'true'/);
  assert.equal(cleanup.env.SAVED_KEY, saves[0].with.key);
  assert.equal(cleanup.env.RESTORED_KEY, '${{ steps.rust-cache.outputs.cache-matched-key }}');
  assert.match(cleanup.with.script, /family: 'backend'/);
  assert.ok(cleanup['timeout-minutes'] > 0);
  assert.ok(writer.steps.some(s => s.run?.includes('cache-retention.mjs')));
  assert.ok(ci.jobs.web.steps.some(s => s.run?.includes('node --test scripts/cache-retention.test.mjs')));
  for (const job of Object.values(ci.jobs).filter(j => j.steps?.some(s => s.id === 'rust-cache'))) {
    assert.ok(job.steps.some(s => s.name === 'Report Rust cache restore'), 'every Rust reader reports warmth');
  }
});
