// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { FileDrop } from "./file-drop";

beforeAll(() => loadCatalog("ko"));
test.each([256 * 1024, 1024 * 1024])("file limit retains fractional megabytes: %s bytes", maxBytes => {
  const markup = renderToStaticMarkup(<FileDrop label="PNG" accept={[{ mime: "image/png", ext: "PNG" }]} maxBytes={maxBytes} onFiles={() => {}} />);
  expect(markup).toContain(t("uiFileDrop.hint", { types: "PNG", mb: fmtNumber(maxBytes / 1048576) }));
});
