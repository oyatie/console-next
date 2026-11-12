// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const env = process.env;
const execute = (command, args, options = {}) => {
  const result = spawnSync(command, args, {encoding: 'utf8', ...options});
  assert.ifError(result.error);
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '');
    process.exitCode = result.status || 1;
    throw new Error(`${command} failed (${result.status})`);
  }
  return result.stdout;
};
function main() {
  assert.ok(['true', 'false'].includes(env.NOTIFY_DRY_RUN), 'NOTIFY_DRY_RUN must be true or false');
  assert.ok(env.NOTIFY_TITLE && env.NOTIFY_BODY && env.RUN_URL, 'notification title, body and run URL are required');
  let body = `${env.NOTIFY_BODY}\n\n${env.RUN_URL}\nArtifacts: ${env.RUN_URL}#artifacts`;
  if (env.NOTIFY_FAILED_JOBS === 'true') {
    const pages = JSON.parse(execute('gh', ['api', '--paginate', '--slurp', `repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT || '1'}/jobs?per_page=100`]));
    for (const job of pages.flatMap(page => page.jobs)) {
      if (['success', 'skipped'].includes(job.conclusion)) continue;
      const steps = job.steps.filter(step => step.conclusion === 'failure').map(step => step.name).join(', ');
      body += `\n${job.name}: ${job.conclusion ?? job.status}${steps ? ` (${steps})` : ''} ${job.html_url}`;
    }
  }
  const payload = {title: env.NOTIFY_TITLE, body};
  mkdirSync('.cache/ci-alert', {recursive: true});
  writeFileSync('.cache/ci-alert/notification.json', JSON.stringify(payload, null, 2));
  if (env.NOTIFY_DRY_RUN === 'true') {
    console.log(`Notification dry run: ${JSON.stringify(payload)}`);
  } else {
    for (const key of ['OCI_CONFIG', 'OCI_API_KEY', 'ONS_TOPIC_ID']) assert.ok(env[key], `${key} is required`);
    const directory = mkdtempSync(path.join(env.RUNNER_TEMP, 'oci-notify-'));
    try {
      writeFileSync(path.join(directory, 'key.pem'), `${env.OCI_API_KEY}\n`, {mode: 0o600});
      writeFileSync(path.join(directory, 'config'), `${env.OCI_CONFIG}\nkey_file=/oci/key.pem\n`, {mode: 0o600});
      execute('docker', ['run', '--rm', '--user', `${process.getuid()}:${process.getgid()}`, '-v', `${directory}:/oci:ro`,
        '-e', 'OCI_CLI_CONFIG_FILE=/oci/config', '-e', 'OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING=True',
        'ghcr.io/oracle/oci-cli:20261007@sha256:48884d8710d30356cac71c7aa678873a97c53c594fefdf2724c80270f3ca563b',
        'ons', 'message', 'publish', '--auth', 'api_key', '--topic-id', env.ONS_TOPIC_ID,
        '--title', payload.title, '--body', payload.body]);
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  }
}
try { main(); } catch (error) {
  console.error(error.message);
  process.exitCode ||= 1;
}
