// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';

const root = resolve(process.env.PLATFORM_REPO_ROOT ?? '.');
const api = () => import(pathToFileURL(join(root, 'deploy/ci/promote.mjs')));
const historyRoot = mkdtempSync(join(tmpdir(), 'promotion-history-'));
after(() => rmSync(historyRoot, {recursive:true, force:true}));
const git = (...args) => execFileSync('git', args, {cwd:historyRoot, encoding:'utf8'}).trim();
git('init', '--quiet');
mkdirSync(join(historyRoot, '.github/workflows'), {recursive:true});
cpSync(join(root, '.github/workflows/platform.yml'), join(historyRoot, '.github/workflows/platform.yml'));
git('add', '.github/workflows/platform.yml');
const commit = message => git('-c', 'user.name=ci', '-c', 'user.email=ci@example.invalid',
  'commit', '--quiet', '--allow-empty', '--no-gpg-sign', '-m', message);
commit('initial platform workflow');
const previous = git('rev-parse', 'HEAD');
commit('candidate');
const sha = git('rev-parse', 'HEAD');
const image = `example.invalid/console@sha256:${'a'.repeat(64)}`;
const repository = 'example/console';
const exitNames = ['ubuntu-24.04', 'ubuntu-24.04-arm'].flatMap(runner =>
  [1, 2].map(repetition => `exit-test (${runner}, ${repetition})`));

function proof() {
  return {sha, repository, currentRevision:previous, gatesResult:'pass',
    run:{id:42, path:'.github/workflows/platform.yml', event:'push', head_branch:'dev',
      head_repository:{full_name:repository}, head_sha:sha, status:'completed', conclusion:'success'},
    jobs:['validate', 'build (amd64, ubuntu-24.04)', 'build (arm64, ubuntu-24.04-arm)', 'publish', 'scan', 'negative-signer / sign', 'prune-image-cache', ...exitNames]
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
      const refused = render(environment, join(dir, 'refused'), dir);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /PLAT_OVERLAY/);
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
    assert.doesNotThrow(() => assertPromotion({...proof(), currentRevision}, historyRoot));
  }
});

for (const conclusion of ['failure', 'skipped', 'cancelled', 'neutral', null]) {
  test(`PROMOTE_NOT_GREEN: refuses ${conclusion} cache maintenance evidence`, async () => {
    const {assertPromotion} = await api();
    const input = proof();
    const cleanup = input.jobs.find(job => job.name === 'prune-image-cache');
    cleanup.status = conclusion === null ? 'in_progress' : 'completed';
    cleanup.conclusion = conclusion;
    assert.throws(() => assertPromotion(input, historyRoot), /PROMOTE_NOT_GREEN/);
  });
}

for (const conclusion of ['failure', 'skipped', 'cancelled', 'neutral', null]) {
  test(`PROMOTE_NOT_GREEN: refuses a ${conclusion} platform job`, async () => {
    const {assertPromotion} = await api();
    const input = proof();
    input.jobs[0].conclusion = conclusion;
    assert.throws(() => assertPromotion(input, historyRoot), /PROMOTE_NOT_GREEN/);
  });
}

for (const [reason, change] of [
  ['wrong workflow', input => { input.run.path = '.github/workflows/other.yml'; }],
  ['wrong SHA', input => { input.run.head_sha = previous; }],
  ['red run', input => { input.run.conclusion = 'failure'; }],
  ['pending run', input => { input.run.status = 'in_progress'; }],
  ['empty jobs', input => { input.jobs = []; }],
  ['missing publish job', input => { input.jobs = input.jobs.filter(job => job.name !== 'publish'); }],
  ['missing cache maintenance job', input => { input.jobs = input.jobs.filter(job => job.name !== 'prune-image-cache'); }],
  ['wrong cache maintenance SHA', input => { input.jobs.find(job => job.name === 'prune-image-cache').head_sha = previous; }],
  ['wrong cache maintenance run', input => { input.jobs.find(job => job.name === 'prune-image-cache').run_id = 41; }],
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
  assert.throws(() => assertPromotion(input, historyRoot), /PROMOTE_NOT_GREEN/);
});

for (const [reason, change] of [
  ['fork', input => { input.run.head_repository.full_name = 'fork/console'; }],
  ['non-push', input => { input.run.event = 'pull_request'; }],
  ['non-dev', input => { input.run.head_branch = 'feature'; }],
  ['missing repository', input => { delete input.run.head_repository; }],
  ['missing both repositories', input => { delete input.repository; delete input.run.head_repository; }],
]) test(`PROMOTE_FORK: refuses ${reason}`, async () => {
  const {assertPromotion} = await api();
  const input = proof();
  change(input);
  assert.throws(() => assertPromotion(input, historyRoot), /PROMOTE_FORK/);
});

