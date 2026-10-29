// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { readFileSync, cpSync, existsSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import yaml from 'js-yaml';
import { pod, refusals } from './fixtures.mjs';
import { rolloutProgressDeadlineSeconds } from './rollout-deadline.mjs';

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
test('PLAT_IMAGE_DIGEST: pod policies accept version tags only with a digest in every container list', () => {
  const policy = yaml.loadAll(read('deploy/policies/admission.yaml')).find(doc => doc.kind === 'ValidatingAdmissionPolicy');
  const expression = policy.spec.validations.find(v => v.message.startsWith('PLAT_IMAGE_DIGEST:')).expression;
  const pattern = new RegExp(expression.match(/matches\('([^']+)'\)/)[1]);
  for (const field of ['containers', 'initContainers', 'ephemeralContainers']) {
    const fixture = pod();
    fixture.spec[field] = [structuredClone(fixture.spec.containers[0])];
    const container = fixture.spec[field][0];
    container.image = `registry.invalid:5000/postgresql:18.6-standard-trixie@sha256:${'a'.repeat(64)}`;
    assert.ok(pattern.test(container.image), 'server admission must accept tagged digests');
    assert.equal(JSON.parse(evaluate(fixture)).flatMap(r => r.failures ?? []).length, 0);
    for (const invalid of ['postgres:18.6', container.image.slice(0, -1), container.image + 'a', container.image.replace('@sha256:', '@sha512:')]) {
      container.image = invalid;
      assert.equal(pattern.test(invalid), false);
      assert.match(evaluate(fixture), /PLAT_IMAGE_DIGEST/);
    }
  }
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
  fixture.spec.imageName = `registry.invalid:5000/postgresql:18.6-standard-trixie@sha256:${'a'.repeat(64)}`;
  assert.equal(JSON.parse(evaluate(fixture)).flatMap(r => r.failures ?? []).length, 0, 'a version tag must preserve the digest pin');
  fixture.spec.imageName = 'postgres:latest';
  assert.match(evaluate(fixture), /PLAT_IMAGE_DIGEST/);
  fixture.spec.imageName = 'postgres:18.6';
  assert.match(evaluate(fixture), /PLAT_IMAGE_DIGEST/);
});

// CNPG v1.30.1 validateImageName uses machinery v0.6.0 reference.Tag and version.FromTag:
// https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/webhook/v1/cluster_webhook.go
// https://github.com/cloudnative-pg/machinery/blob/v0.6.0/pkg/postgres/version/version.go
function cnpgVersion(imageName) {
  const tag = imageName.split('@')[0].split('/').at(-1).split(':')[1] ?? '';
  assert.ok(tag && tag !== 'latest', 'CNPG imageName needs a version tag to detect upgrades');
  const version = tag.match(/^(?:[0-9]\.?)+/)?.[0];
  assert.ok(version, 'CNPG invalid version tag');
  const [major, minor = '0'] = version.split('.');
  for (const part of [major, minor]) assert.ok(/^[0-9]+$/.test(part) && BigInt(part) <= (1n << 63n) - 1n, 'CNPG invalid version component');
  return [Number(major), Number(minor)];
}

test('CNPG image validation accepts version tags and refuses digest-only, latest and invalid versions', () => {
  for (const [tag, version] of [['18.6-standard-trixie',[18,6]], ['14',[14,0]], ['13.3.2.1-1',[13,3]], ['17beta1',[17,0]]]) {
    assert.deepEqual(cnpgVersion(`registry.invalid:5000/postgresql:${tag}@sha256:${'a'.repeat(64)}`), version);
  }
  for (const tag of ['', ':latest', ':stable', ':v18.6', ':18.-trixie', ':99999999999999999999']) {
    assert.throws(() => cnpgVersion(`registry.invalid:5000/postgresql${tag}@sha256:${'a'.repeat(64)}`), /CNPG/);
  }
});

for (const environment of ['exit-test', 'template']) test(`${environment}: rendered images pass CNPG validation and Rollout derives its abort deadline`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-cnpg-'));
  try {
    execFileSync(process.execPath, ['deploy/ci/render.mjs', environment, `example.invalid/console@sha256:${'a'.repeat(64)}`, dir], {cwd:root});
    const resources = yaml.loadAll(readFileSync(join(dir, 'app/resources.yaml'), 'utf8'));
    const rollout = resources.find(doc => doc.kind === 'Rollout');
    const config = JSON.parse(read(`deploy/clusters/${environment}/platform.json`));
    assert.equal(rollout.spec.progressDeadlineAbort, true);
    const deployment = resources.find(doc => doc.kind === rollout.spec.workloadRef.kind && doc.metadata.name === rollout.spec.workloadRef.name);
    const startupBudget = Math.max(...deployment.spec.template.spec.containers.map(c => c.startupProbe.failureThreshold * c.startupProbe.periodSeconds));
    assert.ok(rollout.spec.progressDeadlineSeconds >= startupBudget, 'emitted deadline must protect a healthy slow start');
    assert.ok(!('rolloutProgressDeadlineSeconds' in config), 'environments configure only a margin');
    assert.equal(rollout.spec.progressDeadlineSeconds, rolloutProgressDeadlineSeconds(rollout, resources, config.rolloutProgressDeadlineMarginSeconds));
    assert.ok(rollout.spec.progressDeadlineSeconds > (rollout.spec.minReadySeconds ?? 0), 'Argo requires the deadline to exceed minReadySeconds');
    const derivedDeadline = rolloutProgressDeadlineSeconds(rollout, resources, 0);
    assert.ok(derivedDeadline >= startupBudget, 'shared derivation must protect the rendered startup budget');
    assert.equal(rolloutProgressDeadlineSeconds(rollout, resources, 7), derivedDeadline + 7, 'environment policy supplies only the margin');
    const groups = environment === 'exit-test' ? ['database', 'tests/restore'] : ['database'];
    for (const group of groups) {
      const clusters = yaml.loadAll(readFileSync(join(dir, group, 'resources.yaml'), 'utf8')).filter(doc => doc.kind === 'Cluster');
      assert.equal(clusters.length, 1);
      assert.equal(clusters[0].spec.imageName, JSON.parse(read('deploy/versions.json')).images.postgres);
      cnpgVersion(clusters[0].spec.imageName);
    }
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('PLAT_ROLLOUT_DEADLINE: renderer refuses invalid margins and a legacy deadline below startup before writing output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-deadline-'));
  try {
    cpSync(join(root, 'deploy'), join(dir, 'deploy'), {recursive:true});
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
    const config = JSON.parse(read('deploy/clusters/exit-test/platform.json'));
    delete config.rolloutProgressDeadlineSeconds;
    for (const margin of [undefined, null, -1, -200, 1.5, '5', Number.MAX_SAFE_INTEGER]) {
      writeFileSync(join(dir, 'deploy/clusters/exit-test/platform.json'), JSON.stringify({...config, rolloutProgressDeadlineMarginSeconds:margin}));
      assert.throws(() => execFileSync(process.execPath, ['deploy/ci/render.mjs', 'exit-test', `example.invalid/console@sha256:${'a'.repeat(64)}`, 'out'], {cwd:dir,stdio:'pipe'}),
        error => error.status === 1 && error.stderr.toString().includes('PLAT_ROLLOUT_DEADLINE'));
      assert.equal(existsSync(join(dir, 'out')), false, 'invalid budgets must not leave a deployable artifact');
    }
    delete config.rolloutProgressDeadlineMarginSeconds;
    for (const margin of [undefined, 0]) {
      writeFileSync(join(dir, 'deploy/clusters/exit-test/platform.json'), JSON.stringify({...config, rolloutProgressDeadlineSeconds:60, rolloutProgressDeadlineMarginSeconds:margin}));
      assert.throws(() => execFileSync(process.execPath, ['deploy/ci/render.mjs', 'exit-test', `example.invalid/console@sha256:${'a'.repeat(64)}`, 'out'], {cwd:dir,stdio:'pipe'}),
        error => error.status === 1 && error.stderr.toString().includes('PLAT_ROLLOUT_DEADLINE'));
      assert.equal(existsSync(join(dir, 'out')), false);
    }
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('PLAT_ROLLOUT_DEADLINE: renderer refuses a deadline equal to minReadySeconds before writing output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-min-ready-'));
  try {
    cpSync(join(root, 'deploy'), join(dir, 'deploy'), {recursive:true});
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
    const path = join(dir, 'deploy/base/app/api.yaml');
    const docs = yaml.loadAll(readFileSync(path, 'utf8'));
    for (const container of docs.find(doc => doc.kind === 'Deployment').spec.template.spec.containers) {
      delete container.startupProbe;
      delete container.readinessProbe;
    }
    const rollout = docs.find(doc => doc.kind === 'Rollout');
    rollout.spec.minReadySeconds = 20;
    rollout.spec.strategy.canary.steps = [{setWeight:100}];
    writeFileSync(path, docs.map(doc => yaml.dump(doc)).join('---\n'));
    assert.throws(() => execFileSync(process.execPath, ['deploy/ci/render.mjs', 'exit-test', `example.invalid/console@sha256:${'a'.repeat(64)}`, 'out'], {cwd:dir,stdio:'pipe'}),
      error => error.status === 1 && error.stderr.toString().includes('PLAT_ROLLOUT_DEADLINE: progressDeadlineSeconds must exceed minReadySeconds'));
    assert.equal(existsSync(join(dir, 'out')), false, 'invalid Argo timing must not leave a deployable artifact');
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('renderer derives the deadline from changed manifest probes and the environment margin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-probe-budget-'));
  try {
    cpSync(join(root, 'deploy'), join(dir, 'deploy'), {recursive:true});
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
    const path = join(dir, 'deploy/base/app/api.yaml');
    const docs = yaml.loadAll(readFileSync(path, 'utf8'));
    const container = docs.find(doc => doc.kind === 'Deployment').spec.template.spec.containers[0];
    container.startupProbe.failureThreshold *= 2;
    container.readinessProbe.successThreshold = 3;
    writeFileSync(path, docs.map(doc => yaml.dump(doc)).join('---\n'));
    const config = JSON.parse(read('deploy/clusters/template/platform.json'));
    delete config.rolloutProgressDeadlineSeconds;
    config.rolloutProgressDeadlineMarginSeconds = 13;
    writeFileSync(join(dir, 'deploy/clusters/template/platform.json'), JSON.stringify(config));
    execFileSync(process.execPath, ['deploy/ci/render.mjs', 'template', `example.invalid/console@sha256:${'a'.repeat(64)}`, 'out'], {cwd:dir});
    const rendered = yaml.loadAll(readFileSync(join(dir, 'out/app/resources.yaml'), 'utf8'));
    const rollout = rendered.find(doc => doc.kind === 'Rollout');
    assert.equal(rollout.spec.progressDeadlineSeconds, rolloutProgressDeadlineSeconds(rollout, rendered, config.rolloutProgressDeadlineMarginSeconds));
    assert.ok(rollout.spec.progressDeadlineSeconds >= container.startupProbe.failureThreshold * container.startupProbe.periodSeconds);
  } finally { rmSync(dir, {recursive:true,force:true}); }
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
  assert.match(script, /VerificationError/);
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

for (const environment of ['exit-test','template']) test(`${environment}: rendered Barman mTLS secrets have certificate issuers and match the plugin contract`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-render-'));
  try {
    execFileSync(process.execPath, ['deploy/ci/render.mjs', environment, `example.invalid/console@sha256:${'a'.repeat(64)}`, dir], {cwd:root});
    const docs = yaml.loadAll(execFileSync('kustomize', ['build', join(dir,'platform')], {encoding:'utf8',maxBuffer:40*1024*1024})).filter(Boolean);
    const service = docs.find(doc=>doc.kind==='Service' && doc.metadata.name==='barman-cloud');
    const deployment = docs.find(doc=>doc.kind==='Deployment' && doc.metadata.name===service.metadata.name);
    for (const [role,usage] of [['Client','client auth'],['Server','server auth']]) {
      const secret = service.metadata.annotations[`cnpg.io/plugin${role}Secret`];
      const certificate = docs.find(doc=>doc.kind==='Certificate' && doc.metadata.namespace===service.metadata.namespace && doc.spec.secretName===secret);
      assert.ok(certificate, `${role} TLS Secret must be issued declaratively`);
      assert.ok(certificate.spec.usages.includes(usage));
      const issuer = docs.find(doc=>doc.kind===certificate.spec.issuerRef.kind && doc.metadata.name===certificate.spec.issuerRef.name && doc.metadata.namespace===certificate.metadata.namespace);
      assert.deepEqual(issuer?.spec.selfSigned, {});
      assert.ok(deployment.spec.template.spec.volumes.some(volume=>volume.secret?.secretName===secret));
      if (role==='Server') assert.ok(certificate.spec.dnsNames.includes(service.metadata.name));
    }
    assert.ok(deployment.spec.template.spec.containers[0].args.includes('--server-key=/server/tls.key'));
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('rendered object storage archives and restores WAL beyond the former two-volume ceiling', {timeout:180_000}, () => {
  mkdirSync('.tmp', {recursive:true});
  const dir = mkdtempSync(join(resolve('.tmp'), 'backup-capacity-'));
  const name = `platform-backup-${randomBytes(6).toString('hex')}`;
  const docker = args => execFileSync('docker', args, {encoding:'utf8',timeout:120_000,stdio:['pipe','pipe','pipe']});
  let networkCreated = false, containerCreated = false;
  try {
    execFileSync(process.execPath, ['deploy/ci/render.mjs', 'exit-test', `example.invalid/console@sha256:${'a'.repeat(64)}`, dir], {cwd:root});
    const docs = yaml.loadAll(readFileSync(join(dir, 'objects/resources.yaml'), 'utf8'));
    const deployment = docs.find(doc => doc.kind === 'Deployment');
    const container = deployment.spec.template.spec.containers[0];
    const job = docs.find(doc => doc.kind === 'Job').spec.template.spec.containers[0];
    const settings = docs.find(doc => doc.kind === 'ConfigMap').data;
    const store = yaml.loadAll(readFileSync(join(dir, 'database/resources.yaml'), 'utf8')).find(doc => doc.kind === 'ObjectStore');
    const endpoint = new URL(store.spec.configuration.endpointURL);
    assert.equal(new URL(store.spec.configuration.destinationPath).hostname, settings.bucket);
    const reconcile = yaml.loadAll(read('deploy/reconcile/kustomizations.yaml'));
    for (const [consumer, dependency] of [['console-objects','console-secrets'], ['console-database','console-objects']]) {
      assert.ok(reconcile.find(doc => doc.metadata.name === consumer).spec.dependsOn.some(ref => ref.name === dependency));
      assert.equal(reconcile.find(doc => doc.metadata.name === dependency).spec.wait, true);
    }
    const access = randomBytes(16).toString('hex'), secret = randomBytes(32).toString('hex');
    const auth = {identities:[{name:'fixture',credentials:[{accessKey:access,secretKey:secret}],actions:['Admin','Read','Write','List','Tagging']}]};
    mkdirSync(join(dir, 'auth'));
    writeFileSync(join(dir, 'auth/config.json'), JSON.stringify(auth));
    const capacity = docs.find(doc => doc.kind === 'PersistentVolumeClaim').spec.resources.requests.storage;
    assert.match(capacity, /^\d+Gi$/);
    docker(['network','create',name]); networkCreated = true;
    docker(['run','-d','--name',name,'--network',name,'--network-alias',endpoint.hostname,
      '--user',`${deployment.spec.template.spec.securityContext.runAsUser}`,'--read-only',
      '--tmpfs',`/data:uid=${deployment.spec.template.spec.securityContext.runAsUser},size=${capacity.replace('Gi','g')}`,
      '--tmpfs','/tmp','-w',container.workingDir,'-v',`${dir}/auth:/run/s3:ro`,
      '--entrypoint',container.command[0],container.image,...container.args]); containerCreated = true;
    // Run the rendered bootstrap command with the Job's retry budget; its first attempt can precede the filer.
    let bootstrap;
    for (let attempt = 0; attempt <= docs.find(doc => doc.kind === 'Job').spec.backoffLimit; attempt++) {
      bootstrap = spawnSync('docker', ['exec','-e',`BUCKET=${settings.bucket}`,name,...job.command,...job.args], {encoding:'utf8',timeout:15_000});
      if (bootstrap.status === 0) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
    assert.equal(bootstrap.status, 0, bootstrap.stdout + bootstrap.stderr);
    const lock = JSON.parse(read('deploy/versions.json'));
    const sidecar = Object.entries(lock.platformImages).find(([ref]) => ref.includes('/plugin-barman-cloud-sidecar:'))[1];
    const env = {AWS_ACCESS_KEY_ID:access,AWS_SECRET_ACCESS_KEY:secret,
      BACKUP_ENDPOINT:store.spec.configuration.endpointURL,BACKUP_DESTINATION:store.spec.configuration.destinationPath,
      BACKUP_COMPRESSION:store.spec.configuration.wal.compression};
    for (const item of store.spec.instanceSidecarConfiguration.env ?? []) env[item.name] = item.value;
    const result = spawnSync('docker', ['run','--rm','-i','--name',`${name}-client`,'--network',name,
      ...Object.entries(env).flatMap(([key,value]) => ['-e',`${key}=${value}`]),'--entrypoint','python3',sidecar,'-'], {
      encoding:'utf8',timeout:120_000,input:`import hashlib, os, pathlib, subprocess
payload = os.urandom(16 * 1024 * 1024)
digest = hashlib.sha256(payload).digest()
destination = os.environ['BACKUP_DESTINATION']
endpoint = ['--endpoint-url', os.environ['BACKUP_ENDPOINT']]
for index in range(1, 13):
    wal = pathlib.Path('/tmp/0000000100000000%08X' % index)
    wal.write_bytes(payload)
    subprocess.run(['barman-cloud-wal-archive', '--' + os.environ['BACKUP_COMPRESSION'], *endpoint, destination, 'console-db', str(wal)], check=True)
    wal.unlink()
    subprocess.run(['barman-cloud-wal-restore', *endpoint, destination, 'console-db', wal.name, str(wal)], check=True)
    assert hashlib.sha256(wal.read_bytes()).digest() == digest, 'restored WAL differs'
    wal.unlink()
    print('restored WAL', index, flush=True)
`,
    });
    const logs = spawnSync('docker', ['logs',name], {encoding:'utf8',timeout:10_000});
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${logs.stdout}\n${logs.stderr}`);
    assert.equal(result.stdout.trim().split('\n').length, 12, 'every archived WAL must be restored and compared');
  } finally {
    spawnSync('docker', ['rm','-f',`${name}-client`], {stdio:'ignore',timeout:10_000});
    if (containerCreated) spawnSync('docker', ['rm','-f',name], {stdio:'ignore',timeout:10_000});
    if (networkCreated) spawnSync('docker', ['network','rm',name], {stdio:'ignore',timeout:10_000});
    rmSync(dir, {recursive:true,force:true});
  }
});
