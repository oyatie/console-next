// SPDX-License-Identifier: LicenseRef-Proprietary
// Persist N-1 at publication time; deploy-only releases keep the last distinct image.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { registryAPI } from '../../scripts/ghcr-retention.mjs';

const [file, previousFile] = process.argv.slice(2);
const revision = JSON.parse(readFileSync(file));
const previous = JSON.parse(readFileSync(previousFile));
const repository = revision.image.split('@')[0];
function validate(image) {
  assert.ok(typeof image === 'string' && image.split('@').length === 2 && image.split('@')[0] === repository &&
    /^sha256:[a-f0-9]{64}$/.test(image.split('@')[1]), 'PLAT_PREVIOUS_RELEASE: invalid published image');
  return image;
}
validate(revision.image);
const recorded = [previous.image, previous.previousImage].filter(image => image != null).map(validate);
let previousImage = recorded.find(image => image !== revision.image) ?? null;

// Older artifacts recorded only the immediately previous push, which may have identical bytes.
if (!previousImage && previous.image) {
  const deploy = process.env.DEPLOY;
  assert.ok(deploy?.startsWith('ghcr.io/'), 'PLAT_PREVIOUS_RELEASE: deploy repository required');
  const versions = await registryAPI({repository:process.env.GITHUB_REPOSITORY})
    .versions(deploy.split('/').slice(2).join('/'));
  for (const version of versions) {
    assert.ok(/^sha256:[a-f0-9]{64}$/.test(version.name) && Number.isFinite(Date.parse(version.created_at)),
      'PLAT_PREVIOUS_RELEASE: invalid registry history');
  }
  versions.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  for (const version of versions) {
    const reference = `${deploy}@${version.name}`;
    const manifest = JSON.parse(execFileSync('buildx', ['imagetools', 'inspect', reference, '--raw'], {encoding:'utf8'}));
    // Flux writes this annotation; signatures and attestations are not deploy snapshots.
    if (!manifest.annotations?.['org.opencontainers.image.revision']) continue;
    const directory = mkdtempSync(join(dirname(file), 'previous-release-'));
    try {
      execFileSync('flux', ['pull', 'artifact', `oci://${reference}`, `--output=${directory}`], {stdio:'pipe'});
      const image = validate(JSON.parse(readFileSync(join(directory, 'revision.json'))).image);
      if (image === revision.image) continue;
      previousImage = image;
      break;
    } finally { rmSync(directory, {recursive:true,force:true}); }
  }
}
if (previousImage) {
  execFileSync('cosign', ['verify', '--certificate-oidc-issuer=https://token.actions.githubusercontent.com',
    `--certificate-identity=${process.env.PLATFORM_WORKFLOW_IDENTITY}`, previousImage], {stdio:'pipe'});
}
writeFileSync(file, JSON.stringify({...revision, previousImage}, null, 2)+'\n');
