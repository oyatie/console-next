// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const kubectl=(...args)=>execFileSync('kubectl',args,{encoding:'utf8'});
assert.match(kubectl('config','current-context'),/^kind-platform-/);
const census=name=>{
  const cluster=JSON.parse(kubectl('get','cluster',name,'-n','console','-o','json'));
  return kubectl('exec','-n','console',cluster.status.currentPrimary,'-c','postgres','--','psql','-X','-U','postgres','-d','console','-At','-v','ON_ERROR_STOP=1','-c',"SELECT (SELECT count(*) FROM users)::text || ':' || (SELECT count(*) FROM _sqlx_migrations)::text").trim();
};
const before=census('console-db');assert.ok(Number(before.split(':')[0])>0,'restore must contain the synthetic account created through OTP');
execFileSync('flux',['create','kustomization','console-backup','--source=OCIRepository/console-deploy','--path=./tests/backup','--prune','--interval=1m']);
execFileSync('flux',['reconcile','kustomization','console-backup','--timeout=120s']);
kubectl('wait','--for=jsonpath={.status.phase}=completed','backup/console-exit-backup','-n','console','--timeout=600s');
execFileSync('flux',['create','kustomization','console-restore','--source=OCIRepository/console-deploy','--path=./tests/restore','--prune','--wait','--interval=1m','--timeout=8m']);
execFileSync('flux',['reconcile','kustomization','console-restore','--timeout=10m']);
kubectl('wait','--for=condition=Ready','cluster/console-restore','-n','console','--timeout=180s');
const after=census('console-restore');assert.equal(after,before,'synthetic users and migration lineage must survive S3 recovery');
writeFileSync('.tmp/evidence/restore.json',JSON.stringify({before,after,source:'console-db',recovered:'console-restore'},null,2));
