// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
const root = resolve(process.env.PLATFORM_REPO_ROOT ?? '.');
const api = await import(pathToFileURL(join(root, 'deploy/ci/api-compat.mjs')));
const binary = {skip:spawnSync('oasdiff', ['--version']).status !== 0 && 'Pinned binary is installed by the api-compat workflow'};

test('normalization preserves strict commands, scalar types and removed extensible values', () => {
  const base = {shared:{enum:['a', 'b', 1]}, command:{enum:['a']}, items:[{enum:['a', 'b']}]};
  const candidate = {shared:{'x-extensible-enum':['a', 1]}, command:{enum:['a']}, items:[{'x-extensible-enum':['a']}]};
  api.normalize(base, candidate);
  assert.deepEqual(base, {shared:{'x-extensible-enum':['a', 'b', 1]}, command:{enum:['a']}, items:[{'x-extensible-enum':['a', 'b']}]});
});
test('normalization preserves strict enums when an extensible hint is also present', () => {
  const base = {enum:['a', 'b']};
  api.normalize(base, {enum:['a'], 'x-extensible-enum':['a', 'b']});
  assert.deepEqual(base, {enum:['a', 'b']});
});

const spec = (values, extensible = false) => ({openapi:'3.0.3', info:{title:'fixture', version:'1'}, paths:{
  '/kept':{get:{parameters:[{in:'query', name:'value', schema:{$ref:'#/components/schemas/Value'}}],
    responses:{200:{description:'ok', content:{'application/json':{schema:{$ref:'#/components/schemas/Value'}}}}}}},
}, components:{schemas:{Value:{type:'string', [extensible ? 'x-extensible-enum' : 'enum']:values}}},
});
function compare(base, candidate) {
  const dir = mkdtempSync(join(tmpdir(), 'api-compat-'));
  try {
    for (const [file, value] of [['base', base], ['candidate', candidate]]) writeFileSync(join(dir, `${file}.json`), JSON.stringify(value));
    return spawnSync(process.execPath, [join(root, 'deploy/ci/api-compat.mjs'), 'compare', join(dir, 'base.json'), join(dir, 'candidate.json')], {encoding:'utf8'});
  } finally { rmSync(dir, {recursive:true, force:true}); }
}
test('pinned oasdiff passes additions and rejects a removed path', binary, () => {
  assert.equal(compare(spec(['a']), spec(['a', 'b'])).status, 0);
  const removed = {...spec(['a']), paths:{}};
  assert.notEqual(compare(spec(['a']), removed).status, 0);
});
test('pinned oasdiff permits extensible additions but refuses removed values', binary, () => {
  assert.equal(compare(spec(['a', 'b']), spec(['a', 'b', 'c'], true)).status, 0);
  assert.notEqual(compare(spec(['a', 'b']), spec(['a'], true)).status, 0);
});
const released = yaml.load(readFileSync(new URL('./fixtures/released-office-callback.yaml', import.meta.url), 'utf8'));
const candidate = yaml.load(readFileSync(join(root, 'backend/openapi/openapi.yaml'), 'utf8'));
test('real committed tip contract passes against the released callback contract', binary, () => {
  const result = compare(released, candidate);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
const callbackPath = '/api/v1/office/callback';
const successSchema = doc => doc.paths[callbackPath].post.responses['200'].content['application/json'].schema;
const callbackCandidate = () => ({...structuredClone(released), paths:{[callbackPath]:structuredClone(candidate.paths[callbackPath])}});
for (const [name, mutate, finding] of [
  ['another enum value', (_base, tip) => { successSchema(tip).properties.error.enum = [0, 1]; }, 'response-property-enum-value-added'],
  ['another property', (base, tip) => {
    successSchema(base).properties.other = {type:'integer', minimum:0};
    successSchema(tip).properties.other = {type:'integer'};
  }, 'response-property-min-unset'],
  ['another endpoint', (base, tip) => {
    base.paths['/other'] = structuredClone(base.paths[callbackPath]);
    tip.paths['/other'] = structuredClone(tip.paths[callbackPath]);
  }, 'response-property-min-unset'],
  ['another response status', (base, tip) => {
    base.paths[callbackPath].post.responses['201'] = structuredClone(base.paths[callbackPath].post.responses['200']);
    tip.paths[callbackPath].post.responses['201'] = structuredClone(tip.paths[callbackPath].post.responses['200']);
  }, 'response-property-min-unset'],
  ['an unrelated removed path', (base) => { base.paths['/kept'] = {get:{responses:{200:{description:'ok'}}}}; }, 'api-path-removed-without-deprecation'],
]) test(`callback exception still refuses ${name}`, binary, () => {
  const base = structuredClone(released), tip = callbackCandidate();
  mutate(base, tip);
  const result = compare(base, tip);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(`[${finding}]`) || result.stderr.includes(`[${finding}]`), result.stdout + result.stderr);
});

function releaseFixture(change = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'released-api-'));
  const revision = 'a'.repeat(40);
  const image = `ghcr.io/oyatie/console-next/console@sha256:${'b'.repeat(64)}`;
  const state = {production:{revision}, absent:false, previous:{previousImage:image, image:image.replace(/b/g, 'c')},
    history:[revision], statement:{subject:[{digest:{sha256:'b'.repeat(64)}}], predicate:{buildDefinition:{resolvedDependencies:[{
      uri:'git+https://github.com/oyatie/console-next@refs/heads/dev', digest:{gitCommit:revision},
    }]}}}, calls:[]};
  change(state);
  const execute = (bin, args) => {
    state.calls.push([bin, ...args]);
    if (bin === 'cosign') {
      if (state.verificationError) throw new Error('signature verification failed');
      const envelopes = (state.statements ?? [state.statement]).map(statement => ({payload:Buffer.from(JSON.stringify(statement)).toString('base64')}));
      return state.ndjson ? envelopes.map(envelope => JSON.stringify(envelope)).join('\n') : JSON.stringify(envelopes);
    }
    if (bin === 'git') {
      assert.deepEqual(args, ['rev-list', '--first-parent', '--reverse', 'origin/dev']);
      return state.repository ? execFileSync(bin, ['-C', state.repository, ...args], {encoding:'utf8'}) : state.history.join('\n');
    }
    if (args[2].endsWith(':production')) {
      if (state.absent) throw Object.assign(new Error('registry'), {stderr:state.absent === true ? 'MANIFEST_UNKNOWN' : state.absent});
      writeFileSync(join(directory, 'revision.json'), JSON.stringify(state.production));
    } else writeFileSync(join(directory, 'revision.json'), JSON.stringify(state.previous));
    return '';
  };
  try { return {base:api.releasedBase('oyatie/console-next', directory, execute), calls:state.calls}; }
  finally { rmSync(directory, {recursive:true, force:true}); }
}
test('production revision wins and bootstrap uses a distinct verified N-1 source', () => {
  assert.equal(releaseFixture().calls.length, 1);
  const fallback = releaseFixture(state => { state.absent = true; });
  assert.equal(fallback.base, 'a'.repeat(40));
  assert.equal(fallback.calls.length, 4);
  assert.ok(fallback.calls[2].includes('--type=https://slsa.dev/provenance/v1'));
  assert.ok(fallback.calls[2].includes('--certificate-oidc-issuer=https://token.actions.githubusercontent.com'));
  assert.ok(fallback.calls[2].includes('--certificate-identity=https://github.com/oyatie/console-next/.github/workflows/platform.yml@refs/heads/dev'));
  assert.equal(fallback.calls[2].at(-1), `ghcr.io/oyatie/console-next/console@sha256:${'b'.repeat(64)}`);
});

