// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { openTenant } from "./helpers/tenant";
import { go } from "./flows";

test("access-log review settings expose plan defaults and reject invalid policy values", async ({ browser }) => {
  const admin = await openTenant(browser, "logreview", "접속기록 점검");
  const bearer = bearerOf(admin);
  await go(admin, "/");
  await expect.poll(bearer, { timeout: 15_000 }).not.toBe("");
  const api = apiOf(admin, bearer);
  const settings = await api("/settings");
  expect(settings.status()).toBe(200);
  type Setting = { key: string; value: unknown; default: unknown };
  const reviewSettings = ({ items }: { items: Setting[] }) => items.filter(({ key }) => key.startsWith("access_log_review."));
  const before = reviewSettings(await settings.json() as { items: Setting[] });
  expect(before).toHaveLength(11);
  expect(before.find(({ key }) => key.endsWith(".time_zone"))?.value).toBe("Asia/Seoul");
  expect(before.find(({ key }) => key.endsWith(".every_download"))?.value).toBe(true);
  for (const suffix of ["bulk_subjects_min", "denied_min"]) {
    expect(before.find(({ key }) => key.endsWith(`.${suffix}`))).toMatchObject({ default: null, value: null });
  }
  for (const [suffix, value, code] of [
    ["cadence_months", 0, "setting_out_of_range"],
    ["off_hours.start_hour", 24, "setting_out_of_range"],
    ["flag.bulk_subjects_min", 0, "setting_out_of_range"],
    ["time_zone", "UTC", "setting_value_invalid"],
  ] as const) {
    const response = await api(`/settings/access_log_review.${suffix}`, "POST", { value, reason_code: "POLICY_REVIEW" });
    expect(response.status()).toBe(422);
    expect(await codeOf(response)).toBe(code);
  }
  const after = await api("/settings");
  expect(reviewSettings(await after.json() as { items: Setting[] })).toEqual(before);
});
