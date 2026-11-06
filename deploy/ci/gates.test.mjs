// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildPredicate, classifyBake } from './gates.mjs';
import admission from '../../.github/release-admission.cjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
const collector = await import(pathToFileURL(resolve(process.env.PLATFORM_REPO_ROOT ?? '.', 'deploy/ci/gates.mjs')));
const root = resolve(process.env.PLATFORM_REPO_ROOT ?? '.');
const gatesPolicy = JSON.parse(readFileSync(resolve(root, 'deploy/gates.json'), 'utf8'));

for (const [gate, definitions] of Object.entries(gatesPolicy.checks)) {
  for (const definition of definitions) test(`${gate}: configured evidence resolves once in the workflow`, () => {
    const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows', definition.workflow), 'utf8'));
    const jobs = Object.entries(workflow.jobs).flatMap(([id, job]) => {
      const rows = job.strategy?.matrix?.include;
      const names = rows ? rows.map(row => job.name
        ? job.name.replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_, axis) => row[axis])
        : `${id} (${Object.values(row).join(', ')})`) : [job.name ?? id];
      return names.filter(name => name === definition.job).map(() => job);
    });
    assert.equal(jobs.length, 1, `${definition.workflow}: ${definition.job}`);
    if (definition.step) assert.equal(jobs[0].steps.filter(step => step?.name === definition.step).length, 1, definition.step);
  });
}

test('native smoke keeps the default matrix names required by promotion', () => {
  const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows/platform.yml'), 'utf8'));
  assert.equal(workflow.jobs.build.name, undefined);
});

const sha = 'a'.repeat(40);
const predicateType = 'https://cosskorea.com/attestations/console-gates/v1';
const digest = 'b'.repeat(64);
const required = ['code-gates', 'api-compat', 'sbom', 'scan', 'smoke'];
const runUrl = 'https://github.com/oyatie/console-next/actions/runs/42';
// Path policy belongs to release configuration; these are classifier fixtures.
const longBakePaths = ['apps/web/src/shell/**', 'apps/web/src/features/auth/**', 'backend/crates/platform/auth/**'];

function fixture() {
  let id = 0;
  return {
    sha, runUrl, changedPaths: ['deploy/README.md'], longBakePaths,
    gateChecks: Object.fromEntries(required.map(name => [name,
      Array.from({length:name === 'smoke' ? 2 : 1}, () => ({
        id:++id, head_sha:sha, app:{id:15368}, status:'completed', conclusion:'success',
      })),
    ])),
  };
}

function hostAccepts(predicate, overrides = {}) {
  const statement = {
    _type:'https://in-toto.io/Statement/v1', predicateType,
    subject:[{name:'fixture/console-deploy', digest:{sha256:digest}}], predicate,
    ...overrides,
  };
  // Fixture copy of console-infra host/agent/oci.sh's OCI_GATES rule.
  const rule = `
    [ .[] | (if type == "array" then .[] else . end) | .payload | @base64d | fromjson
      | select(.predicateType == $t and any(.subject[]; .digest.sha256 == $d)) ]
    | select(length > 0 and all(.[];
        (.predicate.gates | type == "array" and length > 0)
        and all(.predicate.gates[]; .result == "pass")
        and (.predicate.gates | map(.name) as $names | all($required | split(" ")[]; IN($names[])))))
    | last`;
  const result = spawnSync('jq', ['-es', '--arg', 'd', digest, '--arg', 't', predicateType,
    '--arg', 'required', required.join(' '), rule], {
    encoding:'utf8', input:JSON.stringify({payload:Buffer.from(JSON.stringify(statement)).toString('base64')}),
  });
  assert.notEqual(result.status, null, result.error?.message);
  assert.notEqual(result.status, 3, result.stderr);
  return result.status === 0;
}

test('all green produces the host predicate shape and passes the actual jq rule', () => {
  const {result, predicate} = buildPredicate(fixture());
  assert.equal(result, 'pass');
  assert.deepEqual(predicate, {
    inputs:{backend:sha, web:sha},
    gates:required.map(name => ({name, result:'pass'})),
    runner:{kind:'gha', url:runUrl}, approver:null, bake:'normal',
  });
  assert.ok(hostAccepts(predicate));
  assert.equal(hostAccepts(predicate, {predicateType:'https://example.invalid/other'}), false);
  assert.equal(hostAccepts(predicate, {subject:[{digest:{sha256:'c'.repeat(64)}}]}), false);
});

