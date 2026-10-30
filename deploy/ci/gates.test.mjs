// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildPredicate, classifyBake } from './gates.mjs';
import admission from '../../.github/release-admission.cjs';

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
