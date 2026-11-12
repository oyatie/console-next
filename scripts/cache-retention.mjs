// SPDX-License-Identifier: LicenseRef-Proprietary
import {readFileSync} from 'node:fs';

const config = JSON.parse(readFileSync(new URL('./cache-retention.config.json', import.meta.url)));

export function planCaches(caches, policy, {family, savedKey, restoredKey}) {
  const rule = policy.families[family];
  if (!rule?.purpose || !rule.readers?.length || !Number.isSafeInteger(rule.copies) || rule.copies < 1 ||
      !Number.isSafeInteger(rule.restoreCopies) || rule.restoreCopies < 1 ||
      !Number.isSafeInteger(rule.prefixes) || rule.prefixes < 1 ||
      rule.blobPattern && (!Number.isSafeInteger(rule.blobBuilds) || rule.blobBuilds < 1 || rule.copies < rule.blobBuilds ||
        !Array.isArray(rule.blobScopes) || !rule.blobScopes.length || rule.blobScopes.some(scope => typeof scope !== 'string' || !scope))) throw new Error('CACHE_POLICY');
  const pattern = new RegExp(rule.keyPattern);
  const owned = caches.filter(c => pattern.test(c.key));
  for (const c of caches) {
    if (!Number.isSafeInteger(c.size_in_bytes) || c.size_in_bytes < 0) throw new Error('CACHE_METADATA');
  }
  for (const c of owned) {
    if (!Number.isSafeInteger(c.id) || !c.version || !Number.isFinite(Date.parse(c.created_at))) {
      throw new Error('CACHE_METADATA');
    }
  }
  if (savedKey !== undefined && !owned.some(c => c.ref === policy.trustedRef && c.key === savedKey)) throw new Error('CACHE_SAVE_MISSING');
  const trusted = owned.filter(c => c.ref === policy.trustedRef)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  const keep = new Set();
  const families = new Map(), prefixes = new Map(), retainedPrefixes = new Map();
  const savedPrefix = savedKey?.match(pattern)?.slice(1, 3).join('');
  const legacy = c => rule.legacyPattern && new RegExp(rule.legacyPattern).test(c.key);
  const blob = c => rule.blobPattern && new RegExp(rule.blobPattern).test(c.key);
  for (const c of owned.filter(blob)) {
    if (!Number.isFinite(Date.parse(c.last_accessed_at))) throw new Error('CACHE_METADATA');
  }
  // Shared blobs use the older scope's build boundary; incomplete history cannot prove obsolescence.
  const boundaries = (rule.blobScopes ?? []).map(scope => trusted.filter(c => c.key.startsWith(scope))[rule.blobBuilds - 1]);
  const unrelatedIndex = caches.some(c => c.key.startsWith('index-') && !legacy(c) &&
    !(c.ref === policy.trustedRef && rule.blobScopes?.some(scope => c.key.startsWith(scope))));
  const blobBoundary = boundaries.length && boundaries.every(Boolean) && !unrelatedIndex
    ? Math.min(...boundaries.map(c => Date.parse(c.created_at))) : -Infinity;
  const resetBlobs = owned.some(legacy) && !caches.some(c => c.key.startsWith('index-') && !legacy(c));
  for (const c of trusted) {
    if (legacy(c)) continue;
    if (blob(c)) {
      if (!resetBlobs && Math.max(Date.parse(c.created_at), Date.parse(c.last_accessed_at)) >= blobBoundary) keep.add(c.id);
      continue;
    }
    const [, runner, compatible] = c.key.match(pattern);
    const group = JSON.stringify([runner, c.version]);
    const prefix = JSON.stringify([runner, compatible, c.version]);
    const count = families.get(group) ?? 0, compatibleCount = prefixes.get(prefix) ?? 0;
    const selected = retainedPrefixes.get(group) ?? new Set();
    if (selected.size < rule.prefixes) selected.add(compatible);
    retainedPrefixes.set(group, selected);
    const currentPrefix = selected.has(compatible) || runner + compatible === savedPrefix;
    if (count < rule.copies || currentPrefix && compatibleCount < rule.restoreCopies || c.key === savedKey || c.key === restoredKey) {
      keep.add(c.id);
    }
    families.set(group, count + 1);
    prefixes.set(prefix, compatibleCount + 1);
  }
  const obsolete = owned.filter(c => c.ref === policy.trustedRef && !keep.has(c.id) || /^refs\/pull\/\d+\/merge$/.test(c.ref));
  const deleted = new Set(obsolete.map(c => c.id));
  const beforeBytes = caches.reduce((sum, c) => sum + c.size_in_bytes, 0);
  return {keep: caches.filter(c => !deleted.has(c.id)), delete: obsolete, beforeBytes,
    projectedBytes: beforeBytes - obsolete.reduce((sum, c) => sum + c.size_in_bytes, 0)};
}

