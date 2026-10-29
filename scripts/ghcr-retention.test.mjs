// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(process.env.GHCR_REPO_ROOT ?? '.');
const { planRetention, inventoryPackages, renderReport, registryAPI } = await import(pathToFileURL(resolve(root, 'scripts/ghcr-retention.mjs')));
const digest = n => `sha256:${n.toString(16).padStart(64, '0')}`;
const name = 'example/console';
const ref = n => `ghcr.io/example/${name}@${digest(n)}`;
const config = { repository: 'example/example', packages: [name], lastDevBuilds: 2,
  requiredSources: { production: 1, canary: 1, staging: 1, rollback: 1, 'exit-test': 1, 'in-flight': 0 } };
const version = (n, tags = []) => ({ id: n, name: digest(n), created_at: `2026-10-${String(n).padStart(2, '0')}T00:00:00Z`, metadata: { container: { tags } } });
const manifest = (n, body = {}) => ({ digest: digest(n), bytes: 100, body: { schemaVersion: 2,
  config: { digest: digest(100), size: 10 }, layers: [{ digest: digest(101), size: 1000 }], ...body } });

// Recorded shapes of Packages REST, OCI manifests, referrers indexes and Cosign's tag fallback;
// all identifiers and digests are synthetic, and no network or credentials are used.
function fixture() {
  const versions = [version(1), version(2), version(3, [`sha256-${digest(1).slice(7)}.sig`]),
    version(4, [`sha256-${digest(1).slice(7)}.att`]), version(5), version(6), version(7), version(8),
    version(9, ['a'.repeat(40)]), version(10, ['b'.repeat(40)]), version(11, ['c'.repeat(40)]), version(12),
    version(13, [`sha256-${digest(1).slice(7)}`]), version(14)];
  const manifests = versions.map(v => manifest(v.id));
  manifests[0] = manifest(1, { manifests: [{ digest: digest(2), size: 100 }] });
  manifests[7] = manifest(8, { subject: { digest: digest(1) } });
  manifests[12] = manifest(13, { manifests: [{ digest: digest(14), size: 100 }] });
  const sources = Object.keys(config.requiredSources).map((source, i) => ({ name: source, complete: true, roots: [ref([1, 5, 5, 6, 7, 5][i])] }));
  return { packages: [{ name, versions, manifests, referrers: { [digest(1)]: { manifests: [{ digest: digest(8), size: 100 }] } } }], sources };
}
const row = (plan, n) => plan.packages[0].versions.find(v => v.id === n);

