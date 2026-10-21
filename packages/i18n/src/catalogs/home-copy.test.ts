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
