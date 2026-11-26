// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
