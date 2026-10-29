// SPDX-License-Identifier: LicenseRef-Proprietary
// Best-effort failure evidence for disposable clusters; never dump specs or Secret objects.
import { spawn, spawnSync } from 'node:child_process';

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
remember(process.env.REGISTRY_TOKEN);
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
    try {
      const items = JSON.parse(result.stdout).items ?? [];
      print(`${resource}: ${items.length} found`);
      if (['jobs', 'events'].includes(resource)) for (const namespace of ['console', 'cnpg-system']) {
        const scoped = items.filter(item => item.metadata.namespace === namespace);
        print(`${resource} ${namespace}: ${scoped.length} found${resource === 'events' ? `, ${scoped.filter(event => event.reason === 'FailedCreate').length} FailedCreate` : ''}`);
      }
      return items;
    } catch { /* Continue with other resource types. */ }
  }
  print(`${resource}: unavailable (exit ${result.status ?? 'timeout'})`);
  return [];
}
const pick = (value, fields) => Object.fromEntries(fields.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const conditionFields = ['type', 'status', 'reason', ...(redactionReady ? ['message'] : [])];
function metricResults(status) {
  if (redactionReady) return status?.metricResults ?? [];
  return (status?.metricResults ?? []).map(metric => ({
    ...pick(metric, ['name', 'phase', 'count', 'successful', 'failed', 'error', 'inconclusive']),
    measurements:(metric.measurements ?? []).map(measurement => pick(measurement,
      ['phase', 'startedAt', 'finishedAt'])),
  }));
}
async function readyz(pod) {
  const {name, namespace} = pod.metadata;
  const container = pod.spec?.containers?.find(container => container.readinessProbe?.httpGet);
  const probe = container?.readinessProbe.httpGet;
  const port = typeof probe?.port === 'string' ? container.ports?.find(port => port.name === probe.port)?.containerPort : probe?.port;
  if (!probe || !port) { print({resource:'readyz',namespace,name,error:'HTTP readiness probe unavailable'}); return; }
  // The runtime image has no shell or curl. Forward directly to every pod, including unready ones.
  const forward = spawn('kubectl', ['port-forward', '-n', namespace, `pod/${name}`, `:${port}`, '--address=127.0.0.1', '--pod-running-timeout=10s'], {stdio:['ignore','pipe','ignore']});
  try {
    const localPort = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('PortForwardTimeout')), 15_000);
      const fail = () => { clearTimeout(timer); reject(new Error('PortForwardUnavailable')); };
      forward.once('error', fail);
      forward.once('exit', fail);
      let output = '';
      forward.stdout.on('data', data => {
        output = (output + data).slice(-1024);
        const match = output.match(/Forwarding from 127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    const response = await fetch(`http://127.0.0.1:${localPort}${probe.path}`, {signal:AbortSignal.timeout(10_000)});
    const body = await response.json();
    // Only the readiness contract's enums bypass redaction, even if a secret equals a status label.
    const labels = {};
    for (const field of ['status', 'database', 'leave_command_database', 'ontology_command_database', 'platform_force_command_database']) {
      if (['ready', 'not_ready', 'draining', 'unreachable', 'not_configured'].includes(body[field])) labels[field] = body[field];
    }
    if (['api', 'worker', 'migrate'].includes(body.role)) labels.role = body.role;
    if (typeof body.write_ready === 'boolean') labels.write_ready = body.write_ready;
    if (redactionReady && typeof body.service === 'string') labels.service = redact(body.service);
    console.log(JSON.stringify({resource:'readyz',namespace,name,httpStatus:response.status,body:labels}));
  } catch (error) {
    print({resource:'readyz',namespace,name,error:error.name === 'Error' ? error.message : error.name});
  } finally { forward.kill(); }
}
for (const resource of ['kustomizations', 'helmreleases', 'ocirepositories', 'jobs', 'rollouts', 'analysisruns', 'clusters']) {
  for (const item of get(resource)) print({resource,namespace:item.metadata.namespace,name:item.metadata.name,
    ...pick(item.status, ['phase', 'replicas', 'readyReplicas', 'active', 'failed', 'succeeded']),
    ...(resource === 'analysisruns' ? {metricResults:metricResults(item.status)} : {}),
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
  if (pod.metadata.labels?.app === 'console-api') await readyz(pod);
  // A ready operator can repeatedly fail to create a Job without a Pod or event ever existing.
  if (namespace !== 'cnpg-system' && (pod.status?.phase === 'Succeeded' || (pod.status?.phase === 'Running' && containers.length && containers.every(c => c.ready)))) continue;
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
