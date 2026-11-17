// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { components } from "@console/api";

const roster = readFileSync(new URL("../../backend/crates/settings/domain/src/code_lists/roster.rs", import.meta.url), "utf8");
const exit = roster.match(/ExitReason => "exit_reason" \[([^\]]+)\];/)?.[1];
const other = roster.match(/pub const OTHER: SystemCode = SystemCode \{([^}]+)\}/)?.[1];
assert(exit && other, "reason roster must declare ExitReason and OTHER");
const entry = /"([A-Z_]+)"(?:\s*=>\s*\((true|false),\s*(true|false)\))?/g;
assert.equal(exit.replace(entry, "").replace(/[\s,]/g, ""), "", "unparsed exit reason declaration");

export const exitReasons: components["schemas"]["ReasonCatalogEntry"][] = [
  ...[...exit.matchAll(entry)].map(([, code, involuntary, notice]) => ({
    code: code!, requires_note: false, involuntary: involuntary === "true", notice_required: notice === "true",
  })),
  {
    code: other.match(/code: "([A-Z_]+)"/)![1]!,
    requires_note: /requires_note: true/.test(other),
    involuntary: /involuntary: true/.test(other),
    notice_required: /notice_required: true/.test(other),
  },
].map(value => ({ ...value, system: true, active: true, label_ko: null, label_en: null }));
