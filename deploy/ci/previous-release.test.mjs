// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import yaml from 'js-yaml';

const root = resolve(process.env.PLATFORM_REPO_ROOT ?? '.');
const workflow = yaml.load(readFileSync(join(root, '.github/workflows/platform.yml'), 'utf8'));
const repository = 'ghcr.io/example/console/console';
const deploy = `${repository}-deploy`;
const digest = letter => `sha256:${letter.repeat(64)}`;
const image = letter => `${repository}@${digest(letter)}`;
const history = [
  {id:1, name:digest('c'), created_at:'2026-10-24T00:00:00Z', image:image('c')},
  {id:4, name:digest('d'), created_at:'2026-10-27T00:00:00Z'}, // Signature, not a deploy artifact.
  {id:5, name:digest('e'), created_at:'2026-10-28T00:00:00Z', image:image('a')},
  {id:3, name:digest('a'), created_at:'2026-10-26T00:00:00Z', image:image('a')},
  {id:2, name:digest('b'), created_at:'2026-10-25T00:00:00Z', image:image('b')},
];

function publish(previous, versions = history, failure = '') {
  const dir = mkdtempSync(join(tmpdir(), 'previous-release-'));
  try {
    mkdirSync(join(dir, '.tmp'), {recursive:true});
    mkdirSync(join(dir, 'deploy'), {recursive:true});
    symlinkSync(join(root, 'deploy/ci'), join(dir, 'deploy/ci'));
    writeFileSync(join(dir, '.tmp/previous-revision.json'), JSON.stringify(previous));
    writeFileSync(join(dir, '.tmp/sbom.json'), '{}');
    writeFileSync(join(dir, 'history.json'), JSON.stringify(versions));
    writeFileSync(join(dir, 'calls'), '');
    for (const command of ['gh', 'buildx', 'flux', 'cosign']) {
      writeFileSync(join(dir, command), `#!/usr/bin/env node
const fs = require('node:fs'), a = process.argv.slice(2), command = ${JSON.stringify(command)};
const history = JSON.parse(fs.readFileSync('history.json'));
fs.appendFileSync('calls', JSON.stringify([command, ...a])+'\\n');
if (process.env.FAILURE === command) { console.error('fixture '+command+' unavailable'); process.exit(17); }
if (command === 'gh') {
  if (!a.includes('--paginate') || !a.includes('--slurp')) process.exit(18);
  console.log(JSON.stringify([history.slice(0, 2), history.slice(2)]));
} else if (command === 'buildx') {
  if (a.includes('--raw')) {
    const version = history.find(v => a.includes(process.env.DEPLOY+'@'+v.name));
    if (!version) process.exit(19);
    console.log(JSON.stringify({annotations:version.image ? {'org.opencontainers.image.revision':'e'.repeat(40)} : {}}));
  } else console.log(JSON.stringify({digest:${JSON.stringify(digest('a'))}}));
} else if (command === 'flux') {
  if (a[0] === 'pull') {
    const version = history.find(v => a.includes('oci://'+process.env.DEPLOY+'@'+v.name));
    if (!version?.image) process.exit(20);
    const output = a.find(v => v.startsWith('--output=')).slice('--output='.length);
    fs.writeFileSync(output+'/revision.json', JSON.stringify({image:version.image}));
  } else console.log(JSON.stringify({digest:${JSON.stringify(digest('f'))}}));
}
`, {mode:0o755});
    }
    writeFileSync(join(dir, 'publish.sh'), `
node() {
  if [[ "$1" == deploy/ci/render.mjs ]]; then
    mkdir -p .tmp/bundle
    printf '%s' "$REVISION" > .tmp/bundle/revision.json
  else command node "$@"; fi
}
bash() { [[ "$1" == deploy/ci/validate.sh ]]; }
${workflow.jobs.publish.steps.find(step => step.id === 'artifact').run}`);
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', 'publish.sh'], {
      cwd:dir, encoding:'utf8', env:{...process.env, PATH:`${dir}:${process.env.PATH}`, FAILURE:failure,
        REVISION:JSON.stringify({image:image('a'), revision:'e'.repeat(40), environment:'exit-test'}),
        IMAGE:repository, IMAGE_DIGEST:digest('a'), DEPLOY:deploy, GITHUB_REPOSITORY:'example/console',
        PLATFORM_WORKFLOW_IDENTITY:'https://github.com/example/console/.github/workflows/platform.yml@refs/heads/dev',
        GITHUB_SHA:'e'.repeat(40), GITHUB_SERVER_URL:'https://github.com', GITHUB_OUTPUT:join(dir, 'output')},
    });
    return {...result, revision:JSON.parse(readFileSync(join(dir, '.tmp/bundle/revision.json'))),
      calls:readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))};
  } finally { rmSync(dir, {recursive:true,force:true}); }
}

test('deploy-only push recovers the newest distinct image from paginated published history, skipping identical digests', () => {
  const result = publish({image:image('a'), previousImage:image('a')});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.revision.previousImage, image('b'));
  assert.ok(result.calls.some(call => call[0] === 'gh'));
  assert.ok(!result.calls.some(call => call[0] === 'flux' && call.includes(`oci://${deploy}@${digest('c')}`)), 'stop at the newest distinct release');
  const verification = result.calls.find(call => call[0] === 'cosign' && call[1] === 'verify');
  assert.ok(verification.includes(image('b')));
  assert.ok(verification.includes('--certificate-identity=https://github.com/example/console/.github/workflows/platform.yml@refs/heads/dev'));
  assert.ok(verification.includes('--certificate-oidc-issuer=https://token.actions.githubusercontent.com'));
});

test('repeated deploy-only pushes carry the last distinct N-1 without rescanning history', () => {
  const result = publish({image:image('a'), previousImage:image('b')});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.revision.previousImage, image('b'));
  assert.ok(!result.calls.some(call => call[0] === 'gh'));
});

test('a new image uses the immediately preceding distinct release', () => {
  const result = publish({image:image('b'), previousImage:image('c')});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.revision.previousImage, image('b'));
});

for (const [name, previous, versions] of [
  ['first publish', {}, []],
  ['only identical images have ever been published', {image:image('a')}, history.filter(v => v.image === image('a') || !v.image)],
]) test(`${name} records no distinct previous image`, () => {
  const result = publish(previous, versions);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.revision.previousImage, null);
});

for (const failure of ['gh', 'buildx', 'flux', 'cosign']) test(`history ${failure} failure cannot silently become a first-publish skip or publish an artifact`, () => {
  const result = publish({image:image('a'), previousImage:image('a')}, history, failure);
  assert.notEqual(result.status, 0, result.stderr);
  assert.ok(!result.calls.some(call => call[0] === 'flux' && call[1] === 'push'));
});

for (const invalid of ['example.invalid/console:latest', `${image('b')}@extra`, image('b').replace(repository, 'ghcr.io/other/console')]) {
  test('PLAT_PREVIOUS_RELEASE: refuses invalid recorded references before publication', () => {
    const result = publish({image:invalid});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PLAT_PREVIOUS_RELEASE/);
    assert.ok(!result.calls.some(call => call[0] === 'flux' && call[1] === 'push'));
  });
}

test('PLAT_PREVIOUS_RELEASE: refuses malformed registry history before publication', () => {
  const result = publish({image:image('a')}, [{id:1, name:'not-a-digest', created_at:'not-a-date'}]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PLAT_PREVIOUS_RELEASE/);
  assert.ok(!result.calls.some(call => call[0] === 'flux' && call[1] === 'push'));
});
