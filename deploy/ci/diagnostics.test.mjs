// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(process.env.PLATFORM_REPO_ROOT ?? '.');
function diagnostics(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'canary-diagnostics-'));
  try {
    writeFileSync(join(dir, 'kubectl'), `#!/usr/bin/env node
const fs = require('node:fs'), http = require('node:http');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args)+'\\n');
if (args.includes('current-context')) console.log('kind-platform-fixture');
else if (args[0] === 'port-forward') {
  if (process.env.FORWARD_FAIL) process.exit(1);
  const healthy = args.includes('pod/console-api-stable');
  const body = {status:healthy?'ready':'not_ready', write_ready:false, service:'fixture-secret-value', role:'api',
    database:'ready', leave_command_database:'not_configured', ontology_command_database:'unreachable', platform_force_command_database:'ready'};
  const server = http.createServer((req, res) => {
    fs.appendFileSync(process.env.CALLS, JSON.stringify({path:req.url})+'\\n');
    res.writeHead(healthy?200:503, {'Content-Type':'application/json'}); res.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1', () => console.log('Forwarding from 127.0.0.1:'+server.address().port+' -> 8080'));
} else if (args[1] === 'secrets') {
  if (process.env.NO_SECRETS) process.exit(1);
  console.log(JSON.stringify({items:[{data:{password:Buffer.from('fixture-secret-value').toString('base64'), label:Buffer.from('not_configured').toString('base64')}}]}));
} else if (args[1] === 'pods') console.log(JSON.stringify({items:['console-api-stable','console-api-canary','console-worker'].map((name,i)=>({
  metadata:{name, namespace:'console', labels:{app:i===2?'console-worker':'console-api'}},
  spec:{containers:[{name:'console', ports:[{name:'http',containerPort:8080}], readinessProbe:{httpGet:{path:'/readyz',port:'http'}}}]},
  status:{phase:'Running',containerStatuses:[{name:'console',ready:i!==1,restartCount:0}]},
}))}));
else if (args[1] === 'analysisruns') console.log(JSON.stringify({items:[{metadata:{name:'canary-analysis',namespace:'console'},status:{phase:'Error',metricResults:[{
  name:'canary-ready',phase:'Error',error:5,measurements:[{phase:'Error',message:'lookup console-api-canary: no such host fixture-secret-value'}],
}]}}]}));
else console.log(JSON.stringify({items:[]}));
`, {mode:0o755});
    const result = spawnSync(process.execPath, ['deploy/ci/diagnostics.mjs'], {cwd:root,encoding:'utf8',timeout:30_000,
      env:{...process.env,PATH:`${dir}:${process.env.PATH}`,CALLS:join(dir,'calls'),...env}});
    assert.equal(result.status, 0, result.stderr);
    return {output:result.stdout, records:result.stdout.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line)),
      calls:readFileSync(join(dir,'calls'),'utf8').trim().split('\n').map(line=>JSON.parse(line))};
  } finally { rmSync(dir, {recursive:true,force:true}); }
}

test('diagnostics capture the 503 readyz body, healthy API pods, and AnalysisRun measurements', () => {
  const {records,output,calls} = diagnostics();
  const ready = records.filter(record=>record.resource==='readyz');
  assert.deepEqual(ready.map(record=>[record.name,record.httpStatus,record.body.status]), [
    ['console-api-stable',200,'ready'],['console-api-canary',503,'not_ready'],
  ]);
  for (const record of ready) {
    assert.equal(record.body.leave_command_database, 'not_configured', 'status labels survive secret collisions');
    assert.equal(record.body.ontology_command_database, 'unreachable');
    assert.equal(record.body.service, '[REDACTED]');
  }
  const metric = records.find(record=>record.resource==='analysisruns').metricResults[0];
  assert.equal(metric.error, 5);
  assert.equal(metric.measurements[0].message, 'lookup console-api-canary: no such host [REDACTED]');
  assert.equal(calls.filter(call=>call.path==='/readyz').length, 2);
  assert.equal(calls.filter(call=>call[0]==='port-forward').length, 2);
  assert.doesNotMatch(output, /fixture-secret-value/);
});

test('diagnostics keep collecting when a pod cannot be forwarded', () => {
  const {records} = diagnostics({FORWARD_FAIL:'1'});
  assert.equal(records.filter(record=>record.resource==='readyz' && record.error).length, 2);
  assert.ok(records.some(record=>record.resource==='analysisruns'));
});

test('diagnostics preserve readiness labels but suppress free text without a secret inventory', () => {
  const {records,output} = diagnostics({NO_SECRETS:'1'});
  const ready = records.find(record=>record.resource==='readyz' && record.httpStatus===503);
  assert.equal(ready?.body.status, 'not_ready');
  assert.equal(ready.body.leave_command_database, 'not_configured');
  assert.equal(ready.body.service, undefined);
  assert.doesNotMatch(output, /fixture-secret-value|no such host/);
});

