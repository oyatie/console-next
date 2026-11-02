// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

export function readEnvironment(environment, root = '.') {
  assert.match(environment ?? '', /^[a-z0-9][a-z0-9-]*$/, 'PLAT_OVERLAY: select a committed environment');
  const directory = join(root, 'deploy/clusters', environment);
  assert.ok(existsSync(directory) && lstatSync(directory).isDirectory() &&
    existsSync(join(directory, 'platform.json')) && lstatSync(join(directory, 'platform.json')).isFile(),
  'PLAT_OVERLAY: select a committed environment');
  const config = JSON.parse(readFileSync(join(directory, 'platform.json'), 'utf8'));
  if (config.target !== undefined || config.channel !== undefined) {
    assert.ok(['host', 'kubernetes'].includes(config.target) && typeof config.channel === 'string' &&
      /^[a-z0-9][a-z0-9_.-]*$/.test(config.channel) && config.channel.length <= 87,
    'PROMOTE_ENVIRONMENT: target and channel must be valid; reserve room for the immutable SHA tag');
  }
  return config;
}

export function discoverEnvironments(root = '.') {
  const channels = new Set();
  return readdirSync(join(root, 'deploy/clusters'), {withFileTypes:true})
    .filter(entry => entry.isDirectory()).map(entry => {
      const {target, channel} = readEnvironment(entry.name, root);
      if (channel === undefined) return null;
      assert.ok(!channels.has(channel), 'PROMOTE_ENVIRONMENT: channels must be unique');
      channels.add(channel);
      return {environment:entry.name, target, channel};
    }).filter(Boolean).sort((a, b) => a.environment.localeCompare(b.environment));
}

export function assertPromotion({sha, repository, run, jobs, gatesResult, currentRevision}, root = '.') {
  assert.ok(typeof repository === 'string' && repository.length > 0 && run?.event === 'push' &&
    run.head_branch === 'dev' && run.head_repository?.full_name === repository,
  'PROMOTE_FORK: require a dev push in this repository');
  assert.ok(typeof sha === 'string' && /^(?!0{40}$)[a-f0-9]{40}$/.test(sha) && run.path === '.github/workflows/platform.yml' &&
    run.head_sha === sha && run.status === 'completed' && run.conclusion === 'success' &&
    Number.isSafeInteger(run.id) && run.id > 0 && Array.isArray(jobs) && jobs.length > 0 &&
    new Set(jobs.map(job => job?.id)).size === jobs.length && jobs.every(job =>
      Number.isSafeInteger(job?.id) && job.id > 0 && typeof job.name === 'string' && job.name.length > 0 &&
      job.run_id === run.id && job.head_sha === sha &&
      job.status === 'completed' && job.conclusion === 'success'),
  'PROMOTE_NOT_GREEN: require completed successful jobs for this platform run and SHA');
  const workflow = yaml.load(readFileSync(join(root, '.github/workflows/platform.yml'), 'utf8'));
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const matrix = job.strategy?.matrix;
    if (!matrix) {
      assert.ok(jobs.some(actual => actual.name === name || actual.name.startsWith(`${name} / `)),
        `PROMOTE_NOT_GREEN: missing ${name}`);
      continue;
    }
    // GitHub's default matrix job names follow the declared axis order.
    assert.ok(!matrix.exclude && (!matrix.include || Object.keys(matrix).length === 1),
      'PROMOTE_NOT_GREEN: unsupported matrix; update proof inventory before changing the workflow');
    const rows = matrix.include?.map(row => Object.values(row)) ?? Object.values(matrix)
      .reduce((rows, values) => rows.flatMap(row => values.map(value => [...row, value])), [[]]);
    const expected = rows.map(row => `${name} (${row.join(', ')})`).sort();
    const actual = jobs.filter(job => job.name.startsWith(`${name} (`)).map(job => job.name).sort();
    assert.deepEqual(actual, expected, `PROMOTE_NOT_GREEN: require every ${name} matrix job exactly once`);
  }
  assert.equal(gatesResult, 'pass', 'PROMOTE_GATES: release gates must pass');
  assert.ok(currentRevision === null || typeof currentRevision === 'string' &&
    /^(?!0{40}$)[a-f0-9]{40}$/.test(currentRevision) &&
    spawnSync('git', ['merge-base', '--is-ancestor', currentRevision, sha], {cwd:root}).status === 0,
  'PROMOTE_NOT_DESCENDANT: channel history must be known and an ancestor of the candidate');
}
