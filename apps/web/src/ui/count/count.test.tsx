// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { Count } from "./count";

test("Count renders number", () => {
  const out = html(<Count n={42} />);
  expect(out).toContain("42");
});

test("Count renders failed dash with reason", () => {
  const out = html(<Count n={undefined} failed="Network error" />);
  expect(out).toContain("—");
  expect(out).toContain('title="Network error"');
});

test("Count renders pending skeleton bar", () => {
  const out = html(<Count n={undefined} />);
  expect(out).toContain('aria-hidden="true"');
});