for (const name of required) {
  for (const [reason, change] of [
    ['missing', input => { delete input.gateChecks[name]; }],
    ['empty', input => { input.gateChecks[name] = []; }],
    ['failure', input => { input.gateChecks[name][0].conclusion = 'failure'; }],
    ['skipped', input => { input.gateChecks[name][0].conclusion = 'skipped'; }],
    ['cancelled', input => { input.gateChecks[name][0].conclusion = 'cancelled'; }],
    ['neutral', input => { input.gateChecks[name][0].conclusion = 'neutral'; }],
    ['pending', input => { input.gateChecks[name][0].status = 'in_progress'; }],
    ['wrong SHA', input => { input.gateChecks[name][0].head_sha = 'c'.repeat(40); }],
    ['wrong app', input => { input.gateChecks[name][0].app.id = 1; }],
    ['missing ID', input => { delete input.gateChecks[name][0].id; }],
  ]) test(`${name}: ${reason} evidence is recorded as fail and refused by the host`, () => {
    const input = fixture();
    change(input);
    const {result, predicate} = buildPredicate(input);
    assert.equal(result, 'fail');
    assert.equal(predicate.gates.find(gate => gate.name === name).result, 'fail');
    assert.equal(predicate.gates.filter(gate => gate.result === 'fail').length, 1);
    assert.equal(hostAccepts(predicate), false);
  });
}

for (const [reason, change] of [
  ['one architecture', input => { input.gateChecks.smoke.pop(); }],
  ['duplicate architecture evidence', input => { input.gateChecks.smoke[1] = input.gateChecks.smoke[0]; }],
  ['ambiguous extra check', input => { input.gateChecks.scan.push(input.gateChecks.sbom[0]); }],
]) test(`refuses ${reason}`, () => {
  const input = fixture();
  change(input);
  assert.equal(buildPredicate(input).result, 'fail');
});

for (const changedPaths of [
  ['apps/web/src/shell/header.tsx'], ['apps/web/src/features/auth/ui/login.tsx'],
  ['backend/crates/platform/auth/src/session.rs'],
  ['deploy/README.md', 'apps/web/src/features/auth/ui/login.tsx'],
]) test(`derives long bake for ${changedPaths.join(', ')}`, () => {
  const input = {...fixture(), changedPaths};
  assert.equal(classifyBake(changedPaths, longBakePaths), 'long');
  assert.equal(buildPredicate(input).predicate.bake, 'long');
});

test('ordinary changes and a known empty change set have normal bake', () => {
  for (const paths of [[], ['apps/web/src/features/people/ui/list.tsx'], ['docs/auth.md']]) {
    assert.equal(classifyBake(paths, longBakePaths), 'normal');
  }
});

for (const [reason, change] of [
  ['missing change set', input => { delete input.changedPaths; }],
  ['missing path policy', input => { delete input.longBakePaths; }],
  ['empty path policy', input => { input.longBakePaths = []; }],
  ['invalid SHA', input => { input.sha = 'a'.repeat(12); }],
  ['zero SHA', input => { input.sha = '0'.repeat(40); }],
  ['wrong repository URL', input => { input.runUrl = 'https://github.com/other/repo/actions/runs/42'; }],
]) test(`refuses ${reason} instead of inventing evidence`, () => {
  const input = fixture();
  change(input);
  assert.throws(() => buildPredicate(input));
});