for (const gatesResult of ['fail', 'skipped', '', undefined]) test(`PROMOTE_GATES: refuses ${gatesResult}`, async () => {
  const {assertPromotion} = await api();
  assert.throws(() => assertPromotion({...proof(), gatesResult}, historyRoot), /PROMOTE_GATES/);
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

test('PROMOTE_NOT_GREEN: refuses unknown expressions and malformed event matrix axes', async () => {
  const {assertPromotion} = await api();
  const dir = mkdtempSync(join(tmpdir(), 'promotion-event-matrix-'));
  try {
    mkdirSync(join(dir, '.github/workflows'), {recursive:true});
    const source = readFileSync(join(root, '.github/workflows/platform.yml'), 'utf8');
    for (const expression of [
      "${{ github.event_name }}",
      "${{ fromJSON(github.event_name == 'schedule' && '[1, 2]' || 'null') }}",
      "${{ fromJSON(github.event_name == 'schedule' && '[1, 2]' || '[ ]') }}",
    ]) {
      const config = source.replace(/repetition: .*/, `repetition: ${expression}`);
      assert.notEqual(config, source);
      writeFileSync(join(dir, '.github/workflows/platform.yml'), config);
      const input = {...proof(), currentRevision:null};
      input.jobs = input.jobs.filter(job => !job.name.startsWith('exit-test ('));
      assert.throws(() => assertPromotion(input, dir), /PROMOTE_NOT_GREEN/);
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
  assert.throws(() => assertPromotion(input, historyRoot), /PROMOTE_NOT_DESCENDANT/);
  for (const currentRevision of [undefined, '', 'local', '0'.repeat(40), 'f'.repeat(40)]) {
    assert.throws(() => assertPromotion({...proof(), currentRevision}, historyRoot), /PROMOTE_NOT_DESCENDANT/);
  }
});

test('PROMOTE_NOT_DESCENDANT: caller must use fetch-depth: 0 for channel ancestry', async () => {
  const {assertPromotion} = await api();
  const dir = mkdtempSync(join(tmpdir(), 'promotion-shallow-'));
  try {
    execFileSync('git', ['clone', '--quiet', '--depth', '1', pathToFileURL(historyRoot).href, dir]);
    assert.equal(execFileSync('git', ['rev-parse', '--is-shallow-repository'], {cwd:dir, encoding:'utf8'}).trim(), 'true');
    for (const currentRevision of [sha, previous]) {
      assert.throws(() => assertPromotion({...proof(), currentRevision}, dir), /PROMOTE_NOT_DESCENDANT:.*fetch-depth: 0/);
    }
    assert.doesNotThrow(() => assertPromotion({...proof(), currentRevision:null}, dir));
    execFileSync('git', ['fetch', '--quiet', '--unshallow'], {cwd:dir});
    for (const currentRevision of [previous, sha]) {
      assert.doesNotThrow(() => assertPromotion({...proof(), currentRevision}, dir));
    }
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

const runUrl = 'https://github.com/example/console/actions/runs/200/attempts/1';
const predicate = () => ({inputs:{backend:sha, web:sha},
  gates:['code-gates', 'api-compat', 'sbom', 'scan', 'smoke'].map(name => ({name, result:'pass'})),
  runner:{kind:'gha', url:runUrl}, approver:null, bake:'normal'});

for (const reason of ['missing', 'failed', 'missing gate', 'duplicate gate', 'wrong SHA', 'wrong run', 'wrong runner', 'invalid bake', 'missing run']) {
  test(`PROMOTE_GATES: publisher refuses ${reason} predicate`, async () => {
    const {validatePredicate} = await api();
    const value = predicate();
    if (reason === 'failed') value.gates[0].result = 'fail';
    if (reason === 'missing gate') value.gates.pop();
    if (reason === 'duplicate gate') value.gates[0] = value.gates[1];
    if (reason === 'wrong SHA') value.inputs.web = previous;
    if (reason === 'wrong run') value.runner.url += '0';
    if (reason === 'wrong runner') value.runner.kind = 'local';
    if (reason === 'invalid bake') value.bake = 'none';
    if (reason === 'missing run') delete value.runner.url;
    assert.throws(() => validatePredicate(reason === 'missing' ? undefined : value, sha, runUrl), /PROMOTE_GATES/);
  });
}

test('platform collector paginates only the selected run attempt and refuses a red run', async () => {
  const {collectPlatformProof} = await api();
  const input = proof();
  input.run.run_attempt = 3;
  const github = {rest:{actions:{getWorkflowRun:async params => {
    assert.deepEqual(params, {owner:'example', repo:'console', run_id:42});
    return {data:input.run};
  }}}, paginate:async (route, params) => {
    assert.match(route, /attempts\/\{attempt_number\}\/jobs$/);
    assert.equal(params.attempt_number, 3);
    assert.equal(params.per_page, 100);
    return input.jobs;
  }};
  const result = await collectPlatformProof(github, repository, 42, historyRoot);
  assert.equal(result.sha, sha);
  assert.deepEqual(result.jobs, input.jobs);
  input.run.run_attempt = 0;
  await assert.rejects(() => collectPlatformProof(github, repository, 42, historyRoot), /PROMOTE_NOT_GREEN/);
  input.run.run_attempt = 3;
  input.run.id = 99;
  input.jobs.forEach(job => { job.run_id = 99; });
  await assert.rejects(() => collectPlatformProof(github, repository, 42, historyRoot), /PROMOTE_NOT_GREEN/);
  input.run.id = 42;
  input.jobs.forEach(job => { job.run_id = 42; });
  input.jobs[0].conclusion = 'failure';
  await assert.rejects(() => collectPlatformProof(github, repository, 42, historyRoot), /PROMOTE_NOT_GREEN/);
});

async function publishingFixture(options = {}) {
  const {publishEnvironment} = await api();
  assert.equal(typeof publishEnvironment, 'function', 'publisher must be available');
  const directory = mkdtempSync(join(tmpdir(), 'promotion-publish-'));
  const calls = [];
  const deploy = `ghcr.io/${repository}/console-deploy`;
  const digests = {shadow:`sha256:${'b'.repeat(64)}`, current:`sha256:${'c'.repeat(64)}`, artifact:`sha256:${'d'.repeat(64)}`};
  const image = `ghcr.io/${repository}/console@sha256:${'a'.repeat(64)}`;
  const envConfig = join(historyRoot, 'deploy/clusters/production');
  mkdirSync(envConfig, {recursive:true});
  writeFileSync(join(envConfig, 'platform.json'), JSON.stringify({target:'host', channel:'production'}));
  const execute = (bin, args, toolOptions) => {
    calls.push([bin, ...args]);
    if (bin === 'buildx') {
      const tag = args[2].split(':').at(-1);
      const kind = tag === 'shadow' ? 'shadow' : tag === 'production' ? 'current' : 'artifact';
      if ((options.registryError || options.unrelated404) && kind === 'current') throw Object.assign(new Error('registry unavailable'), {stderr:options.unrelated404 ? '404 route not found' : 'UNAUTHORIZED'});
      if (kind === 'current' && !options.current || kind === 'artifact' && !options.existing) {
        throw Object.assign(new Error('absent'), {stderr:options.buildxAbsent ? `ERROR: ${deploy}:${tag}: not found\n` : 'MANIFEST_UNKNOWN'});
      }
      return JSON.stringify({digest:options.badDigest ? 'sha256:invalid' : digests[kind]});
    }
    if (bin === 'cosign') {
      const ref = args.at(-1);
      if (options.unsignedCurrent && ref.endsWith(digests.current)) throw new Error('no signatures found');
      if (options.unsigned && ref.endsWith(digests.shadow)) throw new Error('no signatures found');
      if (options.wrongIdentity && ref.endsWith(digests.shadow)) throw new Error('certificate identity mismatch');
      if (options.signFailure && args[0] === 'sign') throw new Error('OIDC unavailable');
      if (options.attestFailure && args[0] === 'attest') throw new Error('attestation upload failed');
      if (args[0] === 'verify' && ref.endsWith(digests.artifact) &&
        (args.some(a => a.includes('platform.yml')) || !calls.some(call => call[1] === 'sign') && !options.existing)) {
        throw new Error('no matching signature');
      }
      if (args[0] === 'verify-attestation') {
        if (options.missingAttestation) throw new Error('no attestations found');
        if (options.emptyAttestation) return '[]';
        if (options.malformedAttestation) return '{}';
        const value = predicate();
        if (options.failedAttestation) value.gates[0].result = 'fail';
        if (options.wrongAttestationRepo) value.runner.url = value.runner.url.replace('/example/console/', '/other/console/');
        return JSON.stringify({payload:Buffer.from(JSON.stringify({
          predicateType:options.wrongType ? 'other' : 'https://cosskorea.com/attestations/console-gates/v1',
          subject:[{digest:{sha256:options.wrongSubject ? 'e'.repeat(64) : ref.split(':').at(-1)}}], predicate:value,
        })).toString('base64')});
      }
      return '[]';
    }
    if (bin === 'flux' && args[0] === 'pull') {
      const output = args.find(arg => arg.startsWith('--output=')).slice(9);
      const current = args[2].endsWith(digests.current);
      writeFileSync(join(output, 'revision.json'), JSON.stringify({
        revision:current ? options.current : options.immutableSha && args[2].endsWith(digests.artifact) ? previous : options.shadowSha ?? sha,
        image:options.invalidImage ? image.replace('/console@', '/other@') : image,
        environment:options.invalidEnvironment ? 'other' : current || args[2].endsWith(digests.artifact) ? 'production' : 'exit-test',
      }));
      writeFileSync(join(output, 'image-sbom.json'), JSON.stringify({spdxVersion:'SPDX-2.3'}));
    }
    if (bin === process.execPath) {
      assert.equal(toolOptions.env.GITHUB_SHA, sha);
      assert.equal(toolOptions.cwd, historyRoot);
      const output = args[3];
      mkdirSync(output, {recursive:true});
      writeFileSync(join(output, 'revision.json'), JSON.stringify({revision:sha, image, environment:'production'}));
    }
    if (bin === 'flux' && args[0] === 'push') return JSON.stringify({digest:digests.artifact});
    return '';
  };
  const input = {proof:{...proof(), currentRevision:null}, environment:'production',
    predicate:options.missingPredicate ? undefined : predicate(), runUrl, root:historyRoot, directory};
  if (options.failedGate) input.predicate.gates[0].result = 'fail';
  const publish = () => publishEnvironment(input, execute);
  return {publish, calls, directory, deploy, digests};
}

for (const reason of ['unsigned', 'wrongIdentity', 'failedGate', 'missingPredicate', 'registryError', 'unrelated404', 'signFailure', 'attestFailure', 'failedAttestation', 'missingAttestation', 'emptyAttestation', 'malformedAttestation', 'wrongType', 'wrongSubject', 'wrongAttestationRepo', 'badDigest', 'invalidImage', 'shadowSha', 'current']) {
  test(`publisher refuses ${reason} without moving a channel`, async () => {
    const value = reason === 'current' ? 'f'.repeat(40) : reason === 'shadowSha' ? previous : true;
    const fixture = await publishingFixture({[reason]:value});
    try {
      const refusal = {
        unsigned:'no signatures found', wrongIdentity:'certificate identity mismatch',
        failedGate:'PROMOTE_GATES', missingPredicate:'PROMOTE_GATES', registryError:'registry unavailable', unrelated404:'registry unavailable',
        signFailure:'OIDC unavailable', attestFailure:'attestation upload failed',
        failedAttestation:'PROMOTE_GATES', missingAttestation:'PROMOTE_GATES', emptyAttestation:'PROMOTE_GATES',
        malformedAttestation:'PROMOTE_GATES', wrongType:'PROMOTE_GATES', wrongSubject:'PROMOTE_GATES',
        wrongAttestationRepo:'PROMOTE_GATES', badDigest:'PROMOTE_ARTIFACT', invalidImage:'PROMOTE_ARTIFACT',
        shadowSha:'PROMOTE_NOT_GREEN', current:'PROMOTE_NOT_DESCENDANT',
      };
      assert.throws(fixture.publish, new RegExp(refusal[reason]));
      assert.equal(fixture.calls.some(call => call[0] === 'flux' && call[1] === 'tag'), false);
      if (['unsigned', 'wrongIdentity', 'failedGate', 'missingPredicate', 'registryError', 'unrelated404', 'badDigest', 'invalidImage', 'shadowSha', 'current'].includes(reason)) {
        assert.equal(fixture.calls.some(call => call[0] === 'flux' && call[1] === 'push'), false);
      }
    } finally { rmSync(fixture.directory, {recursive:true, force:true}); }
  });
}


test('publisher bootstraps on the locked Buildx missing-tag response', async () => {
  const fixture = await publishingFixture({buildxAbsent:true});
  try {
    assert.equal(fixture.publish(), `${fixture.deploy}@${fixture.digests.artifact}`);
    assert.equal(fixture.calls.at(-1)[1], 'tag');
  } finally { rmSync(fixture.directory, {recursive:true, force:true}); }
});

for (const reason of ['immutableSha', 'invalidEnvironment', 'invalidImage', 'failedAttestation', 'missingAttestation']) {
  test(`publisher refuses existing immutable ${reason}`, async () => {
    const fixture = await publishingFixture({existing:true, [reason]:true});
    try {
      assert.throws(fixture.publish, reason.includes('Attestation') ? /PROMOTE_GATES/ : /PROMOTE_ARTIFACT|PROMOTE_ENVIRONMENT/);
      assert.equal(fixture.calls.some(call => call[0] === 'flux' && ['push', 'tag'].includes(call[1])), false);
    } finally { rmSync(fixture.directory, {recursive:true, force:true}); }
  });
}

for (const [existing, current] of [[false, null], [false, previous], [true, previous]]) test(`publisher ${existing ? 'reuses' : 'creates'} immutable artifact for ${current ? 'existing' : 'first'} channel`, async () => {
  const fixture = await publishingFixture({existing, current});
  try {
    const ref = fixture.publish();
    assert.equal(ref, `${fixture.deploy}@${fixture.digests.artifact}`);
    const calls = fixture.calls;
    const push = calls.find(call => call[0] === 'flux' && call[1] === 'push');
    assert.equal(Boolean(push), !existing);
    if (push) {
      assert.equal(push[3], `oci://${fixture.deploy}:production-${sha}`);
      const output = push.find(arg => arg.startsWith('--path=')).slice(7);
      assert.deepEqual(readdirSync(output).sort(), ['image-sbom.json', 'revision.json']);
      assert.deepEqual(JSON.parse(readFileSync(join(output, 'revision.json'))), {
        revision:sha, image:`ghcr.io/${repository}/console@sha256:${'a'.repeat(64)}`, environment:'production',
      });
      const signing = calls.findIndex(call => call[1] === 'sign');
      assert.ok(calls.findIndex(call => call[1] === 'attest') > signing);
      assert.ok(calls.slice(0, signing).some(call => call[1] === 'verify' && call.at(-1) === ref));
    }
    assert.ok(calls.some(call => call[1] === 'verify' && call.at(-1) === ref && call.some(arg => arg.includes('platform.yml'))));
    assert.ok(calls.some(call => call[1] === 'verify-attestation' && call.includes(ref)));
    assert.deepEqual(calls.at(-1), ['flux', 'tag', 'artifact', `oci://${ref}`, '--tag=production']);
  } finally { rmSync(fixture.directory, {recursive:true, force:true}); }
});

for (const reason of ['invalidEnvironment', 'unsignedCurrent']) test(`publisher refuses current channel ${reason}`, async () => {
  const fixture = await publishingFixture({current:previous, [reason]:true});
  try {
    assert.throws(fixture.publish, reason === 'invalidEnvironment' ? /PROMOTE_ENVIRONMENT/ : /no signatures found/);
    assert.equal(fixture.calls.some(call => call[0] === 'flux' && ['push', 'tag'].includes(call[1])), false);
  } finally { rmSync(fixture.directory, {recursive:true, force:true}); }
});

test('promotion workflow binds reusable gates, proof, permissions and channel serialization', async () => {
  const {load} = await import('js-yaml');
  const workflow = load(readFileSync(join(root, '.github/workflows/promote.yml'), 'utf8'));
  assert.deepEqual(workflow.on.workflow_run, {workflows:['platform'], types:['completed']});
  assert.equal(workflow.jobs.gates.uses, './.github/workflows/gates.yml');
  assert.equal(workflow.jobs.gates.with.sha, '${{ needs.proof.outputs.sha }}');
  assert.deepEqual(workflow.jobs.publish.needs, ['proof', 'gates']);
  assert.match(workflow.jobs.publish.if, /needs.gates.outputs.result == 'pass'/);
  assert.match(workflow.jobs.publish.concurrency.group, /matrix.channel/);
  assert.equal(workflow.jobs.publish.concurrency['cancel-in-progress'], false);
  const permissions = workflow.jobs.publish.permissions;
  assert.equal(permissions['id-token'], 'write');
  assert.equal(permissions.packages, 'write');
  assert.equal(permissions.actions, 'read');
  assert.equal(permissions.attestations, 'write');
  assert.match(workflow.jobs.proof.if, /workflow_run.head_repository.full_name == github.repository/);
  assert.match(workflow.jobs.proof.if, /workflow_run.event == 'push'/);
  assert.match(workflow.jobs.proof.if, /workflow_run.head_branch == 'dev'/);
  const source = readFileSync(join(root, '.github/workflows/promote.yml'), 'utf8');
  assert.doesNotMatch(source, /secrets\.|kubeconfig|aws-actions|azure\/|google-github-actions/i);
  assert.match(source, /fetch-depth: 0/);
  assert.match(source, /publishEnvironment/);
});
