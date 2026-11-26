// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import yaml from 'js-yaml';

const source = 'console-db';
const stale = 'console-restore-before-erase';
const current = 'console-restore';
const evidence = '.tmp/evidence';
const witnessPath = `${evidence}/erasure-witness.json`;
const run = (command, args, options = {}) => execFileSync(command, args, {encoding:'utf8', ...options}).trim();
const kubectl = (...args) => run('kubectl', args);
const flux = (...args) => run('flux', args);

function sql(cluster, statement, variables = {}) {
  const primary = kubectl('get', 'cluster', cluster, '-n', 'console', '-o', 'jsonpath={.status.currentPrimary}');
  assert.ok(primary, `missing primary for ${cluster}`);
  const bindings = Object.entries(variables).flatMap(([key, value]) => ['-v', `${key}=${value}`]);
  return run('kubectl', ['exec', '-i', '-n', 'console', primary, '-c', 'postgres', '--',
    'psql', '-XqAt', '-U', 'postgres', '-d', 'console', '-v', 'ON_ERROR_STOP=1', ...bindings], {input:statement});
}

// Owner-only historical approval fixture, matching backend/test_support/governed_erase.rs.
// The live erasure command checks both proofs, the cooling period and legal holds.
export const seed = `
  BEGIN;
  INSERT INTO organizations (id, slug, name, status)
    VALUES (:'org', 'exit-erase-probe', 'Synthetic restore probe', 'ARCHIVED');
  INSERT INTO tenant_encryption_keys
    (org_id, key_scope, key_version, state, alg_id, kek_id, wrapped_dek, key_fingerprint)
    VALUES (:'org', 'mail', 1, 'ACTIVE', 'fixture', 'exit-test', gen_random_bytes(48), gen_random_bytes(32));
  COMMIT;`;

export const erase = `
  BEGIN;
  INSERT INTO organizations (id, slug, name) VALUES ('00000000-0000-0000-0000-00000000face', 'platform', 'Platform')
    ON CONFLICT (id) DO NOTHING;
  SELECT id AS platform FROM organizations WHERE slug = 'platform' \\gset
  INSERT INTO users (id, org_id, display_name, roles)
    SELECT id, :'platform', 'Synthetic erasure operator', ARRAY['SUPER_ADMIN']
    FROM (VALUES (:'requester'::uuid), (:'approver'::uuid)) AS operators(id);
  WITH credentials AS (
    INSERT INTO auth_webauthn_credentials (user_id, org_id, credential_id, passkey_json)
      SELECT id, org_id, gen_random_uuid()::text, '{}' FROM users WHERE id IN (:'requester', :'approver')
      RETURNING id, org_id, user_id
  ) INSERT INTO step_up_assertions
      (ceremony_id, org_id, user_id, credential_row_id, action_kind, object_id, payload_hash, user_verified, asserted_at)
    SELECT CASE WHEN user_id = :'requester' THEN :'opened'::uuid ELSE :'approved'::uuid END,
      org_id, user_id, id, 'OPERATOR_RECOVERY', :'request',
      encode(digest('tenant_erase:' || :'org' || ':' || :'request' || ':' ||
        CASE WHEN user_id = :'requester' THEN 'open' ELSE 'approve' END, 'sha256'), 'hex'),
      true, now() - interval '8 days' FROM credentials;
  INSERT INTO tenant_erase_requests (org_id, id, target_org_id, requested_by, opened_at, open_assertion)
    VALUES (:'platform', :'request', :'org', :'requester', now() - interval '8 days', :'opened');
  UPDATE tenant_erase_requests SET approved_by = :'approver', approved_at = now() - interval '8 days',
    cooling_until = now() - interval '1 day', approve_assertion = :'approved' WHERE id = :'request';
  SELECT platform_force_remove_organization_command(:'org', :'approver',
    replace(gen_random_uuid()::text, '-', '')::char(32), left(replace(gen_random_uuid()::text, '-', ''), 16)::char(16),
    clock_timestamp()) AS outcome \\gset
  COMMIT;
  SELECT json_build_object('org', target_org_id, 'request', id, 'seq', erasure_witness_seq,
    'hash', encode(erasure_witness_hash, 'hex')) FROM tenant_erase_requests
    WHERE id = :'request' AND :'outcome' = 'removed' AND erased_at IS NOT NULL;`;

export const inspect = `
  SELECT json_build_object(
    'tenantPresent', EXISTS (SELECT 1 FROM organizations WHERE id = :'org'),
    'wrappedKeys', (SELECT count(*) FROM tenant_encryption_keys WHERE org_id = :'org' AND wrapped_dek IS NOT NULL),
    'shreddedScopes', (SELECT count(DISTINCT key_scope) FROM tenant_encryption_keys WHERE org_id = :'org'
      AND shredded_request_id = :'request' AND state = 'SHREDDED' AND wrapped_dek IS NULL),
    'hash', (SELECT encode(entry_hash, 'hex') FROM erasure_ledger WHERE org_id = :'org' AND seq = :'seq'));`;

