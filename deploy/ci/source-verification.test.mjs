// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(process.env.PLATFORM_REPO_ROOT ?? '.');
const script = readFileSync(join(root, 'deploy/ci/exit-test.sh'), 'utf8');
const gate = script.slice(script.indexOf('# Source gate:'), script.indexOf('# Drift control:'));
const condition = (type, status, reason, observedGeneration = 1) => ({type, status, reason, observedGeneration});
const refused = [condition('Ready', 'False', 'VerificationError'), condition('SourceVerified', 'False', 'VerificationError')];

function check(states, failure = '') {
  const dir = mkdtempSync(join(tmpdir(), 'platform-source-verification-'));
  try {
    mkdirSync(join(dir, '.tmp/evidence'), {recursive:true});
    writeFileSync(join(dir, 'states.json'), JSON.stringify(states));
    writeFileSync(join(dir, 'calls'), '');
    writeFileSync(join(dir, 'cosign'), `#!/usr/bin/env bash
printf '[{"critical":{"image":{"docker-manifest-digest":"sha256:fixture"}}}]'
`, {mode:0o755});
    writeFileSync(join(dir, 'flux'), '#!/usr/bin/env bash\nexit 1\n', {mode:0o755});
    writeFileSync(join(dir, 'kubectl'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('calls', JSON.stringify(args)+'\\n');
const states = JSON.parse(fs.readFileSync('states.json', 'utf8'));
if (args[0] === 'apply') { fs.readFileSync(0); process.exit(); }
if (args.includes('console-deploy')) {
  console.log(JSON.stringify({metadata:{generation:1},spec:{verify:{provider:'cosign'}}})); process.exit();
}
if (args[0] === 'wait') {
  if (!args.includes('--for=condition=Ready=False') || !args.includes('--timeout=120s') ||
      !args.includes('ocirepository/wrong-workflow') || args[args.indexOf('-n')+1] !== 'flux-system') process.exit(24);
  if (process.env.FIXTURE_FAILURE === 'wait') process.exit(23);
  // Model kubectl wait: absent/Unknown/True conditions cannot satisfy Ready=False.
  for (let index = 0; index < states.length; index++) {
    fs.writeFileSync('index', String(index));
    if (states[index]?.some(c => c.type === 'Ready' && c.status === 'False')) process.exit();
  }
  console.error('timed out waiting for the condition'); process.exit(1);
}
if (process.env.FIXTURE_FAILURE === 'get') process.exit(22);
const index = fs.existsSync('index') ? Number(fs.readFileSync('index', 'utf8')) : 0;
console.log(JSON.stringify({metadata:{generation:1},status:{conditions:states[index]}}));
`, {mode:0o755});
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', gate], {cwd:dir,encoding:'utf8',timeout:5000,env:{
      ...process.env, PATH:`${dir}:${process.env.PATH}`, FIXTURE_FAILURE:failure,
      PLATFORM_WORKFLOW_IDENTITY:'https://github.com/example/console/.github/workflows/platform.yml@refs/heads/dev',
      issuer:'https://token.actions.githubusercontent.com', repository:'ghcr.io/example/console/console-deploy',
      wrong:'oci://ghcr.io/example/console/console-deploy@sha256:fixture',
    }});
    return {...result, calls:readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map(JSON.parse)};
  } finally { rmSync(dir, {recursive:true,force:true}); }
}

test('source gate accepts the controller signature refusal after pending and Unknown states', () => {
  const result = check([null, [], [condition('Ready', 'Unknown', 'Progressing')], refused]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const wait = result.calls.findIndex(args => args[0] === 'wait');
  const get = result.calls.findIndex(args => args[0] === 'get' && args.includes('wrong-workflow'));
  assert.ok(wait >= 0 && get > wait, 'wait for Ready=False before inspecting the verification outcome');
});

test('source gate accepts an already reconciled signature refusal', () => {
  const result = check([refused]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const [name, conditions] of [
  ['unobserved source', null],
  ['absent Ready condition', []],
  ['Unknown readiness', [condition('Ready', 'Unknown', 'Progressing')]],
  ['accepted source', [condition('Ready', 'True', 'Succeeded')]],
  ['authentication failure', [condition('Ready', 'False', 'AuthenticationFailed')]],
  ['registry failure', [condition('Ready', 'False', 'OCIPullFailed')]],
  ['incorrect verification reason', [condition('Ready', 'False', 'SourceVerificationFailed')]],
  ['missing verification condition', [refused[0]]],
  ['unfinished verification', [refused[0], condition('SourceVerified', 'Unknown', 'Progressing')]],
  ['stale refusal', refused.map(c => ({...c, observedGeneration:0}))],
]) test(`source gate refuses to count ${name} as a signature refusal`, () => {
  const result = check([conditions]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PLAT_ARTIFACT_IDENTITY:/);
});

for (const failure of ['wait', 'get']) test(`source gate fails closed on kubectl ${failure} failure`, () => {
  const result = check([refused], failure);
  assert.notEqual(result.status, 0);
});
