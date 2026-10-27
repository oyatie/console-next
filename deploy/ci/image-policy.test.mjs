// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import yaml from 'js-yaml';

const root = resolve(process.env.PLATFORM_REPO_ROOT ?? '.');
const lock = JSON.parse(readFileSync(join(root, 'deploy/versions.json')));
const image = `example.invalid/console@sha256:${'a'.repeat(64)}`;
// policy-controller v0.15.1 pkg/apis/glob: name.ParseReference normalizes Docker Hub and drops digest references' tags.
const canonical = ref => ref.replace(/:[^/:@]+(?=@)/, '').replace(/^docker\.io\//, 'index.docker.io/');
const matches = (glob, ref) => new RegExp(`^${glob.replaceAll('.', '\\.').replaceAll('**', '#').replaceAll('*', '[^/]*').replaceAll('#', '.*')}$`).test(canonical(ref));

function images(value) {
  if (!value || typeof value !== 'object') return [];
  const found = [...(value.containers ?? []), ...(value.initContainers ?? []), ...(value.ephemeralContainers ?? [])].map(c => c.image);
  if (value.imageName) found.push(value.imageName);
  if (value.SIDECAR_IMAGE) found.push(value.SIDECAR_IMAGE);
  if (['SIDECAR_IMAGE', 'OPERATOR_IMAGE_NAME'].includes(value.name) && value.value) found.push(value.value);
  return [...found, ...Object.values(value).flatMap(images)];
}

function coverage(refs, policies) {
  return [...new Set(refs)].filter(ref => !policies.some(p => p.spec.images.some(({glob}) => matches(glob, ref))));
}

function checkSubjectTags(versions, catalog) {
  for (const [repository, {authority}] of Object.entries(catalog)) {
    for (const {subject} of authority.keyless?.identities ?? []) {
      const [workflow, tag] = subject.split('@refs/tags/');
      if (!tag) continue;
      const locked = Object.entries({...versions.images, ...versions.platformImages}).filter(([, ref]) => ref.split('@')[0] === repository);
      assert.ok(locked.length, `tagged subject has no locked image: ${repository}`);
      for (const [original] of locked) {
        const version = versions.signingWorkflows?.[workflow] ?? (versions.upstreamImages?.[original] ?? original).split(':').at(-1);
        assert.equal(tag.replace(/^v/, ''), version.replace(/^v/, ''), `subject tag must match versions.json: ${repository}`);
      }
    }
  }
}

test('every keyless subject tag matches versions.json and stale tags are detected', () => {
  const catalog = yaml.load(readFileSync(join(root, 'deploy/policies/upstream.yaml'), 'utf8'));
  checkSubjectTags(lock, catalog);
  let checked = 0;
  for (const [repository, {authority}] of Object.entries(catalog)) {
    for (const [index, {subject}] of (authority.keyless?.identities ?? []).entries()) {
      if (!subject.includes('@refs/tags/')) continue;
      const stale = structuredClone(catalog);
      stale[repository].authority.keyless.identities[index].subject = subject.replace(/@refs\/tags\/.+$/, '@refs/tags/v0.0.0-stale');
      assert.throws(() => checkSubjectTags(lock, stale), /subject tag must match versions.json/);
      checked++;
    }
  }
  assert.ok(checked > 0, 'exercise tagged keyless subjects');
});

test('coverage detects missing policies for nested init containers and canonical Docker Hub names', () => {
  const ref = lock.images.seaweed;
  const pod = {spec:{jobTemplate:{spec:{template:{spec:{initContainers:[{image:ref}]}}}}}};
  assert.deepEqual(images(pod), [ref]);
  assert.deepEqual(coverage(images(pod), [{spec:{images:[{glob:ref}]}}]), [ref]);
  assert.deepEqual(coverage(images(pod), [{spec:{images:[{glob:canonical(ref)}]}}]), []);
  assert.deepEqual(coverage(images(pod), []), [ref]);
});

test('tagged digest images match the exact digest policy after admission normalization', () => {
  const ref = `registry.invalid:5000/postgresql:18.6@sha256:${'a'.repeat(64)}`;
  const digest = ref.replace(':18.6@', '@');
  assert.equal(canonical(ref), digest, 'keep registry ports while removing the tag');
  assert.deepEqual(coverage([ref], [{spec:{images:[{glob:ref}]}}]), [ref]);
  assert.deepEqual(coverage([ref], [{spec:{images:[{glob:digest}]}}]), []);
  assert.deepEqual(coverage([ref.replace(/a{64}$/, 'b'.repeat(64))], [{spec:{images:[{glob:digest}]}}]), [ref.replace(/a{64}$/, 'b'.repeat(64))]);
});

for (const name of ['seaweed', 'rust']) for (const [replacement, code] of [
  ['example.invalid/unreviewed@sha256:' + 'b'.repeat(64), 'PLAT_IMAGE_AUTHORITY'],
  ['docker.io/chrislusf/seaweedfs:latest', 'PLAT_IMAGE_DIGEST'],
]) test(`${code}: renderer refuses an unreviewed ${name} reference even if unused`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-authority-'));
  try {
    cpSync(join(root, 'deploy'), join(dir, 'deploy'), {recursive:true});
    symlinkSync(resolve('node_modules'), join(dir, 'node_modules'));
    const changed = structuredClone(lock);
    changed.images[name] = replacement;
    writeFileSync(join(dir, 'deploy/versions.json'), JSON.stringify(changed));
    assert.throws(() => execFileSync(process.execPath, ['deploy/ci/render.mjs', 'exit-test', image, join(dir, 'bundle')], {cwd:dir,stdio:'pipe'}), error => error.status === 1 && error.stderr.includes(code));
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

for (const environment of ['exit-test', 'template']) test(`${environment}: only rendered images have an admission policy`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-images-'));
  try {
    execFileSync(process.execPath, ['deploy/ci/render.mjs', environment, image, dir], {cwd:root});
    const groups = readdirSync(dir, {recursive:true}).filter(file => file.endsWith('kustomization.yaml')).map(dirname);
    const docs = groups.flatMap(group => yaml.loadAll(execFileSync('kustomize', ['build', join(dir, group)], {encoding:'utf8',maxBuffer:40*1024*1024})).filter(Boolean));
    const policies = docs.filter(d => d.kind === 'ClusterImagePolicy');
    const runtimeImages = docs.filter(d => d.kind !== 'CustomResourceDefinition').flatMap(images);
    const upstream = [...new Set([...Object.values(lock.images), ...Object.values(lock.platformImages)])];
    assert.ok(runtimeImages.includes(lock.images.seaweed));
    assert.ok(runtimeImages.includes(lock.images.postgres));
    for (const ref of runtimeImages) assert.match(ref, /@sha256:[a-f0-9]{64}$/);
    assert.deepEqual(coverage(runtimeImages, policies), [], 'PLAT_IMAGE_POLICY: images unmatched after admission normalization');
    const catalog = yaml.load(readFileSync(join(root, 'deploy/policies/upstream.yaml'), 'utf8'));
    assert.equal(policies.filter(p => p.spec.authorities.some(a => a.static?.action === 'pass')).length, 2, 'only the two Barman runtime images need static passes');
    for (const ref of upstream) {
      const matched = policies.filter(p => p.spec.images.some(({glob}) => matches(glob, ref)));
      if (!runtimeImages.includes(ref)) {
        assert.deepEqual(matched, [], `unused lock entries must not receive admission policies: ${ref}`);
        continue;
      }
      assert.equal(matched.length, 1, `one upstream policy per digest: ${ref}`);
      const policy = matched[0];
      assert.deepEqual(policy.spec.images, [{glob:canonical(ref)}], 'upstream policies must never allow tag globs');
      assert.ok(policy.spec.authorities.length);
      const unsigned = catalog[canonical(ref).split('@')[0].replace(/^index\.docker\.io\//, 'docker.io/')].authority.static;
      if (unsigned) assert.deepEqual(policy.spec.authorities, [{static:{action:'pass'}}]);
      else {
        assert.ok(policy.spec.authorities.every(a => (a.keyless || a.key) && !a.static), `published signatures must be required: ${ref}`);
        if (/cloudnative-pg\/(?:cloudnative-pg|postgresql)(?::[^/@]+)?@/.test(ref)) assert.equal(policy.spec.authorities[0].signatureFormat, 'bundle');
        if (/jetstack\//.test(ref)) assert.equal(policy.spec.authorities[0].key.hashAlgorithm, 'sha512');
      }
      const resources = readFileSync(join(dir, 'policies/resources.yaml'), 'utf8');
      const document = resources.split('---\n').find(s => s.includes(`name: ${policy.metadata.name}\n`));
      assert.match(document, /# Source: https:\/\//, 'each upstream entry must name its source');
      assert.match(document, /# Reason: .+/, 'each upstream entry must explain its authority');
    }
    for (const suffix of ['', '-unsigned', '-wrong-identity']) {
      const ref = image.replace('console@', `console${suffix}@`);
      const own = policies.filter(p => p.spec.images.some(({glob}) => matches(glob, ref)));
      assert.deepEqual(own.map(p => p.metadata.name).sort(), ['console-attestations', 'console-signature']);
      for (const p of own) for (const a of p.spec.authorities) {
        assert.equal(a.static, undefined);
        assert.equal(a.keyless.identities[0].issuer, 'https://token.actions.githubusercontent.com');
        assert.match(a.keyless.identities[0].subject, /\/platform\.yml@refs\/heads\/dev$/);
      }
    }
    const unknown = lock.images.seaweed.replace(/:[a-f0-9]{64}$/, `:${'f'.repeat(64)}`);
    assert.deepEqual(coverage([unknown], policies), [unknown], 'unlocked upstream digests stay refused');
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