test('shared check reader paginates every check for the requested SHA', async () => {
  const checks = [{id:1}, {id:2}];
  const github = {paginate:async (route, params) => {
    assert.equal(route, 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs');
    assert.deepEqual(params, {owner:'oyatie', repo:'console-next', ref:sha, filter:'all', per_page:100});
    return checks;
  }};
  assert.deepEqual(await admission.readCheckRuns(github, sha), checks);
});

test('shared check reader propagates API failure', async () => {
  const github = {paginate:async () => { throw new Error('fixture API failure'); }};
  await assert.rejects(admission.readCheckRuns(github, sha), /fixture API failure/);
});

function ciFixture() {
  let id = 100;
  const definitions = {
    'ci.yml': [['backend-gates', 'Backend code gates (release parity)']],
    'api-compat.yml': [['api-compat']],
    'platform.yml': [['publish', 'SPDX SBOM'], ['scan'], ['build (amd64, ubuntu-24.04)', 'Test native image'], ['build (arm64, ubuntu-24.04-arm)', 'Test native image']],
  };
  const runs = Object.fromEntries(Object.keys(definitions).map((file, index) => [file, {
    id:index + 1, head_sha:sha, event:'push', head_branch:'dev', path:`.github/workflows/${file}`,
    run_attempt:2, check_suite_id:index + 10,
  }]));
  const jobs = Object.fromEntries(Object.entries(definitions).map(([file, entries]) => [runs[file].id, entries.map(([name, step]) => ({
    id:++id, name, head_sha:sha, status:'completed', conclusion:'success',
    check_run_url:`https://api.github.com/repos/oyatie/console-next/check-runs/${id}`,
    steps:step ? [{name:step, status:'completed', conclusion:'success'}] : [],
  }))]));
  const checks = Object.entries(jobs).flatMap(([runId, rows]) => rows.map(job => ({
    ...job, app:{id:15368}, check_suite:{id:Number(runId) + 9},
  })));
  const github = {paginate:async (route, params) => {
    if (route.endsWith('/check-runs')) return checks;
    if (route.endsWith('/runs')) {
      assert.equal(params.head_sha, sha);
      assert.equal(params.event, 'push');
      assert.equal(params.branch, 'dev');
      return [runs[params.workflow_id]];
    }
    assert.ok(route.endsWith('/attempts/{attempt_number}/jobs'));
    assert.equal(params.attempt_number, 2);
    return jobs[params.run_id];
  }};
  return {github, runs, jobs, checks};
}

test('CI collector binds every gate to the latest push attempt and passes the host', async () => {
  const {github} = ciFixture();
  const gateChecks = await collector.collectChecks(github, sha);
  assert.ok(hostAccepts(buildPredicate({...fixture(), gateChecks}).predicate));
});

for (const latestFirst of [false, true]) test(`CI collector selects the latest push with latestFirst=${latestFirst}`, async () => {
  const {github, runs} = ciFixture();
  const original = github.paginate;
  github.paginate = async (route, params) => {
    if (!params.workflow_id) return original(route, params);
    const latest = runs[params.workflow_id];
    const older = {...latest, id:latest.id - 1, head_sha:'c'.repeat(40)};
    return latestFirst ? [latest, older] : [older, latest];
  };
  const gateChecks = await collector.collectChecks(github, sha);
  assert.equal(buildPredicate({...fixture(), gateChecks}).result, 'pass');
});

test('CI collector records a missing workflow as failed evidence and propagates API outages', async () => {
  const original = ciFixture().github;
  for (const status of [404, 503]) {
    const github = {paginate:async (route, params) => {
      if (params.workflow_id === 'api-compat.yml') throw Object.assign(new Error('API failure'), {status});
      return original.paginate(route, params);
    }};
    if (status === 404) assert.equal(buildPredicate({...fixture(), gateChecks:await collector.collectChecks(github, sha)}).result, 'fail');
    else await assert.rejects(collector.collectChecks(github, sha), /API failure/);
  }
});

for (const failed of [false, true]) test(`CI emits a reviewable ${failed ? 'failed' : 'passing'} predicate and derives bake from the full diff`, async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'emit-gates-'));
  const cwd = process.cwd();
  const path = process.env.PATH;
  try {
    writeFileSync(resolve(directory, 'git'), `#!/bin/sh
[ "$*" = "diff --no-renames --name-only -z ${'c'.repeat(40)}..${sha}" ] || exit 97
printf 'apps/web/src/features/auth/login.ts\\0docs/login.ts\\0'
`, {mode:0o755});
    process.chdir(directory);
    process.env.PATH = `${directory}:${path}`;
    const {github, checks} = ciFixture();
    if (failed) checks.splice(0, 1);
    const outputs = {};
    await collector.emit(github, {setOutput:(name, value) => { outputs[name] = value; }}, sha, 'c'.repeat(40), runUrl);
    assert.equal(outputs.result, failed ? 'fail' : 'pass');
    const predicate = JSON.parse(readFileSync('console-gates.json', 'utf8'));
    assert.equal(predicate.bake, 'long');
    assert.equal(hostAccepts(predicate), !failed);
  } finally {
    process.chdir(cwd);
    process.env.PATH = path;
    rmSync(directory, {recursive:true, force:true});
  }
});

