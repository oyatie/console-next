// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import yaml from 'js-yaml';
import { pod, refusals } from './fixtures.mjs';

const root = resolve(process.env.PLATFORM_REPO_ROOT ?? '.');
const read = path => readFileSync(join(root, path), 'utf8');

test('native builds cannot publish or sign a PR; only dev pushes publish', () => {
  const wf = yaml.load(read('.github/workflows/platform.yml'));
  assert.deepEqual(wf.on.push.branches, ['dev']);
  for (const event of ['pull_request', 'merge_group', 'workflow_dispatch', 'schedule']) assert.ok(event in wf.on);
  assert.deepEqual(wf.permissions, {});
  assert.deepEqual(wf.jobs.build.strategy.matrix.include, [
    { arch: 'amd64', runner: 'ubuntu-24.04' }, { arch: 'arm64', runner: 'ubuntu-24.04-arm' },
  ]);
  for (const [name, job] of Object.entries(wf.jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses) assert.match(step.uses, /^(actions\/[^@]+|step-security\/harden-runner)@[a-f0-9]{40}$/);
      assert.doesNotMatch(step.run ?? '', /qemu|curl[^\n]+\|\s*(sh|bash)/i);
    }
    if (job.permissions?.['id-token'] === 'write' || job.permissions?.packages === 'write') {
      assert.match(job.if, /github.event_name == 'push' && github.ref == 'refs\/heads\/dev'/, name);
    }
  }
  assert.match(JSON.stringify(wf.jobs.build), /type=gha/);
  assert.match(JSON.stringify(wf.jobs.build), /--cache-from/);
  assert.match(JSON.stringify(wf.jobs.validate), /validate\.sh/);
  assert.match(JSON.stringify(wf.jobs.validate), /admission\.mjs/);
  assert.ok(wf.jobs.publish.steps.some(s => s.uses?.startsWith('actions/attest-build-provenance@') && s.with['push-to-registry'] === true));
  assert.ok(wf.jobs.publish.steps.some(s => s.uses?.startsWith('actions/attest-sbom@') && s.with['push-to-registry'] === true));
  assert.match(JSON.stringify(wf.jobs.publish), /flux push artifact/);
  assert.match(wf.jobs.publish.steps.find(s => s.id === 'image').run, /cosign sign --yes "\$\{IMAGE\}@\$\{digest\}"/);
  assert.match(wf.jobs.publish.steps.find(s => s.id === 'artifact').run, /cosign sign --yes "\$\{DEPLOY\}@\$\{digest\}"/);
  assert.deepEqual(wf.jobs['exit-test'].strategy.matrix.runner, ['ubuntu-24.04', 'ubuntu-24.04-arm']);
  assert.match(wf.jobs['exit-test'].if, /schedule/);
  assert.match(wf.jobs['exit-test'].if, /workflow_dispatch/);
});

test('the image ships the real API, worker and migrations without development features', () => {
  const dockerfile = read('deploy/images/console.Dockerfile');
  assert.match(dockerfile, /cargo build --locked --release -p console-app --bin console-app/);
  assert.doesNotMatch(dockerfile, /--features.*(?:dev-auth|e2e-test-support)/);
  assert.match(dockerfile, /COPY --from=web.*dist/);
  // The context holds apps/web and packages only: the root build type-checks e2e/ and tests outside it.
  assert.match(dockerfile, /npm run build -w @console\/web\n/);
  assert.doesNotMatch(dockerfile, /npm run build\n/);
  assert.match(dockerfile, /USER 65532:65532/);
  assert.match(dockerfile, /COPY third-party\/rust\/vendor \/src\/third-party\/rust\/vendor/);
  const lock = JSON.parse(read('deploy/versions.json'));
  for (const name of ['node', 'rust', 'runtime']) assert.match(lock.images[name], /@sha256:[a-f0-9]{64}$/);
  assert.match(dockerfile, /ARG RUST_IMAGE/);
});

test('Flux waits for database and digest-named migration before starting the app', () => {
  const docs = yaml.loadAll(read('deploy/reconcile/kustomizations.yaml'));
  const app = docs.find(d => d.metadata.name === 'console-app');
  const migrate = docs.find(d => d.metadata.name === 'console-migrate');
  assert.ok(app.spec.dependsOn.some(d => d.name === 'console-migrate'));
  assert.ok(migrate.spec.dependsOn.some(d => d.name === 'console-database'));
  assert.equal(migrate.spec.wait, true);
  assert.equal(app.spec.prune, true);
  assert.ok(app.spec.healthCheckExprs.some(e => e.kind === 'Rollout'));
  const source = yaml.load(read('deploy/source/oci.yaml'));
  assert.equal(source.spec.verify.provider, 'cosign');
  assert.match(source.spec.verify.matchOIDCIdentity[0].issuer, /token\\.actions\\.githubusercontent\\.com/);
});