test('keeps releases, arch children, legacy signatures/attestations, OCI bundles and fallback indexes', () => {
  const plan = planRetention(fixture(), config);
  assert.equal(plan.complete, true);
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 13, 14]) assert.equal(row(plan, n).decision, 'keep', `version ${n}`);
  assert.match(row(plan, 1).reason, /production/);
  assert.match(row(plan, 2).reason, /child/);
  assert.match(row(plan, 3).reason, /referrer/);
  assert.match(row(plan, 7).reason, /exit-test/);
});
test('keeps K newest dev builds by creation, not API ordering; older untagged orphans are candidates', () => {
  const data = fixture();
  data.packages[0].versions.reverse();
  const plan = planRetention(data, config);
  for (const n of [10, 11]) assert.match(row(plan, n).reason, /dev/);
  for (const n of [9, 12]) assert.equal(row(plan, n).decision, 'candidate');
  assert.equal(plan.packages[0].candidates, 2);
});
test('a retained dev index protects its architecture and referrers too', () => {
  const data = fixture();
  data.packages[0].manifests[10].body.manifests = [{ digest: digest(12), size: 100 }];
  assert.equal(row(planRetention(data, config), 12).decision, 'keep');
});
test('native referrers protect untagged proofs even without a subject field', () => {
  const data = fixture();
  delete data.packages[0].manifests[7].body.subject;
  assert.equal(row(planRetention(data, config), 8).decision, 'keep');
});
test('subject links protect proofs when the registry uses fallback rather than native referrers', () => {
  const data = fixture();
  data.packages[0].referrers = {};
  assert.equal(row(planRetention(data, config), 8).decision, 'keep');
});
test('legacy SBOM tags protect the SBOM manifest', () => {
  const data = fixture();
  data.packages[0].versions[11].metadata.container.tags = [`sha256-${digest(1).slice(7)}.sbom`];
  assert.equal(row(planRetention(data, config), 12).decision, 'keep');
});
test('Flux revision annotations identify dev deploy artifacts without commit tags', () => {
  const data = fixture();
  data.packages[0].manifests[11].body.annotations = { 'org.opencontainers.image.revision': 'd'.repeat(40) };
  const plan = planRetention(data, config);
  assert.match(row(plan, 12).reason, /dev/);
  assert.equal(row(plan, 10).decision, 'candidate');
});
test('K counts distinct builds and preserves every manifest carrying a retained revision', () => {
  const data = fixture();
  data.packages[0].manifests[11].body.annotations = { 'org.opencontainers.image.revision': 'c'.repeat(40) };
  const plan = planRetention(data, config);
  for (const n of [10, 11, 12]) assert.match(row(plan, n).reason, /dev/);
});
test('a completely observed absence of in-flight candidates permits an empty source', () => {
  const data = fixture();
  data.sources.at(-1).roots = [];
  assert.equal(planRetention(data, config).complete, true);
});
test('N rollback roots must be distinct and meet the configured floor', () => {
  const data = fixture();
  data.sources.find(s => s.name === 'rollback').roots = [ref(6), ref(6)];
  const plan = planRetention(data, { ...config, requiredSources: { ...config.requiredSources, rollback: 2 } });
  assert.equal(plan.complete, false);
  assert.match(plan.errors.join('\n'), /GHCR_SOURCE: rollback/);
});
test('byte totals deduplicate shared blobs and include manifest bytes', () => {
  const plan = planRetention(fixture(), config);
  assert.equal(plan.packages[0].bytes, 14 * 100 + 10 + 1000);
  assert.equal(plan.packages[0].kept, 12);
  assert.match(renderReport(plan), /candidate/);
  assert.match(renderReport(plan), /compressed referenced bytes/);
});
for (const defect of ['missing', 'unreachable', 'empty', 'incomplete']) test(`GHCR_SOURCE: ${defect} required release source holds every version`, () => {
  const data = fixture();
  if (defect === 'missing') data.sources.shift();
  if (defect === 'unreachable') data.sources[0] = { name: 'production', error: 'ref fetch failed' };
  if (defect === 'empty') data.sources[0].roots = [];
  if (defect === 'incomplete') data.sources[0].complete = false;
  const plan = planRetention(data, config);
  assert.equal(plan.complete, false);
  assert.match(plan.errors.join('\n'), /GHCR_SOURCE/);
  assert.ok(plan.packages[0].versions.every(v => v.decision === 'keep' && /hold/.test(v.reason)));
  assert.equal(plan.packages[0].candidates, 0);
});
for (const defect of ['package', 'manifest', 'root', 'child', 'referrer', 'duplicate', 'timestamp', 'schema', 'size']) test(`GHCR_INVENTORY: ${defect} failure holds all packages`, () => {
  const data = fixture();
  if (defect === 'package') data.packages = [];
  if (defect === 'manifest') data.packages[0].manifests.pop();
  if (defect === 'root') data.sources[0].roots = [ref(99)];
  if (defect === 'child') data.packages[0].manifests[0].body.manifests.push({ digest: digest(99), size: 100 });
  if (defect === 'referrer') data.packages[0].referrers[digest(1)].manifests.push({ digest: digest(99), size: 100 });
  if (defect === 'duplicate') data.packages[0].versions.push(version(1));
  if (defect === 'timestamp') data.packages[0].versions[0].created_at = 'bad';
  if (defect === 'schema') data.packages[0].manifests[0].body.schemaVersion = 1;
  if (defect === 'size') data.packages[0].manifests[0].body.layers[0].size = -1;
  const plan = planRetention(data, config);
  assert.equal(plan.complete, false);
  assert.match(plan.errors.join('\n'), /GHCR_INVENTORY/);
  assert.ok(plan.packages.every(p => p.candidates === 0));
});
for (const k of [-1, 0, 1.5, '2']) test(`GHCR_CONFIG: invalid dev retention ${k} refuses a plan`, () => {
  assert.throws(() => planRetention(fixture(), { ...config, lastDevBuilds: k }), /GHCR_CONFIG/);
});
test('package graphs stay separate even when digests are equal', () => {
  const data = fixture();
  const second = structuredClone(data.packages[0]);
  second.name = 'example/unsigned';
  second.versions.forEach(v => { v.metadata.container.tags = []; });
  data.packages.push(second);
  const plan = planRetention(data, { ...config, packages: [name, second.name] });
  assert.equal(plan.complete, true);
  assert.equal(plan.packages[1].kept, 0);
});
test('inventory requests every manifest and OCI referrers, using only reads', async () => {
  const calls = [];
  const inventory = await inventoryPackages(config, {
    versions: async pkg => { calls.push(['versions', pkg]); return [version(1), version(2)]; },
    manifest: async (pkg, sha) => { calls.push(['manifest', pkg, sha]); return manifest(Number.parseInt(sha.slice(7), 16)); },
    referrers: async (pkg, sha) => { calls.push(['referrers', pkg, sha]); return { manifests: [] }; },
  });
  assert.equal(inventory.packages[0].manifests.length, 2);
  assert.equal(calls.filter(([kind]) => kind === 'referrers').length, 2);
});
test('unavailable registry metadata makes byte totals unknown and holds the inventory', async () => {
  const inventory = await inventoryPackages(config, { versions: async () => [version(1)],
    manifest: async () => { throw new Error('503'); }, referrers: async () => ({ manifests: [] }) });
  inventory.sources = fixture().sources;
  const plan = planRetention(inventory, config);
  assert.equal(plan.complete, false);
  assert.equal(plan.packages[0].bytes, null);
  assert.equal(plan.packages[0].candidates, 0);
});
test('apply is refused before registry access in the read-only slice', () => {
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/ghcr-retention.mjs'), '--apply'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /read-only/);
});
test('REST inventory encodes package slashes, paginates all active versions and never writes', async () => {
  const api = registryAPI(config, { gh: (bin, args) => {
    assert.equal(bin, 'gh');
    assert.deepEqual(args, ['api', '--paginate', '--slurp', '/orgs/example/packages/container/example%2Fconsole/versions?per_page=100&state=active']);
    return JSON.stringify([[version(1)], [version(2)]]);
  } });
  assert.deepEqual(await api.versions(name), [version(1), version(2)]);
});
test('registry adapter reads raw manifest bytes and native OCI indexes, caching the public pull token', async () => {
  const calls = [];
  const body = JSON.stringify(manifest(1).body);
  const api = registryAPI(config, { request: async (url, options) => {
    calls.push(url);
    assert.equal(options.method, undefined);
    if (url.includes('/token?')) return Response.json({ token: 'synthetic-pull-token' });
    assert.equal(options.headers.Authorization, 'Bearer synthetic-pull-token');
    return url.includes('/referrers/') ? Response.json({ manifests: [] }) : new Response(body);
  } });
  assert.deepEqual(await api.manifest(name, digest(1)), { digest: digest(1), body: JSON.parse(body), bytes: Buffer.byteLength(body) });
  assert.deepEqual(await api.referrers(name, digest(1)), { manifests: [] });
  assert.equal(calls.filter(url => url.includes('/token?')).length, 1);
  assert.ok(calls.includes(`https://ghcr.io/v2/example/${name}/referrers/${digest(1)}`));
});
for (const status of [404, 403, 503, 'pagination', 'invalid']) test(`native referrers ${status}: only 404 permits tag fallback`, async () => {
  const api = registryAPI(config, { request: async url => {
    if (url.includes('/token?')) return Response.json({ token: 'synthetic-pull-token' });
    if (status === 'pagination') return Response.json({ manifests: [] }, { headers: { Link: '</next>; rel="next"' } });
    if (status === 'invalid') return Response.json({});
    return new Response(null, { status });
  } });
  if (status === 404) assert.deepEqual(await api.referrers(name, digest(1)), { manifests: [] });
  else await assert.rejects(api.referrers(name, digest(1)), /registry HTTP|paginated referrers|invalid referrers/);
});
