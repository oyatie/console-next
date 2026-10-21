import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { apiAs, soloTenant } from "./chaos";
import { go } from "./flows";
import { setupCompany } from "./setup-flows";

test("N-1 terms_version from an open tab still accepts the current document", { tag: "@first-run" }, async ({ browser }) => {
  const admin = await soloTenant(browser, "ideal-terms-compat", "약관호환그룹");
  const read = apiAs(admin);
  await setupCompany(admin, "약관호환정밀", "본사");
  const before = await read<{ blockers: { code: string }[] }>("/api/v1/onboarding/go-live/preview");
  expect(before.blockers.some((b) => b.code === "terms_not_accepted")).toBe(true);
  await go(admin, "/setup/go-live");
  await admin.getByRole("button", { name: "이용약관 읽기" }).click();
  const doc = await read<{ version: string; sha256: string; body: string }>("/api/v1/onboarding/terms");
  await expect(admin.getByText(doc.body, { exact: true })).toBeVisible();
  let sent: unknown;
  let conflict = true;
  await admin.route("**/api/v1/onboarding/terms", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    sent = route.request().postDataJSON();
    await route.continue({ postData: JSON.stringify(conflict
      ? { version: doc.version, sha256: doc.sha256, terms_version: "conflicting-version" }
      : { terms_version: doc.version }) });
  });
  const accept = admin.getByRole("button", { name: "고객 계정을 대표해 이용약관 동의" });
  const termsResponse = () => admin.waitForResponse((r) => r.url().endsWith("/api/v1/onboarding/terms") && r.request().method() === "POST");
  const refused = termsResponse();
  await accept.click();
  const rejection = await refused;
  expect(rejection.status()).toBe(422);
  const error = (await rejection.json()).error;
  expect(error.code).toBe("validation_failed");
  const refusal = admin.getByRole("alert", { name: "고객 계정의 이용약관 동의가 없습니다" }).getByRole("alert");
  await expect(refusal).toContainText(error.message);
  await expect(refusal.getByRole("link", { name: "요청 결과 보기" })).toBeVisible();
  await expect(accept).toBeEnabled();
  await expect(admin.getByText(doc.body, { exact: true })).toBeVisible();
  const unchanged = await read<{ blockers: { code: string }[] }>("/api/v1/onboarding/go-live/preview");
  expect(unchanged.blockers.some((b) => b.code === "terms_not_accepted")).toBe(true);
  conflict = false;
  const response = termsResponse();
  await accept.click();
  expect((await response).status()).toBe(204);
  expect(sent).toEqual({ version: doc.version, sha256: doc.sha256 });
  await expect(accept).toBeHidden();
  const preview = await read<{ blockers: { code: string }[] }>("/api/v1/onboarding/go-live/preview");
  expect(preview.blockers.some((b) => b.code === "terms_not_accepted")).toBe(false);
  await expectAccessible(admin, "legacy terms accepted");
});
