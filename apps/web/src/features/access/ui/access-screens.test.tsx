import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { fmtStamp } from "@console/i18n/format";
import type { AccessEffectiveEntry, AccessGrant, AccessGrantPreview, Account } from "../api";
import { grantLines } from "../../../reference/authz/present";
import { periodText } from "../present";
import { BulkPreview } from "./bulk-preview";
import { GrantState } from "./grants-page";
import { EnforcementChip } from "./holder";
import { RoleDiff } from "./role-diff";

beforeAll(() => loadCatalog("ko"));

const grant = (o: Partial<AccessGrant>): AccessGrant => ({
  id: "g1", account_id: "a1", account_display_name: "김부장", account_active: true, account_has_passkey: true, role_id: "r1", role_name_ko: "팀 조회",
  scope: { kind: "TENANT", include_descendants: true }, valid_from: "2026-10-01T00:00:00Z", effective_in_setup: false, enforcement: "ENFORCED",
  reason_code: "OTHER", granted_by: "ops", granted_at: "2026-10-01T00:00:00Z", ...o,
});

test("future effective states stay visible in My access and the person access view", () => {
  const entry: AccessEffectiveEntry = {
    domain: "org", level: "view", scope: { kind: "TENANT", include_descendants: true },
    grant_id: "g1", role_id: "r1", role_name_ko: "Read", valid_from: "2026-10-01T00:00:00Z",
    enforcement: "FUTURE_STATE", caveats: [],
  };
  expect(grantLines([entry])[0]?.state).toBe("FUTURE_STATE");
  expect(renderToStaticMarkup(<EnforcementChip e={entry.enforcement} />)).toBe('<span class="chip chip--neutral">FUTURE_STATE</span>');
  expect(grantLines([{ ...entry, enforcement: "ENFORCED" }])[0]?.state).toBeUndefined();
  expect(grantLines([{ ...entry, enforcement: "ACCOUNT_INACTIVE" }])[0]?.state).toBe("멈춤 · 계정 비활성");
});

test("regression (people-self-46): a grant on a deactivated account reads 멈춤 with its fix, never 적용 중", () => {
  const off = renderToStaticMarkup(<GrantState g={grant({ account_active: false })} fresh={false} />);
  expect(off).toContain("멈춤 · 계정 비활성");
  expect(off).not.toContain("적용 중");
  expect(renderToStaticMarkup(<GrantState g={grant({})} fresh />)).toContain("방금 부여");
});

test("regression (governance-32): the bulk preview says 부여 가능 before commit and names who has no passkey", () => {
  const preview: AccessGrantPreview = {
    receipt_id: "r", phase: "OPERATING", step_up_required: true, refused: 0, accounts_affected: 1,
    items: [{ index: 0, op: "grant", outcome: "OK", account_id: "a1", enforcement_after: "ENFORCED" }],
  };
  const accounts = [{ id: "a1", display_name: "박담당", employee_number: "E-1", has_passkey: false, is_active: true }] as unknown as Account[];
  // The role's name goes in as a plain prop object (a JSX `role=` would read as an ARIA role to the linter).
  const props = { preview, accounts, role: "권한 관리 담당", scope: "전체", end: "2027-04-08", pending: false, error: null, onBack: () => {}, onDropRefused: () => {}, onApply: () => {} };
  const html = renderToStaticMarkup(<BulkPreview {...props} />);
  expect(html).toContain("부여 가능");
  expect(html).not.toContain("부여됨");
  expect(html).toContain("패스키 없음 · 등록한 뒤 사용");
  expect(html).toContain("패스키가 없는 사람 1명: 박담당");
});

test("ROL-M2: a held role's edit shows what each domain gains and loses before the reason and passkey", () => {
  const html = renderToStaticMarkup(<RoleDiff before={{ hr_basic: ["edit"] }} after={{ hr_basic: ["edit", "export"], org: ["view"] }} order={["org", "hr_basic"]} />);
  expect(html).toContain("저장하면 바뀌는 것");
  expect(html).toContain("더함: 조회");
  expect(html).toContain("더함: 내보내기");
});


test("F8: a pending grant shows its configured activation date", () => {
  const pending = grant({ valid_from: "2026-10-01T00:00:00Z", activates_at: "2026-10-03T00:00:00Z", enforcement: "SCHEDULED" });
  expect(periodText(pending)).toContain(fmtStamp(pending.activates_at));
  expect(periodText(pending)).not.toContain(fmtStamp(pending.valid_from));
});

test("F8: bulk delayed grants never promise application today", () => {
  const preview: AccessGrantPreview = { receipt_id: "r", phase: "OPERATING", step_up_required: true, refused: 0, accounts_affected: 1,
    items: [{ index: 0, op: "grant", outcome: "OK", account_id: "a1", enforcement_after: "SCHEDULED" }] };
  const props = { preview, accounts: [], role: "역할", scope: "전체", end: "2027-04-08", pending: false, error: null, onBack: () => {}, onDropRefused: () => {}, onApply: () => {} };
  const html = renderToStaticMarkup(<BulkPreview {...props} />);
  expect(html).not.toContain("오늘 ~");
  expect(html).toContain("시작 전");
});


test("F8: scheduled preview shows the server deadline without promising immediate application", () => {
  const at = "2026-10-03T02:34:00Z";
  for (const state of ["SCHEDULED", "PREPARED", "ENFORCED"] as const) {
    const preview = { receipt_id: "r", phase: state === "PREPARED" ? "SETUP" : "OPERATING", step_up_required: true, refused: 0, accounts_affected: 1,
      items: [{ index: 0, op: "grant", outcome: "OK", account_id: "a1", enforcement_after: state, activates_at: at }] } as AccessGrantPreview;
    const props = { preview, accounts: [], role: "역할", scope: "전체", end: "2027-04-08", pending: false, error: null, onBack: () => {}, onDropRefused: () => {}, onApply: () => {} };
    const html = renderToStaticMarkup(<BulkPreview {...props} />);
    if (state === "SCHEDULED") {
      expect(html).toContain(fmtStamp(at));
      expect(html).not.toContain("모두 한 번에 적용됩니다");
    } else {
      expect(html).not.toContain(fmtStamp(at));
      expect(html).not.toContain("보안 대기");
    }
  }
});
