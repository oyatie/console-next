// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { matchesGlob } from 'node:path';
import policy from '../../.github/release-admission-policy.json' with {type:'json'};

// Gate names are the console-gates/v1 host contract, not GitHub check names.
const required = ['code-gates', 'api-compat', 'sbom', 'scan', 'smoke'];

export function classifyBake(changedPaths, longBakePaths) {
  const valid = paths => Array.isArray(paths) && paths.every(path =>
    typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.split('/').includes('..'));
  assert.ok(valid(changedPaths), 'Release gates need the complete change set');
  assert.ok(valid(longBakePaths) && longBakePaths.length > 0, 'Release gates need the release bake path policy');
  return changedPaths.some(path => longBakePaths.some(pattern => matchesGlob(path, pattern))) ? 'long' : 'normal';
}

// The collector supplies check runs grouped by gate; smoke needs both native architecture jobs.
export function buildPredicate({sha, gateChecks, changedPaths, longBakePaths, runUrl}) {
  assert.match(sha, /^(?!0{40}$)[a-f0-9]{40}$/, 'Release gates need a full nonzero candidate SHA');
  const url = new URL(runUrl);
  assert.ok(url.origin === 'https://github.com' && !url.search && !url.hash &&
    new RegExp(`^/${policy.repository}/actions/runs/[1-9][0-9]*(/attempts/[1-9][0-9]*)?$`).test(url.pathname),
  'Release gates need a workflow run URL from the admitted repository');
  const gates = required.map(name => {
    const checks = gateChecks && Object.hasOwn(gateChecks, name) ? gateChecks[name] : undefined;
    const pass = Array.isArray(checks) && checks.length === (name === 'smoke' ? 2 : 1) &&
      new Set(checks.map(check => check?.id)).size === checks.length && checks.every(check =>
        Number.isSafeInteger(check?.id) && check.id > 0 && check.head_sha === sha &&
        check.app?.id === policy.check_app_id && check.status === 'completed' && check.conclusion === 'success');
    return {name, result:pass ? 'pass' : 'fail'};
  });
  return {
    result:gates.every(gate => gate.result === 'pass') ? 'pass' : 'fail',
    predicate:{
      inputs:{backend:sha, web:sha}, gates,
      runner:{kind:'gha', url:runUrl}, approver:null,
      bake:classifyBake(changedPaths, longBakePaths),
    },
  };
}