export function verifyErasure(witness, restored) {
  assert.match(witness.hash, /^[a-f0-9]{64}$/, 'missing independent erasure witness');
  assert.ok(Number.isSafeInteger(witness.seq) && witness.seq > 0, 'invalid erasure sequence');
  assert.equal(restored.hash, witness.hash, 'withhold recovery: erasure witness missing or different');
  assert.equal(restored.tenantPresent, false, 'withhold recovery: erased tenant present');
  assert.equal(restored.wrappedKeys, 0, 'withhold recovery: wrapped tenant key present');
  assert.equal(restored.shreddedScopes, 2, 'withhold recovery: missing key scope tombstones');
}

async function drill() {
  assert.match(kubectl('config', 'current-context'), /^kind-platform-exit-[0-9]+$/);
  assert.equal(kubectl('get', 'namespace', 'console', '-o', 'jsonpath={.metadata.labels.env}'), 'exit-test');

  const ids = {org:randomUUID(), request:randomUUID(), requester:randomUUID(), approver:randomUUID(),
    opened:randomUUID(), approved:randomUUID()};
  const census = cluster => sql(cluster, `SELECT
    (SELECT count(*) FROM users WHERE id NOT IN (:'requester', :'approver'))::text || ':' ||
    (SELECT count(*) FROM _sqlx_migrations)::text`, ids);
  const before = census(source);
  assert.ok(Number(before.split(':')[0]) > 0, 'restore must contain the synthetic OTP account');
  flux('create', 'kustomization', 'console-backup', '--source=OCIRepository/console-deploy',
    '--path=./tests/backup', '--prune', '--interval=1m');
  flux('reconcile', 'kustomization', 'console-backup', '--timeout=120s');
  kubectl('wait', '--for=jsonpath={.status.phase}=completed', 'backup/console-exit-backup', '-n', 'console', '--timeout=600s');

  // Both the insertion and the erasure must be recovered from WAL after the base backup.
  sql(source, seed, ids);
  const beforeErasure = sql(source, "SELECT pg_create_restore_point('exit_before_erasure')");
  assert.match(beforeErasure, /^[0-9A-F]+\/[0-9A-F]+$/);
  const original = JSON.parse(sql(source, erase, ids));
  assert.equal(original.org, ids.org);
  assert.equal(original.request, ids.request);
  writeFileSync(witnessPath, JSON.stringify(original, null, 2));
  const segment = sql(source, "SELECT pg_walfile_name(pg_create_restore_point('exit_after_erasure'))");
  assert.match(segment, /^[0-9A-F]{24}$/);
  sql(source, 'SELECT pg_switch_wal()');
  const deadline = Date.now() + 180_000;
  while (sql(source, `SELECT coalesce(last_archived_wal ~ '^[0-9A-F]{24}$' AND
      last_archived_wal >= :'segment', false) FROM pg_stat_archiver`, {segment}) !== 't') {
    assert.ok(Date.now() < deadline, 'erasure WAL segment did not reach the archive');
    await setTimeout(1000);
  }

  const restore = yaml.load(flux('create', 'kustomization', 'console-restore', '--source=OCIRepository/console-deploy',
    '--path=./tests/restore', '--prune', '--wait', '--interval=1m', '--timeout=8m', '--export'));
  restore.spec.postBuild = {substitute:{BEFORE_ERASURE_LSN:beforeErasure}};
  run('kubectl', ['apply', '-f', '-'], {input:JSON.stringify(restore)});
  flux('reconcile', 'kustomization', 'console-restore', '--timeout=10m');
  for (const cluster of [stale, current]) {
    kubectl('wait', '--for=condition=Ready', `cluster/${cluster}`, '-n', 'console', '--timeout=180s');
  }

  const witness = JSON.parse(readFileSync(witnessPath, 'utf8'));
  const state = cluster => JSON.parse(sql(cluster, inspect, witness));
  const preErasure = state(stale);
  assert.deepEqual(preErasure, {tenantPresent:true, wrappedKeys:1, shreddedScopes:0, hash:null},
    'PITR must reach the tenant and key before erasure');
  assert.throws(() => verifyErasure(witness, preErasure), /withhold recovery/);
  const postErasure = state(current);
  verifyErasure(witness, postErasure);
  const after = census(current);
  assert.equal(after, before, 'synthetic users and migration lineage must survive S3 recovery');
  writeFileSync(`${evidence}/restore.json`, JSON.stringify({before, after, source, recovered:current,
    withheld:stale, beforeErasure, erasureWal:segment, preErasure, postErasure}, null, 2));
}

if (import.meta.main) await drill();
