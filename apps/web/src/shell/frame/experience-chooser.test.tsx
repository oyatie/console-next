// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { i18n, loadCatalog, t } from "@console/i18n";
import { ExperienceChooser } from "./experience-chooser";

vi.mock("../../experience/table", async original => {
  const table = await original<typeof import("../../experience/table")>();
  return { ...table, experiences: [...table.experiences, { id: "second", label: "account.field.theme" }] };
});
beforeAll(async () => { await loadCatalog("ko"); await loadCatalog("en"); });

test.each(["en", "ko"] as const)("%s: registering a second pack adds its choice without changing the chooser", locale => {
  i18n.set(locale);
  try {
    const html = renderToStaticMarkup(<ExperienceChooser />);
    expect(html.match(/<option\b/g)).toHaveLength(2);
    expect(html).toContain('value="second"');
    expect(html).toContain(t("account.experience.baseline"));
    expect(html).toContain(t("account.field.theme"));
    expect(html).toContain(t("account.experience.device"));
  } finally { i18n.set("ko"); }
});
