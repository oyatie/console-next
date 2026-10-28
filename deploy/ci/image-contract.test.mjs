// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, matchesGlob, relative, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import yaml from 'js-yaml';

const root = resolve(process.env.PLATFORM_REPO_ROOT ?? '.');
const read = path => readFileSync(join(root, path), 'utf8');
const tracked = execFileSync('git', ['ls-files', '-z'], {cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
const copies = [...read('deploy/images/console.Dockerfile').matchAll(/^COPY (?!\-\-from=)(.+)$/gm)].map(m => m[1].split(/\s+/));
const ignores = read('deploy/images/console.Dockerfile.dockerignore').split('\n').filter(l => l && !l.startsWith('#'));
const admitted = path => ignores.reduce((included, pattern) => matchesGlob(path, pattern.replace(/^!/, '')) ? pattern.startsWith('!') : included, true);
const copied = path => copies.some(parts => parts.slice(0,-1).some(src => path === src || path.startsWith(`${src}/`)));

test('the actual native-build guard accepts each runner and refuses the opposite architecture', () => {
  const workflow = yaml.load(read('.github/workflows/platform.yml'));
  const guard = workflow.jobs.build.steps.find(s => s.name === 'Native image and GHA cache').run.split('buildx create')[0];
  for (const [arch, native, status] of [['amd64','x86_64',0],['arm64','aarch64',0],['amd64','aarch64',1],['arm64','x86_64',1]]) {
    const result = spawnSync('bash',['-c',`docker() { echo "$TEST_NATIVE_ARCH"; }\n${guard}`],{env:{...process.env,ARCH:arch,TEST_NATIVE_ARCH:native},encoding:'utf8'});
    assert.equal(result.status,status,result.stderr);
    if (status) assert.match(result.stderr,/PLAT_NATIVE_ARCH/);
  }
});

test('every Docker COPY source exists in the tracked, admitted context', () => {
  for (const parts of copies) for (const src of parts.slice(0,-1)) {
    assert.ok(tracked.some(p => (p === src || p.startsWith(`${src}/`)) && admitted(p)), `missing COPY source: ${src}`);
  }
});

test('Rust compile-time file inputs are copied from the admitted context', () => {
  for (const file of tracked.filter(p => /^backend\/.*\/src\/.*\.rs$/.test(p) && !/test/.test(p))) {
    const source = read(file).split('#[cfg(test)]')[0];
    for (const match of source.matchAll(/include_(?:str|bytes)!\(\s*"([^"]+)"\s*\)/g)) {
      const path = relative(root, resolve(root, dirname(file), match[1]));
      assert.ok(tracked.includes(path) && admitted(path) && copied(path), `${file} needs ${path} in its image stage`);
    }
  }
});

test('the SBOM policy accepts the pinned attest v4.1.0 SPDX-2.3 statement shape', () => {
  // actions/attest@59d89421af93a897026c735860bf21b6eb4f7b26 src/sbom.ts generates this versioned type.
  const statement = {_type:'https://in-toto.io/Statement/v1', subject:[{name:'example.invalid/console',digest:{sha256:'a'.repeat(64)}}], predicateType:'https://spdx.dev/Document/v2.3', predicate:{spdxVersion:'SPDX-2.3',SPDXID:'SPDXRef-DOCUMENT',name:'console'}};
  const policy = yaml.loadAll(read('deploy/policies/images.yaml')).find(p => p.metadata.name === 'console-attestations');
  const sbom = policy.spec.authorities[0].attestations.find(a => a.name === 'sbom');
  assert.equal(sbom.predicateType, statement.predicateType);
  assert.ok(sbom.policy.data.includes(`predicateType: "${statement.predicateType}"`));
  assert.match(statement.predicate.spdxVersion, /^SPDX-2\./);
});

test('image admission verifies the other signer and fails if its image is admitted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-image-'));
  try {
    const image = `example.invalid/console@sha256:${'a'.repeat(64)}`;
    const unsignedImage = image.replace('console@', 'console-unsigned@');
    const wrongIdentityImage = image.replace('console@', 'console-wrong-identity@');
    const identity = 'https://github.com/example/console/.github/workflows/platform.yml@refs/heads/dev';
    writeFileSync(join(dir, 'kubectl'), `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('current-context')) { console.log('kind-platform-fixture'); process.exit(); }
const pod = JSON.parse(fs.readFileSync(0,'utf8'));
const image = pod.spec.containers[0].image;
fs.appendFileSync(process.env.CALLS, image+'\\n');
if (image.includes('unsigned') && !process.env.ADMIT_UNSIGNED) { console.error('policy.sigstore.dev: '+(process.env.REGISTRY_FAILURE ? 'UNAUTHORIZED: authentication required' : 'no valid bundles exist in registry')); process.exit(1); }
if (image.includes('wrong-identity') && !process.env.ADMIT_WRONG) { console.error('policy.sigstore.dev: no matching signatures: subject mismatch'); process.exit(1); }
`, {mode:0o755});
    writeFileSync(join(dir, 'cosign'), `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(2))+'\\n');
if (process.env.BAD_SIGNATURE) process.exit(1);
` , {mode:0o755});
    execFileSync('mkdir', ['-p', join(dir,'.tmp/exit-bundle'), join(dir,'.tmp/evidence')]);
    writeFileSync(join(dir,'.tmp/exit-bundle/revision.json'), JSON.stringify({image,unsignedImage,wrongIdentityImage}));
    const env = {...process.env, PATH:`${dir}:${process.env.PATH}`, CALLS:join(dir,'calls'), PLATFORM_WORKFLOW_IDENTITY:identity};
    const run = extra => spawnSync(process.execPath,[join(root,'deploy/ci/image-admission.mjs')],{cwd:dir,env:{...env,...extra},encoding:'utf8'});
    const refused = run({});
    assert.equal(refused.status,0,refused.stderr);
    assert.ok(readFileSync(env.CALLS,'utf8').includes(wrongIdentityImage), 'must exercise the wrong-identity image');
    assert.ok(readFileSync(env.CALLS,'utf8').includes(identity.replace('platform.yml','platform-negative-signer.yml')), 'first verify its actual signing identity');
    const admittedUnsigned = run({ADMIT_UNSIGNED:'1'});
    assert.notEqual(admittedUnsigned.status,0, 'accepting unsigned bytes must fail the control');
    assert.match(admittedUnsigned.stderr,/PLAT_UNSIGNED_IMAGE/);
    assert.notEqual(run({REGISTRY_FAILURE:'1'}).status,0, 'registry authorization failures cannot count as signature refusals');
    const admitted = run({ADMIT_WRONG:'1'});
    assert.notEqual(admitted.status,0, 'accepting the wrong identity must fail the control');
    assert.match(admitted.stderr,/PLAT_IMAGE_IDENTITY/);
    writeFileSync(env.CALLS,'');
    assert.notEqual(run({BAD_SIGNATURE:'1'}).status,0, 'an unverified signature cannot count as an identity refusal');
    assert.ok(!readFileSync(env.CALLS,'utf8').split('\n').includes(wrongIdentityImage));
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
