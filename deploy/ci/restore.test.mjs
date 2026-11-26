// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyErasure } from './restore.mjs';

test('only a reconciled restore matches the independently retained erasure receipt', () => {
  const witness = {seq:1, hash:'c'.repeat(64)};
  const reconciled = {hash:witness.hash, tenantPresent:false, wrappedKeys:0, shreddedScopes:2};
  for (const state of [
    {hash:null, tenantPresent:true, wrappedKeys:1, shreddedScopes:0},
    {...reconciled, hash:'d'.repeat(64)},
    {...reconciled, tenantPresent:true},
    {...reconciled, wrappedKeys:1},
    {...reconciled, shreddedScopes:1},
  ]) assert.throws(() => verifyErasure(witness, state), /withhold recovery/);
  assert.throws(() => verifyErasure({seq:0, hash:witness.hash}, reconciled), /sequence/);
  assert.throws(() => verifyErasure({seq:1, hash:''}, {...reconciled, hash:''}), /witness/);
  verifyErasure(witness, reconciled);
});
