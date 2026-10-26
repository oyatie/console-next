// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import yaml from 'js-yaml';

const root = resolve(process.env.PLATFORM_REPO_ROOT ?? '.');
const read = path => readFileSync(join(root, path), 'utf8');
const signer = yaml.load(read('.github/workflows/platform-negative-signer.yml'));
const run = signer.jobs.sign.steps.find(step => step.id === 'sign').run;
const digest = `sha256:${'a'.repeat(64)}`;
const repository = 'ghcr.io/example/console';
const unsigned = `${repository}/console-unsigned@${digest}`;
const wrong = `${repository}/console-wrong-identity@${digest}`;
const bundleDigest = `sha256:${'b'.repeat(64)}`;
const artifact = `oci://${repository}/console-deploy@${bundleDigest}`;

function sign(failure = '') {
  const dir = mkdtempSync(join(tmpdir(), 'platform-negative-'));
  try {
    // Registry and OIDC boundaries are fake; execute the workflow's actual shell on a fresh runner.
    writeFileSync(join(dir, 'sign.sh'), `
docker() { cat >/dev/null; [[ "$FAILURE" != login ]]; }
flux() {
  if [[ "$1" == pull ]]; then
    [[ -d .tmp/negative ]] || { echo 'invalid output path .tmp/negative: no such file or directory' >&2; return 1; }
    [[ "$FAILURE" != pull ]] || return 17
    printf '%s' "$REVISION" > .tmp/negative/revision.json
  else
    [[ "$FAILURE" != push ]] || return 18
    test -s .tmp/negative/wrong-identity.txt || return 19
    if [[ "$FAILURE" == push-digest ]]; then printf '{}\\n'; return; fi
    printf '{"digest":"%s"}\\n' "$BUNDLE_DIGEST"
  fi
}
buildx() {
  [[ "$FAILURE" != "$2" ]] || return 20
  if [[ "$2" == inspect ]]; then
    if [[ "$FAILURE" == mismatch ]]; then printf '{"digest":"sha256:unexpected"}\\n';
    else printf '{"digest":"%s"}\\n' "$DIGEST"; fi
  fi
}
cosign() {
  printf '%s\\n' "$*" >> calls
  [[ "$FAILURE" != "$1" ]] || return 21
}
${run}`);
    writeFileSync(join(dir, 'output'), '');
    writeFileSync(join(dir, 'calls'), '');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', 'sign.sh'], {
      cwd: dir, encoding: 'utf8', env: {
        ...process.env, FAILURE: failure, DIGEST: digest, BUNDLE_DIGEST: bundleDigest,
        REVISION: JSON.stringify(failure === 'revision' ? {} : { unsignedImage: unsigned, wrongIdentityImage: wrong }),
        ARTIFACT: `oci://${repository}/console-deploy@sha256:${'c'.repeat(64)}`,
        REGISTRY_TOKEN: 'fixture-token-must-stay-secret',
        GITHUB_ACTOR: 'fixture', GITHUB_SHA: 'fixture-revision',
        GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'example/console',
        GITHUB_OUTPUT: join(dir, 'output'),
      },
    });
    return { ...result, output: readFileSync(join(dir, 'output'), 'utf8'), calls: readFileSync(join(dir, 'calls'), 'utf8') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('negative signer creates the Flux output directory on a fresh runner and signs only rejection fixtures', () => {
  const result = sign();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.output.includes(`artifact=${artifact}\n`));
  assert.ok(result.output.includes(`image=${repository}/console-wrong-identity\nimage-digest=${digest}\n`));
  const calls = result.calls.trim().split('\n');
  assert.deepEqual(calls.filter(call => call.startsWith('sign ')), [
    `sign --yes ${wrong}`, `sign --yes ${artifact.slice('oci://'.length)}`,
  ]);
  for (const call of calls.filter(call => call.startsWith('verify '))) {
    assert.ok(call.includes('--certificate-identity=https://github.com/example/console/.github/workflows/platform-negative-signer.yml@refs/heads/dev'));
    assert.ok(call.includes('--certificate-oidc-issuer=https://token.actions.githubusercontent.com'));
  }
  assert.equal(calls.filter(call => call.startsWith('verify ')).length, 2);
});

for (const failure of ['login', 'pull', 'revision', 'create', 'inspect', 'mismatch', 'sign', 'verify', 'push', 'push-digest']) {
  test(`negative signer explains ${failure} failure and publishes no artifact output`, () => {
    const result = sign(failure);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PLAT_NEGATIVE_SIGNER:/);
    if (failure !== 'mismatch') assert.match(result.stderr, /line.*exit/);
    assert.doesNotMatch(result.stderr, /fixture-token-must-stay-secret/);
    assert.doesNotMatch(result.output, /^artifact=/m);
    if (failure === 'mismatch') {
      assert.match(result.stderr, /PLAT_NEGATIVE_IMAGE_DIGEST/);
      assert.ok(result.stderr.includes(digest) && result.stderr.includes('sha256:unexpected'));
      assert.equal(result.calls, '', 'never sign bytes that differ from the publisher revision');
    }
  });
}

const workflow = yaml.load(read('.github/workflows/platform.yml'));
for (const [script, directory] of [
  [workflow.jobs.publish.steps.find(step => step.id === 'image').run, '.tmp/previous'],
  [read('deploy/ci/exit-test.sh'), '.tmp/exit-bundle'],
]) {
  test(`platform creates ${directory} before Flux pulls`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'platform-pull-'));
    try {
      const prefix = script.slice(0, script.indexOf('flux pull artifact'));
      // mkdir is the prerequisite; stop before any registry or cluster operation.
      const mkdirs = prefix.split('\n').filter(line => /^\s*mkdir -p /.test(line)).join('\n');
      const result = spawnSync('bash', ['-e', '-c', `${mkdirs}\ntest -d ${directory}`], { cwd: dir, encoding: 'utf8' });
      assert.equal(result.status, 0, `${directory} must exist before Flux pulls: ${result.stderr}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
