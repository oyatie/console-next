// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import yaml from 'js-yaml';

const root = resolve(process.env.PLATFORM_REPO_ROOT ?? '.');
const read = path => readFileSync(join(root, path), 'utf8');

test('exit-test receives only the workflow read token for private registry pulls', () => {
  const job = yaml.load(read('.github/workflows/platform.yml')).jobs['exit-test'];
  assert.equal(job.permissions.packages, 'read');
  const step = job.steps.find(s => s.run === 'bash deploy/ci/exit-test.sh');
  assert.equal(step.env.REGISTRY_TOKEN, '${{ secrets.GITHUB_TOKEN }}');
});

for (const status of [0, 37]) test(`exit-test authenticates the runner and cluster, then removes credentials on exit ${status}`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-registry-'));
  try {
    for (const folder of ['deploy/ci', 'deploy/source', 'runner', '.tmp/exit-bundle/platform', '.tmp/exit-bundle/namespace']) mkdirSync(join(dir, folder), {recursive:true});
    symlinkSync(resolve('node_modules'), join(dir, 'node_modules'));
    writeFileSync(join(dir, 'deploy/source/oci.yaml'), read('deploy/source/oci.yaml'));
    writeFileSync(join(dir, 'deploy/versions.json'), read('deploy/versions.json'));
    for (const file of ['diagnostics.mjs', 'admission.mjs', 'synthetic.mjs']) writeFileSync(join(dir, 'deploy/ci', file), '');
    const script = read('deploy/ci/exit-test.sh');
    writeFileSync(join(dir, 'run.sh'), script.slice(0, script.indexOf('flux create kustomization console-root')) + `\nexit ${status}\n`);
    writeFileSync(join(dir, '.tmp/exit-bundle/revision.json'), '{}');
    writeFileSync(join(dir, 'calls'), '');
    writeFileSync(join(dir, 'tool'), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const command = path.basename(process.argv[1]), args = process.argv.slice(2);
const record = value => fs.appendFileSync(process.env.CALLS, JSON.stringify({command,args,...value})+'\\n');
if (command === 'docker') {
  const token = fs.readFileSync(0, 'utf8');
  if (token !== process.env.REGISTRY_TOKEN || args.includes(token)) process.exit(23);
  fs.writeFileSync(path.join(process.env.DOCKER_CONFIG, 'config.json'), JSON.stringify({auths:{'ghcr.io':{auth:Buffer.from(process.env.GITHUB_ACTOR+':'+token).toString('base64')}}}));
  record({config:process.env.DOCKER_CONFIG});
} else if (command === 'kubectl' && args[0] === 'create' && args[1] === 'secret') {
  const config = JSON.parse(fs.readFileSync(args.find(a => a.startsWith('--from-file=')).split('=').slice(2).join('='), 'utf8'));
  if (Buffer.from(config.auths['ghcr.io'].auth, 'base64').toString() !== process.env.GITHUB_ACTOR+':'+process.env.REGISTRY_TOKEN) process.exit(24);
  record({});
} else if (command === 'kubectl' && args.at(-1) === '-') record({source:require('js-yaml').load(fs.readFileSync(0, 'utf8'))});
else if (command === 'cosign') { record({}); console.log(JSON.stringify([{critical:{image:{'docker-manifest-digest':'sha256:'+'a'.repeat(64)}}}])); }
else record({});
`, {mode:0o755});
    for (const tool of ['docker', 'kubectl', 'cosign', 'flux', 'kind']) symlinkSync('tool', join(dir, tool));
    const token = 'fixture-registry-token-never-print';
    const result = spawnSync('bash', ['run.sh'], {cwd:dir,encoding:'utf8',env:{...process.env,
      PATH:`${dir}:${process.env.PATH}`, CALLS:join(dir, 'calls'), RUNNER_TEMP:join(dir, 'runner'),
      GITHUB_REPOSITORY:'example/console', GITHUB_ACTOR:'fixture-user', REGISTRY_TOKEN:token,
      PLATFORM_WORKFLOW_IDENTITY:'https://github.com/example/console/.github/workflows/platform.yml@refs/heads/dev',
    }});
    assert.equal(result.status, status, result.stderr);
    const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const login = calls.find(c => c.command === 'docker');
    assert.ok(login, 'authenticate the runner before pulling private signatures and artifacts');
    assert.deepEqual(login.args, ['login', 'ghcr.io', '--username', 'fixture-user', '--password-stdin']);
    assert.equal(existsSync(login.config), false, 'remove the temporary Docker login on every exit');
    const secrets = calls.filter(c => c.command === 'kubectl' && c.args[0] === 'create' && c.args[1] === 'secret');
    assert.equal(secrets.length, 2, 'authenticate Flux and console in their own namespaces');
    assert.deepEqual(secrets.map(c => c.args[c.args.indexOf('-n')+1]).sort(), ['console', 'flux-system']);
    for (const secret of secrets) assert.ok(secret.args.includes('--type=kubernetes.io/dockerconfigjson'));
    const source = calls.find(c => c.source)?.source;
    assert.deepEqual(source.spec.secretRef, {name:secrets[0].args[3]});
    const account = calls.find(c => c.source?.kind === 'ServiceAccount')?.source;
    assert.deepEqual(account.metadata, {name:'default',namespace:'console'});
    assert.deepEqual(account.imagePullSecrets, [{name:secrets[1].args[3]}]);
    assert.ok(calls.findIndex(c => c.command === 'docker') < calls.findIndex(c => c.command === 'cosign'));
    assert.ok(calls.findIndex(c => c.command === 'kubectl' && c.args[1] === 'secret') < calls.findIndex(c => c.source));
    assert.equal(calls.at(-1).command, 'kind');
    assert.equal(calls.at(-1).args[0], 'delete');
    assert.doesNotMatch(result.stdout+result.stderr+readFileSync(join(dir, 'calls'), 'utf8'), new RegExp(`${token}|${Buffer.from('fixture-user:'+token).toString('base64')}`));
    for (const file of ['diagnostics.txt', 'disk.txt', 'result.txt', 'revision.json', 'artifact-signature.json']) {
      assert.ok(!readFileSync(join(dir, '.tmp/evidence', file), 'utf8').includes(token), 'never archive the token');
    }
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
