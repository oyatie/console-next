// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test.each([
  "cases/dates.rs",
  "cases/open.rs",
  "statutory/filing_query.rs",
  "statutory/filing_read.rs",
  "statutory/filing_request.rs",
  "statutory/filing_write.rs",
])("%s reads statutory windows and zones from the register", (file) => {
  const source = readFileSync(`backend/crates/hr/adapter-postgres/src/${file}`, "utf8");
  expect(source).not.toMatch(/today_kst|offset!\s*\(\s*\+?9\s*\)|Duration::days\(\s*\d+\s*\)/);
});
