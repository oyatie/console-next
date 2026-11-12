// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
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

test('prefix count removes superseded lockfile hashes, regardless of API ordering', async () => {
  const {planCaches} = await load();
  const entries = [cache(1), cache(4), cache(2), cache(3), cache(5, {key: key(5, 'b')}),
    cache(6, {key: key(6, 'b')}), cache(7, {key: key(7, 'c')}), cache(8, {key: key(8, 'd')})];
  const plan = planCaches(entries, config(), options);
  assert.deepEqual(plan.delete.map(c => c.id).sort(), [1, 2, 5, 6]);
  assert.deepEqual(plan.keep.map(c => c.id).sort(), [3, 4, 7, 8]);
  assert.equal(plan.beforeBytes, 800);
  assert.equal(plan.projectedBytes, 400);
});

test('real dev history stays below the byte target across 113 pushes and nine manifest hashes', async () => {
  const {planCaches} = await load();
  const history = JSON.parse(readFileSync(new URL('./fixtures/cache-history.json', import.meta.url)));
  assert.equal(history.length, 113);
  assert.equal(new Set(history.map(r => r[2])).size, 9);
  let entries = [];
  for (const [sha, time, hash] of history) {
    const prefix = `backend-Linux-ARM64-${hash.repeat(8)}-`;
    const restored = entries.filter(c => c.key.startsWith(prefix)).sort((a, b) => b.id - a.id)[0];
    const saved = cache(time, {key: prefix + sha, size_in_bytes: 1238700000});
    const plan = planCaches([...entries, saved], config(), {
      family: 'backend', savedKey: saved.key, restoredKey: restored?.key,
    });
    entries = plan.keep;
    assert.ok(entries.length <= config().families.backend.copies, sha);
    assert.ok(plan.projectedBytes + 2430000000 < config().budgetBytes * config().targetFraction, sha);
    // Both next-dev and PR readers use the current manifest prefix, then the runner fallback.
    assert.equal(entries.find(c => c.key === saved.key)?.id, time);
  }
});

