// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const source = readFileSync(new URL("../backend/crates/platform/access/src/log_review/filters.rs", import.meta.url), "utf8");
const events = source.split("WITH events AS MATERIALIZED (")[1]?.split("actors AS (")[0];

// RLS independently isolates runtime reads; keep the query's own tenant boundary too.
test("filter choices bind the event tenant before projecting actors, actions and targets", () => {
  expect(events).toMatch(/WHERE a\.org_id=\$1\b/);
  expect(source).toContain(".bind(self.org.as_uuid())");
});

test("filter choices exclude ordinary audit events without the access-record marker", () => {
  expect(events).toContain("AND a.after_snap ? 'self_read'");
});
