// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

export function normalize(base, candidate) {
  if (!base || !candidate || typeof base !== 'object' || typeof candidate !== 'object') return;
  if (!Array.isArray(base) && Array.isArray(base.enum) && !Object.hasOwn(base, 'x-extensible-enum') &&
      !Object.hasOwn(candidate, 'enum') && Array.isArray(candidate['x-extensible-enum'])) {
    base['x-extensible-enum'] = base.enum;
    delete base.enum;
  }
  for (const key of Object.keys(base)) if (Object.hasOwn(candidate, key)) normalize(base[key], candidate[key]);
}

const run = (bin, args) => execFileSync(bin, args, {encoding:'utf8', maxBuffer:64 * 1024 * 1024});
export function releasedBase(repository, directory, execute = run) {
  const deploy = `ghcr.io/${repository.toLowerCase()}/console-deploy`;
  let revision;
  try {
    execute('flux', ['pull', 'artifact', `oci://${deploy}:production`, `--output=${directory}`]);
    revision = JSON.parse(readFileSync(join(directory, 'revision.json'))).revision;
  } catch (error) {
    // Only an absent channel permits N-1 bootstrap; authentication and network failures remain failures.
    assert.match(String(error.stderr), /MANIFEST_UNKNOWN|manifest unknown|404|not found/i);
    execute('flux', ['pull', 'artifact', `oci://${deploy}:shadow`, `--output=${directory}`]);
    const {previousImage, image} = JSON.parse(readFileSync(join(directory, 'revision.json')));
    assert.match(previousImage ?? '', new RegExp(`^ghcr.io/${repository.toLowerCase()}/console@sha256:[a-f0-9]{64}$`));
    assert.notEqual(previousImage, image, 'N-1 must be a distinct image');
    const statements = execute('cosign', ['verify-attestation', '--type=https://slsa.dev/provenance/v1',
      '--certificate-oidc-issuer=https://token.actions.githubusercontent.com',
      `--certificate-identity=https://github.com/${repository}/.github/workflows/platform.yml@refs/heads/dev`, previousImage]);
    const envelopes = statements.trim().split('\n').flatMap(line => JSON.parse(line));
    const dependencies = envelopes.flatMap(envelope => {
      const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString());
      assert.ok(statement.subject.some(subject => subject.digest.sha256 === previousImage.split(':').at(-1)));
      return statement.predicate.buildDefinition.resolvedDependencies;
    }).filter(dep => dep.uri === `git+https://github.com/${repository}@refs/heads/dev`);
    const revisions = [...new Set(dependencies.map(dep => dep.digest.gitCommit))];
    assert.equal(revisions.length, 1, 'N-1 image needs one verified source revision');
    [revision] = revisions;
  }
  assert.match(revision ?? '', /^(?!0{40}$)[a-f0-9]{40}$/, 'Released API base needs a full revision');
  return revision;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, from, to] = process.argv.slice(2);
  const directory = mkdtempSync(join(tmpdir(), 'console-api-'));
  try {
    if (mode === 'base') console.log(releasedBase(process.env.GITHUB_REPOSITORY, directory));
    else {
      assert.equal(mode, 'compare');
      const stdin = from === '-' || to === '-' ? readFileSync(0, 'utf8') : '';
      const base = yaml.load(from === '-' ? stdin : readFileSync(from, 'utf8'));
      const candidate = yaml.load(to === '-' ? stdin : readFileSync(to, 'utf8'));
      normalize(base, candidate);
      for (const [name, spec] of [['base', base], ['candidate', candidate]]) writeFileSync(join(directory, `${name}.json`), JSON.stringify(spec));
      process.stdout.write(run('oasdiff', ['breaking', join(directory, 'base.json'), join(directory, 'candidate.json'), '--fail-on', 'ERR', '-f', 'singleline']));
    }
  } finally { rmSync(directory, {recursive:true, force:true}); }
}
