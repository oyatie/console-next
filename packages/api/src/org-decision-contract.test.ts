// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, expectTypeOf, test } from "vitest";
import type { operations } from "./schema";

type DecisionConflict = operations["decideOrgChangeApprovalStep"]["responses"][409]["content"]["application/json"];

const conflicts = [
  { error: { code: "lifecycle.refuse.stale_version", message: "stale", details: { current_version: "opaque:step:2" } } },
  { error: { code: "lifecycle.refuse.withdrawn", message: "withdrawn" } },
  { error: { code: "org_change_sod_violation", message: "separation of duties" } },
  { error: { code: "lifecycle.refuse.merge_not_allowed", message: "merge refused" } },
  { error: { code: "conflict", message: "state conflict" } },
] satisfies DecisionConflict[];

test.each(conflicts)("decision 409 $error.code satisfies the generated operation type", (body) => {
  expectTypeOf(body).toExtend<DecisionConflict>();
  expectTypeOf<NonNullable<DecisionConflict["error"]["details"]>["current_version"]>().toEqualTypeOf<string | undefined>();
  expectTypeOf<DecisionConflict["error"]["current_version"]>().toEqualTypeOf<number | undefined>();
  expect(Object.keys(body)).toEqual(["error"]);
});
