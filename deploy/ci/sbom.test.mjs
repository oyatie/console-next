// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
test('both native SBOMs retain packages, files and relationships without ID collisions', async () => {
  const {combine} = await import(pathToFileURL(resolve(process.env.PLATFORM_REPO_ROOT ?? '.', 'deploy/ci/sbom.mjs')));
  const doc = {spdxVersion:'SPDX-2.3',name:'console',documentNamespace:'https://example.invalid/sbom',SPDXID:'SPDXRef-DOCUMENT',packages:[{SPDXID:'SPDXRef-package'}],files:[{SPDXID:'SPDXRef-file'}],relationships:[{spdxElementId:'SPDXRef-DOCUMENT',relatedSpdxElement:'SPDXRef-package',relationshipType:'DESCRIBES'}],documentDescribes:['SPDXRef-package']};
  const result = combine([doc, doc]);
  assert.equal(new Set(result.packages.map(p=>p.SPDXID)).size, 2);
  assert.equal(new Set(result.files.map(p=>p.SPDXID)).size, 2);
  assert.deepEqual(result.documentDescribes,result.packages.map(p=>p.SPDXID));
  assert.deepEqual(result.relationships.map(r=>r.relatedSpdxElement),result.documentDescribes);
  assert.equal(result.relationships[0].spdxElementId,'SPDXRef-DOCUMENT');
  assert.equal(doc.packages[0].SPDXID,'SPDXRef-package');
});