export function restoreSummary(family, primary, matched) {
  return `${family} cache restore: ${!matched ? 'MISS' : matched === primary ? 'exact hit' : 'warm fallback'}; matched=${matched || 'none'}\n`;
}

export async function maintainCaches(github, context, options = {}) {
  if (context.eventName !== 'push' || context.ref !== config.trustedRef ||
      context.ref !== `refs/heads/${context.payload.repository?.default_branch}`) throw new Error('CACHE_TRUST');
  const caches = await github.paginate(github.rest.actions.getActionsCacheList, {...context.repo, per_page: 100});
  const families = options.family ? [options.family] : Object.keys(config.families);
  const plans = families.map(family => planCaches(caches, config, {...options, family}));
  const obsolete = new Map(plans.flatMap(p => p.delete).map(c => [c.id, c]));
  const beforeBytes = caches.reduce((sum, c) => sum + c.size_in_bytes, 0);
  const plan = {keep: caches.filter(c => !obsolete.has(c.id)), delete: [...obsolete.values()], beforeBytes,
    projectedBytes: beforeBytes - [...obsolete.values()].reduce((sum, c) => sum + c.size_in_bytes, 0)};
  const applyFamilies = options.applyFamilies ?? [];
  const applicable = new Set(plans.flatMap((p, i) => applyFamilies.includes(families[i]) ? p.delete.map(c => c.id) : []));
  const dryRun = applicable.size === 0;
  const percent = bytes => (100 * bytes / config.budgetBytes).toFixed(1);
  const rows = (label, entries) => entries.map(c => `| ${label} | ${c.id} | ${c.key.replaceAll('|', '\\|')} | ${c.size_in_bytes} |`);
  const summary = [
    `### ${options.family ?? 'Repository'} cache retention — ${dryRun ? 'DRY RUN' : 'APPLY selected families'}`,
    ...families.map(family => {
      const rule = config.families[family];
      return `${family} (${applyFamilies.includes(family) ? 'APPLY' : 'DRY RUN'}): ${rule.purpose}. Readers: ${rule.readers.join('; ')}. Keep ${rule.copies} per family/version, ${rule.restoreCopies} per prefix for ${rule.prefixes} newest prefixes, plus saved/restored keys.${rule.blobPattern ? ` Blobs: created or accessed since the older scope's ${rule.blobBuilds}th newest index; incomplete history preserves blobs.` : ''}`;
    }),
    `Observed: ${plan.beforeBytes} bytes (${percent(plan.beforeBytes)}%). Projected: ${plan.projectedBytes} bytes (${percent(plan.projectedBytes)}%).`,
    `Budget: ${config.budgetBytes} bytes; target ${100 * config.targetFraction}%. Observed budget status: ${plan.beforeBytes <= config.budgetBytes * config.targetFraction ? 'PASS' : 'OVER'}.`,
    `Enabled deletion: ${[...applicable].length} entries. All-family projection assumes every family is enabled.`,
    '| Decision | ID | Key | Bytes |', '| --- | --- | --- | --- |',
    ...rows('KEEP', plan.keep), ...rows('DELETE', plan.delete.filter(c => applicable.has(c.id))),
    ...rows('WOULD DELETE', plan.delete.filter(c => !applicable.has(c.id))), '',
  ].join('\n');
  for (const c of plan.delete.filter(c => applicable.has(c.id))) {
    try { await github.rest.actions.deleteActionsCacheById({...context.repo, cache_id: c.id}); }
    catch (error) { if (error.status !== 404) throw error; }
  }
  return {...plan, summary};
}
