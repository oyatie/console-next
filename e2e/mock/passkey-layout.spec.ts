// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { t } from "@console/i18n";
import { bootKo } from "../../packages/i18n/src/catalogs/boot";
import { expectAxe } from "../a11y";
import { expectStable, recordShifts } from "../stability";
import { acceptConsent } from "../flows";
import { screens } from "../states/registry";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { AT, authz, token, user } from "./fixtures";

test("consent helper waits for fresh documents before accepting them", async ({ page }) => {
  const fixture = await mockScreen(page, screens[1], "populated");
  const claims = { sub: user.id, org: authz.org_id, enrollment: true, exp: Math.floor(Date.now() / 1000) + 3600 };
  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: {
    ...token(), access_token: `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`, requires_passkey_setup: true, privacy_consent_accepted: false,
  } });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await mockRoute(page, "get", "/api/v1/onboarding/terms", async () => {
    await held;
    const terms = { version: "consent-test", sha256: "a".repeat(64), body: "Terms of service" };
    return { status: 200, json: { ...terms, privacy: { ...terms, title: "Privacy notice", published_on: AT.slice(0, 10), policy_url: "/privacy", review_pending: false } } };
  });
  await page.goto("/setup-passkey");
  let waiting = false;
  page.waitForFunction = new Proxy(page.waitForFunction, {
    apply(wait, context, args) { waiting = true; return Reflect.apply(wait, context, args); },
  });
  const accepting = acceptConsent(page);
  try {
    await expect.poll(() => waiting, "the helper waits for route readiness while documents are held").toBe(true);
  } finally { release(); }
  await accepting;
  await expect(page.getByRole("checkbox", { name: t("auth.setup.consent.privacy"), exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: t("auth.setup.consent.terms"), exact: true })).toBeChecked();
  await expect(page.getByRole("button", { name: t("auth.setup.register"), exact: true })).toBeEnabled();
  expect(fixture.unexpected).toEqual([]);
});

for (const width of [1280, 390]) for (const theme of ["light", "dark"]) {
  test(`consent controls first appear in their settled layout at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    const fixture = await mockScreen(page, screens[1], "populated");
    const claims = { sub: user.id, org: authz.org_id, enrollment: true, exp: Math.floor(Date.now() / 1000) + 3600 };
    await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: {
      ...token(), access_token: `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`, requires_passkey_setup: true, privacy_consent_accepted: false,
    } });
    let release!: () => void;
    const held = new Promise<void>(done => { release = done; });
    const terms = { version: "consent-test", sha256: "a".repeat(64) };
    await mockRoute(page, "get", "/api/v1/onboarding/terms", async () => {
      await held;
      return { status: 200, json: { ...terms, body: "이용 약관", privacy: { ...terms, title: "개인정보 처리 안내", body: "개인정보 처리 안내 전문", published_on: AT.slice(0, 10), policy_url: "https://example.test/privacy", review_pending: false } } };
    });
    await page.addInitScript(recordShifts);
    try {
      await page.goto("/setup-passkey");
      await page.getByRole("main").evaluate((_, value) => { document.documentElement.dataset.theme = value; }, theme);
      await expect(page.getByRole("status", { name: bootKo["common.loading"] })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      // No consent target is offered until the document text that determines its layout is known.
      await expect(page.getByRole("checkbox")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "동의하고 패스키 등록", exact: true })).toHaveCount(0);
      release();
      const enroll = page.getByRole("button", { name: "동의하고 패스키 등록", exact: true });
      await expect(page.getByRole("heading", { name: "패스키 등록", exact: true })).toBeVisible();
      await expect(page.getByRole("checkbox")).toHaveCount(2);
      await expect(enroll).toBeDisabled();
      // The policy is in view beside the consent itself, not inside a closed full text.
      const policy = page.getByText("https://example.test/privacy");
      await expect(page.locator("details[open]")).toHaveCount(0);
      await expect(policy).toBeVisible();
      expect((await policy.boundingBox())!.y).toBeLessThan((await enroll.boundingBox())!.y);
      await expect(page.getByRole("checkbox").first()).toHaveAccessibleDescription(/example\.test\/privacy/);
      await page.evaluate(() => document.fonts.ready);
      await expectStable(page, "consent document arrival");
      await expectAxe(page, "settled consent form");
      expect(await page.getByRole("main").evaluate(() => document.scrollingElement!.scrollWidth - innerWidth)).toBe(0);
      expect(await page.getByRole("main").evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await page.screenshot({ path: test.info().outputPath("consent.png"), fullPage: true });
      await acceptConsent(page);
      await expect(enroll).toBeEnabled();
      expect(fixture.unexpected).toEqual([]);
    } finally { release(); }
  });
}
