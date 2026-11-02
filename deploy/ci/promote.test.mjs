// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = resolve(process.env.PLATFORM_REPO_ROOT ?? '.');
const api = () => import(pathToFileURL(join(root, 'deploy/ci/promote.mjs')));
const sha = execFileSync('git', ['rev-parse', 'HEAD'], {cwd:root, encoding:'utf8'}).trim();
const previous = execFileSync('git', ['rev-parse', 'HEAD^'], {cwd:root, encoding:'utf8'}).trim();
const image = `example.invalid/console@sha256:${'a'.repeat(64)}`;
const repository = 'example/console';
const exitNames = ['ubuntu-24.04', 'ubuntu-24.04-arm'].flatMap(runner =>
  [1, 2].map(repetition => `exit-test (${runner}, ${repetition})`));

function proof() {
  return {sha, repository, currentRevision:previous, gatesResult:'pass',
    run:{id:42, path:'.github/workflows/platform.yml', event:'push', head_branch:'dev',
      head_repository:{full_name:repository}, head_sha:sha, status:'completed', conclusion:'success'},
    jobs:['validate', 'build (amd64, ubuntu-24.04)', 'build (arm64, ubuntu-24.04-arm)', 'publish', 'negative-signer / sign', ...exitNames]
      .map((name, index) => ({id:index + 1, name, run_id:42, head_sha:sha, status:'completed', conclusion:'success'})),
  };
}

test('discovers channel and target from environment configuration, without promoting templates', async () => {
  const {discoverEnvironments} = await api();
  assert.deepEqual(discoverEnvironments(root), [
    {environment:'preview', target:'host', channel:'preview'},
    {environment:'production', target:'host', channel:'production'},
  ]);
});

test('discovery reads additional environment data and refuses unsafe or duplicate channels', async () => {
  const {discoverEnvironments} = await api();
  const dir = mkdtempSync(join(tmpdir(), 'promotion-config-'));
  try {
    const write = (name, config) => {
      const path = join(dir, 'deploy/clusters', name);
      mkdirSync(path, {recursive:true});
      writeFileSync(join(path, 'platform.json'), JSON.stringify(config));
    };
    write('example', {target:'host', channel:'candidate'});
    assert.deepEqual(discoverEnvironments(dir), [{environment:'example', target:'host', channel:'candidate'}]);
    for (const config of [
      {target:'host'}, {channel:'candidate'}, {target:'invalid', channel:'candidate'},
      {target:'host', channel:'../candidate'}, {target:'host', channel:'candidate-'+ 'a'.repeat(128)},
    ]) {
      write('example', config);
      assert.throws(() => discoverEnvironments(dir), /PROMOTE_ENVIRONMENT/);
    }
    write('example', {target:'host', channel:'candidate'});
    write('another', {target:'host', channel:'candidate'});
    assert.throws(() => discoverEnvironments(dir), /PROMOTE_ENVIRONMENT/);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

function render(environment, directory, cwd = root, revision = sha) {
  return spawnSync(process.execPath, ['deploy/ci/render.mjs', environment, image, directory], {
    cwd, encoding:'utf8', env:{...process.env, GITHUB_SHA:revision},
  });
}

for (const environment of ['preview', 'production']) test(`${environment}: host renders only the host-compatible revision`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'promotion-host-'));
  try {
    const result = render(environment, dir);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(dir), ['revision.json']);
    const revision = JSON.parse(readFileSync(join(dir, 'revision.json'), 'utf8'));
    assert.deepEqual(revision, {revision:sha, image, environment});
    const rule = '.revision | test("^[a-f0-9]{40}$")';
    assert.equal(spawnSync('jq', ['-e', rule, join(dir, 'revision.json')]).status, 0);
    assert.equal(spawnSync('jq', ['-e', '--arg', 'env', environment, '--arg', 'repo', image.split('@')[0],
      '.environment == $env and (.image | startswith($repo + "@sha256:")) and (.image | test("@sha256:[a-f0-9]{64}$"))',
      join(dir, 'revision.json')]).status, 0);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('renderer accepts a new environment directory and refuses unknown, traversal and symlink environments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'promotion-render-'));
  try {
    cpSync(join(root, 'deploy'), join(dir, 'deploy'), {recursive:true});
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
    mkdirSync(join(dir, 'deploy/clusters/example'));
    writeFileSync(join(dir, 'deploy/clusters/example/platform.json'), JSON.stringify({target:'host', channel:'candidate'}));
    const result = render('example', join(dir, 'out'), dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, 'out/revision.json'))).environment, 'example');
    symlinkSync(join(dir, 'deploy/clusters/example'), join(dir, 'deploy/clusters/linked'));
    mkdirSync(join(dir, 'deploy/clusters/linked-config'));
    symlinkSync(join(dir, 'deploy/clusters/example/platform.json'), join(dir, 'deploy/clusters/linked-config/platform.json'));
    for (const environment of ['unknown', '../clusters/example', 'example/../example', 'linked', 'linked-config']) {
      const result = render(environment, join(dir, 'refused'), dir);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /PLAT_OVERLAY/);
      assert.equal(existsSync(join(dir, 'refused')), false);
    }
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('host rendering refuses an invalid revision and a directory containing a Kubernetes tree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'promotion-clean-'));
  try {
    const result = render('preview', join(dir, 'out'), root, 'local');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PLAT_REVISION/);
    assert.equal(existsSync(join(dir, 'out')), false);
    mkdirSync(join(dir, 'app'));
    const stale = render('preview', dir);
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /PLAT_HOST_OUTPUT/);
    assert.equal(existsSync(join(dir, 'revision.json')), false);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('a newly configured Kubernetes environment uses the existing renderer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'promotion-kubernetes-'));
  try {
    cpSync(join(root, 'deploy'), join(dir, 'deploy'), {recursive:true});
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
    cpSync(join(dir, 'deploy/clusters/template'), join(dir, 'deploy/clusters/example'), {recursive:true});
    const configFile = join(dir, 'deploy/clusters/example/platform.json');
    const config = JSON.parse(readFileSync(configFile));
    writeFileSync(configFile, JSON.stringify({...config, target:'kubernetes', channel:'candidate'}));
    const result = render('example', join(dir, 'out'), dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, 'out/revision.json'))).environment, 'example');
    for (const group of ['app', 'policies', 'database', 'platform', 'reconcile']) {
      assert.ok(existsSync(join(dir, 'out', group, 'resources.yaml')) ||
        existsSync(join(dir, 'out', group, 'kustomization.yaml')));
    }
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('green exact-SHA platform proof admits first, descendant and repeated promotions', async () => {
  const {assertPromotion} = await api();
  for (const currentRevision of [null, previous, sha]) {
    assert.doesNotThrow(() => assertPromotion({...proof(), currentRevision}, root));
  }
});

