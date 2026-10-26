// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { featureAccess, generatedFeatureAccess, output, generatedOperationAccess, operationOutput } from "./gen-feature-access.mjs";

test("the generated permissions match the server's exhaustive feature tags", () => {
  expect(readFileSync(output, "utf8")).toBe(generatedFeatureAccess());
  expect(readFileSync(operationOutput, "utf8")).toBe(generatedOperationAccess());
  const source = readFileSync("backend/crates/platform/authz/src/access/tags.rs", "utf8");
  const tagged = source.slice(source.indexOf("match feature"), source.indexOf("F::Login"));
  expect(Object.keys(featureAccess()).sort()).toEqual([...tagged.matchAll(/F::(\w+)/g)].map(([, name]) => name).sort());
});
