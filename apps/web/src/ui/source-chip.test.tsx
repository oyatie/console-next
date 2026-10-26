// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { SourceChip, type Source } from "./source-chip";

beforeAll(() => loadCatalog("ko"));
test.each<Source>(["document", "nts", "manual", "previous", "opening"])("%s source is named alongside its colour", source => {
  const out = html(<SourceChip source={source} />);
  expect(out).toContain(t(`uiSourceChip.${source}`));
  expect(out).toContain(`chip--${source === "document" ? "info" : source === "nts" ? "ok" : "neutral"}`);
});
