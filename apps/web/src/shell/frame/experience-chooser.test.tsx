// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { i18n, loadCatalog, t } from "@console/i18n";
import { resolveExperience } from "../../experience/table";
import { ExperienceChooser } from "./experience-chooser";

beforeAll(async () => { await loadCatalog("ko"); await loadCatalog("en"); });

test.each(["en", "ko"] as const)("%s: the chooser offers the listed styles without a preview suffix, while resolveExperience defaults to console", locale => {
  i18n.set(locale);
  try {
    expect(resolveExperience().id).toBe("console");
    const html = renderToStaticMarkup(<ExperienceChooser id="test-experience" />);
    expect(html).toContain('id="test-experience"');
    expect(html).toContain('aria-describedby="test-experience-hint"');
    expect(html.match(/<option\b/g)).toHaveLength(2);
    expect(html).toContain(`>${t("account.experience.baseline")}</option>`);
    // Console is offered without a preview suffix; unlisted styles stay hidden.
    expect(html).toContain(`>${t("account.experience.console")}</option>`);
    expect(html).not.toContain(t("account.experience.warmClear"));
    expect(html).toContain(t("account.experience.device"));
  } finally { i18n.set("ko"); }
});
