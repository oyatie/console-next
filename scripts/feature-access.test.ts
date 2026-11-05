// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { featureAccess, generatedFeatureAccess, output, generatedOperationAccess, operationAccess, operationOutput } from "./gen-feature-access.mjs";

const yaml = createRequire(import.meta.url)("js-yaml");

test("the generated permissions match the server's exhaustive feature tags", () => {
  expect(readFileSync(output, "utf8")).toBe(generatedFeatureAccess());
  expect(readFileSync(operationOutput, "utf8")).toBe(generatedOperationAccess());
  const source = readFileSync("backend/crates/platform/authz/src/access/tags.rs", "utf8");
  const tagged = source.slice(source.indexOf("match feature"), source.indexOf("F::Login"));
  expect(Object.keys(featureAccess()).sort()).toEqual([...tagged.matchAll(/F::(\w+)/g)].map(([, name]) => name).sort());
});

test("an unknown Cedar action makes generation fail closed", () => {
  const spec = yaml.load(readFileSync("backend/openapi/openapi.yaml", "utf8"));
  spec.paths["/api/v1/employees/lifecycle-events/bulk"].post["x-console-authz"].action = "missing_action";
  expect(() => operationAccess(spec)).toThrow("Invalid Cedar action contract: post /api/v1/employees/lifecycle-events/bulk");
});

test("server-fact actions validate enrollment without projecting a browser grant", () => {
  const spec = yaml.load(readFileSync("backend/openapi/openapi.yaml", "utf8"));
  const operation = spec.paths["/api/v1/sync"].post;
  operation["x-console-authz"] = { engine: "cedar", permission: "WorkOrderStart", action: "work_order_start", scope: "tenant" };
  expect(operationAccess(spec)["POST /api/v1/sync"]).toBeUndefined();
  for (const invalid of [{ action: "missing_action" }, { permission: "Login" }, { scope: "any" }]) {
    const saved = operation["x-console-authz"];
    operation["x-console-authz"] = { ...saved, ...invalid };
    expect(() => operationAccess(spec)).toThrow("Invalid Cedar action contract: post /api/v1/sync");
    operation["x-console-authz"] = saved;
  }
});
