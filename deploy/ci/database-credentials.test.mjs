// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { test } from 'node:test';
import yaml from 'js-yaml';

const root = resolve(process.env.PLATFORM_REPO_ROOT ?? '.');
const required = {
  api: ['DATABASE_URL', 'LEAVE_COMMAND_DATABASE_URL', 'ONTOLOGY_COMMAND_DATABASE_URL', 'PLATFORM_FORCE_COMMAND_DATABASE_URL'],
  worker: ['DATABASE_URL', 'PLATFORM_FORCE_COMMAND_DATABASE_URL'],
  migrate: ['DATABASE_URL'],
};

function synthetic() {
  const dir = mkdtempSync(join(tmpdir(), 'platform-credentials-'));
  try {
    writeFileSync(join(dir, 'kubectl'), `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('current-context')) console.log('kind-platform-fixture');
else fs.appendFileSync(process.env.SECRET_MANIFESTS, fs.readFileSync(0, 'utf8')+'\\n');
`, {mode:0o755});
    const manifests = join(dir, 'secrets.jsonl');
    execFileSync(process.execPath, ['deploy/ci/synthetic.mjs'], {cwd:root,env:{...process.env,PATH:`${dir}:${process.env.PATH}`,SECRET_MANIFESTS:manifests}});
    return readFileSync(manifests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  } finally { rmSync(dir, {recursive:true,force:true}); }
}

for (const environment of ['exit-test', 'template']) test(`${environment}: every role's required database settings resolve through its mounted secret`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-database-render-'));
  try {
    execFileSync(process.execPath, ['deploy/ci/render.mjs', environment, `example.invalid/console@sha256:${'a'.repeat(64)}`, dir], {cwd:root});
    const docs = ['app', 'migrate', 'secrets'].flatMap(group => yaml.loadAll(readFileSync(join(dir, group, 'resources.yaml'), 'utf8')).filter(Boolean));
    const secrets = environment === 'exit-test' ? synthetic() : docs.filter(doc => doc.kind === 'ExternalSecret');
    for (const [role, settings] of Object.entries(required)) {
      const pod = docs.find(doc => doc.spec?.template?.spec?.containers?.some(c => c.env?.some(e => e.name === 'CONSOLE_APP_ROLE' && e.value === role))).spec.template.spec;
      const container = pod.containers.find(c => c.name === 'console');
      for (const setting of settings) {
        assert.ok(!container.env.some(e => e.name === setting), `${role}: ${setting} must stay out of the container environment`);
        const file = container.env.find(e => e.name === `${setting}_FILE`)?.value;
        assert.ok(file, `${role}: missing ${setting}_FILE`);
        const mount = container.volumeMounts.find(m => file.startsWith(`${m.mountPath}/`));
        assert.equal(mount?.readOnly, true, `${role}: secret mount is read only`);
        const volume = pod.volumes.find(v => v.name === mount.name);
        assert.equal(posix.relative(mount.mountPath, file), setting);
        const secret = secrets.find(s => (s.spec?.target.name ?? s.metadata.name) === volume.secret.secretName);
        assert.ok(secret, `${role}: mounted secret is supplied`);
        if (environment === 'exit-test') assert.ok(secret.stringData[setting], `${role}: synthetic secret supplies ${setting}`);
        else {
          const entry = secret.spec.data.find(e => e.secretKey === setting);
          assert.equal(entry?.remoteRef.property, setting, `${role}: external secret supplies ${setting}`);
          const config = JSON.parse(readFileSync(join(root, 'deploy/clusters/template/platform.json')));
          assert.equal(entry.remoteRef.key, `${config.externalSecretPrefix}/${role}`);
        }
      }
    }
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('synthetic database credentials match managed role secrets for api, worker and migrate', () => {
  const secrets = synthetic();
  const cluster = yaml.load(readFileSync(join(root, 'deploy/base/database/cluster.yaml'), 'utf8'));
  for (const [role, settings] of Object.entries(required)) {
    const secret = secrets.find(s => s.metadata.name === `console-${role}`);
    const passwords = new Set();
    for (const setting of settings) {
      assert.ok(secret.stringData[setting], `${role}: synthetic secret supplies ${setting}`);
      const url = new URL(secret.stringData[setting]);
      const databaseRole = cluster.spec.managed.roles.find(r => r.name === url.username);
      const login = secrets.find(s => s.metadata.name === databaseRole?.passwordSecret?.name);
      assert.equal(databaseRole?.login, true);
      assert.equal(login?.stringData.username, url.username);
      assert.ok(login?.stringData.password === url.password, `${role}: credentials match the managed login`);
      assert.equal(passwords.has(url.password), false, `${role}: database logins have separate passwords`);
      passwords.add(url.password);
    }
  }
  const api = secrets.find(s => s.metadata.name === 'console-api').stringData;
  const worker = secrets.find(s => s.metadata.name === 'console-worker').stringData;
  assert.equal(new URL(worker.DATABASE_URL).username, 'console_rt');
  assert.equal(new URL(worker.PLATFORM_FORCE_COMMAND_DATABASE_URL).username, 'console_platform_force_cmd');
  assert.ok(worker.PLATFORM_FORCE_COMMAND_DATABASE_URL === api.PLATFORM_FORCE_COMMAND_DATABASE_URL, 'both roles use the managed force-command credentials');
});

test('app readiness waits for completed migrations and probes the database-backed ready endpoint', () => {
  const docs = yaml.loadAll(readFileSync(join(root, 'deploy/reconcile/kustomizations.yaml'), 'utf8'));
  const migrate = docs.find(d => d.metadata.name === 'console-migrate');
  const app = docs.find(d => d.metadata.name === 'console-app');
  assert.equal(migrate.spec.wait, true);
  assert.ok(migrate.spec.dependsOn.some(d => d.name === 'console-database'));
  assert.equal(app.spec.wait, true);
  assert.ok(app.spec.dependsOn.some(d => d.name === migrate.metadata.name));
  for (const file of ['api', 'worker']) {
    const deployment = yaml.loadAll(readFileSync(join(root, `deploy/base/app/${file}.yaml`), 'utf8')).find(d => d.kind === 'Deployment');
    assert.equal(deployment.spec.template.spec.containers[0].readinessProbe.httpGet.path, '/readyz');
  }
});