test('re-attested N-1 selects the earliest dev first-parent revision regardless of statement order or commit dates', () => {
  const directory = mkdtempSync(join(tmpdir(), 'api-history-'));
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], {encoding:'utf8'}).trim();
  const commit = (date) => {
    execFileSync('git', ['-C', directory, '-c', 'user.name=Jason Lee', '-c', 'user.email=56489493+jason931225@users.noreply.github.com',
      'commit', '--quiet', '--allow-empty', '-m', 'test: provenance history'],
    {env:{...process.env, GIT_AUTHOR_DATE:date, GIT_COMMITTER_DATE:date}});
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '--quiet', '--initial-branch=dev');
    const earliest = commit('2025-02-02T00:00:00Z');
    const later = commit('2025-01-01T00:00:00Z');
    git('checkout', '--quiet', '-b', 'topic', earliest);
    const side = commit('2025-01-02T00:00:00Z');
    git('checkout', '--quiet', 'dev');
    git('-c', 'user.name=Jason Lee', '-c', 'user.email=56489493+jason931225@users.noreply.github.com',
      'merge', '--quiet', '--no-ff', 'topic', '-m', 'test: merge provenance history');
    git('update-ref', 'refs/remotes/origin/dev', 'HEAD');
    const fixture = (revisions, ndjson = false) => releaseFixture(state => {
      state.absent = true;
      state.repository = directory;
      state.ndjson = ndjson;
      state.statements = revisions.map(revision => {
        const statement = structuredClone(state.statement);
        statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = revision;
        return statement;
      });
    });
    for (const ndjson of [false, true]) for (const revisions of [[later, earliest], [earliest, later], [later, earliest, later]]) {
      assert.equal(fixture(revisions, ndjson).base, earliest);
    }
    assert.throws(() => fixture([side, later]), /dev first-parent history/);
  } finally { rmSync(directory, {recursive:true, force:true}); }
});
for (const [reason, change, error] of [
  ['registry authentication', state => { state.absent = 'unauthorized'; }],
  ['registry network', state => { state.absent = 'timeout'; }],
  ['missing production revision', state => { state.production = {}; }],
  ['invalid production revision', state => { state.production.revision = 'a'.repeat(12); }],
  ['zero production revision', state => { state.production.revision = '0'.repeat(40); }],
  ['missing N-1', state => { state.absent = true; delete state.previous.previousImage; }],
  ['identical N-1', state => { state.absent = true; state.previous.image = state.previous.previousImage; }],
  ['foreign N-1', state => { state.absent = true; state.previous.previousImage = state.previous.previousImage.replace('oyatie', 'other'); }],
  ['wrong subject', state => { state.absent = true; state.statement.subject[0].digest.sha256 = 'c'.repeat(64); }],
  ['no statements', state => { state.absent = true; state.statements = []; }, /N-1 image needs a verified source revision/],
  ['unverifiable statements', state => { state.absent = true; state.verificationError = true; }],
  ['foreign source', state => { state.absent = true; state.statement.predicate.buildDefinition.resolvedDependencies[0].uri += '-other'; }],
  ['source outside dev first-parent history', state => { state.absent = true; state.statement.predicate.buildDefinition.resolvedDependencies.push({uri:'git+https://github.com/oyatie/console-next@refs/heads/dev', digest:{gitCommit:'c'.repeat(40)}}); }],
  ['invalid attested revision', state => { state.absent = true; state.statement.predicate.buildDefinition.resolvedDependencies.push({uri:'git+https://github.com/oyatie/console-next@refs/heads/dev', digest:{gitCommit:'a'.repeat(12)}}); }, /dev first-parent history/],
]) test(`released base refuses ${reason}`, () => assert.throws(() => releaseFixture(change), error));