for (const reason of ['missing', 'skipped', 'cancelled', 'failed step', 'duplicate step', 'wrong suite', 'wrong SHA', 'wrong event', 'wrong branch', 'wrong workflow', 'wrong job SHA', 'missing arch', 'duplicate job', 'old attempt']) {
  test(`CI collector fails closed for ${reason}`, async () => {
    const {github, runs, jobs, checks} = ciFixture();
    if (reason === 'missing') checks.splice(0, 1);
    if (reason === 'skipped') jobs[1][0].conclusion = 'skipped';
    if (reason === 'cancelled') jobs[1][0].status = 'in_progress';
    if (reason === 'failed step') jobs[1][0].steps[0].conclusion = 'failure';
    if (reason === 'duplicate step') jobs[1][0].steps.push({...jobs[1][0].steps[0]});
    if (reason === 'wrong suite') checks[0].check_suite.id = 999;
    if (reason === 'wrong SHA') runs['ci.yml'].head_sha = 'c'.repeat(40);
    if (reason === 'wrong event') runs['ci.yml'].event = 'pull_request';
    if (reason === 'wrong branch') runs['ci.yml'].head_branch = 'other';
    if (reason === 'wrong workflow') runs['ci.yml'].path = '.github/workflows/other.yml';
    if (reason === 'wrong job SHA') jobs[1][0].head_sha = 'c'.repeat(40);
    if (reason === 'missing arch') jobs[3].pop();
    if (reason === 'duplicate job') jobs[1].push(jobs[1][0]);
    if (reason === 'old attempt') jobs[1][0].check_run_url += '0';
    const gateChecks = await collector.collectChecks(github, sha);
    assert.equal(buildPredicate({...fixture(), gateChecks}).result, 'fail');
  });
}

for (const [reason, override, expected] of [
  ['green', {}, 0], ['fixable vulnerability', {SCAN_EXIT:'5'}, 5],
  ['invalid signature', {VERIFY_EXIT:'1'}, 1], ['wrong digest', {SBOM_DIGEST:'c'.repeat(64)}, 5],
]) test(`published SBOM scan propagates ${reason}`, () => {
  const root = resolve(process.env.PLATFORM_REPO_ROOT ?? '.');
  const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows/platform.yml'), 'utf8'));
  const script = workflow.jobs.scan.steps.find(step => step.name === "Scan the image's verified SPDX attestation").run;
  const directory = mkdtempSync(resolve(tmpdir(), 'scan-gate-'));
  try {
    for (const [bin, script] of Object.entries({
      docker:'#!/bin/sh\ncat >/dev/null\n',
      cosign:`#!/bin/sh\n[ "\${VERIFY_EXIT:-0}" = 0 ] || exit "$VERIFY_EXIT"\nprintf '%s' "$SBOM_RECORD"\n`,
      grype:`#!/bin/sh\n[ "$*" = "sbom:$RUNNER_TEMP/image-sbom.json --only-fixed --fail-on high" ] || exit 97\nexit "\${SCAN_EXIT:-0}"\n`,
    })) writeFileSync(resolve(directory, bin), script, {mode:0o755});
    const statement = {subject:[{digest:{sha256:override.SBOM_DIGEST ?? digest}}], predicate:{spdxVersion:'SPDX-2.3'}};
    const record = {payload:Buffer.from(JSON.stringify(statement)).toString('base64')};
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], {encoding:'utf8', env:{...process.env,
      PATH:`${directory}:${process.env.PATH}`, RUNNER_TEMP:directory, IMAGE:`ghcr.io/fixture@sha256:${digest}`,
      REGISTRY_TOKEN:'fixture', GITHUB_ACTOR:'fixture', GITHUB_SERVER_URL:'https://github.com', GITHUB_REPOSITORY:'oyatie/console-next',
      SBOM_RECORD:JSON.stringify(record), ...override,
    }});
    assert.equal(result.status, expected, result.stdout + result.stderr);
  } finally { rmSync(directory, {recursive:true, force:true}); }
});
