// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(process.env.PLATFORM_REPO_ROOT ?? '.');

async function stack({meStatus = 403, meCode = 'passkey_required', consentStatus = 200, replayStatus = 401} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'platform-stack-'));
  const calls = [];
  let redemptions = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push({path:request.url, method:request.method, authorization:request.headers.authorization, body});
    let status = 200, result;
    switch (request.url) {
      case '/': response.end('<!doctype html><html lang="ko"></html>'); return;
      case '/healthz': result = {status:'ok', role:'api'}; break;
      case '/readyz': result = {status:'ready', ...Object.fromEntries(['database', 'leave_command_database', 'ontology_command_database', 'platform_force_command_database'].map(name => [name, 'ready']))}; break;
      case '/api/v1/dev-auth/session': status = 404; result = {}; break;
      case '/api/v1/auth/otp/redeem':
        assert.equal(JSON.parse(body).otp, 'fixture-coldstart-otp');
        status = redemptions++ === 0 ? 200 : replayStatus;
        result = status === 200 ? {access_token:'fixture-enrollment-token', requires_passkey_setup:true} : {error:{code:'unauthorized'}};
        break;
      case '/api/v1/auth/privacy-consent/status': status = consentStatus; result = {accepted:false}; break;
      case '/api/v1/users/me': status = meStatus; result = {error:{code:meCode}}; break;
      default: status = 404; result = {};
    }
    response.writeHead(status, {'content-type':'application/json'}).end(JSON.stringify(result));
  });
  try {
    writeFileSync(join(dir, 'kubectl'), '#!/usr/bin/env node\nprocess.stdout.write(Buffer.from("fixture-coldstart-otp").toString("base64"));\n', {mode:0o755});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const result = await new Promise((resolve, reject) => {
      const env = {
        ...process.env, PATH:`${dir}:${process.env.PATH}`, PLATFORM_TEST_URL:`http://127.0.0.1:${server.address().port}`,
      };
      delete env.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, ['--test', join(root, 'deploy/ci/stack.e2e.mjs')], {env, timeout:10000});
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      child.on('error', reject);
      child.on('close', status => resolve({status, output, calls}));
    });
    return result;
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, {recursive:true, force:true});
  }
}

test('stack accepts a cold-start enrollment session, checks its usable surface and refuses business access and replay', async () => {
  const result = await stack();
  assert.equal(result.status, 0, result.output);
  const consent = result.calls.find(call => call.path.endsWith('/privacy-consent/status'));
  assert.equal(consent?.method, 'POST');
  assert.equal(consent.authorization, 'Bearer fixture-enrollment-token');
  assert.equal(result.calls.find(call => call.path.endsWith('/users/me')).authorization, consent.authorization);
  assert.equal(result.calls.filter(call => call.path.endsWith('/otp/redeem')).length, 2);
});

for (const [name, options] of [
  ['business access from an enrollment token', {meStatus:200}],
  ['an unrelated forbidden response', {meCode:'forbidden'}],
  ['an unusable enrollment session', {consentStatus:401}],
  ['a replayed code being accepted', {replayStatus:200}],
]) test(`stack fails on ${name}`, async () => {
  const result = await stack(options);
  assert.notEqual(result.status, 0, result.output);
});

test('exit-test prints the failing HTTP assertion before cleanup diagnostics', () => {
  const script = readFileSync(join(root, 'deploy/ci/exit-test.sh'), 'utf8');
  const gate = script.slice(script.search(/^(?:if ! )?node --test deploy\/ci\/stack.e2e.mjs/m), script.indexOf('kill "${forward_pid}"'));
  const dir = mkdtempSync(join(tmpdir(), 'platform-stack-output-'));
  try {
    mkdirSync(join(dir, '.tmp/evidence'), {recursive:true});
    writeFileSync(join(dir, 'node'), '#!/usr/bin/env bash\necho "fixture HTTP assertion: 403 !== 200"\nexit 17\n', {mode:0o755});
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', gate], {cwd:dir, encoding:'utf8', env:{...process.env, PATH:`${dir}:${process.env.PATH}`}});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PLAT_STACK:/);
    assert.match(result.stderr, /fixture HTTP assertion: 403 !== 200/);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

for (const actual of ['1', '0']) test(`drift comparison records the observed count ${actual} and names a failed restore`, () => {
  const script = readFileSync(join(root, 'deploy/ci/exit-test.sh'), 'utf8');
  const gate = script.slice(script.indexOf('# Drift control:'), script.indexOf('# Real console HTTP contracts'));
  const dir = mkdtempSync(join(tmpdir(), 'platform-drift-output-'));
  try {
    mkdirSync(join(dir, '.tmp/evidence'), {recursive:true});
    writeFileSync(join(dir, 'flux'), '#!/usr/bin/env bash\nexit 0\n', {mode:0o755});
    writeFileSync(join(dir, 'kubectl'), `#!/usr/bin/env bash
if [[ "$1" == get ]]; then
  if [[ -f read-once ]]; then printf '%s' "$FIXTURE_REPLICAS"; else touch read-once; printf 1; fi
fi
`, {mode:0o755});
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', gate], {cwd:dir, encoding:'utf8', env:{...process.env, PATH:`${dir}:${process.env.PATH}`, FIXTURE_REPLICAS:actual}});
    assert.equal(result.status, actual === '1' ? 0 : 1);
    assert.equal(readFileSync(join(dir, '.tmp/evidence/drift.txt'), 'utf8'), `edited=0\nexpected=1\nreconciled=${actual}\n`);
    if (actual === '0') assert.match(result.stderr, /FLUX_DRIFT: console-worker expected=1 reconciled=0/);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
