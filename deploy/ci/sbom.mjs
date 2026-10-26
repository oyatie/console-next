// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export function combine(documents) {
  assert.equal(documents.length, 2);
  const result = structuredClone(documents[0]);
  result.name += '-multiarch';
  result.documentNamespace += '-multiarch';
  result.packages = []; result.files = []; result.relationships = []; result.documentDescribes = [];
  for (const [index, doc] of documents.entries()) {
    assert.match(doc.spdxVersion, /^SPDX-2\./);
    const id = value => value?.startsWith('SPDXRef-') && value !== 'SPDXRef-DOCUMENT' ? `SPDXRef-arch${index}-${value.slice(8)}` : value;
    const remap = value => {
      if (Array.isArray(value)) return value.map(remap);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, remap(val)]));
      return typeof value === 'string' ? id(value) : value;
    };
    for (const key of ['packages', 'files', 'relationships', 'documentDescribes']) result[key].push(...remap(doc[key] ?? []));
  }
  return result;
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [amd64, arm64, output] = process.argv.slice(2);
  writeFileSync(output, JSON.stringify(combine([amd64, arm64].map(p=>JSON.parse(readFileSync(p))))));
}
