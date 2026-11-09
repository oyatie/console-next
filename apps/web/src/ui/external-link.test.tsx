// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { i18n, loadCatalog, t } from "@console/i18n";
import { afterEach, beforeAll, expect, test } from "vitest";
import { ExternalLink } from "./external-link";

beforeAll(() => Promise.all([loadCatalog("ko"), loadCatalog("en")]), 60_000);
afterEach(() => i18n.set("ko"));

const label = "Citation";

for (const locale of ["ko", "en"] as const) {
  test(`HTTPS citation is labelled plain text with one copy action (${locale})`, () => {
    i18n.set(locale);
    const markup = renderToStaticMarkup(<ExternalLink href="https://www.law.go.kr/example" className="citation">{label}</ExternalLink>);
    expect(markup).not.toContain("<a ");
    expect(markup).toContain("Citation");
    expect(markup.replace(/<[^>]*>/g, "")).toContain("https://www.law.go.kr/example");
    expect(markup.match(/<button /g)).toHaveLength(1);
    expect(markup).toContain(t("uiField.copyUrl"));
    expect(markup).toContain('class="');
    expect(markup).toContain("citation");
  });

  test.each(["http://example.com", "javascript:alert(1)", "data:text/html,unsafe", "file:///example", "//example.com", "/example", "https://", ""])(`external_url_https_required: %s (${locale})`, href => {
    i18n.set(locale);
    const markup = renderToStaticMarkup(<ExternalLink href={href}>{label}</ExternalLink>);
    expect(markup).not.toContain("<a ");
    expect(markup).not.toContain("<button ");
    expect(markup).toContain("Citation");
    expect(markup).toContain('data-refusal-code="external_url_https_required"');
    expect(markup).toContain(t("common.failed.code.external_url_https_required"));
    expect(markup.replace(/<[^>]*>/g, "")).toBe(`Citation · ${t("common.failed.code.external_url_https_required")}`);
  });

}