for (const conclusion of ['failure', 'skipped', 'cancelled', 'neutral', null]) {
  test(`PROMOTE_NOT_GREEN: refuses a ${conclusion} platform job`, async () => {
    const {assertPromotion} = await api();
    const input = proof();
    input.jobs[0].conclusion = conclusion;
    assert.throws(() => assertPromotion(input, root), /PROMOTE_NOT_GREEN/);
  });
}

for (const [reason, change] of [
  ['wrong workflow', input => { input.run.path = '.github/workflows/other.yml'; }],
  ['wrong SHA', input => { input.run.head_sha = previous; }],
  ['red run', input => { input.run.conclusion = 'failure'; }],
  ['pending run', input => { input.run.status = 'in_progress'; }],
  ['empty jobs', input => { input.jobs = []; }],
  ['missing publish job', input => { input.jobs = input.jobs.filter(job => job.name !== 'publish'); }],
  ['missing native build', input => { input.jobs.splice(1, 1); }],
  ['missing exit test', input => { input.jobs.pop(); }],
  ['duplicate exit test', input => { input.jobs.push({...input.jobs.at(-1), id:100}); }],
  ['duplicate job ID', input => { input.jobs[0].id = input.jobs[1].id; }],
  ['wrong job SHA', input => { input.jobs[0].head_sha = previous; }],
  ['wrong run ID', input => { input.jobs[0].run_id = 41; }],
  ['pending job', input => { input.jobs[0].status = 'in_progress'; }],
  ['missing job name', input => { delete input.jobs[0].name; }],
]) test(`PROMOTE_NOT_GREEN: refuses ${reason}`, async () => {
  const {assertPromotion} = await api();
  const input = proof();
  change(input);
  assert.throws(() => assertPromotion(input, root), /PROMOTE_NOT_GREEN/);
});

for (const [reason, change] of [
  ['fork', input => { input.run.head_repository.full_name = 'fork/console'; }],
  ['non-push', input => { input.run.event = 'pull_request'; }],
  ['non-dev', input => { input.run.head_branch = 'feature'; }],
  ['missing repository', input => { delete input.run.head_repository; }],
]) test(`PROMOTE_FORK: refuses ${reason}`, async () => {
  const {assertPromotion} = await api();
  const input = proof();
  change(input);
  assert.throws(() => assertPromotion(input, root), /PROMOTE_FORK/);
});

for (const gatesResult of ['fail', 'skipped', '', undefined]) test(`PROMOTE_GATES: refuses ${gatesResult}`, async () => {
  const {assertPromotion} = await api();
  assert.throws(() => assertPromotion({...proof(), gatesResult}, root), /PROMOTE_GATES/);
});

test('PROMOTE_NOT_GREEN: refuses matrix policies whose proof inventory is unsupported', async () => {
  const {assertPromotion} = await api();
  const dir = mkdtempSync(join(tmpdir(), 'promotion-matrix-'));
  try {
    mkdirSync(join(dir, '.github/workflows'), {recursive:true});
    const source = readFileSync(join(root, '.github/workflows/platform.yml'), 'utf8');
    const rows = ['ubuntu-24.04', 'ubuntu-24.04-arm'].flatMap(runner =>
      [1, 2].map(repetition => `          - {runner: ${runner}, repetition: ${repetition}}`));
    for (const policy of ['exclude: []', `include:\n${rows.join('\n')}`]) {
      const config = source.replace('runner: [ubuntu-24.04, ubuntu-24.04-arm]',
        `${policy}\n        runner: [ubuntu-24.04, ubuntu-24.04-arm]`);
      assert.notEqual(config, source);
      writeFileSync(join(dir, '.github/workflows/platform.yml'), config);
      assert.throws(() => assertPromotion({...proof(), currentRevision:null}, dir), /PROMOTE_NOT_GREEN/);
    }
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('PROMOTE_NOT_DESCENDANT: refuses moving a channel backwards or accepting unknown history', async () => {
  const {assertPromotion} = await api();
  const input = proof();
  input.sha = previous;
  input.run.head_sha = previous;
  input.jobs.forEach(job => { job.head_sha = previous; });
  input.currentRevision = sha;
  assert.throws(() => assertPromotion(input, root), /PROMOTE_NOT_DESCENDANT/);
  for (const currentRevision of [undefined, '', 'local', '0'.repeat(40), 'f'.repeat(40)]) {
    assert.throws(() => assertPromotion({...proof(), currentRevision}, root), /PROMOTE_NOT_DESCENDANT/);
  }
});
