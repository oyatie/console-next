#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sha256 = /^sha256:[0-9a-f]{64}$/;
const commit = /^[0-9a-f]{40}$/;
const key = (pkg, digest) => `${pkg}@${digest}`;
const tags = version => version.metadata?.container?.tags ?? [];

export function planRetention(inventory, config) {
  if (!Number.isSafeInteger(config.lastDevBuilds) || config.lastDevBuilds < 1 ||
      !config.packages?.length || new Set(config.packages).size !== config.packages.length ||
      !Object.keys(config.requiredSources ?? {}).length ||
      Object.values(config.requiredSources).some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('GHCR_CONFIG: invalid retention settings');
  const errors = [...(inventory.errors ?? [])], records = new Map(), reasons = new Map(), edges = new Map();
  const owner = config.repository.split('/')[0];
  const reference = (pkg, digest) => `ghcr.io/${owner}/${key(pkg, digest)}`;
  const link = (from, to, why) => { if (!edges.has(from)) edges.set(from, []); edges.get(from).push([to, why]); };
  const sizeMaps = new Map();
  for (const name of config.packages) {
    const packages = inventory.packages.filter(p => p.name === name);
    if (packages.length !== 1) { errors.push(`GHCR_INVENTORY: ${name} missing or repeated package`); continue; }
    const pkg = packages[0], sizes = new Map();
    sizeMaps.set(name, sizes);
    for (const version of pkg.versions) {
      const id = key(name, version.name);
      if (!sha256.test(version.name) || !Number.isSafeInteger(version.id) || version.id < 1 ||
          !Number.isFinite(Date.parse(version.created_at)) || !Array.isArray(tags(version)) || records.has(id)) {
        errors.push(`GHCR_INVENTORY: ${id} invalid version`); continue;
      }
      const entry = pkg.manifests.find(m => m.digest === version.name);
      records.set(id, { ...version, pkg: name, entry });
      const body = entry?.body;
      if (!body || body.schemaVersion !== 2 || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
          !(Array.isArray(body.manifests) || Array.isArray(body.layers) && body.config)) {
        errors.push(`GHCR_INVENTORY: ${id} missing or invalid manifest`); continue;
      }
      sizes.set(version.name, entry.bytes);
      for (const descriptor of [body.config, ...(body.layers ?? []), ...(body.manifests ?? [])].filter(Boolean)) {
        if (!sha256.test(descriptor.digest) || !Number.isSafeInteger(descriptor.size) || descriptor.size < 0) errors.push(`GHCR_INVENTORY: ${id} invalid descriptor`);
        else sizes.set(descriptor.digest, descriptor.size);
      }
      for (const child of body.manifests ?? []) link(id, key(name, child.digest), 'manifest child');
      if (body.subject) link(key(name, body.subject.digest), id, 'OCI subject referrer');
      for (const descriptor of pkg.referrers?.[version.name]?.manifests ?? []) link(id, key(name, descriptor.digest), 'OCI referrer');
      for (const tag of tags(version)) {
        const match = tag.match(/^sha256-([0-9a-f]{64})(?:\.(?:sig|att|sbom))?$/);
        if (match) link(key(name, `sha256:${match[1]}`), id, 'tag referrer');
      }
    }
  }
  const keep = (id, why) => {
    if (!records.has(id)) { errors.push(`GHCR_INVENTORY: protected dependency ${id} absent`); return; }
    if (reasons.has(id)) { reasons.get(id).add(why); return; }
    reasons.set(id, new Set([why]));
    for (const [child, relation] of edges.get(id) ?? []) keep(child, `${relation} of ${id}`);
  };
  for (const [name, minimum] of Object.entries(config.requiredSources)) {
    const sources = (inventory.sources ?? []).filter(s => s.name === name);
    const source = sources[0];
    if (sources.length !== 1 || source.complete !== true || source.error || !Array.isArray(source.roots) || new Set(source.roots).size < minimum) {
      errors.push(`GHCR_SOURCE: ${name} unavailable or incomplete`); continue;
    }
    for (const root of source.roots) {
      const record = [...records.values()].find(r => reference(r.pkg, r.name) === root);
      if (!record) errors.push(`GHCR_INVENTORY: ${name} root ${root} absent`);
      else keep(key(record.pkg, record.name), name);
    }
  }
  for (const name of config.packages) {
    const dev = new Map();
    const newest = (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id;
    for (const record of [...records.values()].filter(r => r.pkg === name).sort(newest)) {
      const revision = tags(record).find(t => commit.test(t)) ?? record.entry?.body.annotations?.['org.opencontainers.image.revision'];
      if (!commit.test(revision ?? '')) continue;
      if (!dev.has(revision)) dev.set(revision, []);
      dev.get(revision).push(record);
    }
    for (const build of [...dev.values()].slice(0, config.lastDevBuilds)) for (const version of build) keep(key(name, version.name), 'recent dev build');
  }
  // An incomplete source or graph invalidates the entire plan, including other packages.
  const complete = errors.length === 0;
  return { complete, errors: [...new Set(errors)], packages: config.packages.map(name => {
    const pkg = inventory.packages.find(p => p.name === name);
    const versions = (pkg?.versions ?? []).map(v => ({ id: v.id, digest: v.name, tags: tags(v),
      decision: !complete || reasons.has(key(name, v.name)) ? 'keep' : 'candidate',
      reason: !complete ? 'safety hold: incomplete keep sources or inventory' : [...(reasons.get(key(name, v.name)) ?? ['unreferenced outside dev retention'])].join('; ') }));
    const candidates = versions.filter(v => v.decision === 'candidate').length;
    const sizes = sizeMaps.get(name);
    return { name, inventoryComplete: Boolean(pkg) && !inventory.errors?.some(e => e.includes(name)),
      total: versions.length, kept: versions.length - candidates, candidates,
      bytes: sizes && !inventory.errors?.some(e => e.includes(name)) && pkg?.manifests.length === pkg?.versions.length ? [...sizes.values()].reduce((a, b) => a + b, 0) : null, versions };
  }) };
}

export async function inventoryPackages(config, api) {
  const concurrency = config.inventoryConcurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('GHCR_CONFIG: invalid inventory concurrency');
  const inventory = { packages: [], errors: [] };
  for (const name of config.packages) {
    const pkg = { name, versions: [], manifests: [], referrers: {} };
    inventory.packages.push(pkg);
    try {
      pkg.versions = await api.versions(name);
      // Bound requests; a failed page/manifest/referrer lookup remains a global safety hold.
      for (let i = 0; i < pkg.versions.length; i += concurrency) {
        const results = await Promise.allSettled(pkg.versions.slice(i, i + concurrency).map(async version => ({
          manifest: await api.manifest(name, version.name), referrers: await api.referrers(name, version.name),
        })));
        for (const result of results) {
          if (result.status === 'rejected') inventory.errors.push(`GHCR_INVENTORY: ${name} ${result.reason.message}`);
          else {
            pkg.manifests.push(result.value.manifest);
            pkg.referrers[result.value.manifest.digest] = result.value.referrers;
          }
        }
      }
    } catch (error) { inventory.errors.push(`GHCR_INVENTORY: ${name} ${error.message}`); }
  }
  return inventory;
}

export function renderReport(plan) {
  return ['# GHCR retention dry-run', '', `Plan complete: ${plan.complete}. No versions deleted.`,
    'Bytes = unique compressed referenced bytes plus manifests per package; not GitHub billed storage.', '',
    '| Package | Versions | Kept | Candidates | Bytes |', '| --- | ---: | ---: | ---: | ---: |',
    ...plan.packages.map(p => `| ${p.name} | ${p.total} | ${p.kept} | ${p.candidates} | ${p.bytes ?? 'unknown'} |`), '',
    ...plan.errors.map(e => `- ${e}`), '', '| Package | Version ID | Digest | Tags | Decision | Reason |', '| --- | --- | --- | --- | --- | --- |',
    ...plan.packages.flatMap(p => p.versions.map(v => `| ${p.name} | ${v.id} | ${v.digest} | ${v.tags.join(', ')} | ${v.decision} | ${v.reason} |`)), ''].join('\n');
}

export function registryAPI(config, { request = fetch, gh = execFileSync } = {}) {
  const tokens = new Map(), owner = config.repository.split('/')[0];
  const get = async (url, options = {}) => {
    const response = await request(url, { ...options, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`registry HTTP ${response.status}`);
    return response;
  };
  const registry = async (name, suffix) => {
    if (!tokens.has(name)) {
      const response = await get(`https://ghcr.io/token?service=ghcr.io&scope=repository:${owner}/${name}:pull`);
      tokens.set(name, (await response.json()).token);
    }
    return get(`https://ghcr.io/v2/${owner}/${name}/${suffix}`, { headers: {
      Authorization: `Bearer ${tokens.get(name)}`, Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json',
    } });
  };
  return {
    versions: async name => JSON.parse(gh('gh', ['api', '--paginate', '--slurp',
      `/orgs/${owner}/packages/container/${encodeURIComponent(name)}/versions?per_page=100&state=active`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })).flat(),
    manifest: async (name, digest) => {
      const text = await (await registry(name, `manifests/${digest}`)).text();
      return { digest, bytes: Buffer.byteLength(text), body: JSON.parse(text) };
    },
    referrers: async (name, digest) => {
      // GHCR uses the OCI fallback index tag where the referrers endpoint is unsupported.
      // Its index and legacy Cosign tags are inventoried above and traversed by planRetention.
      try {
        const response = await registry(name, `referrers/${digest}`);
        if (response.headers.has('link')) throw new Error('paginated referrers require complete inventory');
        const index = await response.json();
        if (!Array.isArray(index.manifests)) throw new Error('invalid referrers index');
        return index;
      } catch (error) {
        if (error.message === 'registry HTTP 404') return { manifests: [] };
        throw error;
      }
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some(arg => !['--dry-run', '--json'].includes(arg))) throw new Error('This slice is read-only; only --dry-run and --json are supported');
    const config = JSON.parse(readFileSync(new URL('./ghcr-retention.config.json', import.meta.url), 'utf8'));
    const inventory = await inventoryPackages(config, registryAPI(config));
    // Release-source adapters must read promotion's authoritative refs/desired state (next slice).
    // Their absence must never turn an inventory report into an executable deletion plan.
    const plan = planRetention(inventory, config);
    plan.capturedAt = new Date().toISOString();
    process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify(plan, null, 2)}\n` : renderReport(plan));
    process.exitCode = plan.complete ? 0 : 2;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
