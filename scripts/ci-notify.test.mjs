// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import yaml from 'js-yaml';

const script = fileURLToPath(new URL('./ci-notify.mjs', import.meta.url));
function run(overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-notify-'));
  try {
    writeFileSync(path.join(root, 'gh'), `#!${process.execPath}\nconsole.log(JSON.stringify([{jobs:[{name:'db-tests (2)',conclusion:'failure',html_url:'https://example.com/job/2',steps:[{name:'Build',conclusion:'failure'}]},{name:'db-tests (1)',conclusion:'success',steps:[]}]}]));\n`, {mode: 0o755});
    writeFileSync(path.join(root, 'docker'), `#!${process.execPath}\nconst fs=require('node:fs'); const args=process.argv.slice(2); const mount=args[args.indexOf('-v')+1].split(':')[0]; fs.writeFileSync(process.env.CAPTURE,JSON.stringify({args,config:fs.readFileSync(mount+'/config','utf8'),mode:fs.statSync(mount+'/key.pem').mode&511})); process.exit(Number(process.env.DOCKER_STATUS||0));\n`, {mode: 0o755});
    const result = spawnSync(process.execPath, [script], {cwd: root, encoding: 'utf8', env: {...process.env,
      PATH: `${root}:${process.env.PATH}`, RUNNER_TEMP: root, CAPTURE: path.join(root, 'capture'),
      NOTIFY_TITLE: 'Database tests failed', NOTIFY_BODY: 'Run results', NOTIFY_DRY_RUN: 'true',
      NOTIFY_FAILED_JOBS: 'true', GITHUB_REPOSITORY: 'example/console', GITHUB_RUN_ID: '123',
      RUN_URL: 'https://example.com/run/123', ...overrides}});
    let payload, capture;
    try { payload = JSON.parse(readFileSync(path.join(root, '.cache/ci-alert/notification.json'), 'utf8')); } catch {}
    try { capture = JSON.parse(readFileSync(path.join(root, 'capture'), 'utf8')); } catch {}
    const credentialDirectory = capture?.args[capture.args.indexOf('-v') + 1].split(':')[0];
    return {...result, payload, capture, credentialsRemain: credentialDirectory && existsSync(credentialDirectory)};
  } finally { rmSync(root, {recursive: true, force: true}); }
}

test('failure dry run retains failed shard, step, run and artifact links without publishing', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.payload.body, /db-tests \(2\).*failure.*Build/);
  assert.match(result.payload.body, /https:\/\/example.com\/job\/2/);
  assert.match(result.payload.body, /https:\/\/example.com\/run\/123#artifacts/);
  assert.doesNotMatch(result.payload.body, /db-tests \(1\)/);
  assert.equal(result.capture, undefined);
});

test('publisher uses existing ONS adapter, private credentials and always removes them', () => {
  for (const status of [0, 37]) {
    const result = run({NOTIFY_DRY_RUN: 'false', OCI_CONFIG: '[DEFAULT]\nregion=example', OCI_API_KEY: 'private-key-fixture', ONS_TOPIC_ID: 'topic-fixture', DOCKER_STATUS: String(status)});
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.capture.mode, 0o600);
    assert.equal(result.credentialsRemain, false);
    assert.match(result.capture.config, /key_file=\/oci\/key.pem/);
    assert.ok(result.capture.args.includes('topic-fixture'));
    assert.ok(result.capture.args.includes(result.payload.body));
    assert.doesNotMatch(result.stdout + result.stderr, /private-key-fixture/);
  }
});

test('publisher refuses missing credentials and invalid dry-run values', () => {
  for (const overrides of [{NOTIFY_DRY_RUN: 'false', OCI_CONFIG: '', OCI_API_KEY: '', ONS_TOPIC_ID: ''}, {NOTIFY_DRY_RUN: 'invalid'}, {NOTIFY_BODY: ''}]) {
    const result = run(overrides);
    assert.equal(result.status, 1);
    assert.equal(result.capture, undefined);
  }
});

test('database alerts and availability alerts share the environment-scoped publisher', () => {
  const load = name => yaml.load(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
  const db = load('db-tests');
  assert.equal(db.jobs['alert-nightly'].uses, './.github/workflows/notify.yml');
  assert.match(db.jobs['alert-nightly'].if, /always\(\).*schedule.*alert_dry_run/);
  assert.equal(db.jobs['alert-nightly'].with['failed-jobs'], true);
  assert.equal(load('probe').jobs.notify.uses, './.github/workflows/notify.yml');
  const notify = load('notify').jobs.notify;
  assert.match(notify.environment, /inputs.dry-run.*probe/);
  assert.ok(notify.steps.some(step => step.run === 'node scripts/ci-notify.mjs'));
  assert.deepEqual(db.jobs['alert-nightly'].permissions, {contents: 'read', actions: 'read'});
});
