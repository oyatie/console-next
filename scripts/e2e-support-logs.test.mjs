// SPDX-License-Identifier: LicenseRef-Proprietary
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { supportLogs } from "./e2e-support-logs.mjs";

test("lookup reads real structured metadata and omits payloads", async () => {
  const store = await supportLogs();
  const stream = new PassThrough();
  const reader = store.observe(stream);
  try {
    const ref = "0123456789abcdef0123456789abcdef";
    stream.write(JSON.stringify({ fields: { message: "support reference", support_ref: ref, trace_id: ref, release: "entryHash", route_template: "/forced", org_id: "test-org", support_ref_at: "2026-10-22T00:00:00Z", private_input: "must not leave" } }) + "\n");
    const url = new URL(store.url);
    url.search = new URLSearchParams({ query: `fields.support_ref:="${ref}" | fields fields.trace_id`, limit: "1" });
    const response = await fetch(url);
    const row = await response.json();
    assert.equal(row["fields.trace_id"], ref);
    assert.equal(row["fields.route_template"], "/forced");
    assert.equal(Object.keys(row).length, 6);
    assert.equal((await fetch(store.url)).status, 400);
  } finally { reader.close(); stream.end(); await store.close(); }
});
