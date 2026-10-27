// SPDX-License-Identifier: LicenseRef-Proprietary
// Best-effort failure evidence for disposable clusters; never dump specs or Secret objects.
import { spawnSync } from 'node:child_process';

const kubectl = args => spawnSync('kubectl', [...args, '--request-timeout=10s'], {encoding:'utf8',timeout:15_000,maxBuffer:16*1024*1024});
const context = kubectl(['config', 'current-context']);
if (context.status !== 0 || !/^kind-platform-/.test(context.stdout.trim())) {
  console.log('Diagnostics unavailable: no disposable platform context');
  process.exit();
}
const secrets = kubectl(['get', 'secrets', '-A', '-o', 'json']);
const values = new Set();
function remember(value, key) {
  if (key === 'username' || key?.startsWith('usage-bootstrap-')) return;
  if (typeof value === 'string' && value.length >= 12) {
    values.add(value);
    for (const line of value.split('\n').filter(line => line.length >= 12)) values.add(line);
    try { const password = new URL(value).password; if (password) { remember(password); remember(decodeURIComponent(password)); } } catch { /* Not a URL. */ }
    try { const json = JSON.parse(value); if (typeof json === 'object') remember(json); } catch { /* Not JSON. */ }
  } else if (value && typeof value === 'object') Object.entries(value).forEach(([key, value]) => remember(value, key));
}
let redactionReady = false;
if (secrets.status === 0) {
  try {
    for (const secret of JSON.parse(secrets.stdout).items) {
      for (const [key, value] of Object.entries(secret.data ?? {})) {
        remember(value, key);
        remember(Buffer.from(value, 'base64').toString('utf8'), key);
      }
    }
    redactionReady = true;
  } catch { /* Suppress free text if the secret inventory cannot be decoded. */ }
}
const sensitive = [...values].flatMap(value => [value, JSON.stringify(value).slice(1, -1)]).sort((a, b) => b.length - a.length);
const redact = value => {
  let text = value;
  for (const secret of sensitive) text = text.split(secret).join('[REDACTED]');
  return text;
};
const print = value => console.log(typeof value === 'string' ? redact(value) : JSON.stringify(value, (_, entry) => typeof entry === 'string' ? redact(entry) : entry));
function get(resource) {
  const result = kubectl(['get', resource, '-A', '-o', 'json']);
  if (result.status === 0) {
    try { return JSON.parse(result.stdout).items ?? []; } catch { /* Continue with other resource types. */ }
  }
  print(`${resource}: unavailable (exit ${result.status ?? 'timeout'})`);
  return [];
}
const pick = (value, fields) => Object.fromEntries(fields.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const conditionFields = ['type', 'status', 'reason', ...(redactionReady ? ['message'] : [])];
for (const resource of ['kustomizations', 'helmreleases', 'ocirepositories', 'jobs', 'rollouts', 'analysisruns', 'clusters']) {
  for (const item of get(resource)) print({resource,namespace:item.metadata.namespace,name:item.metadata.name,
    ...pick(item.status, ['phase', 'replicas', 'readyReplicas', 'active', 'failed', 'succeeded']),
    conditions:(item.status?.conditions ?? []).map(condition => pick(condition, conditionFields))});
}
if (!redactionReady) print('Secret redaction unavailable: free-text messages, describe and logs suppressed');
for (const pod of get('pods')) {
  const {name, namespace} = pod.metadata;
  const containers = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
  print({resource:'pod',namespace,name,phase:pod.status?.phase,
    conditions:(pod.status?.conditions ?? []).map(condition => pick(condition, conditionFields)),
    containers:containers.map(container => ({...pick(container, ['name', 'ready', 'restartCount']),
      state:Object.fromEntries(Object.entries(container.state ?? {}).map(([state, value]) => [state,pick(value, ['reason', 'exitCode', ...(redactionReady ? ['message'] : [])])]))}))});
  if (pod.status?.phase === 'Succeeded' || (pod.status?.phase === 'Running' && containers.length && containers.every(c => c.ready))) continue;
  if (!redactionReady) continue;
  const described = kubectl(['describe', 'pod', name, '-n', namespace]);
  print(`describe pod ${namespace}/${name} (names and states):`);
  // Keep state fields only: describe also contains literal env, arguments and annotations.
  print((described.stdout ?? '').split('\n').filter(line => /^\s*(Name|Namespace|Status|State|Last State|Reason|Exit Code|Ready|Restart Count):/.test(line)).join('\n'));
  for (const container of [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])]) {
    const restarted = containers.some(c => c.name === container.name && c.restartCount > 0);
    for (const previous of restarted ? [false, true] : [false]) {
      const logs = kubectl(['logs', name, '-n', namespace, '-c', container.name, '--tail=100', '--prefix', ...(previous ? ['--previous'] : [])]);
      print(`logs ${namespace}/${name}/${container.name}${previous ? ' previous' : ''} (exit ${logs.status ?? 'timeout'}):`);
      if (logs.status === 0) print(logs.stdout);
    }
  }
}
for (const event of get('events')) print({resource:'event',namespace:event.metadata.namespace,name:event.metadata.name,
  object:pick(event.involvedObject, ['kind', 'name']), ...pick(event, ['type', 'reason', 'count', ...(redactionReady ? ['message'] : [])])});
