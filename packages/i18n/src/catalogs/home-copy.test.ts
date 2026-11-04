// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { en } from "./en";
import { ko } from "./ko";

// regression (governance-07, worst-case-38): the go-live preview promised 「운영 시작 후 지정」 and the rail
// 「지정할 수 있게 되면 여기에 알려 드리며」 for a security contact no screen can record. Since UX-R2 SETUP (company-49) the
// rail and the preview name no capability that is not offered at all, so neither line has copy.
const NO_PROMISE = ["setup.remedy.security_contact_store_pending", "setup.golive.item.security_contact_store_pending"];

test.each(NO_PROMISE)("regression governance-07 / company-49: %s has no copy", (id) => {
  expect(Object.hasOwn(ko, id)).toBe(false);
  expect(Object.hasOwn(en, id)).toBe(false);
});

test.each([
  "registration_check", "identifier_correction_waiting", "identifier_correction_decide", "identifier_correction_apply", "identifier_correction_review",
  "support_access", "approval", "org_change", "org_change_waiting", "org_change_scheduled", "org_change_approve", "org_change_apply", "org_change_draft", "org_change_rejected", "org_change_settle",
  "hr_exit", "hr_exit_confirm", "hr_exit_confirm_hq", "hr_exit_settle", "hr_lifecycle", "lifecycle_apply_failed", "hr_request", "register_review", "identity_review",
  "contract_renewal", "insurance_filing", "period_unlock", "grant_notice", "dispatch", "support", "work", "payroll", "governance", "unknown",
])("inbox kind %s has a reason in both catalogs", kind => {
  const key = `home.inbox.reason.${kind}`;
  expect(Object.hasOwn(ko, key)).toBe(true);
  expect(Object.hasOwn(en, key)).toBe(true);
});
