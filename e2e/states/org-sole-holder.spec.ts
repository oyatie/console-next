// SPDX-License-Identifier: LicenseRef-Proprietary
import type { OrgChangeDetail } from "@console/api/pending";
import { expect, test, type Page } from "@playwright/test";
import { i18n, loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { failure, id } from "../mock/fixtures";
import { orgChange } from "../mock/org-changes";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { orgChangeScreens } from "./registry";

const offer = { step_id: id(6000), expected_version: "17", payload_hash: "a".repeat(64), notice_count: 2, review_due_at: "2026-11-09T03:00:00Z" };
const words = {
  ko: { open: "단독 예외 처리", commit: "패스키로 확인하고 조직 변경 승인", receipt: "단독 예외로 승인했습니다", notices: "알림 기록 2건", changed: "결재 내용이 바뀌어 승인하지 않았습니다. 바뀐 내용을 확인하고 다시 승인하십시오." },
  en: { open: "Sole-holder exception", commit: "Confirm with a passkey and approve org change", receipt: "Approved as a sole-holder exception", notices: "2 notice records", changed: "The approval details changed, so this change was not approved. Review the updated details before approving again." },
};

test.afterEach(async () => { await loadCatalog("ko"); i18n.set("ko"); });

async function setup(page: Page, locale: "ko" | "en", offered = true) {
  await loadCatalog(locale);
  i18n.set(locale);
  await page.addInitScript(value => localStorage.setItem("console.locale", value), locale);
  const fixture = await mockScreen(page, orgChangeScreens[1], "approval");
  const record = { ...orgChange("approval"), version: "17", sole_holder_decision: offered ? offer : null };
  await mockRoute(page, "get", "/api/v1/org-changes/{id}", { status: 200, json: record });
  return { fixture, record };
}

async function passkey(page: Page, cancel = false) {
  await page.addInitScript(cancel => {
    Object.defineProperty(navigator.credentials, "get", { value: async () => cancel ? null : { toJSON: () => ({ id: "test-credential", type: "public-key" }) } });
  }, cancel);
  await mockRoute(page, "post", "/api/v1/auth/passkey/step-up/start", request => {
    expect(request.postDataJSON()).toEqual({ binding: {
      action_kind: "EXCEPTION_DECIDE", object_id: id(3000), reason_key: "passkey_step_up_exception_decide", replay_attempt: null, payload_hash: offer.payload_hash,
    } });
    return { status: 200, json: { ceremony_id: id(7000), expires_at: "2026-11-09T00:00:00Z", binding: request.postDataJSON().binding, challenge: { publicKey: { challenge: "dGVzdA", rpId: "localhost" } } } };
  });
}

for (const locale of ["ko", "en"] as const) for (const width of [1440, 390]) {
  test(`org sole holder: bound decision and persisted review in ${locale} at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { fixture, record } = await setup(page, locale);
    await passkey(page);
    let writes = 0;
    const exception = { id: id(7001), review_due_at: offer.review_due_at, notice_count: 2 };
    const approved = { ...record, status: "APPROVED" as const, sole_holder_decision: null, sole_holder_exception: exception,
      approvalSteps: record.approvalSteps.map(s => ({ ...s, decision: "APPROVED" as const })) };
    await mockRoute(page, "post", "/api/v1/org-changes/{id}/approval-steps/{stepId}/decision", async request => {
      writes++;
      expect(request.postDataJSON()).toEqual({ decision: "APPROVED", expected_version: "17", step_up: {
        binding: { action_kind: "EXCEPTION_DECIDE", object_id: record.id, reason_key: "passkey_step_up_exception_decide", replay_attempt: null, payload_hash: offer.payload_hash },
        assertion: { ceremony_id: id(7000), credential: { id: "test-credential", type: "public-key" } },
      } });
      await mockRoute(page, "get", "/api/v1/org-changes/{id}", { status: 200, json: approved });
      return { status: 200, json: approved };
    });
    try {
      await page.goto(orgChangeScreens[1].path);
      await page.getByRole("button", { name: words[locale].open, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: words[locale].open, exact: true });
      await expect(dialog).toContainText(record.reason);
      await expect(dialog).toContainText(record.target.label!);
      await expect(dialog).toContainText(words[locale].notices);
      for (const theme of ["light", "dark"]) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await fits(page, `sole-holder/${locale}/${width}/${theme}`);
        expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        await expectAxe(page, `sole-holder/${locale}/${width}/${theme}`);
        await page.screenshot({ path: test.info().outputPath(`${theme}.png`), fullPage: true });
      }
      await dialog.getByRole("button", { name: words[locale].commit, exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByText(words[locale].receipt, { exact: false }).first()).toBeVisible();
      expect(writes).toBe(1);
      await page.reload();
      await expect(page.getByText(t("uiOverrideSheet.mark"), { exact: true })).toBeVisible();
      await expect(page.getByText(words[locale].notices, { exact: false })).toBeVisible();
      await expect(page.getByRole("button", { name: words[locale].open, exact: true })).toHaveCount(0);
      for (const theme of ["light", "dark"]) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await fits(page, `sole-holder review/${locale}/${width}/${theme}`);
        await expectAxe(page, `sole-holder review/${locale}/${width}/${theme}`);
        await page.screenshot({ path: test.info().outputPath(`review-${theme}.png`), fullPage: true });
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

for (const locale of ["ko", "en"] as const) {
  test(`org sole holder: server absence keeps drafter waiting in ${locale} @ui-state`, async ({ page }) => {
    const { fixture } = await setup(page, locale, false);
    try {
      await page.goto(orgChangeScreens[1].path);
      await expect(page.getByText(t("orgChange.turn.drafter"), { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: words[locale].open, exact: true })).toHaveCount(0);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });

  test(`org sole holder: changed consent stays open and retries the refreshed offer in ${locale} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const { fixture, record } = await setup(page, locale);
    await page.addInitScript(() => {
      Object.defineProperty(navigator.credentials, "get", { value: async () => ({ toJSON: () => ({ id: "test-credential", type: "public-key" }) }) });
    });
    const updated = { ...offer, payload_hash: "b".repeat(64), review_due_at: "2026-11-12T03:00:00Z" };
    const hashes: string[] = [];
    await mockRoute(page, "post", "/api/v1/auth/passkey/step-up/start", request => {
      hashes.push(request.postDataJSON().binding.payload_hash);
      return { status: 200, json: { ceremony_id: id(7000 + hashes.length), expires_at: updated.review_due_at,
        binding: request.postDataJSON().binding, challenge: { publicKey: { challenge: "dGVzdA", rpId: "localhost" } } } };
    });
    let writes = 0;
    await mockRoute(page, "post", "/api/v1/org-changes/{id}/approval-steps/{stepId}/decision", async request => {
      writes++;
      expect(request.postDataJSON().step_up.binding.payload_hash).toBe(writes === 1 ? offer.payload_hash : updated.payload_hash);
      await mockRoute(page, "get", "/api/v1/org-changes/{id}", { status: 200, json: { ...record, sole_holder_decision: updated } });
      return { status: 409, json: failure("lifecycle.refuse.stale_version") };
    });
    try {
      await page.goto(orgChangeScreens[1].path);
      await page.getByRole("button", { name: words[locale].open, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: words[locale].open, exact: true });
      await dialog.getByRole("button", { name: words[locale].commit, exact: true }).click();
      await expect(dialog).toContainText(updated.payload_hash.slice(0, 12));
      await expect(dialog.getByRole("alert")).toContainText(words[locale].changed);
      await expect(page.getByText(words[locale].receipt, { exact: false })).toHaveCount(0);
      expect(writes).toBe(1);
      for (const theme of ["light", "dark"]) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await fits(page, `changed consent/${locale}/${theme}`);
        await expectAxe(page, `changed consent/${locale}/${theme}`);
        await page.screenshot({ path: test.info().outputPath(`changed-${theme}.png`), fullPage: true });
      }
      await dialog.getByRole("button", { name: words[locale].commit, exact: true }).click();
      await expect.poll(() => writes).toBe(2);
      expect(hashes).toEqual([offer.payload_hash, updated.payload_hash]);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });

  for (const code of ["org_change.refuse.missing_grant", "lifecycle.refuse.stale_version", "step_up_failed"] as const) {
    test(`org sole holder: ${code} retains the review in ${locale} @ui-state`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 900 });
      const { fixture, record } = await setup(page, locale);
      await passkey(page);
      let writes = 0;
      await mockRoute(page, "post", "/api/v1/org-changes/{id}/approval-steps/{stepId}/decision", () => {
        writes++;
        return { status: code.includes("stale") ? 409 : 403, json: failure(code) };
      });
      try {
        await page.goto(orgChangeScreens[1].path);
        await page.getByRole("button", { name: words[locale].open, exact: true }).click();
        const dialog = page.getByRole("dialog", { name: words[locale].open, exact: true });
        await dialog.getByRole("button", { name: words[locale].commit, exact: true }).click();
        await expect(dialog.getByRole("alert")).toBeVisible();
        await expect(dialog.getByRole("alert")).toContainText(code === "lifecycle.refuse.stale_version" ? words[locale].changed : t(code === "step_up_failed" ? "orgChange.sole.stepUpFailed" : code));
        await expect(dialog.getByRole("alert")).not.toContainText("Untranslated server message");
        await expect(dialog).toContainText(record.reason);
        for (const theme of ["light", "dark"]) {
          await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          await fits(page, `sole-holder refusal/${code}/${locale}/${theme}`);
          await expectAxe(page, `sole-holder refusal/${code}/${locale}/${theme}`);
          await page.screenshot({ path: test.info().outputPath(`refusal-${theme}.png`), fullPage: true });
        }
        const commit = dialog.getByRole("button", { name: words[locale].commit, exact: true });
        if (code === "org_change.refuse.missing_grant") {
          await expect(commit).toBeDisabled();
          await commit.dispatchEvent("click");
          expect(writes).toBe(1);
          await dialog.getByRole("button", { name: t("uiOverrideSheet.back"), exact: true }).click();
          await expect(dialog).toHaveCount(0);
        } else {
          await expect(commit).toBeEnabled();
          await commit.click();
          await expect.poll(() => writes).toBe(2);
        }
        await expect(page.getByText(words[locale].receipt, { exact: false })).toHaveCount(0);
        expect(writes).toBe(code === "org_change.refuse.missing_grant" ? 1 : 2);
        expect(fixture.unexpected).toEqual([]);
      } finally { await page.close(); fixture.release(); }
    });
  }
}

