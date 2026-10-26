// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { Muted } from "./muted";

test("Muted renders span with muted class", () => {
  const text = "Not recorded";
  const out = html(<Muted>{text}</Muted>);
  expect(out).toContain('<span class="muted">Not recorded</span>');
});
