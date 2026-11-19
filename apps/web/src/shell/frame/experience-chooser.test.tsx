// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { i18n, loadCatalog, t } from "@console/i18n";
import { ExperienceChooser } from "./experience-chooser";

beforeAll(async () => { await loadCatalog("ko"); await loadCatalog("en"); });

test.each(["en", "ko"] as const)("%s: the chooser offers the listed style and the preview, and defaults to baseline", locale => {
  i18n.set(locale);
  try {
    const html = renderToStaticMarkup(<ExperienceChooser id="test-experience" />);
    expect(html).toContain('id="test-experience"');
    expect(html).toContain('aria-describedby="test-experience-hint"');
    expect(html.match(/<option\b/g)).toHaveLength(2);
    expect(html).toMatch(/<option value="baseline" selected=""/);
    expect(html).toContain(t("account.experience.baseline"));
    // The style being built is offered, and says so; the one not started is not offered.
    expect(html).toContain(`>${t("account.experience.preview", { style: t("account.experience.controlRoom") })}</option>`);
    expect(html).not.toContain(t("account.experience.warmClear"));
    expect(html).toContain(t("account.experience.device"));
  } finally { i18n.set("ko"); }
});
