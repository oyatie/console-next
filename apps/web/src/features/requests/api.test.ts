// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, it } from "vitest";
import { recordHref } from "./api";
it("certificate outcomes link to the document and issuer settings register", () => {
  expect(recordHref("hr_certificate", "cert/id")).toBe("/people/certificates/cert%2Fid");
  expect(recordHref("hr_certificate_settings", "tenant")).toBe("/people/certificates");
});
