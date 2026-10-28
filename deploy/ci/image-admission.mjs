// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { pod } from './fixtures.mjs';
assert.match(execFileSync('kubectl',['config','current-context'],{encoding:'utf8'}),/^kind-platform-/);
const revision=JSON.parse(readFileSync('.tmp/exit-bundle/revision.json'));
const pullSecret=process.env.PLATFORM_PULL_SECRET;
assert.ok(pullSecret, 'PLAT_REGISTRY: a run-scoped image pull secret is required');
const check = image => {
  const fixture=pod();fixture.metadata={name:'console-signature-test',namespace:'console'};
  fixture.spec.containers[0].image=image;
  fixture.spec.imagePullSecrets=[{name:pullSecret}];
  const result=spawnSync('kubectl',['create','--dry-run=server','-f','-'],{input:JSON.stringify(fixture),encoding:'utf8'});
  assert.doesNotMatch(result.stderr,/UNAUTHORIZED|authentication required|DENIED:|FORBIDDEN|MANIFEST_UNKNOWN|NAME_UNKNOWN|no such host|connection refused|context deadline exceeded|i\/o timeout|TLS handshake timeout|(?:unexpected status|status code).*\b(?:401|403|404|429|5\d\d)\b/i,
    'PLAT_IMAGE_REGISTRY: registry access failed; signature refusal was not proven');
  return result;
};
const positive=check(revision.image);assert.equal(positive.status,0,positive.stderr);
assert.match(revision.unsignedImage??'',/@sha256:[a-f0-9]{64}$/,'publisher must supply an actually unsigned image');
const negative=check(revision.unsignedImage);assert.notEqual(negative.status,0,'PLAT_UNSIGNED_IMAGE: unsigned image was admitted');
assert.match(negative.stderr,/policy\.sigstore\.dev/);
assert.match(negative.stderr,/no matching signatures|failed to verify|no signatures found|no valid bundles exist in registry|verification failed/i);
writeFileSync('.tmp/evidence/unsigned-image.txt',negative.stderr);
assert.match(revision.wrongIdentityImage??'',/@sha256:[a-f0-9]{64}$/,'publisher must supply an image signed by the other workflow');
const identity=process.env.PLATFORM_WORKFLOW_IDENTITY;
assert.ok(identity?.includes('/platform.yml@'), 'the expected workflow identity must be supplied');
const signature=execFileSync('cosign',['verify','--certificate-oidc-issuer=https://token.actions.githubusercontent.com',`--certificate-identity=${identity.replace('/platform.yml@','/platform-negative-signer.yml@')}`,revision.wrongIdentityImage]);
writeFileSync('.tmp/evidence/wrong-image-signature.json',signature);
const wrong=check(revision.wrongIdentityImage);
assert.notEqual(wrong.status,0,'PLAT_IMAGE_IDENTITY: image signed by a different identity was admitted');
assert.match(wrong.stderr,/policy\.sigstore\.dev/);
assert.match(wrong.stderr,/failed to verify certificate identity|no matching CertificateIdentity found/i,'PLAT_IMAGE_IDENTITY: certificate identity refusal was not proven');
writeFileSync('.tmp/evidence/wrong-image-identity.txt',wrong.stderr);
