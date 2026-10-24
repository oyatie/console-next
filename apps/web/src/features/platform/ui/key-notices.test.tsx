// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { KeyNotices } from "./key-notices";

beforeAll(() => loadCatalog("ko"));
const render = (notices: Parameters<typeof KeyNotices>[0]["notices"]) => renderToStaticMarkup(<KeyNotices notices={notices} />);

test.each(["EXPIRING", "EXPIRED", "REJECTED"] as const)("%s key notices name the integration without claiming success", (state) => {
  const out = render([{ env: "NTS_BUSINESSMAN_API_KEY", state }]);
  expect(out).toContain(t("nts.ops.title"));
  expect(out).toContain("NTS_BUSINESSMAN_API_KEY");
  expect(out).toContain(t(`nts.ops.${state}`, { env: "NTS_BUSINESSMAN_API_KEY" }));
  expect(out).toContain(`data-tone="${state === "EXPIRING" ? "warn" : "danger"}"`);
  expect(out).not.toContain("정상");
  expect(out).not.toContain(t("enum.verification.T2"));
});

test("NTS and existing JUSO notices share the same surface", () => {
  const out = render([{ env: "NTS_BUSINESSMAN_API_KEY", state: "EXPIRED" }, { env: "JUSO_API_KEY", state: "REJECTED" }]);
  expect(out).toContain("NTS_BUSINESSMAN_API_KEY");
  expect(out).toContain("JUSO_API_KEY");
  expect(out.match(/<dt\b/g)).toHaveLength(2);
});

test("expiry and the server's remaining days are presented as facts", () => {
  const out = render([{ env: "NTS_BUSINESSMAN_API_KEY", state: "EXPIRING", expires_on: "2026-11-07", days_left: 14 }]);
  expect(out).toContain(t("nts.ops.expiry"));
  expect(out).toContain(fmtDate("2026-11-07"));
  expect(out).toContain(t("nts.ops.daysLeft"));
  expect(out).toContain(`>${fmtNumber(14)}<`);
});

test("zero and elapsed day counts retain their meaning", () => {
  const today = render([{ env: "JUSO_API_KEY", state: "EXPIRING", days_left: 0 }]);
  const expired = render([{ env: "NTS_BUSINESSMAN_API_KEY", state: "EXPIRED", days_left: -2 }]);
  expect(today).toContain(`>${fmtNumber(0)}<`);
  expect(expired).toContain(`>${fmtNumber(-2)}<`);
});

test("no notices produce no empty success card", () => {
  expect(render([])).toBe("");
});

test("extra provider source and secret values are never rendered", () => {
  const notice = { env: "NTS_BUSINESSMAN_API_KEY", state: "REJECTED" as const, expires_on: null, days_left: null, value: "hidden-fixture-value", source: "hidden-fixture-source" };
  const out = render([notice]);
  expect(out).not.toContain(notice.value);
  expect(out).not.toContain(notice.source);
  expect(out).not.toContain(t("nts.ops.expiry"));
  expect(out).not.toContain(t("nts.ops.daysLeft"));
});
