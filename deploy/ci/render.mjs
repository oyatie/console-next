// SPDX-License-Identifier: LicenseRef-Proprietary
// Render the git snapshot into the directory layout consumed by Flux's dependency graph.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';

const header = '# SPDX-License-Identifier: LicenseRef-Proprietary\n';
const [environment, image, output] = process.argv.slice(2);
assert.ok(['exit-test', 'template'].includes(environment), 'PLAT_OVERLAY: select a committed overlay');
assert.match(image ?? '', /^([^/@]+\/)*[^/:@]+@sha256:[a-f0-9]{64}$/, 'PLAT_IMAGE_DIGEST');
const directory = resolve(output);
const config = JSON.parse(readFileSync(`deploy/clusters/${environment}/platform.json`));
const lock = JSON.parse(readFileSync('deploy/versions.json'));
const identity = process.env.PLATFORM_WORKFLOW_IDENTITY ?? config.workflowIdentity;
const repository = image.split('@')[0];
const docs = yaml.loadAll(execFileSync('kustomize', ['build', `deploy/clusters/${environment}`], { encoding: 'utf8' })).filter(Boolean);
for (const doc of docs) {
  const pod = doc.spec?.template?.spec;
  for (const c of pod?.containers ?? []) { if (c.image === 'console-image') c.image = image; if(c.image==='seaweed-image') c.image=lock.images.seaweed; }
  if (doc.kind === 'Job') doc.metadata.name += `-${image.split(':').at(-1).slice(0, 16)}`;
  if (doc.kind === 'Cluster') {
    doc.spec.imageName = lock.images.postgres;
    doc.spec.storage.storageClass = config.storageClass;
  }
  if (doc.kind === 'Rollout') doc.spec.replicas = config.apiReplicas;
  if (doc.kind === 'Deployment' && doc.metadata.name === 'console-worker') doc.spec.replicas = config.workerReplicas;
  if (doc.kind === 'ExternalSecret') {
    doc.spec.secretStoreRef.name = config.secretStore;
    for (const item of doc.spec.data) item.remoteRef.key = item.remoteRef.key.replace('REPLACE_ENVIRONMENT', config.externalSecretPrefix);
  }
}
const groups = { objects: [], namespace: [], policies: yaml.loadAll(readFileSync('deploy/policies/admission.yaml', 'utf8')), database: [], migrate: [], app: [], secrets: [] };
for (const doc of docs) {
  if(doc.kind==='PersistentVolumeClaim') doc.spec.storageClassName=config.storageClass;
  const group = doc.metadata.name.startsWith('console-object') && doc.kind!=='ExternalSecret' ? 'objects' : ['Namespace', 'NetworkPolicy'].includes(doc.kind) ? 'namespace' : ['Cluster','ObjectStore'].includes(doc.kind) ? 'database' : doc.kind === 'Job' ? 'migrate' : doc.kind === 'ExternalSecret' ? 'secrets' : 'app';
  groups[group].push(doc);
}
for (const doc of yaml.loadAll(readFileSync('deploy/policies/images.yaml', 'utf8'))) {
  doc.spec.images[0].glob = `${repository}**`;
  doc.spec.authorities[0].keyless.identities[0].subject = identity;
  groups.policies.push(doc);
}
const upstream = yaml.load(readFileSync('deploy/policies/upstream.yaml', 'utf8'));
const upstreamNotes = new Map();
const renderedReferences = new Set();
function collectReferences(value) {
  if (typeof value === 'string') renderedReferences.add(value);
  else if (value && typeof value === 'object') Object.values(value).forEach(collectReferences);
}
docs.forEach(collectReferences);
yaml.loadAll(execFileSync('kustomize', ['build', 'deploy/base/platform'], {encoding:'utf8',maxBuffer:40*1024*1024})).forEach(collectReferences);
for (const ref of new Set([...Object.values(lock.images), ...Object.values(lock.platformImages)])) {
  assert.match(ref, /@sha256:[a-f0-9]{64}$/, 'PLAT_IMAGE_DIGEST: upstream image must be locked');
  const {source, reason, authority} = upstream[ref.split('@')[0]] ?? {};
  assert.ok(source && reason && authority, `PLAT_IMAGE_AUTHORITY: missing upstream authority for ${ref}`);
  if (!renderedReferences.has(ref)) continue;
  const name = `console-upstream-${ref.split(':').at(-1)}`;
  // go-containerregistry resolves Docker Hub to index.docker.io before policy glob matching.
  const glob = ref.replace(/^docker\.io\//, 'index.docker.io/');
  upstreamNotes.set(name, `# Source: ${source}\n# Reason: ${reason}\n`);
  groups.policies.push({apiVersion:'policy.sigstore.dev/v1beta1',kind:'ClusterImagePolicy',metadata:{name},spec:{images:[{glob}],authorities:[authority]}});
}
// Exit-test credentials are generated per run before reconciliation, never inside the artifact.
if (!groups.secrets.length) groups.secrets.push({apiVersion:'v1',kind:'ConfigMap',metadata:{name:'console-synthetic-data-only',namespace:'console'},data:{classification:'synthetic'}});
if(environment==='exit-test') {
 const cluster=structuredClone(groups.database.find(d=>d.kind==='Cluster'));
 cluster.metadata.name='console-restore';delete cluster.spec.plugins;delete cluster.spec.managed;
 cluster.spec.bootstrap={recovery:{source:'console-db'}};
 cluster.spec.externalClusters=[{name:'console-db',plugin:{name:'barman-cloud.cloudnative-pg.io',parameters:{barmanObjectName:'console-backup',serverName:'console-db'}}}];
 groups['tests/restore']=[cluster];
 groups['tests/backup']=[{apiVersion:'postgresql.cnpg.io/v1',kind:'Backup',metadata:{name:'console-exit-backup',namespace:'console'},spec:{cluster:{name:'console-db'},method:'plugin',pluginConfiguration:{name:'barman-cloud.cloudnative-pg.io'}}}];
}
for (const [group, resources] of Object.entries(groups)) {
  mkdirSync(join(directory, group), { recursive: true });
  writeFileSync(join(directory, group, 'resources.yaml'), header + resources.map(d => (upstreamNotes.get(d.metadata.name) ?? '') + yaml.dump(d, { lineWidth: -1, noRefs: true })).join('---\n'));
  writeFileSync(join(directory, group, 'kustomization.yaml'), header + yaml.dump({apiVersion:'kustomize.config.k8s.io/v1beta1',kind:'Kustomization',resources:['resources.yaml']}));
}
mkdirSync(join(directory, 'platform'), { recursive: true });
for (const name of readdirSync('deploy/base/platform')) {
  const source=readFileSync(join('deploy/base/platform', name),'utf8');
  if(name.startsWith('LICENSE') || name==='kustomization.yaml') {
    writeFileSync(join(directory,'platform',name),source);
  } else if(name.endsWith('.yaml')) {
    const resources=yaml.loadAll(source).filter(Boolean);
    for(const resource of resources) for(const container of resource.spec?.template?.spec?.containers??[]) container.resources=config.platformResources;
    writeFileSync(join(directory,'platform',name),header+resources.map(d=>yaml.dump(d,{lineWidth:-1,noRefs:true})).join('---\n'));
  }
}
mkdirSync(join(directory, 'reconcile'), { recursive: true });
writeFileSync(join(directory, 'reconcile', 'resources.yaml'), readFileSync('deploy/reconcile/kustomizations.yaml'));
writeFileSync(join(directory, 'reconcile', 'kustomization.yaml'), header + yaml.dump({apiVersion:'kustomize.config.k8s.io/v1beta1',kind:'Kustomization',resources:['resources.yaml']}));
writeFileSync(join(directory, 'revision.json'), JSON.stringify({revision:process.env.GITHUB_SHA ?? 'local', image, environment}, null, 2)+'\n');
console.log(`Rendered ${docs.length} workload resources for ${environment} to ${directory}`);
