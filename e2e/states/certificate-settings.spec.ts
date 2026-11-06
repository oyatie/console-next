// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog, t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { expect, test, type Page } from "@playwright/test";
import { expectAxe, fits } from "../a11y";
import { mockScreen } from "../mock/screen";
import { certificateAccess, certificateSettings } from "../mock/certificates";
import { failure, id } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { lifecycleSheetScreens } from "./lifecycle-sheets";

test.beforeAll(() => loadCatalog("ko"));
async function prepare(page: Page, width: number, theme: string, manage: boolean | undefined) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
  const fixture = await mockScreen(page, lifecycleSheetScreens[0], "populated");
  await certificateAccess(page, manage);
  await mockRoute(page, "get", "/api/v1/hr/certificate-settings", { status: 200, json: { settings: [certificateSettings], seal_max_bytes: 100000, can_manage: manage === true } });
  await mockRoute(page, "get", "/api/v1/hr/certificates", { status: 200, json: { items: [], next_cursor: null } });
  return fixture;
}

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  for (const allowed of [true, false, undefined]) test(`certificate register lightweight decision ${allowed} ${width} ${theme} @ui-state`, async ({ page }, info) => {
    const fixture = await prepare(page, width, theme, allowed);
    const settingsReads: string[] = [];
    page.on("request", r => { if (new URL(r.url()).pathname === "/api/v1/hr/certificate-settings") settingsReads.push(r.url()); });
    await page.goto(allowed ? "/people/certificates" : "/people/certificates#certificate-settings");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: t("empDoc.certificate.register"), level: 1 })).toBeVisible();
    await expect(page.getByText(t("empDoc.certificate.empty"), { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: t("empDoc.certificate.settings"), exact: true })).toHaveCount(allowed ? 1 : 0);
    expect(settingsReads).toEqual([]);
    await page.screenshot({ path: info.outputPath("certificate-register.png"), fullPage: true });
    await fits(page, `certificate-register/${allowed}/${width}/${theme}`);
    await expectAxe(page, `certificate-register/${allowed}/${width}/${theme}`);
    expect(fixture.unexpected).toEqual([]);
  });

  for (const allowed of [true, false, undefined]) test(`certificate precondition before entry ${allowed} ${width} ${theme} @ui-state`, async ({ page }, info) => {
    const fixture = await prepare(page, width, theme, allowed);
    await mockRoute(page, "get", "/api/v1/hr/certificates/precondition", { status: 200, json: { settings_configured: false, reason_code: "certificate_settings_required" } });
    const writes: string[] = [];
    page.on("request", r => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/v1/hr/certificates") writes.push(r.url()); });
    await page.goto(`/people/${id(4000)}?act=cert`);
    const sheet = page.getByRole("dialog", { name: t("empDoc.cert.title"), exact: true });
    await expect(sheet.getByText(t("empDoc.certificate.error.certificate_settings_required"), { exact: true })).toBeVisible();
    await expect(sheet.getByRole("radio")).toHaveCount(0);
    await expect(sheet.getByRole("textbox", { name: t("empDoc.certificate.purpose") })).toHaveCount(0);
    const commit = sheet.getByRole("button", { name: t("empDoc.cert.commit"), exact: true });
    await expect(commit).toHaveAttribute("aria-disabled", "true");
    await commit.focus();
    await page.keyboard.press("Enter");
    await sheet.locator("form").evaluate(form => (form as HTMLFormElement).requestSubmit());
    expect(writes).toEqual([]);
    const remedy = sheet.getByRole("link", { name: t("empDoc.certificate.settings"), exact: true });
    await expect(remedy).toHaveCount(allowed ? 1 : 0);
    await fits(page, `certificate-precondition/${allowed}/${width}/${theme}`);
    await expectAxe(page, `certificate-precondition/${allowed}/${width}/${theme}`);
    if (allowed) {
      await page.screenshot({ path: info.outputPath("precondition.png"), fullPage: true });
      await remedy.click();
      const settingsSheet = page.getByRole("dialog", { name: t("empDoc.certificate.settings"), exact: true });
      await expect(settingsSheet).toBeVisible();
      await settingsSheet.getByRole("button", { name: t("uiSheet.close"), exact: true }).click();
      await expect(settingsSheet).toBeHidden();
      await expect(page).toHaveURL(`/people/certificates?employee=${id(4000)}`);
    }
    expect(fixture.unexpected).toEqual([]);
  });

  test(`scoped issuer enters without reading tenant settings ${width} ${theme} @ui-state`, async ({ page }, info) => {
    const fixture = await prepare(page, width, theme, false);
    let settingsReads = 0;
    await mockRoute(page, "get", "/api/v1/hr/certificate-settings", () => {
      settingsReads++;
      return { status: 403, json: failure("certificate_forbidden") };
    });
    await mockRoute(page, "get", "/api/v1/hr/certificates/precondition", request => {
      expect(new URL(request.url()).searchParams.get("employee_id")).toBe(id(4000));
      return { status: 200, json: { settings_configured: true, reason_code: null } };
    });
    await page.goto(`/people/${id(4000)}?act=cert`);
    const sheet = page.getByRole("dialog", { name: t("empDoc.cert.title"), exact: true });
    await sheet.getByRole("radio", { name: t("empDoc.cert.kind.EMPLOYMENT"), exact: true }).press("Space");
    await sheet.getByRole("checkbox", { name: t("empDoc.cert.item.period"), exact: true }).press("Space");
    await sheet.getByRole("textbox", { name: t("empDoc.certificate.purpose") }).fill("재직 확인");
    await expect(sheet.getByRole("button", { name: t("empDoc.cert.commit"), exact: true })).not.toHaveAttribute("aria-disabled", "true");
    expect(settingsReads).toBe(0);
    await fits(page, `certificate-scoped/${width}/${theme}`);
    await expectAxe(page, `certificate-scoped/${width}/${theme}`);
    await page.screenshot({ path: info.outputPath("scoped-issuer.png"), fullPage: true });
    expect(fixture.unexpected).toEqual([]);
  });

  test(`missing assignment blocks with personnel facts reason ${width} ${theme} @ui-state`, async ({ page }) => {
    const fixture = await prepare(page, width, theme, true);
    await mockRoute(page, "get", "/api/v1/hr/certificates/precondition", { status: 200, json: { settings_configured: false, reason_code: "certificate_facts_missing" } });
    await page.goto(`/people/${id(4000)}?act=cert`);
    const sheet = page.getByRole("dialog", { name: t("empDoc.cert.title"), exact: true });
    await expect(sheet.getByText(t("empDoc.certificate.error.certificate_facts_missing"), { exact: true })).toBeVisible();
    await expect(sheet.getByRole("link", { name: t("empDoc.certificate.settings"), exact: true })).toHaveCount(0);
    await expect(sheet.getByRole("radio")).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: t("empDoc.cert.commit"), exact: true })).toHaveAttribute("aria-disabled", "true");
    await fits(page, `certificate-facts/${width}/${theme}`);
    await expectAxe(page, `certificate-facts/${width}/${theme}`);
    expect(fixture.unexpected).toEqual([]);
  });

  test(`certificate settings composer saves and checks conflicts ${width} ${theme} @ui-state`, async ({ page }, info) => {
    const fixture = await prepare(page, width, theme, true);
    await mockRoute(page, "get", "/api/v1/hr/certificate-settings", { status: 200, json: { settings: [certificateSettings], seal_max_bytes: 100000, can_manage: true } });
    let conflict = true;
    const writes: unknown[] = [];
    await mockRoute(page, "put", "/api/v1/hr/certificate-settings", request => {
      writes.push(request.postDataJSON());
      return conflict ? { status: 409, json: failure("certificate_state_conflict") }
        : { status: 200, json: { ...certificateSettings, prefix: "NEW", version: 4 } };
    });
    await page.goto("/people/certificates#certificate-settings");
    const sheet = page.getByRole("dialog", { name: t("empDoc.certificate.settings"), exact: true });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('[data-composer-section="effects"]')).toContainText(t("empDoc.certificate.settingsEffect"));
    const commit = sheet.getByRole("button", { name: t("composer.verb.save"), exact: true });
    await expect(commit).toHaveAttribute("aria-disabled", "true");
    await sheet.getByRole("radio", { name: /화면 검증 회사/ }).press("Space");
    const prefix = sheet.getByRole("textbox", { name: t("empDoc.certificate.prefix") });
    await expect(prefix).toHaveValue("HR");
    await expect(sheet.getByRole("spinbutton", { name: t("empDoc.certificate.width") })).toHaveValue("4");
    const widthField = sheet.getByRole("spinbutton", { name: t("empDoc.certificate.width") });
    await widthField.fill("13");
    await expect(widthField).toHaveAttribute("aria-invalid", "true");
    await expect(sheet.getByText(t("empDoc.certificate.widthInvalid"), { exact: true })).toBeVisible();
    await widthField.press("Control+Enter");
    expect(writes).toEqual([]);
    await widthField.fill("4");
    await expect(widthField).not.toHaveAttribute("aria-invalid");
    await expect(sheet.getByText(t("uiFileDrop.hint", { types: "PNG", mb: fmtNumber(100000 / 1048576) }), { exact: true })).toBeVisible();
    await sheet.locator('input[type="file"]').setInputFiles({ name: "oversized.png", mimeType: "image/png", buffer: Buffer.alloc(100001) });
    await expect(sheet.getByRole("alert")).toContainText(t("uiFileDrop.tooLarge", { name: "oversized.png", mb: fmtNumber(100000 / 1048576) }));
    await sheet.locator('input[type="file"]').setInputFiles({ name: "seal.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64") });
    await sheet.getByRole("button", { name: t("empDoc.certificate.clearSeal"), exact: true }).click();
    await prefix.fill("NEW");
    await page.screenshot({ path: info.outputPath("settings-filled.png"), fullPage: true });
    await prefix.press("Control+Enter");
    await expect(sheet.getByRole("alert")).toContainText(t("empDoc.certificate.error.certificate_state_conflict"));
    await expect(prefix).toHaveValue("NEW");
    expect(writes).toEqual([{ legal_entity_id: certificateSettings.legal_entity_id, prefix: "NEW", width: 4, seal_text: certificateSettings.seal_text, seal_png: null, expected_version: 3 }]);
    await fits(page, `certificate-settings/${width}/${theme}`);
    await expectAxe(page, `certificate-settings/${width}/${theme}`);
    await page.screenshot({ path: info.outputPath("settings.png"), fullPage: true });
    conflict = false;
    await commit.click();
    await expect(sheet).toBeHidden();
    expect(writes).toHaveLength(2);
    expect(fixture.unexpected).toEqual([]);
  });

  for (const status of [403, 503, "loading"] as const) test(`certificate precondition read ${status} ${width} ${theme} @ui-state`, async ({ page }) => {
    const fixture = await prepare(page, width, theme, true);
    let failed = true, attempted = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await mockRoute(page, "get", "/api/v1/hr/certificates/precondition", async () => {
      attempted++;
      if (status === "loading" && failed) await held;
      return failed && status !== "loading" ? { status, json: failure(status === 403 ? "certificate_forbidden" : "service_unavailable") }
        : { status: 200, json: { settings_configured: true, reason_code: null } };
    });
    await page.goto(`/people/${id(4000)}?act=cert`);
    const sheet = page.getByRole("dialog", { name: t("empDoc.cert.title"), exact: true });
    await expect.poll(() => attempted).toBeGreaterThan(0);
    const register = sheet.getByRole("link", { name: t("empDoc.certificate.register"), exact: true });
    const before = await register.boundingBox();
    expect(before).not.toBeNull();
    await expect(sheet.getByRole("radio")).toHaveCount(0);
    await sheet.locator("form").evaluate(form => (form as HTMLFormElement).requestSubmit());
    failed = false;
    if (status === "loading") release();
    else await sheet.getByRole("button", { name: t("common.retry"), exact: true }).click();
    await expect(sheet.getByRole("radio", { name: t("empDoc.cert.kind.EMPLOYMENT"), exact: true })).toBeVisible();
    expect((await register.boundingBox())?.y).toBe(before?.y);
    await fits(page, `certificate-settings-read/${status}/${width}/${theme}`);
    await expectAxe(page, `certificate-settings-read/${status}/${width}/${theme}`);
    expect(fixture.unexpected).toEqual([]);
  });
}
