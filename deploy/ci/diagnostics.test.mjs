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
