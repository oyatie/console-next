// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import yaml from 'js-yaml';

const root = resolve(process.env.PLATFORM_REPO_ROOT ?? '.');
const read = path => readFileSync(join(root, path), 'utf8');

test('every deploy healthCheckExprs expression uses has() with a field selection', () => {
  const invalid = [];
  for (const file of readdirSync(join(root, 'deploy'), {recursive:true}).filter(file => /\.ya?ml$/.test(file))) {
    for (const doc of yaml.loadAll(read(`deploy/${file}`)).filter(Boolean)) {
      for (const check of doc.spec?.healthCheckExprs ?? []) {
        for (const field of ['failed', 'inProgress', 'current']) {
          if (/\bhas\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s*\)/.test(check[field] ?? '')) invalid.push(`${file}: ${check.kind} ${field}: ${check[field]}`);
        }
      }
    }
  }
  assert.deepEqual(invalid, [], 'has() cannot check top-level identifiers; select a field instead');
});

for (const environment of ['exit-test', 'template']) test(`${environment}: the entire rendered bundle assigns every namespaced resource to a declared namespace`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-render-'));
  try {
    execFileSync(process.execPath, ['deploy/ci/render.mjs', environment, `example.invalid/console@sha256:${'a'.repeat(64)}`, dir], {cwd:root});
    const groups = readdirSync(dir, {recursive:true}).filter(file => file.endsWith('kustomization.yaml')).map(dirname);
    const docs = groups.flatMap(group => yaml.loadAll(execFileSync('kustomize', ['build', join(dir, group)], {encoding:'utf8',maxBuffer:40*1024*1024})).filter(Boolean));
    const namespaces = new Set(['default', 'kube-system', 'kube-public', 'kube-node-lease', ...docs.filter(d => d.kind === 'Namespace').map(d => d.metadata.name)]);
    const clusterScoped = new Set(['Namespace', 'CustomResourceDefinition', 'ClusterRole', 'ClusterRoleBinding', 'MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration', 'ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding']);
    const scopes = new Map(docs.filter(d => d.kind === 'CustomResourceDefinition').map(d => [`${d.spec.group}/${d.spec.names.kind}`, d.spec.scope]));
    const missing = [];
    for (const doc of docs) {
      const scope = scopes.get(`${doc.apiVersion.split('/')[0]}/${doc.kind}`);
      if (scope === 'Namespaced' || (scope !== 'Cluster' && !clusterScoped.has(doc.kind))) {
        if (!namespaces.has(doc.metadata.namespace)) missing.push(`${doc.kind}/${doc.metadata.name}: namespace must be explicit and declared`);
      }
      for (const subject of doc.subjects ?? []) if (subject.kind === 'ServiceAccount') assert.ok(namespaces.has(subject.namespace), `${doc.kind}/${doc.metadata.name}: ServiceAccount subject namespace`);
    }
    assert.deepEqual(missing, [], 'every rendered namespaced resource needs metadata.namespace');
    const cluster = yaml.loadAll(readFileSync(join(dir, 'database/resources.yaml'), 'utf8')).find(d => d.kind === 'Cluster');
    const bootstrap = cluster.spec.bootstrap.initdb.postInitSQL.join(';\n');
    const created = new Set([...bootstrap.matchAll(/CREATE ROLE (console_\w+)/g)].map(m => m[1]));
    created.add(cluster.spec.bootstrap.initdb.owner);
    for (const file of readdirSync(join(root, 'backend/crates/platform/db/migrations')).filter(f => f.endsWith('.sql'))) {
      const sql = read(`backend/crates/platform/db/migrations/${file}`).replace(/--[^\n]*/g, '');
      for (const match of sql.matchAll(/\b(?:GRANT|REVOKE)\b[^;]*?\b(?:TO|FROM)\s+(console_\w+(?:\s*,\s*console_\w+)*)\s*;/g)) {
        for (const role of match[1].split(/\s*,\s*/)) assert.ok(created.has(role), `${file}: bootstrap must create migration grantee ${role}`);
      }
    }
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('auth command custody stays dormant and unprivileged in bootstrap and managed roles', () => {
  const {spec} = yaml.load(read('deploy/base/database/cluster.yaml'));
  const create = spec.bootstrap.initdb.postInitSQL.find(sql => sql.startsWith('CREATE ROLE console_auth_cmd '));
  assert.ok(create, 'migration 0232 requires console_auth_cmd before migrations run');
  for (const flag of ['NOLOGIN', 'NOINHERIT', 'NOSUPERUSER', 'NOBYPASSRLS', 'NOCREATEDB', 'NOCREATEROLE', 'NOREPLICATION']) assert.ok(create.split(' ').includes(flag), flag);
  const role = spec.managed.roles.find(role => role.name === 'console_auth_cmd');
  for (const flag of ['login', 'inherit', 'superuser', 'bypassrls', 'createdb', 'createrole', 'replication']) assert.equal(role?.[flag], false, flag);
  assert.equal(role.passwordSecret, undefined);
  assert.equal(role.inRoles, undefined);
  assert.ok(!spec.managed.roles.some(role => role.inRoles?.includes('console_auth_cmd')));
});

function diagnostics(data, message) {
  const dir = mkdtempSync(join(tmpdir(), 'platform-diagnostics-'));
  try {
    writeFileSync(join(dir, 'kubectl'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('current-context')) console.log('kind-platform-fixture');
else if (args.includes('secrets')) console.log(JSON.stringify({items:[{data:JSON.parse(process.env.FIXTURE_SECRETS)}]}));
else if (args.includes('kustomizations')) console.log(JSON.stringify({items:[{metadata:{name:'console-root',namespace:'flux-system'},status:{conditions:[{type:'Ready',status:'False',reason:'ContainersNotReady',message:process.env.FIXTURE_MESSAGE}]}}]}));
else console.log(JSON.stringify({items:[]}));
`, {mode:0o755});
    const result = spawnSync(process.execPath, ['deploy/ci/diagnostics.mjs'], {cwd:root,encoding:'utf8',env:{...process.env,
      PATH:`${dir}:${process.env.PATH}`,FIXTURE_MESSAGE:message,
      FIXTURE_SECRETS:JSON.stringify(Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Buffer.from(value).toString('base64')]))),
    }});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  } finally { rmSync(dir, {recursive:true,force:true}); }
}

test('diagnostics preserve readiness and usernames while redacting long passwords', () => {
  const output = diagnostics({
    password:'sensitive-fixture-value', username:'console_rt', 'usage-bootstrap-authentication':'true',
    'usage-bootstrap-signing':'public-bootstrap-metadata',
    object:JSON.stringify({actions:['Admin','Read','Write','List','Tagging'],username:'public-console-username',
      'usage-bootstrap-signing':'nested-bootstrap-metadata',short:'public-info',password:'twelve-chars'}),
  }, 'console_rt public-console-username public-bootstrap-metadata nested-bootstrap-metadata public-info true sensitive-fixture-value twelve-chars');
  for (const value of ['Ready', 'ContainersNotReady', 'console_rt', 'public-console-username', 'public-bootstrap-metadata', 'nested-bootstrap-metadata', 'public-info', 'true']) assert.ok(output.includes(value), `preserve ${value}`);
  assert.match(output, /\[REDACTED\]/);
  assert.doesNotMatch(output, /sensitive-fixture-value|twelve-chars/);
});

test('diagnostics redact each long line of a multiline secret without erasing short state words', () => {
  const output = diagnostics({certificate:'certificate-line-one\nRead\ncertificate-line-two'}, 'first: certificate-line-one; second: certificate-line-two; Read');
  assert.match(output, /first: \[REDACTED\]; second: \[REDACTED\]; Read/);
  assert.doesNotMatch(output, /certificate-line-one|certificate-line-two/);
});

test('failure diagnostics precede deletion, redact secrets, and preserve the original exit despite diagnostic failures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-cleanup-'));
  try {
    mkdirSync(join(dir, 'deploy/ci'), {recursive:true});
    for (const file of ['exit-test.sh', 'diagnostics.mjs']) {
      if (existsSync(join(root, 'deploy/ci', file))) writeFileSync(join(dir, 'deploy/ci', file), read(`deploy/ci/${file}`));
    }
    writeFileSync(join(dir, 'cosign'), '#!/usr/bin/env bash\nexit 42\n', {mode:0o755});
    writeFileSync(join(dir, 'kind'), '#!/usr/bin/env bash\necho "kind $*" >> "$CALLS"\nexit 19\n', {mode:0o755});
    writeFileSync(join(dir, 'kubectl'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2), call = args.join(' ');
const quoted = 'quoted'+String.fromCharCode(34)+'secret';
fs.appendFileSync(process.env.CALLS, call+'\\n');
if (args.includes('current-context')) {console.log(process.env.FOREIGN_CONTEXT ? 'production' : 'kind-platform-fixture');process.exit();}
if (args.includes('helmreleases')) {console.error('API unavailable');process.exit(1);}
if (args.includes('secrets')) {if (process.env.NO_SECRETS) process.exit(1);console.log(JSON.stringify({items:[{data:{quoted:Buffer.from(quoted).toString('base64'),password:Buffer.from('sensitive-fixture-value').toString('base64'),url:Buffer.from('postgresql://fixture:embedded-password@db/console').toString('base64'),json:Buffer.from(JSON.stringify({nested:{key:'nested-secret'}})).toString('base64')}}]}));process.exit();}
if (args[0] === 'logs') {console.log('migration auth_command_role.missing_or_unsafe sensitive-fixture-value embedded-password nested-secret');console.log(JSON.stringify({message:quoted}));process.exit();}
if (args[0] === 'describe') {console.log('Name: fixture\\nStatus: Failed\\n    Environment:\\n      PASSWORD: sensitive-fixture-value');process.exit();}
const status = {phase:'Failed',conditions:[{type:'Ready',status:'False',reason:'ReconciliationFailed',message:'namespace not specified sensitive-fixture-value'}],containerStatuses:[{name:'migrate',ready:false,restartCount:1,state:{terminated:{exitCode:1,reason:'Error'}}}]};
console.log(JSON.stringify({items:[{kind:args[1],metadata:{name:'fixture',namespace:'console'},status,spec:{containers:[{name:'migrate',env:[{name:'PASSWORD',value:'sensitive-fixture-value'}]}]}}]}));
`, {mode:0o755});
    const env = {...process.env,PATH:`${dir}:${process.env.PATH}`,CALLS:join(dir,'calls'),RUNNER_TEMP:dir,GITHUB_REPOSITORY:'example/console',PLATFORM_WORKFLOW_IDENTITY:'fixture'};
    const run = extra => spawnSync('bash', ['deploy/ci/exit-test.sh'], {cwd:dir,env:{...env,...extra},encoding:'utf8'});
    const result = run({});
    assert.equal(result.status, 42, result.stderr);
    assert.match(result.stdout, /ReconciliationFailed/, 'print the reconciliation failure before cleanup');
    const evidence = readFileSync(join(dir, '.tmp/evidence/diagnostics.txt'), 'utf8');
    assert.match(evidence, /auth_command_role.missing_or_unsafe/);
    assert.match(evidence, /\[REDACTED\]/);
    assert.doesNotMatch(result.stdout + result.stderr + evidence, /sensitive-fixture-value|embedded-password|nested-secret|PASSWORD/);
    for (const value of ['quoted"secret', 'quoted\\"secret']) assert.ok(!(result.stdout + evidence).includes(value), 'redact JSON-escaped log values too');
    const calls = readFileSync(env.CALLS, 'utf8');
    for (const resource of ['kustomizations', 'helmreleases', 'events']) assert.ok(calls.includes(resource));
    assert.match(calls, /logs .*--previous/);
    assert.ok(calls.indexOf('logs ') < calls.indexOf('kind delete cluster'));
    assert.equal(calls.trim().split('\n').at(-1), 'kind delete cluster --name platform-exit-1');
    const unavailable = run({NO_SECRETS:'1'});
    assert.equal(unavailable.status, 42);
    assert.doesNotMatch(unavailable.stdout + unavailable.stderr, /sensitive-fixture-value/);
    assert.match(unavailable.stdout, /redaction unavailable/);
    writeFileSync(env.CALLS, '');
    const foreign = run({FOREIGN_CONTEXT:'1'});
    assert.equal(foreign.status, 42);
    assert.match(foreign.stdout, /no disposable platform context/);
    assert.doesNotMatch(readFileSync(env.CALLS, 'utf8'), /get secrets|logs |describe /);
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
