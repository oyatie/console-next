// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, matchesGlob, relative, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import yaml from 'js-yaml';
import { dockerfileStages } from '../../scripts/quality/tooling-inventory.mjs';

const root = resolve(process.env.PLATFORM_REPO_ROOT ?? '.');
const read = path => readFileSync(join(root, path), 'utf8');
const tracked = execFileSync('git', ['ls-files', '-z'], {cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
const dockerfile = 'deploy/images/console.Dockerfile';
const stages = dockerfileStages(read(dockerfile), dockerfile);
const ignores = read('deploy/images/console.Dockerfile.dockerignore').split('\n').filter(l => l && !l.startsWith('#'));
const admitted = path => ignores.reduce((included, pattern) => matchesGlob(path, pattern.replace(/^!/, '')) ? pattern.startsWith('!') : included, true);
const backendSources = stages.find(stage => stage.name === 'backend').contextSources;
const copied = path => backendSources.some(src => path === src || path.startsWith(`${src}/`));

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
  for (const src of stages.flatMap(stage => stage.contextSources)) {
    assert.ok(tracked.some(p => (p === src || p.startsWith(`${src}/`)) && admitted(p)), `missing COPY source: ${src}`);
  }
});

export function stripCfgTestItems(source) {
  const skipCommentOrLiteral = (index) => {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      let cursor = index + 2;
      while (cursor < source.length && source[cursor] !== '\n') cursor += 1;
      return { kind: 'comment', nextIndex: cursor };
    }
    if (char === '/' && next === '*') {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < source.length && depth > 0) {
        if (source[cursor] === '/' && source[cursor + 1] === '*') {
          depth += 1;
          cursor += 2;
        } else if (source[cursor] === '*' && source[cursor + 1] === '/') {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      return { kind: 'comment', nextIndex: cursor };
    }
    const prev = index > 0 ? source[index - 1] : '';
    if (!/[A-Za-z0-9_]/.test(prev)) {
      const raw = source.slice(index).match(/^(?:[bc])?r(#*)"/);
      if (raw) {
        const terminator = `"${raw[1]}`;
        const end = source.indexOf(terminator, index + raw[0].length);
        return { kind: 'literal', nextIndex: end === -1 ? source.length : end + terminator.length };
      }
    }
    if (char === '"') {
      let cursor = index + 1;
      while (cursor < source.length) {
        const inner = source[cursor];
        cursor += 1;
        if (inner === '\\') {
          if (cursor < source.length) cursor += 1;
          continue;
        }
        if (inner === '"') break;
      }
      return { kind: 'literal', nextIndex: cursor };
    }
    if (char === '\'') {
      const literal = source.slice(index).match(/^'(?:\\(?:[^u]|u\{[^}]*\})|[^\\'\n])'/);
      if (literal) return { kind: 'literal', nextIndex: index + literal[0].length };
    }
    return null;
  };

  const skipBracketGroup = (startIndex, openChar, closeChar) => {
    let depth = 1;
    let cursor = startIndex + 1;
    while (cursor < source.length && depth > 0) {
      const skipped = skipCommentOrLiteral(cursor);
      if (skipped) {
        cursor = skipped.nextIndex;
        continue;
      }
      if (source[cursor] === openChar) depth += 1;
      else if (source[cursor] === closeChar) depth -= 1;
      cursor += 1;
    }
    return cursor;
  };

  let output = '';
  let index = 0;
  while (index < source.length) {
    const skipped = skipCommentOrLiteral(index);
    if (skipped) {
      output += skipped.kind === 'comment' ? ' ' : source.slice(index, skipped.nextIndex);
      index = skipped.nextIndex;
      continue;
    }
    if (source[index] === '#') {
      const attr = source.slice(index).match(/^#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/);
      if (attr) {
        index += attr[0].length;
        while (index < source.length) {
          const innerSkipped = skipCommentOrLiteral(index);
          if (innerSkipped) {
            index = innerSkipped.nextIndex;
            continue;
          }
          if (/\s/.test(source[index])) {
            index += 1;
            continue;
          }
          if (source[index] === '#') {
            const nextBracket = source.slice(index).match(/^#\s*\[/);
            if (nextBracket) {
              index = skipBracketGroup(index + nextBracket[0].length - 1, '[', ']');
              continue;
            }
          }
          if (source[index] === ';') {
            index += 1;
            break;
          }
          if (source[index] === '{') {
            index = skipBracketGroup(index, '{', '}');
            break;
          }
          index += 1;
        }
        output += ' ';
        continue;
      }
    }
    output += source[index];
    index += 1;
  }
  return output;
}

export function compileTimeFileInputs(source) {
  return [...stripCfgTestItems(source).matchAll(/include_(?:str|bytes)!\(\s*"([^"]+)"\s*\)/g)].map(m => m[1]);
}

test('stripCfgTestItems strips #[cfg(test)] items while preserving subsequent production include_str!', () => {
  const sample = `
    // #[cfg(test)] must not truncate production code
    const DECOY: &str = "#[cfg(test)]";
    #[cfg(test)]
    mod frozen_keys;

    #[cfg(test)]
    #[path = "grammar_tests.rs"]
    mod external_tests;

    #[cfg(test)]
    mod inline_tests {
        const BRACE: &str = "}";
        const RAW: &str = r#"} still inside test"#;
        // } comment brace
        const TEST_ONLY: &str = include_str!("test-only.json");
    }

    pub fn prod() -> &'static str {
        include_str!("../../../../../packages/i18n/src/catalogs/uncopied-prod.json")
    }
  `;
  const inputs = compileTimeFileInputs(sample);
  assert.deepEqual(inputs, ['../../../../../packages/i18n/src/catalogs/uncopied-prod.json']);
  const unresolved = inputs.map(rel => relative(root, resolve(root, dirname('backend/crates/platform/request-context/src/error_i18n.rs'), rel)))
    .filter(path => !(tracked.includes(path) && admitted(path) && copied(path)));
  assert.deepEqual(unresolved, ['packages/i18n/src/catalogs/uncopied-prod.json']);
});

test('Rust compile-time file inputs are copied from the admitted context', () => {
  for (const file of tracked.filter(p => /^backend\/.*\/src\/.*\.rs$/.test(p) && !/test/.test(p))) {
    for (const rel of compileTimeFileInputs(read(file))) {
      const path = relative(root, resolve(root, dirname(file), rel));
      assert.ok(tracked.includes(path) && admitted(path) && copied(path), `${file} needs ${path} in its image stage`);
    }
  }
});

test('the SBOM scan and policy accept the pinned attest v4.1.0 SPDX-2.3 statement shape', () => {
  // actions/attest@59d89421af93a897026c735860bf21b6eb4f7b26 src/sbom.ts generates this versioned type.
  const statement = {_type:'https://in-toto.io/Statement/v1', subject:[{name:'example.invalid/console',digest:{sha256:'a'.repeat(64)}}], predicateType:'https://spdx.dev/Document/v2.3', predicate:{spdxVersion:'SPDX-2.3',SPDXID:'SPDXRef-DOCUMENT',name:'console'}};
  const policy = yaml.loadAll(read('deploy/policies/images.yaml')).find(p => p.metadata.name === 'console-attestations');
  const sbom = policy.spec.authorities[0].attestations.find(a => a.name === 'sbom');
  assert.equal(sbom.predicateType, statement.predicateType);
  assert.ok(sbom.policy.data.includes(`predicateType: "${statement.predicateType}"`));
  assert.match(statement.predicate.spdxVersion, /^SPDX-2\./);
  const workflow = yaml.load(read('.github/workflows/platform.yml'));
  const attest = workflow.jobs.publish.steps.find(step => step.uses?.startsWith('actions/attest-sbom@'));
  assert.equal(attest.uses, 'actions/attest-sbom@c604332985a26aa8cf1bdc465b92731239ec6b9e');
  assert.equal(attest.with['push-to-registry'], true);
  const scan = workflow.jobs.scan.steps.find(step => step.run?.includes('cosign verify-attestation'));
  assert.equal(scan.run.match(/verify-attestation --type=(\S+)/)?.[1], statement.predicateType);
  assert.ok(scan.run.includes('--certificate-oidc-issuer=https://token.actions.githubusercontent.com'));
  assert.ok(scan.run.includes('--certificate-identity="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/.github/workflows/platform.yml@refs/heads/dev"'));
  assert.equal(scan.env.IMAGE, '${{ needs.publish.outputs.image }}');
  assert.ok(scan.run.includes('grype "sbom:${RUNNER_TEMP}/image-sbom.json" --only-fixed --fail-on high'));
});

test('the scan handles repeated verified SBOMs and fails closed on verification or vulnerability errors', () => {
  const workflow = yaml.load(read('.github/workflows/platform.yml'));
  const scan = workflow.jobs.scan.steps.find(step => step.run?.includes('cosign verify-attestation'));
  const digest = 'a'.repeat(64);
  const envelope = (name, hash = digest) => ({payload:Buffer.from(JSON.stringify({
    subject:[{digest:{sha256:hash}}], predicate:{spdxVersion:'SPDX-2.3',name},
  })).toString('base64')});
  const dir = mkdtempSync(join(tmpdir(), 'image-scan-'));
  try {
    for (const [name, source] of Object.entries({
      docker:'#!/usr/bin/env bash\ncat > /dev/null\n',
      cosign:'#!/usr/bin/env bash\ncat "$ATTESTATIONS"\nexit "${VERIFY_STATUS:-0}"\n',
      grype:`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify({args,sbom:JSON.parse(fs.readFileSync(args[0].slice('sbom:'.length),'utf8'))})+'\\n');
process.exit(Number(process.env.GRYPE_STATUS ?? 0));
`,
    })) writeFileSync(join(dir, name), source, {mode:0o755});
    const calls = join(dir, 'calls');
    const attestations = join(dir, 'attestations');
    const run = (statements, extra = {}) => {
      writeFileSync(attestations, statements.map(value => JSON.stringify(value)).join('\n'));
      writeFileSync(calls, '');
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', scan.run], {encoding:'utf8',env:{
        ...process.env, PATH:`${dir}:${process.env.PATH}`, RUNNER_TEMP:dir, ATTESTATIONS:attestations, CALLS:calls,
        IMAGE:`example.invalid/console@sha256:${digest}`, REGISTRY_TOKEN:'fixture',
        GITHUB_SERVER_URL:'https://github.com', GITHUB_REPOSITORY:'example/console', GITHUB_ACTOR:'fixture', ...extra,
      }});
      return {...result, calls:readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))};
    };
    const single = run([envelope('first')]);
    assert.equal(single.status, 0, single.stderr);
    assert.equal(single.calls.length, 1);
    const repeated = run([[envelope('first')], envelope('second'), envelope('unrelated', 'b'.repeat(64))]);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(repeated.calls.map(call => call.sbom.name), ['first','second']);
    for (const call of repeated.calls) assert.deepEqual(call.args, [`sbom:${dir}/image-sbom.json`,'--only-fixed','--fail-on','high']);
    for (const statements of [[], [envelope('unrelated', 'b'.repeat(64))]]) {
      const missing = run(statements);
      assert.notEqual(missing.status, 0, 'missing digest-matching evidence must fail');
      assert.equal(missing.calls.length, 0);
    }
    const unverified = run([envelope('unverified')], {VERIFY_STATUS:'1'});
    assert.notEqual(unverified.status, 0);
    assert.equal(unverified.calls.length, 0);
    const vulnerable = run([envelope('vulnerable'), envelope('second')], {GRYPE_STATUS:'2'});
    assert.equal(vulnerable.status, 2);
    assert.equal(vulnerable.calls.length, 1, 'a vulnerability failure must stop the scan');
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

function imageAdmission(extra = {}) {
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
if (process.env.REQUIRE_PULL_SECRET && pod.spec.imagePullSecrets?.[0]?.name !== process.env.PLATFORM_PULL_SECRET) { console.error('policy.sigstore.dev: failed to verify: UNAUTHORIZED: authentication required'); process.exit(1); }
if (image.includes('unsigned') && !process.env.ADMIT_UNSIGNED) { console.error('policy.sigstore.dev: '+(process.env.REGISTRY_FAILURE ? 'UNAUTHORIZED: authentication required' : 'no valid bundles exist in registry')); process.exit(1); }
if (image.includes('wrong-identity') && !process.env.ADMIT_WRONG) { console.error('policy.sigstore.dev: '+(process.env.WRONG_FAILURE || 'failed to verify certificate identity: no matching CertificateIdentity found')); process.exit(1); }
`, {mode:0o755});
    writeFileSync(join(dir, 'cosign'), `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(2))+'\\n');
if (process.env.BAD_SIGNATURE) process.exit(1);
` , {mode:0o755});
    execFileSync('mkdir', ['-p', join(dir,'.tmp/exit-bundle'), join(dir,'.tmp/evidence')]);
    writeFileSync(join(dir,'.tmp/exit-bundle/revision.json'), JSON.stringify({image,unsignedImage,wrongIdentityImage}));
    writeFileSync(join(dir, 'calls'), '');
    const env = {...process.env, PATH:`${dir}:${process.env.PATH}`, CALLS:join(dir,'calls'), PLATFORM_WORKFLOW_IDENTITY:identity, PLATFORM_PULL_SECRET:'fixture-registry'};
    const result = spawnSync(process.execPath,[join(root,'deploy/ci/image-admission.mjs')],{cwd:dir,env:{...env,...extra},encoding:'utf8'});
    return {...result, calls:readFileSync(env.CALLS, 'utf8'), wrongIdentityImage, identity};
  } finally { rmSync(dir,{recursive:true,force:true}); }
}

test('image admission verifies the other signer and fails if its image is admitted', () => {
  const refused = imageAdmission();
  assert.equal(refused.status,0,refused.stderr);
  assert.ok(refused.calls.includes(refused.wrongIdentityImage), 'must exercise the wrong-identity image');
  assert.ok(refused.calls.includes(refused.identity.replace('platform.yml','platform-negative-signer.yml')), 'first verify its actual signing identity');
  const admittedUnsigned = imageAdmission({ADMIT_UNSIGNED:'1'});
  assert.notEqual(admittedUnsigned.status,0, 'accepting unsigned bytes must fail the control');
  assert.match(admittedUnsigned.stderr,/PLAT_UNSIGNED_IMAGE/);
  assert.notEqual(imageAdmission({REGISTRY_FAILURE:'1'}).status,0, 'registry authorization failures cannot count as signature refusals');
  const admitted = imageAdmission({ADMIT_WRONG:'1'});
  assert.notEqual(admitted.status,0, 'accepting the wrong identity must fail the control');
  assert.match(admitted.stderr,/PLAT_IMAGE_IDENTITY/);
  const bad = imageAdmission({BAD_SIGNATURE:'1'});
  assert.notEqual(bad.status,0, 'an unverified signature cannot count as an identity refusal');
  assert.ok(!bad.calls.split('\n').includes(bad.wrongIdentityImage));
});

test('all admission probes use the run-scoped pull secret', () => {
  const result = imageAdmission({REQUIRE_PULL_SECRET:'1'});
  assert.equal(result.status, 0, result.stderr);
});

test('missing run credentials cannot silently use anonymous registry access', () => {
  const result = imageAdmission({PLATFORM_PULL_SECRET:''});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PLAT_REGISTRY/);
});

for (const failure of ['failed to verify: UNAUTHORIZED: authentication required', 'verification failed: DENIED: requested access is denied', 'failed to verify: dial tcp: no such host', 'failed to verify: context deadline exceeded', 'failed to verify certificate identity: no matching CertificateIdentity found; UNAUTHORIZED: authentication required']) {
  test(`wrong-identity registry failure is fatal: ${failure}`, () => {
    const result = imageAdmission({WRONG_FAILURE:failure});
    assert.notEqual(result.status, 0, 'a wrong-identity registry failure must fail the control');
    assert.match(result.stderr, /PLAT_IMAGE_REGISTRY/);
    assert.ok(result.stderr.includes(failure), 'explain the registry failure');
  });
}

test('wrong-identity missing bundles do not prove an identity refusal', () => {
  const result = imageAdmission({WRONG_FAILURE:'failed to verify: no valid bundles exist in registry'});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PLAT_IMAGE_IDENTITY/);
});