function backupDiagnostics(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'backup-diagnostics-'));
  try {
    writeFileSync(join(dir, 'kubectl'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args)+'\\n');
if (args.includes('current-context')) console.log('kind-platform-fixture');
else if (args[1] === 'secrets') {
  if (process.env.NO_SECRETS) process.exit(1);
  console.log(JSON.stringify({items:[{data:{password:Buffer.from('fixture-backup-secret').toString('base64')}}]}));
} else if (args[0] === 'logs') {
  if (process.env.LOG_FAIL) process.exit(1);
  console.log('barman: object-store connection refused fixture-backup-secret');
} else if (args[1] === 'backups.postgresql.cnpg.io') {
  if (process.env.NO_BACKUP_API) process.exit(1);
  console.log(JSON.stringify({items:[{metadata:{name:'console-exit-backup',namespace:'console'},
    spec:{unsafe:'spec-must-stay-private'},status:{phase:'failed',backupId:'fixture-backup-id',
      startedAt:'2026-10-29T18:19:50Z',stoppedAt:'2026-10-29T18:24:25Z',
      error:'backup failed fixture-backup-secret',commandError:'S3 connection refused fixture-backup-secret',
      unsafe:'status-must-stay-private',conditions:[{type:'Completed',status:'False',reason:'BackupFailed',message:'fixture-backup-secret'}]}}]}));
} else if (['certificates.cert-manager.io','issuers.cert-manager.io'].includes(args[1])) {
  console.log(JSON.stringify({items:(args[1].startsWith('certificates') ? ['barman-cloud-client','barman-cloud-server'] : ['selfsigned-issuer'])
    .map(name=>({metadata:{name,namespace:'cnpg-system'},status:{conditions:[{type:'Ready',status:'False',reason:'SecretMissing',message:'issuer unavailable fixture-backup-secret'}]}}))}));
} else if (args[1] === 'pods') console.log(JSON.stringify({items:[
  {name:'database',namespace:'console',labels:{'cnpg.io/cluster':'console-db'},sidecar:true},
  {name:'barman',namespace:'cnpg-system'},
  {name:'objects',namespace:'console',labels:{app:'console-objects'}},
  {name:'unrelated',namespace:'console'},
].map(pod=>({metadata:pod,spec:{containers:[{name:'main'}],
  ...(pod.sidecar ? {initContainers:[{name:'plugin-barman-cloud',restartPolicy:'Always'}]} : {})},
  status:{phase:'Running',containerStatuses:[{name:'main',ready:true,restartCount:0}],
    ...(pod.sidecar ? {initContainerStatuses:[{name:'plugin-barman-cloud',ready:true,restartCount:1}]} : {})}}))}));
else console.log(JSON.stringify({items:[]}));
`, {mode:0o755});
    const result = spawnSync(process.execPath, ['deploy/ci/diagnostics.mjs'], {cwd:root,encoding:'utf8',timeout:30_000,
      env:{...process.env,PATH:`${dir}:${process.env.PATH}`,CALLS:join(dir,'calls'),...env}});
    assert.equal(result.status, 0, result.stderr);
    return {output:result.stdout,records:result.stdout.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line)),
      calls:readFileSync(join(dir,'calls'),'utf8').trim().split('\n').map(line=>JSON.parse(line))};
  } finally { rmSync(dir, {recursive:true,force:true}); }
}

test('backup diagnostics report phase, failure details and certificate/issuer readiness without specs', () => {
  const {records,output} = backupDiagnostics();
  const backup = records.find(record=>record.resource==='backups.postgresql.cnpg.io');
  assert.equal(backup?.phase, 'failed');
  assert.equal(backup.backupId, 'fixture-backup-id');
  assert.equal(backup.startedAt, '2026-10-29T18:19:50Z');
  assert.equal(backup.stoppedAt, '2026-10-29T18:24:25Z');
  assert.equal(backup.error, 'backup failed [REDACTED]');
  assert.equal(backup.commandError, 'S3 connection refused [REDACTED]');
  assert.equal(backup.conditions[0].reason, 'BackupFailed');
  const certificates = records.filter(record=>record.resource==='certificates.cert-manager.io');
  assert.deepEqual(certificates.map(record=>record.name), ['barman-cloud-client','barman-cloud-server']);
  for (const certificate of certificates) assert.deepEqual(certificate.conditions, [
    {type:'Ready',status:'False',reason:'SecretMissing',message:'issuer unavailable [REDACTED]'},
  ]);
  assert.equal(records.find(record=>record.resource==='issuers.cert-manager.io')?.name, 'selfsigned-issuer');
  assert.doesNotMatch(output, /fixture-backup-secret|must-stay-private/);
});

test('backup diagnostics collect healthy database, restarted sidecar, plugin and object-store logs', () => {
  const {calls,output} = backupDiagnostics();
  const logs = calls.filter(call=>call[0]==='logs');
  for (const pod of ['database','barman','objects']) assert.ok(logs.some(call=>call[1]===pod), pod);
  assert.ok(logs.some(call=>call[1]==='database' && call.includes('plugin-barman-cloud') && call.includes('--previous')));
  assert.ok(!logs.some(call=>call[1]==='unrelated'));
  assert.ok(logs.every(call=>call.includes('--tail=100') && call.includes('--request-timeout=10s')));
  assert.match(output, /barman: object-store connection refused \[REDACTED\]/);
  assert.doesNotMatch(output, /fixture-backup-secret/);
});

test('backup diagnostics suppress error text and logs when secret inventory is unavailable', () => {
  const {records,calls,output} = backupDiagnostics({NO_SECRETS:'1'});
  const backup = records.find(record=>record.resource==='backups.postgresql.cnpg.io');
  assert.equal(backup?.phase, 'failed');
  assert.equal(backup.error, undefined);
  assert.equal(backup.commandError, undefined);
  assert.equal(backup.conditions[0].reason, 'BackupFailed');
  assert.equal(backup.conditions[0].message, undefined);
  assert.ok(!calls.some(call=>call[0]==='logs'));
  assert.doesNotMatch(output, /fixture-backup-secret|S3 connection refused|issuer unavailable/);
});

test('backup diagnostics keep certificate evidence when the Backup API or pod logs fail', () => {
  const {records,output} = backupDiagnostics({NO_BACKUP_API:'1',LOG_FAIL:'1'});
  assert.match(output, /backups.postgresql.cnpg.io: unavailable \(exit 1\)/);
  assert.ok(records.some(record=>record.resource==='certificates.cert-manager.io'));
  assert.match(output, /logs console\/database\/plugin-barman-cloud previous \(exit 1\)/);
});
