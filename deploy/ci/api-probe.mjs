// SPDX-License-Identifier: LicenseRef-Proprietary
// The host probes the exact API contract shipped in the image before admitting it.
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const [file, revision] = process.argv.slice(2);
if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw new Error('API_PROBE_REVISION: expected a full source SHA');
const spec = yaml.load(readFileSync(file, 'utf8'));
function resolve(value) {
  const seen = new Set();
  while (value?.$ref) {
    const ref = value.$ref;
    if (!ref.startsWith('#/') || seen.has(ref)) throw new Error('API_PROBE_REF: unsupported or cyclic reference');
    seen.add(ref);
    value = ref.slice(2).split('/').reduce((item, key) => item[key.replaceAll('~1', '/').replaceAll('~0', '~')], spec);
  }
  return value;
}

const path = Object.keys(spec.paths).sort().find(path => {
  if (!/^\/api\/[A-Za-z0-9/_-]+$/.test(path)) return false;
  const item = resolve(spec.paths[path]);
  const op = item.get;
  if (!op) return false;
  const security = op.security ?? spec.security ?? [];
  if (!security.length || security.some(requirement => !Object.keys(requirement).length)) return false;
  if (op.requestBody || [...(item.parameters ?? []), ...(op.parameters ?? [])].some(parameter => resolve(parameter).required)) return false;
  return Boolean(resolve(op.responses?.['401'])?.content?.['application/problem+json']);
});
if (!path) throw new Error('API_PROBE_MISSING: no protected GET without required inputs documents a 401 problem response');
console.log(JSON.stringify({ backend: revision, path, code: 'unauthorized' }));
