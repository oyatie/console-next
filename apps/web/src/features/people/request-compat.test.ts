// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import type { ChangeRequest } from "./api";
import { kindText, requestedChanges, subjectText } from "./present";

beforeAll(() => loadCatalog("ko"));

// Also run unchanged in the released 89cf5eeb08c2 web tree: generated enums are not runtime validators.
test.each([
  ["IMPORT_ROLLBACK", "DATA_IMPORT_RUN"],
  ["FUTURE_KIND", "FUTURE_SUBJECT"],
])("a client can render an unfamiliar %s / %s request", (kind, subject_type) => {
  const request = { kind, subject_type, payload: {} } as ChangeRequest;
  expect(kindText(request.kind)).toBeTruthy();
  expect(subjectText(request)).toBeTruthy();
  expect(requestedChanges(request)).toEqual([]);
  if (kind === "FUTURE_KIND") {
    expect(kindText(request.kind)).toMatch(/FUTURE_KIND$/);
    expect(subjectText(request)).toMatch(/FUTURE_SUBJECT$/);
  }
});
