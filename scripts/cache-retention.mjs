// SPDX-License-Identifier: LicenseRef-Proprietary
import {readFileSync} from 'node:fs';

const config = JSON.parse(readFileSync(new URL('./cache-retention.config.json', import.meta.url)));

export function planCaches(caches, policy, {family, savedKey, restoredKey}) {
  const rule = policy.families[family];
  if (!rule?.purpose || !rule.readers?.length || !Number.isSafeInteger(rule.copies) || rule.copies < 1 ||
      !Number.isSafeInteger(rule.restoreCopies) || rule.restoreCopies < 1) throw new Error('CACHE_POLICY');
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
  if (!owned.some(c => c.ref === policy.trustedRef && c.key === savedKey)) throw new Error('CACHE_SAVE_MISSING');
  const trusted = owned.filter(c => c.ref === policy.trustedRef)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  const keep = new Set();
  const families = new Map(), prefixes = new Map();
  for (const c of trusted) {
    const [, runner, compatible] = c.key.match(pattern);
    const group = JSON.stringify([runner, c.version]);
    const prefix = JSON.stringify([runner, compatible, c.version]);
    const count = families.get(group) ?? 0, compatibleCount = prefixes.get(prefix) ?? 0;
    if (count < rule.copies || compatibleCount < rule.restoreCopies || c.key === savedKey || c.key === restoredKey) {
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

export async function maintainCaches(github, context, options) {
  if (context.eventName !== 'push' || context.ref !== config.trustedRef ||
      context.ref !== `refs/heads/${context.payload.repository?.default_branch}`) throw new Error('CACHE_TRUST');
  const caches = await github.paginate(github.rest.actions.getActionsCacheList, {...context.repo, per_page: 100});
  const plan = planCaches(caches, config, options);
  const dryRun = options.dryRun !== false;
  const rule = config.families[options.family];
  const percent = bytes => (100 * bytes / config.budgetBytes).toFixed(1);
  const rows = (label, entries) => entries.map(c => `| ${label} | ${c.id} | ${c.key.replaceAll('|', '\\|')} | ${c.size_in_bytes} |`);
  const summary = [
    `### ${options.family} cache retention — ${dryRun ? 'DRY RUN' : 'APPLY'}`,
    `Purpose: ${rule.purpose}. Readers: ${rule.readers.join('; ')}.`,
    `Keep newest ${rule.copies} per runner/version, ${rule.restoreCopies} per compatible restore prefix/version, plus saved/restored keys.`,
    `Observed: ${plan.beforeBytes} bytes (${percent(plan.beforeBytes)}%). Projected: ${plan.projectedBytes} bytes (${percent(plan.projectedBytes)}%).`,
    `Budget: ${config.budgetBytes} bytes; target ${100 * config.targetFraction}%. Observed budget status: ${plan.beforeBytes <= config.budgetBytes * config.targetFraction ? 'PASS' : 'OVER'}.`,
    '| Decision | ID | Key | Bytes |', '| --- | --- | --- | --- |',
    ...rows('KEEP', plan.keep), ...rows('DELETE', plan.delete), '',
  ].join('\n');
  if (!dryRun) for (const c of plan.delete) {
    try { await github.rest.actions.deleteActionsCacheById({...context.repo, cache_id: c.id}); }
    catch (error) { if (error.status !== 404) throw error; }
  }
  return {...plan, summary};
}