test('next dev and PR keep the newest current prefix and runner fallback warm', async () => {
  const {planCaches} = await load();
  const entries = [cache(1), cache(2), cache(3), cache(4), cache(5, {key: key(5, 'b')})];
  const plan = planCaches(entries, config(), options);
  for (const prefix of ['backend-Linux-ARM64-', `backend-Linux-ARM64-${'b'.repeat(64)}-`]) {
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
  for (const patch of [{copies: 0}, {restoreCopies: 0}, {prefixes: 0}, {prefixes: 1.5}, {purpose: ''}, {readers: []}]) {
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
  assert.match(writer.steps.find(s => s.id === 'rust-cache').with['restore-keys'], /backend-\$\{\{ runner.os \}\}-\$\{\{ runner.arch \}\}-\s*$/);
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
  assert.equal(cleanup['continue-on-error'], true);
  assert.ok(cleanup.id);
  const warning = writer.steps.find(s => s.if?.includes(`steps.${cleanup.id}.outcome`));
  assert.ok(warning);
  for (const outcome of ['success', 'failure', 'skipped', 'cancelled']) {
    for (const cancelled of [true, false]) {
      assert.equal(runInNewContext(warning.if.replace(/steps\.([\w-]+)/g, 'steps["$1"]'), {steps: {[cleanup.id]: {outcome}}, cancelled: () => cancelled}),
        !cancelled && outcome !== 'success');
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'cache-warning-'));
  try {
    const summary = join(dir, 'summary');
    const result = spawnSync('bash', ['-e', '-c', warning.run], {env: {...process.env, GITHUB_STEP_SUMMARY: summary}});
    assert.equal(result.status, 0);
    assert.match(readFileSync(summary, 'utf8'), /warning.*cache.*failed/i);
  } finally { rmSync(dir, {recursive: true, force: true}); }
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

test('bounded count applies to npm, browsers, DB targets, CodeQL overlays and image indexes', async () => {
  const {planCaches} = await load();
  const families = {
    npm: n => `node-cache-Linux-x64-npm-${String(n).padStart(64, 'a')}`,
    playwright: n => `playwright-Linux-X64-chromium-1.64.${n}`,
    'db-tests': n => `db-tests-Linux-ARM64-debug0-${'a'.repeat(64)}-${String(n).padStart(40, '0')}`,
    codeql: n => `codeql-overlay-base-database-1-673738e94a8102ad-javascript-2.27.4-${String(n).padStart(40, '0')}-123-1`,
    buildkit: n => `index-console-platform-arm64-1-5a70b200#${n}`,
  };
  for (const [family, makeKey] of Object.entries(families)) {
    const entries = [1, 2, 3, 4].map(n => cache(n, {key: makeKey(n)}));
    const plan = planCaches(entries, config(), {family});
    assert.deepEqual(plan.keep.map(c => c.id), [4], family);
    assert.deepEqual(plan.delete.map(c => c.id), [1, 2, 3], family);
  }
});

test('current saved prefix survives newer incompatible saves without preserving every old prefix', async () => {
  const {planCaches} = await load();
  const policy = config();
  policy.families.backend.copies = 1;
  const entries = [cache(1), cache(2), cache(3, {key: key(3, 'b')}), cache(4, {key: key(4, 'c')})];
  const plan = planCaches(entries, policy, {family: 'backend', savedKey: key(1)});
  assert.deepEqual(plan.keep.map(c => c.id), [1, 2, 4]);
  assert.throws(() => planCaches([cache(4, {ref: 'refs/pull/42/merge'})], config(), options), /CACHE_SAVE_MISSING/);
});

test('repository cache census covers every writer through the shared maintenance step', () => {
  const policy = config();
  const covered = new Set();
  for (const file of readdirSync(resolve(root, '.github/workflows')).filter(f => /\.yml$/.test(f))) {
    const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows', file), 'utf8'));
    for (const job of Object.values(workflow.jobs)) for (const step of job.steps ?? []) {
      let family;
      if (step.uses?.startsWith('actions/setup-node@') && step.with?.cache) {
        assert.equal(step.with.cache, 'npm'); family = 'npm';
      } else if (/^actions\/cache(?:\/save)?@/.test(step.uses ?? '')) {
        const keyStep = job.steps.find(s => s.id === 'rust-cache');
        const keyText = step.with.key.includes('cache-primary-key') ? keyStep?.with.key : step.with.key;
        family = keyText?.split('-${{')[0];
      } else if (step.uses?.startsWith('github/codeql-action/init@')) family = 'codeql';
      else if (step.run?.includes('--cache-to')) family = 'buildkit';
      else continue;
      assert.ok(policy.families[family]?.purpose && policy.families[family]?.readers.length, `${file}: ${family}`);
      covered.add(family);
    }
  }
  assert.deepEqual([...covered].sort(), Object.keys(policy.families).sort());
  const platform = yaml.load(readFileSync(resolve(root, '.github/workflows/platform.yml'), 'utf8'));
  const step = platform.jobs['prune-image-cache'].steps.find(s => s.id === 'prune');
  assert.match(step.with.script, /maintainCaches/);
  assert.match(step.with.script, /cache-retention.mjs/);
  assert.match(step.with.script, /dryRun: process.env.CACHE_RETENTION_APPLY !== 'true'/);
  assert.equal(step.env.CACHE_RETENTION_APPLY, '${{ vars.CACHE_RETENTION_APPLY }}');
  assert.ok(!readFileSync(resolve(root, 'scripts/cache-retention.mjs'), 'utf8').includes('prune-image-cache.mjs'));
});

test('shared sweep plans all families once and remains dry-run unless explicitly enabled', async () => {
  const {maintainCaches} = await load();
  const entries = [cache(1), cache(2), cache(3),
    cache(4, {key: `node-cache-Linux-x64-npm-${'a'.repeat(64)}`}),
    cache(5, {key: `node-cache-Linux-x64-npm-${'b'.repeat(64)}`}),
    cache(6, {key: 'unowned', ref: 'refs/pull/42/merge'})];
  for (const dryRun of [undefined, false]) {
    const {github, calls} = api(entries);
    const plan = await maintainCaches(github, context, {dryRun});
    assert.deepEqual(plan.delete.map(c => c.id), [1, 4]);
    assert.deepEqual(plan.keep.map(c => c.id), [2, 3, 5, 6]);
    assert.deepEqual(calls, dryRun === false ? [1, 4] : []);
    for (const family of Object.keys(config().families)) assert.ok(plan.summary.includes(family));
  }
});

test('dry-run budget status remains OVER when only projected bytes meet the target', async () => {
  const {maintainCaches} = await load();
  const entries = [1, 2, 3, 4].map(n => cache(n, {size_in_bytes: config().budgetBytes / 4}));
  const {github} = api(entries);
  const plan = await maintainCaches(github, context, options);
  assert.match(plan.summary, /Observed budget status: OVER/);
  assert.equal(plan.projectedBytes, config().budgetBytes / 2);
});

test('CodeQL counts by language across query configurations and compiler versions', async () => {
  const {planCaches} = await load();
  const makeKey = (hash, language, version, n) => `codeql-overlay-base-database-1-${hash}-${language}-${version}-${String(n).padStart(40, '0')}-123-1`;
  const entries = [cache(1, {key: makeKey('aaa', 'javascript', '2.26.0', 1)}),
    cache(2, {key: makeKey('bbb', 'javascript', '2.27.4', 2)}),
    cache(3, {key: makeKey('ccc', 'python', '2.27.4', 3)})];
  assert.deepEqual(planCaches(entries, config(), {family: 'codeql'}).keep.map(c => c.id), [2, 3]);
});
