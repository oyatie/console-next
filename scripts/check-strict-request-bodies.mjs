#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripRustCommentsAndStringLiterals } from "./check-executed-tests-cfg.mjs";
import { collectRustRequestBodies } from "./check-request-body-contract.mjs";

// These inherited fixes cannot return to the broader legacy-body baseline.
export const STRICT_REQUEST_BODIES = Object.freeze([
  ["backend/crates/ontology/rest/src/request_bodies.rs", [
    "ObjectTypeLifecycleRequest", "AttachObjectPolicyRequest", "LifecycleRequest",
  ]],
  ["backend/crates/governance/rest/src/request_bodies.rs", [
    "DecideApprovalRequest", "ConfigureTransitionRequest", "PreflightRequest",
  ]],
  ["backend/app/src/lifecycle_bodies.rs", ["TransitionLifecycleRequest", "SetLifecycleHoldRequest"]],
  ["backend/app/src/objects_bodies.rs", ["CreateObjectLinkRequest"]],
  ["backend/app/src/hr_bodies.rs", ["CreateEmployeeAttendanceRecordRequest"]],
  ["backend/crates/hr/adapter-postgres/src/exits/types.rs", [
    "ReportEmployeeExitCaseRequest", "ConfirmEmployeeExitCaseRequest", "DraftEmployeeExitApprovalRequest",
  ]],
  ["backend/crates/hr/adapter-postgres/src/lifecycle/requests.rs", [
    "CreateEmployeeLifecycleEventRequest",
  ]],
  ["backend/crates/platform/authz-rest/src/request_bodies.rs", [
    "CreateDraftBody", "UpdateDraftBody", "ReviewBody", "SimulateBody", "AuthorizeBody", "BulkAuthorizeBody",
  ]],
  ["backend/crates/identity/rest/src/policy/dto.rs", [
    "CreatePolicyRoleRequest", "UpdatePolicyRoleRequest", "UpdatePolicyRoleStatusRequest",
    "PolicyRoleStatusPreviewRequest", "ReplacePolicyRoleAssignmentsRequest",
  ]],
  ["backend/crates/identity/rest/src/users/dto.rs", [
    "CreateUserRequest", "UpdateUserRequest", "UpdateSelfRequest",
  ]],
  ["backend/crates/notices/rest/src/request_bodies.rs", ["CreateDraftBody", "UpdateDraftBody"]],
].flatMap(([file, names]) => names.map((name) => Object.freeze({ file, name }))));

export function check(root) {
  const sources = new Map();
  const failures = [];
  for (const { file, name } of STRICT_REQUEST_BODIES) {
    if (!sources.has(file)) {
      try {
        sources.set(file, stripRustCommentsAndStringLiterals(readFileSync(resolve(root, file), "utf8")));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        sources.set(file, "");
      }
    }
    const declarations = [...sources.get(file).matchAll(new RegExp(
      `((?:#\\s*\\[[^\\]]*\\]\\s*)*)(?:pub(?:\\([^)]*\\))?\\s+)?struct\\s+${name}\\b`, "g",
    ))];
    if (declarations.length !== 1) {
      failures.push(`${file}::${name}: expected one request DTO, found ${declarations.length}`);
      continue;
    }
    if (!/#\s*\[\s*serde\s*\([^)]*\bdeny_unknown_fields\b[^)]*\)\s*\]/.test(declarations[0][1])) {
      failures.push(`${file}::${name}: missing #[serde(deny_unknown_fields)]`);
    }
  }
  return failures;
}

export function checkCensus(root, baseline) {
  return compareCensus(collectRustRequestBodies(root), baseline);
}

export function compareCensus(bodies, baseline) {
  const exceptions = new Set(baseline.map(({file, name}) => `${file}::${name}`));
  const failures = bodies.filter(b => !b.denyUnknown && !exceptions.has(`${b.file}::${b.name}`))
    .map(b => `${b.file}::${b.name}: new request body must reject unknown fields`);
  // Freeze the remaining inherited exceptions; removing a body or tightening it shrinks this list.
  const live = new Set(bodies.filter(b => !b.denyUnknown).map(b => `${b.file}::${b.name}`));
  for (const key of exceptions) if (!live.has(key)) failures.push(`${key}: stale strictness exception`);
  if (bodies.length < 207) failures.push(`request-body census shrank below 207 (${bodies.length})`);
  if (exceptions.size > 105) failures.push("legacy strictness exceptions cannot grow above 105");
  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url));
  const failures = check(root);
  if (!failures.length) {
    const baseline = JSON.parse(readFileSync(resolve(root, "scripts/strict-request-body-baseline.json"), "utf8"));
    failures.push(...checkCensus(root, baseline));
  }
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`strict request bodies passed (${STRICT_REQUEST_BODIES.length} inherited fixes; all 207+ resolved bodies ratcheted)`);
  }
}