test("org sole holder: cancelling a passkey sends no decision @ui-state", async ({ page }) => {
  const { fixture } = await setup(page, "ko");
  await passkey(page, true);
  let writes = 0;
  await mockRoute(page, "post", "/api/v1/org-changes/{id}/approval-steps/{stepId}/decision", () => { writes++; return { status: 403, json: failure("forbidden") }; });
  try {
    await page.goto(orgChangeScreens[1].path);
    await page.getByRole("button", { name: words.ko.open, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: words.ko.open, exact: true });
    await dialog.getByRole("button", { name: words.ko.commit, exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText(t("orgChange.sole.cancelled"));
    expect(writes).toBe(0);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});


test("org sole holder: each stored step needs an explicit reopen and a fresh binding @ui-state", async ({ page }) => {
  const { fixture, record } = await setup(page, "ko");
  await page.addInitScript(() => {
    Object.defineProperty(navigator.credentials, "get", { value: async () => ({ toJSON: () => ({ id: "test-credential", type: "public-key" }) }) });
  });
  const roles = ["hr", "finance", "legal", "executive"] as const;
  let writes = 0;
  let current: OrgChangeDetail = { ...record, approvalSteps: roles.map((roleKey, i) => ({ ...record.approvalSteps[0]!, id: id(6000 + i), roleKey, stepOrder: i + 1 })) };
  await mockRoute(page, "get", "/api/v1/org-changes/{id}", () => ({ status: 200, json: current }));
  await mockRoute(page, "post", "/api/v1/auth/passkey/step-up/start", request => ({ status: 200, json: {
    ceremony_id: id(7000), expires_at: offer.review_due_at, binding: request.postDataJSON().binding,
    challenge: { publicKey: { challenge: "dGVzdA", rpId: "localhost" } },
  } }));
  await mockRoute(page, "post", "/api/v1/org-changes/{id}/approval-steps/{stepId}/decision", request => {
    expect(new URL(request.url()).pathname).toContain(`/approval-steps/${id(6000 + writes)}/decision`);
    expect(request.postDataJSON().expected_version).toBe(String(17 + writes));
    expect(request.postDataJSON().step_up.binding.payload_hash).toBe(current.sole_holder_decision!.payload_hash);
    current.approvalSteps[writes]!.decision = "APPROVED";
    writes++;
    current = { ...current, status: writes === roles.length ? "APPROVED" : "IN_APPROVAL",
      sole_holder_exception: { id: id(7001), notice_count: 2, review_due_at: offer.review_due_at },
      version: String(17 + writes), sole_holder_decision: writes === roles.length ? null : {
      ...offer, step_id: id(6000 + writes), expected_version: String(17 + writes), payload_hash: String(writes).repeat(64),
    } };
    return { status: 200, json: current };
  });
  try {
    await page.goto(orgChangeScreens[1].path);
    for (let step = 0; step < roles.length; step++) {
      await page.getByRole("button", { name: words.ko.open, exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: words.ko.commit, exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByRole("button", { name: words.ko.open, exact: true })).toHaveCount(0);
      expect(writes).toBe(step + 1);
      if (step < roles.length - 1) await page.getByRole("button", { name: t("orgChange.sole.next"), exact: true }).click();
    }
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

test("org sole holder: a completed record cannot reopen a stale offer @ui-state", async ({ page }) => {
  const { fixture, record } = await setup(page, "ko");
  await mockRoute(page, "get", "/api/v1/org-changes/{id}", { status: 200, json: { ...record, status: "APPLIED" } });
  try {
    await page.goto(orgChangeScreens[1].path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: words.ko.open, exact: true })).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});
