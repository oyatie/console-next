// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('VAP waits for enforcement after type checking, including a reapplied generation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-vap-'));
  try {
    execFileSync('mkdir', ['-p', join(dir,'.tmp/evidence')]);
    writeFileSync(join(dir,'kubectl'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('current-context')) { console.log('kind-platform-fixture'); process.exit(); }
if (args[0] === 'wait' && !args.includes('--for=jsonpath={.status.observedGeneration}=7')) process.exit(1);
if (args[0] === 'get') { console.log(JSON.stringify({metadata:{generation:7},status:{observedGeneration:7,typeChecking:{expressionWarnings:[]}}})); process.exit(); }
if (args[0] !== 'create') process.exit();
const pod = JSON.parse(fs.readFileSync(0,'utf8'));
const spec = pod.spec, c = spec.containers[0], sc = c.securityContext;
let code;
if (!c.image.includes('@sha256:')) code = 'PLAT_IMAGE_DIGEST';
else if (!spec.securityContext.runAsNonRoot) code = 'PLAT_NON_ROOT';
else if (!sc.readOnlyRootFilesystem) code = 'PLAT_READ_ONLY';
else if (!c.resources.limits) code = 'PLAT_RESOURCES';
else if (spec.volumes) code = 'PLAT_HOST_PATH';
else if (sc.allowPrivilegeEscalation) code = 'PLAT_PRIVILEGE';
else if (spec.hostNetwork) code = 'PLAT_HOST_NAMESPACE';
else if (spec.securityContext.seccompProfile.type !== 'RuntimeDefault') code = 'PLAT_SECCOMP';
if (!code) process.exit();
let attempts = 0;
try { attempts = Number(fs.readFileSync(process.env.CALLS,'utf8')); } catch {}
fs.writeFileSync(process.env.CALLS, String(attempts+1));
if (attempts < 2) process.exit(); // Type checking is ready before admission enforcement.
console.error(code); process.exit(1);
`, {mode:0o755});
    const script = resolve(process.env.PLATFORM_REPO_ROOT ?? '.', 'deploy/ci/admission.mjs');
    const result = spawnSync(process.execPath,[script], {cwd:dir,env:{...process.env,PATH:`${dir}:${process.env.PATH}`,CALLS:join(dir,'attempts')},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.ok(Number(readFileSync(join(dir,'attempts'),'utf8')) >= 11);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