function evaluate(value) {
  const dir = mkdtempSync(join(tmpdir(), 'platform-policy-'));
  try {
    const file = join(dir, 'fixture.json');
    writeFileSync(file, JSON.stringify(value));
    try { return execFileSync('conftest', ['test', file, '-p', join(root, 'deploy/policies/conftest'), '--output', 'json'], { encoding: 'utf8' }); }
    catch (error) { if (error.status !== 1) throw error; return error.stdout; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('hardened pods are accepted by the actual OPA policy', () => {
  const result = JSON.parse(evaluate(pod()));
  assert.equal(result.flatMap(r => r.failures ?? []).length, 0);
});
for (const [code, mutate] of Object.entries(refusals)) test(`${code}: refuses the unsafe pod and init container`, () => {
  const fixture = pod(); mutate(fixture);
  assert.match(evaluate(fixture), new RegExp(code));
  if (fixture.spec.containers[0].image !== pod().spec.containers[0].image || ['PLAT_READ_ONLY', 'PLAT_RESOURCES', 'PLAT_PRIVILEGE'].includes(code)) {
    fixture.spec.initContainers = fixture.spec.containers;
    fixture.spec.containers = pod().spec.containers;
    assert.match(evaluate(fixture), new RegExp(code));
  }
});

for (const [name, code, mutate] of [
  ['privileged', 'PLAT_PRIVILEGE', c => { c.securityContext.privileged = true; }],
  ['added capabilities', 'PLAT_PRIVILEGE', c => { c.securityContext.capabilities.add = ['NET_ADMIN']; }],
  ['ALL not dropped', 'PLAT_PRIVILEGE', c => { c.securityContext.capabilities.drop = []; }],
  ['root UID', 'PLAT_NON_ROOT', c => { c.securityContext.runAsUser = 0; }],
  ['non-root disabled', 'PLAT_NON_ROOT', c => { c.securityContext.runAsNonRoot = false; }],
]) test(`${code}: independently refuses ${name} in every container list`, () => {
  for (const field of ['containers', 'initContainers', 'ephemeralContainers']) {
    const fixture = pod();
    const container = structuredClone(fixture.spec.containers[0]);
    mutate(container);
    fixture.spec[field] = [container];
    assert.match(evaluate(fixture), new RegExp(code));
  }
});

test('PLAT_IMAGE_DIGEST: database images independently require a digest', () => {
  const fixture = {apiVersion:'postgresql.cnpg.io/v1', kind:'Cluster', metadata:{name:'db'}, spec:{imageName:JSON.parse(read('deploy/versions.json')).images.postgres}};
  assert.equal(JSON.parse(evaluate(fixture)).flatMap(r => r.failures ?? []).length, 0);
  fixture.spec.imageName = 'postgres:latest';
  assert.match(evaluate(fixture), /PLAT_IMAGE_DIGEST/);
});

test('PLAT_IMAGE_DIGEST and PLAT_OVERLAY: renderer refuses tags and unknown environments before output', () => {
  for (const [environment, image, code] of [
    ['exit-test', 'example.invalid/console:latest', 'PLAT_IMAGE_DIGEST'],
    ['exit-test', `example.invalid/console:latest@sha256:${'a'.repeat(64)}`, 'PLAT_IMAGE_DIGEST'],
    ['../production', `example.invalid/console@sha256:${'a'.repeat(64)}`, 'PLAT_OVERLAY'],
  ]) {
    assert.throws(() => execFileSync(process.execPath, [join(root, 'deploy/ci/render.mjs'), environment, image, '.tmp/invalid'], {encoding:'utf8',stdio:'pipe'}), error => error.status === 1 && error.stderr.includes(code));
  }
});

test('class B executes signature and identity controls, drift, real HTTP, canary and S3 recovery', () => {
  const script = read('deploy/ci/exit-test.sh');
  for (const name of ['image-admission.mjs','stack.e2e.mjs','canary.mjs','restore.mjs']) assert.ok(script.includes(name));
  assert.match(script, /SourceVerificationFailed/);
  assert.match(script, /kubectl scale deployment console-worker/);
  assert.match(script, /flux reconcile kustomization console-app/);
  const signer = yaml.load(read('.github/workflows/platform-negative-signer.yml'));
  assert.ok(signer.on.workflow_call);
  assert.match(signer.jobs.sign.if, /github.event_name == 'push' && github.ref == 'refs\/heads\/dev'/);
  const sign = signer.jobs.sign.steps.find(s => s.id === 'sign');
  assert.match(sign.run, /wrong-identity\.txt/);
  assert.match(sign.run, /certificate-identity=.*platform-negative-signer\.yml/);
  assert.match(sign.run, /cosign verify/);
  assert.match(sign.run, /cosign sign --yes "\$\{wrong\}"/);
  for (const action of ['attest-build-provenance', 'attest-sbom']) {
    assert.ok(signer.jobs.sign.steps.some(s => s.uses?.startsWith(`actions/${action}@`) && s.with['push-to-registry'] === true));
  }
  assert.match(script, /test "\$\{actual\}" = "\$\{expected\}"/);
});

test('PLAT_RENDER_GROUP: a missing bundle never passes validation by doing zero work', () => {
  const dir=mkdtempSync(join(tmpdir(),'platform-missing-'));
  try {
    assert.throws(()=>execFileSync('bash',[join(root,'deploy/ci/validate.sh'),dir],{encoding:'utf8',stdio:'pipe'}),error=>error.status===1 && error.stderr.includes('PLAT_RENDER_GROUP'));
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('a failed previous-artifact pull is printed and is bootstrap only for a missing package', () => {
  const wf = yaml.load(read('.github/workflows/platform.yml'));
  const run = wf.jobs.publish.steps.find(step => step.id === 'image').run;
  const pull = run.slice(run.indexOf('flux pull artifact'), run.indexOf('for arch in'));
  assert.match(pull, /cat \.tmp\/previous-error\.txt >&2/);
  assert.match(pull, /packages\/container\//);
  assert.match(pull, /\[\[ "\$\{code\}" == 404 \]\] \|\| \{ echo .+ exit 1; \}/);
});

