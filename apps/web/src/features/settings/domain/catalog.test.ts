// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import type { components } from "@console/api/schema";
import { parseSettingInput } from "./catalog";

function codeEntry(allowed?: string[]): components["schemas"]["SettingEntry"] {
  return {
    key: "approval.policy.org_structure",
    kind: { type: "code", allowed },
    default: "none",
    value: "none",
    looser_when: "higher",
    governance: "tenant",
    legal_basis: null,
    version: "code_default",
    effective_from: null,
    source: { layer: "tenant", scope_entity_id: null },
    chain: [],
    scheduled: [],
  };
}

test("parseSettingInput rejects empty and disallowed values for code entries", () => {
  const restricted = codeEntry(["none", "POLICY_UPDATE"]);
  expect(parseSettingInput(restricted, "")).toEqual({ ok: false, problem: "invalidValue" });
  expect(parseSettingInput(restricted, "   ")).toEqual({ ok: false, problem: "invalidValue" });
  expect(parseSettingInput(restricted, "UNKNOWN_CODE")).toEqual({ ok: false, problem: "invalidValue" });
  expect(parseSettingInput(restricted, " POLICY_UPDATE ")).toEqual({ ok: true, value: "POLICY_UPDATE" });

  const openCode = codeEntry();
  expect(parseSettingInput(openCode, "")).toEqual({ ok: false, problem: "invalidValue" });
  expect(parseSettingInput(openCode, "custom")).toEqual({ ok: true, value: "custom" });
});
