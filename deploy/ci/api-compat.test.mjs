// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
const root = resolve(process.env.PLATFORM_REPO_ROOT ?? '.');
const api = await import(pathToFileURL(join(root, 'deploy/ci/api-compat.mjs')));
const binary = {skip:spawnSync('oasdiff', ['--version']).status !== 0 && 'Pinned binary is installed by the api-compat workflow'};

test('normalization preserves strict commands, scalar types and removed extensible values', () => {
  const base = {shared:{enum:['a', 'b', 1]}, command:{enum:['a']}, items:[{enum:['a', 'b']}]};
  const candidate = {shared:{'x-extensible-enum':['a', 1]}, command:{enum:['a']}, items:[{'x-extensible-enum':['a']}]};
  api.normalize(base, candidate);
  assert.deepEqual(base, {shared:{'x-extensible-enum':['a', 'b', 1]}, command:{enum:['a']}, items:[{'x-extensible-enum':['a', 'b']}]});
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
test('real committed tip contract passes unchanged', binary, () => {
  const spec = readFileSync(join(root, 'backend/openapi/openapi.yaml'), 'utf8');
  const result = spawnSync(process.execPath, [join(root, 'deploy/ci/api-compat.mjs'), 'compare', '-', '-'], {encoding:'utf8', input:spec});
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

function releaseFixture(change = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'released-api-'));
  const revision = 'a'.repeat(40);
  const image = `ghcr.io/oyatie/console-next/console@sha256:${'b'.repeat(64)}`;
  const state = {production:{revision}, absent:false, previous:{previousImage:image, image:image.replace(/b/g, 'c')},
    statement:{subject:[{digest:{sha256:'b'.repeat(64)}}], predicate:{buildDefinition:{resolvedDependencies:[{
      uri:'git+https://github.com/oyatie/console-next@refs/heads/dev', digest:{gitCommit:revision},
    }]}}}, calls:[]};
  change(state);
  const execute = (bin, args) => {
    state.calls.push([bin, ...args]);
    if (bin === 'cosign') return JSON.stringify([{payload:Buffer.from(JSON.stringify(state.statement)).toString('base64')}]);
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
  assert.equal(fallback.calls.length, 3);
  assert.ok(fallback.calls[2].includes('--certificate-identity=https://github.com/oyatie/console-next/.github/workflows/platform.yml@refs/heads/dev'));
});
for (const [reason, change] of [
  ['registry authentication', state => { state.absent = 'unauthorized'; }],
  ['registry network', state => { state.absent = 'timeout'; }],
  ['missing production revision', state => { state.production = {}; }],
  ['invalid production revision', state => { state.production.revision = 'a'.repeat(12); }],
  ['zero production revision', state => { state.production.revision = '0'.repeat(40); }],
  ['missing N-1', state => { state.absent = true; delete state.previous.previousImage; }],
  ['identical N-1', state => { state.absent = true; state.previous.image = state.previous.previousImage; }],
  ['foreign N-1', state => { state.absent = true; state.previous.previousImage = state.previous.previousImage.replace('oyatie', 'other'); }],
  ['wrong subject', state => { state.absent = true; state.statement.subject[0].digest.sha256 = 'c'.repeat(64); }],
  ['foreign source', state => { state.absent = true; state.statement.predicate.buildDefinition.resolvedDependencies[0].uri += '-other'; }],
  ['ambiguous source', state => { state.absent = true; state.statement.predicate.buildDefinition.resolvedDependencies.push({uri:'git+https://github.com/oyatie/console-next@refs/heads/dev', digest:{gitCommit:'c'.repeat(40)}}); }],
]) test(`released base refuses ${reason}`, () => assert.throws(() => releaseFixture(change)));
