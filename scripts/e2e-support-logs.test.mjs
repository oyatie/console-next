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
    url.search = new URLSearchParams({ query: `fields.support_ref:="${ref.slice(0, 8)}"* | uniq by (fields.trace_id)`, limit: "2" });
    assert.equal((await (await fetch(url)).json())["fields.support_ref"], ref);
    const other = ref.slice(0, 8) + "f".repeat(24);
    stream.write(JSON.stringify({ fields: { message: "support reference", support_ref: other, trace_id: other } }) + "\n");
    const collisions = (await (await fetch(url)).text()).trim().split("\n").map(JSON.parse);
    assert.equal(collisions.length, 2);
    assert.equal((await fetch(store.url)).status, 400);
  } finally { reader.close(); stream.end(); await store.close(); }
});
