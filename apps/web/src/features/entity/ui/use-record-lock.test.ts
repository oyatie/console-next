// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import type { LegalEntity } from "@console/api/pending";
import { lockOf } from "./use-record-lock";

test("a record stays readable while its phase-dependent verbs wait for an authoritative phase", () => {
  const entity = { can_manage: true } as LegalEntity;
  expect(lockOf(entity, false)).toBe("loading");
  expect(lockOf(entity, true)).toBeNull();
  expect(lockOf({ ...entity, read_only: true }, false)).toBe("asof");
  expect(lockOf({ ...entity, can_manage: false }, false)).toBe("reach");
});
