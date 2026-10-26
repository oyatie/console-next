// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { Kbd } from "./kbd";

test("Kbd renders keyboard hint with aria-hidden", () => {
  const out = html(<Kbd keys="⌘K" />);
  expect(out).toContain("<kbd");
  expect(out).toContain('aria-hidden="true"');
  expect(out).toContain("⌘K");
});
